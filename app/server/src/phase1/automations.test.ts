/**
 * Unified automations — HTTP surface (Stage 2: shape-kind CRUD, lazy
 * migration from the legacy `rules` table, and the "one-time run" preview
 * that replaces Test). Mirrors rules.test.ts's setup — same deterministic
 * synthesis stub, same "killing" → one decision candidate heuristic.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { foundingProfile } from '../lib/profiles/__fixtures__/founding.js';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-automations-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?automations=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string; ws?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.ws) headers['x-workspace-id'] = opts.ws;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
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
  return { status: r.status, json };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await jsonCall(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await jsonCall(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

async function setup() {
  const { app } = await loadApp();
  const token = await magic(app, 'automations@pome.test');
  const created = await jsonCall(app, '/workspaces', {
    method: 'POST',
    token,
    body: { name: 'AutomationsWs', profile_id: 'notes' },
  });
  const ws = created.json.id as string;
  await jsonCall(app, `/workspaces/${ws}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  return { app, token, ws };
}

describe('automations HTTP surface (kind=shape)', () => {
  it('GET seeds the three defaults once, and reports can_edit for the owner', async () => {
    const { app, token, ws } = await setup();
    const r = await jsonCall(app, `/workspaces/${ws}/automations`, { token, ws });
    expect(r.status).toBe(200);
    expect(r.json.automations).toHaveLength(3);
    expect(r.json.can_edit).toBe(true);
    expect(r.json.automations.every((a: any) => a.kind === 'shape')).toBe(true);

    // Idempotent: a second GET does not re-seed.
    const r2 = await jsonCall(app, `/workspaces/${ws}/automations`, { token, ws });
    expect(r2.json.automations).toHaveLength(3);
  });

  it('creates, patches (enable toggle), and deletes an automation', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Hide PII from customer transcripts', scopes: ['team'] },
    });
    expect(create.status).toBe(200);
    const id = create.json.automation.id as string;
    expect(id).toMatch(/^au_/);
    expect(create.json.automation.kind).toBe('shape');

    const patch = await jsonCall(app, `/workspaces/${ws}/automations/${id}`, {
      method: 'PATCH',
      token,
      ws,
      body: { enabled: false },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.automation.enabled).toBe(false);
    // Instructions unchanged, so no re-classification — action carries over.
    expect(patch.json.automation.instructions).toBe('Hide PII from customer transcripts');

    const del = await jsonCall(app, `/workspaces/${ws}/automations/${id}`, { method: 'DELETE', token, ws });
    expect(del.status).toBe(200);
    const after = await jsonCall(app, `/workspaces/${ws}/automations?kind=shape`, { token, ws });
    expect((after.json.automations as any[]).find((a) => a.id === id)).toBeUndefined();
  });

  it('an ingestion automation preview dry-runs with and without it, and persists nothing', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Prefer decisions over speculative notes' },
    });
    const id = create.json.automation.id as string;

    const preview = await jsonCall(app, `/workspaces/${ws}/automations/${id}/preview`, {
      method: 'POST',
      token,
      ws,
      body: { text: 'We are killing the legacy settings page next quarter.' },
    });
    expect(preview.status).toBe(200);
    expect(preview.json.mode).toBe('ingestion');
    expect(Array.isArray(preview.json.with_rule)).toBe(true);
    expect(Array.isArray(preview.json.without_rule)).toBe(true);

    // Nothing persisted: no candidates exist for this workspace.
    const candidates = await jsonCall(app, `/workspaces/${ws}/candidates`, { token, ws });
    expect(candidates.json.candidates ?? []).toEqual([]);
  });

  it('lazily migrates a legacy rule created via the old /rules route, preserving its id', async () => {
    const { app, token, ws } = await setup();
    const legacy = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Do not share timelines for product releases', scopes: ['team'] },
    });
    expect(legacy.status).toBe(200);
    const legacyId = legacy.json.rule.id as string;

    const r = await jsonCall(app, `/workspaces/${ws}/automations?kind=shape`, { token, ws });
    const migrated = (r.json.automations as any[]).find((a) => a.id === legacyId);
    expect(migrated).toBeDefined();
    expect(migrated.instructions).toBe('Do not share timelines for product releases');

    // The legacy rules table is untouched — still readable via the old route.
    const stillLegacy = await jsonCall(app, `/workspaces/${ws}/rules`, { token, ws });
    expect((stillLegacy.json.rules as any[]).some((r2) => r2.id === legacyId)).toBe(true);
  });

  it('GET /automations/:id/runs returns an empty run history for a shape automation', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Hide PII' },
    });
    const id = create.json.automation.id as string;
    const runs = await jsonCall(app, `/workspaces/${ws}/automations/${id}/runs`, { token, ws });
    expect(runs.status).toBe(200);
    expect(runs.json.runs).toEqual([]);
  });
});

describe('automations HTTP surface (kind=apps_pull, manual-run only — Stage 3)', () => {
  it('rejects an unknown connector', async () => {
    const { app, token, ws } = await setup();
    const r = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { kind: 'apps_pull', connector: 'not_a_real_app', criteria: { query: 'anything' } },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('unknown_connector');
  });

  it('creates an apps_pull automation storing connector + criteria verbatim', async () => {
    const { app, token, ws } = await setup();
    const r = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: {
        kind: 'apps_pull',
        connector: 'gmail',
        criteria: { query: 'weekly digest emails' },
        cadence_ms: 24 * 60 * 60 * 1000,
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.automation.kind).toBe('apps_pull');
    expect(r.json.automation.connector).toBe('gmail');
    expect(r.json.automation.criteria).toEqual({ query: 'weekly digest emails' });
    expect(r.json.automation.cadence_ms).toBe(24 * 60 * 60 * 1000);

    const listed = await jsonCall(app, `/workspaces/${ws}/automations?kind=apps_pull`, { token, ws });
    expect(listed.json.automations).toHaveLength(1);
  });

  it('preview passes through app_not_connected when the user has not connected the app', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { kind: 'apps_pull', connector: 'gmail', criteria: { query: 'anything' } },
    });
    const id = create.json.automation.id as string;

    const preview = await jsonCall(app, `/workspaces/${ws}/automations/${id}/preview`, { method: 'POST', token, ws });
    expect(preview.status).toBe(409);
    expect(preview.json.error).toBe('app_not_connected');
  });

  it('run-now records an error run when the app is not connected', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { kind: 'apps_pull', connector: 'gmail', criteria: { query: 'anything' } },
    });
    const id = create.json.automation.id as string;

    const run = await jsonCall(app, `/workspaces/${ws}/automations/${id}/run-now`, { method: 'POST', token, ws });
    expect(run.status).toBe(409);
    expect(run.json.error).toBe('app_not_connected');
    expect(run.json.run.outcome).toBe('error');

    const runs = await jsonCall(app, `/workspaces/${ws}/automations/${id}/runs`, { token, ws });
    expect(runs.json.runs).toHaveLength(1);
    expect(runs.json.runs[0].trigger).toBe('manual_run');
    expect(runs.json.runs[0].outcome).toBe('error');
  });

  it('run-now is rejected for a shape automation (unsupported kind)', async () => {
    const { app, token, ws } = await setup();
    const create = await jsonCall(app, `/workspaces/${ws}/automations`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Hide PII' },
    });
    const id = create.json.automation.id as string;
    const run = await jsonCall(app, `/workspaces/${ws}/automations/${id}/run-now`, { method: 'POST', token, ws });
    expect(run.status).toBe(400);
    expect(run.json.error).toBe('unsupported_kind');
  });
});
