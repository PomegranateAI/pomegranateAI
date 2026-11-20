/**
 * Tests the `candidate_groups` cache table contract:
 *
 *   - getGroupsCache returns null when nothing's been stored
 *   - setGroupsCache + getGroupsCache round-trip preserves the groups JSON
 *     and candidate_count
 *   - the same signature with a different workspace doesn't cross-leak
 *   - deleteWorkspaceRows sweeps the cache
 *
 * These tests intentionally don't invoke any LLM — the auto-trigger logic
 * lives in api/server.ts and is exercised in the live scenario script.
 *
 * See the internal design notes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';

let db: Database.Database;
let repo: Repo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
});

const SAMPLE_GROUPS = [
  {
    title: 'Banned phrases from gtm doc',
    summary: 'Approving propagates three banned phrases to ICs.',
    candidate_ids: ['c_a', 'c_b', 'c_c'],
    recommended_action: 'approve_all',
    rationale: 'All green, single source.',
  },
  {
    title: 'Roadmap decisions',
    summary: 'Two roadmap decisions; check the dates before approving.',
    candidate_ids: ['c_d', 'c_e'],
    recommended_action: 'review_individually',
    rationale: 'Mixed flags.',
  },
];

describe('candidate_groups cache', () => {
  it('returns null on cache miss', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.test' });
    expect(await repo.getGroupsCache(ws.id, 'sig_nope')).toBeNull();
  });

  it('round-trips groups + candidate_count', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.test' });
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_xyz',
      groups: SAMPLE_GROUPS,
      candidate_count: 5,
    });
    const hit = await repo.getGroupsCache(ws.id, 'sig_xyz');
    expect(hit).not.toBeNull();
    expect(hit!.candidate_count).toBe(5);
    expect(hit!.groups).toEqual(SAMPLE_GROUPS);
    expect(typeof hit!.created_at).toBe('string');
  });

  it('does not cross-leak between workspaces with identical signatures', async () => {
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.test' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.test' });
    await repo.setGroupsCache({
      workspace_id: a.id,
      signature: 'sig_shared',
      groups: SAMPLE_GROUPS,
      candidate_count: 5,
    });
    // Workspace B has never stored anything under sig_shared.
    expect(await repo.getGroupsCache(b.id, 'sig_shared')).toBeNull();
  });

  it('upsert: writing the same signature replaces the prior entry', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.test' });
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_dup',
      groups: SAMPLE_GROUPS,
      candidate_count: 5,
    });
    const updated = [{ ...SAMPLE_GROUPS[0]!, title: 'New title' }];
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_dup',
      groups: updated,
      candidate_count: 3,
    });
    const hit = await repo.getGroupsCache(ws.id, 'sig_dup');
    expect(hit!.candidate_count).toBe(3);
    expect((hit!.groups[0] as any).title).toBe('New title');
  });

  it('getLatestGroupsCache returns the most recent entry regardless of signature', async () => {
    const ws = await repo.createWorkspace({ name: 'L', owner_email: 'l@l.test' });
    expect(await repo.getLatestGroupsCache(ws.id)).toBeNull();
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_old',
      groups: [{ ...SAMPLE_GROUPS[0]!, title: 'OLDER' }],
      candidate_count: 3,
    });
    // Force a measurable created_at gap so the ORDER BY DESC picks the
    // newer row deterministically on systems where datetime('now') has
    // 1-second resolution.
    repo.db.prepare(`UPDATE candidate_groups SET created_at = datetime('now', '-1 hour') WHERE signature = 'sig_old'`).run();
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_new',
      groups: [{ ...SAMPLE_GROUPS[0]!, title: 'NEWER' }],
      candidate_count: 5,
    });
    const latest = await repo.getLatestGroupsCache(ws.id);
    expect(latest).not.toBeNull();
    expect(latest!.signature).toBe('sig_new');
    expect((latest!.groups[0] as any).title).toBe('NEWER');
    expect(latest!.candidate_count).toBe(5);
  });

  it('deleteWorkspaceRows sweeps the cache (so workspace deletion is total)', async () => {
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.test' });
    await repo.setGroupsCache({
      workspace_id: ws.id,
      signature: 'sig_a',
      groups: SAMPLE_GROUPS,
      candidate_count: 5,
    });
    const counts = await repo.deleteWorkspaceRows(ws.id);
    expect(counts['candidate_groups']).toBe(1);
    // Tripwire check from the deletion-test helper: every workspace-scoped
    // table is at zero after delete.
    const remaining = await repo.countWorkspaceRows(ws.id);
    expect(remaining['candidate_groups']).toBe(0);
  });
});
