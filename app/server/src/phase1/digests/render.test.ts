import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { renderNudge, renderWeeklyDigest } from './render.js';

let db: Database.Database;
let repo: Repo;
let wsId: string;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  const ws = await repo.createWorkspace({ name: 'Acme', owner_email: 'leader@acme.test' });
  wsId = ws.id;
  // Seed graph
  await repo.insertNode(wsId, {
    id: 'dec-mobile-2026-04-15',
    type: 'decision',
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
    status: 'active',
    summary: 'Kill the v1 mobile app',
    body: 'Dropping the v1 mobile app effective 2026-04-15.',
    decided_on: '2026-04-15',
    category: 'scope',
  } as any);
});

describe('renderNudge', () => {
  it('empty when no candidates pending; calm, plain subject + body', async () => {
    const r = await renderNudge(repo, wsId, { workspaceName: 'Acme' });
    expect(r.red_count).toBe(0);
    expect(r.yellow_count).toBe(0);
    expect(r.subject).toBe('Nothing waiting for Acme');
    expect(r.body).toContain('Nothing waiting');
    // No banned vendor words.
    for (const w of [
      'unlock', 'empower', 'leverage', 'streamline', 'supercharge', 'transform',
      'single source of truth', 'co-pilot',
    ]) {
      expect(r.body.toLowerCase()).not.toContain(w);
    }
  });

  it('groups reds by source and caps at 5 with a "and N more" line', async () => {
    // 7 reds across 2 sources
    const sources = ['slack:#strategy@1', 'slack:#roadmap@1'];
    for (let i = 0; i < 7; i++) {
      await repo.insertCandidate(wsId, {
        id: `c${i}`,
        flag: 'red',
        proposed_node: {
          id: `prop-${i}`,
          type: 'decision',
          created_at: '2026-05-17T00:00:00Z',
          updated_at: '2026-05-17T00:00:00Z',
          status: 'active',
          summary: `Override decision ${i}`,
          body: 'body',
          decided_on: '2026-05-17',
          category: 'scope',
        },
        source_quote: 'q',
        source_ref: sources[i % 2]!,
        confidence: 0.9,
        conflicts_with: 'dec-mobile-2026-04-15',
      } as any);
    }
    const r = await renderNudge(repo, wsId, { workspaceName: 'Acme' });
    expect(r.red_count).toBe(7);
    expect(r.truncated).toBe(2);
    expect(r.subject).toBe('7 reds waiting for Acme');
    expect(r.body).toContain('From #strategy:');
    expect(r.body).toContain('From #roadmap:');
    expect(r.body).toContain('and 2 more red items');
    // Conflict pointer surfaces in the line.
    expect(r.body).toContain('(overrides dec-mobile-2026-04-15)');
  });

  it('singular vs plural copy is correct for 1 item', async () => {
    await repo.insertCandidate(wsId, {
      id: 'c1',
      flag: 'red',
      proposed_node: {
        id: 'p1', type: 'decision', created_at: '2026-05-17T00:00:00Z',
        updated_at: '2026-05-17T00:00:00Z', status: 'active',
        summary: 'A single override', body: 'b',
        decided_on: '2026-05-17', category: 'scope',
      },
      source_quote: 'q', source_ref: 'slack:#strategy@1',
      confidence: 0.9,
    } as any);
    const r = await renderNudge(repo, wsId);
    expect(r.subject).toBe('1 red waiting');
    expect(r.body).toContain('1 red item waiting');
  });
});

describe('renderWeeklyDigest', () => {
  it('reports zero state in plain English', async () => {
    const r = await renderWeeklyDigest(repo, wsId, {
      workspaceName: 'Acme',
      now: new Date('2026-05-17T17:00:00Z'),
    });
    expect(r.reviews_count).toBe(0);
    expect(r.subject).toBe('Weekly digest — Acme: 0 red, 0 yellow, 0 green');
    expect(r.body).toContain('0 reviews');
    expect(r.body).toContain('never used for performance review');
  });

  it('aggregates findings across the past 7 days and lists top 3 reds with cites', async () => {
    const now = new Date('2026-05-17T17:00:00Z');
    const insertReview = (when: Date, findings: any[]) => {
      db.prepare(
        `INSERT INTO reviews (id, workspace_id, caller, kind, deliverable, findings, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `rev_${Math.random().toString(36).slice(2)}`,
        wsId,
        'web',
        'campaign',
        'body',
        JSON.stringify(findings),
        null,
        when.toISOString(),
      );
    };
    insertReview(new Date(now.getTime() - 3 * 24 * 3600_000), [
      { flag: 'red', summary: 'Uses banned phrase "synergy"', node_id: 'pos-banned-synergy', category: 'brand_voice', quote_from_deliverable: '...' },
      { flag: 'green', summary: 'Aligned with mid-market', node_id: 'goal-mm', category: 'goals_priorities', quote_from_deliverable: '...' },
    ]);
    insertReview(new Date(now.getTime() - 1 * 24 * 3600_000), [
      { flag: 'red', summary: 'References killed v1 mobile app', node_id: 'dec-mobile-2026-04-15', category: 'decisions', quote_from_deliverable: '...' },
      { flag: 'red', summary: 'Mobile launch contradicts scope-defer', node_id: 'dec-scope', category: 'decisions', quote_from_deliverable: '...' },
      { flag: 'red', summary: 'Fourth red', node_id: 'x', category: 'decisions', quote_from_deliverable: '...' },
      { flag: 'yellow', summary: 'soft mismatch', node_id: null, category: 'positioning', quote_from_deliverable: '...' },
    ]);
    // A review outside the window — must NOT count.
    insertReview(new Date(now.getTime() - 14 * 24 * 3600_000), [
      { flag: 'red', summary: 'OLD red — must not appear', node_id: 'old', category: 'decisions', quote_from_deliverable: '...' },
    ]);

    const r = await renderWeeklyDigest(repo, wsId, { workspaceName: 'Acme', now });
    expect(r.reviews_count).toBe(2);
    expect(r.red_count).toBe(4);
    expect(r.yellow_count).toBe(1);
    expect(r.green_count).toBe(1);
    expect(r.subject).toBe('Weekly digest — Acme: 4 red, 1 yellow, 1 green');
    // Top 3 reds appear; the 4th is omitted.
    expect(r.body).toContain('References killed v1 mobile app');
    expect(r.body).toContain('→ dec-mobile-2026-04-15');
    expect(r.body).not.toContain('OLD red');
    // Per-IC names never appear.
    expect(r.body).not.toMatch(/submitted_by|leader@acme\.test/);
    // Trust line is load-bearing.
    expect(r.body).toContain('never used for performance review');
  });

  it('curator attribution surfaces approvers with 3+ approvals; never IC names', async () => {
    const now = new Date('2026-05-17T17:00:00Z');
    const within = new Date(now.getTime() - 2 * 24 * 3600_000).toISOString();
    // 3 approvals by curator u_alice
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO audit_log (workspace_id, actor, event, resource_type, resource_id, payload, created_at)
         VALUES (?, ?, 'candidate.approved', 'candidate', ?, NULL, ?)`,
      ).run(wsId, 'u_alice', `c${i}`, within);
    }
    // 1 approval by u_bob (under threshold)
    db.prepare(
      `INSERT INTO audit_log (workspace_id, actor, event, resource_type, resource_id, payload, created_at)
       VALUES (?, ?, 'candidate.approved', 'candidate', 'c-bob', NULL, ?)`,
    ).run(wsId, 'u_bob', within);
    const r = await renderWeeklyDigest(repo, wsId, { now });
    expect(r.body).toContain('u_alice: 3');
    expect(r.body).not.toContain('u_bob');
  });
});
