/**
 * Ingest fan-out across subgraphs (Phase 3).
 *
 * A document is routed to one or more target subgraphs and extracted/deduped/
 * curated INDEPENDENTLY into each. A `#<slug>` token in the source PINS the
 * targets (no classifier call); without a pin, content routing decides. The
 * HARD INVARIANT: a single-subgraph workspace behaves byte-identically to
 * before fan-out existed.
 *
 * Same deterministic synthesis stub as mcp-curation.test.ts — no real API.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TestSynthStub } from '../__test_utils__/synth-stub.js';
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

// A source the stub extracts from: "killing" → a decision candidate,
// "north star" → a goal candidate. Two pending items per subgraph it routes to.
const SOURCE_BODY =
  'We are killing the legacy reseller program. New north star: 20 design-partner workspaces by Q3.';

describe('ingest fan-out across subgraphs', () => {
  it('a #pin routes a document into exactly the named subgraphs, independently', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'fanout@pome.test');

    // 3-subgraph workspace, all on the one template — distinguished by slug,
    // not profile_id (all three are 'notes').
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Fan', profile_ids: ['notes', 'notes', 'notes'] },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    const bySlug = Object.fromEntries(
      (created.json.subgraphs as any[]).map((s) => [s.slug, s]),
    );
    const foundingSlug = bySlug['notes'].slug as string;
    const productSlug = bySlug['notes-3'].slug as string;
    const foundingId = bySlug['notes'].subgraph_id as string; // 'default'
    const otherId = bySlug['notes-2'].subgraph_id as string;
    const productId = bySlug['notes-3'].subgraph_id as string;
    expect(foundingId).toBe('default');

    // The stub's capture heuristics extract decision/goal-kind candidates
    // from SOURCE_BODY ("killing"/"north star") — install the founding
    // fixture profile on every subgraph so those kinds validate.
    for (const sgId of [foundingId, otherId, productId]) {
      await jsonCall(app, `/workspaces/${ws}/profile`, {
        method: 'PUT',
        token,
        ws,
        subgraph: sgId,
        body: { profile: foundingProfile },
      });
    }

    // Ingest with PINS to founding + product (NOT marketing). Pinned path: no
    // classifier/API call. The #tokens lead the source text.
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: {
        source: `#${foundingSlug} #${productSlug} ${SOURCE_BODY}`,
        source_kind: 'doc',
        source_ref: 'pinned-plan.md',
      },
    });
    expect(ing.status).toBe(200);
    const documentId = ing.json.document_id as string;
    expect(documentId).toBeTruthy();

    // `routed` reports exactly the two pinned subgraphs, not marketing.
    const routedIds = (ing.json.routed as any[]).map((r) => r.subgraph_id).sort();
    expect(routedIds).toEqual([foundingId, productId].sort());
    expect(routedIds).not.toContain(otherId);
    // Each pinned subgraph extracted its own candidates (≥1).
    for (const r of ing.json.routed as any[]) {
      expect(r.candidates).toBeGreaterThanOrEqual(1);
    }
    // Summed candidates across targets is the legacy `candidates` field.
    const summed = (ing.json.routed as any[]).reduce((s: number, r: any) => s + r.candidates, 0);
    expect(ing.json.candidates).toBe(summed);

    // Candidates exist in founding + product, ZERO in marketing. Light
    // auto-approves on ingest (no pending queue), so check 'approved'.
    const foundingPending = await jsonCall(app, `/workspaces/${ws}/candidates?status=approved`, { token, ws, subgraph: foundingId });
    const productPending = await jsonCall(app, `/workspaces/${ws}/candidates?status=approved`, { token, ws, subgraph: productId });
    const marketingPending = await jsonCall(app, `/workspaces/${ws}/candidates?status=approved`, { token, ws, subgraph: otherId });
    expect(foundingPending.json.candidates.length).toBeGreaterThanOrEqual(1);
    expect(productPending.json.candidates.length).toBeGreaterThanOrEqual(1);
    expect(marketingPending.json.candidates.length).toBe(0);

    // The candidates in founding and product are DISTINCT rows (independent
    // extraction), not shared ids.
    const fIds = new Set(foundingPending.json.candidates.map((c: any) => c.id));
    const pIds = new Set(productPending.json.candidates.map((c: any) => c.id));
    for (const id of pIds) expect(fIds.has(id)).toBe(false);

    // Routing registry lists exactly the two pinned subgraphs, marked pinned.
    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, { token, ws });
    expect(routing.status).toBe(200);
    const routedSubgraphIds = (routing.json.routing as any[]).map((r) => r.subgraph_id).sort();
    expect(routedSubgraphIds).toEqual([foundingId, productId].sort());
    for (const r of routing.json.routing as any[]) expect(r.routed_by).toBe('pinned');

    // The verbatim source (with #tokens) is what's persisted for download —
    // the candidate context line carries the stripped summary, never tokens.
    for (const c of foundingPending.json.candidates) {
      const ctx = (c.proposed_node?.attrs?.context ?? '') as string;
      expect(ctx).not.toContain(`#${productSlug}`);
      expect(ctx).not.toContain(`#${foundingSlug}`);
    }
  });

  it('persists routing for EVERY target up front, so a capture failure on one target does not drop the others', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'fanout-fail@pome.test');

    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'FanFail', profile_ids: ['notes', 'notes', 'notes'] },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    const bySlug = Object.fromEntries((created.json.subgraphs as any[]).map((s) => [s.slug, s]));
    const foundingSlug = bySlug['notes'].slug as string;
    const productSlug = bySlug['notes-3'].slug as string;
    const foundingId = bySlug['notes'].subgraph_id as string; // 'default', captured FIRST
    const productId = bySlug['notes-3'].subgraph_id as string;

    // Make the FIRST target's capture blow up (mirrors the prod incident: the
    // 'default' subgraph's capture stalled/errored on the LLM), and fall through
    // to the real stub for the rest. Later targets must still be recorded as
    // routed — the whole point of committing routing up front, before the
    // fallible capture loop.
    const realCapture = TestSynthStub.capture.bind(TestSynthStub);
    let calls = 0;
    const spy = vi
      .spyOn(TestSynthStub, 'capture')
      .mockImplementation((args: any) =>
        ++calls === 1 ? Promise.reject(new Error('capture boom on first target')) : realCapture(args),
      );

    try {
      const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
        method: 'POST',
        token,
        ws,
        body: {
          source: `#${foundingSlug} #${productSlug} ${SOURCE_BODY}`,
          source_kind: 'doc',
          source_ref: 'fail-plan.md',
        },
      });
      // The request itself fails (fix #1 does not isolate capture errors — that
      // is fix #2); what matters is the routing record survives.
      expect(ing.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }

    // The document was registered and routed to BOTH pinned subgraphs, even
    // though the first target's capture threw before the second ever ran.
    const docs = await jsonCall(app, `/workspaces/${ws}/documents`, { token, ws });
    const doc = (docs.json.documents as any[]).find((d) => d.source_ref === 'fail-plan.md');
    expect(doc).toBeTruthy();
    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${doc.id}/routing`, { token, ws });
    const routedIds = (routing.json.routing as any[]).map((r) => r.subgraph_id).sort();
    expect(routedIds).toEqual([foundingId, productId].sort());
  });

  it('a single-subgraph workspace with no pins behaves like today (candidates land in default)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'solo-fanout@pome.test');

    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Solo', profile_id: 'notes' },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    // SOURCE_BODY triggers the stub's decision/goal-kind heuristics — install
    // the founding fixture profile so those kinds validate under `notes`.
    await jsonCall(app, `/workspaces/${ws}/profile`, { method: 'PUT', token, ws, body: { profile: foundingProfile } });

    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: SOURCE_BODY, source_kind: 'doc', source_ref: 'solo-plan.md' },
    });
    expect(ing.status).toBe(200);
    // Exactly one target: default. No classifier ran (single subgraph).
    expect((ing.json.routed as any[]).map((r) => r.subgraph_id)).toEqual(['default']);
    expect(ing.json.candidates).toBeGreaterThanOrEqual(1);

    const pending = await jsonCall(app, `/workspaces/${ws}/candidates?status=approved`, { token, ws });
    expect(pending.json.candidates.length).toBe(ing.json.candidates);

    // A productive ingest is NOT flagged as zero-yield.
    expect(ing.json.zero_yield).toBe(false);
    expect(ing.json.notice ?? null).toBeNull();

    // The routing registry records the single default route.
    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${ing.json.document_id}/routing`, { token, ws });
    expect((routing.json.routing as any[]).map((r) => r.subgraph_id)).toEqual(['default']);
  });

  it('surfaces zero_yield when the router deems a doc relevant but capture extracts nothing', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'zeroyield@pome.test');

    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'ZeroYield', profile_id: 'notes' },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;

    // Reproduce the weak-model failure shape: capture runs, pushes the
    // `zero_yield` tripwire into the trace (as anthropic.ts runCaptureBase does
    // when route.relevant && merged.length === 0), and returns no candidates.
    const spy = vi.spyOn(TestSynthStub, 'capture').mockImplementation(async (args: any) => {
      args.trace?.push({ stage: 'zero_yield', groups: ['direction'], source_type: 'strategy_doc' });
      return [];
    });

    try {
      const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
        method: 'POST',
        token,
        ws,
        body: { source: SOURCE_BODY, source_kind: 'doc', source_ref: 'empty-capture.md' },
      });
      expect(ing.status).toBe(200);
      expect(ing.json.candidates).toBe(0);
      // The signal the caller needs: this 0 is a model miss, not "nothing to add".
      expect(ing.json.zero_yield).toBe(true);
      expect(typeof ing.json.notice).toBe('string');
      expect(ing.json.notice.length).toBeGreaterThan(0);

      // A zero-yield source must STILL appear in the documents list — an
      // ingest never silently vanishes — with zero pending/approved candidates
      // (nothing to review, rather than nothing at all).
      const docs = await jsonCall(app, `/workspaces/${ws}/documents`, { method: 'GET', token, ws });
      expect(docs.status).toBe(200);
      const row = (docs.json.documents as any[]).find((d) => d.source_ref?.endsWith('empty-capture.md'));
      expect(row).toBeTruthy();
      expect(row.candidates.pending).toBe(0);
      expect(row.candidates.approved).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('subgraph_id on /ingest files directly into that folder, skipping the router — no #token needed', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'direct-add@pome.test');

    // There is only one template, so three subgraphs of it — distinguished by
    // slug, not profile_id (all three are 'notes').
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Direct', profile_ids: ['notes', 'notes', 'notes'] },
    });
    const ws = created.json.id as string;
    const bySlug = Object.fromEntries((created.json.subgraphs as any[]).map((s) => [s.slug, s]));
    const targetId = bySlug['notes-2'].subgraph_id as string;
    const otherId = bySlug['notes-3'].subgraph_id as string;

    // No #tokens in the source at all — the destination comes only from
    // subgraph_id, proving the request never depends on the router's opinion.
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: SOURCE_BODY, source_kind: 'doc', source_ref: 'direct-plan.md', subgraph_id: targetId },
    });
    expect(ing.status).toBe(200);
    expect((ing.json.routed as any[]).map((r: any) => r.subgraph_id)).toEqual([targetId]);
    expect(ing.json.dropped).toBeUndefined();
    expect(ing.json.pending_approval).toBeFalsy();

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${ing.json.document_id}/routing`, { token, ws });
    expect((routing.json.routing as any[]).map((r: any) => r.subgraph_id)).toEqual([targetId]);
    expect((routing.json.routing as any[])[0].routed_by).toBe('pinned');

    // The other folder got nothing — a direct add only ever touches the one folder named.
    const otherPending = await jsonCall(app, `/workspaces/${ws}/candidates`, { token, ws, subgraph: otherId });
    expect(otherPending.json.candidates.length).toBe(0);
  });

  it('rejects /ingest with a subgraph_id from another workspace or an archived folder', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'direct-add-invalid@pome.test');

    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'DirectInvalid', profile_ids: ['notes', 'notes'] },
    });
    const ws = created.json.id as string;
    const otherId = Object.fromEntries((created.json.subgraphs as any[]).map((s) => [s.slug, s]))[
      'notes-2'
    ].subgraph_id as string;

    const bogus = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: SOURCE_BODY, source_ref: 'bogus.md', subgraph_id: 'sg_does_not_exist' },
    });
    expect(bogus.status).toBe(400);
    expect(bogus.json.error).toBe('invalid_subgraph');

    const archived = await jsonCall(app, `/workspaces/${ws}/subgraphs/${otherId}`, { method: 'DELETE', token, ws });
    expect(archived.status).toBe(200);

    const intoArchived = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: SOURCE_BODY, source_ref: 'into-archived.md', subgraph_id: otherId },
    });
    expect(intoArchived.status).toBe(400);
    expect(intoArchived.json.error).toBe('invalid_subgraph');
  });
});
