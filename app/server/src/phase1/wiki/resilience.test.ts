import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import { planWikiStructure, materializeWikiPlan } from './plan.js';
import { fillPage } from './fill.js';
import { setStructuredLLM } from '../../lib/anthropic.js';
import { sealedNodeData } from '../../__test_utils__/sealed-fixtures.js';

// An LLM error must NEVER 500 the wiki. plan/fill degrade to a usable result
// instead of throwing (which the route surfaces as {"error":"plan_failed"}).

let db: Database.Database;
let repo: Repo;
let ws: string;
const ts = '2026-01-01T00:00:00Z';

// An override that always throws — stands in for an exhausted/invalid Anthropic
// key or a network failure on the structured call.
const throwingLLM = {
  name: 'throwing',
  async callStructured(): Promise<unknown> {
    throw new Error('402 insufficient credits');
  },
};

async function addNode(id: string, type: string, title: string, docId: string | null) {
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body`, status: 'active', created_at: ts, updated_at: ts, attrs: { product: 'P' } });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, document_id, visibility, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, 'team', ?, ?)`,
    )
    .run(id, ws, type, data, docId, ts, ts);
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
  setStructuredLLM(throwingLLM);
});
afterEach(() => setStructuredLLM(null));

describe('wiki resilience — LLM error never 500s', () => {
  it('planWikiStructure degrades to the deterministic plan when the LLM throws', async () => {
    await addNode('n1', 'product', 'P', null);
    const r = await planWikiStructure(repo, ws, 'default', productProfile);
    expect(r.via).toBe('fallback');
    expect(r.plan.categories.length).toBeGreaterThan(0);
  });

  it('fillPage degrades to the deterministic fill when the LLM throws', async () => {
    await addNode('n1', 'product', 'P', null);
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'P', anchor: { scope_value: 'P' }, sections: [{ heading: 'Definition' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'P')!;
    const r = await fillPage(repo, ws, 'default', page);
    expect(r.via).toBe('fallback');
    expect(r.blocks).toBeGreaterThan(0);
  });
});
