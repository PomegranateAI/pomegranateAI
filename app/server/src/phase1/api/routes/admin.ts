// Routes: admin.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { log } from '../../../lib/log.js';
import { generateTemporaryPassword, hashPassword, passwordPolicyError, isBreachedPassword } from '../../../lib/passwords.js';
import { accountInviteContent } from '../../mail/smtp.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import { capabilityUrlsEnabled } from '../../mcp/server.js';

export function registerAdmin(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  userEmail,
  clientIp,
  media,
  FILES_DIR,
  deliverEmail,
  PUBLIC_ORIGIN,
} = core;

// Email the account its sign-in address and temporary password. False when no
// mailer is configured or the send failed — the admin then hands the password
// over another way (it is shown to them either way).
async function emailAccountInvite(email: string, password: string, reset: boolean): Promise<boolean> {
  const origin = PUBLIC_ORIGIN?.split(',')[0]?.trim();
  const { subject, text } = accountInviteContent({ email, password, origin, reset });
  return deliverEmail(email, subject, text);
}
// System administration is deliberately separate from workspace_admin. The
// bootstrap script is the only way to grant this deployment-wide privilege.
async function systemAdmin(c: any): Promise<boolean> {
  const user = await repo.getUserById(c.get('user_id'));
  return user?.is_admin === 1;
}

app.get('/admin/users', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  return c.json({ users: await repo.listAdminUsers() });
});

app.post('/admin/users', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  // `password` is optional: left out, a random temporary one is generated.
  // `send_invite` emails the account its address and temporary password.
  const parsed = z.object({
    email: z.string().trim().email(),
    password: z.string().optional(),
    send_invite: z.boolean().optional(),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const emailBad = parsed.error.issues.some((issue) => issue.path[0] === 'email');
    return c.json({ error: emailBad ? 'invalid_email' : 'invalid_request' }, 400);
  }
  const email = parsed.data.email.toLowerCase();
  if (await repo.findUserByEmail(email)) return c.json({ error: 'user already exists' }, 409);
  const password = parsed.data.password?.trim() ? parsed.data.password : generateTemporaryPassword();
  const policyError = passwordPolicyError(password, { email });
  if (policyError) return c.json({ error: policyError }, 400);
  if (await isBreachedPassword(password)) return c.json({ error: 'password has appeared in a data breach; choose another' }, 400);
  const hash = await hashPassword(password);
  const user = await repo.tx(async () => {
    const created = await repo.findOrCreateUser(email);
    await repo.setPasswordHash(created.id, hash, { mustChange: true });
    return created;
  });
  const emailed = parsed.data.send_invite ? await emailAccountInvite(user.email, password, false) : false;
  log.info('admin.user_created', { actor: c.get('user_id'), user: user.id, invite: !!parsed.data.send_invite, emailed });
  // The temporary password goes back to the admin who set it (they may need
  // to pass it on by hand). It is never logged.
  return c.json({ user: { id: user.id, email: user.email }, temporary_password: password, emailed }, 201);
});

app.put('/admin/users/:id/password', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  const user = await repo.getUserById(c.req.param('id'));
  if (!user) return c.json({ error: 'user not found' }, 404);
  const parsed = z.object({ password: z.string().optional(), send_invite: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const password = parsed.data.password?.trim() ? parsed.data.password : generateTemporaryPassword();
  const policyError = passwordPolicyError(password, { email: user.email });
  if (policyError) return c.json({ error: policyError }, 400);
  if (await isBreachedPassword(password)) return c.json({ error: 'password has appeared in a data breach; choose another' }, 400);
  await repo.setPasswordHash(user.id, await hashPassword(password), { mustChange: true });
  await repo.deleteUserSessions(user.id);
  const emailed = parsed.data.send_invite ? await emailAccountInvite(user.email, password, true) : false;
  log.info('admin.password_reset', { actor: c.get('user_id'), user: user.id, invite: !!parsed.data.send_invite, emailed });
  return c.json({ ok: true, temporary_password: password, emailed });
});

/**
 * Set a user's Slack / WhatsApp identity directly (operator onboarding). The
 * self-service path requires a link code sent from the identity itself; a
 * system admin is trusted to have checked ownership out of band.
 */
app.put('/admin/users/:id/identities/:kind', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  const kind = c.req.param('kind');
  if (kind !== 'slack' && kind !== 'whatsapp') return c.json({ error: 'invalid kind' }, 400);
  const user = await repo.getUserById(c.req.param('id'));
  if (!user) return c.json({ error: 'user not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed =
    kind === 'slack'
      ? z.object({
          team_id: z.string().trim().min(1).optional(),
          external_id: z.string().trim().min(1),
          handle: z.string().trim().min(1).transform((s) => s.replace(/^@/, '')).optional(),
        }).safeParse(body)
      : z.object({ phone: z.string().trim().min(3) }).transform((d) => ({ external_id: d.phone, team_id: undefined, handle: undefined })).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  let identity;
  try {
    identity = await repo.upsertUserIdentity({
      user_id: user.id,
      kind,
      team_id: parsed.data.team_id ?? null,
      external_id: parsed.data.external_id,
      handle: parsed.data.handle ?? null,
    });
  } catch (err) {
    if ((err as Error).message === 'identity_claimed_by_other_user') {
      return c.json({ error: 'identity already linked to another user' }, 409);
    }
    if ((err as Error).message === 'invalid_external_id') return c.json({ error: 'invalid identity' }, 400);
    throw err;
  }
  for (const m of await repo.listMembershipsWithWorkspace(user.id)) {
    await repo.logCustomerAudit(m.id, {
      event: 'identity_linked',
      actor_user_id: c.get('user_id'),
      actor_email: await userEmail(c.get('user_id')),
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'user_identity',
      resource_id: identity.id,
      payload: { kind, external_id: identity.external_id, handle: identity.handle, via: 'admin', subject_user_id: user.id },
    });
  }
  log.info('admin.identity_set', { actor: c.get('user_id'), user: user.id, kind });
  return c.json({ identity });
});

app.get('/admin/users/:id/deletion', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  const user = await repo.getUserById(c.req.param('id'));
  if (!user) return c.json({ error: 'user not found' }, 404);
  return c.json({ user: { id: user.id, email: user.email }, owned_workspaces: await repo.listOwnedWorkspaces(user.email) });
});

app.delete('/admin/users/:id', authn, async (c) => {
  if (!await systemAdmin(c)) return c.json({ error: 'admin only' }, 403);
  const user = await repo.getUserById(c.req.param('id'));
  if (!user) return c.json({ error: 'user not found' }, 404);
  if (user.id === c.get('user_id')) return c.json({ error: 'cannot delete your own admin account' }, 400);
  const parsed = z.object({ confirm_email: z.string() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.confirm_email.toLowerCase() !== user.email.toLowerCase())
    return c.json({ error: 'email confirmation does not match' }, 400);
  const owned = await repo.listOwnedWorkspaces(user.email);
  // Owned directories are deleted with their data; shared directories where
  // this user is merely a member keep their shared content.
  for (const ws of owned) {
    await media.deleteWorkspace(ws.id);
    await repo.crypto.shredWorkspace(ws.id);
    await repo.deleteWorkspaceRows(ws.id);
    await fs.rm(path.join(FILES_DIR, ws.id), { recursive: true, force: true });
  }
  await repo.deleteAdminUser(user.id);
  log.info('admin.user_deleted', { actor: c.get('user_id'), user: user.id, owned_workspaces: owned.length });
  return c.json({ ok: true, deleted_workspaces: owned.length });
});
// ---------- MCP tokens (admin only) ----------

app.post('/workspaces/:ws/mcp-tokens', authn, workspaceGate, async (c) => {
  if (!capabilityUrlsEnabled()) return c.json({ error: 'oauth_required', hint: 'connect over OAuth at /mcp/server' }, 410);
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const { id, token } = await repo.issueMcpToken({ workspace_id: ws, user_id });
  await repo.logCustomerAudit(ws, {
    event: 'mcp_token_issued',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'mcp_token',
    resource_id: id,
  });
  return c.json({ id, token });
});

app.delete('/workspaces/:ws/mcp-tokens/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const id = c.req.param('id');
  await repo.revokeMcpToken(ws, id, user_id);
  await repo.logCustomerAudit(ws, {
    event: 'mcp_token_revoked',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'mcp_token',
    resource_id: id,
  });
  return c.json({ ok: true });
});

// ---------- claude.ai connectors (admin only) ----------
//
// A connector is a self-serve capability URL for claude.ai. Creation returns
// the secret path exactly once; the client turns it into a full URL against
// its own origin (https://<host>/mcp/connector/<secret>). Unlike the legacy
// static Caddy connectors this needs no infra change — the secret resolves
// in-app. Only the paste-into-claude.ai step stays manual (no claude.ai API).

app.post('/workspaces/:ws/connectors', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  if (!capabilityUrlsEnabled()) return c.json({ error: 'capability_urls_disabled', hint: 'connect over OAuth at /mcp/server' }, 410);
  const body = (await c.req.json().catch(() => ({}))) as { label?: string };
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : undefined;
  const { id, secret } = await repo.createConnector({ workspace_id: ws, user_id, label });
  await repo.logCustomerAudit(ws, {
    event: 'connector_created',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'claude_ai_connector',
    resource_id: id,
  });
  return c.json({ id, secret, path: `/mcp/connector/${secret}` });
});

app.get('/workspaces/:ws/connectors', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  return c.json({ connectors: await repo.listConnectors(ws) });
});

app.delete('/workspaces/:ws/connectors/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const role = c.get('role');
  if (role !== 'workspace_admin') return c.json({ error: 'admin only' }, 403);
  const id = c.req.param('id');
  await repo.revokeConnector(ws, id, user_id);
  await repo.logCustomerAudit(ws, {
    event: 'connector_revoked',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'claude_ai_connector',
    resource_id: id,
  });
  return c.json({ ok: true });
});

}
