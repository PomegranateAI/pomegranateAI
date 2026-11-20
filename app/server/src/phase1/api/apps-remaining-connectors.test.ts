import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { __setDriveLiveTestHooks, type DriveLiveItem } from './drive-live.js';
import { __setNotionLiveTestHooks } from './notion-live.js';
import { __setFathomLiveTestHooks } from './fathom-live.js';
import { __setTeamsLiveTestHooks, type TeamsLiveItem } from './teams-live.js';
import { __setJiraLiveTestHooks, type JiraLiveItem } from './jira-live.js';

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-remaining-connectors-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => {
  __setDriveLiveTestHooks(null);
  __setNotionLiveTestHooks(null);
  __setFathomLiveTestHooks(null);
  __setTeamsLiveTestHooks(null);
  __setJiraLiveTestHooks(null);
});

async function loadApp() {
  return import('./server.js?remainingconn=' + Date.now());
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
    body: JSON.stringify({ name: 'RemainingConn' }),
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
async function del(app: any, token: string, url: string) {
  const r = await app.request(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function oauthHooks() {
  return {
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: null }),
    statusChecker: async () => 'active' as const,
    disconnector: async () => {},
  };
}

describe('Drive: registry + preview/pull (single-document, per-item ingest)', () => {
  it('connect, preview returns a picker list, pull fetches body lazily for chosen ids only', async () => {
    let contentFetchCount = 0;
    __setDriveLiveTestHooks({
      ...oauthHooks(),
      planner: async (q) => ({ searchQuery: q, owner: null, modifiedAfter: null, audience: 'private', title: 'Drive search' }),
      searcher: async () => ({
        items: [
          { id: 'f1', title: 'Roadmap.docx', meta: 'owner · 2026-07-01', snippet: '', body: '' },
          { id: 'f2', title: 'Deck.pptx', meta: 'owner · 2026-07-02', snippet: '', body: '' },
        ] as DriveLiveItem[],
        mimeTypesById: new Map([['f1', 'application/vnd.google-apps.document'], ['f2', 'application/vnd.google-apps.presentation']]),
      }),
      contentFetcher: async (fileId) => {
        contentFetchCount++;
        return `full content of ${fileId}`;
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'drive@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/gdrive/connect', {});
    await post(app, token, '/me/apps/gdrive/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/gdrive/preview`, { query: 'the roadmap doc' });
    expect(preview.status).toBe(200);
    expect(preview.json.items).toHaveLength(2);
    expect(contentFetchCount).toBe(0); // preview never eagerly fetches body

    const pull = await post(app, token, `/workspaces/${ws.id}/apps/gdrive/pull`, {
      query: 'the roadmap doc',
      item_ids: ['f1'],
    });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1);
    expect(contentFetchCount).toBe(1); // only the chosen file's content was fetched
  });
});

describe('Notion: registry + preview/pull (single-document, per-item ingest)', () => {
  it('connect, preview returns page matches, pull fetches content for chosen page', async () => {
    __setNotionLiveTestHooks({
      ...oauthHooks(),
      planner: async (q) => ({ query: q, database: null, audience: 'private', title: 'Notion search' }),
      searcher: async () => [{ id: 'p1', title: 'Onboarding', meta: 'edited 2026-07-01', snippet: '' }],
      contentFetcher: async (pageId) => ({ id: pageId, title: 'Onboarding', meta: 'edited 2026-07-01', snippet: 'summary', body: 'full page markdown' }),
    });
    const { app } = await loadApp();
    const token = await magic(app, 'notion@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/notion/connect', {});
    await post(app, token, '/me/apps/notion/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/notion/preview`, { query: 'the onboarding doc' });
    expect(preview.status).toBe(200);
    expect(preview.json.items).toEqual([{ id: 'p1', title: 'Onboarding', meta: 'edited 2026-07-01', snippet: '' }]);

    const pull = await post(app, token, `/workspaces/${ws.id}/apps/notion/pull`, { query: 'the onboarding doc', item_ids: ['p1'] });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1);
  });
});

describe('Fathom: registry + preview/pull (meeting transcript, per-item ingest)', () => {
  it('connect, preview lists meetings, pull fetches transcript for chosen meeting', async () => {
    __setFathomLiveTestHooks({
      ...oauthHooks(),
      planner: async (q) => ({ search: q, participant: null, dateFrom: null, dateTo: null, audience: 'private', title: 'Fathom search' }),
      meetingsFetcher: async () => [{ id: 'm1', title: 'Northwind rollout call', meta: '2026-07-01' }],
      transcriptFetcher: async (meetingId) => ({ id: meetingId, title: 'Northwind rollout call', meta: '2026-07-01', snippet: '', body: 'full transcript text' }),
    });
    const { app } = await loadApp();
    const token = await magic(app, 'fathom@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/fathom/connect', {});
    await post(app, token, '/me/apps/fathom/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/fathom/preview`, { query: 'the rollout call' });
    expect(preview.status).toBe(200);
    expect(preview.json.items).toHaveLength(1);

    const pull = await post(app, token, `/workspaces/${ws.id}/apps/fathom/pull`, { query: 'the rollout call', item_ids: ['m1'] });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1);
  });
});

describe('Microsoft Teams: registry + preview/pull (aggregate, like Slack)', () => {
  it('connect, preview collapses a fetched batch into one selection row, pull ingests one aggregate document', async () => {
    __setTeamsLiveTestHooks({
      ...oauthHooks(),
      planner: async (q) => ({ mode: 'channel', team: 'Product', channel: 'General', chat: null, count: 50, topic: null, audience: 'private', title: 'Teams pull' }),
      fetcher: async () => [
        { id: 'msg1', title: 'Message from Alice', meta: 'Alice · 2026-07-01', snippet: 'shipped the thing', body: 'shipped the thing' },
      ] as TeamsLiveItem[],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'teams@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/microsoft_teams/connect', {});
    await post(app, token, '/me/apps/microsoft_teams/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/microsoft_teams/preview`, { query: 'recent messages in Product/General' });
    expect(preview.status).toBe(200);
    expect(preview.json.unit).toBe('selection');
    expect(preview.json.items).toHaveLength(1);

    const ids = preview.json.items.map((i: any) => i.id);
    const pull = await post(app, token, `/workspaces/${ws.id}/apps/microsoft_teams/pull`, { query: 'recent messages in Product/General', item_ids: ids });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1); // one aggregate document
  });
});

describe('Jira: registry + preview/pull (3 modes: project/board/ticket)', () => {
  it('ticket mode: per-item ingest, one document per ticket', async () => {
    __setJiraLiveTestHooks({
      ...oauthHooks(),
      planner: async (q) => ({ mode: 'ticket', project: 'POM', board: null, ticketKeys: ['POM-1', 'POM-2'], filter: null, audience: 'private', title: 'Jira tickets' }),
      ticketsFetcher: async () => [
        { id: 'POM-1', title: 'Fix bug', meta: 'In Progress', snippet: '', body: 'ticket body 1', status: 'In Progress' },
        { id: 'POM-2', title: 'Add feature', meta: 'Done', snippet: '', body: 'ticket body 2', status: 'Done' },
      ] as JiraLiveItem[],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'jira-ticket@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/jira/connect', {});
    await post(app, token, '/me/apps/jira/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/jira/preview`, { query: 'POM-1 and POM-2' });
    expect(preview.status).toBe(200);
    expect(preview.json.unit).toBe('ticket');
    expect(preview.json.items).toHaveLength(2);

    const pull = await post(app, token, `/workspaces/${ws.id}/apps/jira/pull`, { query: 'POM-1 and POM-2', item_ids: ['POM-1', 'POM-2'] });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(2); // each ticket its own document
  });

  it('project mode: one aggregate document for the whole project', async () => {
    __setJiraLiveTestHooks({
      ...oauthHooks(),
      planner: async () => ({ mode: 'project', project: 'POM', board: null, ticketKeys: null, filter: null, audience: 'private', title: 'POM project' }),
      projectFetcher: async () => ({
        meta: { key: 'POM', name: 'Pomegranate', description: 'The product' },
        issues: [{ id: 'POM-1', title: 'Fix bug', meta: 'In Progress', snippet: '', body: 'b', status: 'In Progress' }] as JiraLiveItem[],
      }),
    });
    const { app } = await loadApp();
    const token = await magic(app, 'jira-project@test.dev');
    const ws = await setupWs(app, token);
    await post(app, token, '/me/apps/jira/connect', {});
    await post(app, token, '/me/apps/jira/refresh', {});

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/jira/preview`, { query: 'the whole POM project' });
    expect(preview.status).toBe(200);
    expect(preview.json.unit).toBe('selection');
    expect(preview.json.items).toHaveLength(1);

    const ids = preview.json.items.map((i: any) => i.id);
    const pull = await post(app, token, `/workspaces/${ws.id}/apps/jira/pull`, { query: 'the whole POM project', item_ids: ids });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1); // one aggregate document
  });
});
