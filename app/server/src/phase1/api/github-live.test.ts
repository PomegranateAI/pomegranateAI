import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  __setGithubLiveTestHooks,
  filterGithubItems,
  fetchGithubFilesFromBranch,
  GithubRepoRequired,
  GithubUnsupportedContentType,
  type GithubLiveItem,
  type GithubPullPlan,
  type GithubFilesPullPlan,
} from './github-live.js';
import { __setComposioClientForTests } from '../../lib/composio.js';

// Deterministic synthesis stub, same convention as gmail-live.test.ts: its
// evaluateRules matches a rule when any >4-char word of the rule's criteria
// appears in the document/items text — filter tests key on "zelta".
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-github-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => __setGithubLiveTestHooks(null));

async function loadApp() {
  return import('./server.js?github=' + Date.now());
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const { dev_code } = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  const { session } = await r2.json();
  return session as string;
}

async function setupWs(app: any, token: string) {
  const r = await app.request('/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'GithubLive' }),
  });
  return r.json() as any;
}

async function post(app: any, token: string, url: string, body?: unknown) {
  const r = await app.request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function get(app: any, token: string, url: string) {
  const r = await app.request(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function fakePr(number: number, author: string, title: string, body: string): GithubLiveItem {
  return {
    id: String(number),
    title,
    meta: `@${author} · 2026-07-0${(number % 6) + 1} · open`,
    snippet: body.slice(0, 140),
    body: [`Repo: pomegranate/pomegranate`, `PR #${number}: ${title}`, `Author: ${author}`, 'State: open', '', body].join('\n'),
  };
}

// 3 PRs from zelta among 10; only their author line carries "zelta".
function prs(): GithubLiveItem[] {
  const out: GithubLiveItem[] = [];
  for (let i = 1; i <= 10; i++) {
    if (i % 3 === 0) {
      out.push(fakePr(i, 'zelta', `Fix #${i}`, 'Resolves the flaky retry path in the ingest queue.'));
    } else {
      out.push(fakePr(i, `dev${i}`, `Chore #${i}`, 'Bump a dependency and tidy up lint warnings.'));
    }
  }
  out.reverse();
  return out;
}

const zeltaPlan: GithubPullPlan = {
  repo: 'pomegranate/pomegranate',
  count: 10,
  filter: 'from zelta',
  audience: 'team',
  title: "Zelta's PRs",
};
const plainPlan: GithubPullPlan = {
  repo: 'pomegranate/pomegranate',
  count: 10,
  filter: null,
  audience: 'private',
  title: 'Recent PRs',
};

function connectedHooks(overrides: Partial<Parameters<typeof __setGithubLiveTestHooks>[0]> = {}) {
  __setGithubLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: 'https://github.com/login/oauth/authorize?fake=1' }),
    statusChecker: async () => 'active',
    disconnector: async () => {},
    ...overrides,
  });
}

async function connectGithub(app: any, token: string) {
  const connect = await post(app, token, '/me/apps/github/connect', {});
  expect(connect.status).toBe(200);
  const refresh = await post(app, token, '/me/apps/github/refresh', {});
  expect(refresh.status).toBe(200);
  expect(refresh.json.configured).toBe(true);
}

describe('github live connector (Composio prototype)', () => {
  it('preview plans, fetches, and returns only rule-matched items', async () => {
    const fetchedCounts: number[] = [];
    connectedHooks({
      planner: async () => zeltaPlan,
      fetcher: async (plan) => {
        fetchedCounts.push(plan.count);
        return prs().slice(0, plan.count);
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'github-preview@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: 'show me zelta prs on pomegranate/pomegranate',
    });
    expect(r.status).toBe(200);
    expect(r.json.live).toBe(true);
    expect(fetchedCounts).toEqual([10]);
    expect(r.json.plan).toMatchObject({ repo: 'pomegranate/pomegranate', count: 10, filter: 'from zelta', fetched: 10, matched: 3 });
    expect(r.json.items).toHaveLength(3);
    for (const item of r.json.items) {
      expect(item.meta).toContain('@zelta');
      expect(item).not.toHaveProperty('body');
    }
  });

  it('pull aggregates the selected PRs into ONE source per run', async () => {
    connectedHooks({
      planner: async () => zeltaPlan,
      fetcher: async (plan) => prs().slice(0, plan.count),
    });
    const { app } = await loadApp();
    const token = await magic(app, 'github-pull@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: 'zelta prs on pomegranate/pomegranate',
    });
    const ids = preview.json.items.map((i: any) => i.id);
    expect(ids.length).toBe(3);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/pull`, {
      query: 'zelta prs on pomegranate/pomegranate',
      item_ids: ids,
    });
    expect(r.status).toBe(200);
    expect(r.json.live).toBe(true);
    expect(r.json.audience).toBe('team');
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].title).toContain("Zelta's PRs");

    const list = await get(app, token, `/workspaces/${ws.id}/documents`);
    const doc = list.json.documents.find((d: any) => d.id === r.json.results[0].document_id);
    expect(doc).toBeTruthy();
    expect(doc.source_ref).toBe(r.json.results[0].title);
  });

  it('a plan with no repo asks for one instead of guessing', async () => {
    connectedHooks({
      planner: async () => {
        throw new GithubRepoRequired();
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'github-norepo@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, { query: 'show me recent prs' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('github_repo_required');
  });

  it('maps live failures to 502 instead of falling back to canned data', async () => {
    connectedHooks({
      planner: async () => plainPlan,
      fetcher: async () => {
        throw new Error('composio: rate limited');
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'github-down@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, { query: 'recent prs' });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('github_unavailable');
    expect(r.json.detail).toContain('rate limited');
  });

  it('filter fails closed when the provider has no rule matcher', async () => {
    const items = prs().slice(0, 5);
    const bare = { evaluateRules: undefined };
    const synthesis = await import('../../lib/synthesis.js');
    const spy = vi.spyOn(synthesis, 'getProvider').mockReturnValue(bare as any);
    try {
      await expect(filterGithubItems(items, 'from zelta')).rejects.toThrow(/refusing to ingest unfiltered/);
    } finally {
      spy.mockRestore();
    }
  });

  it('without a connected account or hooks, github answers app_not_connected', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'github-canned@test.dev');
    const ws = await setupWs(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, { query: 'anything' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('app_not_connected');
  });
});

describe('github connection (Settings → Connected apps, Composio OAuth)', () => {
  it('connect mints a redirect link; refresh confirms live status', async () => {
    connectedHooks();
    const { app } = await loadApp();
    const token = await magic(app, 'github-connect@test.dev');

    expect(await get(app, token, '/me/apps/github')).toMatchObject({ status: 200, json: { configured: false, status: null } });

    const connect = await post(app, token, '/me/apps/github/connect', {});
    expect(connect.status).toBe(200);
    expect(connect.json.redirect_url).toContain('github.com');

    // Not "connected" yet — only a live refresh confirms the OAuth actually completed.
    expect((await get(app, token, '/me/apps/github')).json).toMatchObject({ configured: false, status: 'initiated' });

    const refresh = await post(app, token, '/me/apps/github/refresh', {});
    expect(refresh.status).toBe(200);
    expect(refresh.json).toMatchObject({ configured: true, status: 'active' });
    expect(await get(app, token, '/me/apps/github')).toMatchObject({ status: 200, json: { configured: true, status: 'active' } });
  });

  it('a status check that never completes stays "initiated", not "connected"', async () => {
    connectedHooks({ statusChecker: async () => 'initiated' });
    const { app } = await loadApp();
    const token = await magic(app, 'github-pending@test.dev');

    await post(app, token, '/me/apps/github/connect', {});
    const refresh = await post(app, token, '/me/apps/github/refresh', {});
    expect(refresh.json).toMatchObject({ configured: false, status: 'initiated' });
  });

  it('disconnect revokes at Composio and clears the local row', async () => {
    const revoked: string[] = [];
    connectedHooks({ disconnector: async (id) => { revoked.push(id); } });
    const { app } = await loadApp();
    const token = await magic(app, 'github-disconnect@test.dev');
    await connectGithub(app, token);

    const del = await app.request('/me/apps/github', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(revoked).toEqual(['ca_test']);
    expect((await get(app, token, '/me/apps/github')).json).toMatchObject({ configured: false, status: null });
  });

  it('without COMPOSIO_API_KEY configured, connect refuses rather than silently no-opping', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'github-nokey@test.dev');
    const saved = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      const r = await post(app, token, '/me/apps/github/connect', {});
      expect(r.status).toBe(501);
      expect(r.json.error).toBe('composio_not_configured');
    } finally {
      process.env.COMPOSIO_API_KEY = saved;
    }
  });
});

describe('fetchGithubFilesFromBranch: binary content guard', () => {
  afterEach(() => __setComposioClientForTests(null));

  const filePlan: GithubFilesPullPlan = {
    repo: 'acme/widgets',
    branch: null,
    path: 'assets/logo.png',
    filter: null,
    audience: 'private',
    title: 'logo',
  };

  it('throws GithubUnsupportedContentType for a direct binary file path, without decoding it', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: { content: { content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), name: 'logo.png', path: 'assets/logo.png' } },
    });
    __setComposioClientForTests({ tools: { execute } } as any);

    await expect(fetchGithubFilesFromBranch(filePlan, 'user_1', 'ca_1')).rejects.toThrow(GithubUnsupportedContentType);
  });

  it('skips binary entries in a directory listing but still returns the text files', async () => {
    const execute = vi.fn().mockImplementation(async (_tool: string, { arguments: args }: { arguments: { path: string } }) => {
      if (args.path === 'src') {
        return {
          successful: true,
          error: null,
          data: {
            content: [
              { type: 'file', path: 'src/index.ts', name: 'index.ts' },
              { type: 'file', path: 'src/icon.png', name: 'icon.png' },
              { type: 'file', path: 'src/readme.md', name: 'readme.md' },
            ],
          },
        };
      }
      const bodies: Record<string, string> = {
        'src/index.ts': 'export const x = 1;',
        'src/readme.md': '# widgets',
      };
      return {
        successful: true,
        error: null,
        data: { content: { content: Buffer.from(bodies[args.path]).toString('base64'), name: args.path, path: args.path } },
      };
    });
    __setComposioClientForTests({ tools: { execute } } as any);

    const items = await fetchGithubFilesFromBranch({ ...filePlan, path: 'src' }, 'user_1', 'ca_1');

    expect(items.map((i) => i.id).sort()).toEqual(['src/index.ts', 'src/readme.md']);
    // The binary entry's content was never even requested — the directory
    // listing is filtered before the per-file getContent call, not after.
    expect(execute).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ arguments: expect.objectContaining({ path: 'src/icon.png' }) }));
  });
});
