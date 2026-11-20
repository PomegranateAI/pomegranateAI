import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance, interviewGuidance } from '../source-types.js';

/**
 * The `founding` profile — byte-equivalent to the behaviour the core shipped
 * with before context profiles existed. This is the migration target for every
 * existing workspace, and the default for new ones.
 *
 * Kind keys, subkinds, categories, feedback dimensions, review kinds, and flag
 * semantics here MUST match the hardcoded enums and prompt decision-trees that
 * used to live in lib/schemas.ts and lib/prompts/*.md. The kind `description`
 * fields carry the exact capture decision-tree guidance the founding prompts
 * used; `prompt-render.ts` injects them so rendered founding prompts are
 * semantically identical to the original hardcoded ones.
 */
export const foundingProfile: ContextProfile = {
  id: 'founding',
  shape: 'items',
  name: 'Founding team',
  routing_hint:
    'Company-level durable strategy: the goals / north-star the whole company is pursuing, ' +
    'how the company positions itself, and the committed cross-functional decisions. Route ' +
    'here for top-level strategy not owned by a single function. Founding overlaps every ' +
    'function — include it ALONGSIDE product / marketing / program whenever a document sets ' +
    'company-wide direction.',
  description:
    'A founding / leadership team tracking goals, positioning, and decisions. ' +
    'The context is the durable strategy: what we are pursuing, how we talk about ' +
    'ourselves, and the concrete choices we have committed to.',
  kinds: [
    {
      key: 'goal',
      label: 'Goal',
      label_plural: 'Goals',
      color: 1,
      description:
        'A target, OKR, north star, or priority the team is pursuing.\n\n' +
        'goal.title (≤10 words): noun phrase. Include the metric and target if the ' +
        'source has them. Period is a separate field; do not duplicate it in the title.\n' +
        'goal.body (1-3 sentences): re-state the target; rationale if present; ' +
        'ownership/scope if present.\n\n' +
        'goal.priority — choose ONE:\n' +
        '- north_star: source uses "north star", "the goal", "top priority", or is ' +
        'unambiguously the singular top goal of the period.\n' +
        '- priority: a stated priority but not the top one; "a priority", "second priority".\n' +
        '- supporting: a supporting / contributing goal; "supporting", "in service of", ' +
        '"rolls up to".',
      attrs: [
        { key: 'period', label: 'Period', type: 'string', description: 'e.g. "Q2 2026"' },
        {
          key: 'metric',
          label: 'Metric',
          type: 'object',
          description: 'Optional: { name, current?, target? }',
        },
      ],
      buckets: [
        { key: 'north_star', label: 'North star', match: 'priority' },
        { key: 'priority', label: 'Priority', match: 'priority' },
        { key: 'supporting', label: 'Supporting', match: 'priority' },
      ],
      // Triage: a new goal entering the canon redirects every downstream
      // draft — always worth individual eyes. The north star is the anchor.
      consequence: 'high',
      anchor: { match: 'priority', values: ['north_star'] },
    },
    {
      key: 'positioning',
      label: 'Positioning',
      label_plural: 'Positioning',
      color: 2,
      description:
        'A stance, differentiator, banned/approved phrase, killed messaging, or ' +
        'competitive claim.\n\n' +
        'positioning.body (1-3 sentences): the canonical claim in declarative voice, ' +
        'present tense; rationale or evidence if the source gives one. Drop rollout ' +
        'logistics unless that IS the positioning claim. For killed_messaging, lead with ' +
        'what is being killed ("Drop X." / "Retire X."). For banned_phrase / ' +
        'approved_phrase, quote the phrase verbatim in the body.\n\n' +
        'positioning.subkind — apply this decision tree top-down; first match wins:\n' +
        '1. Source says stop saying / drop / kill / retire a specific message or framing ' +
        '→ killed_messaging.\n' +
        '2. Source says never say / banned / don’t use a specific word or phrase ' +
        '→ banned_phrase.\n' +
        '3. Source says always say / adopt / approved / start using a specific word or ' +
        'phrase → approved_phrase.\n' +
        '4. The claim is about a specific competitor (we vs. them, they do X we don’t) ' +
        '→ competitive_claim.\n' +
        '5. The claim describes how we differ from the market/competitors in general (our ' +
        'defining edge) → differentiator.\n' +
        '6. The claim is a general declarative stance that doesn’t fit above → stance.',
      subkinds: [
        {
          key: 'stance',
          label: 'Stance',
          description: 'A general declarative stance that does not fit the other subkinds.',
        },
        {
          key: 'differentiator',
          label: 'Differentiator',
          description: 'How we differ from the market/competitors in general — our defining edge.',
        },
        {
          key: 'killed_messaging',
          label: 'Killed messaging',
          description: 'A message or framing we have decided to stop saying / drop / kill / retire.',
        },
        {
          key: 'banned_phrase',
          label: 'Banned phrase',
          description: 'A specific word or phrase we never say / have banned / do not use.',
        },
        {
          key: 'approved_phrase',
          label: 'Approved phrase',
          description: 'A specific word or phrase we always say / have adopted / approve / start using.',
        },
        {
          key: 'competitive_claim',
          label: 'Competitive claim',
          description: 'A claim about a specific competitor (we vs. them, they do X we do not).',
        },
      ],
      // Triage: phrase/stance additions are the bread-and-butter of bulk
      // curation; reversals (killed messaging) arrive red-flagged and the
      // red carve-out protects them regardless of tier.
      consequence: 'medium',
    },
    {
      key: 'decision',
      label: 'Decision',
      label_plural: 'Decisions',
      color: 3,
      description:
        'A concrete choice with a date, on a non-positioning, non-goal topic.\n\n' +
        'decision.summary (≤12 words): imperative verb + object + key constraint. No ' +
        'subject ("we"). No source-metadata (omit "effective today", "by Friday", speaker ' +
        'names). Material dates and owners go in decided_on / decided_by. Lowercase except ' +
        'proper nouns and dollar amounts.\n' +
        'decision.body (1-3 sentences): re-state the claim in declarative voice; rationale ' +
        'if given; material scope or owner if given.\n\n' +
        'decision.category — apply these in order; the first match wins:\n' +
        '- pricing: the choice changes prices, tiers, discounts, contract floors/ceilings, ' +
        'payment terms.\n' +
        '- hiring: the choice changes headcount, opens/closes roles, hires/fires.\n' +
        '- scope: the choice changes what we build, ship, or maintain (defer/cut/restart a ' +
        'product or feature).\n' +
        '- positioning: leave as positioning — emit a positioning candidate, not a decision.\n' +
        '- strategy: the choice is multi-functional or sets direction without fitting the above.\n' +
        '- other: use only if none of the above genuinely apply.',
      categories: [
        { key: 'pricing', label: 'Pricing' },
        { key: 'positioning', label: 'Positioning' },
        { key: 'scope', label: 'Scope' },
        { key: 'hiring', label: 'Hiring' },
        { key: 'strategy', label: 'Strategy' },
        { key: 'other', label: 'Other' },
      ],
      attrs: [
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
      ],
      // Triage: a decision is a commitment ICs' AI tools will enforce —
      // a wrong one propagates immediately. Always individual eyes.
      consequence: 'high',
    },
  ],
  feedback_dimensions: [
    {
      key: 'decisions',
      label: 'Decisions',
      description: 'alignment with what leadership has decided',
    },
    {
      key: 'goals_priorities',
      label: 'Goals & priorities',
      description: 'does this lead with / serve current direction',
    },
    {
      key: 'positioning',
      label: 'Positioning',
      description: 'current positioning, killed messaging, differentiators',
    },
    {
      key: 'brand_voice',
      label: 'Brand voice',
      description: 'banned phrases, approved vocabulary, on-tone language',
    },
    {
      key: 'context_recency',
      label: 'Context recency',
      description: 'recent shifts the work should reflect',
    },
  ],
  review_kinds: ['prd', 'exec_update', 'campaign', 'sales_email', 'deck', 'other'],
  query_scopes: [
    { key: 'decisions', label: 'Decisions', kind_keys: ['decision'] },
    { key: 'goals', label: 'Goals', kind_keys: ['goal'] },
    { key: 'positioning', label: 'Positioning', kind_keys: ['positioning'] },
    { key: 'brand_voice', label: 'Brand voice', kind_keys: ['positioning'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  flag_semantics: {
    red: 'change-away-from-prior strategy / contradiction (kill, reverse, replace a prior position)',
    yellow: 'a change proposed with explicit hedging or low conviction; no commitment',
    green: 'a consistent addition with no reversal signal and no hedging (default)',
  },
  // Typed node↔node relations. Small on purpose: each edge answers a real
  // retrieval question — "what serves the north star?", "which decision
  // produced this stance?", "what replaced the killed messaging?".
  edge_kinds: [
    {
      key: 'supports',
      label: 'Supports',
      description:
        'Points FROM the supporting or priority goal TO the broader goal it advances (typically the north star).',
      src_kinds: ['goal'],
      dst_kinds: ['goal'],
      directed: true,
    },
    {
      key: 'establishes',
      label: 'Establishes',
      description:
        'Points FROM the dated decision TO the positioning stance or goal it established or changed — answers "which call produced this position?".',
      src_kinds: ['decision'],
      dst_kinds: ['positioning', 'goal'],
      directed: true,
    },
    {
      key: 'replaces',
      label: 'Replaces',
      description:
        'Points FROM the current stance or phrase TO the killed messaging or superseded position it replaced. Keeps the kill history queryable.',
      src_kinds: ['positioning'],
      dst_kinds: ['positioning'],
      directed: true,
    },
  ],
  // Source types this profile expects. The router classifies each document;
  // the matched type's extraction_guidance is injected into capture calls.
  // No group_floor entries: this profile declares no extraction_groups, so
  // capture is a single call covering every kind — there is no routing step
  // that could drop a group. If extraction_groups are ever added, every
  // source type here MUST gain a group_floor (see validate.ts).
  source_types: [
    {
      key: 'strategy_doc',
      label: 'Strategy doc',
      description: 'A strategy memo, vision doc, plan, or positioning document from leadership.',
      extraction_guidance: '',
      // Triage: an authored leadership artifact — either it IS the current
      // strategy (commit it whole) or it isn't (and that's a user question).
      commit_unit: true,
      currency: 'decaying',
      triage_guidance:
        'Legitimate when it reads as an authored leadership artifact (positions stated as settled, not brainstormed) and its stated period has not passed. Be suspicious of drafts, options memos, and docs whose own dates put them behind the graph.',
    },
    {
      key: 'board_or_investor_material',
      label: 'Board / investor material',
      description: 'A board update, investor letter, or pitch material about the company.',
      extraction_guidance:
        'Board-facing statements of goals, positioning, and decisions are high-authority canon. Forward-looking pitch flourish that the company has not adopted internally stays out.',
      commit_unit: true,
      currency: 'decaying',
      triage_guidance:
        'Board-facing material is high-authority but date-sensitive: a deck from two quarters ago describes a prior strategy. Anchor currency on the period the material itself claims to cover.',
    },
    {
      key: 'leadership_meeting_notes',
      label: 'Leadership meeting notes',
      description: 'Notes or minutes from a leadership/exec meeting.',
      extraction_guidance:
        'Extract stated outcomes (decisions, goal changes, positioning calls); skip the discussion that led there. Action items are logistics, not canon.',
      // A record of discussion — never accurate "as a unit"; item triage.
      currency: 'point_in_time',
    },
    {
      key: 'external_interview',
      label: 'External interview',
      description: 'A call with a customer, advisor, or candidate touching strategy or positioning.',
      extraction_guidance: interviewGuidance(
        'Only the workspace-owner side\'s settled statements yield canon here (goals, positioning, decisions); the external party\'s words are context, not canon, unless leadership adopts them in the conversation.',
      ),
      source_kinds: ['transcript'],
      currency: 'point_in_time',
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between founders/teammates.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from founding-team chat: decisions both founders converge on (naming, pricing, scope, hiring), goal or positioning changes treated as settled, and killed directions — kills settled in chat are real kills and flag red.',
      ),
      source_kinds: ['slack'],
      currency: 'point_in_time',
    },
  ],
  seed_questions: [
    'What is our current north star?',
    'What messaging have we killed?',
    'What phrases are banned?',
    'What pricing decisions are in effect?',
    'What is our core differentiator?',
  ],
};
