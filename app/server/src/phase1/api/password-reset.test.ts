import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from './routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { hashPassword } from '../../lib/passwords.js';

// Forgotten password: an emailed single-use link (30 min) to choose a new
// password. It never signs anyone in, ends every session, and the answer to
// "send me a link" doesn't reveal whether the account exists.

const OLD = 'harbor willow tide 58';
const NEW = 'copper meadow lantern 31';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-reset-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const repo = new Repo(db);
  const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
  const user = await repo.findOrCreateUser('teacher@school.test');
  await repo.setPasswordHash(user.id, await hashPassword(OLD));
  const post = async (route: string, body: unknown) => {
    const r = await app.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return { db, repo, user, post };
}

describe('forgotten password', () => {
  it('answers the same for an unknown address, without a link', async () => {
    const { db, post } = await fixture();
    const r = await post('/auth/password/forgot', { email: 'nobody@school.test' });
    expect(r).toEqual({ status: 200, data: { sent: true } });
    db.close();
  });

  it('resets the password with a valid link, once, and ends every session', async () => {
    const { db, repo, user, post } = await fixture();
    const session = await repo.createSession(user.id);
    const { data } = await post('/auth/password/forgot', { email: 'Teacher@School.test' });
    const token = data.dev_reset_token as string;
    expect(token).toMatch(/^pwr_/);
    expect((await post('/auth/password/reset/check', { token })).data).toEqual({ valid: true });

    // A password the policy refuses does not burn the link.
    const weak = await post('/auth/password/reset', { token, new_password: 'short' });
    expect(weak.status).toBe(400);
    expect((await post('/auth/password/reset/check', { token })).data).toEqual({ valid: true });

    const ok = await post('/auth/password/reset', { token, new_password: NEW });
    expect(ok).toEqual({ status: 200, data: { ok: true } });
    expect(ok.data).not.toHaveProperty('session');
    expect(await repo.getSession(session)).toBeFalsy();
    expect((await post('/auth/password/login', { email: 'teacher@school.test', password: OLD })).status).toBe(401);
    expect((await post('/auth/password/login', { email: 'teacher@school.test', password: NEW })).status).toBe(200);

    // Single use.
    expect((await post('/auth/password/reset', { token, new_password: 'another fresh phrase 77' })).data).toEqual({ error: 'expired' });
    expect((await post('/auth/password/reset/check', { token })).data).toEqual({ valid: false });
    db.close();
  });

  it('only the newest link works', async () => {
    const { db, post } = await fixture();
    const first = (await post('/auth/password/forgot', { email: 'teacher@school.test' })).data.dev_reset_token;
    const second = (await post('/auth/password/forgot', { email: 'teacher@school.test' })).data.dev_reset_token;
    expect((await post('/auth/password/reset', { token: first, new_password: NEW })).data).toEqual({ error: 'expired' });
    expect((await post('/auth/password/reset', { token: second, new_password: NEW })).status).toBe(200);
    db.close();
  });

  it('refuses an expired link', async () => {
    const { db, repo, post } = await fixture();
    const token = (await post('/auth/password/forgot', { email: 'teacher@school.test' })).data.dev_reset_token;
    await repo.sql.exec(`UPDATE password_reset_tokens SET expires_at = ?`, [new Date(Date.now() - 1000).toISOString()]);
    expect((await post('/auth/password/reset/check', { token })).data).toEqual({ valid: false });
    expect((await post('/auth/password/reset', { token, new_password: NEW })).data).toEqual({ error: 'expired' });
    db.close();
  });

  it('a disabled account gets no link', async () => {
    const { db, repo, user, post } = await fixture();
    await repo.disableUser(user.id);
    expect((await post('/auth/password/forgot', { email: 'teacher@school.test' })).data).toEqual({ sent: true });
    db.close();
  });
});
