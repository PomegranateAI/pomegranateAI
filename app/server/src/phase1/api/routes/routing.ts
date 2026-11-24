// Routes: routing.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import { pendingRouteResolvableBy } from '../../db/repo.js';

export function registerRouting(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  resolvePendingRoute,
} = core;
// ---------- pending routes (routing approval) ----------
//
// A routing decision the router could not auto-apply: it wants to create a
// new folder, or picked an existing one it had nothing to go on (see
// resolveIngestTargets / runTextIngest). Visibility follows the held
// document's audience: its ingester and admins/owner always see it, other
// members only when it is team-audience (repo.pendingRouteVisibleTo). Only
// the ingester or an admin/owner may resolve it — enforced inside
// resolvePendingRoute so REST and MCP share the gate.

app.get('/workspaces/:ws/pending-routes', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const status = c.req.query('status') ?? 'pending';
  const viewer = await repo.pendingRouteViewer(ws, c.get('user_id'), c.get('role'));
  const rows = await repo.listPendingRoutes(ws, { status, viewer });
  // `can_resolve` so the UI never guesses who may act; the ingester's email
  // so a read-only row can say who it is waiting on.
  const emails = new Map<string, string | null>();
  for (const r of rows) {
    if (r.ingested_by && !emails.has(r.ingested_by)) {
      emails.set(r.ingested_by, (await repo.getUserEmailRow(r.ingested_by))?.email ?? null);
    }
  }
  const pending_routes = rows.map((r) => ({
    ...r,
    ingested_by_email: r.ingested_by ? emails.get(r.ingested_by) ?? null : null,
    can_resolve: pendingRouteResolvableBy(r, viewer),
  }));
  return c.json({ pending_routes });
});

app.post('/workspaces/:ws/pending-routes/:id/approve', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const actor = await repo.pendingRouteViewer(ws, user_id, c.get('role'));
  const result = await resolvePendingRoute(ws, c.req.param('id'), { action: 'approve', resolved_by: user_id }, actor);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post('/workspaces/:ws/pending-routes/:id/choose', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ target_ids: z.array(z.string().min(1)).min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const actor = await repo.pendingRouteViewer(ws, user_id, c.get('role'));
  const result = await resolvePendingRoute(ws, c.req.param('id'), {
    action: 'choose',
    chosen_target_ids: parsed.data.target_ids,
    resolved_by: user_id,
  }, actor);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post('/workspaces/:ws/pending-routes/:id/reject', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const actor = await repo.pendingRouteViewer(ws, user_id, c.get('role'));
  const result = await resolvePendingRoute(ws, c.req.param('id'), { action: 'reject', resolved_by: user_id }, actor);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});
}
