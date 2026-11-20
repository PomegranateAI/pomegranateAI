/**
 * Wiki HTTP surface (M1): build structure, read the tree/pages, and the manual
 * structure-editing endpoints (add / rename / move / reorder / remove).
 *
 * No structured LLM is wired in tests, so /wiki/plan takes the deterministic
 * fallback path (via: 'fallback') — which is exactly what lets the structure
 * endpoints be exercised without a model.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sealedNodeData, sealedEvidenceQuote } from '../../__test_utils__/sealed-fixtures.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-wiki-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?wiki-test=' + Date.now());
}
async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' } });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: j1.dev_code }), headers: { 'content-type': 'application/json' } });
  return (await r2.json()).session as string;
}
async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function addNode(repo: any, ws: string, id: string, type: string, title: string, attrs?: Record<string, unknown>) {
  const ts = '2026-01-01T00:00:00Z';
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body`, status: 'active', created_at: ts, updated_at: ts, attrs });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, ?)`,
    )
    .run(id, ws, type, data, ts, ts);
}

describe('wiki M1 HTTP surface', () => {
  it('builds a structure, reads the tree, and edits it', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'owner@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'W', profile_id: 'notes' }, token: sess })).json;

    await addNode(repo, ws.id, 'n1', 'product', 'Pomegranate', { product: 'Pomegranate' });
    await addNode(repo, ws.id, 'n2', 'product', 'Standalone', { product: 'Standalone' });
    await addNode(repo, ws.id, 'n3', 'goal', 'Low upkeep');

    // Empty before build.
    const empty = await call(app, `/workspaces/${ws.id}/wiki`, { token: sess });
    expect(empty.status).toBe(200);
    expect(empty.json.wiki).toBeNull();
    expect(empty.json.tree).toEqual([]);

    // Build (fallback path — no LLM in tests).
    const built = await call(app, `/workspaces/${ws.id}/wiki/plan`, { method: 'POST', token: sess });
    expect(built.status).toBe(200);
    expect(built.json.via).toBe('fallback');
    expect(built.json.categories).toBeGreaterThan(0);

    const tree = (await call(app, `/workspaces/${ws.id}/wiki`, { token: sess })).json.tree;
    const products = tree.find((c: any) => c.title === 'Products');
    expect(products).toBeTruthy();
    expect(products.children.map((p: any) => p.title).sort()).toEqual(['Pomegranate', 'Standalone']);

    // Page read returns planned sections and the filled blocks produced during build.
    const pomeId = products.children.find((p: any) => p.title === 'Pomegranate').id;
    const page = await call(app, `/workspaces/${ws.id}/wiki/pages/${pomeId}`, { token: sess });
    expect(page.status).toBe(200);
    expect(page.json.page.sections.length).toBeGreaterThan(0);
    expect(page.json.blocks.length).toBeGreaterThan(0);

    // Add a page under the Products category.
    const added = await call(app, `/workspaces/${ws.id}/wiki/pages`, {
      method: 'POST',
      body: { kind: 'page', title: 'New product', parent_id: products.id },
      token: sess,
    });
    expect(added.status).toBe(200);
    const newId = added.json.id;
    expect(added.json.tree.find((c: any) => c.title === 'Products').children.some((p: any) => p.id === newId)).toBe(true);

    // Rename it.
    const renamed = await call(app, `/workspaces/${ws.id}/wiki/pages/${newId}`, {
      method: 'PATCH',
      body: { title: 'Renamed product' },
      token: sess,
    });
    expect(renamed.status).toBe(200);
    expect((await repo.getWikiPage(ws.id, newId)).title).toBe('Renamed product');

    // Move it under the Pomegranate page (reparent).
    const moved = await call(app, `/workspaces/${ws.id}/wiki/pages/${newId}`, {
      method: 'PATCH',
      body: { parent_id: pomeId },
      token: sess,
    });
    expect(moved.status).toBe(200);
    expect((await repo.getWikiPage(ws.id, newId)).parent_id).toBe(pomeId);

    // Remove it (archived, not hard-deleted).
    const removed = await call(app, `/workspaces/${ws.id}/wiki/pages/${newId}`, { method: 'DELETE', token: sess });
    expect(removed.status).toBe(200);
    expect((await repo.getWikiPage(ws.id, newId)).status).toBe('archived');
  });

  it('persists filled content when the wiki is first built', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'persist@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'Persist', profile_id: 'notes' }, token: sess })).json;

    await addNode(repo, ws.id, 'p1', 'product', 'Pomegranate', { product: 'Pomegranate' });

    const built = await call(app, `/workspaces/${ws.id}/wiki/plan`, { method: 'POST', token: sess });
    expect(built.status).toBe(200);

    const page = (await repo.listWikiPages(ws.id, 'default')).find((p: any) => p.title === 'Pomegranate');
    expect(page).toBeTruthy();
    expect((await repo.listWikiBlocks(ws.id, page.id)).length).toBeGreaterThan(0);
  });

  it('rejects reparenting a page onto its own descendant (cycle guard)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'owner2@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'W2', profile_id: 'notes' }, token: sess })).json;

    const cat = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'category', title: 'Cat' }, token: sess })).json.id;
    const parent = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'page', title: 'Parent', parent_id: cat }, token: sess })).json.id;
    const child = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'page', title: 'Child', parent_id: parent }, token: sess })).json.id;

    // Try to move Parent under Child → must be rejected.
    const bad = await call(app, `/workspaces/${ws.id}/wiki/pages/${parent}`, { method: 'PATCH', body: { parent_id: child }, token: sess });
    expect(bad.status).toBe(400);
    expect((await repo.getWikiPage(ws.id, parent)).parent_id).toBe(cat);
  });

  it('fills a page with cited blocks over HTTP (fallback path)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'fill@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'F', profile_id: 'notes' }, token: sess })).json;

    // A product node tied to a document, plus an edge-reached goal.
    repo.db
      .prepare(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, source_type, created_at) VALUES ('d1', ?, 'spec.md', 'doc', 'h', 1, 'prd_or_spec', '2026-01-01T00:00:00Z')`)
      .run(ws.id);
    await addNode(repo, ws.id, 'def', 'product', 'Pomegranate', { product: 'Pomegranate' });
    repo.db.prepare(`INSERT INTO node_evidence (workspace_id, node_id, document_id, quote, captured_at) VALUES (?, 'def', 'd1', ?, '2026-01-01T00:00:00Z')`).run(ws.id, await sealedEvidenceQuote(repo, ws.id, 'def', 'd1', 'q'));

    await call(app, `/workspaces/${ws.id}/wiki/plan`, { method: 'POST', token: sess });
    // Point the product page at the document so fill has an origin.
    const tree = (await call(app, `/workspaces/${ws.id}/wiki`, { token: sess })).json.tree;
    const productPage = tree.find((c: any) => c.title === 'Products').children.find((p: any) => p.title === 'Pomegranate');
    await repo.updateWikiPage(ws.id, productPage.id, { sections: [{ heading: 'Definition' }] } as any);
    repo.db.prepare(`UPDATE wiki_pages SET source_doc_ids = '["d1"]' WHERE workspace_id = ? AND id = ?`).run(ws.id, productPage.id);

    const filled = await call(app, `/workspaces/${ws.id}/wiki/pages/${productPage.id}/fill`, { method: 'POST', token: sess });
    expect(filled.status).toBe(200);
    expect(filled.json.blocks).toBeGreaterThan(0);
    expect(filled.json.blocks_list[0].cited_node_ids).toContain('def');
    expect(filled.json.blocks_list[0].provenance).toBe('in_document');
  });

  it('adds, edits, and deletes blocks; user blocks are edit-protected (M5)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'edit@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'E', profile_id: 'notes' }, token: sess })).json;
    const cat = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'category', title: 'C' }, token: sess })).json.id;
    const page = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'page', title: 'P', parent_id: cat }, token: sess })).json.id;

    const added = await call(app, `/workspaces/${ws.id}/wiki/pages/${page}/blocks`, { method: 'POST', body: { type: 'paragraph', content: { text: 'hello' } }, token: sess });
    expect(added.status).toBe(200);
    const blockId = added.json.blocks_list[0].id;
    expect((await repo.getWikiBlock(ws.id, blockId)).edited_by_user).toBe(true);
    expect((await repo.getWikiBlock(ws.id, blockId)).provenance).toBe('user');

    const edited = await call(app, `/workspaces/${ws.id}/wiki/blocks/${blockId}`, { method: 'PATCH', body: { content: { text: 'goodbye' } }, token: sess });
    expect(edited.status).toBe(200);
    expect((await repo.getWikiBlock(ws.id, blockId)).content.text).toBe('goodbye');

    const del = await call(app, `/workspaces/${ws.id}/wiki/blocks/${blockId}`, { method: 'DELETE', token: sess });
    expect(del.status).toBe(200);
    expect(await repo.getWikiBlock(ws.id, blockId)).toBeUndefined();
  });

  it('replaces the whole page body at once, preserving citations and rejecting removed inferred blocks (unified editor)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'body@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'B', profile_id: 'notes' }, token: sess })).json;
    const cat = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'category', title: 'C' }, token: sess })).json.id;
    const page = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'page', title: 'P', parent_id: cat }, token: sess })).json.id;

    // An inferred, cited block already in the document.
    const inf = (await repo.insertWikiBlock(ws.id, page, {
      sort_order: 0,
      type: 'paragraph',
      content: { text: '<p>cited body</p>' },
      cited_node_ids: ['def'],
      provenance: 'inferred',
      review_state: 'accepted',
    })).id;

    // Save a body that keeps (and edits) the inferred block and adds a new
    // client-id block. The inferred block keeps its citations + provenance; the
    // new one is inserted under the editor's own id as a user block.
    const save1 = await call(app, `/workspaces/${ws.id}/wiki/pages/${page}/body`, {
      method: 'PUT',
      body: {
        blocks: [
          { id: inf, type: 'paragraph', content: { text: '<p>cited body edited</p>' } },
          { id: 'wb_clientnew1', type: 'heading', content: { text: '<h2>New</h2>' } },
        ],
      },
      token: sess,
    });
    expect(save1.status).toBe(200);
    const kept = await repo.getWikiBlock(ws.id, inf);
    expect(kept.content.text).toBe('<p>cited body edited</p>');
    expect(kept.cited_node_ids).toContain('def');
    expect(kept.provenance).toBe('inferred');
    const created = await repo.getWikiBlock(ws.id, 'wb_clientnew1');
    expect(created).toBeTruthy();
    expect(created.provenance).toBe('user');
    expect(created.type).toBe('heading');
    expect(created.edited_by_user).toBe(true);

    // Save again dropping the inferred block → remembered as rejected, not gone,
    // so a later refill does not re-propose it.
    const save2 = await call(app, `/workspaces/${ws.id}/wiki/pages/${page}/body`, {
      method: 'PUT',
      body: { blocks: [{ id: 'wb_clientnew1', type: 'heading', content: { text: '<h2>New</h2>' } }] },
      token: sess,
    });
    expect(save2.status).toBe(200);
    expect((await repo.getWikiBlock(ws.id, inf)).review_state).toBe('rejected');
  });

  it('clamps page audience to its most-restrictive node (no widening, M5/§9)', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'share@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'S', profile_id: 'notes' }, token: sess })).json;
    // A product node marked only_me, tied to a document.
    repo.db.prepare(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, source_type, created_at) VALUES ('d1', ?, 'spec.md', 'doc', 'h', 1, 'prd_or_spec', '2026-01-01T00:00:00Z')`).run(ws.id);
    await addNode(repo, ws.id, 'def', 'product', 'Secret', { product: 'Secret' });
    repo.db.prepare(`UPDATE graph_nodes SET visibility = 'only_me', document_id = 'd1' WHERE workspace_id = ? AND id = 'def'`).run(ws.id);

    const cat = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'category', title: 'C' }, token: sess })).json.id;
    const page = (await call(app, `/workspaces/${ws.id}/wiki/pages`, { method: 'POST', body: { kind: 'page', title: 'P', parent_id: cat }, token: sess })).json.id;
    repo.db.prepare(`UPDATE wiki_pages SET source_doc_ids = '["d1"]' WHERE workspace_id = ? AND id = ?`).run(ws.id, page);

    // Widening to team must be rejected (the node is only_me).
    const widen = await call(app, `/workspaces/${ws.id}/wiki/pages/${page}/visibility`, { method: 'PATCH', body: { visibility: 'team' }, token: sess });
    expect(widen.status).toBe(422);
    expect(widen.json.error).toBe('would_widen');

    // Setting only_me (equally restrictive) is allowed.
    const ok = await call(app, `/workspaces/${ws.id}/wiki/pages/${page}/visibility`, { method: 'PATCH', body: { visibility: 'only_me' }, token: sess });
    expect(ok.status).toBe(200);
    expect((await repo.getWikiPage(ws.id, page)).visibility).toBe('only_me');
  });

  // The reported regression: "the update button generates empty articles".
  // Refresh must fold new sources into the tree, and must never blank a page.
  it('refresh adds pages for new sources and never empties an existing article', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'refresh@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'R', profile_id: 'notes' }, token: sess })).json;
    await addNode(repo, ws.id, 'r1', 'product', 'Atlas', { product: 'Atlas' });

    await call(app, `/workspaces/${ws.id}/wiki/plan`, { method: 'POST', token: sess });
    const atlas = (await repo.listWikiPages(ws.id, 'default')).find((p: any) => p.title === 'Atlas');
    expect(atlas).toBeTruthy();
    const blocksBefore = (await repo.listWikiBlocks(ws.id, atlas.id)).length;
    expect(blocksBefore).toBeGreaterThan(0);

    // A new product lands in the canon → the plan signature drifts.
    await addNode(repo, ws.id, 'r2', 'product', 'Beacon', { product: 'Beacon' });

    const refreshed = await call(app, `/workspaces/${ws.id}/wiki/fill`, { method: 'POST', token: sess });
    expect(refreshed.status).toBe(200);
    // The new product earned a page — the old refresh could never do this.
    expect(refreshed.json.added_pages).toBe(1);
    const titles = (await repo.listWikiPages(ws.id, 'default')).map((p: any) => p.title);
    expect(titles).toContain('Beacon');
    // …and the page that already existed kept its id and its content.
    const atlasAfter = (await repo.listWikiPages(ws.id, 'default')).find((p: any) => p.title === 'Atlas');
    expect(atlasAfter.id).toBe(atlas.id);
    expect((await repo.listWikiBlocks(ws.id, atlas.id)).length).toBeGreaterThan(0);
    // Refresh re-syncs to the canon → no longer stale.
    expect((await call(app, `/workspaces/${ws.id}/wiki`, { token: sess })).json.stale).toBe(false);
  });

  // GENERATED prose is what the empty-article bug destroyed: replaceWikiBlocks
  // already spares user-edited blocks, so only a filled-but-unedited article was
  // exposed — refresh it after its nodes stop resolving and it came back blank.
  it('refresh keeps a filled article when its nodes no longer resolve', async () => {
    const { app, repo } = (await loadApp()) as any;
    const sess = await magic(app, 'keep@wiki.test');
    const ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'K', profile_id: 'notes' }, token: sess })).json;
    await addNode(repo, ws.id, 'k1', 'product', 'Atlas', { product: 'Atlas' });
    await call(app, `/workspaces/${ws.id}/wiki/plan`, { method: 'POST', token: sess });

    const atlas = (await repo.listWikiPages(ws.id, 'default')).find((p: any) => p.title === 'Atlas');
    const before = await repo.listWikiBlocks(ws.id, atlas.id);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((b: any) => !b.edited_by_user)).toBe(true); // generated, unprotected

    // The node the page was built from goes away (deleted, or made private).
    repo.db.prepare(`DELETE FROM graph_nodes WHERE workspace_id = ? AND id = 'k1'`).run(ws.id);

    await call(app, `/workspaces/${ws.id}/wiki/fill`, { method: 'POST', token: sess });

    // The article still reads — it is not silently blanked.
    expect((await repo.listWikiBlocks(ws.id, atlas.id)).length).toBe(before.length);
  });

  it('scopes reads to the caller workspace (404 for a foreign page)', async () => {
    const { app } = (await loadApp()) as any;
    const a = await magic(app, 'a@wiki.test');
    const b = await magic(app, 'b@wiki.test');
    const wsA = (await call(app, '/workspaces', { method: 'POST', body: { name: 'A', profile_id: 'notes' }, token: a })).json;
    const wsB = (await call(app, '/workspaces', { method: 'POST', body: { name: 'B', profile_id: 'notes' }, token: b })).json;
    const pageA = (await call(app, `/workspaces/${wsA.id}/wiki/pages`, { method: 'POST', body: { kind: 'category', title: 'Secret' }, token: a })).json.id;

    // B cannot read A's page through B's own workspace path.
    const cross = await call(app, `/workspaces/${wsB.id}/wiki/pages/${pageA}`, { token: b });
    expect(cross.status).toBe(404);
  });
});
