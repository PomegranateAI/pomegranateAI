// Source-RAG retrieval + trust-gate tests (spec-source-rag-hybrid-answering.md
// §2.2/§2.5). Exercises the REAL Repo end-to-end: chunks are embedded and stored
// exactly as ingest does, then retrieved through the same repo SQL gate that the
// query path uses. The StubEmbedder makes cosine deterministic — an identical
// text scores 1.0, unrelated texts ~0 — so we assert on WHICH chunks survive the
// gate, not on model behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { StubEmbedder } from '../../lib/embeddings.js';
import {
  embedAndStoreChunks,
  retrieveSourceExcerpts,
  sourceRagEnabled,
} from './source-rag.js';
import type { Candidate } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;
const embedder = new StubEmbedder();
const now = '2026-07-09T00:00:00Z';

function decisionCandidate(id: string, source_ref: string, body: string): Candidate {
  return {
    id,
    proposed_node: {
      id: `dec-${id}`,
      type: 'decision',
      created_at: now,
      updated_at: now,
      status: 'active',
      summary: body.slice(0, 40),
      body,
      decided_on: '2026-07-09',
      category: 'other',
    },
    flag: 'yellow',
    source_quote: body,
    source_ref,
    confidence: 0.8,
  } as Candidate;
}

// Register a document version and store its chunks — the ingest path in one call.
async function ingest(source_ref: string, text: string): Promise<string> {
  const doc = await repo.registerDocument(ws, {
    source_ref,
    source_kind: 'doc',
    sha256: `sha-${source_ref}-${text.length}-${text.slice(0, 8)}`,
    summary: text.slice(0, 60),
  });
  await embedAndStoreChunks({ repo, workspace_id: ws, document_id: doc.id, text, now, embedder });
  return doc.id;
}

beforeEach(async () => {
  process.env.POMEGRANATE_SOURCE_RAG = '1';
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'RAG', owner_email: 'owner@example.com' })).id;
});

afterEach(() => {
  delete process.env.POMEGRANATE_SOURCE_RAG;
  db.close();
});

describe('flag gate', () => {
  it('returns [] when the flag is off, even with chunks present', async () => {
    await ingest('A.txt', 'ALPHA distinctive launch checklist content.');
    delete process.env.POMEGRANATE_SOURCE_RAG;
    expect(sourceRagEnabled()).toBe(false);
    const out = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: 'ALPHA distinctive launch checklist content.', embedder });
    expect(out).toEqual([]);
  });
});

describe('retrieval', () => {
  it('retrieves a chunk from a zero-candidate document (the core source-answerable case)', async () => {
    const q = 'ALPHA distinctive launch checklist content.';
    await ingest('A.txt', q);
    const out = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: q, embedder, minSim: 0.5 });
    expect(out.length).toBe(1);
    expect(out[0]!.source_ref).toBe('A.txt');
    expect(out[0]!.text).toContain('ALPHA');
    expect(out[0]!.score).toBeGreaterThan(0.99);
  });

  it('honours the similarity floor — an unrelated question returns nothing', async () => {
    await ingest('A.txt', 'ALPHA distinctive launch checklist content.');
    const out = await retrieveSourceExcerpts({
      repo,
      workspace_id: ws,
      question: 'completely unrelated question about llamas',
      embedder,
      minSim: 0.99,
    });
    expect(out).toEqual([]);
  });

  it('caps results per document (diversity)', async () => {
    // A doc long enough to span multiple chunks under the default window. Query
    // with an ACTUAL stored chunk's text so that chunk scores 1.0; the per-doc
    // cap must then limit the result to one even though the doc has many chunks.
    const sentence = 'Repeated roadmap sentence that forms its own chunk here now. ';
    await ingest('D.txt', sentence.repeat(60));
    const stored = await repo.listSourceChunkRowsForSearch(ws);
    expect(stored.length).toBeGreaterThan(1);
    const out = await retrieveSourceExcerpts({
      repo,
      workspace_id: ws,
      question: stored[0]!.text,
      embedder,
      minSim: 0.9,
      perDoc: 1,
      k: 10,
    });
    expect(out.length).toBe(1); // per-doc cap, despite many matching chunks
  });
});

describe('trust gate', () => {
  it('excludes superseded versions — only the latest version of a source_ref is retrieved', async () => {
    await ingest('B.txt', 'BETA old superseded version content one.');
    await ingest('B.txt', 'BETA new current version content two.');

    const oldHit = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: 'BETA old superseded version content one.', embedder, minSim: 0.5 });
    expect(oldHit).toEqual([]); // v1 chunk is gated out

    const newHit = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: 'BETA new current version content two.', embedder, minSim: 0.5 });
    expect(newHit.length).toBe(1);
    expect(newHit[0]!.text).toContain('content two');
  });

  it('excludes a rejected source (≥1 rejected, no surviving candidate)', async () => {
    const q = 'GAMMA rejected source content here.';
    const docId = await ingest('C.txt', q);
    const cand = decisionCandidate('cand-c', 'C.txt', q);
    await repo.insertCandidate(ws, cand, docId);
    await repo.rejectCandidate(ws, 'cand-c');

    const out = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: q, embedder, minSim: 0.5 });
    expect(out).toEqual([]);
  });

  it('KEEPS a source that has a surviving (approved) candidate even if another was rejected', async () => {
    const q = 'DELTA mixed source content approved.';
    const docId = await ingest('E.txt', q);
    await repo.insertCandidate(ws, decisionCandidate('cand-e1', 'E.txt', q), docId);
    await repo.insertCandidate(ws, decisionCandidate('cand-e2', 'E.txt', q + ' second'), docId);
    await repo.rejectCandidate(ws, 'cand-e1');
    await repo.approveCandidate(ws, 'cand-e2');

    const out = await retrieveSourceExcerpts({ repo, workspace_id: ws, question: q, embedder, minSim: 0.5 });
    expect(out.length).toBe(1);
    expect(out[0]!.source_ref).toBe('E.txt');
  });
});
