import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import {
  buildWikiDigest,
  fallbackPlan,
  materializeWikiPlan,
  computePlanSignature,
  type WikiPlan,
} from './plan.js';
import { sealedNodeData, sealedDocumentSummary } from '../../__test_utils__/sealed-fixtures.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-01-01T00:00:00Z';

async function addNode(id: string, type: string, title: string, attrs?: Record<string, unknown>) {
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body`, status: 'active', created_at: ts, updated_at: ts, attrs });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, ?)`,
    )
    .run(
      id,
      ws,
      type,
      data,
      ts,
      ts,
    );
}

async function addDoc(id: string, ref: string, source_type: string, summary: string, subgraph_id = 'default') {
  const sealedSummary = await sealedDocumentSummary(repo, ws, id, summary);
  repo.db
    .prepare(
      `INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, summary, source_type, created_at, last_ingested_at)
       VALUES (?, ?, ?, 'doc', ?, 1, ?, ?, ?, ?)`,
    )
    .run(id, ws, ref, id, sealedSummary, source_type, ts, ts);
  // Real ingest always records a routing row (routes the doc to its subgraph);
  // the digest lists only documents routed to the subfolder it plans, so a test
  // doc must be routed the same way to appear.
  await repo.routeDocument(ws, id, subgraph_id, { routed_by: 'pinned' });
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
});

describe('buildWikiDigest', () => {
  it('summarizes profile, documents, and node/product census', async () => {
    await addNode('n1', 'product', 'Pomegranate', { product: 'Pomegranate', subkind: 'definition' });
    await addNode('n2', 'feature', 'Wiki', { product: 'Pomegranate' });
    await addNode('n3', 'goal', 'Low upkeep');
    await addDoc('d1', 'specs/wiki.md', 'prd_or_spec', 'The wiki spec.');

    const digest = await buildWikiDigest(repo, ws, 'default', productProfile);
    expect(digest.profile.id).toBe('product');
    expect(digest.profile.groups.length).toBeGreaterThan(0);
    expect(digest.census.total_nodes).toBe(3);
    expect(digest.census.by_kind.product).toBe(1);
    expect(digest.census.by_product.Pomegranate).toBe(2);
    expect(digest.documents[0]).toMatchObject({ name: 'wiki.md', source_type: 'prd_or_spec' });
  });

  it('lists only documents routed to the planned subfolder', async () => {
    // Two subfolders sharing one workspace. A doc routed to 'sg2' must not show
    // up in 'default's digest — else the planner anchors this subfolder's pages
    // to another subfolder's document and fill reads its text in.
    await repo.setWorkspaceProfile(ws, 'product', productProfile, 'sg2');
    await addDoc('d-here', 'here.md', 'prd_or_spec', 'Belongs to default.', 'default');
    await addDoc('d-other', 'other.md', 'prd_or_spec', 'Belongs to sg2.', 'sg2');

    const here = await buildWikiDigest(repo, ws, 'default', productProfile);
    expect(here.documents.map((d) => d.id)).toEqual(['d-here']);

    const other = await buildWikiDigest(repo, ws, 'sg2', productProfile);
    expect(other.documents.map((d) => d.id)).toEqual(['d-other']);
  });
});

describe('fallbackPlan', () => {
  it('builds one product page per distinct product value', async () => {
    await addNode('n1', 'product', 'Pomegranate', { product: 'Pomegranate' });
    await addNode('n2', 'product', 'Standalone', { product: 'Standalone' });
    const digest = await buildWikiDigest(repo, ws, 'default', productProfile);
    const plan = fallbackPlan(digest);
    const products = plan.categories.find((c) => c.title === 'Products');
    expect(products).toBeTruthy();
    expect(products!.pages.map((p) => p.title).sort()).toEqual(['Pomegranate', 'Standalone']);
    // every product page has sections to fill in M2
    expect(products!.pages[0].sections!.length).toBeGreaterThan(0);
  });

  it('always yields at least one category even on an empty graph', async () => {
    const digest = await buildWikiDigest(repo, ws, 'default', productProfile);
    const plan = fallbackPlan(digest);
    expect(plan.categories.length).toBeGreaterThan(0);
  });
});

describe('materializeWikiPlan', () => {
  const plan: WikiPlan = {
    categories: [
      {
        title: 'Products',
        pages: [
          {
            title: 'Pomegranate',
            anchor: { kind: 'product', scope_value: 'Pomegranate' },
            source_doc_ids: ['d1', 'd2'],
            sections: [{ heading: 'Definition' }, { heading: 'Goals' }],
            // two specs of the same product nest as CHILDREN, not top-level pages
            children: [
              { title: 'Wiki — spec', source_doc_ids: ['d1'], sections: [{ heading: 'Scope' }] },
              { title: 'Updates — spec', source_doc_ids: ['d2'], sections: [{ heading: 'Scope' }] },
            ],
          },
        ],
      },
    ],
  };

  it('writes categories, pages, and nested children with a single product page', async () => {
    const counts = await materializeWikiPlan(repo, ws, 'default', 'product', plan, 'sig1');
    expect(counts.categories).toBe(1);
    expect(counts.pages).toBe(3); // product + 2 spec children

    const pages = await repo.listWikiPages(ws, 'default');
    const cat = pages.find((p) => p.kind === 'category');
    expect(cat?.title).toBe('Products');

    const productPage = pages.find((p) => p.title === 'Pomegranate');
    expect(productPage?.parent_id).toBe(cat!.id);
    expect(productPage?.sections?.length).toBe(2);
    expect(productPage?.source_doc_ids).toEqual(['d1', 'd2']);

    const children = pages.filter((p) => p.parent_id === productPage!.id);
    expect(children.map((c) => c.title).sort()).toEqual(['Updates — spec', 'Wiki — spec']);
    // exactly one product page — specs did NOT become their own top-level pages
    expect(pages.filter((p) => p.parent_id === cat!.id).length).toBe(1);

    expect((await repo.getWiki(ws, 'default'))?.plan_signature).toBe('sig1');
  });

  it('replaces the previous tree on rebuild (archives the old pages)', async () => {
    await materializeWikiPlan(repo, ws, 'default', 'product', plan, 'sig1');
    const before = (await repo.listWikiPages(ws, 'default')).length;
    expect(before).toBe(4);
    // rebuild with a smaller plan
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Just one', pages: [{ title: 'Solo', sections: [] }] }],
    });
    const active = await repo.listWikiPages(ws, 'default');
    expect(active.length).toBe(2); // 1 category + 1 page
    // old rows archived, not deleted
    const all = await repo.listWikiPages(ws, 'default', { includeArchived: true });
    expect(all.length).toBe(6);
  });

  it('rebuilds with the IDENTICAL plan without an id collision (regression)', async () => {
    // The real-world rebuild: same workspace → same titles. Deterministic ids
    // would regenerate the archived rows' ids and hit the UNIQUE constraint
    // (wiki_pages.workspace_id, id) → 500 plan_failed. Per-build salt fixes it.
    await materializeWikiPlan(repo, ws, 'default', 'product', plan, 'sig1');
    await materializeWikiPlan(repo, ws, 'default', 'product', plan, 'sig1');
    // one active tree, previous one archived (no duplicate-id explosion)
    expect((await repo.listWikiPages(ws, 'default')).length).toBe(4);
    expect((await repo.listWikiPages(ws, 'default', { includeArchived: true })).length).toBe(8);
  });
});

describe('computePlanSignature', () => {
  it('changes when the document set changes but is stable otherwise', async () => {
    await addNode('n1', 'product', 'Pomegranate', { product: 'Pomegranate' });
    const sig1 = computePlanSignature(await buildWikiDigest(repo, ws, 'default', productProfile));
    const sig1b = computePlanSignature(await buildWikiDigest(repo, ws, 'default', productProfile));
    expect(sig1).toBe(sig1b);
    await addDoc('d9', 'new.md', 'prd_or_spec', 'new');
    const sig2 = computePlanSignature(await buildWikiDigest(repo, ws, 'default', productProfile));
    expect(sig2).not.toBe(sig1);
  });
});
