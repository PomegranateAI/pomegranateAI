/**
 * Subscribe-to-Updates API surface (spec §6/§8, milestone U1). Exercises the
 * CRUD routes and the internal run-due driver end-to-end through the built app,
 * with the deterministic synth stub (no paid API). Confirms owner-scoping,
 * topic-only creation defaults, edit/pause/resume/delete, and target access.
 */
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StubEmbedder, embeddingToBlob } from '../../lib/embeddings.js';
import { sealedNodeEmbedding } from '../../__test_utils__/sealed-fixtures.js';

// Force the deterministic stub embedder so the inline first-run's topic
// relevance is reproducible: a node embedded from the same text as the topic
// scores cosine 1.0 and is always topical.
process.env.POMEGRANATE_EMBEDDER = 'stub';

/** Insert a node whose stub embedding matches `topic`, so the run reports it. */
async function seedTopicalNode(repo: any, ws: string, topic: string, id = 'bn1'): Promise<void> {
  const [vec] = await new StubEmbedder().embed([topic]);
  const nowIso = new Date().toISOString();
  repo.db
    .prepare(
      `INSERT INTO graph_nodes
         (id, workspace_id, type, status, data, embedding, created_at, updated_at, subgraph_id, visibility)
       VALUES (?, ?, 'decision', 'active', ?, ?, ?, ?, 'default', 'team')`,
    )
    .run(id, ws, JSON.stringify({ type: 'decision', title: `About ${topic}` }), await sealedNodeEmbedding(repo, ws, id, embeddingToBlob(vec!)), nowIso, nowIso);
}

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

// Each test gets its own DB + freshly-imported server module, so subscriptions
// from one test never leak into another's run-due sweep (the scheduler runs
// every due subscription in the DB).
let appSeq = 0;
async function loadApp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-updates-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
  return import('./server.js?updates=' + ++appSeq + '_' + Date.now());
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
  const { session } = await r2.json();
  return session as string;
}

async function call(
  app: any,
  method: string,
  p: string,
  opts: { token?: string; body?: unknown; internalSecret?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.internalSecret) headers['x-internal-secret'] = opts.internalSecret;
  const r = await app.request(p, {
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

describe('updates API', () => {
  it('creates from a topic alone, lists, edits, pauses/resumes, and deletes', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'owner@test.example');
    const wsRes = await call(app, 'POST', '/workspaces', { token, body: { name: 'W' } });
    expect(wsRes.status).toBe(200);
    const ws = wsRes.json.id as string;

    // Create — topic is the only field; defaults fill the rest.
    const created = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'competitor launches' },
    });
    expect(created.status).toBe(201);
    const sub = created.json.subscription;
    expect(sub.topic).toBe('competitor launches');
    expect(sub.medium).toBe('email');
    expect(sub.status).toBe('active');
    expect(sub.cadence_ms).toBe(7 * 24 * 60 * 60 * 1000); // weekly default
    expect(sub.targets).toEqual([{ workspace_id: ws, subgraph_id: 'default' }]);

    // List mine.
    const list = await call(app, 'GET', `/workspaces/${ws}/updates`, { token });
    expect(list.json.subscriptions).toHaveLength(1);

    // Edit cadence → clamped + next_run recomputed; edit topic.
    const patched = await call(app, 'PATCH', `/workspaces/${ws}/updates/${sub.id}`, {
      token,
      body: { cadence_ms: 1000, topic: 'enterprise deals' }, // 1s → clamped up to 1h min
    });
    expect(patched.status).toBe(200);
    expect(patched.json.subscription.cadence_ms).toBe(60 * 60 * 1000);
    expect(patched.json.subscription.topic).toBe('enterprise deals');

    // Pause → resume.
    expect((await call(app, 'POST', `/workspaces/${ws}/updates/${sub.id}/pause`, { token })).json.subscription.status).toBe('paused');
    expect((await call(app, 'POST', `/workspaces/${ws}/updates/${sub.id}/resume`, { token })).json.subscription.status).toBe('active');

    // Delete → gone.
    expect((await call(app, 'DELETE', `/workspaces/${ws}/updates/${sub.id}`, { token })).status).toBe(200);
    expect((await call(app, 'GET', `/workspaces/${ws}/updates`, { token })).json.subscriptions).toHaveLength(0);
  });

  it('honors bi-weekly / monthly cadences and clamps only past the 31d cap', async () => {
    // Regression for the #84 cadence change: the server cap was raised 7d -> 31d
    // so the "Every 2 weeks" / "Monthly" watches mint at their true cadence
    // instead of being silently clamped down to a week.
    const { app } = await loadApp();
    const token = await magic(app, 'cadence@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WC' } })).json.id;
    const DAY = 24 * 60 * 60 * 1000;

    // Bi-weekly (14d) and monthly (30d) are within the raised cap → kept exactly.
    const biweekly = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'competitor launches', cadence_ms: 14 * DAY },
    });
    expect(biweekly.status).toBe(201);
    expect(biweekly.json.subscription.cadence_ms).toBe(14 * DAY);

    const monthly = await call(app, 'PATCH', `/workspaces/${ws}/updates/${biweekly.json.subscription.id}`, {
      token,
      body: { cadence_ms: 30 * DAY },
    });
    expect(monthly.status).toBe(200);
    expect(monthly.json.subscription.cadence_ms).toBe(30 * DAY);

    // Anything past 31d is clamped to the cap, not accepted unbounded.
    const tooLong = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'enterprise deals', cadence_ms: 90 * DAY },
    });
    expect(tooLong.status).toBe(201);
    expect(tooLong.json.subscription.cadence_ms).toBe(31 * DAY);
  });

  it('rejects a missing topic and a target the owner cannot read', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'owner2@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'W2' } })).json.id;

    expect((await call(app, 'POST', `/workspaces/${ws}/updates`, { token, body: {} })).status).toBe(400);

    const bad = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'x', targets: [{ workspace_id: 'ws_stranger', subgraph_id: 'default' }] },
    });
    expect(bad.status).toBe(403);
  });

  it('does not let a non-owner read another user\'s subscription id', async () => {
    const { app } = await loadApp();
    const owner = await magic(app, 'a@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token: owner, body: { name: 'WA' } })).json.id;
    const sub = (await call(app, 'POST', `/workspaces/${ws}/updates`, { token: owner, body: { topic: 't' } })).json.subscription;

    // A stranger who is a member of the same workspace still can't read the
    // owner's subscription (owner-scoped), and a non-member is gated out.
    const stranger = await magic(app, 'b@test.example');
    const strangerWs = (await call(app, 'POST', '/workspaces', { token: stranger, body: { name: 'WB' } })).json.id;
    const res = await call(app, 'GET', `/workspaces/${strangerWs}/updates/${sub.id}`, { token: stranger });
    expect(res.status).toBe(404);
  });

  it('watches a folder by reference and rejects one the owner cannot read', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'multi@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'Home' } })).json.id;

    // A reference to a folder the owner is a member of resolves fine (their own
    // folder, by name). An unknown/foreign reference is refused.
    const ok = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'roadmap', target_refs: ['Home'] },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.subscription.targets).toEqual([{ workspace_id: ws, subgraph_id: 'default' }]);

    const bad = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'roadmap', target_refs: ['ws_nope_does_not_exist'] },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(String(bad.json.error)).toMatch(/couldn't watch/i);
  });

  it('drives due subscriptions through the internal run-due endpoint', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'runner@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WR' } })).json.id;
    const sub = (await call(app, 'POST', `/workspaces/${ws}/updates`, { token, body: { topic: 't' } })).json.subscription;

    // Force it due and give it something to report. Null the topic embedding so
    // relevance passes through — this test exercises the HTTP driver + delivery
    // wiring, not embedding similarity (covered in scheduler.test.ts).
    await repo.updateUpdateSubscription(sub.id, {
      next_run_at: '2000-01-01T00:00:00.000Z',
      watermark: '2000-01-01T00:00:00.000Z', // pin the window open (no now/now race)
      topic_embedding: null,
    });
    const nowIso = new Date().toISOString();
    repo.db
      .prepare(
        `INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at, subgraph_id, visibility)
         VALUES ('rn1', ?, 'decision', 'active', ?, ?, ?, 'default', 'team')`,
      )
      .run(ws, JSON.stringify({ type: 'decision', title: 'A change' }), nowIso, nowIso);

    // Without a configured secret the route does not exist; with one, the
    // secret is required.
    delete process.env.SURFACE_AGENT_SECRET;
    expect((await call(app, 'POST', '/internal/updates/run-due', {})).status).toBe(404);
    process.env.SURFACE_AGENT_SECRET = 'run-due-test-secret';
    expect((await call(app, 'POST', '/internal/updates/run-due', {})).status).toBe(403);
    expect((await call(app, 'POST', '/internal/updates/run-due', { internalSecret: 'wrong-secret-value!' })).status).toBe(403);
    const run = await call(app, 'POST', '/internal/updates/run-due', { internalSecret: 'run-due-test-secret' });
    delete process.env.SURFACE_AGENT_SECRET;
    expect(run.status).toBe(200);
    expect(run.json.ran).toBeGreaterThanOrEqual(1);

    // The delivery was kept (LoggingTransport in test env still records it).
    const owner = (await repo.findUserByEmail('runner@test.example'))!.id;
    const deliveries = await repo.listUpdateDeliveries({ owner_user_id: owner });
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0]!.delivered_at).toBeTruthy();
  });

  it('produces an immediate baseline first update on create (autonomous)', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'baseline@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WB' } })).json.id;
    // Something already in the folder → the baseline (watermark=null) first run
    // reports it right away, no waiting a full cadence.
    await seedTopicalNode(repo, ws, 'roadmap strategy');

    const created = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'roadmap strategy' },
    });
    expect(created.status).toBe(201);
    expect(created.json.first_run).toBeTruthy();
    expect(created.json.first_run.outcome).toBe('ok');

    // A delivery is already visible under "past updates", marked sent.
    const deliveries = await call(app, 'GET', `/workspaces/${ws}/updates/deliveries`, { token });
    expect(deliveries.json.deliveries).toHaveLength(1);
    expect(deliveries.json.deliveries[0].status).toBe('sent');
  });

  it('round-trips approval_mode and holds a review-mode update for approval', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'review@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WV' } })).json.id;
    await seedTopicalNode(repo, ws, 'competitor moves');

    // Create in review mode → the first update is held, not sent.
    const created = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'competitor moves', approval_mode: 'review' },
    });
    expect(created.status).toBe(201);
    expect(created.json.subscription.approval_mode).toBe('review');
    expect(created.json.first_run.outcome).toBe('pending');

    // It shows up pending, and the nav-badge count sees it.
    const deliveries = (await call(app, 'GET', `/workspaces/${ws}/updates/deliveries`, { token })).json.deliveries;
    expect(deliveries).toHaveLength(1);
    const did = deliveries[0].id;
    expect(deliveries[0].status).toBe('pending');
    expect((await call(app, 'GET', `/workspaces/${ws}/updates/pending-count`, { token })).json.count).toBe(1);

    // Approve → sent; pending count drops to 0.
    const sent = await call(app, 'POST', `/workspaces/${ws}/updates/delivery/${did}/send`, { token });
    expect(sent.status).toBe(200);
    expect(sent.json.delivery.status).toBe('sent');
    expect(sent.json.delivery.delivered_at).toBeTruthy();
    expect((await call(app, 'GET', `/workspaces/${ws}/updates/pending-count`, { token })).json.count).toBe(0);

    // Sending again is refused (no longer pending).
    const again = await call(app, 'POST', `/workspaces/${ws}/updates/delivery/${did}/send`, { token });
    expect(again.status).toBe(409);

    // PATCH can switch a watch back to autonomous.
    const patched = await call(app, 'PATCH', `/workspaces/${ws}/updates/${created.json.subscription.id}`, {
      token,
      body: { approval_mode: 'autonomous' },
    });
    expect(patched.json.subscription.approval_mode).toBe('autonomous');
  });

  it('discards a pending update without sending it', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'discard@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WD' } })).json.id;
    await seedTopicalNode(repo, ws, 'roadmap changes');

    const created = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'roadmap changes', approval_mode: 'review' },
    });
    const did = (await call(app, 'GET', `/workspaces/${ws}/updates/deliveries`, { token })).json.deliveries[0].id;

    const discarded = await call(app, 'POST', `/workspaces/${ws}/updates/delivery/${did}/discard`, { token });
    expect(discarded.status).toBe(200);
    expect(discarded.json.delivery.status).toBe('discarded');
    expect((await call(app, 'GET', `/workspaces/${ws}/updates/pending-count`, { token })).json.count).toBe(0);
  });

  it('tracks email opens (pixel) and clicks (redirect) without auth', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'eng@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WE' } })).json.id;
    const sub = (await call(app, 'POST', `/workspaces/${ws}/updates`, { token, body: { topic: 't' } })).json.subscription;
    const owner = (await repo.findUserByEmail('eng@test.example'))!.id;
    // Seed a delivery directly.
    const d = await repo.recordUpdateDelivery({
      subscription_id: sub.id,
      owner_user_id: owner,
      window_from: null,
      window_to: new Date().toISOString(),
      title: 'T',
      body: 'B',
      cited_node_ids: [],
      change_count: 1,
      medium: 'email',
    });

    // Open pixel — public, returns a gif, stamps opened_at.
    const pixel = await app.request(`/updates/track/open/${d.id}.gif`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get('content-type')).toBe('image/gif');
    expect((await repo.getUpdateDelivery(d.id))!.opened_at).toBeTruthy();

    // Click — public, 302 redirect, counts the click.
    const click = await app.request(`/updates/track/click/${d.id}`, { redirect: 'manual' });
    expect([301, 302]).toContain(click.status);
    expect((await repo.getUpdateDelivery(d.id))!.click_count).toBe(1);
  });

  // ── The 'give' work agent: broadcast my own work to a list of teammates ──
  // Same watches, same scheduler; the differences are the recipient list, the
  // own-folder-only scope, and the review-first default.

  it("creates a 'give' watch with many recipients and keeps the two agents' lists apart", async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'giver@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WG' } })).json.id;

    const give = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'what I shipped', kind: 'give', recipients: ['a@x.example', 'b@x.example'] },
    });
    expect(give.status).toBe(201);
    expect(give.json.subscription.kind).toBe('give');
    // Recipients ride `destination` as a comma-separated list.
    expect(give.json.subscription.destination).toBe('a@x.example,b@x.example');
    // A broadcast goes out under your name → it holds for approval by default.
    expect(give.json.subscription.approval_mode).toBe('review');

    const get = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'competitor launches' },
    });
    expect(get.json.subscription.kind).toBe('get');
    expect(get.json.subscription.approval_mode).toBe('autonomous'); // unchanged default

    // Each agent sees only its own watches; no kind → both (the old behaviour).
    const gives = await call(app, 'GET', `/workspaces/${ws}/updates?kind=give`, { token });
    expect(gives.json.subscriptions.map((s: any) => s.topic)).toEqual(['what I shipped']);
    const gets = await call(app, 'GET', `/workspaces/${ws}/updates?kind=get`, { token });
    expect(gets.json.subscriptions.map((s: any) => s.topic)).toEqual(['competitor launches']);
    expect((await call(app, 'GET', `/workspaces/${ws}/updates`, { token })).json.subscriptions).toHaveLength(2);
    expect((await call(app, 'GET', `/workspaces/${ws}/updates?kind=nope`, { token })).status).toBe(400);
  });

  it("pins a 'give' watch to the owner's own workspace, spanning every subgraph and ignoring target refs", async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'pinned@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WP' } })).json.id;
    const other = (await call(app, 'POST', '/workspaces', { token, body: { name: 'Other' } })).json.id;

    // A 'get' watch can reach the owner's other folder…
    const get = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 't', target_refs: [ws, other] },
    });
    expect(get.json.subscription.targets).toHaveLength(2);

    // A second subgraph in THIS workspace — the create form never asks the
    // caller to pick one, so a 'give' watch must span all of them, not just
    // whichever happened to be ambient in the UI when the form was submitted.
    const second = await call(app, 'POST', `/workspaces/${ws}/subgraphs`, {
      token,
      body: { profile_id: 'notes', name: 'Second' },
    });
    const secondSubgraphId = second.json.subgraph_id as string;

    // …a 'give' watch reports on THIS workspace's subgraphs only — it's a work
    // agent — but ALL of them, not one arbitrarily picked default.
    const give = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: { topic: 'my work', kind: 'give', recipients: ['a@x.example'], target_refs: [ws, other] },
    });
    expect(give.json.subscription.targets).toEqual(
      expect.arrayContaining([
        { workspace_id: ws, subgraph_id: 'default' },
        { workspace_id: ws, subgraph_id: secondSubgraphId },
      ]),
    );
    expect(give.json.subscription.targets).toHaveLength(2);
    expect(give.json.subscription.targets.every((t: any) => t.workspace_id === ws)).toBe(true);

    // And an edit can't re-open that scope either.
    const patched = await call(app, 'PATCH', `/workspaces/${ws}/updates/${give.json.subscription.id}`, {
      token,
      body: { target_refs: [ws, other] },
    });
    expect(patched.json.subscription.targets).toEqual(give.json.subscription.targets);
  });

  it('edits a broadcast\'s recipients', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'editrcp@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WE' } })).json.id;
    const sub = (
      await call(app, 'POST', `/workspaces/${ws}/updates`, {
        token,
        body: { topic: 'my work', kind: 'give', recipients: ['a@x.example'] },
      })
    ).json.subscription;

    const patched = await call(app, 'PATCH', `/workspaces/${ws}/updates/${sub.id}`, {
      token,
      body: { recipients: ['b@x.example', 'c@x.example'] },
    });
    expect(patched.json.subscription.destination).toBe('b@x.example,c@x.example');

    // Omitting recipients leaves them alone.
    const untouched = await call(app, 'PATCH', `/workspaces/${ws}/updates/${sub.id}`, {
      token,
      body: { cadence_ms: 2 * 60 * 60 * 1000 },
    });
    expect(untouched.json.subscription.destination).toBe('b@x.example,c@x.example');
  });

  it('sends a broadcast to every recipient', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'fanout@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token, body: { name: 'WF' } })).json.id;
    await seedTopicalNode(repo, ws, 'my shipped work');

    const created = await call(app, 'POST', `/workspaces/${ws}/updates`, {
      token,
      body: {
        topic: 'my shipped work',
        kind: 'give',
        recipients: ['a@x.example', 'b@x.example', 'c@x.example'],
        approval_mode: 'autonomous',
      },
    });
    expect(created.json.first_run.outcome).toBe('ok');

    // One delivery row, fanned out to all three (LoggingTransport in tests).
    const deliveries = (await call(app, 'GET', `/workspaces/${ws}/updates/deliveries`, { token })).json.deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('sent');
  });

  it('saves, reuses, and deletes recipient lists — owner-scoped', async () => {
    const { app } = await loadApp();
    const mine = await magic(app, 'lists@test.example');
    const theirs = await magic(app, 'other@test.example');
    const ws = (await call(app, 'POST', '/workspaces', { token: mine, body: { name: 'WL' } })).json.id;

    const saved = await call(app, 'POST', `/workspaces/${ws}/recipient-lists`, {
      token: mine,
      body: { name: 'Design team', recipients: ['a@x.example', 'b@x.example', 'a@x.example'] },
    });
    expect(saved.status).toBe(201);
    expect(saved.json.list.recipients).toEqual(['a@x.example', 'b@x.example']); // de-duped

    // Re-saving the same name overwrites rather than making a twin.
    const again = await call(app, 'POST', `/workspaces/${ws}/recipient-lists`, {
      token: mine,
      body: { name: 'Design team', recipients: ['c@x.example'] },
    });
    expect(again.json.list.id).toBe(saved.json.list.id);
    const listed = await call(app, 'GET', `/workspaces/${ws}/recipient-lists`, { token: mine });
    expect(listed.json.lists).toHaveLength(1);
    expect(listed.json.lists[0].recipients).toEqual(['c@x.example']);

    // A list needs a name and at least one recipient.
    expect((await call(app, 'POST', `/workspaces/${ws}/recipient-lists`, { token: mine, body: { name: 'X', recipients: [] } })).status).toBe(400);

    // Another member of the same folder never sees my lists, and can't delete one.
    await call(app, 'POST', `/workspaces/${ws}/members`, { token: mine, body: { email: 'other@test.example' } });
    expect((await call(app, 'GET', `/workspaces/${ws}/recipient-lists`, { token: theirs })).json.lists).toHaveLength(0);
    expect((await call(app, 'DELETE', `/workspaces/${ws}/recipient-lists/${saved.json.list.id}`, { token: theirs })).status).toBe(404);

    expect((await call(app, 'DELETE', `/workspaces/${ws}/recipient-lists/${saved.json.list.id}`, { token: mine })).status).toBe(200);
    expect((await call(app, 'GET', `/workspaces/${ws}/recipient-lists`, { token: mine })).json.lists).toHaveLength(0);
  });
});
