import type { ContextProfile } from '../../schemas.js';

/**
 * `project_status` — PLACEHOLDER template (shape: `slots`).
 *
 * The structure below (id, shape, kind keys, the `section` enum, source
 * channels) is what the runtime depends on. Every prose string is a minimal
 * working placeholder: replace it with guidance for your own use case. The
 * strings are sent to the capture / routing / review prompts. See
 * docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const projectStatusTemplate: ContextProfile = {
  id: 'project_status',
  name: 'Project status',
  shape: 'slots',
  // PLACEHOLDER
  routing_hint:
    'Project status: documents that report how a project is going, what is blocked, what was ' +
    'decided, or what is coming next.',
  // PLACEHOLDER
  description:
    'A living status report with four sections: current state, blockers, recent decisions, next ' +
    'milestones. Emit at most one node per section a document touches, each a complete rewrite ' +
    'of that section: keep what still holds, drop what is resolved.',
  kinds: [
    {
      key: 'status_section',
      label: 'Section',
      label_plural: 'Sections',
      color: 1,
      // PLACEHOLDER
      description:
        'One section of the status report as it currently stands. Title: the section heading. ' +
        'Body: the full section, readable without other context.',
      attrs: [
        {
          key: 'section',
          label: 'Section',
          type: 'enum',
          values: ['current_state', 'blockers', 'recent_decisions', 'next_milestones'],
          required: true,
          // PLACEHOLDER
          description: 'Which of the four sections this node is. Always set.',
        },
        {
          key: 'as_of',
          label: 'As of',
          type: 'date',
          // PLACEHOLDER
          description: 'ISO date the source describes this state for; omit if it gives none.',
        },
      ],
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'standup',
      label: 'Standup / status note',
      description: 'A short recurring update on progress and blockers.',
      // PLACEHOLDER
      extraction_guidance: 'Usually touches current state and blockers only; rewrite each in full.',
      source_kinds: ['slack'],
    },
    {
      key: 'review_meeting',
      label: 'Review meeting',
      description: 'A meeting or transcript reviewing where the project stands.',
      // PLACEHOLDER
      extraction_guidance: 'Record what was settled, not what was discussed.',
      source_kinds: ['transcript', 'interaction'],
    },
    {
      key: 'status_doc',
      label: 'Status document / plan',
      description: 'A written status report, project plan, or roadmap update.',
      // PLACEHOLDER
      extraction_guidance: 'Usually rewrites all four sections; it is newer, so it wins.',
      source_kinds: ['doc'],
    },
  ],
  feedback_dimensions: [
    { key: 'currency', label: 'Currency', description: 'whether the draft matches where the project stands now' },
    { key: 'completeness', label: 'Completeness', description: 'whether the draft accounts for known blockers and milestones' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'sections', label: 'Sections', kind_keys: ['status_section'] },
  ],
  flag_semantics: {
    red: 'states a project state the current sections contradict',
    yellow: 'describes progress the sections do not cover',
    green: 'consistent with the sections as they stand (default)',
  },
  // PLACEHOLDER
  seed_questions: ['Where does the project stand?', 'What is blocking us?'],
};
