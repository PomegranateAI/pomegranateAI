/**
 * Visibility regression suite for the day-one audit and web feedback
 * (security audit, 2026-11).
 *
 * One directory: an owner, two plain members (alice, bob) and a
 * workspace_admin (carol). The owner holds two team notes; alice holds a
 * private note and an only_me note. Edges join team↔team, team→private and
 * private→only_me. Asserts on what the TestSynthStub's `feedback` received:
 * the graph and the edges a run sends to the model must be the requester's
 * aiRead view, and day-one reports are readable by their requester or an
 * owner-tier user only.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-d1-vis-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function magic(app: any, email: string): Promise<string> {
  const r1 = await app.request('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' } });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: j1.dev_code }), headers: { 'content-type': 'application/json' } });
  return (await r2.json()).session as string;
}
async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, { method: opts.method ?? 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const N = { teamA: 'vis-team-a', teamB: 'vis-team-b', alicePriv: 'vis-alice-priv', aliceOnlyMe: 'vis-alice-onlyme' };
const note = (id: string, body: string) => ({
  id,
  type: 'note',
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  status: 'active',
  summary: body,
  body,
});

describe('day-one audit + feedback visibility', () => {
  let app: any;
  let repo: any;
  let ws: any;
  const sess: Record<'owner' | 'alice' | 'bob' | 'carol', string> = {} as any;

  /** Run `fn`, returning every `feedback` input the stub received meanwhile. */
  async function captureFeedback(fn: () => Promise<unknown>) {
    const spy = vi.spyOn(TestSynthStub, 'feedback');
    await fn();
    const inputs = spy.mock.calls.map((c) => c[0] as any);
    spy.mockRestore();
    return inputs;
  }
  const nodeIds = (input: any) => new Set((input.graph as any[]).map((n) => n.id));
  const edgePairs = (input: any) => new Set(((input.edges ?? []) as any[]).map((e) => `${e.src}->${e.dst}`));

  beforeAll(async () => {
    ({ app, repo } = (await import('../api/server.js?d1vis=' + Date.now())) as any);
    sess.owner = await magic(app, 'owner@d1vis.test');
    ws = (await call(app, '/workspaces', { method: 'POST', body: { name: 'Vis', profile_id: 'notes' }, token: sess.owner })).json;
    const alice = (await repo.findOrCreateUser('alice@d1vis.test')).id;
    const bob = (await repo.findOrCreateUser('bob@d1vis.test')).id;
    const carol = (await repo.findOrCreateUser('carol@d1vis.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: alice, role: 'member' });
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });
    await repo.addMember({ workspace_id: ws.id, user_id: carol, role: 'workspace_admin' });
    sess.alice = await magic(app, 'alice@d1vis.test');
    sess.bob = await magic(app, 'bob@d1vis.test');
    sess.carol = await magic(app, 'carol@d1vis.test');

    for (const [id, body] of [
      [N.teamA, 'team plan alpha'],
      [N.teamB, 'team plan beta'],
      [N.alicePriv, 'alice private salary note'],
      [N.aliceOnlyMe, 'alice only-me diary'],
    ] as const) {
      const r = await call(app, `/workspaces/${ws.id}/graph`, { method: 'POST', body: note(id, body), token: sess.owner });
      expect(r.status).toBe(200);
    }
    await repo.setNodeVisibility(ws.id, N.teamA, 'team');
    await repo.setNodeVisibility(ws.id, N.teamB, 'team');
    await repo.setNodeVisibility(ws.id, N.alicePriv, 'private');
    await repo.setNodeVisibility(ws.id, N.aliceOnlyMe, 'only_me');
    // Alice owns her two notes (set directly: setNodeVisibility never
    // overwrites an existing owner).
    await repo.sql.exec(
      `UPDATE graph_nodes SET owner_user_id = ? WHERE workspace_id = ? AND id IN (?, ?)`,
      [alice, ws.id, N.alicePriv, N.aliceOnlyMe],
    );

    // Edges inserted directly: the `notes` profile declares no edge kinds,
    // and the code under test only reads them.
    const now = new Date().toISOString();
    for (const [i, [src, dst]] of ([
      [N.teamA, N.teamB],
      [N.teamA, N.alicePriv],
      [N.alicePriv, N.aliceOnlyMe],
    ] as const).entries()) {
      await repo.sql.exec(
        `INSERT INTO graph_edges (id, workspace_id, src, dst, kind, status, created_by, created_at, updated_at, subgraph_id)
         VALUES (?, ?, ?, ?, 'relates_to', 'active', 'manual', ?, ?, 'default')`,
        [`e_vis_${i}`, ws.id, src, dst, now, now],
      );
    }
  }, 120_000);

  afterEach(() => vi.restoreAllMocks());

  it("a member's day-one audit never receives another member's private or only_me node", async () => {
    let res: any;
    const inputs = await captureFeedback(async () => {
      res = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
        method: 'POST', token: sess.bob, body: { deliverables: [{ content: 'A plan for the team.' }] },
      });
    });
    expect(res.status).toBe(200);
    expect(inputs).toHaveLength(1);
    expect(nodeIds(inputs[0])).toEqual(new Set([N.teamA, N.teamB]));
    // Only the edge whose both ends bob can see.
    expect(edgePairs(inputs[0])).toEqual(new Set([`${N.teamA}->${N.teamB}`]));
  });

  it("the requester's own audit gets their private node but not their only_me node (aiRead)", async () => {
    const inputs = await captureFeedback(async () => {
      const r = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
        method: 'POST', token: sess.alice, body: { deliverables: [{ content: 'A plan for the team.' }] },
      });
      expect(r.status).toBe(200);
    });
    expect(nodeIds(inputs[0])).toEqual(new Set([N.teamA, N.teamB, N.alicePriv]));
    expect(edgePairs(inputs[0])).toEqual(new Set([`${N.teamA}->${N.teamB}`, `${N.teamA}->${N.alicePriv}`]));
  });

  it('web feedback (POST /reviews) drops edges that touch a node hidden from the viewer', async () => {
    const bobInputs = await captureFeedback(async () => {
      const r = await call(app, `/workspaces/${ws.id}/reviews`, {
        method: 'POST', token: sess.bob, body: { deliverable: 'A plan for the team.' },
      });
      expect(r.status).toBe(200);
    });
    expect(bobInputs).toHaveLength(1);
    expect(nodeIds(bobInputs[0])).toEqual(new Set([N.teamA, N.teamB]));
    expect(edgePairs(bobInputs[0])).toEqual(new Set([`${N.teamA}->${N.teamB}`]));

    const aliceInputs = await captureFeedback(async () => {
      const r = await call(app, `/workspaces/${ws.id}/reviews`, {
        method: 'POST', token: sess.alice, body: { deliverable: 'A plan for the team.' },
      });
      expect(r.status).toBe(200);
    });
    expect(edgePairs(aliceInputs[0])).toEqual(new Set([`${N.teamA}->${N.teamB}`, `${N.teamA}->${N.alicePriv}`]));
  });

  it("member B can neither list nor get member A's report; an admin and the owner can", async () => {
    const aRun = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      method: 'POST', token: sess.alice, body: { deliverables: [{ content: 'Alice audit.' }] },
    });
    expect(aRun.status).toBe(200);
    const aId = aRun.json.id as string;
    const bRun = await call(app, `/workspaces/${ws.id}/day-1-audit`, {
      method: 'POST', token: sess.bob, body: { deliverables: [{ content: 'Bob audit.' }] },
    });
    const bId = bRun.json.id as string;

    const listIds = async (t: string) =>
      ((await call(app, `/workspaces/${ws.id}/day-1-audit`, { token: t })).json.reports as any[]).map((r) => r.id);

    // Bob: his own reports only, never alice's.
    const bobList = await listIds(sess.bob);
    expect(bobList).toContain(bId);
    expect(bobList).not.toContain(aId);
    expect((await call(app, `/workspaces/${ws.id}/day-1-audit/${aId}`, { token: sess.bob })).status).toBe(404);
    expect((await call(app, `/workspaces/${ws.id}/day-1-audit/${bId}`, { token: sess.bob })).status).toBe(200);

    // Alice: her own, not bob's.
    const aliceList = await listIds(sess.alice);
    expect(aliceList).toContain(aId);
    expect(aliceList).not.toContain(bId);
    expect((await call(app, `/workspaces/${ws.id}/day-1-audit/${aId}`, { token: sess.alice })).status).toBe(200);

    // workspace_admin and owner: everything.
    for (const t of [sess.carol, sess.owner]) {
      const all = await listIds(t);
      expect(all).toEqual(expect.arrayContaining([aId, bId]));
      const got = await call(app, `/workspaces/${ws.id}/day-1-audit/${aId}`, { token: t });
      expect(got.status).toBe(200);
      expect(got.json.id).toBe(aId);
    }
  });

  it('a member with no reports gets an empty list', async () => {
    const dan = (await repo.findOrCreateUser('dan@d1vis.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: dan, role: 'member' });
    const danSess = await magic(app, 'dan@d1vis.test');
    const r = await call(app, `/workspaces/${ws.id}/day-1-audit`, { token: danSess });
    expect(r.status).toBe(200);
    expect(r.json.reports).toEqual([]);
  });
});
