import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';
import { marketingProfile } from '../../lib/profiles/__fixtures__/marketing.js';
import { productProfile } from '../../lib/profiles/__fixtures__/product.js';

// Deterministic synth stub — these tests exercise routing/validation, not the model.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-profile-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  const mod = await import('./server.js?profiletest=' + Date.now());
  return mod;
}

async function magic(app: any, email: string) {
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

async function api(
  app: any,
  method: string,
  pth: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const r = await app.request(pth, {
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
  return { status: r.status, json };
}

const TS = '2026-01-01T00:00:00Z';

describe('API: profiles', () => {
  it('GET /profiles returns the built-in catalog: just `notes` post-Light', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'cat@x.com');
    const r = await api(app, 'GET', '/profiles', { token });
    expect(r.status).toBe(200);
    expect(r.json.profiles.map((p: any) => p.id)).toEqual(['notes']);
  });

  it('POST /workspaces defaults to the `notes` template', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'def@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'D' } })).json;
    expect(ws.profile_id).toBe('notes');
    const got = (await api(app, 'GET', `/workspaces/${ws.id}/profile`, { token })).json;
    expect(got.profile_id).toBe('notes');
    expect(got.profile.kinds.map((k: any) => k.key)).toEqual(['note']);
    expect(got.profile.shape).toBe('log');
  });

  it('POST /workspaces rejects the retired founding profile_id (nothing legacy stays resolvable)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'legacy@x.com');
    const r = await api(app, 'POST', '/workspaces', { token, body: { name: 'L', profile_id: 'founding' } });
    expect(r.status).toBe(400);
  });

  it('POST /workspaces rejects an unknown profile_id', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'bad@x.com');
    const r = await api(app, 'POST', '/workspaces', { token, body: { name: 'X', profile_id: 'nope' } });
    expect(r.status).toBe(400);
  });

  it('PUT /workspaces/:ws/profile switches to a full custom profile (admin)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'admin@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'P' } })).json;
    const put = await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: productProfile } });
    expect(put.status).toBe(200);
    expect(put.json.profile_id).toBe('product');
    const got = (await api(app, 'GET', `/workspaces/${ws.id}/profile`, { token })).json;
    expect(got.profile.kinds.map((k: any) => k.key)).toContain('user_insight');
    // customer-audit recorded the change.
    const audit = (await api(app, 'GET', `/workspaces/${ws.id}/customer-audit`, { token })).json;
    const events = audit.entries.map((e: any) => e.event);
    expect(events).toContain('profile_assigned'); // at create
    expect(events).toContain('profile_updated'); // at PUT
  });

  it('PUT /workspaces/:ws/profile validates a full custom profile body (422 on bad shape)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'custom@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'C' } })).json;
    const bad = await api(app, 'PUT', `/workspaces/${ws.id}/profile`, {
      token,
      body: { profile: { id: 'custom-1', name: 'broken' } }, // missing kinds/dims/…
    });
    expect(bad.status).toBe(422);
  });

  it('PUT rejects a structurally valid custom profile that breaks semantic rules (422 with problems)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'semantic@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'S' } })).json;
    // Structurally valid, semantically broken: edge → unknown kind, scope →
    // unknown kind, enum attr without values.
    const profile = {
      id: 'custom-sem',
      name: 'Custom semantic',
      description: 'A custom profile used to exercise semantic write-time validation in tests, long enough to pass the description length convention.',
      kinds: [
        {
          key: 'thing',
          label: 'Thing',
          label_plural: 'Things',
          description: 'A generic thing captured for testing semantic validation of custom profiles.',
          color: 1,
          attrs: [{ key: 'state', label: 'State', type: 'enum' }], // no values → error
        },
      ],
      feedback_dimensions: [{ key: 'fit', label: 'Fit', description: 'fit' }],
      review_kinds: ['doc', 'other'],
      query_scopes: [
        { key: 'all', label: 'all', kind_keys: 'all' },
        { key: 'ghosts', label: 'ghosts', kind_keys: ['ghost'] }, // unknown kind → error
      ],
      flag_semantics: { red: 'r', yellow: 'y', green: 'g' },
      seed_questions: ['What things exist?'],
      edge_kinds: [
        {
          key: 'relates',
          label: 'Relates',
          description: 'Points FROM a thing TO a kind that does not exist.',
          src_kinds: ['thing'],
          dst_kinds: ['nonexistent'], // unknown kind → error
          directed: true,
        },
      ],
    };
    const r = await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile } });
    expect(r.status).toBe(422);
    expect(r.json.error).toContain('semantic');
    const problems = r.json.problems.join(' | ');
    expect(problems).toContain('nonexistent');
    expect(problems).toContain('ghost');
    expect(problems).toContain("enum attr 'state'");
  });

  it('PUT accepts a minimal custom profile that opts out of conventions, returning warnings', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'minimal@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'M' } })).json;
    const profile = {
      id: 'custom-min',
      name: 'Custom minimal',
      description: 'A deliberately minimal custom profile: no edges, no source types, no seed questions — exercising the warning (not error) path.',
      kinds: [
        {
          key: 'note',
          label: 'Note',
          label_plural: 'Notes',
          description: 'A durable note captured for testing the minimal-custom-profile path.',
          color: 2,
        },
      ],
      feedback_dimensions: [{ key: 'fit', label: 'Fit', description: 'fit' }],
      review_kinds: ['other'],
      query_scopes: [{ key: 'all', label: 'all', kind_keys: 'all' }],
      flag_semantics: { red: 'r', yellow: 'y', green: 'g' },
      seed_questions: [],
    };
    const r = await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile } });
    expect(r.status).toBe(200);
    expect(r.json.profile_id).toBe('custom-min');
    const warnings = r.json.warnings.join(' | ');
    expect(warnings).toContain('no edge_kinds');
    expect(warnings).toContain('no source_types');
    expect(warnings).toContain('seed_questions');
    // And the profile is actually stored.
    const got = (await api(app, 'GET', `/workspaces/${ws.id}/profile`, { token })).json;
    expect(got.profile_id).toBe('custom-min');
  });
});

describe('API: profile write-time validation (422)', () => {
  it('a node kind not in the workspace profile is rejected with 422', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'wv@x.com');
    // founding workspace
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'WV' } })).json;
    // 'voice' is a marketing kind, not founding.
    const r = await api(app, 'POST', `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'v1',
        type: 'voice',
        created_at: TS,
        updated_at: TS,
        status: 'active',
        body: 'x',
        subkind: 'banned_phrase',
      },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('profile_mismatch');
  });

  it('a valid founding node still writes (200)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'wv2@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'WV2' } })).json;
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: foundingProfile } });
    const r = await api(app, 'POST', `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'p1',
        type: 'positioning',
        created_at: TS,
        updated_at: TS,
        status: 'active',
        body: 'x',
        kind: 'stance',
      },
    });
    expect(r.status).toBe(200);
  });

  it('an out-of-profile review kind is rejected with 422', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'rv@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'RV' } })).json;
    // 'blog_article' is a marketing review kind, not founding.
    const r = await api(app, 'POST', `/workspaces/${ws.id}/reviews`, {
      token,
      body: { deliverable: 'draft text', kind: 'blog_article' },
    });
    expect(r.status).toBe(422);
  });

  it('an out-of-profile query scope is rejected with 422', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'qs@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { name: 'QS' } })).json;
    const r = await api(app, 'POST', `/workspaces/${ws.id}/query`, {
      token,
      body: { question: 'what?', scope: 'audience_fit' },
    });
    expect(r.status).toBe(422);
  });
});

describe('API: workspace_profiles isolation', () => {
  it('a workspace profile is not visible to a non-member', async () => {
    const { app } = await loadApp();
    const tokenA = await magic(app, 'iso-a@x.com');
    const tokenB = await magic(app, 'iso-b@x.com');
    const wsA = (await api(app, 'POST', '/workspaces', { token: tokenA, body: { name: 'A' } })).json;
    await api(app, 'PUT', `/workspaces/${wsA.id}/profile`, { token: tokenA, body: { profile: marketingProfile } });

    // B (not a member) cannot read A's profile.
    const forbidden = await api(app, 'GET', `/workspaces/${wsA.id}/profile`, { token: tokenB });
    expect(forbidden.status).toBe(403);

    // B cannot PUT A's profile either.
    const put = await api(app, 'PUT', `/workspaces/${wsA.id}/profile`, { token: tokenB, body: { profile: productProfile } });
    expect(put.status).toBe(403);

    // A's profile is unchanged.
    const got = (await api(app, 'GET', `/workspaces/${wsA.id}/profile`, { token: tokenA })).json;
    expect(got.profile_id).toBe('marketing');
  });

  it('a non-admin member cannot PUT the workspace profile (admin-gated)', async () => {
    const { app, repo } = await loadApp();
    const adminToken = await magic(app, 'pa-admin@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token: adminToken, body: { name: 'PA' } })).json;
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token: adminToken, body: { profile: foundingProfile } });
    const memberToken = await magic(app, 'pa-member@x.com');
    const memberRow = repo.db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get('pa-member@x.com') as { id: string };
    await repo.addMember({ workspace_id: ws.id, user_id: memberRow.id, role: 'member' });

    // Member is in the workspace (passes workspaceGate) but is not an admin.
    const put = await api(app, 'PUT', `/workspaces/${ws.id}/profile`, {
      token: memberToken,
      body: { profile: productProfile },
    });
    expect(put.status).toBe(403);
    // Profile unchanged (still founding).
    const got = (await api(app, 'GET', `/workspaces/${ws.id}/profile`, { token: adminToken })).json;
    expect(got.profile_id).toBe('founding');
  });
});
