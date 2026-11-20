import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { __setGithubLiveTestHooks } from './github-live.js';

// Stage 4: instructions on a connector pull reuse the exact same
// runInstructedIngest/add-source-agent engine as Upload/Paste — never a
// separate implementation. Mock the agent module itself (not the LLM/network
// underneath it) so this test proves the ROUTING (instructions -> agent path,
// no instructions -> plain path), not the agent's own behavior — that's
// covered by add-source-agent.test.ts.
const runAddSourceAgentMock = vi.fn();
vi.mock('../agent/add-source-agent.js', async () => {
  const real = await vi.importActual<typeof import('../agent/add-source-agent.js')>('../agent/add-source-agent.js');
  return { ...real, runAddSourceAgent: (...args: unknown[]) => runAddSourceAgentMock(...args) };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-instr-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => {
  __setGithubLiveTestHooks(null);
  runAddSourceAgentMock.mockReset();
});

async function loadApp() {
  return import('./server.js?instr=' + Date.now());
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
async function post(app: any, token: string, url: string, body?: unknown) {
  const r = await app.request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function connectAndPreview(app: any, token: string, wsId: string) {
  __setGithubLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: null }),
    statusChecker: async () => 'active',
    planner: async () => ({ repo: 'a/b', count: 5, filter: null, audience: 'private' as const, title: 'Recent PRs' }),
    fetcher: async () => [{ id: 'pr1', title: 'PR1', meta: '@dev · 2026-07-01', snippet: 's', body: 'PR body' }],
  });
  await post(app, token, '/me/apps/github/connect', {});
  await post(app, token, '/me/apps/github/refresh', {});
  const preview = await post(app, token, `/workspaces/${wsId}/apps/github/preview`, { query: 'recent prs on a/b' });
  return preview.json.items.map((i: any) => i.id) as string[];
}

describe('apps/:app/pull instructions (reuses runInstructedIngest, same as Upload/Paste)', () => {
  it('with instructions: routes through the add-source-agent, not the plain aggregate ingest', async () => {
    runAddSourceAgentMock.mockResolvedValue({
      message: 'Filed under Notes.',
      receipts: [
        { tool: 'ingest_document', args: {}, ok: true, result: { document_id: 'doc_abc', candidates: 3 } },
      ],
      pending_action: null,
    });
    const { app } = await loadApp();
    const token = await magic(app, 'instr-yes@test.dev');
    const ws = await post(app, token, '/workspaces', { name: 'W' });
    const ids = await connectAndPreview(app, token, ws.json.id);

    const r = await post(app, token, `/workspaces/${ws.json.id}/apps/github/pull`, {
      query: 'recent prs on a/b',
      item_ids: ids,
      instructions: 'file this under a Notes folder, create it if missing',
    });
    expect(r.status).toBe(200);
    expect(runAddSourceAgentMock).toHaveBeenCalledTimes(1);
    expect(runAddSourceAgentMock.mock.calls[0]![0]).toMatchObject({
      instructions: 'file this under a Notes folder, create it if missing',
    });
    expect(r.json.results).toEqual([{ id: 'github_run', title: expect.any(String), document_id: 'doc_abc', candidates: 3 }]);
    expect(r.json.total_candidates).toBe(3);
  });

  it('agent can decline to ingest — response reports zero results + its message, not a fake success', async () => {
    runAddSourceAgentMock.mockResolvedValue({
      message: "That doesn't look like something worth filing — nothing ingested.",
      receipts: [],
      pending_action: null,
    });
    const { app } = await loadApp();
    const token = await magic(app, 'instr-decline@test.dev');
    const ws = await post(app, token, '/workspaces', { name: 'W' });
    const ids = await connectAndPreview(app, token, ws.json.id);

    const r = await post(app, token, `/workspaces/${ws.json.id}/apps/github/pull`, {
      query: 'recent prs on a/b',
      item_ids: ids,
      instructions: 'ignore this, not relevant',
    });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([]);
    expect(r.json.total_candidates).toBe(0);
    expect(r.json.message).toContain('nothing ingested');
  });

  it('without instructions: plain aggregate ingest runs, the agent is never invoked', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'instr-no@test.dev');
    const ws = await post(app, token, '/workspaces', { name: 'W' });
    const ids = await connectAndPreview(app, token, ws.json.id);

    const r = await post(app, token, `/workspaces/${ws.json.id}/apps/github/pull`, {
      query: 'recent prs on a/b',
      item_ids: ids,
    });
    expect(r.status).toBe(200);
    expect(runAddSourceAgentMock).not.toHaveBeenCalled();
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].document_id).toBeTruthy();
  });
});
