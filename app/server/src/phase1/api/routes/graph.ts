// Routes: graph.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import * as path from 'node:path';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerGraph(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  resolveSubgraph,
  repo,
  viewerFor,
  docTextFilenames,
  isWorkspaceOwnerTier,
} = core;
// ---------- graph CRUD ----------

app.get('/workspaces/:ws/graph', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const activeOnly = c.req.query('active') !== 'false';
  // Profile-driven Graph view filters (spec B6.4): ?kind=&subkind=&category=.
  // All optional; absent → no filter on that dimension. `kind` matches the
  // node envelope `type`; `subkind`/`category` match the generalized-envelope
  // fields (legacy positioning.kind reads back as subkind via the schema
  // backfill, so `?subkind=banned_phrase` works on founding rows too).
  const kind = c.req.query('kind');
  const subkind = c.req.query('subkind');
  const category = c.req.query('category');
  // Sharing enforcement (graph sync): a member only sees team nodes, their own
  // private nodes, and nodes shared with them. Cloud-native nodes default to
  // 'team', so existing graphs read identically. (Local mode: no filter.)
  let nodes = await repo.listNodes(ws, { activeOnly, viewer: viewerFor(c) }, sg.id);
  if (kind || subkind || category) {
    nodes = nodes.filter((n) => {
      const r = n as unknown as Record<string, unknown>;
      if (kind && n.type !== kind) return false;
      if (subkind) {
        const sub = (r.subkind as string | undefined) ?? (r.kind as string | undefined);
        if (sub !== subkind) return false;
      }
      if (category && r.category !== category) return false;
      return true;
    });
  }
  // Relationship enrichment for the Graph UI: origin document + evidence
  // strength + per-node audience, so the client can draw node↔document edges
  // and show the sharing control without N+1 requests. One query, scoped to
  // this subfolder (not the whole workspace) — document_id, visibility, and
  // owner_user_id are all dedicated graph_nodes columns, not part of the
  // stored node JSON, so they can't come off `nodes` itself.
  const metaRows = await repo.listNodeMetaRows(ws, sg.id);
  const metaByNode = new Map(metaRows.map((r) => [r.id, r]));
  const evCounts = await repo.evidenceCounts(ws, sg.id);
  // `can_manage` is the client-side gate for showing an editable control. It
  // mirrors canManageNode in curation.ts: the node's owner or the workspace
  // owner tier; an ownerless (cloud-native) node is owner-tier only. In
  // single-user local mode everything is manageable.
  const viewer = viewerFor(c);
  const privileged = !viewer || await isWorkspaceOwnerTier(c, ws);
  const canManage = (owner: string | null): boolean =>
    privileged || (!!owner && owner === viewer);
  const enriched = nodes.map((n) => {
    const ev = evCounts.get(n.id);
    const meta = metaByNode.get(n.id);
    return {
      ...(n as object),
      document_id: meta?.document_id ?? null,
      evidence: ev ? { sources: ev.sources, latest: ev.latest } : null,
      visibility: meta?.visibility ?? 'team',
      owner_user_id: meta?.owner_user_id ?? null,
      can_manage: canManage(meta?.owner_user_id ?? null),
    };
  });
  return c.json({ nodes: enriched });
});

// Document registry (Connect UI): what was ingested, its summary, version,
// and stakeholders. Workspace-scoped like everything else. `downloadable`
// tells the UI whether GET /documents/:id/content can serve this one —
// false only for text-channel documents from before canonical-text
// persistence existed. `candidates` aggregates the document's extraction
// outcomes across every subgraph so the Sources list can show a per-source
// processing status (needs review / integrated / nothing extracted).
//
// Optional `?subgraph=<id>` narrows both the document list and its
// candidate counts to just that subgraph — via `document_routing` (§
// repo.listSubgraphDocuments), the same table the data-agent backfill path
// already reads. Without it, both stay workspace-wide (the default, used by
// the standalone Sources page, which deliberately spans every subfolder).
app.get('/workspaces/:ws/documents', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const subgraph_id = c.req.query('subgraph');
  const routedIds = subgraph_id
    ? new Set((await repo.listSubgraphDocuments(ws, subgraph_id)).map((r) => r.document_id))
    : null;
  const shaById = new Map(
    (
      await repo.listDocumentSha256Rows(ws)
    ).map((r) => [r.id, r.sha256]),
  );
  const sourceShas = new Set(
    (await repo.listSourceSha256Rows(ws)).map(
      (r) => r.sha256,
    ),
  );
  const candCounts = new Map<string, { pending: number; approved: number; rejected: number }>();
  for (const r of await repo.countCandidatesByDocumentStatus(ws, subgraph_id)) {
    const row = candCounts.get(r.document_id) ?? { pending: 0, approved: 0, rejected: 0 };
    if (r.status === 'pending') row.pending += r.n;
    // 'edited' is an approved candidate that was amended on the way in.
    else if (r.status === 'approved' || r.status === 'edited') row.approved += r.n;
    else if (r.status === 'rejected') row.rejected += r.n;
    candCounts.set(r.document_id, row);
  }
  const textFilenames = docTextFilenames(ws);
  // Audience: only documents the caller may read (repo.documentVisibilityFilter).
  const docs = (await repo
    .listDocuments(ws, { viewer: viewerFor(c) }))
    .filter((d) => !routedIds || routedIds.has(d.id))
    .map((d) => ({
      ...d,
      downloadable:
        textFilenames.has(`${d.id}-v${d.version}.txt`) || sourceShas.has(shaById.get(d.id) ?? ''),
      candidates: candCounts.get(d.id) ?? { pending: 0, approved: 0, rejected: 0 },
    }));
  return c.json({ documents: docs });
});
}
