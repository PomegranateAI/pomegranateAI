/**
 * get_context's new retrieval controls (index mode, id/date-based direct
 * retrieval, sort, limit, include_superseded) and the new `search_context`
 * tool (registry.ts). Nodes are seeded directly via POST /workspaces/:ws/graph
 * (no LLM); embeddings are set directly via `repo.setNodeEmbedding` rather
 * than relying on the write route's fire-and-forget embed-on-write, so
 * search_context's ranking is deterministic and race-free.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StubEmbedder, embeddingToBlob } from '../../lib/embeddings.js';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-context-retrieval-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  process.env.POMEGRANATE_EMBEDDER = 'stub';
});

async function loadApp() {
  return import('../api/server.js?mcp-context-retrieval=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await jsonCall(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await jsonCall(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

async function setupWorkspaceAndToken(app: any, email: string, body: Record<string, unknown>) {
  const session = await magic(app, email);
  const created = await jsonCall(app, '/workspaces', { method: 'POST', token: session, body });
  const ws = created.json.id as string;
  const tokenRes = await jsonCall(app, `/workspaces/${ws}/mcp-tokens`, { method: 'POST', token: session, body: {} });
  return { ws, mcpToken: tokenRes.json.token as string, session };
}

/** Seed a 'note'-kind node directly (POST /workspaces/:ws/graph), no LLM involved. */
async function seedNote(
  app: any,
  ws: string,
  session: string,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  const node = {
    id,
    type: 'note',
    title: id,
    body: `Body of ${id}.`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    ...overrides,
  };
  const r = await jsonCall(app, `/workspaces/${ws}/graph`, { method: 'POST', token: session, body: node });
  expect(r.status).toBe(200);
  return node;
}

describe('get_context retrieval controls', () => {
  it('mode: index returns one compact entry per node, no body', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'ctx-index@pome.test', {
      name: 'CtxIndex',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'note-a', { created_at: '2026-01-01T00:00:00Z' });
    await seedNote(app, ws, session, 'note-b', { created_at: '2026-01-02T00:00:00Z' });

    const res = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', mode: 'index' },
    });
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('index');
    expect(res.json.node_count).toBe(2);
    const ids = res.json.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(['note-a', 'note-b']);
    for (const n of res.json.nodes) {
      expect(n.body).toBeUndefined();
      expect(typeof n.summary).toBe('string');
    }
    expect(res.json.markdown).toContain('note-a');
    expect(res.json.markdown).toContain('note-b');
  });

  it('include_superseded: false (default) hides an archived node; true surfaces it with its lineage', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'ctx-superseded@pome.test', {
      name: 'CtxSuperseded',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'old-note', { status: 'archived', superseded: 'new-note' });
    await seedNote(app, ws, session, 'new-note');

    const defaultRes = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all' },
    });
    expect(defaultRes.json.include_superseded).toBe(false);
    expect(defaultRes.json.nodes.map((n: any) => n.id)).toEqual(['new-note']);

    const withHistory = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', include_superseded: true, mode: 'index' },
    });
    const ids = withHistory.json.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(['new-note', 'old-note']);
    const old = withHistory.json.nodes.find((n: any) => n.id === 'old-note');
    expect(old.status).toBe('archived');
    expect(old.superseded).toBe('new-note');
    expect(withHistory.json.markdown).toContain('SUPERSEDED');
  });

  it('ids retrieves specific nodes in full, regardless of relevance ranking', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'ctx-ids@pome.test', {
      name: 'CtxIds',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'pick-me');
    await seedNote(app, ws, session, 'skip-me');

    const res = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', ids: ['pick-me'] },
    });
    expect(res.json.node_count).toBe(1);
    expect(res.json.nodes[0].id).toBe('pick-me');
    expect(res.json.nodes[0].body).toBe('Body of pick-me.');
  });

  it('since/until/sort filter and order by creation date; limit caps and reports total_matched', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'ctx-dates@pome.test', {
      name: 'CtxDates',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'jan', { created_at: '2026-01-01T00:00:00Z' });
    await seedNote(app, ws, session, 'feb', { created_at: '2026-02-01T00:00:00Z' });
    await seedNote(app, ws, session, 'mar', { created_at: '2026-03-01T00:00:00Z' });

    const ranged = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', since: '2026-02-01T00:00:00Z', mode: 'index' },
    });
    expect(ranged.json.nodes.map((n: any) => n.id)).toEqual(['mar', 'feb']); // newest first (default)

    const oldest = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', mode: 'index', sort: 'oldest' },
    });
    expect(oldest.json.nodes.map((n: any) => n.id)).toEqual(['jan', 'feb', 'mar']);

    const capped = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all', mode: 'index', limit: 1 },
    });
    expect(capped.json.node_count).toBe(1);
    expect(capped.json.total_matched).toBe(3);
    expect(capped.json.truncated).toBe(true);
    expect(capped.json.nodes[0].id).toBe('mar'); // newest first
  });

  it('a plain call (no new args) is unaffected: mode defaults to full, include_superseded to false', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'ctx-plain@pome.test', {
      name: 'CtxPlain',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'plain-note');

    const res = await jsonCall(app, '/mcp/tools/get_context', {
      method: 'POST',
      token: mcpToken,
      body: { scope: 'all' },
    });
    expect(res.json.mode).toBe('full');
    expect(res.json.include_superseded).toBe(false);
    expect(res.json.nodes[0].body).toBe('Body of plain-note.');
  });
});

describe('search_context', () => {
  it('ranks the node whose stored embedding exactly matches the query text first', async () => {
    const { app, repo } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'search-basic@pome.test', {
      name: 'SearchBasic',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'about-roadmap', { body: 'Roadmap decision content.' });
    await seedNote(app, ws, session, 'about-hiring', { body: 'Hiring plan content.' });
    const embedder = new StubEmbedder();
    const [roadmapVec] = await embedder.embed(['ROADMAP_MARKER']);
    const [hiringVec] = await embedder.embed(['unrelated text about something else entirely']);
    await repo.setNodeEmbedding(ws, 'about-roadmap', embeddingToBlob(roadmapVec!));
    await repo.setNodeEmbedding(ws, 'about-hiring', embeddingToBlob(hiringVec!));

    const res = await jsonCall(app, '/mcp/tools/search_context', {
      method: 'POST',
      token: mcpToken,
      body: { query: 'ROADMAP_MARKER' },
    });
    expect(res.status).toBe(200);
    expect(res.json.hits[0].id).toBe('about-roadmap');
    expect(res.json.hits[0].score).toBeCloseTo(1, 5);
    expect(res.json.markdown).toContain('about-roadmap');
  });

  it('include_superseded: false excludes an archived node from search by default', async () => {
    const { app, repo } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'search-superseded@pome.test', {
      name: 'SearchSuperseded',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, 'archived-note', { status: 'archived', superseded: 'live-note' });
    await seedNote(app, ws, session, 'live-note');
    const embedder = new StubEmbedder();
    const [vec] = await embedder.embed(['SHARED_MARKER']);
    await repo.setNodeEmbedding(ws, 'archived-note', embeddingToBlob(vec!));
    await repo.setNodeEmbedding(ws, 'live-note', embeddingToBlob(vec!));

    const defaultRes = await jsonCall(app, '/mcp/tools/search_context', {
      method: 'POST',
      token: mcpToken,
      body: { query: 'SHARED_MARKER' },
    });
    expect(defaultRes.json.hits.map((h: any) => h.id)).toEqual(['live-note']);

    const withHistory = await jsonCall(app, '/mcp/tools/search_context', {
      method: 'POST',
      token: mcpToken,
      body: { query: 'SHARED_MARKER', include_superseded: true },
    });
    const ids = withHistory.json.hits.map((h: any) => h.id).sort();
    expect(ids).toEqual(['archived-note', 'live-note']);
    const archived = withHistory.json.hits.find((h: any) => h.id === 'archived-note');
    expect(archived.status).toBe('archived');
    expect(archived.superseded).toBe('live-note');
  });

  it('rejects an unknown subgraph', async () => {
    const { app } = await loadApp();
    const { mcpToken } = await setupWorkspaceAndToken(app, 'search-badsub@pome.test', {
      name: 'SearchBadSub',
      profile_id: 'notes',
    });
    const res = await jsonCall(app, '/mcp/tools/search_context', {
      method: 'POST',
      token: mcpToken,
      body: { query: 'anything', subgraph: 'does-not-exist' },
    });
    expect(res.status).toBe(404);
  });
});
