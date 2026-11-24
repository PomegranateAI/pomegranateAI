// Routes: me.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { log } from '../../../lib/log.js';
import { hashPassword, verifyPassword, passwordPolicyError, isBreachedPassword } from '../../../lib/passwords.js';
import { composioConfigured } from '../../../lib/composio.js';
import { listGithubBranches } from '../github-live.js';
import { TokenBucketLimiter } from '../rate-limit.js';
import {
  LINK_CODE_TTL_MS,
  LINK_KINDS,
  linkInstructions,
  mintLinkCode,
  unverifiedIdentityLinkAllowed,
  type LinkKind,
} from '../identity-link.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import type { ComposioConnectorSpec } from './types.js';

export function registerMe(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  repo,
  userEmail,
  clientIp,
  logAccountAudit,
  COMPOSIO_CONNECTORS,
  PUBLIC_ORIGIN,
  requestWorkspaceAccess,
} = core;
// ---------- me: profile, linked identities, default folder ----------

/**
 * The caller's own profile: display name, linked external identities, and
 * per-surface default-folder pointers. Everything the Setup "Profile" and
 * "Default folder" cards need in one call.
 */
app.get('/me', authn, async (c) => {
  const user_id = c.get('user_id');
  const me = await repo.getUserById(user_id);
  if (!me) return c.json({ error: 'unknown user' }, 401);
  return c.json({
    user_id,
    email: me.email,
    is_admin: me.is_admin === 1,
    display_name: me.display_name ?? null,
    assistant_nickname: me.assistant_nickname ?? null,
    has_password: await repo.hasPassword(user_id),
    password_must_change: await repo.passwordMustChange(user_id),
    identities: await repo.listUserIdentities(user_id),
    defaults: await repo.listUserDefaults(user_id),
  });
});

app.patch('/me', authn, async (c) => {
  const user_id = c.get('user_id');
  const parsed = z
    .object({
      display_name: z.string().trim().max(80).nullable().optional(),
      // The caller's own wake name for the assistant on chat surfaces. Letters
      // and digits, single spaces or hyphens between them — so "Mango" reads as
      // an address and punctuation-only names are rejected. null/'' clears it.
      assistant_nickname: z
        .string()
        .trim()
        .max(24)
        .nullable()
        .optional()
        .refine(
          (v) => v == null || v === '' || (v.length >= 2 && /^[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u.test(v)),
          { message: 'invalid nickname' },
        ),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const me = await repo.getUserById(user_id);
  if (!me) return c.json({ error: 'unknown user' }, 401);

  let display_name = me.display_name ?? null;
  if (parsed.data.display_name !== undefined) {
    display_name = parsed.data.display_name === '' ? null : parsed.data.display_name;
    await repo.updateUserDisplayName(user_id, display_name);
  }
  let assistant_nickname = me.assistant_nickname ?? null;
  if (parsed.data.assistant_nickname !== undefined) {
    assistant_nickname = parsed.data.assistant_nickname === '' ? null : parsed.data.assistant_nickname;
    await repo.updateUserAssistantNickname(user_id, assistant_nickname);
  }
  return c.json({ ok: true, display_name, assistant_nickname });
});

/**
 * Set or change the caller's own password. `current_password` is required
 * whenever one is already set (a rotation, not a takeover of a password an
 * admin provisioned); omit it only the first time, when hasPassword() is
 * still false. Never touches the magic-link path — this only ever adds or
 * updates the row in user_passwords.
 */
app.put('/me/password', authn, async (c) => {
  const user_id = c.get('user_id');
  const parsed = z
    .object({ current_password: z.string().optional(), new_password: z.string() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const existingHash = await repo.getPasswordHash(user_id);
  if (existingHash) {
    const ok = !!parsed.data.current_password && (await verifyPassword(parsed.data.current_password, existingHash));
    if (!ok) return c.json({ error: 'invalid_current_password' }, 401);
  }
  const me = await repo.getUserById(user_id);
  const policyError = passwordPolicyError(parsed.data.new_password, { email: me?.email });
  if (policyError) return c.json({ error: policyError }, 400);
  if (await isBreachedPassword(parsed.data.new_password)) {
    return c.json({ error: 'password has appeared in a data breach; choose another' }, 400);
  }
  // Re-using the administrator-set password doesn't count as changing it.
  if (existingHash && (await repo.passwordMustChange(user_id)) && (await verifyPassword(parsed.data.new_password, existingHash))) {
    return c.json({ error: 'choose a new password, not the one you were given' }, 400);
  }
  await repo.setPasswordHash(user_id, await hashPassword(parsed.data.new_password));
  // A password change ends every other session: if the old password leaked,
  // whoever used it is signed out. The session making the change stays.
  const revoked = await repo.deleteUserSessions(user_id, { except: c.req.header('Authorization')?.slice(7) });
  const user = await repo.getUserById(user_id);
  if (user) await logAccountAudit(c, user, 'password_changed', { first_password: !existingHash, other_sessions_revoked: revoked });
  return c.json({ ok: true });
});

// Link-code minting: 10 per hour per user (burst 10, one back every 6 min).
const linkCodeLimiter = new TokenBucketLimiter({ capacity: 10, refillIntervalMs: 6 * 60_000 });

/**
 * Mint a single-use code that links a Slack account / WhatsApp number to the
 * caller once it is sent to the bot FROM that identity (redeemed in the
 * surface relay, see identity-link.ts). 10 minutes; a new code replaces any
 * earlier unused one for the same kind. Only a hash is stored.
 */
app.post('/me/identities/:kind/link-code', authn, async (c) => {
  const kind = c.req.param('kind') as LinkKind;
  if (!LINK_KINDS.includes(kind)) return c.json({ error: 'invalid kind' }, 400);
  const user_id = c.get('user_id');
  if (!linkCodeLimiter.take(user_id)) {
    c.header('Retry-After', String(linkCodeLimiter.retryAfterSec(user_id)));
    return c.json({ error: 'rate_limited' }, 429);
  }
  const code = mintLinkCode();
  const expires_at = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  await repo.createIdentityLinkCode(user_id, kind, code, expires_at);
  log.info('identity.link_code_minted', { user: user_id, kind });
  return c.json({ code, expires_at, instructions: linkInstructions(kind, code) });
});

/**
 * Direct linking without proof of ownership is off unless the deployment
 * allows it (POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK=1, local/dev) or the
 * caller is a system admin. Everyone else links with a code.
 */
async function directLinkAllowed(user_id: string): Promise<boolean> {
  if (unverifiedIdentityLinkAllowed()) return true;
  return (await repo.getUserById(user_id))?.is_admin === 1;
}

/**
 * Unlink the caller's own identities of one kind (all Slack accounts, or the
 * WhatsApp number). Afterwards that identity is unmapped and can be linked
 * again — by anyone who controls it — with a fresh code.
 */
app.delete('/me/identities/:kind', authn, async (c) => {
  const kind = c.req.param('kind') as LinkKind;
  if (!LINK_KINDS.includes(kind)) return c.json({ error: 'invalid kind' }, 400);
  const user_id = c.get('user_id');
  const removed = await repo.deleteUserIdentities(user_id, kind);
  if (removed > 0) {
    for (const m of await repo.listMembershipsWithWorkspace(user_id)) {
      await repo.logCustomerAudit(m.id, {
        event: 'identity_unlinked',
        actor_user_id: user_id,
        actor_email: await userEmail(user_id),
        source_ip: clientIp(c),
        user_agent: c.req.header('user-agent') ?? undefined,
        resource_type: 'user_identity',
        resource_id: `${user_id}:${kind}`,
        payload: { kind, removed },
      });
    }
  }
  return c.json({ ok: true, removed });
});

/**
 * Link the caller's Slack identity directly (no proof of ownership — gated,
 * see directLinkAllowed; the normal path is a link code). Surfaces resolve
 * "@handle"/U-ids to users through this, replacing the Slack bot's static
 * mapping file. Claiming an identity another user already holds is a 409.
 */
app.put('/me/identities/slack', authn, async (c) => {
  const user_id = c.get('user_id');
  if (!(await directLinkAllowed(user_id))) {
    return c.json({ error: 'verification_required', detail: 'use a link code' }, 403);
  }
  const parsed = z
    .object({
      team_id: z.string().trim().min(1).optional(),
      external_id: z.string().trim().min(1),
      handle: z
        .string()
        .trim()
        .min(1)
        .transform((s) => s.replace(/^@/, ''))
        .optional(),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  let identity;
  try {
    identity = await repo.upsertUserIdentity({
      user_id,
      kind: 'slack',
      team_id: parsed.data.team_id ?? null,
      external_id: parsed.data.external_id,
      handle: parsed.data.handle ?? null,
    });
  } catch (err) {
    if ((err as Error).message === 'identity_claimed_by_other_user') {
      return c.json({ error: 'identity already linked to another user' }, 409);
    }
    throw err;
  }
  // Identity linking changes who a surface resolves to — audit it against
  // every workspace the user belongs to so each owner's log shows it.
  for (const m of await repo.listMembershipsWithWorkspace(user_id)) {
    await repo.logCustomerAudit(m.id, {
      event: 'identity_linked',
      actor_user_id: user_id,
      actor_email: await userEmail(user_id),
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'user_identity',
      resource_id: identity.id,
      payload: { kind: 'slack', external_id: identity.external_id, handle: identity.handle },
    });
  }
  return c.json({ identity });
});

/**
 * Link the caller's WhatsApp identity directly (gated like the Slack PUT). The whatsapp surface
 * resolves an inbound message's sender phone number to a user through this,
 * the same way `/me/identities/slack` backs the Slack relay. `phone` is
 * normalized to digits-only (see normalizePhoneDigits) so "+1 415 555 0100"
 * and the webhook's "14155550100@s.whatsapp.net" agree. No team_id — one bot
 * number serves the whole org, so identities aren't team-scoped.
 */
app.put('/me/identities/whatsapp', authn, async (c) => {
  const user_id = c.get('user_id');
  if (!(await directLinkAllowed(user_id))) {
    return c.json({ error: 'verification_required', detail: 'use a link code' }, 403);
  }
  const parsed = z
    .object({ phone: z.string().trim().min(3) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  let identity;
  try {
    identity = await repo.upsertUserIdentity({
      user_id,
      kind: 'whatsapp',
      team_id: null,
      external_id: parsed.data.phone,
    });
  } catch (err) {
    if ((err as Error).message === 'identity_claimed_by_other_user') {
      return c.json({ error: 'identity already linked to another user' }, 409);
    }
    if ((err as Error).message === 'invalid_external_id') {
      return c.json({ error: 'invalid phone number' }, 400);
    }
    throw err;
  }
  for (const m of await repo.listMembershipsWithWorkspace(user_id)) {
    await repo.logCustomerAudit(m.id, {
      event: 'identity_linked',
      actor_user_id: user_id,
      actor_email: await userEmail(user_id),
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'user_identity',
      resource_id: identity.id,
      payload: { kind: 'whatsapp', external_id: identity.external_id },
    });
  }
  return c.json({ identity });
});

/**
 * Set the caller's default folder for a surface ('all' | 'slack' | 'mcp' |
 * 'whatsapp'). Membership in the target workspace is required — a default is
 * a pointer other surfaces resolve, never a grant.
 */
app.put('/me/defaults/:surface', authn, async (c) => {
  const user_id = c.get('user_id');
  const surface = c.req.param('surface');
  if (!['all', 'slack', 'mcp', 'whatsapp'].includes(surface)) return c.json({ error: 'invalid surface' }, 400);
  const parsed = z
    .object({ workspace_id: z.string().min(1), subgraph_id: z.string().min(1).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  if (!await repo.getMembership(parsed.data.workspace_id, user_id)) {
    return c.json({ error: 'not a member of that directory' }, 403);
  }
  const dflt = await repo.setUserDefault(
    user_id,
    surface as 'all' | 'slack' | 'mcp' | 'whatsapp',
    parsed.data.workspace_id,
    parsed.data.subgraph_id ?? null,
  );
  await repo.logCustomerAudit(parsed.data.workspace_id, {
    event: 'default_folder_set',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace',
    resource_id: parsed.data.workspace_id,
    payload: { surface },
  });
  return c.json({ default: dflt });
});

app.delete('/me/defaults/:surface', authn, async (c) => {
  const user_id = c.get('user_id');
  const surface = c.req.param('surface');
  if (!['all', 'slack', 'mcp', 'whatsapp'].includes(surface)) return c.json({ error: 'invalid surface' }, 400);
  await repo.clearUserDefault(user_id, surface as 'all' | 'slack' | 'mcp' | 'whatsapp');
  return c.json({ ok: true });
});

app.get('/me/apps/:toolkit', authn, async (c) => {
  const toolkit = c.req.param('toolkit');
  if (!COMPOSIO_CONNECTORS[toolkit]) return c.json({ error: 'unknown_toolkit' }, 404);
  const user_id = c.get('user_id');
  const conn = await repo.getUserComposioConnection(user_id, toolkit);
  return c.json({ configured: conn?.status === 'active', status: conn?.status ?? null });
});

/** Picker items for the Add Sources UI — e.g. repos for github, channels for slack. */
app.get('/me/apps/:toolkit/picker', authn, async (c) => {
  const toolkit = c.req.param('toolkit');
  const spec = COMPOSIO_CONNECTORS[toolkit];
  if (!spec) return c.json({ error: 'unknown_toolkit' }, 404);
  const user_id = c.get('user_id');
  const conn = await repo.getUserComposioConnection(user_id, toolkit);
  if (conn?.status !== 'active') return c.json({ error: 'not_connected' }, 400);
  try {
    const items = await spec.listPickerItems(user_id, conn.connected_account_id);
    return c.json({ items });
  } catch (err) {
    return c.json(
      { error: `${toolkit}_picker_failed`, detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Branches for a repo — a second-level picker (repo -> branch), not part of
 * the generic ComposioConnectorSpec.listPickerItems shape since it needs an
 * extra `repo` param no other toolkit's picker does. GitHub-specific, same
 * way gmail's routes sit alongside the generic :toolkit family.
 */
app.get('/me/apps/github/branches', authn, async (c) => {
  const user_id = c.get('user_id');
  const conn = await repo.getUserComposioConnection(user_id, 'github');
  if (conn?.status !== 'active') return c.json({ error: 'not_connected' }, 400);
  const repoParam = c.req.query('repo');
  if (!repoParam) return c.json({ error: 'repo_required' }, 400);
  try {
    const branches = await listGithubBranches(user_id, conn.connected_account_id, repoParam);
    return c.json({ branches });
  } catch (err) {
    return c.json(
      { error: 'github_branches_failed', detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Start a connection: mints a Composio Connect link and returns it for the
 * client to redirect the browser to. callback_url is supplied by the caller
 * (Add Sources threads it back to itself, not Settings — see Sources.tsx);
 * falling back to the bare origin only if the client omitted it. The OAuth
 * redirect completing is never trusted as proof by itself — POST .../refresh
 * always re-checks live status against Composio afterward.
 */
app.post('/me/apps/:toolkit/connect', authn, async (c) => {
  const toolkit = c.req.param('toolkit');
  const spec = COMPOSIO_CONNECTORS[toolkit];
  if (!spec) return c.json({ error: 'unknown_toolkit' }, 404);
  if (!composioConfigured()) return c.json({ error: 'composio_not_configured' }, 501);
  const user_id = c.get('user_id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ callback_url: z.string().url().optional() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const callbackUrl =
    parsed.data.callback_url ?? (PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN.split(',')[0]!.trim()}/` : undefined);
  try {
    const { connectedAccountId, redirectUrl } = await spec.startConnect(repo, user_id, callbackUrl);
    await repo.upsertUserComposioConnection(user_id, toolkit, connectedAccountId, 'initiated');
    return c.json({ redirect_url: redirectUrl });
  } catch (err) {
    return c.json(
      { error: `${toolkit}_connect_failed`, detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Live status re-check — called by the Add Sources page right after the
 * OAuth redirect returns (and on demand). Never trust the redirect alone:
 * Composio is the source of truth for whether the token exchange succeeded.
 */
app.post('/me/apps/:toolkit/refresh', authn, async (c) => {
  const toolkit = c.req.param('toolkit');
  const spec = COMPOSIO_CONNECTORS[toolkit];
  if (!spec) return c.json({ error: 'unknown_toolkit' }, 404);
  const user_id = c.get('user_id');
  const conn = await repo.getUserComposioConnection(user_id, toolkit);
  if (!conn) return c.json({ configured: false, status: null });
  try {
    const status = await spec.refreshStatus(conn.connected_account_id);
    await repo.upsertUserComposioConnection(user_id, toolkit, conn.connected_account_id, status);
    if (status === 'active') {
      for (const m of await repo.listMembershipsWithWorkspace(user_id)) {
        await repo.logCustomerAudit(m.id, {
          event: 'app_connected',
          actor_user_id: user_id,
          actor_email: await userEmail(user_id),
          source_ip: clientIp(c),
          user_agent: c.req.header('user-agent') ?? undefined,
          resource_type: 'user_composio_connection',
          resource_id: `${user_id}:${toolkit}`,
          payload: { app: toolkit },
        });
      }
    }
    return c.json({ configured: status === 'active', status });
  } catch (err) {
    return c.json(
      { error: `${toolkit}_status_check_failed`, detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

app.delete('/me/apps/:toolkit', authn, async (c) => {
  const toolkit = c.req.param('toolkit');
  const spec = COMPOSIO_CONNECTORS[toolkit];
  if (!spec) return c.json({ error: 'unknown_toolkit' }, 404);
  const user_id = c.get('user_id');
  const conn = await repo.getUserComposioConnection(user_id, toolkit);
  if (conn) {
    try {
      await spec.disconnect(conn.connected_account_id);
    } catch (err) {
      log.warn('composio.disconnect_failed', { toolkit, user: user_id, error: String(err) });
    }
    await repo.deleteUserComposioConnection(user_id, toolkit);
  }
  for (const m of await repo.listMembershipsWithWorkspace(user_id)) {
    await repo.logCustomerAudit(m.id, {
      event: 'app_disconnected',
      actor_user_id: user_id,
      actor_email: await userEmail(user_id),
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'user_composio_connection',
      resource_id: `${user_id}:${toolkit}`,
      payload: { app: toolkit },
    });
  }
  return c.json({ ok: true });
});

app.post('/workspaces/:ws/request-access', authn, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { message?: string };
  const r = await requestWorkspaceAccess({
    // The reserved eval workspace is code-only — an unknown id is a plain 404,
    // so we never acknowledge it either way.
    workspace_id: c.req.param('ws'),
    user_id: c.get('user_id'),
    message: body.message,
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
  });
  if (!r.ok) {
    const message =
      r.error === 'unknown_user'
        ? 'unknown user'
        : r.error === 'not_found'
          ? 'not found'
          : r.error === 'already_member'
            ? 'already a member'
            : 'forbidden';
    return c.json({ error: message }, r.status);
  }
  return c.json(r.sent ? { sent: true } : { sent: false, preview: r.preview });
});
}
