/**
 * Wiki REFRESH semantics (spec §11.4) — how a refresh differs from a rebuild.
 *
 * A rebuild (materializeWikiPlan) replaces the tree. A refresh runs over a wiki
 * people have already read and edited, so it must be additive: fold the new plan
 * in (reconcileWikiPlan), and never let a fill blank a page it can't resolve.
 * Both of those regressed as "the update button generates empty articles".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import { materializeWikiPlan, reconcileWikiPlan } from './plan.js';
import { fillPage } from './fill.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

/** The tree a first build produced: one category, one page anchored to nothing
 *  (what fallbackPlan emits, and what pre-fix plans left behind). */
async function buildInitial() {
  await materializeWikiPlan(repo, ws, 'default', 'product', {
    categories: [{ title: 'Products', pages: [{ title: 'Atlas', sections: [{ heading: 'Definition' }] }] }],
  }, 'sig-v1');
}

async function pageByTitle(title: string) {
  return (await repo.listWikiPages(ws, 'default')).find((p) => p.title === title)!;
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
  await buildInitial();
});

describe('fill never blanks a page it cannot resolve', () => {
  it('keeps existing blocks when the page resolves to no nodes', async () => {
    const page = await pageByTitle('Atlas');
    // The page already holds content — a reproduction, or the user's own prose.
    await repo.replaceWikiBlocks(ws, page.id, [
      { sort_order: 0, type: 'paragraph', content: { text: 'Atlas is our ingest product.' }, cited_node_ids: [], provenance: 'user', review_state: 'accepted' },
    ]);

    // Nothing in the canon resolves to it (no nodes at all).
    const r = await fillPage(repo, ws, 'default', page);

    expect(r.via).toBe('empty');
    const blocks = await repo.listWikiBlocks(ws, page.id);
    expect(blocks).toHaveLength(1);
    expect((blocks[0].content as { text: string }).text).toBe('Atlas is our ingest product.');
  });

  it('reports 0 blocks for a page that was empty and stays empty', async () => {
    const r = await fillPage(repo, ws, 'default', await pageByTitle('Atlas'));
    expect(r).toEqual({ blocks: 0, via: 'empty' });
  });
});

describe('reconcileWikiPlan (refresh) vs materializeWikiPlan (rebuild)', () => {
  it('re-homes an existing page onto its source documents without churning its id', async () => {
    const before = await pageByTitle('Atlas');
    expect(before.source_doc_ids).toEqual([]); // planned before the fix → no docs

    await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        { title: 'Products', pages: [{ title: 'Atlas', source_doc_ids: ['doc_1'], anchor: { kind: 'product', scope_value: 'Atlas' }, sections: [{ heading: 'Ignored' }] }] },
      ],
    }, 'sig-v2');

    const after = await pageByTitle('Atlas');
    expect(after.id).toBe(before.id); // same row → blocks and edits survive
    expect(after.source_doc_ids).toEqual(['doc_1']); // …now on the document path
    expect(after.anchor).toEqual({ kind: 'product', scope_value: 'Atlas' });
    expect((await repo.getWiki(ws, 'default'))!.plan_signature).toBe('sig-v2');
  });

  it("keeps a matched page's own sections rather than replanning them", async () => {
    await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Atlas', sections: [{ heading: 'Something else' }] }] }],
    }, 'sig-v2');
    expect((await pageByTitle('Atlas')).sections).toEqual([{ heading: 'Definition' }]);
  });

  it('adds a page for a newly-ingested document, appended after the existing ones', async () => {
    const r = await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        {
          title: 'Products',
          pages: [
            { title: 'Atlas', source_doc_ids: ['doc_1'] },
            { title: 'Beacon', source_doc_ids: ['doc_2'], sections: [{ heading: 'Definition' }] },
          ],
        },
      ],
    }, 'sig-v2');

    expect(r).toEqual({ added_categories: 0, added_pages: 1, rehomed_pages: 1 });
    const beacon = await pageByTitle('Beacon');
    expect(beacon.source_doc_ids).toEqual(['doc_2']);
    expect(beacon.sort_order).toBeGreaterThan((await pageByTitle('Atlas')).sort_order);
  });

  it('appends several new pages under one new category without colliding on order', async () => {
    await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        { title: 'Strategy', pages: [{ title: 'Goals' }, { title: 'Bets' }] },
      ],
    }, 'sig-v2');
    const orders = (await repo
      .listWikiPages(ws, 'default'))
      .filter((p) => p.title === 'Goals' || p.title === 'Bets')
      .map((p) => p.sort_order);
    expect(new Set(orders).size).toBe(2);
  });

  it('leaves a user-authored page absent from the plan alone (only a rebuild prunes)', async () => {
    await repo.insertWikiPage(ws, 'default', { kind: 'page', slug: 'my-notes', title: 'My notes', parent_id: null });

    await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Atlas' }] }],
    }, 'sig-v2');
    expect((await repo.listWikiPages(ws, 'default')).some((p) => p.title === 'My notes')).toBe(true);

    // A rebuild, by contrast, replaces the tree outright.
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Atlas' }] }],
    }, 'sig-v3');
    expect((await repo.listWikiPages(ws, 'default')).some((p) => p.title === 'My notes')).toBe(false);
  });

  it('matches on title within a category, so the same title under two categories stays two pages', async () => {
    await reconcileWikiPlan(repo, ws, 'default', 'product', {
      categories: [
        { title: 'Products', pages: [{ title: 'Atlas' }] },
        { title: 'Archive', pages: [{ title: 'Atlas' }] },
      ],
    }, 'sig-v2');
    expect((await repo.listWikiPages(ws, 'default')).filter((p) => p.title === 'Atlas')).toHaveLength(2);
  });
});
