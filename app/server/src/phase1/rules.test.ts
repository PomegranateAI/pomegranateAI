/**
 * Ingestion/sharing rules — HTTP surface (Stage R0 CRUD + seeding, R1 test loop).
 *
 * Uses the same deterministic synthesis stub as ingest-fanout.test.ts (no real
 * API): a source containing "killing" yields one decision candidate. The rule
 * test endpoint dry-runs the SAME capture, so it returns candidates WITHOUT
 * persisting them.
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-rules-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?rules=' + Date.now());
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
  const token = await magic(app, 'rules@pome.test');
  const created = await jsonCall(app, '/workspaces', {
    method: 'POST',
    token,
    body: { name: 'RulesWs', profile_id: 'notes' },
  });
  const ws = created.json.id as string;
  // The stub's capture heuristics extract decision/goal-kind candidates from
  // "killing"/"north star" source text — install the founding fixture profile
  // so those kinds validate at the ingest kind-gate instead of being dropped.
  await jsonCall(app, `/workspaces/${ws}/profile`, { method: 'PUT', token, body: { profile: foundingProfile } });
  return { app, token, ws };
}

describe('rules HTTP surface', () => {
  it('GET seeds the three defaults once, on the unified 3-tier model, and reports can_edit for the owner', async () => {
    const { app, token, ws } = await setup();
    const r = await jsonCall(app, `/workspaces/${ws}/rules`, { token, ws });
    expect(r.status).toBe(200);
    expect(r.json.rules).toHaveLength(3);
    expect(r.json.can_edit).toBe(true);
    const scopes = (r.json.rules as any[]).flatMap((x) => x.scopes);
    expect(scopes).not.toContain('local'); // unified model, no legacy tier
    expect(scopes).toContain('only_me');

    // Idempotent: a second GET does not re-seed.
    const r2 = await jsonCall(app, `/workspaces/${ws}/rules`, { token, ws });
    expect(r2.json.rules).toHaveLength(3);
  });

  it('creates, patches (enable toggle), and deletes a rule', async () => {
    const { app, token, ws } = await setup();
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Redact salaries', scopes: ['team'], phases: ['store'], action: 'shape' },
    });
    expect(created.status).toBe(200);
    const id = created.json.rule.id as string;
    expect(created.json.rule.enabled).toBe(true);

    const patched = await jsonCall(app, `/workspaces/${ws}/rules/${id}`, {
      method: 'PATCH',
      token,
      ws,
      body: { enabled: false },
    });
    expect(patched.json.rule.enabled).toBe(false);
    expect(patched.json.rule.instructions).toBe('Redact salaries'); // untouched fields preserved

    const del = await jsonCall(app, `/workspaces/${ws}/rules/${id}`, { method: 'DELETE', token, ws });
    expect(del.status).toBe(200);
    const after = await jsonCall(app, `/workspaces/${ws}/rules`, { token, ws });
    expect((after.json.rules as any[]).some((x) => x.id === id)).toBe(false);
  });

  it('accepts an empty-instructions draft (the web UI "Add rule" flow) without classifying', async () => {
    const { app, token, ws } = await setup();
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: '', scopes: ['only_me', 'private', 'team'], sort_order: 0 },
    });
    expect(created.status).toBe(200);
    expect(created.json.rule.instructions).toBe('');
    // Blank drafts take the fail-open default classification (no LLM call).
    expect(created.json.rule.phases).toEqual(['store']);
    expect(created.json.rule.action).toBe('shape');
  });

  it('infers phase from the instructions, ignoring any client-sent values, and always normalizes action to shape', async () => {
    const { app, token, ws } = await setup();
    // A sharing rule — even though the body lies (store/auto_reject, a stale
    // pre-removal action value), the server classifies "share" → use-phase and
    // ALWAYS normalizes action to 'shape' — there is no other action anymore.
    const share = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Do not share product release timelines', scopes: ['team'], phases: ['store'], action: 'auto_reject' },
    });
    expect(share.json.rule.phases).toContain('use');
    expect(share.json.rule.action).toBe('shape');
  });

  it('an ingestion rule test dry-runs with and without the rule and persists nothing', async () => {
    const { app, token, ws } = await setup();
    // A node-shaping, store-phase rule → ingestion test mode (with/without diff).
    // (NB: "do not index …" wording is deliberately NOT used here — that is
    // source-document treatment and classifies as a source rule.)
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Keep extracted notes concise and neutral in tone', scopes: ['team'] },
    });
    const id = created.json.rule.id as string;

    const test = await jsonCall(app, `/workspaces/${ws}/rules/${id}/test`, {
      method: 'POST',
      token,
      ws,
      body: { text: 'We are killing the legacy reseller program.', source_kind: 'doc' },
    });
    expect(test.status).toBe(200);
    expect(test.json.mode).toBe('ingestion');
    // The stub emits a decision candidate for "killing" on BOTH runs.
    expect(test.json.without_rule.length).toBeGreaterThan(0);
    expect(test.json.with_rule.length).toBeGreaterThan(0);
    expect(test.json.with_rule[0].id).toMatch(/^cpv_/); // preview id, not persisted

    // Dry run: NOTHING was written to the candidate queue.
    const cands = await jsonCall(app, `/workspaces/${ws}/candidates?status=pending`, { token, ws });
    expect(cands.json.candidates ?? cands.json).toEqual([]);
  });

  it('a source rule test returns the document after processing; ingest scrubs the stored source', async () => {
    const { app, token, ws } = await setup();
    // "Remove PII from transcripts" → the stub classifies target 'both' (source rule).
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Remove reseller mentions from transcripts', scopes: ['team'] },
    });
    expect(['source', 'both']).toContain(created.json.rule.target === 'both' ? 'both' : created.json.rule.target);
    const id = created.json.rule.id as string;

    // Test mode = source: the stub redacts any >4-char word of the rule that
    // appears in the text; "reseller" hits.
    const test = await jsonCall(app, `/workspaces/${ws}/rules/${id}/test`, {
      method: 'POST',
      token,
      ws,
      body: { text: 'The reseller program is ending.' },
    });
    expect(test.json.mode).toBe('source');
    expect(test.json.processed).toContain('[redacted]');
    expect(test.json.processed).not.toContain('reseller');

    // Live ingest: the STORED source document is scrubbed too, not just the nodes.
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: { source: 'The reseller program is ending.', source_kind: 'doc', source_ref: 'scrub.md' },
    });
    const content = await jsonCall(app, `/workspaces/${ws}/documents/${ing.json.document_id}/content`, { token, ws });
    const text = typeof content.json === 'string' ? content.json : JSON.stringify(content.json);
    expect(text).not.toContain('reseller');
  });

  it("a don't-index rule classifies as a SOURCE rule: it acts on the document at the first stage, not the capture prompt", async () => {
    const { app, token, ws } = await setup();
    // "Do not index casual chatter …" is source-document treatment: the rule
    // must act on the document BEFORE it is stored or processed further — never
    // be routed to the capture-prompt stage, where a router rejection would
    // bypass it entirely (the 2026-07-06 rule-test bug).
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: {
        instructions: 'Do not index casual chatter in call transcripts and Slack communication',
        scopes: ['private', 'team'],
      },
    });
    expect(created.json.rule.target).toBe('source');
    expect(created.json.rule.phases).toContain('store');
    const id = created.json.rule.id as string;

    // Its test surface is the scrubbed document (mode 'source'), which exercises
    // the rule directly — no relevance router sits in front of it.
    const test = await jsonCall(app, `/workspaces/${ws}/rules/${id}/test`, {
      method: 'POST',
      token,
      ws,
      body: { text: 'Some casual chatter about coffee. We are killing the legacy program.' },
    });
    expect(test.json.mode).toBe('source');
    expect(test.json.changed).toBe(true);
    expect(test.json.processed).not.toContain('chatter');

    // Live ingest scrubs the stored document at the first stage too.
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: {
        source: 'Some casual chatter about coffee. We are killing the legacy program.',
        source_kind: 'doc',
        source_ref: 'chat.md',
      },
    });
    const content = await jsonCall(app, `/workspaces/${ws}/documents/${ing.json.document_id}/content`, { token, ws });
    const text = typeof content.json === 'string' ? content.json : JSON.stringify(content.json);
    expect(text).not.toContain('chatter');
  });

  it('a use-phase rule test returns an Ask answer with and without the rule', async () => {
    const { app, token, ws } = await setup();
    const created = await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: { instructions: 'Do not share product release timelines', scopes: ['team'] },
    });
    const id = created.json.rule.id as string;
    const test = await jsonCall(app, `/workspaces/${ws}/rules/${id}/test`, {
      method: 'POST',
      token,
      ws,
      body: { question: 'What is our release timeline?' },
    });
    expect(test.json.mode).toBe('use');
    expect(test.json.without_rule_answer).toHaveProperty('has_answer');
    expect(test.json.with_rule_answer).toHaveProperty('has_answer');
  });

  it('live ingest runs cleanly with an enabled store-phase shaping rule active (R2.a)', async () => {
    const { app, token, ws } = await setup();
    // An enabled store+shape rule → storeShapePolicy() injects it into the live
    // capture prompt. The ingest must still succeed and produce candidates
    // (the deterministic stub ignores the policy text; this guards the wiring).
    await jsonCall(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      ws,
      body: {
        instructions: 'Hide PII from customer call transcripts',
        scopes: ['team'],
        phases: ['store'],
        action: 'shape',
      },
    });
    const ing = await jsonCall(app, `/workspaces/${ws}/ingest`, {
      method: 'POST',
      token,
      ws,
      body: {
        source: 'We are killing the legacy reseller program.',
        source_kind: 'doc',
        source_ref: 'shaped.md',
      },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.candidates).toBeGreaterThan(0);
    // And these ARE persisted (real ingest, unlike the dry-run test endpoint).
    // Light auto-approves on ingest (no pending queue), so the persisted
    // state to check is 'approved', not 'pending'.
    const cands = await jsonCall(app, `/workspaces/${ws}/candidates?status=approved`, { token, ws });
    expect((cands.json.candidates ?? cands.json).length).toBeGreaterThan(0);
  });
});

// The old "curation-automation" describe block that used to live here (R2.b,
// §5.3a: auto_approve/auto_reject/surface actions driving a live-ingest
// `curation.case`/`auto_integrated` response + a per-document chat thread)
// tested a response shape and a `/curation/:doc` thread route that no longer
// exist — replaced by the routing-approval model (list_pending_routes /
// approve_route / choose_route / reject_route). Those three actions were later
// removed from the classifier and the rule TEST endpoint entirely (they never
// applied to a live document); every rule is a 'shape' rule now.
