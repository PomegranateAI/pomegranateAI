import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import type { Candidate } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-01-01T00:00:00Z';

function cand(id: string, nodeId: string, flag: 'red' | 'yellow' | 'green' = 'green'): Candidate {
  return {
    id,
    flag,
    proposed_node: {
      id: nodeId,
      type: 'decision',
      created_at: ts,
      updated_at: ts,
      status: 'active',
      summary: `decision ${id}`,
      body: `body of ${id}`,
      category: 'scope',
    } as any,
    source_quote: `quote for ${id}`,
    source_ref: 'doc.md',
    confidence: 0.9,
  };
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
});

describe('curation conversations', () => {
  it('creates once and keeps the original case on replays', async () => {
    expect(await repo.createCurationConversation(ws, 'd1', '2')).toBe(true);
    expect(await repo.createCurationConversation(ws, 'd1', '1')).toBe(false); // raced/duplicate
    expect((await repo.getCurationConversation(ws, 'd1'))?.case_opened).toBe('2');
  });

  it('appends messages in order and bumps updated_at', async () => {
    await repo.createCurationConversation(ws, 'd1', '1');
    const before = (await repo.getCurationConversation(ws, 'd1'))!.updated_at;
    await repo.appendCurationMessage(ws, 'd1', 'agent', 'welcome');
    await repo.appendCurationMessage(ws, 'd1', 'user', 'hi');
    await repo.appendCurationMessage(ws, 'd1', 'event', '✓ 3 items integrated', [{ tool: 'accept_source', ids: ['a'], result: { approved: 3 } }]);
    const msgs = await repo.listCurationMessages(ws, 'd1');
    expect(msgs.map((m) => m.role)).toEqual(['agent', 'user', 'event']);
    expect(msgs[2].receipts).toEqual([{ tool: 'accept_source', ids: ['a'], result: { approved: 3 } }]);
    expect((await repo.getCurationConversation(ws, 'd1'))!.updated_at >= before).toBe(true);
  });

  it('round-trips the structured ui payload (suggested actions + item list)', async () => {
    await repo.createCurationConversation(ws, 'd1', '2');
    const ui = {
      suggested_actions: [{ action: 'accept_source', label: 'Accept whole source (3)' }],
      item_list: ['c1', 'c2', 'c3'],
    };
    await repo.appendCurationMessage(ws, 'd1', 'agent', 'Do you want to add all the components?', undefined, ui);
    await repo.appendCurationMessage(ws, 'd1', 'user', 'sure');
    const [welcome, user] = await repo.listCurationMessages(ws, 'd1');
    expect(welcome.ui).toEqual(ui);
    expect(user.ui).toBeNull();
  });

  it("the loose-items conversation uses document_id ''", async () => {
    await repo.createCurationConversation(ws, '', '3');
    expect((await repo.getCurationConversation(ws, ''))?.case_opened).toBe('3');
    expect(await repo.listCurationConversations(ws)).toHaveLength(1);
  });
});

describe('revertCandidate (un-integration)', () => {
  it('archives the node and flips the candidate to rejected', async () => {
    await repo.registerDocument(ws, { source_ref: 'doc.md', source_kind: 'doc', sha256: 'x' });
    const doc = (await repo.listDocuments(ws))[0];
    await repo.insertCandidate(ws, cand('c1', 'n1'), doc.id);
    await repo.approveCandidate(ws, 'c1', 'u1');
    expect((await repo.getNode(ws, 'n1'))?.status).toBe('active');

    const { node_id } = await repo.revertCandidate(ws, 'c1', 'u1');
    expect(node_id).toBe('n1');
    expect(await repo.listNodes(ws, { activeOnly: true })).toHaveLength(0);
    expect((await repo.listCandidates(ws, { status: 'rejected' })).map((x) => x.id)).toEqual(['c1']);
  });

  it('refuses to revert a pending candidate', async () => {
    await repo.insertCandidate(ws, cand('c2', 'n2'));
    await expect(async () => await repo.revertCandidate(ws, 'c2')).rejects.toThrow(/not approved/);
  });
});

describe('doc_triage shrink-reuse storage (assessed_ids)', () => {
  it('round-trips assessed_ids and surfaces the latest row for the doc', async () => {
    await repo.setDocTriage({
      workspace_id: ws,
      document_id: 'd1',
      signature: 'sig-a',
      assessment: { legitimacy: 0.9 },
      assessed_ids: ['c1', 'c2', 'c3'],
    });
    const latest = await repo.latestDocTriageForDoc(ws, 'd1');
    expect(latest?.signature).toBe('sig-a');
    expect(latest?.assessed_ids).toEqual(['c1', 'c2', 'c3']);

    // Answers land on the row and survive a later read — the carry-forward
    // half of shrink-reuse.
    await repo.addDocTriageAnswer(ws, 'd1', 'sig-a', 'q1', 'yes');
    expect((await repo.latestDocTriageForDoc(ws, 'd1'))?.answers).toEqual({ q1: 'yes' });
  });

  it('a newer assessment row supersedes the old one as the reuse candidate', async () => {
    await repo.setDocTriage({ workspace_id: ws, document_id: 'd1', signature: 'sig-old', assessment: {}, assessed_ids: ['c1'] });
    await repo.setDocTriage({ workspace_id: ws, document_id: 'd1', signature: 'sig-new', assessment: {}, assessed_ids: ['c1', 'c2'] });
    expect((await repo.latestDocTriageForDoc(ws, 'd1'))?.signature).toBe('sig-new');
  });

  it('pre-reuse rows (no assessed_ids) report null so callers fall back', async () => {
    await repo.setDocTriage({ workspace_id: ws, document_id: 'd2', signature: 'sig-x', assessment: {} });
    expect((await repo.latestDocTriageForDoc(ws, 'd2'))?.assessed_ids).toBeNull();
  });
});

describe('resolvedCandidatesSince (external-change absorption)', () => {
  it('counts approvals/rejections after the cursor, scoped to the document', async () => {
    await repo.registerDocument(ws, { source_ref: 'doc.md', source_kind: 'doc', sha256: 'x' });
    const doc = (await repo.listDocuments(ws))[0];
    await repo.insertCandidate(ws, cand('c1', 'n1'), doc.id);
    await repo.insertCandidate(ws, cand('c2', 'n2'), doc.id);
    await repo.insertCandidate(ws, cand('c3', 'n3')); // loose — different scope

    const cursor = '2000-01-01T00:00:00.000Z';
    expect(await repo.resolvedCandidatesSince(ws, doc.id, cursor)).toEqual({ approved: 0, rejected: 0 });

    await repo.approveCandidate(ws, 'c1');
    await repo.rejectCandidate(ws, 'c2');
    await repo.approveCandidate(ws, 'c3');
    expect(await repo.resolvedCandidatesSince(ws, doc.id, cursor)).toEqual({ approved: 1, rejected: 1 });
    expect(await repo.resolvedCandidatesSince(ws, null, cursor)).toEqual({ approved: 1, rejected: 0 });

    // A cursor in the future sees nothing.
    expect(await repo.resolvedCandidatesSince(ws, doc.id, '2100-01-01T00:00:00.000Z')).toEqual({ approved: 0, rejected: 0 });
  });
});
