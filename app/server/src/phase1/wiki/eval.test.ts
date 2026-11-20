/**
 * Wiki quality gate (wiki-milestones.md M6).
 *
 * Encodes the acceptance thresholds for the two structuring passes as runnable,
 * DETERMINISTIC checks — they exercise the plan + fill fallback paths, so they
 * run in CI with no API key. (Live-LLM scoring of wiki-plan.md / wiki-fill.md
 * uses the same fixtures through the evals/ runner when a key is present; see
 * evals/results/wiki-eval.md.)
 *
 * Two role fixtures (product, marketing) prove role-specificity: the same code
 * yields structurally different wikis from the bound profile. The grounding gate
 * proves every rendered block cites a real node.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { buildWikiDigest, fallbackPlan, materializeWikiPlan } from './plan.js';
import { productProfile } from './mock-product-profile.js';
import { ContextProfile } from '../../lib/schemas.js';
import { fillPage } from './fill.js';
import { sealedNodeData } from '../../__test_utils__/sealed-fixtures.js';

const marketingProfile: ContextProfile = {
  id: 'marketing',
  name: 'Marketing',
  description: 'A mock marketing profile',
  shape: 'items',
  kinds: [
    { key: 'positioning', label: 'Positioning', label_plural: 'Positioning', color: 1, description: '' },
    { key: 'audience', label: 'Audience', label_plural: 'Audiences', color: 2, description: '' },
    { key: 'campaign', label: 'Campaign', label_plural: 'Campaigns', color: 3, description: '' },
  ],
  feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: '' }],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: { red: '', yellow: '', green: '' },
  seed_questions: [],
};

let db: Database.Database;
let repo: Repo;
let ws: string;
const ts = '2026-01-01T00:00:00Z';

async function node(id: string, type: string, title: string, attrs?: Record<string, unknown>, document_id?: string) {
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body`, status: 'active', created_at: ts, updated_at: ts, attrs });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, document_id, visibility, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, 'team', ?, ?)`,
    )
    .run(id, ws, type, data, document_id ?? null, ts, ts);
}
function doc(id: string, ref: string, source_type: string) {
  repo.db
    .prepare(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, source_type, created_at) VALUES (?, ?, ?, 'doc', ?, 1, ?, ?)`)
    .run(id, ws, ref, id, source_type, ts);
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
});

/** Fill every page and return the grounding rate (fraction of blocks that cite
 *  ≥1 real active node) and the total block count. */
async function groundingGate(): Promise<{ rate: number; blocks: number }> {
  const activeIds = new Set(
    (repo.db.prepare(`SELECT id FROM graph_nodes WHERE workspace_id = ? AND status = 'active'`).all(ws) as Array<{ id: string }>).map((r) => r.id),
  );
  let total = 0;
  let grounded = 0;
  for (const page of (await repo.listWikiPages(ws, 'default')).filter((p) => p.kind === 'page')) {
    await fillPage(repo, ws, 'default', page);
    for (const b of await repo.listWikiBlocks(ws, page.id)) {
      total++;
      if (b.cited_node_ids.length > 0 && b.cited_node_ids.every((id) => activeIds.has(id))) grounded++;
    }
  }
  return { rate: total === 0 ? 1 : grounded / total, blocks: total };
}

describe('wiki quality gate — product profile', () => {
  beforeEach(async () => {
    await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
    doc('d1', 'wiki-spec.md', 'prd_or_spec');
    doc('d2', 'updates-spec.md', 'prd_or_spec');
    await node('p1', 'product', 'Pomegranate', { product: 'Pomegranate', subkind: 'definition' }, 'd1');
    await node('f1', 'feature', 'Wiki', { product: 'Pomegranate' }, 'd1');
    await node('f2', 'feature', 'Updates', { product: 'Pomegranate' }, 'd2');
    await node('g1', 'goal', 'Low upkeep', { product: 'Pomegranate' });
  });

  it('STRUCTURE: one product page per product, not one per document', async () => {
    const digest = await buildWikiDigest(repo, ws, 'default', productProfile);
    await materializeWikiPlan(repo, ws, 'default', 'product', fallbackPlan(digest));
    const pages = await repo.listWikiPages(ws, 'default');
    const productCat = pages.find((p) => p.kind === 'category' && p.title === 'Products')!;
    const productPages = pages.filter((p) => p.parent_id === productCat.id);
    expect(productPages.map((p) => p.title)).toEqual(['Pomegranate']); // ONE page, not two-per-spec
  });

  it('GROUNDING: every filled block cites a real node (≥ 0.99)', async () => {
    const digest = await buildWikiDigest(repo, ws, 'default', productProfile);
    await materializeWikiPlan(repo, ws, 'default', 'product', fallbackPlan(digest));
    const { rate, blocks } = await groundingGate();
    expect(blocks).toBeGreaterThan(0);
    expect(rate).toBeGreaterThanOrEqual(0.99);
  });
});

describe('wiki quality gate — marketing profile (role-specificity)', () => {
  beforeEach(async () => {
    await repo.setWorkspaceProfile(ws, 'marketing', marketingProfile, 'default');
    doc('m1', 'brand.md', 'brand_or_messaging_doc');
    await node('p1', 'positioning', 'The mid-market wedge', {}, 'm1');
    await node('a1', 'audience', 'Operators', {}, 'm1');
    await node('c1', 'campaign', 'Launch', {});
  });

  it('STRUCTURE: categories come from the marketing profile, differing from product', async () => {
    const digest = await buildWikiDigest(repo, ws, 'default', marketingProfile);
    await materializeWikiPlan(repo, ws, 'default', 'marketing', fallbackPlan(digest));
    const cats = (await repo.listWikiPages(ws, 'default')).filter((p) => p.kind === 'category').map((p) => p.title);
    expect(cats.length).toBeGreaterThan(0);
    // marketing nodes carry no `product` scope → NO "Products" category (unlike the product fixture)
    expect(cats).not.toContain('Products');
  });

  it('GROUNDING: every filled block cites a real node (≥ 0.99)', async () => {
    const digest = await buildWikiDigest(repo, ws, 'default', marketingProfile);
    await materializeWikiPlan(repo, ws, 'default', 'marketing', fallbackPlan(digest));
    const { rate } = await groundingGate();
    expect(rate).toBeGreaterThanOrEqual(0.99);
  });
});
