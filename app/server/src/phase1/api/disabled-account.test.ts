import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from './routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { AccountDisabledError } from '../db/repo/identity.js';
import { hashPassword } from '../../lib/passwords.js';

// A disabled account (SCIM leaver, admin action) must lose every way in and
// must not be able to mint a new one from anything issued before the disable.

const PASSWORD = 'harbor willow tide 58';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-disabled-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  const repo = new Repo(db);
  const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
  const ws = await repo.createWorkspace({ name: 'W', owner_email: 'leaver@school.test' });
  const user = (await repo.findUserByEmail('leaver@school.test'))!;
  await repo.setPasswordHash(user.id, await hashPassword(PASSWORD));
  const call = async (method: string, route: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await app.request(route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  /** Mark disabled without disableUser's cleanup: simulates anything that
   *  raced or slipped past it, so the per-path checks are tested on their own. */
  const markDisabled = () => repo.sql.exec(`UPDATE users SET disabled_at = ? WHERE id = ?`, [new Date().toISOString(), user.id]);
  return { db, repo, app, ws, user, call, markDisabled };
}

describe('disabled accounts', () => {
  it("an existing session gets a 401 once the account is disabled", async () => {
    const { db, repo, user, call, markDisabled } = await fixture();
    const session = await repo.createSession(user.id);
    expect((await call('GET', '/me/mfa', undefined, session)).status).toBe(200);
    await markDisabled();
    expect(await repo.getSession(session)).toBeUndefined();
    expect((await call('GET', '/me/mfa', undefined, session)).status).toBe(401);
    // Re-enabling doesn't resurrect it: the refused session was deleted.
    await repo.enableUser(user.id);
    expect(await repo.getSession(session)).toBeUndefined();
    db.close();
  });

  it('an MFA challenge issued before the disable cannot be redeemed', async () => {
    const { db, repo, user, call } = await fixture();
    const mfa_token = await repo.createMfaChallenge(user.id, 'password');
    const revoked = await repo.disableUser(user.id);
    expect(revoked.mfa_challenges).toBe(1);
    const r = await call('POST', '/auth/mfa/verify', { mfa_token });
    expect(r.status).toBe(401);
    expect(r.data).not.toHaveProperty('session');
    db.close();
  });

  it('an MFA challenge that slipped past disableUser is still refused', async () => {
    const { db, repo, user, call, markDisabled } = await fixture();
    const mfa_token = await repo.createMfaChallenge(user.id, 'sso');
    await markDisabled();
    const r = await call('POST', '/auth/mfa/verify', { mfa_token });
    expect(r.status).toBe(401);
    expect(r.data).not.toHaveProperty('session');
    db.close();
  });

  it('password login fails for a disabled account, even with the right password', async () => {
    const { db, repo, user, call } = await fixture();
    expect((await call('POST', '/auth/password/login', { email: 'leaver@school.test', password: PASSWORD })).status).toBe(200);
    await repo.disableUser(user.id);
    const r = await call('POST', '/auth/password/login', { email: 'leaver@school.test', password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.data).not.toHaveProperty('session');
    db.close();
  });

  it('a password-reset link issued before the disable is dropped', async () => {
    const { db, repo, user, call } = await fixture();
    const token = await repo.createPasswordResetToken(user.id);
    const revoked = await repo.disableUser(user.id);
    expect(revoked.password_reset_tokens).toBe(1);
    expect((await call('POST', '/auth/password/reset/check', { token })).data).toEqual({ valid: false });
    expect((await call('POST', '/auth/password/reset', { token, new_password: 'copper meadow lantern 31' })).status).toBe(400);
    db.close();
  });

  it('createSession refuses a disabled account (central guard)', async () => {
    const { db, repo, user } = await fixture();
    await repo.disableUser(user.id);
    await expect(repo.createSession(user.id)).rejects.toBeInstanceOf(AccountDisabledError);
    await repo.enableUser(user.id);
    expect(await repo.createSession(user.id)).toMatch(/^sess_/);
    db.close();
  });

  it('MCP tokens and connector links stop resolving for a disabled account', async () => {
    const { db, repo, ws, user, markDisabled } = await fixture();
    const { token } = await repo.issueMcpToken({ workspace_id: ws.id, user_id: user.id });
    const { secret } = await repo.createConnector({ workspace_id: ws.id, user_id: user.id });
    expect(await repo.resolveMcpTokenWithId(token)).toBeTruthy();
    expect(await repo.resolveConnectorSecret(secret)).toBeTruthy();
    // Even without disableUser's revocation, the disabled flag alone refuses them.
    await markDisabled();
    expect(await repo.resolveMcpTokenWithId(token)).toBeUndefined();
    expect(await repo.resolveConnectorSecret(secret)).toBeUndefined();
    // disableUser itself revokes them too.
    await repo.enableUser(user.id);
    const revoked = await repo.disableUser(user.id);
    expect(revoked.mcp_tokens).toBe(1);
    expect(revoked.connectors).toBe(1);
    await repo.enableUser(user.id);
    expect(await repo.resolveMcpTokenWithId(token)).toBeUndefined();
    db.close();
  });

  it('chat surfaces treat a disabled account as unmapped', async () => {
    const { db, repo, user, markDisabled } = await fixture();
    await repo.sql.exec(
      `INSERT INTO user_identities (id, user_id, kind, external_id, created_at) VALUES ('uid_1', ?, 'whatsapp', '15550001111', ?)`,
      [user.id, new Date().toISOString()],
    );
    expect((await repo.findUserByWhatsappIdentity('+1 555 000 1111', { activeOnly: true }))?.id).toBe(user.id);
    await markDisabled();
    expect(await repo.findUserByWhatsappIdentity('+1 555 000 1111', { activeOnly: true })).toBeUndefined();
    // Non-auth lookups (e.g. naming a person) still see the account.
    expect((await repo.findUserByWhatsappIdentity('+1 555 000 1111'))?.id).toBe(user.id);
    db.close();
  });
});
