// Routes: workspaces.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import { displayName } from '../../lib/display-name.js';
import * as path from 'node:path';
import { listBuiltinProfiles, getBuiltinProfile, DEFAULT_PROFILE_ID } from '../../../lib/profiles/index.js';
import { log } from '../../../lib/log.js';
import { domainKind, emailDomain } from '../../../lib/email-domain.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerWorkspaces(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  repo,
  uniqueSlug,
  clientIp,
  SINGLE_USER_LOCAL,
  userEmail,
  workspaceGate,
  isWorkspaceOwnerTier,
} = core;
// ---------- workspaces ----------

app.post('/workspaces', authn, async (c) => {
  const user_id = c.get('user_id');
  const u = await repo.getUserEmailRow(user_id) as { email: string };
  const body = await c.req.json();
  const parsed = z
    .object({
      // No control characters: the name reaches email subjects (access requests).
      name: displayName(),
      profile_id: z.string().optional(),
      // Multi-subgraph onboarding: one or more profiles. First becomes the
      // 'default' subgraph; the rest each get their own subgraph. Falls back
      // to the single profile_id (or the default profile) for back-compat.
      profile_ids: z.array(z.string().min(1)).min(1).optional(),
      // Optional per-subfolder descriptions captured at onboarding, keyed by
      // profile id (each profile maps to exactly one subfolder here). A missing
      // or blank entry falls back to the 'miscellaneous' column default.
      descriptions: z.record(z.string(), z.string().max(500)).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const requested =
    parsed.data.profile_ids ?? [parsed.data.profile_id ?? DEFAULT_PROFILE_ID];
  const profiles = requested.map((id) => getBuiltinProfile(id));
  const missingAt = profiles.findIndex((p) => !p);
  if (missingAt >= 0) {
    const allowed = listBuiltinProfiles().map((p) => p.id).join(', ');
    return c.json({ error: `unknown profile_id '${requested[missingAt]}' (allowed: ${allowed})` }, 400);
  }
  const ws = await repo.createWorkspace({ name: parsed.data.name, owner_email: u.email });
  // createWorkspace seeded the 'default' subgraph. First profile binds to it
  // (renamed onto that profile); each additional profile gets a new subgraph.
  const takenSlugs = new Set<string>();
  const descriptions = parsed.data.descriptions ?? {};
  const created: Array<{ subgraph_id: string; slug: string; name: string; description: string; profile_id: string }> = [];
  for (const [i, profile] of profiles.entries()) {
    const p = profile!;
    const slug = uniqueSlug(p.id, takenSlugs);
    // Blank/missing description → repo falls back to the 'miscellaneous' default.
    const description = descriptions[p.id];
    let subgraph_id: string;
    if (i === 0) {
      subgraph_id = 'default';
      await repo.updateSubgraph(ws.id, 'default', { slug, name: p.name, description });
    } else {
      subgraph_id = (await repo.createSubgraph(ws.id, { slug, name: p.name, description })).id;
    }
    await repo.setWorkspaceProfile(ws.id, p.id, p, subgraph_id);
    created.push({ subgraph_id, slug, name: p.name, description: (await repo.getSubgraph(ws.id, subgraph_id))?.description ?? 'miscellaneous', profile_id: p.id });
    await repo.logCustomerAudit(ws.id, {
      event: 'profile_assigned',
      actor_user_id: user_id,
      actor_email: u.email,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      resource_type: 'workspace_profile',
      resource_id: subgraph_id,
      payload: { profile_id: p.id, subgraph_id },
    });
  }
  return c.json({ ...ws, profile_id: created[0]!.profile_id, subgraphs: created });
});

app.get('/workspaces', authn, async (c) => {
  // Single-user (standalone) mode: the local DB holds exactly one person's data,
  // so every workspace on the device is theirs — list them ALL, independent of
  // any membership row. Membership scoping here is what made workspaces "vanish"
  // on logout (the signed-out local-owner id had no membership to mirrored team
  // workspaces); node visibility already bypasses membership under SINGLE_USER
  // (see actorId / teamOnly), and listing must match. The cloud path stays
  // membership-scoped.
  const rows = SINGLE_USER_LOCAL
    ? await repo.listAllWorkspaceRowsAsAdmin()
    : await repo.listWorkspaceRowsForUser(c.get('user_id'));
  // `can_manage` answers "may this person change team-wide settings here"
  // without the client fetching the member list per folder just to disable
  // one button. Same owner-tier rule the routes
  // themselves enforce — the flag is a UI convenience, never the check.
  const viewerEmail = (await userEmail(c.get('user_id')) ?? '').toLowerCase();
  const workspaces = (rows as Array<Record<string, unknown>>).map(({ member_role, ...w }) => ({
    ...w,
    can_manage:
      String(w.owner_email ?? '').toLowerCase() === viewerEmail || member_role === 'workspace_admin',
  }));
  return c.json({ workspaces });
});

// ---------- team directory (cross-workspace, domain-scoped) ----------

/**
 * Everyone who shares the caller's email domain, with the workspaces each
 * belongs to. For every workspace: its plan, its context-profile type(s), and
 * the MCP endpoint that serves it (the path is the same for all workspaces —
 * the workspace is selected by the token an admin issues in Setup — so we
 * return the bare `mcp_path` and let the client compose the full URL against
 * its own origin).
 *
 * Authenticated but deliberately NOT workspaceGate'd: the whole point is to
 * explore teammates' workspaces, which the caller may not be a member of. The
 * domain is taken from the caller's own email, so a user only ever sees their
 * own org. Not linked in the nav — reachable only from Setup.
 *
 * `domain_kind` says whether that domain groups anybody: 'org' for a company
 * domain, 'personal' for a public mailbox provider (gmail.com, outlook.com, …),
 * where the directory is the caller alone — strangers who share a mailbox
 * provider are not a team. The UI uses it to explain the empty page instead of
 * implying the org is empty.
 */
app.get('/team/directory', authn, async (c) => {
  const user_id = c.get('user_id');
  const me = await repo.getUserEmailRow(user_id);
  if (!me) return c.json({ error: 'unknown user' }, 401);
  const domain = emailDomain(me.email);
  const users = await repo.listDomainDirectory(domain, user_id);
  return c.json({
    domain,
    domain_kind: domainKind(domain),
    me: { user_id, email: me.email },
    mcp_path: '/mcp/server',
    users,
  });
});

}
