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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?mcp-test=' + Date.now());
}

async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: j1.dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  const j2 = await r2.json();
  return j2.session as string;
}

async function jsonCall(app: any, path: string, opts: { method?: string; body?: unknown; token?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(path, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

describe('MCP HTTP', () => {
  it('requires a token', async () => {
    const { app } = await loadApp();
    const r = await jsonCall(app, '/mcp/tools', { method: 'GET' });
    expect(r.status).toBe(401);
  });

  it('full end-to-end: issue token, list tools, query, review, recent changes', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'mcp-user@x.com');
    const ws = (
      await jsonCall(app, '/workspaces', { body: { profile_id: 'notes', name: 'MCP Test' }, token: session })
    ).json;
    // The seeded decision/positioning nodes + 'decisions' scope below aren't
    // valid under `notes` — install the founding fixture profile.
    await jsonCall(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', body: { profile: foundingProfile }, token: session });
    // Seed graph
    const seed = [
      {
        id: 'pos-banned-synergy',
        type: 'positioning',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
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
      await jsonCall(app, `/workspaces/${ws.id}/graph`, { body: n, token: session });
    }
    // Issue MCP token
    const tokenRes = await jsonCall(app, `/workspaces/${ws.id}/mcp-tokens`, {
      body: {},
      token: session,
    });
    const mcpToken = tokenRes.json.token;
    expect(mcpToken).toMatch(/^pmg_/);

    // List tools
    const tools = await jsonCall(app, '/mcp/tools', { method: 'GET', token: mcpToken });
    expect(tools.status).toBe(200);
    expect(tools.json.tools.map((t: any) => t.name)).toEqual([
      'query_context',
      'review_deliverable',
      'list_recent_changes',
      'update_node',
      'update_attribute',
      'get_context',
      'search_context',
      'ingest_document',
      'list_sources',
      'list_pending_routes',
      'approve_route',
      'choose_route',
      'reject_route',
      'create_subfolder',
      'list_rules',
      'upsert_rule',
      'delete_rule',
      'test_rule',
      'list_templates',
      'list_folders',
      'list_team',
      'explore_team_folders',
      'request_folder_access',
      'set_default_folder',
    ]);

    // Query
    const q = await jsonCall(app, '/mcp/tools/query_context', {
      body: { question: 'What is our stance on the v1 mobile app?', scope: 'decisions' },
      token: mcpToken,
    });
    expect(q.status).toBe(200);
    expect(q.json.cited_node_ids).toContain('dec-mobile-2026-04-15');

    // Review
    const r = await jsonCall(app, '/mcp/tools/review_deliverable', {
      body: { content: 'Sign up for our v1 mobile app and unlock synergy.', kind: 'sales_email' },
      token: mcpToken,
    });
    expect(r.status).toBe(200);
    const reds = r.json.findings.filter((f: any) => f.flag === 'red');
    expect(reds.length).toBeGreaterThan(0);
    for (const red of reds) expect(red.node_id).toBeTruthy();

    // Recent changes
    const recent = await jsonCall(app, '/mcp/tools/list_recent_changes', {
      body: { since: '2026-01-01T00:00:00Z' },
      token: mcpToken,
    });
    expect(recent.status).toBe(200);
    expect(recent.json.nodes.length).toBeGreaterThanOrEqual(2);

    // Audit log should contain mcp.* events
    const audit = await jsonCall(app, `/workspaces/${ws.id}/audit`, {
      method: 'GET',
      token: session,
    });
    const events = audit.json.entries.map((e: any) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        'mcp_token.issued',
        'mcp.query_context',
        'mcp.review_deliverable',
        'mcp.list_recent_changes',
      ]),
    );
  });

  it('MCP token from workspace A cannot read from workspace B', async () => {
    const { app } = await loadApp();
    const sessA = await magic(app, 'tenant-a@x.com');
    const sessB = await magic(app, 'tenant-b@x.com');
    const wsA = (
      await jsonCall(app, '/workspaces', { body: { profile_id: 'notes', name: 'A' }, token: sessA })
    ).json;
    const wsB = (
      await jsonCall(app, '/workspaces', { body: { profile_id: 'notes', name: 'B' }, token: sessB })
    ).json;
    await jsonCall(app, `/workspaces/${wsB.id}/profile`, { method: 'PUT', body: { profile: foundingProfile }, token: sessB });
    // Seed only in B
    await jsonCall(app, `/workspaces/${wsB.id}/graph`, {
      body: {
        id: 'secret-of-b',
        type: 'decision',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        summary: 'Tenant B confidential decision',
        body: 'Only B should ever see this.',
        decided_on: '2026-01-01',
        category: 'strategy',
      },
      token: sessB,
    });
    // A's MCP token
    const aTok = (
      await jsonCall(app, `/workspaces/${wsA.id}/mcp-tokens`, { body: {}, token: sessA })
    ).json.token;
    const r = await jsonCall(app, '/mcp/tools/list_recent_changes', {
      body: { since: '2026-01-01T00:00:00Z' },
      token: aTok,
    });
    // Recent changes returns only A's (empty) nodes, never B's.
    expect(r.status).toBe(200);
    const ids = r.json.nodes.map((n: any) => n.id);
    expect(ids).not.toContain('secret-of-b');
  });
});
