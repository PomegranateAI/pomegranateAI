// JobQueue.
//
// Every piece of background work goes through enqueue + registerJob instead
// of setImmediate / setInterval / an unawaited promise. In the default setup
// (POMEGRANATE_JOB_QUEUE=inproc) jobs run in-process, as today; on Azure
// (=pg) they are rows in a Postgres `jobs` table claimed by the worker
// container, so the API container can scale to zero and restarts lose nothing.
//
// Handler rules:
//   - Idempotent: a job may run twice (worker crash after the work, before
//     the ack). Handlers re-check state instead of assuming first delivery.
//   - Payloads are ids and small settings only — never customer text. The
//     handler loads what it needs from the repo.
//   - Throwing = retry with backoff, up to `maxAttempts` (default 5); then the
//     job is dead-lettered and logged.
//
// JOB_KINDS is closed: adding a kind is a contract change (A0 + version bump).
// The list comes from the A0 inventory of background work (CONTRACTS.md
// Appendix A) plus the scheduled jobs the plan adds.
//
// Implementations: inproc and pg — A8. This file holds the contract and a
// minimal in-process queue for tests.

export const JOB_KINDS = [
  // from the A0 inventory (Appendix A)
  'embed.node', // embed one node after a write (routes.ts ×2, mcp/registry.ts)
  'embed.backfill', // boot-time backfill of missing node embeddings (server.ts)
  'ingest.followups', // edge inference after a node batch (routes.ts scheduleIngestFollowups)
  'edge.infer', // LLM edge inference for a data-agent batch
  'groups.compute', // candidate grouping precompute (scheduleAutoGroup)
  'subgraph.overview_refresh', // refreshSubgraphOverview after ingest
  'media.process', // media ingest jobs (media-service runDue, 15 s poll today)
  'updates.digest', // Subscribe-to-Updates scheduler tick (60 s today)
  'automations.run', // automations scheduler tick (60 s today)
  // added by the plan (not running today)
  'ingest.capture', // move capture off the request path (A8)
  'wiki.fill', // wiki refresh off the request path
  'retention.sweep', // retention / deletion sweeps (SOC 2)
  'backup.pg-dump', // nightly logical backup to Blob
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** JSON-serialisable; ids and settings only. */
export type JobPayload = Record<string, string | number | boolean | null | string[]>;

export interface EnqueueOptions {
  /** Tenant the job acts for. null only for cross-tenant system jobs (backfill, retention, backup). */
  workspaceId: string | null;
  /** Do not run before this time. Default: now. */
  runAfter?: Date;
  /**
   * While a job with the same (kind, dedupeKey) is queued and not started, a
   * second enqueue is a no-op. Use it for "refresh X" jobs triggered on every
   * write (overview refresh, grouping).
   */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface JobContext {
  kind: JobKind;
  jobId: string;
  workspaceId: string | null;
  /** 1 on first run. */
  attempt: number;
}

export type JobHandler = (payload: JobPayload, ctx: JobContext) => Promise<void>;

export interface JobQueue {
  /** Returns the job id, or null when deduped. */
  enqueue(kind: JobKind, payload: JobPayload, opts: EnqueueOptions): Promise<string | null>;
  /** One handler per kind; registering twice throws. */
  registerJob(kind: JobKind, handler: JobHandler): void;
  /** Stop claiming new jobs and wait for running ones (graceful shutdown). */
  drain(): Promise<void>;
}

/**
 * Minimal in-process queue for tests: runs each job on the next tick, retries
 * immediately up to maxAttempts, honours dedupeKey while queued. Ignores
 * runAfter beyond scheduling with setTimeout. A8 replaces it with the real
 * inproc driver (backoff, concurrency limit, logging).
 */
export function memoryJobQueue(): JobQueue & { idle(): Promise<void> } {
  const handlers = new Map<JobKind, JobHandler>();
  const queuedKeys = new Set<string>();
  const running = new Set<Promise<void>>();
  let seq = 0;
  let draining = false;

  async function run(kind: JobKind, payload: JobPayload, ctxBase: Omit<JobContext, 'attempt'>, max: number, dk?: string) {
    if (dk) queuedKeys.delete(dk);
    const handler = handlers.get(kind);
    if (!handler) throw new Error(`no handler registered for job kind ${kind}`);
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        await handler(payload, { ...ctxBase, attempt });
        return;
      } catch (err) {
        if (attempt === max) throw err;
      }
    }
  }

  return {
    async enqueue(kind, payload, opts) {
      if (draining) throw new Error('job queue is draining');
      const dk = opts.dedupeKey ? `${kind}\u0000${opts.dedupeKey}` : undefined;
      if (dk && queuedKeys.has(dk)) return null;
      if (dk) queuedKeys.add(dk);
      const jobId = `job_${++seq}`;
      const delay = Math.max(0, (opts.runAfter?.getTime() ?? 0) - Date.now());
      const p = new Promise<void>((resolve) => {
        setTimeout(() => {
          run(kind, payload, { kind, jobId, workspaceId: opts.workspaceId }, opts.maxAttempts ?? 5, dk)
            .catch(() => {
              // dead-lettered; the real driver logs it
            })
            .finally(resolve);
        }, delay);
      });
      running.add(p);
      void p.finally(() => running.delete(p));
      return jobId;
    },
    registerJob(kind, handler) {
      if (handlers.has(kind)) throw new Error(`job kind ${kind} already has a handler`);
      handlers.set(kind, handler);
    },
    async drain() {
      draining = true;
      await Promise.all([...running]);
    },
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
  };
}
