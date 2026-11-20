import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { __setGmailLiveTestHooks, filterGmailItems, type GmailLiveItem, type GmailPullPlan } from './gmail-live.js';

// Deterministic synthesis stub: its evaluateRules matches a rule when any
// >4-char word of the rule's criteria appears in the document/items text —
// so the filter tests key on the word "zelta".
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-gmail-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  process.env.COMPOSIO_API_KEY = 'test-composio-key';
});

afterEach(() => __setGmailLiveTestHooks(null));

async function loadApp() {
  return import('./server.js?gmail=' + Date.now());
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
    body: JSON.stringify({ name: 'GmailLive' }),
  });
  return r.json() as any;
}

async function post(app: any, token: string, url: string, body: unknown) {
  const r = await app.request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

function fakeEmail(uid: number, from: string, subject: string, text: string): GmailLiveItem {
  return {
    id: String(uid),
    title: subject,
    meta: `${from} · 2026-07-0${(uid % 6) + 1}`,
    snippet: text.slice(0, 140),
    body: [`From: ${from}`, `Date: 2026-07-0${(uid % 6) + 1}T09:00:00.000Z`, `Subject: ${subject}`, '', text].join('\n'),
  };
}

// 3 emails from John Zelta among 25; only their From lines carry "zelta".
function inbox(): GmailLiveItem[] {
  const out: GmailLiveItem[] = [];
  for (let i = 1; i <= 25; i++) {
    if (i % 8 === 0) {
      out.push(
        fakeEmail(i, 'John Zelta <john@zelta.io>', `Pilot update ${i}`, 'Rollout is on track for next week. Two squads onboarded.'),
      );
    } else {
      out.push(fakeEmail(i, `sender${i}@example.com`, `Newsletter ${i}`, 'Weekly digest of product links and industry notes.'));
    }
  }
  out.reverse();
  return out;
}

const zeltaPlan: GmailPullPlan = { count: 25, filter: 'from Zelta', audience: 'team', title: 'Emails from John Zelta' };
const plainPlan: GmailPullPlan = { count: 20, filter: null, audience: 'private', title: 'Recent inbox emails' };

// Every live-path test needs a real user_composio_connections row (the
// gmailConn?.connected_account_id the route threads through to
// fetchRecentGmail) — auth-hook fields plus planner/fetcher are set together
// since __setGmailLiveTestHooks replaces the whole hooks object, not merges.
async function connectGmail(app: any, token: string, extra: Partial<Parameters<typeof __setGmailLiveTestHooks>[0]> = {}) {
  __setGmailLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: 'https://accounts.google.com/o/oauth2/auth?fake=1' }),
    statusChecker: async () => 'active',
    disconnector: async () => {},
    ...extra,
  });
  await post(app, token, '/me/apps/gmail/connect', {});
  await post(app, token, '/me/apps/gmail/refresh', {});
}

describe('gmail live connector', () => {
  it('preview plans, fetches, and returns only rule-matched items', async () => {
    const fetcherCounts: number[] = [];
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-preview@test.dev');
    const ws = await setupWs(app, token);
    await connectGmail(app, token, {
      planner: async () => zeltaPlan,
      fetcher: async (count) => {
        fetcherCounts.push(count);
        return inbox().slice(0, count);
      },
    });

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, {
      query: 'make emails from john zelta shareable with my team',
    });
    expect(r.status).toBe(200);
    expect(r.json.live).toBe(true);
    expect(fetcherCounts).toEqual([25]);
    expect(r.json.plan).toMatchObject({ count: 25, filter: 'from Zelta', audience: 'team', fetched: 25, matched: 3 });
    expect(r.json.items).toHaveLength(3);
    for (const item of r.json.items) {
      expect(item.meta).toContain('zelta.io');
      expect(item).not.toHaveProperty('body');
    }
  });

  it('defaults to 20 emails and no filter for a plain request', async () => {
    const fetcherCounts: number[] = [];
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-default@test.dev');
    const ws = await setupWs(app, token);
    await connectGmail(app, token, {
      planner: async () => plainPlan,
      fetcher: async (count) => {
        fetcherCounts.push(count);
        return inbox().slice(0, count);
      },
    });

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, { query: 'pull my recent emails' });
    expect(r.status).toBe(200);
    expect(fetcherCounts).toEqual([20]);
    expect(r.json.items).toHaveLength(20);
    expect(r.json.plan.audience).toBe('private');
  });

  it('pull aggregates the selected emails into ONE source per run', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-pull@test.dev');
    const ws = await setupWs(app, token);
    await connectGmail(app, token, {
      planner: async () => zeltaPlan,
      fetcher: async (count) => inbox().slice(0, count),
    });

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, {
      query: 'make emails from john zelta shareable with my team',
    });
    const ids = preview.json.items.map((i: any) => i.id);
    expect(ids.length).toBe(3);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/pull`, {
      query: 'make emails from john zelta shareable with my team',
      item_ids: ids,
    });
    expect(r.status).toBe(200);
    expect(r.json.live).toBe(true);
    expect(r.json.audience).toBe('team');
    // ONE document for the whole run, not one per email.
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0].title).toContain('John Zelta');

    const list = await app.request(`/workspaces/${ws.id}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { documents } = await list.json();
    const doc = documents.find((d: any) => d.id === r.json.results[0].document_id);
    expect(doc).toBeTruthy();
    expect(doc.source_ref).toBe(r.json.results[0].title);
  });

  it('pull without a fresh preview replans and refetches, selection still applies', async () => {
    let plans = 0;
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-nocache@test.dev');
    const ws = await setupWs(app, token);
    await connectGmail(app, token, {
      planner: async () => {
        plans++;
        return zeltaPlan;
      },
      fetcher: async (count) => inbox().slice(0, count),
    });

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/pull`, {
      query: 'share john zelta threads with the team',
      item_ids: ['8', '16', '24'],
    });
    expect(r.status).toBe(200);
    expect(plans).toBe(1);
    expect(r.json.results).toHaveLength(1);
  });

  it('maps live failures to 502 instead of falling back to canned data', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-down@test.dev');
    const ws = await setupWs(app, token);
    await connectGmail(app, token, {
      planner: async () => plainPlan,
      fetcher: async () => {
        throw new Error('imap: authentication failed');
      },
    });

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, { query: 'recent emails' });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('gmail_unavailable');
    expect(r.json.detail).toContain('authentication failed');
  });

  it('filter fails closed when the provider has no rule matcher', async () => {
    const items = inbox().slice(0, 5);
    const bare = { evaluateRules: undefined };
    const synthesis = await import('../../lib/synthesis.js');
    const spy = vi.spyOn(synthesis, 'getProvider').mockReturnValue(bare as any);
    try {
      await expect(filterGmailItems(items, 'from Zelta')).rejects.toThrow(/refusing to ingest unfiltered/);
    } finally {
      spy.mockRestore();
    }
  });

  it('without a connected mailbox or hooks, gmail answers app_not_connected', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-canned@test.dev');
    const ws = await setupWs(app, token);

    const r = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, { query: 'anything' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('app_not_connected');
  });
});

describe('gmail connection (Add Sources, Composio OAuth)', () => {
  async function get(app: any, token: string) {
    const r = await app.request('/me/apps/gmail', { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  it('connect mints a redirect link; refresh confirms live status; gates the live pull path per user', async () => {
    const fetchedWith: Array<{ userId: string; connectedAccountId: string }> = [];
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-connect@test.dev');
    const ws = await setupWs(app, token);

    // Not connected yet.
    expect((await get(app, token)).json).toMatchObject({ configured: false, status: null });

    __setGmailLiveTestHooks({
      authConfigCreator: async () => 'ac_test',
      linker: async () => ({ id: 'ca_test', redirectUrl: 'https://accounts.google.com/o/oauth2/auth?fake=1' }),
      statusChecker: async () => 'active',
      disconnector: async () => {},
    });
    const connect = await post(app, token, '/me/apps/gmail/connect', {});
    expect(connect.status).toBe(200);
    expect(connect.json.redirect_url).toContain('accounts.google.com');

    // Not "connected" yet — only a live refresh confirms the OAuth actually completed.
    expect((await get(app, token)).json).toMatchObject({ configured: false, status: 'initiated' });

    // Add the fetch hooks now, same object reference expectations as connectGmail().
    __setGmailLiveTestHooks({
      authConfigCreator: async () => 'ac_test',
      linker: async () => ({ id: 'ca_test', redirectUrl: 'https://accounts.google.com/o/oauth2/auth?fake=1' }),
      statusChecker: async () => 'active',
      disconnector: async () => {},
      planner: async () => plainPlan,
      fetcher: async (count, userId, connectedAccountId) => {
        fetchedWith.push({ userId, connectedAccountId });
        return inbox().slice(0, count);
      },
    });
    const refresh = await post(app, token, '/me/apps/gmail/refresh', {});
    expect(refresh.status).toBe(200);
    expect(refresh.json).toMatchObject({ configured: true, status: 'active' });
    expect((await get(app, token)).json).toMatchObject({ configured: true, status: 'active' });

    // Preview runs live with THIS user's connected account.
    const p = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, { query: 'recent emails' });
    expect(p.status).toBe(200);
    expect(p.json.live).toBe(true);
    expect(fetchedWith).toEqual([{ userId: expect.any(String), connectedAccountId: 'ca_test' }]);
  });

  it('a status check that never completes stays "initiated", not "connected"', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-pending@test.dev');
    await connectGmail(app, token, { statusChecker: async () => 'initiated' });

    expect((await get(app, token)).json).toMatchObject({ configured: false, status: 'initiated' });
  });

  it('disconnect revokes at Composio and clears the local row', async () => {
    const revoked: string[] = [];
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-disconnect@test.dev');
    await connectGmail(app, token, { disconnector: async (id) => { revoked.push(id); } });

    const del = await app.request('/me/apps/gmail', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(del.status).toBe(200);
    expect(revoked).toEqual(['ca_test']);
    expect((await get(app, token)).json).toMatchObject({ configured: false, status: null });
  });

  it('without COMPOSIO_API_KEY configured, connect refuses rather than silently no-opping', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'gmail-nokey@test.dev');
    const saved = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      const r = await post(app, token, '/me/apps/gmail/connect', {});
      expect(r.status).toBe(501);
      expect(r.json.error).toBe('composio_not_configured');
    } finally {
      process.env.COMPOSIO_API_KEY = saved;
    }
  });
});
