import { describe, it, expect } from 'vitest';
import { runTriage, runCapture, runFeedback, runQuery } from './anthropic.js';
import type { Node } from './schemas.js';

// Integration tests — exercise the real Anthropic API. Opt-in only via
// POMEGRANATE_RUN_LIVE_TESTS=1, and still skipped if the key is missing,
// the heuristic provider is forced, or live tests are explicitly disabled.
// (The previous default of "run when key is present" failed loudly when the
// key existed but the account was out of credits.)
const SKIP_INTEGRATION =
  process.env.POMEGRANATE_RUN_LIVE_TESTS !== '1' ||
  !process.env.ANTHROPIC_API_KEY ||
  process.env.POMEGRANATE_SKIP_INTEGRATION === '1';

const itLive = SKIP_INTEGRATION ? it.skip : it;

const ts = '2026-01-01T00:00:00Z';

const seedGraph: Node[] = [
  {
    id: 'goal-q2-mm-arr',
    type: 'goal',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    title: 'Q2 north star: mid-market ARR',
    body: 'Land 10 mid-market design partners by EOQ2.',
    priority: 'north_star',
    period: 'Q2 2026',
  },
  {
    id: 'pos-killed-allinone',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'We are not the all-in-one revenue platform',
    kind: 'killed_messaging',
  },
  {
    id: 'pos-banned-synergy',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'synergy',
    kind: 'banned_phrase',
  },
  {
    id: 'dec-mobile-2026-04-30',
    type: 'decision',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    summary: 'Retired the v1 mobile app',
    body: 'Leadership decided 2026-04-30 to drop the v2 beta in favor of a staged rollout for enterprise.',
    decided_on: '2026-04-30',
    category: 'scope',
  },
];

describe('triage', () => {
  itLive('marks strategic content as relevant', async () => {
    const r = await runTriage(
      'help me rewrite this positioning paragraph to be sharper',
      'Sure — here is a sharper version that leads with the differentiator.',
    );
    expect(r.relevant).toBe(true);
  }, 60_000);

  itLive('marks pure refactor as not relevant', async () => {
    const r = await runTriage(
      'refactor this CRUD endpoint to use the new ORM',
      'Here is the refactored code using Prisma.',
    );
    expect(r.relevant).toBe(false);
  }, 60_000);
});

describe('capture', () => {
  itLive('extracts a decision candidate from a meeting transcript', async () => {
    const source = `
Speaker A: OK, we're killing the v1 mobile app. Effective Monday.
Speaker B: All approved, then. Sales gets the notice tomorrow.
Speaker A: Yes. We're going web-only for everything below mid-market.
`;
    const candidates = await runCapture({
      graph: seedGraph,
      sourceKind: 'transcript',
      source,
    });
    expect(candidates.length).toBeGreaterThan(0);
    const decision = candidates.find((c) => c.proposed_node.type === 'decision');
    expect(decision).toBeDefined();
  }, 90_000);
});

describe('feedback', () => {
  itLive('flags a deliverable using banned phrase as <red>', async () => {
    const deliverable = `Our all-in-one revenue platform unlocks synergy across teams. The new v1 mobile app is now live.`;
    const findings = await runFeedback({
      graph: seedGraph,
      kind: 'campaign',
      deliverable,
    });
    expect(findings.length).toBeGreaterThan(0);
    const reds = findings.filter((f) => f.flag === 'red');
    expect(reds.length).toBeGreaterThan(0);
    // Every red MUST cite a real node id from the graph
    for (const r of reds) {
      expect(r.node_id).not.toBeNull();
      expect(seedGraph.some((n) => n.id === r.node_id)).toBe(true);
    }
  }, 90_000);
});

describe('query', () => {
  itLive('answers a question grounded in the graph', async () => {
    const r = await runQuery({
      graph: seedGraph,
      scope: 'decisions',
      question: 'What is our current stance on the v1 mobile app?',
    });
    expect(r.has_answer).toBe(true);
    expect(r.cited_node_ids).toContain('dec-mobile-2026-04-30');
  }, 60_000);

  itLive("says I don't know when the graph has no answer", async () => {
    const r = await runQuery({
      graph: seedGraph,
      scope: 'all',
      question: 'What is our SOC 2 audit timeline?',
    });
    expect(r.has_answer).toBe(false);
  }, 60_000);
});
