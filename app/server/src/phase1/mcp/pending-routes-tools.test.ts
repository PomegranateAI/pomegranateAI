/**
 * The routing-approval MCP/Slack tools: `list_pending_routes`, `approve_route`,
 * `choose_route`, `reject_route` (registry.ts). These ride the SAME registry
 * catalog Slack's surface agent drives (createTools), so testing them over the
 * MCP REST transport (`/mcp/tools/<name>`) covers both surfaces at once —
 * see routing-approval.test.ts for the REST-endpoint-level coverage of the
 * same underlying `resolvePendingRoute` logic.
 *
 * `routeDocument`/`proposeNewFolder` are mocked exactly as in
 * routing-approval.test.ts (same reasons: no real LLM call, and the two calls
 * are separate — the second only runs when the first named no folder).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

type MockRoute = { target_subgraph_ids: string[]; reason: string; summary: string; stakeholders: string[] };
type MockProposal = { name: string; description: string } | null;
let nextRoute: MockRoute | null = null;
let nextProposal: MockProposal | undefined;

vi.mock('../../lib/anthropic.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/anthropic.js')>('../../lib/anthropic.js');
  return {
    ...real,
    routeDocument: async (opts: unknown) => {
      if (nextRoute) {
        const r = nextRoute;
        nextRoute = null;
        return r;
      }
      return (real.routeDocument as (o: unknown) => unknown)(opts);
    },
    proposeNewFolder: async (opts: unknown) => {
      if (nextProposal !== undefined) {
        const p = nextProposal;
        nextProposal = undefined;
        return { propose_new_folder: p, reason: 'mocked' };
      }
      return (real.proposeNewFolder as (o: unknown) => unknown)(opts);
    },
  };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-pending-routes-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?mcp-pending-routes=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string; ws?: string; subgraph?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.ws) headers['x-workspace-id'] = opts.ws;
  if (opts.subgraph) headers['x-subgraph-id'] = opts.subgraph;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await jsonCall(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await jsonCall(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

/** Workspace + an issued MCP token scoped to it. */
async function setupWorkspaceAndToken(app: any, email: string, body: Record<string, unknown>) {
  const session = await magic(app, email);
  const created = await jsonCall(app, '/workspaces', { method: 'POST', token: session, body });
  const ws = created.json.id as string;
  const tokenRes = await jsonCall(app, `/workspaces/${ws}/mcp-tokens`, { method: 'POST', token: session, body: {} });
  return { ws, mcpToken: tokenRes.json.token as string, session };
}

const BLAND_SOURCE = 'Weekly lunch order: turkey sandwiches for the team, delivered at noon on Thursday.';

describe('MCP routing-approval tools', () => {
  it('lists the new tool names alongside the existing catalog', async () => {
    const { app } = await loadApp();
    const { mcpToken } = await setupWorkspaceAndToken(app, 'mcp-pending-list@pome.test', {
      name: 'ToolList',
      profile_id: 'notes',
    });
    const tools = await jsonCall(app, '/mcp/tools', { method: 'GET', token: mcpToken });
    expect(tools.status).toBe(200);
    const names = tools.json.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_pending_routes', 'approve_route', 'choose_route', 'reject_route']),
    );
  });

  it('new-folder proposal: list_pending_routes surfaces it, approve_route creates the folder, a second approve is already_resolved', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-approve-route@pome.test', {
      name: 'ApproveRoute',
      profile_id: 'notes',
    });

    nextRoute = {
      target_subgraph_ids: [],
      reason: 'Nothing existing fits, and this deserves its own folder.',
      summary: 'A settled call about the lunch vendor.',
      stakeholders: [],
    };
    nextProposal = { name: 'Decisions', description: 'Calls the team has made.' };
    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'mcp-new-folder.md' },
    });
    expect(ingest.status).toBe(200);
    expect(ingest.json.pending_approval).toBe(true);
    const pendingRouteId = ingest.json.pending_route_id as string;

    // A hold must READ as a hold. Before this, the response was
    // `candidates: 0, routed: [], notice: null` + a bare flag, which a client
    // could not tell from a quiet no-op — so it reported the ingest as done
    // and never asked the user, leaving the document filed nowhere.
    expect(ingest.json.status).toBe('awaiting_user_decision');
    expect(ingest.json.action_required).toContain('ask_user');
    expect(ingest.json.notice).toContain('NOT INGESTED YET');
    expect(ingest.json.pending_route.pending_route_id).toBe(pendingRouteId);
    expect(ingest.json.pending_route.document_id).toBe(ingest.json.document_id);
    expect(ingest.json.pending_route.source_ref).toBe('mcp-new-folder.md');
    expect(ingest.json.pending_route.proposed_new_folder.name).toBe('Decisions');
    // The question names the proposal, and the three ways out carry the id.
    expect(ingest.json.pending_route.ask_user).toContain('Decisions');
    expect(Object.keys(ingest.json.pending_route.resolve_with)).toEqual([
      'approve_route',
      'choose_route',
      'reject_route',
    ]);
    expect(ingest.json.pending_route.resolve_with.approve_route).toContain(pendingRouteId);

    const list = await jsonCall(app, '/mcp/tools/list_pending_routes', { method: 'POST', token: mcpToken, body: {} });
    expect(list.status).toBe(200);
    expect(list.json.pending_routes.map((r: any) => r.id)).toEqual([pendingRouteId]);
    expect(list.json.pending_routes[0].proposed_new_folder.name).toBe('Decisions');
    expect(list.json.pending_routes[0].ask_user).toContain('Decisions');

    const approve = await jsonCall(app, '/mcp/tools/approve_route', {
      method: 'POST',
      token: mcpToken,
      body: { id: pendingRouteId },
    });
    expect(approve.status).toBe(200);
    expect(approve.json.ok).toBe(true);
    const newSubgraphId = approve.json.new_subgraph_id as string;
    expect(newSubgraphId).toBeTruthy();

    // Plain REST routes (not MCP tools) authenticate via SESSION token, not
    // the pmg_ MCP token — use the session this workspace was created with.
    const subgraphs = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { method: 'GET', token: session });
    expect(subgraphs.status).toBe(200);
    const createdFolder = (subgraphs.json.subgraphs as any[]).find((s) => s.id === newSubgraphId);
    expect(createdFolder?.name).toBe('Decisions');
    expect(createdFolder?.profile_id).toBe('notes');

    // Status-guard: a second approve on the same (now-approved) row is a conflict.
    const again = await jsonCall(app, '/mcp/tools/approve_route', {
      method: 'POST',
      token: mcpToken,
      body: { id: pendingRouteId },
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already_resolved');
  });

  it('low-confidence target: choose_route files into a caller-supplied folder by slug', async () => {
    const { app } = await loadApp();
    // There is only one template, so two subgraphs of it — distinguished by
    // slug/id, not profile_id (both are 'notes').
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-choose-route@pome.test', {
      name: 'ChooseRoute',
      profile_ids: ['notes', 'notes'],
    });
    const subgraphs = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { method: 'GET', token: session });
    const bySlug = Object.fromEntries((subgraphs.json.subgraphs as any[]).map((s) => [s.slug, s]));
    const decisionLogSlug = bySlug['notes-2'].slug as string;
    const decisionLogId = bySlug['notes-2'].id as string;
    const defaultId = bySlug['notes'].id as string;

    nextRoute = {
      target_subgraph_ids: [defaultId],
      reason: 'Closest match, but the folder has nothing in it yet.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'mcp-low-confidence.md' },
    });
    expect(ingest.json.pending_approval).toBe(true);
    const pendingRouteId = ingest.json.pending_route_id as string;

    // Low-confidence hold: the guessed folder is named, by NAME — a raw row
    // only carries subgraph ids, which no one can be asked about.
    expect(ingest.json.status).toBe('awaiting_user_decision');
    expect(ingest.json.pending_route.low_confidence_folders).toEqual([
      { id: defaultId, name: bySlug['notes'].name, slug: 'notes' },
    ]);
    expect(ingest.json.pending_route.ask_user).toContain(bySlug['notes'].name);
    expect(ingest.json.pending_route.proposed_new_folder).toBeNull();

    // choose_route resolves target_ids as slugs OR ids (resolveSubgraphArg) —
    // pass the slug to prove that resolution runs, not just raw ids.
    const choose = await jsonCall(app, '/mcp/tools/choose_route', {
      method: 'POST',
      token: mcpToken,
      body: { id: pendingRouteId, target_ids: [decisionLogSlug] },
    });
    expect(choose.status).toBe(200);
    expect(choose.json.targets).toEqual([decisionLogId]);

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${ingest.json.document_id}/routing`, {
      method: 'GET',
      token: session,
    });
    expect((routing.json.routing as any[]).map((r: any) => r.subgraph_id)).toEqual([decisionLogId]);
  });

  it('reject_route: not_found on an unknown id', async () => {
    const { app } = await loadApp();
    const { mcpToken } = await setupWorkspaceAndToken(app, 'mcp-reject-route@pome.test', {
      name: 'RejectRoute',
      profile_id: 'notes',
    });
    const r = await jsonCall(app, '/mcp/tools/reject_route', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'pr_does_not_exist' },
    });
    expect(r.status).toBe(404);
    expect(r.json.error).toBe('not_found');
  });

  it('approve_route actually captures content, and honors the ingest-time audience', async () => {
    // Regression for the fix itself: a HELD document must not just get a
    // clearer response — approving it has to finish the ingestion (nodes
    // land) and must not leak a 'private' ingest to the whole team just
    // because a different call (approve_route) is the one that runs capture.
    const { app, repo } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-approve-audience@pome.test', {
      name: 'ApproveAudience',
      profile_id: 'notes',
    });
    // The stub's capture heuristics only emit decision/goal candidates for
    // kinds the 'notes' profile doesn't declare — install a profile that does.
    await jsonCall(app, `/workspaces/${ws}/profile`, {
      method: 'PUT',
      token: session,
      ws,
      body: { profile: foundingProfile },
    });

    nextRoute = {
      target_subgraph_ids: ['default'],
      reason: 'Closest match, but the folder has nothing in it yet.',
      summary: 'Roadmap + north star.',
      stakeholders: [],
    };
    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: {
        source: 'We are killing the v1 mobile app. Our north star is mid-market ARR for the rest of the year.',
        source_kind: 'doc',
        source_ref: 'mcp-audience-hold.md',
        audience: 'private',
      },
    });
    expect(ingest.json.pending_approval).toBe(true);
    const pendingRouteId = ingest.json.pending_route_id as string;

    const before = (await repo.listNodes(ws, {}, 'default')).length;
    const approve = await jsonCall(app, '/mcp/tools/approve_route', {
      method: 'POST',
      token: mcpToken,
      body: { id: pendingRouteId },
    });
    expect(approve.status).toBe(200);
    expect(approve.json.candidates).toBeGreaterThan(0);

    // Content actually landed — a held route resolving is not just a status
    // change on the pending_routes row.
    const after = await repo.listNodes(ws, {}, 'default');
    expect(after.length).toBeGreaterThan(before);
    // And it landed with the ORIGINAL audience, not the resolver's default —
    // resolving a hold must not silently promote a private stage to team-wide.
    for (const n of after) {
      const vis = await repo.getNodeVisibility(ws, n.id);
      expect(vis?.visibility).toBe('private');
    }
  });
});
