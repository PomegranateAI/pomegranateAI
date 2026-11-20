/**
 * `pending_routes` — a routing decision the router couldn't auto-apply (a new
 * folder it wants to create, or an existing one it had nothing to go on) held
 * for a human to approve/choose/reject. Pure repo-layer CRUD; the gate logic
 * that decides WHEN a row gets created lives in api/routes.ts and is covered
 * by routing-approval.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';
import { Repo } from './repo.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
});

describe('pending_routes', () => {
  it('creates, lists (defaulting to pending), and reads back JSON columns as parsed values', async () => {
    const { id } = await repo.createPendingRoute(ws, {
      document_id: 'doc_1',
      reason: 'Nothing existing fits, but this reads like a decision log entry.',
      proposed_targets: ['sg_a'],
      proposed_new_folder: { name: 'Decisions', description: 'What got decided.' },
      low_confidence_targets: [],
    });

    const row = await repo.getPendingRoute(ws, id);
    expect(row?.status).toBe('pending');
    expect(row?.document_id).toBe('doc_1');
    expect(row?.proposed_targets).toEqual(['sg_a']);
    expect(row?.proposed_new_folder).toEqual({ name: 'Decisions', description: 'What got decided.' });
    expect(row?.low_confidence_targets).toEqual([]);

    const pending = await repo.listPendingRoutes(ws);
    expect(pending.map((r) => r.id)).toEqual([id]);

    // Default status filter is 'pending' — an approved row drops out of the
    // default list without an explicit status.
    await repo.resolvePendingRoute(ws, id, { status: 'approved', resolved_by: 'user_1' });
    expect(await repo.listPendingRoutes(ws)).toHaveLength(0);
    expect((await repo.listPendingRoutes(ws, { status: 'approved' })).map((r) => r.id)).toEqual([id]);

    const resolved = await repo.getPendingRoute(ws, id);
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolved_by).toBe('user_1');
    expect(resolved?.resolved_at).toBeTruthy();
  });

  it('stores a null proposed_new_folder as null, not the string "null"', async () => {
    const { id } = await repo.createPendingRoute(ws, {
      document_id: 'doc_2',
      reason: 'Picked an empty, undescribed folder.',
      proposed_targets: ['sg_b'],
      proposed_new_folder: null,
      low_confidence_targets: ['sg_b'],
    });
    const row = await repo.getPendingRoute(ws, id);
    expect(row?.proposed_new_folder).toBeNull();
    expect(row?.low_confidence_targets).toEqual(['sg_b']);
  });

  it('getPendingRoute returns undefined for an unknown id or the wrong workspace', async () => {
    const { id } = await repo.createPendingRoute(ws, {
      document_id: 'doc_3',
      reason: 'r',
      proposed_targets: [],
      proposed_new_folder: null,
      low_confidence_targets: [],
    });
    expect(await repo.getPendingRoute(ws, 'pr_nope')).toBeUndefined();
    const otherWs = (await repo.createWorkspace({ name: 'Other', owner_email: 'o@t.com' })).id;
    expect(await repo.getPendingRoute(otherWs, id)).toBeUndefined();
  });
});
