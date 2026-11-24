/**
 * Directory (workspace) and folder (subgraph) names reach email subjects, so
 * names with control characters (CR/LF included) are rejected with 400.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-wsname-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function call(app: any, pathname: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

describe('display names reject control characters', () => {
  it('workspace create and folder create/rename refuse a newline (400)', async () => {
    const { app } = await import('./server.js?wsname=' + Date.now());
    const r1 = await call(app, '/auth/magic-link', { method: 'POST', body: { email: 'wsname@pome.test' } });
    const token = (await call(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } })).json
      .session as string;

    for (const name of ['Acme\r\nBcc: v@evil.test', 'Acme\nX', 'Acme\x00', 'Acme\x7f']) {
      const bad = await call(app, '/workspaces', { method: 'POST', token, body: { name, profile_id: 'notes' } });
      expect(bad.status, JSON.stringify(name)).toBe(400);
    }
    const ok = await call(app, '/workspaces', { method: 'POST', token, body: { name: 'Acme Équipe', profile_id: 'notes' } });
    expect(ok.status).toBe(200);
    const ws = ok.json.id as string;

    const badFolder = await call(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      body: { profile_id: 'notes', name: 'People\r\nX' },
    });
    expect(badFolder.status).toBe(400);
    const folder = await call(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    expect(folder.status).toBe(200);
    const id = folder.json.subgraph_id as string;
    const badRename = await call(app, `/workspaces/${ws}/subgraphs/${id}`, {
      method: 'PATCH',
      token,
      body: { name: 'People\nBcc: v@evil.test' },
    });
    expect(badRename.status).toBe(400);
    const rename = await call(app, `/workspaces/${ws}/subgraphs/${id}`, { method: 'PATCH', token, body: { name: 'Team' } });
    expect(rename.status).toBe(200);
  });
});
