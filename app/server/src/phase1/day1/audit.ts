/**
 * Day-1 Audit (PRD Goal #6).
 *
 * "Within 24 hours of onboarding, a single report to the leader: places
 *  where work shipped in the last 30 days contradicts the freshly-built
 *  graph. Built from the materials uploaded during onboarding plus any
 *  additional past output the leader provides."
 *
 * Pipeline:
 *   1. Caller supplies a list of past deliverables (≥1).
 *   2. For each, we run `synth.feedback` against the workspace's current
 *      active graph (same engine as /reviews and MCP review_deliverable).
 *   3. Integrity gate (same as elsewhere): drop findings whose `node_id`
 *      doesn't resolve in the active graph; drop <red>s with no `node_id`.
 *   4. Aggregate into a single report.
 *
 * The report is persisted to `day1_audit_reports` so the leader can revisit
 * it (the PRD frames it as "a single report" — but multiple runs are
 * permissible; the most-recent one is what the UI should surface).
 */
import { nanoid } from 'nanoid';
import type { Repo } from '../db/repo.js';
import type { SynthesisProvider } from '../../lib/synthesis.js';
import type { Finding, Node } from '../../lib/schemas.js';

export type DeliverableKind =
  | 'prd'
  | 'exec_update'
  | 'campaign'
  | 'sales_email'
  | 'deck'
  | 'other';

export interface Day1AuditInputDeliverable {
  /** Free-form identifier the leader can use to find the original. */
  source_ref?: string;
  kind?: DeliverableKind;
  content: string;
}

export interface PerDeliverable {
  source_ref: string;
  kind: DeliverableKind;
  excerpt: string;
  totals: { red: number; yellow: number; green: number };
  top_contradictions: Array<{
    category: string;
    flag: 'red' | 'yellow' | 'green';
    node_id: string | null;
    quote_from_deliverable: string;
    summary: string;
  }>;
  findings_count: number;
}

export interface Day1AuditReport {
  id: string;
  workspace_id: string;
  created_at: string;
  deliverables_reviewed: number;
  totals: { red: number; yellow: number; green: number };
  by_category: Record<string, { red: number; yellow: number; green: number }>;
  per_deliverable: PerDeliverable[];
}

const FEEDBACK_CATEGORIES = [
  'decisions',
  'goals_priorities',
  'positioning',
  'brand_voice',
  'context_recency',
] as const;

function emptyCategoryTotals(): Record<string, { red: number; yellow: number; green: number }> {
  const out: Record<string, { red: number; yellow: number; green: number }> = {};
  for (const c of FEEDBACK_CATEGORIES) out[c] = { red: 0, yellow: 0, green: 0 };
  return out;
}

function filterFindingsByIntegrity(graph: readonly Node[], findings: Finding[]): Finding[] {
  const realIds = new Set(graph.map((n) => n.id));
  return findings.filter((f) => {
    if (f.flag === 'red' && (!f.node_id || !realIds.has(f.node_id))) return false;
    if (f.node_id && !realIds.has(f.node_id)) return false;
    return true;
  });
}

export interface RunDay1AuditOpts {
  repo: Repo;
  synth: SynthesisProvider;
  workspace_id: string;
  requested_by?: string;
  deliverables: Day1AuditInputDeliverable[];
}

export async function runDay1Audit(opts: RunDay1AuditOpts): Promise<Day1AuditReport> {
  // Not subgraph-fanned-out (a pre-multi-subgraph feature) — both calls default
  // to 'default', matching listNodes's own default.
  const graph = await opts.repo.listNodes(opts.workspace_id, { activeOnly: true });
  const edges = await opts.repo.listEdges(opts.workspace_id, {}, 'default');

  const perDeliverable: PerDeliverable[] = [];
  const totals = { red: 0, yellow: 0, green: 0 };
  const byCat = emptyCategoryTotals();

  for (const [i, d] of opts.deliverables.entries()) {
    const findings = await opts.synth.feedback({
      graph,
      edges,
      kind: d.kind ?? 'other',
      deliverable: d.content,
    });
    const safe = filterFindingsByIntegrity(graph, findings);

    const localTotals = { red: 0, yellow: 0, green: 0 };
    for (const f of safe) {
      totals[f.flag]++;
      localTotals[f.flag]++;
      if (FEEDBACK_CATEGORIES.includes(f.category as any)) {
        byCat[f.category]![f.flag]++;
      }
    }
    // Top contradictions = the reds, capped at 5, in their natural order.
    const reds = safe.filter((f) => f.flag === 'red').slice(0, 5);

    perDeliverable.push({
      source_ref: d.source_ref ?? `deliverable_${i + 1}`,
      kind: d.kind ?? 'other',
      excerpt: d.content.slice(0, 240),
      totals: localTotals,
      top_contradictions: reds.map((f) => ({
        category: f.category,
        flag: f.flag,
        node_id: f.node_id,
        quote_from_deliverable: f.quote_from_deliverable,
        summary: f.summary,
      })),
      findings_count: safe.length,
    });
  }

  const id = `d1_${nanoid(10)}`;
  const created_at = new Date().toISOString();
  const report: Day1AuditReport = {
    id,
    workspace_id: opts.workspace_id,
    created_at,
    deliverables_reviewed: opts.deliverables.length,
    totals,
    by_category: byCat,
    per_deliverable: perDeliverable,
  };

  await opts.repo.insertDay1AuditReport(id, opts.workspace_id, opts.requested_by ?? null, opts.deliverables.length, JSON.stringify(report), created_at);
  await opts.repo.logAudit(opts.workspace_id, {
    actor: opts.requested_by,
    event: 'day1_audit.generated',
    resource_type: 'day1_audit',
    resource_id: id,
    payload: {
      deliverables: opts.deliverables.length,
      totals,
    },
  });
  return report;
}

export async function getDay1Audit(
  repo: Repo,
  workspace_id: string,
  id: string,
): Promise<Day1AuditReport | undefined> {
  const row = await repo.getDay1AuditReport(workspace_id, id) as { report: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.report) as Day1AuditReport;
}

export async function listDay1Audits(
  repo: Repo,
  workspace_id: string,
): Promise<Array<{ id: string; created_at: string; deliverables_count: number }>> {
  return await repo.listDay1AuditReports(workspace_id) as Array<{
    id: string;
    created_at: string;
    deliverables_count: number;
  }>;
}
