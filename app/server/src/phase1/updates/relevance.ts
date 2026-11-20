/**
 * Topic relevance for Subscribe to Updates (spec §5.3, decision D2).
 *
 * Cheap-first: rank the changed node set by cosine similarity to the stored
 * topic embedding and keep those above a similarity floor. No LLM gate in U1 —
 * that's added later only if precision evals demand it. When a subscription has
 * no topic embedding (the embedder was offline at create time, or a test drives
 * the window directly), every change is treated as topical — the scheduler's
 * watermark/backoff/empty-window behaviour stays exercised without embeddings.
 */
import type { Repo } from '../db/repo.js';
import { blobToEmbedding, cosineSimilarity } from '../../lib/embeddings.js';
import type { ChangedNode } from '../lib/change-window.js';

export interface TopicRanked {
  node: ChangedNode;
  score: number;
}

/** Default cosine floor — below this a changed node is treated as off-topic. */
export const DEFAULT_SIMILARITY_FLOOR = 0.15;

export async function rankChangesByTopic(
  repo: Repo,
  workspace_id: string,
  topicEmbedding: Float32Array | null,
  nodes: ChangedNode[],
  opts?: { floor?: number },
): Promise<{ topical: ChangedNode[]; ranked: TopicRanked[] }> {
  // No topic vector → cannot rank; keep everything (deterministic passthrough).
  if (!topicEmbedding || nodes.length === 0) {
    return { topical: nodes, ranked: nodes.map((node) => ({ node, score: 1 })) };
  }
  const floor = opts?.floor ?? DEFAULT_SIMILARITY_FLOOR;
  const embByNode = await loadNodeEmbeddings(repo, workspace_id, nodes.map((n) => n.id));

  const ranked: TopicRanked[] = nodes.map((node) => {
    const emb = embByNode.get(node.id);
    const score = emb ? cosineSimilarity(topicEmbedding, emb) : 0;
    return { node, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  const topical = ranked.filter((r) => r.score >= floor).map((r) => r.node);
  return { topical, ranked };
}

async function loadNodeEmbeddings(
  repo: Repo,
  workspace_id: string,
  ids: string[],
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  if (ids.length === 0) return out;
  // Chunk the IN-list so we never blow past SQLite's variable limit.
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = await repo.listNodeEmbeddingsByIds(workspace_id, slice) as Array<{ id: string; embedding: Buffer | null }>;
    for (const r of rows) {
      const emb = blobToEmbedding(r.embedding);
      if (emb) out.set(r.id, emb);
    }
  }
  return out;
}
