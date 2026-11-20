// slack-live.ts unit tests.
//
// Unlike github-live.test.ts / github-files.test.ts (which exercise the
// connector through the full Hono server, since routes.ts already has
// github's /me/apps/github and /workspaces/:ws/apps/github routes wired),
// routes.ts has NOT been wired for slack yet — that wiring happens in a
// separate pass across all new connectors at once (see task scope). So these
// tests call slack-live.ts's exported functions directly: test-hook-backed
// orchestration (planner/fetcher/selector) the same way github-live.test.ts's
// "filter fails closed" case does, plus a Repo built on an in-memory sqlite
// db (same pattern as db/repo.test.ts) for the auth flows, and a fake
// Composio client (via __setComposioClientForTests) for the parts of this
// port that are NEW here — conversation classification (channel/im/mpim) and
// display-name resolution — so that logic is actually exercised, not just
// the test-hook seam around it.
//
// Zero real network calls; passes with no COMPOSIO_API_KEY set in the real
// environment (a fake key is set in beforeAll, same as github-live.test.ts).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { __setComposioClientForTests } from '../../lib/composio.js';
import {
  __setSlackLiveTestHooks,
  planSlackPull,
  extractSlackSelection,
  fetchRecentSlackMessages,
  listSlackConversations,
  buildSlackSelectionItem,
  renderSlackAggregate,
  slackRunRef,
  cacheSlackPreview,
  getSlackPreview,
  ensureSlackAuthConfig,
  startSlackConnect,
  refreshSlackConnectionStatus,
  disconnectSlack,
  slackLiveConfigured,
  SlackChannelRequired,
  SlackChannelNotFound,
  type SlackLiveItem,
  type SlackPullPlan,
} from './slack-live.js';

beforeAll(() => {
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => {
  __setSlackLiveTestHooks(null);
  __setComposioClientForTests(null);
});

// ---------- fixtures ----------

function fakeMsg(n: number, user: string, text: string): SlackLiveItem {
  return {
    id: String(n),
    title: `Message from ${user}`,
    meta: `${user} · 2026-07-0${(n % 6) + 1}`,
    snippet: text.slice(0, 140),
    body: [`Conversation: #pome-product-update`, `From: ${user}`, `Time: 2026-07-0${(n % 6) + 1}`, '', text].join('\n'),
  };
}

// 3 messages from zelta among 10; only their user line carries "zelta".
function messages(): SlackLiveItem[] {
  const out: SlackLiveItem[] = [];
  for (let i = 1; i <= 10; i++) {
    if (i % 3 === 0) {
      out.push(fakeMsg(i, 'zelta', 'Rollout is on track for next week, two squads onboarded.'));
    } else {
      out.push(fakeMsg(i, `dev${i}`, 'Weekly digest of product links and industry notes.'));
    }
  }
  out.reverse();
  return out;
}

const zeltaPlan: SlackPullPlan = {
  channel: 'pome-product-update',
  count: 10,
  filter: 'from zelta',
  audience: 'team',
  title: "Zelta's messages",
};
const plainPlan: SlackPullPlan = {
  channel: 'pome-product-update',
  count: 10,
  filter: null,
  audience: 'private',
  title: 'Recent messages',
};

/** Minimal fake Composio client: dispatches tools.execute by tool slug to canned responses, and records calls for assertions. */
function fakeComposioClient(handlers: Record<string, (args: any) => any>) {
  const calls: Array<{ tool: string; args: any }> = [];
  return {
    client: {
      tools: {
        execute: async (tool: string, args: any) => {
          calls.push({ tool, args });
          const handler = handlers[tool];
          if (!handler) throw new Error(`unexpected tool call: ${tool}`);
          return handler(args);
        },
      },
    } as any,
    calls,
  };
}

// ---------- plan ----------

describe('planSlackPull', () => {
  it('returns the planner hook output verbatim', async () => {
    __setSlackLiveTestHooks({ planner: async () => zeltaPlan });
    await expect(planSlackPull('zelta messages in #pome-product-update')).resolves.toEqual(zeltaPlan);
  });

  it('a plan with no channel asks for one instead of guessing', async () => {
    __setSlackLiveTestHooks({
      planner: async () => {
        throw new SlackChannelRequired();
      },
    });
    await expect(planSlackPull('show me recent messages')).rejects.toThrow(SlackChannelRequired);
  });

  it('without a planner hook and no LLM configured, refuses rather than guessing', async () => {
    // No test hook and this process carries no real LLM key.
    await expect(planSlackPull('anything')).rejects.toThrow();
  });
});

// ---------- selection (shared batch-selection helper) ----------

describe('extractSlackSelection (shared selectRelevantItems, itemNoun: messages)', () => {
  it('keeps only the messages a topic-selection pass names', async () => {
    __setSlackLiveTestHooks({
      selector: async (items, topic) => {
        expect(topic).toBe('from zelta');
        return items.filter((i) => i.meta.includes('zelta'));
      },
    });
    const selected = await extractSlackSelection(messages(), 'from zelta');
    expect(selected).toHaveLength(3);
    expect(selected.every((i) => i.meta.includes('zelta'))).toBe(true);
  });

  it('fails closed when no LLM is available, instead of ingesting the whole batch unfiltered', async () => {
    const items = messages().slice(0, 5);
    // No test hooks set (afterEach clears them) and no real LLM key in this
    // process — extractSlackSelection must refuse, not silently select all.
    await expect(extractSlackSelection(items, 'from zelta')).rejects.toThrow(/refusing to ingest the whole messages batch unfiltered/);
  });
});

// ---------- fetch (hook path) ----------

describe('fetchRecentSlackMessages (fetcher hook)', () => {
  it('passes the plan through to the fetcher and returns its items', async () => {
    const fetchedCounts: number[] = [];
    __setSlackLiveTestHooks({
      fetcher: async (plan) => {
        fetchedCounts.push(plan.count);
        return messages().slice(0, plan.count);
      },
    });
    const items = await fetchRecentSlackMessages(plainPlan, 'user_1', 'ca_test');
    expect(fetchedCounts).toEqual([10]);
    expect(items).toHaveLength(10);
  });
});

// ---------- conversation resolution + fetch, against a faked Composio client (no test hook) ----------
//
// This is the part of the port that's actually new: classifying im/mpim vs
// channel and building a display label. Exercised here directly (not via a
// test hook) so the logic itself is under test, matching the live-verified
// tool slugs/param shapes documented at the top of slack-live.ts.

describe('conversation resolution against a faked Composio client', () => {
  it('resolves a channel name to its id and renders "Conversation: #name" in fetched message bodies', async () => {
    const { client } = fakeComposioClient({
      SLACK_LIST_ALL_CHANNELS: () => ({
        successful: true,
        data: {
          channels: [
            { id: 'C1', name: 'general', is_im: false, is_mpim: false },
            { id: 'C2', name: 'pome-product-update', is_im: false, is_mpim: false },
          ],
        },
      }),
      SLACK_FETCH_CONVERSATION_HISTORY: (args: any) => {
        expect(args.arguments.channel).toBe('C2');
        return { successful: true, data: { messages: [{ ts: '1700000000.000100', user: 'U1', text: 'hello' }] } };
      },
    });
    __setComposioClientForTests(client);

    const items = await fetchRecentSlackMessages(
      { channel: '#pome-product-update', count: 10, filter: null, audience: 'private', title: 'x' },
      'user_1',
      'ca_test',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toContain('Conversation: #pome-product-update');
  });

  it('resolves a raw DM (im) conversation id via conversation-info + user-info, without listing all channels', async () => {
    const { client, calls } = fakeComposioClient({
      SLACK_RETRIEVE_CONVERSATION_INFORMATION: (args: any) => {
        expect(args.arguments.channel).toBe('D0123456789');
        return { successful: true, data: { channel: { id: 'D0123456789', is_im: true, user: 'U42' } } };
      },
      SLACK_RETRIEVE_DETAILED_USER_INFORMATION: (args: any) => {
        expect(args.arguments.user).toBe('U42');
        return { successful: true, data: { user: { id: 'U42', name: 'alice', profile: { display_name: 'Alice' } } } };
      },
      SLACK_FETCH_CONVERSATION_HISTORY: (args: any) => {
        expect(args.arguments.channel).toBe('D0123456789');
        return { successful: true, data: { messages: [{ ts: '1700000000.000200', user: 'U42', text: 'hi there' }] } };
      },
    });
    __setComposioClientForTests(client);

    const items = await fetchRecentSlackMessages(
      { channel: 'D0123456789', count: 5, filter: null, audience: 'private', title: 'x' },
      'user_1',
      'ca_test',
    );
    expect(items[0]!.body).toContain('Conversation: DM with Alice');
    // SLACK_LIST_ALL_CHANNELS must never be called for a raw-id resolution —
    // that's the whole point of using the single-conversation info lookup.
    expect(calls.some((c) => c.tool === 'SLACK_LIST_ALL_CHANNELS')).toBe(false);
  });

  it('a channel name with no match raises SlackChannelNotFound', async () => {
    const { client } = fakeComposioClient({
      SLACK_LIST_ALL_CHANNELS: () => ({ successful: true, data: { channels: [{ id: 'C1', name: 'general', is_im: false, is_mpim: false }] } }),
    });
    __setComposioClientForTests(client);
    await expect(
      fetchRecentSlackMessages({ channel: 'nonexistent', count: 5, filter: null, audience: 'private', title: 'x' }, 'user_1', 'ca_test'),
    ).rejects.toThrow(SlackChannelNotFound);
  });
});

describe('listSlackConversations', () => {
  it('classifies public/private channels, DMs, and group DMs, and resolves display names for the ones with no channel-style name', async () => {
    const { client } = fakeComposioClient({
      SLACK_LIST_ALL_CHANNELS: (args: any) => {
        expect(args.arguments.types).toBe('public_channel,private_channel,im,mpim');
        return {
          successful: true,
          data: {
            channels: [
              { id: 'C1', name: 'general', is_im: false, is_mpim: false },
              { id: 'C2', name: 'eng-private', is_im: false, is_mpim: false, is_private: true },
              { id: 'D1', is_im: true, user: 'U1' },
              { id: 'G1', is_mpim: true, name: 'mpdm-alice--bob--carol-1' },
              { id: 'G2', is_mpim: true, name: '' }, // no usable name -> falls back to member resolution
            ],
          },
        };
      },
      SLACK_RETRIEVE_DETAILED_USER_INFORMATION: (args: any) => {
        const names: Record<string, string> = { U1: 'Alice', U2: 'Bob', U3: 'Carol' };
        return { successful: true, data: { user: { id: args.arguments.user, profile: { display_name: names[args.arguments.user] } } } };
      },
      SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST: (args: any) => {
        expect(args.arguments.channel).toBe('G2');
        return { successful: true, data: { members: ['U2', 'U3'] } };
      },
    });
    __setComposioClientForTests(client);

    const conversations = await listSlackConversations('user_1', 'ca_test');
    expect(conversations).toHaveLength(5);

    const byId = Object.fromEntries(conversations.map((c) => [c.id, c]));
    expect(byId.C1).toMatchObject({ type: 'channel', name: '#general' });
    expect(byId.C2).toMatchObject({ type: 'channel', name: '#eng-private' });
    expect(byId.D1).toMatchObject({ type: 'im', name: 'DM with Alice' });
    expect(byId.G1).toMatchObject({ type: 'mpim', name: 'Group DM (mpdm-alice--bob--carol-1)' });
    expect(byId.G2).toMatchObject({ type: 'mpim', name: 'Group DM: Bob, Carol' });
  });

  it('a failed user-info lookup degrades to the raw user id, not a picker-wide failure', async () => {
    const { client } = fakeComposioClient({
      SLACK_LIST_ALL_CHANNELS: () => ({ successful: true, data: { channels: [{ id: 'D1', is_im: true, user: 'U404' }] } }),
      SLACK_RETRIEVE_DETAILED_USER_INFORMATION: () => {
        throw new Error('composio: user lookup failed');
      },
    });
    __setComposioClientForTests(client);

    const conversations = await listSlackConversations('user_1', 'ca_test');
    expect(conversations).toEqual([{ id: 'D1', type: 'im', name: 'DM with U404' }]);
  });

  it('honors the conversationLister test hook, bypassing the real client entirely', async () => {
    __setSlackLiveTestHooks({
      conversationLister: async () => [
        { id: 'C1', type: 'channel', name: '#general' },
        { id: 'D1', type: 'im', name: 'DM with Alice' },
      ],
    });
    const conversations = await listSlackConversations('user_1', 'ca_test');
    expect(conversations.map((c) => c.type)).toEqual(['channel', 'im']);
  });
});

// ---------- pure rendering helpers ----------

describe('buildSlackSelectionItem', () => {
  it('collapses a batch into one always-checked row with no channel-specific suffix', () => {
    const items = messages().slice(0, 3);
    const item = buildSlackSelectionItem(items, zeltaPlan);
    expect(item.id).toBe('selection');
    expect(item.title).toBe(zeltaPlan.title);
    expect(item.meta).toBe('3 messages');
    expect(item).not.toHaveProperty('body', expect.stringMatching(/.+/)); // body is the empty placeholder
    expect(item.body).toBe('');
  });

  it('singularizes for exactly one message', () => {
    const item = buildSlackSelectionItem(messages().slice(0, 1), plainPlan);
    expect(item.meta).toBe('1 message');
  });
});

describe('renderSlackAggregate', () => {
  it('aggregates every item into one document with a per-message section header', () => {
    const items = messages().slice(0, 3);
    const doc = renderSlackAggregate({ query: 'zelta messages', plan: zeltaPlan, items });
    expect(doc).toContain('Slack pull — ' + zeltaPlan.title);
    expect(doc).toContain('Filter applied: from zelta');
    expect(doc).toContain('Messages included: 3');
    expect((doc.match(/=== Message \d of 3 ===/g) ?? []).length).toBe(3);
    // No leading '#' at line start anywhere — parseSubgraphTokens treats #tokens as subgraph pins.
    expect(doc.split('\n').some((line) => line.startsWith('#'))).toBe(false);
  });

  it('states "no filter" when the plan carries none', () => {
    const doc = renderSlackAggregate({ query: 'recent messages', plan: plainPlan, items: messages().slice(0, 2) });
    expect(doc).toContain('Filter: none (all downloaded messages included)');
  });
});

describe('slackRunRef', () => {
  it('embeds the plan title and today\'s date', () => {
    const ref = slackRunRef(zeltaPlan);
    expect(ref).toContain("Zelta's messages");
    expect(ref).toMatch(/\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------- preview cache ----------

describe('cacheSlackPreview / getSlackPreview', () => {
  it('round-trips a cached preview keyed by query', () => {
    const key = 'ws_1:user_1';
    cacheSlackPreview(key, { query: 'zelta messages', plan: zeltaPlan, items: messages().slice(0, 3) });
    expect(getSlackPreview(key, 'zelta messages')?.plan).toEqual(zeltaPlan);
  });

  it('misses on a different query (stale/mismatched preview)', () => {
    const key = 'ws_2:user_1';
    cacheSlackPreview(key, { query: 'zelta messages', plan: zeltaPlan, items: [] });
    expect(getSlackPreview(key, 'a totally different request')).toBeNull();
  });

  it('misses for an unknown key', () => {
    expect(getSlackPreview('never-cached', 'anything')).toBeNull();
  });
});

// ---------- auth: connect / status / disconnect (Repo-backed, in-memory db) ----------

describe('slack auth (connect/refresh/disconnect), Repo-backed', () => {
  let db: Database.Database;
  let repo: Repo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = new Repo(db);
  });

  it('slackLiveConfigured is false with no test hook and no active connection, true for either', () => {
    expect(slackLiveConfigured(undefined)).toBe(false);
    expect(slackLiveConfigured({ status: 'initiated' })).toBe(false);
    expect(slackLiveConfigured({ status: 'active' })).toBe(true);
    __setSlackLiveTestHooks({});
    expect(slackLiveConfigured(undefined)).toBe(true);
  });

  it('ensureSlackAuthConfig creates once via Composio and reuses the repo-stored config afterward', async () => {
    let creates = 0;
    __setComposioClientForTests({
      authConfigs: {
        create: async () => {
          creates++;
          return { id: 'ac_real' };
        },
      },
    } as any);
    const first = await ensureSlackAuthConfig(repo);
    const second = await ensureSlackAuthConfig(repo);
    expect(first).toBe('ac_real');
    expect(second).toBe('ac_real');
    // The second call must be satisfied from repo.getComposioAuthConfig, not
    // a second round-trip to Composio — "get-or-create ONE shared config".
    expect(creates).toBe(1);
  });

  it('startSlackConnect mints a redirect link via the linker hook', async () => {
    __setSlackLiveTestHooks({
      authConfigCreator: async () => 'ac_test',
      linker: async (userId, authConfigId) => {
        expect(authConfigId).toBe('ac_test');
        return { id: 'ca_test', redirectUrl: 'https://slack.com/oauth/v2/authorize?fake=1' };
      },
    });
    const r = await startSlackConnect(repo, 'user_1');
    expect(r).toEqual({ connectedAccountId: 'ca_test', redirectUrl: 'https://slack.com/oauth/v2/authorize?fake=1' });
  });

  it('refreshSlackConnectionStatus reports the live status via the statusChecker hook', async () => {
    __setSlackLiveTestHooks({ statusChecker: async () => 'active' });
    await expect(refreshSlackConnectionStatus('ca_test')).resolves.toBe('active');
  });

  it('a status check that never completes stays "initiated"', async () => {
    __setSlackLiveTestHooks({ statusChecker: async () => 'initiated' });
    await expect(refreshSlackConnectionStatus('ca_test')).resolves.toBe('initiated');
  });

  it('disconnectSlack revokes via the disconnector hook', async () => {
    const revoked: string[] = [];
    __setSlackLiveTestHooks({ disconnector: async (id) => void revoked.push(id) });
    await disconnectSlack('ca_test');
    expect(revoked).toEqual(['ca_test']);
  });
});
