import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Deterministic synth stub — this suite only exercises connector CRUD, never
// the LLM, but server.js pulls the provider in transitively.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-con-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?con=' + Date.now());
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const { dev_code } = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  const { session } = await r2.json();
  return session as string;
}

async function call(
  app: any,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

describe('claude.ai connector CRUD', () => {
  it('admin creates, lists, and revokes a connector; secret shown once as a URL path', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'admin@con.example');
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: session, body: { name: 'ConTest' } })
    ).json.id;

    // Create — returns the one-time secret and an app-relative path.
    const created = await call(app, 'POST', `/workspaces/${wsId}/connectors`, {
      token: session,
      body: { label: 'Marketing team' },
    });
    expect(created.status).toBe(200);
    expect(created.json.id).toMatch(/^con_/);
    expect(created.json.secret).toBeTruthy();
    expect(created.json.path).toBe(`/mcp/connector/${created.json.secret}`);

    // List — shows the connector without leaking the secret.
    const listed = await call(app, 'GET', `/workspaces/${wsId}/connectors`, { token: session });
    expect(listed.status).toBe(200);
    expect(listed.json.connectors.map((c: any) => c.id)).toEqual([created.json.id]);
    expect(JSON.stringify(listed.json)).not.toContain(created.json.secret);

    // Revoke — connector drops out of the live list.
    const revoked = await call(
      app,
      'DELETE',
      `/workspaces/${wsId}/connectors/${created.json.id}`,
      { token: session },
    );
    expect(revoked.status).toBe(200);
    const after = await call(app, 'GET', `/workspaces/${wsId}/connectors`, { token: session });
    expect(after.json.connectors).toEqual([]);
  });

  it('non-admin members cannot create or list connectors', async () => {
    const { app, repo } = await loadApp();
    const adminSession = await magic(app, 'boss@con2.example');
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: adminSession, body: { name: 'Gated' } })
    ).json.id;

    // Second user joins as a plain member.
    const memberSession = await magic(app, 'ic@con2.example');
    const member = await repo.findOrCreateUser('ic@con2.example');
    await repo.addMember({ workspace_id: wsId, user_id: member.id, role: 'member' });

    const createRes = await call(app, 'POST', `/workspaces/${wsId}/connectors`, {
      token: memberSession,
      body: {},
    });
    expect(createRes.status).toBe(403);
    const listRes = await call(app, 'GET', `/workspaces/${wsId}/connectors`, {
      token: memberSession,
    });
    expect(listRes.status).toBe(403);
  });
});
