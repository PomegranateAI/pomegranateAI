// Routes: automations.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { readWorkspaceFile, readWorkspaceText } from '../../files/sealed-files.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IngestionCriteria } from '../../../lib/schemas.js';
import { log } from '../../../lib/log.js';
import { APP_CATALOG } from '../app-sources.js';
import { extract } from '../../ingest/extract.js';
import type { AutomationKind } from '../../db/repo.js';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerAutomations(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  repo,
  ruleWriteAllowed,
  classifyRulePhaseAction,
  testRuleAction,
  docTextPath,
  FILES_DIR,
  viewerFor,
} = core;
const RuleBody = z.object({
  id: z.string().optional(),
  // Empty allowed: "Add rule" creates a blank draft row the user fills in
  // afterwards. Blank rules are inert everywhere (buildRulePolicy filters them).
  instructions: z.string(),
  scopes: z.array(z.enum(['only_me', 'private', 'team'])).default([]),
  phases: z.array(z.enum(['store', 'use'])).default(['store']),
  action: z.enum(['shape', 'auto_approve', 'auto_reject', 'surface']).optional(),
  target: z.enum(['node', 'source']).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

app.get('/workspaces/:ws/rules', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  await repo.seedDefaultRules(ws, null);
  return c.json({ rules: await repo.listRules(ws), can_edit: await ruleWriteAllowed(ws, c.get('user_id'), c.get('role')) });
});

app.post('/workspaces/:ws/rules', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const parsed = RuleBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const cls = await classifyRulePhaseAction(parsed.data.instructions);
  const rule = await repo.upsertRule(ws, {
    ...parsed.data,
    phases: cls.phases,
    action: 'shape',
    target: cls.target,
  });
  log.info('rules.upserted', { workspace: ws, user: user_id, rule_id: rule.id, target: cls.target });
  return c.json({ rule });
});

app.patch('/workspaces/:ws/rules/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const existing = await repo.getRule(ws, c.req.param('id'));
  if (!existing) return c.json({ error: 'not_found' }, 404);
  const parsed = RuleBody.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  // Re-classify phase + action only when the instructions changed; a scope- or
  // enabled-only edit keeps the existing classification (no LLM call).
  const instructionsChanged =
    parsed.data.instructions !== undefined && parsed.data.instructions !== existing.instructions;
  const cls = instructionsChanged
    ? await classifyRulePhaseAction(parsed.data.instructions!)
    : {
        phases: existing.phases as ('store' | 'use')[],
        target: (existing.target ?? 'node') as 'node' | 'source' | 'both',
      };
  const merged = {
    id: existing.id,
    instructions: parsed.data.instructions ?? existing.instructions,
    scopes: parsed.data.scopes ?? existing.scopes,
    phases: cls.phases,
    action: 'shape',
    target: cls.target,
    enabled: parsed.data.enabled ?? existing.enabled,
    sort_order: parsed.data.sort_order ?? existing.sort_order,
    owner_user_id: existing.owner_user_id,
    created_at: existing.created_at,
  };
  const rule = await repo.upsertRule(ws, merged);
  log.info('rules.patched', { workspace: ws, user: user_id, rule_id: rule.id });
  return c.json({ rule });
});

app.delete('/workspaces/:ws/rules/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  await repo.deleteRule(ws, c.req.param('id'));
  log.info('rules.deleted', { workspace: ws, user: user_id, rule_id: c.req.param('id') });
  return c.json({ ok: true });
});

app.post('/workspaces/:ws/rules/:id/test', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const parsed = z
    .object({
      text: z.string().optional(),
      question: z.string().optional(),
      source_kind: z.enum(['doc', 'slack', 'transcript', 'interaction']).default('doc'),
      subgraph_id: z.string().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const r = await testRuleAction({
    ws,
    rule_id: c.req.param('id'),
    user_id,
    text: parsed.data.text,
    question: parsed.data.question,
    source_kind: parsed.data.source_kind,
    subgraph_id: parsed.data.subgraph_id,
  });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json(r.result);
});

// ---- Unified automations (redesign of the Automations tab) ----------------
// Supersedes the /rules* routes above as the web/MCP CRUD surface. Two kinds
// live here so far: 'shape' (today's shape/use-phase/curation rules, re-homed)
// and 'apps_pull' (recurring app-connector ingestion, manual-run only in this
// stage — no scheduler consumes cadence_ms yet). slack_listen/track_directory
// land in later stages. The /rules* routes above are left running, unmodified,
// so nothing that still points at them (old builds, the `rule-test:<id>`
// source-ref convention) breaks during the staged rollout — see
// repo.migrateRulesToAutomations.
const ShapeAutomationBody = z.object({
  id: z.string().optional(),
  kind: z.literal('shape'),
  // Empty allowed: "Add automation" creates a blank draft row the user fills
  // in afterwards. Blank shape automations are inert everywhere (buildRulePolicy filters them).
  instructions: z.string(),
  scopes: z.array(z.enum(['only_me', 'private', 'team'])).default([]),
  phases: z.array(z.enum(['store', 'use'])).default(['store']),
  action: z.literal('shape').optional(),
  target: z.enum(['node', 'source', 'both']).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

// Mirrors IngestionCriteria (lib/schemas.ts) — `query` is the same free-text
// request the Add Source app-picker takes; github/slack/jira mirror its
// structured overrides exactly as sent to /apps/:app/preview|pull.
const IngestionCriteriaBody = z.object({
  query: z.string(),
  recency: z
    .object({ since_relative: z.string().optional(), anchor_to_watermark: z.boolean().optional() })
    .optional(),
  github: z
    .object({
      repo: z.string().optional(),
      branch: z.string().optional(),
      path: z.string().optional(),
      mode: z.enum(['prs', 'files']),
    })
    .optional(),
  slack: z.object({ channel: z.string().optional() }).optional(),
  jira: z
    .object({
      mode: z.enum(['project', 'board', 'ticket']),
      project: z.string().optional(),
      board: z.string().optional(),
    })
    .optional(),
});

const AppsPullAutomationBody = z.object({
  id: z.string().optional(),
  kind: z.literal('apps_pull'),
  connector: z.string().min(1),
  criteria: IngestionCriteriaBody,
  subgraph_id: z.string().optional(),
  run_instructions: z.string().optional(),
  // Accepted and stored, but nothing schedules off it yet (Stage 4).
  cadence_ms: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

// Default to kind='shape' when omitted — every existing caller (the web
// client, the MCP upsert_rule tool's route-level caller, older test bodies)
// predates the apps_pull kind and never sends `kind` at all; this preserves
// that behavior instead of requiring every one of them to start sending it.
const AutomationBody = z.preprocess(
  (val) => (val && typeof val === 'object' && !('kind' in (val as object)) ? { ...(val as object), kind: 'shape' } : val),
  z.discriminatedUnion('kind', [ShapeAutomationBody, AppsPullAutomationBody]),
);

/**
 * Reuse the connector preview/pull logic wired to /apps/:app/preview|pull
 * WITHOUT duplicating it: a genuine internal HTTP round-trip through this
 * same Hono app instance (Hono's own `app.request`), carrying the caller's
 * bearer token forward so authn/workspaceGate run exactly as they do for an
 * external call. This is what lets an apps_pull automation's preview/run-now
 * be "the existing add-source experience," not a second implementation of it.
 */
async function dispatchAppsRoute(
  authHeader: string | undefined,
  method: 'POST',
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Maps a stored IngestionCriteria onto the /apps/:app/preview|pull request
// body shape — jira's mode/project/board are NOT forwarded here because the
// real endpoint has no such fields for jira (its plan is entirely re-derived
// from `query` server-side); they exist on IngestionCriteria only as a
// display/record of what a prior planned run looked like.
function ingestionCriteriaToRequestBody(criteria: IngestionCriteria): Record<string, unknown> {
  return {
    query: criteria.query,
    mode: criteria.github?.mode ?? 'prs',
    repo: criteria.github?.repo,
    branch: criteria.github?.branch,
    path: criteria.github?.path,
    channel: criteria.slack?.channel,
  };
}

app.get('/workspaces/:ws/automations', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const kind = c.req.query('kind') as AutomationKind | undefined;
  // Lazily copy any legacy `rules` rows in (preserving ids), then seed the 3
  // defaults for a genuinely fresh workspace — both are no-ops once either has
  // already happened. See repo.migrateRulesToAutomations / seedDefaultAutomations.
  await repo.migrateRulesToAutomations(ws);
  await repo.seedDefaultAutomations(ws, null);
  return c.json({
    automations: await repo.listAutomations(ws, kind),
    can_edit: await ruleWriteAllowed(ws, c.get('user_id'), c.get('role')),
  });
});

app.post('/workspaces/:ws/automations', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const parsed = AutomationBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  if (parsed.data.kind === 'apps_pull') {
    if (!APP_CATALOG[parsed.data.connector]) return c.json({ error: 'unknown_connector' }, 400);
    const automation = await repo.upsertAutomation(ws, { ...parsed.data, owner_user_id: user_id });
    log.info('automations.upserted', { workspace: ws, user: user_id, automation_id: automation.id, kind: 'apps_pull', connector: automation.connector });
    return c.json({ automation });
  }

  const cls = await classifyRulePhaseAction(parsed.data.instructions);
  const automation = await repo.upsertAutomation(ws, {
    ...parsed.data,
    phases: cls.phases,
    action: 'shape',
    target: cls.target,
  });
  log.info('automations.upserted', {
    workspace: ws,
    user: user_id,
    automation_id: automation.id,
    kind: automation.kind,
    target: cls.target,
  });
  return c.json({ automation });
});

app.patch('/workspaces/:ws/automations/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const existing = await repo.getAutomation(ws, c.req.param('id'));
  if (!existing) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => null);

  if (existing.kind === 'apps_pull') {
    const parsed = AppsPullAutomationBody.omit({ kind: true }).partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    if (parsed.data.connector && !APP_CATALOG[parsed.data.connector]) return c.json({ error: 'unknown_connector' }, 400);
    const automation = await repo.upsertAutomation(ws, {
      id: existing.id,
      kind: 'apps_pull',
      connector: parsed.data.connector ?? existing.connector ?? undefined,
      criteria: parsed.data.criteria ?? existing.criteria ?? undefined,
      subgraph_id: parsed.data.subgraph_id ?? existing.subgraph_id ?? undefined,
      run_instructions: parsed.data.run_instructions ?? existing.run_instructions ?? undefined,
      cadence_ms: parsed.data.cadence_ms ?? existing.cadence_ms ?? undefined,
      enabled: parsed.data.enabled ?? existing.enabled,
      sort_order: parsed.data.sort_order ?? existing.sort_order,
      owner_user_id: existing.owner_user_id,
      created_at: existing.created_at,
    });
    log.info('automations.patched', { workspace: ws, user: user_id, automation_id: automation.id });
    return c.json({ automation });
  }

  const parsed = ShapeAutomationBody.omit({ kind: true }).partial().safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  // Re-classify phase + action only when the instructions changed; a scope- or
  // enabled-only edit keeps the existing classification (no LLM call).
  const instructionsChanged =
    parsed.data.instructions !== undefined && parsed.data.instructions !== existing.instructions;
  const cls = instructionsChanged
    ? await classifyRulePhaseAction(parsed.data.instructions!)
    : {
        phases: existing.phases as ('store' | 'use')[],
        target: (existing.target ?? 'node') as 'node' | 'source' | 'both',
      };
  const merged = {
    id: existing.id,
    kind: 'shape' as const,
    instructions: parsed.data.instructions ?? existing.instructions ?? '',
    scopes: parsed.data.scopes ?? existing.scopes,
    phases: cls.phases,
    action: 'shape',
    target: cls.target,
    enabled: parsed.data.enabled ?? existing.enabled,
    sort_order: parsed.data.sort_order ?? existing.sort_order,
    owner_user_id: existing.owner_user_id,
    created_at: existing.created_at,
  };
  const automation = await repo.upsertAutomation(ws, merged);
  log.info('automations.patched', { workspace: ws, user: user_id, automation_id: automation.id });
  return c.json({ automation });
});

app.delete('/workspaces/:ws/automations/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  await repo.deleteAutomation(ws, c.req.param('id'));
  log.info('automations.deleted', { workspace: ws, user: user_id, automation_id: c.req.param('id') });
  return c.json({ ok: true });
});

// "One-time run" (spec follow-up): replaces the old Test button. For a shape
// automation this IS the old dry-run test (testRuleAction, unchanged logic).
// For an apps_pull automation, it's the SAME preview an ad-hoc Add Source
// pull would show — the automation's own stored criteria stand in for what
// the user would otherwise type — so the user sees exactly which
// documents/items this automation would generate, before committing to a
// schedule. Persists nothing either way.
app.post('/workspaces/:ws/automations/:id/preview', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const automation = await repo.getAutomation(ws, c.req.param('id'));
  if (!automation) return c.json({ error: 'not_found' }, 404);

  if (automation.kind === 'apps_pull') {
    if (!automation.connector || !automation.criteria) return c.json({ error: 'not_configured' }, 400);
    const body = ingestionCriteriaToRequestBody(automation.criteria);
    const { status, json } = await dispatchAppsRoute(
      c.req.header('authorization'),
      'POST',
      `/workspaces/${ws}/apps/${automation.connector}/preview`,
      body,
    );
    return c.json(json, status as any);
  }

  const parsed = z
    .object({
      text: z.string().optional(),
      question: z.string().optional(),
      source_kind: z.enum(['doc', 'slack', 'transcript', 'interaction']).default('doc'),
      subgraph_id: z.string().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const r = await testRuleAction({
    ws,
    rule_id: c.req.param('id'),
    user_id,
    text: parsed.data.text,
    question: parsed.data.question,
    source_kind: parsed.data.source_kind,
    subgraph_id: parsed.data.subgraph_id,
  });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json(r.result);
});

// Commit an apps_pull automation's criteria right now (manual trigger — no
// scheduler exists yet, see Stage 4): re-preview, then pull every matched
// item, exactly as if the user had checked every box in the Add Source apps
// picker and clicked Pull. Records one automation_runs row either way.
app.post('/workspaces/:ws/automations/:id/run-now', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  if (!await ruleWriteAllowed(ws, user_id, c.get('role'))) return c.json({ error: 'forbidden' }, 403);
  const automation = await repo.getAutomation(ws, c.req.param('id'));
  if (!automation) return c.json({ error: 'not_found' }, 404);
  if (automation.kind !== 'apps_pull') return c.json({ error: 'unsupported_kind' }, 400);
  if (!automation.connector || !automation.criteria) return c.json({ error: 'not_configured' }, 400);

  const authHeader = c.req.header('authorization');
  const previewBody = ingestionCriteriaToRequestBody(automation.criteria);
  const preview = await dispatchAppsRoute(
    authHeader,
    'POST',
    `/workspaces/${ws}/apps/${automation.connector}/preview`,
    previewBody,
  );
  const nowIso = new Date().toISOString();
  if (preview.status !== 200) {
    const run = await repo.recordAutomationRun(ws, {
      automation_id: automation.id,
      trigger: 'manual_run',
      outcome: 'error',
      error: preview.json?.error ?? `preview failed (${preview.status})`,
    });
    return c.json({ error: preview.json?.error ?? 'preview_failed', run }, preview.status as any);
  }

  const items = (preview.json.items ?? []) as Array<{ id: string }>;
  if (items.length === 0) {
    await repo.advanceAutomation(ws, automation.id, { last_run_at: nowIso });
    const run = await repo.recordAutomationRun(ws, {
      automation_id: automation.id,
      trigger: 'manual_run',
      outcome: 'empty',
      items_seen: 0,
      summary: 'Nothing matched this run.',
    });
    log.info('automations.run_now', { workspace: ws, user: user_id, automation_id: automation.id, connector: automation.connector, outcome: 'empty' });
    return c.json({ run, preview: preview.json });
  }

  const pullBody = {
    ...previewBody,
    item_ids: items.map((i) => i.id),
    subgraph_id: automation.subgraph_id ?? undefined,
    instructions: automation.run_instructions ?? undefined,
  };
  const pull = await dispatchAppsRoute(authHeader, 'POST', `/workspaces/${ws}/apps/${automation.connector}/pull`, pullBody);
  if (pull.status !== 200) {
    const code = pull.json?.error ?? `pull failed (${pull.status})`;
    const redaction = code === 'redaction_unavailable' && typeof pull.json?.detail === 'string';
    const run = await repo.recordAutomationRun(ws, {
      automation_id: automation.id,
      trigger: 'manual_run',
      outcome: 'error',
      items_seen: items.length,
      error: redaction ? `${code}: ${pull.json.detail}` : code,
    });
    return c.json(
      { error: pull.json?.error ?? 'pull_failed', ...(redaction ? { reason: pull.json.reason, detail: pull.json.detail } : {}), run },
      pull.status as any,
    );
  }

  const results = (pull.json.results ?? []) as Array<{ document_id: string; candidates: number }>;
  const document_ids = results.map((r) => r.document_id);
  const candidate_count = pull.json.total_candidates ?? results.reduce((sum, r) => sum + (r.candidates ?? 0), 0);
  await repo.advanceAutomation(ws, automation.id, { last_run_at: nowIso });
  const run = await repo.recordAutomationRun(ws, {
    automation_id: automation.id,
    trigger: 'manual_run',
    outcome: 'ok',
    items_seen: items.length,
    items_ingested: document_ids.length,
    document_ids,
    candidate_count,
    summary: `Ingested ${document_ids.length} of ${items.length} item${items.length === 1 ? '' : 's'} from ${automation.connector}`,
  });
  log.info('automations.run_now', {
    workspace: ws,
    user: user_id,
    automation_id: automation.id,
    connector: automation.connector,
    outcome: 'ok',
    items: items.length,
    documents: document_ids.length,
  });
  return c.json({ run, pull: pull.json });
});

app.get('/workspaces/:ws/automations/:id/runs', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const limitParam = Number(c.req.query('limit') ?? '50');
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  return c.json({ runs: await repo.listAutomationRuns(ws, c.req.param('id'), limit) });
});

// Raw text of one ingested document, served as a .txt attachment (Sources
// UI download icon). The canonical text is persisted at registration
// (docTextPath); documents from before that existed fall back to
// re-extracting the original uploaded file (sources table — file ingests
// only). Legacy text-channel documents have no recoverable content → 404.
app.get('/workspaces/:ws/documents/:id/content', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const id = c.req.param('id');
  const doc = await repo.getDocument(ws, id);
  if (!doc) return c.json({ error: 'not_found' }, 404);
  // Raw text carries the audience of the notes it produced: 404 (not 403) so a
  // member can't probe for other members' private uploads.
  if (!await repo.documentVisibleToViewer(ws, id, viewerFor(c))) return c.json({ error: 'not_found' }, 404);
  let text: string | null = null;
  try {
    text = await readWorkspaceText(repo.crypto, ws, FILES_DIR, docTextPath(ws, doc.id, doc.version));
  } catch {
    const sha = (await repo.getDocumentSha256Row(ws, id))?.sha256;
    const src = sha ? await repo.getSourceBySha256(ws, sha) : undefined;
    if (src) {
      try {
        const buf = await readWorkspaceFile(repo.crypto, ws, FILES_DIR, path.join(FILES_DIR, src.object_path));
        text = (await extract(src.original_name ?? doc.source_ref, buf)).text;
      } catch {
        /* fall through to content_not_stored */
      }
    }
  }
  if (text === null) return c.json({ error: 'content_not_stored' }, 404);
  await repo.logAudit(ws, {
    actor: user_id,
    event: 'document.downloaded',
    resource_type: 'document',
    resource_id: doc.id,
    payload: { source_ref: doc.source_ref, version: doc.version, chars: text.length },
  });
  // Attachment filename: the source ref's basename, extension swapped to .txt.
  const base =
    (doc.source_ref.split('/').pop() ?? doc.id)
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 80) || doc.id;
  return c.body(text, 200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${base}.txt"`,
  });
});
}
