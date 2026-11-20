// Write-time and approval-time profile-kind gates (prod incident: a glean
// pass emitted a `competitor` candidate into the Program subgraph; it was
// approved into graph_nodes and then invisible in the Library, which buckets
// strictly by profile kinds). These tests pin the gates that now make the
// graph_nodes schema comment true.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';
import { programProfile } from '../../lib/profiles/__fixtures__/program.js';
import { enforceProfileKinds } from '../../lib/anthropic.js';
import type { Candidate } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-01-01T00:00:00Z';

function cand(id: string, type: string): Candidate {
  return {
    id,
    flag: 'green',
    proposed_node: {
      id: `n_${id}`,
      type,
      created_at: ts,
      updated_at: ts,
      status: 'active',
      title: `node ${id}`,
      body: `body of ${id}`,
      summary: `summary of ${id}`,
    } as any,
    source_quote: `quote for ${id}`,
    source_ref: 'doc.md',
    confidence: 0.9,
  } as Candidate;
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
});

describe('insertCandidate kind gate', () => {
  it('rejects a kind that is not in the stored profile', async () => {
    await repo.setWorkspaceProfile(ws, programProfile.id, programProfile);
    await expect(async () => await repo.insertCandidate(ws, cand('c1', 'competitor'))).rejects.toThrow(/invalid_kind/);
  });

  it('accepts a profile kind', async () => {
    await repo.setWorkspaceProfile(ws, programProfile.id, programProfile);
    await repo.insertCandidate(ws, cand('c2', 'milestone'));
    expect(await repo.listCandidates(ws)).toHaveLength(1);
  });

  it('validates against the SUBGRAPH the candidate targets, not default', async () => {
    await repo.setWorkspaceProfile(ws, programProfile.id, programProfile); // default = program
    const sg = await repo.createSubgraph(ws, { slug: 'product', name: 'Product' });
    // The target subgraph has no stored profile, so its gate is open even
    // though 'competitor' is foreign to the default subgraph's profile.
    await repo.insertCandidate(ws, cand('c3', 'competitor'), undefined, sg.id);
  });

  it('is open when no profile is stored (pre-profile workspaces)', async () => {
    await repo.insertCandidate(ws, cand('c4', 'anything'));
  });
});

describe('approveCandidate kind gate', () => {
  it('refuses to materialize a legacy candidate whose kind left the profile', async () => {
    // Simulate the prod row: candidate stored BEFORE the gate existed
    // (upsertCandidate mirrors device rows and is deliberately warn-only).
    await repo.setWorkspaceProfile(ws, programProfile.id, programProfile);
    await repo.upsertCandidate(ws, {
      id: 'c_legacy',
      flag: 'green',
      proposed_node: cand('c_legacy', 'competitor').proposed_node,
      source_quote: 'q',
      source_ref: 'doc.md',
      confidence: 0.9,
    });
    await expect(async () => await repo.approveCandidate(ws, 'c_legacy')).rejects.toThrow(/invalid_kind/);
    expect(await repo.listNodes(ws, { activeOnly: true })).toHaveLength(0);
    // …and the candidate is still pending, not half-approved.
    expect(await repo.listCandidates(ws, { status: 'pending' })).toHaveLength(1);
  });

  it('approves a valid kind into the graph', async () => {
    await repo.setWorkspaceProfile(ws, programProfile.id, programProfile);
    await repo.insertCandidate(ws, cand('c_ok', 'milestone'));
    const node = await repo.approveCandidate(ws, 'c_ok');
    expect((node as { type?: string }).type).toBe('milestone');
    expect(await repo.listNodes(ws, { activeOnly: true })).toHaveLength(1);
  });
});

describe('enforceProfileKinds (capture output gate)', () => {
  it('drops foreign kinds and traces them, keeps profile kinds', () => {
    const trace: Array<{ stage: string; [k: string]: unknown }> = [];
    const out = enforceProfileKinds(
      [cand('a', 'competitor'), cand('b', 'milestone')],
      programProfile,
      trace,
    );
    expect(out.map((c) => (c.proposed_node as { type?: string }).type)).toEqual(['milestone']);
    const evt = trace.find((t) => t.stage === 'kind_enforced');
    expect(evt).toBeTruthy();
    expect(String((evt as { dropped?: string[] }).dropped?.[0])).toContain('competitor');
  });

  it('is a no-op on an all-valid batch (no trace event)', () => {
    const trace: Array<{ stage: string }> = [];
    const out = enforceProfileKinds([cand('a', 'goal')], programProfile, trace);
    expect(out).toHaveLength(1);
    expect(trace).toHaveLength(0);
  });
});
