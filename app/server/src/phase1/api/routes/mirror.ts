// Routes: mirror.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { nodeIdsOf } from '../../db/repo/shared.js';
import type { Context } from 'hono';
import { z } from 'zod';
import * as path from 'node:path';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { getEmbedder } from '../../../lib/embeddings.js';
import {
  buildScopedGraph,
  buildContextPack,
  buildScopedGraphMulti,
  edgesForPackedGraph,
} from '../../retrieval/pack.js';
import { retrieveSourceExcerpts } from '../../retrieval/source-rag.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerMirror(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  resolveQueryTargets,
  repo,
  viewerFor,
  synth,
  clientIp,
  profileFor,
} = core;
// ---------- Mirror surface endpoints ----------
//
// The leader's "Mirror" view (see PRD UI redesign) shows two things:
//   1. What the team's AI tools see when they ask the graph (Q&A peek).
//   2. The recent questions ICs are asking — anonymized, no IC names.
//
// Both endpoints below are session-authed (not MCP-token-authed) because the
// caller is the leader inside the web app, not an external LLM tool.

app.post('/workspaces/:ws/query', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const t0 = Date.now();
  const body = await c.req.json();
  const parsed = z
    .object({
      question: z.string().min(1).max(1000),
      // Profile-driven scope key; validated against the workspace profile's
      // query_scopes.
      scope: z.string().default('all'),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const scope = parsed.data.scope;
  // Phase 4: auto-route the question to the relevant subgraph(s); a `#slug`
  // token in the question pins. A single-subgraph workspace takes the fast
  // path (one 'default' target, no classifier) so behaviour is byte-identical.
  const { targets, stripped } = await resolveQueryTargets(ws, parsed.data.question);

  if (targets.length === 1) {
    // Single-target path — byte-identical to the legacy single-subgraph path.
    const profile = targets[0]!.profile;
    if (!profile.query_scopes.some((s) => s.key === scope)) {
      const allowed = profile.query_scopes.map((s) => s.key).join(', ');
      return c.json({ error: 'profile_mismatch', detail: `scope '${scope}' is not in profile '${profile.id}' (allowed: ${allowed})` }, 422);
    }
    // Scoped + embedding-ranked retrieval (spec B6.1/B6.2): filter to the
    // scope's kind keys, then rank-and-pack when the active graph exceeds the
    // threshold. Below threshold this is the full scoped graph, exactly as
    // before (keeps the query eval gates valid).
    const pack = await buildScopedGraph({
      repo,
      workspace_id: ws,
      profile,
      scope,
      question: stripped,
      embedder: getEmbedder(),
      subgraph_id: targets[0]!.subgraph_id,
      viewer: viewerFor(c),
    });
    const graph = pack.nodes;
    // Always-hybrid source-RAG path (spec-source-rag-hybrid-answering.md);
    // [] when the flag is off → node-only, byte-identical.
    const excerpts = await retrieveSourceExcerpts({
      repo,
      workspace_id: ws,
      question: stripped,
      embedder: getEmbedder(),
      viewer: viewerFor(c),
    });
    const edges = await edgesForPackedGraph(repo, ws, [targets[0]!.subgraph_id], graph);
    log.info('query.retrieval', {
      workspace: ws,
      caller: 'api.mirror_query',
      scope,
      ...pack.stats,
      edge_count: edges.length,
      source_excerpts: excerpts.length,
    });
    const result = await withLlmContext(
      {
        caller: 'api.mirror_query',
        context: { scope, question_chars: stripped.length },
      },
      () =>
        synth.query({
          graph,
          edges,
          scope,
          question: stripped,
          profile,
          sourceExcerpts: excerpts,
        }),
    );
    // Integrity: same drop as the MCP path.
    const realIds = new Set(graph.map((n) => n.id));
    result.cited_node_ids = result.cited_node_ids.filter((id) => realIds.has(id));
    if (result.cited_chunk_ids) {
      const realChunkIds = new Set(excerpts.map((e) => e.chunk_id));
      result.cited_chunk_ids = result.cited_chunk_ids.filter((id) => realChunkIds.has(id));
    }
    // Cross-user usage record: WHO asked + request shape go to the attributed
    // log; the verbatim question goes to the anonymized text store only.
    await repo.recordContextAccess(ws, {
      actor_user_id: user_id,
      channel: 'web',
      tool: 'query',
      scope,
      has_answer: result.has_answer,
      cited: result.cited_node_ids.length,
      node_count: graph.length,
      latency_ms: Date.now() - t0,
      request_text: stripped,
      cited_node_ids: result.cited_node_ids,
      subgraph_id: targets[0]!.subgraph_id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
    return c.json(result);
  }

  // Multi-target path: query each subgraph against its OWN profile (a scope
  // absent from a target silently widens to 'all' there — no 422), merge the
  // nodes, then run ONE synthesis pass. The integrity filter cites against the
  // merged id set; the synthesis profile is representative (citations are
  // node-id based and profile-agnostic for Q&A).
  const multi = await buildScopedGraphMulti({
    repo,
    workspace_id: ws,
    subgraphs: targets,
    scope,
    question: stripped,
    embedder: getEmbedder(),
    viewer: viewerFor(c),
  });
  const graph = multi.nodes;
  const excerpts = await retrieveSourceExcerpts({
    repo,
    workspace_id: ws,
    question: stripped,
    embedder: getEmbedder(),
    viewer: viewerFor(c),
  });
  const edges = await edgesForPackedGraph(repo, ws, multi.perSubgraph.map((p) => p.subgraph_id), graph);
  log.info('query.retrieval', {
    workspace: ws,
    caller: 'api.mirror_query',
    scope,
    multi: true,
    subgraphs: multi.perSubgraph.map((p) => p.subgraph_id),
    node_count: graph.length,
    edge_count: edges.length,
    source_excerpts: excerpts.length,
  });
  const result = await withLlmContext(
    {
      caller: 'api.mirror_query',
      context: { scope, question_chars: stripped.length },
    },
    () =>
      synth.query({
        graph,
        edges,
        scope,
        question: stripped,
        profile: targets[0]!.profile,
        sourceExcerpts: excerpts,
      }),
  );
  const realIds = new Set(graph.map((n) => n.id));
  result.cited_node_ids = result.cited_node_ids.filter((id) => realIds.has(id));
  if (result.cited_chunk_ids) {
    const realChunkIds = new Set(excerpts.map((e) => e.chunk_id));
    result.cited_chunk_ids = result.cited_chunk_ids.filter((id) => realChunkIds.has(id));
  }
  // One usage row per contributing subgraph (subgraph is shape not identity;
  // the split-table privacy model is preserved). Per-subgraph node_count;
  // cited split is the cites that fall inside each subgraph's node set.
  for (const ps of multi.perSubgraph) {
    const sgIds = new Set(
      graph.filter((n) => (n as any).subgraph_id === ps.subgraph_id).map((n) => n.id),
    );
    const sgCites = result.cited_node_ids.filter((id) => sgIds.has(id));
    await repo.recordContextAccess(ws, {
      actor_user_id: user_id,
      channel: 'web',
      tool: 'query',
      scope,
      has_answer: result.has_answer,
      cited: sgCites.length,
      node_count: sgIds.size,
      latency_ms: Date.now() - t0,
      request_text: stripped,
      cited_node_ids: sgCites,
      subgraph_id: ps.subgraph_id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
  }
  return c.json({ ...result, subgraphs: targets.map((t) => t.subgraph_id) });
});

/**
 * Context-pack endpoint (spec B6.3). Returns the scoped, embedding-ranked,
 * citation-ready slice of the canon as JSON with a rendered markdown field.
 * Unlike /query this never calls the synthesis LLM — it's a direct canon dump
 * for an IC's AI tools to pull and cite by node id.
 *
 *   ?scope=         profile query-scope key (default 'all'); 422 on mismatch
 *   ?budget_tokens= soft cap on the markdown body (nodes dropped past the cap)
 */
app.get('/workspaces/:ws/context-pack', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const scope = c.req.query('scope') ?? 'all';
  const budgetRaw = c.req.query('budget_tokens');
  let budget_tokens: number | undefined;
  if (budgetRaw !== undefined) {
    const n = Number(budgetRaw);
    if (!Number.isFinite(n) || n <= 0) return c.json({ error: 'invalid budget_tokens' }, 400);
    budget_tokens = Math.floor(n);
  }

  // Phase 4 target resolution: there is no NL question here, so we never run
  // the classifier. A `?subgraph=` pin (slug/id) targets one subgraph; absent a
  // pin we dump EVERY active subgraph. A single-subgraph workspace takes the
  // legacy path (one 'default' target) and is byte-identical.
  const subs = await repo.listSubgraphs(ws, { activeOnly: true });
  const pinSel = c.req.query('subgraph');
  let targets: Array<{ subgraph_id: string; profile: ContextProfileT }>;
  if (subs.length <= 1) {
    targets = await Promise.all(subs.map(async (s) => ({ subgraph_id: s.id, profile: await profileFor(ws, s.id) })));
  } else if (pinSel && pinSel !== 'default') {
    const sg = await repo.getSubgraphBySlug(ws, pinSel) ?? await repo.getSubgraph(ws, pinSel);
    if (!sg) return c.json({ error: 'unknown_subgraph', detail: `no folder '${pinSel}'` }, 400);
    targets = [{ subgraph_id: sg.id, profile: await profileFor(ws, sg.id) }];
  } else if (pinSel === 'default') {
    const sg = await repo.getSubgraph(ws, 'default');
    if (!sg) return c.json({ error: 'unknown_subgraph', detail: "no folder 'default'" }, 400);
    targets = [{ subgraph_id: sg.id, profile: await profileFor(ws, sg.id) }];
  } else {
    targets = await Promise.all(subs.map(async (s) => ({ subgraph_id: s.id, profile: await profileFor(ws, s.id) })));
  }

  if (targets.length === 1) {
    // Single-target path — byte-identical to the legacy single-subgraph path.
    const profile = targets[0]!.profile;
    if (!profile.query_scopes.some((s) => s.key === scope)) {
      const allowed = profile.query_scopes.map((s) => s.key).join(', ');
      return c.json({ error: 'profile_mismatch', detail: `scope '${scope}' is not in profile '${profile.id}' (allowed: ${allowed})` }, 422);
    }
    const scopeDef = profile.query_scopes.find((s) => s.key === scope)!;
    const pack = await buildContextPack({
      repo,
      workspace_id: ws,
      profile,
      scope,
      // No natural-language question on this endpoint; seed the cosine ranking
      // with the scope label so over-threshold graphs still rank meaningfully.
      question: scopeDef.label,
      embedder: getEmbedder(),
      budget_tokens,
      subgraph_id: targets[0]!.subgraph_id,
      // Packs feed an LLM: buildScopedGraph reads them as aiRead, so this
      // viewer gets team notes + their own non-only_me notes, nothing else.
      viewer: viewerFor(c),
    });
    log.info('context_pack.served', {
      workspace: ws,
      caller: 'api.context_pack',
      scope,
      node_count: pack.node_count,
      packed: pack.packed,
      truncated: pack.truncated,
      budget_tokens: budget_tokens ?? null,
    });
    await repo.recordContextAccess(ws, {
      actor_user_id: c.get('user_id'),
      channel: 'web',
      tool: 'context_pack',
      scope,
      node_count: pack.node_count,
      accessed_node_ids: nodeIdsOf(pack.nodes as unknown[]),
      subgraph_id: targets[0]!.subgraph_id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
    return c.json(pack);
  }

  // Multi-target path: build a pack per subgraph (each section already headed
  // by its profile name + scope), concatenate the markdown, and concat nodes.
  // A scope absent from a given target silently widens to 'all' there.
  const packs: Array<{ subgraph_id: string; pack: Awaited<ReturnType<typeof buildContextPack>> }> = [];
  for (const t of targets) {
    const scopeDef = t.profile.query_scopes.find((s) => s.key === scope);
    const pack = await buildContextPack({
      repo,
      workspace_id: ws,
      profile: t.profile,
      scope,
      question: scopeDef?.label ?? scope,
      embedder: getEmbedder(),
      budget_tokens,
      subgraph_id: t.subgraph_id,
      viewer: viewerFor(c),
    });
    packs.push({ subgraph_id: t.subgraph_id, pack });
  }
  const merged = {
    scope,
    profile_id: targets.map((t) => t.profile.id).join('+'),
    node_count: packs.reduce((a, p) => a + p.pack.node_count, 0),
    packed: packs.some((p) => p.pack.packed),
    budget_tokens,
    truncated: packs.some((p) => p.pack.truncated),
    nodes: packs.flatMap((p) =>
      p.pack.nodes.map((n) => ({ ...n, subgraph_id: p.subgraph_id })),
    ),
    markdown: packs.map((p) => p.pack.markdown).join('\n\n---\n\n'),
    subgraphs: targets.map((t) => t.subgraph_id),
  };
  log.info('context_pack.served', {
    workspace: ws,
    caller: 'api.context_pack',
    scope,
    multi: true,
    subgraphs: merged.subgraphs,
    node_count: merged.node_count,
  });
  for (const p of packs) {
    await repo.recordContextAccess(ws, {
      actor_user_id: c.get('user_id'),
      channel: 'web',
      tool: 'context_pack',
      scope,
      node_count: p.pack.node_count,
      accessed_node_ids: nodeIdsOf(p.pack.nodes as unknown[]),
      subgraph_id: p.subgraph_id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
  }
  return c.json(merged);
});

/**
 * Recent question-shapes seen by the MCP query_context tool, kept anonymous
 * (no actor, no text) for aggregate/stat use. The attributed equivalent —
 * who asked and, as of 2026-08, what they asked — lives at
 * /workspaces/:ws/context-usage and is what the Usage view renders.
 */
app.get('/workspaces/:ws/mcp-queries', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 200);
  const rows = await repo.listMcpQueryAuditRows(ws, limit);
  const out = rows.map((r) => {
    const p = r.payload ? JSON.parse(r.payload) : {};
    return {
      created_at: r.created_at,
      scope: p.scope ?? 'all',
      has_answer: !!p.has_answer,
      cited: p.cited ?? 0,
      latency_ms: p.latency_ms ?? null,
    };
  });
  return c.json({ queries: out });
});

/**
 * Anonymized review log. Returns kind, caller, flag counts, and timestamp —
 * not the deliverable body, not the IC. Aggregated drift metrics stay
 * anonymous; per-IC attribution (without content) lives on the
 * /context-usage endpoints instead (2026-06 decision).
 */
app.get('/workspaces/:ws/reviews', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
  const rows = await repo.listReviewLogRows(ws, limit);
  const reviews = rows.map((r) => {
    let red = 0;
    let yellow = 0;
    let green = 0;
    try {
      const arr = JSON.parse(r.findings) as Array<{ flag: 'red' | 'yellow' | 'green' }>;
      for (const f of arr) {
        if (f.flag === 'red') red++;
        else if (f.flag === 'yellow') yellow++;
        else if (f.flag === 'green') green++;
      }
    } catch {
      // ignore
    }
    return {
      id: r.id,
      caller: r.caller,
      kind: r.kind,
      red,
      yellow,
      green,
      created_at: r.created_at,
    };
  });
  return c.json({ reviews });
});
}
