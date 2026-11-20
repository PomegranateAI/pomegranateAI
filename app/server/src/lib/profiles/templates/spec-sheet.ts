import type { ContextProfile } from '../../schemas.js';

/**
 * `spec_sheet` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts. See docs/llm-calls.md and
 * src/lib/prompt-render.ts.
 */
export const specSheetTemplate: ContextProfile = {
  id: 'spec_sheet',
  name: 'Spec sheet',
  shape: 'log',
  // PLACEHOLDER
  routing_hint:
    'Spec sheet: documents that state, change, or resolve what something being built must do, ' +
    'what is out of scope, or what is still an open question.',
  // PLACEHOLDER
  description:
    'A running log of what a spec says: requirements added, requirements or questions resolved, ' +
    'and open questions raised. Batch everything from one document into one node per kind, one ' +
    'item per line. A requirement is something the team states the built thing must do.',
  kinds: [
    {
      key: 'spec_additions',
      label: 'Spec additions',
      label_plural: 'Spec additions',
      color: 1,
      // PLACEHOLDER
      description:
        'Every requirement, non-goal, and success metric newly stated in one document, as one ' +
        'node. Body: one per line, prefixed `Requirement:`, `Non-goal:`, or `Success metric:`.',
    },
    {
      key: 'spec_resolutions',
      label: 'Spec resolutions',
      label_plural: 'Spec resolutions',
      color: 2,
      // PLACEHOLDER
      description:
        'Every requirement reported shipped, done, or cut, and every open question answered, in ' +
        'one document, as one node. Body: one per line with its outcome.',
    },
    {
      key: 'open_questions_raised',
      label: 'Open questions raised',
      label_plural: 'Open questions raised',
      color: 3,
      // PLACEHOLDER
      description:
        'Every question still unanswered at the end of one document, as one node, one question ' +
        'per line.',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'prd',
      label: 'PRD / spec / one-pager',
      description: 'A written spec whose purpose is stating what something must do.',
      // PLACEHOLDER
      extraction_guidance: 'Batch every requirement and every open question the document states.',
      source_kinds: ['doc'],
    },
    {
      key: 'grooming_meeting',
      label: 'Grooming / review meeting',
      description: 'A meeting or transcript where scope was discussed, added, or resolved.',
      // PLACEHOLDER
      extraction_guidance: 'Extract agreed scope and answered questions only.',
      source_kinds: ['transcript'],
    },
    {
      key: 'scope_thread',
      label: 'Slack thread',
      description: 'A chat thread negotiating or clarifying scope.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what the thread settles.',
      source_kinds: ['slack'],
    },
    {
      key: 'scope_mail',
      label: 'Escalation / scope mail',
      description: 'An email proposing, confirming, or resolving a requirement.',
      // PLACEHOLDER
      extraction_guidance: 'Treat it as a spec revision.',
      source_kinds: ['interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'coverage', label: 'Coverage', description: 'whether the draft covers what the log shows as required' },
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects the latest state of each requirement' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'claims a requirement the log shows was cut, or omits one still required',
    yellow: 'treats an open question as settled',
    green: 'consistent with the log (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What is currently required?', 'What is still an open question?'],
};
