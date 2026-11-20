import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { __setSlackLiveTestHooks, type SlackLiveItem } from './slack-live.js';

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-slack-routes-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => __setSlackLiveTestHooks(null));

async function loadApp() {
  return import('./server.js?slackroutes=' + Date.now());
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
    body: JSON.stringify({ name: 'SlackRoutes' }),
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

function connectedHooks(overrides: Partial<Parameters<typeof __setSlackLiveTestHooks>[0]> = {}) {
  __setSlackLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: null }),
    statusChecker: async () => 'active',
    disconnector: async () => {},
    ...overrides,
  });
}

async function connectSlack(app: any, token: string) {
  await post(app, token, '/me/apps/slack/connect', {});
  const refresh = await post(app, token, '/me/apps/slack/refresh', {});
  expect(refresh.json.configured).toBe(true);
}

function fakeMessage(id: string, user: string, text: string): SlackLiveItem {
  return {
    id,
    title: `Message from ${user}`,
    meta: `${user} · 2026-07-29`,
    snippet: text.slice(0, 140),
    body: `Conversation: #general\nFrom: ${user}\nTime: 2026-07-29\n\n${text}`,
  };
}

describe('slack routes (registry + preview/pull wiring)', () => {
  it('generic registry routes work for slack: connect/refresh/disconnect/picker', async () => {
    connectedHooks({
      conversationLister: async () => [
        { id: 'C1', type: 'channel', name: '#general' },
        { id: 'D1', type: 'im', name: 'DM with Alice' },
      ],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'slack-registry@test.dev');

    const connect = await post(app, token, '/me/apps/slack/connect', {});
    expect(connect.status).toBe(200);
    const refresh = await post(app, token, '/me/apps/slack/refresh', {});
    expect(refresh.json).toMatchObject({ configured: true, status: 'active' });

    const picker = await get(app, token, '/me/apps/slack/picker');
    expect(picker.status).toBe(200);
    expect(picker.json.items).toEqual([
      { id: 'C1', type: 'channel', name: '#general' },
      { id: 'D1', type: 'im', name: 'DM with Alice' },
    ]);

    const disconnect = await post(app, token, '/me/apps/slack', undefined).then(() =>
      app.request('/me/apps/slack', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
    );
    expect(disconnect.status).toBe(200);
  });

  it('preview + pull with free-text query: LLM planner path, one collapsed selection row', async () => {
    let plannerCalls = 0;
    connectedHooks({
      planner: async (query) => {
        plannerCalls++;
        expect(query).toBe('recent messages in #general');
        return { channel: '#general', count: 30, filter: null, audience: 'private' as const, title: 'Recent messages in #general' };
      },
      fetcher: async () => [fakeMessage('1', 'alice', 'hello'), fakeMessage('2', 'bob', 'world')],
    });
    const { app } = await loadApp();
    const token = await magic(app, 'slack-freetext@test.dev');
    const ws = await setupWs(app, token);
    await connectSlack(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/slack/preview`, {
      query: 'recent messages in #general',
    });
    expect(preview.status).toBe(200);
    expect(plannerCalls).toBe(1);
    expect(preview.json.unit).toBe('selection');
    // ONE collapsed row, not one per message.
    expect(preview.json.items).toHaveLength(1);
    expect(preview.json.plan.fetched).toBe(2);
    expect(preview.json.plan.matched).toBe(2);

    const ids = preview.json.items.map((i: any) => i.id);
    const pull = await post(app, token, `/workspaces/${ws.id}/apps/slack/pull`, {
      query: 'recent messages in #general',
      item_ids: ids,
    });
    expect(pull.status).toBe(200);
    // ONE aggregate document for the whole batch — unlike GitHub files mode.
    expect(pull.json.results).toHaveLength(1);
    expect(pull.json.results[0].document_id).toBeTruthy();
  });

  it('preview + pull with a structured picker-selected channel: no LLM planner call', async () => {
    let plannerCalls = 0;
    connectedHooks({
      planner: async () => {
        plannerCalls++;
        throw new Error('should not be called when channel is given structurally');
      },
      fetcher: async (plan) => {
        expect(plan.channel).toBe('D1');
        return [fakeMessage('1', 'alice', 'hi there')];
      },
    });
    const { app } = await loadApp();
    const token = await magic(app, 'slack-structured@test.dev');
    const ws = await setupWs(app, token);
    await connectSlack(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/slack/preview`, {
      query: '',
      channel: 'D1',
    });
    expect(preview.status).toBe(200);
    expect(plannerCalls).toBe(0);
    expect(preview.json.items).toHaveLength(1);
    expect(preview.json.plan.channel).toBe('D1');

    const ids = preview.json.items.map((i: any) => i.id);
    const pull = await post(app, token, `/workspaces/${ws.id}/apps/slack/pull`, {
      query: '',
      channel: 'D1',
      item_ids: ids,
    });
    expect(pull.status).toBe(200);
    expect(pull.json.results).toHaveLength(1);
  });

  it('a topic filter runs the shared batch-selection step', async () => {
    connectedHooks({
      fetcher: async () => [fakeMessage('1', 'alice', 'about the customer call'), fakeMessage('2', 'bob', 'unrelated chatter')],
      selector: async (items) => items.filter((i) => i.body.includes('customer call')),
    });
    const { app } = await loadApp();
    const token = await magic(app, 'slack-topic@test.dev');
    const ws = await setupWs(app, token);
    await connectSlack(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/slack/preview`, {
      query: '',
      channel: 'C1',
      // query doubles as the topic filter in structured mode
    });
    expect(preview.status).toBe(200);
    expect(preview.json.plan.fetched).toBe(2);
    expect(preview.json.plan.matched).toBe(2); // no filter set (query was empty) — whole batch kept
  });

  it('without a connected account, answers app_not_connected like other connectors', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'slack-canned@test.dev');
    const ws = await setupWs(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/slack/preview`, {
      query: 'anything',
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('app_not_connected');
  });
});
