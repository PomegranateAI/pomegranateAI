import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance, interviewGuidance } from '../source-types.js';

/**
 * The `marketing` built-in profile, v3 — "Marketing strategy". The operating
 * model of a full-funnel head of marketing — brand, content, demand gen,
 * lifecycle — who also reviews work other marketers produce. Six layers:
 *
 *   MARKET     competitor · audience      — the landscape and who we win
 *   MESSAGE    positioning · brand_asset  — what we claim, and the LINKED
 *              visual/template canon we say it with
 *   DIRECTION  goal                       — marketing targets and KPIs
 *   EXECUTION  channel · campaign         — playbooks and campaigns in flight
 *   JUDGMENT   campaign_decision · commitment · principle
 *   EVIDENCE   learning                   — performance/experiment findings
 *
 * v3 (2026-07-15): renamed "Marketing" → "Marketing strategy", and the `voice`
 * kind + its `governs` edge + the `brand_voice` feedback dimension moved OUT
 * to the dedicated `brand_voice` profile. The split axis is CLAIM vs WORDING:
 * what we publicly claim and run is strategy (here); how we sound saying it is
 * brand voice (there). `brand_asset` stays here — logos, templates, palettes
 * are the VISUAL brand canon, a different axis to voice.
 *
 * The profile `id` deliberately stays 'marketing': it is the key every stored
 * workspace's profile_id resolves against.
 *
 * Compatibility: stored `voice` nodes in existing marketing workspaces stay
 * valid — setWorkspaceProfile stores a self-contained snapshot, so a
 * workspace keeps the taxonomy it was created with until a snapshot refresh.
 * Refreshing a marketing workspace that holds voice nodes will orphan them;
 * such workspaces want a brand_voice subgraph and a node migration first.
 * v1 compatibility otherwise unchanged: kind keys positioning/audience/
 * channel/campaign_decision, their subkinds/categories, and edge keys
 * targets/concerns/refines are preserved.
 *
 * THE ASSET LINK RULE (inherited from the designer profile, same rationale):
 * brand assets and templates are captured BY LINK + usage map, never by
 * visual description. The graph carries usage; the link carries the visual.
 */
export const marketingProfile: ContextProfile = {
  id: 'marketing',
  shape: 'items',
  name: 'Marketing strategy',
  routing_hint:
    'Go-to-market strategy: the market and competitors, the audience model (ICPs, personas, ' +
    'segments), positioning and messaging, value proposition and differentiators, brand assets ' +
    'and templates, campaigns, channels and content. SHARED ZONE — value proposition, ' +
    'positioning and competitive claims are shared with product: route here ALONGSIDE product ' +
    'whenever a document (including a product vision or strategy doc) states who it is for, how ' +
    'it is positioned, or how it compares to alternatives. SHARED ZONE — how copy is WORDED ' +
    '(tone, style, banned/approved phrases, specimens of copy) is shared with brand voice: ' +
    'route there ALONGSIDE this folder whenever a document states how something should be ' +
    'worded as opposed to what should be claimed.',
  description:
    'A full-funnel marketing leader (head of marketing / CMO) who runs brand, content, ' +
    'demand generation, and lifecycle — and reviews the work other marketers produce. ' +
    'The context is: the market (competitor messaging and moves, the audience model — ' +
    'ICPs, personas, segment insights), the message canon (positioning stances, ' +
    'differentiators, competitive claims and their proof points; the LINKED ' +
    'brand-asset canon — logos, templates, imagery, palettes), the direction ' +
    '(marketing goals and KPIs), the execution layer ' +
    '(channel playbooks and the campaigns in flight with their status), the judgment ' +
    'layer (dated marketing calls, commitments to named parties, durable principles ' +
    'and quality bars), and the evidence (performance and experiment learnings). The ' +
    'work product is campaigns, posts, articles, emails, landing pages, ads, decks, ' +
    'and press material.\n\n' +
    'ASSET LINK RULE — visual and template entities are captured BY REFERENCE, never ' +
    'by description. A node about a logo, template, image library, or palette carries ' +
    'LINKS: the asset_url attr for the canonical source (Figma, brand portal, Drive, ' +
    'Canva) and one body line per version/variant as "<version> — <when to use it> — ' +
    '<link>". NEVER describe what the asset looks like — the link carries the visual; ' +
    'the node carries usage. When the source names an asset but provides no link, ' +
    'still capture the entity and its usage rules, end the body with "No link in ' +
    'source.", and flag yellow.\n\n' +
    'SCOPING — set the `product` attr (the product/brand SHORT NAME, lowercase) on ' +
    'nodes specific to one product/brand; omit when company-wide. Campaign-scoped ' +
    'nodes (campaign_decision, learning, commitment) additionally carry a `campaign` ' +
    'attr (the campaign short name) when they belong to a named campaign. Write both ' +
    'as lowercase space-separated words exactly as the team names them — never ' +
    'hyphenate or invent punctuation — and set ONLY the attrs each kind declares.\n\n' +
    'NOT THIS DOMAIN: product/engineering internals — feature specs, architecture, ' +
    'sprint state, code — are NOT marketing canon even when they mention launch or ' +
    'positioning; only what marketing publicly claims and runs belongs here. A ' +
    'product spec or engineering doc is irrelevant unless it states a marketing fact ' +
    '(an approved public claim, a launch-campaign call).\n\n' +
    'ALSO NOT THIS DOMAIN — BRAND VOICE: how copy is WORDED belongs to the brand voice ' +
    'canon, not here. Banned and approved phrases, tone/style/mechanics rules, the ' +
    'voice character, per-channel register, and specimens of copy are NOT marketing ' +
    'strategy nodes even when a marketing document states them. The split is CLAIM vs ' +
    'WORDING: "we are the only audit-ready option" is a positioning claim and belongs ' +
    'here; "never say enterprise-grade" and "always write in second person" are voice ' +
    'rules and do not. When a document does both, extract only the claims side.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. A competitor\'s messaging, campaign activity, pricing, or a market trend → competitor\n' +
    '2. A named brand asset or template — logo, deck/social/email template, image library, palette, typography → brand_asset\n' +
    '3. Who we market to — an ICP, persona, or durable segment insight → audience\n' +
    '4. How we position — a stance, differentiator, competitive claim, or a proof point substantiating a claim → positioning\n' +
    '5. A marketing target or KPI being chased → goal\n' +
    '6. A channel playbook, cadence rule, or format rule → channel\n' +
    '7. A campaign as an entity — its goal, audience, channels, dates, budget, status → campaign\n' +
    '8. A performance or experiment learning, or customer-language evidence → learning\n' +
    '9. A promise to a named external party with a date or condition → commitment\n' +
    '10. A durable always/never rule, quality bar, or canonical definition → principle\n' +
    '11. A dated one-off marketing call not better captured above → campaign_decision\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant documents): voice and phrasing rules ' +
    'of any kind — banned/approved phrases, tone, style, mechanics, register (those are ' +
    'brand voice canon, captured in their own folder); draft copy and creative ' +
    'concepts inside briefs or decks — those are deliverables to review, not canon; ' +
    'raw metrics without a stated conclusion (numbers alone are not learnings); prose ' +
    'descriptions of how an asset or creative looks (ASSET LINK RULE — capture the ' +
    'entity, link, and usage instead); open ideas, brainstorms, and options still ' +
    'being weighed; scheduling/logistics and tool operations; who-owns-what people ' +
    'info (except decided_by on decisions and to_whom on commitments); product or ' +
    'engineering implementation detail.',
  kinds: [
    {
      key: 'competitor',
      label: 'Competitor',
      label_plural: 'Competitors & market',
      color: 5,
      consequence: 'low',
      description:
        'A durable marketing-relevant fact about a competitor or the market: their ' +
        'messaging/positioning, campaign activity, pricing moves, or a market trend. ' +
        'Title: competitor + the fact in ≤10 words. ONE node per named competitor — ' +
        'never comma-join companies. For market_trend spanning vendors, omit the ' +
        'competitor attr.\n\n' +
        'NOT a competitor node: a claim WE make against them (→ positioning, subkind ' +
        'competitive_claim); what customers say about them (→ audience segment_insight ' +
        'or learning customer_evidence).\n\n' +
        'competitor.subkind — choose ONE: messaging, activity, pricing, market_trend.',
      subkinds: [
        { key: 'messaging', label: 'Messaging', description: 'How they position/sell themselves.' },
        { key: 'activity', label: 'Activity', description: 'A campaign, launch, or channel move they made.' },
        { key: 'pricing', label: 'Pricing', description: 'How they charge or a pricing move.' },
        { key: 'market_trend', label: 'Market trend', description: 'A market-level shift not tied to one competitor.' },
      ],
      attrs: [
        { key: 'competitor', label: 'Competitor', type: 'string', description: 'Competitor name; omit for market_trend spanning vendors.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Which of OUR products it is most relevant to; omit if company-wide.' },
      ],
    },
    {
      key: 'positioning',
      label: 'Positioning',
      label_plural: 'Positioning',
      color: 1,
      consequence: 'medium',
      description:
        'How the company is positioned in the market: the stance we take, what makes us ' +
        'different, the claims we make against competitors, and the proof points that ' +
        'substantiate claims. Title: the stance/claim in ≤10 words.\n\n' +
        'NOT positioning: a phrasing rule about HOW to say it (→ brand voice canon, not ' +
        'this folder); a fact about a ' +
        'competitor with no claim by us (→ competitor); audience definition (→ audience). ' +
        'A claim WITHOUT a recorded proof point is capturable but reviewers treat it as ' +
        'unsubstantiated — when the source pairs a claim with its evidence, emit the ' +
        'proof_point with the claim it backs named in the body.\n\n' +
        'positioning.subkind — choose ONE:\n' +
        '- stance: a general declarative positioning statement.\n' +
        '- differentiator: how we differ from the market/competitors in general.\n' +
        '- competitive_claim: a claim about a specific competitor (we vs. them).\n' +
        '- proof_point: evidence that substantiates a stated claim — a number, customer ' +
        'proof, or third-party validation, with the claim it backs named.',
      subkinds: [
        { key: 'stance', label: 'Stance', description: 'A general declarative positioning statement.' },
        { key: 'differentiator', label: 'Differentiator', description: 'How we differ from the market/competitors in general.' },
        { key: 'competitive_claim', label: 'Competitive claim', description: 'A claim about a specific competitor (we vs. them).' },
        { key: 'proof_point', label: 'Proof point', description: 'Evidence substantiating a stated claim, with the claim named.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['active', 'retired'], description: 'active is the default reading; retiring a stance/claim is a reversal (red flag).' },
      ],
    },
    {
      key: 'brand_asset',
      label: 'Brand asset',
      label_plural: 'Brand assets',
      color: 6,
      consequence: 'high',
      description:
        'A named brand asset or template family the marketing team produces with: the ' +
        'logo set, deck/social/email templates, image or illustration libraries, the ' +
        'color palette, typography. ONE node per asset family — versions/variants live ' +
        'INSIDE the node as the usage map. Title: the asset name in ≤6 words.\n\n' +
        'ASSET LINK RULE (binding here): the body is a USAGE MAP — one line per ' +
        'version/variant as "<version> — <when to use it> — <link>". Set asset_url to ' +
        'the canonical source of truth (Figma, brand portal, Drive, Canva). When the ' +
        'source deprecates or replaces a prior version, that deprecation IS canon — ' +
        'add a usage-map line "<old version> — DEPRECATED <date when stated>, <what to ' +
        'do> — <link if any>". ALWAYS mirror the canonical link into asset_url, in ' +
        'conversations as much as formal documents. NEVER describe what the asset ' +
        'looks like — no colors-in-words, shapes, or style adjectives; a palette node ' +
        'names ROLES and links to the source, never hex values. If the source provides ' +
        'no link, end the body with "No link in source." and flag yellow.\n\n' +
        'NOT a brand_asset: a voice/phrasing rule (→ brand voice canon, not this folder); ' +
        'a channel format rule ' +
        '(→ channel); one campaign\'s creative (a deliverable, not canon). Replacing ' +
        'an asset family is a status reversal: flag red.\n\n' +
        'brand_asset.subkind — choose ONE: logo, template, imagery, color_palette, typography.',
      subkinds: [
        { key: 'logo', label: 'Logo', description: 'Logo/wordmark family and its version usage map.' },
        { key: 'template', label: 'Template', description: 'A deck, social, email, or doc template family.' },
        { key: 'imagery', label: 'Imagery', description: 'A photo/illustration library or style with its source link.' },
        { key: 'color_palette', label: 'Color palette', description: 'Palette roles + link to the source, never hex enumerations.' },
        { key: 'typography', label: 'Typography', description: 'The typeface set and each face\'s role.' },
      ],
      attrs: [
        {
          key: 'asset_url',
          label: 'Asset link',
          type: 'string',
          description:
            'Link/URI to the canonical artifact source (Figma, brand portal, Drive, Canva). Required whenever ' +
            'the source provides one — a brand_asset without it is incomplete (flag yellow).',
        },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['current', 'deprecated'], description: 'current is the default reading; replacement deprecates the old family (red flag).' },
      ],
      buckets: [
        { key: 'logo', label: 'Logos', match: 'subkind' },
        { key: 'template', label: 'Templates', match: 'subkind' },
        { key: 'imagery', label: 'Imagery', match: 'subkind' },
        { key: 'color_palette', label: 'Color', match: 'subkind' },
        { key: 'typography', label: 'Type', match: 'subkind' },
      ],
    },
    {
      key: 'audience',
      label: 'Audience',
      label_plural: 'Audiences',
      color: 3,
      consequence: 'medium',
      description:
        'Who we market to: ideal customer profiles, personas, and durable segment ' +
        'insights. Title: the audience name, or segment + insight in ≤10 words. One ' +
        'audience described several ways is ONE node.\n\n' +
        'NOT an audience node: a performance finding about how a segment responded to ' +
        'a campaign (→ learning); a competitor\'s audience (→ competitor).\n\n' +
        'audience.subkind — choose ONE:\n' +
        '- icp: an ideal customer profile (the company shape we sell to).\n' +
        '- persona: a buyer/user persona (role, goals, pains).\n' +
        '- segment_insight: a durable insight about a market segment, incl. the ' +
        'language customers actually use.',
      subkinds: [
        { key: 'icp', label: 'ICP', description: 'An ideal customer profile.' },
        { key: 'persona', label: 'Persona', description: 'A buyer/user persona.' },
        { key: 'segment_insight', label: 'Segment insight', description: 'A durable insight about a market segment.' },
      ],
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when the audience spans products.' }],
    },
    {
      key: 'goal',
      label: 'Goal',
      label_plural: 'Goals',
      color: 2,
      consequence: 'high',
      anchor: { match: 'subkind', values: ['north_star'] },
      description:
        'A marketing target or KPI being chased: pipeline, MQLs/SQLs, traffic, ' +
        'subscribers, share of voice, CAC — with the number and period when stated. ' +
        'Title (≤10 words): noun phrase including the number (e.g. "500 MQLs per ' +
        'quarter").\n\n' +
        'NOT a goal: a campaign built to reach it (→ campaign); a performance result ' +
        'against it (→ learning). Money and volume targets ARE goals — a numbers-dense ' +
        'plan never yields zero goals.\n\n' +
        'goal.subkind — choose ONE: north_star, priority, supporting.',
      subkinds: [
        { key: 'north_star', label: 'North star', description: 'THE defining marketing target.' },
        { key: 'priority', label: 'Priority', description: 'A first-order target.' },
        { key: 'supporting', label: 'Supporting', description: 'A secondary target.' },
      ],
      attrs: [
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
        { key: 'period', label: 'Period', type: 'string', description: 'e.g. "Q3 2026".' },
        { key: 'metric', label: 'Metric', type: 'string', description: 'The metric this goal moves, when named.' },
      ],
      buckets: [
        { key: 'north_star', label: 'North star', match: 'subkind' },
        { key: 'priority', label: 'Priority', match: 'subkind' },
        { key: 'supporting', label: 'Supporting', match: 'subkind' },
      ],
    },
    {
      key: 'channel',
      label: 'Channel',
      label_plural: 'Channels',
      color: 4,
      consequence: 'low',
      description:
        'How we go to market through a channel: repeatable playbooks, cadence rules, ' +
        'and format rules — per channel (LinkedIn, email, blog, paid, events, SEO). ' +
        'Title: channel + the rule in ≤8 words.\n\n' +
        'NOT a channel node: a one-off campaign on the channel (→ campaign); a ' +
        'voice/phrasing rule even when channel-scoped (→ brand voice canon, not this ' +
        'folder); a performance learning about the channel (→ learning).\n\n' +
        'channel.subkind — choose ONE:\n' +
        '- playbook: a repeatable channel playbook.\n' +
        '- cadence_rule: a rule about posting/sending cadence.\n' +
        '- format_rule: a rule about content format for a channel.',
      subkinds: [
        { key: 'playbook', label: 'Playbook', description: 'A repeatable channel playbook.' },
        { key: 'cadence_rule', label: 'Cadence rule', description: 'A rule about posting/sending cadence.' },
        { key: 'format_rule', label: 'Format rule', description: 'A rule about content format for a channel.' },
      ],
      attrs: [
        { key: 'channel', label: 'Channel', type: 'string', description: 'The channel name, lowercase (linkedin, email, blog, …). Required.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when the playbook spans products.' },
      ],
    },
    {
      key: 'campaign',
      label: 'Campaign',
      label_plural: 'Campaigns',
      color: 4,
      consequence: 'medium',
      description:
        'A campaign as an entity: its objective, audience, channels, dates, budget, ' +
        'and status. Title: the campaign name in ≤6 words. Body: objective, audience, ' +
        'channel mix, and key dates as stated — the campaign\'s draft copy/creative is ' +
        'a deliverable, never pasted here.\n\n' +
        'NOT a campaign: a dated call inside it (→ campaign_decision, with its ' +
        'campaign attr); the channel playbook it follows (→ channel); its results ' +
        '(→ learning). Status changes (live → killed) are reversals: flag red.\n\n' +
        'Always set the campaign attr to the campaign\'s own SHORT NAME, lowercase — ' +
        'scoped nodes reference it by that name.',
      attrs: [
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign\'s own short name, lowercase. Required.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
        { key: 'status', label: 'Status', type: 'enum', values: ['planned', 'live', 'done', 'killed'] },
        { key: 'starts', label: 'Starts', type: 'date' },
        { key: 'ends', label: 'Ends', type: 'date' },
        { key: 'budget', label: 'Budget', type: 'string', description: 'The stated budget, when given.' },
      ],
      buckets: [
        { key: 'planned', label: 'Planned', match: 'status' },
        { key: 'live', label: 'Live', match: 'status' },
        { key: 'done', label: 'Done', match: 'status' },
        { key: 'killed', label: 'Killed', match: 'status' },
      ],
    },
    {
      key: 'campaign_decision',
      label: 'Marketing decision',
      label_plural: 'Marketing decisions',
      color: 5,
      consequence: 'high',
      description:
        'A dated one-off marketing call not better captured by a more specific kind ' +
        '(see the decision tree — adopting a stance is positioning, a channel rule is ' +
        'channel, a target is goal: the resulting entity IS ' +
        'the node, never a decision wrapper). What remains: budget allocations, ' +
        'timing calls, channel-mix choices, creative direction picks, offer/promo ' +
        'calls, partnership go/no-gos. Title (≤12 words): imperative verb + object + ' +
        'key constraint.\n\n' +
        'campaign_decision.category — choose ONE: messaging, budget, channel, timing, ' +
        'creative, offer, partnership.',
      categories: [
        { key: 'messaging', label: 'Messaging' },
        { key: 'budget', label: 'Budget' },
        { key: 'channel', label: 'Channel' },
        { key: 'timing', label: 'Timing' },
        { key: 'creative', label: 'Creative' },
        { key: 'offer', label: 'Offer / promo' },
        { key: 'partnership', label: 'Partnership' },
      ],
      attrs: [
        { key: 'decided_on', label: 'Decided on', type: 'date' },
        { key: 'decided_by', label: 'Decided by', type: 'string' },
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign it belongs to, when named.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
      ],
    },
    {
      key: 'commitment',
      label: 'Commitment',
      label_plural: 'Commitments',
      color: 6,
      consequence: 'high',
      description:
        'A promise made to a named external party with a date or condition: a ' +
        'co-marketing partner, press (embargo dates), an event organizer, a sponsor, ' +
        'an influencer. Title: what was promised to whom in ≤10 words.\n\n' +
        'NOT a commitment: an internal plan with no named counterparty (→ campaign or ' +
        'goal); a dated internal call (→ campaign_decision). "Promised/agreed with ' +
        'someone external" wins over campaign_decision — extract here.',
      attrs: [
        { key: 'to_whom', label: 'To whom', type: 'string', description: 'The counterparty. Required when stated.' },
        { key: 'due', label: 'Due', type: 'date', description: 'The promised date, when stated.' },
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign it belongs to, when named.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
      ],
    },
    {
      key: 'principle',
      label: 'Principle',
      label_plural: 'Principles',
      color: 1,
      consequence: 'medium',
      description:
        'A durable always/never rule the marketing team holds itself to, a quality bar ' +
        'work must clear, a process rule, or a canonical definition. Timeless guidance, ' +
        'not a dated choice. Fan bulleted principle lists into one node per item.\n\n' +
        'NOT a principle: a voice/phrasing rule (→ brand voice canon, not this folder); ' +
        'a channel rule (→ channel); ' +
        'a positioning stance (→ positioning) — when the rule names a channel ' +
        'or claim, the specific kind wins.\n\n' +
        'principle.subkind — choose ONE:\n' +
        '- marketing_principle: how we market generally ("educate, never pitch first").\n' +
        '- quality_bar: a bar work must clear before shipping.\n' +
        '- process_rule: how the team operates — approvals, measurement plans, briefs.\n' +
        '- definition: a canonical term or naming rule.',
      subkinds: [
        { key: 'marketing_principle', label: 'Marketing principle', description: 'How we market generally.' },
        { key: 'quality_bar', label: 'Quality bar', description: 'A bar work must clear before shipping.' },
        { key: 'process_rule', label: 'Process rule', description: 'How the team operates: approvals, measurement, briefs.' },
        { key: 'definition', label: 'Definition', description: 'A canonical term or naming rule.' },
      ],
      attrs: [{ key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide (most are).' }],
    },
    {
      key: 'learning',
      label: 'Learning',
      label_plural: 'Learnings',
      color: 3,
      consequence: 'low',
      description:
        'A durable, settled performance or experiment finding, or customer-language ' +
        'evidence: "LinkedIn carousels outperform text posts 3:1", "subject lines ' +
        'with numbers lift opens 12%", "buyers say \'audit trail\', never ' +
        '\'compliance log\'". The conclusion WITH its number when stated. Tag the ' +
        'campaign and channel it came from.\n\n' +
        'NOT a learning: raw metrics with no stated conclusion (not canon); a durable ' +
        'fact about a segment (→ audience segment_insight); a rule the team adopted ' +
        'BECAUSE of a learning (→ channel/principle, with this learning as its ' +
        'grounding). In multi-speaker sources, customer_evidence must originate from ' +
        'the customer\'s own words. ATTRS: set ONLY campaign, channel, segment, ' +
        'product — never a speaker attr.\n\n' +
        'learning.subkind — choose ONE: experiment_result, performance_finding, ' +
        'customer_evidence.',
      subkinds: [
        { key: 'experiment_result', label: 'Experiment result', description: 'An A/B or experiment outcome with its number.' },
        { key: 'performance_finding', label: 'Performance finding', description: 'A settled conclusion from performance data.' },
        { key: 'customer_evidence', label: 'Customer evidence', description: 'Customer-language or reaction evidence, from the customer\'s own words.' },
      ],
      attrs: [
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign it came from, when named.' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'The channel it concerns, lowercase, when named.' },
        { key: 'segment', label: 'Segment', type: 'string', description: 'The audience it concerns, when named.' },
        { key: 'product', label: 'Product', type: 'string', description: 'Omit when company-wide.' },
      ],
    },
  ],
  feedback_dimensions: [
    { key: 'goals_alignment', label: 'Goals alignment', description: 'serves the current marketing goals and funnel priorities; leads with what the period is chasing' },
    { key: 'positioning', label: 'Positioning', description: 'consistent with active stances, differentiators, and competitive claims — and does not revive retired ones' },
    {
      key: 'claim_accuracy',
      label: 'Claim accuracy',
      description: 'every claim matches the recorded canon and is substantiated by a recorded proof point or learning; no unapproved or unverifiable claims',
    },
    { key: 'audience_fit', label: 'Audience fit', description: 'speaks to the right ICP/persona in language the recorded segment insights support' },
    { key: 'channel_craft', label: 'Channel craft', description: 'follows the target channel\'s recorded playbook, format, and cadence rules' },
    {
      key: 'campaign_consistency',
      label: 'Campaign consistency',
      description: 'matches the campaign\'s recorded objective, audience, budget, timing, and the decisions made for it',
    },
    {
      key: 'asset_link_integrity',
      label: 'Asset & link integrity',
      description:
        'uses the CURRENT version of every brand asset/template per its recorded usage map, and identifies any asset it references or introduces by LINK, never prose description',
    },
    { key: 'evidence_grounding', label: 'Evidence grounding', description: 'performance and audience claims are backed by recorded learnings, not assertion' },
    { key: 'commitments', label: 'Commitments', description: 'does not promise anything not committed, and respects committed dates (embargoes, partner terms)' },
    { key: 'context_recency', label: 'Context recency', description: 'recent decisions, kills, asset changes, or learnings the work should reflect' },
  ],
  review_kinds: [
    'campaign',
    'social_post',
    'blog_article',
    'sales_email',
    'landing_page',
    'newsletter',
    'deck',
    'ad_copy',
    'press_release',
    'case_study',
    'video_script',
    'carousel',
    'other',
  ],
  query_scopes: [
    { key: 'market', label: 'Market & competitors', kind_keys: ['competitor'] },
    { key: 'positioning', label: 'Positioning', kind_keys: ['positioning'] },
    { key: 'assets', label: 'Brand assets', kind_keys: ['brand_asset'] },
    { key: 'message', label: 'Message canon', kind_keys: ['positioning', 'brand_asset'] },
    { key: 'audience', label: 'Audience', kind_keys: ['audience'] },
    { key: 'direction', label: 'Goals', kind_keys: ['goal'] },
    { key: 'channel', label: 'Channels', kind_keys: ['channel'] },
    { key: 'campaigns', label: 'Campaigns', kind_keys: ['campaign'] },
    { key: 'decisions', label: 'Decisions & commitments', kind_keys: ['campaign_decision', 'commitment'] },
    { key: 'principles', label: 'Principles', kind_keys: ['principle'] },
    { key: 'evidence', label: 'Learnings', kind_keys: ['learning'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'market',
      label: 'Market & audience',
      kind_keys: ['competitor', 'audience'],
      description: 'Competitor messaging/moves and market trends; audience definitions — ICPs, personas, durable segment insights.',
    },
    {
      key: 'message',
      label: 'Message canon',
      kind_keys: ['positioning', 'brand_asset'],
      description:
        'Positioning stances, differentiators, competitive claims and proof points; ' +
        'brand assets and templates with their links and usage rules.',
    },
    {
      key: 'direction',
      label: 'Goals',
      kind_keys: ['goal'],
      description: 'Marketing targets and KPIs: pipeline, MQLs, traffic, subscribers — with numbers and periods.',
    },
    {
      key: 'execution',
      label: 'Channels & campaigns',
      kind_keys: ['channel', 'campaign'],
      description: 'Channel playbooks, cadence and format rules; campaigns in flight with objective, audience, dates, budget, status.',
    },
    {
      key: 'judgment',
      label: 'Decisions & guardrails',
      kind_keys: ['campaign_decision', 'commitment', 'principle'],
      description: 'Dated marketing calls, promises to named external parties, and durable principles, quality bars, process rules.',
    },
    {
      key: 'evidence',
      label: 'Learnings',
      kind_keys: ['learning'],
      description: 'Performance and experiment findings with their numbers, and customer-language evidence.',
    },
  ],
  flag_semantics: {
    red:
      'contradicts the canon — makes a claim contradicting recorded ' +
      'positioning or revives a retired stance, uses a deprecated asset/template version, reverses a recorded ' +
      'decision, campaign status, or ' +
      'commitment, or replaces a previously linked asset reference with a prose description',
    yellow:
      'hedged or low-conviction; an unsubstantiated claim with no recorded proof point; a brand asset captured without ' +
      'a usable link ("No link in source."); performance claims without recorded learnings; implicitly settled chat',
    green: 'consistent with positioning, approved claims, current linked assets, and the recorded direction',
  },
  // Typed node↔node relations. v1 keys targets/concerns/refines preserved;
  // new keys only add. Each answers a retrieval question. (`governs` moved to
  // the brand_voice profile with the voice kind — see the header note.)
  edge_kinds: [
    {
      key: 'targets',
      label: 'Targets',
      description:
        'Points FROM a positioning stance/differentiator/claim or a campaign TO the ONE audience the source ' +
        'EXPLICITLY says it is for ("for compliance leads", "primary ICP: …"). NEVER inferred from topic, and NEVER ' +
        'emitted just because positioning and an audience coexist in the canon — when the source does not name the ' +
        'audience, emit NO edge. At most one targets edge per source node; never both an ICP and its persona.',
      src_kinds: ['positioning', 'campaign'],
      dst_kinds: ['audience'],
      directed: true,
    },
    {
      key: 'concerns',
      label: 'Concerns',
      description:
        'Points FROM a marketing decision TO the ONE entity the decision is a decision ABOUT — the positioning it ' +
        'changes, the audience it targets, the channel it allocates, the asset it adopts, or the campaign it shapes. ' +
        'NEVER an entity mentioned in passing or in the rationale: a creative decision banning stock imagery is ' +
        'about its campaign, NOT about the imagery library. When unsure which entity, emit NO edge.',
      src_kinds: ['campaign_decision'],
      dst_kinds: ['positioning', 'audience', 'channel', 'campaign', 'brand_asset'],
      directed: true,
    },
    {
      key: 'refines',
      label: 'Refines',
      description:
        'Points FROM the NARROWER audience TO the BROADER one it slices: persona → the ICP it buys within, ' +
        'sub-segment → segment. Direction check before emitting: the src must be the smaller/more specific group; ' +
        'ICP → persona is the WRONG direction and must not be emitted.',
      src_kinds: ['audience'],
      dst_kinds: ['audience'],
      directed: true,
    },
    {
      key: 'belongs_to',
      label: 'Belongs to',
      description:
        'Campaign scoping made explicit: points FROM a scoped node (decision, learning, commitment) TO the campaign ' +
        'it belongs to — only for nodes whose campaign attr or body names that campaign.',
      src_kinds: ['campaign_decision', 'learning', 'commitment'],
      dst_kinds: ['campaign'],
      directed: true,
      scope_attr: 'campaign',
    },
    {
      key: 'supports',
      label: 'Supports',
      description:
        'Points FROM a campaign or supporting goal TO the goal it advances — answers "what is this campaign for?". ' +
        'Only when the source states the objective, never from shared topic.',
      src_kinds: ['campaign', 'goal'],
      dst_kinds: ['goal'],
      directed: true,
    },
    {
      key: 'about',
      label: 'About',
      description:
        'Evidence pointing at what it concerns: points FROM a learning TO the single entity the learning\'s own ' +
        'finding is ABOUT — the channel it measured, the campaign it ran in, the audience it studied, or the ' +
        'positioning claim it tests. ONLY when the learning\'s body names that entity; a channel learning is about ' +
        'its channel, NOT about positioning or audiences that merely share the topic. At most one about edge per ' +
        'learning; when unsure, emit NO edge.',
      src_kinds: ['learning'],
      dst_kinds: ['channel', 'audience', 'campaign', 'positioning'],
      directed: true,
    },
  ],
  // NOTE deliberately NO supersedes edge: brand_asset version history lives
  // INSIDE each asset's usage map (per the ASSET LINK RULE — deprecation
  // lines are part of the map). Two golden runs showed an edge variant only
  // produced cross-family noise the usage map already disambiguates.
  // Source types this profile expects. With extraction_groups now declared,
  // every type carries a group_floor — the deterministic capture guarantee
  // (the router can add groups, never drop a floored one).
  source_types: [
    {
      key: 'brand_or_messaging_doc',
      label: 'Brand / messaging doc',
      description: 'A brand guide, messaging framework, or positioning doc.',
      extraction_guidance:
        'This is the message canon. APPLY THE ASSET LINK RULE STRICTLY: every brand asset/template node carries ' +
        'asset_url and a usage map of "<version> — <when to use> — <link>" lines — usage rules and role names, ' +
        'NEVER visual descriptions or hex/token enumerations. Pair claims with their proof points when the doc ' +
        'states evidence. A brand guide usually also carries VOICE rules (banned/approved phrases, tone, style) — ' +
        'those are brand voice canon and are NOT extracted here: take the claims and the assets, leave the wording.',
      // Message canon IS the point of a brand/messaging doc; its principles
      // live in judgment — floor both (golden run: router voted message only
      // and all three principles were silently dropped).
      group_floor: ['message', 'judgment'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['positioning', 'brand_asset', 'audience', 'channel', 'principle'],
      triage_guidance:
        'Legitimate when it reads as the team\'s adopted guide (rules stated as settled). Brand guides go stale ' +
        'quietly — anchor currency on version markers, dates, and whether it contradicts newer positioning or ' +
        'asset versions in the graph. Suspicious when asset references carry no links — a linkless brand doc is ' +
        'likely an exploration deck.',
    },
    {
      key: 'marketing_strategy_doc',
      label: 'Marketing strategy doc',
      description: 'A marketing strategy memo or plan: goals, segments, channel mix, budget priorities for a period.',
      extraction_guidance: '',
      group_floor: ['direction', 'market'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['goal', 'audience', 'competitor', 'positioning', 'channel', 'principle', 'campaign'],
      triage_guidance:
        'A strategy memo speaks for direction and the market model, not for performance evidence. Currency is the ' +
        'central question: a prior period\'s plan contradicting the graph is usually the stale party.',
    },
    {
      key: 'campaign_brief',
      label: 'Campaign brief',
      description: 'A campaign brief or plan: audience, channels, budget, timing, creative direction.',
      extraction_guidance:
        'Emit the campaign node FIRST (objective, audience, channel mix, dates, budget, status), then the campaign ' +
        'CALLS (budget, channel, timing, creative, messaging, offer choices) with their campaign attr set — the ' +
        'draft copy and creative concepts inside the brief are deliverables, never canon.',
      // The campaign entity and its calls ARE the point of a brief.
      group_floor: ['execution', 'judgment'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['campaign', 'campaign_decision', 'commitment', 'audience', 'channel', 'goal'],
      triage_guidance:
        'A brief is authoritative for its own campaign and calls only. A brief for a finished or cancelled ' +
        'campaign is a stale snapshot — check campaign status against the graph.',
    },
    {
      key: 'customer_or_market_research',
      label: 'Customer / market research',
      description: 'Persona research, survey results, win/loss notes, or a customer interview about messaging.',
      extraction_guidance: interviewGuidance(
        'Capture especially: segment insights, persona pains, and the language customers actually use — tagged to ' +
          'the audience they describe; customer reactions to OUR messaging are learning customer_evidence.',
      ),
      source_kinds: ['transcript'],
      // Audience truth IS the point of research; customer evidence lands in
      // evidence — floor both (the Dan-interview lesson).
      group_floor: ['market', 'evidence'],
      currency: 'point_in_time',
      authority_kinds: ['audience', 'learning', 'competitor'],
    },
    {
      key: 'performance_report',
      label: 'Performance report',
      description: 'Channel or campaign performance data: what worked, what did not.',
      extraction_guidance:
        'Numbers alone are not canon. Extract only durable conclusions the report itself draws — one learning per ' +
        'conclusion WITH its number, tagged with campaign and channel. A rule the report proposes going forward is ' +
        'a channel rule only when stated as adopted, not as a recommendation.',
      group_floor: ['evidence'],
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['learning', 'channel', 'audience'],
      triage_guidance:
        'Legitimate when it is a finished write-up (period and channels identifiable, conclusions stated). ' +
        'Authoritative for learnings only — direction or judgment nodes it yields need individual eyes.',
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between teammates.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from marketing chat: campaign calls both parties land on; positioning claims and ' +
          'competitive stances converged on — kills settled in chat are real kills and flag red; new asset/template ' +
          'versions shared by link — capture the link (in the usage-map line AND asset_url) and when each version ' +
          'applies per the ASSET LINK RULE, never how it looks. Wording rules settled in chat ("never say ' +
          'enterprise-grade") are brand voice canon, not this folder\'s — leave them.',
      ),
      source_kinds: ['slack'],
      // Marketing chat settles calls (judgment) AND message canon (positioning
      // language, asset links) — floor both.
      group_floor: ['judgment', 'message'],
      currency: 'point_in_time',
    },
  ],
  seed_questions: [
    'What is our approved positioning against competitors, and which claims have proof points?',
    'Who is our primary ICP, and what language do they actually use?',
    'What campaigns are in flight, and what is each one\'s objective and status?',
    'What are the marketing goals for this period?',
    'What is the playbook for LinkedIn, and what cadence do we keep?',
    'Where do the current logo and deck templates live, and which version is used where?',
    'What have experiments taught us about subject lines and channel mix?',
    'What have we promised partners or press, and by when?',
  ],
};
