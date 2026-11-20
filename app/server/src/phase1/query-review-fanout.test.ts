/**
 * Phase 4 — retrieval + review fan-out across subgraphs.
 *
 * Verifies that query_context / review_deliverable auto-route (here: PINNED via
 * `#slug` tokens so the real classifier never runs) across the relevant
 * subgraph(s) and MERGE results, while a single-subgraph workspace behaves
 * exactly as before.
 *
 * Uses the deterministic synthesis stub (no real API). Embedding ranking never
 * fires (graphs are tiny), so getEmbedder is never consulted either.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../lib/profiles/__fixtures__/founding.js';

vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-fanout-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?fanout=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string; subgraph?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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

/** Ingest a (pinned) source into its subgraph; Light auto-approves on ingest
 *  (no pending queue/accept-source step), so the candidates are already
 *  active nodes — just read them back. */
async function ingestAndAccept(
  app: any,
  ws: string,
  token: string,
  source: string,
  subgraphId: string,
): Promise<{ document_id: string; nodeIds: string[] }> {
  const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
    method: 'POST',
    token,
    body: { source, source_kind: 'doc' },
  });
  expect(ing.status).toBe(200);
  const document_id = ing.json.document_id as string;
  // Read back the active nodes in this subgraph.
  const graph = await jsonCall(app, `/workspaces/${ws}/graph`, { token, subgraph: subgraphId });
  const nodeIds = (graph.json.nodes as any[]).map((n) => n.id);
  return { document_id, nodeIds };
}

describe('Phase 4 — query/review fan-out across subgraphs', () => {
  it('two-subgraph workspace: pinned multi-query merges; pinned single-query scopes; reviews merge', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'leader@fanout.io');

    // 2-subgraph workspace, both on the one template — distinguished by slug,
    // not profile_id ('notes' → default, 'notes-2' → the second).
    const wsRes = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token: session,
      body: { name: 'Fanout', profile_ids: ['notes', 'notes'] },
    });
    expect(wsRes.status).toBe(200);
    const ws = wsRes.json.id as string;
    const subs = wsRes.json.subgraphs as Array<{ subgraph_id: string; slug: string }>;
    const foundingSg = subs.find((s) => s.slug === 'notes')!;
    const productSg = subs.find((s) => s.slug === 'notes-2')!;
    expect(foundingSg.subgraph_id).toBe('default');
    expect(productSg.subgraph_id).not.toBe('default');

    // The stub's capture heuristics extract decision/goal-kind candidates
    // from "killing"/"north star" — install the founding fixture profile on
    // both subgraphs so those kinds validate under `notes`.
    for (const sg of [foundingSg, productSg]) {
      await jsonCall(app, `/workspaces/${ws}/profile`, {
        method: 'PUT',
        token: session,
        subgraph: sg.subgraph_id,
        body: { profile: foundingProfile },
      });
    }

    // Ingest a doc PINNED to each subgraph so each has distinct active nodes.
    // The stub capture emits a goal (from "north star") + a decision (from
    // "killing"); distinctive vocabulary drives the stub's query overlap match.
    const founding = await ingestAndAccept(
      app,
      ws,
      session,
      `#${foundingSg.slug} Killing the legacy reseller channel arrangement entirely. ` +
        'North star metric: twenty design-partner workspaces secured before the September deadline.',
      foundingSg.subgraph_id,
    );
    const product = await ingestAndAccept(
      app,
      ws,
      session,
      `#${productSg.slug} Killing the deprecated mobile synchronization subsystem permanently. ` +
        'North star roadmap: realtime collaboration cursors shipped before the autumn launch window.',
      productSg.subgraph_id,
    );
    expect(founding.nodeIds.length).toBeGreaterThan(0);
    expect(product.nodeIds.length).toBeGreaterThan(0);
    // Node ids are globally unique across subgraphs — no overlap.
    const foundingSet = new Set(founding.nodeIds);
    const productSet = new Set(product.nodeIds);
    for (const id of product.nodeIds) expect(foundingSet.has(id)).toBe(false);

    // 1. Multi-subgraph PINNED query → both subgraphs queried + merged.
    const multiQ = await jsonCall(app, `/workspaces/${ws}/query`, {
      method: 'POST',
      token: session,
      body: {
        question:
          `#${foundingSg.slug} #${productSg.slug} What did we decide about killing the legacy reseller channel and ` +
          'the north star metric: design-partner workspaces secured before September, plus the ' +
          'roadmap for realtime collaboration cursors and the mobile synchronization subsystem launch?',
        scope: 'all',
      },
    });
    expect(multiQ.status).toBe(200);
    expect(multiQ.json.subgraphs).toEqual(
      expect.arrayContaining([foundingSg.subgraph_id, productSg.subgraph_id]),
    );
    // Cites are drawn from BOTH subgraphs' node sets (merged answer).
    const cited: string[] = multiQ.json.cited_node_ids ?? [];
    expect(cited.length).toBeGreaterThan(0);
    const citedFromFounding = cited.some((id) => foundingSet.has(id));
    const citedFromProduct = cited.some((id) => productSet.has(id));
    expect(citedFromFounding).toBe(true);
    expect(citedFromProduct).toBe(true);
    // Every cited id is a real node in one of the two subgraphs.
    for (const id of cited) expect(foundingSet.has(id) || productSet.has(id)).toBe(true);

    // 2. Single-subgraph PINNED query → only the product subgraph is in play;
    //    cited ids ⊆ product nodes (founding nodes never reachable).
    const prodOnly = await jsonCall(app, `/workspaces/${ws}/query`, {
      method: 'POST',
      token: session,
      body: {
        question:
          `#${productSg.slug} What did we decide about killing the mobile synchronization subsystem and ` +
          'the realtime collaboration cursors launch roadmap?',
        scope: 'all',
      },
    });
    expect(prodOnly.status).toBe(200);
    const prodCited: string[] = prodOnly.json.cited_node_ids ?? [];
    expect(prodCited.length).toBeGreaterThan(0);
    for (const id of prodCited) expect(productSet.has(id)).toBe(true);
    expect(prodCited.some((id) => foundingSet.has(id))).toBe(false);

    // 3. Multi-subgraph PINNED review with a kind valid in BOTH profiles
    //    ('other') → findings merged and the review persists.
    const review = await jsonCall(app, `/workspaces/${ws}/reviews`, {
      method: 'POST',
      token: session,
      body: {
        deliverable:
          `#${foundingSg.slug} #${productSg.slug} Draft launch note: we are reviving the legacy reseller channel ` +
          'arrangement and shipping the deprecated mobile synchronization subsystem.',
        kind: 'other',
      },
    });
    expect(review.status).toBe(200);
    expect(review.json.id).toMatch(/^rev_/);
    expect(review.json.subgraphs).toEqual(
      expect.arrayContaining([foundingSg.subgraph_id, productSg.subgraph_id]),
    );
    expect(Array.isArray(review.json.findings)).toBe(true);
    // The review row persisted.
    const reviews = await jsonCall(app, `/workspaces/${ws}/reviews`, { token: session });
    const ids = (reviews.json.reviews ?? []).map((r: any) => r.id);
    expect(ids).toContain(review.json.id);

    // 4. A kind accepted by NEITHER profile → 422 across subgraphs.
    const badKind = await jsonCall(app, `/workspaces/${ws}/reviews`, {
      method: 'POST',
      token: session,
      body: { deliverable: `#${foundingSg.slug} #${productSg.slug} anything`, kind: 'totally_made_up_kind' },
    });
    expect(badKind.status).toBe(422);

    // 5. context-pack with NO pin dumps every active subgraph and merges.
    const pack = await jsonCall(app, `/workspaces/${ws}/context-pack?scope=all`, { token: session });
    expect(pack.status).toBe(200);
    expect(pack.json.subgraphs).toEqual(
      expect.arrayContaining([foundingSg.subgraph_id, productSg.subgraph_id]),
    );
    expect(pack.json.node_count).toBe(founding.nodeIds.length + product.nodeIds.length);
  });

  it('single-subgraph workspace: query + review behave exactly as before (no subgraphs field)', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'solo@fanout.io');
    const ws = (
      await jsonCall(app, '/workspaces', { method: 'POST', token: session, body: { profile_id: 'notes', name: 'Solo' } })
    ).json.id as string;
    // The stub's capture heuristics extract decision/goal-kind candidates —
    // install the founding fixture profile so those kinds validate.
    await jsonCall(app, `/workspaces/${ws}/profile`, { method: 'PUT', token: session, body: { profile: foundingProfile } });

    const ing = await ingestAndAccept(
      app,
      ws,
      session,
      'Killing the legacy reseller channel arrangement. North star metric: twenty design-partner ' +
        'workspaces secured before the September deadline.',
      'default',
    );
    expect(ing.nodeIds.length).toBeGreaterThan(0);

    // Query: legacy response shape — no `subgraphs` field.
    const q = await jsonCall(app, `/workspaces/${ws}/query`, {
      method: 'POST',
      token: session,
      body: {
        question:
          'What did we decide about killing the reseller channel arrangement and the north star ' +
          'metric of design-partner workspaces?',
        scope: 'all',
      },
    });
    expect(q.status).toBe(200);
    expect(q.json.subgraphs).toBeUndefined();
    expect(Array.isArray(q.json.cited_node_ids)).toBe(true);

    // Bad scope still 422s on the single path.
    const badScope = await jsonCall(app, `/workspaces/${ws}/query`, {
      method: 'POST',
      token: session,
      body: { question: 'anything', scope: 'not_a_scope' },
    });
    expect(badScope.status).toBe(422);

    // Review: legacy shape — no `subgraphs` field; bad kind 422s.
    const rev = await jsonCall(app, `/workspaces/${ws}/reviews`, {
      method: 'POST',
      token: session,
      body: { deliverable: 'Some draft text about strategy.', kind: 'other' },
    });
    expect(rev.status).toBe(200);
    expect(rev.json.id).toMatch(/^rev_/);
    expect(rev.json.subgraphs).toBeUndefined();

    const badRev = await jsonCall(app, `/workspaces/${ws}/reviews`, {
      method: 'POST',
      token: session,
      body: { deliverable: 'x', kind: 'not_a_kind' },
    });
    expect(badRev.status).toBe(422);
  });
});
