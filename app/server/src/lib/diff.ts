import type { Candidate, Flag, Node } from './schemas.js';

/**
 * Determine the flag for a candidate against the current graph.
 *
 * Rules from PRD §Flags:
 *   <red>    — Proposes overriding or contradicting an *active* graph node
 *   <yellow> — Ambiguous, low-confidence, or partial proposal
 *   <green>  — Clean, high-confidence addition
 *
 * A candidate may already arrive with a flag from the model; this function
 * is the *deterministic* check that the flag is supported by the graph state.
 * If the model and the diff disagree, we trust the diff (more conservative).
 */
export function assignFlag(
  candidate: Pick<Candidate, 'proposed_node' | 'confidence'>,
  graph: readonly Node[],
): { flag: Flag; conflicts_with?: string; reason: string } {
  const proposed = candidate.proposed_node;

  // Type-specific conflict checks against active graph
  const active = graph.filter((n) => n.status === 'active');

  if (proposed.type === 'goal') {
    // Same-period north_star already exists?
    if (proposed.priority === 'north_star') {
      const existing = active.find(
        (n) => n.type === 'goal' && n.priority === 'north_star' && n.period === proposed.period,
      );
      if (existing && existing.id !== proposed.id) {
        return {
          flag: 'red',
          conflicts_with: existing.id,
          reason: `Another north_star already active for ${proposed.period}`,
        };
      }
    }
  }

  if (proposed.type === 'positioning') {
    // Banned vs approved phrase collision on same body
    const opposites: Record<string, string> = {
      banned_phrase: 'approved_phrase',
      approved_phrase: 'banned_phrase',
      killed_messaging: 'stance',
      stance: 'killed_messaging',
    };
    const opposite = opposites[proposed.kind];
    if (opposite) {
      const conflict = active.find(
        (n) =>
          n.type === 'positioning' &&
          n.kind === opposite &&
          similarBody(n.body, proposed.body),
      );
      if (conflict) {
        return {
          flag: 'red',
          conflicts_with: conflict.id,
          reason: `Conflicts with active ${opposite} on similar text`,
        };
      }
    }
  }

  if (proposed.type === 'decision') {
    // Recent same-category decision present?
    const sameCat = active.find(
      (n): n is Extract<Node, { type: 'decision' }> =>
        n.type === 'decision' && n.category === proposed.category && n.id !== proposed.id,
    );
    if (sameCat && similarText(sameCat.summary, proposed.summary)) {
      return {
        flag: 'red',
        conflicts_with: sameCat.id,
        reason: `Active decision in category=${proposed.category} on similar topic`,
      };
    }
  }

  // 3. Confidence-based fallback
  if (candidate.confidence < 0.6) {
    return { flag: 'yellow', reason: `Low confidence (${candidate.confidence.toFixed(2)})` };
  }

  return { flag: 'green', reason: 'Clean addition, no active conflicts' };
}

/** Cheap similarity heuristic. Good enough for v0 deterministic check. */
function similarBody(a: string, b: string): boolean {
  return overlap(a, b) >= 0.5;
}

function similarText(a: string, b: string): boolean {
  return overlap(a, b) >= 0.4;
}

function overlap(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  return common / Math.min(sa.size, sb.size);
}
