// Routes: curation.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { writeWorkspaceFile } from '../../files/sealed-files.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Candidate } from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { DEFAULT_PROFILE_ID } from '../../../lib/profiles/index.js';
import { validateNode } from '../../../lib/profile-validate.js';
import { log } from '../../../lib/log.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerCuration(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  resolveSubgraph,
  repo,
  subgraphIds,
  profileFor,
  embedAndStoreNode,
  materializeUsePhaseRedaction,
  docTextPath,
  FILES_DIR,
  ruleWriteAllowed,
  userEmail,
  listShapeAutomations,
  viewerFor,
  isWorkspaceOwnerTier,
} = core;
// ---------- candidates ----------

/**
 * Drop candidates the viewer may not see. A candidate shares its note's audience
 * (approve keeps proposed_node.id as the persisted node id); one with no note
 * yet falls back to its document's audience. Without this the Curate list read
 * the content and source quotes behind other members' private/only_me notes.
 *
 * A candidate with no document has no audience to inherit, so it is visible
 * only to the member who submitted it (`created_by`) and to the workspace
 * owner tier (owner or workspace_admin). A hand-submitted candidate is gated
 * by its creator even when its proposed_node.id names an existing node, so a
 * member can't surface their text under someone else's team note. Legacy
 * document-less rows with no recorded creator are owner-tier only.
 */
async function candidatesVisibleTo<T extends { proposed_node: { id: string }; document_id?: string; created_by?: string }>(
  ws: string,
  cands: T[],
  viewer: string | undefined,
  privileged: boolean,
): Promise<T[]> {
  if (!viewer || cands.length === 0) return cands;
  const access = await repo.getNodeAccessMap(ws, [...new Set(cands.map((k) => k.proposed_node.id))]);
  const docOk = new Map<string, boolean>();
  const out: T[] = [];
  for (const k of cands) {
    if (!k.document_id && k.created_by) {
      if (privileged || k.created_by === viewer) out.push(k);
      continue;
    }
    const a = access.get(k.proposed_node.id);
    if (a) {
      if (a.visibility === 'team' || (!!a.owner_user_id && a.owner_user_id === viewer)) out.push(k);
      continue;
    }
    if (!k.document_id) { if (privileged) out.push(k); continue; }
    if (!docOk.has(k.document_id)) docOk.set(k.document_id, await repo.documentVisibleToViewer(ws, k.document_id, viewer));
    if (docOk.get(k.document_id)) out.push(k);
  }
  return out;
}

const CandidateStatus = z.enum(['pending', 'approved', 'rejected', 'edited']);

app.get('/workspaces/:ws/candidates', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const statusParsed = CandidateStatus.safeParse(c.req.query('status') ?? 'pending');
  if (!statusParsed.success) return c.json({ error: 'invalid', detail: 'status must be pending, approved, rejected or edited' }, 400);
  const status = statusParsed.data;
  const viewer = viewerFor(c);
  const privileged = !viewer || await isWorkspaceOwnerTier(c, ws);
  // A subgraph selector (header or `?subgraph=`) scopes to that one subgraph —
  // preserves the single-subgraph isolation contract. With NO selector, the
  // list spans every subgraph: the unified Curate inbox + its pending badge
  // are workspace-wide. The web client drops the header on those calls.
  const hasSelector = c.req.query('subgraph') ?? c.req.header('x-subgraph-id');
  if (hasSelector) {
    const sg = await resolveSubgraph(c, ws);
    if (!sg) return c.json({ error: 'unknown folder' }, 400);
    return c.json({ candidates: await candidatesVisibleTo(ws, await repo.listCandidates(ws, { status }, sg.id), viewer, privileged) });
  }
  const ids = await subgraphIds(ws);
  const candidates = [];
  for (const id of ids) candidates.push(...await repo.listCandidates(ws, { status }, id));
  return c.json({ candidates: await candidatesVisibleTo(ws, candidates, viewer, privileged) });
});

app.post('/workspaces/:ws/candidates', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const body = await c.req.json();
  const parsed = Candidate.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', details: parsed.error.format() }, 400);
  // Same subfolder-locality rule as POST /graph: validate and insert against the
  // subfolder this candidate belongs to, not the workspace default.
  const sgSel = await resolveSubgraph(c, ws);
  const subgraph_id = sgSel?.id ?? 'default';
  const kindErr = validateNode(await profileFor(ws, subgraph_id), parsed.data.proposed_node);
  if (kindErr) return c.json({ error: 'profile_mismatch', detail: kindErr }, 422);
  // Record the submitting member: a document-less candidate has no document
  // audience to inherit, so its creator (plus the owner tier) gates who sees it.
  await repo.insertCandidate(ws, parsed.data, undefined, subgraph_id, c.get('user_id'));
  return c.json({ ok: true });
});


// ===================== audience (visibility) controls =====================
// Change who can see a node, a document's nodes, or every node of a kind.
// All sharing/ACL enforcement is server-side.

/**
 * Who may change a node's audience: its owner, or the workspace owner tier
 * (owner or workspace_admin). An ownerless (cloud-native) node is owner-tier
 * only; letting any member change it would let them hide a shared note from
 * the whole team. `viewer` undefined = single-user local mode: permissive.
 * `privileged` is isWorkspaceOwnerTier for the caller, computed once per request.
 */
async function canManageNode(ws: string, node_id: string, viewer: string | undefined, privileged: boolean): Promise<boolean> {
  const v = await repo.getNodeVisibility(ws, node_id);
  if (!v) return false;
  if (!viewer || privileged) return true;
  return !!v.owner_user_id && v.owner_user_id === viewer;
}

/**
 * Change a node's audience on behalf of `actor` without claiming it. An
 * ownerless node is handed to its document's ingester (if recorded), the same
 * owner ingest would have assigned; otherwise it stays ownerless. The caller is
 * never made the owner just for changing the audience.
 */
async function changeNodeAudience(ws: string, node_id: string, visibility: 'team' | 'private' | 'only_me', actor: string): Promise<void> {
  await repo.setNodeVisibility(ws, node_id, visibility, await repo.getNodeIngester(ws, node_id), actor);
}

const SyncVisibilityBody = z.object({
  visibility: z.enum(['team', 'private', 'only_me']),
});

// Change an already-published node's audience (no content re-push).
app.post('/workspaces/:ws/sync/nodes/:id/visibility', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const node_id = c.req.param('id');
  const viewer = viewerFor(c);
  const privileged = !viewer || await isWorkspaceOwnerTier(c, ws);
  if (!await canManageNode(ws, node_id, viewer, privileged)) return c.json({ error: 'forbidden' }, 403);
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  await changeNodeAudience(ws, node_id, visibility, user_id);
  await materializeUsePhaseRedaction(ws, [node_id], visibility);
  return c.json({ ok: true, node_id, visibility });
});

// Set the audience of a WHOLE source at once — fan-out over every node
// extracted from the document (product decision: source sharing = bulk node
// sharing, reusing the node ACL; no separate document-visibility table). Each
// node is owner/admin-gated individually; nodes the caller can't manage are
// skipped and reported. Returns how many nodes changed.
app.post('/workspaces/:ws/sync/document/:id/visibility', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const document_id = c.req.param('id');
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  const nodeIds = await repo.listNodeIdsByDocument(ws, document_id);
  if (nodeIds.length === 0) return c.json({ error: 'no nodes for document' }, 404);
  const viewer = viewerFor(c);
  const privileged = !viewer || await isWorkspaceOwnerTier(c, ws);
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const node_id of nodeIds) {
    if (!await canManageNode(ws, node_id, viewer, privileged)) {
      skipped.push(node_id);
      continue;
    }
    await changeNodeAudience(ws, node_id, visibility, user_id);
    changed.push(node_id);
  }
  await materializeUsePhaseRedaction(ws, changed, visibility);
  log.info('sync.document_visibility_set', {
    workspace: ws,
    user: user_id,
    document_id,
    visibility,
    changed: changed.length,
    skipped: skipped.length,
  });
  return c.json({ ok: true, document_id, visibility, changed: changed.length, skipped: skipped.length, total: nodeIds.length });
});

// Set the audience of a WHOLE category (profile kind) at once — fan-out over
// every active node of that kind, mirroring the source fan-out above. Backs the
// per-category toggle in the Library. Each node is owner/admin-gated
// individually; nodes the caller can't manage are skipped and reported.
app.post('/workspaces/:ws/sync/kind/:kind/visibility', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const kind = c.req.param('kind');
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  const nodeIds = await repo.listNodeIdsByKind(ws, kind);
  if (nodeIds.length === 0) return c.json({ error: 'no nodes for kind' }, 404);
  const viewer = viewerFor(c);
  const privileged = !viewer || await isWorkspaceOwnerTier(c, ws);
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const node_id of nodeIds) {
    if (!await canManageNode(ws, node_id, viewer, privileged)) {
      skipped.push(node_id);
      continue;
    }
    await changeNodeAudience(ws, node_id, visibility, user_id);
    changed.push(node_id);
  }
  await materializeUsePhaseRedaction(ws, changed, visibility);
  log.info('sync.kind_visibility_set', {
    workspace: ws,
    user: user_id,
    kind,
    visibility,
    changed: changed.length,
    skipped: skipped.length,
  });
  return c.json({ ok: true, kind, visibility, changed: changed.length, skipped: skipped.length, total: nodeIds.length });
});

/** Short human-readable summary of a graph node — used in log lines so you
 * can see at a glance *what* just got approved without opening the DB. */
function summarizeNode(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'goal') return node.title ?? '';
  if (node.type === 'decision') return node.summary ?? '';
  return (node.body ?? '').toString();
}


const BulkBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });
}
