import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mirror-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?mirror=' + Date.now());
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
  url: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(url, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function seedGraph(app: any, token: string) {
  const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Mirror' }, token })).json;
  // Fixtures below use decision/positioning kinds and the 'decisions' scope
  // the stub's heuristics and this test's assertions target — install the
  // founding fixture profile so they validate instead of 422ing against `notes`.
  await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  const ts = '2026-01-01T00:00:00Z';
  await call(app, `/workspaces/${ws.id}/graph`, {
    token,
    body: {
      id: 'dec-mobile-2026-04-15',
      type: 'decision',
      created_at: '2026-04-15T00:00:00Z',
      updated_at: '2026-04-15T00:00:00Z',
      status: 'active',
      summary: 'Kill the v1 mobile app',
      body: 'Dropping the v1 mobile app effective 2026-04-15.',
      decided_on: '2026-04-15',
      category: 'scope',
    },
  });
  await call(app, `/workspaces/${ws.id}/graph`, {
    token,
    body: {
      id: 'pos-banned-synergy',
      type: 'positioning',
      created_at: ts,
      updated_at: ts,
      status: 'active',
      body: 'synergy',
      kind: 'banned_phrase',
    },
  });
  return ws;
}

describe('Mirror endpoints', () => {
  it('POST /query — session-authed graph query, integrity-gated', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@mir.example');
    const ws = await seedGraph(app, token);
    const r = await call(app, `/workspaces/${ws.id}/query`, {
      token,
      body: { question: 'What is our stance on the v1 mobile app?', scope: 'decisions' },
    });
    expect(r.status).toBe(200);
    expect(r.json.cited_node_ids).toContain('dec-mobile-2026-04-15');
    // All cited ids must resolve in the active graph.
    for (const id of r.json.cited_node_ids) {
      expect(['dec-mobile-2026-04-15', 'pos-banned-synergy']).toContain(id);
    }
  });

  it('GET /mcp-queries — returns anonymized stream of recent MCP question shapes', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader2@mir.example');
    const ws = await seedGraph(app, token);
    // Issue an MCP token, then send a few question_context calls through it.
    const tok = (
      await call(app, `/workspaces/${ws.id}/mcp-tokens`, { body: {}, token })
    ).json.token;
    for (const q of [
      'What is our roadmap?',
      'Are we still mid-market?',
      'Is synergy approved?',
    ]) {
      await call(app, `/mcp/tools/query_context`, {
        body: { question: q, scope: 'all' },
        token: tok,
      });
    }
    const r = await call(app, `/workspaces/${ws.id}/mcp-queries`, {
      method: 'GET',
      token,
    });
    expect(r.status).toBe(200);
    expect(r.json.queries.length).toBeGreaterThanOrEqual(3);
    // Each row carries scope + has_answer + cited count, never the question text or IC.
    for (const q of r.json.queries) {
      expect(q).toHaveProperty('scope');
      expect(q).toHaveProperty('has_answer');
      expect(q).toHaveProperty('cited');
      expect(q).not.toHaveProperty('question');
      expect(q).not.toHaveProperty('actor');
      expect(q).not.toHaveProperty('user_id');
    }
  });

  it('GET /reviews — anonymized review log, no body, no submitter', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader3@mir.example');
    const ws = await seedGraph(app, token);
    // Two reviews — heuristic should flag both.
    await call(app, `/workspaces/${ws.id}/reviews`, {
      token,
      body: { deliverable: 'Unlock synergy across teams.', kind: 'campaign' },
    });
    await call(app, `/workspaces/${ws.id}/reviews`, {
      token,
      body: { deliverable: 'Sign up for our v1 mobile app.', kind: 'sales_email' },
    });

    const r = await call(app, `/workspaces/${ws.id}/reviews`, { method: 'GET', token });
    expect(r.status).toBe(200);
    expect(r.json.reviews.length).toBe(2);
    for (const rv of r.json.reviews) {
      expect(rv).toHaveProperty('caller');
      expect(rv).toHaveProperty('kind');
      expect(rv).toHaveProperty('red');
      expect(rv).toHaveProperty('yellow');
      expect(rv).toHaveProperty('green');
      // Never returns the deliverable body or the submitter id.
      expect(rv).not.toHaveProperty('deliverable');
      expect(rv).not.toHaveProperty('submitted_by');
      expect(rv).not.toHaveProperty('findings');
    }
  });

  it('Mirror endpoints respect workspace isolation', async () => {
    const { app } = await loadApp();
    const tokA = await magic(app, 'a@mir.example');
    const tokB = await magic(app, 'b@mir.example');
    const wsA = await seedGraph(app, tokA);
    const wsB = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'B' }, token: tokB })).json;

    // B cannot read A's reviews
    const cross = await call(app, `/workspaces/${wsA.id}/reviews`, {
      method: 'GET',
      token: tokB,
    });
    expect(cross.status).toBe(403);

    // B's own reviews list is empty
    const own = await call(app, `/workspaces/${wsB.id}/reviews`, {
      method: 'GET',
      token: tokB,
    });
    expect(own.status).toBe(200);
    expect(own.json.reviews).toHaveLength(0);
  });
});
