/**
 * Per-(document, subgraph) routing records + per-subgraph source_type. The
 * source_type is captured for free from each subgraph's extraction pass and
 * overrides the shared documents.source_type for that subgraph's triage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
});

describe('document_routing source_type', () => {
  it('records routing per subgraph and resolves source_type per subgraph with shared fallback', async () => {
    // Shared document with a default-profile (shared) source_type.
    const doc = await repo.registerDocument(ws, {
      source_ref: 'strategy.md',
      source_kind: 'doc',
      sha256: 'abc',
      source_type: 'shared_default_type',
    });
    const sgB = (await repo.createSubgraph(ws, { slug: 'product', name: 'Product' })).id;

    await repo.routeDocument(ws, doc.id, 'default', { routed_by: 'pinned' });
    await repo.routeDocument(ws, doc.id, sgB, { routed_by: 'pinned' });

    // Before any per-subgraph classification: both fall back to the shared type.
    expect(await repo.getDocumentSourceType(ws, doc.id, 'default')).toBe('shared_default_type');
    expect(await repo.getDocumentSourceType(ws, doc.id, sgB)).toBe('shared_default_type');

    // Each subgraph's extraction pass classifies its own source_type.
    await repo.setDocumentRoutingSourceType(ws, doc.id, 'default', 'founding_type');
    await repo.setDocumentRoutingSourceType(ws, doc.id, sgB, 'prd_or_spec');

    expect(await repo.getDocumentSourceType(ws, doc.id, 'default')).toBe('founding_type');
    expect(await repo.getDocumentSourceType(ws, doc.id, sgB)).toBe('prd_or_spec');

    // listDocumentSubgraphs surfaces the per-subgraph source_type.
    const routing = await repo.listDocumentSubgraphs(ws, doc.id);
    const byId = Object.fromEntries(routing.map((r) => [r.subgraph_id, r]));
    expect(byId['default'].source_type).toBe('founding_type');
    expect(byId[sgB].source_type).toBe('prd_or_spec');
    expect(byId[sgB].routed_by).toBe('pinned');
  });

  it('falls back to the shared documents.source_type for a subgraph with no per-subgraph classification', async () => {
    const doc = await repo.registerDocument(ws, {
      source_ref: 'notes.md',
      source_kind: 'doc',
      sha256: 'def',
      source_type: 'customer_interview',
    });
    await repo.routeDocument(ws, doc.id, 'default', { routed_by: 'router' });
    // No setDocumentRoutingSourceType → shared fallback.
    expect(await repo.getDocumentSourceType(ws, doc.id, 'default')).toBe('customer_interview');
    // Unrouted/unknown subgraph also falls back to the shared type.
    expect(await repo.getDocumentSourceType(ws, doc.id, 'sg_missing')).toBe('customer_interview');
  });
});
