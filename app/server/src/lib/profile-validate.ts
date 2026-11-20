import type { ContextProfile } from './schemas.js';

/**
 * The subset of a node the profile validator reads. Both the founding `Node`
 * union and the generalized `ProfileNode` envelope satisfy this shape.
 */
type ValidatableNode = { type: string } & Record<string, unknown>;

/**
 * Write-time validation of a node / candidate / review / finding against the
 * workspace's ContextProfile (spec B7). The profile replaces the old global
 * enums: a node's `type` must be a profile kind key, its `subkind` must be one
 * of that kind's subkinds, its `category` one of that kind's categories; a
 * review `kind` must be a profile review kind; a finding `category` must be a
 * profile feedback-dimension key.
 *
 * Returns null when valid, or a short human-readable reason on mismatch. The
 * API turns a non-null reason into a 422.
 */

/** Read the kind classifier off a node regardless of legacy vs generalized shape. */
function nodeSubkind(node: Record<string, unknown>): string | undefined {
  // generalized envelope uses `subkind`; legacy positioning used `kind`.
  return (node.subkind as string | undefined) ?? (node.kind as string | undefined);
}

export function validateNode(profile: ContextProfile, node: ValidatableNode): string | null {
  const n = node as Record<string, unknown>;
  const kindDef = profile.kinds.find((k) => k.key === node.type);
  if (!kindDef) {
    const allowed = profile.kinds.map((k) => k.key).join(', ');
    return `kind '${node.type}' is not in profile '${profile.id}' (allowed: ${allowed})`;
  }
  const sub = nodeSubkind(n);
  if (sub !== undefined && sub !== null) {
    if (!kindDef.subkinds || !kindDef.subkinds.some((s) => s.key === sub)) {
      const allowed = (kindDef.subkinds ?? []).map((s) => s.key).join(', ') || '(none)';
      return `subkind '${sub}' is not valid for kind '${node.type}' (allowed: ${allowed})`;
    }
  }
  const cat = n.category as string | undefined;
  if (cat !== undefined && cat !== null) {
    if (!kindDef.categories || !kindDef.categories.some((cc) => cc.key === cat)) {
      const allowed = (kindDef.categories ?? []).map((cc) => cc.key).join(', ') || '(none)';
      return `category '${cat}' is not valid for kind '${node.type}' (allowed: ${allowed})`;
    }
  }
  return null;
}

export function validateReviewKind(profile: ContextProfile, kind: string): string | null {
  if (!profile.review_kinds.includes(kind)) {
    return `review kind '${kind}' is not in profile '${profile.id}' (allowed: ${profile.review_kinds.join(', ')})`;
  }
  return null;
}

export function validateFeedbackCategory(profile: ContextProfile, category: string): string | null {
  if (!profile.feedback_dimensions.some((d) => d.key === category)) {
    const allowed = profile.feedback_dimensions.map((d) => d.key).join(', ');
    return `feedback category '${category}' is not in profile '${profile.id}' (allowed: ${allowed})`;
  }
  return null;
}

export function validateScope(profile: ContextProfile, scope: string): string | null {
  if (!profile.query_scopes.some((s) => s.key === scope)) {
    const allowed = profile.query_scopes.map((s) => s.key).join(', ');
    return `scope '${scope}' is not in profile '${profile.id}' (allowed: ${allowed})`;
  }
  return null;
}
