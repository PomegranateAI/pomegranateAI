/**
 * Retrieval improvements (spec B6).
 *
 * Three pieces, all pure(-ish) functions over a workspace's active graph:
 *
 *   1. Scoped retrieval — filter the graph to a query scope's `kind_keys`
 *      before synthesis. `'all'` (or an unknown scope) is a no-op pass-through.
 *
 *   2. Embedding-ranked context packing — when the active graph exceeds
 *      `PACK_THRESHOLD` (120) nodes, rank by cosine(question embedding, node
 *      embedding) and keep the top `PACK_TOP_K` (60) PLUS every red-flagged
 *      node and every north-star-bucket node (always-include set), so the most
 *      load-bearing canon is never dropped by rank alone. Below the threshold
 *      the graph is returned unchanged — this keeps the Phase-1 eval gates
 *      valid (they were measured on full-graph synthesis).
 *
 *   3. Context-pack rendering — a scoped, ranked, citation-ready slice of the
 *      canon rendered to markdown for the `/context-pack` endpoint and the
 *      `get_context` MCP tool.
 *
 * The embedding infra is reused verbatim from the dedup pipeline
 * (`lib/embeddings.ts`): the same `Embedder`, the same `embeddingTextForNode`
 * projection, the same cosine.
 */
import type { ContextProfile, GraphEdge, Node } from '../../lib/schemas.js';
import type { Embedder } from '../../lib/embeddings.js';
import {
  blobToEmbedding,
  cosineSimilarity,
  embeddingTextForNode,
} from '../../lib/embeddings.js';

/** Above this many active nodes we rank-and-pack; at or below we send the full graph. */
export const PACK_THRESHOLD = 120;
/** How many top-ranked nodes to keep when packing. */
export const PACK_TOP_K = 60;
/**
 * When packing drops nodes by rank, one-hop edge expansion pulls back the
 * in-scope nodes DIRECTLY related to what survived (see `expandAlongEdges`).
 * This caps how many such neighbors we re-admit, so a densely-linked hub can't
 * blow the synthesis budget. Profile-agnostic — it is a property of retrieval,
 * not of any one profile's edge kinds.
 */
export const EDGE_EXPAND_CAP = 60;
/** Rough chars-per-token estimate for the budget_tokens guard. */
const CHARS_PER_TOKEN = 4;

type NodeWithEmbedding = { node: Node; embedding: Buffer | null };

/**
 * Resolve a scope key to the set of kind keys it admits, or `'all'`.
 * Unknown scopes fall back to `'all'` (caller validates the scope separately;
 * this is defensive so an out-of-profile scope never silently drops the graph).
 */
export function scopeKindKeys(
  profile: ContextProfile,
  scope: string,
): string[] | 'all' {
  const def = profile.query_scopes.find((s) => s.key === scope);
  if (!def) return 'all';
  return def.kind_keys;
}

/** Filter a graph to a scope's kind keys. `'all'` is a pass-through. */
export function filterGraphToScope<T extends { node: Node }>(
  rows: readonly T[],
  profile: ContextProfile,
  scope: string,
): T[] {
  const keys = scopeKindKeys(profile, scope);
  if (keys === 'all') return [...rows];
  const allow = new Set(keys);
  return rows.filter((r) => allow.has(r.node.type));
}

/** Filter a plain node list to a scope (convenience for callers that hold bare nodes). */
export function filterNodesToScope(
  nodes: readonly Node[],
  profile: ContextProfile,
  scope: string,
): Node[] {
  const keys = scopeKindKeys(profile, scope);
  if (keys === 'all') return [...nodes];
  const allow = new Set(keys);
  return nodes.filter((n) => allow.has(n.type));
}

/**
 * The set of node ids that fall into a `north_star` bucket per the profile.
 * A kind's bucket with key `north_star` names the attr/field (`match`) whose
 * value `north_star` places a node in that bucket — for founding this is
 * `goal.priority === 'north_star'`. Profile-agnostic: any kind that declares a
 * `north_star` bucket participates.
 */
export function northStarNodeIds(
  nodes: readonly Node[],
  profile: ContextProfile,
): Set<string> {
  // matchField keyed by kind: the field whose value === 'north_star' qualifies.
  const matchByKind = new Map<string, string>();
  for (const k of profile.kinds) {
    const ns = k.buckets?.find((b) => b.key === 'north_star');
    if (ns) matchByKind.set(k.key, ns.match);
  }
  const out = new Set<string>();
  if (matchByKind.size === 0) return out;
  for (const n of nodes) {
    const field = matchByKind.get(n.type);
    if (!field) continue;
    const v = readField(n, field);
    if (v === 'north_star') out.add(n.id);
  }
  return out;
}

/** Read a bucket `match` field off a node (top-level legacy field or attrs.*). */
function readField(node: Node, field: string): unknown {
  const n = node as unknown as Record<string, unknown>;
  if (n[field] !== undefined) return n[field];
  const attrs = n.attrs as Record<string, unknown> | undefined;
  return attrs?.[field];
}

export interface PackResult {
  /** The nodes selected for synthesis, in rank order (always-include first). */
  nodes: Node[];
  /** True when the graph exceeded the threshold and was rank-packed. */
  packed: boolean;
  /** Diagnostics for logging. */
  stats: {
    graph_size: number;
    threshold: number;
    top_k: number;
    always_included: number;
    ranked_included: number;
    /** In-scope neighbors re-admitted by one-hop edge expansion (0 when none). */
    edge_expanded?: number;
  };
}

/**
 * One-hop edge expansion — the generic, profile-agnostic half of edge-following
 * retrieval. Given the packed node set and the scoped universe it was drawn
 * from, re-admit every in-scope node DIRECTLY connected by an active edge to
 * something already selected, up to `cap`.
 *
 * Why this exists: ranking keeps the nodes most similar to the QUESTION, but a
 * node's related updates/context often rank just below the cut and get dropped —
 * so an answer about a thing arrives without the news attached to it. Following
 * edges pulls that back. It is deliberately:
 *   - **generic** — every edge kind participates; nothing here knows about any
 *     particular profile, kind, or topic. The profile decides what edges exist;
 *     retrieval just follows them.
 *   - **scope-respecting** — neighbors are taken from `universe` (already
 *     scope- and visibility-filtered), so expansion never leaks a kind the
 *     query scope excluded, and never crosses the sharing boundary.
 *   - **one hop, capped, order-stable** — bounded work, deterministic output.
 *
 * Callers only invoke it when packing actually dropped nodes; below the pack
 * threshold every scoped node is already present and this would be a no-op.
 */
export function expandAlongEdges(opts: {
  selected: readonly Node[];
  universe: ReadonlyArray<{ node: Node }>;
  edges: ReadonlyArray<{ src: string; dst: string }>;
  cap: number;
}): { nodes: Node[]; added: number } {
  const byId = new Map(opts.universe.map((r) => [r.node.id, r.node]));
  const selected = new Set(opts.selected.map((n) => n.id));
  const addedIds: string[] = [];
  const addedSet = new Set<string>();
  const consider = (id: string) => {
    if (addedIds.length >= opts.cap) return;
    if (selected.has(id) || addedSet.has(id)) return;
    // Only re-admit nodes that are IN the scoped, visibility-filtered universe.
    // An edge pointing out of scope (or at a node the viewer can't see) is
    // skipped — expansion widens recall within the scope, never past it.
    if (!byId.has(id)) return;
    addedSet.add(id);
    addedIds.push(id);
  };
  for (const e of opts.edges) {
    if (addedIds.length >= opts.cap) break;
    if (selected.has(e.src)) consider(e.dst);
    if (selected.has(e.dst)) consider(e.src);
  }
  return {
    nodes: [...opts.selected, ...addedIds.map((id) => byId.get(id)!)],
    added: addedIds.length,
  };
}

/**
 * Embedding-ranked context packing (spec B6.2).
 *
 * `rows` is the scoped active graph with each node's stored embedding (as a
 * Buffer; null when not yet computed). When `rows.length <= PACK_THRESHOLD`
 * the full set is returned unchanged (`packed: false`). Otherwise we embed the
 * question once, rank by cosine, and keep `PACK_TOP_K` plus the always-include
 * set (red-flagged + north-star). Nodes with no stored embedding still rank
 * (cosine against a zero vector is 0) so they can only enter via the
 * always-include set — which is the desired behaviour (un-embedded nodes are
 * stragglers awaiting backfill, not the most relevant canon).
 */
export async function packGraph(opts: {
  rows: readonly NodeWithEmbedding[];
  question: string;
  embedder: Embedder;
  alwaysInclude: ReadonlySet<string>;
  topK?: number;
  threshold?: number;
}): Promise<PackResult> {
  const threshold = opts.threshold ?? PACK_THRESHOLD;
  const topK = opts.topK ?? PACK_TOP_K;
  const graph_size = opts.rows.length;

  if (graph_size <= threshold) {
    return {
      nodes: opts.rows.map((r) => r.node),
      packed: false,
      stats: {
        graph_size,
        threshold,
        top_k: topK,
        always_included: 0,
        ranked_included: graph_size,
      },
    };
  }

  // Embed the question once. Failure bubbles to the caller, which should fall
  // back to the unpacked graph (parity with the dedup pipeline's posture).
  const [qVec] = await opts.embedder.embed([opts.question]);
  const scored = opts.rows.map((r) => {
    const vec = blobToEmbedding(r.embedding);
    const score = qVec && vec ? cosineSimilarity(qVec, vec) : 0;
    return { node: r.node, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const chosen = new Map<string, Node>();
  // Always-include first so they keep their place even if topK fills up.
  for (const { node } of scored) {
    if (opts.alwaysInclude.has(node.id)) chosen.set(node.id, node);
  }
  const always_included = chosen.size;
  // Then the top-K by rank.
  let ranked_included = 0;
  for (const { node } of scored) {
    if (ranked_included >= topK) break;
    if (!chosen.has(node.id)) {
      chosen.set(node.id, node);
      ranked_included++;
    } else {
      // already in via always-include; still counts toward neither bucket here
    }
  }

  return {
    nodes: [...chosen.values()],
    packed: true,
    stats: {
      graph_size,
      threshold,
      top_k: topK,
      always_included,
      ranked_included,
    },
  };
}

export interface RepoLike {
  listNodesWithEmbeddings(
    workspace_id: string,
    opts?: { activeOnly?: boolean; viewer?: string; teamOnly?: boolean; aiRead?: boolean },
    subgraph_id?: string,
  ): Promise<Array<{ node: Node; embedding: Buffer | null }>>;
  evidenceCounts?(
    workspace_id: string,
    subgraph_id?: string,
  ): Promise<Map<string, { sources: number; latest: string }>>;
  redFlaggedNodeIds(workspace_id: string, subgraph_id?: string): Promise<Set<string>>;
  listEdges(
    workspace_id: string,
    opts?: { node?: string; src?: string; dst?: string; kind?: string; includeArchived?: boolean },
    subgraph_id?: string,
  ): Promise<GraphEdge[]>;
}

/**
 * Edges for a packed retrieval: every edge in the folder whose BOTH ends
 * are nodes actually present in `graph`, across every contributing subgraph.
 * Packing ranks a subfolder down to a subset when it exceeds `PACK_THRESHOLD`
 * — an edge to a node the model was never shown would be a dangling reference,
 * so it's filtered out rather than passed through. Below threshold `graph` IS
 * the whole subfolder, so this is every edge in it (spec-pomegranate-light.md
 * §4: "retrieval loads every node and every edge").
 *
 * Shared by the web `/query` route, the MCP `query_context` tool, and Review —
 * every synthesis call that reads a packed/scoped graph needs the same
 * currency signal, not a copy each grew independently.
 */
export async function edgesForPackedGraph(
  repo: RepoLike,
  workspace_id: string,
  subgraphIds: readonly string[],
  graph: ReadonlyArray<{ id: string }>,
): Promise<GraphEdge[]> {
  const nodeIds = new Set(graph.map((n) => n.id));
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const sg of subgraphIds) {
    for (const e of await repo.listEdges(workspace_id, {}, sg)) {
      if (!nodeIds.has(e.src) || !nodeIds.has(e.dst)) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/**
 * The shared retrieval path used by query (web + MCP) and the context-pack
 * endpoint: scope-filter the active graph, then embedding-rank-pack it when it
 * exceeds the threshold. Returns the node set for synthesis plus stats.
 *
 * `embedder` is only consulted when packing actually fires (graph over
 * threshold), so the common small-graph path never touches the embedding API.
 */
export async function buildScopedGraph(opts: {
  repo: RepoLike;
  workspace_id: string;
  profile: ContextProfile;
  scope: string;
  question: string;
  embedder: Embedder;
  topK?: number;
  threshold?: number;
  /** Which subgraph to read (default 'default' — omit for single-subgraph parity). */
  subgraph_id?: string;
  /** Viewer user_id for sharing enforcement; omit to read the whole graph. */
  viewer?: string;
  /**
   * false surfaces every node regardless of status — an archived (superseded)
   * node stays in the graph rather than disappearing, so a caller can ask for
   * the history alongside what's current. Default true: only the current
   * statement on each topic, matching every retrieval path before this option
   * existed (query_context, review_deliverable, the callers below that omit
   * it) — the newest statement wins and a superseded node never surfaces.
   */
  activeOnly?: boolean;
}): Promise<PackResult> {
  const sg = opts.subgraph_id;
  // Context packs always feed an LLM, so this is an aiRead: 'only_me' nodes are
  // excluded even for their owner (spec-unified-sharing-and-always-sync.md §3).
  const rowsRaw = await opts.repo.listNodesWithEmbeddings(
    opts.workspace_id,
    { activeOnly: opts.activeOnly ?? true, viewer: opts.viewer, aiRead: true },
    sg,
  );
  // Evidence annotation: multi-source nodes carry their corroboration count
  // into every synthesis prompt downstream of this retrieval.
  const evCounts = await opts.repo.evidenceCounts?.(opts.workspace_id, sg) ?? new Map<string, { sources: number; latest: string }>();
  const rows = rowsRaw.map((r) => {
    const ev = evCounts.get(r.node.id);
    return ev && ev.sources > 1
      ? { ...r, node: { ...(r.node as object), evidence: { sources: ev.sources, latest: ev.latest } } as unknown as Node }
      : r;
  });
  const scoped = filterGraphToScope(rows, opts.profile, opts.scope);
  const red = await opts.repo.redFlaggedNodeIds(opts.workspace_id, sg);
  const ns = northStarNodeIds(scoped.map((r) => r.node), opts.profile);
  const alwaysInclude = new Set<string>([...red, ...ns]);
  const pack = await packGraph({
    rows: scoped,
    question: opts.question,
    embedder: opts.embedder,
    alwaysInclude,
    topK: opts.topK,
    threshold: opts.threshold,
  });
  // Edge-following retrieval (generic — see `expandAlongEdges`). Only meaningful
  // when packing dropped nodes by rank; below the threshold every scoped node is
  // already present, so we skip the edge read entirely and behavior is
  // byte-identical to before (which keeps the full-graph eval gates valid).
  if (!pack.packed || !opts.repo.listEdges) return pack;
  const edges = await opts.repo.listEdges(opts.workspace_id, undefined, sg);
  if (edges.length === 0) return pack;
  const grown = expandAlongEdges({ selected: pack.nodes, universe: scoped, edges, cap: EDGE_EXPAND_CAP });
  return grown.added === 0
    ? pack
    : { ...pack, nodes: grown.nodes, stats: { ...pack.stats, edge_expanded: grown.added } };
}

/**
 * Multi-subgraph retrieval (Phase 4): query every relevant subgraph SEPARATELY
 * against ITS OWN profile, then merge. Each subgraph resolves `scope` against
 * its own `query_scopes` via `scopeKindKeys` — an absent scope key already
 * falls back to 'all' there, so a scope that doesn't exist in one subgraph
 * silently widens to its whole graph rather than dropping it.
 *
 * Every returned node is tagged with its `subgraph_id` for citation provenance.
 * Node ids are globally unique across subgraphs, so the concatenation needs no
 * de-dup. The caller does ONE synthesis pass over the merged set.
 */
export async function buildScopedGraphMulti(opts: {
  repo: RepoLike;
  workspace_id: string;
  subgraphs: Array<{ subgraph_id: string; profile: ContextProfile }>;
  scope: string;
  question: string;
  embedder: Embedder;
  topK?: number;
  threshold?: number;
  /** Viewer user_id for sharing enforcement; omit to read the whole graph. */
  viewer?: string;
}): Promise<{
  nodes: Node[];
  perSubgraph: Array<{ subgraph_id: string; profile_id: string; stats: PackResult['stats'] }>;
}> {
  const nodes: Node[] = [];
  const perSubgraph: Array<{ subgraph_id: string; profile_id: string; stats: PackResult['stats'] }> = [];
  for (const entry of opts.subgraphs) {
    const pack = await buildScopedGraph({
      repo: opts.repo,
      workspace_id: opts.workspace_id,
      profile: entry.profile,
      scope: opts.scope,
      question: opts.question,
      embedder: opts.embedder,
      topK: opts.topK,
      threshold: opts.threshold,
      subgraph_id: entry.subgraph_id,
      viewer: opts.viewer,
    });
    for (const node of pack.nodes) {
      // Tag a copy with provenance — node ids are globally unique, no de-dup.
      nodes.push({ ...(node as object), subgraph_id: entry.subgraph_id } as unknown as Node);
    }
    perSubgraph.push({
      subgraph_id: entry.subgraph_id,
      profile_id: entry.profile.id,
      stats: pack.stats,
    });
  }
  return { nodes, perSubgraph };
}

// ─── Context-pack rendering ────────────────────────────────────────────

export interface RenderedNode {
  id: string;
  kind: string;
  subkind?: string;
  category?: string;
  title?: string;
  body: string;
  created_at: string;
  status: 'active' | 'archived';
  /** Set on an archived node once something superseded it — the successor's id. */
  superseded?: string;
}

export interface ContextPack {
  scope: string;
  profile_id: string;
  node_count: number;
  packed: boolean;
  budget_tokens?: number;
  truncated: boolean;
  nodes: RenderedNode[];
  markdown: string;
}

/**
 * End-to-end context pack for the `/context-pack` endpoint and the
 * `get_context` MCP tool: scope-filter + embedding-rank-pack the active graph,
 * then render to a citation-ready markdown slice under an optional token
 * budget. Shared so the HTTP and MCP surfaces produce identical packs.
 *
 * `question` seeds the cosine ranking when packing fires; for the canon-dump
 * use-case (no natural-language question) callers pass the scope label, which
 * still ranks meaningfully and is harmless below the pack threshold.
 */
export async function buildContextPack(opts: {
  repo: RepoLike;
  workspace_id: string;
  profile: ContextProfile;
  scope: string;
  question: string;
  embedder: Embedder;
  budget_tokens?: number;
  /** Which subgraph to read (default 'default' — omit for single-subgraph parity). */
  subgraph_id?: string;
  /** Viewer user_id for sharing enforcement; omit to read the whole graph. */
  viewer?: string;
  /** See `buildScopedGraph`'s `activeOnly` — default true (superseded nodes excluded). */
  activeOnly?: boolean;
}): Promise<ContextPack> {
  const pack = await buildScopedGraph({
    repo: opts.repo,
    workspace_id: opts.workspace_id,
    profile: opts.profile,
    scope: opts.scope,
    question: opts.question,
    embedder: opts.embedder,
    subgraph_id: opts.subgraph_id,
    viewer: opts.viewer,
    activeOnly: opts.activeOnly,
  });
  return renderContextPack({
    profile: opts.profile,
    scope: opts.scope,
    nodes: pack.nodes,
    packed: pack.packed,
    budget_tokens: opts.budget_tokens,
  });
}

/** Project a node to the citation-ready shape the pack exposes. */
function projectNode(node: Node): RenderedNode {
  const n = node as unknown as Record<string, unknown>;
  const subkind = (n.subkind as string | undefined) ?? (n.kind as string | undefined);
  const category = n.category as string | undefined;
  const title =
    (n.title as string | undefined) ?? (n.summary as string | undefined) ?? undefined;
  return {
    id: node.id,
    kind: node.type,
    subkind: subkind || undefined,
    category: category || undefined,
    title: title || undefined,
    body: (n.body as string | undefined) ?? '',
    created_at: node.created_at,
    status: node.status,
    superseded: (n.superseded as string | undefined) || undefined,
  };
}

/** A single node's markdown block — id and tags are mono-styled in the UI. */
function renderNodeMarkdown(n: RenderedNode): string {
  const tags = [n.kind, n.subkind, n.category].filter(Boolean).join(' · ');
  const head = `### ${n.title ?? n.id}`;
  // The status/lineage line only appears on an archived node — the common
  // (active) case renders exactly as before this field existed.
  const status =
    n.status === 'archived' ? ` — SUPERSEDED${n.superseded ? ` by \`${n.superseded}\`` : ''}` : '';
  const meta = `\`${n.id}\` — ${tags}${status}`;
  return `${head}\n${meta}\n\n${n.body}`.trim();
}

/**
 * Render a scoped, ranked node set to a citation-ready context pack. The
 * markdown leads with a heading naming the profile + scope, then one block per
 * node (heading + mono id/tags line + body) so an IC's AI tool can cite by id.
 *
 * `budget_tokens` is a soft cap on the markdown body: nodes are emitted in the
 * given order until the running char estimate (≈ budget_tokens * 4) would be
 * exceeded; the remainder is dropped and `truncated` is set. The always-include
 * + top-ranked ordering from `packGraph` means the most load-bearing canon
 * survives truncation.
 */
export function renderContextPack(opts: {
  profile: ContextProfile;
  scope: string;
  nodes: readonly Node[];
  packed: boolean;
  budget_tokens?: number;
}): ContextPack {
  const projected = opts.nodes.map(projectNode);
  const scopeDef = opts.profile.query_scopes.find((s) => s.key === opts.scope);
  const scopeLabel = scopeDef?.label ?? opts.scope;

  const header = `# ${opts.profile.name} vault — ${scopeLabel}\n\n${opts.profile.description}`;
  const budgetChars = opts.budget_tokens
    ? Math.max(0, opts.budget_tokens * CHARS_PER_TOKEN - header.length)
    : Infinity;

  const blocks: string[] = [];
  const kept: RenderedNode[] = [];
  let used = 0;
  let truncated = false;
  for (const p of projected) {
    const block = renderNodeMarkdown(p);
    const cost = block.length + 2; // +2 for the joining blank line
    if (used + cost > budgetChars && kept.length > 0) {
      truncated = true;
      break;
    }
    blocks.push(block);
    kept.push(p);
    used += cost;
  }

  const markdown =
    kept.length === 0
      ? `${header}\n\n_No vault nodes in this scope yet._`
      : [header, ...blocks].join('\n\n');

  return {
    scope: opts.scope,
    profile_id: opts.profile.id,
    node_count: kept.length,
    packed: opts.packed,
    budget_tokens: opts.budget_tokens,
    truncated,
    nodes: kept,
    markdown,
  };
}

// ─── Direct selection: by id / date range, sorted, capped ─────────────────
//
// The relevance-ranked pack above answers "what's most relevant to this
// question." A large folder (hundreds/thousands of nodes) also needs a way
// to browse deterministically — pull the newest N, page by date, or fetch a
// specific set of ids already known from an index or citation. This is that
// path: no embedding call, no ranking, just filter + sort + cap.

/**
 * Filter a node list to an optional id set and/or creation-date range, then
 * sort by `created_at`. Pure and synchronous — no embedding/LLM call, so it's
 * cheap even over a folder with thousands of nodes.
 */
export function selectNodesDirect(opts: {
  nodes: readonly Node[];
  ids?: readonly string[];
  since?: string;
  until?: string;
  sort?: 'newest' | 'oldest';
}): Node[] {
  let rows = [...opts.nodes];
  if (opts.ids && opts.ids.length > 0) {
    const want = new Set(opts.ids);
    rows = rows.filter((n) => want.has(n.id));
  }
  if (opts.since) rows = rows.filter((n) => n.created_at >= opts.since!);
  if (opts.until) rows = rows.filter((n) => n.created_at <= opts.until!);
  rows.sort((a, b) =>
    opts.sort === 'oldest' ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at),
  );
  return rows;
}

/** Collapse whitespace and cap to `max` chars on a word-ish boundary. */
function truncateSummary(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A short, deterministic one-liner for a node — no LLM call. Prefers a field
 * that's already a summary (decision nodes' `summary`), then a title + body
 * lead-in, then the bare body. Used by the index and search result shapes,
 * which exist specifically to be cheap to scan over hundreds of nodes.
 */
export function summarizeNode(node: Node, max = 160): string {
  const n = node as unknown as Record<string, unknown>;
  const existing = n.summary as string | undefined;
  if (existing) return truncateSummary(existing, max);
  const title = n.title as string | undefined;
  const body = (n.body as string | undefined) ?? '';
  return truncateSummary(title ? `${title}: ${body}` : body, max);
}

export interface IndexEntry {
  id: string;
  kind: string;
  subkind?: string;
  category?: string;
  title?: string;
  summary: string;
  created_at: string;
  status: 'active' | 'archived';
  superseded?: string;
}

function projectIndexEntry(node: Node): IndexEntry {
  const n = node as unknown as Record<string, unknown>;
  return {
    id: node.id,
    kind: node.type,
    subkind: (n.subkind as string | undefined) ?? (n.kind as string | undefined) ?? undefined,
    category: (n.category as string | undefined) ?? undefined,
    title: (n.title as string | undefined) ?? undefined,
    summary: summarizeNode(node),
    created_at: node.created_at,
    status: node.status,
    superseded: (n.superseded as string | undefined) || undefined,
  };
}

export interface IndexPack {
  index: IndexEntry[];
  markdown: string;
}

/**
 * Render a node list as a compact index — one line per node (id, kind, date,
 * a short auto-summary, and a SUPERSEDED tag when it's an archived row) —
 * instead of full-mode's one markdown block per node. The point: an agent can
 * see everything in a folder of hundreds/thousands of nodes at a fraction of
 * the token cost, then re-call get_context with `ids` to pull full content
 * for just the ones it needs.
 */
export function renderIndex(opts: {
  profile: ContextProfile;
  scope: string;
  nodes: readonly Node[];
}): IndexPack {
  const entries = opts.nodes.map(projectIndexEntry);
  const scopeDef = opts.profile.query_scopes.find((s) => s.key === opts.scope);
  const scopeLabel = scopeDef?.label ?? opts.scope;
  const header = `# ${opts.profile.name} vault — ${scopeLabel} (index, ${entries.length} node${
    entries.length === 1 ? '' : 's'
  })`;
  if (entries.length === 0) return { index: entries, markdown: `${header}\n\n_No nodes in this scope yet._` };
  const lines = entries.map((e) => {
    const tags = [e.kind, e.subkind, e.category].filter(Boolean).join(' · ');
    const sup = e.status === 'archived' ? ` [SUPERSEDED${e.superseded ? ` by \`${e.superseded}\`` : ''}]` : '';
    return `- \`${e.id}\` (${e.created_at.slice(0, 10)})${tags ? ` [${tags}]` : ''} ${e.summary}${sup}`;
  });
  return { index: entries, markdown: [header, ...lines].join('\n') };
}

// ─── Search: ranked lookup, no synthesis ───────────────────────────────────
//
// query_context runs full LLM synthesis over a scope+relevance pack;
// get_context dumps a scope deterministically. Neither is "find the nodes
// that best match this text" as a raw, fast primitive an agent can fall back
// to when scope/date/id retrieval isn't surfacing the right thing — this is
// that primitive: embed the query once, rank every candidate node by cosine,
// return the top matches with their score. No LLM call beyond the embedding.

export interface SearchHit extends IndexEntry {
  score: number;
  subgraph_id?: string;
}

/** Default result count for `searchNodes`/`searchNodesMulti` when `limit` is omitted. */
export const SEARCH_DEFAULT_LIMIT = 20;

/**
 * Rank a single subgraph's nodes by cosine similarity to `query` and return
 * the top `limit`. A node with no stored embedding still ranks (cosine
 * against a zero vector is 0), so it just sorts last rather than erroring.
 */
export async function searchNodes(opts: {
  repo: RepoLike;
  workspace_id: string;
  query: string;
  embedder: Embedder;
  subgraph_id?: string;
  activeOnly?: boolean;
  viewer?: string;
  limit?: number;
}): Promise<SearchHit[]> {
  const rows = await opts.repo.listNodesWithEmbeddings(
    opts.workspace_id,
    { activeOnly: opts.activeOnly ?? true, viewer: opts.viewer, aiRead: true },
    opts.subgraph_id,
  );
  if (rows.length === 0) return [];
  const [qVec] = await opts.embedder.embed([opts.query]);
  const scored = rows.map((r) => {
    const vec = blobToEmbedding(r.embedding);
    const score = qVec && vec ? cosineSimilarity(qVec, vec) : 0;
    return { entry: projectIndexEntry(r.node), score };
  });
  scored.sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  return scored.slice(0, limit).map(({ entry, score }) => ({ ...entry, score }));
}

/**
 * Search every given subgraph separately (each ranked against its own node
 * set), then merge and re-rank by score globally, capped to `limit`. Each hit
 * is tagged with `subgraph_id` for provenance, same convention as
 * `buildScopedGraphMulti`.
 */
export async function searchNodesMulti(opts: {
  repo: RepoLike;
  workspace_id: string;
  query: string;
  embedder: Embedder;
  subgraph_ids: readonly string[];
  activeOnly?: boolean;
  viewer?: string;
  limit?: number;
}): Promise<SearchHit[]> {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  const perSubgraph = await Promise.all(
    opts.subgraph_ids.map(async (subgraph_id) => {
      const hits = await searchNodes({
        repo: opts.repo,
        workspace_id: opts.workspace_id,
        query: opts.query,
        embedder: opts.embedder,
        subgraph_id,
        activeOnly: opts.activeOnly,
        viewer: opts.viewer,
        limit,
      });
      return hits.map((h) => ({ ...h, subgraph_id }));
    }),
  );
  return perSubgraph
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
