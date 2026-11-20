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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-overview-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?overview=' + Date.now());
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

describe('GET /workspaces/:ws/overview', () => {
  it('empty graph → summary null (no synthesis call)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@ovr.example');
    const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Empty' }, token })).json;
    const r = await call(app, `/workspaces/${ws.id}/overview`, { method: 'GET', token });
    expect(r.status).toBe(200);
    expect(r.json.summary).toBeNull();
  });

  it('active graph → stub summary grounded in node content, and cached by graph hash', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'leader2@ovr.example');
    const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Full' }, token })).json;
    // A north-star 'goal' node isn't a valid kind under `notes` — install the
    // founding fixture profile so it validates.
    await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
    const ts = '2026-01-01T00:00:00Z';
    await call(app, `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'goal-north-star',
        type: 'goal',
        created_at: ts,
        updated_at: ts,
        status: 'active',
        title: 'Reach $1M ARR by Q4',
        body: 'North-star revenue goal for the year.',
        priority: 'north_star',
      },
    });

    const r1 = await call(app, `/workspaces/${ws.id}/overview`, { method: 'GET', token });
    expect(r1.status).toBe(200);
    expect(r1.json.summary).toContain('Reach $1M ARR by Q4');

    // The generated description is persisted onto the (default) subfolder row.
    const sgRow = await repo.getSubgraph(ws.id, 'default');
    expect(sgRow?.generated_description).toBe(r1.json.summary);
    expect(sgRow?.generated_description_at).toBeTruthy();

    // Second hit serves from the synth cache (key includes the graph hash).
    const cachedRows = (repo as any).db
      .prepare(`SELECT cache_key FROM synth_cache WHERE workspace_id = ? AND cache_key LIKE '%:overview:%'`)
      .all(ws.id);
    expect(cachedRows.length).toBe(1);
    const r2 = await call(app, `/workspaces/${ws.id}/overview`, { method: 'GET', token });
    expect(r2.json.summary).toBe(r1.json.summary);
  });

  it('a hand-edited content summary locks against the automatic refresh; regenerate clears the lock', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'leader3@ovr.example');
    const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Locked' }, token })).json;
    await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
    const ts = '2026-01-01T00:00:00Z';
    await call(app, `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'goal-north-star',
        type: 'goal',
        created_at: ts,
        updated_at: ts,
        status: 'active',
        title: 'Reach $1M ARR by Q4',
        body: 'North-star revenue goal for the year.',
        priority: 'north_star',
      },
    });
    const auto = await call(app, `/workspaces/${ws.id}/overview`, { method: 'GET', token });
    expect(auto.json.summary).toContain('Reach $1M ARR by Q4');

    // Hand-edit it via PATCH — locks it.
    const patch = await call(app, `/workspaces/${ws.id}/subgraphs/default`, {
      method: 'PATCH',
      token,
      body: { generated_description: 'Manually curated: this folder tracks the $1M ARR push only.' },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.generated_description_locked).toBe(true);
    expect(patch.json.generated_description).toBe('Manually curated: this folder tracks the $1M ARR push only.');

    // A graph mutation would normally re-key the synth cache and produce a
    // fresh summary — but the lock means the next /overview call must leave
    // the manual text alone and NOT call synthesis again.
    await call(app, `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'goal-second',
        type: 'goal',
        created_at: ts,
        updated_at: ts,
        status: 'active',
        title: 'Ship the mobile app',
        body: 'Second goal added after the manual edit.',
        priority: 'high',
      },
    });
    const stillLocked = await call(app, `/workspaces/${ws.id}/overview`, { method: 'GET', token });
    expect(stillLocked.json.summary).toBe('Manually curated: this folder tracks the $1M ARR push only.');
    const rowStillLocked = await repo.getSubgraph(ws.id, 'default');
    expect(rowStillLocked?.generated_description_locked).toBe(true);

    // Regenerate: clears the lock and forces a fresh synthesis reflecting
    // BOTH goals now in the graph.
    const regen = await call(app, `/workspaces/${ws.id}/subgraphs/default/regenerate-summary`, { token });
    expect(regen.status).toBe(200);
    expect(regen.json.summary).toContain('Ship the mobile app');
    const rowUnlocked = await repo.getSubgraph(ws.id, 'default');
    expect(rowUnlocked?.generated_description_locked).toBe(false);
    expect(rowUnlocked?.generated_description).toBe(regen.json.summary);
  });
});
