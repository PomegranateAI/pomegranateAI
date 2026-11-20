/**
 * Routing: the ingest router only ever decides between two outcomes — file
 * into an existing folder, or ask a human to create a new one. There is no
 * third "drop it silently" outcome: a document that fits no existing folder
 * ALWAYS turns into a `pending_route` (see `proposeNewFolder` /
 * `resolveIngestTargets` / `runTextIngest` in api/routes.ts), even when the
 * namer call itself fails. The human can still reject a pending route — but
 * that is now an explicit decision, not a silent router verdict.
 *
 * `routeDocument` and `proposeNewFolder` are mocked directly (not through
 * TestSynthStub, which only covers capture) so each test controls exactly
 * what the router "decided" without an LLM call — same technique
 * ingest-fanout.test.ts uses for capture. Source text is deliberately bland
 * (no TestSynthStub strategic keywords) so capture always yields zero
 * candidates: these tests are about the ROUTING gate and its resolution, not
 * extraction content.
 *
 * The two are mocked separately because they're two SEPARATE real calls
 * (resolveIngestTargets only invokes proposeNewFolder when routeDocument
 * named no folder) — see proposeNewFolder's docstring in lib/anthropic.ts
 * for why they were split.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

type MockRoute = {
  target_subgraph_ids: string[];
  reason: string;
  summary: string;
  stakeholders: string[];
};
type MockProposal = { name: string; description: string } | null;

// Set by each test right before it ingests; the mocked functions return these
// verbatim instead of calling an LLM. A `*Throws` flag simulates the real
// call failing (network/model error) instead of returning a verdict.
let nextRoute: MockRoute | null = null;
let nextRouteThrows = false;
let nextProposal: MockProposal | undefined;
let nextProposalThrows = false;
// Captures the `opts` resolveIngestTargets passed into the most recent
// routeDocument call, so a test can assert on which folder ids actually made
// it into the catalog (the routable filter runs before this call).
let lastRouteOpts: { folders: Array<{ id: string }> } | null = null;
// Same, for the QUERY-side classifier: captures the subgraph list
// resolveQueryTargets passed into routeToSubgraphs. `nextQuerySubgraphIds`
// lets a test choose the verdict; undefined falls through to real behaviour
// (empty candidate pool → [], since these tests never set strategic
// keywords the real classifier would key off of).
let lastQuerySubgraphs: Array<{ id: string }> | null = null;
let nextQuerySubgraphIds: string[] | undefined;

vi.mock('../lib/anthropic.js', async () => {
  const real = await vi.importActual<typeof import('../lib/anthropic.js')>('../lib/anthropic.js');
  return {
    ...real,
    routeDocument: async (opts: { folders: Array<{ id: string }> }) => {
      lastRouteOpts = opts;
      if (nextRouteThrows) {
        nextRouteThrows = false;
        throw new Error('simulated router failure');
      }
      if (nextRoute) {
        const r = nextRoute;
        nextRoute = null;
        return r;
      }
      return (real.routeDocument as (o: unknown) => unknown)(opts);
    },
    proposeNewFolder: async (opts: unknown) => {
      if (nextProposalThrows) {
        nextProposalThrows = false;
        throw new Error('simulated namer failure');
      }
      if (nextProposal !== undefined) {
        const p = nextProposal;
        nextProposal = undefined;
        return { propose_new_folder: p, reason: 'mocked' };
      }
      return (real.proposeNewFolder as (o: unknown) => unknown)(opts);
    },
    routeToSubgraphs: async (source: string, subgraphs: Array<{ id: string }>) => {
      lastQuerySubgraphs = subgraphs;
      if (nextQuerySubgraphIds !== undefined) {
        const ids = nextQuerySubgraphIds;
        nextQuerySubgraphIds = undefined;
        return ids;
      }
      return (real.routeToSubgraphs as (s: string, sg: unknown) => unknown)(source, subgraphs);
    },
  };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-routing-approval-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?routing-approval=' + Date.now());
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

// No STRATEGIC_KEYWORDS (see synth-stub.ts) — TestSynthStub.capture returns
// [] for this, keeping every assertion here about routing, not extraction.
const BLAND_SOURCE = 'Weekly lunch order: turkey sandwiches for the team, delivered at noon on Thursday.';

describe('routing', () => {
  it('a new-folder proposal holds routing pending, then approve creates the folder and files the document', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'new-folder@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'NewFolder', profile_id: 'notes' } });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;

    nextRoute = {
      target_subgraph_ids: [],
      reason: 'Nothing existing fits, and this deserves its own folder.',
      summary: 'A settled call about the lunch vendor.',
      stakeholders: [],
    };
    nextProposal = { name: 'Decisions', description: 'Calls the team has made.' };
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'new-folder.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.pending_approval).toBe(true);
    expect(ing.json.dropped).toBeUndefined();
    const pendingRouteId = ing.json.pending_route_id as string;
    expect(pendingRouteId).toBeTruthy();
    const documentId = ing.json.document_id as string;

    // Nothing committed yet: the document exists but is routed nowhere.
    const routingBefore = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, { token, ws });
    expect(routingBefore.json.routing).toEqual([]);

    // Shows up in the pending list.
    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.status).toBe(200);
    expect(list.json.pending_routes.map((r: any) => r.id)).toEqual([pendingRouteId]);
    expect(list.json.pending_routes[0].proposed_new_folder).toEqual({ name: 'Decisions', description: 'Calls the team has made.' });

    // Approve: creates the folder, files the document into it, runs capture.
    const approve = await jsonCall(app, `/workspaces/${ws}/pending-routes/${pendingRouteId}/approve`, {
      method: 'POST',
      token,
      ws,
    });
    expect(approve.status).toBe(200);
    expect(approve.json.ok).toBe(true);
    const newSubgraphId = approve.json.new_subgraph_id as string;
    expect(newSubgraphId).toBeTruthy();
    expect(approve.json.targets).toEqual([newSubgraphId]);

    const subgraphs = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    const created2 = (subgraphs.json.subgraphs as any[]).find((s) => s.id === newSubgraphId);
    expect(created2).toBeTruthy();
    expect(created2.name).toBe('Decisions');
    expect(created2.profile_id).toBe('notes');

    const routingAfter = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, { token, ws });
    expect((routingAfter.json.routing as any[]).map((r: any) => r.subgraph_id)).toEqual([newSubgraphId]);
    expect((routingAfter.json.routing as any[])[0].routed_by).toBe('manual');

    // A second resolution on the same row is a conflict, not a silent re-run.
    const again = await jsonCall(app, `/workspaces/${ws}/pending-routes/${pendingRouteId}/approve`, {
      method: 'POST',
      token,
      ws,
    });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already_resolved');
  });

  it('an empty, undescribed target folder holds routing pending; choosing a different folder files it there instead', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'low-confidence@pome.test');

    // There is only one template, so two subgraphs of it — distinguished by
    // slug, not profile_id (both are 'notes').
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'LowConf', profile_ids: ['notes', 'notes'] },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    const bySlug = Object.fromEntries((created.json.subgraphs as any[]).map((s) => [s.slug, s]));
    const defaultId = bySlug['notes'].subgraph_id as string; // 'default', description left blank → 'miscellaneous'
    const otherFolderId = bySlug['notes-2'].subgraph_id as string;

    nextRoute = {
      target_subgraph_ids: [defaultId],
      reason: 'Closest match, but the folder has nothing in it yet.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'low-confidence.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.pending_approval).toBe(true);
    const pendingRouteId = ing.json.pending_route_id as string;
    const documentId = ing.json.document_id as string;

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes[0].low_confidence_targets).toEqual([defaultId]);
    expect(list.json.pending_routes[0].proposed_new_folder).toBeNull();

    // Choose the OTHER folder instead of the router's low-confidence pick.
    const choose = await jsonCall(app, `/workspaces/${ws}/pending-routes/${pendingRouteId}/choose`, {
      method: 'POST',
      token,
      ws,
      body: { target_ids: [otherFolderId] },
    });
    expect(choose.status).toBe(200);
    expect(choose.json.targets).toEqual([otherFolderId]);

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, { token, ws });
    expect((routing.json.routing as any[]).map((r: any) => r.subgraph_id)).toEqual([otherFolderId]);
  });

  it('reject leaves the document filed nowhere and creates no folder', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'reject-route@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'Reject', profile_id: 'notes' } });
    const ws = created.json.id as string;

    nextRoute = {
      target_subgraph_ids: [],
      reason: 'Not confident this belongs anywhere.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    nextProposal = { name: 'Decisions', description: 'x' };
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'reject-route.md' },
    });
    const pendingRouteId = ing.json.pending_route_id as string;
    const documentId = ing.json.document_id as string;

    const reject = await jsonCall(app, `/workspaces/${ws}/pending-routes/${pendingRouteId}/reject`, {
      method: 'POST',
      token,
      ws,
    });
    expect(reject.status).toBe(200);
    expect(reject.json.ok).toBe(true);

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, { token, ws });
    expect(routing.json.routing).toEqual([]);
    const subgraphs = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(subgraphs.json.subgraphs).toHaveLength(1); // no folder created

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes).toEqual([]); // resolved rows drop off the default (pending) list
  });

  it('a confidently-routed, described folder auto-applies with no gate (regression: normal ingest is unaffected)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'confident@pome.test');

    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Confident', profile_id: 'notes', descriptions: { notes: 'Personal errands only' } },
    });
    const ws = created.json.id as string;
    const defaultId = created.json.subgraphs[0].subgraph_id as string;

    nextRoute = {
      target_subgraph_ids: [defaultId],
      reason: 'A clean fit for the described folder.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'confident.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.pending_approval).toBeFalsy();
    expect(ing.json.dropped).toBeUndefined();
    expect((ing.json.routed as any[]).map((r: any) => r.subgraph_id)).toEqual([defaultId]);

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${ing.json.document_id}/routing`, { token, ws });
    expect((routing.json.routing as any[]).map((r: any) => r.subgraph_id)).toEqual([defaultId]);
    expect((routing.json.routing as any[])[0].routed_by).toBe('router');

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes).toEqual([]);
  });

  it('nothing fits and the namer minimally complies (empty name/description) — still a pending route, never a silent drop', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'no-drop-weak-namer@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'WeakNamer', profile_id: 'notes' } });
    const ws = created.json.id as string;

    nextRoute = {
      target_subgraph_ids: [],
      reason: 'Nothing existing fits.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    // The namer complying only minimally (empty strings) is still a real
    // object — truthy — so the pending-route gate must still fire. This is
    // the case that used to fall through to a silent drop when the old
    // `fits_template` gate said false.
    nextProposal = { name: '', description: '' };
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'weak-namer.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.dropped).toBeUndefined();
    expect(ing.json.pending_approval).toBe(true);
    expect(ing.json.pending_route_id).toBeTruthy();

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes).toHaveLength(1);
    expect(list.json.pending_routes[0].proposed_new_folder).toEqual({ name: '', description: '' });
  });

  it('nothing fits and the namer call itself fails — still a pending route, with a generic fallback name', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'no-drop-namer-failure@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'NamerFails', profile_id: 'notes' } });
    const ws = created.json.id as string;

    nextRoute = {
      target_subgraph_ids: [],
      reason: 'Nothing existing fits.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    nextProposalThrows = true;
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'namer-fails.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.dropped).toBeUndefined();
    expect(ing.json.pending_approval).toBe(true);

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes[0].proposed_new_folder).toEqual({ name: 'New folder', description: '' });

    // Still resolvable exactly like a real proposal: approve creates the folder.
    const approve = await jsonCall(app, `/workspaces/${ws}/pending-routes/${list.json.pending_routes[0].id}/approve`, {
      method: 'POST',
      token,
      ws,
    });
    expect(approve.status).toBe(200);
    expect(approve.json.ok).toBe(true);
  });

  it('the router call itself fails — holds for a folder decision instead of filing to default', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'router-call-fails@pome.test');

    // TWO folders, deliberately: holding is only meaningful when there is a
    // decision to hold for. A single-folder workspace files to its one folder
    // instead — see the test below.
    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'RouterFails', profile_ids: ['notes', 'notes'] } });
    const ws = created.json.id as string;

    nextRouteThrows = true;
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'router-fails.md' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.dropped).toBeUndefined();
    expect(ing.json.pending_approval).toBe(true);

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes).toHaveLength(1);
    expect(list.json.pending_routes[0].reason).toMatch(/Automatic routing failed/);
    expect(list.json.pending_routes[0].proposed_new_folder).toEqual({ name: 'New folder', description: '' });
  });

  it('the router fails in a single-folder workspace — files to the one folder instead of holding', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'router-fails-solo@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'SoloRouterFails', profile_id: 'notes' } });
    const ws = created.json.id as string;

    nextRouteThrows = true;
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'solo-router-fails.md' },
    });
    expect(ing.status).toBe(200);
    // There is only one place it could go, so it goes there rather than
    // stalling behind a decision nobody needs to make. A provider outage must
    // not stop ingestion for the single-folder case, which is most new users.
    expect(ing.json.pending_approval).toBeFalsy();
    expect((ing.json.routed as any[]).map((r) => r.subgraph_id)).toEqual(['default']);

    const list = await jsonCall(app, `/workspaces/${ws}/pending-routes`, { token, ws });
    expect(list.json.pending_routes).toHaveLength(0);
  });

  it('a non-routable subfolder is hidden from the router catalog unless the document pins it', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'not-routable@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'NotRoutable', profile_id: 'notes' } });
    const ws = created.json.id as string;
    const defaultId = created.json.subgraphs[0].subgraph_id as string;
    // Give the default subfolder a real description so it clears the
    // separate "low-confidence, no owner description or content" approval
    // gate (routing-approval's other tests) — this test is about the
    // routable filter, not that gate.
    await jsonCall(app, `/workspaces/${ws}/subgraphs/${defaultId}`, {
      method: 'PATCH',
      token,
      ws,
      body: { description: 'Personal errands only' },
    });

    const add = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      ws,
      body: { profile_id: 'notes', name: 'Sealed', slug: 'sealed' },
    });
    const sealedId = add.json.subgraph_id as string;

    // New subgraphs default routable (pre-feature behaviour, unaffected).
    const listBefore = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(listBefore.json.subgraphs.find((s: any) => s.id === sealedId).routable).toBe(true);

    const patch = await jsonCall(app, `/workspaces/${ws}/subgraphs/${sealedId}`, {
      method: 'PATCH',
      token,
      ws,
      body: { routable: false },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.routable).toBe(false);

    // Unpinned: "Sealed" never even reaches the catalog the router is shown —
    // resolveIngestTargets filters it out before the call, so it's not a
    // question of the router declining it, it's never offered. Route into
    // the (still-routable) default folder to keep this ingest uneventful.
    nextRoute = {
      target_subgraph_ids: [defaultId],
      reason: 'A clean fit for the one routable folder on offer.',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    const unpinned = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: BLAND_SOURCE, source_kind: 'doc', source_ref: 'unpinned.md' },
    });
    expect((lastRouteOpts!.folders as any[]).map((f) => f.id)).toEqual([defaultId]);
    expect(unpinned.status).toBe(200);
    expect(unpinned.json.pending_approval).toBeFalsy();
    expect((unpinned.json.routed as any[]).map((r: any) => r.subgraph_id)).toEqual([defaultId]);

    // Pinned (#sealed): the explicit address always wins regardless of routable.
    nextRoute = {
      target_subgraph_ids: [],
      reason: 'irrelevant — pin overrides',
      summary: 'Lunch vendor call.',
      stakeholders: [],
    };
    const pinned = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: `${BLAND_SOURCE} #sealed`, source_kind: 'doc', source_ref: 'pinned.md' },
    });
    expect(pinned.status).toBe(200);
    expect(pinned.json.pending_approval).toBeFalsy();
    expect((pinned.json.routed as any[]).map((r: any) => r.subgraph_id)).toEqual([sealedId]);

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${pinned.json.document_id}/routing`, { token, ws });
    expect((routing.json.routing as any[])[0].routed_by).toBe('pinned');
  });

  it('the query classifier never sees a non-routable subfolder as a candidate', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'query-not-routable@pome.test');

    const created = await jsonCall(app, '/workspaces', { method: 'POST', token, body: { name: 'QueryNotRoutable', profile_id: 'notes' } });
    const ws = created.json.id as string;
    const defaultId = created.json.subgraphs[0].subgraph_id as string;

    const add = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      ws,
      body: { profile_id: 'notes', name: 'Sealed', slug: 'sealed' },
    });
    const sealedId = add.json.subgraph_id as string;
    await jsonCall(app, `/workspaces/${ws}/subgraphs/${sealedId}`, {
      method: 'PATCH',
      token,
      ws,
      body: { routable: false },
    });

    // Empty verdict from the classifier would normally fall back to querying
    // every active subgraph — it must still exclude "Sealed".
    nextQuerySubgraphIds = [];
    const q = await jsonCall(app, `/workspaces/${ws}/query`, {
      method: 'POST',
      token,
      ws,
      body: { question: 'What do we know?' },
    });
    expect(q.status).toBe(200);
    expect((lastQuerySubgraphs as any[]).map((s) => s.id)).toEqual([defaultId]);
    expect((lastQuerySubgraphs as any[]).map((s) => s.id)).not.toContain(sealedId);
  });
});
