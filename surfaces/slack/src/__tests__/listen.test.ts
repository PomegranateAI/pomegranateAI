/**
 * Phase-2 channel listening: subscription store round-trips, interval
 * parsing, the listen/stop/status verbs, and the scheduler's collect →
 * ingest → watermark loop (incl. error backoff and noise filtering).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SubscriptionStore,
  parseIntervalSpec,
  formatInterval,
  DEFAULT_INTERVAL_MS,
} from '../subscriptions.js';
import {
  collectTranscript,
  createListenScheduler,
  type ChannelHistoryApi,
  type SlackHistoryMessage,
} from '../scheduler.js';
import { createMentionHandler } from '../handlers.js';
import { parseMention } from '../parse.js';
import { parseConfig } from '../config.js';
import type {
  Config,
  MentionContext,
  PomegranateClient,
  IngestResult,
} from '../types.js';

const config: Config = parseConfig({
  teams: [{ slack_team_id: 'T1', pomegranate_api_url: 'http://localhost:3000' }],
  users: [
    {
      slack_team_id: 'T1',
      slack_user_id: 'U_ALICE',
      slack_handle: 'alice',
      pomegranate_user_id: 'u_alice',
      pomegranate_workspace_id: 'ws_alice',
      mcp_token_env: 'TOK_ALICE',
    },
  ],
});
const env = { TOK_ALICE: 'secret' };

function tmpStore(): SubscriptionStore {
  return new SubscriptionStore(join(mkdtempSync(join(tmpdir(), 'pom-subs-')), 'subs.json'));
}

// ---------- interval parsing ----------

describe('parseIntervalSpec', () => {
  it('defaults to 24h when no spec is present', () => {
    expect(parseIntervalSpec('')).toBe(DEFAULT_INTERVAL_MS);
    expect(parseIntervalSpec('to this channel please')).toBe(DEFAULT_INTERVAL_MS);
  });

  it('parses minutes/hours/days variants', () => {
    expect(parseIntervalSpec('every 30m')).toBe(30 * 60_000);
    expect(parseIntervalSpec('every 30 minutes')).toBe(30 * 60_000);
    expect(parseIntervalSpec('every 12h')).toBe(12 * 3600_000);
    expect(parseIntervalSpec('every 12 hours')).toBe(12 * 3600_000);
    expect(parseIntervalSpec('every 2 days')).toBe(2 * 24 * 3600_000);
  });

  it('rejects malformed or out-of-range specs', () => {
    expect(parseIntervalSpec('every banana')).toBeNull();
    expect(parseIntervalSpec('every 1m')).toBeNull(); // < 5m floor
    expect(parseIntervalSpec('every 30 days')).toBeNull(); // > 7d cap
  });

  it('formats intervals back for humans', () => {
    expect(formatInterval(DEFAULT_INTERVAL_MS)).toBe('24h');
    expect(formatInterval(30 * 60_000)).toBe('30m');
  });
});

// ---------- parse: listen verbs ----------

describe('parseMention — listen grammar', () => {
  it('listen with and without interval', () => {
    expect(parseMention('<@BOT> listen', 'BOT').verb).toBe('listen');
    const cmd = parseMention('<@BOT> listen every 12h', 'BOT');
    expect(cmd.verb).toBe('listen');
    expect(cmd.remainder).toBe('every 12h');
  });

  it('stop listening beats the bare listening status verb', () => {
    expect(parseMention('<@BOT> stop listening', 'BOT').verb).toBe('stoplisten');
    expect(parseMention('<@BOT> unlisten', 'BOT').verb).toBe('stoplisten');
    expect(parseMention('<@BOT> listening', 'BOT').verb).toBe('listening');
  });
});

// ---------- store ----------

describe('SubscriptionStore', () => {
  it('round-trips through the file and survives reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pom-subs-'));
    const path = join(dir, 'subs.json');
    const a = new SubscriptionStore(path);
    const now = new Date('2026-06-04T00:00:00Z');
    a.upsert({
      teamId: 'T1',
      channelId: 'C1',
      slackUserId: 'U_ALICE',
      intervalMs: 3600_000,
      nowTs: '100.000000',
      now,
    });
    const b = new SubscriptionStore(path);
    const sub = b.get('T1', 'C1', 'U_ALICE')!;
    expect(sub.interval_ms).toBe(3600_000);
    expect(sub.last_ts).toBe('100.000000');
    expect(sub.next_run_at).toBe('2026-06-04T01:00:00.000Z');
  });

  it('upsert preserves the watermark; remove() and due() behave', () => {
    const store = tmpStore();
    const now = new Date('2026-06-04T00:00:00Z');
    store.upsert({ teamId: 'T1', channelId: 'C1', slackUserId: 'U_ALICE', intervalMs: 3600_000, nowTs: '100.0', now });
    const updated = store.upsert({
      teamId: 'T1', channelId: 'C1', slackUserId: 'U_ALICE', intervalMs: 60 * 60_000 * 2, nowTs: '999.0', now,
    });
    expect(updated.created).toBe(false);
    expect(updated.sub.last_ts).toBe('100.0'); // watermark untouched on update

    expect(store.due(new Date('2026-06-04T01:00:00Z'))).toHaveLength(0); // next at 02:00
    expect(store.due(new Date('2026-06-04T02:00:01Z'))).toHaveLength(1);

    expect(store.remove('T1', 'C1', 'U_ALICE')).toBe(true);
    expect(store.remove('T1', 'C1', 'U_ALICE')).toBe(false);
  });
});

// ---------- verb handlers (through the mention pipeline) ----------

function listenCtx(text: string, eventId: string): MentionContext & { replies: string[] } {
  const replies: string[] = [];
  return {
    text,
    files: [],
    requesterUserId: 'U_ALICE',
    teamId: 'T1',
    channelId: 'C_LISTEN',
    threadKey: 'C_LISTEN:1.1',
    eventId,
    replies,
    async react() {},
    async reply(t: string) {
      replies.push(t);
    },
    async replyEditable(t: string) {
      replies.push(t);
      return async (nt: string) => {
        replies.push(nt);
      };
    },
    async fetchFileText() {
      return '';
    },
  };
}

const nullClient: PomegranateClient = {
  review: async () => ({ id: 'r', findings: [] }),
  getContext: async () => ({ answer: '', cited_node_ids: [], has_answer: false }),
  ingest: async () => ({ candidates: 0, document_id: 'd' }),
  listCandidates: async () => ({ status: 'pending', total: 0, candidates: [] }),
  approveCandidate: async () => ({ ok: true }),
  rejectCandidate: async () => ({ ok: true }),
};

describe('listen / stop listening / listening verbs', () => {
  let store: SubscriptionStore;
  beforeEach(() => {
    store = tmpStore();
  });

  it('listen subscribes the channel for the requester (default 24h)', async () => {
    const handle = createMentionHandler({ config, client: nullClient, botUserId: 'BOT', env, subscriptions: store });
    const ctx = listenCtx('<@BOT> listen', 'ev1');
    await handle(ctx);
    const sub = store.get('T1', 'C_LISTEN', 'U_ALICE')!;
    expect(sub.interval_ms).toBe(DEFAULT_INTERVAL_MS);
    expect(ctx.replies[0]).toContain('Listening to <#C_LISTEN>');
    expect(ctx.replies[0]).toContain('24h');
  });

  it('listen every 12h sets the interval; repeating updates it', async () => {
    const handle = createMentionHandler({ config, client: nullClient, botUserId: 'BOT', env, subscriptions: store });
    await handle(listenCtx('<@BOT> listen every 12h', 'ev2'));
    expect(store.get('T1', 'C_LISTEN', 'U_ALICE')!.interval_ms).toBe(12 * 3600_000);
    const ctx = listenCtx('<@BOT> listen every 30m', 'ev3');
    await handle(ctx);
    expect(store.get('T1', 'C_LISTEN', 'U_ALICE')!.interval_ms).toBe(30 * 60_000);
    expect(ctx.replies[0]).toContain('Updated');
  });

  it('malformed interval → usage reply, no subscription', async () => {
    const handle = createMentionHandler({ config, client: nullClient, botUserId: 'BOT', env, subscriptions: store });
    const ctx = listenCtx('<@BOT> listen every banana', 'ev4');
    await handle(ctx);
    expect(store.list()).toHaveLength(0);
    expect(ctx.replies[0]).toContain("couldn't read that interval");
  });

  it('stop listening removes; listening reports', async () => {
    const handle = createMentionHandler({ config, client: nullClient, botUserId: 'BOT', env, subscriptions: store });
    await handle(listenCtx('<@BOT> listen', 'ev5'));
    const status = listenCtx('<@BOT> listening', 'ev6');
    await handle(status);
    expect(status.replies[0]).toContain('<#C_LISTEN>');
    const stop = listenCtx('<@BOT> stop listening', 'ev7');
    await handle(stop);
    expect(stop.replies[0]).toContain('Stopped listening');
    expect(store.list()).toHaveLength(0);
    const statusEmpty = listenCtx('<@BOT> listening', 'ev8');
    await handle(statusEmpty);
    expect(statusEmpty.replies[0]).toContain('not listening');
  });

  it('unmapped requester cannot listen', async () => {
    const handle = createMentionHandler({ config, client: nullClient, botUserId: 'BOT', env, subscriptions: store });
    const ctx = listenCtx('<@BOT> listen', 'ev9');
    (ctx as { requesterUserId: string }).requesterUserId = 'U_GHOST';
    await handle(ctx);
    expect(store.list()).toHaveLength(0);
    expect(ctx.replies[0]).toContain('U_GHOST');
  });
});

// ---------- scheduler ----------

function fakeApi(opts: {
  history: SlackHistoryMessage[];
  replies?: Record<string, SlackHistoryMessage[]>;
  failHistory?: boolean;
}): ChannelHistoryApi & { posted: Array<{ channel: string; text: string }>; historyCalls: Array<{ oldest?: string }> } {
  const posted: Array<{ channel: string; text: string }> = [];
  const historyCalls: Array<{ oldest?: string }> = [];
  return {
    posted,
    historyCalls,
    conversations: {
      async history(args) {
        historyCalls.push({ oldest: args.oldest });
        if (opts.failHistory) return { ok: false, error: 'not_in_channel' };
        // honor `oldest` (exclusive) like Slack does
        const messages = opts.history.filter((m) => Number(m.ts) > Number(args.oldest ?? '0'));
        return { ok: true, messages, has_more: false };
      },
      async replies(args) {
        const all = opts.replies?.[args.ts] ?? [];
        const messages = all.filter((m) => Number(m.ts) > Number(args.oldest ?? '0'));
        return { ok: true, messages, has_more: false };
      },
      async join() {
        return {};
      },
    },
    chat: {
      async postMessage(args) {
        posted.push(args);
        return {};
      },
    },
  };
}

function captureClient(result: IngestResult) {
  const calls: Array<{ source: string; opts?: { sourceRef?: string; sourceKind?: string } }> = [];
  const client: PomegranateClient = {
    ...nullClient,
    ingest: async (_c, _r, source, opts) => {
      calls.push({ source, opts });
      return result;
    },
  };
  return { client, calls };
}

describe('createListenScheduler', () => {
  const HISTORY: SlackHistoryMessage[] = [
    { ts: '101.0', user: 'U_ALICE', text: 'we decided to focus on design partners' },
    { ts: '102.0', user: 'U_OTHER', text: 'agreed — and <@U_ALICE> owns the roadmap' },
    { ts: '103.0', user: 'U_ALICE', text: 'thread parent with replies', thread_ts: '103.0', reply_count: 2 },
    // noise: bot message, join, command
    { ts: '104.0', bot_id: 'B1', text: 'I am a bot reply' },
    { ts: '105.0', user: 'U_OTHER', subtype: 'channel_join', text: 'joined' },
    { ts: '106.0', user: 'U_OTHER', text: '<@BOT> ingest something' },
  ];
  const REPLIES: Record<string, SlackHistoryMessage[]> = {
    '103.0': [
      { ts: '103.0', user: 'U_ALICE', text: 'thread parent with replies' }, // parent dup
      { ts: '103.5', user: 'U_OTHER', text: 'reply inside the thread' },
    ],
  };

  function makeScheduler(opts: {
    store: SubscriptionStore;
    api: ChannelHistoryApi;
    client: PomegranateClient;
    now?: () => Date;
  }) {
    return createListenScheduler({
      store: opts.store,
      config,
      client: opts.client,
      api: opts.api,
      botUserId: 'BOT',
      env,
      now: opts.now ?? (() => new Date('2026-06-05T01:00:00Z')),
    });
  }

  function seedSub(store: SubscriptionStore) {
    store.upsert({
      teamId: 'T1',
      channelId: 'C_LISTEN',
      slackUserId: 'U_ALICE',
      intervalMs: 3600_000,
      nowTs: '100.0',
      now: new Date('2026-06-04T00:00:00Z'), // next_run long past
    });
  }

  it('collectTranscript: chronological, handles mentions, drops noise, includes thread replies', async () => {
    const api = fakeApi({ history: HISTORY, replies: REPLIES });
    const t = await collectTranscript({
      api,
      config,
      teamId: 'T1',
      channelId: 'C_LISTEN',
      oldest: '100.0',
      botUserId: 'BOT',
    });
    expect(t.count).toBe(4); // 101, 102, 103 parent, 103.5 reply
    expect(t.latestTs).toBe('106.0'); // watermark covers noise too
    const lines = t.text.split('\n');
    expect(lines[0]).toContain('alice: we decided to focus');
    expect(lines[1]).toContain('@alice owns the roadmap'); // mention inlined
    expect(lines[3]).toContain('reply inside the thread');
    expect(t.text).not.toContain('I am a bot');
    expect(t.text).not.toContain('ingest something');
  });

  it('due run: ingests the batch as slack source, advances watermark, announces', async () => {
    const store = tmpStore();
    seedSub(store);
    const api = fakeApi({ history: HISTORY, replies: REPLIES });
    const { client, calls } = captureClient({ candidates: 2, document_id: 'd1' });
    const scheduler = makeScheduler({ store, api, client });

    const reports = await scheduler.runDueOnce();
    expect(reports).toEqual([
      expect.objectContaining({ outcome: 'ok', messages: 4, candidates: 2 }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts?.sourceKind).toBe('slack');
    expect(calls[0]!.opts?.sourceRef).toContain('slack:C_LISTEN');
    const sub = store.get('T1', 'C_LISTEN', 'U_ALICE')!;
    expect(sub.last_ts).toBe('106.0');
    expect(new Date(sub.next_run_at).toISOString()).toBe('2026-06-05T02:00:00.000Z');
    expect(api.posted).toHaveLength(1);
    expect(api.posted[0]!.text).toContain('2 proposed changes');

    // Second run immediately: nothing new (watermark advanced) → empty, quiet.
    store.advance(sub, { now: new Date('2026-06-04T00:00:00Z'), nextDelayMs: 0 }); // force due again
    const second = await scheduler.runDueOnce();
    expect(second[0]!.outcome).toBe('empty');
    expect(api.posted).toHaveLength(1); // no new announcement
  });

  it('quiet when ingest finds no candidates', async () => {
    const store = tmpStore();
    seedSub(store);
    const api = fakeApi({ history: HISTORY, replies: REPLIES });
    const { client } = captureClient({ candidates: 0, document_id: 'd1' });
    const scheduler = makeScheduler({ store, api, client });
    const reports = await scheduler.runDueOnce();
    expect(reports[0]!.outcome).toBe('ok');
    expect(api.posted).toHaveLength(0);
  });

  it('history failure: watermark kept, backoff scheduled', async () => {
    const store = tmpStore();
    seedSub(store);
    const api = fakeApi({ history: HISTORY, failHistory: true });
    const { client, calls } = captureClient({ candidates: 1, document_id: 'd1' });
    const scheduler = makeScheduler({ store, api, client });
    const reports = await scheduler.runDueOnce();
    expect(reports[0]!.outcome).toBe('error');
    expect(reports[0]!.error).toContain('not_in_channel');
    expect(calls).toHaveLength(0);
    const sub = store.get('T1', 'C_LISTEN', 'U_ALICE')!;
    expect(sub.last_ts).toBe('100.0'); // nothing lost
    expect(new Date(sub.next_run_at).toISOString()).toBe('2026-06-05T02:00:00.000Z'); // min(1h, interval)
  });

  it('not due → not run', async () => {
    const store = tmpStore();
    store.upsert({
      teamId: 'T1',
      channelId: 'C_LISTEN',
      slackUserId: 'U_ALICE',
      intervalMs: 3600_000,
      nowTs: '100.0',
      now: new Date('2026-06-05T00:59:00Z'), // next run 01:59, "now" is 01:00
    });
    const api = fakeApi({ history: HISTORY });
    const { client, calls } = captureClient({ candidates: 1, document_id: 'd1' });
    const scheduler = makeScheduler({ store, api, client });
    expect(await scheduler.runDueOnce()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
