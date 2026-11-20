import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Deterministic synth stub — same capture pipeline the web ingest tests use.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-cat-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?cat=' + Date.now());
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
  return (await r2.json()).session as string;
}

async function call(
  app: any,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

let seq = 0;
async function setup() {
  const mod = await loadApp();
  const { app, repo } = mod;
  const domain = `cat${++seq}.example`;
  const admin = await magic(app, `admin@${domain}`);
  const member = await magic(app, `member@${domain}`);
  const wsId = (
    await call(app, 'POST', '/workspaces', { token: admin, body: { profile_id: 'notes', name: 'CatalogWs' } })
  ).json.id;
  await call(app, 'POST', `/workspaces/${wsId}/members`, {
    token: admin,
    body: { email: `member@${domain}`, role: 'member' },
  });
  const adminMcp = (
    await call(app, 'POST', `/workspaces/${wsId}/mcp-tokens`, { token: admin, body: {} })
  ).json.token as string;
  // Members can't mint tokens (admin-only route) — admin mints, but the token
  // binds the ADMIN. For a member-bound token, use the self-serve connection
  // link… which is a connector, not a bearer. Simplest: mint via repo.
  const memberId = (await repo.findUserByEmail(`member@${domain}`))!.id;
  const memberMcp = (await repo.issueMcpToken({ workspace_id: wsId, user_id: memberId })).token as string;
  return { app, repo, admin, member, wsId, adminMcp, memberMcp, domain };
}

// The bulk item-curation MCP tools this file used to pin (accept_items,
// reject_items, revert_items, get_source) and their web counterpart
// (/curation/items/bulk-accept) were removed with the routing-approval
// pivot (see routes.ts / mcp/registry.ts: list_pending_routes, approve_route,
// choose_route, reject_route) — nothing left to test parity against.

describe('rules tools', () => {
  it('list_rules works for any member; writes are owner/admin-gated', async () => {
    const { app, adminMcp, memberMcp } = await setup();

    const memberList = await call(app, 'POST', '/mcp/tools/list_rules', { token: memberMcp, body: {} });
    expect(memberList.status).toBe(200);
    expect(memberList.json.can_edit).toBe(false);
    expect(memberList.json.rules.length).toBeGreaterThan(0); // seeded defaults

    const denied = await call(app, 'POST', '/mcp/tools/upsert_rule', {
      token: memberMcp,
      body: { instructions: 'Never store salary figures.' },
    });
    expect(denied.status).toBe(403);

    const created = await call(app, 'POST', '/mcp/tools/upsert_rule', {
      token: adminMcp,
      body: { instructions: 'Never store salary figures.', scopes: ['team'] },
    });
    expect(created.status).toBe(200);
    expect(created.json.rule.id).toBeTruthy();
    // Classifier stub absent → fail-open default classification.
    expect(created.json.rule.phases).toContain('store');

    // Update flips enabled without losing the instruction.
    const updated = await call(app, 'POST', '/mcp/tools/upsert_rule', {
      token: adminMcp,
      body: { id: created.json.rule.id, instructions: 'Never store salary figures.', enabled: false },
    });
    expect(updated.status).toBe(200);
    expect(updated.json.rule.enabled).toBe(false);

    const deletedDenied = await call(app, 'POST', '/mcp/tools/delete_rule', {
      token: memberMcp,
      body: { id: created.json.rule.id },
    });
    expect(deletedDenied.status).toBe(403);
    const deleted = await call(app, 'POST', '/mcp/tools/delete_rule', {
      token: adminMcp,
      body: { id: created.json.rule.id },
    });
    expect(deleted.status).toBe(200);
  });

  it('test_rule dry-runs an ingestion rule and persists nothing', async () => {
    const { app, repo, adminMcp, wsId } = await setup();
    // Instructions chosen so the stub classifier yields a shape/store rule
    // (no accept/reject/surface keywords) → 'ingestion' test mode.
    const created = await call(app, 'POST', '/mcp/tools/upsert_rule', {
      token: adminMcp,
      body: { instructions: 'Strip customer names from stored notes.' },
    });
    const before = (await repo.listCandidates(wsId)).length;
    const tested = await call(app, 'POST', '/mcp/tools/test_rule', {
      token: adminMcp,
      body: { id: created.json.rule.id, text: 'DECISION: ship the v2 beta in May.' },
    });
    expect(tested.status).toBe(200);
    expect(tested.json.mode).toBe('ingestion');
    expect(Array.isArray(tested.json.with_rule)).toBe(true);
    expect((await repo.listCandidates(wsId)).length).toBe(before); // dry-run persisted nothing
  });
});
