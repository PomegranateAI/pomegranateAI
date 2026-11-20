import { describe, it, expect } from 'vitest';
import { validateProfileSemantics } from './validate.js';
import { listBuiltinProfiles, validateBuiltinProfiles } from './index.js';
import { foundingProfile } from './__fixtures__/founding.js';
import { productProfile } from './__fixtures__/product.js';
import type { ContextProfile } from '../schemas.js';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('profile semantic validation', () => {
  it('every builtin passes with zero errors AND zero warnings', () => {
    for (const p of listBuiltinProfiles()) {
      const { errors, warnings } = validateProfileSemantics(p);
      expect(errors, `${p.id} errors: ${errors.join(' | ')}`).toEqual([]);
      // The default (whole-doc) profile is deliberately minimal: it declares no
      // edge taxonomy and no source types, which are exactly the two documented
      // "legal opt-out" warnings. validateBuiltinProfiles allows those for
      // default only (see index.ts); every other builtin stays at zero.
      const expectedWarnings =
        p.id === 'default'
          ? warnings.filter((w) => !/no edge_kinds|no source_types/.test(w))
          : warnings;
      expect(expectedWarnings, `${p.id} warnings: ${expectedWarnings.join(' | ')}`).toEqual([]);
    }
    expect(() => validateBuiltinProfiles()).not.toThrow();
  });

  it('rejects edges referencing unknown kinds', () => {
    const p = clone(foundingProfile) as ContextProfile;
    p.edge_kinds!.push({
      key: 'broken',
      label: 'Broken',
      description: 'Points FROM nowhere TO nowhere, for testing.',
      src_kinds: ['goal'],
      dst_kinds: ['nonexistent_kind'],
      directed: true,
    });
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("edge 'broken'") && e.includes('nonexistent_kind'))).toBe(true);
  });

  it('rejects a kind missing from every extraction group, and double coverage', () => {
    const p = clone(productProfile) as ContextProfile;
    // Remove 'competitor' from its group → uncovered.
    p.extraction_groups = p.extraction_groups!.map((g) => ({
      ...g,
      kind_keys: g.kind_keys.filter((k) => k !== 'competitor'),
    }));
    const r1 = validateProfileSemantics(p);
    expect(r1.errors.some((e) => e.includes("'competitor'") && e.includes('NO extraction group'))).toBe(true);

    const p2 = clone(productProfile) as ContextProfile;
    p2.extraction_groups![0]!.kind_keys.push('goal'); // already in 'direction'
    const r2 = validateProfileSemantics(p2);
    expect(r2.errors.some((e) => e.includes("'goal'") && e.includes('2 extraction groups'))).toBe(true);
  });

  it('rejects two source types claiming the same channel; allows empty guidance', () => {
    const p = clone(productProfile) as ContextProfile;
    p.source_types!.push({
      key: 'second_chat',
      label: 'Second chat',
      description: 'Another chat type claiming slack.',
      extraction_guidance: '', // empty guidance is legal — flexibility by design
      source_kinds: ['slack'],
    });
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("channel 'slack'") && e.includes('order-dependent'))).toBe(true);
    expect(errors.some((e) => e.includes('extraction_guidance'))).toBe(false);
  });

  it('rejects enum attrs without values and bucket keys outside their dimension', () => {
    const p = clone(productProfile) as ContextProfile;
    const feature = p.kinds.find((k) => k.key === 'feature')!;
    feature.attrs!.push({ key: 'tier', label: 'Tier', type: 'enum' });
    feature.buckets!.push({ key: 'someday', label: 'Someday', match: 'horizon' }); // not a horizon value
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("enum attr 'tier'"))).toBe(true);
    expect(errors.some((e) => e.includes("bucket 'someday'") && e.includes("'horizon'"))).toBe(true);
  });

  it('rejects duplicate keys and query scopes over unknown kinds', () => {
    const p = clone(foundingProfile) as ContextProfile;
    p.kinds.push(clone(p.kinds[0]!)); // duplicate 'goal'
    p.query_scopes.push({ key: 'ghosts', label: 'Ghosts', kind_keys: ['ghost'] });
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("duplicate kind key 'goal'"))).toBe(true);
    expect(errors.some((e) => e.includes("query scope 'ghosts'") && e.includes("'ghost'"))).toBe(true);
  });

  it('warns (not errors) on opt-outable conventions: no edges, no source types, no all-scope', () => {
    const p = clone(foundingProfile) as ContextProfile;
    delete (p as Partial<ContextProfile>).edge_kinds;
    delete (p as Partial<ContextProfile>).source_types;
    p.query_scopes = p.query_scopes.filter((s) => s.kind_keys !== 'all');
    p.seed_questions = [];
    const { errors, warnings } = validateProfileSemantics(p);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('no edge_kinds'))).toBe(true);
    expect(warnings.some((w) => w.includes('no source_types'))).toBe(true);
    expect(warnings.some((w) => w.includes("'all'"))).toBe(true);
    expect(warnings.some((w) => w.includes('seed_questions'))).toBe(true);
  });

  it("accepts founding's legacy bucket match field ('priority') without warning", () => {
    const { warnings } = validateProfileSemantics(foundingProfile);
    expect(warnings.filter((w) => w.includes('priority'))).toEqual([]);
  });

  it('rejects a group_floor referencing an unknown extraction group', () => {
    const p = clone(productProfile) as ContextProfile;
    p.source_types!.find((s) => s.key === 'customer_interview')!.group_floor = ['ghost_group'];
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("'customer_interview'") && e.includes("'ghost_group'"))).toBe(true);
  });

  it('rejects a group_floor on a profile with no extraction_groups, and duplicate floor entries', () => {
    const p = clone(foundingProfile) as ContextProfile; // no extraction_groups
    p.source_types![0]!.group_floor = ['anything'];
    const r1 = validateProfileSemantics(p);
    expect(r1.errors.some((e) => e.includes('no extraction_groups'))).toBe(true);

    const p2 = clone(productProfile) as ContextProfile;
    p2.source_types!.find((s) => s.key === 'customer_interview')!.group_floor = ['evidence', 'evidence'];
    const r2 = validateProfileSemantics(p2);
    expect(r2.errors.some((e) => e.includes('duplicate group_floor') && e.includes("'evidence'"))).toBe(true);
  });

  it('warns (not errors) when a grouped profile source type has no group_floor', () => {
    const p = clone(productProfile) as ContextProfile;
    delete p.source_types!.find((s) => s.key === 'customer_interview')!.group_floor;
    const { errors, warnings } = validateProfileSemantics(p);
    expect(errors).toEqual([]);
    expect(
      warnings.some((w) => w.includes("'customer_interview'") && w.includes('group_floor')),
    ).toBe(true);
  });

  // ---- context-aware triage contract (spec §3) ----

  it('rejects an anchor whose match resolves to nothing', () => {
    const p = clone(productProfile) as ContextProfile;
    p.kinds.find((k) => k.key === 'competitor')!.anchor = { match: 'ghost_attr', values: ['x'] };
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("kind 'competitor' anchor") && e.includes('ghost_attr'))).toBe(true);
  });

  it('rejects anchor values outside the declared subkinds / enum values', () => {
    const p = clone(productProfile) as ContextProfile;
    p.kinds.find((k) => k.key === 'goal')!.anchor = { match: 'subkind', values: ['everything_star'] };
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes('everything_star') && e.includes('subkind'))).toBe(true);
  });

  it("accepts founding's legacy anchor field ('priority') — same allowance as buckets", () => {
    const { errors, warnings } = validateProfileSemantics(foundingProfile);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns on a consequence-annotation gap (those kinds fail safe to high)', () => {
    const p = clone(productProfile) as ContextProfile;
    delete p.kinds.find((k) => k.key === 'competitor')!.consequence;
    const { errors, warnings } = validateProfileSemantics(p);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('competitor') && w.includes("'high'"))).toBe(true);
  });

  it('warns when anchor is declared without a consequence tier', () => {
    const p = clone(productProfile) as ContextProfile;
    const goal = p.kinds.find((k) => k.key === 'goal')!;
    delete goal.consequence;
    const { warnings } = validateProfileSemantics(p);
    expect(warnings.some((w) => w.includes("'goal' anchor") && w.includes('consequence'))).toBe(true);
  });

  it('rejects authority_kinds referencing unknown kinds', () => {
    const p = clone(productProfile) as ContextProfile;
    p.source_types!.find((s) => s.key === 'prd_or_spec')!.authority_kinds = ['feature', 'ghost_kind'];
    const { errors } = validateProfileSemantics(p);
    expect(errors.some((e) => e.includes("'prd_or_spec'") && e.includes("'ghost_kind'"))).toBe(true);
  });

  it('warns when source types declare triage fields but no kind is annotated (dead config)', () => {
    const p = clone(productProfile) as ContextProfile;
    for (const k of p.kinds) {
      delete k.consequence;
      delete k.anchor;
    }
    const { errors, warnings } = validateProfileSemantics(p);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('triage fields') && w.includes('inactive'))).toBe(true);
  });

  describe('progress (spec-data-agents-and-subfolder-wiki.md §5.2)', () => {
    function withEnumAttr(): ContextProfile {
      const p = clone(foundingProfile) as ContextProfile;
      const goal = p.kinds.find((k) => k.key === 'goal')!;
      goal.attrs = [
        ...(goal.attrs ?? []),
        { key: 'status', label: 'Status', type: 'enum', values: ['proposed', 'active', 'shelved'] },
      ];
      return p;
    }

    it('accepts a progress declaration referencing a real enum attr and a real value', () => {
      const p = withEnumAttr();
      p.kinds.find((k) => k.key === 'goal')!.progress = { attr: 'status', settled_values: ['shelved'] };
      const { errors } = validateProfileSemantics(p);
      expect(errors).toEqual([]);
    });

    it('rejects a progress attr that is not declared on the kind', () => {
      const p = withEnumAttr();
      p.kinds.find((k) => k.key === 'goal')!.progress = { attr: 'ghost_attr', settled_values: ['x'] };
      const { errors } = validateProfileSemantics(p);
      expect(errors.some((e) => e.includes("kind 'goal' progress") && e.includes('ghost_attr'))).toBe(true);
    });

    it('rejects a progress attr that is not enum-typed', () => {
      const p = withEnumAttr();
      p.kinds.find((k) => k.key === 'goal')!.progress = { attr: 'period', settled_values: ['x'] };
      const { errors } = validateProfileSemantics(p);
      expect(errors.some((e) => e.includes("kind 'goal' progress") && e.includes("not 'enum'"))).toBe(true);
    });

    it('rejects a settled_values entry outside the attr\'s declared values', () => {
      const p = withEnumAttr();
      p.kinds.find((k) => k.key === 'goal')!.progress = { attr: 'status', settled_values: ['retired'] };
      const { errors } = validateProfileSemantics(p);
      expect(errors.some((e) => e.includes("kind 'goal' progress") && e.includes('retired'))).toBe(true);
    });

    it('is a fully legitimate absence — no warning, no error', () => {
      const p = withEnumAttr(); // progress left unset
      const { errors, warnings } = validateProfileSemantics(p);
      expect(errors).toEqual([]);
      expect(warnings.filter((w) => w.includes('progress'))).toEqual([]);
    });
  });
});
