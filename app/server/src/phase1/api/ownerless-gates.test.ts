/**
 * Ownerless-node and document-less-candidate gates (security fix, 2026-11-24).
 *
 *  1. An ownerless (cloud-native) node's audience may be changed only by the
 *     workspace owner tier (owner or workspace_admin). A plain member gets 403
 *     on the single-node route and has the node reported as `skipped` on the
 *     by-document and by-kind fan-outs. An admin's change never makes the admin
 *     the owner: the node stays ownerless, or goes to its document's ingester.
 *  2. A candidate with no document is visible only to its creator and the
 *     owner tier; legacy document-less rows with no creator are owner-tier only.
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-ownerless-'));
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

const note = (id: string, body: string) => ({
  id,
  type: 'note',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  status: 'active',
  summary: body,
  body,
});
// POST /candidates parses the founding Node union, so candidates propose decisions.
const decision = (id: string, body: string) => ({
  id,
  type: 'decision',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  status: 'active',
  summary: body,
  body,
  decided_on: '2026-05-01',
  category: 'other',
});
const candidate = (id: string, nodeId: string, body: string) => ({
  id,
  proposed_node: decision(nodeId, body),
  flag: 'green',
  source_quote: body,
  source_ref: 'manual',
  confidence: 0.9,
});

describe('ownerless nodes + document-less candidates', () => {
  let app: any;
  let repo: any;
  let ws: any;
  let ownerSess: string;
  let adminSess: string;
  let aliceSess: string;
  let bobSess: string;
  let admin: string;
  let alice: string;

  beforeAll(async () => {
    ({ app, repo } = (await import('./server.js?ownerless=' + Date.now())) as any);
    ownerSess = await magic(app, 'owner@ownerless.test');
    ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'Ownerless', profile_id: 'notes' }, token: ownerSess })).json;
    admin = (await repo.findOrCreateUser('admin@ownerless.test')).id;
    alice = (await repo.findOrCreateUser('alice@ownerless.test')).id;
    const bob = (await repo.findOrCreateUser('bob@ownerless.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: admin, role: 'workspace_admin' });
    await repo.addMember({ workspace_id: ws.id, user_id: alice, role: 'member' });
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });
    adminSess = await magic(app, 'admin@ownerless.test');
    aliceSess = await magic(app, 'alice@ownerless.test');
    bobSess = await magic(app, 'bob@ownerless.test');
  });

  async function ownerlessNote(id: string, body: string): Promise<void> {
    const r = await call(app, `/workspaces/${ws.id}/graph`, { method: 'POST', body: note(id, body), token: ownerSess });
    expect(r.status).toBe(200);
    const v = await repo.getNodeVisibility(ws.id, id);
    expect(v).toEqual({ visibility: 'team', owner_user_id: null });
  }

  it('a member cannot change an ownerless node (403) and /graph says so', async () => {
    await ownerlessNote('ol-single', 'shared roadmap');
    const r = await call(app, `/workspaces/${ws.id}/sync/nodes/ol-single/visibility`, { method: 'POST', token: aliceSess, body: { visibility: 'only_me' } });
    expect(r.status).toBe(403);
    expect(await repo.getNodeVisibility(ws.id, 'ol-single')).toEqual({ visibility: 'team', owner_user_id: null });

    const graph = async (t: string) =>
      new Map<string, any>((await call(app, `/workspaces/${ws.id}/graph`, { token: t })).json.nodes.map((n: any) => [n.id, n]));
    expect((await graph(aliceSess)).get('ol-single').can_manage).toBe(false);
    expect((await graph(adminSess)).get('ol-single').can_manage).toBe(true);
    expect((await graph(ownerSess)).get('ol-single').can_manage).toBe(true);
  });

  it('an admin can change an ownerless node without becoming its owner', async () => {
    await ownerlessNote('ol-admin', 'pricing note');
    const r = await call(app, `/workspaces/${ws.id}/sync/nodes/ol-admin/visibility`, { method: 'POST', token: adminSess, body: { visibility: 'private' } });
    expect(r.status).toBe(200);
    const v = await repo.getNodeVisibility(ws.id, 'ol-admin');
    expect(v.visibility).toBe('private');
    expect(v.owner_user_id).toBeNull();
    // And back to team, still unowned.
    await call(app, `/workspaces/${ws.id}/sync/nodes/ol-admin/visibility`, { method: 'POST', token: adminSess, body: { visibility: 'team' } });
    expect(await repo.getNodeVisibility(ws.id, 'ol-admin')).toEqual({ visibility: 'team', owner_user_id: null });
  });

  it("an admin's change hands an ownerless node to its document's ingester, never the admin", async () => {
    await ownerlessNote('ol-ingested', 'alice brought this in');
    const docId = (await repo.registerDocument(ws.id, { source_ref: 'alice.md', source_kind: 'doc', sha256: 'sha-alice' })).id;
    await repo.stampDocumentIngest(ws.id, docId, alice, null);
    await repo.setNodeDocumentId(ws.id, 'ol-ingested', docId);
    const r = await call(app, `/workspaces/${ws.id}/sync/nodes/ol-ingested/visibility`, { method: 'POST', token: adminSess, body: { visibility: 'private' } });
    expect(r.status).toBe(200);
    expect(await repo.getNodeVisibility(ws.id, 'ol-ingested')).toEqual({ visibility: 'private', owner_user_id: alice });
  });

  it('bulk by document and by kind skip ownerless nodes for a member, change them for an admin', async () => {
    await ownerlessNote('ol-bulk-1', 'bulk one');
    await ownerlessNote('ol-bulk-2', 'bulk two');
    const docId = (await repo.registerDocument(ws.id, { source_ref: 'bulk.md', source_kind: 'doc', sha256: 'sha-bulk' })).id;
    await repo.setNodeDocumentId(ws.id, 'ol-bulk-1', docId);
    await repo.setNodeDocumentId(ws.id, 'ol-bulk-2', docId);

    const byDoc = await call(app, `/workspaces/${ws.id}/sync/document/${docId}/visibility`, { method: 'POST', token: aliceSess, body: { visibility: 'only_me' } });
    expect(byDoc.status).toBe(200);
    expect(byDoc.json.changed).toBe(0);
    expect(byDoc.json.skipped).toBe(2);

    // Alice owns one note of her own (plus ol-ingested, handed to her above);
    // the kind fan-out changes only those.
    const mine = await call(app, `/workspaces/${ws.id}/graph`, { method: 'POST', body: note('alice-own', 'alice private'), token: aliceSess });
    expect(mine.status).toBe(200);
    await repo.setNodeVisibility(ws.id, 'alice-own', 'team', alice);
    const totalNotes = (await repo.listNodeIdsByKind(ws.id, 'note')).length;
    const byKind = await call(app, `/workspaces/${ws.id}/sync/kind/note/visibility`, { method: 'POST', token: aliceSess, body: { visibility: 'private' } });
    expect(byKind.status).toBe(200);
    expect(byKind.json.changed).toBe(2);
    expect(byKind.json.skipped).toBe(totalNotes - 2);
    for (const id of ['ol-bulk-1', 'ol-bulk-2', 'ol-single']) {
      expect((await repo.getNodeVisibility(ws.id, id)).visibility).toBe('team');
    }

    const adminDoc = await call(app, `/workspaces/${ws.id}/sync/document/${docId}/visibility`, { method: 'POST', token: adminSess, body: { visibility: 'private' } });
    expect(adminDoc.json.changed).toBe(2);
    expect(adminDoc.json.skipped).toBe(0);
    for (const id of ['ol-bulk-1', 'ol-bulk-2']) {
      expect(await repo.getNodeVisibility(ws.id, id)).toEqual({ visibility: 'private', owner_user_id: null });
    }
    const adminKind = await call(app, `/workspaces/${ws.id}/sync/kind/note/visibility`, { method: 'POST', token: adminSess, body: { visibility: 'team' } });
    expect(adminKind.json.skipped).toBe(0);
    expect((await repo.getNodeVisibility(ws.id, 'alice-own')).owner_user_id).toBe(alice);
    expect((await repo.getNodeVisibility(ws.id, 'ol-single')).owner_user_id).toBeNull();
  });

  let candWs: any;
  const candIds = async (t: string, qs = '') =>
    ((await call(app, `/workspaces/${candWs.id}/candidates?status=pending${qs}`, { token: t })).json.candidates as any[]).map((c) => c.id);

  it("a document-less candidate is visible to its creator and the owner tier, not another member", async () => {
    // Own directory with the founding profile so decision candidates validate.
    candWs = (await call(app, '/workspaces', { method: 'POST', body: { name: 'Loose', profile_id: 'notes' }, token: ownerSess })).json;
    await call(app, `/workspaces/${candWs.id}/profile`, { method: 'PUT', token: ownerSess, body: { profile: foundingProfile } });
    const bob = (await repo.findOrCreateUser('bob@ownerless.test')).id;
    await repo.addMember({ workspace_id: candWs.id, user_id: admin, role: 'workspace_admin' });
    await repo.addMember({ workspace_id: candWs.id, user_id: alice, role: 'member' });
    await repo.addMember({ workspace_id: candWs.id, user_id: bob, role: 'member' });
    await repo.insertNode(candWs.id, decision('team-decision', 'a shared decision'));
    expect((await repo.getNodeVisibility(candWs.id, 'team-decision')).visibility).toBe('team');

    const created = await call(app, `/workspaces/${candWs.id}/candidates`, { method: 'POST', token: aliceSess, body: candidate('cand-alice', 'cand-alice-node', 'alice proposal') });
    expect(created.status).toBe(200);
    expect(await candIds(aliceSess)).toContain('cand-alice');
    expect(await candIds(adminSess)).toContain('cand-alice');
    expect(await candIds(ownerSess)).toContain('cand-alice');
    expect(await candIds(bobSess)).not.toContain('cand-alice');
    // Subgraph-scoped listing applies the same rule.
    expect(await candIds(bobSess, '&subgraph=default')).not.toContain('cand-alice');
    expect(await candIds(aliceSess, '&subgraph=default')).toContain('cand-alice');

    // Even naming an existing team node's id doesn't widen it.
    await call(app, `/workspaces/${candWs.id}/candidates`, { method: 'POST', token: aliceSess, body: candidate('cand-alice-2', 'team-decision', 'alice text on a team node id') });
    expect(await candIds(bobSess)).not.toContain('cand-alice-2');
    expect(await candIds(aliceSess)).toContain('cand-alice-2');

    // No route resolves a candidate the caller can't see.
    for (const verb of ['approve', 'reject']) {
      const r = await call(app, `/workspaces/${candWs.id}/candidates/cand-alice/${verb}`, { method: 'POST', token: bobSess });
      expect(r.status).toBe(404);
    }
    expect((await repo.listCandidates(candWs.id, { status: 'pending' })).map((c: any) => c.id)).toContain('cand-alice');
  });

  it('a legacy document-less candidate with no creator is owner-tier only', async () => {
    await repo.insertCandidate(candWs.id, candidate('cand-legacy', 'cand-legacy-node', 'legacy loose'));
    expect(await candIds(adminSess)).toContain('cand-legacy');
    expect(await candIds(ownerSess)).toContain('cand-legacy');
    expect(await candIds(aliceSess)).not.toContain('cand-legacy');
    expect(await candIds(bobSess)).not.toContain('cand-legacy');
  });
});
