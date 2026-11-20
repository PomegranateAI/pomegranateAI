import { describe, it, expect } from 'vitest';
import {
  scopeKindKeys,
  filterNodesToScope,
  northStarNodeIds,
  packGraph,
  buildScopedGraph,
  renderContextPack,
  buildContextPack,
  expandAlongEdges,
  PACK_THRESHOLD,
  PACK_TOP_K,
  type RepoLike,
} from './pack.js';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';
import { StubEmbedder, embeddingTextForNode, embeddingToBlob } from '../../lib/embeddings.js';
import type { Node } from '../../lib/schemas.js';

function goal(id: string, priority: 'north_star' | 'priority' | 'supporting', title = id): Node {
  return {
    id,
    type: 'goal',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    title,
    body: `${title} body text`,
    priority,
  } as Node;
}

function decision(id: string, summary = id): Node {
  return {
    id,
    type: 'decision',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    summary,
    body: `${summary} body`,
    decided_on: '2026-01-01',
    category: 'scope',
  } as Node;
}

function positioning(id: string, kind = 'stance', body = id): Node {
  return {
    id,
    type: 'positioning',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    body,
    kind,
  } as Node;
}

describe('scopeKindKeys', () => {
  it('resolves a founding scope to its kind keys', () => {
    expect(scopeKindKeys(foundingProfile, 'decisions')).toEqual(['decision']);
    expect(scopeKindKeys(foundingProfile, 'goals')).toEqual(['goal']);
  });
  it('returns "all" for the all scope and for unknown scopes', () => {
    expect(scopeKindKeys(foundingProfile, 'all')).toBe('all');
    expect(scopeKindKeys(foundingProfile, 'nonsense')).toBe('all');
  });
});

describe('filterNodesToScope', () => {
  const nodes = [goal('g1', 'priority'), decision('d1'), positioning('p1')];
  it('filters to the scope kind keys', () => {
    expect(filterNodesToScope(nodes, foundingProfile, 'decisions').map((n) => n.id)).toEqual(['d1']);
    expect(filterNodesToScope(nodes, foundingProfile, 'goals').map((n) => n.id)).toEqual(['g1']);
  });
  it('passes through on the all scope', () => {
    expect(filterNodesToScope(nodes, foundingProfile, 'all')).toHaveLength(3);
  });
});

describe('northStarNodeIds', () => {
  it('identifies goal nodes in the north_star bucket', () => {
    const nodes = [goal('ns', 'north_star'), goal('p', 'priority'), decision('d1')];
    const ids = northStarNodeIds(nodes, foundingProfile);
    expect([...ids]).toEqual(['ns']);
  });
});

describe('packGraph', () => {
  const embedder = new StubEmbedder();

  it('returns the full graph unchanged below the threshold', async () => {
    const nodes = [goal('g1', 'priority'), decision('d1')];
    const r = nodes.map((node) => ({ node, embedding: null }));
    const res = await packGraph({
      rows: r,
      question: 'anything',
      embedder,
      alwaysInclude: new Set(),
    });
    expect(res.packed).toBe(false);
    expect(res.nodes).toHaveLength(2);
  });

  it('packs to topK + always-include above the threshold', async () => {
    const nodes: Node[] = [];
    for (let i = 0; i < PACK_THRESHOLD + 40; i++) nodes.push(decision(`d${i}`, `decision number ${i}`));
    // Mark one node well outside the top-K as always-include.
    const alwaysId = `d${PACK_THRESHOLD + 39}`;
    // Embed for real so cosine ranking is meaningful.
    const texts = nodes.map((n) => embeddingTextForNode(n as any));
    const vecs = await embedder.embed(texts);
    const r = nodes.map((node, i) => ({ node, embedding: embeddingToBlob(vecs[i]!) }));
    const res = await packGraph({
      rows: r,
      question: 'decision number 5',
      embedder,
      alwaysInclude: new Set([alwaysId]),
    });
    expect(res.packed).toBe(true);
    // topK ranked + the 1 always-include (which is not in the top-K).
    expect(res.nodes.length).toBeLessThanOrEqual(PACK_TOP_K + 1);
    expect(res.nodes.map((n) => n.id)).toContain(alwaysId);
    expect(res.stats.always_included).toBe(1);
  });
});

describe('renderContextPack', () => {
  it('renders a citation-ready markdown with id + tags per node', () => {
    const nodes = [decision('dec-1', 'kill the v1 mobile app'), positioning('pos-1', 'banned_phrase', 'synergy')];
    const pack = renderContextPack({ profile: foundingProfile, scope: 'all', nodes, packed: false });
    expect(pack.node_count).toBe(2);
    expect(pack.markdown).toContain('Founding team vault');
    expect(pack.markdown).toContain('`dec-1`');
    expect(pack.markdown).toContain('`pos-1`');
    expect(pack.markdown).toContain('banned_phrase');
    expect(pack.truncated).toBe(false);
  });

  it('renders an empty-state when no nodes', () => {
    const pack = renderContextPack({ profile: foundingProfile, scope: 'goals', nodes: [], packed: false });
    expect(pack.node_count).toBe(0);
    expect(pack.markdown).toContain('No vault nodes');
  });

  it('truncates to a token budget, keeping the leading nodes', () => {
    const nodes = [
      decision('dec-1', 'first decision with a reasonably long body to consume budget'),
      decision('dec-2', 'second decision also with a long body to push past the cap'),
      decision('dec-3', 'third decision'),
    ];
    const pack = renderContextPack({
      profile: foundingProfile,
      scope: 'decisions',
      nodes,
      packed: false,
      budget_tokens: 40, // ~160 chars — only the header + first block fits
    });
    expect(pack.truncated).toBe(true);
    expect(pack.node_count).toBeGreaterThanOrEqual(1);
    expect(pack.node_count).toBeLessThan(3);
    expect(pack.nodes[0]!.id).toBe('dec-1');
  });
});

describe('expandAlongEdges (generic edge-following)', () => {
  const uni = (ids: string[]) => ids.map((id) => ({ node: decision(id) }));

  it('re-admits an in-scope neighbor linked to a selected node (either direction)', () => {
    const universe = uni(['a', 'b', 'c', 'd']);
    const selected = [decision('a')];
    const r = expandAlongEdges({
      selected,
      universe,
      edges: [{ src: 'a', dst: 'b' }, { src: 'c', dst: 'a' }],
      cap: 10,
    });
    expect(r.added).toBe(2);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('never crosses the scope/visibility boundary — a neighbor outside the universe is skipped', () => {
    // 'x' is linked to the selected node but is NOT in the scoped universe.
    const r = expandAlongEdges({
      selected: [decision('a')],
      universe: uni(['a', 'b']),
      edges: [{ src: 'a', dst: 'x' }],
      cap: 10,
    });
    expect(r.added).toBe(0);
    expect(r.nodes.map((n) => n.id)).toEqual(['a']);
  });

  it('honors the cap and does not duplicate already-selected nodes', () => {
    const r = expandAlongEdges({
      selected: [decision('a'), decision('b')],
      universe: uni(['a', 'b', 'c', 'd', 'e']),
      edges: [{ src: 'a', dst: 'b' }, { src: 'a', dst: 'c' }, { src: 'b', dst: 'd' }, { src: 'b', dst: 'e' }],
      cap: 1,
    });
    expect(r.added).toBe(1); // capped
    // 'b' is already selected — the a→b edge must not re-add it.
    expect(r.nodes.filter((n) => n.id === 'b')).toHaveLength(1);
  });
});

describe('edge-following through buildScopedGraph', () => {
  const embedder = new StubEmbedder();

  // A repo whose nodes carry real embeddings (so ranking is meaningful) and
  // that exposes a fixed edge list.
  function repoWithEdges(nodes: Node[], edges: Array<{ src: string; dst: string }>, blobs: Map<string, Buffer>): RepoLike {
    return {
      listNodesWithEmbeddings: async () => nodes.map((node) => ({ node, embedding: blobs.get(node.id) ?? null })),
      redFlaggedNodeIds: async () => new Set<string>(),
      listEdges: async () => edges,
    };
  }

  it('pulls a rank-dropped node back in when an edge links it to a survivor', async () => {
    const nodes: Node[] = [];
    for (let i = 0; i < PACK_THRESHOLD + 40; i++) nodes.push(decision(`d${i}`, `decision number ${i}`));
    const texts = nodes.map((n) => embeddingTextForNode(n as any));
    const vecs = await embedder.embed(texts);
    const blobs = new Map(nodes.map((n, i) => [n.id, embeddingToBlob(vecs[i]!)]));
    const question = 'decision number 5';

    // First, learn which nodes survive packing with NO edges.
    const baseline = await buildScopedGraph({
      repo: repoWithEdges(nodes, [], blobs),
      workspace_id: 'ws', profile: foundingProfile, scope: 'decisions', question, embedder,
    });
    expect(baseline.packed).toBe(true);
    const survivorIds = new Set(baseline.nodes.map((n) => n.id));
    const survivor = baseline.nodes[0]!.id;
    const dropped = nodes.map((n) => n.id).find((id) => !survivorIds.has(id))!;
    expect(dropped).toBeDefined();

    // Now link a dropped node to a survivor and re-retrieve.
    const grown = await buildScopedGraph({
      repo: repoWithEdges(nodes, [{ src: survivor, dst: dropped }], blobs),
      workspace_id: 'ws', profile: foundingProfile, scope: 'decisions', question, embedder,
    });
    expect(grown.nodes.map((n) => n.id)).toContain(dropped);
    expect(grown.stats.edge_expanded).toBeGreaterThanOrEqual(1);
  });
});

describe('buildScopedGraph + buildContextPack (with a fake repo)', () => {
  const embedder = new StubEmbedder();
  function fakeRepo(nodes: Node[], red: string[] = []): RepoLike {
    return {
      listNodesWithEmbeddings: async () => nodes.map((node) => ({ node, embedding: null })),
      redFlaggedNodeIds: async () => new Set(red),
    };
  }

  it('scopes the graph and packs below threshold (full set)', async () => {
    const repo = fakeRepo([goal('g1', 'north_star'), decision('d1'), positioning('p1')]);
    const res = await buildScopedGraph({
      repo,
      workspace_id: 'ws',
      profile: foundingProfile,
      scope: 'decisions',
      question: 'q',
      embedder,
    });
    expect(res.packed).toBe(false);
    expect(res.nodes.map((n) => n.id)).toEqual(['d1']);
  });

  it('buildContextPack returns a scoped rendered pack', async () => {
    const repo = fakeRepo([goal('g1', 'north_star'), decision('d1')]);
    const pack = await buildContextPack({
      repo,
      workspace_id: 'ws',
      profile: foundingProfile,
      scope: 'goals',
      question: 'goals',
      embedder,
    });
    expect(pack.scope).toBe('goals');
    expect(pack.nodes.map((n) => n.id)).toEqual(['g1']);
    expect(pack.markdown).toContain('`g1`');
  });
});
