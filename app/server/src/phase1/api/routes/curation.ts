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
} = core;
// ---------- candidates ----------

/**
 * Drop candidates the viewer may not see. A candidate shares its note's audience
 * (approve keeps proposed_node.id as the persisted node id); one with no note
 * yet falls back to its document's audience. Without this the Curate list read
 * the content and source quotes behind other members' private/only_me notes.
 */
async function candidatesVisibleTo<T extends { proposed_node: { id: string }; document_id?: string }>(
  ws: string,
  cands: T[],
  viewer: string | undefined,
): Promise<T[]> {
  if (!viewer || cands.length === 0) return cands;
  const access = await repo.getNodeAccessMap(ws, [...new Set(cands.map((k) => k.proposed_node.id))]);
  const docOk = new Map<string, boolean>();
  const out: T[] = [];
  for (const k of cands) {
    const a = access.get(k.proposed_node.id);
    if (a) {
      if (a.visibility === 'team' || (!!a.owner_user_id && a.owner_user_id === viewer)) out.push(k);
      continue;
    }
    if (!k.document_id) { out.push(k); continue; }
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
  // A subgraph selector (header or `?subgraph=`) scopes to that one subgraph —
  // preserves the single-subgraph isolation contract. With NO selector, the
  // list spans every subgraph: the unified Curate inbox + its pending badge
  // are workspace-wide. The web client drops the header on those calls.
  const hasSelector = c.req.query('subgraph') ?? c.req.header('x-subgraph-id');
  if (hasSelector) {
    const sg = await resolveSubgraph(c, ws);
    if (!sg) return c.json({ error: 'unknown folder' }, 400);
    return c.json({ candidates: await candidatesVisibleTo(ws, await repo.listCandidates(ws, { status }, sg.id), viewer) });
  }
  const ids = await subgraphIds(ws);
  const candidates = [];
  for (const id of ids) candidates.push(...await repo.listCandidates(ws, { status }, id));
  return c.json({ candidates: await candidatesVisibleTo(ws, candidates, viewer) });
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
  await repo.insertCandidate(ws, parsed.data, undefined, subgraph_id);
  return c.json({ ok: true });
});


// ===================== audience (visibility) controls =====================
// Change who can see a node, a document's nodes, or every node of a kind.
// All sharing/ACL enforcement is server-side.

/** Reject a visibility change by anyone but the node's owner (or a workspace admin). */
async function canManageNode(ws: string, node_id: string, user_id: string, role: string): Promise<boolean> {
  const v = await repo.getNodeVisibility(ws, node_id);
  if (!v) return false;
  if (!v.owner_user_id) return true; // cloud-native node, no owner gate
  return v.owner_user_id === user_id || role === 'workspace_admin';
}

const SyncVisibilityBody = z.object({
  visibility: z.enum(['team', 'private', 'only_me']),
});

// Change an already-published node's audience (no content re-push).
app.post('/workspaces/:ws/sync/nodes/:id/visibility', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  const node_id = c.req.param('id');
  if (!await canManageNode(ws, node_id, user_id, role)) return c.json({ error: 'forbidden' }, 403);
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  await repo.setNodeVisibility(ws, node_id, visibility, user_id, user_id);
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
  const role = c.get('role');
  const document_id = c.req.param('id');
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  const nodeIds = await repo.listNodeIdsByDocument(ws, document_id);
  if (nodeIds.length === 0) return c.json({ error: 'no nodes for document' }, 404);
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const node_id of nodeIds) {
    if (!await canManageNode(ws, node_id, user_id, role)) {
      skipped.push(node_id);
      continue;
    }
    await repo.setNodeVisibility(ws, node_id, visibility, user_id, user_id);
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
  const role = c.get('role');
  const kind = c.req.param('kind');
  const parsed = SyncVisibilityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { visibility } = parsed.data;
  const nodeIds = await repo.listNodeIdsByKind(ws, kind);
  if (nodeIds.length === 0) return c.json({ error: 'no nodes for kind' }, 404);
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const node_id of nodeIds) {
    if (!await canManageNode(ws, node_id, user_id, role)) {
      skipped.push(node_id);
      continue;
    }
    await repo.setNodeVisibility(ws, node_id, visibility, user_id, user_id);
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
