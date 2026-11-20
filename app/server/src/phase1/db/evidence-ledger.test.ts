/**
 * Evidence ledger + document registry (corroboration architecture).
 *
 * - registerDocument: idempotent on (source_ref, sha256); same ref with new
 *   content bumps version.
 * - approveCandidate seeds the node's origin evidence row + document link.
 * - addNodeEvidence accumulates corroborations; evidenceCounts aggregates
 *   distinct sources for prompt annotation.
 * - workspace deletion cascades both tables.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import type { Candidate } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-06-04T00:00:00Z';

const cand = (id: string): Candidate =>
  ({
    id,
    proposed_node: {
      id: `n-${id}`,
      type: 'user_insight',
      subkind: 'pain_point',
      created_at: ts,
      updated_at: ts,
      status: 'active',
      body: 'Cross-functional review is the bottleneck for AI-assisted work.',
      attrs: { context: 'From transcript "priya-call" (v1): discovery call about AI workflows.' },
    },
    flag: 'green',
    source_quote: 'reviewing is the bottleneck',
    source_ref: 'priya-call',
    confidence: 0.9,
  }) as unknown as Candidate;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'Ev', owner_email: 'pm@example.com' })).id;
});

describe('document registry', () => {
  it('is idempotent on identical content and bumps version on changed content', async () => {
    const a = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'aaa', summary: 'v1' });
    const b = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'aaa', summary: 'v1' });
    expect(b).toEqual({ id: a.id, version: 1, existing: true });
    const c2 = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'bbb', summary: 'v2' });
    expect(c2.version).toBe(2);
    expect(c2.id).not.toBe(a.id);
  });

  it('floats a re-ingested source to the top of listDocuments (recency), keeping created_at as first-seen', async () => {
    const a = await repo.registerDocument(ws, { source_ref: 'a.md', source_kind: 'doc', sha256: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    await repo.registerDocument(ws, { source_ref: 'b.md', source_kind: 'doc', sha256: 'b1' });
    // Newest-first by ingest: b is on top.
    expect((await repo.listDocuments(ws)).map((d) => d.source_ref)).toEqual(['b.md', 'a.md']);
    const firstSeen = (await repo.getDocument(ws, a.id))!.created_at;
    // Idempotent re-ingest of a (same content) — no new row, but it resurfaces.
    await new Promise((r) => setTimeout(r, 5));
    const again = await repo.registerDocument(ws, { source_ref: 'a.md', source_kind: 'doc', sha256: 'a1' });
    expect(again).toEqual({ id: a.id, version: 1, existing: true });
    const docs = await repo.listDocuments(ws);
    expect(docs.map((d) => d.source_ref)).toEqual(['a.md', 'b.md']);
    const rowA = docs.find((d) => d.id === a.id)!;
    expect(rowA.created_at).toBe(firstSeen); // first-seen unchanged
    expect(rowA.last_ingested_at! > firstSeen).toBe(true); // recency advanced
  });

  it('stores summary and stakeholders, readable via getDocument', async () => {
    const d = await repo.registerDocument(ws, {
      source_ref: 'call.md',
      source_kind: 'transcript',
      sha256: 'x',
      summary: 'Discovery call with Priya about marketing AI workflows.',
      stakeholders: ['Sam', 'Priya Shah'],
    });
    const got = (await repo.getDocument(ws, d.id))!;
    expect(got.summary).toContain('Priya');
    expect(got.stakeholders).toEqual(['Sam', 'Priya Shah']);
  });
});

describe('evidence ledger', () => {
  it('approveCandidate seeds the origin evidence row and document link', async () => {
    const doc = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'x' });
    await repo.insertCandidate(ws, cand('c1'), doc.id);
    await repo.approveCandidate(ws, 'c1');
    const ev = await repo.listNodeEvidence(ws, 'n-c1');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.document_id).toBe(doc.id);
    expect(ev[0]!.quote).toBe('reviewing is the bottleneck');
    const node = db
      .prepare(`SELECT document_id FROM graph_nodes WHERE workspace_id = ? AND id = ?`)
      .get(ws, 'n-c1') as { document_id: string };
    expect(node.document_id).toBe(doc.id);
  });

  it('corroborations from later documents accumulate; counts are per distinct document', async () => {
    const doc1 = await repo.registerDocument(ws, { source_ref: 'call-1.md', source_kind: 'transcript', sha256: 'a' });
    await repo.insertCandidate(ws, cand('c1'), doc1.id);
    await repo.approveCandidate(ws, 'c1');
    const doc2 = await repo.registerDocument(ws, { source_ref: 'call-2.md', source_kind: 'transcript', sha256: 'b' });
    const doc3 = await repo.registerDocument(ws, { source_ref: 'call-3.md', source_kind: 'transcript', sha256: 'c' });
    await repo.addNodeEvidence(ws, { node_id: 'n-c1', document_id: doc2.id, source_ref: 'call-2.md', quote: 'review is killing us' });
    await repo.addNodeEvidence(ws, { node_id: 'n-c1', document_id: doc3.id, source_ref: 'call-3.md', quote: 'the bottleneck is review' });
    // duplicate row is ignored (idempotent)
    await repo.addNodeEvidence(ws, { node_id: 'n-c1', document_id: doc2.id, source_ref: 'call-2.md', quote: 'review is killing us' });
    expect(await repo.listNodeEvidence(ws, 'n-c1')).toHaveLength(3);
    const counts = await repo.evidenceCounts(ws);
    expect(counts.get('n-c1')!.sources).toBe(3);
  });

  it('workspace deletion cascades documents and node_evidence', async () => {
    const doc = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'x' });
    await repo.insertCandidate(ws, cand('c1'), doc.id);
    await repo.approveCandidate(ws, 'c1');
    const counts = await repo.deleteWorkspaceRows(ws);
    expect(counts.documents).toBe(1);
    expect(counts.node_evidence).toBe(1);
    expect(Object.values(await repo.countWorkspaceRows(ws)).every((n) => n === 0)).toBe(true);
  });

  it('cross-workspace isolation: evidence in A is invisible to B', async () => {
    const wsB = (await repo.createWorkspace({ name: 'B', owner_email: 'b@example.com' })).id;
    const doc = await repo.registerDocument(ws, { source_ref: 'call.md', source_kind: 'transcript', sha256: 'x' });
    await repo.insertCandidate(ws, cand('c1'), doc.id);
    await repo.approveCandidate(ws, 'c1');
    expect((await repo.evidenceCounts(wsB)).size).toBe(0);
    expect(await repo.listNodeEvidence(wsB, 'n-c1')).toHaveLength(0);
  });
});
