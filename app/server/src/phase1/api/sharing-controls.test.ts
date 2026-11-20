/**
 * Backend for the sharing/audience UI controls (cloud web app).
 *
 * Covers the two pieces the cloud UI depends on that the standalone loopback
 * used to own:
 *   1. GET /workspaces/:ws/graph surfaces per-node visibility/owner/can_manage
 *      so the Library + Curate pills can render current audience.
 *   2. POST /workspaces/:ws/sync/document/:id/visibility fans an audience out
 *      over every node of a source ("share the whole source"), reusing the node
 *      ACL — and the change actually gates a teammate's reads.
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-share-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?share-test=' + Date.now());
}
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

/** The stub's capture heuristics extract decision/goal-kind candidates —
 *  install the founding fixture profile so they validate under `notes`. */
async function installFounding(app: any, wsId: string, token: string) {
  await call(app, `/workspaces/${wsId}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
}

/** Light auto-applies on ingest (no manual approve step) — the active node ids
 *  in a fresh workspace ARE what the source produced. */
async function activeNodeIds(repo: any, wsId: string): Promise<string[]> {
  return (await repo.listNodesWithEmbeddings(wsId, { activeOnly: true })).map((r: { node: { id: string } }) => r.node.id);
}

describe('sharing controls — graph payload + source fan-out', () => {
  it('surfaces node audience on /graph and fans a whole source out to private, gating a teammate', async () => {
    const { app, repo } = (await loadApp()) as any;
    const ownerSess = await magic(app, 'owner@share.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'Share', profile_id: 'notes' }, token: ownerSess })).json;
    await installFounding(app, ws.id, ownerSess);
    const owner = (await repo.findOrCreateUser('owner@share.test')).id;
    const bob = (await repo.findOrCreateUser('bob@share.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });
    const bobSess = await magic(app, 'bob@share.test');

    // Add a source — Light auto-applies on ingest, so it's already active.
    const ing = await call(app, `/workspaces/${ws.id}/ingest`, {
      token: ownerSess,
      body: { source_kind: 'doc', source: 'We are killing the v1 mobile app effective today. Mid-market wedge stays.', source_ref: 'share-paste' },
    });
    expect(ing.status).toBe(200);
    const approvedIds = await activeNodeIds(repo, ws.id);
    expect(approvedIds.length).toBeGreaterThan(0);

    // 1. /graph surfaces audience: cloud-native nodes read as team / no owner /
    //    manageable by anyone.
    const graph = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: ownerSess });
    const byId = new Map<string, any>(graph.json.nodes.map((n: any) => [n.id, n]));
    for (const id of approvedIds) {
      const n = byId.get(id);
      expect(n).toBeTruthy();
      expect(n.visibility).toBe('team');
      expect(n.owner_user_id).toBeNull();
      expect(n.can_manage).toBe(true);
    }

    // Bob (teammate) sees them while they're team-visible.
    const graphBobBefore = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: bobSess });
    const bobSeesBefore = new Set<string>(graphBobBefore.json.nodes.map((n: any) => n.id));
    for (const id of approvedIds) expect(bobSeesBefore.has(id)).toBe(true);

    // 2. Fan the whole source out to 'private' in one call.
    const docId = await repo.getNodeDocumentId(ws.id, approvedIds[0]);
    expect(docId).toBeTruthy();
    const fanout = await call(app, `/workspaces/${ws.id}/sync/document/${docId}/visibility`, {
      token: ownerSess,
      body: { visibility: 'private' },
    });
    expect(fanout.status).toBe(200);
    expect(fanout.json.changed).toBe(approvedIds.length);
    expect(fanout.json.skipped).toBe(0);

    // Every node is now private + owned by the actor.
    for (const id of approvedIds) {
      const v = await repo.getNodeVisibility(ws.id, id);
      expect(v.visibility).toBe('private');
      expect(v.owner_user_id).toBe(owner);
    }

    // Bob no longer sees any of them (private → owner-only).
    const graphBobAfter = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: bobSess });
    const bobSeesAfter = new Set<string>(graphBobAfter.json.nodes.map((n: any) => n.id));
    for (const id of approvedIds) expect(bobSeesAfter.has(id)).toBe(false);
  });

  it('fans a source out across versions and recovers legacy NULL document_id (regression: 404 "no nodes for document")', async () => {
    const { app, repo } = (await loadApp()) as any;
    const { migrate } = await import('../db/schema.js');
    const db = (repo as any).db;
    const sess = await magic(app, 'o@bug404.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'Bug404', profile_id: 'notes' }, token: sess })).json;
    await installFounding(app, ws.id, sess);

    // Light auto-applies on ingest (no manual approve step) — snapshot active
    // node ids before/after each ingest to isolate what it produced.
    async function ingestApprove(source: string): Promise<string[]> {
      const before = new Set(
        (await repo.listNodesWithEmbeddings(ws.id, { activeOnly: true })).map((r: { node: { id: string } }) => r.node.id),
      );
      const ing = await call(app, `/workspaces/${ws.id}/ingest`, {
        token: sess,
        body: { source_kind: 'doc', source, source_ref: 'src-x' },
      });
      expect(ing.status).toBe(200);
      return (await repo
        .listNodesWithEmbeddings(ws.id, { activeOnly: true }))
        .map((r: { node: { id: string } }) => r.node.id)
        .filter((id: string) => !before.has(id));
    }

    // Two versions of the SAME source_ref (changed content → new doc id/version).
    // Distinct node types (decision vs goal) so neither is deduped into the other.
    const v1 = await ingestApprove('We are killing the v1 mobile app effective today.');
    const v2 = await ingestApprove('Our north star OKR is 5000 mid-market customers by Q4.');
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
    const doc1 = await repo.getNodeDocumentId(ws.id, v1[0]);
    const doc2 = await repo.getNodeDocumentId(ws.id, v2[0]);
    expect(doc1).toBeTruthy();
    expect(doc2).toBeTruthy();
    expect(doc1).not.toBe(doc2); // distinct versions of the one source

    // Sharing the LATEST version's id must still reach nodes captured under the
    // EARLIER version — version-aware match, not an exact-id 404.
    const all = v1.length + v2.length;
    const fan = await call(app, `/workspaces/${ws.id}/sync/document/${doc2}/visibility`, {
      token: sess,
      body: { visibility: 'private' },
    });
    expect(fan.status).toBe(200);
    expect(fan.json.changed).toBe(all);

    // Legacy simulation: nodes predating graph_nodes.document_id (NULL linkage)
    // → the fan-out finds nothing → the reported 404.
    db.prepare(`UPDATE graph_nodes SET document_id = NULL WHERE workspace_id = ?`).run(ws.id);
    const broken = await call(app, `/workspaces/${ws.id}/sync/document/${doc2}/visibility`, {
      token: sess,
      body: { visibility: 'team' },
    });
    expect(broken.status).toBe(404);
    expect(broken.json.error).toBe('no nodes for document');

    // The backfill migration recovers the linkage from the approved candidates.
    migrate(db);
    const fixed = await call(app, `/workspaces/${ws.id}/sync/document/${doc2}/visibility`, {
      token: sess,
      body: { visibility: 'team' },
    });
    expect(fixed.status).toBe(200);
    expect(fixed.json.changed).toBe(all);
  });

  it('fans a whole category (kind) out to private, gating a teammate', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'owner@kind.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'KindShare', profile_id: 'notes' }, token: sess })).json;
    const bob = (await repo.findOrCreateUser('bob@kind.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });
    const bobSess = await magic(app, 'bob@kind.test');
    await installFounding(app, ws.id, sess);

    const ing = await call(app, `/workspaces/${ws.id}/ingest`, {
      token: sess,
      body: { source_kind: 'doc', source: 'We are killing the v1 mobile app effective today.', source_ref: 'kind-src' },
    });
    expect(ing.status).toBe(200);
    const ids = await activeNodeIds(repo, ws.id);
    expect(ids.length).toBeGreaterThan(0);

    // Bob sees the decision nodes while they're team-visible.
    const before = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: bobSess });
    expect(new Set(before.json.nodes.map((n: any) => n.id)).has(ids[0])).toBe(true);

    // Fan the whole 'decision' category out to private in one call.
    const fan = await call(app, `/workspaces/${ws.id}/sync/kind/decision/visibility`, {
      token: sess,
      body: { visibility: 'private' },
    });
    expect(fan.status).toBe(200);
    expect(fan.json.changed).toBe(ids.length);

    // Bob no longer sees any of them (private → owner-only).
    const after = await call(app, `/workspaces/${ws.id}/graph`, { method: 'GET', token: bobSess });
    const seen = new Set<string>(after.json.nodes.map((n: any) => n.id));
    for (const id of ids) expect(seen.has(id)).toBe(false);

    // Unknown kind → 404 (parallel to the document fan-out contract).
    const none = await call(app, `/workspaces/${ws.id}/sync/kind/nonexistent/visibility`, {
      token: sess,
      body: { visibility: 'team' },
    });
    expect(none.status).toBe(404);
    expect(none.json.error).toBe('no nodes for kind');
  });

  it('fan-out skips nodes the caller does not own (owner/admin gate)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const ownerSess = await magic(app, 'a@share2.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'Share2', profile_id: 'notes' }, token: ownerSess })).json;
    const bob = (await repo.findOrCreateUser('b@share2.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });
    const bobSess = await magic(app, 'b@share2.test');
    await installFounding(app, ws.id, ownerSess);

    const ing = await call(app, `/workspaces/${ws.id}/ingest`, {
      token: ownerSess,
      body: { source_kind: 'doc', source: 'We are killing the v1 mobile app effective today.', source_ref: 'p2' },
    });
    expect(ing.status).toBe(200);
    const ids = await activeNodeIds(repo, ws.id);
    const docId = await repo.getNodeDocumentId(ws.id, ids[0]);

    // Owner takes ownership of the source (private).
    await call(app, `/workspaces/${ws.id}/sync/document/${docId}/visibility`, { token: ownerSess, body: { visibility: 'private' } });

    // Bob (member, not owner/admin) tries to change it — every node is skipped.
    const bobTry = await call(app, `/workspaces/${ws.id}/sync/document/${docId}/visibility`, { token: bobSess, body: { visibility: 'team' } });
    expect(bobTry.status).toBe(200);
    expect(bobTry.json.changed).toBe(0);
    expect(bobTry.json.skipped).toBe(ids.length);
    // Still private.
    expect((await repo.getNodeVisibility(ws.id, ids[0])).visibility).toBe('private');
  });
});
