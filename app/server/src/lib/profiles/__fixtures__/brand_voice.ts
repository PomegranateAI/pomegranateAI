import type { ContextProfile } from '../../schemas.js';
import { conversationGuidance } from '../source-types.js';

/**
 * The `brand_voice` built-in profile. The operating model of a brand/content
 * lead who owns how the company SOUNDS — and who feeds that canon to AI
 * writing tools as an instruction set. Four layers:
 *
 *   CHARACTER  voice_attribute            — the archetype and the axes
 *   RULES      voice_rule · lexicon · register — how we write, word by word,
 *                                            and how that shifts per channel
 *   SPECIMENS  exemplar                   — the copy itself: gold, off-voice,
 *                                            and before/after rewrites
 *   EVIDENCE   learning                   — what performance taught us about
 *                                            language
 *
 * THE VERBATIM SPECIMEN RULE — the deliberate INVERSE of the marketing and
 * designer profiles' ASSET LINK RULE. Those capture visual artifacts BY LINK
 * because a link carries the visual and prose cannot. Here the artifact IS
 * text: the voice lives in the exact words, so specimens are captured
 * VERBATIM and a paraphrase destroys the thing being captured. Link AND
 * quote — `source_url` for provenance, the body for the words themselves.
 *
 * Split from `marketing` (2026-07-15): marketing's `voice` kind and its
 * `governs` edge moved here, and marketing was renamed "Marketing strategy".
 * Marketing keeps `brand_asset` — logos, templates, palettes are the VISUAL
 * brand canon, a different axis to how we sound. Existing marketing
 * workspaces are unaffected: `setWorkspaceProfile` stores a self-contained
 * snapshot, so their stored `voice` nodes stay valid until a snapshot refresh.
 */
export const brandVoiceProfile: ContextProfile = {
  id: 'brand_voice',
  shape: 'items',
  name: 'Brand voice',
  routing_hint:
    'Brand voice: how we sound — the voice character and archetype, tone, style and mechanics ' +
    'rules, the lexicon of banned and approved phrases, per-channel register, specimens of copy ' +
    'that are on- or off-voice, and what performance taught us about language. SHARED ZONE — ' +
    'voice rules stated inside marketing material are shared with marketing strategy: route here ' +
    'ALONGSIDE marketing whenever a document states how something should be WORDED as opposed to ' +
    'what should be CLAIMED. Positioning, competitive claims, campaigns, and audience models are ' +
    'marketing strategy\'s, not this folder\'s.',
  description:
    'A brand or content lead who owns how the company sounds — across email, social, the blog, ' +
    'product copy, ads, and support — and who feeds that canon to AI writing tools as an ' +
    'instruction set. The context is: the voice character (the archetype, the axes we hold, the ' +
    'durable attributes), the rules (tone, style, structure, mechanics), the lexicon (the exact ' +
    'phrases we ban, approve, or spell a canonical way), the register (how the voice shifts per ' +
    'channel and audience), the specimen library (real copy that IS the voice, real copy that ' +
    'is NOT, and the rewrites between them), and the evidence (what performance taught us about ' +
    'language). The work product is emails, subject lines, posts, articles, landing pages, ads, ' +
    'and product copy.\n\n' +
    'VERBATIM SPECIMEN RULE — copy is captured VERBATIM, never paraphrased or summarized. A ' +
    'specimen\'s body is the source text EXACTLY as written: an exemplar that describes copy ' +
    'instead of containing it is worthless, because the voice lives in the words themselves. ' +
    'Set asset_url to the canonical artifact (Mailchimp campaign, doc, thread permalink) ' +
    'whenever the source provides one — but the link never replaces the text. Quote lexicon ' +
    'phrases VERBATIM, one node per phrase, never a list. For before_after, the body carries ' +
    'both versions labelled "BEFORE:" and "AFTER:" plus, when stated, the reason for the ' +
    'change. When a specimen is too long to carry whole, capture the PASSAGE the source ' +
    'actually discusses — never a summary of the rest.\n\n' +
    'SCOPING — set the `channel` attr (lowercase: email, linkedin, blog, product, support, ads) ' +
    'and the `audience` attr on items scoped to one; set `campaign` on specimens and learnings ' +
    'from a named campaign. Write all three as lowercase space-separated words exactly as the ' +
    'team names them — never hyphenate or invent punctuation. Most voice rules are GLOBAL: omit ' +
    'the attr rather than guess a scope, and set ONLY the attrs each kind declares.\n\n' +
    'NOT THIS DOMAIN: positioning stances, competitive claims, proof points, campaign plans, ' +
    'audience/ICP models, and product facts are marketing strategy canon, not voice canon. A ' +
    'campaign doc is relevant here ONLY for the copy it contains and the wording rules it ' +
    'states — what it CLAIMS belongs to marketing, how it SAYS it belongs here.\n\n' +
    'KIND DECISION TREE — test in this order, first match wins:\n' +
    '1. Is this the copy ITSELF, rather than a statement about copy? → exemplar\n' +
    '2. A specific word or phrase we ban, always use, or spell a canonical way → lexicon\n' +
    '3. A rule that only holds for a named channel, audience, or format → register\n' +
    '4. A tone, style, structure, or mechanics rule → voice_rule\n' +
    '5. The brand\'s durable character — archetype, an axis ("warm, not cute"), an attribute → voice_attribute\n' +
    '6. A finding about how language performed → learning\n\n' +
    'DO NOT EXTRACT (not canon, even in relevant sources): an AI draft the human did not react ' +
    'to — only CORRECTED drafts are canon, and only as off_voice specimens; raw metrics with no ' +
    'stated conclusion; a one-off copy edit with no generalizable reason ("change Hi to Hey ' +
    'here"); paraphrases or prose descriptions of copy (VERBATIM SPECIMEN RULE — capture the ' +
    'text or capture nothing); scheduling, logistics, and tool operations; who-owns-what people ' +
    'info; open options still being weighed.',
  kinds: [
    {
      key: 'voice_attribute',
      label: 'Voice attribute',
      label_plural: 'Voice character',
      color: 1,
      consequence: 'high',
      anchor: { match: 'subkind', values: ['archetype'] },
      description:
        'The brand\'s durable character: the archetype we write as, the axes we hold ("warm, ' +
        'not cute"), and the attributes that describe how we sound. Timeless — not a rule about ' +
        'a specific word or format. Title: the attribute in ≤8 words. ONE node per attribute; ' +
        'fan a bulleted character list into one node each.\n\n' +
        'NOT a voice_attribute: a concrete tone or style rule (→ voice_rule); a phrase (→ ' +
        'lexicon); how we sound on ONE channel (→ register). The archetype is a single ' +
        'workspace anchor — there is one, and replacing it is a reversal.\n\n' +
        'voice_attribute.subkind — choose ONE:\n' +
        '- archetype: THE defining character we write as ("the expert friend").\n' +
        '- axis: a we-are-X-not-Y pair that draws a boundary.\n' +
        '- attribute: a durable quality of the voice.',
      subkinds: [
        { key: 'archetype', label: 'Archetype', description: 'THE defining character we write as.' },
        { key: 'axis', label: 'Axis', description: 'A we-are-X-not-Y pair drawing a boundary.' },
        { key: 'attribute', label: 'Attribute', description: 'A durable quality of the voice.' },
      ],
      attrs: [
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['active', 'retired'],
          description: 'active is the default reading; retiring an attribute is a reversal (red flag).',
        },
      ],
      buckets: [
        { key: 'archetype', label: 'Archetype', match: 'subkind' },
        { key: 'axis', label: 'Axes', match: 'subkind' },
        { key: 'attribute', label: 'Attributes', match: 'subkind' },
      ],
    },
    {
      key: 'voice_rule',
      label: 'Voice rule',
      label_plural: 'Voice rules',
      color: 2,
      consequence: 'medium',
      description:
        'A rule about HOW we write that is not about a specific phrase: tone, style, sentence ' +
        'and document structure, or mechanics (capitalization, punctuation, emoji, numbers). ' +
        'Title: the rule in ≤8 words, stated as a rule ("never open with a question").\n\n' +
        'NOT a voice_rule: a specific word or phrase (→ lexicon, even when phrased as a rule); ' +
        'a rule that only holds for one channel or audience (→ register); an abstract quality ' +
        'with no actionable instruction (→ voice_attribute). Killing a rule is a reversal — set ' +
        'status retired and flag red.\n\n' +
        'voice_rule.subkind — choose ONE:\n' +
        '- tone_rule: a rule about tone ("never hype").\n' +
        '- style_rule: a rule about style ("second person, active voice").\n' +
        '- structure_rule: a rule about sentence/document shape ("lead with the outcome").\n' +
        '- mechanics: capitalization, punctuation, emoji, numbers, formatting.',
      subkinds: [
        { key: 'tone_rule', label: 'Tone rule', description: 'A rule about tone.' },
        { key: 'style_rule', label: 'Style rule', description: 'A rule about style.' },
        { key: 'structure_rule', label: 'Structure rule', description: 'A rule about sentence or document shape.' },
        { key: 'mechanics', label: 'Mechanics', description: 'Capitalization, punctuation, emoji, numbers, formatting.' },
      ],
      attrs: [
        { key: 'channel', label: 'Channel', type: 'string', description: 'Lowercase channel the rule is scoped to; omit for global rules (most are).' },
        { key: 'audience', label: 'Audience', type: 'string', description: 'The audience it is scoped to, when named; omit when global.' },
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['active', 'retired'],
          description: 'active is the default reading; retiring a rule is a reversal (red flag).',
        },
      ],
      buckets: [
        { key: 'tone_rule', label: 'Tone', match: 'subkind' },
        { key: 'style_rule', label: 'Style', match: 'subkind' },
        { key: 'structure_rule', label: 'Structure', match: 'subkind' },
        { key: 'mechanics', label: 'Mechanics', match: 'subkind' },
      ],
    },
    {
      key: 'lexicon',
      label: 'Lexicon entry',
      label_plural: 'Words & phrases',
      color: 5,
      consequence: 'medium',
      description:
        'A word or phrase decision, quoted VERBATIM: a phrase we never use, a phrase we always ' +
        'use, or the canonical spelling/casing of a term. ONE node per phrase — never a list, ' +
        'never a comma-joined set. Title: the phrase itself in quotes. Body: the phrase verbatim ' +
        'plus the reason when the source gives one.\n\n' +
        'NOT a lexicon entry: a tone or style rule with no specific phrase (→ voice_rule); a ' +
        'positioning claim (→ marketing strategy, not this folder). When a source bans a phrase ' +
        'AND names the replacement, emit BOTH nodes and set the banned entry\'s replacement ' +
        'attr. Killing approved language is a reversal: set status retired and flag red.\n\n' +
        'lexicon.subkind — choose ONE:\n' +
        '- banned_phrase: a specific word or phrase we never use.\n' +
        '- approved_phrase: a specific word or phrase we always use.\n' +
        '- canonical_term: the one correct spelling/casing of a term.',
      subkinds: [
        { key: 'banned_phrase', label: 'Banned phrase', description: 'A specific word or phrase we never use.' },
        { key: 'approved_phrase', label: 'Approved phrase', description: 'A specific word or phrase we always use.' },
        { key: 'canonical_term', label: 'Canonical term', description: 'The one correct spelling/casing of a term.' },
      ],
      attrs: [
        { key: 'replacement', label: 'Say instead', type: 'string', description: 'What to say instead, when the source names it. Only on banned_phrase.' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'Lowercase channel the entry is scoped to; omit for global (most are).' },
        {
          key: 'status',
          label: 'Status',
          type: 'enum',
          values: ['active', 'retired'],
          description: 'active is the default reading; retiring an entry is a reversal (red flag).',
        },
      ],
      buckets: [
        { key: 'banned_phrase', label: 'Banned', match: 'subkind' },
        { key: 'approved_phrase', label: 'Approved', match: 'subkind' },
        { key: 'canonical_term', label: 'Canonical', match: 'subkind' },
      ],
    },
    {
      key: 'register',
      label: 'Register',
      label_plural: 'Register',
      color: 4,
      consequence: 'medium',
      description:
        'How the voice SHIFTS for a named channel, audience, or format: what changes about tone, ' +
        'length, formality, or structure when we write there. Title: channel + the shift in ≤8 ' +
        'words ("support email: plainer, no metaphor").\n\n' +
        'NOT a register node: a global rule that happens to be mentioned near a channel (→ ' +
        'voice_rule); a phrase banned only on one channel (→ lexicon with its channel attr); a ' +
        'performance finding about a channel (→ learning). The channel attr is REQUIRED — a ' +
        'register node with no channel or audience is a voice_rule.\n\n' +
        'register.subkind — choose ONE:\n' +
        '- channel_register: how the voice shifts for a channel.\n' +
        '- audience_register: how it shifts for an audience.\n' +
        '- format_register: how it shifts for a format (subject line, push, headline).',
      subkinds: [
        { key: 'channel_register', label: 'Channel register', description: 'How the voice shifts for a channel.' },
        { key: 'audience_register', label: 'Audience register', description: 'How the voice shifts for an audience.' },
        { key: 'format_register', label: 'Format register', description: 'How the voice shifts for a format.' },
      ],
      attrs: [
        { key: 'channel', label: 'Channel', type: 'string', description: 'The channel name, lowercase. Required.' },
        { key: 'audience', label: 'Audience', type: 'string', description: 'The audience it concerns, when named.' },
      ],
      buckets: [
        { key: 'channel_register', label: 'By channel', match: 'subkind' },
        { key: 'audience_register', label: 'By audience', match: 'subkind' },
        { key: 'format_register', label: 'By format', match: 'subkind' },
      ],
    },
    {
      key: 'exemplar',
      label: 'Specimen',
      label_plural: 'Specimens',
      color: 3,
      consequence: 'low',
      description:
        'A specimen of real copy — the copy ITSELF, not a statement about it. The body is the ' +
        'source text VERBATIM (see the VERBATIM SPECIMEN RULE): a sent email, a post, a draft ' +
        'the team rated, or a rewrite pair. Title: what the copy is in ≤8 words ("launch ' +
        'announcement email, march").\n\n' +
        'VERBATIM SPECIMEN RULE (binding here): quote, never paraphrase. Set asset_url to the ' +
        'canonical artifact when the source gives one — the link is provenance, never a ' +
        'substitute for the words. For before_after, label both versions "BEFORE:" and "AFTER:" ' +
        'and name the reason for the change when stated. An exemplar whose body describes copy ' +
        'rather than containing it must not be emitted; if the copy is not in the source, emit ' +
        'nothing. If it is too long, carry the passage actually discussed and flag yellow.\n\n' +
        'NOT an exemplar: a rule extracted FROM the copy (→ voice_rule/lexicon — emit both when ' +
        'the source does both); an AI draft nobody reacted to (not canon at all). Only emit ' +
        'off_voice when the source says WHY it is off — a rejection with no reason teaches ' +
        'nothing.\n\n' +
        'exemplar.subkind — choose ONE:\n' +
        '- gold: copy the team holds up as ON voice.\n' +
        '- off_voice: copy explicitly rejected as OFF voice, with the stated reason.\n' +
        '- before_after: a rewrite pair showing the correction.',
      subkinds: [
        { key: 'gold', label: 'Gold', description: 'Copy the team holds up as on voice.' },
        { key: 'off_voice', label: 'Off voice', description: 'Copy explicitly rejected as off voice, with the reason.' },
        { key: 'before_after', label: 'Before / after', description: 'A rewrite pair showing the correction.' },
      ],
      attrs: [
        { key: 'asset_url', label: 'Source link', type: 'string', description: 'Link to the canonical artifact (Mailchimp campaign, doc, thread permalink), when the source provides one.' },
        { key: 'channel', label: 'Channel', type: 'string', description: 'The channel it was written for, lowercase.' },
        { key: 'audience', label: 'Audience', type: 'string', description: 'The audience it addressed, when named.' },
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign it came from, lowercase, when named.' },
        { key: 'sent_on', label: 'Sent on', type: 'date', description: 'When it was sent/published, when stated.' },
      ],
      buckets: [
        { key: 'gold', label: 'Gold', match: 'subkind' },
        { key: 'off_voice', label: 'Off voice', match: 'subkind' },
        { key: 'before_after', label: 'Before / after', match: 'subkind' },
      ],
    },
    {
      key: 'learning',
      label: 'Learning',
      label_plural: 'Learnings',
      color: 6,
      consequence: 'low',
      description:
        'A durable, settled finding about LANGUAGE and how it performed: "subject lines under 6 ' +
        'words lift opens 12%", "first-person subject lines beat second-person 2:1". The ' +
        'conclusion WITH its number when stated. Tag the channel and campaign it came from.\n\n' +
        'NOT a learning: raw metrics with no stated conclusion (numbers alone are not canon); a ' +
        'finding about an offer, audience, or channel MIX rather than wording (→ marketing ' +
        'strategy); a rule the team adopted BECAUSE of a finding (→ voice_rule/lexicon, with ' +
        'this learning as its grounding — emit both).\n\n' +
        'learning.subkind — choose ONE:\n' +
        '- experiment_result: an A/B or test outcome about wording, with its number.\n' +
        '- performance_finding: a settled conclusion about language drawn from performance data.\n' +
        '- audience_language: how our audience actually words things, in their own terms.',
      subkinds: [
        { key: 'experiment_result', label: 'Experiment result', description: 'An A/B outcome about wording, with its number.' },
        { key: 'performance_finding', label: 'Performance finding', description: 'A settled conclusion about language from performance data.' },
        { key: 'audience_language', label: 'Audience language', description: 'How the audience actually words things.' },
      ],
      attrs: [
        { key: 'channel', label: 'Channel', type: 'string', description: 'The channel it concerns, lowercase, when named.' },
        { key: 'campaign', label: 'Campaign', type: 'string', description: 'The campaign it came from, lowercase, when named.' },
        { key: 'metric', label: 'Metric', type: 'string', description: 'The metric it moved (open rate, CTR), when named.' },
      ],
      buckets: [
        { key: 'experiment_result', label: 'Experiments', match: 'subkind' },
        { key: 'performance_finding', label: 'Performance', match: 'subkind' },
        { key: 'audience_language', label: 'Audience language', match: 'subkind' },
      ],
    },
  ],
  feedback_dimensions: [
    { key: 'voice_character', label: 'Voice character', description: 'expresses the recorded archetype and attributes rather than a generic brand register' },
    { key: 'lexicon', label: 'Lexicon', description: 'banned phrases absent, approved and canonical terms used with their recorded spelling' },
    {
      key: 'tone_and_style',
      label: 'Tone & style',
      description: 'follows the recorded tone, style, structure, and mechanics rules — and does not revive retired ones',
    },
    { key: 'register_fit', label: 'Register fit', description: 'matches the recorded register for the target channel and audience' },
    {
      key: 'specimen_likeness',
      label: 'Specimen likeness',
      description: 'reads like the gold specimens for this channel, and does not resemble recorded off-voice specimens',
    },
    {
      key: 'correction_recall',
      label: 'Correction recall',
      description: 'does not repeat a wording pattern a recorded alignment session already corrected',
    },
    { key: 'evidence_grounding', label: 'Evidence grounding', description: 'wording choices do not contradict recorded language learnings' },
    { key: 'context_recency', label: 'Context recency', description: 'recent rule changes, kills, or learnings the work should reflect' },
  ],
  review_kinds: [
    'email',
    'subject_line',
    'newsletter',
    'social_post',
    'blog_article',
    'landing_page',
    'ad_copy',
    'product_copy',
    'push_notification',
    'sales_email',
    'script',
    'other',
  ],
  query_scopes: [
    { key: 'character', label: 'Voice character', kind_keys: ['voice_attribute'] },
    { key: 'rules', label: 'Rules', kind_keys: ['voice_rule', 'lexicon'] },
    { key: 'lexicon', label: 'Words & phrases', kind_keys: ['lexicon'] },
    { key: 'register', label: 'Register', kind_keys: ['register'] },
    { key: 'specimens', label: 'Specimens', kind_keys: ['exemplar'] },
    { key: 'evidence', label: 'Learnings', kind_keys: ['learning'] },
    // The instruction-set scope: what an AI needs to WRITE in our voice.
    // Deliberately excludes `exemplar` — specimen bodies are verbatim copy and
    // would dominate the prompt budget. Pull them via `specimens` when wanted.
    { key: 'writing_brief', label: 'Everything an AI needs to write', kind_keys: ['voice_attribute', 'voice_rule', 'lexicon', 'register'] },
    { key: 'all', label: 'Everything', kind_keys: 'all' },
  ],
  extraction_groups: [
    {
      key: 'character',
      label: 'Voice character',
      kind_keys: ['voice_attribute'],
      description: 'The brand\'s durable character: the archetype we write as, we-are-X-not-Y axes, and durable voice attributes.',
    },
    {
      key: 'rules',
      label: 'Rules & lexicon',
      kind_keys: ['voice_rule', 'lexicon', 'register'],
      description:
        'How we write: tone, style, structure, and mechanics rules; banned/approved phrases and canonical terms quoted ' +
        'verbatim; and how the voice shifts per channel, audience, or format.',
    },
    {
      key: 'specimens',
      label: 'Specimens',
      kind_keys: ['exemplar'],
      description:
        'Real copy captured verbatim: sent campaigns and posts held up as on-voice, drafts rejected as off-voice with ' +
        'their reason, and before/after rewrite pairs.',
    },
    {
      key: 'evidence',
      label: 'Learnings',
      kind_keys: ['learning'],
      description: 'Findings about language and how it performed, with their numbers, and how the audience actually words things.',
    },
  ],
  flag_semantics: {
    red:
      'contradicts the canon — uses a banned phrase, uses a retired rule or a superseded canonical term, contradicts a ' +
      'recorded voice attribute or the register for its channel, repeats a wording pattern a recorded alignment session ' +
      'explicitly corrected, or reads like a recorded off-voice specimen',
    yellow:
      'hedged or unsupported — a wording choice no recorded rule covers; a specimen captured without its source link, ' +
      'paraphrased rather than quoted, or truncated to the discussed passage; a rule inferred from a single specimen with ' +
      'no stated reason; a language claim with no recorded learning behind it; a rule stated in chat but never settled',
    green:
      'consistent with the recorded character, rules, lexicon, and the register for its channel, and reads like the gold ' +
      'specimens for that channel',
  },
  edge_kinds: [
    {
      key: 'expresses',
      label: 'Expresses',
      description:
        'Points FROM a concrete rule or lexicon entry TO the ONE voice attribute it is the concrete form of — answers ' +
        '"why does this rule exist?". Only when the source ties them together ("we ban hype BECAUSE we are the expert ' +
        'friend"); never inferred from two items merely sharing a theme. At most one per source node; when unsure, emit ' +
        'NO edge.',
      src_kinds: ['voice_rule', 'lexicon'],
      dst_kinds: ['voice_attribute'],
      directed: true,
    },
    {
      key: 'applies_in',
      label: 'Applies in',
      description:
        'Points FROM a channel-scoped rule or lexicon entry TO the register node for the SAME channel its channel attr ' +
        'names — never a different channel, never a global rule. (Deterministic guard: both ends must carry matching ' +
        'channel attrs; mismatches are dropped at apply time.)',
      src_kinds: ['voice_rule', 'lexicon'],
      dst_kinds: ['register'],
      directed: true,
      scope_attr: 'channel',
    },
    {
      key: 'exemplifies',
      label: 'Exemplifies',
      description:
        'Points FROM a gold or before_after specimen TO the ONE rule, lexicon entry, or attribute it demonstrates — ' +
        'answers "show me this rule in real copy". Only when the source names the rule the specimen illustrates; never ' +
        'because a specimen happens not to violate a rule. When unsure which, emit NO edge.',
      src_kinds: ['exemplar'],
      dst_kinds: ['voice_rule', 'lexicon', 'voice_attribute'],
      directed: true,
    },
    {
      key: 'violates',
      label: 'Violates',
      description:
        'Points FROM an off_voice specimen TO the ONE rule or lexicon entry it breaks — the negative example, the most ' +
        'instructive edge in this profile. Only when the source states which rule was broken; a draft rejected on vibes ' +
        'with no named rule gets NO edge.',
      src_kinds: ['exemplar'],
      dst_kinds: ['voice_rule', 'lexicon'],
      directed: true,
    },
    {
      key: 'grounds',
      label: 'Grounds',
      description:
        'Points FROM a learning TO the ONE rule, lexicon entry, or register it is the evidence for — answers "which of ' +
        'our rules came from data rather than taste?". Only when the source states the rule was adopted BECAUSE of the ' +
        'finding; shared topic is not grounding.',
      src_kinds: ['learning'],
      dst_kinds: ['voice_rule', 'lexicon', 'register'],
      directed: true,
    },
  ],
  // NOTE deliberately NO supersedes edge, following marketing's precedent:
  // rule replacement is carried by the status attr (active/retired) plus the
  // banned entry's `replacement`, which the reviewer reads directly. An edge
  // would only add cross-family noise.
  source_types: [
    {
      key: 'brand_voice_guide',
      label: 'Brand voice guide',
      description: 'A voice & tone guide, style guide, editorial standards doc, or a written set of instructions for how to write for us.',
      extraction_guidance:
        'This is the voice canon stated formally. Fan every bulleted rule list into ONE node per rule — a guide\'s ' +
        'value is in its individual rules, never a summary of them. Quote every banned/approved phrase VERBATIM, one ' +
        'node per phrase, and set the replacement attr when the guide names what to say instead. Guides usually state ' +
        'the character AND the rules: emit both layers. Copy shown inside the guide as an example IS a specimen — ' +
        'capture it verbatim per the VERBATIM SPECIMEN RULE and tie it to the rule it illustrates.',
      group_floor: ['character', 'rules'],
      commit_unit: true,
      currency: 'decaying',
      authority_kinds: ['voice_attribute', 'voice_rule', 'lexicon', 'register', 'exemplar'],
      triage_guidance:
        'Legitimate when it reads as the team\'s adopted guide (rules stated as settled, not proposed). Voice guides go ' +
        'stale quietly — anchor currency on version markers, dates, and whether it contradicts newer rules or lexicon ' +
        'entries in the graph. Suspicious when it reads as one person\'s draft proposal or contains open questions.',
    },
    {
      key: 'ai_alignment_session',
      label: 'AI alignment session',
      description: 'A ChatGPT/Claude conversation where a human critiques AI-generated copy, corrects it, and states what the voice should be.',
      extraction_guidance:
        'This source is an AI ALIGNMENT SESSION and it inverts the usual reading: the AI\'s output is NOT canon — the ' +
        'HUMAN\'S CORRECTION is. Read it as a stream of corrections, and extract from the human\'s side only.\n\n' +
        'WHAT TO EXTRACT:\n' +
        '- Every correction that generalizes: "too salesy", "we never say leverage", "shorter sentences" → the rule or ' +
        'lexicon entry the human is asserting. This is the richest rule source in the corpus — a single session often ' +
        'yields a dozen rules. Do not merge them into one node.\n' +
        '- A rejected AI draft the human explained → an off_voice specimen, body VERBATIM, with the human\'s stated ' +
        'reason. NEVER emit off_voice for a draft rejected with no reason given.\n' +
        '- A draft the human accepted or praised ("that\'s it", "perfect") → a gold specimen, body VERBATIM.\n' +
        '- A human rewrite of an AI draft → a before_after specimen carrying BOTH versions verbatim.\n\n' +
        'WHAT STAYS OUT: the AI\'s own explanations of its choices; AI drafts the human ignored or did not respond to; ' +
        'the human\'s one-off edits with no generalizable reason ("make this line shorter" about one line only); ' +
        'prompt scaffolding and meta-instructions about the tool.\n\n' +
        'ORIGIN AND CAUTION: end each candidate body with one sentence naming that it came from an AI alignment ' +
        'session (e.g. "Stated as a correction to AI-drafted copy."). Set confidence ≤ 0.8 for explicit rules the ' +
        'human stated outright, ≤ 0.6 for rules you inferred from a pattern of corrections — and flag the inferred ' +
        'ones yellow.',
      source_kinds: ['transcript', 'interaction'],
      group_floor: ['rules', 'specimens'],
      // A record of discussion, never accurate "as a unit": the session is a
      // stream of corrections, some of which the human later reverses.
      commit_unit: false,
      currency: 'point_in_time',
      authority_kinds: ['voice_rule', 'lexicon', 'exemplar', 'register'],
      triage_guidance:
        'A correction session speaks for rules and specimens, never for the voice character as a whole — a human ' +
        'critiquing one draft is not redefining the archetype. Later corrections in the same session override earlier ' +
        'ones: when two extracted rules conflict, the later one is the human\'s settled view.',
    },
    {
      key: 'sent_campaign',
      label: 'Sent campaign',
      description: 'A real campaign that shipped — a Mailchimp email, newsletter, or published post export, often with its performance data.',
      extraction_guidance:
        'The campaign body IS a specimen: emit ONE exemplar carrying the copy VERBATIM (per the VERBATIM SPECIMEN ' +
        'RULE), with channel, campaign, and sent_on set, and asset_url pointing at the campaign. Do NOT shred the copy ' +
        'into rules — a sent email demonstrates the voice, it does not legislate it. Emit a rule ONLY when the source ' +
        'ANNOTATES the copy with one ("we led with the outcome here because…").\n\n' +
        'Subkind by what the source says about it: gold only when the team held it up as on-voice or the performance ' +
        'data is presented as a success; otherwise emit it unmarked rather than guessing. A campaign that merely ' +
        'exists is not automatically gold.\n\n' +
        'Performance numbers attached to the campaign are NOT learnings on their own — a learning needs a stated ' +
        'conclusion about LANGUAGE ("the short subject line drove the lift"). Numbers with no conclusion stay on the ' +
        'specimen as context, and yield no learning node.',
      group_floor: ['specimens', 'evidence'],
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['exemplar', 'learning'],
      triage_guidance:
        'A sent campaign is a record of something that actually shipped — it is authoritative for its own copy and ' +
        'nothing else. It is never "out of date" as a specimen (it was really sent), but a rule someone reads into it ' +
        'needs individual eyes.',
    },
    {
      key: 'performance_report',
      label: 'Performance report',
      description: 'Campaign or channel performance data: open rates, CTR, engagement — what language worked and what did not.',
      extraction_guidance:
        'Numbers alone are not canon. Extract only durable conclusions about LANGUAGE that the report itself draws — ' +
        'one learning per conclusion WITH its number, tagged with channel, campaign, and metric. A finding about send ' +
        'time, offer, segment, or channel mix is NOT this folder\'s (that is marketing strategy) — extract only what ' +
        'the report concludes about WORDING. A rule the report recommends going forward is a voice_rule only when ' +
        'stated as adopted, not as a suggestion.',
      group_floor: ['evidence'],
      commit_unit: true,
      currency: 'point_in_time',
      authority_kinds: ['learning'],
      triage_guidance:
        'Legitimate when it is a finished write-up (period and channels identifiable, conclusions stated). ' +
        'Authoritative for learnings only — any rule it yields needs individual eyes.',
    },
    {
      key: 'team_conversation',
      label: 'Team conversation',
      description: 'A Slack thread, chat export, or informal back-and-forth between teammates about how something should be worded.',
      extraction_guidance: conversationGuidance(
        'CAPTURE ESPECIALLY from voice chat: phrase rules settled in passing ("we never say enterprise-grade") — kills ' +
          'settled in chat are real kills, so set status retired on what they kill and flag red; wording the team ' +
          'converged on after debate; copy pasted into the thread and reacted to — that is a specimen, capture it ' +
          'VERBATIM per the VERBATIM SPECIMEN RULE with the reaction determining gold vs off_voice; and rewrites ' +
          'offered inline ("how about: …") once someone assents, as before_after pairs carrying both versions.',
      ),
      source_kinds: ['slack'],
      group_floor: ['rules', 'specimens'],
      currency: 'point_in_time',
    },
  ],
  seed_questions: [
    'What phrases do we ban, and what do we say instead?',
    'How would you describe our voice in one sentence — and what are we deliberately not?',
    'How does our voice change between email, LinkedIn, and product copy?',
    'Show me the best example of an email in our voice.',
    'What has AI-generated copy gotten wrong about our voice before?',
    'What did we correct most often in the last month?',
    'Which subject lines performed best, and what did they have in common?',
    'What are our rules about punctuation, capitalization, and emoji?',
    'Which of our voice rules came from performance data rather than taste?',
  ],
};
