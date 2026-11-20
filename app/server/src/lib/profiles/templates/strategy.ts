import type { ContextProfile } from '../../schemas.js';

/**
 * `strategy` — PLACEHOLDER template (shape: `slots`).
 *
 * The structure below (id, shape, kind keys, the `section` enum, source
 * channels) is what the runtime depends on. Every prose string is a minimal
 * working placeholder: replace it with guidance for your own use case. The
 * strings are sent to the capture / routing / review prompts. See
 * docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const strategyTemplate: ContextProfile = {
  id: 'strategy',
  name: 'Strategy',
  shape: 'slots',
  // PLACEHOLDER
  routing_hint:
    'Strategy: documents that state or settle positioning (including against competitors), ' +
    'target audience, goals, or messaging pillars.',
  // PLACEHOLDER
  description:
    'A living strategy document with four sections: positioning, target audience, goals, and ' +
    'messaging pillars. Emit at most one node per section a document touches, each a complete ' +
    'rewrite: keep what still holds. Extract only settled positions, not options being weighed.',
  kinds: [
    {
      key: 'strategy_section',
      label: 'Section',
      label_plural: 'Sections',
      color: 5,
      // PLACEHOLDER
      description:
        'One section of the strategy as it currently stands. Title: the section heading. Body: ' +
        'the full section, readable without other context.',
      attrs: [
        {
          key: 'section',
          label: 'Section',
          type: 'enum',
          values: ['positioning', 'target_audience', 'goals', 'messaging_pillars'],
          required: true,
          // PLACEHOLDER
          description: 'Which of the four sections this node is. Always set.',
        },
      ],
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'positioning_doc',
      label: 'Positioning / strategy memo',
      description: 'A written strategy memo, positioning doc, or strategy-setting deck.',
      // PLACEHOLDER
      extraction_guidance: 'Rewrite only the sections the document addresses; it is newer, so it wins.',
      source_kinds: ['doc'],
    },
    {
      key: 'strategy_workshop',
      label: 'Strategy workshop / review',
      description: 'A meeting or transcript where positioning, audience, or goals were discussed and settled.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what was agreed.',
      source_kinds: ['transcript'],
    },
    {
      key: 'strategy_thread',
      label: 'Slack thread',
      description: 'A chat thread debating or settling one part of the strategy.',
      // PLACEHOLDER
      extraction_guidance: 'Rewrite the one section the thread settles, if any.',
      source_kinds: ['slack'],
    },
    {
      key: 'strategy_briefing',
      label: 'Briefing / external notes',
      description: 'Analyst or press briefing notes, or other external-facing notes touching strategy.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only sections the notes restate as current.',
      source_kinds: ['interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'consistency', label: 'Consistency', description: 'whether the draft matches the strategy sections' },
    { key: 'completeness', label: 'Completeness', description: 'whether the draft accounts for the audience and goals on record' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'sections', label: 'Sections', kind_keys: ['strategy_section'] },
  ],
  flag_semantics: {
    red: 'states a position the current sections contradict',
    yellow: 'describes strategy the sections do not cover',
    green: 'consistent with the sections (default)',
  },
  // PLACEHOLDER
  seed_questions: ['Who are we for?', 'What are we trying to achieve?'],
};
