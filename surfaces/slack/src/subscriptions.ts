/**
 * [shared] Channel-listening subscriptions: types + a small file-backed store.
 *
 * A subscription says "ingest new messages from THIS channel into THIS Slack
 * user's own workspace every N ms". The owner's canon (workspace + token) is
 * resolved at RUN time from the mapping config, so token rotation or mapping
 * edits apply without touching stored state.
 *
 * Persistence is a single JSON file (default ./data/subscriptions.json,
 * volume-mounted in Docker) written atomically (tmp + rename) — losing a tick
 * is acceptable, corrupting the file is not.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Subscription {
  id: string;
  team_id: string;
  channel_id: string;
  /** Slack user whose OWN workspace receives the ingested transcripts. */
  slack_user_id: string;
  interval_ms: number;
  /**
   * Slack ts watermark — only messages strictly newer than this are collected
   * on the next run (Slack's `oldest` param is exclusive by default).
   */
  last_ts: string;
  /** ISO datetime of the next scheduled run. */
  next_run_at: string;
  created_at: string;
}

interface StoreFile {
  subscriptions: Subscription[];
}

export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MIN_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function subKey(teamId: string, channelId: string, slackUserId: string): string {
  return `${teamId}:${channelId}:${slackUserId}`;
}

export class SubscriptionStore {
  private readonly filePath: string;
  private data: StoreFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StoreFile {
    if (!existsSync(this.filePath)) return { subscriptions: [] };
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile;
      if (!Array.isArray(raw.subscriptions)) return { subscriptions: [] };
      return raw;
    } catch {
      // A corrupt state file must not kill the bot; start empty and let the
      // next persist overwrite it. (Subscriptions are cheap to re-create.)
      return { subscriptions: [] };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = join(
      dirname(this.filePath),
      `.subscriptions-${randomBytes(4).toString('hex')}.tmp`,
    );
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.filePath);
  }

  list(teamId?: string, slackUserId?: string): Subscription[] {
    return this.data.subscriptions.filter(
      (s) =>
        (teamId === undefined || s.team_id === teamId) &&
        (slackUserId === undefined || s.slack_user_id === slackUserId),
    );
  }

  get(teamId: string, channelId: string, slackUserId: string): Subscription | undefined {
    return this.data.subscriptions.find(
      (s) => subKey(s.team_id, s.channel_id, s.slack_user_id) === subKey(teamId, channelId, slackUserId),
    );
  }

  /**
   * Create or update the (team, channel, user) subscription. A new
   * subscription starts its watermark at `nowTs` — only messages sent AFTER
   * the `listen` command are ever ingested. Updating an existing one only
   * changes the interval (the watermark and history are preserved).
   */
  upsert(opts: {
    teamId: string;
    channelId: string;
    slackUserId: string;
    intervalMs: number;
    nowTs: string;
    now: Date;
  }): { sub: Subscription; created: boolean } {
    const existing = this.get(opts.teamId, opts.channelId, opts.slackUserId);
    if (existing) {
      existing.interval_ms = opts.intervalMs;
      existing.next_run_at = new Date(opts.now.getTime() + opts.intervalMs).toISOString();
      this.persist();
      return { sub: existing, created: false };
    }
    const sub: Subscription = {
      id: `sub_${randomBytes(6).toString('hex')}`,
      team_id: opts.teamId,
      channel_id: opts.channelId,
      slack_user_id: opts.slackUserId,
      interval_ms: opts.intervalMs,
      last_ts: opts.nowTs,
      next_run_at: new Date(opts.now.getTime() + opts.intervalMs).toISOString(),
      created_at: opts.now.toISOString(),
    };
    this.data.subscriptions.push(sub);
    this.persist();
    return { sub, created: true };
  }

  remove(teamId: string, channelId: string, slackUserId: string): boolean {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter(
      (s) => subKey(s.team_id, s.channel_id, s.slack_user_id) !== subKey(teamId, channelId, slackUserId),
    );
    const removed = this.data.subscriptions.length < before;
    if (removed) this.persist();
    return removed;
  }

  /** Subscriptions whose next_run_at is in the past. */
  due(now: Date): Subscription[] {
    return this.data.subscriptions.filter((s) => new Date(s.next_run_at) <= now);
  }

  /**
   * Advance a subscription after a run: move the watermark (when the run saw
   * messages) and schedule the next run. `nextDelayMs` lets the scheduler
   * back off on errors without losing the watermark.
   */
  advance(sub: Subscription, opts: { lastTs?: string; now: Date; nextDelayMs: number }): void {
    const live = this.data.subscriptions.find((s) => s.id === sub.id);
    if (!live) return; // removed mid-run
    if (opts.lastTs) live.last_ts = opts.lastTs;
    live.next_run_at = new Date(opts.now.getTime() + opts.nextDelayMs).toISOString();
    this.persist();
  }
}

/**
 * Parse an `every N <unit>` interval spec from a listen command's remainder.
 * Returns DEFAULT_INTERVAL_MS when absent, null when present but malformed
 * or out of range (caller turns that into a usage reply).
 */
export function parseIntervalSpec(remainder: string): number | null {
  const m = /\bevery\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i.exec(
    remainder,
  );
  if (!m) {
    // `every` with nothing parseable after it → malformed, not default.
    if (/\bevery\b/i.test(remainder)) return null;
    return DEFAULT_INTERVAL_MS;
  }
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const ms =
    unit.startsWith('m') && unit !== 'month'
      ? n * 60 * 1000
      : unit.startsWith('h')
        ? n * 60 * 60 * 1000
        : n * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;
  return Math.round(ms);
}

/** Human-readable interval, e.g. "24h", "30m", "2d". */
export function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`.replace('.0', '');
  return `${Math.round((hours / 24) * 10) / 10}d`.replace('.0', '');
}
