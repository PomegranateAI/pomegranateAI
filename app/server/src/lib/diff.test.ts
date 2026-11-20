import { describe, it, expect } from 'vitest';
import { assignFlag } from './diff.js';
import type { Candidate, Node } from './schemas.js';

const ts = '2026-01-01T00:00:00Z';

const graph: Node[] = [
  {
    id: 'goal-q2-ns',
    type: 'goal',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    title: 'Q2 mid-market ARR',
    body: 'Land 10 partners.',
    priority: 'north_star',
    period: 'Q2 2026',
  },
  {
    id: 'pos-killed',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'We are not the all-in-one revenue platform',
    kind: 'killed_messaging',
  },
  {
    id: 'dec-mobile',
    type: 'decision',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    summary: 'Retired the v1 mobile app',
    body: 'Dropping the v1 mobile app.',
    decided_on: '2026-04-30',
    category: 'scope',
  },
];

function cand(node: Node, confidence: number): Candidate {
  return {
    id: 'cand-x',
    proposed_node: node,
    flag: 'green',
    source_quote: 'q',
    source_ref: 'r',
    confidence,
  };
}

describe('assignFlag', () => {
  it('red: explicit supersede of active node', () => {
    const r = assignFlag(
      cand(
        {
          id: 'dec-mobile-2',
          type: 'decision',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          summary: 'Restore the v1 mobile app',
          body: 'Reverse the prior decision.',
          decided_on: '2026-05-15',
          category: 'scope',
          superseded: 'dec-mobile',
        },
        0.9,
      ),
      graph,
    );
    expect(r.flag).toBe('red');
    expect(r.conflicts_with).toBe('dec-mobile');
  });

  it('red: competing north_star in same period', () => {
    const r = assignFlag(
      cand(
        {
          id: 'goal-q2-other',
          type: 'goal',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          title: 'Q2 dev-tools wedge',
          body: 'Pivot.',
          priority: 'north_star',
          period: 'Q2 2026',
        },
        0.85,
      ),
      graph,
    );
    expect(r.flag).toBe('red');
    expect(r.conflicts_with).toBe('goal-q2-ns');
  });

  it('red: positioning stance contradicts killed_messaging on similar body', () => {
    const r = assignFlag(
      cand(
        {
          id: 'pos-new',
          type: 'positioning',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          body: 'We are the all-in-one revenue platform that does everything',
          kind: 'stance',
        },
        0.9,
      ),
      graph,
    );
    expect(r.flag).toBe('red');
    expect(r.conflicts_with).toBe('pos-killed');
  });

  it('yellow: low confidence', () => {
    const r = assignFlag(
      cand(
        {
          id: 'goal-new',
          type: 'goal',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          title: 'New supporting goal',
          body: 'Cross-functional cleanup.',
          priority: 'supporting',
        },
        0.4,
      ),
      graph,
    );
    expect(r.flag).toBe('yellow');
  });

  it('green: clean high-confidence addition', () => {
    const r = assignFlag(
      cand(
        {
          id: 'pos-new',
          type: 'positioning',
          created_at: ts,
          updated_at: ts,
          status: 'active',
          body: 'We compete on synthesis quality, not surface coverage',
          kind: 'differentiator',
        },
        0.85,
      ),
      graph,
    );
    expect(r.flag).toBe('green');
  });
});
