/**
 * Regression tests for the profile-aware capture parse (spec Part B).
 *
 * Bug: `runCapture` parsed `proposed_node` with the strict founding `Node`
 * discriminated union (`goal | positioning | decision`) for EVERY profile.
 * When a non-founding profile (marketing, product, …) correctly emitted a
 * profile-specific kind (voice, audience, channel, campaign_decision,
 * principle, user_insight, scope_boundary), the per-chunk try/catch in
 * runCapture caught the Zod discriminator failure and silently returned `[]`,
 * dropping the candidate before it reached the scorer. Measured impact:
 * marketing capture precision 6.3%, product 20% — only legacy-union kinds
 * survived.
 *
 * Fix: parse with `ProfileCapturePayload` (whose `proposed_node` is the
 * generalized `ProfileNode` envelope) when a non-founding profile is active;
 * keep the strict `CapturePayload` for founding so its behaviour is unchanged.
 *
 * These tests pin the parse seam directly (no live API): the bug and the fix
 * both live entirely in Zod schema selection, and the marketing/product
 * fixture kinds are the ground-truth shapes the model emits.
 */
import { describe, it, expect } from 'vitest';

// Pin the dedup pass to its deterministic fallback (no LLM judge) so the
// end-to-end flow test below is hermetic.
process.env.POMEGRANATE_DEDUP_NO_JUDGE = '1';

import {
  CapturePayload,
  ProfileCapturePayload,
} from './schemas.js';

const ts = '2026-05-20T00:00:00Z';

/** Build a raw capture payload (as the model emits it) around one node. */
function payloadWith(proposed_node: Record<string, unknown>) {
  return {
    candidates: [
      {
        id: 'cand-1',
        proposed_node,
        flag: 'green',
        source_quote: 'q',
        source_ref: 'source:doc',
        confidence: 0.8,
      },
    ],
  };
}

// The profile-specific kinds the marketing + product profiles emit. These are
// exactly the kinds the eval fixtures (marketing-capture.ts / product-capture)
// use as ground truth, and exactly the ones that were being dropped.
const PROFILE_NODES: Record<string, Record<string, unknown>> = {
  voice: {
    id: 'n-voice',
    type: 'voice',
    created_at: ts,
    updated_at: ts,
    body: 'Banned phrase: "leverage" — replace with "use".',
    subkind: 'banned_phrase',
  },
  audience: {
    id: 'n-aud',
    type: 'audience',
    created_at: ts,
    updated_at: ts,
    body: 'RevOps leaders at 300-600 person shops are the highest-intent cohort.',
    subkind: 'segment_insight',
  },
  channel: {
    id: 'n-chan',
    type: 'channel',
    created_at: ts,
    updated_at: ts,
    body: 'Newsletter moves to biweekly (1st & 3rd Thursday).',
    subkind: 'cadence_rule',
  },
  campaign_decision: {
    id: 'n-camp',
    type: 'campaign_decision',
    created_at: ts,
    updated_at: ts,
    body: 'Approved $40k for a Q2 mid-market field dinner series.',
    category: 'budget',
  },
  principle: {
    id: 'n-prin',
    type: 'principle',
    created_at: ts,
    updated_at: ts,
    body: 'We optimize for time-to-first-value over feature breadth.',
  },
  user_insight: {
    id: 'n-ui',
    type: 'user_insight',
    created_at: ts,
    updated_at: ts,
    body: 'Users abandon onboarding at the workspace-import step.',
  },
  scope_boundary: {
    id: 'n-scope',
    type: 'scope_boundary',
    created_at: ts,
    updated_at: ts,
    body: 'No native mobile app in 2026.',
  },
};

describe('ProfileCapturePayload — non-founding kinds survive the parse', () => {
  for (const [kind, node] of Object.entries(PROFILE_NODES)) {
    it(`parses a "${kind}" candidate`, () => {
      const parsed = ProfileCapturePayload.parse(payloadWith(node));
      expect(parsed.candidates).toHaveLength(1);
      expect(parsed.candidates[0]!.proposed_node.type).toBe(kind);
      expect(parsed.candidates[0]!.proposed_node.body).toBe(node.body);
    });

    it(`the strict (founding) CapturePayload would DROP a "${kind}" candidate`, () => {
      // This is the bug: the strict union rejects non-founding kinds, which is
      // why the old runCapture silently dropped them in its try/catch.
      const result = CapturePayload.safeParse(payloadWith(node));
      expect(result.success).toBe(false);
    });
  }
});

describe('ProfileCapturePayload preserves subkind / category / passthrough attrs', () => {
  it('keeps subkind on a voice node', () => {
    const parsed = ProfileCapturePayload.parse(payloadWith(PROFILE_NODES.voice!));
    expect((parsed.candidates[0]!.proposed_node as any).subkind).toBe('banned_phrase');
  });

  it('keeps category on a campaign_decision node', () => {
    const parsed = ProfileCapturePayload.parse(
      payloadWith(PROFILE_NODES.campaign_decision!),
    );
    expect((parsed.candidates[0]!.proposed_node as any).category).toBe('budget');
  });

  it('passes through unknown extra fields (e.g. decided_on) on profile nodes', () => {
    const parsed = ProfileCapturePayload.parse(
      payloadWith({
        ...PROFILE_NODES.campaign_decision!,
        decided_on: '2026-05-19',
        decided_by: 'CMO',
      }),
    );
    const pn = parsed.candidates[0]!.proposed_node as any;
    expect(pn.decided_on).toBe('2026-05-19');
    expect(pn.decided_by).toBe('CMO');
  });
});

describe('founding behaviour is unchanged (byte-identical strict union)', () => {
  const goal = {
    id: 'g1',
    type: 'goal',
    created_at: ts,
    updated_at: ts,
    title: 'Q2 north star',
    body: 'Land 10 design partners.',
    priority: 'north_star',
  };
  const positioning = {
    id: 'p1',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    body: 'synergy',
    kind: 'banned_phrase',
  };
  const decision = {
    id: 'd1',
    type: 'decision',
    created_at: ts,
    updated_at: ts,
    summary: 'Retired the v1 app',
    body: 'Moved everyone to the web app.',
    decided_on: '2026-04-30',
    category: 'scope',
  };

  for (const [name, node] of Object.entries({ goal, positioning, decision })) {
    it(`founding ${name} still parses under the strict CapturePayload`, () => {
      const parsed = CapturePayload.parse(payloadWith(node));
      expect(parsed.candidates[0]!.proposed_node.type).toBe(node.type);
    });
  }

  it('founding kinds also parse cleanly under ProfileCapturePayload (superset)', () => {
    // ProfileNode is a permissive superset, so a founding profile could parse
    // either way — we only switch to it for non-founding profiles, but it must
    // not corrupt legacy shapes if it ever sees one.
    const parsed = ProfileCapturePayload.parse(payloadWith(positioning));
    expect(parsed.candidates[0]!.proposed_node.type).toBe('positioning');
    expect((parsed.candidates[0]!.proposed_node as any).kind).toBe('banned_phrase');
  });
});

// The separate "dedup pipeline accepts profile-kind candidates end-to-end"
// tests that used to live here (dedupAgainstGraph) tested the dedup-judge
// stage Light removed: capture now reads the subfolder's own nodes directly
// and decides addition/change/nuance itself (see runCaptureSingle /
// captureSlots' subfolder_nodes slot in anthropic.ts / prompt-render.ts) —
// there is no separate post-capture dedup-against-graph pass left to call.
