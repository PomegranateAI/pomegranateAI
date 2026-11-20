import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

// OIDC single sign-on against a fake identity provider, the
// SSO-required policy with break-glass, and SCIM deprovisioning of a leaver.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

const ISSUER = 'https://idp.example.test';
const CLIENT = 'pomegranate-client';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', use: 'sig', alg: 'RS256' };
const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function idToken(claims: Record<string, unknown>): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })));
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  return `${h}.${p}.${b64url(cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey))}`;
}

// What the fake IdP puts in the next ID token (per test).
let nextClaims: (nonce: string) => Record<string, unknown> = () => ({});
let lastNonce = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-sso-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  process.env.PUBLIC_ORIGIN = 'https://app.example.org';
  process.env.SSO_OIDC_ISSUER = ISSUER;
  process.env.SSO_OIDC_CLIENT_ID = CLIENT;
  process.env.SSO_OIDC_CLIENT_SECRET = 'shh';
  process.env.SSO_ALLOWED_DOMAINS = 'example.test';
  process.env.SSO_IDP_ENFORCES_MFA = '1';
  process.env.SCIM_TOKEN = 'scim-secret-token';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` }));
    }
    if (url === `${ISSUER}/jwks`) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('code_verifier')).toBeTruthy();
      return new Response(JSON.stringify({ id_token: idToken(nextClaims(lastNonce)) }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const k of ['SSO_OIDC_ISSUER', 'SSO_OIDC_CLIENT_ID', 'SSO_OIDC_CLIENT_SECRET', 'SSO_ALLOWED_DOMAINS', 'SSO_IDP_ENFORCES_MFA', 'SCIM_TOKEN', 'SSO_REQUIRED', 'SSO_BREAK_GLASS_EMAILS', 'PUBLIC_ORIGIN']) delete process.env[k];
});

async function loadApp() {
  return import('./server.js?sso=' + Date.now());
}

const good = (email: string) => (nonce: string) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: `sub-${email}`,
  email,
  email_verified: true,
  nonce,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 600,
});

/** Run the browser side of the flow; returns the final redirect location. */
async function ssoLogin(app: any): Promise<string> {
  const start = await app.request('/auth/sso/start');
  expect(start.status).toBe(302);
  const auth = new URL(start.headers.get('location')!);
  expect(auth.origin + auth.pathname).toBe(`${ISSUER}/authorize`);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  lastNonce = auth.searchParams.get('nonce')!;
  const cb = await app.request(`/auth/sso/callback?code=abc&state=${auth.searchParams.get('state')}`);
  expect(cb.status).toBe(302);
  return cb.headers.get('location')!;
}

async function exchange(app: any, location: string) {
  const code = new URL(location).searchParams.get('sso');
  const r = await app.request('/auth/sso/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return { status: r.status, json: await r.json() };
}

describe('single sign-on (OIDC)', () => {
  it('signs an invited user in, with an SSO session and an audit entry', async () => {
    const { app, repo } = await loadApp();
    await repo.findOrCreateUser('teacher@example.test');
    nextClaims = good('teacher@example.test');
    const loc = await ssoLogin(app);
    expect(loc).toMatch(/^https:\/\/app\.example\.org\/\?sso=/);
    const ex = await exchange(app, loc);
    expect(ex.status).toBe(200);
    const me = await app.request('/me', { headers: { Authorization: `Bearer ${ex.json.session}` } });
    expect(me.status).toBe(200);
    expect((await repo.getSession(ex.json.session))?.via_sso).toBe(true);
    // The hand-off code works once.
    expect((await exchange(app, loc)).status).toBe(401);
  });

  it('requires an emailed second step when the identity provider does not enforce MFA', async () => {
    const { app, repo } = await loadApp();
    const user = await repo.findOrCreateUser('two-step@example.test');
    await repo.enableEmailMfa(user.id);
    nextClaims = good(user.email);
    delete process.env.SSO_IDP_ENFORCES_MFA;
    try {
      const ex = await exchange(app, await ssoLogin(app));
      expect(ex.status).toBe(401);
      expect(ex.json).toMatchObject({ error: 'mfa_required', method: 'email' });
      const verified = await app.request('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mfa_token: ex.json.dev_mfa_token }),
      });
      expect(verified.status).toBe(200);
      const session = (await verified.json()).session;
      expect((await repo.getSession(session))?.via_sso).toBe(true);
    } finally {
      process.env.SSO_IDP_ENFORCES_MFA = '1';
    }
  });

  it('refuses accounts that were not invited, foreign domains, and bad tokens', async () => {
    const { app } = await loadApp();
    nextClaims = good('stranger@example.test');
    expect(await ssoLogin(app)).toContain('sso_error=no_account');
    nextClaims = good('someone@gmail.com');
    expect(await ssoLogin(app)).toContain('sso_error=domain_not_allowed');
    nextClaims = (n) => ({ ...good('teacher@example.test')(n), nonce: 'replayed' });
    expect(await ssoLogin(app)).toContain('sso_error=sso_failed');
    nextClaims = (n) => ({ ...good('teacher@example.test')(n), aud: 'another-app' });
    expect(await ssoLogin(app)).toContain('sso_error=sso_failed');
    nextClaims = (n) => ({ ...good('teacher@example.test')(n), exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await ssoLogin(app)).toContain('sso_error=sso_failed');
  });

  it('accepts Entra preferred_username when there is no email claim', async () => {
    const { app, repo } = await loadApp();
    await repo.findOrCreateUser('head@example.test');
    nextClaims = (n) => {
      const { email, email_verified, ...rest } = good('head@example.test')(n) as any;
      return { ...rest, preferred_username: 'Head@Example.test' };
    };
    expect((await exchange(app, await ssoLogin(app))).status).toBe(200);
  });
});

describe('SSO required + break-glass', () => {
  it('blocks email links and passwords except for break-glass admins, who must use two-step', async () => {
    const { app, repo } = await loadApp();
    process.env.SSO_REQUIRED = '1';
    process.env.SSO_BREAK_GLASS_EMAILS = 'admin@example.test';
    try {
      await repo.findOrCreateUser('staff@example.test');
      await repo.findOrCreateUser('admin@example.test');
      const post = (email: string) =>
        app.request('/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      expect((await (await post('staff@example.test')).json()).error).toBe('sso_required');
      const r = await (await post('admin@example.test')).json();
      expect(r.dev_code).toBeTruthy();
      const ex = await app.request('/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: r.dev_code }) });
      expect((await ex.json()).mfa_enrollment_required).toBe(true);
      const cfg = await (await app.request('/auth/sso/config')).json();
      expect(cfg).toMatchObject({ enabled: true, required: true });
    } finally {
      delete process.env.SSO_REQUIRED;
      delete process.env.SSO_BREAK_GLASS_EMAILS;
    }
  });
});

describe('SCIM deprovisioning', () => {
  const scim = (app: any, method: string, url: string, body?: unknown, token = 'scim-secret-token') =>
    app.request(url, {
      method,
      headers: { 'content-type': 'application/scim+json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('a leaver disabled by the identity provider loses every way in, audited', async () => {
    const { app, repo } = await loadApp();
    const user = await repo.findOrCreateUser('leaver@example.test');
    const w = await repo.createWorkspace({ name: 'Leavers', owner_email: 'owner@example.test' });
    await repo.addMember({ workspace_id: w.id, user_id: user.id, role: 'member' });
    nextClaims = good('leaver@example.test');
    const session = (await exchange(app, await ssoLogin(app))).json.session;
    const mcp = await repo.issueMcpToken({ workspace_id: w.id, user_id: user.id });

    expect((await scim(app, 'GET', '/scim/v2/Users?filter=userName eq "leaver@example.test"', undefined, 'wrong')).status).toBe(401);
    const list = await (await scim(app, 'GET', '/scim/v2/Users?filter=userName eq "leaver@example.test"')).json();
    expect(list.Resources[0]).toMatchObject({ userName: 'leaver@example.test', active: true });

    const patch = await scim(app, 'PATCH', `/scim/v2/Users/${user.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect((await patch.json()).active).toBe(false);
    expect((await app.request('/me', { headers: { Authorization: `Bearer ${session}` } })).status).toBe(401);
    expect((await app.request('/mcp/tools/list_folders', { method: 'POST', headers: { Authorization: `Bearer ${mcp.token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect(await ssoLogin(app)).toContain('sso_error=account_disabled');
    const audit = await repo.listCustomerAudit(w.id, { event: 'account_disabled' });
    expect(audit.length).toBe(1);

    await scim(app, 'PATCH', `/scim/v2/Users/${user.id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
    expect((await exchange(app, await ssoLogin(app))).status).toBe(200);
  });
});
