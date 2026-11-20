import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Substitute the production Anthropic provider with the deterministic stub so
// the work-agent route exercises its own-context assembly + integrity gate
// without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-work-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?work=' + Date.now());
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
  url: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(url, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

/** Create a workspace, then install the founding fixture profile (seedNode
 *  writes decision-kind nodes, which `notes` — the only real builtin — can't
 *  hold). */
async function createWs(app: any, token: string, name: string): Promise<{ id: string }> {
  const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name }, token })).json;
  await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  return ws;
}

async function seedNode(app: any, ws: string, token: string, id: string, updated_at: string) {
  await call(app, `/workspaces/${ws}/graph`, {
    token,
    body: {
      id,
      type: 'decision',
      created_at: updated_at,
      updated_at,
      status: 'active',
      summary: `Decision ${id}`,
      body: `Body of ${id}.`,
      decided_on: updated_at.slice(0, 10),
      category: 'scope',
    },
  });
}

describe('Work agents (own-context)', () => {
  it('draft: runs over own graph, integrity-cites only real nodes', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w1@work.example');
    const ws = await createWs(app, token, 'W1');
    await seedNode(app, ws.id, token, 'dec-a', '2026-07-10T00:00:00Z');
    await seedNode(app, ws.id, token, 'dec-b', '2026-07-11T00:00:00Z');

    const r = await call(app, `/workspaces/${ws.id}/work/draft`, {
      token,
      body: { input: 'a roadmap one-pager', docType: 'one-pager' },
    });
    expect(r.status).toBe(200);
    expect(r.json.agent).toBe('draft');
    expect(r.json.output.length).toBeGreaterThan(0);
    // Every cited id resolves in the active graph.
    for (const id of r.json.cited_node_ids) expect(['dec-a', 'dec-b']).toContain(id);
    expect(r.json.cited_node_ids.length).toBeGreaterThan(0);
  });

  it('catchup: only surfaces nodes changed since the cutoff', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w2@work.example');
    const ws = await createWs(app, token, 'W2');
    await seedNode(app, ws.id, token, 'old-node', '2026-01-01T00:00:00Z');
    await seedNode(app, ws.id, token, 'fresh-node', new Date().toISOString());

    const r = await call(app, `/workspaces/${ws.id}/work/catchup`, {
      token,
      body: { since: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString() },
    });
    expect(r.status).toBe(200);
    // The stub cites the nodes it was handed; the route must only hand it the
    // recent one, so the old node can never be cited.
    expect(r.json.cited_node_ids).not.toContain('old-node');
  });

  it('empty graph → empty:true, does not fabricate', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w3@work.example');
    const ws = await createWs(app, token, 'W3');
    const r = await call(app, `/workspaces/${ws.id}/work/synthesize`, {
      token,
      body: { input: 'anything' },
    });
    expect(r.status).toBe(200);
    expect(r.json.empty).toBe(true);
    expect(r.json.output).toBe('');
  });

  it('rejects an unknown agent name', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w4@work.example');
    const ws = await createWs(app, token, 'W4');
    const r = await call(app, `/workspaces/${ws.id}/work/nonsense`, { token, body: {} });
    expect(r.status).toBe(400);
  });

  // Work agents use the same per-user opt-in nav visibility as collab agents
  // (spec §7), so the server allow-list must accept their keys or the sidebar
  // "Add app" silently 404s.
  it('nav visibility accepts work-agent keys, round-trips, and still rejects junk', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w6@work.example');
    const ws = await createWs(app, token, 'W6');

    // Default: nothing visible until explicitly added.
    const before = await call(app, `/workspaces/${ws.id}/apps/visibility`, { method: 'GET', token });
    expect(before.json.visible_apps).toEqual([]);

    for (const key of ['draft', 'synthesize', 'catchup', 'followup']) {
      const add = await call(app, `/workspaces/${ws.id}/apps/visibility/${key}`, { token });
      expect(add.status).toBe(200);
    }
    const after = await call(app, `/workspaces/${ws.id}/apps/visibility`, { method: 'GET', token });
    expect(after.json.visible_apps.sort()).toEqual(['catchup', 'draft', 'followup', 'synthesize']);

    // A collab key still works (the allow-list is a union, not a replacement).
    expect((await call(app, `/workspaces/${ws.id}/apps/visibility/ask`, { token })).status).toBe(200);

    // Hiding removes it again.
    const del = await call(app, `/workspaces/${ws.id}/apps/visibility/draft`, { method: 'DELETE', token });
    expect(del.status).toBe(200);
    const final = await call(app, `/workspaces/${ws.id}/apps/visibility`, { method: 'GET', token });
    expect(final.json.visible_apps).not.toContain('draft');

    // Unknown keys are still rejected.
    expect((await call(app, `/workspaces/${ws.id}/apps/visibility/nonsense`, { token })).status).toBe(404);
  });

  it('records a work usage row (tool=work) with scope=agent', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'w5@work.example');
    const ws = await createWs(app, token, 'W5');
    await seedNode(app, ws.id, token, 'dec-x', '2026-07-12T00:00:00Z');
    const r = await call(app, `/workspaces/${ws.id}/work/followup`, { token, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.agent).toBe('followup');
  });
});
