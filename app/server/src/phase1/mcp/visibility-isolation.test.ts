/**
 * Context-isolation tests for the sharing/visibility controls, exercised through
 * the REAL access path: a per-user MCP token (pmg_) → tokenGate resolves it to a
 * user_id → the read tools filter by that viewer. This is how a teammate's AI
 * agent actually reaches someone else's context, so it's the path that matters.
 *
 * Matrix: one workspace, three identities (owner / alice / bob) and three nodes
 * (team / private / shared-with-alice). Every MCP read tool is asserted to
 * surface exactly the caller's visible set — no more.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Capturing synthesis provider: records the node ids it is handed on every
// query/feedback call, so we can assert exactly which nodes reached synthesis
// AFTER viewer-filtering. Spreads the deterministic stub for the other methods.
const rec = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = (await import('../../__test_utils__/synth-stub.js')).TestSynthStub as any;
  const capturing = {
    ...stub,
    name: 'capturing',
    async query(o: any) {
      rec.ids = (o.graph ?? []).map((n: any) => n.id);
      return { answer: 'x', cited_node_ids: rec.ids, has_answer: true };
    },
    async feedback(o: any) {
      rec.ids = (o.graph ?? []).map((n: any) => n.id);
      return [];
    },
  };
  return { ...real, getProvider: () => capturing };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-iso-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?iso-test=' + Date.now());
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
  const r = await app.request(p, { method: opts.method ?? 'POST', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json() };
}

const N = { team: 'iso-team', priv: 'iso-priv', onlyMe: 'iso-onlyme' };
let ctr = 0;

describe('MCP context isolation (visibility via per-user token)', () => {
  let app: any;
  let repo: any;
  let ws: any;
  let owner: string;
  let alice: string;
  let bob: string;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, repo } = await loadApp());
    const ownerSess = await magic(app, 'owner@iso.test');
    ws = (await call(app, '/workspaces', { body: { name: 'Iso', profile_id: 'notes' }, token: ownerSess })).json;
    owner = (await repo.findOrCreateUser('owner@iso.test')).id;
    alice = (await repo.findOrCreateUser('alice@iso.test')).id;
    bob = (await repo.findOrCreateUser('bob@iso.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: alice, role: 'member' });
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });

    for (const [id, summary] of [
      [N.team, 'team-visible decision'],
      [N.priv, 'private decision'],
      [N.onlyMe, 'only-me decision'],
    ] as const) {
      await call(app, `/workspaces/${ws.id}/graph`, {
        body: {
          id,
          type: 'note',
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
          status: 'active',
          summary,
          body: summary,
        },
        token: ownerSess,
      });
    }
    // Seeded nodes default to 'team'; set the two restricted ones.
    await repo.setNodeVisibility(ws.id, N.priv, 'private', owner);
    await repo.setNodeVisibility(ws.id, N.onlyMe, 'only_me', owner);

    tok.owner = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: owner })).token;
    tok.alice = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: alice })).token;
    tok.bob = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: bob })).token;
  });

  // ---- per-tool readers, returning the set of node ids the caller can see ----
  const recentSet = async (token: string) => {
    const r = await call(app, '/mcp/tools/list_recent_changes', { body: { since: '2020-01-01T00:00:00Z' }, token });
    return new Set<string>((r.json.nodes ?? []).map((n: any) => n.id));
  };
  const reviewSet = async (token: string) => {
    rec.ids = [];
    await call(app, '/mcp/tools/review_deliverable', { body: { content: `iso review ${++ctr}`, kind: 'other' }, token });
    return new Set<string>(rec.ids);
  };
  const querySet = async (token: string) => {
    rec.ids = [];
    await call(app, '/mcp/tools/query_context', { body: { question: `iso q ${++ctr}`, scope: 'all' }, token });
    return new Set<string>(rec.ids);
  };
  const ctxCount = async (token: string) => {
    const r = await call(app, '/mcp/tools/get_context', { body: { scope: 'all' }, token });
    return r.json.node_count as number;
  };

  // MCP reads are AI reads: a caller's agent sees team nodes + the caller's own
  // 'private' ("AI agents") nodes. 'only_me' is human-eyes-only and never appears
  // in any MCP read — not even for its own owner's agents.
  it('list_recent_changes surfaces team + the caller\'s own private, never only_me', async () => {
    expect(await recentSet(tok.owner)).toEqual(new Set([N.team, N.priv]));
    expect(await recentSet(tok.alice)).toEqual(new Set([N.team]));
    expect(await recentSet(tok.bob)).toEqual(new Set([N.team]));
  });

  it('review_deliverable synthesizes over team + the caller\'s own private only', async () => {
    expect(await reviewSet(tok.owner)).toEqual(new Set([N.team, N.priv]));
    expect(await reviewSet(tok.alice)).toEqual(new Set([N.team]));
    expect(await reviewSet(tok.bob)).toEqual(new Set([N.team]));
  });

  it('query_context retrieves team + the caller\'s own private only', async () => {
    expect(await querySet(tok.owner)).toEqual(new Set([N.team, N.priv]));
    expect(await querySet(tok.alice)).toEqual(new Set([N.team]));
    expect(await querySet(tok.bob)).toEqual(new Set([N.team]));
  });

  it('get_context packs team + the caller\'s own private only', async () => {
    expect(await ctxCount(tok.owner)).toBe(2);
    expect(await ctxCount(tok.alice)).toBe(1);
    expect(await ctxCount(tok.bob)).toBe(1);
  });

  it('only_me is hidden from the owner\'s OWN agents across every MCP read', async () => {
    expect((await recentSet(tok.owner)).has(N.onlyMe)).toBe(false);
    expect((await querySet(tok.owner)).has(N.onlyMe)).toBe(false);
    expect((await reviewSet(tok.owner)).has(N.onlyMe)).toBe(false);
    expect(await ctxCount(tok.owner)).toBe(2); // team + private, only_me excluded
  });

  it('promoting a private node to team grants access to everyone\'s agents', async () => {
    await repo.setNodeVisibility(ws.id, N.priv, 'team', owner);
    expect(await recentSet(tok.bob)).toEqual(new Set([N.team, N.priv]));
    expect(await recentSet(tok.alice)).toEqual(new Set([N.team, N.priv]));
    // restore for the next test
    await repo.setNodeVisibility(ws.id, N.priv, 'private', owner);
  });

  it('deleteSharedNode removes a node for everyone', async () => {
    expect((await recentSet(tok.owner)).has(N.priv)).toBe(true);
    await repo.deleteSharedNode(ws.id, N.priv);
    expect(await recentSet(tok.owner)).toEqual(new Set([N.team]));
  });

  it("a token never leaks another workspace's nodes", async () => {
    const otherSess = await magic(app, 'other@iso.test');
    const wsOther = (await call(app, '/workspaces', { body: { name: 'Other', profile_id: 'notes' }, token: otherSess })).json;
    await call(app, `/workspaces/${wsOther.id}/graph`, {
      body: {
        id: 'other-secret',
        type: 'note',
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
        status: 'active',
        summary: 'secret in another workspace',
        body: 'secret',
      },
      token: otherSess,
    });
    // Every Iso-workspace token only ever sees Iso nodes.
    for (const t of [tok.owner, tok.alice, tok.bob]) {
      const ids = await recentSet(t);
      expect(ids.has('other-secret')).toBe(false);
    }
  });
});
