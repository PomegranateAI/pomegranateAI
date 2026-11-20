import { createHash, timingSafeEqual } from 'node:crypto';
import { clientIp as clientIpOf } from '../../lib/client-ip.js';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Repo } from '../db/repo.js';
import { TokenBucketLimiter } from '../api/rate-limit.js';

export const OAUTH_SCOPES = [
  'context:read',
  'context:ingest',
  'context:curate',
  'workspace:manage',
  'offline_access',
] as const;

const READ_TOOLS = new Set([
  'query_context', 'review_deliverable', 'list_recent_changes', 'get_context',
  'search_context', 'list_sources', 'list_pending_routes', 'list_rules',
  'test_rule', 'list_templates', 'list_folders', 'list_team',
  'explore_team_folders',
]);
const INGEST_TOOLS = new Set(['ingest_document']);
const CURATE_TOOLS = new Set([
  'update_node', 'update_attribute', 'approve_route', 'choose_route', 'reject_route',
]);
const MANAGE_TOOLS = new Set([
  'create_subfolder', 'upsert_rule', 'delete_rule', 'request_folder_access',
  'set_default_folder',
]);

export function oauthScopeForTool(name: string): string {
  if (READ_TOOLS.has(name)) return 'context:read';
  if (INGEST_TOOLS.has(name)) return 'context:ingest';
  if (CURATE_TOOLS.has(name)) return 'context:curate';
  if (MANAGE_TOOLS.has(name)) return 'workspace:manage';
  return 'workspace:manage'; // fail closed when the registry grows
}

export type OAuthAccess = {
  id: string;
  grant_id: string;
  user_id: string;
  resource: string;
  scopes: string[];
  workspace_ids: string[];
};

// Every timestamp is an ISO-8601 string made here, never SQLite's datetime('now'):
// expiries are written with toISOString() ('…T14:00:00.000Z') and 'T' sorts
// after the space in datetime('now') ('… 14:00:00'), so comparing the two let a
// token expiring later the same UTC day pass until midnight. ISO on both sides
// also keeps this SQL portable to Postgres (Azure contracts §C2).
const nowIso = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonArray = (value: string): string[] => {
  try { return z.array(z.string()).parse(JSON.parse(value)); } catch { return []; }
};
const splitScopes = (value: string | undefined) =>
  [...new Set((value || 'context:read').split(/\s+/).filter(Boolean))];

function publicOrigin(requestUrl: string): string {
  return process.env.PUBLIC_ORIGIN?.split(',')[0]?.trim() || new URL(requestUrl).origin;
}

function oauthIssuer(requestUrl: string): string {
  return `${publicOrigin(requestUrl)}/mcp/oauth`;
}

function resourceUri(requestUrl: string): string {
  return `${publicOrigin(requestUrl)}/mcp/server`;
}

// https, or http on a loopback host (native/desktop clients). No fragment
// (RFC 6749 §3.1.2) and no userinfo, which can disguise the real host.
export function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash || uri.includes('#') || u.username || u.password) return false;
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    return u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
  } catch { return false; }
}

function clientIp(c: any): string {
  return clientIpOf(c) ?? 'unknown';
}

/** A registered client that never completed an authorization within this window is deleted. */
export const UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete clients older than UNUSED_CLIENT_TTL_MS that never produced a grant
 * (their authorization codes go with them). Runs on every /register call, so
 * open registration can't grow the table without bound and no timer is needed.
 */
export function pruneUnusedClients(repo: Repo): number {
  const cutoff = new Date(Date.now() - UNUSED_CLIENT_TTL_MS).toISOString();
  return repo.db.transaction(() => {
    const stale = `SELECT client_id FROM oauth_clients c WHERE c.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`;
    repo.db.prepare(`DELETE FROM oauth_authorization_codes WHERE client_id IN (${stale})`).run(cutoff);
    return repo.db.prepare(`DELETE FROM oauth_clients WHERE client_id IN (${stale})`).run(cutoff).changes;
  })();
}

type AuditMeta = { source_ip?: string; user_agent?: string };
function requestAuditMeta(c: any): AuditMeta {
  return { source_ip: clientIp(c), user_agent: c.req.header('user-agent') ?? undefined };
}

/** One customer-audit row per folder the grant covers (the audit log is per-workspace). */
async function auditGrant(
  repo: Repo,
  event: 'oauth_consent_granted' | 'oauth_token_issued' | 'oauth_grant_revoked',
  grant: { id: string; user_id: string; client_id: string; workspace_ids: string },
  meta: AuditMeta,
  payload: Record<string, unknown> = {},
): Promise<void> {
  for (const ws of jsonArray(grant.workspace_ids)) {
    await repo.logCustomerAudit(ws, {
      event,
      actor_user_id: grant.user_id,
      ...meta,
      resource_type: 'oauth_grant',
      resource_id: grant.id,
      payload: { client_id: grant.client_id, ...payload },
    });
  }
}

function client(repo: Repo, clientId: string) {
  return repo.db.prepare(`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?`)
    .get(clientId) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
}

function validateAuthorization(repo: Repo, q: Record<string, string>, requestUrl: string) {
  const c = client(repo, q.client_id || '');
  if (!c) return { error: 'invalid_client' } as const;
  if (q.response_type !== 'code') return { error: 'unsupported_response_type' } as const;
  if (!jsonArray(c.redirect_uris).includes(q.redirect_uri || '')) return { error: 'invalid_redirect_uri' } as const;
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) return { error: 'invalid_request' } as const;
  const scopes = splitScopes(q.scope);
  if (scopes.some((s) => !(OAUTH_SCOPES as readonly string[]).includes(s))) return { error: 'invalid_scope' } as const;
  const expectedResource = resourceUri(requestUrl);
  if (q.resource !== expectedResource) return { error: 'invalid_target' } as const;
  return { client: c, scopes, resource: expectedResource } as const;
}

async function bearerSession(repo: Repo, header: string | undefined) {
  if (!header?.startsWith('Bearer ')) return undefined;
  const session = await repo.getSession(header.slice(7));
  // A session still waiting on required MFA enrolment can't approve a
  // connection: consent must come from a fully signed-in user.
  if (!session || session.mfa_enrollment_required) return undefined;
  return session;
}

export async function resolveOAuthAccess(repo: Repo, token: string, requestUrl: string): Promise<OAuthAccess | undefined> {
  if (!token.startsWith('oat_')) return undefined;
  const row = repo.db.prepare(
    `SELECT t.id, t.grant_id, g.user_id, g.resource, g.scopes, g.workspace_ids
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL
        AND t.expires_at > ? AND g.revoked_at IS NULL`,
  ).get(hash(token), nowIso()) as any;
  if (!row || row.resource !== resourceUri(requestUrl)) return undefined;
  // Membership is re-checked on every use: a grant never outlives the membership it was given under.
  const workspaceIds: string[] = [];
  for (const id of jsonArray(row.workspace_ids)) if (await repo.getMembership(id, row.user_id)) workspaceIds.push(id);
  if (!workspaceIds.length) return undefined;
  return { id: row.id, grant_id: row.grant_id, user_id: row.user_id, resource: row.resource,
    scopes: jsonArray(row.scopes), workspace_ids: workspaceIds };
}

function tokenPair(repo: Repo, grantId: string, familyId = `fam_${nanoid(16)}`) {
  const now = new Date();
  const access = `oat_${nanoid(40)}`;
  const refresh = `ort_${nanoid(48)}`;
  const accessExp = new Date(now.getTime() + 60 * 60 * 1000);
  const refreshExp = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const insert = repo.db.prepare(`INSERT INTO oauth_tokens
    (id, grant_id, kind, token_hash, family_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run(`ot_${nanoid(16)}`, grantId, 'access', hash(access), familyId, now.toISOString(), accessExp.toISOString());
  insert.run(`ot_${nanoid(16)}`, grantId, 'refresh', hash(refresh), familyId, now.toISOString(), refreshExp.toISOString());
  return { access, refresh, expiresIn: 3600 };
}

// The consent page loads its script and styles from static routes below, so
// the page can carry a strict CSP (no inline script or style).
const authorizeHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Pomegranate</title><link rel="stylesheet" href="consent.css"></head><body><div class="box"><h1>Connect Pomegranate</h1><div id="app">Loading…</div></div><script src="consent.js" defer></script></body></html>`;

const consentCss = `body{font:16px system-ui;max-width:560px;margin:8vh auto;padding:24px;color:#241f1c}button,input{font:inherit;padding:10px;margin:5px 0}button{background:#a53030;color:white;border:0;border-radius:7px}.box{border:1px solid #ddd;border-radius:12px;padding:22px}label{display:block;margin:8px 0}.muted{color:#666;font-size:14px}.error{color:#a00}`;

const consentJs = `(() => {
const q = location.search, app = document.querySelector('#app'), api = location.pathname.replace(/\\/authorize$/, '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function load() {
  const session = localStorage.getItem('pmg_session');
  if (!session) {
    app.innerHTML = '<p>Sign in to Pomegranate first, then return to this page.</p><p><a href="/">Open Pomegranate sign in</a></p><button id="retry" type="button">I have signed in — retry</button>';
    document.querySelector('#retry').addEventListener('click', load);
    return;
  }
  const r = await fetch(api + '/authorize/context' + q, { headers: { Authorization: 'Bearer ' + session } });
  const j = await r.json();
  if (!r.ok) { app.innerHTML = '<p class="error">' + esc(j.error || 'Unable to authorize') + '</p>'; return; }
  app.innerHTML = '<p><b>' + esc(j.client_name) + '</b> wants access to:</p>' + (j.redirect_host ? '<p class="muted">After you allow it, you will be sent to <b>' + esc(j.redirect_host) + '</b>. Only continue if you recognise this address.</p>' : '') + '<p>' + j.scopes.map(esc).join(', ') + '</p><form id="f"><p class="muted">Choose folders this connection may reach:</p>'
    + j.workspaces.map((w) => '<label><input type="checkbox" name="ws" value="' + esc(w.id) + '" checked> ' + esc(w.name) + '</label>').join('')
    + '<button>Allow connection</button></form>';
  document.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const workspace_ids = [...document.querySelectorAll('[name=ws]:checked')].map((x) => x.value);
    const p = await fetch(api + '/authorize' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + session, 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, workspace_ids }) });
    const out = await p.json();
    if (!p.ok) { app.innerHTML = '<p class="error">' + esc(out.error) + '</p>'; return; }
    location.href = out.redirect_uri;
  });
}
load();
})();
`;

export const CONSENT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export type MountOAuthOptions = {
  /** Per-IP limiter for dynamic client registration. Default: burst 10, then 1 per minute. */
  registerLimiter?: TokenBucketLimiter;
};

export function mountOAuth(app: Hono<any, any, any>, repo: Repo, opts: MountOAuthOptions = {}): void {
  const registerLimiter = opts.registerLimiter ?? new TokenBucketLimiter({ capacity: 10, refillIntervalMs: 60_000 });
  const metadata = (c: any) => c.json({
    issuer: oauthIssuer(c.req.url), authorization_endpoint: `${oauthIssuer(c.req.url)}/authorize`,
    token_endpoint: `${oauthIssuer(c.req.url)}/token`, registration_endpoint: `${oauthIssuer(c.req.url)}/register`,
    revocation_endpoint: `${oauthIssuer(c.req.url)}/revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: OAUTH_SCOPES,
  });
  app.get('/.well-known/oauth-authorization-server', metadata);
  app.get('/.well-known/oauth-authorization-server/api/oauth', metadata);
  app.get('/mcp/.well-known/oauth-authorization-server/oauth', metadata);
  // RFC 8414/OIDC path-appending fallback. Unlike root well-known paths this
  // remains reachable through the deployment's existing /mcp/* proxy.
  app.get('/mcp/oauth/.well-known/openid-configuration', metadata);
  const protectedMetadata = (c: any) => c.json({ resource: resourceUri(c.req.url), authorization_servers: [oauthIssuer(c.req.url)], scopes_supported: OAUTH_SCOPES });
  app.get('/.well-known/oauth-protected-resource', protectedMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp/server', protectedMetadata);
  app.get('/mcp/.well-known/oauth-protected-resource/server', protectedMetadata);

  app.post('/mcp/oauth/register', async (c) => {
    const ip = clientIp(c);
    if (!registerLimiter.take(ip)) {
      const retryAfter = registerLimiter.retryAfterSec(ip);
      return c.json({ error: 'rate_limited', retry_after_s: retryAfter }, 429, { 'retry-after': String(retryAfter) });
    }
    pruneUnusedClients(repo);
    const parsed = z.object({ client_name: z.string().min(1).max(100), redirect_uris: z.array(z.string()).min(1).max(10),
      token_endpoint_auth_method: z.literal('none').optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || parsed.data.redirect_uris.some((u) => !validRedirect(u))) return c.json({ error: 'invalid_client_metadata' }, 400);
    const id = `oc_${nanoid(24)}`;
    repo.db.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, parsed.data.client_name, JSON.stringify(parsed.data.redirect_uris), new Date().toISOString());
    return c.json({ client_id: id, client_name: parsed.data.client_name, redirect_uris: parsed.data.redirect_uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  });

  app.get('/mcp/oauth/authorize', (c) => {
    const valid = validateAuthorization(repo, c.req.query(), c.req.url);
    if ('error' in valid) return c.json({ error: valid.error }, 400);
    c.header('Content-Security-Policy', CONSENT_CSP);
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(authorizeHtml);
  });
  app.get('/mcp/oauth/consent.js', (c) => c.body(consentJs, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }));
  app.get('/mcp/oauth/consent.css', (c) => c.body(consentCss, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' }));
  app.get('/mcp/oauth/authorize/context', async (c) => {
    const session = await bearerSession(repo, c.req.header('authorization'));
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    const valid = validateAuthorization(repo, c.req.query(), c.req.url);
    if ('error' in valid) return c.json({ error: valid.error }, 400);
    // The redirect host is shown next to the self-declared client name, so a
    // registration that borrows a trusted name but sends you elsewhere is visible.
    let redirect_host = '';
    try { redirect_host = new URL(c.req.query('redirect_uri') ?? '').host; } catch { /* validated above */ }
    return c.json({ client_name: valid.client.client_name, redirect_host, scopes: valid.scopes,
      workspaces: (await repo.listMembershipsWithWorkspace(session.user_id)).map((w) => ({ id: w.id, name: w.name })) });
  });
  app.post('/mcp/oauth/authorize', async (c) => {
    const session = await bearerSession(repo, c.req.header('authorization'));
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    const valid = validateAuthorization(repo, c.req.query(), c.req.url);
    if ('error' in valid) return c.json({ error: valid.error }, 400);
    const body = z.object({ approve: z.literal(true), workspace_ids: z.array(z.string()).min(1) }).safeParse(await c.req.json().catch(() => ({})));
    let notMember = false;
    if (body.success) {
      for (const id of body.data.workspace_ids) {
        if (!await repo.getMembership(id, session.user_id)) { notMember = true; break; }
      }
    }
    if (!body.success || notMember) return c.json({ error: 'invalid_grant' }, 400);
    const code = `oac_${nanoid(40)}`;
    repo.db.prepare(`INSERT INTO oauth_authorization_codes
      (code_hash, client_id, user_id, redirect_uri, resource, scopes, workspace_ids, code_challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash(code), valid.client.client_id, session.user_id, c.req.query('redirect_uri'), valid.resource,
        JSON.stringify(valid.scopes), JSON.stringify(body.data.workspace_ids), c.req.query('code_challenge'), new Date(Date.now() + 5 * 60_000).toISOString());
    const redirect = new URL(c.req.query('redirect_uri')!); redirect.searchParams.set('code', code);
    if (c.req.query('state')) redirect.searchParams.set('state', c.req.query('state')!);
    return c.json({ redirect_uri: redirect.toString() });
  });

  app.post('/mcp/oauth/token', async (c) => {
    const form = await c.req.parseBody();
    if (form.grant_type === 'authorization_code') {
      const row = repo.db.prepare(`SELECT * FROM oauth_authorization_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
        .get(hash(String(form.code || '')), nowIso()) as any;
      if (!row || row.client_id !== form.client_id || row.redirect_uri !== form.redirect_uri || row.resource !== form.resource) return c.json({ error: 'invalid_grant' }, 400);
      const challenge = createHash('sha256').update(String(form.code_verifier || '')).digest('base64url');
      const a = Buffer.from(challenge), b = Buffer.from(row.code_challenge);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'invalid_grant' }, 400);
      const result = repo.db.transaction(() => {
        const used = repo.db.prepare(`UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL`).run(nowIso(), hash(String(form.code))).changes;
        if (!used) return null;
        const grantId = `og_${nanoid(20)}`;
        repo.db.prepare(`INSERT INTO oauth_grants (id, client_id, user_id, resource, scopes, workspace_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(grantId, row.client_id, row.user_id, row.resource, row.scopes, row.workspace_ids, new Date().toISOString());
        return { grantId, pair: tokenPair(repo, grantId) };
      })();
      if (!result) return c.json({ error: 'invalid_grant' }, 400);
      const grant = { id: result.grantId, user_id: row.user_id, client_id: row.client_id, workspace_ids: row.workspace_ids };
      const meta = requestAuditMeta(c);
      await auditGrant(repo, 'oauth_consent_granted', grant, meta, { scopes: jsonArray(row.scopes) });
      await auditGrant(repo, 'oauth_token_issued', grant, meta, { via: 'authorization_code' });
      const scopes = jsonArray(row.scopes);
      return c.json({ access_token: result.pair.access, token_type: 'Bearer', expires_in: result.pair.expiresIn,
        refresh_token: result.pair.refresh, scope: scopes.join(' ') });
    }
    if (form.grant_type === 'refresh_token') {
      const tokenHash = hash(String(form.refresh_token || ''));
      const replayed = repo.db.prepare(`SELECT t.grant_id, t.family_id, g.user_id, g.client_id, g.workspace_ids, g.revoked_at
          FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.token_hash=? AND t.kind='refresh' AND t.consumed_at IS NOT NULL`)
        .get(tokenHash) as { grant_id: string; family_id: string; user_id: string; client_id: string; workspace_ids: string; revoked_at: string | null } | undefined;
      if (replayed) {
        // Rotation reuse detection: possession of an already-consumed refresh
        // token implies the token family may have been copied. Kill the grant,
        // including the replacement refresh token, rather than merely denying
        // this one replay.
        repo.db.transaction(() => {
          repo.db.prepare(`UPDATE oauth_tokens SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL`).run(nowIso(), replayed.family_id);
          repo.db.prepare(`UPDATE oauth_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL`).run(nowIso(), replayed.grant_id);
        })();
        if (!replayed.revoked_at) {
          await auditGrant(repo, 'oauth_grant_revoked', { id: replayed.grant_id, user_id: replayed.user_id, client_id: replayed.client_id, workspace_ids: replayed.workspace_ids },
            requestAuditMeta(c), { reason: 'refresh_token_reuse' });
        }
        return c.json({ error: 'invalid_grant' }, 400);
      }
      const row = repo.db.prepare(`SELECT t.*, g.client_id, g.resource, g.scopes, g.user_id, g.workspace_ids FROM oauth_tokens t JOIN oauth_grants g ON g.id=t.grant_id
        WHERE t.token_hash=? AND t.kind='refresh' AND t.revoked_at IS NULL AND t.consumed_at IS NULL AND t.expires_at > ? AND g.revoked_at IS NULL`).get(tokenHash, nowIso()) as any;
      if (!row || row.client_id !== form.client_id || row.resource !== form.resource) return c.json({ error: 'invalid_grant' }, 400);
      const pair = repo.db.transaction(() => {
        const used = repo.db.prepare(`UPDATE oauth_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL`).run(nowIso(), tokenHash).changes;
        return used ? tokenPair(repo, row.grant_id, row.family_id) : null;
      })();
      if (!pair) return c.json({ error: 'invalid_grant' }, 400);
      await auditGrant(repo, 'oauth_token_issued', { id: row.grant_id, user_id: row.user_id, client_id: row.client_id, workspace_ids: row.workspace_ids },
        requestAuditMeta(c), { via: 'refresh_token' });
      return c.json({ access_token: pair.access, token_type: 'Bearer', expires_in: pair.expiresIn,
        refresh_token: pair.refresh, scope: jsonArray(row.scopes).join(' ') });
    }
    return c.json({ error: 'unsupported_grant_type' }, 400);
  });

  app.post('/mcp/oauth/revoke', async (c) => {
    const form = await c.req.parseBody();
    const row = repo.db.prepare(`SELECT t.grant_id, g.user_id, g.client_id, g.workspace_ids FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash=? AND g.revoked_at IS NULL`).get(hash(String(form.token || ''))) as
      { grant_id: string; user_id: string; client_id: string; workspace_ids: string } | undefined;
    if (row) {
      repo.db.prepare(`UPDATE oauth_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL`).run(nowIso(), row.grant_id);
      await auditGrant(repo, 'oauth_grant_revoked', { id: row.grant_id, user_id: row.user_id, client_id: row.client_id, workspace_ids: row.workspace_ids },
        requestAuditMeta(c), { reason: 'client_revoked' });
    }
    return c.body(null, 200);
  });
}
