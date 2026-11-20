import type { ContextProfile } from '../../schemas.js';

/**
 * `goals_metrics` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts. See docs/llm-calls.md and
 * src/lib/prompt-render.ts.
 */
export const goalsMetricsTemplate: ContextProfile = {
  id: 'goals_metrics',
  name: 'Goals & metrics',
  shape: 'log',
  // PLACEHOLDER
  routing_hint:
    'Goals & metrics: documents that set a goal or target, or report where an existing goal ' +
    'currently stands.',
  // PLACEHOLDER
  description:
    'A running log of goals and progress against them. A target with no current value is a goal ' +
    'set; a current or actual value against a target is a check-in. Batch everything from one ' +
    'document into one node per kind, one goal per line.',
  kinds: [
    {
      key: 'goals_set',
      label: 'Goals set',
      label_plural: 'Goals set',
      color: 5,
      // PLACEHOLDER
      description:
        'Every goal or target newly set in one document, as one node. Body: one goal per line ' +
        'with metric, target, owner, and timeframe when stated.',
    },
    {
      key: 'goal_checkins',
      label: 'Goal check-ins',
      label_plural: 'Goal check-ins',
      color: 6,
      // PLACEHOLDER
      description:
        'Every progress report against an existing goal in one document, as one node. Body: one ' +
        'goal per line with its current value or status.',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'okr_doc',
      label: 'OKR doc / goals tracker',
      description: 'A written OKR document, goals-tracking export, or planning doc that sets targets.',
      // PLACEHOLDER
      extraction_guidance: 'Batch every goal the document sets, with target, owner, and timeframe.',
      source_kinds: ['doc'],
    },
    {
      key: 'planning_meeting',
      label: 'Planning / review meeting',
      description: 'A meeting or transcript where targets were set or progress was reviewed.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only agreed targets and reported progress.',
      source_kinds: ['transcript'],
    },
    {
      key: 'metrics_thread',
      label: 'Slack thread',
      description: 'A chat thread setting a target or reporting a metric update.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what the thread settles or reports.',
      source_kinds: ['slack'],
    },
    {
      key: 'metrics_mail',
      label: 'Metrics update mail',
      description: 'An email reporting a goal or metric update.',
      // PLACEHOLDER
      extraction_guidance: 'Treat it as a progress report.',
      source_kinds: ['interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects the latest reported value for a metric' },
    { key: 'accuracy', label: 'Accuracy', description: 'whether a claimed target or value matches the log' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'states a target or value the log contradicts',
    yellow: 'refers to a goal not tracked here',
    green: 'consistent with the log (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What are our current goals?', 'How are we tracking against them?'],
};
