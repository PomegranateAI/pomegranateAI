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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-d1-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('../api/server.js?d1=' + Date.now());
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
  const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Audit' }, token })).json;
  // Seeded decision/positioning nodes below aren't valid under `notes` —
  // install the founding fixture profile so they validate.
  await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  const ts = '2026-01-01T00:00:00Z';
  const seed = [
    {
      id: 'pos-banned-synergy',
      type: 'positioning',
      created_at: ts,
      updated_at: ts,
      status: 'active',
      body: 'synergy',
      kind: 'banned_phrase',
    },
    {
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
  ];
  for (const n of seed) {
    await call(app, `/workspaces/${ws.id}/graph`, { body: n, token });
  }
  return ws;
}

describe('Day-1 Audit', () => {
  it('produces an aggregated report with per-deliverable detail and totals', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@d1.example');
    const ws = await seedGraph(app, token);

    const deliverables = [
      {
        source_ref: 'campaign:q2',
        kind: 'campaign',
        content: 'Unlock synergy across teams. Sign up for our v1 mobile app.',
      },
      {
        source_ref: 'email:promo',
        kind: 'sales_email',
        content: 'Hello, our v1 mobile app is back!',
      },
      {
        source_ref: 'doc:clean',
        kind: 'prd',
        content: 'A clean PRD with no banned phrases or retired products.',
      },
    ];
    const r = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      token,
      body: { deliverables },
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toMatch(/^d1_/);
    expect(r.json.deliverables_reviewed).toBe(3);

    // Heuristic provider flags synergy + v1 → expect at least 2 reds aggregated.
    expect(r.json.totals.red).toBeGreaterThanOrEqual(2);
    expect(r.json.per_deliverable).toHaveLength(3);
    const campaign = r.json.per_deliverable.find((p: any) => p.source_ref === 'campaign:q2');
    expect(campaign.totals.red).toBeGreaterThanOrEqual(2);
    expect(campaign.top_contradictions.length).toBeGreaterThan(0);
    for (const tc of campaign.top_contradictions) {
      // Integrity gate: every <red> cites a real node.
      expect(['pos-banned-synergy', 'dec-mobile-2026-04-15']).toContain(tc.node_id);
    }
    // Clean deliverable produces no reds.
    const clean = r.json.per_deliverable.find((p: any) => p.source_ref === 'doc:clean');
    expect(clean.totals.red).toBe(0);
  });

  it('persists the report; GET by id returns the same shape', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader2@d1.example');
    const ws = await seedGraph(app, token);
    const post = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      token,
      body: { deliverables: [{ content: 'Unlock synergy.' }] },
    });
    expect(post.status).toBe(200);

    const list = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      method: 'GET',
      token,
    });
    expect(list.json.reports).toHaveLength(1);
    expect(list.json.reports[0].id).toBe(post.json.id);

    const fetched = await call(app, `/workspaces/${ws.id}/day-1-audit/${post.json.id}`, {
      method: 'GET',
      token,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.json.id).toBe(post.json.id);
    expect(fetched.json.totals).toEqual(post.json.totals);
  });

  it('rejects empty deliverable list and oversized batches', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader3@d1.example');
    const ws = await seedGraph(app, token);
    const empty = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      token,
      body: { deliverables: [] },
    });
    expect(empty.status).toBe(400);

    const huge = Array.from({ length: 51 }, () => ({ content: 'x' }));
    const big = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      token,
      body: { deliverables: huge },
    });
    expect(big.status).toBe(400);
  });

  it('reports from workspace A are not visible to workspace B', async () => {
    const { app } = await loadApp();
    const tokA = await magic(app, 'a@d1.example');
    const tokB = await magic(app, 'b@d1.example');
    const wsA = await seedGraph(app, tokA);
    const wsB = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'B' }, token: tokB })).json;

    const ra = await call(app, `/workspaces/${wsA.id}/day-1-audit`, {
      token: tokA,
      body: { deliverables: [{ content: 'synergy' }] },
    });
    expect(ra.status).toBe(200);

    // B tries to read A's report from B's namespace → 404
    const cross = await call(app, `/workspaces/${wsB.id}/day-1-audit/${ra.json.id}`, {
      method: 'GET',
      token: tokB,
    });
    expect(cross.status).toBe(404);
    // B tries A's namespace directly → 403 (workspaceGate)
    const forbidden = await call(app, `/workspaces/${wsA.id}/day-1-audit/${ra.json.id}`, {
      method: 'GET',
      token: tokB,
    });
    expect(forbidden.status).toBe(403);
  });

  it('writes a customer-audit row that records counts but not deliverable text', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader4@d1.example');
    const ws = await seedGraph(app, token);
    await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      token,
      body: { deliverables: [{ content: 'Unlock synergy.', source_ref: 'sensitive-doc' }] },
    });
    const audit = await call(app, `/workspaces/${ws.id}/customer-audit`, {
      method: 'GET',
      token,
    });
    const row = audit.json.entries.find(
      (e: any) => e.resource_type === 'day1_audit',
    );
    expect(row).toBeTruthy();
    const payload = JSON.parse(row.payload);
    expect(payload.caller).toBe('day1_audit');
    expect(payload.deliverables).toBe(1);
    // Deliverable text is never echoed into the audit payload.
    expect(row.payload).not.toContain('synergy');
    expect(row.payload).not.toContain('sensitive-doc');
  });
});
