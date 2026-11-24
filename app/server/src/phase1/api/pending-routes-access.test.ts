/**
 * Who may see and resolve a held routing decision (pending_routes).
 *
 * A held document has not been captured yet, so the audience its ingest asked
 * for must gate the hold itself: someone else's private hold is invisible to
 * other members (404 everywhere), and a team hold is visible to everyone but
 * resolvable only by its ingester or a workspace owner/admin (403
 * not_your_route otherwise). Covered over REST and the MCP tool transport.
 *
 * The router is mocked (same pattern as routing-approval.test.ts) so every
 * ingest holds with a new-folder proposal; no real model call runs.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

// Every routing call in this file holds: no existing folder fits, and the
// router proposes a new one.
vi.mock('../../lib/anthropic.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/anthropic.js')>('../../lib/anthropic.js');
  return {
    ...real,
    routeDocument: async () => ({
      target_subgraph_ids: [],
      reason: 'Nothing existing fits.',
      summary: 'A held document.',
      stakeholders: [],
    }),
    proposeNewFolder: async () => ({
      propose_new_folder: { name: 'Held', description: 'Documents that were held.' },
      reason: 'mocked',
    }),
  };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-pending-access-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?pending-access=' + Date.now());
}

async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await call(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await call(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

const SOURCE = 'Weekly lunch order: turkey sandwiches for the team, delivered at noon on Thursday.';

async function setup() {
  const { app, repo } = (await loadApp()) as any;
  const tag = Math.random().toString(36).slice(2, 8);
  const ownerEmail = `owner-${tag}@access.test`;
  const aEmail = `alice-${tag}@access.test`;
  const bEmail = `bob-${tag}@access.test`;
  const dEmail = `dana-${tag}@access.test`;
  const ownerSess = await magic(app, ownerEmail);
  const ws = (await call(app, '/workspaces', { method: 'POST', token: ownerSess, body: { name: 'Access', profile_id: 'notes' } })).json.id as string;
  const a = (await repo.findOrCreateUser(aEmail)).id as string;
  const b = (await repo.findOrCreateUser(bEmail)).id as string;
  const d = (await repo.findOrCreateUser(dEmail)).id as string;
  await repo.addMember({ workspace_id: ws, user_id: a, role: 'member' });
  await repo.addMember({ workspace_id: ws, user_id: b, role: 'member' });
  await repo.addMember({ workspace_id: ws, user_id: d, role: 'workspace_admin' });
  const aSess = await magic(app, aEmail);
  const bSess = await magic(app, bEmail);
  const dSess = await magic(app, dEmail);
  const bMcp = (await repo.issueMcpToken({ workspace_id: ws, user_id: b })).token as string;
  const aMcp = (await repo.issueMcpToken({ workspace_id: ws, user_id: a })).token as string;
  const dMcp = (await repo.issueMcpToken({ workspace_id: ws, user_id: d })).token as string;

  /** Alice ingests over REST; every ingest here holds. Returns the pending route id. */
  const hold = async (body: Record<string, unknown>, ref: string) => {
    const r = await call(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token: aSess,
      body: { source: SOURCE, source_kind: 'doc', source_ref: ref, ...body },
    });
    expect(r.status).toBe(200);
    expect(r.json.pending_approval).toBe(true);
    return r.json.pending_route_id as string;
  };
  const restList = async (token: string) =>
    (await call(app, `/workspaces/${ws}/pending-routes`, { token })).json.pending_routes as any[];
  const mcpList = async (token: string) =>
    (await call(app, '/mcp/tools/list_pending_routes', { method: 'POST', token, body: {} })).json.pending_routes as any[];
  const restResolve = (token: string, id: string, action: 'approve' | 'choose' | 'reject', body?: unknown) =>
    call(app, `/workspaces/${ws}/pending-routes/${id}/${action}`, { method: 'POST', token, body: body ?? {} });
  const mcpResolve = (token: string, tool: string, body: unknown) =>
    call(app, `/mcp/tools/${tool}`, { method: 'POST', token, body });

  return { app, repo, ws, a, b, aEmail, ownerSess, aSess, bSess, dSess, aMcp, bMcp, dMcp, hold, restList, mcpList, restResolve, mcpResolve };
}

describe('pending routes: visibility and who may resolve', () => {
  it("a member cannot see or resolve another member's private hold (REST + MCP: hidden, 404)", async () => {
    const t = await setup();
    const priv = await t.hold({ audience: 'private' }, 'private.md');
    // The web app's fallback ('only_me' when no audience is named) hides too.
    const fallback = await t.hold({ default_audience: 'only_me' }, 'fallback.md');
    const folderId = (await t.repo.listSubgraphs(t.ws))[0].id as string;

    expect((await t.restList(t.bSess)).map((r) => r.id)).not.toContain(priv);
    expect((await t.restList(t.bSess)).map((r) => r.id)).not.toContain(fallback);
    expect((await t.mcpList(t.bMcp)).map((r) => r.id)).not.toContain(priv);
    expect((await t.mcpList(t.bMcp)).map((r) => r.id)).not.toContain(fallback);

    for (const action of ['approve', 'reject'] as const) {
      const r = await t.restResolve(t.bSess, priv, action);
      expect(r.status).toBe(404);
      expect(r.json.error).toBe('not_found');
    }
    const ch = await t.restResolve(t.bSess, priv, 'choose', { target_ids: [folderId] });
    expect(ch.status).toBe(404);
    expect((await t.mcpResolve(t.bMcp, 'approve_route', { id: priv })).status).toBe(404);
    expect((await t.mcpResolve(t.bMcp, 'choose_route', { id: priv, target_ids: [folderId] })).status).toBe(404);
    const mr = await t.mcpResolve(t.bMcp, 'reject_route', { id: fallback });
    expect(mr.status).toBe(404);
    expect(mr.json.error).toBe('not_found');

    // Still pending — nothing B did took effect.
    expect((await t.repo.getPendingRoute(t.ws, priv)).status).toBe('pending');
    expect((await t.repo.getPendingRoute(t.ws, fallback)).status).toBe('pending');

    // The ingester and the owner see it, and may resolve it.
    const aRow = (await t.restList(t.aSess)).find((r) => r.id === priv);
    expect(aRow?.can_resolve).toBe(true);
    expect((await t.mcpList(t.aMcp)).find((r) => r.id === priv)?.can_resolve).toBe(true);
    const ownerRow = (await t.restList(t.ownerSess)).find((r) => r.id === priv);
    expect(ownerRow?.can_resolve).toBe(true);
    expect(ownerRow?.ingested_by_email).toBe(t.aEmail);

    // Ingester resolves one; the owner approves the other (full capture path).
    expect((await t.restResolve(t.aSess, fallback, 'reject')).status).toBe(200);
    const approved = await t.restResolve(t.ownerSess, priv, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.json.ok).toBe(true);
  });

  it('a team hold is visible to every member, but only the ingester or an admin may resolve it (403 not_your_route)', async () => {
    const t = await setup();
    const team = await t.hold({ audience: 'team' }, 'team.md');
    const team2 = await t.hold({}, 'team-default.md'); // no audience named = team
    const folderId = (await t.repo.listSubgraphs(t.ws))[0].id as string;

    const bRest = (await t.restList(t.bSess)).find((r) => r.id === team);
    expect(bRest).toBeTruthy();
    expect(bRest.can_resolve).toBe(false);
    expect(bRest.ingested_by_email).toBe(t.aEmail);
    const bMcpRow = (await t.mcpList(t.bMcp)).find((r) => r.id === team2);
    expect(bMcpRow).toBeTruthy();
    expect(bMcpRow.can_resolve).toBe(false);

    for (const action of ['approve', 'reject'] as const) {
      const r = await t.restResolve(t.bSess, team, action);
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('not_your_route');
    }
    const ch = await t.restResolve(t.bSess, team, 'choose', { target_ids: [folderId] });
    expect(ch.status).toBe(403);
    expect(ch.json.error).toBe('not_your_route');
    for (const [tool, body] of [
      ['approve_route', { id: team2 }],
      ['choose_route', { id: team2, target_ids: [folderId] }],
      ['reject_route', { id: team2 }],
    ] as const) {
      const r = await t.mcpResolve(t.bMcp, tool, body);
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('not_your_route');
    }
    expect((await t.repo.getPendingRoute(t.ws, team)).status).toBe('pending');
    expect((await t.repo.getPendingRoute(t.ws, team2)).status).toBe('pending');

    // can_resolve is true for the ingester and for a workspace_admin.
    expect((await t.restList(t.aSess)).find((r) => r.id === team)?.can_resolve).toBe(true);
    expect((await t.restList(t.dSess)).find((r) => r.id === team)?.can_resolve).toBe(true);
    expect((await t.mcpList(t.dMcp)).find((r) => r.id === team2)?.can_resolve).toBe(true);

    // Ingester rejects one over MCP; a (non-owner) workspace_admin rejects the other over REST.
    expect((await t.mcpResolve(t.aMcp, 'reject_route', { id: team })).status).toBe(200);
    expect((await t.restResolve(t.dSess, team2, 'reject')).status).toBe(200);
  });

  it('legacy holds with no recorded ingester stay visible to everyone but are admin-only to resolve', async () => {
    const t = await setup();
    const { id } = await t.repo.createPendingRoute(t.ws, {
      document_id: 'doc_legacy',
      reason: 'pre-column row',
      proposed_targets: [],
      proposed_new_folder: null,
      low_confidence_targets: [],
    });
    const bRow = (await t.restList(t.bSess)).find((r) => r.id === id);
    expect(bRow?.can_resolve).toBe(false);
    expect(bRow?.ingested_by_email).toBeNull();
    expect((await t.restResolve(t.bSess, id, 'reject')).status).toBe(403);
    expect((await t.restList(t.ownerSess)).find((r) => r.id === id)?.can_resolve).toBe(true);
    expect((await t.restResolve(t.ownerSess, id, 'reject')).status).toBe(200);
  });
});
