import type { ContextProfile } from '../../schemas.js';

/**
 * `user_insight` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts. See docs/llm-calls.md and
 * src/lib/prompt-render.ts.
 */
export const userInsightTemplate: ContextProfile = {
  id: 'user_insight',
  name: 'User insight',
  shape: 'log',
  // PLACEHOLDER
  routing_hint:
    'User insight: documents that report a specific interview or research conversation with an ' +
    'identifiable person.',
  // PLACEHOLDER
  description:
    'A running log of user interview sessions, one node per session. Open with who the person is ' +
    '(persona, role), then what they shared: pains, preferences, tools, feedback. A follow-up ' +
    'interview is a new entry. Leave out next actions and the interviewer\'s questions.',
  kinds: [
    {
      key: 'interview_notes',
      label: 'Interview notes',
      label_plural: 'Interview notes',
      color: 2,
      // PLACEHOLDER
      description:
        'One interview session as one node. Title: who the person is and a one-line theme. Body: ' +
        'persona and role, then what they shared, as the source states it.',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'interview_transcript',
      label: 'Interview transcript',
      description: 'A recorded or transcribed customer/user interview.',
      // PLACEHOLDER
      extraction_guidance: 'Write one node for the session; skip the interviewer\'s questions.',
      source_kinds: ['transcript'],
    },
    {
      key: 'interview_writeup',
      label: 'Researcher write-up',
      description: 'A researcher\'s own written summary of an interview session.',
      // PLACEHOLDER
      extraction_guidance: 'Treat the write-up as the session record.',
      source_kinds: ['doc'],
    },
    {
      key: 'interview_relay',
      label: 'Relayed interview notes',
      description: 'A Slack message or email relaying what happened in an interview someone else ran.',
      // PLACEHOLDER
      extraction_guidance: 'Capture what the relay reports about the session.',
      source_kinds: ['slack', 'interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'grounding', label: 'Grounding', description: 'whether claims about users match a recorded session' },
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects the most recent session' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'attributes something to a user the sessions do not record',
    yellow: 'generalizes from one session',
    green: 'consistent with the sessions on record (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What have users told us about their pains?', 'What feedback have we heard?'],
};
