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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mw-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?mw=' + Date.now());
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

async function seedReview(app: any, token: string) {
  const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'MW' }, token })).json;
  // The stub's banned-phrase detection targets 'positioning' — install the
  // founding fixture profile so that kind (and the 'campaign' review kind
  // below) validate instead of being rejected as foreign to `notes`.
  await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  // banned phrase to guarantee a heuristic red finding
  await call(app, `/workspaces/${ws.id}/graph`, {
    token,
    body: {
      id: 'pos-banned-synergy',
      type: 'positioning',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      status: 'active',
      body: 'synergy',
      kind: 'banned_phrase',
    },
  });
  const r = await call(app, `/workspaces/${ws.id}/reviews`, {
    token,
    body: { deliverable: 'Unlock synergy across teams.', kind: 'campaign' },
  });
  return { ws, reviewId: r.json.id, findings: r.json.findings };
}

describe('mark feedback as wrong', () => {
  it('marks a finding wrong, idempotent on second call', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'ic@x.example');
    const { ws, reviewId, findings } = await seedReview(app, token);
    expect(findings.length).toBeGreaterThan(0);

    const r1 = await call(app, `/workspaces/${ws.id}/reviews/${reviewId}/findings/0/wrong`, {
      token,
      body: { reason: 'not actually banned in our context' },
    });
    expect(r1.status).toBe(200);
    expect(r1.json.newly_recorded).toBe(true);

    const r2 = await call(app, `/workspaces/${ws.id}/reviews/${reviewId}/findings/0/wrong`, {
      token,
      body: { reason: 'updated reason' },
    });
    expect(r2.status).toBe(200);
    expect(r2.json.newly_recorded).toBe(false);
  });

  it('rejects out-of-range finding_index', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'ic2@x.example');
    const { ws, reviewId, findings } = await seedReview(app, token);
    const r = await call(
      app,
      `/workspaces/${ws.id}/reviews/${reviewId}/findings/${findings.length + 5}/wrong`,
      { token, body: {} },
    );
    expect(r.status).toBe(400);
  });

  it('cross-workspace forgery is rejected (review id from B cannot be marked under A)', async () => {
    const { app } = await loadApp();
    const tokenA = await magic(app, 'a@x.example');
    const tokenB = await magic(app, 'b@x.example');
    const wsA = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'A' }, token: tokenA })).json;
    const seededB = await seedReview(app, tokenB);
    // Token A trying to mark a finding on B's review under its OWN workspace
    // path (review id won't resolve in workspace A).
    const r = await call(
      app,
      `/workspaces/${wsA.id}/reviews/${seededB.reviewId}/findings/0/wrong`,
      { token: tokenA, body: {} },
    );
    expect(r.status).toBe(404);
  });

  it('rejections do not write a customer-audit event (PRD: captured silently)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'ic3@x.example');
    const { ws, reviewId } = await seedReview(app, token);
    await call(app, `/workspaces/${ws.id}/reviews/${reviewId}/findings/0/wrong`, {
      token,
      body: {},
    });
    const audit = await call(app, `/workspaces/${ws.id}/customer-audit`, {
      method: 'GET',
      token,
    });
    const events = audit.json.entries.map((e: any) => e.event);
    expect(events).not.toContain('finding_marked_wrong');
    expect(events).not.toContain('finding_rejected');
  });
});
