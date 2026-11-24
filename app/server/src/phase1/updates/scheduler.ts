/**
 * The update scheduler (spec §5). Every tick, run every due subscription once:
 * collect what changed on its topic since the watermark, synthesize a cited
 * update, deliver it, keep it. Modeled directly on the Slack channel-listening
 * scheduler (surfaces/slack/src/scheduler.ts) — the same `running` re-entrancy
 * guard, per-sub serialization, and "back off on failure WITHOUT advancing the
 * watermark" discipline, generalized to a DB-backed, medium-agnostic runner.
 *
 * `runDueOnce()` returns a report array and is directly unit-testable (no timer,
 * no network — inject `now`, `transports`, and `synthesize`).
 */
import type { Repo, UpdateSubscription, UpdateTarget } from '../db/repo.js';
import { changesSince, changeCount, type ChangedNode } from '../lib/change-window.js';
import { rankChangesByTopic } from './relevance.js';
import {
  synthesizeUpdate,
  type UpdateDigest,
  type UpdateDigestInput,
} from './synthesize.js';
import { defaultTransports, type UpdateTransport } from './transport.js';
import { checkRecipients, splitDestination } from './recipients.js';
import { log } from '../../lib/log.js';

/** Backoff cap: a failing subscription retries at most this far out. */
export const ERROR_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/** No one to send to: no allowed recipients, and no owner channel to fall back on. */
const NO_DESTINATION = 'no destination: no allowed recipients and owner has no account email';

export interface RunReport {
  subscription_id: string;
  // 'ok' delivered; 'empty' nothing topical moved; 'pending' a review-mode
  // update is held for the owner's approval; 'error' the run failed.
  outcome: 'ok' | 'empty' | 'pending' | 'error';
  change_count?: number;
  delivery_id?: string;
  error?: string;
}

export interface UpdateSchedulerDeps {
  repo: Repo;
  /** Transports by medium; defaults built from env (email → Resend or logging). */
  transports?: Partial<Record<'email' | 'slack', UpdateTransport>>;
  /** Base URL for in-app "Open update" links; from env when omitted. */
  appBaseUrl?: string;
  /**
   * Engagement tracking (open pixel + click-counting redirect). OFF by
   * default: an email carrying a hidden pixel is monitoring the recipient,
   * which needs disclosure under privacy rules (and a school or company
   * deployment may not want it at all). Opt in with UPDATES_TRACKING=1.
   */
  trackEngagement?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable synthesis (tests) — defaults to the LLM/fallback path. */
  synthesize?: (input: UpdateDigestInput) => Promise<UpdateDigest>;
}

export interface UpdateScheduler {
  runDueOnce(): Promise<RunReport[]>;
  runSubscription(sub: UpdateSubscription): Promise<RunReport>;
  /** Deliver a review-mode delivery the owner has approved (routes: approve). */
  sendPendingDelivery(deliveryId: string): Promise<RunReport>;
  start(tickMs?: number): void;
  stop(): void;
}

export function createUpdateScheduler(deps: UpdateSchedulerDeps): UpdateScheduler {
  const repo = deps.repo;
  const now = deps.now ?? (() => new Date());
  const transports = deps.transports ?? defaultTransports();
  const synth = deps.synthesize ?? synthesizeUpdate;
  const appBaseUrl = (deps.appBaseUrl ?? process.env.PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  // Tracking endpoints are app routes reached from the public internet, where
  // the reverse proxy only forwards the API prefix (`/api/*`) to the server.
  // So pixel/click URLs use the API base; the click endpoint itself redirects
  // back to the SPA (appBaseUrl). PUBLIC_API_URL overrides for other topologies.
  const apiBaseUrl = (
    process.env.PUBLIC_API_URL ??
    (appBaseUrl ? `${appBaseUrl}/api` : '')
  ).replace(/\/$/, '');
  const trackEngagement = deps.trackEngagement ?? process.env.UPDATES_TRACKING === '1';
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /** Targets the owner can still read — membership is re-checked at run time. */
  async function readableTargets(sub: UpdateSubscription): Promise<UpdateTarget[]> {
    const out: UpdateTarget[] = [];
    for (const t of sub.targets) if (await repo.getMembership(t.workspace_id, sub.owner_user_id)) out.push(t);
    return out;
  }

  /**
   * Send a recorded update's body over a transport with the standard tracking
   * link + open pixel. Shared by the autonomous path and `sendPendingDelivery`
   * so all transport/tracking wiring lives in one place. Does NOT touch DB
   * state — the caller stamps `delivered_at`/status after a successful send.
   */
  async function deliverBody(
    transport: UpdateTransport,
    to: string[],
    delivery: { id: string; title: string; body: string },
  ): Promise<void> {
    // With tracking on, engagement links route through the public tracking
    // endpoints (§8): the "Open" link redirects (counting a click), and email
    // carries a 1×1 open pixel. With tracking off (the default) the link goes
    // straight to the app and there is no pixel. Both no-op when no public base
    // URL is configured (dev).
    const msg = trackEngagement
      ? {
          title: delivery.title,
          body: delivery.body,
          link: apiBaseUrl ? `${apiBaseUrl}/updates/track/click/${delivery.id}` : undefined,
          openPixelUrl: apiBaseUrl ? `${apiBaseUrl}/updates/track/open/${delivery.id}.gif` : undefined,
        }
      : {
          title: delivery.title,
          body: delivery.body,
          link: appBaseUrl ? `${appBaseUrl}/#updates` : undefined,
        };
    // A 'give' watch broadcasts to many recipients; one send each, sequentially,
    // so a bad address is attributable. The first failure throws — the caller
    // treats the whole run as failed and retries the window, which can re-send
    // to recipients already reached. That's the deliberate trade: a duplicate
    // update is recoverable, a silently dropped one isn't.
    for (const addr of to) {
      await transport.send({ ...msg, to: addr });
    }
  }

  /**
   * Review mode: ping the owner that an update is ready to approve. This is a
   * NOTIFICATION, not the update itself — a short preview plus a link into the
   * app, where the pending delivery (the durable in-app notification) is sent or
   * discarded. Best-effort: the caller swallows failures so a flaky channel
   * never loses the pending row.
   */
  async function notifyApprovalNeeded(
    sub: UpdateSubscription,
    to: string,
    delivery: { body: string },
  ): Promise<void> {
    const transport = transports[sub.medium];
    if (!transport) return; // no channel wired → the in-app pending item stands alone
    const preview = delivery.body.slice(0, 280);
    const ellipsis = delivery.body.length > 280 ? '…' : '';
    await transport.send({
      to,
      title: `Update ready to review: ${sub.topic}`.slice(0, 150),
      body:
        `A new update on “${sub.topic}” is ready for your approval.\n\n` +
        `${preview}${ellipsis}\n\n` +
        `Open Pomegranate to review and send it.`,
      link: appBaseUrl ? `${appBaseUrl}/#updates` : undefined,
    });
  }

  async function runSubscription(sub: UpdateSubscription): Promise<RunReport> {
    const report: RunReport = { subscription_id: sub.id, outcome: 'error' };
    const runAt = now();
    const windowFrom = sub.watermark;
    const windowTo = runAt.toISOString();
    // The delivery row is written before the send (its id is the "Open" link
    // target). If the send throws we roll it back, so a failed run leaves no
    // orphan/duplicate row — the same window is re-synthesized cleanly next tick.
    let pendingDeliveryId: string | null = null;
    try {
      // 1–3. Collect + topic-filter changes across every readable target.
      const topicalNodes: ChangedNode[] = [];
      const documents: Array<{ id: string; summary: string | null }> = [];
      let approved = 0;
      let rejected = 0;
      for (const target of await readableTargets(sub)) {
        const win = await changesSince(repo, target, windowFrom, {
          viewer_user_id: sub.owner_user_id,
          aiRead: true,
        });
        const { topical } = await rankChangesByTopic(
          repo,
          target.workspace_id,
          sub.topic_embedding,
          win.nodes,
        );
        topicalNodes.push(...topical);
        for (const d of win.documents) documents.push({ id: d.id, summary: d.summary });
        approved += win.resolvedCandidates.approved;
        rejected += win.resolvedCandidates.rejected;
      }

      const hasTopical = topicalNodes.length > 0 || documents.length > 0;

      // 4. Synthesize (skipped entirely when nothing topical moved).
      let digest: UpdateDigest = hasTopical
        ? await synth({
            topic: sub.topic,
            window: { from: windowFrom, to: windowTo },
            nodes: topicalNodes.map((n) => ({
              id: n.id,
              title: nodeTitle(n),
              snippet: nodeSnippet(n),
            })),
            documents,
            resolvedCandidates: { approved, rejected },
          })
        : { title: sub.topic, body: '', cited_node_ids: [], is_empty: true };

      // 5a. Empty window: a 'get' watch monitors a topic it doesn't own, so
      // "nothing changed" is noise — skip the send, advance the watermark, and
      // record a zero-change run with no delivered row (spec D4). A 'give'
      // broadcast is a status update to teammates under the owner's name, so
      // silence isn't the safe default: "nothing to report" IS the status, and
      // an owner who explicitly asked to "keep your team posted" expects that
      // to include quiet stretches, not silent no-ops. Swap in a no-news digest
      // and fall through to the normal deliver path below.
      if (digest.is_empty || !digest.body.trim()) {
        if (sub.kind !== 'give') {
          await repo.advanceUpdateSubscription(sub.id, {
            last_run_at: windowTo,
            next_run_at: new Date(runAt.getTime() + sub.cadence_ms).toISOString(),
            watermark: windowTo,
            fail_count: 0,
          });
          report.outcome = 'empty';
          report.change_count = 0;
          return report;
        }
        digest = {
          title: digest.title || sub.topic,
          body: `No updates on "${sub.topic}" since the last report.`,
          cited_node_ids: [],
          is_empty: false,
        };
      }

      // 5b. We have a real update. Resolve the recipients for both paths.
      const to = await destinationsFor(sub);
      if (to.length === 0) throw new Error(NO_DESTINATION);

      // Record the delivery first (kept even if a send lags). Review mode records
      // it as PENDING (held for approval); autonomous records it as sent-in-flight.
      const delivery = await repo.recordUpdateDelivery({
        subscription_id: sub.id,
        owner_user_id: sub.owner_user_id,
        window_from: windowFrom,
        window_to: windowTo,
        title: digest.title,
        body: digest.body,
        cited_node_ids: digest.cited_node_ids,
        change_count: topicalNodes.length + documents.length + approved + rejected,
        medium: sub.medium,
        status: sub.approval_mode === 'review' ? 'pending' : 'sent',
      });
      pendingDeliveryId = delivery.id;

      // ── Review mode: hold the update, notify the owner to approve. ──────────
      if (sub.approval_mode === 'review') {
        // The pending delivery is the durable in-app notification; the channel
        // ping is best-effort and must never lose the pending row.
        try {
          // The ping goes to the OWNER — never to `to`. On a 'give' watch those
          // are the teammates being broadcast to, and pinging them to approve
          // the owner's own update would leak it before it was approved.
          const approver = sub.kind === 'give' ? await ownerChannel(sub) : to[0];
          if (approver) await notifyApprovalNeeded(sub, approver, delivery);
        } catch (err) {
          log.warn('updates.notify_failed', {
            subscription: sub.id,
            error: (err as Error).message,
          });
        }
        // The window is captured in the pending row — advance the watermark and
        // reset backoff (approving sends it later; discarding is an intentional
        // drop). Committed now: clear the rollback marker.
        await repo.advanceUpdateSubscription(sub.id, {
          last_run_at: windowTo,
          next_run_at: new Date(runAt.getTime() + sub.cadence_ms).toISOString(),
          watermark: windowTo,
          fail_count: 0,
        });
        pendingDeliveryId = null;
        report.outcome = 'pending';
        report.change_count = topicalNodes.length + documents.length;
        report.delivery_id = delivery.id;
        return report;
      }

      // ── Autonomous mode: deliver now. ──────────────────────────────────────
      const transport = transports[sub.medium];
      if (!transport) throw new Error(`no transport wired for medium '${sub.medium}'`);
      await deliverBody(transport, to, delivery);

      // 6. Success — mark delivered, advance watermark, reset backoff.
      await repo.setUpdateDeliveryStatus(delivery.id, 'sent', { delivered_at: windowTo });
      await repo.advanceUpdateSubscription(sub.id, {
        last_run_at: windowTo,
        next_run_at: new Date(runAt.getTime() + sub.cadence_ms).toISOString(),
        watermark: windowTo,
        fail_count: 0,
      });
      report.outcome = 'ok';
      report.change_count = topicalNodes.length + documents.length;
      report.delivery_id = delivery.id;
      return report;
    } catch (err) {
      // Roll back a half-written delivery so a failed send leaves no orphan row.
      if (pendingDeliveryId) {
        await repo.deleteUpdateDelivery(pendingDeliveryId);
      }
      // Failure: never advance the watermark (never drop a window). Bump
      // fail_count and back off; the same window is retried next tick.
      const failCount = sub.fail_count + 1;
      const delayMs = Math.min(sub.cadence_ms * 2 ** (failCount - 1), ERROR_BACKOFF_CAP_MS);
      await repo.advanceUpdateSubscription(sub.id, {
        last_run_at: windowTo,
        next_run_at: new Date(runAt.getTime() + delayMs).toISOString(),
        fail_count: failCount,
      });
      report.error = (err as Error).message?.slice(0, 300);
      return report;
    }
  }

  /**
   * The owner's own channel on this medium — where an update with no explicit
   * destination lands, and where a review-mode approval ping always goes.
   */
  async function ownerChannel(sub: UpdateSubscription): Promise<string | null> {
    if (sub.medium === 'email') return (await repo.getUserById(sub.owner_user_id))?.email ?? null;
    if (sub.medium === 'slack') {
      // No explicit channel → DM the owner. The transport opens a DM from the
      // Slack user id; pick the owner's first linked Slack identity.
      const slack = (await repo.listUserIdentities(sub.owner_user_id)).find((i) => i.kind === 'slack');
      return slack?.external_id ?? null;
    }
    return null;
  }

  /**
   * Everyone this update is sent to. `destination` holds a comma-separated list
   * — one address for a 'get' watch (the owner), a broadcast list for a 'give'
   * one — and empty means the owner's own channel.
   *
   * Explicit recipients are re-validated here (membership can change after
   * the watch was created): anyone who is no longer allowed is dropped. If
   * that leaves nobody, the result is empty, the same "no destination" outcome
   * as an owner with no channel. It does NOT fall back to the owner, so a
   * broadcast never quietly turns into a note to self.
   */
  async function destinationsFor(sub: UpdateSubscription): Promise<string[]> {
    const explicit = splitDestination(sub.destination);
    if (explicit.length > 0) {
      const { allowed, rejected } = await checkRecipients(repo, {
        ownerUserId: sub.owner_user_id,
        targets: sub.targets,
        recipients: explicit,
      });
      if (rejected.length > 0) {
        // Count only: never log the addresses themselves.
        log.warn('updates.recipients_dropped', {
          subscription: sub.id,
          dropped: rejected.length,
          remaining: allowed.length,
        });
      }
      return allowed;
    }
    const own = await ownerChannel(sub);
    return own ? [own] : [];
  }

  /**
   * Deliver a review-mode delivery the owner has approved. Sends the held body
   * over its medium (with tracking) and marks it sent. Idempotency + ownership
   * are the route's job; here we only re-check the delivery is still `pending`.
   */
  async function sendPendingDelivery(deliveryId: string): Promise<RunReport> {
    const report: RunReport = {
      subscription_id: '',
      outcome: 'error',
      delivery_id: deliveryId,
    };
    const delivery = await repo.getUpdateDelivery(deliveryId);
    if (!delivery) {
      report.error = 'delivery not found';
      return report;
    }
    report.subscription_id = delivery.subscription_id;
    if (delivery.status !== 'pending') {
      report.error = `delivery is '${delivery.status}', not pending`;
      return report;
    }
    const sub = await repo.getUpdateSubscription(delivery.subscription_id);
    if (!sub) {
      report.error = 'subscription not found';
      return report;
    }
    const transport = transports[delivery.medium];
    if (!transport) {
      report.error = `no transport wired for medium '${delivery.medium}'`;
      return report;
    }
    const to = await destinationsFor(sub);
    if (to.length === 0) {
      report.error = NO_DESTINATION;
      return report;
    }
    try {
      await deliverBody(transport, to, delivery);
      await repo.setUpdateDeliveryStatus(delivery.id, 'sent', { delivered_at: now().toISOString() });
      report.outcome = 'ok';
      return report;
    } catch (err) {
      report.error = (err as Error).message?.slice(0, 300);
      return report;
    }
  }

  async function runDueOnce(): Promise<RunReport[]> {
    const due = await repo.dueUpdateSubscriptions(now());
    const reports: RunReport[] = [];
    for (const sub of due) {
      const report = await runSubscription(sub);
      reports.push(report);
      log.info('updates.run', {
        subscription: report.subscription_id,
        outcome: report.outcome,
        change_count: report.change_count,
        error: report.error,
      });
    }
    return reports;
  }

  return {
    runDueOnce,
    runSubscription,
    sendPendingDelivery,
    start(tickMs = 60_000): void {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return; // skip a tick rather than overlap
        running = true;
        runDueOnce()
          .catch((err) => log.warn('updates.tick_failed', { error: (err as Error).message }))
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

// `changeCount` is re-exported for callers that want the window total without
// re-importing change-window (keeps the scheduler the single updates entrypoint).
export { changeCount };

function nodeTitle(n: ChangedNode): string {
  const d = n.data;
  return String(d.title ?? d.summary ?? d.name ?? n.id).slice(0, 140);
}
function nodeSnippet(n: ChangedNode): string {
  const d = n.data;
  const text = (d.summary ?? d.body ?? '') as string;
  return String(text).slice(0, 240);
}
