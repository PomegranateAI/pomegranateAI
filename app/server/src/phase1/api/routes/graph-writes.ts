// Routes: graph-writes.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { Node, ProfileNode } from '../../../lib/schemas.js';
import type { Node as NodeT } from '../../../lib/schemas.js';
import { validateNode } from '../../../lib/profile-validate.js';
import { log } from '../../../lib/log.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerGraphWrites(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  resolveSubgraph,
  profileFor,
  embedAndStoreNode,
  userEmail,
  clientIp,
  viewerFor,
} = core;

/**
 * True when the caller may see (and therefore act on) node `id`: team notes are
 * everyone's; private/only_me notes only their owner's. A node that does not
 * exist yet passes, so POST /graph can still create. Local single-user mode
 * (viewerFor → undefined) skips the check, as on every other read.
 */
async function callerMaySeeNode(ws: string, id: string, viewer: string | undefined): Promise<boolean> {
  if (!viewer) return true;
  if (!await repo.getNodeVisibility(ws, id)) return true;
  return repo.nodeVisibleToViewer(ws, id, viewer);
}
app.get('/workspaces/:ws/graph/:id/evidence', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const nodeId = c.req.param('id');
  const viewer = viewerFor(c);
  // Evidence is the source quotes behind a note: same audience as the note,
  // and each quote also needs its document to be readable by the caller.
  if (viewer && !await repo.nodeVisibleToViewer(ws, nodeId, viewer)) return c.json({ error: 'not_found' }, 404);
  const evidence = [];
  for (const e of await repo.listNodeEvidence(ws, nodeId)) {
    if (viewer && e.document_id && !await repo.documentVisibleToViewer(ws, e.document_id, viewer)) continue;
    evidence.push({ ...e, document: e.document_id ? (await repo.getDocument(ws, e.document_id) ?? null) : null });
  }
  return c.json({ node_id: nodeId, evidence });
});

app.post('/workspaces/:ws/graph', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const body = await c.req.json();
  // Parse with the founding union first; fall back to the generalized
  // envelope so profile-driven kinds (beyond goal/positioning/decision) still
  // round-trip. Either way, validity of the kind/subkind/category is enforced
  // against the workspace profile below (→ 422), not by the schema.
  const founding = Node.safeParse(body);
  const generalized = founding.success ? null : ProfileNode.safeParse(body);
  if (!founding.success && !generalized!.success) {
    return c.json({ error: 'invalid node', details: founding.error.format() }, 400);
  }
  const node = (founding.success ? founding.data : generalized!.data) as NodeT;
  // Upsert by id must not let a member overwrite someone else's private note.
  if (!await callerMaySeeNode(ws, node.id, viewerFor(c))) return c.json({ error: 'not_found' }, 404);
  // Validate against the template of the subfolder the node actually lives in —
  // NOT the workspace's default subfolder. `profileFor(ws)` defaults to
  // 'default', so saving a node in any other subfolder was checked against the
  // wrong template and 422'd on its own perfectly valid kind (a brand-voice
  // `voice_attribute` rejected as "not in profile 'todo_list'"). Nodes are
  // subfolder-local; their template is too.
  const sgSel = await resolveSubgraph(c, ws);
  const subgraph_id = sgSel?.id ?? 'default';
  const kindErr = validateNode(await profileFor(ws, subgraph_id), node);
  if (kindErr) return c.json({ error: 'profile_mismatch', detail: kindErr }, 422);
  const parsed = { data: node };
  await repo.upsertNode(ws, parsed.data, user_id, undefined, subgraph_id);
  // Compute the embedding so future dedup-against-graph runs can compare
  // against this node via cosine. Best-effort: failure is logged but
  // doesn't block the write (next ingest still falls back to lexical
  // Jaccard for this row until backfill picks it up).
  embedAndStoreNode(ws, parsed.data).catch((err) => {
    log.warn('embed_on_upsert_failed', {
      workspace: ws,
      node_id: parsed.data.id,
      msg: (err as Error).message?.slice(0, 200),
    });
  });
  await repo.logCustomerAudit(ws, {
    event: 'graph_node_mutated',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'graph_node',
    resource_id: parsed.data.id,
    payload: { type: parsed.data.type, status: parsed.data.status },
  });
  return c.json({ ok: true, node: parsed.data });
});

app.delete('/workspaces/:ws/graph/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const id = c.req.param('id');
  if (!await callerMaySeeNode(ws, id, viewerFor(c))) return c.json({ error: 'not_found' }, 404);
  await repo.archiveNode(ws, id, user_id);
  await repo.logCustomerAudit(ws, {
    event: 'graph_node_mutated',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'graph_node',
    resource_id: id,
    payload: { archived: true },
  });
  return c.json({ ok: true });
});
}
