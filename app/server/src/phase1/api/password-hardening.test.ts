import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { hashPassword, isBreachedPassword, passwordPolicyError } from '../../lib/passwords.js';

// Deterministic stub instead of a real LLM provider.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-pw-hard-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});
afterEach(() => {
  delete process.env.PASSWORD_BREACH_CHECK;
});

async function loadApp() {
  return import('./server.js?password-hardening-test=' + Date.now());
}

async function req(app: any, method: string, pathname: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await app.request(pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function magic(app: any, email: string) {
  const m = await req(app, 'POST', '/auth/magic-link', { email });
  return (await req(app, 'POST', '/auth/exchange', { code: m.json.dev_code })).json as { session: string; user: { id: string } };
}

describe('password policy', () => {
  it('refuses common, low-variety and self-referential passwords; accepts a decent one', () => {
    expect(passwordPolicyError('short')).toMatch(/12 characters/);
    expect(passwordPolicyError('password1234')).toBe('password is too common');
    expect(passwordPolicyError('Password!2024')).toBe('password is too easy to guess');
    expect(passwordPolicyError('aaaaaaabbbbb')).toBe('password is too easy to guess');
    expect(passwordPolicyError('fatima.khalil-2026', { email: 'fatima.khalil@example.org' })).toBe(
      'password must not contain your email name',
    );
    expect(passwordPolicyError('my-pomegranate-key-77')).toBe('password must not contain the product name');
    expect(passwordPolicyError('lantern orbit cedar 42')).toBeNull();
    expect(passwordPolicyError('lantern orbit cedar 42', { email: 'ana@example.org' })).toBeNull(); // 'ana' < 4 chars
  });

  it('checks Have I Been Pwned by hash prefix only when enabled, and fails open', async () => {
    const plain = 'lantern orbit cedar 42';
    const sha1 = createHash('sha1').update(plain).digest('hex').toUpperCase();
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(`0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:12\r\n`);
    }) as unknown as typeof fetch;

    expect(await isBreachedPassword(plain, fake)).toBe(false); // off by default
    expect(calls).toHaveLength(0);

    process.env.PASSWORD_BREACH_CHECK = 'hibp';
    expect(await isBreachedPassword(plain, fake)).toBe(true);
    expect(calls[0]).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
    expect(calls[0]).not.toContain(sha1.slice(5)); // only the prefix leaves

    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await isBreachedPassword(plain, failing)).toBe(false);
  });
});

describe('administrator-set password', () => {
  it('must be replaced at first password sign-in before anything else works', async () => {
    const { app, repo } = await loadApp();
    const email = 'given@example.com';
    const { user } = await magic(app, email);
    await repo.setPasswordHash(user.id, await hashPassword('admin-given-pass-1'), { mustChange: true });

    const login = await req(app, 'POST', '/auth/password/login', { email, password: 'admin-given-pass-1' });
    expect(login.status).toBe(200);
    expect(login.json.password_change_required).toBe(true);
    const token = login.json.session;

    const blocked = await req(app, 'GET', '/workspaces', undefined, token);
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('password_change_required');
    expect((await req(app, 'GET', '/me', undefined, token)).json.password_must_change).toBe(true);

    // Re-submitting the given password doesn't count.
    const same = await req(app, 'PUT', '/me/password', { current_password: 'admin-given-pass-1', new_password: 'admin-given-pass-1' }, token);
    expect(same.status).toBe(400);

    const changed = await req(app, 'PUT', '/me/password', { current_password: 'admin-given-pass-1', new_password: 'lantern orbit cedar 42' }, token);
    expect(changed.status).toBe(200);
    expect((await req(app, 'GET', '/workspaces', undefined, token)).status).toBe(200);
    expect(await repo.passwordMustChange(user.id)).toBe(false);
  });

  it('refuses a common password at change time', async () => {
    const { app } = await loadApp();
    const { session } = await magic(app, 'commonpw@example.com');
    const r = await req(app, 'PUT', '/me/password', { new_password: 'password1234' }, session);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('password is too common');
  });
});

describe('repeated sign-in failures', () => {
  it('alerts at 5 failures and locks password sign-in at 10, leaving the magic link open', async () => {
    const { app, repo } = await loadApp();
    const email = 'hammered@example.com';
    const { session, user } = await magic(app, email);
    const ws = (await req(app, 'POST', '/workspaces', { profile_id: 'notes', name: 'Hammered' }, session)).json;
    await req(app, 'PUT', '/me/password', { new_password: 'lantern orbit cedar 42' }, session);

    for (let i = 0; i < 10; i++) {
      expect((await req(app, 'POST', '/auth/password/login', { email, password: `wrong-guess-${i}-xyz` })).status).toBe(401);
    }
    const audit = await app.request(`/workspaces/${ws.id}/customer-audit?limit=500`, {
      headers: { Authorization: `Bearer ${session}`, 'x-workspace-id': ws.id },
    });
    const events = (await audit.json()).entries.map((e: any) => e.event);
    expect(events.filter((e: string) => e === 'sign_in_failures_alert')).toHaveLength(1);

    // Locked: even the right password is refused, with the same answer.
    const right = await req(app, 'POST', '/auth/password/login', { email, password: 'lantern orbit cedar 42' });
    expect(right.status).toBe(401);
    expect(right.json.error).toBe('invalid_credentials');
    // The mailbox owner can still get in.
    expect((await magic(app, email)).session).toBeTruthy();

    // After the lock expires, the right password works and resets the count.
    repo.db.prepare(`UPDATE user_auth_failures SET locked_until = ? WHERE user_id = ?`).run('2000-01-01T00:00:00.000Z', user.id);
    expect((await req(app, 'POST', '/auth/password/login', { email, password: 'lantern orbit cedar 42' })).status).toBe(200);
    expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM user_auth_failures WHERE user_id = ?`).get(user.id)).toEqual({ n: 0 });
  });
});
