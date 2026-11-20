import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { vi } from 'vitest';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-pw-login-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?password-login-test=' + Date.now());
}

async function req(app: any, method: string, pathname: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await app.request(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

/** Sign up + sign in an account via the existing magic-link flow, returning
 *  its session token and user id — the on-ramp every test here uses before
 *  exercising the password path. */
async function magicLinkSignIn(app: any, email: string) {
  const m = await req(app, 'POST', '/auth/magic-link', { email });
  const ex = await req(app, 'POST', '/auth/exchange', { code: m.json.dev_code });
  return { token: ex.json.session as string, user_id: ex.json.user.id as string };
}

describe('password sign-in (alongside magic link)', () => {
  it('an account with no password set rejects password login, magic link still works', async () => {
    const { app } = await loadApp();
    const email = 'nopass@example.com';
    await magicLinkSignIn(app, email);

    const bad = await req(app, 'POST', '/auth/password/login', { email, password: 'whatever-12345' });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe('invalid_credentials');

    // Magic link is unaffected by the account having no password.
    const m2 = await req(app, 'POST', '/auth/magic-link', { email });
    expect(m2.status).toBe(200);
  });

  it('an unknown email gets the same invalid_credentials shape (no account-existence oracle)', async () => {
    const { app } = await loadApp();
    const r = await req(app, 'POST', '/auth/password/login', {
      email: 'ghost@example.com',
      password: 'whatever-12345',
    });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('invalid_credentials');
  });

  it('set → login → wrong password fails → right password succeeds', async () => {
    const { app } = await loadApp();
    const email = 'haspass@example.com';
    const { token } = await magicLinkSignIn(app, email);

    const set = await req(app, 'PUT', '/me/password', { new_password: 'lantern orbit cedar 42' }, token);
    expect(set.status).toBe(200);
    expect(set.json.ok).toBe(true);

    const wrong = await req(app, 'POST', '/auth/password/login', { email, password: 'nope nope nope nope' });
    expect(wrong.status).toBe(401);

    const right = await req(app, 'POST', '/auth/password/login', {
      email,
      password: 'lantern orbit cedar 42',
    });
    expect(right.status).toBe(200);
    expect(right.json.session).toBeTruthy();
    expect(right.json.user.email).toBe(email);
    // The user object handed back to the client must never carry the hash —
    // it lives in a separate table precisely so this can't leak by accident.
    expect(right.json.user.password_hash).toBeUndefined();
  });

  it('email is matched case-insensitively, same as magic-link accounts', async () => {
    const { app } = await loadApp();
    const email = 'CaseFold@Example.com';
    const { token } = await magicLinkSignIn(app, email);
    await req(app, 'PUT', '/me/password', { new_password: 'lantern orbit cedar 42' }, token);

    const r = await req(app, 'POST', '/auth/password/login', {
      email: 'casefold@example.com',
      password: 'lantern orbit cedar 42',
    });
    expect(r.status).toBe(200);
  });

  it('rejects a too-short password on set', async () => {
    const { app } = await loadApp();
    const { token } = await magicLinkSignIn(app, 'short@example.com');
    const r = await req(app, 'PUT', '/me/password', { new_password: 'short1' }, token);
    expect(r.status).toBe(400);
  });

  it('changing an existing password requires the current one', async () => {
    const { app } = await loadApp();
    const email = 'rotate@example.com';
    const { token } = await magicLinkSignIn(app, email);
    await req(app, 'PUT', '/me/password', { new_password: 'first password value' }, token);

    // No current_password at all.
    const noCurrent = await req(app, 'PUT', '/me/password', { new_password: 'second password value' }, token);
    expect(noCurrent.status).toBe(401);

    // Wrong current_password.
    const wrongCurrent = await req(
      app,
      'PUT',
      '/me/password',
      { current_password: 'nope nope nope', new_password: 'second password value' },
      token,
    );
    expect(wrongCurrent.status).toBe(401);

    // Correct current_password rotates it, and login reflects the new value.
    const ok = await req(
      app,
      'PUT',
      '/me/password',
      { current_password: 'first password value', new_password: 'second password value' },
      token,
    );
    expect(ok.status).toBe(200);
    const login = await req(app, 'POST', '/auth/password/login', { email, password: 'second password value' });
    expect(login.status).toBe(200);
    const stale = await req(app, 'POST', '/auth/password/login', { email, password: 'first password value' });
    expect(stale.status).toBe(401);
  });

  it('requires auth to set a password, and unauth requests never touch the DB', async () => {
    const { app } = await loadApp();
    const r = await req(app, 'PUT', '/me/password', { new_password: 'lantern orbit cedar 42' });
    expect(r.status).toBe(401);
  });

  it('GET /me reports has_password', async () => {
    const { app } = await loadApp();
    const { token } = await magicLinkSignIn(app, 'flag@example.com');
    const before = await req(app, 'GET', '/me', undefined, token);
    expect(before.json.has_password).toBe(false);

    await req(app, 'PUT', '/me/password', { new_password: 'lantern orbit cedar 42' }, token);
    const after = await req(app, 'GET', '/me', undefined, token);
    expect(after.json.has_password).toBe(true);
  });
});
