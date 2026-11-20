/**
 * Edge inference: the LLM-proposal apply layer (the model call itself is not
 * tested — applyEdgeProposals is the trust boundary where its output is
 * validated).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../phase1/db/schema.js';
import { Repo } from '../phase1/db/repo.js';
import { productProfile } from './profiles/__fixtures__/product.js';
import { programProfile } from './profiles/__fixtures__/program.js';
import { applyEdgeProposals } from './edge-inference.js';
import type { Node } from './schemas.js';

let db: Database.Database;
let repo: Repo;
let ws: string;

const ts = '2026-06-04T00:00:00Z';

function node(id: string, type: string, attrs?: Record<string, unknown>): Node {
  return {
    id,
    type,
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: `${type} ${id}`,
    ...(attrs ? { attrs } : {}),
  } as Node;
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'Prod', owner_email: 'pm@example.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile);
  await repo.upsertNode(ws, node('prod-app', 'product', { product: 'Pomegranate' }));
});

describe('applyEdgeProposals', () => {
  beforeEach(async () => {
    await repo.upsertNode(ws, node('goal-north', 'goal'));
    await repo.upsertNode(ws, node('metric-act', 'metric'));
    // Scoped to the product (mixed case on purpose — the guard compares
    // case-insensitively against prod-app's 'Pomegranate').
    await repo.upsertNode(ws, node('seg-icp', 'segment', { product: 'pomegranate' }));
  });

  it('persists valid proposals involving a new node, with llm provenance', async () => {
    const r = await applyEdgeProposals(repo, ws, new Set(['metric-act']), [
      { src: 'metric-act', dst: 'goal-north', kind: 'supports', quote: 'measures the launch goal', confidence: 0.9 },
    ]);
    expect(r).toEqual({ added: 1, skipped: 0 });
    const [edge] = await repo.listEdges(ws, { kind: 'supports' });
    expect(edge.created_by).toBe('llm');
    expect(edge.quote).toBe('measures the launch goal');
    expect(edge.confidence).toBe(0.9);
  });

  it('skips proposals between two pre-existing nodes', async () => {
    const r = await applyEdgeProposals(repo, ws, new Set(['metric-act']), [
      { src: 'goal-north', dst: 'prod-app', kind: 'belongs_to' },
    ]);
    expect(r).toEqual({ added: 0, skipped: 1 });
  });

  it('skips proposals that violate the taxonomy instead of throwing', async () => {
    const r = await applyEdgeProposals(repo, ws, new Set(['seg-icp']), [
      { src: 'seg-icp', dst: 'goal-north', kind: 'supports' }, // segment is not a supports source
      { src: 'seg-icp', dst: 'prod-app', kind: 'belongs_to' }, // valid (scoped to pomegranate)
      { src: 'seg-icp', dst: 'goal-north', kind: 'made_up' }, // unknown kind
    ]);
    expect(r).toEqual({ added: 1, skipped: 2 });
    expect((await repo.listEdges(ws)).map((e) => e.kind)).toEqual(['belongs_to']);
  });

  it('scope guard: drops membership edges from unscoped (portfolio-wide) nodes', async () => {
    // goal-north has NO product attr — portfolio-wide; belongs_to must not attach it.
    const r = await applyEdgeProposals(repo, ws, new Set(['goal-north']), [
      { src: 'goal-north', dst: 'prod-app', kind: 'belongs_to' },
    ]);
    expect(r).toEqual({ added: 0, skipped: 1 });
    expect(await repo.listEdges(ws, { kind: 'belongs_to' })).toEqual([]);
  });

  it('scope guard: drops membership edges whose scope values mismatch', async () => {
    await repo.upsertNode(ws, node('feat-x', 'feature', { product: 'other-product' }));
    const r = await applyEdgeProposals(repo, ws, new Set(['feat-x']), [
      { src: 'feat-x', dst: 'prod-app', kind: 'belongs_to' }, // feat belongs to other-product
    ]);
    expect(r).toEqual({ added: 0, skipped: 1 });
  });

  it('scope guard: matching scope values pass, case-insensitively', async () => {
    await repo.upsertNode(ws, node('feat-y', 'feature', { product: 'POMEGRANATE' }));
    const r = await applyEdgeProposals(repo, ws, new Set(['feat-y']), [
      { src: 'feat-y', dst: 'prod-app', kind: 'belongs_to' },
    ]);
    expect(r).toEqual({ added: 1, skipped: 0 });
  });

  it('scope guard: does not gate edge kinds without scope_attr', async () => {
    // supports has no scope_attr — an unscoped metric may support a goal.
    const r = await applyEdgeProposals(repo, ws, new Set(['metric-act']), [
      { src: 'metric-act', dst: 'goal-north', kind: 'supports' },
    ]);
    expect(r).toEqual({ added: 1, skipped: 0 });
  });
});

describe('applyEdgeProposals — temporal order guard (program profile)', () => {
  beforeEach(async () => {
    await repo.setWorkspaceProfile(ws, 'program', programProfile);
    await repo.upsertNode(ws, node('ms-early', 'milestone', { project: 'p1', due: '2026-07-01' }));
    await repo.upsertNode(ws, node('ms-late', 'milestone', { project: 'p1', due: '2026-08-01' }));
    await repo.upsertNode(ws, node('ms-undated', 'milestone', { project: 'p1' }));
  });

  it('drops a dependency whose dependent is due before its prerequisite', async () => {
    const r = await applyEdgeProposals(repo, ws, new Set(['ms-early']), [
      { src: 'ms-early', dst: 'ms-late', kind: 'depends_on' }, // early depends on late: reversed
    ]);
    expect(r).toEqual({ added: 0, skipped: 1 });
  });

  it('keeps the correctly-ordered dependency and ignores undated ends', async () => {
    const r = await applyEdgeProposals(repo, ws, new Set(['ms-late', 'ms-undated']), [
      { src: 'ms-late', dst: 'ms-early', kind: 'depends_on' }, // later depends on earlier: valid
      { src: 'ms-undated', dst: 'ms-late', kind: 'depends_on' }, // no src date: passes the guard
    ]);
    expect(r).toEqual({ added: 2, skipped: 0 });
  });

  it('reverse-duplicate rejection: the second direction of a directed pair is refused', async () => {
    const r1 = await applyEdgeProposals(repo, ws, new Set(['ms-late']), [
      { src: 'ms-late', dst: 'ms-early', kind: 'depends_on' },
    ]);
    expect(r1).toEqual({ added: 1, skipped: 0 });
    const r2 = await applyEdgeProposals(repo, ws, new Set(['ms-early']), [
      { src: 'ms-early', dst: 'ms-late', kind: 'depends_on' },
    ]);
    expect(r2).toEqual({ added: 0, skipped: 1 });
  });
});
