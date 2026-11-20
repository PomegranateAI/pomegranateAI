/**
 * Edge inference — populate graph_edges from graph content with a Haiku call
 * proposing edges between freshly approved nodes and the existing active
 * graph, constrained to the profile's edge_kinds taxonomy. Invalid proposals
 * (unknown kind, constraint mismatch, edge between two pre-existing nodes)
 * are dropped at apply time by the same write-time validation every edge
 * writer goes through (repo.addEdge). Edges land with created_by='llm' so
 * the batch is auditable and removable.
 *
 * Runs fire-and-forget after candidate approval (api/server.ts,
 * mcp/server.ts) — failure never blocks an approval.
 *
 * A deterministic attrs.product pass was tried first and dropped: prod data
 * showed attrs.product is uncontrolled vocabulary (the same workspace held
 * 'pomegranate', 'vdm' — the category — and null), so exact matching wired
 * 2 of 14 attributed competitors and silently skipped the rest. The LLM
 * pass reads bodies, not attrs, and doesn't share that failure mode.
 *
 * LLM-call observability: one llm.log row per call with task=`edge_inference`.
 * Node/edge bodies and quotes are excluded from the log per
 * docs/llm-calls.md; ids + kinds reconstruct the
 * decision without leaking customer content.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { structuredCall } from './anthropic.js';
import { resolveEdgeKinds } from './edges.js';
import { writeLlmCall } from './llm-log.js';
import { getLlmContext } from './llm-context.js';
import { log } from './log.js';
import type { ContextProfile as ContextProfileT, EdgeKindDef as EdgeKindDefT, EdgeOrigin as EdgeOriginT, Node as NodeT } from './schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, 'prompts');

/**
 * The slice of Repo edge inference needs (structural — lib/ does not import
 * phase1/). Repo satisfies it as-is.
 */
export interface EdgeRepo {
  getWorkspaceProfile(workspace_id: string, subgraph_id?: string): Promise<ContextProfileT | undefined>;
  listNodes(workspace_id: string, opts?: { activeOnly?: boolean }, subgraph_id?: string): Promise<NodeT[]>;
  addEdge(
    workspace_id: string,
    edge: {
      src: string;
      dst: string;
      kind: string;
      created_by: EdgeOriginT;
      document_id?: string;
      quote?: string;
      confidence?: number;
    },
    actor?: string,
    subgraph_id?: string,
    /**
     * The already-resolved edge taxonomy to validate against, when the
     * caller has one (see applyEdgeProposals below). Without it, the
     * concrete Repo.addEdge re-derives the taxonomy itself via
     * `this.getWorkspaceProfile` — the REAL method, not whatever this
     * EdgeRepo's own `getWorkspaceProfile` was overridden to return (the
     * data-agent path overrides it to the active template; `this` inside
     * the bound method is still the concrete Repo instance and never sees
     * that override). Passing it through here is what makes the two agree.
     */
    edgeKinds?: EdgeKindDefT[],
  ): Promise<{ id: string; existing: boolean }>;
  getNodeDocumentId(workspace_id: string, node_id: string): Promise<string | undefined>;
}

// ---------- LLM pass ----------

const EdgeProposal = z.object({
  src: z.string(),
  dst: z.string(),
  kind: z.string(),
  quote: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});
const EdgeProposalPayload = z.object({ edges: z.array(EdgeProposal) });
export type EdgeProposal = z.infer<typeof EdgeProposal>;

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          src: { type: 'string', description: 'Source node id.' },
          dst: { type: 'string', description: 'Destination node id.' },
          kind: { type: 'string', description: 'An edge kind key from the taxonomy.' },
          quote: { type: ['string', 'null'], description: 'One-sentence justification.' },
          confidence: { type: ['number', 'null'] },
        },
        required: ['src', 'dst', 'kind'],
      },
    },
  },
  required: ['edges'],
} as const;

function loadEdgePrompt(): { body: string; version: number | undefined } {
  const raw = readFileSync(resolve(PROMPTS_DIR, 'edge-inference.md'), 'utf8');
  const parsed = matter(raw);
  return { body: parsed.content.trim(), version: (parsed.data as { version?: number }).version };
}

const MODEL = 'claude-haiku-4-5-20251001';
/** Cap on the existing-graph listing sent to the model (most recent first). */
const MAX_GRAPH_NODES = 150;
/** Body truncation for the existing-graph listing (new nodes go in full). */
const GRAPH_BODY_CHARS = 240;

function nodeListing(n: NodeT, truncate?: number): Record<string, unknown> {
  const body = (n as { body?: string }).body ?? '';
  return {
    id: n.id,
    type: n.type,
    subkind: (n as { subkind?: string }).subkind,
    title: (n as { title?: string }).title,
    date_inserted: (n as any).created_at,
    body: truncate && body.length > truncate ? `${body.slice(0, truncate)}…` : body,
  };
}

/**
 * Apply model-proposed edges. Exported for tests — enforces the rules the
 * model is told about but not trusted on: every edge involves at least one new
 * node, scoping guards (EdgeKindDef.scope_attr) hold deterministically, and
 * every edge passes the same write-time taxonomy validation as any other
 * writer (via repo.addEdge). Provenance: each edge inherits the document_id
 * of its new-node end.
 */
export async function applyEdgeProposals(
  repo: EdgeRepo,
  workspace_id: string,
  newNodeIds: ReadonlySet<string>,
  proposals: readonly EdgeProposal[],
  subgraph_id = 'default',
): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  // Guard inputs: edge-kind defs carrying deterministic guards, and node attrs.
  // Must resolve against THIS subgraph's profile/nodes, not the workspace's
  // 'default' subgraph — a multi-subgraph workspace's other subgraphs run a
  // different profile with a different (or empty) edge taxonomy, so validating
  // against the wrong one silently drops every valid proposal here (found
  // 2026-07-23: an `about` edge for a `people_list` folder was rejected
  // because it was checked against the workspace's `default` subgraph, whose
  // profile happened to declare `edge_kinds: []`).
  const allKinds = resolveEdgeKinds(await repo.getWorkspaceProfile(workspace_id, subgraph_id));
  const scopedKinds = new Map(allKinds.filter((k) => k.scope_attr).map((k) => [k.key, k.scope_attr!]));
  const orderedKinds = new Map(allKinds.filter((k) => k.order_attr).map((k) => [k.key, k.order_attr!]));
  const nodeById =
    scopedKinds.size > 0 || orderedKinds.size > 0
      ? new Map((await repo.listNodes(workspace_id, { activeOnly: true }, subgraph_id)).map((n) => [n.id, n]))
      : new Map<string, NodeT>();
  const attrValue = (id: string, attr: string): string | undefined => {
    const v = (nodeById.get(id) as { attrs?: Record<string, unknown> } | undefined)?.attrs?.[attr];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const scopeValue = (id: string, attr: string): string | undefined =>
    attrValue(id, attr)?.toLowerCase();
  for (const p of proposals) {
    // Defense in depth on top of the taxonomy exclusion in inferLlmEdges:
    // `amends` is reserved for captureIntoSubgraph's deterministic write from
    // capture's own operation/amends fields — an LLM-proposed `amends` is
    // always wrong (the profile's declared kinds never include it as a real
    // option; this only fires if it slips through some other call path).
    if (p.kind === 'amends') {
      skipped++;
      log.debug('edges.llm_proposal_rejected', {
        workspace: workspace_id,
        src: p.src,
        dst: p.dst,
        kind: p.kind,
        reason: 'amends is reserved for capture\'s deterministic operation/amends field, never proposed by edge-inference',
      });
      continue;
    }
    const newEnd = newNodeIds.has(p.src) ? p.src : newNodeIds.has(p.dst) ? p.dst : undefined;
    if (!newEnd) {
      skipped++; // edge between two pre-existing nodes — out of scope
      continue;
    }
    // Deterministic scoping guard: a membership edge requires the SRC to be
    // scoped (program/portfolio-wide nodes belong to nothing), and the two
    // ends' scope values to agree when both are present. The model is told
    // this in the edge description; here it is enforced.
    const scopeAttr = scopedKinds.get(p.kind);
    if (scopeAttr) {
      const sv = scopeValue(p.src, scopeAttr);
      const dv = scopeValue(p.dst, scopeAttr);
      if (!sv || (dv && sv !== dv)) {
        skipped++;
        log.debug('edges.llm_proposal_rejected', {
          workspace: workspace_id,
          src: p.src,
          dst: p.dst,
          kind: p.kind,
          reason: !sv
            ? `scope guard: src has no ${scopeAttr} attr (program-wide)`
            : `scope guard: src ${scopeAttr}='${sv}' != dst '${dv}'`,
        });
        continue;
      }
    }
    // Temporal guard: a dependent cannot be due before its prerequisite.
    // Only fires when BOTH ends carry the date attr (ISO dates compare
    // lexicographically); undated ends pass through.
    const orderAttr = orderedKinds.get(p.kind);
    if (orderAttr) {
      const sd = attrValue(p.src, orderAttr);
      const dd = attrValue(p.dst, orderAttr);
      if (sd && dd && sd < dd) {
        skipped++;
        log.debug('edges.llm_proposal_rejected', {
          workspace: workspace_id,
          src: p.src,
          dst: p.dst,
          kind: p.kind,
          reason: `order guard: src ${orderAttr}=${sd} precedes dst ${dd} (reversed dependency)`,
        });
        continue;
      }
    }
    try {
      await repo.addEdge(
        workspace_id,
        {
          src: p.src,
          dst: p.dst,
          kind: p.kind,
          created_by: 'llm',
          document_id: await repo.getNodeDocumentId(workspace_id, newEnd),
          quote: p.quote ?? undefined,
          confidence: p.confidence ?? undefined,
        },
        undefined,
        subgraph_id,
        // Pass the taxonomy this function already resolved correctly (line
        // ~145) straight through, instead of letting addEdge re-derive it
        // via the concrete Repo's own getWorkspaceProfile — see the
        // EdgeRepo.addEdge doc comment for why that re-derivation silently
        // disagreed with this one on the data-agent path.
        allKinds,
      );
      added++;
    } catch (err) {
      skipped++;
      log.debug('edges.llm_proposal_rejected', {
        workspace: workspace_id,
        src: p.src,
        dst: p.dst,
        kind: p.kind,
        reason: (err as Error).message?.slice(0, 200),
      });
    }
  }
  return { added, skipped };
}

/**
 * Propose and persist edges for freshly approved nodes against the active
 * graph. No-op when the profile has no edge taxonomy, none of it applies to
 * the new nodes' kinds, or the graph has nothing else to relate to.
 */
export async function inferLlmEdges(
  repo: EdgeRepo,
  workspace_id: string,
  subgraph_id: string,
  newNodeIds: string[],
): Promise<{ proposed: number; added: number; skipped: number }> {
  const none = { proposed: 0, added: 0, skipped: 0 };
  const profile = await repo.getWorkspaceProfile(workspace_id, subgraph_id);
  const kinds = resolveEdgeKinds(profile);
  if (kinds.length === 0 || newNodeIds.length === 0) return none;

  const idSet = new Set(newNodeIds);
  const all = await repo.listNodes(workspace_id, { activeOnly: true }, subgraph_id);
  const newNodes = all.filter((n) => idSet.has(n.id));
  if (newNodes.length === 0) return none;

  // Only send the taxonomy slice the new nodes can participate in. `amends` is
  // excluded outright — per edges.ts, it is written ONLY by captureIntoSubgraph
  // from capture's own `operation`/`amends` fields ("Capture STATED the
  // amendment; an inference pass would re-derive a known fact and could
  // disagree with it"). Because AMENDS_EDGE_KIND declares `src_kinds`/
  // `dst_kinds: 'any'`, it always passed this relevance filter regardless of
  // the new nodes' types, so this model was being offered a kind it was never
  // supposed to write — confirmed 2026-07-23: a fresh `contact` + `status_update`
  // pair from the same capture batch got an LLM-proposed `amends` edge between
  // them (backwards, and not a real amendment — neither node supersedes the
  // other) where the correct proposal was `about`. Removed at the source
  // instead of only guarded at apply time, so it stops being an option to
  // confuse the model with in the first place.
  const newTypes = new Set(newNodes.map((n) => n.type as string));
  const relevantKinds = kinds.filter(
    (k) =>
      k.key !== 'amends' &&
      (k.src_kinds === 'any' ||
        k.dst_kinds === 'any' ||
        k.src_kinds.some((t) => newTypes.has(t)) ||
        k.dst_kinds.some((t) => newTypes.has(t))),
  );
  if (relevantKinds.length === 0) return none;

  // The rest of the graph may be EMPTY (first approval batch into a fresh
  // workspace) — that's still worth a call: the batch relates internally
  // (e.g. a metric supporting a goal approved together).
  const rest = all.filter((n) => !idSet.has(n.id));
  if (rest.length === 0 && newNodes.length < 2) return none;
  // listNodes is updated_at DESC — cap keeps the freshest slice.
  const graph = rest.slice(0, MAX_GRAPH_NODES);
  if (rest.length > graph.length) {
    log.info('edges.graph_truncated', {
      workspace: workspace_id,
      active: rest.length,
      sent: graph.length,
    });
  }

  const parts = [];
  if (profile?.description) parts.push(`<template_guidelines>\n${profile.description}\n</template_guidelines>`);
  parts.push(
    `<taxonomy>\n${JSON.stringify(
      relevantKinds.map((k) => ({
        key: k.key,
        description: k.description,
        src_kinds: k.src_kinds,
        dst_kinds: k.dst_kinds,
      })),
      null,
      2,
    )}\n</taxonomy>`,
    `<new_nodes>\n${JSON.stringify(newNodes.map((n) => nodeListing(n)), null, 2)}\n</new_nodes>`,
    `<graph>\n${JSON.stringify(graph.map((n) => nodeListing(n, GRAPH_BODY_CHARS)), null, 2)}\n</graph>`,
  );
  const userMessage = parts.join('\n\n');

  const { body: system, version: promptVersion } = loadEdgePrompt();
  // Routes through the local Qwen provider when the standalone app installed
  // one (structuredCall honors the override); otherwise hits Anthropic.
  const res = await structuredCall({
    model: MODEL,
    system,
    user: userMessage,
    toolName: 'emit_edges',
    toolDescription: 'Emit proposed typed edges for the new nodes.',
    schema: PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4096,
    task: 'edge_inference',
  });
  const latency_ms = res.latency_ms;

  if (res.noToolUse) {
    log.warn('edges.llm_no_tool_use', { workspace: workspace_id, new_nodes: newNodeIds });
    return none;
  }
  const parsed = EdgeProposalPayload.parse(res.output);
  const { added, skipped } = await applyEdgeProposals(repo, workspace_id, idSet, parsed.edges, subgraph_id);

  const ctx = getLlmContext();
  writeLlmCall({
    task: 'edge_inference',
    caller: ctx.caller ?? 'lib.edge_inference',
    workspace_id: ctx.workspace_id ?? workspace_id,
    user_id: ctx.user_id,
    mcp_token_id: ctx.mcp_token_id,
    model: res.modelLabel,
    prompt_version: promptVersion,
    context: ctx.context,
    // ids + kinds only — node bodies and edge quotes are customer content
    // and stay out of llm.log (conventions/llm-calls.md).
    input: {
      new_nodes: newNodes.map((n) => ({ id: n.id, type: n.type })),
      graph_nodes_sent: graph.length,
      taxonomy_kinds: relevantKinds.map((k) => k.key),
    },
    output: {
      proposed: parsed.edges.map((e) => ({
        src: e.src,
        dst: e.dst,
        kind: e.kind,
        confidence: e.confidence ?? null,
      })),
      added,
      skipped,
    },
    tokens: {
      input: res.tokens.input,
      cache_read: res.tokens.cache_read,
      cache_write: res.tokens.cache_write,
      output: res.tokens.output,
    },
    latency_ms,
  });
  log.info('edges.llm', {
    workspace: workspace_id,
    new_nodes: newNodeIds.length,
    proposed: parsed.edges.length,
    added,
    skipped,
    latency_ms,
  });
  return { proposed: parsed.edges.length, added, skipped };
}
