import type { ContextProfile } from '../../schemas.js';

/**
 * `evidence_log` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts. See docs/llm-calls.md and
 * src/lib/prompt-render.ts.
 */
export const evidenceLogTemplate: ContextProfile = {
  id: 'evidence_log',
  name: 'Evidence log',
  shape: 'log',
  // PLACEHOLDER
  routing_hint:
    'Evidence log: documents that quote what a customer, user, or other voice said, such as ' +
    'pain points, requests, objections, or praise.',
  // PLACEHOLDER
  description:
    'A running log of what people actually said, kept close to verbatim. Batch every observation ' +
    'from one document into one node, one line each: a short [theme] label, who said it, and the ' +
    'quote. Never invent a quote; skip the interviewer\'s questions.',
  kinds: [
    {
      key: 'evidence_collected',
      label: 'Evidence collected',
      label_plural: 'Evidence collected',
      color: 4,
      // PLACEHOLDER
      description:
        'Every observation in one document, as one node. Body: one line each, formatted ' +
        '`[theme] who said it — quote`.',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'customer_interview',
      label: 'Customer / user interview',
      description: 'A recorded or transcribed interview with a customer, prospect, or user.',
      // PLACEHOLDER
      extraction_guidance: 'Quote the interviewee; skip questions and small talk.',
      source_kinds: ['transcript'],
    },
    {
      key: 'support_thread',
      label: 'Support ticket / escalation',
      description: 'A support ticket thread or an escalation forwarded by CS/sales.',
      // PLACEHOLDER
      extraction_guidance: 'Prefer the customer\'s own words over the agent\'s summary.',
      source_kinds: ['interaction'],
    },
    {
      key: 'survey_export',
      label: 'Survey / NPS free-text export',
      description: 'A written export of free-text survey or NPS responses.',
      // PLACEHOLDER
      extraction_guidance: 'One line per respondent, quoted as given.',
      source_kinds: ['doc'],
    },
    {
      key: 'relay_thread',
      label: 'Slack relay',
      description: 'A chat thread where someone relays what a customer, prospect, or stakeholder said.',
      // PLACEHOLDER
      extraction_guidance: 'Attribute the relayed observation to whoever it came from.',
      source_kinds: ['slack'],
    },
  ],
  feedback_dimensions: [
    { key: 'grounding', label: 'Grounding', description: 'whether claimed sentiment matches what the log recorded' },
    { key: 'coverage', label: 'Coverage', description: 'whether relevant evidence on record was considered' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'claims someone said something the log does not record',
    yellow: 'generalizes from a single observation',
    green: 'consistent with the log (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What pain points have customers raised?', 'What feature requests have we heard?'],
};
