import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Deterministic synth stub (no paid API) — same pattern as the MCP test.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-retrieval-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  // Force the deterministic stub embedder so packing never touches OpenAI.
  process.env.POMEGRANATE_EMBEDDER = 'stub';
});

async function loadApp() {
  return import('./server.js?retrieval-test=' + Date.now());
}

async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: j1.dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  return (await r2.json()).session as string;
}

async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

const SEED = [
  {
    id: 'goal-ns',
    type: 'goal',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    title: 'Become the canon layer for AI teams',
    body: 'North star for the year.',
    priority: 'north_star',
  },
  {
    id: 'dec-mobile',
    type: 'decision',
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
    status: 'active',
    summary: 'Kill the v1 mobile app',
    body: 'Dropping the v1 mobile app effective 2026-04-15.',
    decided_on: '2026-04-15',
    category: 'scope',
  },
  {
    id: 'pos-banned',
    type: 'positioning',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    body: 'synergy',
    kind: 'banned_phrase',
  },
];

async function seedWorkspace(app: any, session: string, name: string) {
  const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name }, token: session })).json;
  await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', body: { profile: foundingProfile }, token: session });
  for (const n of SEED) {
    await call(app, `/workspaces/${ws.id}/graph`, { body: n, token: session });
  }
  return ws;
}

describe('GET /graph filters (spec B6.4)', () => {
  it('filters by kind, subkind, and category', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'graphfilter@x.com');
    const ws = await seedWorkspace(app, s, 'GF');

    const all = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: s });
    expect(all.json.nodes).toHaveLength(3);

    const byKind = await call(app, `/workspaces/${ws.id}/graph?kind=decision`, { method: 'GET', token: s });
    expect(byKind.json.nodes.map((n: any) => n.id)).toEqual(['dec-mobile']);

    const bySub = await call(app, `/workspaces/${ws.id}/graph?subkind=banned_phrase`, { method: 'GET', token: s });
    expect(bySub.json.nodes.map((n: any) => n.id)).toEqual(['pos-banned']);

    const byCat = await call(app, `/workspaces/${ws.id}/graph?category=scope`, { method: 'GET', token: s });
    expect(byCat.json.nodes.map((n: any) => n.id)).toEqual(['dec-mobile']);

    const none = await call(app, `/workspaces/${ws.id}/graph?category=hiring`, { method: 'GET', token: s });
    expect(none.json.nodes).toHaveLength(0);
  });
});

describe('scoped /query (spec B6.1)', () => {
  it('answers within the decisions scope', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'scopedq@x.com');
    const ws = await seedWorkspace(app, s, 'SQ');
    const r = await call(app, `/workspaces/${ws.id}/query`, {
      body: { question: 'What did we decide about the v1 mobile app?', scope: 'decisions' },
      token: s,
    });
    expect(r.status).toBe(200);
    expect(r.json.cited_node_ids).toContain('dec-mobile');
  });

  it('rejects an out-of-profile scope with 422', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'badscope@x.com');
    const ws = await seedWorkspace(app, s, 'BS');
    const r = await call(app, `/workspaces/${ws.id}/query`, {
      body: { question: 'anything', scope: 'not_a_scope' },
      token: s,
    });
    expect(r.status).toBe(422);
  });
});

describe('GET /context-pack (spec B6.3)', () => {
  it('returns a scoped, citation-ready pack with markdown', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'pack@x.com');
    const ws = await seedWorkspace(app, s, 'PK');

    const r = await call(app, `/workspaces/${ws.id}/context-pack?scope=decisions`, {
      method: 'GET',
      token: s,
    });
    expect(r.status).toBe(200);
    expect(r.json.scope).toBe('decisions');
    expect(r.json.nodes.map((n: any) => n.id)).toEqual(['dec-mobile']);
    expect(r.json.markdown).toContain('`dec-mobile`');
    expect(r.json.markdown).not.toContain('pos-banned');
  });

  it('honors a token budget (truncates)', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'packbudget@x.com');
    const ws = await seedWorkspace(app, s, 'PB');
    const r = await call(app, `/workspaces/${ws.id}/context-pack?scope=all&budget_tokens=20`, {
      method: 'GET',
      token: s,
    });
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.node_count).toBeLessThan(3);
  });

  it('422 on an unknown scope', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'packbadscope@x.com');
    const ws = await seedWorkspace(app, s, 'PBS');
    const r = await call(app, `/workspaces/${ws.id}/context-pack?scope=zzz`, {
      method: 'GET',
      token: s,
    });
    expect(r.status).toBe(422);
  });
});

describe('embedding-ranked packing over the threshold (spec B6.2)', () => {
  it('a >120-node graph packs but always keeps the north-star node', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'bigpack@x.com');
    const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'BIG' }, token: s })).json;
    await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', body: { profile: foundingProfile }, token: s });
    // North star goal — must survive packing regardless of cosine rank.
    await call(app, `/workspaces/${ws.id}/graph`, {
      body: {
        id: 'ns-goal',
        type: 'goal',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        title: 'The singular north star',
        body: 'totally unrelated text zzz',
        priority: 'north_star',
      },
      token: s,
    });
    // 130 unrelated goals to push past the 120 threshold.
    for (let i = 0; i < 130; i++) {
      await call(app, `/workspaces/${ws.id}/graph`, {
        body: {
          id: `g${i}`,
          type: 'goal',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          status: 'active',
          title: `filler goal ${i}`,
          body: `filler goal body ${i}`,
          priority: 'supporting',
        },
        token: s,
      });
    }
    const r = await call(app, `/workspaces/${ws.id}/context-pack?scope=goals`, {
      method: 'GET',
      token: s,
    });
    expect(r.status).toBe(200);
    expect(r.json.packed).toBe(true);
    // Packed to << full graph, but the north-star node is always present.
    expect(r.json.node_count).toBeLessThan(131);
    expect(r.json.nodes.map((n: any) => n.id)).toContain('ns-goal');
  });
});

describe('MCP get_context tool (spec B6.3)', () => {
  it('returns the scoped pack via an MCP token', async () => {
    const { app } = await loadApp();
    const s = await magic(app, 'mcpctx@x.com');
    const ws = await seedWorkspace(app, s, 'MCPCTX');
    const mcpToken = (await call(app, `/workspaces/${ws.id}/mcp-tokens`, { body: {}, token: s })).json.token;

    const r = await call(app, '/mcp/tools/get_context', {
      body: { scope: 'positioning' },
      token: mcpToken,
    });
    expect(r.status).toBe(200);
    expect(r.json.nodes.map((n: any) => n.id)).toEqual(['pos-banned']);
    expect(r.json.markdown).toContain('`pos-banned`');

    // Per-call audit row recorded.
    const audit = await call(app, `/workspaces/${ws.id}/audit`, { method: 'GET', token: s });
    expect(audit.json.entries.map((e: any) => e.event)).toContain('mcp.get_context');
  });

  it('requires a token', async () => {
    const { app } = await loadApp();
    const r = await call(app, '/mcp/tools/get_context', { body: { scope: 'all' } });
    expect(r.status).toBe(401);
  });

  it('ADVERSARIAL: workspace-A MCP token cannot pull workspace-B canon', async () => {
    const { app } = await loadApp();
    const sA = await magic(app, 'ctx-tenant-a@x.com');
    const sB = await magic(app, 'ctx-tenant-b@x.com');
    const wsA = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'A' }, token: sA })).json;
    const wsB = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'B' }, token: sB })).json;
    await call(app, `/workspaces/${wsB.id}/profile`, { method: 'PUT', body: { profile: foundingProfile }, token: sB });
    // Seed a secret only in B.
    await call(app, `/workspaces/${wsB.id}/graph`, {
      body: {
        id: 'secret-of-b',
        type: 'decision',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        summary: 'Tenant B confidential decision',
        body: 'Only B should ever see this.',
        decided_on: '2026-01-01',
        category: 'strategy',
      },
      token: sB,
    });
    // A's MCP token tries to pull a context pack — it resolves to A's workspace,
    // never B's, so B's secret can never appear.
    const aTok = (await call(app, `/workspaces/${wsA.id}/mcp-tokens`, { body: {}, token: sA })).json.token;
    const r = await call(app, '/mcp/tools/get_context', { body: { scope: 'all' }, token: aTok });
    expect(r.status).toBe(200);
    expect(r.json.nodes.map((n: any) => n.id)).not.toContain('secret-of-b');
    expect(r.json.markdown).not.toContain('Only B should ever see this');
    expect(JSON.stringify(r.json)).not.toContain('secret-of-b');
  });
});
