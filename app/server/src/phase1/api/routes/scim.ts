// Routes: SCIM 2.0 user deprovisioning.
//
// Lets the organisation's identity provider (Microsoft Entra ID provisioning) disable a
// leaver in Pomegranate the moment they are disabled or unassigned there:
// web sessions, MCP tokens, claude.ai connector links and assistant (OAuth)
// connections all end at once (repo.disableUser). Re-activating restores
// access; memberships are kept.
//
// Tenant URL for the provider: <PUBLIC_ORIGIN>/api/scim/v2
// Secret token: SCIM_TOKEN (or SCIM_TOKEN_FILE, a Docker secret).
// Minimal surface: Users list/filter by userName, get, create (account only —
// directory membership stays an admin decision), PATCH/PUT active, DELETE.
// Google Workspace has no SCIM to custom apps: there, leavers rely on short
// SSO sessions plus removal in Pomegranate (recurring-operations OPS-EVT-01).

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Hono } from 'hono';
import { log } from '../../../lib/log.js';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimToken(): string | undefined {
  if (process.env.SCIM_TOKEN_FILE) {
    try {
      return readFileSync(process.env.SCIM_TOKEN_FILE, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return process.env.SCIM_TOKEN || undefined;
}

function truthy(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' ? true : v.toLowerCase() === 'false' ? false : undefined;
  return undefined;
}

export function registerScim(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
  const { repo, clientIp, authGuard } = core;

  const err = (c: any, status: number, detail: string) =>
    c.json({ schemas: [SCHEMA_ERROR], status: String(status), detail }, status, { 'content-type': 'application/scim+json' });

  const authorized = (presented: string | undefined): boolean => {
    const expected = scimToken();
    if (!expected || !presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const toScim = (u: { id: string; email: string; disabled_at?: string | null; created_at: string }) => ({
    schemas: [SCHEMA_USER],
    id: u.id,
    userName: u.email,
    emails: [{ value: u.email, primary: true }],
    active: !u.disabled_at,
    meta: { resourceType: 'User', created: u.created_at },
  });

  const userRow = async (id: string) =>
    (await repo.sql.one<any>(`SELECT id, email, disabled_at, created_at FROM users WHERE id = ?`, [id])) as
      | { id: string; email: string; disabled_at: string | null; created_at: string }
      | undefined;

  const setActive = async (c: any, user: { id: string; email: string }, active: boolean) => {
    const wasDisabled = await repo.isUserDisabled(user.id);
    if (active === !wasDisabled) return;
    const revoked = active ? undefined : await repo.disableUser(user.id);
    if (active) await repo.enableUser(user.id);
    for (const w of await repo.listMembershipWorkspaceIds(user.id)) {
      await repo.logCustomerAudit(w.workspace_id, {
        event: active ? 'account_enabled' : 'account_disabled',
        actor_email: 'identity-provider (SCIM)',
        source_ip: clientIp(c),
        resource_type: 'user',
        resource_id: user.id,
        payload: { email: user.email, ...(revoked ?? {}) },
      });
    }
    log.info(active ? 'scim.user_enabled' : 'scim.user_disabled', { user: user.id, ...(revoked ?? {}) });
  };

  app.use('/scim/v2/*', async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const { value: ok, limited } = await authGuard.check(c, presented, () => authorized(presented));
    if (limited) return limited;
    if (!ok) return err(c, 401, 'invalid or missing SCIM token');
    await next();
  });

  app.get('/scim/v2/ServiceProviderConfig', (c) =>
    c.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 100 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'SCIM_TOKEN' }],
    }),
  );

  app.get('/scim/v2/Users', async (c) => {
    const filter = c.req.query('filter') ?? '';
    const m = /^userName\s+eq\s+"([^"]+)"$/i.exec(filter.trim());
    let rows: Array<{ id: string; email: string; disabled_at: string | null; created_at: string }> = [];
    if (m) {
      const u = await repo.findUserByEmail(m[1]!.toLowerCase());
      const row = u ? await userRow(u.id) : undefined;
      if (row) rows = [row];
    } else if (filter) {
      return err(c, 400, 'only filter=userName eq "<email>" is supported');
    }
    return c.json({ schemas: [SCHEMA_LIST], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: rows.map(toScim) });
  });

  app.get('/scim/v2/Users/:id', async (c) => {
    const row = await userRow(c.req.param('id'));
    return row ? c.json(toScim(row)) : err(c, 404, 'user not found');
  });

  app.post('/scim/v2/Users', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userName?: string; emails?: Array<{ value?: string }>; active?: unknown };
    const email = (body.userName || body.emails?.[0]?.value || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return err(c, 400, 'userName must be an email');
    const existing = await repo.findUserByEmail(email);
    if (existing) return err(c, 409, 'user already exists');
    // An account only: which directories it can open is an admin decision.
    const user = await repo.findOrCreateUser(email);
    if (truthy(body.active) === false) await setActive(c, user, false);
    return c.json(toScim((await userRow(user.id))!), 201);
  });

  const applyActive = async (c: any, id: string, active: boolean | undefined) => {
    const row = await userRow(id);
    if (!row) return err(c, 404, 'user not found');
    if (active !== undefined) await setActive(c, row, active);
    return c.json(toScim((await userRow(id))!));
  };

  app.patch('/scim/v2/Users/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { Operations?: Array<{ op?: string; path?: string; value?: unknown }> };
    let active: boolean | undefined;
    for (const op of body.Operations ?? []) {
      if (!/^(replace|add)$/i.test(op.op ?? '')) continue;
      if ((op.path ?? '').toLowerCase() === 'active') active = truthy(op.value);
      else if (!op.path && op.value && typeof op.value === 'object' && 'active' in (op.value as object)) {
        active = truthy((op.value as { active: unknown }).active);
      }
    }
    return applyActive(c, c.req.param('id'), active);
  });

  app.put('/scim/v2/Users/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { active?: unknown };
    return applyActive(c, c.req.param('id'), truthy(body.active));
  });

  app.delete('/scim/v2/Users/:id', async (c) => {
    const row = await userRow(c.req.param('id'));
    if (!row) return err(c, 404, 'user not found');
    await setActive(c, row, false);
    return c.body(null, 204);
  });
}
