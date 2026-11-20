/**
 * Out-of-app surface renderers.
 *
 * The PRD specifies two recurring touchpoints that live OUTSIDE the web app:
 *   1. Daily 9am nudge — one line per outstanding red, source-grouped, cap 5.
 *   2. Weekly Drift Digest (Friday 5pm) — five lines.
 *
 * These functions render text. Delivery (Resend / Slack app) is wired
 * separately at deploy time; tests cover the rendered body only.
 *
 * Voice rules from gtm-positioning.md / product-strategy.md:
 *  - Plainspoken operator-to-operator.
 *  - No banned vendor words. No metaphors.
 *  - Aggregated drift is NEVER per-IC.
 *  - Decision attribution travels with every cited node.
 */
import type { Repo } from '../db/repo.js';

interface PendingCandidate {
  id: string;
  flag: 'red' | 'yellow' | 'green';
  proposed_node: string; // JSON
  source_ref: string;
  conflicts_with: string | null;
  created_at: string;
}

interface ReviewRow {
  caller: 'web' | 'mcp' | 'slack';
  kind: string;
  findings: string; // JSON
  created_at: string;
}

export interface NudgeRender {
  subject: string;
  body: string;
  red_count: number;
  yellow_count: number;
  truncated: number;
}

export interface DigestRender {
  subject: string;
  body: string;
  red_count: number;
  yellow_count: number;
  green_count: number;
  reviews_count: number;
}

const NUDGE_CAP = 5;

/**
 * Strip the source_ref to a short chip-style label. `slack:#strategy@1234`
 * becomes `#strategy`; `source:src_abc123` becomes `source`; a path becomes
 * its basename. Never returns the raw id.
 */
function sourceLabel(source_ref: string): string {
  if (!source_ref) return 'unknown';
  if (source_ref.startsWith('slack:')) {
    const rest = source_ref.slice('slack:'.length);
    const at = rest.indexOf('@');
    return at === -1 ? rest : rest.slice(0, at);
  }
  if (source_ref.startsWith('source:')) return 'upload';
  if (source_ref.includes('/')) return source_ref.slice(source_ref.lastIndexOf('/') + 1);
  return source_ref;
}

function summarize(node: any): string {
  if (!node) return '(unknown)';
  if (node.type === 'goal') return node.title ?? '(goal)';
  if (node.type === 'decision') return node.summary ?? '(decision)';
  if (node.type === 'positioning') {
    const body = String(node.body ?? '');
    return body.length > 80 ? body.slice(0, 77) + '…' : body;
  }
  return '(item)';
}

/**
 * Daily 9am nudge. Empty when no <red> items pending — empty nudge body is
 * the contract; caller decides whether to send.
 */
export async function renderNudge(
  repo: Repo,
  workspace_id: string,
  opts: { now?: Date; workspaceName?: string } = {},
): Promise<NudgeRender> {
  const cands = await repo.listCandidatesForDigest(workspace_id) as PendingCandidate[];

  const reds = cands.filter((c) => c.flag === 'red');
  const yellows = cands.filter((c) => c.flag === 'yellow');
  const truncated = Math.max(0, reds.length - NUDGE_CAP);
  const visibleReds = reds.slice(0, NUDGE_CAP);

  const lines: string[] = [];
  if (reds.length === 0 && yellows.length === 0) {
    lines.push('Nothing waiting — the vault matches the recent input.');
  } else {
    if (reds.length > 0) {
      lines.push(`${reds.length} red ${reds.length === 1 ? 'item' : 'items'} waiting.`);
      lines.push('');
      // Group by source for legibility.
      const bySource = new Map<string, PendingCandidate[]>();
      for (const r of visibleReds) {
        const k = sourceLabel(r.source_ref);
        const arr = bySource.get(k) ?? [];
        arr.push(r);
        bySource.set(k, arr);
      }
      for (const [src, group] of bySource) {
        lines.push(`From ${src}:`);
        for (const c of group) {
          let node: any = {};
          try {
            node = JSON.parse(c.proposed_node);
          } catch {}
          const overrides = c.conflicts_with ? ` (overrides ${c.conflicts_with})` : '';
          lines.push(`  - ${summarize(node)}${overrides}`);
        }
      }
      if (truncated > 0) {
        lines.push('');
        lines.push(`…and ${truncated} more red ${truncated === 1 ? 'item' : 'items'}.`);
      }
    }
    if (yellows.length > 0) {
      lines.push('');
      lines.push(
        `${yellows.length} yellow ${yellows.length === 1 ? 'item' : 'items'} waiting.`,
      );
    }
  }
  lines.push('');
  lines.push('Open Today to clear them: /today');

  const ws = opts.workspaceName ? ` for ${opts.workspaceName}` : '';
  return {
    subject: reds.length === 0
      ? `Nothing waiting${ws}`
      : `${reds.length} red${reds.length === 1 ? '' : 's'} waiting${ws}`,
    body: lines.join('\n'),
    red_count: reds.length,
    yellow_count: yellows.length,
    truncated,
  };
}

/**
 * Weekly digest. Window is [now-7d, now). Reports counts and the top reds
 * caught during the window. Curator attribution shows who CURATED a red
 * (resolved it) — not the IC who submitted a deliverable that triggered it.
 * If no curator reaches the 3-per-week threshold, the curator line is
 * omitted (strategy: no per-IC drift).
 */
export async function renderWeeklyDigest(
  repo: Repo,
  workspace_id: string,
  opts: { now?: Date; workspaceName?: string } = {},
): Promise<DigestRender> {
  const end = opts.now ?? new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600_000);
  const startIso = start.toISOString();

  const reviews = await repo.listReviewsSince(workspace_id, startIso) as ReviewRow[];

  let red = 0;
  let yellow = 0;
  let green = 0;
  const topReds: Array<{ summary: string; node_id: string | null; kind: string }> = [];
  for (const r of reviews) {
    let findings: any[] = [];
    try {
      findings = JSON.parse(r.findings) as any[];
    } catch {}
    for (const f of findings) {
      if (f.flag === 'red') {
        red++;
        if (topReds.length < 3) {
          topReds.push({
            summary: String(f.summary ?? ''),
            node_id: f.node_id ?? null,
            kind: r.kind ?? 'other',
          });
        }
      } else if (f.flag === 'yellow') yellow++;
      else if (f.flag === 'green') green++;
    }
  }

  // Resolution attribution: curators who approved 3+ candidates this week.
  const curatorRows = await repo.countApprovalsByCuratorSince(workspace_id, startIso) as Array<{ actor: string | null; n: number }>;

  const lines: string[] = [];
  lines.push(
    `This week: ${reviews.length} ${reviews.length === 1 ? 'review' : 'reviews'} (${red} red, ${yellow} yellow, ${green} green).`,
  );
  if (topReds.length > 0) {
    lines.push('');
    lines.push('Top reds:');
    for (const t of topReds) {
      const cite = t.node_id ? `  → ${t.node_id}` : '';
      lines.push(`  - [${t.kind}] ${t.summary}${cite}`);
    }
  }
  if (curatorRows.length > 0) {
    lines.push('');
    lines.push('Curators with 3+ approvals this week:');
    for (const c of curatorRows) {
      const id = c.actor ?? '(unattributed)';
      lines.push(`  - ${id}: ${c.n}`);
    }
  }
  lines.push('');
  lines.push('(Pomegranate drift metrics are never used for performance review.)');
  lines.push('Open the Mirror: /mirror');

  const ws = opts.workspaceName ? ` — ${opts.workspaceName}` : '';
  return {
    subject: `Weekly digest${ws}: ${red} red, ${yellow} yellow, ${green} green`,
    body: lines.join('\n'),
    red_count: red,
    yellow_count: yellow,
    green_count: green,
    reviews_count: reviews.length,
  };
}
