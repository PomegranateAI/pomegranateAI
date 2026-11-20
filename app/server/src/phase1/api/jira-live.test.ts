import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { __setComposioClientForTests } from '../../lib/composio.js';
import {
  __setJiraLiveTestHooks,
  planJiraPull,
  fetchJiraProject,
  fetchJiraBoard,
  fetchJiraTickets,
  listJiraProjects,
  listJiraBoards,
  ensureJiraAuthConfig,
  startJiraConnect,
  refreshJiraConnectionStatus,
  disconnectJira,
  renderJiraProjectAggregate,
  renderJiraBoardAggregate,
  jiraProjectRunRef,
  jiraBoardRunRef,
  jiraTicketsRunRef,
  JiraAgentUnavailable,
  JiraProjectRequired,
  JiraBoardRequired,
  JiraTicketScopeRequired,
  JiraBoardNotFound,
  JiraBoardNoActiveSprint,
  JiraBoardProjectRequired,
  type JiraPullPlan,
  type JiraLiveItem,
} from './jira-live.js';

beforeAll(() => {
  // A dummy value — composioConfigured() just needs *something* set; every
  // real Composio call in these tests goes through a fake client injected via
  // __setComposioClientForTests, never the network.
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => {
  __setJiraLiveTestHooks(null);
  __setComposioClientForTests(null);
});

function issue(key: string, summary: string, status: string, opts: Partial<{ assignee: string; priority: string; type: string; description: string }> = {}) {
  return {
    key,
    summary,
    status: { name: status },
    assignee: { display_name: opts.assignee ?? 'unassigned' },
    priority: { name: opts.priority ?? 'Medium' },
    issue_type: { name: opts.type ?? 'Task' },
    description: opts.description ?? `Body text for ${key}`,
  };
}

function fakeToolsExecute(handlers: Record<string, (args: any) => any>) {
  return vi.fn(async (slug: string, args: any) => {
    const handler = handlers[slug];
    if (!handler) throw new Error(`unexpected tool call: ${slug}`);
    return handler(args);
  });
}

const basePlan: JiraPullPlan = {
  mode: 'project',
  project: null,
  board: null,
  ticketKeys: null,
  filter: null,
  audience: 'private',
  title: 'Test pull',
};

describe('planJiraPull', () => {
  it('returns the planner hook output when the request carries enough scope', async () => {
    const plan: JiraPullPlan = { ...basePlan, mode: 'ticket', ticketKeys: ['POM-1'] };
    __setJiraLiveTestHooks({ planner: async () => plan });
    await expect(planJiraPull('pull POM-1')).resolves.toEqual(plan);
  });

  it('project mode with no project asks for one instead of guessing', async () => {
    __setJiraLiveTestHooks({ planner: async () => ({ ...basePlan, mode: 'project', project: null }) });
    await expect(planJiraPull('pull a project')).rejects.toThrow(JiraProjectRequired);
  });

  it('board mode with no board asks for one instead of guessing', async () => {
    __setJiraLiveTestHooks({ planner: async () => ({ ...basePlan, mode: 'board', board: null }) });
    await expect(planJiraPull('pull a board')).rejects.toThrow(JiraBoardRequired);
  });

  it('ticket mode with no keys, project, board, or filter refuses to guess a scope', async () => {
    __setJiraLiveTestHooks({
      planner: async () => ({ ...basePlan, mode: 'ticket', ticketKeys: null, project: null, board: null, filter: null }),
    });
    await expect(planJiraPull('pull some tickets')).rejects.toThrow(JiraTicketScopeRequired);
  });

  it('without a hook or a configured LLM, refuses rather than guessing', async () => {
    // hasStructuredLLM() checks process.env.ANTHROPIC_API_KEY directly; the
    // ambient dev/CI shell can carry one for unrelated reasons, so this test
    // clears it for its duration rather than assuming it's absent (same
    // save/restore pattern github-live.test.ts uses for COMPOSIO_API_KEY).
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(planJiraPull('anything')).rejects.toThrow(JiraAgentUnavailable);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('fetchJiraProject', () => {
  it('requires a project even without hooks', async () => {
    await expect(fetchJiraProject({ ...basePlan, mode: 'project', project: null }, 'u1', 'ca1')).rejects.toThrow(JiraProjectRequired);
  });

  it('fetches project metadata and its issue list, scoped by JQL', async () => {
    const seenJql: string[] = [];
    __setJiraLiveTestHooks({
      projectMetaFetcher: async (key) => ({ key, name: 'Pomegranate', description: 'The context vault product.' }),
      searcher: async (jql) => {
        seenJql.push(jql);
        return [
          { ...zItem('POM-1', 'Fix login bug', 'To Do') },
          { ...zItem('POM-2', 'Ship the picker', 'In Progress') },
        ];
      },
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'project', project: 'POM', title: 'POM pull' };
    const { meta, issues } = await fetchJiraProject(plan, 'u1', 'ca1');
    expect(meta).toEqual({ key: 'POM', name: 'Pomegranate', description: 'The context vault product.' });
    expect(issues).toHaveLength(2);
    expect(seenJql[0]).toContain('project = "POM"');

    const doc = renderJiraProjectAggregate({ query: 'pull the POM project', plan, meta, issues });
    expect(doc).toContain('Jira project pull — POM pull');
    expect(doc).toContain('Project: Pomegranate (POM)');
    expect(doc).toContain('Description: The context vault product.');
    expect(doc).toContain('Issues included: 2');
    expect(doc).toContain('POM-1');
    expect(doc).toContain('POM-2');
    expect(jiraProjectRunRef(plan)).toContain('POM pull');
  });
});

function zItem(key: string, title: string, status: string): JiraLiveItem {
  return { id: key, title, meta: `Task · ${status} · @unassigned · Medium`, status, snippet: `Body for ${key}`, body: `Key: ${key}\nStatus: ${status}\n\nBody for ${key}` };
}

describe('fetchJiraBoard', () => {
  it('requires a board even without hooks', async () => {
    await expect(fetchJiraBoard({ ...basePlan, mode: 'board', board: null }, 'u1', 'ca1')).rejects.toThrow(JiraBoardRequired);
  });

  it('scrum board: resolves the active sprint and groups issues by status column', async () => {
    __setJiraLiveTestHooks({
      boardResolver: async (name) => ({
        meta: { id: 42, name, type: 'scrum', sprint: { id: 900, name: 'Sprint 7', goal: 'Ship the picker' } },
        jql: 'sprint = 900',
      }),
      searcher: async () => [zItem('POM-1', 'A', 'To Do'), zItem('POM-2', 'B', 'In Progress'), zItem('POM-3', 'C', 'To Do')],
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'Sharing board', title: 'Sharing board pull' };
    const { meta, issues } = await fetchJiraBoard(plan, 'u1', 'ca1');
    expect(meta.sprint?.name).toBe('Sprint 7');
    expect(issues).toHaveLength(3);

    const doc = renderJiraBoardAggregate({ query: 'pull the sharing board', plan, meta, issues });
    expect(doc).toContain('Board: Sharing board (scrum)');
    expect(doc).toContain('Sprint: Sprint 7 — Ship the picker');
    // "To Do" appears before "In Progress" (first-seen order: POM-1 is To Do first).
    expect(doc.indexOf('--- To Do (2) ---')).toBeLessThan(doc.indexOf('--- In Progress (1) ---'));
    expect(jiraBoardRunRef(plan)).toContain('Sharing board pull');
  });

  it('kanban board without a project scope refuses rather than guessing which issues are "on" it', async () => {
    __setJiraLiveTestHooks({
      boardResolver: async () => {
        throw new JiraBoardProjectRequired('Sharing board');
      },
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'Sharing board' };
    await expect(fetchJiraBoard(plan, 'u1', 'ca1')).rejects.toThrow(JiraBoardProjectRequired);
  });

  // Exercises the REAL (non-hooked) board-resolution code against a fake
  // Composio client, since this is the surface that's schema-verified but
  // NOT live-execute-verified (no connected account exists) — see
  // resolveJiraBoardScope's doc comment in jira-live.ts.
  describe('real resolveJiraBoardScope (via a fake Composio client)', () => {
    it('resolves a scrum board to its active sprint', async () => {
      const execute = fakeToolsExecute({
        JIRA_LIST_BOARDS: async () => ({
          successful: true,
          data: { values: [{ id: 7, name: 'Sharing board', type: 'scrum', isPrivate: false, self: 'x' }] },
        }),
        JIRA_LIST_SPRINTS: async (args: any) => {
          expect(args.arguments.board_id).toBe(7);
          expect(args.arguments.state).toBe('active');
          return { successful: true, data: { values: [{ id: 900, name: 'Sprint 7', goal: 'Ship it' }] } };
        },
        JIRA_SEARCH_ISSUES: async (args: any) => {
          expect(args.arguments.jql).toBe('sprint = 900');
          return { successful: true, data: { issues: [issue('POM-1', 'A', 'To Do')], total: 1, jql_used: args.arguments.jql, max_results: 100, search_method: 'jql' } };
        },
      });
      __setComposioClientForTests({ tools: { execute } } as any);
      const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'Sharing board' };
      const { meta, issues } = await fetchJiraBoard(plan, 'u1', 'ca1');
      expect(meta.type).toBe('scrum');
      expect(meta.sprint?.id).toBe(900);
      expect(issues).toHaveLength(1);
    });

    it('a scrum board with no active sprint refuses rather than silently returning the backlog', async () => {
      const execute = fakeToolsExecute({
        JIRA_LIST_BOARDS: async () => ({ successful: true, data: { values: [{ id: 7, name: 'Sharing board', type: 'scrum' }] } }),
        JIRA_LIST_SPRINTS: async () => ({ successful: true, data: { values: [] } }),
      });
      __setComposioClientForTests({ tools: { execute } } as any);
      const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'Sharing board' };
      await expect(fetchJiraBoard(plan, 'u1', 'ca1')).rejects.toThrow(JiraBoardNoActiveSprint);
    });

    it('a kanban board resolves via project + statusCategory, requiring a project hint', async () => {
      const execute = fakeToolsExecute({
        JIRA_LIST_BOARDS: async () => ({ successful: true, data: { values: [{ id: 8, name: 'POM Kanban', type: 'kanban' }] } }),
        JIRA_SEARCH_ISSUES: async (args: any) => {
          expect(args.arguments.jql).toBe('project = "POM" AND statusCategory != "Done"');
          return { successful: true, data: { issues: [], total: 0, jql_used: args.arguments.jql, max_results: 100, search_method: 'jql' } };
        },
      });
      __setComposioClientForTests({ tools: { execute } } as any);
      const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'POM Kanban', project: 'POM' };
      const { meta } = await fetchJiraBoard(plan, 'u1', 'ca1');
      expect(meta.type).toBe('kanban');
      expect(meta.sprint).toBeNull();
    });

    it('a kanban board without a project hint refuses instead of guessing scope', async () => {
      const execute = fakeToolsExecute({
        JIRA_LIST_BOARDS: async () => ({ successful: true, data: { values: [{ id: 8, name: 'POM Kanban', type: 'kanban' }] } }),
      });
      __setComposioClientForTests({ tools: { execute } } as any);
      const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'POM Kanban', project: null };
      await expect(fetchJiraBoard(plan, 'u1', 'ca1')).rejects.toThrow(JiraBoardProjectRequired);
    });

    it('an unknown board name refuses rather than guessing a nearby match', async () => {
      const execute = fakeToolsExecute({ JIRA_LIST_BOARDS: async () => ({ successful: true, data: { values: [] } }) });
      __setComposioClientForTests({ tools: { execute } } as any);
      const plan: JiraPullPlan = { ...basePlan, mode: 'board', board: 'Nonexistent' };
      await expect(fetchJiraBoard(plan, 'u1', 'ca1')).rejects.toThrow(JiraBoardNotFound);
    });
  });
});

describe('fetchJiraTickets', () => {
  it('explicit ticket keys become a "key in (...)" JQL search, no narrowing applied', async () => {
    const seenJql: string[] = [];
    __setJiraLiveTestHooks({
      searcher: async (jql) => {
        seenJql.push(jql);
        return [zItem('POM-1', 'A', 'Done'), zItem('POM-2', 'B', 'Done')];
      },
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'ticket', ticketKeys: ['POM-1', 'POM-2'] };
    const items = await fetchJiraTickets(plan, 'u1', 'ca1');
    expect(items).toHaveLength(2);
    expect(seenJql[0]).toBe('key in ("POM-1", "POM-2")');
    expect(jiraTicketsRunRef(plan)).toContain('Test pull');
  });

  it('a project scope with a topic narrows the batch via selectRelevantItems', async () => {
    const pool = [zItem('POM-1', 'Fix flaky retry', 'Done'), zItem('POM-2', 'Bump dependency', 'To Do'), zItem('POM-3', 'Fix another flaky test', 'Done')];
    __setJiraLiveTestHooks({
      searcher: async () => pool,
      ticketsSelector: async (items, topic) => {
        expect(topic).toBe('closed this sprint');
        return items.filter((i) => i.status === 'Done');
      },
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'ticket', project: 'POM', filter: 'closed this sprint' };
    const items = await fetchJiraTickets(plan, 'u1', 'ca1');
    expect(items.map((i) => i.id)).toEqual(['POM-1', 'POM-3']);
  });

  it('a board scope resolves through resolveJiraBoardScope before searching', async () => {
    __setJiraLiveTestHooks({
      boardResolver: async () => ({ meta: { id: 1, name: 'Board', type: 'scrum', sprint: { id: 5, name: 'S1', goal: null } }, jql: 'sprint = 5' }),
      searcher: async (jql) => {
        expect(jql).toBe('(sprint = 5) ORDER BY updated DESC');
        return [zItem('POM-9', 'X', 'To Do')];
      },
    });
    const plan: JiraPullPlan = { ...basePlan, mode: 'ticket', board: 'Board' };
    const items = await fetchJiraTickets(plan, 'u1', 'ca1');
    expect(items).toHaveLength(1);
  });

  it('no ticket keys, project, board, or filter refuses to guess a scope', async () => {
    const plan: JiraPullPlan = { ...basePlan, mode: 'ticket' };
    await expect(fetchJiraTickets(plan, 'u1', 'ca1')).rejects.toThrow(JiraTicketScopeRequired);
  });
});

describe('picker: listJiraProjects / listJiraBoards (real calls via a fake Composio client)', () => {
  it('handles the double-nested GET_ALL_PROJECTS response shape (schema-derived, not live-verified)', async () => {
    const execute = fakeToolsExecute({
      JIRA_GET_ALL_PROJECTS: async () => ({
        successful: true,
        data: { data: { values: [{ id: '1', key: 'POM', name: 'Pomegranate' }], total: 1, isLast: true, startAt: 0, maxResults: 100 } },
      }),
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const projects = await listJiraProjects('u1', 'ca1');
    expect(projects).toEqual([{ key: 'POM', name: 'Pomegranate', id: '1' }]);
  });

  it('falls back to a single-level values array if the runtime shape differs from the declared schema', async () => {
    const execute = fakeToolsExecute({
      JIRA_GET_ALL_PROJECTS: async () => ({ successful: true, data: { values: [{ id: '2', key: 'MKT', name: 'Marketing' }] } }),
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const projects = await listJiraProjects('u1', 'ca1');
    expect(projects).toEqual([{ key: 'MKT', name: 'Marketing', id: '2' }]);
  });

  it('lists boards, optionally scoped to a project', async () => {
    const execute = fakeToolsExecute({
      JIRA_LIST_BOARDS: async (args: any) => {
        expect(args.arguments.projectKeyOrId).toBe('POM');
        return { successful: true, data: { values: [{ id: 7, name: 'Sharing board', type: 'scrum' }] } };
      },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const boards = await listJiraBoards('u1', 'ca1', 'POM');
    expect(boards).toEqual([{ id: 7, name: 'Sharing board', type: 'scrum' }]);
  });
});

describe('jira connection (auth glue, mirrors github-live.ts)', () => {
  let db: Database.Database;
  let repo: Repo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = new Repo(db);
  });

  it('ensureJiraAuthConfig creates once, then reuses the persisted row', async () => {
    const create = vi.fn(async () => ({ id: 'ac_jira_1' }));
    __setComposioClientForTests({ authConfigs: { create } } as any);
    const first = await ensureJiraAuthConfig(repo);
    const second = await ensureJiraAuthConfig(repo);
    expect(first).toBe('ac_jira_1');
    expect(second).toBe('ac_jira_1');
    expect(create).toHaveBeenCalledTimes(1); // second call reused the persisted row, no new Composio call
  });

  it('startJiraConnect mints a redirect link', async () => {
    const create = vi.fn(async () => ({ id: 'ac_jira_1' }));
    const link = vi.fn(async () => ({ id: 'ca_jira_1', redirectUrl: 'https://auth.atlassian.com/authorize?fake=1' }));
    __setComposioClientForTests({ authConfigs: { create }, connectedAccounts: { link } } as any);
    const r = await startJiraConnect(repo, 'u1', 'https://app/callback');
    expect(r.connectedAccountId).toBe('ca_jira_1');
    expect(r.redirectUrl).toContain('atlassian.com');
    expect(link).toHaveBeenCalledWith('u1', 'ac_jira_1', { callbackUrl: 'https://app/callback', allowMultiple: true });
  });

  it('refreshJiraConnectionStatus reflects live Composio status, not just a completed redirect', async () => {
    const list = vi.fn(async () => ({ items: [{ id: 'ca_jira_1', status: 'ACTIVE' }] }));
    __setComposioClientForTests({ connectedAccounts: { list } } as any);
    await expect(refreshJiraConnectionStatus('ca_jira_1')).resolves.toBe('active');
    await expect(refreshJiraConnectionStatus('ca_missing')).resolves.toBe('failed');
  });

  it('disconnectJira revokes at Composio', async () => {
    const del = vi.fn(async () => {});
    __setComposioClientForTests({ connectedAccounts: { delete: del } } as any);
    await disconnectJira('ca_jira_1');
    expect(del).toHaveBeenCalledWith('ca_jira_1');
  });

  it('test hooks bypass Composio entirely when set', async () => {
    __setJiraLiveTestHooks({
      authConfigCreator: async () => 'ac_hooked',
      linker: async () => ({ id: 'ca_hooked', redirectUrl: 'https://fake' }),
      statusChecker: async () => 'initiated',
      disconnector: async () => {},
    });
    const r = await startJiraConnect(repo, 'u1');
    expect(r.connectedAccountId).toBe('ca_hooked');
    await expect(refreshJiraConnectionStatus('ca_hooked')).resolves.toBe('initiated');
    await expect(disconnectJira('ca_hooked')).resolves.toBeUndefined();
  });
});
