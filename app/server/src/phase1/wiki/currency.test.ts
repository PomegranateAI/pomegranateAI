import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import { materializeWikiPlan } from './plan.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

function addNode(id: string, updated_at: string, subgraph_id = 'default') {
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, created_at, updated_at)
       VALUES (?, ?, ?, 'product', 'active', ?, ?, ?)`,
    )
    .run(id, ws, subgraph_id, JSON.stringify({ id, type: 'product', title: id, body: 'b', status: 'active', created_at: updated_at, updated_at }), updated_at, updated_at);
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
  await materializeWikiPlan(repo, ws, 'default', 'product', {
    categories: [{ title: 'C', pages: [{ title: 'P', sections: [{ heading: 'S' }] }] }],
  });
});

describe('wiki currency (M4)', () => {
  it('latestGraphChangeAt reflects the newest node timestamp', async () => {
    addNode('n1', '2026-01-01T00:00:00Z');
    addNode('n2', '2026-03-01T00:00:00Z');
    expect(await repo.latestGraphChangeAt(ws, 'default')).toBe('2026-03-01T00:00:00Z');
  });

  it('is stale when a node changes after the watermark, and refresh clears it', async () => {
    addNode('n1', '2026-01-01T00:00:00Z');
    // Stamp the watermark at the current latest change (as a build/fill would).
    await repo.setWikiWatermark(ws, 'default', await repo.latestGraphChangeAt(ws, 'default'));
    expect((await repo.getWiki(ws, 'default'))!.status).toBe('built');

    // A later node change → latest > watermark → stale.
    addNode('n2', '2026-06-01T00:00:00Z');
    const wiki = (await repo.getWiki(ws, 'default'))!;
    expect(await repo.latestGraphChangeAt(ws, 'default') > (wiki.content_watermark ?? '')).toBe(true);

    // Re-stamp (a refresh) advances the watermark and clears stale.
    await repo.setWikiWatermark(ws, 'default', await repo.latestGraphChangeAt(ws, 'default'));
    const after = (await repo.getWiki(ws, 'default'))!;
    expect(after.status).toBe('built');
    expect(await repo.latestGraphChangeAt(ws, 'default') > (after.content_watermark ?? '')).toBe(false);
  });

  it('markWikisStale flips a built wiki to stale (event-driven signal)', async () => {
    await repo.setWikiWatermark(ws, 'default', '2026-01-01T00:00:00Z');
    expect((await repo.getWiki(ws, 'default'))!.status).toBe('built');
    await repo.markWikisStale(ws);
    expect((await repo.getWiki(ws, 'default'))!.status).toBe('stale');
  });

  describe('staleness is subfolder-specific', () => {
    beforeEach(async () => {
      // A second subfolder (subgraph) with its own wiki, alongside 'default'.
      await repo.setWorkspaceProfile(ws, 'product', productProfile, 'sg2');
      await materializeWikiPlan(repo, ws, 'sg2', 'product', {
        categories: [{ title: 'C2', pages: [{ title: 'P2', sections: [{ heading: 'S2' }] }] }],
      });
      await repo.setWikiWatermark(ws, 'default', '2026-01-01T00:00:00Z');
      await repo.setWikiWatermark(ws, 'sg2', '2026-01-01T00:00:00Z');
    });

    it('markWikisStale(ws, subgraph) flags only that subfolder', async () => {
      await repo.markWikisStale(ws, 'sg2');
      expect((await repo.getWiki(ws, 'sg2'))!.status).toBe('stale');
      expect((await repo.getWiki(ws, 'default'))!.status).toBe('built');
    });

    it("latestGraphChangeAt ignores another subfolder's node changes", async () => {
      addNode('n-sg2', '2026-06-01T00:00:00Z', 'sg2');
      // 'default' saw no change of its own, so it stays current…
      expect(await repo.latestGraphChangeAt(ws, 'default') > '2026-01-01T00:00:00Z').toBe(false);
      // …while sg2's own change makes it stale relative to its watermark.
      expect(await repo.latestGraphChangeAt(ws, 'sg2') > '2026-01-01T00:00:00Z').toBe(true);
    });

    it('subgraphIdsForNodes maps a node batch back to its subfolder(s)', async () => {
      addNode('a', '2026-02-01T00:00:00Z', 'default');
      addNode('b', '2026-02-01T00:00:00Z', 'sg2');
      expect((await repo.subgraphIdsForNodes(ws, ['a'])).sort()).toEqual(['default']);
      expect((await repo.subgraphIdsForNodes(ws, ['a', 'b'])).sort()).toEqual(['default', 'sg2']);
      expect(await repo.subgraphIdsForNodes(ws, [])).toEqual([]);
    });
  });
});
