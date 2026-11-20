import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from '../api/routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';

const origin = 'https://app.test';
const resource = `${origin}/mcp/server`;

async function fixture() {
  process.env.PUBLIC_ORIGIN = origin;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-oauth-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const repo = new Repo(db);
  const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
  return { app, repo, db };
}

async function json(app: any, route: string, init: RequestInit = {}) {
  const response = await app.request(`${origin}${route}`, init);
  return { response, body: await response.json() };
}

async function sessionAndWorkspace(app: any) {
  const magic = await json(app, '/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'oauth@example.com' }) });
  const login = await json(app, '/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: magic.body.dev_code }) });
  const session = login.body.session as string;
  const ws = await json(app, '/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ name: 'OAuth folder', profile_id: 'notes' }) });
  return { session, workspaceId: ws.body.id as string };
}

async function oauthTokens(app: any, session: string, workspaceId: string, scope = 'context:read offline_access') {
  const registered = await json(app, '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test MCP client', redirect_uris: ['https://client.test/callback'], token_endpoint_auth_method: 'none' }) });
  const clientId = registered.body.client_id as string;
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.test/callback', code_challenge: challenge, code_challenge_method: 'S256', resource, scope, state: 'kept' });
  const approved = await json(app, `/mcp/oauth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ approve: true, workspace_ids: [workspaceId] }) });
  const redirect = new URL(approved.body.redirect_uri);
  expect(redirect.searchParams.get('state')).toBe('kept');
  const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: 'https://client.test/callback', resource, code: redirect.searchParams.get('code')!, code_verifier: verifier });
  const tokens = await json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  return { clientId, ...tokens.body };
}

afterEach(() => { delete process.env.PUBLIC_ORIGIN; vi.useRealTimers(); });

describe('MCP OAuth 2.1 additive authorization', () => {
  it('publishes discovery and challenges unauthenticated MCP requests', async () => {
    const { app, db } = await fixture();
    const metadata = await json(app, '/mcp/.well-known/oauth-protected-resource/server');
    expect(metadata.body.authorization_servers).toEqual([`${origin}/mcp/oauth`]);
    const denied = await app.request(`${origin}/mcp/tools`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('oauth-protected-resource');
    db.close();
  });

  it('runs PKCE, limits tools by scope, rotates refresh tokens, and leaves pmg tokens working', async () => {
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toMatch(/^ort_/);

    const tools = await json(app, '/mcp/tools', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(tools.response.status).toBe(200);
    expect(tools.body.tools.map((t: any) => t.name)).toContain('query_context');
    expect(tools.body.tools.map((t: any) => t.name)).not.toContain('ingest_document');
    const forbidden = await json(app, '/mcp/tools/ingest_document', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: '{}' });
    expect(forbidden.response.status).toBe(403);

    const refreshForm = new URLSearchParams({ grant_type: 'refresh_token', client_id: tokens.clientId, resource, refresh_token: tokens.refresh_token });
    const refreshed = await json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refreshForm });
    expect(refreshed.body.access_token).toMatch(/^oat_/);
    const replay = await json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refreshForm });
    expect(replay.response.status).toBe(400);

    const legacy = await json(app, `/workspaces/${workspaceId}/mcp-tokens`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: '{}' });
    const legacyTools = await json(app, '/mcp/tools', { headers: { authorization: `Bearer ${legacy.body.token}` } });
    expect(legacyTools.body.tools.map((t: any) => t.name)).toContain('ingest_document');
    db.close();
  });
});

// Regression for the same-day expiry bug: expiries were compared against SQLite's
// datetime('now') ("YYYY-MM-DD HH:MM:SS"), but written with toISOString()
// ("YYYY-MM-DDTHH:MM:SS.sssZ"). "T" sorts after " ", so an expiry earlier the
// same UTC day still compared as in the future until midnight.
describe('MCP OAuth expiry', () => {
  const toolsWith = (app: any, token: string) => app.request(`${origin}/mcp/tools`, { headers: { authorization: `Bearer ${token}` } });

  it('rejects an access token that expired a minute ago (same UTC day)', async () => {
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    expect((await toolsWith(app, tokens.access_token)).status).toBe(200);
    db.prepare(`UPDATE oauth_tokens SET expires_at = ? WHERE kind = 'access'`).run(new Date(Date.now() - 60_000).toISOString());
    expect((await toolsWith(app, tokens.access_token)).status).toBe(401);
    db.close();
  });

  it('expires access tokens exactly at the 1-hour mark, across an hour boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T14:00:00.000Z'));
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    vi.setSystemTime(new Date('2026-10-03T14:59:59.000Z'));
    expect((await toolsWith(app, tokens.access_token)).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-03T15:00:01.000Z'));
    expect((await toolsWith(app, tokens.access_token)).status).toBe(401);
    db.close();
  });

  it('expires access tokens across a UTC day boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T23:30:00.000Z'));
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    vi.setSystemTime(new Date('2026-10-04T00:29:59.000Z'));
    expect((await toolsWith(app, tokens.access_token)).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-04T00:30:01.000Z'));
    expect((await toolsWith(app, tokens.access_token)).status).toBe(401);
    db.close();
  });

  it('refuses an authorization code after 5 minutes and a refresh token after 30 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);

    // Authorization code: approve, then redeem 5 min + 1 s later.
    const registered = await json(app, '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Late client', redirect_uris: ['https://client.test/callback'] }) });
    const verifier = 'b'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: registered.body.client_id, redirect_uri: 'https://client.test/callback', code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'context:read' });
    const approved = await json(app, `/mcp/oauth/authorize?${query}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: JSON.stringify({ approve: true, workspace_ids: [workspaceId] }) });
    vi.setSystemTime(new Date('2026-10-03T10:05:01.000Z'));
    const late = await json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.body.client_id, redirect_uri: 'https://client.test/callback', resource, code: new URL(approved.body.redirect_uri).searchParams.get('code')!, code_verifier: verifier }) });
    expect(late.response.status).toBe(400);

    // Refresh token: valid just before 30 days, refused just after.
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    const tokens = await oauthTokens(app, session, workspaceId);
    const refresh = (t: { clientId: string; refresh_token: string }) => json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: t.clientId, resource, refresh_token: t.refresh_token }) });
    vi.setSystemTime(new Date('2026-11-02T10:00:01.000Z'));
    expect((await refresh(tokens)).response.status).toBe(400);
    vi.setSystemTime(new Date('2026-10-03T10:00:00.000Z'));
    const fresh = await oauthTokens(app, session, workspaceId);
    vi.setSystemTime(new Date('2026-11-02T09:59:59.000Z'));
    expect((await refresh(fresh)).response.status).toBe(200);
    db.close();
  });
});

describe('MCP OAuth hardening (8.3)', () => {
  const register = (app: any, redirect_uris: string[], ip = '203.0.113.7') =>
    app.request(`${origin}/mcp/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ client_name: 'c', redirect_uris }) });

  it('rate-limits dynamic client registration per IP', async () => {
    const { app, db } = await fixture();
    for (let i = 0; i < 10; i++) expect((await register(app, ['https://client.test/cb'])).status).toBe(201);
    const limited = await register(app, ['https://client.test/cb']);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await register(app, ['https://client.test/cb'], '198.51.100.9')).status).toBe(201);
    db.close();
  });

  it('deletes clients that never completed an authorization within 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T08:00:00.000Z'));
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const unused = (await (await register(app, ['https://client.test/cb'])).json()).client_id;
    const used = (await oauthTokens(app, session, workspaceId)).clientId;
    vi.setSystemTime(new Date('2026-10-04T08:00:01.000Z'));
    await register(app, ['https://client.test/cb']);
    const ids = (db.prepare('SELECT client_id FROM oauth_clients').all() as { client_id: string }[]).map((r) => r.client_id);
    expect(ids).not.toContain(unused);
    expect(ids).toContain(used);
    db.close();
  });

  it('accepts only https or loopback redirect URIs, without fragments or credentials', async () => {
    const { app, db } = await fixture();
    for (const bad of ['http://client.test/cb', 'https://client.test/cb#frag', 'https://user:pw@client.test/cb', 'javascript:alert(1)', 'custom-scheme://cb']) {
      expect((await register(app, [bad])).status, bad).toBe(400);
    }
    for (const good of ['https://client.test/cb', 'http://127.0.0.1:33418/cb', 'http://localhost:8080/cb']) {
      expect((await register(app, [good])).status, good).toBe(201);
    }
    db.close();
  });

  it('serves the consent page with a strict CSP and no inline script', async () => {
    const { app, db } = await fixture();
    const clientId = (await (await register(app, ['https://client.test/cb'])).json()).client_id;
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.test/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource });
    const page = await app.request(`${origin}/mcp/oauth/authorize?${query}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    const html = await page.text();
    expect(html).not.toMatch(/<script>|<style>|onclick=|onsubmit=/);
    expect(html).toContain('src="consent.js"');
    const js = await app.request(`${origin}/mcp/oauth/consent.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toContain("addEventListener('submit'");
    db.close();
  });

  it('audits consent, token issue and revocation per granted folder', async () => {
    const { app, repo, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    const events = async () => (await repo.listCustomerAudit(workspaceId)).map((r) => r.event);
    expect(await events()).toEqual(expect.arrayContaining(['oauth_consent_granted', 'oauth_token_issued']));
    await app.request(`${origin}/mcp/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.access_token }) });
    expect(await events()).toContain('oauth_grant_revoked');
    const audit = JSON.stringify(await repo.listCustomerAudit(workspaceId));
    expect(audit).not.toContain(tokens.access_token);
    expect(audit).not.toContain(tokens.refresh_token);
    db.close();
  });

  it('revokes the whole token family when a refresh token is reused', async () => {
    const { app, repo, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const tokens = await oauthTokens(app, session, workspaceId);
    const refresh = (t: string) => json(app, '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: tokens.clientId, resource, refresh_token: t }) });
    const rotated = await refresh(tokens.refresh_token);
    expect(rotated.response.status).toBe(200);
    expect((await refresh(tokens.refresh_token)).response.status).toBe(400); // reuse
    expect((await refresh(rotated.body.refresh_token)).response.status).toBe(400); // replacement is dead too
    const denied = await app.request(`${origin}/mcp/tools`, { headers: { authorization: `Bearer ${rotated.body.access_token}` } });
    expect(denied.status).toBe(401);
    const revoked = await repo.listCustomerAudit(workspaceId, { event: 'oauth_grant_revoked' });
    expect(JSON.stringify(revoked[0]?.payload ?? revoked[0])).toContain('refresh_token_reuse');
    db.close();
  });

  it('MCP_CAPABILITY_URLS=0 requires OAuth for assistant access', async () => {
    const { app, db } = await fixture();
    const { session, workspaceId } = await sessionAndWorkspace(app);
    const mint = () => app.request(`${origin}/workspaces/${workspaceId}/connectors`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: '{}' });
    const on = await mint();
    expect(on.status).toBe(200);
    const { path: connectorPath } = await on.json();
    const legacy = await json(app, `/workspaces/${workspaceId}/mcp-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: '{}',
    });
    expect(legacy.response.status).toBe(200);
    const oauth = await oauthTokens(app, session, workspaceId);
    process.env.MCP_CAPABILITY_URLS = '0';
    try {
      expect((await mint()).status).toBe(410);
      expect((await app.request(`${origin}${connectorPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
      expect((await json(app, '/auth/assistant-config')).body).toEqual({ oauth_only: true });
      expect((await json(app, `/workspaces/${workspaceId}/mcp-tokens`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: '{}',
      })).response.status).toBe(410);
      expect((await app.request(`${origin}/mcp/tools`, { headers: { authorization: `Bearer ${legacy.body.token}` } })).status).toBe(401);
      expect((await app.request(`${origin}/mcp/tools`, { headers: { authorization: `Bearer ${oauth.access_token}` } })).status).toBe(200);
    } finally {
      delete process.env.MCP_CAPABILITY_URLS;
    }
    db.close();
  });
});

describe('MCP OAuth consent and MFA', () => {
  it('a session still waiting on required MFA enrolment cannot approve a connection', async () => {
    const { app, db } = await fixture();
    const { workspaceId } = await sessionAndWorkspace(app);
    process.env.MFA_REQUIRED = 'admins';
    try {
      // Re-sign-in under the policy: the admin gets an enrolment-only session.
      const magic = await json(app, '/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'oauth@example.com' }) });
      const login = await json(app, '/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: magic.body.dev_code }) });
      expect(login.body.mfa_enrollment_required).toBe(true);
      const registered = await json(app, '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'C', redirect_uris: ['https://client.test/callback'] }) });
      const query = new URLSearchParams({ response_type: 'code', client_id: registered.body.client_id, redirect_uri: 'https://client.test/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource, scope: 'context:read' });
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${login.body.session}` };
      expect((await app.request(`${origin}/mcp/oauth/authorize/context?${query}`, { headers })).status).toBe(401);
      const post = await app.request(`${origin}/mcp/oauth/authorize?${query}`, { method: 'POST', headers, body: JSON.stringify({ approve: true, workspace_ids: [workspaceId] }) });
      expect(post.status).toBe(401);
    } finally {
      delete process.env.MFA_REQUIRED;
      db.close();
    }
  });
});
