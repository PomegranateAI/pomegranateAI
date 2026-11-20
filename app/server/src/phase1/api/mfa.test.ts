import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { vi } from 'vitest';

// Deterministic stub instead of a real LLM provider.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mfa-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

afterEach(() => {
  delete process.env.MFA_REQUIRED;
});

async function loadApp() {
  return import('./server.js?mfa-test=' + Date.now());
}

async function req(app: any, method: string, pathname: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await app.request(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function magic(app: any, email: string) {
  const m = await req(app, 'POST', '/auth/magic-link', { email });
  return req(app, 'POST', '/auth/exchange', { code: m.json.dev_code });
}

async function passwordLogin(app: any, email: string, password = PASSWORD) {
  return req(app, 'POST', '/auth/password/login', { email, password });
}

const PASSWORD = 'a-good-long-password';

/** Sign in, set a password, turn email MFA on. Returns the session. */
async function enrolled(app: any, email: string) {
  const s = await magic(app, email);
  const token = s.json.session as string;
  expect((await req(app, 'PUT', '/me/password', { new_password: PASSWORD }, token)).status).toBe(200);
  expect((await req(app, 'POST', '/me/mfa/enable', undefined, token)).status).toBe(200);
  return { token, user_id: s.json.user.id as string };
}

describe('turning email MFA on', () => {
  it('needs a password first', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'nopw@example.com');
    const token = s.json.session;
    expect((await req(app, 'GET', '/me/mfa', undefined, token)).json).toMatchObject({ enabled: false, has_password: false });
    const r = await req(app, 'POST', '/me/mfa/enable', undefined, token);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('password_required');

    await req(app, 'PUT', '/me/password', { new_password: PASSWORD }, token);
    expect((await req(app, 'POST', '/me/mfa/enable', undefined, token)).status).toBe(200);
    expect((await req(app, 'GET', '/me/mfa', undefined, token)).json).toMatchObject({ enabled: true, has_password: true });
  });
});

describe('MFA sign-in: password, then the emailed link', () => {
  it('the password alone no longer signs in; the link completes it, once', async () => {
    const { app } = await loadApp();
    await enrolled(app, 'two-step@example.com');
    const first = await passwordLogin(app, 'two-step@example.com');
    expect(first.status).toBe(401);
    expect(first.json).toMatchObject({ error: 'mfa_required', method: 'email' });
    expect(first.json.session).toBeUndefined();
    // No mailer in tests: the link token comes back inline (dev mode).
    const mfa_token = first.json.dev_mfa_token;
    expect(mfa_token).toMatch(/^mfa_/);

    const done = await req(app, 'POST', '/auth/mfa/verify', { mfa_token });
    expect(done.status).toBe(200);
    expect((await req(app, 'GET', '/me', undefined, done.json.session)).status).toBe(200);
    // The link is spent.
    const again = await req(app, 'POST', '/auth/mfa/verify', { mfa_token });
    expect(again.status).toBe(401);
    expect(again.json.error).toBe('expired');
  });

  it('a wrong password sends no link', async () => {
    const { app } = await loadApp();
    await enrolled(app, 'wrongpw@example.com');
    const r = await passwordLogin(app, 'wrongpw@example.com', 'not-the-password');
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid_credentials');
    expect(r.json.dev_mfa_token).toBeUndefined();
  });

  it('a magic link alone is refused for an account with MFA on', async () => {
    const { app } = await loadApp();
    await enrolled(app, 'magic-only@example.com');
    const r = await magic(app, 'magic-only@example.com');
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('password_required');
    expect(r.json.session).toBeUndefined();
  });

  it('an expired link is refused', async () => {
    const { app, repo } = await loadApp();
    await enrolled(app, 'expired@example.com');
    const mfa_token = (await passwordLogin(app, 'expired@example.com')).json.dev_mfa_token;
    repo.db.prepare(`UPDATE mfa_challenges SET expires_at = ?`).run(new Date(Date.now() - 1000).toISOString());
    const r = await req(app, 'POST', '/auth/mfa/verify', { mfa_token });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('expired');
  });

  it('the link is audited as a two-step sign-in', async () => {
    const { app } = await loadApp();
    // Account events land in the account's workspaces: make one first.
    const token = (await magic(app, 'audit@example.com')).json.session;
    const ws = (await req(app, 'POST', '/workspaces', { profile_id: 'notes', name: 'Audit' }, token)).json;
    await req(app, 'PUT', '/me/password', { new_password: PASSWORD }, token);
    await req(app, 'POST', '/me/mfa/enable', undefined, token);
    const mfa_token = (await passwordLogin(app, 'audit@example.com')).json.dev_mfa_token;
    const done = await req(app, 'POST', '/auth/mfa/verify', { mfa_token });
    const audit = await app.request(`/workspaces/${ws.id}/customer-audit?limit=200`, {
      headers: { Authorization: `Bearer ${done.json.session}`, 'x-workspace-id': ws.id },
    });
    const entries = (await audit.json()).entries;
    expect(entries.map((e: any) => e.event)).toContain('mfa_enabled');
    const signIns = entries.filter((e: any) => e.event === 'sign_in').map((e: any) => JSON.parse(e.payload));
    expect(signIns).toContainEqual({ method: 'password', mfa: 'email' });
  });

  it('turning MFA off needs the current password', async () => {
    const { app } = await loadApp();
    const { token } = await enrolled(app, 'disable@example.com');
    expect((await req(app, 'POST', '/me/mfa/disable', { current_password: 'nope-nope-nope' }, token)).status).toBe(401);
    expect((await req(app, 'POST', '/me/mfa/disable', { current_password: PASSWORD }, token)).status).toBe(200);
    const s = await passwordLogin(app, 'disable@example.com');
    expect(s.status).toBe(200);
    expect(s.json.session).toBeTruthy();
    // And the magic link works on its own again.
    expect((await magic(app, 'disable@example.com')).status).toBe(200);
  });

  it('an account without MFA signs in with the password alone', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'plain@example.com');
    await req(app, 'PUT', '/me/password', { new_password: PASSWORD }, s.json.session);
    const r = await passwordLogin(app, 'plain@example.com');
    expect(r.status).toBe(200);
    expect(r.json.session).toBeTruthy();
  });

  it('carries over accounts enrolled under the old authenticator-app version', async () => {
    const { repo } = await loadApp();
    const user = await repo.findOrCreateUser('legacy-totp@example.com');
    repo.db.exec(`CREATE TABLE IF NOT EXISTS user_mfa (user_id TEXT PRIMARY KEY, secret_enc TEXT NOT NULL, enabled_at TEXT, last_step INTEGER, created_at TEXT NOT NULL)`);
    repo.db.prepare(`INSERT INTO user_mfa VALUES (?, 'v1:x', ?, NULL, ?)`).run(user.id, new Date().toISOString(), new Date().toISOString());
    const { migrate } = await import('../db/schema.js');
    migrate(repo.db);
    migrate(repo.db); // idempotent
    expect(await repo.emailMfaEnabled(user.id)).toBe(true);
  });
});

describe('MFA_REQUIRED policy', () => {
  it('admins: an admin without a password gets a set-a-password-only session, then needs password + link', async () => {
    const { app } = await loadApp();
    const first = await magic(app, 'policy-admin@example.com');
    const ws = (await req(app, 'POST', '/workspaces', { profile_id: 'notes', name: 'Pol' }, first.json.session)).json;
    expect(ws.id).toBeTruthy();
    process.env.MFA_REQUIRED = 'admins';

    const s = await magic(app, 'policy-admin@example.com');
    expect(s.status).toBe(200);
    expect(s.json.mfa_enrollment_required).toBe(true);
    const token = s.json.session;
    const blocked = await req(app, 'GET', '/workspaces', undefined, token);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('mfa_enrollment_required');
    expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(200);
    expect((await req(app, 'GET', '/me/mfa', undefined, token)).json).toMatchObject({ required: true, has_password: false });

    expect((await req(app, 'PUT', '/me/password', { new_password: PASSWORD }, token)).status).toBe(200);
    // Same session, now unrestricted.
    expect((await req(app, 'GET', '/workspaces', undefined, token)).status).toBe(200);
    // Policy blocks switching it off.
    expect((await req(app, 'POST', '/me/mfa/disable', { current_password: PASSWORD }, token)).status).toBe(403);
    // From now on: magic link alone refused, password needs the link.
    expect((await magic(app, 'policy-admin@example.com')).status).toBe(403);
    const pw = await passwordLogin(app, 'policy-admin@example.com');
    expect(pw.json.error).toBe('mfa_required');
    expect((await req(app, 'POST', '/auth/mfa/verify', { mfa_token: pw.json.dev_mfa_token })).status).toBe(200);
  });

  it('admins: a plain member is not covered', async () => {
    const { app } = await loadApp();
    process.env.MFA_REQUIRED = 'admins';
    const s = await magic(app, 'policy-member@example.com');
    expect(s.json.mfa_enrollment_required).toBeUndefined();
    expect((await req(app, 'GET', '/workspaces', undefined, s.json.session)).status).toBe(200);
  });

  it('all: everyone is covered', async () => {
    const { app } = await loadApp();
    process.env.MFA_REQUIRED = 'all';
    const s = await magic(app, 'policy-all@example.com');
    expect(s.json.mfa_enrollment_required).toBe(true);
  });
});
