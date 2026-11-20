// Routes: routing.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

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
// resolveIngestTargets / runTextIngest). Any workspace member can resolve
// one — this is a "validate where this goes" checkpoint, not an admin gate.

app.get('/workspaces/:ws/pending-routes', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const status = c.req.query('status') ?? 'pending';
  const rows = await repo.listPendingRoutes(ws, { status });
  return c.json({ pending_routes: rows });
});

app.post('/workspaces/:ws/pending-routes/:id/approve', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const result = await resolvePendingRoute(ws, c.req.param('id'), { action: 'approve', resolved_by: user_id });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post('/workspaces/:ws/pending-routes/:id/choose', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ target_ids: z.array(z.string().min(1)).min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const result = await resolvePendingRoute(ws, c.req.param('id'), {
    action: 'choose',
    chosen_target_ids: parsed.data.target_ids,
    resolved_by: user_id,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.post('/workspaces/:ws/pending-routes/:id/reject', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const result = await resolvePendingRoute(ws, c.req.param('id'), { action: 'reject', resolved_by: user_id });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result);
});
}
