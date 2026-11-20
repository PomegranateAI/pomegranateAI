import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { __setComposioClientForTests } from '../../lib/composio.js';
import type { Composio } from '@composio/core';
import {
  __setNotionLiveTestHooks,
  planNotionPull,
  fetchNotionPages,
  fetchNotionPageContent,
  ensureNotionAuthConfig,
  startNotionConnect,
  refreshNotionConnectionStatus,
  disconnectNotion,
  notionLiveConfigured,
  cacheNotionPreview,
  getNotionPreview,
  notionRunRef,
  NotionQueryRequired,
  NotionAgentUnavailable,
  type NotionPullPlan,
} from './notion-live.js';

// These are unit tests against the module's exported functions directly —
// NOT server/route integration tests, since routes.ts is out of scope for
// this connector (another pass wires github/notion/etc into routes.ts,
// server.ts, Sources.tsx together to avoid cross-connector merge conflicts).
// Every real external call (Composio, LLM) is either a test hook or a fake
// Composio client injected via __setComposioClientForTests, so these run
// with zero network access and no COMPOSIO_API_KEY required for the
// hook-based tests. A handful of tests fake the Composio CLIENT itself
// (rather than the higher-level test hooks) specifically to exercise this
// file's own response-shape parsing logic, since that logic is explicitly
// unverified against a live account (see the comment block in
// notion-live.ts above NOTION_SEARCH_NOTION_PAGE) and deserves real coverage
// of what it does with a plausible payload.

let db: Database.Database;
let repo: Repo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => {
  __setNotionLiveTestHooks(null);
  __setComposioClientForTests(null);
  delete process.env.COMPOSIO_API_KEY;
});

function fakeExecute(handler: (toolSlug: string, args: any) => any): Composio {
  return {
    tools: { execute: async (toolSlug: string, args: any) => handler(toolSlug, args) },
  } as unknown as Composio;
}

const plan: NotionPullPlan = {
  query: 'onboarding',
  database: null,
  audience: 'team',
  title: 'Onboarding doc (Notion)',
};

describe('planNotionPull', () => {
  it('uses the planner hook when set', async () => {
    __setNotionLiveTestHooks({ planner: async () => plan });
    const result = await planNotionPull('the onboarding doc');
    expect(result).toEqual(plan);
  });

  it('a plan with no page named asks for one instead of guessing', async () => {
    __setNotionLiveTestHooks({
      planner: async () => {
        throw new NotionQueryRequired();
      },
    });
    await expect(planNotionPull('pull something from notion')).rejects.toThrow(NotionQueryRequired);
  });

  it('throws NotionAgentUnavailable when no LLM is configured and no hook is set', async () => {
    // hasStructuredLLM() also passes when a real ANTHROPIC_API_KEY happens to
    // be present in the shell (as it is in this dev sandbox) — unset it for
    // this one assertion so the "no LLM available" path is actually exercised,
    // same guard anthropic.test.ts uses for its own live-vs-stub gating.
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(planNotionPull('the onboarding doc')).rejects.toThrow(NotionAgentUnavailable);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('auth: connect / status / disconnect', () => {
  it('ensureNotionAuthConfig uses the hook, then caches nothing extra beyond the repo row', async () => {
    __setNotionLiveTestHooks({ authConfigCreator: async () => 'ac_test' });
    const id = await ensureNotionAuthConfig(repo);
    expect(id).toBe('ac_test');
  });

  it('ensureNotionAuthConfig returns an existing repo-stored auth config without calling Composio', async () => {
    await repo.setComposioAuthConfig('notion', 'ac_existing');
    delete process.env.COMPOSIO_API_KEY; // if this reached getComposioClient() it would throw
    const id = await ensureNotionAuthConfig(repo);
    expect(id).toBe('ac_existing');
  });

  it('startNotionConnect mints a redirect via the linker hook', async () => {
    __setNotionLiveTestHooks({
      authConfigCreator: async () => 'ac_test',
      linker: async () => ({ id: 'ca_test', redirectUrl: 'https://notion.so/oauth/authorize?fake=1' }),
    });
    const r = await startNotionConnect(repo, 'user_1', 'https://app.example/callback');
    expect(r).toEqual({ connectedAccountId: 'ca_test', redirectUrl: 'https://notion.so/oauth/authorize?fake=1' });
  });

  it('refreshNotionConnectionStatus reports the statusChecker hook result', async () => {
    __setNotionLiveTestHooks({ statusChecker: async () => 'active' });
    expect(await refreshNotionConnectionStatus('ca_test')).toBe('active');
  });

  it('a status check that never completes stays "initiated"', async () => {
    __setNotionLiveTestHooks({ statusChecker: async () => 'initiated' });
    expect(await refreshNotionConnectionStatus('ca_test')).toBe('initiated');
  });

  it('disconnectNotion calls the disconnector hook', async () => {
    const revoked: string[] = [];
    __setNotionLiveTestHooks({ disconnector: async (id) => void revoked.push(id) });
    await disconnectNotion('ca_test');
    expect(revoked).toEqual(['ca_test']);
  });

  it('notionLiveConfigured is true whenever test hooks are installed, or the connection is active', () => {
    expect(notionLiveConfigured(undefined)).toBe(false);
    expect(notionLiveConfigured({ status: 'initiated' })).toBe(false);
    expect(notionLiveConfigured({ status: 'active' })).toBe(true);
    __setNotionLiveTestHooks({});
    expect(notionLiveConfigured(undefined)).toBe(true);
  });
});

describe('fetchNotionPages (search)', () => {
  it('uses the searcher hook when set', async () => {
    const matches = [{ id: 'p1', title: 'Onboarding Guide', meta: 'edited 2026-07-20', snippet: '' }];
    __setNotionLiveTestHooks({ searcher: async () => matches });
    const result = await fetchNotionPages(plan, 'user_1', 'ca_test');
    expect(result).toEqual(matches);
  });

  it('parses a { results: [...] } response shape into picker items (title from properties.<title-type-prop>.title)', async () => {
    __setComposioClientForTests(
      fakeExecute((_tool, args) => {
        expect(args.arguments.query).toBe('onboarding');
        expect(args.arguments.filter_value).toBe('page');
        return {
          successful: true,
          data: {
            results: [
              {
                id: 'p1',
                object: 'page',
                last_edited_time: '2026-07-20T10:00:00.000Z',
                last_edited_by: { object: 'user', id: 'u1' },
                parent: { type: 'workspace' },
                properties: {
                  title: { id: 'title', type: 'title', title: [{ plain_text: 'Onboarding Guide' }] },
                },
              },
            ],
          },
        };
      }),
    );
    const result = await fetchNotionPages(plan, 'user_1', 'ca_test');
    expect(result).toEqual([{ id: 'p1', title: 'Onboarding Guide', meta: 'edited 2026-07-20', snippet: '' }]);
  });

  it('also parses a bare-array response and a { pages: [...] } response (defensive shape handling)', async () => {
    __setComposioClientForTests(
      fakeExecute(() => ({
        successful: true,
        data: [{ id: 'p2', properties: { Name: { type: 'title', title: [{ plain_text: 'Bare array page' }] } } }],
      })),
    );
    expect(await fetchNotionPages(plan, 'user_1', 'ca_test')).toEqual([
      { id: 'p2', title: 'Bare array page', meta: '', snippet: '' },
    ]);

    __setComposioClientForTests(
      fakeExecute(() => ({
        successful: true,
        data: { pages: [{ id: 'p3', properties: { Name: { type: 'title', title: [{ plain_text: 'Pages-key page' }] } } }] },
      })),
    );
    expect(await fetchNotionPages(plan, 'user_1', 'ca_test')).toEqual([
      { id: 'p3', title: 'Pages-key page', meta: '', snippet: '' },
    ]);
  });

  it('scopes to a named database: resolves the database id first, then keeps only pages parented under it', async () => {
    const scopedPlan: NotionPullPlan = { ...plan, database: 'Product Wiki' };
    __setComposioClientForTests(
      fakeExecute((_tool, args) => {
        if (args.arguments.filter_value === 'database') {
          expect(args.arguments.query).toBe('Product Wiki');
          return { successful: true, data: { results: [{ id: 'db1', title: [{ plain_text: 'Product Wiki' }] }] } };
        }
        return {
          successful: true,
          data: {
            results: [
              {
                id: 'in-db',
                parent: { type: 'database_id', database_id: 'db1' },
                properties: { title: { type: 'title', title: [{ plain_text: 'In the wiki' }] } },
              },
              {
                id: 'not-in-db',
                parent: { type: 'page_id', page_id: 'somewhere-else' },
                properties: { title: { type: 'title', title: [{ plain_text: 'Not in the wiki' }] } },
              },
            ],
          },
        };
      }),
    );
    const result = await fetchNotionPages(scopedPlan, 'user_1', 'ca_test');
    expect(result).toEqual([{ id: 'in-db', title: 'In the wiki', meta: '', snippet: '' }]);
  });

  it('falls back to unscoped results when the named database cannot be resolved', async () => {
    const scopedPlan: NotionPullPlan = { ...plan, database: 'Nonexistent DB' };
    __setComposioClientForTests(
      fakeExecute((_tool, args) => {
        if (args.arguments.filter_value === 'database') {
          return { successful: true, data: { results: [] } };
        }
        return {
          successful: true,
          data: { results: [{ id: 'p1', properties: { title: { type: 'title', title: [{ plain_text: 'Any page' }] } } }] },
        };
      }),
    );
    const result = await fetchNotionPages(scopedPlan, 'user_1', 'ca_test');
    expect(result).toEqual([{ id: 'p1', title: 'Any page', meta: '', snippet: '' }]);
  });

  it('maps a live tool failure to a thrown error', async () => {
    __setComposioClientForTests(fakeExecute(() => ({ successful: false, error: 'rate limited' })));
    await expect(fetchNotionPages(plan, 'user_1', 'ca_test')).rejects.toThrow(/rate limited/);
  });
});

describe('fetchNotionPageContent', () => {
  it('uses the contentFetcher hook when set', async () => {
    const item = { id: 'p1', title: 'Onboarding Guide', meta: 'edited 2026-07-20', snippet: 'hi', body: 'hi there' };
    __setNotionLiveTestHooks({ contentFetcher: async () => item });
    expect(await fetchNotionPageContent('p1', 'user_1', 'ca_test')).toEqual(item);
  });

  it('combines page metadata + flattened markdown into one item, resolving the author via a follow-up call when not embedded', async () => {
    __setComposioClientForTests(
      fakeExecute((tool, args) => {
        if (tool === 'NOTION_RETRIEVE_PAGE') {
          expect(args.arguments.page_id).toBe('p1');
          return {
            successful: true,
            data: {
              object: 'page',
              id: 'p1',
              last_edited_time: '2026-07-20T10:00:00.000Z',
              last_edited_by: { object: 'user', id: 'u1' },
              url: 'https://notion.so/Onboarding-Guide-p1',
              properties: { title: { type: 'title', title: [{ plain_text: 'Onboarding Guide' }] } },
            },
          };
        }
        if (tool === 'NOTION_GET_PAGE_MARKDOWN') {
          expect(args.arguments.page_id).toBe('p1');
          return { successful: true, data: { markdown: '# Onboarding\n\nWelcome to the team.' } };
        }
        if (tool === 'NOTION_GET_ABOUT_USER') {
          expect(args.arguments.user_id).toBe('u1');
          return { successful: true, data: { name: 'Jane Doe' } };
        }
        throw new Error(`unexpected tool ${tool}`);
      }),
    );
    const item = await fetchNotionPageContent('p1', 'user_1', 'ca_test');
    expect(item.id).toBe('p1');
    expect(item.title).toBe('Onboarding Guide');
    expect(item.meta).toBe('edited 2026-07-20 · by Jane Doe');
    expect(item.snippet).toContain('Onboarding');
    expect(item.body).toContain('Notion page: Onboarding Guide');
    expect(item.body).toContain('URL: https://notion.so/Onboarding-Guide-p1');
    expect(item.body).toContain('Welcome to the team.');
  });

  it('skips the author follow-up call when the metadata already embeds a name', async () => {
    let aboutUserCalled = false;
    __setComposioClientForTests(
      fakeExecute((tool) => {
        if (tool === 'NOTION_RETRIEVE_PAGE') {
          return {
            successful: true,
            data: {
              last_edited_time: '2026-07-20T10:00:00.000Z',
              last_edited_by: { name: 'Embedded Name' },
              properties: { title: { type: 'title', title: [{ plain_text: 'Doc' }] } },
            },
          };
        }
        if (tool === 'NOTION_GET_PAGE_MARKDOWN') return { successful: true, data: { markdown: 'body' } };
        aboutUserCalled = true;
        return { successful: true, data: {} };
      }),
    );
    const item = await fetchNotionPageContent('p1', 'user_1', 'ca_test');
    expect(item.meta).toBe('edited 2026-07-20 · by Embedded Name');
    expect(aboutUserCalled).toBe(false);
  });

  it('truncates very long page bodies to the char cap', async () => {
    const longText = 'x'.repeat(5000);
    __setComposioClientForTests(
      fakeExecute((tool) => {
        if (tool === 'NOTION_RETRIEVE_PAGE') {
          return { successful: true, data: { properties: { title: { type: 'title', title: [{ plain_text: 'Long' }] } } } };
        }
        if (tool === 'NOTION_GET_PAGE_MARKDOWN') return { successful: true, data: { markdown: longText } };
        return { successful: true, data: {} };
      }),
    );
    const item = await fetchNotionPageContent('p1', 'user_1', 'ca_test');
    expect(item.body).toContain('…[truncated]');
    expect(item.body.length).toBeLessThan(longText.length);
  });

  it('maps a live tool failure to a thrown error', async () => {
    __setComposioClientForTests(fakeExecute(() => ({ successful: false, error: 'notion down' })));
    await expect(fetchNotionPageContent('p1', 'user_1', 'ca_test')).rejects.toThrow(/notion down/);
  });
});

describe('preview cache + run ref', () => {
  it('round-trips a cached preview keyed by query, and misses on a different query', () => {
    const matches = [{ id: 'p1', title: 'Onboarding Guide', meta: '', snippet: '' }];
    cacheNotionPreview('ws1:user1', { query: 'onboarding', plan, matches });
    expect(getNotionPreview('ws1:user1', 'onboarding')).toMatchObject({ plan, matches });
    expect(getNotionPreview('ws1:user1', 'something else')).toBeNull();
    expect(getNotionPreview('ws-unknown', 'onboarding')).toBeNull();
  });

  it('renders a stable run ref containing the plan title and a date', () => {
    const ref = notionRunRef(plan);
    expect(ref).toContain('notion:');
    expect(ref).toContain(plan.title);
    expect(ref).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
