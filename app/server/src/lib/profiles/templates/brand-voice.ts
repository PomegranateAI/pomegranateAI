import type { ContextProfile } from '../../schemas.js';

/**
 * `brand_voice` — PLACEHOLDER template (shape: `items`).
 *
 * The structure below (id, shape, kind keys, attrs and enums, edge kinds,
 * query scopes, source channels) is what the runtime depends on. Every prose
 * string is a minimal working placeholder: replace it with guidance for your
 * own use case. The strings are sent to the capture / routing / review /
 * edge-inference prompts. See docs/llm-calls.md and src/lib/prompt-render.ts.
 */
export const brandVoiceTemplate: ContextProfile = {
  id: 'brand_voice',
  // Distinct display name from the built-in `brand_voice` workspace profile.
  name: 'Brand voice (data agent)',
  shape: 'items',
  // PLACEHOLDER
  routing_hint:
    'Brand voice: documents that say how things should be worded: voice traits, tone and style ' +
    'rules, banned or approved phrases, and examples of on- or off-voice copy.',
  // PLACEHOLDER
  description:
    'How the brand sounds: voice attributes, writing rules, lexicon entries, and specimens of ' +
    'real copy. One rule or phrase per node. Capture specimens verbatim, never paraphrased. When ' +
    'a document changes a rule, amend the existing rule in its own terms.',
  kinds: [
    {
      key: 'voice_attribute',
      label: 'Voice attribute',
      label_plural: 'Voice attributes',
      color: 1,
      // PLACEHOLDER
      description:
        'A durable trait of the voice, such as an archetype or a tone the brand holds. A specific ' +
        'wording instruction is a voice rule instead.',
    },
    {
      key: 'voice_rule',
      label: 'Voice rule',
      label_plural: 'Voice rules',
      color: 2,
      // PLACEHOLDER
      description:
        'One writing instruction a writer could follow or break. Title: the rule itself. Set ' +
        '`channel` when it applies to one channel only.',
      attrs: [
        {
          key: 'channel',
          label: 'Channel',
          type: 'string',
          // PLACEHOLDER
          description: 'The channel the rule is limited to, when the source limits it.',
        },
      ],
    },
    {
      key: 'lexicon',
      label: 'Lexicon entry',
      label_plural: 'Lexicon',
      color: 3,
      // PLACEHOLDER
      description:
        'One exact phrase, word, or spelling with a verdict, quoted verbatim, one phrase per node. ' +
        'Title: the phrase itself.',
      attrs: [
        {
          key: 'verdict',
          label: 'Verdict',
          type: 'enum',
          values: ['banned', 'approved', 'canonical_spelling'],
          required: true,
          // PLACEHOLDER
          description: 'Always set: whether the phrase is banned, approved, or the canonical spelling.',
        },
        {
          key: 'instead_use',
          label: 'Instead use',
          type: 'string',
          // PLACEHOLDER
          description: 'The replacement for a banned phrase, verbatim, when the source gives one.',
        },
      ],
    },
    {
      key: 'exemplar',
      label: 'Specimen',
      label_plural: 'Specimens',
      color: 4,
      // PLACEHOLDER
      description:
        'A piece of real copy, carried verbatim, that shows the voice or breaks it. For a rewrite, ' +
        'carry both versions labelled BEFORE: and AFTER:.',
      attrs: [
        {
          key: 'verdict',
          label: 'Verdict',
          type: 'enum',
          values: ['on_voice', 'off_voice', 'before_after'],
          required: true,
          // PLACEHOLDER
          description: 'Always set: what the specimen demonstrates.',
        },
        {
          key: 'asset_url',
          label: 'Asset URL',
          type: 'string',
          // PLACEHOLDER
          description: 'Link to the original artifact, when given. Keep the text too.',
        },
      ],
    },
  ],
  edge_kinds: [
    {
      key: 'demonstrates',
      label: 'Demonstrates',
      // PLACEHOLDER
      description: 'The specimen shows the rule or attribute followed or broken, as the source states.',
      src_kinds: ['exemplar'],
      dst_kinds: ['voice_rule', 'voice_attribute'],
      directed: true,
    },
    {
      key: 'refines',
      label: 'Refines',
      // PLACEHOLDER
      description: 'The rule is a concrete form of the broader attribute, as the source states.',
      src_kinds: ['voice_rule'],
      dst_kinds: ['voice_attribute'],
      directed: true,
    },
  ],
  source_types: [
    {
      key: 'style_guide',
      label: 'Style guide',
      description: 'A document stating how the brand should write.',
      // PLACEHOLDER
      extraction_guidance: 'Extract every rule as its own node; quote examples verbatim as specimens.',
      source_kinds: ['doc'],
    },
    {
      key: 'copy_review',
      label: 'Copy review / edit',
      description: 'Someone marking up copy, or a discussion of why wording was changed.',
      // PLACEHOLDER
      extraction_guidance: 'Carry before and after versions verbatim, with the stated reason.',
      source_kinds: ['slack', 'interaction'],
    },
    {
      key: 'voice_discussion',
      label: 'Voice discussion',
      description: 'A conversation about how the brand should sound.',
      // PLACEHOLDER
      extraction_guidance: 'Extract only what was settled.',
      source_kinds: ['transcript'],
    },
  ],
  feedback_dimensions: [
    { key: 'voice', label: 'Voice', description: 'whether the draft matches the voice character and rules' },
    { key: 'lexicon', label: 'Lexicon', description: 'whether the draft uses banned or misses approved phrasing' },
  ],
  review_kinds: ['other'],
  query_scopes: [
    { key: 'all', label: 'Everything', kind_keys: 'all' },
    { key: 'rules', label: 'Rules', kind_keys: ['voice_rule', 'voice_attribute'] },
    { key: 'lexicon', label: 'Lexicon', kind_keys: ['lexicon'] },
    { key: 'specimens', label: 'Specimens', kind_keys: ['exemplar'] },
  ],
  flag_semantics: {
    red: 'breaks a voice rule or uses a banned phrase',
    yellow: 'strays from the voice character',
    green: 'consistent with the rules and lexicon (default)',
  },
  // PLACEHOLDER
  seed_questions: ['What phrases are banned?', 'Show me copy that is on-voice.'],
};
