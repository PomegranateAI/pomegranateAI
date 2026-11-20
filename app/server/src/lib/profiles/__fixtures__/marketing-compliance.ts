import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance } from '../source-types.js';

/**
 * The `marketing_compliance` built-in profile, v2. A case-law model for a
 * marketing-compliance function. Five layers:
 *
 *   AUTHORITY       policy   — the regime as an entity (issuer, version, status)
 *   NORMS           rule     — operative constraints, each tied to its policy
 *   INTERPRETATION  ruling   — decisions on situations and edge cases that
 *                              CLARIFY how rules apply (interpretation |
 *                              exception | escalation)
 *   GUIDANCE        guidance — distilled from training docs: definitions,
 *                              checklists, best practices, red flags
 *   PRECEDENT       sample   — approved / rejected / corrected copy
 *
 * The review path for an asset: applicable rules → rulings covering the
 * situation → nearest samples → if nothing covers it, yellow-flag and
 * escalate. Escalation outcomes come back as new rulings, so the graph
 * accumulates precedent. `supersedes` edges keep history queryable: review
 * binds to the ACTIVE version of a policy/rule/ruling while the chain shows
 * what changed and when.
 */
export const marketingComplianceProfile: ContextProfile = {
  id: 'marketing_compliance',
  shape: 'items',
  name: 'Marketing compliance',
  routing_hint:
    'The rules that govern marketing claims: regulatory / policy requirements, the operative ' +
    'rules and definitions extracted from them, case-by-case rulings, and approved / rejected ' +
    'sample precedents — plus the review of assets against them. SHARED ZONE — overlaps ' +
    'marketing on any content question: route here ALONGSIDE marketing whenever a document ' +
    'concerns what may or may not be SAID in marketing (rules, rulings, approvals, or a ' +
    'compliance review), even when it is also about a campaign or asset.',
  description:
    'A marketing-compliance function reviewing marketing content against policy. The ' +
    'context is the policy regimes that bind marketing (regulators, ad platforms, ' +
    'industry codes, internal policy, contracts), the operative rules extracted from ' +
    'them, the rulings that decide how concrete situations and edge cases are treated ' +
    '— clarifying the rules — the guidance distilled from training material ' +
    '(definitions, checklists, red flags), and the precedent record: approved, ' +
    'rejected, and corrected samples. The work product is compliance reviews of ' +
    'marketing assets before they ship.\n\n' +
    'REVIEW MODEL — evaluating an asset uses the WHOLE graph, in this order: (1) the ' +
    'active rules whose category/channel/jurisdiction cover the asset; (2) the rulings ' +
    'that cover the asset’s situation — a situation with an interpretation or an ' +
    'unexpired exception is treated the ruled way, never re-litigated; (3) the nearest ' +
    'samples — copy resembling a rejected sample inherits its objection unless a ' +
    'ruling says otherwise; (4) guidance checklists and red flags. A genuine gray area ' +
    'covered by NO rule or ruling is flagged yellow for escalation — the escalation ' +
    'outcome should be captured as a new ruling so the gap closes.\n\n' +
    'STATUS AND HISTORY — policies, rules, and rulings carry a status (active | ' +
    'superseded) and exceptions carry an expiry. Review binds to ACTIVE, unexpired ' +
    'norms only, but superseded versions stay in the graph (linked by supersedes) so ' +
    'history is auditable. A rule change or an overturned ruling is a reversal: flag ' +
    'red. Scope rules/rulings/samples with the jurisdiction, channel, and product ' +
    'attrs when stated; omit product when it applies to all marketing.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. An authority document or regime AS AN ENTITY — its name, issuer, version, effective date, status → policy. Emit it BEFORE its rules and set each rule’s policy attr to its name.\n' +
    '2. A normative constraint — obliges, forbids, or permits-with-conditions ("must", "may not", "is required", "never", "always") → rule\n' +
    '3. A decision on a CONCRETE situation or edge case — how a gray area is treated, an exception granted with conditions, an escalation resolved → ruling\n' +
    '4. Non-binding teaching from training/guidance material — a definition of a term, a pre-publish checklist, a best practice, a red-flag indicator → guidance\n' +
    '5. A concrete piece of marketing copy with a verdict (approved, rejected, corrected) → sample\n\n' +
    'When one passage states an obligation AND shows an example, extract both: the ' +
    'obligation as a rule, the example as a sample. When a review verdict articulates ' +
    'a general treatment for a class of situations, extract both: the verdict as a ' +
    'sample, the treatment as a ruling.\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant documents): the marketing asset ' +
    'currently under review (it is the deliverable, not context); open questions ' +
    'awaiting a ruling; opinions or counsel’s advice that was NOT adopted as a ' +
    'decision; meeting logistics and reviewer rotas; copy inside a UI mockup or demo ' +
    'dataset.',
  kinds: [
    {
      key: 'policy',
      label: 'Policy',
      label_plural: 'Policies',
      color: 2,
      consequence: 'high',
      description:
        'An authority document or regime as an entity: its name, who issues it, what it ' +
        'governs, its version/effective date, and whether it is active. The policy ' +
        'DOCUMENT itself is a source to digest — never paste it into the body; the ' +
        'node records its existence and binding state. Title: the regime name (e.g. ' +
        '"FTC Endorsement Guides", "Internal claims policy v3").\n\n' +
        'NOT a policy node: the operative constraints inside it (→ rule, one per ' +
        'constraint, each with its policy attr set to this name); a training deck ' +
        '(→ its content becomes guidance nodes with their source attr set).\n\n' +
        'policy.subkind — the AUTHORITY, choose ONE:\n' +
        '- regulation: law or a regulator (FTC, SEC, EU, FDA, ASA…).\n' +
        '- platform_policy: an ad/content platform (Google Ads, Meta, TikTok, app stores…).\n' +
        '- industry_code: a self-regulatory or industry code of practice.\n' +
        '- internal_policy: our own legal/brand/compliance policy.\n' +
        '- contract: obligations from a contract, license, or partnership.\n\n' +
        'A new version of a policy supersedes the old node: keep both, status does the ' +
        'filtering. Version changes are reversals: flag red.',
      subkinds: [
        { key: 'regulation', label: 'Regulation', description: 'Law or a regulator (FTC, SEC, EU, FDA, ASA…).' },
        { key: 'platform_policy', label: 'Platform policy', description: 'An ad/content platform policy.' },
        { key: 'industry_code', label: 'Industry code', description: 'A self-regulatory or industry code of practice.' },
        { key: 'internal_policy', label: 'Internal policy', description: 'Our own legal/brand/compliance policy.' },
        { key: 'contract', label: 'Contract', description: 'Obligations from a contract, license, or partnership.' },
      ],
      attrs: [
        { key: 'issuer', label: 'Issuer', type: 'string', description: 'Who issues/owns the regime (FTC, Google, Legal…).' },
        { key: 'jurisdiction', label: 'Jurisdiction', type: 'string', description: 'Where it applies (e.g. "US", "EU", "global").' },
        { key: 'version', label: 'Version', type: 'string', description: 'Version or revision identifier, when stated.' },
        { key: 'effective_from', label: 'Effective from', type: 'date' },
        { key: 'status', label: 'Status', type: 'enum', values: ['active', 'superseded'] },
        { key: 'source_ref', label: 'Source ref', type: 'string', description: 'Where the document lives (URL, citation).' },
        { key: 'product', label: 'Product', type: 'string', description: 'When the regime governs one product/brand only; omit when it governs all marketing.' },
      ],
      buckets: [
        { key: 'active', label: 'Active', match: 'status' },
        { key: 'superseded', label: 'Superseded', match: 'status' },
      ],
    },
    {
      key: 'rule',
      label: 'Rule',
      label_plural: 'Rules',
      color: 1,
      consequence: 'high',
      description:
        'A normative constraint on marketing content: something that must, may, or must ' +
        'not be done. State the operative constraint plainly in the body, quoting any ' +
        'exact required/forbidden wording verbatim. Title: the constraint in ≤10 words ' +
        '(e.g. "Investment promos require past-performance disclaimer").\n\n' +
        'NOT a rule: concrete copy shown as an example (→ sample); how the rule applies ' +
        'to one specific situation (→ ruling); a non-binding tip or definition from ' +
        'training material (→ guidance).\n\n' +
        'rule.subkind — the AUTHORITY the rule comes from, choose ONE: regulatory, ' +
        'platform_policy, industry_code, internal_policy, contractual.\n\n' +
        'rule.category — the TOPIC the rule governs, choose ONE:\n' +
        '- claims: what may or may not be claimed, and substantiation requirements.\n' +
        '- disclosures: required disclaimers, disclosures, or notices.\n' +
        '- endorsements: testimonials, influencers, reviews, endorsements.\n' +
        '- pricing_promotions: pricing display, discounts, "free", sweepstakes, urgency.\n' +
        '- comparisons: comparative and superiority claims against competitors.\n' +
        '- privacy_targeting: data use, consent, audience targeting restrictions.\n' +
        '- brand_usage: trademarks, logos, brand and third-party asset usage.\n' +
        '- other: a rule that fits none of the above.\n\n' +
        'Set the policy attr to the policy node the rule derives from. A changed rule ' +
        'supersedes the old node — keep both, status does the filtering; flag red.',
      subkinds: [
        { key: 'regulatory', label: 'Regulatory', description: 'Law or a regulator (FTC, SEC, EU, FDA, ASA…).' },
        { key: 'platform_policy', label: 'Platform policy', description: 'An ad/content platform policy.' },
        { key: 'industry_code', label: 'Industry code', description: 'A self-regulatory or industry code of practice.' },
        { key: 'internal_policy', label: 'Internal policy', description: 'Our own legal/brand/compliance policy.' },
        { key: 'contractual', label: 'Contractual', description: 'An obligation from a contract, license, or partnership.' },
      ],
      categories: [
        { key: 'claims', label: 'Claims' },
        { key: 'disclosures', label: 'Disclosures' },
        { key: 'endorsements', label: 'Endorsements' },
        { key: 'pricing_promotions', label: 'Pricing & promotions' },
        { key: 'comparisons', label: 'Comparisons' },
        { key: 'privacy_targeting', label: 'Privacy & targeting' },
        { key: 'brand_usage', label: 'Brand usage' },
        { key: 'other', label: 'Other' },
      ],
      attrs: [
        { key: 'policy', label: 'Policy', type: 'string', description: 'The policy node this rule derives from (its title).' },
        { key: 'source', label: 'Source', type: 'string', description: 'Citation of the provision (e.g. "FTC 16 CFR Part 255", "Google Ads policy: Healthcare").' },
        { key: 'jurisdiction', label: 'Jurisdiction', type: 'string', description: 'Where the rule applies (e.g. "US", "EU", "global").' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'Where it applies (email, social, paid ads, …); omit when all channels.' },
        { key: 'effective_from', label: 'Effective from', type: 'date' },
        {
          key: 'strictness',
          label: 'Strictness',
          type: 'enum',
          values: ['hard', 'advisory'],
          description: 'hard: violation blocks publication. advisory: strong guidance, judgement allowed.',
        },
        { key: 'status', label: 'Status', type: 'enum', values: ['active', 'superseded'] },
        { key: 'product', label: 'Product', type: 'string', description: 'When specific to one product/brand; omit when it applies to all marketing.' },
      ],
      buckets: [
        { key: 'regulatory', label: 'Regulatory', match: 'subkind' },
        { key: 'platform_policy', label: 'Platform', match: 'subkind' },
        { key: 'industry_code', label: 'Industry code', match: 'subkind' },
        { key: 'internal_policy', label: 'Internal', match: 'subkind' },
        { key: 'contractual', label: 'Contractual', match: 'subkind' },
      ],
    },
    {
      key: 'ruling',
      label: 'Ruling',
      label_plural: 'Rulings',
      color: 5,
      consequence: 'medium',
      description:
        'A decision that a concrete SITUATION or edge case is treated a certain way — ' +
        'the case law that clarifies how rules apply. Body: the situation (fact ' +
        'pattern) first, then the treatment and the reasoning, naming the rule(s) it ' +
        'clarifies. Title: situation → treatment in ≤12 words (e.g. "Customer quotes ' +
        'in paid ads → testimonial rules apply").\n\n' +
        'NOT a ruling: the general obligation itself (→ rule); the verdict on one ' +
        'specific asset with no generalizable treatment (→ sample); counsel’s advice ' +
        'that was not adopted (not canon). "We decided that X counts as Y" / "from now ' +
        'on, treat X as Y" / "X is allowed provided Z" ARE rulings.\n\n' +
        'ruling.subkind — choose ONE:\n' +
        '- interpretation: how a rule applies to a gray area or fact pattern.\n' +
        '- exception: a scoped permission to deviate from a rule, with conditions and (usually) an expiry.\n' +
        '- escalation: the resolution of an escalated case, adopted as the treatment for that class of situations.\n\n' +
        'ruling.category — the TOPIC it governs (same taxonomy as rules): claims, ' +
        'disclosures, endorsements, pricing_promotions, comparisons, privacy_targeting, ' +
        'brand_usage, other.\n\n' +
        'An overturned ruling supersedes the old node — keep both; flag red.',
      subkinds: [
        { key: 'interpretation', label: 'Interpretation', description: 'How a rule applies to a gray area or fact pattern.' },
        { key: 'exception', label: 'Exception', description: 'A scoped permission to deviate, with conditions and usually an expiry.' },
        { key: 'escalation', label: 'Escalation', description: 'An escalated case resolved and adopted as the treatment for its class.' },
      ],
      categories: [
        { key: 'claims', label: 'Claims' },
        { key: 'disclosures', label: 'Disclosures' },
        { key: 'endorsements', label: 'Endorsements' },
        { key: 'pricing_promotions', label: 'Pricing & promotions' },
        { key: 'comparisons', label: 'Comparisons' },
        { key: 'privacy_targeting', label: 'Privacy & targeting' },
        { key: 'brand_usage', label: 'Brand usage' },
        { key: 'other', label: 'Other' },
      ],
      attrs: [
        { key: 'situation', label: 'Situation', type: 'string', description: 'The fact pattern this ruling covers, in one line.' },
        { key: 'rule', label: 'Rule', type: 'string', description: 'The rule(s) this ruling clarifies (their titles).' },
        { key: 'outcome', label: 'Outcome', type: 'enum', values: ['allowed', 'allowed_with_conditions', 'blocked'] },
        { key: 'conditions', label: 'Conditions', type: 'string', description: 'The conditions attached, for allowed_with_conditions.' },
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
        { key: 'expires', label: 'Expires', type: 'date', description: 'When the ruling (typically an exception) lapses.' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'When the treatment is channel-specific; omit when general.' },
        { key: 'product', label: 'Product', type: 'string', description: 'When specific to one product/brand; omit when general.' },
      ],
      buckets: [
        { key: 'interpretation', label: 'Interpretations', match: 'subkind' },
        { key: 'exception', label: 'Exceptions', match: 'subkind' },
        { key: 'escalation', label: 'Escalations', match: 'subkind' },
      ],
    },
    {
      key: 'guidance',
      label: 'Guidance',
      label_plural: 'Guidance',
      color: 6,
      consequence: 'low',
      description:
        'Non-binding teaching distilled from training and enablement material: how to ' +
        'think about compliance, not what is forbidden. Fan training docs into one node ' +
        'per teachable item. Title: the item in ≤10 words. Set the source attr to the ' +
        'training doc it comes from.\n\n' +
        'NOT guidance: a hard obligation, even when it appears in a training deck ' +
        '(→ rule, with the policy attr when the deck cites one); a worked example with ' +
        'a verdict (→ sample).\n\n' +
        'guidance.subkind — choose ONE:\n' +
        '- definition: a canonical compliance term ("an endorsement is any message a consumer is likely to attribute to a third party…").\n' +
        '- checklist: a pre-publish check, one node per checklist (keep the items together in the body).\n' +
        '- best_practice: a recommended pattern that keeps copy safely inside the rules.\n' +
        '- red_flag: a signal that copy needs review or escalation ("superlatives + health claims = escalate").\n\n' +
        'guidance.category — the TOPIC (same taxonomy as rules): claims, disclosures, ' +
        'endorsements, pricing_promotions, comparisons, privacy_targeting, brand_usage, other.',
      subkinds: [
        { key: 'definition', label: 'Definition', description: 'A canonical compliance term.' },
        { key: 'checklist', label: 'Checklist', description: 'A pre-publish check; keep the items together in one node.' },
        { key: 'best_practice', label: 'Best practice', description: 'A recommended pattern that stays safely inside the rules.' },
        { key: 'red_flag', label: 'Red flag', description: 'A signal that copy needs review or escalation.' },
      ],
      categories: [
        { key: 'claims', label: 'Claims' },
        { key: 'disclosures', label: 'Disclosures' },
        { key: 'endorsements', label: 'Endorsements' },
        { key: 'pricing_promotions', label: 'Pricing & promotions' },
        { key: 'comparisons', label: 'Comparisons' },
        { key: 'privacy_targeting', label: 'Privacy & targeting' },
        { key: 'brand_usage', label: 'Brand usage' },
        { key: 'other', label: 'Other' },
      ],
      attrs: [
        { key: 'source', label: 'Source', type: 'string', description: 'The training doc/program it comes from.' },
        { key: 'audience', label: 'Audience', type: 'string', description: 'Who it trains (e.g. "all marketers", "social team").' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'When channel-specific; omit when general.' },
        { key: 'product', label: 'Product', type: 'string', description: 'When specific to one product/brand; omit when general.' },
      ],
      buckets: [
        { key: 'definition', label: 'Definitions', match: 'subkind' },
        { key: 'checklist', label: 'Checklists', match: 'subkind' },
        { key: 'best_practice', label: 'Best practices', match: 'subkind' },
        { key: 'red_flag', label: 'Red flags', match: 'subkind' },
      ],
    },
    {
      key: 'sample',
      label: 'Sample',
      label_plural: 'Samples',
      color: 4,
      consequence: 'low',
      description:
        'A concrete worked example: a piece of marketing copy together with its ' +
        'compliance verdict. Quote the copy VERBATIM in the body, then state the ' +
        'verdict and the reason (which rule or ruling it satisfied or violated). ' +
        'Title: the verdict + what it shows in ≤10 words (e.g. "Rejected: testimonial ' +
        'without typical-results disclosure").\n\n' +
        'NOT a sample: a general obligation with no concrete copy (→ rule); a ' +
        'generalizable treatment articulated during a review (→ ruling — extract BOTH ' +
        'when a verdict sets a treatment for a class of situations).\n\n' +
        'sample.subkind — choose ONE:\n' +
        '- approved: copy that passed review; a pattern to follow.\n' +
        '- rejected: copy that failed review; the reason is the lesson.\n' +
        '- corrected: a before → after rewrite; include both versions in the body.',
      subkinds: [
        { key: 'approved', label: 'Approved', description: 'Copy that passed review; a pattern to follow.' },
        { key: 'rejected', label: 'Rejected', description: 'Copy that failed review; the reason is the lesson.' },
        { key: 'corrected', label: 'Corrected', description: 'A before → after rewrite; include both versions.' },
      ],
      attrs: [
        { key: 'channel', label: 'Channel', type: 'string', description: 'Where the copy ran or was intended (e.g. "email", "social", "landing_page", "ad").' },
        { key: 'related_rule', label: 'Related rule', type: 'string', description: 'The rule this sample illustrates, when stated.' },
        { key: 'related_ruling', label: 'Related ruling', type: 'string', description: 'The ruling this sample illustrates or triggered, when stated.' },
        { key: 'reviewed_on', label: 'Reviewed on', type: 'date' },
        { key: 'reviewed_by', label: 'Reviewed by', type: 'string' },
        { key: 'product', label: 'Product', type: 'string', description: 'When specific to one product/brand; omit when general.' },
      ],
      buckets: [
        { key: 'approved', label: 'Approved', match: 'subkind' },
        { key: 'rejected', label: 'Rejected', match: 'subkind' },
        { key: 'corrected', label: 'Corrected', match: 'subkind' },
      ],
    },
  ],
  feedback_dimensions: [
    {
      key: 'rule_violations',
      label: 'Rule violations',
      description:
        'direct conflicts with an ACTIVE rule — banned wording, forbidden claim types, prohibited tactics; cite the rule, honoring its strictness (hard blocks, advisory warns)',
    },
    {
      key: 'missing_disclosures',
      label: 'Missing disclosures',
      description: 'required disclaimers, disclosures, or notices that the asset omits given its content, channel, and jurisdiction',
    },
    {
      key: 'claim_substantiation',
      label: 'Claim substantiation',
      description: 'claims made without the substantiation or qualification the rules require',
    },
    {
      key: 'ruling_consistency',
      label: 'Ruling consistency',
      description:
        'situations covered by a ruling follow it — an edge case with an interpretation or an unexpired exception is treated the ruled way, with its conditions, not re-litigated; expired exceptions no longer apply',
    },
    {
      key: 'precedent_consistency',
      label: 'Precedent consistency',
      description:
        'consistency with the sample record — copy resembling a rejected sample inherits its objection unless a ruling says otherwise; deviations from approved patterns need a reason',
    },
    {
      key: 'context_recency',
      label: 'Context recency',
      description: 'recent rule changes, new rulings, expired exceptions, or superseded policies the asset should reflect',
    },
  ],
  review_kinds: [
    'ad_copy',
    'social_post',
    'email',
    'landing_page',
    'blog_article',
    'press_release',
    'sales_material',
    'video_script',
    'influencer_brief',
    'other',
  ],
  query_scopes: [
    { key: 'policies', label: 'Policies', kind_keys: ['policy'] },
    { key: 'rules', label: 'Rules', kind_keys: ['rule'] },
    { key: 'rulings', label: 'Rulings', kind_keys: ['ruling'] },
    { key: 'guidance', label: 'Guidance', kind_keys: ['guidance'] },
    { key: 'samples', label: 'Samples', kind_keys: ['sample'] },
    { key: 'norms', label: 'Policies, rules & rulings', kind_keys: ['policy', 'rule', 'ruling'] },
    { key: 'precedent', label: 'Rulings & samples', kind_keys: ['ruling', 'sample'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'authority',
      label: 'Policies & rules',
      kind_keys: ['policy', 'rule'],
      description:
        'Policy/regulatory documents and the normative constraints they impose. PROCEDURE: emit ONE policy node ' +
        'FIRST (name the regime), then one rule per operative constraint with its policy attr set to that name.',
    },
    {
      key: 'interpretation',
      label: 'Rulings',
      kind_keys: ['ruling'],
      description:
        'Decisions on situations and edge cases: interpretations of gray areas, exceptions granted with conditions, ' +
        'escalation outcomes — from review threads, decision logs, and meeting notes.',
    },
    {
      key: 'training',
      label: 'Guidance',
      kind_keys: ['guidance'],
      description:
        'Training decks, onboarding docs, and enablement material: definitions, pre-publish checklists, best practices, red-flag indicators.',
    },
    {
      key: 'precedent',
      label: 'Samples',
      kind_keys: ['sample'],
      description:
        'Reviewed copy with verdicts — approved, rejected, and corrected (before → after) examples from review logs.',
    },
  ],
  flag_semantics: {
    red: 'violates an active hard rule, contradicts a ruling or its conditions, repeats a rejected pattern, omits a required disclosure — or changes/reverses a recorded policy, rule, ruling, or verdict',
    yellow: 'a gray area no rule or ruling covers (needs escalation), wording that risks non-compliance, resembles a rejected sample, advisory-rule tension, or unverified substantiation',
    green: 'consistent with the active rules, the rulings that cover its situations, and the approved precedent',
  },
  // Typed node↔node relations. Each edge answers a review-time retrieval
  // question: "where does this rule come from?", "how has this rule been
  // interpreted?", "what precedent is closest?", "what replaced this?".
  edge_kinds: [
    {
      key: 'derived_from',
      label: 'Derived from',
      description:
        'Provenance: points FROM the rule TO the policy regime it was extracted from. ' +
        'ANCHOR: when a policy has active and superseded versions, attach to the version the rule actually derives from (usually the active one).',
      src_kinds: ['rule'],
      dst_kinds: ['policy'],
      directed: true,
    },
    {
      key: 'clarifies',
      label: 'Clarifies',
      description:
        'Interpretation pointing at the norm it explains: points FROM the ruling or guidance TO the rule it clarifies. ' +
        'ANCHOR: attach to the ACTIVE version of the rule, not a superseded one.',
      src_kinds: ['ruling', 'guidance'],
      dst_kinds: ['rule'],
      directed: true,
    },
    {
      key: 'excepts',
      label: 'Excepts',
      description:
        'Points FROM an exception ruling TO the rule it permits deviation from, under stated conditions and usually with an expiry. ' +
        'ANCHOR: attach to the ACTIVE version of the rule.',
      src_kinds: ['ruling'],
      dst_kinds: ['rule'],
      directed: true,
    },
    {
      key: 'illustrates',
      label: 'Illustrates',
      description: 'A worked example showing how a rule, ruling, or guidance item applies in real copy.',
      src_kinds: ['sample'],
      dst_kinds: ['rule', 'ruling', 'guidance'],
      directed: true,
    },
    {
      key: 'supersedes',
      label: 'Supersedes',
      description:
        'Version history: points FROM the NEWER norm TO the older one it replaces — policy versions, amended rules, overturned rulings. Keeps history queryable while review binds to the active version.',
      src_kinds: ['policy', 'rule', 'ruling'],
      dst_kinds: ['policy', 'rule', 'ruling'],
      directed: true,
    },
    {
      key: 'conflicts_with',
      label: 'Conflicts with',
      description: 'Two norms in tension — e.g. a platform policy stricter than the regulation, or two rules that cannot both be satisfied. Surfaced for triage.',
      src_kinds: ['rule', 'ruling'],
      dst_kinds: ['rule', 'ruling'],
      directed: false,
    },
  ],
  // Source types this profile expects. The router classifies each document;
  // the matched type's extraction_guidance is injected into capture calls.
  source_types: [
    {
      key: 'policy_document',
      label: 'Policy document',
      description: 'A regulation, platform policy, industry code, internal policy, or contract imposing marketing obligations.',
      extraction_guidance:
        'Emit the policy node FIRST (regime, issuer, version, status), then one rule per operative constraint with its policy attr set — per the authority procedure in the taxonomy.',
      // Policy + rules ARE the authority group; a policy doc that yields
      // neither is a capture failure.
      group_floor: ['authority'],
      // Triage: the canonical authority artifact — commit-as-a-unit when it
      // is the version in force.
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['policy', 'rule'],
      triage_guidance:
        'Legitimacy hinges on issuer and version: a regulation, platform policy, or signed contract is authoritative on its face; a summary OF a policy is not the policy. Currency hinges on effective dates and supersession — an old version of a known regime is a stale snapshot.',
    },
    {
      key: 'training_material',
      label: 'Training material',
      description: 'A training deck, onboarding doc, enablement guide, or compliance handbook.',
      extraction_guidance:
        'Training material yields guidance nodes (definitions, checklists, best practices, red flags) with the source attr set to this doc — EXCEPT hard obligations quoted inside it, which are rules tied to their policy.',
      group_floor: ['training'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['guidance'],
      triage_guidance:
        'Authoritative for soft guidance only — any hard rules it quotes belong to their policy and need individual eyes.',
    },
    {
      key: 'review_log',
      label: 'Review log',
      description: 'Records of past compliance reviews: copy with verdicts (approved/rejected/corrected).',
      extraction_guidance:
        'Each verdict is a sample (quote the copy verbatim). When a verdict articulates a general treatment for a class of situations, ALSO extract that treatment as a ruling.',
      group_floor: ['precedent'],
      // Past verdicts are historical record — they do not decay.
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['sample', 'ruling'],
      triage_guidance:
        'Legitimate when verdicts are attributable to an actual review process. Verdicts are precedent, not new rules — rule-shaped extractions need individual eyes.',
    },
    {
      key: 'escalation_thread',
      label: 'Escalation thread',
      description: 'An email or chat thread escalating a compliance question to a decision.',
      extraction_guidance:
        'The RESOLUTION is the canon: extract the adopted treatment as a ruling (situation → outcome, with conditions and who decided). The back-and-forth before the resolution, and counsel\'s advice that was not adopted, stay out.',
      group_floor: ['interpretation'],
      currency: 'point_in_time',
      authority_kinds: ['ruling'],
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between teammates.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from compliance chat: treatments both parties converge on ("ok, so testimonials always get the disclaimer") — these are rulings; verdicts given informally on concrete copy — these are samples; and any rule change agreed in chat, which supersedes and flags red.',
      ),
      source_kinds: ['slack'],
      // Chat settles rulings (interpretation) and informal verdicts on
      // concrete copy (precedent) — per the guidance above.
      group_floor: ['interpretation', 'precedent'],
      currency: 'point_in_time',
    },
  ],
  seed_questions: [
    'What disclosures are required for a promotional email in the US?',
    'What claims are we allowed to make, and with what substantiation?',
    'How have we ruled on testimonials with atypical results?',
    'Which exceptions are active right now, and under what conditions?',
    'Show me rejected samples about pricing claims and why they failed.',
    'Which rules or rulings changed in the last quarter?',
  ],
};
