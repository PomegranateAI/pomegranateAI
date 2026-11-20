/**
 * Typed graph edges: write-time taxonomy enforcement + idempotent storage.
 *
 * Edge kinds live on the workspace profile (edge_kinds); the graph_edges
 * table enforces nothing beyond the (src, dst, kind) unique index. These
 * tests pin the contract: addEdge validates against the resolved profile
 * taxonomy (builtin fallback for pre-edge_kinds snapshots), re-adding is
 * idempotent and reactivates archived edges, and archiving a node archives
 * its edges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import { productProfile } from '../../lib/profiles/__fixtures__/product.js';
import { resolveEdgeKinds, validateEdge } from '../../lib/edges.js';
import { ContextProfile } from '../../lib/schemas.js';
import type { Node } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-06-04T00:00:00Z';

function node(id: string, type: string): Node {
  return {
    id,
    type,
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: `${type} ${id}`,
  } as Node;
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'Prod', owner_email: 'pm@example.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile);
  await repo.upsertNode(ws, node('goal-north', 'goal'));
  await repo.upsertNode(ws, node('goal-q3', 'goal'));
  await repo.upsertNode(ws, node('metric-activation', 'metric'));
  await repo.upsertNode(ws, node('seg-icp', 'segment'));
});

describe('addEdge: write-time taxonomy enforcement', () => {
  it('accepts an edge satisfying src/dst constraints', async () => {
    const r = await repo.addEdge(ws, {
      src: 'metric-activation',
      dst: 'goal-north',
      kind: 'supports',
      created_by: 'manual',
    });
    expect(r.existing).toBe(false);
    const edges = await repo.listEdges(ws);
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('supports');
    expect(edges[0].created_by).toBe('manual');
  });

  it('rejects an unknown edge kind', async () => {
    await expect(async () =>
      await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'blocks', created_by: 'manual' }),
    ).rejects.toThrow(/unknown edge kind/);
  });

  it('rejects a src kind outside the constraint', async () => {
    // segment is not a valid 'supports' source
    await expect(async () =>
      await repo.addEdge(ws, { src: 'seg-icp', dst: 'goal-north', kind: 'supports', created_by: 'manual' }),
    ).rejects.toThrow(/does not accept source kind 'segment'/);
  });

  it('rejects a dst kind outside the constraint', async () => {
    // supports must point at a goal
    await expect(async () =>
      await repo.addEdge(ws, { src: 'goal-q3', dst: 'seg-icp', kind: 'supports', created_by: 'manual' }),
    ).rejects.toThrow(/does not accept destination kind 'segment'/);
  });

  it('rejects edges to missing nodes', async () => {
    await expect(async () =>
      await repo.addEdge(ws, { src: 'goal-q3', dst: 'nope', kind: 'supports', created_by: 'manual' }),
    ).rejects.toThrow(/destination node not found/);
  });
});

describe('addEdge: idempotency + reactivation', () => {
  it('re-adding the same (src, dst, kind) returns the existing edge', async () => {
    const a = await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'llm' });
    const b = await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'llm' });
    expect(b.id).toBe(a.id);
    expect(b.existing).toBe(true);
    expect(await repo.listEdges(ws)).toHaveLength(1);
  });

  it('re-adding an archived edge reactivates it and keeps prior provenance unless overwritten', async () => {
    const a = await repo.addEdge(ws, {
      src: 'goal-q3',
      dst: 'goal-north',
      kind: 'supports',
      created_by: 'llm',
      quote: 'original quote',
      confidence: 0.6,
    });
    await repo.archiveEdge(ws, a.id);
    expect(await repo.listEdges(ws)).toHaveLength(0);

    const b = await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'llm', confidence: 0.9 });
    expect(b.id).toBe(a.id);
    const edge = await repo.getEdge(ws, a.id);
    expect(edge?.status).toBe('active');
    expect(edge?.quote).toBe('original quote'); // not clobbered by the provenance-less re-add
    expect(edge?.confidence).toBe(0.9); // refreshed where the new write carried it
  });
});

describe('listEdges filters + node archive cascade', () => {
  it('filters by node (either end), src, dst, kind', async () => {
    await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'manual' });
    await repo.addEdge(ws, { src: 'metric-activation', dst: 'goal-q3', kind: 'supports', created_by: 'manual' });
    expect(await repo.listEdges(ws, { node: 'goal-q3' })).toHaveLength(2);
    expect(await repo.listEdges(ws, { src: 'goal-q3' })).toHaveLength(1);
    expect(await repo.listEdges(ws, { dst: 'goal-q3' })).toHaveLength(1);
    expect(await repo.listEdges(ws, { kind: 'supports' })).toHaveLength(2);
    expect(await repo.listEdges(ws, { kind: 'about' })).toHaveLength(0);
  });

  it('archiving a node archives every active edge touching it', async () => {
    await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'manual' });
    await repo.addEdge(ws, { src: 'metric-activation', dst: 'goal-q3', kind: 'supports', created_by: 'manual' });
    await repo.archiveNode(ws, 'goal-q3');
    expect(await repo.listEdges(ws)).toHaveLength(0);
    expect(await repo.listEdges(ws, { includeArchived: true })).toHaveLength(2);
  });

  it('removeEdgesByOrigin hard-deletes only that batch', async () => {
    await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'deterministic' });
    await repo.addEdge(ws, { src: 'metric-activation', dst: 'goal-north', kind: 'supports', created_by: 'manual' });
    expect(await repo.removeEdgesByOrigin(ws, 'deterministic')).toBe(1);
    const left = await repo.listEdges(ws, { includeArchived: true });
    expect(left).toHaveLength(1);
    expect(left[0].created_by).toBe('manual');
  });
});

describe('cross-workspace isolation', () => {
  it('edges in workspace A are invisible to workspace B', async () => {
    await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'manual' });
    const b = (await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' })).id;
    expect(await repo.listEdges(b)).toHaveLength(0);
  });
});

describe('resolveEdgeKinds: builtin fallback for stale snapshots', () => {
  it('uses the profile snapshot when it carries edge_kinds', () => {
    expect(resolveEdgeKinds(productProfile).map((k) => k.key)).toContain('supports');
  });

  // The builtin-fallback path (BUILTIN_PROFILES[profile.id]) has no live case
  // to test against post-Light: `product` is no longer a registered builtin,
  // and the one that remains (`notes`) declares no edge taxonomy at all. See
  // 'a profile with no taxonomy anywhere rejects every edge' below for the
  // behavior this collapses into.

  it('a profile with no taxonomy anywhere rejects every edge', async () => {
    const bare = ContextProfile.parse({ ...productProfile, id: 'custom-x', edge_kinds: undefined });
    await repo.setWorkspaceProfile(ws, 'custom-x', bare);
    await expect(async () =>
      await repo.addEdge(ws, { src: 'goal-q3', dst: 'goal-north', kind: 'supports', created_by: 'manual' }),
    ).rejects.toThrow(/unknown edge kind/);
  });

  it('validateEdge honors the "any" opt-out', () => {
    const kinds = [
      { key: 'related', label: 'Related', description: '', src_kinds: 'any' as const, dst_kinds: 'any' as const, directed: true },
    ];
    expect(validateEdge(kinds, { kind: 'related', src_type: 'goal', dst_type: 'segment' }).ok).toBe(true);
  });
});
