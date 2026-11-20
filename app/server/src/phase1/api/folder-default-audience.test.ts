/**
 * Folder-level default privacy for notes added from the app.
 *
 * Precedence for the audience of captured nodes:
 *   explicit `audience` > folder `default_audience` > caller `default_audience`
 *   fallback (the web app sends 'only_me') > column default ('team').
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-folder-aud-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' } });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: j1.dev_code }), headers: { 'content-type': 'application/json' } });
  return (await r2.json()).session as string;
}
async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, { method: opts.method ?? 'POST', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json() };
}

describe('folder default audience', () => {
  it('explicit > folder default > app fallback > team', async () => {
    const { app, repo } = (await import('./server.js?folder-aud=' + Date.now())) as any;
    const sess = await magic(app, 'owner@folder-aud.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'Aud', profile_id: 'notes' }, token: sess })).json;
    await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token: sess, body: { profile: foundingProfile } });

    const topics = ['v1 mobile app', 'offline mode', 'enterprise SSO', 'public API', 'partner channel', 'EU region', 'mobile app'];
    let n = 0;
    const ingest = async (extra: Record<string, unknown>) => {
      const topic = topics[n++];
      const before = new Set(
        (await repo.listNodesWithEmbeddings(ws.id, { activeOnly: true })).map((r: any) => r.node.id),
      );
      const r = await call(app, `/workspaces/${ws.id}/ingest`, {
        token: sess,
        body: {
          source_kind: 'doc',
          source: `Decision: we are killing the ${topic} effective today. Mid-market wedge stays.`,
          source_ref: `aud-${n}`,
          subgraph_id: 'default',
          ...extra,
        },
      });
      expect(r.status).toBe(200);
      const ids = (await repo.listNodesWithEmbeddings(ws.id, { activeOnly: true }))
        .map((x: any) => x.node.id)
        .filter((id: string) => !before.has(id));
      expect(ids.length).toBeGreaterThan(0);
      return new Set(await Promise.all(ids.map(async (id: string) => (await repo.getNodeVisibility(ws.id, id)).visibility)));
    };

    // No folder default, no fallback → team (MCP/Slack behaviour unchanged).
    expect(await ingest({})).toEqual(new Set(['team']));
    // The app's fallback applies when the folder sets nothing.
    expect(await ingest({ default_audience: 'only_me' })).toEqual(new Set(['only_me']));

    // Folder default outranks the app's fallback, and applies to callers with none.
    const patch = await call(app, `/workspaces/${ws.id}/subgraphs/default`, {
      method: 'PATCH',
      token: sess,
      body: { default_audience: 'private' },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.default_audience).toBe('private');
    expect(await ingest({ default_audience: 'only_me' })).toEqual(new Set(['private']));
    expect(await ingest({})).toEqual(new Set(['private']));

    // An explicit choice beats the folder default.
    expect(await ingest({ audience: 'team', default_audience: 'only_me' })).toEqual(new Set(['team']));

    // Clearing the folder default restores the fallback.
    const cleared = await call(app, `/workspaces/${ws.id}/subgraphs/default`, {
      method: 'PATCH',
      token: sess,
      body: { default_audience: null },
    });
    expect(cleared.json.default_audience).toBeNull();
    expect(await ingest({ default_audience: 'only_me' })).toEqual(new Set(['only_me']));

    // The folder list carries the setting for the web dialog.
    await call(app, `/workspaces/${ws.id}/subgraphs/default`, { method: 'PATCH', token: sess, body: { default_audience: 'team' } });
    const list = await call(app, `/workspaces/${ws.id}/subgraphs`, { method: 'GET', token: sess });
    const sg = (list.json.subgraphs ?? list.json).find((s: any) => s.id === 'default');
    expect(sg.default_audience).toBe('team');
  });
});
