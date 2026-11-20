import { beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-system-admin-'));
  process.env.POMEGRANATE_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.POMEGRANATE_FILES_DIR = path.join(dir, 'files');
});

async function request(app: any, method: string, url: string, token: string, body?: unknown) {
  const r = await app.request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

describe('system user administration', () => {
  it('requires an explicit system admin, creates and resets passwords, and deletes owned data', async () => {
    const { app, repo } = await import('./server.js?system-admin=' + Date.now());
    const admin = await repo.findOrCreateUser('root@example.com');
    const normal = await repo.findOrCreateUser('normal@example.com');
    await repo.sql.exec('UPDATE users SET is_admin = 1 WHERE id = ?', [admin.id]);
    const adminToken = await repo.createSession(admin.id);
    const normalToken = await repo.createSession(normal.id);

    expect((await request(app, 'GET', '/admin/users', normalToken)).status).toBe(403);
    expect((await request(app, 'POST', '/admin/users', normalToken, { email: 'x@example.com', password: 'A long good password 42' })).status).toBe(403);
    const created = await request(app, 'POST', '/admin/users', adminToken, { email: 'target@example.com', password: 'river cedar lantern 42' });
    expect(created.status).toBe(201);
    const targetId = created.data.user.id;
    expect((await repo.getUserById(targetId))?.is_admin).toBe(0);
    expect(await repo.passwordMustChange(targetId)).toBe(true);
    expect((await request(app, 'POST', '/admin/users', adminToken, { email: 'TARGET@example.com', password: 'another long password 42' })).status).toBe(409);

    const targetToken = await repo.createSession(targetId);
    const reset = await request(app, 'PUT', `/admin/users/${targetId}/password`, adminToken, { password: 'ocean moss canyon 78' });
    expect(reset.status).toBe(200);
    expect(await repo.passwordMustChange(targetId)).toBe(true);
    expect((await request(app, 'GET', '/me', targetToken)).status).toBe(401);

    const owned = await repo.createWorkspace({ name: 'Target data', owner_email: 'target@example.com' });
    const shared = await repo.createWorkspace({ name: 'Shared data', owner_email: 'normal@example.com' });
    await repo.addMember({ workspace_id: shared.id, user_id: targetId, role: 'member' });
    const preview = await request(app, 'GET', `/admin/users/${targetId}/deletion`, adminToken);
    expect(preview.data.owned_workspaces.map((w: { id: string }) => w.id)).toEqual([owned.id]);
    expect((await request(app, 'DELETE', `/admin/users/${targetId}`, adminToken, { confirm_email: 'wrong@example.com' })).status).toBe(400);
    expect((await request(app, 'DELETE', `/admin/users/${admin.id}`, adminToken, { confirm_email: admin.email })).status).toBe(400);
    expect((await request(app, 'DELETE', `/admin/users/${targetId}`, adminToken, { confirm_email: 'target@example.com' })).status).toBe(200);
    expect(await repo.getUserById(targetId)).toBeUndefined();
    expect(await repo.getWorkspace(owned.id)).toBeUndefined();
    expect(await repo.getWorkspace(shared.id)).toBeDefined();
  });
});
