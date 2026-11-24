// Routes: slack-listen.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import * as path from 'node:path';
import { Repo } from '../../db/repo.js';
import { log } from '../../../lib/log.js';
import { ToolError } from '../../mcp/errors.js';
import { resolveFolderRef } from '../../mcp/folder-resolve.js';
import { getEmbedder } from '../../../lib/embeddings.js';
import type { RunReport } from '../../updates/scheduler.js';
import type { RecipientList, UpdateMedium, UpdateTarget } from '../../db/repo.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerSlackListen(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  ctx,
  surfaceSecretOk,
  repo,
  UNMAPPED_REPLY,
  surfaceFolderFor,
  NO_DEFAULT_REPLY,
  resolveSubgraph,
  authn,
  workspaceGate,
} = core;
// ---- Slack listen automations (redesign of the Automations tab, Stage 5) --
// The surface bot's channel-listen subscriptions used to live in a JSON file
// local to the surfaces/slack process; they now live in the shared
// `automations` table (kind='slack_listen') like every other automation, so
// they show up in the web Automations tab with history. What moves here is
// ONLY the subscription CRUD + watermark/cadence bookkeeping — the actual
// Slack Web API polling (collectTranscript, noise filtering) still runs in
// surfaces/slack, since only that process holds the bot token. Same
// X-Surface-Secret trust model as /agent/surface/messages|actions above.

app.get('/agent/surface/automations/due', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  if (!surfaceSecretOk(c.req.header('x-surface-secret'))) return c.json({ error: 'unauthorized' }, 401);
  const team_id = c.req.query('team_id');
  if (!team_id) return c.json({ error: 'team_id required' }, 400);
  const due = (await repo.dueAutomations(new Date(), 'slack_listen')).filter((a) => a.slack_team_id === team_id);
  return c.json({ automations: due });
});

const SurfaceAutomationUpsertBody = z.object({
  team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  channel_id: z.string().min(1),
  cadence_ms: z.number().int().positive(),
});

app.post('/agent/surface/automations/upsert', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  if (!surfaceSecretOk(c.req.header('x-surface-secret'))) return c.json({ error: 'unauthorized' }, 401);
  const parsed = SurfaceAutomationUpsertBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { team_id, slack_user_id, channel_id, cadence_ms } = parsed.data;

  const user = await repo.findUserBySlackIdentity(team_id, slack_user_id, { activeOnly: true });
  if (!user) return c.json({ error: 'unmapped', reply: UNMAPPED_REPLY }, 404);
  const wsId = await surfaceFolderFor(user.id, 'slack');
  if (!wsId) return c.json({ error: 'no_default_folder', reply: NO_DEFAULT_REPLY }, 409);

  // Idempotent by (workspace, channel) — a user can only listen to a given
  // channel once for their own canon; re-issuing `listen` just updates the
  // cadence (mirrors the old SubscriptionStore.upsert's "update in place").
  const existing = (await repo.listAutomations(wsId, 'slack_listen')).find((a) => a.slack_channel_id === channel_id);
  const nowIso = new Date().toISOString();
  const automation = await repo.upsertAutomation(wsId, {
    id: existing?.id,
    kind: 'slack_listen',
    slack_team_id: team_id,
    slack_channel_id: channel_id,
    cadence_ms,
    next_run_at: existing?.next_run_at ?? new Date(Date.now() + cadence_ms).toISOString(),
    watermark: existing?.watermark ?? `${Math.floor(Date.now() / 1000)}.000000`,
    owner_user_id: user.id,
    created_at: existing?.created_at,
  });
  log.info('automations.slack_listen_upserted', {
    workspace: wsId,
    user: user.id,
    automation_id: automation.id,
    created: !existing,
    nowIso,
  });
  return c.json({ automation, created: !existing });
});

app.delete('/agent/surface/automations/slack-listen', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  if (!surfaceSecretOk(c.req.header('x-surface-secret'))) return c.json({ error: 'unauthorized' }, 401);
  const team_id = c.req.query('team_id');
  const slack_user_id = c.req.query('slack_user_id');
  const channel_id = c.req.query('channel_id');
  if (!team_id || !slack_user_id || !channel_id) {
    return c.json({ error: 'team_id, slack_user_id, channel_id required' }, 400);
  }
  const user = await repo.findUserBySlackIdentity(team_id, slack_user_id, { activeOnly: true });
  if (!user) return c.json({ removed: false });
  const wsId = await surfaceFolderFor(user.id, 'slack');
  if (!wsId) return c.json({ removed: false });
  const existing = (await repo.listAutomations(wsId, 'slack_listen')).find((a) => a.slack_channel_id === channel_id);
  if (!existing) return c.json({ removed: false });
  await repo.deleteAutomation(wsId, existing.id);
  return c.json({ removed: true });
});

const SurfaceAutomationReportRunBody = z.object({
  team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  outcome: z.enum(['ok', 'empty', 'error']),
  window_to: z.string().optional(),
  items_seen: z.number().int().optional(),
  items_ingested: z.number().int().optional(),
  document_ids: z.array(z.string()).optional(),
  error: z.string().optional(),
});

app.post('/agent/surface/automations/:id/report-run', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  if (!surfaceSecretOk(c.req.header('x-surface-secret'))) return c.json({ error: 'unauthorized' }, 401);
  const parsed = SurfaceAutomationReportRunBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { team_id, slack_user_id, outcome, window_to, items_seen, items_ingested, document_ids, error } = parsed.data;

  const user = await repo.findUserBySlackIdentity(team_id, slack_user_id, { activeOnly: true });
  if (!user) return c.json({ error: 'unmapped' }, 404);
  const wsId = await surfaceFolderFor(user.id, 'slack');
  if (!wsId) return c.json({ error: 'no_default_folder' }, 409);
  const id = c.req.param('id');
  const automation = await repo.getAutomation(wsId, id);
  // Defense against a stale/spoofed id from a different workspace — only the
  // resolved owner's own automation may be advanced.
  if (!automation || automation.kind !== 'slack_listen') return c.json({ error: 'not_found' }, 404);

  // Same backoff discipline as the pre-migration scheduler: success/empty
  // advance the watermark and reset backoff; a failed run backs off to at most
  // 1h without touching the watermark, so a flaky run never drops messages.
  const cadence = automation.cadence_ms ?? 24 * 60 * 60 * 1000;
  const delayMs = outcome === 'error' ? Math.min(cadence, 60 * 60 * 1000) : cadence;
  const nowIso = new Date().toISOString();
  await repo.advanceAutomation(wsId, id, {
    last_run_at: nowIso,
    next_run_at: new Date(Date.now() + delayMs).toISOString(),
    watermark: outcome === 'error' ? undefined : (window_to ?? undefined),
    fail_count: outcome === 'error' ? automation.fail_count + 1 : 0,
  });
  const run = await repo.recordAutomationRun(wsId, {
    automation_id: id,
    trigger: 'scheduled',
    outcome,
    window_to,
    items_seen,
    items_ingested,
    document_ids,
    error,
    summary:
      outcome === 'ok'
        ? `Ingested ${items_ingested ?? 0} new message batch from #${automation.slack_channel_id}`
        : outcome === 'empty'
          ? 'Nothing new in this channel.'
          : undefined,
  });
  return c.json({ ok: true, run });
});

  // ---------- Subscribe to Updates (spec-subscribe-to-updates.md / U1) ----------
  //
  // Standing NL topic watches with scheduled delivery. Subscriptions are
  // USER-OWNED (may span the owner's folders); the `:ws` in the path is the
  // "home" folder used for the auth gate — ownership, not workspace, scopes
  // every read/write below. Full teammate/folder-ref target resolution + the
  // web UI land in U2/U3; U1 exposes the model + CRUD + the run-due driver.

  const MIN_CADENCE_MS = 60 * 60 * 1000; // 1h — guard against runaway runs
  const MAX_CADENCE_MS = 31 * 24 * 60 * 60 * 1000; // 31d — allows bi-weekly / monthly cadences
  const clampCadence = (ms: number) => Math.max(MIN_CADENCE_MS, Math.min(MAX_CADENCE_MS, ms));

  // Resolve the target list a subscription watches. Defaults to the caller's
  // current (workspace, subgraph); an explicit list is validated for membership
  // and rejected (403) if the owner can't read one — the standard access posture.
  // Resolve a subscription's watch targets from either explicit (workspace,
  // subgraph) pairs OR human references (folder id/name, teammate email,
  // @handle, display name) via the shared folder resolver — the same references
  // every MCP tool accepts. Membership is enforced (a ref you can't read is a
  // 403 with the standard message). Empty → the caller's current folder.
  async function resolveUpdateTargets(
    c: any,
    ws: string,
    ownerUserId: string,
    rawTargets: unknown,
    rawRefs: unknown,
  ): Promise<{ targets: UpdateTarget[] } | { error: string; status: number }> {
    const targets: UpdateTarget[] = [];
    const seen = new Set<string>();
    const add = (workspace_id: string, subgraph_id: string) => {
      const key = `${workspace_id}:${subgraph_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ workspace_id, subgraph_id });
      }
    };

    if (Array.isArray(rawTargets)) {
      for (const t of rawTargets as any[]) {
        const workspace_id = String(t.workspace_id ?? ws);
        if (!await repo.getMembership(workspace_id, ownerUserId)) {
          return { error: `no access to workspace ${workspace_id}`, status: 403 };
        }
        add(workspace_id, String(t.subgraph_id ?? 'default'));
      }
    }
    if (Array.isArray(rawRefs)) {
      for (const ref of rawRefs as unknown[]) {
        try {
          const r = await resolveFolderRef(repo, ownerUserId, String(ref), 'mcp');
          add(r.workspace_id, 'default');
        } catch (err) {
          const detail =
            err instanceof ToolError ? String(err.extra.detail ?? err.code) : String(err);
          const status = err instanceof ToolError ? err.httpStatus : 400;
          return { error: `couldn't watch "${ref}": ${detail}`, status };
        }
      }
    }
    if (targets.length === 0) {
      const sg = await resolveSubgraph(c, ws);
      add(ws, sg?.id ?? 'default');
    }
    return { targets };
  }

  async function embedTopic(topic: string): Promise<Float32Array | null> {
    try {
      const [vec] = await getEmbedder().embed([topic]);
      return vec ?? null;
    } catch {
      return null; // embedder offline → relevance falls back to passthrough
    }
  }

  const publicSub = (s: Awaited<ReturnType<Repo['getUpdateSubscription']>>) =>
    s && {
      id: s.id,
      topic: s.topic,
      targets: s.targets,
      cadence_ms: s.cadence_ms,
      medium: s.medium,
      kind: s.kind,
      destination: s.destination,
      approval_mode: s.approval_mode,
      status: s.status,
      last_run_at: s.last_run_at,
      next_run_at: s.next_run_at,
      created_at: s.created_at,
      updated_at: s.updated_at,
    };

  // A watch's recipients ride `destination` as a comma-separated list. Callers
  // may send either `destination` (one address — the 'get' agent) or
  // `recipients` (a list — the 'give' agent's broadcast); both land in the same
  // column so one scheduler path serves both. Returns undefined when the caller
  // sent neither, which leaves the field untouched on a patch.
  const normalizeDestination = (
    destination: string | null | undefined,
    recipients: string[] | undefined,
  ): string | null | undefined => {
    if (recipients !== undefined) {
      const list = recipients.map((r) => r.trim()).filter(Boolean);
      return list.length > 0 ? list.join(',') : null;
    }
    if (destination === undefined) return undefined;
    return destination?.trim() || null;
  };

  // Create — topic is the only required field; everything else defaults.
  app.post('/workspaces/:ws/updates', authn, workspaceGate, async (c) => {
    const ws = c.get('workspace_id');
    const owner = c.get('user_id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        topic: z.string().min(1),
        targets: z
          .array(z.object({ workspace_id: z.string().optional(), subgraph_id: z.string().optional() }))
          .optional(),
        // Human folder/teammate references (folder id/name, email, @handle,
        // display name) — resolved via the shared folder resolver.
        target_refs: z.array(z.string().min(1)).optional(),
        cadence_ms: z.number().int().positive().optional(),
        medium: z.enum(['email', 'slack']).optional(),
        kind: z.enum(['get', 'give']).optional(),
        destination: z.string().nullish(),
        recipients: z.array(z.string().min(1)).optional(),
        approval_mode: z.enum(['autonomous', 'review']).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.flatten() }, 400);

    // A 'give' watch is a WORK agent (spec-work-agents.md): it reports on the
    // caller's own WORKSPACE only — never a teammate's — which is what keeps
    // it distinct from a 'get' collab watch's cross-folder scope, so the
    // target refs a 'get' watch accepts are ignored here. It spans every
    // subgraph in the workspace rather than pinning to one: the create form
    // never asks the caller to pick a subgraph, so defaulting to "whichever
    // subgraph happened to be ambient in the UI" silently scoped broadcasts to
    // the wrong folder (e.g. a customer-insight broadcast pinned to Backlog).
    const kind = parsed.data.kind ?? 'get';
    const resolved =
      kind === 'give'
        ? { targets: (await repo.listSubgraphs(ws, { activeOnly: true })).map((sg) => ({ workspace_id: ws, subgraph_id: sg.id })) }
        : await resolveUpdateTargets(c, ws, owner, parsed.data.targets, parsed.data.target_refs);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status as 400 | 403);

    const cadence = clampCadence(parsed.data.cadence_ms ?? 7 * 24 * 60 * 60 * 1000); // default weekly
    const topicEmbedding = await embedTopic(parsed.data.topic);
    // The first update fires NOW: watermark stays null so run 1 is a baseline
    // snapshot of what's currently relevant to the topic (the run then advances
    // the watermark to "now"; every later run is incremental). next_run_at = now
    // so the scheduler picks it up immediately even when we can't run inline.
    const sub = await repo.createUpdateSubscription({
      owner_user_id: owner,
      topic: parsed.data.topic,
      topic_embedding: topicEmbedding,
      targets: resolved.targets,
      cadence_ms: cadence,
      medium: (parsed.data.medium ?? 'email') as UpdateMedium,
      kind,
      destination: normalizeDestination(parsed.data.destination, parsed.data.recipients) ?? null,
      // A 'give' watch goes out to teammates under the owner's name, so it holds
      // for approval unless the owner explicitly opts into autonomous sending.
      approval_mode: parsed.data.approval_mode ?? (kind === 'give' ? 'review' : 'autonomous'),
      next_run_at: new Date().toISOString(),
    });

    // Produce that first update inline when a scheduler is wired (cloud). It's
    // resilient: a synth/send failure is logged and never fails the create — the
    // watch still exists and the scheduler retries the (still-null) watermark.
    let first_run: RunReport | null = null;
    if (ctx.updateScheduler) {
      try {
        first_run = await ctx.updateScheduler.runSubscription((await repo.getUpdateSubscription(sub.id))!);
      } catch (err) {
        log.warn('updates.first_run_failed', { subscription: sub.id, error: (err as Error).message });
      }
    }
    return c.json({ subscription: publicSub(await repo.getUpdateSubscription(sub.id)), first_run }, 201);
  });

  // List mine. `?kind=get|give` keeps each agent to its own watches; omitted
  // returns every watch I own (the pre-'give' behaviour).
  app.get('/workspaces/:ws/updates', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const kind = c.req.query('kind');
    if (kind !== undefined && kind !== 'get' && kind !== 'give') {
      return c.json({ error: 'invalid', detail: `unknown kind '${kind}'` }, 400);
    }
    return c.json({ subscriptions: (await repo.listUpdateSubscriptions(owner, kind)).map(publicSub) });
  });

  // My deliveries (across subscriptions). Registered before `/updates/:id` so
  // the static segment wins regardless of router internals.
  app.get('/workspaces/:ws/updates/deliveries', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    return c.json({ deliveries: await repo.listUpdateDeliveries({ owner_user_id: owner }) });
  });

  // Count of updates awaiting my approval (review mode) — drives the nav badge.
  app.get('/workspaces/:ws/updates/pending-count', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    return c.json({ count: await repo.countPendingDeliveries(owner) });
  });

  // One delivery — marks it viewed (view tracking; spec §8).
  app.get('/workspaces/:ws/updates/delivery/:did', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const d = await repo.getUpdateDelivery(c.req.param('did'));
    if (!d || d.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    await repo.markUpdateDeliveryViewed(d.id);
    return c.json({ delivery: await repo.getUpdateDelivery(d.id) });
  });

  // Approve a pending (review-mode) update → send it now over its medium. The
  // scheduler owns transport/tracking; here we gate on ownership + pending state.
  app.post('/workspaces/:ws/updates/delivery/:did/send', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const d = await repo.getUpdateDelivery(c.req.param('did'));
    if (!d || d.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    if (d.status !== 'pending') return c.json({ error: `not_pending`, status: d.status }, 409);
    if (!ctx.updateScheduler) return c.json({ error: 'updates scheduler not configured' }, 501);
    const report = await ctx.updateScheduler.sendPendingDelivery(d.id);
    if (report.outcome !== 'ok') return c.json({ error: report.error ?? 'send_failed' }, 502);
    return c.json({ delivery: await repo.getUpdateDelivery(d.id) });
  });

  // Discard a pending update → owner rejected it; never sent (window already
  // consumed at synthesis time, so this is an intentional drop).
  app.post('/workspaces/:ws/updates/delivery/:did/discard', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const d = await repo.getUpdateDelivery(c.req.param('did'));
    if (!d || d.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    if (d.status !== 'pending') return c.json({ error: `not_pending`, status: d.status }, 409);
    await repo.setUpdateDeliveryStatus(d.id, 'discarded');
    return c.json({ delivery: await repo.getUpdateDelivery(d.id) });
  });

  // One subscription (owner-scoped).
  app.get('/workspaces/:ws/updates/:id', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const sub = await repo.getUpdateSubscription(c.req.param('id'));
    if (!sub || sub.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    return c.json({ subscription: publicSub(sub) });
  });

  // Deliveries for one subscription.
  app.get('/workspaces/:ws/updates/:id/deliveries', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const sub = await repo.getUpdateSubscription(c.req.param('id'));
    if (!sub || sub.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    return c.json({
      deliveries: await repo.listUpdateDeliveries({ owner_user_id: owner, subscription_id: sub.id }),
    });
  });

  // Edit any field. Topic → re-embed; cadence → recompute next_run_at; targets →
  // re-resolve + re-check membership. Editing never disturbs the watermark
  // unless `catch_up` resets it (spec §6).
  app.patch('/workspaces/:ws/updates/:id', authn, workspaceGate, async (c) => {
    const ws = c.get('workspace_id');
    const owner = c.get('user_id');
    const sub = await repo.getUpdateSubscription(c.req.param('id'));
    if (!sub || sub.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        topic: z.string().min(1).optional(),
        targets: z
          .array(z.object({ workspace_id: z.string().optional(), subgraph_id: z.string().optional() }))
          .optional(),
        target_refs: z.array(z.string().min(1)).optional(),
        cadence_ms: z.number().int().positive().optional(),
        medium: z.enum(['email', 'slack']).optional(),
        destination: z.string().nullish(),
        recipients: z.array(z.string().min(1)).optional(),
        approval_mode: z.enum(['autonomous', 'review']).optional(),
        catch_up: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.flatten() }, 400);

    const patch: Parameters<Repo['updateUpdateSubscription']>[1] = {};
    if (parsed.data.topic !== undefined) {
      patch.topic = parsed.data.topic;
      patch.topic_embedding = await embedTopic(parsed.data.topic);
    }
    // A 'give' watch stays pinned to the folder it was created in (own context
    // only), so its scope isn't re-openable through an edit.
    if (
      sub.kind !== 'give' &&
      (parsed.data.targets !== undefined || parsed.data.target_refs !== undefined)
    ) {
      const resolved = await resolveUpdateTargets(c, ws, owner, parsed.data.targets, parsed.data.target_refs);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status as 400 | 403);
      patch.targets = resolved.targets;
    }
    if (parsed.data.cadence_ms !== undefined) {
      patch.cadence_ms = clampCadence(parsed.data.cadence_ms);
      patch.next_run_at = new Date(Date.now() + patch.cadence_ms).toISOString();
    }
    if (parsed.data.medium !== undefined) patch.medium = parsed.data.medium;
    const destination = normalizeDestination(parsed.data.destination, parsed.data.recipients);
    if (destination !== undefined) patch.destination = destination;
    if (parsed.data.approval_mode !== undefined) patch.approval_mode = parsed.data.approval_mode;
    if (parsed.data.catch_up) patch.watermark = null; // re-report from scratch next run
    await repo.updateUpdateSubscription(sub.id, patch);
    return c.json({ subscription: publicSub(await repo.getUpdateSubscription(sub.id)) });
  });

  // Pause / resume — toggles status without losing history or watermark.
  const setStatus = (status: 'active' | 'paused') => async (c: any) => {
    const owner = c.get('user_id');
    const sub = await repo.getUpdateSubscription(c.req.param('id'));
    if (!sub || sub.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    const patch: Parameters<Repo['updateUpdateSubscription']>[1] = { status };
    // Resuming schedules the next run one cadence out (don't fire instantly).
    if (status === 'active') patch.next_run_at = new Date(Date.now() + sub.cadence_ms).toISOString();
    await repo.updateUpdateSubscription(sub.id, patch);
    return c.json({ subscription: publicSub(await repo.getUpdateSubscription(sub.id)) });
  };
  app.post('/workspaces/:ws/updates/:id/pause', authn, workspaceGate, setStatus('paused'));
  app.post('/workspaces/:ws/updates/:id/resume', authn, workspaceGate, setStatus('active'));

  // Delete — retains past deliveries by default (`?purge=1` to drop them too).
  app.delete('/workspaces/:ws/updates/:id', authn, workspaceGate, async (c) => {
    const owner = c.get('user_id');
    const sub = await repo.getUpdateSubscription(c.req.param('id'));
    if (!sub || sub.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    await repo.deleteUpdateSubscription(sub.id, { purgeDeliveries: c.req.query('purge') === '1' });
    return c.json({ ok: true });
  });

  // ---------- Saved recipient lists (the 'give' agent's address book) ----------
  //
  // A named group of addresses the owner broadcasts to, so a recurring audience
  // is typed once. Owner-scoped inside a folder: you only ever see your own.

  const publicList = (l: RecipientList) => ({
    id: l.id,
    name: l.name,
    recipients: l.recipients,
    created_at: l.created_at,
    updated_at: l.updated_at,
  });

  app.get('/workspaces/:ws/recipient-lists', authn, workspaceGate, async (c) => {
    const ws = c.get('workspace_id');
    const owner = c.get('user_id');
    return c.json({ lists: (await repo.listRecipientLists(ws, owner)).map(publicList) });
  });

  // Save (or overwrite by name) a list.
  app.post('/workspaces/:ws/recipient-lists', authn, workspaceGate, async (c) => {
    const ws = c.get('workspace_id');
    const owner = c.get('user_id');
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        recipients: z.array(z.string().min(1)).min(1),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid', detail: parsed.error.flatten() }, 400);
    const recipients = [...new Set(parsed.data.recipients.map((r) => r.trim()).filter(Boolean))];
    if (recipients.length === 0) return c.json({ error: 'invalid', detail: 'no recipients' }, 400);
    const list = await repo.saveRecipientList({
      workspace_id: ws,
      owner_user_id: owner,
      name: parsed.data.name.trim(),
      recipients,
    });
    return c.json({ list: publicList(list) }, 201);
  });

  app.delete('/workspaces/:ws/recipient-lists/:id', authn, workspaceGate, async (c) => {
    const ws = c.get('workspace_id');
    const owner = c.get('user_id');
    const list = await repo.getRecipientList(ws, c.req.param('id'));
    if (!list || list.owner_user_id !== owner) return c.json({ error: 'not_found' }, 404);
    await repo.deleteRecipientList(ws, list.id);
    return c.json({ ok: true });
  });

  // Internal driver — run every due subscription once (backfill / cron / tests).
  // Guarded by a shared secret when SURFACE_AGENT_SECRET is set, mirroring the
  // other internal endpoints; open in local dev when unset.
  // Internal driver for an external cron. Always requires the shared secret
  // (SURFACE_AGENT_SECRET, compared in constant time); without one configured
  // the route does not exist — the in-process scheduler (UPDATES_SCHEDULER=1)
  // needs no HTTP trigger.
  app.post('/internal/updates/run-due', async (c) => {
    const secret = process.env.SURFACE_AGENT_SECRET;
    if (!secret) return c.json({ error: 'not_found' }, 404);
    const given = Buffer.from(c.req.header('x-internal-secret') ?? '');
    const expected = Buffer.from(secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (!ctx.updateScheduler) return c.json({ error: 'updates scheduler not configured' }, 501);
    const reports = await ctx.updateScheduler.runDueOnce();
    return c.json({ ran: reports.length, reports });
  });

  // Engagement tracking (spec §8) — PUBLIC (no auth): an email client can't send
  // a bearer token. Both endpoints only bump a counter on one delivery by its
  // unguessable id and expose no data. Open pixel → stamps opened_at; click →
  // counts a click and redirects to the app.
  const TRACK_PIXEL = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );
  app.get('/updates/track/open/:id', async (c) => {
    const id = c.req.param('id').replace(/\.gif$/, '');
    try {
      await repo.markUpdateDeliveryOpened(id);
    } catch {
      /* tracking must never error the pixel */
    }
    return new Response(TRACK_PIXEL, {
      headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private' },
    });
  });
  app.get('/updates/track/click/:id', async (c) => {
    try {
      await repo.markUpdateDeliveryClicked(c.req.param('id'));
    } catch {
      /* fall through to the redirect regardless */
    }
    const base = (process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    return c.redirect(base ? `${base}/#updates` : '/', 302);
  });
}
