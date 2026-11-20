import type { ContextProfile } from '../../schemas.js';

/**
 * `policy_book` — PLACEHOLDER template (shape: `items`).
 *
 * The structure below (id, shape, kind keys, attrs and enums, edge kinds,
 * source channels) is what the runtime depends on. Every prose string is a
 * minimal working placeholder: replace it with guidance for your own use
 * case. The strings are sent to the capture / routing / review / edge-inference
 * prompts. See docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const policyBookTemplate: ContextProfile = {
  id: 'policy_book',
  name: 'Policy book',
  shape: 'items',
  // PLACEHOLDER
  routing_hint:
    'Policy book: documents that say what is or is not allowed: rules, restrictions, required ' +
    'disclosures, and what backs them.',
  // PLACEHOLDER
  description:
    'Rules about what is and is not allowed, one rule per node, stated so a draft can be checked ' +
    'against it. Record what backs each rule and where it applies. When a document changes a ' +
    'rule, amend the existing rule instead of adding a new one.',
  kinds: [
    {
      key: 'policy',
      label: 'Policy',
      label_plural: 'Policies',
      color: 2,
      // PLACEHOLDER
      description:
        'One rule about what may or may not be said or done. Title: the rule itself. Body: ' +
        'reasoning, exceptions, and consequences as the source states them.',
      attrs: [
        {
          key: 'verdict',
          label: 'Verdict',
          type: 'enum',
          values: ['prohibited', 'required', 'allowed'],
          required: true,
          // PLACEHOLDER
          description: 'Always set: whether the rule prohibits, requires, or allows.',
        },
        {
          key: 'authority',
          label: 'Authority',
          type: 'enum',
          values: ['law', 'regulator', 'contract', 'counsel', 'internal'],
          required: true,
          // PLACEHOLDER
          description: 'Always set: what backs the rule; `internal` when the source names nothing.',
        },
        {
          key: 'basis',
          label: 'Basis',
          type: 'string',
          // PLACEHOLDER
          description: 'The statute, clause, or person cited, verbatim; omit if none.',
        },
        {
          key: 'scope',
          label: 'Scope',
          type: 'string',
          // PLACEHOLDER
          description: 'Where the rule applies, when the source limits it.',
        },
      ],
    },
  ],
  edge_kinds: [
    {
      key: 'excepts',
      label: 'Excepts',
      // PLACEHOLDER
      description: 'The source policy is an exception to the destination policy, as stated.',
      src_kinds: ['policy'],
      dst_kinds: ['policy'],
      directed: true,
    },
    {
      key: 'derives_from',
      label: 'Derives from',
      // PLACEHOLDER
      description: 'The source policy implements the broader destination policy, as stated.',
      src_kinds: ['policy'],
      dst_kinds: ['policy'],
      directed: true,
    },
  ],
  source_types: [
    {
      key: 'legal_review',
      label: 'Legal review',
      description: 'Counsel or compliance marking up work, or answering what is permitted.',
      // PLACEHOLDER
      extraction_guidance: 'Extract every restriction as its own policy, with its cited basis.',
      source_kinds: ['doc'],
    },
    {
      key: 'regulator_guidance',
      label: 'Regulation / regulator guidance',
      description: 'A statute, regulation, or official guidance from a governing body.',
      // PLACEHOLDER
      extraction_guidance: 'Carry the citation verbatim and set the scope it applies to.',
      source_kinds: ['interaction'],
    },
    {
      key: 'policy_decision',
      label: 'Internal policy decision',
      description: 'A discussion where the team set a boundary for itself.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only settled rules, with `authority: internal`.',
      source_kinds: ['slack', 'transcript'],
    },
  ],
  feedback_dimensions: [
    { key: 'permission', label: 'Permission', description: 'whether the draft does something a policy prohibits or requires' },
    { key: 'substantiation', label: 'Substantiation', description: 'whether claims carry the backing a policy requires' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'policies', label: 'Policies', kind_keys: ['policy'] },
  ],
  flag_semantics: {
    red: 'does something a policy prohibits, or omits something it requires',
    yellow: 'approaches a policy boundary',
    green: 'consistent with the policies that apply (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What are we not allowed to claim?', 'What disclosures are required?'],
};
