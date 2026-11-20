import type { ContextProfile } from '../../schemas.js';

/**
 * `people_list` — PLACEHOLDER template (shape: `items`).
 *
 * The structure below (id, shape, kind keys, the `status` enum, `progress`,
 * the `about` edge, source channels) is what the runtime depends on. Every
 * prose string is a minimal working placeholder: replace it with guidance for
 * your own use case. The strings are sent to the capture / routing / review /
 * edge-inference prompts. See docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const peopleListTemplate: ContextProfile = {
  id: 'people_list',
  name: 'People list',
  shape: 'items',
  // PLACEHOLDER
  routing_hint:
    'People list: documents that add people to a roster tracked for a purpose, give their ' +
    'contact details, or report where someone stands (reached out, responded, scheduled, done).',
  // PLACEHOLDER
  description:
    'A roster of people tracked for the purpose the folder\'s own description defines. One ' +
    '`contact` node per person; each report about a person is its own `status_update` node. If a ' +
    'status is about someone new, write both. Copy links and contact details verbatim.',
  kinds: [
    {
      key: 'contact',
      label: 'Contact',
      label_plural: 'Contacts',
      color: 1,
      // PLACEHOLDER
      description:
        'One person on the list. Title: their name. Body: role, why they are tracked, links and ' +
        'contact details, verbatim. Amend the existing node only for new or corrected details.',
      body_spec: 'body (string — this person\'s identifying info, copied verbatim; may be just the name)',
    },
    {
      key: 'status_update',
      label: 'Status update',
      label_plural: 'Status updates',
      color: 2,
      // PLACEHOLDER
      description:
        'One report about one person. Title: their name and a short gist. Body: what the source ' +
        'reports about them, in its own terms. Never amended; a later report is a new node.',
      body_spec: 'body (string, 1-3 sentences: what this document reports about this person)',
      attrs: [
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['reached_out', 'responded', 'signaled', 'scheduled', 'completed', 'declined', 'unreachable'],
          required: true,
          // PLACEHOLDER
          description: 'Always set: where the person now stands, per this report.',
        },
      ],
      progress: { attr: 'status', settled_values: ['completed', 'declined', 'unreachable'] },
    },
  ],
  edge_kinds: [
    {
      key: 'about',
      label: 'About',
      // PLACEHOLDER
      description: 'The status update reports on this contact, when it names that person.',
      src_kinds: ['status_update'],
      dst_kinds: ['contact'],
      directed: true,
    },
  ],
  source_types: [
    {
      key: 'research_list',
      label: 'Research list / export',
      description: 'A list of names compiled from research, a directory, or a spreadsheet export.',
      // PLACEHOLDER
      extraction_guidance: 'One contact node per name, details copied exactly.',
      source_kinds: ['doc'],
    },
    {
      key: 'referral_thread',
      label: 'Referral thread',
      description: 'A chat thread where someone suggests or shares people to add to the list.',
      // PLACEHOLDER
      extraction_guidance: 'One contact node per person named anywhere in the thread.',
      source_kinds: ['slack'],
    },
    {
      key: 'outreach_call',
      label: 'Outreach call / meeting',
      description: 'A call or meeting transcript where an outreach conversation happens or gets discussed.',
      // PLACEHOLDER
      extraction_guidance: 'One status update per named person whose status is reported.',
      source_kinds: ['transcript'],
    },
    {
      key: 'outreach_mail',
      label: 'Outreach mail',
      description: 'An email thread reaching out to someone on the list or reporting back on outreach.',
      // PLACEHOLDER
      extraction_guidance: 'Read the last message first; the closing status is what matters.',
      source_kinds: ['interaction'],
    },
  ],
  feedback_dimensions: [
    { key: 'completeness', label: 'Completeness', description: 'whether the people a draft refers to are tracked here' },
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects each person\'s latest status' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'contacts', label: 'Contacts', kind_keys: ['contact'] },
  ],
  flag_semantics: {
    red: 'states a status the latest update contradicts, or invents contact details',
    yellow: 'refers to a person not tracked here',
    green: 'consistent with the list (default)',
  },
  // PLACEHOLDER
  seed_questions: ['Who is currently on the list?', 'Who is still unreached?'],
};
