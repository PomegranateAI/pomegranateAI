/**
 * Regression: profile-kind nodes must survive the repo READ paths.
 *
 * The capture fix (ProfileCapturePayload) let non-founding kinds through the
 * write path, but listCandidates / approveCandidate / listNodes still parsed
 * stored JSON with the strict founding `Node` union — production 500'd on
 * `GET /candidates` the first time a marketing workspace ingested a doc
 * (invalid_union_discriminator on kind 'voice'). repo.ts now parses
 * founding-first with a ProfileNode fallback (parseStoredNode).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import type { Candidate } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-06-03T00:00:00Z';

const voiceCandidate: Candidate = {
  id: 'cand-voice-1',
  proposed_node: {
    id: 'voice-banned-ai-powered',
    type: 'voice',
    subkind: 'banned_phrase',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'Banned phrase: "AI-powered". Use "agent-native operating layer".',
  } as Candidate['proposed_node'],
  flag: 'red',
  source_quote: 'we are killing the phrase AI-powered everywhere',
  source_ref: 'marketing-sync-jun-3',
  confidence: 0.95,
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'Mkt', owner_email: 'mkt@example.com' })).id;
});

describe('profile-kind node round-trip through repo read paths', () => {
  it('listCandidates returns a stored profile-kind candidate intact', async () => {
    await repo.insertCandidate(ws, voiceCandidate);
    const listed = await repo.listCandidates(ws, { status: 'pending' });
    expect(listed).toHaveLength(1);
    const node = listed[0].proposed_node as Record<string, unknown>;
    expect(node.type).toBe('voice');
    expect(node.subkind).toBe('banned_phrase');
  });

  it('approveCandidate upserts the profile-kind node and listNodes reads it back', async () => {
    await repo.insertCandidate(ws, voiceCandidate);
    await repo.approveCandidate(ws, voiceCandidate.id);
    const nodes = await repo.listNodes(ws, { activeOnly: true });
    expect(nodes.map((n) => (n as Record<string, unknown>).type)).toContain('voice');
    const got = await repo.getNode(ws, 'voice-banned-ai-powered') as Record<string, unknown>;
    expect(got.subkind).toBe('banned_phrase');
  });

  it('founding-kind candidates still parse via the strict union (backfill preserved)', async () => {
    const founding: Candidate = {
      id: 'cand-pos-1',
      proposed_node: {
        id: 'pos-stance-1',
        type: 'positioning',
        kind: 'stance',
        created_at: ts,
        updated_at: ts,
        status: 'active',
        body: 'We are the strategy substrate, not a chat tool.',
      },
      flag: 'green',
      source_quote: 'strategy substrate, not a chat tool',
      source_ref: 'doc-1',
      confidence: 0.9,
    };
    await repo.insertCandidate(ws, founding);
    const listed = await repo.listCandidates(ws, { status: 'pending' });
    const node = listed[0].proposed_node as Record<string, unknown>;
    expect(node.type).toBe('positioning');
    expect(node.kind).toBe('stance');
  });
});
