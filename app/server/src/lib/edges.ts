import { BUILTIN_PROFILES } from './profiles/index.js';
import type { ContextProfile as ContextProfileT, EdgeKindDef as EdgeKindDefT } from './schemas.js';

/**
 * The edge-kind taxonomy for a workspace profile. Stored profile snapshots
 * predate `edge_kinds` (ContextProfile keeps it optional), so fall back to
 * the builtin profile of the same id when the snapshot lacks it. Profiles
 * without a declared taxonomy resolve to `[]` — every `addEdge` is rejected as
 * an unknown kind, which is the intended "no semantic edges" posture for a
 * profile that hasn't declared relations of its own.
 */
export function resolveEdgeKinds(profile: ContextProfileT | undefined): EdgeKindDefT[] {
  if (!profile) return [];
  return profile.edge_kinds && profile.edge_kinds.length > 0 ? profile.edge_kinds : (BUILTIN_PROFILES[profile.id]?.edge_kinds ?? []);
}

export type EdgeValidation = { ok: true; def: EdgeKindDefT } | { ok: false; error: string };

/**
 * Write-time enforcement of an edge kind's src/dst node-kind constraints
 * (the graph_edges table deliberately does not enforce them — see schema.ts).
 * `src_type`/`dst_type` are the nodes' profile kind keys (node.type).
 */
export function validateEdge(
  kinds: EdgeKindDefT[],
  edge: { kind: string; src_type: string; dst_type: string },
): EdgeValidation {
  const def = kinds.find((k) => k.key === edge.kind);
  if (!def) return { ok: false, error: `unknown edge kind '${edge.kind}' for this profile` };
  if (def.src_kinds !== 'any' && !def.src_kinds.includes(edge.src_type)) {
    return {
      ok: false,
      error: `edge kind '${edge.kind}' does not accept source kind '${edge.src_type}' (allowed: ${def.src_kinds.join(', ')})`,
    };
  }
  if (def.dst_kinds !== 'any' && !def.dst_kinds.includes(edge.dst_type)) {
    return {
      ok: false,
      error: `edge kind '${edge.kind}' does not accept destination kind '${edge.dst_type}' (allowed: ${def.dst_kinds.join(', ')})`,
    };
  }
  return { ok: true, def };
}
