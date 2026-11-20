import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { __setGithubLiveTestHooks, type GithubLiveItem } from './github-live.js';

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-github-files-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => __setGithubLiveTestHooks(null));

async function loadApp() {
  return import('./server.js?githubfiles=' + Date.now());
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
    body: JSON.stringify({ name: 'GithubFiles' }),
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

function connectedHooks(overrides: Partial<Parameters<typeof __setGithubLiveTestHooks>[0]> = {}) {
  __setGithubLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: null }),
    statusChecker: async () => 'active',
    disconnector: async () => {},
    ...overrides,
  });
}

async function connectGithub(app: any, token: string) {
  await post(app, token, '/me/apps/github/connect', {});
  const refresh = await post(app, token, '/me/apps/github/refresh', {});
  expect(refresh.json.configured).toBe(true);
}

function fakeFile(path: string, name: string, body: string): GithubLiveItem {
  return {
    id: path,
    title: name,
    meta: `owner/repo@main · ${path}`,
    snippet: body.slice(0, 140),
    body: [`Repo: owner/repo`, `Branch: main`, `Path: ${path}`, '', body].join('\n'),
  };
}

describe('github files-from-branch (picker-driven, no LLM planner involved)', () => {
  it('preview lists branches for a repo', async () => {
    connectedHooks({
      branchLister: async (_u, _c, repo) => {
        expect(repo).toBe('owner/repo');
        return [{ name: 'main', protected: true }, { name: 'feature/x', protected: false }];
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'files-branches@test.dev');
    await connectGithub(app, token);

    const r = await get(app, token, '/me/apps/github/branches?repo=owner/repo');
    expect(r.status).toBe(200);
    expect(r.json.branches).toEqual([
      { name: 'main', protected: true },
      { name: 'feature/x', protected: false },
    ]);
  });

  it('preview + pull with structured repo/branch/path: no LLM planner call, one row per file', async () => {
    let plannerCalls = 0;
    connectedHooks({
      filesPlanner: async () => {
        plannerCalls++;
        throw new Error('should not be called when repo is given structurally');
      },
      filesFetcher: async (plan) => {
        expect(plan).toMatchObject({ repo: 'owner/repo', branch: 'main', path: 'src' });
        return [fakeFile('src/a.ts', 'a.ts', 'export const a = 1;'), fakeFile('src/b.ts', 'b.ts', 'export const b = 2;')];
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'files-structured@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: '',
      mode: 'files',
      repo: 'owner/repo',
      branch: 'main',
      path: 'src',
    });
    expect(preview.status).toBe(200);
    expect(plannerCalls).toBe(0);
    expect(preview.json.unit).toBe('file');
    // ONE row per file — not collapsed like Slack's selection summary.
    expect(preview.json.items).toHaveLength(2);
    expect(preview.json.items.map((i: any) => i.title)).toEqual(['a.ts', 'b.ts']);
    for (const item of preview.json.items) expect(item).not.toHaveProperty('body');

    const ids = preview.json.items.map((i: any) => i.id);
    const pull = await post(app, token, `/workspaces/${ws.id}/apps/github/pull`, {
      query: '',
      mode: 'files',
      repo: 'owner/repo',
      branch: 'main',
      path: 'src',
      item_ids: ids,
    });
    expect(pull.status).toBe(200);
    // Each file is its OWN document — not aggregated into one, unlike PRs.
    expect(pull.json.results).toHaveLength(2);
    expect(new Set(pull.json.results.map((r: any) => r.document_id)).size).toBe(2);
  });

  it('a topic filter runs the shared batch-selection step, not the whole batch', async () => {
    connectedHooks({
      filesFetcher: async () => [
        fakeFile('src/auth.ts', 'auth.ts', 'handles login and session tokens'),
        fakeFile('src/utils.ts', 'utils.ts', 'unrelated helper functions'),
      ],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'files-topic@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: 'files about authentication',
      mode: 'files',
      repo: 'owner/repo',
    });
    expect(preview.status).toBe(502); // no LLM configured in this test env — fails closed, does not silently return all files
    expect(preview.json.error).toBe('github_unavailable');
    expect(preview.json.detail).toContain('refusing to ingest the whole files batch unfiltered');
  });

  it('free-text fallback (no repo given): the LLM planner constructs the plan', async () => {
    connectedHooks({
      filesPlanner: async (query) => {
        expect(query).toBe('files under src/ on the release branch of owner/repo');
        return { repo: 'owner/repo', branch: 'release', path: 'src', filter: null, audience: 'private', title: 'Release src files' };
      },
      filesFetcher: async (plan) => {
        expect(plan.branch).toBe('release');
        return [fakeFile('src/main.ts', 'main.ts', 'entry point')];
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'files-freetext@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: 'files under src/ on the release branch of owner/repo',
      mode: 'files',
    });
    expect(preview.status).toBe(200);
    expect(preview.json.items).toHaveLength(1);
    expect(preview.json.plan).toMatchObject({ repo: 'owner/repo', branch: 'release', path: 'src' });
  });

  it('without a connected account, files mode answers app_not_connected like PRs do', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'files-canned@test.dev');
    const ws = await setupWs(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, {
      query: 'anything',
      mode: 'files',
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('app_not_connected');
  });

  it('mode defaults to prs when omitted — existing PR behavior is unaffected', async () => {
    connectedHooks({
      planner: async () => ({ repo: 'owner/repo', count: 5, filter: null, audience: 'private' as const, title: 'PRs' }),
      fetcher: async () => [{ id: '1', title: 'PR', meta: 'm', snippet: 's', body: 'b' }],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'files-default-mode@test.dev');
    const ws = await setupWs(app, token);
    await connectGithub(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/github/preview`, { query: 'recent prs on owner/repo' });
    expect(r.status).toBe(200);
    expect(r.json.unit).toBe('PR');
  });
});
