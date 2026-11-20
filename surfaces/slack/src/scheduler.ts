/**
 * The channel-listening scheduler: every tick, run all due subscriptions —
 * collect messages newer than the watermark, batch them into ONE transcript,
 * ingest it into the owner's own workspace (source_kind=slack), advance the
 * watermark, and announce in-channel when the ingest proposed changes.
 *
 * Decoupled from Bolt the same way handlers.ts is: it talks to a narrow
 * {@link ChannelHistoryApi} so tests inject canned history. Failures back off
 * (min(interval, 1h)) WITHOUT advancing the watermark, so a flaky run never
 * drops messages.
 */
import type { Config, PomegranateClient } from './types.js';
import { SubscriptionStore, type Subscription } from './subscriptions.js';
import { resolveCanon, resolveRequester, resolveTeam } from './resolve.js';
import { SurfaceAgentClient } from './surface-client.js';
import { logEvent } from './log.js';

export interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

interface HistoryPage {
  ok?: boolean;
  messages?: SlackHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
  error?: string;
}

/** The subset of the Slack Web API the scheduler needs. */
export interface ChannelHistoryApi {
  conversations: {
    history(args: {
      channel: string;
      oldest?: string;
      cursor?: string;
      limit?: number;
    }): Promise<HistoryPage>;
    replies(args: {
      channel: string;
      ts: string;
      oldest?: string;
      cursor?: string;
      limit?: number;
    }): Promise<HistoryPage>;
    join?(args: { channel: string }): Promise<unknown>;
  };
  chat: {
    postMessage(args: { channel: string; text: string }): Promise<unknown>;
  };
}

export interface SchedulerDeps {
  store: SubscriptionStore;
  config: Config;
  client: PomegranateClient;
  api: ChannelHistoryApi;
  /**
   * Relay mode: ingest through the server's surface-action endpoint (the
   * subscriber's identity + default folder resolve server-side) instead of
   * the legacy per-user token keyring.
   */
  surface?: SurfaceAgentClient;
  botUserId?: string;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RunReport {
  subscription_id: string;
  channel_id: string;
  outcome: 'ok' | 'empty' | 'error';
  messages?: number;
  candidates?: number;
  error?: string;
}

const PAGE_LIMIT = 200;
const MAX_MESSAGES_PER_RUN = 1000;
const ERROR_BACKOFF_CAP_MS = 60 * 60 * 1000;

/** True for messages that should never enter a transcript. */
function isNoise(m: SlackHistoryMessage, botUserId?: string): boolean {
  if (m.bot_id) return true; // any bot/app message, including our own replies
  if (botUserId && m.user === botUserId) return true;
  // Joins/leaves/topic changes etc. File shares and thread broadcasts are
  // real human content and keep their text.
  if (m.subtype && m.subtype !== 'file_share' && m.subtype !== 'thread_broadcast') return true;
  if (!m.text || !m.text.trim()) return true;
  // Bot commands (`@pomegranate ingest …`) are instructions, not content.
  if (botUserId && m.text.includes(`<@${botUserId}>`)) return true;
  return false;
}

/** Map a Slack user id to the mapping's handle, else keep the raw id. */
function handleFor(config: Config, teamId: string, userId: string | undefined): string {
  if (!userId) return 'unknown';
  const u = config.users.find((x) => x.slack_team_id === teamId && x.slack_user_id === userId);
  return u?.slack_handle ?? userId;
}

/** Replace `<@U…>` mention tokens with @handle where the mapping knows them. */
function inlineMentions(config: Config, teamId: string, text: string): string {
  return text.replace(/<@([^>|\s]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${handleFor(config, teamId, id)}`);
}

function tsToIso(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export interface CollectedTranscript {
  text: string;
  count: number;
  /** Newest ts SEEN (including skipped noise) — the next watermark. */
  latestTs: string | null;
}

/**
 * Collect everything newer than `oldest` in a channel: top-level messages
 * plus replies of any thread that had activity in the window. Returns the
 * transcript in chronological order.
 */
export async function collectTranscript(opts: {
  api: ChannelHistoryApi;
  config: Config;
  teamId: string;
  channelId: string;
  oldest: string;
  botUserId?: string;
}): Promise<CollectedTranscript> {
  const { api, config, teamId, channelId, oldest, botUserId } = opts;

  const top: SlackHistoryMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.conversations.history({
      channel: channelId,
      oldest,
      cursor,
      limit: PAGE_LIMIT,
    });
    if (page.ok === false) throw new Error(`conversations.history failed: ${page.error}`);
    top.push(...(page.messages ?? []));
    cursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
  } while (cursor && top.length < MAX_MESSAGES_PER_RUN);

  // Thread replies: for every parent with replies seen in this window, pull
  // the new replies too. (Replies don't appear in conversations.history.)
  const all: SlackHistoryMessage[] = [...top];
  for (const m of top) {
    if (!m.reply_count || m.thread_ts !== m.ts) continue;
    let rCursor: string | undefined;
    do {
      const page = await api.conversations.replies({
        channel: channelId,
        ts: m.ts,
        oldest,
        cursor: rCursor,
        limit: PAGE_LIMIT,
      });
      if (page.ok === false) break; // replies are best-effort
      for (const r of page.messages ?? []) {
        if (r.ts !== m.ts) all.push(r); // skip the parent duplicate
      }
      rCursor = page.has_more ? page.response_metadata?.next_cursor : undefined;
    } while (rCursor && all.length < MAX_MESSAGES_PER_RUN);
  }

  // Watermark covers EVERYTHING seen (noise included) so bot chatter never
  // gets re-scanned forever.
  let latestTs: string | null = null;
  for (const m of all) {
    if (Number(m.ts) > Number(latestTs ?? '0')) latestTs = m.ts;
  }

  const keep = all
    .filter((m) => !isNoise(m, botUserId))
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const lines = keep.map(
    (m) =>
      `[${tsToIso(m.ts)} UTC] ${handleFor(config, teamId, m.user)}: ${inlineMentions(config, teamId, m.text ?? '')}`,
  );

  return { text: lines.join('\n'), count: keep.length, latestTs };
}

export function createListenScheduler(deps: SchedulerDeps) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runSubscription(sub: Subscription): Promise<RunReport> {
    const report: RunReport = {
      subscription_id: sub.id,
      channel_id: sub.channel_id,
      outcome: 'error',
    };
    try {
      // Legacy mode resolves the owner's canon at run time: token rotation or
      // mapping edits apply immediately; a now-unmapped owner fails the run
      // (logged, backed off) instead of ingesting into a stale workspace.
      // Relay mode resolves identity server-side per call — nothing here.
      const canon = deps.surface
        ? null
        : resolveCanon(deps.config, sub.team_id, sub.slack_user_id, env);
      const req = deps.surface
        ? null
        : resolveRequester(deps.config, sub.team_id, sub.slack_user_id);

      // Best-effort (public channels): being a member is required for
      // history. The bot was already a member when `listen` was issued —
      // this only heals "removed and re-added" gaps.
      await deps.api.conversations.join?.({ channel: sub.channel_id }).catch(() => {});

      const collected = await collectTranscript({
        api: deps.api,
        config: deps.config,
        teamId: sub.team_id,
        channelId: sub.channel_id,
        oldest: sub.last_ts,
        botUserId: deps.botUserId,
      });

      if (collected.count === 0) {
        // Nothing human/new — advance the watermark past any noise and go
        // back to sleep quietly (no channel spam).
        deps.store.advance(sub, {
          lastTs: collected.latestTs ?? undefined,
          now: now(),
          nextDelayMs: sub.interval_ms,
        });
        report.outcome = 'empty';
        report.messages = 0;
        return report;
      }

      const day = now().toISOString().slice(0, 10);
      const sourceRef = `slack:${sub.channel_id}:${day}:${collected.latestTs}`;
      let result: { candidates: number };
      if (deps.surface) {
        const apiBaseUrl = resolveTeam(deps.config, sub.team_id).pomegranate_api_url;
        const r = await deps.surface.invokeAction(apiBaseUrl, {
          team_id: sub.team_id,
          slack_user_id: sub.slack_user_id,
          tool: 'ingest_document',
          args: {
            source: collected.text,
            source_kind: 'slack',
            source_ref: sourceRef,
          },
        });
        if (!r.ok) throw new Error(`surface ingest failed: ${JSON.stringify(r.result).slice(0, 200)}`);
        result = { candidates: Number(r.result.candidates ?? 0) };
      } else {
        result = await deps.client.ingest(canon!, req!, collected.text, {
          sourceKind: 'slack',
          sourceRef,
        });
      }

      deps.store.advance(sub, {
        lastTs: collected.latestTs ?? undefined,
        now: now(),
        nextDelayMs: sub.interval_ms,
      });
      report.outcome = 'ok';
      report.messages = collected.count;
      report.candidates = result.candidates;

      if (result.candidates > 0) {
        const n = result.candidates;
        await deps.api.chat
          .postMessage({
            channel: sub.channel_id,
            text:
              `:inbox_tray: Ingested ${collected.count} new message${collected.count === 1 ? '' : 's'} from this channel ` +
              `into <@${sub.slack_user_id}>'s workspace — *${n} proposed change${n === 1 ? '' : 's'}* pending. ` +
              'Say `pending` (mentioning me) to review.',
          })
          .catch(() => {}); // announcement is cosmetic
      }
      return report;
    } catch (err) {
      report.error = (err as Error).message?.slice(0, 300);
      // Keep the watermark; retry sooner than the regular interval but never
      // hot-loop.
      deps.store.advance(sub, {
        now: now(),
        nextDelayMs: Math.min(sub.interval_ms, ERROR_BACKOFF_CAP_MS),
      });
      return report;
    }
  }

  /** Run every due subscription once. Serialized to keep API usage tame. */
  async function runDueOnce(): Promise<RunReport[]> {
    const due = deps.store.due(now());
    const reports: RunReport[] = [];
    for (const sub of due) {
      const report = await runSubscription(sub);
      reports.push(report);
      logEvent('info', 'listen_run', {
        subscription: report.subscription_id,
        channel: report.channel_id,
        outcome: report.outcome,
        messages: report.messages,
        candidates: report.candidates,
        error: report.error,
      });
    }
    return reports;
  }

  return {
    runDueOnce,
    start(tickMs = 60_000): void {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return; // skip a tick rather than overlap
        running = true;
        runDueOnce()
          .catch((err) =>
            logEvent('warn', 'listen_tick_failed', { error: (err as Error).message }),
          )
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
