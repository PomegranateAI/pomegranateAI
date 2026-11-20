/**
 * Subscribe-to-Updates quality gate (spec §9 / U4).
 *
 * Encodes the acceptance thresholds for `update-digest.md` as runnable,
 * DETERMINISTIC checks — like the wiki gate, they run in CI with no API key by
 * exercising the relevance filter + the synthesis fallback. The same fixture
 * feeds live-LLM scoring of the real prompt when a key is present (see
 * evals/results/updates-eval.md).
 *
 * The stub embedder hashes the whole text, so we set the topic vector and the
 * on-topic nodes' embeddings from the SAME string (cosine 1.0, above the floor)
 * and the off-topic nodes' from a different string (≈orthogonal, below it).
 * That makes recall (all on-topic reported) and precision (no off-topic noise)
 * deterministic, alongside grounding (every claim cites a real node) and
 * empty-correctness (nothing topical → no send).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import {
  getEmbedder,
  embeddingToBlob,
  StubEmbedder,
  __setEmbedderForTesting,
} from '../../lib/embeddings.js';
import { changesSince } from '../lib/change-window.js';
import { rankChangesByTopic } from './relevance.js';
import { fallbackDigest } from './synthesize.js';
import { createUpdateScheduler } from './scheduler.js';
import { sealedNodeEmbedding } from '../../__test_utils__/sealed-fixtures.js';

let db: Database.Database;
let repo: Repo;
let ws: string;
let ownerId: string;

const WATERMARK = '2026-07-01T00:00:00.000Z';
const AFTER = '2026-07-05T00:00:00.000Z';
const ON_TOPIC = 'competitor launches and release dates';
const OFF_TOPIC = 'office snack budget and kitchen supplies';

beforeEach(async () => {
  // Pin the deterministic stub embedder so the gate is reproducible regardless
  // of an ambient OPENAI_API_KEY (on-topic vectors are identical to the topic;
  // off-topic vectors hash-orthogonal to it).
  __setEmbedderForTesting(new StubEmbedder());
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  const w = await repo.createWorkspace({ name: 'Eval', owner_email: 'eval@test.example' });
  ws = w.id;
  ownerId = (await repo.findUserByEmail('eval@test.example'))!.id;
});

afterEach(() => {
  __setEmbedderForTesting(null); // restore the env-selected embedder
});

async function embed(text: string): Promise<Float32Array> {
  const [v] = await getEmbedder().embed([text]);
  return v!;
}

async function insertNode(id: string, title: string, seedText: string): Promise<void> {
  const emb = await sealedNodeEmbedding(repo, ws, id, embeddingToBlob(await embed(seedText)));
  db.prepare(
    `INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at, subgraph_id, visibility, embedding)
     VALUES (?, ?, 'decision', 'active', ?, ?, ?, 'default', 'team', ?)`,
  ).run(
    id,
    ws,
    JSON.stringify({ type: 'decision', title, summary: title }),
    AFTER,
    AFTER,
    emb,
  );
}

/** The labelled fixture: 3 on-topic + 2 off-topic nodes, all after the watermark. */
async function seedFixture(): Promise<{ onTopic: string[]; offTopic: string[]; topicVec: Float32Array }> {
  const onTopic = ['pr1', 'pr2', 'pr3'];
  const offTopic = ['sn1', 'sn2'];
  for (const id of onTopic) await insertNode(id, `Pricing change ${id}`, ON_TOPIC);
  for (const id of offTopic) await insertNode(id, `Snack change ${id}`, OFF_TOPIC);
  return { onTopic, offTopic, topicVec: await embed(ON_TOPIC) };
}

describe('updates quality gate (deterministic, CI)', () => {
  it('RECALL + PRECISION: the relevance filter keeps every on-topic change and drops off-topic noise (≥ 0.99)', async () => {
    const { onTopic, offTopic, topicVec } = await seedFixture();
    const win = await changesSince(repo, { workspace_id: ws, subgraph_id: 'default' }, WATERMARK, {
      viewer_user_id: ownerId,
    });
    expect(win.nodes).toHaveLength(onTopic.length + offTopic.length);

    const { topical } = await rankChangesByTopic(repo, ws, topicVec, win.nodes);
    const kept = new Set(topical.map((n) => n.id));

    const recall = onTopic.filter((id) => kept.has(id)).length / onTopic.length;
    const precision = topical.filter((n) => onTopic.includes(n.id)).length / (topical.length || 1);
    expect(recall).toBeGreaterThanOrEqual(0.99);
    expect(precision).toBeGreaterThanOrEqual(0.99);
    expect(offTopic.some((id) => kept.has(id))).toBe(false);
  });

  it('GROUNDING: every claim in a synthesized update cites a real active node (≥ 0.99)', async () => {
    const { onTopic, topicVec } = await seedFixture();
    const win = await changesSince(repo, { workspace_id: ws, subgraph_id: 'default' }, WATERMARK, {
      viewer_user_id: ownerId,
    });
    const { topical } = await rankChangesByTopic(repo, ws, topicVec, win.nodes);
    const digest = fallbackDigest({
      topic: 'competitor launches',
      window: { from: WATERMARK, to: '2026-07-08T00:00:00.000Z' },
      nodes: topical.map((n) => ({ id: n.id, title: String(n.data.title ?? n.id), snippet: '' })),
      documents: [],
      resolvedCandidates: { approved: 0, rejected: 0 },
    });

    const activeIds = new Set(
      (db.prepare(`SELECT id FROM graph_nodes WHERE workspace_id = ? AND status = 'active'`).all(ws) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    expect(digest.is_empty).toBe(false);
    expect(digest.cited_node_ids.length).toBeGreaterThan(0);
    const grounded = digest.cited_node_ids.filter((id) => activeIds.has(id)).length / digest.cited_node_ids.length;
    expect(grounded).toBeGreaterThanOrEqual(0.99);
    // Every on-topic node is represented in the update.
    for (const id of onTopic) expect(digest.cited_node_ids).toContain(id);
  });

  it('EMPTY-CORRECTNESS: a window with only off-topic change sends nothing and advances the watermark', async () => {
    // Only off-topic nodes change.
    await insertNode('sn9', 'Snack change', OFF_TOPIC);
    const topicVec = await embed(ON_TOPIC);
    const sub = await repo.createUpdateSubscription({
      owner_user_id: ownerId,
      topic: 'competitor launches',
      topic_embedding: topicVec,
      targets: [{ workspace_id: ws, subgraph_id: 'default' }],
      cadence_ms: 3_600_000,
      medium: 'email',
      destination: 'eval@test.example',
      next_run_at: '2026-07-08T00:00:00.000Z',
    });
    await repo.updateUpdateSubscription(sub.id, { watermark: WATERMARK });

    const sched = createUpdateScheduler({ repo, now: () => new Date('2026-07-09T00:00:00.000Z') });
    const report = await sched.runSubscription((await repo.getUpdateSubscription(sub.id))!);

    expect(report.outcome).toBe('empty');
    expect(await repo.listUpdateDeliveries({ owner_user_id: ownerId })).toHaveLength(0);
    expect((await repo.getUpdateSubscription(sub.id))!.watermark).toBe('2026-07-09T00:00:00.000Z');
  });
});
