// Routes: agents.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import type { Context } from 'hono';
import { z } from 'zod';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerAgents(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  resolveSubgraph,
  profileFor,
  viewerFor,
  synth,
  clientIp,
  ensureGroupsForWorkspace,
} = core;
// ---------- Work agents (spec-work-agents.md) ----------
// Agents that act on the CALLER'S OWN context only — their own active graph in
// the current folder — to produce a finished artifact (draft / synthesize /
// catch-up / follow-up). The opposite axis to the collaboration agents above,
// which reach outward into the team/other folders. Own-context invariant W0:
// this NEVER resolves a teammate reference or crosses folders; it reads the
// pinned subgraph with the caller as viewer, same as any own-folder read.
const WORK_AGENTS = new Set(['draft', 'synthesize', 'catchup', 'followup']);
// Cap the graph handed to the prompt so a large folder doesn't blow the context
// window. Nodes come newest-first, so this keeps the freshest material.
const WORK_AGENT_NODE_CAP = 200;

app.post('/workspaces/:ws/work/:agent', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const agent = c.req.param('agent');
  if (!WORK_AGENTS.has(agent)) {
    return c.json({ error: `unknown work agent '${agent}'` }, 400);
  }
  const parsed = z
    .object({
      input: z.string().max(4000).optional(),
      docType: z.string().max(120).optional(),
      // Catch-up window (ISO date/datetime); defaults to 7 days ago.
      since: z.string().max(40).optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const input = (parsed.data.input ?? '').trim();

  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const profile = await profileFor(ws, sg.id);
  const viewer = viewerFor(c);
  const t0 = Date.now();

  // Assemble the caller's OWN nodes. Catch-up wants only what changed recently;
  // the other three want the (capped, newest-first) active graph. All are
  // aiRead reads (an LLM sees them) filtered to what the caller may see.
  let graph: Awaited<ReturnType<typeof repo.listNodes>>;
  if (agent === 'catchup') {
    const cutoff = parsed.data.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const rows = await repo.listRecentlyUpdatedNodeIds(ws, sg.id, cutoff.slice(0, 19).replace('T', ' '), WORK_AGENT_NODE_CAP);
    const visibleIds: string[] = [];
    for (const r of rows) if (await repo.nodeVisibleToViewer(ws, r.id, user_id, true)) visibleIds.push(r.id);
    const recentIds = new Set(visibleIds);
    graph = (await repo
      .listNodes(ws, { activeOnly: true, viewer, aiRead: true }, sg.id))
      .filter((n) => recentIds.has(n.id));
  } else {
    graph = (await repo
      .listNodes(ws, { activeOnly: true, viewer, aiRead: true }, sg.id))
      .slice(0, WORK_AGENT_NODE_CAP);
  }

  log.info('work.run', {
    workspace: ws,
    user: user_id,
    agent,
    subgraph: sg.id,
    input_chars: input.length,
    node_count: graph.length,
  });

  // Empty pile → tell the UI to nudge the user to add sources, not run the LLM.
  if (graph.length === 0) {
    return c.json({ agent, title: '', output: '', cited_node_ids: [], empty: true });
  }

  try {
    const result = await withLlmContext(
      { caller: `api.work.${agent}`, context: { agent, input_chars: input.length } },
      () =>
        synth.workAgent({
          agent: agent as 'draft' | 'synthesize' | 'catchup' | 'followup',
          graph,
          input,
          docType: parsed.data.docType,
          profile,
        }),
    );
    // Integrity: only cite nodes that are actually in the supplied set (same
    // drop the query/review paths do).
    const realIds = new Set(graph.map((n) => n.id));
    const cited = result.cited_node_ids.filter((id) => realIds.has(id));
    // Attribution-without-content: WHO ran it + the shape go to the attributed
    // usage log; the verbatim input goes to the anonymized text store only.
    await repo.recordContextAccess(ws, {
      actor_user_id: user_id,
      channel: 'web',
      tool: 'work',
      scope: agent,
      cited: cited.length,
      node_count: graph.length,
      latency_ms: Date.now() - t0,
      request_text: input || undefined,
      cited_node_ids: cited,
      subgraph_id: sg.id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
    return c.json({ agent, title: result.title, output: result.output, cited_node_ids: cited });
  } catch (err) {
    // Degrade, don't 500 (see anthropic-key-stale-behind-qwen): an LLM/key
    // failure returns a soft error the view can show, not a crash.
    log.warn('work.failed', { workspace: ws, agent, msg: (err as Error).message?.slice(0, 200) });
    return c.json({ agent, title: '', output: '', cited_node_ids: [], error: 'synthesis_failed' }, 200);
  }
});


// Background scheduler for the post-ingest grouping precompute. Fires
// `ensureGroupsForWorkspace`, swallowing failure — a grouping LLM hiccup
// must not impact the HTTP response that already committed the candidates.
// Logged as `groups.auto_trigger` for observability.
function scheduleAutoGroup(workspace_id: string, caller: string, subgraph_id = 'default'): void {
  setImmediate(() => {
    ensureGroupsForWorkspace(workspace_id, caller, subgraph_id).catch((err) => {
      log.warn('groups.auto_trigger_failed', {
        workspace: workspace_id,
        caller,
        msg: (err as Error).message?.slice(0, 200),
      });
    });
  });
  log.info('groups.auto_trigger', { workspace: workspace_id, caller, subgraph: subgraph_id });
}
}
