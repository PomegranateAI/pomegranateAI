import { describe, it, expect, beforeAll } from 'vitest';
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-session-sec-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?session-security-test=' + Date.now());
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

async function signIn(app: any, email: string) {
  const m = await req(app, 'POST', '/auth/magic-link', { email });
  const ex = await req(app, 'POST', '/auth/exchange', { code: m.json.dev_code });
  return { token: ex.json.session as string, user_id: ex.json.user.id as string };
}

describe('sign-out', () => {
  it('revokes the session server-side, so the token stops working', async () => {
    const { app } = await loadApp();
    const { token } = await signIn(app, 'logout@example.com');
    expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(200);

    const out = await req(app, 'POST', '/auth/logout', undefined, token);
    expect(out.status).toBe(200);

    expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(401);
  });

  it('only revokes the session it was called with', async () => {
    const { app } = await loadApp();
    const a = await signIn(app, 'two-devices@example.com');
    const b = await signIn(app, 'two-devices@example.com');
    await req(app, 'POST', '/auth/logout', undefined, a.token);
    expect((await req(app, 'GET', '/me', undefined, a.token)).status).toBe(401);
    expect((await req(app, 'GET', '/me', undefined, b.token)).status).toBe(200);
  });

  it('requires a valid session', async () => {
    const { app } = await loadApp();
    expect((await req(app, 'POST', '/auth/logout')).status).toBe(401);
    expect((await req(app, 'POST', '/auth/logout', undefined, 'sess_not_a_real_one')).status).toBe(401);
  });
});

describe('account events in the customer audit log', () => {
  async function auditEvents(app: any, ws: string, token: string): Promise<any[]> {
    const r = await app.request(`/workspaces/${ws}/customer-audit?limit=200`, {
      headers: { Authorization: `Bearer ${token}`, 'x-workspace-id': ws },
    });
    return (await r.json()).entries;
  }

  it('records failed password sign-in, password change and sign-out', async () => {
    const { app } = await loadApp();
    const email = 'audited@example.com';
    const { token } = await signIn(app, email);
    const ws = (await req(app, 'POST', '/workspaces', { profile_id: 'notes', name: 'Audited' }, token)).json;

    expect((await req(app, 'PUT', '/me/password', { new_password: 'first-password-123' }, token)).status).toBe(200);
    expect(
      (await req(app, 'PUT', '/me/password', { current_password: 'first-password-123', new_password: 'second-password-456' }, token)).status,
    ).toBe(200);
    expect((await req(app, 'POST', '/auth/password/login', { email, password: 'wrong-password-000' })).status).toBe(401);
    const second = await req(app, 'POST', '/auth/password/login', { email, password: 'second-password-456' });
    expect(second.status).toBe(200);
    await req(app, 'POST', '/auth/logout', undefined, token);

    const entries = await auditEvents(app, ws.id, second.json.session);
    const events = entries.map((e) => e.event);
    expect(events).toContain('sign_in_failed');
    expect(events).toContain('sign_out');
    const pw = entries.filter((e) => e.event === 'password_changed');
    expect(pw).toHaveLength(2);
    const firsts = pw.map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload).first_password).sort();
    expect(firsts).toEqual([false, true]);
    // No password ever lands in the audit payloads.
    expect(JSON.stringify(entries)).not.toContain('password-');
  });

  it('a failed sign-in for an unknown email writes no audit row anywhere', async () => {
    const { app } = await loadApp();
    const { token } = await signIn(app, 'bystander@example.com');
    const ws = (await req(app, 'POST', '/workspaces', { profile_id: 'notes', name: 'Bystander' }, token)).json;
    await req(app, 'POST', '/auth/password/login', { email: 'nobody@example.com', password: 'whatever-12345' });
    const events = (await auditEvents(app, ws.id, token)).map((e) => e.event);
    expect(events).not.toContain('sign_in_failed');
  });
});

describe('session tokens at rest', () => {
  it('stores only a hash of the session token', async () => {
    const { app, repo } = await loadApp();
    const { token, user_id } = await signIn(app, 'hashed@example.com');
    const rows = repo.db.prepare(`SELECT token FROM sessions WHERE user_id = ?`).all(user_id) as Array<{ token: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.token).not.toBe(token);
      expect(r.token).toMatch(/^h:[0-9a-f]{64}$/);
    }
    // ...and the raw token from the database does not work as a credential.
    expect((await req(app, 'GET', '/me', undefined, rows[0].token)).status).toBe(401);
    expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(200);
  });

  it('migration hashes pre-existing plaintext sessions without signing anyone out', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { migrate } = await import('../db/schema.js');
    const { Repo } = await import('../db/repo.js');
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO users (id, email, created_at) VALUES ('u_legacy', 'legacy@example.com', datetime('now'))`).run();
    const legacy = 'sess_legacyPlaintextToken123';
    db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, 'u_legacy', ?, ?)`).run(
      legacy,
      new Date().toISOString(),
      new Date(Date.now() + 3600_000).toISOString(),
    );
    migrate(db); // boot again
    migrate(db); // and again: idempotent
    const stored = db.prepare(`SELECT token FROM sessions`).all() as Array<{ token: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0].token).toMatch(/^h:[0-9a-f]{64}$/);
    expect(await new Repo(db).getSession(legacy)).toEqual({ user_id: 'u_legacy', mfa_enrollment_required: false, password_change_required: false, via_sso: false });
  });
});

describe('session limits', () => {
  it('ends a session after the idle timeout, and deletes it', async () => {
    const { app, repo } = await loadApp();
    const { token, user_id } = await signIn(app, 'idle@example.com');
    process.env.SESSION_IDLE_MINUTES = '30';
    try {
      const stale = new Date(Date.now() - 31 * 60_000).toISOString();
      repo.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE user_id = ?`).run(stale, user_id);
      expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(401);
      expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?`).get(user_id)).toEqual({ n: 0 });
    } finally {
      delete process.env.SESSION_IDLE_MINUTES;
    }
  });

  it('activity keeps a session alive past the idle window', async () => {
    const { app, repo } = await loadApp();
    const { token, user_id } = await signIn(app, 'active@example.com');
    process.env.SESSION_IDLE_MINUTES = '30';
    try {
      const recent = new Date(Date.now() - 20 * 60_000).toISOString();
      repo.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE user_id = ?`).run(recent, user_id);
      expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(200);
      const seen = (repo.db.prepare(`SELECT last_seen_at FROM sessions WHERE user_id = ?`).get(user_id) as any).last_seen_at;
      expect(Date.now() - Date.parse(seen)).toBeLessThan(5_000); // stamped by that request
    } finally {
      delete process.env.SESSION_IDLE_MINUTES;
    }
  });

  it('honours SESSION_TTL_HOURS for new sessions and rejects an expired one the same day', async () => {
    const { app, repo } = await loadApp();
    process.env.SESSION_TTL_HOURS = '12';
    try {
      const { token, user_id } = await signIn(app, 'ttl@example.com');
      const row = repo.db.prepare(`SELECT created_at, expires_at FROM sessions WHERE user_id = ?`).get(user_id) as any;
      expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(12 * 3600_000);
      // Expired one second ago: must fail even though the date part is today
      // (a text comparison against datetime('now') used to let this through).
      repo.db.prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`).run(new Date(Date.now() - 1000).toISOString(), user_id);
      expect((await req(app, 'GET', '/me', undefined, token)).status).toBe(401);
    } finally {
      delete process.env.SESSION_TTL_HOURS;
    }
  });

  it('sign out everywhere revokes every session of the user only', async () => {
    const { app } = await loadApp();
    const a = await signIn(app, 'everywhere@example.com');
    const b = await signIn(app, 'everywhere@example.com');
    const other = await signIn(app, 'someone-else@example.com');
    const r = await req(app, 'POST', '/auth/logout-all', undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.json.revoked).toBe(2);
    expect((await req(app, 'GET', '/me', undefined, a.token)).status).toBe(401);
    expect((await req(app, 'GET', '/me', undefined, b.token)).status).toBe(401);
    expect((await req(app, 'GET', '/me', undefined, other.token)).status).toBe(200);
  });

  it('changing the password signs out other sessions but keeps the current one', async () => {
    const { app } = await loadApp();
    const a = await signIn(app, 'pwchange@example.com');
    const b = await signIn(app, 'pwchange@example.com');
    expect((await req(app, 'PUT', '/me/password', { new_password: 'brand-new-password-1' }, a.token)).status).toBe(200);
    expect((await req(app, 'GET', '/me', undefined, a.token)).status).toBe(200);
    expect((await req(app, 'GET', '/me', undefined, b.token)).status).toBe(401);
  });
});
