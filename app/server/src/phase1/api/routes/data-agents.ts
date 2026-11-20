// Routes: data-agents.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { ContextProfile } from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { validateProfileSemantics } from '../../../lib/profiles/index.js';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { listStandardDataAgentTemplates, getStandardDataAgentTemplate, deriveTemplateProfile } from '../../../lib/profiles/templates/index.js';
import { generateReport } from '../../report/generate.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerDataAgents(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  repo,
  authn,
  workspaceGate,
  isWorkspaceOwnerTier,
  userEmail,
  runDataAgentBackfill,
  capturingProfileFor,
  clientIp,
  viewerFor,
} = core;
// ---------- data agents (spec-data-agents-and-subfolder-wiki.md) ----------
//
// Read routes (catalog list, active binding) are open to any workspace
// member — same precedent as the subgraphs GET routes above, which carry no
// role check while their POST/PATCH/DELETE siblings do. Every WRITE route
// below (template save/delete, attach/detach/change) is owner-tier gated
// (§4.2) — narrower than admin-only, matching `isWorkspaceOwnerTier`.

/** Resolve a template by id — the standard catalog first, then this
 *  workspace's own custom library. Undefined if neither has it. */
async function resolveDataAgentTemplate(ws: string, template_id: string): Promise<ContextProfileT | undefined> {
  return getStandardDataAgentTemplate(template_id) ?? await repo.getDataAgentTemplate(ws, template_id);
}

// The catalog: standard (code-defined, workspace-independent) + this
// workspace's own custom templates, each annotated with how many subfolders
// currently have it active (the Setup card's "used by N subfolders" line
// and the delete guard both read this same count).
app.get('/workspaces/:ws/data-agent-templates', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const standard = await Promise.all(listStandardDataAgentTemplates().map(async (p) => ({
    id: p.id,
    name: p.name,
    standard: true,
    profile: p,
    active_subfolders: await repo.countActiveUsersOfTemplate(ws, p.id),
  })));
  const custom = [];
  for (const t of await repo.listDataAgentTemplates(ws)) {
    custom.push({
      id: t.id,
      name: t.name,
      standard: false,
      profile: t.profile,
      active_subfolders: await repo.countActiveUsersOfTemplate(ws, t.id),
    });
  }
  return c.json({ templates: [...standard, ...custom] });
});

// Save (create, or Save-in-place when `id` names an existing custom
// template) — the ONLY thing that distinguishes "+ New template" from
// "Save" on an existing one is whether the caller passes an id (§4.2). A
// standard (code-defined) id here always forks a NEW custom template
// instead of overwriting the standard one, which cannot be edited in place.
// Accepts a DRAFT profile — Tier A/B fields only (§5.1/§5.2). Tier C
// (review_kinds/query_scopes/feedback_dimensions/flag_semantics) is
// OPTIONAL here and derived server-side by deriveTemplateProfile when
// absent — the editor never asks for it, so the route can't require it
// either, or the whole point of Tier C is defeated. A caller that DOES
// supply one (a hand-tune, §5.2's escape hatch) has it honored as-is.
const DraftContextProfile = ContextProfile.partial({
  review_kinds: true,
  query_scopes: true,
  feedback_dimensions: true,
  flag_semantics: true,
});

app.post('/workspaces/:ws/data-agent-templates', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (!await isWorkspaceOwnerTier(c, ws)) return c.json({ error: 'forbidden' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      id: z.string().min(1).optional(),
      name: z.string().min(1),
      profile: DraftContextProfile,
      forked_from: z.string().min(1).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
  const fullProfile = deriveTemplateProfile(parsed.data.profile as unknown as import('../../../lib/profiles/templates/index.js').DraftTemplateProfile);
  // Same bar every built-in template must clear (§5.3): zero errors, zero
  // warnings, checked live rather than only in a test suite — run against
  // the DERIVED profile, since that's what actually gets saved and attached.
  const { errors, warnings } = validateProfileSemantics(fullProfile);
  if (errors.length > 0) return c.json({ error: 'invalid_profile', errors, warnings }, 400);
  // Saving over a standard id forks instead of overwriting — a standard
  // template has no row to overwrite in this table.
  const id = parsed.data.id && !getStandardDataAgentTemplate(parsed.data.id) ? parsed.data.id : undefined;
  const { id: savedId } = await repo.saveDataAgentTemplate(ws, {
    id,
    name: parsed.data.name,
    profile: fullProfile,
    forked_from: parsed.data.forked_from,
    created_by: c.get('user_id'),
  });
  return c.json({ ok: true, id: savedId, warnings });
});

// Rejected (409) if any subfolder still has this template actively attached
// — the same delete-guard UX as the Subfolders card, not a new pattern.
app.delete('/workspaces/:ws/data-agent-templates/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (!await isWorkspaceOwnerTier(c, ws)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  if (getStandardDataAgentTemplate(id)) return c.json({ error: 'cannot delete a standard template' }, 400);
  if (!await repo.getDataAgentTemplate(ws, id)) return c.json({ error: 'not found' }, 404);
  const activeCount = await repo.countActiveUsersOfTemplate(ws, id);
  if (activeCount > 0) {
    return c.json({ error: 'in_use', detail: `attached to ${activeCount} folder(s)`, active_subfolders: activeCount }, 409);
  }
  await repo.deleteDataAgentTemplate(ws, id);
  return c.json({ ok: true });
});

// The active binding for one subfolder, or null — the strip's collapsed
// state (§4.1) is rendered directly from this.
app.get('/workspaces/:ws/subgraphs/:id/data-agent', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const id = c.req.param('id');
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  const active = await repo.getActiveDataAgent(ws, id);
  return c.json({ active: active ?? null });
});

// Attach OR Change (§4.1) — the identical write either way, since the PK on
// subfolder_data_agents already enforces "one at a time": attaching over an
// existing active row simply replaces it. Detach (below) is the ONLY
// distinct action, kept separate per §4.1's own note that conflating them
// under one button was the earlier draft's actual mistake.
app.post('/workspaces/:ws/subgraphs/:id/data-agent', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (!await isWorkspaceOwnerTier(c, ws)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      template_id: z.string().min(1),
      cadence: z.enum(['once', 'per_document', 'scheduled']),
      cadence_ms: z.number().int().positive().optional(),
      // Run mode (spec §6/§8): 'new_only' (default) leaves existing content
      // alone and only the per-document hook fires from here on. 'backfill'
      // re-runs capture immediately against every document already in this
      // subfolder, archiving whatever was active first — see
      // runDataAgentBackfill's own doc comment for why archive-then-run.
      run: z.enum(['new_only', 'backfill']).default('new_only'),
    })
    .refine((v) => v.cadence !== 'scheduled' || v.cadence_ms !== undefined, {
      message: 'cadence_ms is required when cadence is "scheduled"',
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.message }, 400);
  const template = await resolveDataAgentTemplate(ws, parsed.data.template_id);
  if (!template) return c.json({ error: 'unknown template_id' }, 404);
  await repo.attachDataAgent(ws, id, {
    template_id: parsed.data.template_id,
    template,
    cadence: parsed.data.cadence,
    cadence_ms: parsed.data.cadence_ms,
    attached_by: c.get('user_id'),
  });
  await repo.logCustomerAudit(ws, {
    event: 'data_agent_attached',
    actor_user_id: c.get('user_id'),
    actor_email: await userEmail(c.get('user_id')),
    resource_type: 'subgraph',
    resource_id: id,
    payload: { template_id: parsed.data.template_id, cadence: parsed.data.cadence, run: parsed.data.run },
  });
  let backfill: { archived: number; documents: number; documents_skipped: number; candidates: number } | undefined;
  if (parsed.data.run === 'backfill') {
    try {
      backfill = await runDataAgentBackfill({ ws, subgraph_id: id, user_id: c.get('user_id'), caller: 'api.data_agent_attach' });
    } catch (err) {
      // Attach itself already succeeded and must not be rolled back over a
      // backfill failure — surface it as a partial result instead of a 500.
      log.warn('data_agent.backfill_failed', { workspace: ws, subgraph: id, msg: (err as Error).message?.slice(0, 200) });
    }
  }
  return c.json({ ok: true, active: await repo.getActiveDataAgent(ws, id), backfill });
});

// Detach — turns the agent off; future documents resume the note path
// (§3/§6). The row is kept with status='detached', not deleted.
app.delete('/workspaces/:ws/subgraphs/:id/data-agent', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (!await isWorkspaceOwnerTier(c, ws)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  const before = await repo.getActiveDataAgent(ws, id);
  await repo.detachDataAgent(ws, id);
  if (before) {
    await repo.logCustomerAudit(ws, {
      event: 'data_agent_detached',
      actor_user_id: c.get('user_id'),
      actor_email: await userEmail(c.get('user_id')),
      resource_type: 'subgraph',
      resource_id: id,
      payload: { template_id: before.template_id },
    });
  }
  return c.json({ ok: true });
});

// ---------- the Report (spec-data-agents-and-subfolder-wiki.md §4.3) ----------
//
// Deliberately NOT the wiki's page-tree: one full-screen document per
// subfolder, mirroring the two Library states exactly (§4.1) — no agent →
// one synthesized Notes section; an agent attached → one section per its
// kinds plus a Sources listing. Regeneration is a single explicit action
// (no background replan), reusing capturingProfileFor so the Report always
// reads the SAME taxonomy capture itself would use right now.

app.get('/workspaces/:ws/subgraphs/:id/report', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await repo.getSubgraph(ws, c.req.param('id'));
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const report = await repo.getReport(ws, sg.id) ?? null;
  const latest = await repo.latestGraphChangeAt(ws, sg.id);
  const stale = report ? latest > report.generated_at : false;
  return c.json({ report, stale, latest_change: latest });
});

app.post('/workspaces/:ws/subgraphs/:id/report/generate', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await repo.getSubgraph(ws, c.req.param('id'));
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const { profile, dataAgentActive } = await capturingProfileFor(ws, sg.id);
  try {
    const content = await withLlmContext({ caller: 'api.report_generate', workspace_id: ws }, () =>
      generateReport(repo, ws, sg.id, profile.kinds, { hasSources: dataAgentActive, caller: 'api.report_generate' }),
    );
    const { generated_at } = await repo.saveReport(ws, sg.id, content);
    return c.json({ ok: true, report: { content, generated_at } });
  } catch (err) {
    log.warn('report.generate_failed', { workspace: ws, subgraph: sg.id, msg: (err as Error).message?.slice(0, 200) });
    return c.json({ error: 'generate_failed' }, 500);
  }
});

// Archive a subgraph (never deletes its nodes). Admin-only. The 'default'
// subgraph cannot be archived — it is the always-present home partition.
app.delete('/workspaces/:ws/subgraphs/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  if (id === 'default') return c.json({ error: 'cannot archive the default folder' }, 400);
  if (!await repo.getSubgraph(ws, id)) return c.json({ error: 'not found' }, 404);
  await repo.archiveSubgraph(ws, id);
  return c.json({ ok: true, subgraph_id: id });
});

// Hard-delete a subgraph AND every node/candidate/edge/etc. scoped to it —
// unlike the plain DELETE above (which only archives), this is irreversible.
// Admin-only. The former default folder can be purged once another active
// folder exists; its folder-scoped data is migrated first so deleting it does
// not discard legacy content.
app.delete('/workspaces/:ws/subgraphs/:id/purge', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (c.get('role') !== 'workspace_admin') return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const sg = await repo.getSubgraph(ws, id);
  if (!sg) return c.json({ error: 'not found' }, 404);
  let migrated: Record<string, number> = {};
  if (id === 'default') {
    const replacement = (await repo.listSubgraphs(ws, { activeOnly: true })).find((candidate) => candidate.id !== id);
    if (!replacement) {
      return c.json({ error: 'create another active folder before deleting the default folder' }, 400);
    }
    migrated = await repo.migrateSubgraphRows(ws, id, replacement.id);
  }
  const counts = await repo.deleteSubgraphRows(ws, id);
  await repo.logCustomerAudit(ws, {
    event: 'subgraph_deleted',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'subgraph',
    resource_id: id,
    payload: { name: sg.name, slug: sg.slug },
  });
  return c.json({ ok: true, subgraph_id: id, deleted: counts, migrated });
});

// Which subgraphs a (shared) document routed into.
app.get('/workspaces/:ws/documents/:id/routing', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const document_id = c.req.param('id');
  if (!await repo.documentVisibleToViewer(ws, document_id, viewerFor(c))) return c.json({ error: 'not_found' }, 404);
  const rows = [];
  for (const r of await repo.listDocumentSubgraphs(ws, document_id)) {
    const sg = await repo.getSubgraph(ws, r.subgraph_id);
    rows.push({ ...r, slug: sg?.slug ?? r.subgraph_id, name: sg?.name ?? r.subgraph_id });
  }
  return c.json({ document_id, routing: rows });
});
}
