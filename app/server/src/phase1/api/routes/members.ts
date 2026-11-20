// Routes: members.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import { hasTwoStep } from './mfa.js';

export function registerMembers(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  userEmail,
  clientIp,
} = core;
// ---------- workspace members (share the workspace) ----------

app.get('/workspaces/:ws/members', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const owner = (await repo.getWorkspace(ws))?.owner_email.toLowerCase();
  const members = await repo.listWorkspaceMembers(ws);
  // is_owner lets the UI hide "Leave" / "Remove" for the one person who can't go.
  return c.json({ members: members.map((m) => ({ ...m, is_owner: m.email.toLowerCase() === owner })) });
});

app.get('/workspaces/:ws/ai-access', authn, workspaceGate, async (c) => {
  const workspace = await repo.getWorkspace(c.get('workspace_id'));
  return c.json({ ai_allowed: workspace?.ai_allowed !== 0 });
});

app.put('/workspaces/:ws/ai-access', authn, workspaceGate, async (c) => {
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const parsed = z.object({ ai_allowed: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const ws = c.get('workspace_id');
  const before = await repo.getWorkspace(ws);
  await repo.setWorkspaceAiAllowed(ws, parsed.data.ai_allowed);
  await repo.logCustomerAudit(ws, {
    event: 'ai_access_changed',
    actor_user_id: c.get('user_id'),
    actor_email: await userEmail(c.get('user_id')),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace',
    resource_id: ws,
    payload: { from: before?.ai_allowed !== 0, to: parsed.data.ai_allowed },
  });
  return c.json(parsed.data);
});

/**
 * Add a teammate to this workspace by email. Admin only. Creates the user if
 * they haven't signed in yet (findOrCreateUser), so you can invite ahead of
 * their first login. Idempotent-ish: re-adding an existing member is a 409.
 */
app.post('/workspaces/:ws/members', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const actor = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const parsed = z
    .object({
      email: z.string().email(),
      // 'viewer' = a member with view-and-ask access only (governance.ts).
      role: z.enum(['workspace_admin', 'leader', 'member', 'viewer']).default('member'),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const user = await repo.findOrCreateUser(parsed.data.email.toLowerCase());
  if (await repo.getMembership(ws, user.id)) return c.json({ error: 'already a member' }, 409);
  const viewer = parsed.data.role === 'viewer';
  await repo.addMember({ workspace_id: ws, user_id: user.id, role: parsed.data.role === 'viewer' ? 'member' : parsed.data.role });
  if (viewer) await repo.setMemberAccess(ws, user.id, 'member', true);
  await repo.logCustomerAudit(ws, {
    event: 'member_added',
    actor_user_id: actor,
    actor_email: await userEmail(actor),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'user',
    resource_id: user.id,
    payload: { email: user.email, role: parsed.data.role },
  });
  return c.json({ user_id: user.id, email: user.email, role: parsed.data.role });
});

/**
 * Change a member's access: role, or viewer (view and ask only). Admin only.
 * The owner stays an admin.
 */
app.patch('/workspaces/:ws/members/:userId', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const actor = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const parsed = z
    .object({ role: z.enum(['workspace_admin', 'leader', 'member', 'viewer']) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const target = c.req.param('userId');
  const before = await repo.getMembership(ws, target);
  if (!before) return c.json({ error: 'not a member' }, 404);
  const workspace = await repo.getWorkspace(ws);
  const targetUser = await repo.getUserById(target);
  if (workspace && targetUser && targetUser.email.toLowerCase() === workspace.owner_email.toLowerCase() && parsed.data.role !== 'workspace_admin') {
    return c.json({ error: 'the workspace owner stays an admin' }, 400);
  }
  const viewer = parsed.data.role === 'viewer';
  const role = parsed.data.role === 'viewer' ? 'member' : parsed.data.role;
  await repo.setMemberAccess(ws, target, role, viewer);
  await repo.logCustomerAudit(ws, {
    event: 'member_role_changed',
    actor_user_id: actor,
    actor_email: await userEmail(actor),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'user',
    resource_id: target,
    payload: { from: before.read_only ? 'viewer' : before.role, to: parsed.data.role },
  });
  return c.json({ user_id: target, role: parsed.data.role });
});

/**
 * Directory governance flags (governance.ts): sensitive (two-step required,
 * assistant connections off unless allowed) and read-only AI agents.
 * Read by any member; changed by admins only, audited.
 */
app.get('/workspaces/:ws/governance', authn, workspaceGate, async (c) => {
  const w = await repo.getWorkspace(c.get('workspace_id'));
  return c.json({
    sensitive: !!w?.sensitive,
    assistants_allowed: !!w?.assistants_allowed,
    agents_read_only: !!w?.agents_read_only,
  });
});

app.put('/workspaces/:ws/governance', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const actor = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const parsed = z
    .object({ sensitive: z.boolean(), assistants_allowed: z.boolean(), agents_read_only: z.boolean() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  // Turning sensitive on locks out every member without two-step — including
  // the admin doing it, who must have it first.
  if (parsed.data.sensitive && !(await hasTwoStep(repo, actor))) {
    return c.json({ error: 'turn on two-step verification before marking a directory sensitive' }, 400);
  }
  const before = await repo.getWorkspace(ws);
  await repo.setWorkspaceGovernance(ws, parsed.data);
  await repo.logCustomerAudit(ws, {
    event: 'governance_changed',
    actor_user_id: actor,
    actor_email: await userEmail(actor),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace',
    resource_id: ws,
    payload: {
      from: { sensitive: !!before?.sensitive, assistants_allowed: !!before?.assistants_allowed, agents_read_only: !!before?.agents_read_only },
      to: parsed.data,
    },
  });
  return c.json(parsed.data);
});

/**
 * AI-assistant connections (OAuth grants) that reach this directory. Admins
 * see and revoke everyone's; members see and revoke their own (deck B2:
 * "admins see every connection and revoke any of them").
 */
app.get('/workspaces/:ws/assistant-connections', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const isAdmin = c.get('role') === 'workspace_admin';
  const rows = (await repo.sql.query<any>(
    `SELECT g.id, g.user_id, u.email, cl.client_name, g.created_at,
            (SELECT MAX(t.created_at) FROM oauth_tokens t WHERE t.grant_id = g.id) AS last_used_at
       FROM oauth_grants g
       JOIN users u ON u.id = g.user_id
       JOIN oauth_clients cl ON cl.client_id = g.client_id
      WHERE g.revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(g.workspace_ids) j WHERE j.value = ?)
        AND (? = 1 OR g.user_id = ?)
      ORDER BY g.created_at DESC`,
    [ws, isAdmin ? 1 : 0, c.get('user_id')],
  )) as Array<{ id: string; user_id: string; email: string; client_name: string; created_at: string; last_used_at: string | null }>;
  return c.json({ connections: rows });
});

app.delete('/workspaces/:ws/assistant-connections/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const actor = c.get('user_id');
  const grant = (await repo.sql.one<any>(
    `SELECT id, user_id, client_id, workspace_ids FROM oauth_grants
      WHERE id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(workspace_ids) j WHERE j.value = ?)`,
    [c.req.param('id'), ws],
  )) as { id: string; user_id: string; client_id: string; workspace_ids: string } | undefined;
  if (!grant) return c.json({ error: 'not_found' }, 404);
  if (c.get('role') !== 'workspace_admin' && grant.user_id !== actor) return c.json({ error: 'admin only' }, 403);
  const now = new Date().toISOString();
  await repo.sql.exec(`UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [now, grant.id]);
  await repo.sql.exec(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`, [now, grant.id]);
  const actorEmail = await userEmail(actor);
  for (const w of JSON.parse(grant.workspace_ids) as string[]) {
    await repo.logCustomerAudit(w, {
      event: 'oauth_grant_revoked',
      actor_user_id: actor,
      actor_email: actorEmail,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'oauth_grant',
      resource_id: grant.id,
      payload: { client_id: grant.client_id, owner_user_id: grant.user_id, reason: actor === grant.user_id ? 'user_revoked' : 'admin_revoked' },
    });
  }
  return c.json({ ok: true });
});

/**
 * Remove a teammate from this workspace. Admins can remove anyone; any member
 * can remove themselves ("Leave directory"). The workspace owner cannot be
 * removed or leave (they always retain access), and the last admin cannot
 * leave, so a directory is never left without one.
 */
app.delete('/workspaces/:ws/members/:userId', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const actor = c.get('user_id');
  const target = c.req.param('userId');
  const self = target === actor;
  if (!self && c.get('role') !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const workspace = await repo.getWorkspace(ws);
  const targetUser = await repo.getUserById(target);
  if (workspace && targetUser && targetUser.email.toLowerCase() === workspace.owner_email.toLowerCase()) {
    return c.json({ error: self ? 'the directory owner cannot leave it' : 'cannot remove the workspace owner' }, 400);
  }
  const membership = await repo.getMembership(ws, target);
  if (!membership) return c.json({ error: 'not a member' }, 404);
  if (membership.role === 'workspace_admin') {
    const admins = (await repo.listWorkspaceMembers(ws)).filter((m) => m.role === 'workspace_admin');
    if (admins.length <= 1) return c.json({ error: 'the last admin cannot be removed' }, 400);
  }
  await repo.removeMember(ws, target);
  await repo.logCustomerAudit(ws, {
    event: 'member_removed',
    actor_user_id: actor,
    actor_email: await userEmail(actor),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'user',
    resource_id: target,
    payload: { reason: self ? 'left' : 'removed_by_admin' },
  });
  return c.json({ ok: true });
});
}
