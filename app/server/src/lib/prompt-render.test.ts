import { describe, it, expect } from 'vitest';
import {
  renderPrompt,
  renderKindTaxonomy,
  renderKindFieldSpecs,
  renderFlagSemantics,
  renderFeedbackDimensions,
  renderReviewKinds,
  renderScopes,
  resolveSourceGuidance,
  renderRulePolicy,
  renderOperationRule,
  captureSlots,
  feedbackSlots,
  querySlots,
} from './prompt-render.js';
import { foundingProfile } from './profiles/__fixtures__/founding.js';
import { marketingProfile } from './profiles/__fixtures__/marketing.js';
import { brandVoiceProfile } from './profiles/__fixtures__/brand_voice.js';
import { productProfile } from './profiles/__fixtures__/product.js';
import { personalProfile } from './profiles/__fixtures__/personal.js';

describe('prompt templating', () => {
  it('substitutes known slots and leaves unknown ones untouched', () => {
    const out = renderPrompt('a {{x}} b {{y}} c', { x: '1' });
    expect(out).toBe('a 1 b {{y}} c');
  });

  it('renders a slot to empty when the value is the empty string', () => {
    expect(renderPrompt('[{{x}}]', { x: '' })).toBe('[]');
  });

  it('kind taxonomy includes every kind, its subkinds and categories', () => {
    const tax = renderKindTaxonomy(foundingProfile);
    expect(tax).toContain('## goal — Goal');
    expect(tax).toContain('## positioning — Positioning');
    expect(tax).toContain('## decision — Decision');
    // positioning subkinds rendered
    for (const s of foundingProfile.kinds.find((k) => k.key === 'positioning')!.subkinds!) {
      expect(tax).toContain(`\`${s.key}\``);
    }
    // decision categories rendered
    for (const cc of foundingProfile.kinds.find((k) => k.key === 'decision')!.categories!) {
      expect(tax).toContain(`\`${cc.key}\``);
    }
  });

  it('flag semantics render all three flags from the profile', () => {
    const f = renderFlagSemantics(foundingProfile);
    expect(f).toContain('**red**');
    expect(f).toContain('**yellow**');
    expect(f).toContain('**green**');
    expect(f).toContain(foundingProfile.flag_semantics.red);
  });

  it('feedback dimensions, review kinds, and scopes render from the profile', () => {
    expect(renderFeedbackDimensions(foundingProfile)).toContain('decisions');
    expect(renderReviewKinds(foundingProfile)).toBe(foundingProfile.review_kinds.join(' | '));
    expect(renderScopes(foundingProfile)).toContain('`all`');
    expect(renderScopes(foundingProfile)).toContain('all kinds');
  });

  it('slot maps expose the expected keys per prompt', () => {
    expect(Object.keys(captureSlots(foundingProfile)).sort()).toEqual([
      'extraction_scope',
      'flag_semantics',
      'kind_field_specs',
      'kind_taxonomy',
      'operation_rule',
      'profile_description',
      'rule_policy',
      'shape_rule',
      'source_guidance',
      'subfolder_nodes',
      'today',
    ]);
    expect(Object.keys(feedbackSlots(foundingProfile)).sort()).toEqual([
      'feedback_dimensions',
      'flag_semantics',
      'profile_description',
      'review_kinds',
    ]);
    expect(Object.keys(querySlots(foundingProfile)).sort()).toEqual([
      'profile_description',
      'scopes',
      'today',
    ]);
  });

  it('different profiles render different taxonomies', () => {
    const founding = renderKindTaxonomy(foundingProfile);
    const marketing = renderKindTaxonomy(marketingProfile);
    const brandVoice = renderKindTaxonomy(brandVoiceProfile);
    expect(founding).not.toBe(marketing);
    expect(marketing).toContain('## competitor');
    expect(founding).not.toContain('## competitor');
    // The voice canon renders from brand_voice, not marketing (the v3 split).
    expect(brandVoice).toContain('## lexicon');
    expect(marketing).not.toContain('## lexicon');
  });
});

describe('source-type guidance', () => {
  // Light (2026-07-17) removed the router-classification path entirely: the
  // router only decides which FOLDER a document belongs in, never what kind
  // of document it is. resolveSourceGuidance is channel-only now (profile +
  // sourceKind) — see its docstring in prompt-render.ts. The "list every
  // source type" renderer and the extraction-group evidence-floor resolver
  // (resolveGroupFloor) were removed with grouping/doc-triage; nothing calls
  // them anymore.
  it('channel match resolves guidance; unmatched channel → empty', () => {
    const g1 = resolveSourceGuidance(foundingProfile, 'slack');
    expect(g1).toContain('TEAM CONVERSATION');
    // A channel with no matching source type → no guidance.
    expect(resolveSourceGuidance(foundingProfile, 'doc')).toBe('');
    // Profile without source_types (old snapshot) → always empty.
    const bare = { ...foundingProfile, source_types: undefined };
    expect(resolveSourceGuidance(bare, 'slack')).toBe('');
  });

  it('captureSlots renders guidance into source_guidance and empty stays empty', () => {
    const withG = captureSlots(foundingProfile, undefined, 'BE CAREFUL WITH CHAT');
    expect(withG.source_guidance).toContain('# Source-type guidance for THIS document');
    expect(withG.source_guidance).toContain('BE CAREFUL WITH CHAT');
    const withoutG = captureSlots(foundingProfile, undefined, '');
    expect(withoutG.source_guidance).toBe('');
    // Back-compat: not passing guidance at all renders the empty slot.
    expect(captureSlots(foundingProfile).source_guidance).toBe('');
  });
});

describe('doc-triage source-type block (context-aware triage §6)', () => {
  it('renders the matched type with its triage semantics', async () => {
    const { renderSourceTypeBlock, docTriageSlots } = await import('./prompt-render.js');
    const block = renderSourceTypeBlock(productProfile, 'prd_or_spec');
    expect(block).toContain('`prd_or_spec`');
    expect(block).toContain('commit unit: YES');
    expect(block).toContain('decaying');
    // authority list renders LABELS, not keys — the prompt speaks the
    // profile's user-facing vocabulary.
    expect(block).toContain('authoritative for:');
    expect(block).toContain('Feature');
    // per-type guidance is injected
    expect(block).toContain('adopted spec');
    const slots = docTriageSlots(productProfile, 'prd_or_spec');
    expect(slots.source_type_block).toBe(block);
    expect(slots.profile_description).toBe(productProfile.description);
  });

  it('point_in_time types forbid currency; records of discussion are not commit units', async () => {
    const { renderSourceTypeBlock } = await import('./prompt-render.js');
    const block = renderSourceTypeBlock(productProfile, 'customer_interview');
    expect(block).toContain('commit unit: NO');
    expect(block).toContain('point_in_time');
    expect(block).toContain('currency MUST be null');
  });

  it('unclassified documents render the explicit fail-open block', async () => {
    const { renderSourceTypeBlock } = await import('./prompt-render.js');
    const block = renderSourceTypeBlock(productProfile, undefined);
    expect(block).toContain('could not be classified');
    expect(block).toContain('never be committed as a unit');
  });
});

describe('rule policy injection (ingestion rules §5.3b)', () => {
  it('renders empty for no/blank policy so the capture prompt stays byte-identical', () => {
    expect(renderRulePolicy('')).toBe('');
    expect(renderRulePolicy('   \n  ')).toBe('');
  });

  it('renders a directive block that carries the rule instructions', () => {
    const block = renderRulePolicy('1. Hide PII from customer call transcripts');
    expect(block).toContain('Ingestion rules');
    expect(block).toContain('Hide PII from customer call transcripts');
    expect(block).toContain('[redacted]');
  });

  it('captureSlots exposes rule_policy — empty by default, populated when passed', () => {
    const bare = captureSlots(foundingProfile);
    expect(bare.rule_policy).toBe('');

    const withPolicy = captureSlots(foundingProfile, undefined, undefined, '1. Do not index chatter');
    expect(withPolicy.rule_policy).toContain('Do not index chatter');
  });

  it('renderPrompt leaves the capture template byte-identical when rule_policy is empty', () => {
    const template = 'A\n\n{{rule_policy}}\n\nB';
    expect(renderPrompt(template, { rule_policy: '' })).toBe('A\n\n\n\nB');
    // and substitutes when present
    expect(renderPrompt(template, { rule_policy: 'POLICY' })).toBe('A\n\nPOLICY\n\nB');
  });

  describe('required attrs (AttrDef.required)', () => {
    // The attr contract is "include only keys the source supports" — correct
    // for evidence-bearing attrs (never invent an amount) and fatal for
    // lifecycle state: nobody writes "TODO (status: open)", so status was
    // ALWAYS omitted (prod: personal 0/17 nodes, marketing 0/184). A node with
    // no starting state has nothing to transition FROM and lands in no
    // status-matched Graph bucket.
    it('calls out required attrs against the source-supports-only contract', () => {
      const s = renderKindFieldSpecs(personalProfile);
      const task = s.slice(s.indexOf('task:'), s.indexOf('calendar_event:'));
      expect(task).toContain('EXCEPT status');
      expect(task).toContain('status [ALWAYS SET]');
      // The contract itself must survive for the non-required attrs.
      expect(task).toContain('include only keys the source supports');
      expect(task).not.toContain('due [ALWAYS SET]');
      expect(task).not.toContain('owner [ALWAYS SET]');
    });

    it('is OPT-IN: profiles declaring no required attr render exactly as before', () => {
      for (const p of [productProfile, marketingProfile, brandVoiceProfile, foundingProfile]) {
        const s = renderKindFieldSpecs(p);
        expect(s, `${p.id} must not gain an ALWAYS SET marker`).not.toContain('[ALWAYS SET]');
        expect(s, `${p.id} must not gain an EXCEPT clause`).not.toContain('EXCEPT');
      }
    });
  });

  describe('operation_rule (spec-data-agents-and-subfolder-wiki.md §3.1)', () => {
    it('no agent: byte-identical to the pre-slot capture.md assertion', () => {
      expect(renderOperationRule(false)).toBe(
        'Every candidate you emit is a fresh node — there is no operation to choose ' +
          'and nothing to name as a target. Write what the document says, in its own ' +
          'terms.',
      );
    });

    it('no agent: never mentions operation/amends as choosable', () => {
      const s = renderOperationRule(false);
      expect(s).toContain('no operation to choose');
      expect(s).not.toContain('operation: "change"');
      expect(s).not.toContain('operation: "nuance"');
    });

    it('agent active: teaches all three operations, each naming its exact field', () => {
      const s = renderOperationRule(true);
      expect(s).toContain('operation: "change"');
      expect(s).toContain('operation: "nuance"');
      expect(s).toContain('operation: "addition"');
      expect(s).toContain('amends');
    });

    it('captureSlots defaults to the no-agent rendering when unspecified', () => {
      expect(captureSlots(foundingProfile).operation_rule).toBe(renderOperationRule(false));
    });

    it('captureSlots renders the agent rule only when explicitly told to', () => {
      expect(captureSlots(foundingProfile, undefined, undefined, undefined, [], true).operation_rule).toBe(
        renderOperationRule(true),
      );
    });
  });
});
