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
import { Repo, pendingRouteResolvableBy } from './repo.js';

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

  it('viewer filter: private holds are ingester/admin-only, team and legacy holds are visible to all; only ingester/admin resolve', async () => {
    const base = { reason: 'r', proposed_targets: [], proposed_new_folder: null, low_confidence_targets: [] };
    const priv = (await repo.createPendingRoute(ws, { ...base, document_id: 'd1', audience: 'private', ingested_by: 'u_a' })).id;
    const onlyMe = (await repo.createPendingRoute(ws, { ...base, document_id: 'd2', fallback_audience: 'only_me', ingested_by: 'u_a' })).id;
    const team = (await repo.createPendingRoute(ws, { ...base, document_id: 'd3', audience: 'team', ingested_by: 'u_a' })).id;
    // An explicit team audience beats a private fallback.
    const teamOverFallback = (await repo.createPendingRoute(ws, { ...base, document_id: 'd4', audience: 'team', fallback_audience: 'only_me', ingested_by: 'u_a' })).id;
    const legacy = (await repo.createPendingRoute(ws, { ...base, document_id: 'd5' })).id;
    const legacyPrivate = (await repo.createPendingRoute(ws, { ...base, document_id: 'd6', audience: 'private' })).id;

    const a = { user_id: 'u_a', is_admin: false };
    const b = { user_id: 'u_b', is_admin: false };
    const admin = { user_id: 'u_admin', is_admin: true };
    const ids = async (viewer?: typeof a) => (await repo.listPendingRoutes(ws, { viewer })).map((r) => r.id).sort();

    const all = [priv, onlyMe, team, teamOverFallback, legacy, legacyPrivate].sort();
    expect(await ids()).toEqual(all);
    expect(await ids(admin)).toEqual(all);
    expect(await ids(a)).toEqual([priv, onlyMe, team, teamOverFallback, legacy].sort());
    expect(await ids(b)).toEqual([team, teamOverFallback, legacy].sort());

    // getPendingRoute applies the same filter, so a hidden route reads as missing.
    expect(await repo.getPendingRoute(ws, priv, { viewer: b })).toBeUndefined();
    expect(await repo.getPendingRoute(ws, onlyMe, { viewer: b })).toBeUndefined();
    expect((await repo.getPendingRoute(ws, priv, { viewer: a }))?.id).toBe(priv);
    expect((await repo.getPendingRoute(ws, team, { viewer: b }))?.id).toBe(team);

    const teamRow = (await repo.getPendingRoute(ws, team))!;
    const legacyRow = (await repo.getPendingRoute(ws, legacy))!;
    expect(pendingRouteResolvableBy(teamRow, a)).toBe(true);
    expect(pendingRouteResolvableBy(teamRow, b)).toBe(false);
    expect(pendingRouteResolvableBy(teamRow, admin)).toBe(true);
    expect(pendingRouteResolvableBy(teamRow, undefined)).toBe(true);
    expect(pendingRouteResolvableBy(legacyRow, a)).toBe(false);
    expect(pendingRouteResolvableBy(legacyRow, admin)).toBe(true);
  });

  it('pendingRouteViewer: workspace_admin role or the owner email is admin; a plain member is not', async () => {
    const owner = (await repo.findOrCreateUser('t@t.com')).id;
    const member = (await repo.findOrCreateUser('m@t.com')).id;
    const wsAdmin = (await repo.findOrCreateUser('adm@t.com')).id;
    await repo.addMember({ workspace_id: ws, user_id: member, role: 'member' });
    await repo.addMember({ workspace_id: ws, user_id: wsAdmin, role: 'workspace_admin' });
    expect((await repo.pendingRouteViewer(ws, owner)).is_admin).toBe(true);
    expect((await repo.pendingRouteViewer(ws, member)).is_admin).toBe(false);
    expect((await repo.pendingRouteViewer(ws, wsAdmin)).is_admin).toBe(true);
    // An explicit role wins over the lookup.
    expect((await repo.pendingRouteViewer(ws, member, 'workspace_admin')).is_admin).toBe(true);
  });
});
