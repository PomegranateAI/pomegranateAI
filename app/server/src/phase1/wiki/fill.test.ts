import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import { materializeWikiPlan } from './plan.js';
import { gatherPageNodes, fillPage } from './fill.js';
import { sealedNodeData, sealedEvidenceQuote } from '../../__test_utils__/sealed-fixtures.js';

let db: Database.Database;
let repo: Repo;
let ws: string;
const ts = '2026-01-01T00:00:00Z';

async function addNode(id: string, type: string, title: string, attrs?: Record<string, unknown>) {
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body text`, status: 'active', created_at: ts, updated_at: ts, attrs });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, document_id, visibility, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, 'team', ?, ?)`,
    )
    .run(
      id,
      ws,
      type,
      data,
      attrs?.document_id ?? null,
      ts,
      ts,
    );
}

function addDoc(id: string, ref: string) {
  repo.db
    .prepare(
      `INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, source_type, created_at, last_ingested_at)
       VALUES (?, ?, ?, 'doc', ?, 1, 'prd_or_spec', ?, ?)`,
    )
    .run(id, ws, ref, id, ts, ts);
}

async function addEvidence(nodeId: string, docId: string) {
  const quote = await sealedEvidenceQuote(repo, ws, nodeId, docId, `quote for ${nodeId}`);
  repo.db
    .prepare(
      `INSERT INTO node_evidence (workspace_id, node_id, document_id, quote, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ws, nodeId, docId, quote, ts);
}

function addEdge(src: string, dst: string, kind: string) {
  repo.db
    .prepare(
      `INSERT INTO graph_edges (id, workspace_id, subgraph_id, src, dst, kind, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'default', ?, ?, ?, 'active', 'manual', ?, ?)`,
    )
    .run(`e_${src}_${dst}`, ws, src, dst, kind, ts, ts);
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
});

describe('gatherPageNodes', () => {
  it('collects origin-document nodes, anchor-scope nodes, and one-hop neighbours', async () => {
    addDoc('d1', 'spec.md');
    await addNode('def', 'product', 'Pomegranate', { product: 'Pomegranate', document_id: 'd1' });
    await addEvidence('def', 'd1'); // makes 'def' an origin-doc node of d1
    await addNode('feat', 'feature', 'Wiki', { product: 'Pomegranate' }); // same product scope
    await addNode('goal', 'goal', 'Low upkeep'); // reached only via edge
    addEdge('feat', 'goal', 'supports');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        {
          title: 'Products',
          pages: [
            {
              title: 'Pomegranate',
              anchor: { kind: 'product', scope_value: 'Pomegranate' },
              source_doc_ids: ['d1'],
              sections: [{ heading: 'Definition' }, { heading: 'Goals' }],
            },
          ],
        },
      ],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Pomegranate')!;
    const { nodes, originIds } = await gatherPageNodes(repo, ws, 'default', page);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['def', 'feat', 'goal']);
    expect(originIds.has('def')).toBe(true);
    // 'def' from the origin document is in_document; the edge-reached goal is not
    expect(nodes.find((n) => n.id === 'def')!.in_document).toBe(true);
    expect(nodes.find((n) => n.id === 'goal')!.in_document).toBe(false);
  });

  it('resolves a non-product entity page by {kind,title} — not just by product', async () => {
    // The planner anchors a project page to {kind:'project', scope_value:<title>}
    // with NO source_doc_ids and NO product attr. This must still find the entity
    // node (matched by title + kind) and its one-hop neighbours — the root-cause
    // case where such pages previously filled empty.
    await addNode('proj', 'project', 'Migrate to Postgres');
    await addNode('risk', 'goal', 'Zero downtime'); // reached only via edge
    addEdge('proj', 'risk', 'supports');
    await addNode('decoy', 'goal', 'Migrate to Postgres'); // same title, wrong kind → excluded

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        {
          title: 'Projects',
          pages: [
            {
              title: 'Migrate to Postgres',
              anchor: { kind: 'project', scope_value: 'Migrate to Postgres' },
              sections: [{ heading: 'Objective' }],
            },
          ],
        },
      ],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Migrate to Postgres')!;
    const { nodes } = await gatherPageNodes(repo, ws, 'default', page);
    const ids = nodes.map((n) => n.id).sort();
    // the project node (by title+kind) and its edge neighbour; NOT the wrong-kind decoy
    expect(ids).toEqual(['proj', 'risk']);
  });

  it('resolves a kind-overview page (kind, no scope_value) to every node of that kind', async () => {
    await addNode('p1', 'project', 'Alpha');
    await addNode('p2', 'project', 'Beta');
    await addNode('g1', 'goal', 'Not a project');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        { title: 'Projects', pages: [{ title: 'All projects', anchor: { kind: 'project' }, sections: [{ heading: 'Overview' }] }] },
      ],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'All projects')!;
    const { nodes } = await gatherPageNodes(repo, ws, 'default', page);
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['p1', 'p2']);
  });
});

describe('fillPage (fallback, no LLM)', () => {
  it('writes cited blocks and classifies provenance', async () => {
    addDoc('d1', 'spec.md');
    await addNode('def', 'product', 'Pomegranate', { product: 'Pomegranate', document_id: 'd1' });
    await addEvidence('def', 'd1');
    await addNode('goal', 'goal', 'Low upkeep', { product: 'Pomegranate' });
    addEdge('def', 'goal', 'belongs_to');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        {
          title: 'Products',
          pages: [
            {
              title: 'Pomegranate',
              anchor: { kind: 'product', scope_value: 'Pomegranate' },
              source_doc_ids: ['d1'],
              sections: [{ heading: 'Definition' }],
            },
          ],
        },
      ],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Pomegranate')!;
    const r = await fillPage(repo, ws, 'default', page);
    expect(r.via).toBe('fallback');
    expect(r.blocks).toBeGreaterThan(0);

    const blocks = await repo.listWikiBlocks(ws, page.id);
    // every block cites at least one real node
    const nodeIds = new Set(['def', 'goal']);
    for (const b of blocks) {
      expect(b.cited_node_ids.length).toBeGreaterThan(0);
      for (const id of b.cited_node_ids) expect(nodeIds.has(id)).toBe(true);
    }
    // the origin-doc node → in_document; a scope/edge-only node → inferred
    const defBlock = blocks.find((b) => b.cited_node_ids.includes('def'))!;
    expect(defBlock.provenance).toBe('in_document');
    const goalBlock = blocks.find((b) => b.cited_node_ids.includes('goal'))!;
    expect(goalBlock.provenance).toBe('inferred');
  });

  it('is idempotent and protects human-edited blocks on refill', async () => {
    addDoc('d1', 'spec.md');
    await addNode('def', 'product', 'Pomegranate', { product: 'Pomegranate', document_id: 'd1' });
    await addEvidence('def', 'd1');
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Pomegranate', anchor: { scope_value: 'Pomegranate' }, source_doc_ids: ['d1'], sections: [{ heading: 'Definition' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Pomegranate')!;
    await fillPage(repo, ws, 'default', page);
    const first = await repo.listWikiBlocks(ws, page.id);
    expect(first.length).toBeGreaterThan(0);

    // Simulate a human edit on the first block (protected from regen).
    repo.db.prepare(`UPDATE wiki_blocks SET edited_by_user = 1 WHERE workspace_id = ? AND id = ?`).run(ws, first[0].id);
    await fillPage(repo, ws, 'default', page);
    const after = await repo.listWikiBlocks(ws, page.id);
    // the edited block survived the refill
    expect(after.some((b) => b.id === first[0].id)).toBe(true);
  });

  it('marks inferred blocks pending and does not re-propose a rejected one (M3)', async () => {
    addDoc('d1', 'spec.md');
    await addNode('def', 'product', 'Pomegranate', { product: 'Pomegranate', document_id: 'd1' });
    await addEvidence('def', 'd1');
    await addNode('goal', 'goal', 'Low upkeep', { product: 'Pomegranate' }); // scope-only → inferred
    addEdge('def', 'goal', 'belongs_to');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Pomegranate', anchor: { scope_value: 'Pomegranate' }, source_doc_ids: ['d1'], sections: [{ heading: 'Definition' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Pomegranate')!;
    await fillPage(repo, ws, 'default', page);

    const goalBlock = (await repo.listWikiBlocks(ws, page.id)).find((b) => b.cited_node_ids.includes('goal'))!;
    expect(goalBlock.provenance).toBe('inferred');
    expect(goalBlock.review_state).toBe('pending'); // inferred → pending

    // Reject it, then refill — the same citation set must not come back.
    await repo.setWikiBlockReview(ws, goalBlock.id, 'rejected');
    await fillPage(repo, ws, 'default', page);
    const goalAgain = (await repo.listWikiBlocks(ws, page.id)).filter((b) => b.cited_node_ids.includes('goal') && b.review_state !== 'rejected');
    expect(goalAgain.length).toBe(0);
  });

  it('clears blocks and reports empty when a page has no nodes', async () => {
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Empty', pages: [{ title: 'Nothing', sections: [{ heading: 'X' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Nothing')!;
    const r = await fillPage(repo, ws, 'default', page);
    expect(r.via).toBe('empty');
    expect(await repo.listWikiBlocks(ws, page.id)).toEqual([]);
  });
});
