/**
 * Audience enforcement regression suite (security audit, 2026-11-20).
 *
 * One directory, an owner and a plain member (alice). The owner holds a team
 * note, a private note and an only_me note, plus documents behind them. Every
 * read and write path the audit named is asserted to give alice the team
 * material only, and to give the owner their own.
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-audience-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' } });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: j1.dev_code }), headers: { 'content-type': 'application/json' } });
  return (await r2.json()).session as string;
}
async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: r.status, json };
}

const N = { team: 'aud-team', priv: 'aud-priv', onlyMe: 'aud-onlyme' };
const note = (id: string, body: string) => ({
  id,
  type: 'note',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  status: 'active',
  summary: body,
  body,
});

describe('audience enforcement', () => {
  let app: any;
  let repo: any;
  let ws: any;
  let owner: string;
  let ownerSess: string;
  let aliceSess: string;
  const doc: Record<string, string> = {};
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    ({ app, repo } = (await import('./server.js?audience=' + Date.now())) as any);
    ownerSess = await magic(app, 'owner@audience.test');
    ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'Aud', profile_id: 'notes' }, token: ownerSess })).json;
    owner = (await repo.findOrCreateUser('owner@audience.test')).id;
    const alice = (await repo.findOrCreateUser('alice@audience.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: alice, role: 'member' });
    aliceSess = await magic(app, 'alice@audience.test');

    for (const [id, body] of [[N.team, 'team plan'], [N.priv, 'private salary note'], [N.onlyMe, 'only-me diary']] as const) {
      const r = await call(app, `/workspaces/${ws.id}/graph`, { method: 'POST', body: note(id, body), token: ownerSess });
      expect(r.status).toBe(200);
    }
    await repo.setNodeVisibility(ws.id, N.team, 'team', owner);
    await repo.setNodeVisibility(ws.id, N.priv, 'private', owner);
    await repo.setNodeVisibility(ws.id, N.onlyMe, 'only_me', owner);

    // Documents: one behind each note, one zero-note upload by the owner, one legacy row.
    for (const k of ['team', 'priv', 'onlyMe', 'orphan', 'legacy'] as const) {
      doc[k] = (await repo.registerDocument(ws.id, { source_ref: `aud-${k}.md`, source_kind: 'doc', sha256: `sha-${k}` })).id;
    }
    await repo.setNodeDocumentId(ws.id, N.team, doc.team);
    await repo.setNodeDocumentId(ws.id, N.priv, doc.priv);
    await repo.setNodeDocumentId(ws.id, N.onlyMe, doc.onlyMe);
    await repo.stampDocumentIngest(ws.id, doc.orphan, owner, null);

    // A pending candidate behind the private note.
    await repo.insertCandidate(ws.id, {
      id: 'cand-priv',
      proposed_node: note(N.priv, 'private salary note'),
      flag: 'green',
      source_quote: 'salary is 120k',
      source_ref: 'aud-priv.md',
      confidence: 0.9,
    }, doc.priv);

    tok.owner = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: owner })).token;
    tok.alice = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: alice })).token;
  });

  it('rejects a SQL-injection status on GET /candidates', async () => {
    const r = await call(app, `/workspaces/${ws.id}/candidates?status=${encodeURIComponent("x' OR '1'='1")}`, { token: aliceSess });
    expect(r.status).toBe(400);
  });

  it("hides candidates behind another member's private note", async () => {
    const ids = async (t: string) =>
      ((await call(app, `/workspaces/${ws.id}/candidates?status=pending`, { token: t })).json.candidates as any[]).map((c) => c.id);
    expect(await ids(ownerSess)).toContain('cand-priv');
    expect(await ids(aliceSess)).not.toContain('cand-priv');
  });

  it('GET /context-pack applies the viewer (team + own non-only_me)', async () => {
    const ids = async (t: string) =>
      new Set(((await call(app, `/workspaces/${ws.id}/context-pack?scope=all`, { token: t })).json.nodes as any[]).map((n) => n.id));
    expect(await ids(aliceSess)).toEqual(new Set([N.team]));
    expect(await ids(ownerSess)).toEqual(new Set([N.team, N.priv]));
  });

  it('an LLM-facing read with no viewer fails closed to team only', async () => {
    const nodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: true });
    expect(nodes.map((n: any) => n.id)).toEqual([N.team]);
  });

  it('documents carry the audience of their notes', async () => {
    const listed = async (t: string) =>
      new Set(((await call(app, `/workspaces/${ws.id}/documents`, { token: t })).json.documents as any[]).map((d) => d.id));
    const alice = await listed(aliceSess);
    expect(alice.has(doc.team)).toBe(true);
    expect(alice.has(doc.legacy)).toBe(true);
    expect(alice.has(doc.priv)).toBe(false);
    expect(alice.has(doc.onlyMe)).toBe(false);
    expect(alice.has(doc.orphan)).toBe(false);
    const own = await listed(ownerSess);
    for (const k of ['team', 'priv', 'onlyMe', 'orphan', 'legacy']) expect(own.has(doc[k])).toBe(true);

    expect((await call(app, `/workspaces/${ws.id}/documents/${doc.priv}/content`, { token: aliceSess })).json.error).toBe('not_found');
    expect((await call(app, `/workspaces/${ws.id}/documents/${doc.priv}/content`, { token: ownerSess })).json?.error).not.toBe('not_found');
    expect((await call(app, `/workspaces/${ws.id}/documents/${doc.priv}/routing`, { token: aliceSess })).status).toBe(404);
  });

  it('source-RAG chunks are limited to documents the asker may read', async () => {
    await repo.upsertSourceChunks(ws.id, [
      { id: `${doc.team}:c0`, document_id: doc.team, chunk_index: 0, char_start: 0, char_end: 4, text: 'team', embedding: null, sha256: 's', created_at: '2026-05-01T00:00:00Z' },
      { id: `${doc.priv}:c0`, document_id: doc.priv, chunk_index: 0, char_start: 0, char_end: 4, text: 'priv', embedding: null, sha256: 's', created_at: '2026-05-01T00:00:00Z' },
    ]);
    const docs = async (viewer?: string) => new Set((await repo.listSourceChunkRowsForSearch(ws.id, viewer)).map((r: any) => r.document_id));
    const alice = (await repo.findOrCreateUser('alice@audience.test')).id;
    expect(await docs(alice)).toEqual(new Set([doc.team]));
    expect(await docs(owner)).toEqual(new Set([doc.team, doc.priv]));
  });

  it("GET /graph/:id/evidence is 404 for someone else's private note", async () => {
    expect((await call(app, `/workspaces/${ws.id}/graph/${N.priv}/evidence`, { token: aliceSess })).status).toBe(404);
    expect((await call(app, `/workspaces/${ws.id}/graph/${N.priv}/evidence`, { token: ownerSess })).status).toBe(200);
    expect((await call(app, `/workspaces/${ws.id}/graph/${N.team}/evidence`, { token: aliceSess })).status).toBe(200);
  });

  it("a member cannot overwrite or archive someone else's private note", async () => {
    const put = await call(app, `/workspaces/${ws.id}/graph`, { method: 'POST', body: note(N.priv, 'overwritten'), token: aliceSess });
    expect(put.status).toBe(404);
    const del = await call(app, `/workspaces/${ws.id}/graph/${N.onlyMe}`, { method: 'DELETE', token: aliceSess });
    expect(del.status).toBe(404);
    const priv = await repo.getNode(ws.id, N.priv);
    expect((priv as any).body).toBe('private salary note');
    expect((await repo.getNode(ws.id, N.onlyMe))!.status).toBe('active');
  });

  it('wiki page audience is enforced on read, and only the owner changes it', async () => {
    const privPage = (await repo.insertWikiPage(ws.id, 'default', { slug: 'p', title: 'Private page', owner_user_id: owner })).id;
    await repo.updateWikiPage(ws.id, privPage, { visibility: 'private' });
    const teamPage = (await repo.insertWikiPage(ws.id, 'default', { slug: 't', title: 'Team page', owner_user_id: owner })).id;

    expect((await call(app, `/workspaces/${ws.id}/wiki/pages/${privPage}`, { token: aliceSess })).status).toBe(404);
    expect((await call(app, `/workspaces/${ws.id}/wiki/pages/${privPage}`, { token: ownerSess })).status).toBe(200);
    const flat = (tree: any[]): string[] => tree.flatMap((n) => [n.id, ...flat(n.children ?? [])]);
    const aliceTree = flat((await call(app, `/workspaces/${ws.id}/wiki`, { token: aliceSess })).json.tree);
    expect(aliceTree).toContain(teamPage);
    expect(aliceTree).not.toContain(privPage);

    const widen = await call(app, `/workspaces/${ws.id}/wiki/pages/${teamPage}/visibility`, { method: 'PATCH', body: { visibility: 'only_me' }, token: aliceSess });
    expect(widen.status).toBe(403);
  });

  it('MCP list_recent_changes serves the redacted copy to non-owners', async () => {
    const full = await repo.getNode(ws.id, N.team);
    await repo.setNodeRedaction(ws.id, N.team, JSON.stringify({ ...full, body: '[redacted]', summary: '[redacted]' }));
    const body = async (t: string) => {
      const r = await call(app, '/mcp/tools/list_recent_changes', { method: 'POST', body: { since: '2020-01-01T00:00:00Z' }, token: t });
      return (r.json.nodes as any[]).find((n) => n.id === N.team)?.body;
    };
    expect(await body(tok.alice)).toBe('[redacted]');
    expect(await body(tok.owner)).toBe('team plan');
  });
});
