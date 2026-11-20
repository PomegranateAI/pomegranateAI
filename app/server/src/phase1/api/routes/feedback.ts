// Routes: feedback.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { validateReviewKind } from '../../../lib/profile-validate.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { runDay1Audit, getDay1Audit, listDay1Audits } from '../../day1/audit.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerFeedback(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  workspaceGate,
  resolveQueryTargets,
  withEvidence,
  repo,
  viewerFor,
  synth,
  userEmail,
  clientIp,
} = core;
// ---------- feedback (web) ----------

app.post('/workspaces/:ws/reviews', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const body = await c.req.json();
  const parsed = z
    .object({
      deliverable: z.string().min(1),
      // Profile-driven: validated against the workspace profile's review_kinds
      // below (422 on mismatch).
      kind: z.string().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const kind = parsed.data.kind;

  // Phase 4: route the DELIVERABLE to the relevant subgraph(s); a `#slug` token
  // pins. A single-subgraph workspace takes the fast path (one 'default'
  // target, no classifier).
  const { targets: allTargets, stripped } = await resolveQueryTargets(ws, parsed.data.deliverable);

  // Per-target kind validation: keep only subgraphs whose profile ACCEPTS the
  // kind. Single-subgraph keeps the legacy 422 on mismatch.
  let targets = allTargets;
  if (kind !== undefined) {
    if (allTargets.length === 1) {
      const kindErr = validateReviewKind(allTargets[0]!.profile, kind);
      if (kindErr) return c.json({ error: 'profile_mismatch', detail: kindErr }, 422);
    } else {
      targets = allTargets.filter((t) => validateReviewKind(t.profile, kind) === null);
      if (targets.length === 0) {
        const allowed = [...new Set(allTargets.flatMap((t) => t.profile.review_kinds))].join(', ');
        return c.json(
          { error: 'profile_mismatch', detail: `review kind '${kind}' is not accepted by any targeted folder (allowed across folders: ${allowed})` },
          422,
        );
      }
    }
  }

  const multiMode = targets.length > 1;
  const merged: any[] = [];
  // Per-subgraph stats for the usage rows.
  const perSub: Array<{ subgraph_id: string; cited: number; node_count: number }> = [];
  for (const t of targets) {
    // Review feeds the deliverable to an LLM against the graph → aiRead (exclude 'only_me').
    const graph = await withEvidence(ws, await repo.listNodes(ws, { activeOnly: true, viewer: viewerFor(c), aiRead: true }, t.subgraph_id)) as Awaited<ReturnType<typeof repo.listNodes>>;
    // Every edge in the subfolder this profile has declared, if any — most
    // profiles today declare none, so this is typically empty.
    const edges = await repo.listEdges(ws, {}, t.subgraph_id);
    const findings = await withLlmContext(
      {
        caller: 'api.review',
        context: {
          deliverable_kind: kind ?? 'other',
          deliverable_chars: stripped.length,
        },
      },
      () =>
        synth.feedback({
          graph,
          edges,
          kind,
          deliverable: stripped,
          profile: t.profile,
        }),
    );
    // Integrity gate (per subgraph): drop reds without a valid node citation,
    // and any finding citing a node outside THIS subgraph's id set.
    const realIds = new Set(graph.map((n) => n.id));
    const safe = findings.filter((f) => {
      if (f.flag === 'red' && (!f.node_id || !realIds.has(f.node_id))) return false;
      if (f.node_id && !realIds.has(f.node_id)) return false;
      return true;
    });
    // Tag provenance ONLY in multi mode so the single-subgraph response shape
    // is unchanged.
    for (const f of safe) merged.push(multiMode ? { ...f, subgraph_id: t.subgraph_id } : f);
    perSub.push({ subgraph_id: t.subgraph_id, cited: safe.length, node_count: graph.length });
  }

  const { id } = await repo.insertReview({
    workspace_id: ws,
    caller: 'web',
    kind,
    deliverable: parsed.data.deliverable,
    findings: merged,
    submitted_by: user_id,
  });
  await repo.logCustomerAudit(ws, {
    event: 'deliverable_submitted',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'review',
    resource_id: id,
    payload: {
      caller: 'web',
      kind,
      findings_count: merged.length,
      reds: merged.filter((f) => f.flag === 'red').length,
      subgraph_ids: targets.map((t) => t.subgraph_id),
    },
  });
  // Cross-user usage record (shape only; the deliverable body stays in the
  // reviews table, not the anonymized text store) — one row per subgraph.
  for (const ps of perSub) {
    await repo.recordContextAccess(ws, {
      actor_user_id: user_id,
      channel: 'web',
      tool: 'review',
      deliverable_kind: kind ?? 'other',
      cited: ps.cited,
      node_count: ps.node_count,
      subgraph_id: ps.subgraph_id,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
    });
  }
  return multiMode
    ? c.json({ id, findings: merged, subgraphs: targets.map((t) => t.subgraph_id) })
    : c.json({ id, findings: merged });
});

// ---------- Day-1 Audit (PRD Goal #6) ----------

const DELIVERABLE_KIND = z.enum([
  'prd',
  'exec_update',
  'campaign',
  'sales_email',
  'deck',
  'other',
]);

app.post('/workspaces/:ws/day-1-audit', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const body = await c.req.json();
  const parsed = z
    .object({
      deliverables: z
        .array(
          z.object({
            source_ref: z.string().max(200).optional(),
            kind: DELIVERABLE_KIND.optional(),
            content: z.string().min(1).max(200_000),
          }),
        )
        .min(1)
        .max(50),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid', details: parsed.error.format() }, 400);
  }

  const report = await runDay1Audit({
    repo,
    synth,
    workspace_id: ws,
    requested_by: user_id,
    deliverables: parsed.data.deliverables,
  });
  // Customer-audit: the act of running the audit is a leader-visible event,
  // but the deliverable contents are not echoed into the audit row.
  await repo.logCustomerAudit(ws, {
    event: 'deliverable_submitted',
    actor_user_id: user_id,
    actor_email: await userEmail(user_id),
    source_ip: clientIp(c),
    user_agent: c.req.header('user-agent') ?? undefined,
    resource_type: 'day1_audit',
    resource_id: report.id,
    payload: {
      caller: 'day1_audit',
      deliverables: report.deliverables_reviewed,
      reds: report.totals.red,
    },
  });
  return c.json(report);
});

app.get('/workspaces/:ws/day-1-audit', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  return c.json({ reports: await listDay1Audits(repo, ws) });
});

app.get('/workspaces/:ws/day-1-audit/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const r = await getDay1Audit(repo, ws, c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  return c.json(r);
});

// ---------- mark feedback as wrong (IC negative-space loop) ----------

/**
 * IC marks a finding as wrong. Captured silently per PRD — no customer-audit
 * event, no leader-facing surface yet. Future v1 work surfaces this corpus
 * for prompt-tuning + a leader-visible triage card.
 *
 * Idempotent. Cross-workspace forgery returns 404 (review id only resolves
 * inside the caller's workspace).
 */
app.post('/workspaces/:ws/reviews/:id/findings/:index/wrong', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const user_id = c.get('user_id');
  const review_id = c.req.param('id');
  const finding_index = Number(c.req.param('index'));
  if (!Number.isInteger(finding_index) || finding_index < 0) {
    return c.json({ error: 'invalid finding_index' }, 400);
  }
  const count = await repo.getReviewFindingsCount(ws, review_id);
  if (count < 0) return c.json({ error: 'review not found' }, 404);
  if (finding_index >= count) return c.json({ error: 'finding_index out of range' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ reason: z.string().max(500).optional() }).safeParse(body);
  const reason = parsed.success ? parsed.data.reason : undefined;

  const res = await repo.markFindingWrong({
    workspace_id: ws,
    review_id,
    finding_index,
    marked_by_user_id: user_id,
    reason,
  });
  return c.json({ ok: true, newly_recorded: res.newly_recorded });
});
}
