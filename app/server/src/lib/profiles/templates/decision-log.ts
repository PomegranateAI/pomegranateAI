import type { ContextProfile } from '../../schemas.js';

/**
 * `decision_log` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts. See docs/llm-calls.md and
 * src/lib/prompt-render.ts.
 */
export const decisionLogTemplate: ContextProfile = {
  id: 'decision_log',
  name: 'Decision log',
  shape: 'log',
  // PLACEHOLDER
  routing_hint:
    'Decision log: documents that report a choice was settled, or an earlier choice was ' +
    'overturned. Not threads that only float options.',
  // PLACEHOLDER
  description:
    'A running log of choices that were made or reversed. Batch everything from one document ' +
    'into one node per kind. A reversal is a new entry, never an edit. Extract only what the ' +
    'source reports as settled, not what was merely discussed.',
  kinds: [
    {
      key: 'decision_made',
      label: 'Decisions made',
      label_plural: 'Decisions made',
      color: 3,
      // PLACEHOLDER
      description:
        'Every choice newly settled in one document, as one node. Body: one choice per line, ' +
        'with rationale and alternatives when the source states them.',
    },
    {
      key: 'decision_reversed',
      label: 'Decisions reversed',
      label_plural: 'Decisions reversed',
      color: 4,
      // PLACEHOLDER
      description:
        'Every earlier choice reported as overturned in one document, as one node. Body: one per ' +
        'line, saying what it is now instead.',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'decision_doc',
      label: 'Decision doc / ADR',
      description: 'A written record whose purpose is stating a decision and its rationale.',
      // PLACEHOLDER
      extraction_guidance: 'Batch every decision the document states, with its rationale.',
      source_kinds: ['doc'],
    },
    {
      key: 'decision_meeting',
      label: 'Meeting / review',
      description: 'A meeting or transcript where a choice was discussed and settled.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what was agreed, not options still being weighed.',
      source_kinds: ['transcript'],
    },
    {
      key: 'converged_thread',
      label: 'Slack thread',
      description: 'A chat thread that reaches explicit agreement on a choice.',
      // PLACEHOLDER
      extraction_guidance: 'Extract a decision only when the thread shows agreement.',
      source_kinds: ['slack'],
    },
    {
      key: 'decision_confirmation',
      label: 'Confirmation mail',
      description: 'An email or message confirming a decision that was made elsewhere.',
      // PLACEHOLDER
      extraction_guidance: 'Treat the confirmation as the decision record.',
      source_kinds: ['interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'consistency', label: 'Consistency', description: 'whether the draft matches the latest logged decisions' },
    { key: 'grounding', label: 'Grounding', description: 'whether claimed reasons match the logged rationale' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'contradicts what the log most recently reported about a decision',
    yellow: 'states a rationale the log does not carry',
    green: 'consistent with the log (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What did we decide about this?', 'Has this decision been reversed?'],
};
