/**
 * End-to-end ship-readiness scenario.
 *
 * Stands up the full Phase 1 stack in-process and walks through the leader+IC
 * loop: workspace creation, ingestion, candidate approval, deliverable
 * submission via web AND via MCP, and verifies that web and MCP produce
 * findings of equivalent shape against the same graph.
 *
 * This is the integration test that gates "shippable to a design partner."
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../lib/profiles/__fixtures__/founding.js';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-e2e-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?e2e=' + Date.now());
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
  const r2 = await jsonCall(app, '/auth/exchange', {
    method: 'POST',
    body: { code: r1.json.dev_code },
  });
  return r2.json.session as string;
}

describe('ship-readiness scenario', () => {
  it('full leader + IC loop succeeds via both web and MCP, with equivalent findings', async () => {
    const { app } = await loadApp();

    // 1. Leader signs in and creates a workspace
    const leaderTok = await magic(app, 'cro@acme.io');
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'Acme' }, token: leaderTok })).json;
    expect(ws.id).toMatch(/^ws_/);
    // The stub's capture heuristics extract decision/goal/positioning-kind
    // candidates — install the founding fixture profile so they validate.
    await jsonCall(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token: leaderTok, body: { profile: foundingProfile } });

    // 2. Onboarding: leader ingests a strategy paste; candidates appear
    const ingestRes = await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: leaderTok,
      body: {
        source_kind: 'doc',
        source: 'We are killing the v1 mobile app effective today. Mid-market wedge stays.',
        source_ref: 'onboarding-paste',
      },
    });
    expect(ingestRes.status).toBe(200);
    expect(ingestRes.json.candidates).toBeGreaterThan(0);

    // The audit trail names the source and lists the notes it created.
    const ingestAudit = await jsonCall(app, `/workspaces/${ws.id}/customer-audit?limit=100`, { token: leaderTok });
    const ingested = ingestAudit.json.entries.find((e: any) => e.event === 'source_ingested');
    const ing = JSON.parse(ingested.payload);
    expect(ing.source_name).toBe('onboarding-paste');
    expect(ing.nodes_created).toBe(ingestRes.json.candidates);
    expect(ing.node_ids).toHaveLength(ing.nodes_created);
    const graphIds = new Set(
      (await jsonCall(app, `/workspaces/${ws.id}/graph`, { token: leaderTok })).json.nodes.map((n: any) => n.id),
    );
    for (const id of ing.node_ids) expect(graphIds.has(id)).toBe(true);

    // 3. Approve candidates → graph populated
    const inbox = await jsonCall(app, `/workspaces/${ws.id}/candidates`, { token: leaderTok });
    for (const c of inbox.json.candidates) {
      await jsonCall(app, `/workspaces/${ws.id}/candidates/${c.id}/approve`, {
        method: 'POST',
        token: leaderTok,
      });
    }
    // Also seed a banned phrase by hand so the IC's draft hits a clear <red>
    await jsonCall(app, `/workspaces/${ws.id}/graph`, {
      method: 'POST',
      token: leaderTok,
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
    await jsonCall(app, `/workspaces/${ws.id}/graph`, {
      method: 'POST',
      token: leaderTok,
      body: {
        id: 'dec-mobile-test',
        type: 'decision',
        created_at: '2026-04-15T00:00:00Z',
        updated_at: '2026-04-15T00:00:00Z',
        status: 'active',
        summary: 'Kill the v1 mobile app',
        body: 'Effective immediately.',
        decided_on: '2026-04-15',
        category: 'scope',
      },
    });

    const graph = await jsonCall(app, `/workspaces/${ws.id}/graph`, { token: leaderTok });
    expect(graph.json.nodes.length).toBeGreaterThanOrEqual(2);

    // 4. IC signs in as a member of the workspace (auto-add as leader for simplicity)
    const icTok = await magic(app, 'ic@acme.io');
    // Add IC to the workspace via repo direct (since we don't have an invite endpoint)
    const mod = await loadApp();
    const repo = mod.repo;
    const icUser = repo.db.prepare(`SELECT id FROM users WHERE email = ?`).get('ic@acme.io') as { id: string };
    const wsRow = repo.db.prepare(`SELECT id FROM workspaces WHERE id = ?`).get(ws.id) as { id: string };
    await repo.addMember({ workspace_id: wsRow.id, user_id: icUser.id, role: 'member' });

    // 5. IC submits a deliverable via the WEB feedback endpoint
    const draft =
      'Sign up for our v1 mobile app and unlock synergy across teams. Limited time offer.';
    const webRes = await jsonCall(app, `/workspaces/${ws.id}/reviews`, {
      method: 'POST',
      token: icTok,
      body: { deliverable: draft, kind: 'sales_email' },
    });
    expect(webRes.status).toBe(200);
    expect(webRes.json.findings.length).toBeGreaterThan(0);
    const webReds = webRes.json.findings.filter((f: any) => f.flag === 'red');
    expect(webReds.length).toBeGreaterThan(0);
    for (const red of webReds) {
      expect(red.node_id).toBeTruthy();
    }

    // 6. IC submits the SAME deliverable via MCP — should produce equivalent findings
    const mcpTokRes = await jsonCall(app, `/workspaces/${ws.id}/mcp-tokens`, {
      method: 'POST',
      token: leaderTok,
      body: {},
    });
    const mcpToken = mcpTokRes.json.token;
    const mcpRes = await jsonCall(app, '/mcp/tools/review_deliverable', {
      method: 'POST',
      token: mcpToken,
      body: { content: draft, kind: 'sales_email' },
    });
    expect(mcpRes.status).toBe(200);
    const mcpReds = mcpRes.json.findings.filter((f: any) => f.flag === 'red');
    expect(mcpReds.length).toBeGreaterThan(0);

    // 7. Equivalence check: same set of red node_ids
    const webRedIds = new Set(webReds.map((f: any) => f.node_id));
    const mcpRedIds = new Set(mcpReds.map((f: any) => f.node_id));
    expect([...webRedIds].sort()).toEqual([...mcpRedIds].sort());

    // 8. MCP query_context returns graph-grounded answer
    const qRes = await jsonCall(app, '/mcp/tools/query_context', {
      method: 'POST',
      token: mcpToken,
      body: { question: 'What is our stance on the v1 mobile app?', scope: 'decisions' },
    });
    expect(qRes.status).toBe(200);
    expect(qRes.json.cited_node_ids).toContain('dec-mobile-test');

    // 9. Audit log records the full chain
    const audit = await jsonCall(app, `/workspaces/${ws.id}/audit`, { token: leaderTok });
    const events = audit.json.entries.map((e: any) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        'workspace.created',
        'graph.node.created',
        'candidate.approved',
        'review.submitted',
        'mcp_token.issued',
        'mcp.review_deliverable',
        'mcp.query_context',
      ]),
    );
  });
});
