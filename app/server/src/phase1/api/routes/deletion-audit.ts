// Routes: deletion-audit.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { log } from '../../../lib/log.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerDeletionAudit(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  userEmail,
  clientIp,
  media,
  FILES_DIR,
} = core;
// ---------- workspace deletion ----------

/**
 * Delete a workspace and all of its data. Workspace Admin only. Wipes:
 *   - every workspace-scoped table row (graph_nodes, candidates, reviews,
 *     sources, mcp_tokens, slack_channels, synth_cache, audit_log,
 *     customer_audit_log, memberships, workspaces)
 *   - on-disk files under FILES_DIR/<workspace_id>/
 *
 * The PRD's "data deletion path, end-to-end documented and tested" gate.
 * Writes a final `workspace_deleted` customer-audit row BEFORE the wipe so
 * the actor sees their own action in any audit they pulled prior; the row
 * is then erased with the rest. (The actor must keep their own copy of the
 * export if they need post-deletion proof; that's the customer-managed
 * retention pattern.)
 */
app.delete('/workspaces/:ws', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);

  await repo.logCustomerAudit(ws, {
    event: 'workspace_deleted',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace',
    resource_id: ws,
  });

  await media.deleteWorkspace(ws);
  // Crypto-shred first: with sealing on, destroying the workspace's keys makes
  // every sealed copy unreadable, including ones in backups.
  await repo.crypto.shredWorkspace(ws);
  const counts = await repo.deleteWorkspaceRows(ws);
  // Files on disk: scoped to FILES_DIR/<workspace_id>/. Best-effort; missing
  // dir is fine. We don't traverse outside the workspace dir.
  const wsFilesDir = path.join(FILES_DIR, ws);
  await fs.rm(wsFilesDir, { recursive: true, force: true });

  return c.json({ ok: true, deleted: counts });
});

// ---------- audit ----------

app.get('/workspaces/:ws/audit', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  return c.json({ entries: await repo.listAudit(ws, 200) });
});

// Customer-facing audit log. Workspace Admin only. JSON by default; ?format=csv
// returns a stable column order suitable for ingestion into a SIEM.
app.get('/workspaces/:ws/customer-audit', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);

  const since = c.req.query('since') ?? undefined;
  const event = c.req.query('event') ?? undefined;
  const limit = Number(c.req.query('limit') ?? 1000);
  const format = c.req.query('format') ?? 'json';
  // Paging cursor: rows older than this id. Absent = the first page.
  const before = Number(c.req.query('before')) || undefined;

  // Log the export FIRST so the act of pulling the audit log is itself
  // visible in the returned rows. Customers expect to see "you exported at T"
  // when they pull the log; logging after the read would hide that. Later
  // pages of the same view (`before` set) aren't logged again — one read of
  // the log is one event, not one per page turned.
  if (!before) {
    await repo.logCustomerAudit(ws, {
      event: 'audit_log_exported',
      actor_user_id: user_id,
      actor_email: await userEmail(user_id),
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      payload: { format, since, event_filter: event },
    });
  }
  const rows = await repo.listCustomerAudit(ws, {
    since,
    event: event as any,
    limit,
    before,
  });

  if (format === 'csv') {
    const header =
      'id,created_at,event,actor_user_id,actor_email,source_ip,user_agent,resource_type,resource_id,payload';
    const lines = rows.map((r) =>
      [
        r.id,
        r.created_at,
        r.event,
        r.actor_user_id ?? '',
        r.actor_email ?? '',
        r.source_ip ?? '',
        r.user_agent ?? '',
        r.resource_type ?? '',
        r.resource_id ?? '',
        r.payload ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    const body = [header, ...lines].join('\n');
    return c.body(body, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="customer-audit-${ws}.csv"`,
    });
  }
  return c.json({ entries: rows, total: await repo.countCustomerAudit(ws, { since, event: event as any }) });
});

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
}
