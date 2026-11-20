/**
 * Source-RAG: the second retrieval path (spec-source-rag-hybrid-answering.md).
 *
 * The node canon is a deliberately lossy filter — extraction keeps what is
 * canon-worthy and drops the rest. This module recovers the dropped material by
 * retrieving over the raw source text we already persist on disk, so
 * `query_context` can answer from sources, not only nodes. It is always-hybrid
 * and canon-prioritized: the excerpts this returns are handed to synthesis as a
 * clearly-labeled, subordinate tier (see runQuery).
 *
 * Gated by POMEGRANATE_SOURCE_RAG (default OFF). When off, `SOURCE_RAG_ENABLED`
 * is false, nothing is embedded at ingest, and `retrieveSourceExcerpts` returns
 * [] — so the answering path is byte-identical to today.
 *
 * Embedding infra is reused verbatim from the node path (`lib/embeddings.ts`):
 * same `Embedder`, same BLOB pack, same cosine. Retrieval is brute-force cosine
 * in-process (parity with `packGraph`); the `sqlite-vec` ANN migration is a
 * data-triggered follow-up (spec §2.6).
 */
import { createHash } from 'node:crypto';
import type { Repo } from '../db/repo.js';
import type { Embedder } from '../../lib/embeddings.js';
import {
  blobToEmbedding,
  cosineSimilarity,
  embeddingToBlob,
  getEmbedder,
} from '../../lib/embeddings.js';
import { log } from '../../lib/log.js';

/**
 * Feature flag — default OFF so the answering path is unchanged until flipped.
 * Read dynamically (not frozen at import) so the eval harness can sweep it and
 * tests can toggle it per-case.
 */
export function sourceRagEnabled(): boolean {
  return process.env.POMEGRANATE_SOURCE_RAG === '1';
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function floatEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/** The tunable retrieval surface (spec §3). Read from env each call so evals can sweep. */
export function sourceRagConfig(): {
  chunkChars: number;
  overlapPct: number;
  k: number;
  minSim: number;
  perDoc: number;
} {
  return {
    chunkChars: intEnv('POMEGRANATE_SOURCE_CHUNK_CHARS', 1000), // P1
    overlapPct: intEnv('POMEGRANATE_SOURCE_CHUNK_OVERLAP_PCT', 15), // P2
    k: intEnv('POMEGRANATE_SOURCE_RAG_K', 6), // P4
    minSim: floatEnv('POMEGRANATE_SOURCE_RAG_MIN_SIM', 0.25), // P5
    perDoc: intEnv('POMEGRANATE_SOURCE_RAG_PER_DOC', 2), // P6
  };
}

/** One retrieved source excerpt, subordinate to the node canon at synthesis. */
export interface SourceExcerpt {
  /** Deterministic chunk id — the citation token the synthesizer echoes back. */
  chunk_id: string;
  document_id: string;
  source_ref: string;
  text: string;
  score: number;
  char_start: number;
  char_end: number;
}

// ─── Chunking ───────────────────────────────────────────────────────────

/**
 * Sentence-aware fixed-window chunker. Walks the text in ~`chars` windows,
 * snapping each window end back to the nearest sentence/paragraph boundary in
 * the last 40% so facts aren't cut mid-sentence, and carries `overlapPct` of the
 * window into the next start so a fact straddling a boundary survives in at
 * least one chunk. `char_start`/`char_end` are offsets into the original text
 * (before per-chunk trim), preserving provenance.
 */
export function chunkText(
  text: string,
  opts?: { chars?: number; overlapPct?: number },
): Array<{ text: string; char_start: number; char_end: number }> {
  if (!text || text.trim().length === 0) return [];
  const size = Math.max(200, opts?.chars ?? 1000);
  const overlap = Math.min(size - 1, Math.max(0, Math.floor((size * (opts?.overlapPct ?? 15)) / 100)));
  const n = text.length;
  const out: Array<{ text: string; char_start: number; char_end: number }> = [];
  let start = 0;
  while (start < n) {
    let end = Math.min(n, start + size);
    if (end < n) {
      const minEnd = start + Math.floor(size * 0.6);
      let cut = -1;
      for (let i = end; i > minEnd; i--) {
        const ch = text[i - 1];
        if (ch === '\n') {
          cut = i;
          break;
        }
        if (
          (ch === '.' || ch === '!' || ch === '?') &&
          (i >= n || text[i] === ' ' || text[i] === '\n')
        ) {
          cut = i;
          break;
        }
      }
      if (cut > 0) end = cut;
    }
    const trimmed = text.slice(start, end).trim();
    if (trimmed.length > 0) out.push({ text: trimmed, char_start: start, char_end: end });
    if (end >= n) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

// ─── Embed at ingest ──────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Chunk a document's full text, embed the chunks in one batch, and upsert them.
 * Best-effort: the caller wraps this so a failure never fails the ingest (parity
 * with the .txt persist). Returns the number of chunks stored (0 on empty/skip).
 */
export async function embedAndStoreChunks(opts: {
  repo: Repo;
  workspace_id: string;
  document_id: string;
  subgraph_ref?: string | null;
  text: string;
  now: string;
  embedder?: Embedder;
}): Promise<number> {
  const cfg = sourceRagConfig();
  const pieces = chunkText(opts.text, { chars: cfg.chunkChars, overlapPct: cfg.overlapPct });
  if (pieces.length === 0) return 0;
  const embedder = opts.embedder ?? getEmbedder();
  let vecs: Float32Array[] = [];
  try {
    vecs = await embedder.embed(pieces.map((p) => p.text));
  } catch (err) {
    // Store the chunks without embeddings; the boot back-fill sweep (parity with
    // graph_nodes) can fill them later. An un-embedded chunk simply never ranks.
    log.warn('source_rag.embed_failed', {
      workspace: opts.workspace_id,
      document: opts.document_id,
      chunks: pieces.length,
      msg: (err as Error).message?.slice(0, 200),
    });
  }
  const rows = pieces.map((p, i) => ({
    id: `${opts.document_id}:c${i}`,
    document_id: opts.document_id,
    subgraph_ref: opts.subgraph_ref ?? null,
    chunk_index: i,
    text: p.text,
    char_start: p.char_start,
    char_end: p.char_end,
    embedding: vecs[i] ? embeddingToBlob(vecs[i]!) : null,
    sha256: sha256(p.text),
    created_at: opts.now,
  }));
  await opts.repo.upsertSourceChunks(opts.workspace_id, rows);
  log.info('source_rag.chunks_stored', {
    workspace: opts.workspace_id,
    document: opts.document_id,
    chunks: rows.length,
    embedded: vecs.length > 0,
  });
  return rows.length;
}

// ─── Retrieval ──────────────────────────────────────────────────────────

/**
 * The source path of always-hybrid retrieval: embed the question, brute-force
 * cosine over the workspace's trust-gated chunks (§2.5 filtering is in the repo
 * SQL), then keep the top-K above the similarity floor with a per-document cap
 * for diversity. Returns [] when the flag is off, there are no chunks, or the
 * question can't be embedded — all of which degrade cleanly to node-only.
 */
export async function retrieveSourceExcerpts(opts: {
  repo: Repo;
  workspace_id: string;
  question: string;
  embedder?: Embedder;
  k?: number;
  minSim?: number;
  perDoc?: number;
  /** The asking user: excerpts are limited to documents they may read (aiRead). */
  viewer?: string;
}): Promise<SourceExcerpt[]> {
  if (!sourceRagEnabled()) return [];
  const cfg = sourceRagConfig();
  const k = opts.k ?? cfg.k;
  const minSim = opts.minSim ?? cfg.minSim;
  const perDoc = opts.perDoc ?? cfg.perDoc;

  const rows = await opts.repo.listSourceChunkRowsForSearch(opts.workspace_id, opts.viewer);
  if (rows.length === 0) return [];

  const embedder = opts.embedder ?? getEmbedder();
  let qVec: Float32Array | undefined;
  try {
    [qVec] = await embedder.embed([opts.question]);
  } catch (err) {
    log.warn('source_rag.query_embed_failed', {
      workspace: opts.workspace_id,
      msg: (err as Error).message?.slice(0, 200),
    });
    return [];
  }
  if (!qVec) return [];

  const scored = rows
    .map((r) => {
      const v = blobToEmbedding(r.embedding);
      return { r, score: v ? cosineSimilarity(qVec!, v) : 0 };
    })
    .filter((s) => s.score >= minSim)
    .sort((a, b) => b.score - a.score);

  const perDocCount = new Map<string, number>();
  const out: SourceExcerpt[] = [];
  for (const s of scored) {
    if (out.length >= k) break;
    const c = perDocCount.get(s.r.document_id) ?? 0;
    if (c >= perDoc) continue;
    perDocCount.set(s.r.document_id, c + 1);
    out.push({
      chunk_id: s.r.id,
      document_id: s.r.document_id,
      source_ref: s.r.source_ref,
      text: s.r.text,
      score: s.score,
      char_start: s.r.char_start,
      char_end: s.r.char_end,
    });
  }
  return out;
}
