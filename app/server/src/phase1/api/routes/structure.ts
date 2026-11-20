// Routes: structure.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import { ContextProfile } from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { FALLBACK_PROFILE } from '../../../lib/profiles/index.js';
import {
  listBuiltinProfiles,
  getBuiltinProfile,
  DEFAULT_PROFILE_ID,
  validateProfileSemantics,
} from '../../../lib/profiles/index.js';
import { log } from '../../../lib/log.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerStructure(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  resolveSubgraph,
  profileFor,
  repo,
  refreshSubgraphOverview,
  userEmail,
  clientIp,
  uniqueSlug,
} = core;
// ---------- context profiles (spec B7) ----------

// Built-in profile catalog — drives the onboarding picker.
app.get('/profiles', authn, (c) => {
  return c.json({ profiles: listBuiltinProfiles() });
});

// Resolved ContextProfile for a workspace. Falls back to FALLBACK_PROFILE for
// pre-profile workspaces.
app.get('/workspaces/:ws/profile', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const profile = await profileFor(ws, sg.id);
  const profile_id = await repo.getWorkspaceProfileId(ws, sg.id) ?? profile.id;
  return c.json({ profile_id, profile, subgraph_id: sg.id });
});

app.get('/workspaces/:ws/overview', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const summary = await refreshSubgraphOverview(ws, sg.id);
  return c.json({ summary });
});

// Set/replace a workspace's profile. Admin-only; validates the body against
// the ContextProfile schema; logs a customer-audit event. Accepts either a
// built-in `profile_id` (resolved to its snapshot) or a full `profile` JSON
// (custom profiles ship as API-level JSON in Phase 1).
app.put('/workspaces/:ws/profile', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));

  let profile: ContextProfileT;
  let profile_id: string;
  let validationWarnings: string[] = [];
  if (typeof body?.profile_id === 'string' && body.profile == null) {
    const builtin = getBuiltinProfile(body.profile_id);
    if (!builtin) {
      const allowed = listBuiltinProfiles().map((p) => p.id).join(', ');
      return c.json({ error: `unknown profile_id '${body.profile_id}' (allowed: ${allowed})` }, 400);
    }
    profile = builtin;
    profile_id = builtin.id;
  } else {
    const parsed = ContextProfile.safeParse(body?.profile ?? body);
    if (!parsed.success) {
      return c.json({ error: 'invalid profile', details: parsed.error.format() }, 422);
    }
    // Semantic rules beyond the structural schema (spec: well-defined profile
    // entities on every custom change). Errors — referential breaks and
    // ambiguities that corrupt pipeline behavior — reject the write. Warnings
    // — conventions a custom profile may opt out of — are returned and logged.
    const semantics = validateProfileSemantics(parsed.data);
    if (semantics.errors.length > 0) {
      return c.json(
        { error: 'profile fails semantic validation', problems: semantics.errors, warnings: semantics.warnings },
        422,
      );
    }
    if (semantics.warnings.length > 0) {
      log.info('profile.update_warnings', { workspace: ws, profile_id: parsed.data.id, warnings: semantics.warnings.join(' | ') });
    }
    validationWarnings = semantics.warnings;
    profile = parsed.data;
    profile_id = parsed.data.id;
  }

  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  await repo.setWorkspaceProfile(ws, profile_id, profile, sg.id);
  await repo.logCustomerAudit(ws, {
    event: 'profile_updated',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace_profile',
    resource_id: sg.id,
    payload: { profile_id, subgraph_id: sg.id },
  });
  return c.json({ profile_id, profile, subgraph_id: sg.id, warnings: validationWarnings });
});

// ---------- subgraphs (multi-profile partitions) ----------

// List the workspace's subgraphs with their bound profile id + active-node
// counts. Drives the header subgraph selector and the Library switch.
app.get('/workspaces/:ws/subgraphs', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const includeArchived = c.req.query('archived') === 'true';
  const rows = await repo.listSubgraphs(ws, { activeOnly: !includeArchived });
  const out = [];
  for (const s of rows) {
    out.push({
      ...s,
      profile_id: await repo.getWorkspaceProfileId(ws, s.id) ?? DEFAULT_PROFILE_ID,
      node_count: (await repo.listNodes(ws, { activeOnly: true }, s.id)).length,
    });
  }
  // (rows already carry description + generated_description(_locked) + routable via SUBGRAPH_SELECT)
  return c.json({ subgraphs: out });
});

// Create a new subgraph bound to a built-in profile. Admin-only.
app.post('/workspaces/:ws/subgraphs', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      profile_id: z.string().min(1),
      name: z.string().min(1).optional(),
      slug: z.string().min(1).optional(),
      description: z.string().max(500).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const profile = getBuiltinProfile(parsed.data.profile_id);
  if (!profile) {
    const allowed = listBuiltinProfiles().map((p) => p.id).join(', ');
    return c.json({ error: `unknown profile_id '${parsed.data.profile_id}' (allowed: ${allowed})` }, 400);
  }
  const taken = new Set((await repo.listSubgraphs(ws)).map((s) => s.slug));
  const slug = uniqueSlug(parsed.data.slug ?? profile.id, taken);
  // Blank description falls back to 'miscellaneous' inside createSubgraph.
  const { id } = await repo.createSubgraph(ws, {
    slug,
    name: parsed.data.name ?? profile.name,
    description: parsed.data.description,
  });
  await repo.setWorkspaceProfile(ws, profile.id, profile, id);
  await repo.logCustomerAudit(ws, {
    event: 'profile_assigned',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'workspace_profile',
    resource_id: id,
    payload: { profile_id: profile.id, subgraph_id: id },
  });
  return c.json({
    subgraph_id: id,
    slug,
    name: parsed.data.name ?? profile.name,
    description: (await repo.getSubgraph(ws, id))?.description ?? 'miscellaneous',
    profile_id: profile.id,
  });
});

// Edit a subgraph's display metadata (name and/or user description). Admin-only.
// Works for any subgraph including 'default' — the name/description are cosmetic
// and the profile binding is untouched. At least one of name/description must be
// present; a blank description resets to 'miscellaneous'.
app.patch('/workspaces/:ws/subgraphs/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().max(500).optional(),
      // The content-summary override. Non-empty only — blanking it out isn't
      // supported here (that would leave the router's `currently_holds` input
      // empty); use the regenerate endpoint to go back to an auto summary.
      generated_description: z.string().min(1).max(4000).optional(),
      // Whether AUTOMATIC routing (the ingest router, the query classifier)
      // may pick this folder unprompted. An explicit `#slug` pin or a
      // caller-picked destination always reaches it either way.
      routable: z.boolean().optional(),
      // Folder-level default privacy for nodes captured into this folder when
      // the ingest names no explicit audience. null clears it.
      default_audience: z.enum(['team', 'private', 'only_me']).nullable().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.description !== undefined ||
        v.generated_description !== undefined ||
        v.routable !== undefined ||
        v.default_audience !== undefined,
      { message: 'name, description, generated_description, routable, or default_audience required' },
    )
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  await repo.updateSubgraph(ws, id, {
    name: parsed.data.name,
    description: parsed.data.description,
    generated_description: parsed.data.generated_description,
    routable: parsed.data.routable,
    default_audience: parsed.data.default_audience,
  });
  const row = await repo.getSubgraph(ws, id);
  return c.json({
    ok: true,
    subgraph_id: id,
    name: row?.name,
    description: row?.description,
    generated_description: row?.generated_description,
    generated_description_locked: row?.generated_description_locked,
    routable: row?.routable,
    default_audience: row?.default_audience ?? null,
  });
});

// Force a fresh content-summary synthesis, discarding any manual override —
// the counterpart to PATCH's `generated_description`. Admin-only.
app.post('/workspaces/:ws/subgraphs/:id/regenerate-summary', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  await repo.unlockSubgraphOverview(ws, id);
  const summary = await refreshSubgraphOverview(ws, id);
  return c.json({ ok: true, subgraph_id: id, summary });
});
}
