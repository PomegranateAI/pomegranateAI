import type { ContextProfile } from './schemas.js';

/**
 * Prompt templating (spec B5). Prompts stay as markdown files and gain
 * `{{slot}}` template slots filled from the workspace ContextProfile at call
 * time. Substitution is intentionally trivial — no new dependency. Unknown
 * slots are left untouched (so a prompt body that mentions `{{ }}` for other
 * reasons is safe), and a profile with no value for a slot renders nothing.
 */
export function renderPrompt(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(slots, key) ? slots[key]! : whole,
  );
}

/**
 * Render the `{{kind_taxonomy}}` slot for capture.md: every node kind with its
 * description, subkinds, and categories. This is what tells the capture model
 * what kinds exist and what belongs in each.
 */
export function renderKindTaxonomy(profile: ContextProfile): string {
  const parts: string[] = [];
  for (const kind of profile.kinds) {
    const header = `## ${kind.key} — ${kind.label}`;
    const lines = [header, '', kind.description.trim()];
    if (kind.subkinds && kind.subkinds.length > 0) {
      lines.push('', `Subkinds (set \`subkind\` to one of):`);
      for (const s of kind.subkinds) {
        lines.push(`- \`${s.key}\` (${s.label})${s.description ? ` — ${s.description}` : ''}`);
      }
    }
    if (kind.categories && kind.categories.length > 0) {
      lines.push('', `Categories (set \`category\` to one of):`);
      for (const cat of kind.categories) {
        lines.push(`- \`${cat.key}\` (${cat.label})${cat.description ? ` — ${cat.description}` : ''}`);
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/** Render the `{{flag_semantics}}` slot: per-flag meaning for this profile. */
export function renderFlagSemantics(profile: ContextProfile): string {
  const f = profile.flag_semantics;
  return [
    `- **red** — ${f.red}`,
    `- **yellow** — ${f.yellow}`,
    `- **green** — ${f.green}`,
  ].join('\n');
}

/** Render the `{{feedback_dimensions}}` slot for feedback.md. */
export function renderFeedbackDimensions(profile: ContextProfile): string {
  return profile.feedback_dimensions
    .map((d, i) => `${i + 1}. ${d.key} — ${d.description}`)
    .join('\n');
}

/** Render the `{{review_kinds}}` slot for feedback.md. */
export function renderReviewKinds(profile: ContextProfile): string {
  return profile.review_kinds.join(' | ');
}

/** Render the `{{scopes}}` slot for query.md. */
export function renderScopes(profile: ContextProfile): string {
  return profile.query_scopes
    .map((s) => {
      const kinds = s.kind_keys === 'all' ? 'all kinds' : s.kind_keys.join(', ');
      return `- \`${s.key}\` (${s.label}) → ${kinds}`;
    })
    .join('\n');
}

/**
 * Render the `{{kind_field_specs}}` slot for capture.md: the per-kind output
 * field shape — the generalized ProfileNode shape (title?, body, subkind?,
 * category?, attrs{...}) every current profile emits.
 */
export function renderKindFieldSpecs(profile: ContextProfile): string {
  const parts: string[] = [];
  for (const kind of profile.kinds) {
    const lines = [`${kind.key}:`];
    lines.push('  title (string, ≤10 words, per this kind\'s guidance in the taxonomy),');
    const bodySpec = kind.body_spec ?? 'body (string, 1-3 sentences, canonical form per Step 4)';
    lines.push(`  ${bodySpec}` + (kind.subkinds?.length || kind.categories?.length || kind.attrs?.length ? ',' : ''));
    if (kind.subkinds && kind.subkinds.length > 0) {
      lines.push(`  subkind (${kind.subkinds.map((s) => `"${s.key}"`).join(' | ')})` + (kind.categories?.length || kind.attrs?.length ? ',' : ''));
    }
    if (kind.categories && kind.categories.length > 0) {
      lines.push(`  category (${kind.categories.map((c) => `"${c.key}"`).join(' | ')})` + (kind.attrs?.length ? ',' : ''));
    }
    if (kind.attrs && kind.attrs.length > 0) {
      // "Only keys the source supports" is right for evidence-bearing attrs
      // (never invent an amount) but wrong for attrs a profile marks
      // `required`: a lifecycle status has an inferable default and is never
      // stated outright ("TODO (status: open)"), so it would always be
      // omitted, leaving nothing to transition FROM. Call the required ones
      // out explicitly rather than leaving them to lose against the contract.
      const req = kind.attrs.filter((a) => a.required);
      lines.push(
        req.length > 0
          ? `  attrs (object, include only keys the source supports — EXCEPT ${req
              .map((a) => a.key)
              .join(', ')}, which you MUST set on every ${kind.key}, inferring the default when the source does not say):`
          : '  attrs (object, include only keys the source supports):',
      );
      for (const a of kind.attrs) {
        const t = a.type === 'enum' && a.values?.length ? a.values.map((v) => `"${v}"`).join(' | ') : a.type;
        const flag = a.required ? ' [ALWAYS SET]' : '';
        lines.push(`    ${a.key}${flag}: ${t}${a.description ? ` — ${a.description}` : ''}`);
      }
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * A profile narrowed to one extraction group's kinds — used to render the
 * specialist capture prompt. Taxonomy and field specs render only the
 * group's kinds; everything else (description, flags) is unchanged.
 */
export function profileForGroup(profile: ContextProfile, groupKey: string): ContextProfile {
  const group = profile.extraction_groups?.find((g) => g.key === groupKey);
  if (!group) return profile;
  const keep = new Set(group.kind_keys);
  return { ...profile, kinds: profile.kinds.filter((k) => keep.has(k.key)) };
}

/**
 * Render the `{{extraction_scope}}` slot for a specialist call: the kinds
 * this call owns, plus a one-line list of every OTHER kind with the explicit
 * instruction to skip passages belonging to them (a parallel specialist
 * handles those). Renders empty for single-call capture.
 */
export function renderExtractionScope(profile: ContextProfile, groupKey?: string): string {
  if (!groupKey || !profile.extraction_groups?.length) return '';
  const group = profile.extraction_groups.find((g) => g.key === groupKey);
  if (!group) return '';
  const own = new Set(group.kind_keys);
  const others = profile.kinds.filter((k) => !own.has(k.key));
  const lines = [
    `# Extraction scope — you are the "${group.label}" specialist`,
    '',
    `You extract ONLY these kinds: ${group.kind_keys.map((k) => `\`${k}\``).join(', ')}.`,
    '',
    'The following kinds exist in this workspace but are NOT yours. Parallel',
    'specialist calls handle them. When a passage belongs to one of these,',
    'SKIP it — do not stretch it into one of your kinds:',
    '',
    ...others.map((k) => `- \`${k.key}\` — ${k.label}`),
  ];
  return lines.join('\n');
}

/**
 * Resolve the extraction guidance to inject into a capture call: a
 * deterministic match of the ingestion channel against
 * `SourceTypeDef.source_kinds`, or '' when nothing matches.
 *
 * Took a `routedSourceType` until 2026-07-17 and preferred it — route-capture
 * classified the document against the template's source_types, and that won over
 * the channel. Light's router decides which FOLDER a document belongs in and
 * nothing else, so the channel match is the whole resolution now (owner
 * decision; every template declares source_kinds).
 */
export function resolveSourceGuidance(profile: ContextProfile, sourceKind: string): string {
  const types = profile.source_types ?? [];
  if (types.length === 0) return '';
  const byChannel = types.find((s) => (s.source_kinds ?? []).includes(sourceKind));
  return byChannel?.extraction_guidance ?? '';
}

/**
 * Render the `{{source_guidance}}` slot for capture.md. Empty (the historic
 * prompt, byte-for-byte after slot collapse) when the document matched no
 * source type or the profile defines none.
 */
export function renderSourceGuidance(guidance: string): string {
  if (!guidance.trim()) return '';
  return ['# Source-type guidance for THIS document', '', guidance.trim()].join('\n');
}

/**
 * Render the `{{rule_policy}}` slot: the workspace owner's store-phase ingestion
 * rules (spec-directory-tracking-and-ingestion-rules.md §5.3b). `policy` is a
 * newline-joined list of rule instructions; empty → '' so the prompt is
 * byte-identical when no rules apply.
 */
export function renderRulePolicy(policy: string): string {
  if (!policy.trim()) return '';
  return [
    '# Ingestion rules — apply these as you extract',
    '',
    "The workspace owner has set standing rules for what may be captured and how.",
    'Honour every rule below:',
    '- If a rule says NOT to index/extract certain content, emit NO candidate for it.',
    '- If a rule says to hide or redact certain content (e.g. PII), redact it from',
    '  every field you emit — summary, body, and source_quote — replacing it with a',
    '  neutral placeholder like [redacted].',
    '',
    policy.trim(),
  ].join('\n');
}

/**
 * Render the `{{source_type_block}}` slot for doc-triage.md: the matched
 * source type in full (description + triage semantics + per-type guidance),
 * or an explicit "unclassified" line. The doc-triage prompt carries no
 * profile vocabulary of its own — this block is where the profile speaks.
 */
export function renderSourceTypeBlock(
  profile: ContextProfile,
  sourceTypeKey: string | undefined,
): string {
  const def = (profile.source_types ?? []).find((s) => s.key === sourceTypeKey);
  if (!def) {
    return [
      'This document could not be classified against the workspace profile’s',
      'source types. It can never be committed as a unit — assess legitimacy',
      'only, return null currency, and ask no currency questions.',
    ].join('\n');
  }
  const currency = def.currency ?? 'decaying';
  const lines = [
    `- key: \`${def.key}\` (${def.label})`,
    `- what it is: ${def.description}`,
    `- commit unit: ${def.commit_unit ? 'YES — when legitimate and current, the whole document can be committed in one action' : 'NO — a record of discussion; its items are always reviewed, so questions can only affect quarantine vs item triage'}`,
    `- currency mode: ${currency === 'decaying' ? 'decaying — the document claims to describe NOW; assess currency and ask about it when decisive' : 'point_in_time — a record of an event; currency MUST be null and currency questions are forbidden'}`,
  ];
  if (def.authority_kinds && def.authority_kinds !== 'any') {
    const labels = def.authority_kinds.map((k) => profile.kinds.find((x) => x.key === k)?.label ?? k);
    lines.push(`- authoritative for: ${labels.join(', ')} (other kinds it yields are reviewed individually regardless)`);
  }
  if (def.triage_guidance?.trim()) {
    lines.push('', `Type-specific assessment guidance: ${def.triage_guidance.trim()}`);
  }
  return lines.join('\n');
}

// ---- Convenience: build the slot map for a given prompt + profile ----

/**
 * Render the `{{subfolder_nodes}}` slot: what the subfolder already holds.
 *
 * THE slot that makes Light's capture work. Pre-Light, `CaptureOpts.graph` was
 * passed to `synth.capture` and then dropped on the floor — no slot rendered it,
 * so capture was graph-blind and a downstream dedup judge had to reconstruct
 * what capture could not see. Rendering the nodes here is what let that whole
 * stage be deleted: capture names its own amendments because it can finally read
 * the ids it must name.
 *
 * Ids are load-bearing, not decoration — `change`/`nuance` must quote one back.
 * Bodies are truncated: capture needs to recognize a node, not re-read it.
 */
export function renderSubfolderNodes(nodes: readonly unknown[]): string {
  if (!nodes || nodes.length === 0) {
    return 'This subfolder is empty. Every node you emit is an `addition`.';
  }
  const lines = nodes.map((n) => {
    const node = n as Record<string, unknown>;
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    const label = String(node.title ?? node.summary ?? '').trim();
    const body = String(node.body ?? '').replace(/\s+/g, ' ').trim();
    const attrStr = Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(' ');
    return [
      `- id: \`${String(node.id)}\` (${String(node.type)})`,
      label ? `  ${label}` : '',
      attrStr ? `  [${attrStr}]` : '',
      body ? `  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return lines.join('\n');
}

/**
 * Render the `{{shape_rule}}` slot: the template's cardinality, and the one
 * instruction that changes with it. `items` and `slots` want opposite instincts
 * from the extractor, so the rule is rendered rather than written into the
 * prompt body — capture.md must stay one file for both.
 */
export function renderShapeRule(profile: ContextProfile): string {
  if (profile.shape === 'log') {
    return [
      '## Cardinality — this template is a LOG',
      '',
      'ONE node per KIND, per document. Batch everything of the same kind from',
      'this document into that single node, one line per item — a document',
      'reporting six new items and two closures is TWO nodes (one node of the',
      'first kind with six lines, one of the second with two), never one node',
      'per item, never one node mixing kinds. A document carrying only one kind',
      'is one node.',
      '',
      'Every node is a fresh, standalone record — a dated report. "What holds',
      'now" is read by scanning the log newest-first, not by rewriting an',
      'earlier node.',
    ].join('\n');
  }
  if (profile.shape !== 'slots') {
    return [
      '## Cardinality — this template holds ITEMS',
      '',
      'Many nodes per kind — but node count follows distinct ITEMS, not sentence',
      'count. A document naming six tasks yields six nodes, because there are six',
      'tasks. A document spending several sentences on ONE thing — its cause, an',
      'effect, an example, a detail that sharpens it — yields ONE node holding all',
      'of it, not one node per sentence.',
      '',
      'Before writing a node, ask: is this a new item, or still the same item the',
      'document was already talking about? A new item gets its own node. More',
      'said about the item already being described belongs in the node already',
      'being built for it, not a node of its own.',
    ].join('\n');
  }
  const slotAttr = profile.kinds[0]?.attrs?.find((a) => a.values && a.values.length > 0);
  const slots = slotAttr?.values ?? [];
  return [
    '## Cardinality — this template holds SLOTS',
    '',
    '**This is the opposite instinct to a list, and getting it wrong breaks the',
    'subfolder.** This template has a fixed set of named slots. Emit AT MOST ONE',
    'node per slot per document — never a node per claim.',
    '',
    slots.length ? `The slots (\`${slotAttr?.key}\`): ${slots.map((s) => `\`${s}\``).join(' · ')}` : '',
    '',
    'Each node you emit is a COMPLETE STATEMENT of its slot as this document',
    'leaves it, incorporating what the document adds. A document naming two',
    'blockers gets ONE blockers node covering both.',
    '',
    '**Carry forward what still holds.** State the slot fully, not just what',
    'changed — a reader comparing this node to the last one on the same slot',
    'should see the complete current picture, not a diff. Anything the',
    'document does not address should still be represented if it still holds.',
    '',
    '**Drop what is resolved.** The mirror: when the document says something',
    'cleared, your statement of the slot must not still carry it.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * Render the `{{operation_rule}}` slot: capture.md's body asserts, verbatim,
 * "there is no operation to choose" (removed 2026-07-31, PR #145, when the
 * only live profile was log-shaped and every candidate was structurally an
 * addition). This slot renders EITHER that same assertion (note path,
 * dataAgentActive=false — byte-identical to today's prompt) OR the restored
 * supersede-detection teaching (data-agent path, dataAgentActive=true) — never
 * both, mirroring how `{{shape_rule}}` already varies by profile. Adapted
 * from the pre-removal text at commit 0cec4cf (spec-data-agents-and-
 * subfolder-wiki.md §3.1): "node" → "entry" throughout (this now runs only on
 * a data agent's structured entries, never on a note), and the original's
 * domain-specific worked example dropped — a shared slot shouldn't carry one
 * template's example into every other template's capture call.
 */
export function renderOperationRule(dataAgentActive: boolean): string {
  if (!dataAgentActive) {
    return (
      'Every candidate you emit is a fresh node — there is no operation to choose ' +
      'and nothing to name as a target. Write what the document says, in its own ' +
      'terms.'
    );
  }
  return [
    '## Does this replace something the folder already holds?',
    '',
    'For each thing you\'re about to emit, check it against the list above (the',
    'folder\'s current entries). Three cases:',
    '',
    '**It replaces one of them.** The task closed. The rule was overturned. The',
    'status changed. → `operation: "change"`, `amends: "<that entry\'s id>"`.',
    'Write the entry as it now stands, in full — not a note ABOUT the change.',
    '"Auth is done" changes the entry `Ship auth` to done; it does not create a',
    'new entry called "auth is done".',
    '',
    '**It sharpens one of them without replacing it** — an exception, a',
    'condition, a scope that still leaves the original standing. →',
    '`operation: "nuance"`, `amends: "<that entry\'s id>"`. Carry the',
    'qualification into the body alongside what was already there.',
    '',
    '**Nothing on the list is this.** → `operation: "addition"`, no `amends`.',
    '',
    '`change` and `nuance` MUST name a real id from the list above — if you',
    'cannot find the id, it\'s an `addition`, not a guess.',
  ].join('\n');
}

/**
 * Real current date, ISO (`YYYY-MM-DD`) — the anchor every LLM call needs to
 * resolve a relative date ("tomorrow", "next Tuesday") stated in a document
 * or a question. Nothing else supplies this: the model's training cutoff is
 * not today, and node timestamps only tell you when THIS graph was last
 * touched, not the real date "next week" means.
 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function captureSlots(
  profile: ContextProfile,
  groupKey?: string,
  sourceGuidance?: string,
  rulePolicy?: string,
  subfolderNodes: readonly unknown[] = [],
  dataAgentActive = false,
): Record<string, string> {
  const scoped = groupKey ? profileForGroup(profile, groupKey) : profile;
  return {
    kind_taxonomy: renderKindTaxonomy(scoped),
    flag_semantics: renderFlagSemantics(scoped),
    kind_field_specs: renderKindFieldSpecs(scoped),
    profile_description: profile.description,
    extraction_scope: renderExtractionScope(profile, groupKey),
    source_guidance: renderSourceGuidance(sourceGuidance ?? ''),
    rule_policy: renderRulePolicy(rulePolicy ?? ''),
    subfolder_nodes: renderSubfolderNodes(subfolderNodes),
    shape_rule: renderShapeRule(profile),
    operation_rule: renderOperationRule(dataAgentActive),
    today: today(),
  };
}

export function feedbackSlots(profile: ContextProfile): Record<string, string> {
  return {
    feedback_dimensions: renderFeedbackDimensions(profile),
    flag_semantics: renderFlagSemantics(profile),
    review_kinds: renderReviewKinds(profile),
    profile_description: profile.description,
  };
}

export function querySlots(profile: ContextProfile): Record<string, string> {
  return {
    scopes: renderScopes(profile),
    profile_description: profile.description,
    today: today(),
  };
}

export function docTriageSlots(
  profile: ContextProfile,
  sourceTypeKey: string | undefined,
): Record<string, string> {
  return {
    profile_description: profile.description,
    flag_semantics: renderFlagSemantics(profile),
    source_type_block: renderSourceTypeBlock(profile, sourceTypeKey),
  };
}
