import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from './routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { generateTemporaryPassword, passwordPolicyError } from '../../lib/passwords.js';

// User admin: temporary passwords are generated when the admin leaves the
// field empty, and the account can be emailed its address + password.

async function fixture(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-invite-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const repo = new Repo(db);
  const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
  const admin = await repo.findOrCreateUser('root@school.test');
  await repo.sql.exec('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
  const token = await repo.createSession(admin.id);
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await app.request(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  return { app, repo, db, call };
}

const login = (app: any, email: string, password: string) =>
  app.request('/auth/password/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.PUBLIC_ORIGIN;
  vi.unstubAllGlobals();
});

describe('generateTemporaryPassword', () => {
  it('is four groups of four unambiguous characters, random, and passes the policy', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
      expect(passwordPolicyError(pw)).toBeNull();
      seen.add(pw);
    }
    expect(seen.size).toBe(200);
  });
});

describe('User admin invites', () => {
  it('generates a temporary password when none is given, and it signs in', async () => {
    const { app, db, call } = await fixture();
    const created = await call('POST', '/admin/users', { email: 'new@school.test' });
    expect(created.status).toBe(201);
    expect(created.data.temporary_password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(created.data.emailed).toBe(false);
    expect((await login(app, 'new@school.test', created.data.temporary_password)).status).toBe(200);
    db.close();
  });

  it("keeps the admin's own password when one is given", async () => {
    const { app, db, call } = await fixture();
    const created = await call('POST', '/admin/users', { email: 'own@school.test', password: 'harbor willow tide 58' });
    expect(created.data.temporary_password).toBe('harbor willow tide 58');
    expect((await login(app, 'own@school.test', 'harbor willow tide 58')).status).toBe(200);
    db.close();
  });

  it('emails the address and temporary password on create and on reset, only when asked', async () => {
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }));
    const { db, call } = await fixture({ RESEND_API_KEY: 're_test', MAIL_FROM: 'Pomegranate <noreply@example.org>', PUBLIC_ORIGIN: 'https://example.org' });

    const quiet = await call('POST', '/admin/users', { email: 'quiet@school.test' });
    expect(quiet.data.emailed).toBe(false);
    expect(sent).toHaveLength(0);

    const created = await call('POST', '/admin/users', { email: 'invited@school.test', send_invite: true });
    expect(created.data.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Your Pomegranate account');
    expect(JSON.stringify(sent[0]!.to)).toContain('invited@school.test');
    expect(sent[0]!.text).toContain('https://example.org');
    expect(sent[0]!.text).toContain(created.data.temporary_password);

    const reset = await call('PUT', `/admin/users/${created.data.user.id}/password`, { send_invite: true });
    expect(reset.status).toBe(200);
    expect(reset.data.temporary_password).not.toBe(created.data.temporary_password);
    expect(reset.data.emailed).toBe(true);
    expect(sent[1]!.subject).toBe('Your new Pomegranate temporary password');
    expect(sent[1]!.text).toContain(reset.data.temporary_password);
    db.close();
  });

  it('names the email when it is not a full address (the browser accepts name@school)', async () => {
    const { db, call } = await fixture();
    for (const email of ['name@school', 'not-an-email', '']) {
      const r = await call('POST', '/admin/users', { email });
      expect(r.status).toBe(400);
      expect(r.data).toEqual({ error: 'invalid_email' });
    }
    db.close();
  });

  it('still refuses a weak password the admin typed', async () => {
    const { db, call } = await fixture();
    expect((await call('POST', '/admin/users', { email: 'weak@school.test', password: 'password1234' })).status).toBe(400);
    db.close();
  });
});
