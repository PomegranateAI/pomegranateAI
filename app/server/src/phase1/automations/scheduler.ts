/**
 * The automations scheduler (redesign of the Automations tab, Stage 4): runs
 * every due `apps_pull` automation on its own cadence. Modeled directly on
 * app/server/src/phase1/updates/scheduler.ts — same re-entrancy guard
 * (`running`), the same "never advance the schedule on failure, back off
 * fail_count instead" discipline, generalized to app-connector ingestion.
 *
 * Only `apps_pull` rows are ever executed here. `shape` automations carry no
 * cadence at all (standing policy, not a scheduled job); `slack_listen`/
 * `track_directory` rows are structurally excluded by repo.dueAutomations'
 * `cadence_ms IS NOT NULL` filter (always NULL for those kinds — see repo.ts).
 * The defensive kind check in runAutomation is belt-and-suspenders in case
 * that invariant is ever violated by a future bug, not a code path that
 * should ever actually fire.
 *
 * Execution reuses the SAME /apps/:app/preview and /apps/:app/pull routes the
 * manual "Run now" action (routes.ts) calls — no separate per-connector
 * implementation. Since there is no live HTTP request to carry a bearer token
 * forward here, each run mints a short-lived session for the automation's
 * owner (repo.createSession) and calls `dispatch` with it; `dispatch` is
 * injected so this module has no dependency on the Hono app instance itself
 * (server.ts wires it to `app.request`).
 *
 * NOT YET IMPLEMENTED: recency/watermark folding. Every scheduled run replays
 * `criteria.query` verbatim rather than narrowing it to "since last run" —
 * see the `recency` field's doc comment on IngestionCriteria (lib/schemas.ts)
 * for the intended mechanism. Ingestion is idempotent by source content, so a
 * repeated overlapping window is wasted work, not a correctness bug — this is
 * a known scope cut for Stage 4, not an oversight.
 */
import type { Repo, Automation } from '../db/repo.js';
import { log } from '../../lib/log.js';

export const ERROR_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export interface AutomationRunReport {
  automation_id: string;
  outcome: 'ok' | 'empty' | 'error';
  items_seen?: number;
  items_ingested?: number;
  error?: string;
}

/** Matches routes.ts's internal dispatchAppsRoute — injected so this module
 *  has no dependency on the Hono app instance or a live HTTP request. */
export type AppsRouteDispatcher = (
  authHeader: string,
  method: 'POST',
  path: string,
  body: Record<string, unknown>,
) => Promise<{ status: number; json: any }>;

export interface AutomationSchedulerDeps {
  repo: Repo;
  dispatch: AppsRouteDispatcher;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface AutomationScheduler {
  runDueOnce(): Promise<AutomationRunReport[]>;
  runAutomation(a: Automation): Promise<AutomationRunReport>;
  start(tickMs?: number): void;
  stop(): void;
}

// Mirrors routes.ts's ingestionCriteriaToRequestBody — kept as its own small
// copy rather than importing across modules, since routes.ts is the busiest,
// most contended file in this codebase and this is a trivial pure function.
function ingestionCriteriaToRequestBody(criteria: NonNullable<Automation['criteria']>): Record<string, unknown> {
  return {
    query: criteria.query,
    mode: criteria.github?.mode ?? 'prs',
    repo: criteria.github?.repo,
    branch: criteria.github?.branch,
    path: criteria.github?.path,
    channel: criteria.slack?.channel,
  };
}

export function createAutomationScheduler(deps: AutomationSchedulerDeps): AutomationScheduler {
  const repo = deps.repo;
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runAutomation(a: Automation): Promise<AutomationRunReport> {
    const runAt = now();
    const nowIso = runAt.toISOString();

    if (a.kind !== 'apps_pull') {
      log.error('automations.due_unsupported_kind', { automation_id: a.id, kind: a.kind });
      return { automation_id: a.id, outcome: 'error', error: `unsupported kind for scheduled run: ${a.kind}` };
    }
    if (!a.connector || !a.criteria || !a.owner_user_id) {
      await repo.recordAutomationRun(a.workspace_id, {
        automation_id: a.id,
        trigger: 'scheduled',
        outcome: 'error',
        error: 'not_configured',
      });
      return { automation_id: a.id, outcome: 'error', error: 'not_configured' };
    }

    const authHeader = `Bearer ${await repo.createSession(a.owner_user_id, 5 * 60)}`;
    const previewBody = ingestionCriteriaToRequestBody(a.criteria);

    try {
      const preview = await deps.dispatch(
        authHeader,
        'POST',
        `/workspaces/${a.workspace_id}/apps/${a.connector}/preview`,
        previewBody,
      );
      if (preview.status !== 200) throw new Error(preview.json?.error ?? `preview failed (${preview.status})`);

      const items = (preview.json.items ?? []) as Array<{ id: string }>;
      if (items.length === 0) {
        await repo.advanceAutomation(a.workspace_id, a.id, {
          last_run_at: nowIso,
          next_run_at: new Date(runAt.getTime() + a.cadence_ms!).toISOString(),
          fail_count: 0,
        });
        await repo.recordAutomationRun(a.workspace_id, {
          automation_id: a.id,
          trigger: 'scheduled',
          outcome: 'empty',
          items_seen: 0,
          summary: 'Nothing matched this run.',
        });
        return { automation_id: a.id, outcome: 'empty', items_seen: 0 };
      }

      const pullBody = {
        ...previewBody,
        item_ids: items.map((i) => i.id),
        subgraph_id: a.subgraph_id ?? undefined,
        instructions: a.run_instructions ?? undefined,
      };
      const pull = await deps.dispatch(
        authHeader,
        'POST',
        `/workspaces/${a.workspace_id}/apps/${a.connector}/pull`,
        pullBody,
      );
      if (pull.status !== 200) throw new Error(pull.json?.error ?? `pull failed (${pull.status})`);

      const results = (pull.json.results ?? []) as Array<{ document_id: string; candidates: number }>;
      const document_ids = results.map((r) => r.document_id);
      const candidate_count =
        pull.json.total_candidates ?? results.reduce((sum, r) => sum + (r.candidates ?? 0), 0);

      await repo.advanceAutomation(a.workspace_id, a.id, {
        last_run_at: nowIso,
        next_run_at: new Date(runAt.getTime() + a.cadence_ms!).toISOString(),
        fail_count: 0,
      });
      await repo.recordAutomationRun(a.workspace_id, {
        automation_id: a.id,
        trigger: 'scheduled',
        outcome: 'ok',
        items_seen: items.length,
        items_ingested: document_ids.length,
        document_ids,
        candidate_count,
        summary: `Ingested ${document_ids.length} of ${items.length} item${items.length === 1 ? '' : 's'} from ${a.connector}`,
      });
      return { automation_id: a.id, outcome: 'ok', items_seen: items.length, items_ingested: document_ids.length };
    } catch (err) {
      // Failure: never advance next_run_at past the retry window (never skip a
      // due run silently) — same discipline as the update scheduler. Bump
      // fail_count and back off, capped.
      const failCount = a.fail_count + 1;
      const cadence = a.cadence_ms ?? ERROR_BACKOFF_CAP_MS;
      const delayMs = Math.min(cadence * 2 ** (failCount - 1), ERROR_BACKOFF_CAP_MS);
      await repo.advanceAutomation(a.workspace_id, a.id, {
        last_run_at: nowIso,
        next_run_at: new Date(runAt.getTime() + delayMs).toISOString(),
        fail_count: failCount,
      });
      const message = (err as Error).message?.slice(0, 300);
      await repo.recordAutomationRun(a.workspace_id, {
        automation_id: a.id,
        trigger: 'scheduled',
        outcome: 'error',
        error: message,
      });
      return { automation_id: a.id, outcome: 'error', error: message };
    }
  }

  async function runDueOnce(): Promise<AutomationRunReport[]> {
    const due = await repo.dueAutomations(now(), 'apps_pull');
    const reports: AutomationRunReport[] = [];
    for (const a of due) {
      const report = await runAutomation(a);
      reports.push(report);
      log.info('automations.scheduled_run', {
        automation_id: report.automation_id,
        outcome: report.outcome,
        items_seen: report.items_seen,
        items_ingested: report.items_ingested,
        error: report.error,
      });
    }
    return reports;
  }

  return {
    runDueOnce,
    runAutomation,
    start(tickMs = 60_000): void {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return; // skip a tick rather than overlap
        running = true;
        runDueOnce()
          .catch((err) => log.warn('automations.tick_failed', { error: (err as Error).message }))
          .finally(() => {
            running = false;
          });
      }, tickMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
