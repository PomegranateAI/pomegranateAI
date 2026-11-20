/**
 * Update scheduler + change-window unit tests (spec §12, milestone U1).
 *
 * Mirrors the Slack scheduler.test discipline: no timer, no network — inject a
 * fixed clock, a fake transport, and (mostly) a deterministic synthesize, then
 * assert the run loop's watermark / backoff / empty-window / delivery behaviour
 * directly through runDueOnce()/runSubscription().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { changesSince } from '../lib/change-window.js';
import { createUpdateScheduler, ERROR_BACKOFF_CAP_MS } from './scheduler.js';
import type { UpdateTransport, UpdateMessage } from './transport.js';
import type { UpdateDigest, UpdateDigestInput } from './synthesize.js';

let db: Database.Database;
let repo: Repo;
let wsId: string;
let ownerId: string;

const WATERMARK = '2026-07-01T00:00:00.000Z';
const CLOCK = new Date('2026-07-08T12:00:00.000Z');
const CADENCE = 60 * 60 * 1000; // 1h

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  const ws = await repo.createWorkspace({ name: 'W', owner_email: 'owner@test' });
  wsId = ws.id;
  ownerId = (await repo.findUserByEmail('owner@test'))!.id;
});

/** Insert an active node into the default subgraph with a given updated_at. */
function insertNode(
  id: string,
  updatedAt: string,
  opts?: { visibility?: 'team' | 'private' | 'only_me'; owner?: string; title?: string },
): void {
  db.prepare(
    `INSERT INTO graph_nodes
       (id, workspace_id, type, status, data, created_at, updated_at, subgraph_id, visibility, owner_user_id)
     VALUES (?, ?, 'decision', 'active', ?, ?, ?, 'default', ?, ?)`,
  ).run(
    id,
    wsId,
    JSON.stringify({ type: 'decision', title: opts?.title ?? `Decision ${id}`, summary: 'a change' }),
    updatedAt,
    updatedAt,
    opts?.visibility ?? 'team',
    opts?.owner ?? null,
  );
}

/** A subscription due now, watermarked at WATERMARK, email to owner default. */
async function makeDueSub(overrides?: {
  medium?: 'email' | 'slack';
  targets?: Array<{ workspace_id: string; subgraph_id: string }>;
  approval_mode?: 'autonomous' | 'review';
  kind?: 'get' | 'give';
  destination?: string | null;
}) {
  const sub = await repo.createUpdateSubscription({
    owner_user_id: ownerId,
    topic: 'roadmap',
    topic_embedding: null, // null → relevance passthrough (deterministic)
    targets: overrides?.targets ?? [{ workspace_id: wsId, subgraph_id: 'default' }],
    cadence_ms: CADENCE,
    medium: overrides?.medium ?? 'email',
    kind: overrides?.kind ?? 'get',
    destination: overrides?.destination ?? null,
    approval_mode: overrides?.approval_mode ?? 'autonomous',
    next_run_at: '2026-07-08T00:00:00.000Z', // in the past relative to CLOCK → due
  });
  await repo.updateUpdateSubscription(sub.id, { watermark: WATERMARK });
  return (await repo.getUpdateSubscription(sub.id))!;
}

class FakeTransport implements UpdateTransport {
  readonly medium = 'email' as const;
  sent: UpdateMessage[] = [];
  constructor(private readonly fail = false) {}
  async send(msg: UpdateMessage): Promise<void> {
    if (this.fail) throw new Error('transport boom');
    this.sent.push(msg);
  }
}

/** Deterministic synth: non-empty iff there are changes; cites the node ids. */
const fakeSynth = async (input: UpdateDigestInput): Promise<UpdateDigest> => {
  const has = input.nodes.length > 0 || input.documents.length > 0;
  return {
    title: `${input.topic} update`,
    body: has ? `Changed: ${input.nodes.map((n) => n.title).join(', ')}` : '',
    cited_node_ids: input.nodes.map((n) => n.id),
    is_empty: !has,
  };
};

describe('changesSince', () => {
  it('includes only nodes strictly after the watermark (exclusive boundary)', async () => {
    insertNode('n_before', '2026-06-30T00:00:00.000Z');
    insertNode('n_at', WATERMARK); // exactly at the boundary → excluded
    insertNode('n_after', '2026-07-05T00:00:00.000Z');
    const win = await changesSince(repo, { workspace_id: wsId, subgraph_id: 'default' }, WATERMARK, {
      viewer_user_id: ownerId,
    });
    const ids = win.nodes.map((n) => n.id);
    expect(ids).toEqual(['n_after']);
  });

  it('excludes only_me nodes under aiRead', async () => {
    insertNode('n_team', '2026-07-05T00:00:00.000Z', { visibility: 'team' });
    insertNode('n_secret', '2026-07-06T00:00:00.000Z', { visibility: 'only_me', owner: ownerId });
    const win = await changesSince(repo, { workspace_id: wsId, subgraph_id: 'default' }, WATERMARK, {
      viewer_user_id: ownerId,
      aiRead: true,
    });
    expect(win.nodes.map((n) => n.id)).toEqual(['n_team']);
  });
});

describe('update scheduler', () => {
  it('runs a due subscription, delivers, and advances the watermark on success', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    const reports = await sched.runDueOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome).toBe('ok');

    // Delivered exactly once, to the owner's account email.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('owner@test');

    // A delivery row exists, delivered, citing the changed node.
    const deliveries = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.delivered_at).toBeTruthy();
    expect(deliveries[0]!.cited_node_ids).toContain('n1');

    // Watermark advanced to the run time; next run one cadence out; backoff reset.
    const after = (await repo.getUpdateSubscription(sub.id))!;
    expect(after.watermark).toBe(CLOCK.toISOString());
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + CADENCE).toISOString());
    expect(after.fail_count).toBe(0);
  });

  it('sends no open pixel and an untracked app link by default', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
      appBaseUrl: 'https://app.example',
    });
    await sched.runSubscription(sub);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].openPixelUrl).toBeUndefined();
    expect(transport.sent[0].link).toBe('https://app.example/#updates');
  });

  it('adds the open pixel and click redirect only when tracking is opted in', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
      appBaseUrl: 'https://app.example',
      trackEngagement: true,
    });
    await sched.runSubscription(sub);
    expect(transport.sent[0].openPixelUrl).toMatch(/^https:\/\/app\.example\/api\/updates\/track\/open\/.+\.gif$/);
    expect(transport.sent[0].link).toMatch(/^https:\/\/app\.example\/api\/updates\/track\/click\//);
  });

  it('does not pick up a subscription that is not yet due', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    await repo.updateUpdateSubscription(sub.id, { next_run_at: '2026-07-09T00:00:00.000Z' }); // future
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, synthesize: fakeSynth, now: () => CLOCK });
    const reports = await sched.runDueOnce();
    expect(reports).toHaveLength(0);
    expect(transport.sent).toHaveLength(0);
  });

  it('sends nothing on an empty window but still advances the watermark', async () => {
    // No node changes after the watermark.
    const sub = await makeDueSub();
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, synthesize: fakeSynth, now: () => CLOCK });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('empty');
    expect(transport.sent).toHaveLength(0);
    expect(await repo.listUpdateDeliveries({ owner_user_id: ownerId })).toHaveLength(0);

    const after = (await repo.getUpdateSubscription(sub.id))!;
    expect(after.watermark).toBe(CLOCK.toISOString()); // advanced
    expect(after.fail_count).toBe(0);
  });

  it("a 'give' broadcast still sends a no-news update on an empty window", async () => {
    // No node changes after the watermark — same setup as the 'get' empty test
    // above, but a 'give' broadcast is a status update to teammates, so silence
    // isn't the safe default: it should send a "nothing to report" email rather
    // than a silent no-op.
    const sub = await makeDueSub({ kind: 'give', destination: 'a@x.example' });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, synthesize: fakeSynth, now: () => CLOCK });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('ok');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.body).toMatch(/no updates/i);

    const deliveries = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('sent');
    expect(deliveries[0]!.cited_node_ids).toEqual([]);

    const after = (await repo.getUpdateSubscription(sub.id))!;
    expect(after.watermark).toBe(CLOCK.toISOString()); // advanced, same as the 'get' path
    expect(after.fail_count).toBe(0);
  });

  it('on delivery failure: keeps the watermark, bumps fail_count, and backs off', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    const transport = new FakeTransport(true); // throws on send
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, synthesize: fakeSynth, now: () => CLOCK });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('error');

    const after = (await repo.getUpdateSubscription(sub.id))!;
    expect(after.watermark).toBe(WATERMARK); // NOT advanced — window never dropped
    expect(after.fail_count).toBe(1);
    // First failure backs off one cadence out (2^0 * cadence).
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + CADENCE).toISOString());

    // Second consecutive failure backs off exponentially (2^1 * cadence).
    const report2 = await sched.runSubscription((await repo.getUpdateSubscription(sub.id))!);
    expect(report2.outcome).toBe('error');
    const after2 = (await repo.getUpdateSubscription(sub.id))!;
    expect(after2.fail_count).toBe(2);
    const expectedDelay = Math.min(CADENCE * 2, ERROR_BACKOFF_CAP_MS);
    expect(after2.next_run_at).toBe(new Date(CLOCK.getTime() + expectedDelay).toISOString());
    // No delivered rows were left behind by the failures.
    expect(await repo.listUpdateDeliveries({ owner_user_id: ownerId })).toHaveLength(0);
  });

  it('drops a target the owner is no longer a member of', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    // Target a foreign workspace the owner cannot read → the run finds no
    // readable target, so nothing topical, so an empty (advance-only) run.
    const other = await repo.createWorkspace({ name: 'Other', owner_email: 'stranger@test' });
    const sub = await makeDueSub({ targets: [{ workspace_id: other.id, subgraph_id: 'default' }] });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, synthesize: fakeSynth, now: () => CLOCK });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('empty');
    expect(transport.sent).toHaveLength(0);
  });

  it('uses the real synthesis fallback to produce a grounded, cited update', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z', { title: 'Shipped dark mode' });
    const sub = await makeDueSub();
    const transport = new FakeTransport();
    // No injected synthesize → exercises synthesizeUpdate()'s deterministic
    // fallback (no structured LLM wired in tests).
    const sched = createUpdateScheduler({ repo, transports: { email: transport }, now: () => CLOCK });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('ok');
    const [delivery] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(delivery!.body).toContain('Shipped dark mode');
    expect(delivery!.cited_node_ids).toContain('n1'); // grounding: cites a real node
  });

  it('delivers via the Slack transport to the owner’s DM when medium is slack', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    // Link a Slack identity to the owner so the DM target resolves.
    db.prepare(
      `INSERT INTO user_identities (id, user_id, kind, team_id, external_id, handle, created_at)
       VALUES ('uid_o', ?, 'slack', 'T1', 'U777', 'owner', ?)`,
    ).run(ownerId, CLOCK.toISOString());
    const sub = await makeDueSub({ medium: 'slack' });
    const slack = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { slack },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('ok');
    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]!.to).toBe('U777'); // owner's Slack id → DM
    const [d] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(d!.medium).toBe('slack');
    expect(d!.delivered_at).toBeTruthy();
  });

  it('records an error (no advance) when a slack subscription has no linked identity', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub({ medium: 'slack' }); // owner has no slack identity
    const sched = createUpdateScheduler({ repo, transports: { slack: new FakeTransport() }, synthesize: fakeSynth, now: () => CLOCK });
    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('error');
    expect((await repo.getUpdateSubscription(sub.id))!.watermark).toBe(WATERMARK); // not advanced
  });

  it('review mode: holds the update as pending, notifies, and does not deliver it', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z', { title: 'Shipped dark mode' });
    const sub = await makeDueSub({ approval_mode: 'review' });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('pending');

    // A PENDING delivery row exists, not yet delivered.
    const [d] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(d!.status).toBe('pending');
    expect(d!.delivered_at).toBeFalsy();
    expect(d!.cited_node_ids).toContain('n1');
    expect(await repo.countPendingDeliveries(ownerId)).toBe(1);

    // The owner is notified (a ping, not the update body).
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.title).toContain('ready to review');

    // The window is captured: watermark advanced, backoff reset.
    const after = (await repo.getUpdateSubscription(sub.id))!;
    expect(after.watermark).toBe(CLOCK.toISOString());
    expect(after.fail_count).toBe(0);
  });

  it('sendPendingDelivery: delivers an approved pending update and marks it sent', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z', { title: 'Shipped dark mode' });
    const sub = await makeDueSub({ approval_mode: 'review' });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });
    await sched.runSubscription(sub);
    const [pendingD] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    transport.sent = []; // ignore the notification; assert only the approved send

    const report = await sched.sendPendingDelivery(pendingD!.id);
    expect(report.outcome).toBe('ok');

    // The update body was delivered to the owner's email.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('owner@test');
    expect(transport.sent[0]!.body).toContain('Shipped dark mode');

    const after = (await repo.getUpdateDelivery(pendingD!.id))!;
    expect(after.status).toBe('sent');
    expect(after.delivered_at).toBeTruthy();
    expect(await repo.countPendingDeliveries(ownerId)).toBe(0);
  });

  it('sendPendingDelivery: refuses a delivery that is not pending', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub(); // autonomous → the delivery is already sent
    const sched = createUpdateScheduler({
      repo,
      transports: { email: new FakeTransport() },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });
    await sched.runSubscription(sub);
    const [sent] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    const report = await sched.sendPendingDelivery(sent!.id);
    expect(report.outcome).toBe('error');
    expect(report.error).toContain('not pending');
  });

  it('marks a delivery viewed exactly once opened, setting opened_at', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub();
    const sched = createUpdateScheduler({ repo, transports: { email: new FakeTransport() }, synthesize: fakeSynth, now: () => CLOCK });
    await sched.runSubscription(sub);
    const [d] = await repo.listUpdateDeliveries({ owner_user_id: ownerId });
    expect(d!.view_count).toBe(0);
    await repo.markUpdateDeliveryViewed(d!.id);
    await repo.markUpdateDeliveryViewed(d!.id);
    const after = (await repo.getUpdateDelivery(d!.id))!;
    expect(after.view_count).toBe(2);
    expect(after.opened_at).toBeTruthy();
  });

  // ── The 'give' agent's broadcast ───────────────────────────────────────────

  it('fans one broadcast out to every recipient', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub({ kind: 'give', destination: 'a@x.example,b@x.example,c@x.example' });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('ok');
    // One update, one delivery row, three sends — same body to each.
    expect(transport.sent.map((m) => m.to)).toEqual(['a@x.example', 'b@x.example', 'c@x.example']);
    expect(new Set(transport.sent.map((m) => m.body)).size).toBe(1);
    expect(await repo.listUpdateDeliveries({ owner_user_id: ownerId })).toHaveLength(1);
  });

  it('pings the OWNER — not the recipients — to approve a review-mode broadcast', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub({
      kind: 'give',
      approval_mode: 'review',
      destination: 'teammate@x.example',
    });
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    const report = await sched.runSubscription(sub);
    expect(report.outcome).toBe('pending');
    // The teammate must not hear about it until the owner approves — the only
    // message out is the approval ping, and it goes to the owner's own address.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('owner@test');
    expect(transport.sent[0]!.title).toMatch(/ready to review/i);

    // Approving then sends the real update to the recipient.
    const delivery = (await repo.listUpdateDeliveries({ owner_user_id: ownerId }))[0]!;
    expect(delivery.status).toBe('pending');
    const sent = await sched.sendPendingDelivery(delivery.id);
    expect(sent.outcome).toBe('ok');
    expect(transport.sent[1]!.to).toBe('teammate@x.example');
  });

  it('still falls back to the owner when a watch names no destination', async () => {
    insertNode('n1', '2026-07-05T00:00:00.000Z');
    const sub = await makeDueSub(); // destination null → owner's account email
    const transport = new FakeTransport();
    const sched = createUpdateScheduler({
      repo,
      transports: { email: transport },
      synthesize: fakeSynth,
      now: () => CLOCK,
    });

    expect((await sched.runSubscription(sub)).outcome).toBe('ok');
    expect(transport.sent.map((m) => m.to)).toEqual(['owner@test']);
  });
});
