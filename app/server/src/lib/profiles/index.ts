import { ContextProfile } from '../schemas.js';
import type { ContextProfile as ContextProfileT } from '../schemas.js';
import { notesTemplate } from './notes.js';
import { validateProfileSemantics } from './validate.js';

/**
 * The built-in templates, shipped as data.
 *
 * There is exactly one: `notes`. Pomegranate Light (2026-07-17) replaced the
 * nine open-ended context profiles (`founding`, `marketing`, `product`,
 * `designer`, `personal`, `brand_voice`, `marketing_compliance`, `program`,
 * `default`) with four narrow templates; seven more joined the next day
 * (`decision_log`, `spec_sheet`, `strategy`, `evidence_log`, `user_insight`,
 * `goals_metrics`, `people_list`), for twelve total. That catalog optimized
 * for per-template extraction precision at the cost of breadth. This change
 * collapses all twelve into the single `notes` template — one general
 * folder job (keep what arrives), no per-template classification risk, no
 * picker. See `notes.ts` for the shape rationale.
 *
 * Nothing legacy is kept resolvable. A workspace/subgraph whose stored
 * `workspace_profiles` snapshot names a retired id keeps that frozen JSON
 * (see the pomegranate-template-contract skill's "Ship + snapshot" section)
 * until explicitly re-pointed at `notes`.
 */
export const BUILTIN_PROFILES: Record<string, ContextProfileT> = {
  notes: notesTemplate,
};

/** The only template — also the default for any caller that resolves none. */
export const DEFAULT_PROFILE_ID = 'notes';

/**
 * The template used when a caller supplies none — a folder with no stored
 * template, or an internal call that never had one.
 *
 * This is a LAST RESORT, not a routing decision: reaching it means a folder's
 * template could not be resolved, and the capture that follows is shaped by a
 * template nobody chose. Callers that can resolve a real one always should.
 */
export const FALLBACK_PROFILE: ContextProfileT = notesTemplate;

/** Ordered catalog for the onboarding picker. */
export function listBuiltinProfiles(): ContextProfileT[] {
  return [notesTemplate];
}

/** Resolve a built-in template by id, or undefined if not a built-in. */
export function getBuiltinProfile(id: string): ContextProfileT | undefined {
  return BUILTIN_PROFILES[id];
}

/**
 * True when this template holds exactly one node per named slot rather than
 * many nodes per kind. `notes` is `log`-shaped, so this is always false for
 * the built-in catalog today — kept for any custom `slots` profile a
 * workspace still has snapshotted.
 */
export function isSlotted(profile: ContextProfileT): boolean {
  return profile.shape === 'slots';
}

/**
 * Validate every built-in template parses against the ContextProfile schema AND
 * passes semantic validation with zero errors and zero warnings — built-ins are
 * held to the full bar (customs are blocked on errors only).
 */
export function validateBuiltinProfiles(): void {
  for (const p of listBuiltinProfiles()) {
    ContextProfile.parse(p);
    const { errors, warnings } = validateProfileSemantics(p);
    // A `slots` template is a fixed set of self-contained sections: relations
    // between headings carry no information, so an empty edge taxonomy is a
    // deliberate opt-out. `edges_deliberately_empty` is the same opt-out for
    // an `items`/`log` template whose kinds are events/batches rather than
    // entities. Every other warning, on every template, is blocking.
    const edgesOptedOut = isSlotted(p) || p.edges_deliberately_empty === true;
    const blocking = edgesOptedOut ? warnings.filter((w) => !/no edge_kinds/.test(w)) : warnings;
    if (errors.length > 0 || blocking.length > 0) {
      throw new Error(
        `builtin template '${p.id}' fails semantic validation:\n` +
          [...errors.map((e) => `  error: ${e}`), ...blocking.map((w) => `  warning: ${w}`)].join('\n'),
      );
    }
  }
}

export { notesTemplate };
export { validateProfileSemantics } from './validate.js';
export type { ProfileValidation } from './validate.js';
