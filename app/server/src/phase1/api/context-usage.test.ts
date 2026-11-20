import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Cross-user context usage logging. WHO used a workspace's context, the
// request SHAPE, and (as of the 2026-08 decision reversing the original
// 2026-06 attribution-without-content split) the verbatim request text all
// go to the attributed log; the anonymized copy of the text also still goes
// to a no-identity store for the usage-analysis synthesis; the customer
// audit log carries a `context_accessed` event (shape only, no text).

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-ctxusage-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?ctxusage=' + Date.now());
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

async function call(
  app: any,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, text };
}

const SEED_NODE = {
  id: 'dec-mobile-2026-04-15',
  type: 'decision',
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
  status: 'active',
  summary: 'Kill the v1 mobile app',
  body: 'Dropping the v1 mobile app effective 2026-04-15.',
  decided_on: '2026-04-15',
  category: 'scope',
};

const QUESTION = 'What is our stance on the v1 mobile app?';

/** Owner workspace + a second member user; member asks one web query. */
async function setupOwnerAndMember() {
  const { app, repo } = await loadApp();
  const ownerSession = await magic(app, 'owner@acme.example');
  const ws = (
    await call(app, 'POST', '/workspaces', { token: ownerSession, body: { profile_id: 'notes', name: 'Acme' } })
  ).json;
  await call(app, 'POST', `/workspaces/${ws.id}/graph`, { token: ownerSession, body: SEED_NODE });

  const memberSession = await magic(app, 'ic@acme.example');
  const memberUser = repo.db
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get('ic@acme.example') as { id: string };
  await repo.addMember({ workspace_id: ws.id, user_id: memberUser.id, role: 'member' });

  const q = await call(app, 'POST', `/workspaces/${ws.id}/query`, {
    token: memberSession,
    body: { question: QUESTION, scope: 'all' },
  });
  expect(q.status).toBe(200);

  return { app, repo, ws, ownerSession, memberSession, memberUser };
}

describe('cross-user context usage logging', () => {
  it('attributes WHO + request shape + the verbatim request text', async () => {
    const { app, ws, ownerSession } = await setupOwnerAndMember();

    const r = await call(app, 'GET', `/workspaces/${ws.id}/context-usage`, {
      token: ownerSession,
    });
    expect(r.status).toBe(200);
    const row = r.json.usage.find((u: any) => u.actor_email === 'ic@acme.example');
    expect(row).toMatchObject({
      channel: 'web',
      tool: 'query',
      scope: 'all',
      request_text: QUESTION,
    });
    expect(typeof row.has_answer).toBe('boolean');
  });

  it('stores the verbatim question anonymized — no actor columns at all', async () => {
    const { repo, ws } = await setupOwnerAndMember();

    const texts = await repo.listContextRequestTexts(ws.id);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]!.request_text).toBe(QUESTION);
    // Schema-level: the anonymized table has no identity columns.
    const cols = repo.db
      .prepare(`PRAGMA table_info(context_request_texts)`)
      .all()
      .map((c: any) => c.name);
    expect(cols).not.toContain('actor_user_id');
    expect(cols).not.toContain('actor_email');
  });

  it('shows the requester their own usage across workspaces (/me/context-usage)', async () => {
    const { app, memberSession } = await setupOwnerAndMember();

    const r = await call(app, 'GET', '/me/context-usage', { token: memberSession });
    expect(r.status).toBe(200);
    const row = r.json.usage[0];
    expect(row).toMatchObject({
      workspace_name: 'Acme',
      owner_email: 'owner@acme.example',
      own_context: false,
      tool: 'query',
      request_text: QUESTION,
    });
  });

  it('writes context_accessed to the customer audit log with a terse payload', async () => {
    const { app, ws, ownerSession } = await setupOwnerAndMember();

    const audit = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit?limit=100`, {
      token: ownerSession,
    });
    expect(audit.status).toBe(200);
    const entries = audit.json.entries.filter((e: any) => e.event === 'context_accessed');
    expect(entries.length).toBeGreaterThan(0);
    const member = entries.find((e: any) => e.actor_email === 'ic@acme.example');
    expect(member).toBeTruthy();
    const payload = JSON.parse(member.payload);
    expect(payload).toMatchObject({ channel: 'web', tool: 'query', scope: 'all' });
    expect(member.payload).not.toContain('v1');
  });

  it('records MCP tool calls (query / get_context / review / recent_changes)', async () => {
    const { app, ws, ownerSession } = await setupOwnerAndMember();

    const tok = (
      await call(app, 'POST', `/workspaces/${ws.id}/mcp-tokens`, { token: ownerSession, body: {} })
    ).json;
    const mcp = (p: string, body: unknown) =>
      call(app, 'POST', p, { token: tok.token, body });

    expect((await mcp('/mcp/tools/query_context', { question: QUESTION, scope: 'all' })).status).toBe(200);
    expect((await mcp('/mcp/tools/get_context', { scope: 'all' })).status).toBe(200);
    expect((await mcp('/mcp/tools/review_deliverable', { content: 'Buy the v1 mobile app today.', kind: 'other' })).status).toBe(200);
    expect((await mcp('/mcp/tools/list_recent_changes', {})).status).toBe(200);

    const r = await call(app, 'GET', `/workspaces/${ws.id}/context-usage?limit=50`, {
      token: ownerSession,
    });
    const mcpRows = r.json.usage.filter((u: any) => u.channel === 'mcp');
    expect(mcpRows.map((u: any) => u.tool).sort()).toEqual([
      'context_pack',
      'query',
      'recent_changes',
      'review',
    ]);
    // MCP rows attribute to the token's user.
    for (const row of mcpRows) expect(row.actor_email).toBe('owner@acme.example');
    const review = mcpRows.find((u: any) => u.tool === 'review');
    expect(review.deliverable_kind).toBe('other');
    // Deliverable bodies and questions never surface here.
    expect(r.text).not.toContain('Buy the v1 mobile app');
  });

  it('pages by id cursor, filters unanswered server-side, and reports totals', async () => {
    const { repo, ws, ownerSession, app } = await setupOwnerAndMember();
    for (let i = 0; i < 6; i++) {
      await repo.recordContextAccess(ws.id, { channel: 'mcp', tool: 'query', has_answer: i % 2 === 0, request_text: `q${i}` });
    }
    const get = async (qs: string) =>
      (await call(app, 'GET', `/workspaces/${ws.id}/context-usage?${qs}`, { token: ownerSession })).json;

    const p1 = await get('limit=4');
    expect(p1.usage).toHaveLength(4);
    expect(p1.total).toBe(7); // 6 seeded + the setup's question
    const p2 = await get(`limit=4&before=${p1.usage[3].id}`);
    expect(p2.usage).toHaveLength(3);
    expect(p2.usage[0].id).toBeLessThan(p1.usage[3].id);

    const un = await get('limit=10&filter=unanswered');
    expect(un.usage.every((u: any) => u.has_answer === false)).toBe(true);
    expect(un.usage).toHaveLength(un.unanswered_total);
    expect(un.unanswered_total).toBeGreaterThanOrEqual(3);
  });

  it('MCP reads carry human-readable detail: search terms, options, folder', async () => {
    const { app, ws, ownerSession } = await setupOwnerAndMember();
    const tok = (
      await call(app, 'POST', `/workspaces/${ws.id}/mcp-tokens`, { token: ownerSession, body: {} })
    ).json;
    const mcp = (p: string, body: unknown) => call(app, 'POST', p, { token: tok.token, body });

    expect((await mcp('/mcp/tools/search_context', { query: 'v1 mobile app retirement' })).status).toBe(200);
    expect(
      (await mcp('/mcp/tools/get_context', { scope: 'all', mode: 'index', since: '2026-04-01', sort: 'oldest' })).status,
    ).toBe(200);
    expect((await mcp('/mcp/tools/list_recent_changes', { since: '2026-04-01' })).status).toBe(200);

    const r = await call(app, 'GET', `/workspaces/${ws.id}/context-usage?limit=50`, { token: ownerSession });
    const rows = r.json.usage.filter((u: any) => u.channel === 'mcp');
    const search = rows.find((u: any) => u.tool === 'search');
    expect(search.request_text).toBe('v1 mobile app retirement');
    expect(typeof search.node_count).toBe('number');
    const pack = rows.find((u: any) => u.tool === 'context_pack');
    expect(pack.detail).toBe('titles only, added since 1 Apr 2026, oldest first');
    expect(pack.folder_name).toBeTruthy();
    const recent = rows.find((u: any) => u.tool === 'recent_changes');
    expect(recent.detail).toBe('since 1 Apr 2026');
  });

  it('usage-analysis: owner-only, separate self and team narratives', async () => {
    const { app, ws, ownerSession, memberSession } = await setupOwnerAndMember();

    // Members are not the owner — 403.
    const forbidden = await call(app, 'GET', `/workspaces/${ws.id}/usage-analysis`, {
      token: memberSession,
    });
    expect(forbidden.status).toBe(403);

    // Two more member requests (3 total → past the stub's thin-data rule)…
    for (let i = 0; i < 2; i++) {
      await call(app, 'POST', `/workspaces/${ws.id}/query`, {
        token: memberSession,
        body: { question: QUESTION, scope: 'all' },
      });
    }
    // …and three OWNER requests so the self slice narrates too.
    for (let i = 0; i < 3; i++) {
      await call(app, 'POST', `/workspaces/${ws.id}/query`, {
        token: ownerSession,
        body: { question: 'Did we keep the v1 mobile app?', scope: 'all' },
      });
    }

    const r = await call(app, 'GET', `/workspaces/${ws.id}/usage-analysis`, {
      token: ownerSession,
    });
    expect(r.status).toBe(200);
    // Team slice: the member's 3 queries, narrated for the 'team' audience.
    expect(r.json.team.stats).toMatchObject({ total: 3, distinct_users: 1 });
    expect(r.json.team.stats.by_tool.query).toBe(3);
    expect(r.json.team.summary).toContain('Stub team usage analysis: 3 requests');
    // Self slice: the owner's 3 queries, narrated separately.
    expect(r.json.self.stats).toMatchObject({ total: 3, distinct_users: 1 });
    expect(r.json.self.summary).toContain('Stub self usage analysis: 3 requests');
    // Neither narrative carries identities.
    expect(r.json.team.summary).not.toContain('ic@acme.example');
    expect(r.json.self.summary).not.toContain('owner@acme.example');
  });

  it('usage-analysis: thin slices return null summaries but real stats', async () => {
    // setupOwnerAndMember leaves exactly 1 member query — below the stub's
    // ≥3 rule — and no owner usage at all.
    const { app, ws, ownerSession } = await setupOwnerAndMember();
    const r = await call(app, 'GET', `/workspaces/${ws.id}/usage-analysis`, {
      token: ownerSession,
    });
    expect(r.status).toBe(200);
    expect(r.json.team.stats.total).toBe(1);
    expect(r.json.team.summary).toBeNull();
    expect(r.json.self.stats.total).toBe(0);
    expect(r.json.self.summary).toBeNull();
  });

  it('anonymized texts carry only the by_owner flag for the slice split', async () => {
    const { app, repo, ws, ownerSession } = await setupOwnerAndMember();
    await call(app, 'POST', `/workspaces/${ws.id}/query`, {
      token: ownerSession,
      body: { question: 'Did we keep the v1 mobile app?', scope: 'all' },
    });
    const texts = await repo.listContextRequestTexts(ws.id);
    const ownerText = texts.find((t: any) => t.request_text.includes('v1 mobile app'));
    const memberText = texts.find((t: any) => t.request_text === QUESTION);
    expect(ownerText.by_owner).toBe(1);
    expect(memberText.by_owner).toBe(0);
  });

  it('web context-pack pulls are recorded too', async () => {
    const { app, ws, ownerSession, memberSession } = await setupOwnerAndMember();

    const pack = await call(app, 'GET', `/workspaces/${ws.id}/context-pack?scope=all`, {
      token: memberSession,
    });
    expect(pack.status).toBe(200);

    const r = await call(app, 'GET', `/workspaces/${ws.id}/context-usage?limit=50`, {
      token: ownerSession,
    });
    const row = r.json.usage.find(
      (u: any) => u.tool === 'context_pack' && u.actor_email === 'ic@acme.example',
    );
    expect(row).toMatchObject({ channel: 'web', scope: 'all' });
  });
});
