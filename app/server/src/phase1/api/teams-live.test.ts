import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  __setTeamsLiveTestHooks,
  planTeamsPull,
  fetchTeamsMessages,
  listTeamsTeams,
  listTeamsChannels,
  listTeamsChats,
  ensureTeamsAuthConfig,
  startTeamsConnect,
  refreshTeamsConnectionStatus,
  disconnectTeams,
  teamsLiveConfigured,
  renderTeamsAggregate,
  teamsRunRef,
  cacheTeamsPreview,
  getTeamsPreview,
  TeamsAgentUnavailable,
  TeamsTargetRequired,
  TeamsTargetNotFound,
  type TeamsPullPlan,
  type TeamsLiveItem,
} from './teams-live.js';
import type { Repo } from '../db/repo.js';

// No HTTP app here — unlike github-live.test.ts, routes.ts is NOT wired for
// this connector yet (a separate pass wires all new connectors in together to
// avoid merge conflicts across parallel connector work). These tests exercise
// teams-live.ts's exported functions directly. Zero real network calls: every
// external call (LLM plan, Composio API) is either behind __setTeamsLiveTestHooks
// or, for the couple of real (non-hook) code paths exercised below, one that
// provably never reaches the network (cached-config lookup, pre-network
// validation failures).
// The sandbox's shell environment can carry a real ANTHROPIC_API_KEY (used by
// other tooling in this session); if left set, hasStructuredLLM() would be
// true by default and planTeamsPull's "no LLM configured" path would make a
// REAL network call to Anthropic instead of throwing TeamsAgentUnavailable.
// Force it unset for this whole file — every test that needs an LLM to be
// "available" does so explicitly via __setTeamsLiveTestHooks or by mocking
// hasStructuredLLM/structuredCall, never by relying on ambient env state.
let savedAnthropicKey: string | undefined;

beforeAll(() => {
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

afterEach(() => __setTeamsLiveTestHooks(null));

function fakeRepo(): Repo {
  const store = new Map<string, string>();
  return {
    getComposioAuthConfig: (toolkit: string) => store.get(toolkit),
    setComposioAuthConfig: (toolkit: string, id: string) => {
      store.set(toolkit, id);
    },
  } as unknown as Repo;
}

describe('planTeamsPull', () => {
  it('throws TeamsAgentUnavailable when no LLM is configured and no hook is set', async () => {
    await expect(planTeamsPull('anything')).rejects.toThrow(TeamsAgentUnavailable);
  });

  it('planner hook: a channel-mode plan passes through untouched', async () => {
    const plan: TeamsPullPlan = {
      mode: 'channel',
      team: 'Engineering',
      channel: 'general',
      chat: null,
      count: 50,
      topic: null,
      audience: 'private',
      title: 'Eng general',
    };
    __setTeamsLiveTestHooks({ planner: async () => plan });
    await expect(planTeamsPull('last 50 messages in Engineering general')).resolves.toEqual(plan);
  });

  it('planner hook: a chat-mode plan passes through untouched', async () => {
    const plan: TeamsPullPlan = {
      mode: 'chat',
      team: null,
      channel: null,
      chat: 'Project X',
      count: 20,
      topic: 'launch date',
      audience: 'team',
      title: 'Project X chat',
    };
    __setTeamsLiveTestHooks({ planner: async () => plan });
    await expect(planTeamsPull('messages about the launch date in my Project X chat')).resolves.toEqual(plan);
  });

  it('a channel-mode plan missing team or channel asks for one instead of guessing', async () => {
    const anthropic = await import('../../lib/anthropic.js');
    const s1 = vi.spyOn(anthropic, 'hasStructuredLLM').mockReturnValue(true);
    const s2 = vi.spyOn(anthropic, 'structuredCall').mockResolvedValue({
      output: { mode: 'channel', team: null, channel: 'general', chat: null, count: 50, topic: null, audience: 'private', title: 'x' },
    } as any);
    try {
      await expect(planTeamsPull('messages in general')).rejects.toThrow(TeamsTargetRequired);
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  });

  it('a chat-mode plan missing a chat label asks for one instead of guessing', async () => {
    const anthropic = await import('../../lib/anthropic.js');
    const s1 = vi.spyOn(anthropic, 'hasStructuredLLM').mockReturnValue(true);
    const s2 = vi.spyOn(anthropic, 'structuredCall').mockResolvedValue({
      output: { mode: 'chat', team: null, channel: null, chat: null, count: 50, topic: null, audience: 'private', title: 'x' },
    } as any);
    try {
      await expect(planTeamsPull('my last 50 chat messages')).rejects.toThrow(TeamsTargetRequired);
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  });

  it('malformed structured output fails closed as TeamsAgentUnavailable', async () => {
    const anthropic = await import('../../lib/anthropic.js');
    const s1 = vi.spyOn(anthropic, 'hasStructuredLLM').mockReturnValue(true);
    const s2 = vi.spyOn(anthropic, 'structuredCall').mockResolvedValue({ output: { mode: 'nonsense' } } as any);
    try {
      await expect(planTeamsPull('???')).rejects.toThrow(TeamsAgentUnavailable);
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  });
});

describe('fetchTeamsMessages', () => {
  const items: TeamsLiveItem[] = [
    { id: '1', title: 'Msg', meta: '@zelta', snippet: 'zelta note', body: 'zelta body' },
    { id: '2', title: 'Msg2', meta: '@dev2', snippet: 'other note', body: 'other body' },
  ];
  const noTopicPlan: TeamsPullPlan = {
    mode: 'chat',
    team: null,
    channel: null,
    chat: 'Project X',
    count: 50,
    topic: null,
    audience: 'private',
    title: 'Project X chat',
  };
  const topicPlan: TeamsPullPlan = { ...noTopicPlan, topic: 'zelta' };

  it('returns the whole fetched batch when no topic filter is set', async () => {
    __setTeamsLiveTestHooks({ fetcher: async () => items });
    const out = await fetchTeamsMessages(noTopicPlan, 'user1', 'ca_1');
    expect(out).toEqual(items);
  });

  it('a topic filter fails closed when no LLM is available and no selector hook is set', async () => {
    __setTeamsLiveTestHooks({ fetcher: async () => items });
    await expect(fetchTeamsMessages(topicPlan, 'user1', 'ca_1')).rejects.toThrow(/refusing to ingest the whole messages batch unfiltered/);
  });

  it('a topic filter runs the shared batch-selection step and returns only matched items', async () => {
    __setTeamsLiveTestHooks({
      fetcher: async () => items,
      selector: async (its, topic) => {
        expect(topic).toBe('zelta');
        return its.filter((i) => i.body.includes('zelta'));
      },
    });
    const out = await fetchTeamsMessages(topicPlan, 'user1', 'ca_1');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('1');
  });

  it('mode "channel" with no team/channel named throws TeamsTargetRequired before any network call', async () => {
    const plan: TeamsPullPlan = { mode: 'channel', team: null, channel: null, chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetRequired);
  });

  it('mode "chat" with no chat named throws TeamsTargetRequired before any network call', async () => {
    const plan: TeamsPullPlan = { mode: 'chat', team: null, channel: null, chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetRequired);
  });

  it('an unresolvable team name fails closed instead of guessing', async () => {
    __setTeamsLiveTestHooks({ teamLister: async () => [{ id: 't1', display_name: 'Engineering' }] });
    const plan: TeamsPullPlan = { mode: 'channel', team: 'Marketing', channel: 'general', chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetNotFound);
  });

  it('an ambiguous team name (two teams sharing a display name) fails closed rather than picking one', async () => {
    __setTeamsLiveTestHooks({
      teamLister: async () => [
        { id: 't1', display_name: 'Design' },
        { id: 't2', display_name: 'Design' },
      ],
    });
    const plan: TeamsPullPlan = { mode: 'channel', team: 'Design', channel: 'general', chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetNotFound);
  });

  it('an unresolvable channel name within a resolved team fails closed', async () => {
    __setTeamsLiveTestHooks({
      teamLister: async () => [{ id: 't1', display_name: 'Engineering' }],
      channelLister: async () => [{ id: 'c1', display_name: 'general' }],
    });
    const plan: TeamsPullPlan = { mode: 'channel', team: 'Engineering', channel: 'random', chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetNotFound);
  });

  it('an unresolvable chat label fails closed', async () => {
    __setTeamsLiveTestHooks({ chatLister: async () => [{ id: 'ch1', label: 'Project Y', chat_type: 'group' }] });
    const plan: TeamsPullPlan = { mode: 'chat', team: null, channel: null, chat: 'Project Z', count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).rejects.toThrow(TeamsTargetNotFound);
  });

  it('resolves a channel target by exact team+channel name match (no network beyond the hooked listers)', async () => {
    __setTeamsLiveTestHooks({
      teamLister: async () => [{ id: 't1', display_name: 'Engineering' }],
      channelLister: async (_u, _c, teamId) => {
        expect(teamId).toBe('t1');
        return [{ id: 'c1', display_name: 'general' }];
      },
      // Once resolution succeeds, fetchTeamsMessagesRaw would call the real
      // Composio-backed message list tool next; short-circuit that with the
      // fetcher hook so this test still makes zero network calls.
      fetcher: async (plan) => {
        expect(plan.team).toBe('Engineering');
        expect(plan.channel).toBe('general');
        return items;
      },
    });
    const plan: TeamsPullPlan = { mode: 'channel', team: 'Engineering', channel: 'general', chat: null, count: 50, topic: null, audience: 'private', title: 'x' };
    await expect(fetchTeamsMessages(plan, 'user1', 'ca_1')).resolves.toEqual(items);
  });
});

describe('pickers', () => {
  it('listTeamsTeams defers to the test hook', async () => {
    __setTeamsLiveTestHooks({ teamLister: async () => [{ id: 't1', display_name: 'Eng' }] });
    await expect(listTeamsTeams('u1', 'ca1')).resolves.toEqual([{ id: 't1', display_name: 'Eng' }]);
  });

  it('listTeamsChannels defers to the test hook and threads the team id', async () => {
    __setTeamsLiveTestHooks({
      channelLister: async (_u, _c, teamId) => {
        expect(teamId).toBe('t1');
        return [{ id: 'c1', display_name: 'general' }];
      },
    });
    await expect(listTeamsChannels('u1', 'ca1', 't1')).resolves.toEqual([{ id: 'c1', display_name: 'general' }]);
  });

  it('listTeamsChats defers to the test hook', async () => {
    __setTeamsLiveTestHooks({ chatLister: async () => [{ id: 'ch1', label: 'Group chat', chat_type: 'group' }] });
    await expect(listTeamsChats('u1', 'ca1')).resolves.toEqual([{ id: 'ch1', label: 'Group chat', chat_type: 'group' }]);
  });
});

describe('teams connection (Composio OAuth)', () => {
  it('ensureTeamsAuthConfig reuses a stored auth config without any hook or network call', async () => {
    const repo = fakeRepo();
    await repo.setComposioAuthConfig('microsoft_teams', 'ac_stored');
    await expect(ensureTeamsAuthConfig(repo)).resolves.toBe('ac_stored');
  });

  it('ensureTeamsAuthConfig defers to the test hook when set', async () => {
    const repo = fakeRepo();
    __setTeamsLiveTestHooks({ authConfigCreator: async () => 'ac_test' });
    await expect(ensureTeamsAuthConfig(repo)).resolves.toBe('ac_test');
  });

  it('startTeamsConnect returns a redirect via the linker hook', async () => {
    const repo = fakeRepo();
    __setTeamsLiveTestHooks({
      authConfigCreator: async () => 'ac_test',
      linker: async (_userId, authConfigId) => {
        expect(authConfigId).toBe('ac_test');
        return { id: 'ca_test', redirectUrl: 'https://login.microsoftonline.com/oauth2/authorize?fake=1' };
      },
    });
    const r = await startTeamsConnect(repo, 'u1', 'https://callback');
    expect(r).toEqual({ connectedAccountId: 'ca_test', redirectUrl: 'https://login.microsoftonline.com/oauth2/authorize?fake=1' });
  });

  it('refreshTeamsConnectionStatus reflects the status hook', async () => {
    __setTeamsLiveTestHooks({ statusChecker: async () => 'active' });
    await expect(refreshTeamsConnectionStatus('ca_test')).resolves.toBe('active');
    __setTeamsLiveTestHooks({ statusChecker: async () => 'initiated' });
    await expect(refreshTeamsConnectionStatus('ca_test')).resolves.toBe('initiated');
  });

  it('disconnectTeams calls the disconnector hook with the connected account id', async () => {
    const revoked: string[] = [];
    __setTeamsLiveTestHooks({ disconnector: async (id) => { revoked.push(id); } });
    await disconnectTeams('ca_test');
    expect(revoked).toEqual(['ca_test']);
  });
});

describe('teamsLiveConfigured', () => {
  it('true whenever any test hook is set, regardless of connection status', () => {
    __setTeamsLiveTestHooks({});
    expect(teamsLiveConfigured(undefined)).toBe(true);
    expect(teamsLiveConfigured({ status: 'failed' })).toBe(true);
  });

  it('without hooks, true only when the connection is active', () => {
    expect(teamsLiveConfigured({ status: 'active' })).toBe(true);
    expect(teamsLiveConfigured({ status: 'initiated' })).toBe(false);
    expect(teamsLiveConfigured(undefined)).toBe(false);
  });
});

describe('renderTeamsAggregate / teamsRunRef', () => {
  it('renders a channel-mode aggregate with head + per-message sections', () => {
    const plan: TeamsPullPlan = { mode: 'channel', team: 'Engineering', channel: 'general', chat: null, count: 2, topic: 'zelta', audience: 'team', title: 'Eng general' };
    const items: TeamsLiveItem[] = [
      { id: '1', title: 'Msg', meta: '@a', snippet: 's1', body: 'body1' },
      { id: '2', title: 'Msg2', meta: '@b', snippet: 's2', body: 'body2' },
    ];
    const doc = renderTeamsAggregate({ query: 'zelta messages in Engineering general', plan, items });
    expect(doc).toContain('Team: Engineering · Channel: general');
    expect(doc).toContain('Topic applied: zelta');
    expect(doc).toContain('Messages included: 2');
    expect(doc).toContain('=== Message 1 of 2 ===');
    expect(doc).toContain('body1');
    expect(doc).toContain('body2');
  });

  it('renders a chat-mode aggregate with no topic applied', () => {
    const plan: TeamsPullPlan = { mode: 'chat', team: null, channel: null, chat: 'Project X', count: 1, topic: null, audience: 'private', title: 'Project X chat' };
    const doc = renderTeamsAggregate({ query: 'my chat', plan, items: [{ id: '1', title: 'M', meta: 'm', snippet: 's', body: 'b' }] });
    expect(doc).toContain('Chat: Project X');
    expect(doc).toContain('Topic: none (all fetched messages included)');
  });

  it('teamsRunRef embeds the title and today\'s date', () => {
    const plan: TeamsPullPlan = { mode: 'chat', team: null, channel: null, chat: 'Project X', count: 1, topic: null, audience: 'private', title: 'Project X chat' };
    expect(teamsRunRef(plan)).toMatch(/^teams: Project X chat — \d{4}-\d{2}-\d{2}$/);
  });
});

describe('preview cache', () => {
  it('round-trips a cached preview and misses on query mismatch or unknown key', () => {
    const plan: TeamsPullPlan = { mode: 'chat', team: null, channel: null, chat: 'Project X', count: 1, topic: null, audience: 'private', title: 'x' };
    const items: TeamsLiveItem[] = [{ id: '1', title: 'M', meta: 'm', snippet: 's', body: 'b' }];
    cacheTeamsPreview('key1', { query: 'q1', plan, items });
    expect(getTeamsPreview('key1', 'q1')).toMatchObject({ query: 'q1', plan, items });
    expect(getTeamsPreview('key1', 'different query')).toBeNull();
    expect(getTeamsPreview('missing-key', 'q1')).toBeNull();
  });
});
