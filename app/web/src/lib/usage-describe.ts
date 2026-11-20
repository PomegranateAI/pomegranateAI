import type { ContextUsageEntry } from '../api.js';

/**
 * One Usage row as a plain-English sentence:
 *   action  — what they did ("Asked", "Searched for", "Pulled notes")
 *   quote   — what they typed, when there is any (the question / search terms)
 *   context — where and how ("from Roadmap · titles only, added since 1 Oct 2026")
 *   outcome — what came back ("Answered · 3 sources", "42 notes", "No answer")
 */
export type UsageSentence = {
  action: string;
  quote: string | null;
  context: string | null;
  outcome: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const join = (...parts: Array<string | null | undefined | false>) =>
  parts.filter(Boolean).join(' · ') || null;

export function describeUsage(u: ContextUsageEntry): UsageSentence {
  const folder = u.folder_name ? `in ${u.folder_name}` : null;
  const topic = u.scope && u.scope !== 'all' ? `about ${u.scope.replace(/_/g, ' ')}` : null;
  const n = u.node_count ?? null;
  const text = u.request_text?.trim() || null;

  switch (u.tool) {
    case 'query':
      return {
        action: 'Asked',
        quote: text,
        context: join(folder),
        outcome:
          u.has_answer === false
            ? 'No answer'
            : u.cited
              ? `Answered · ${plural(u.cited, 'source')}`
              : 'Answered',
      };
    case 'search':
      return {
        action: 'Searched for',
        quote: text,
        context: join(folder, u.detail),
        outcome: n === null ? '—' : plural(n, 'result'),
      };
    case 'context_pack':
      return {
        action: u.detail?.startsWith('titles only') ? 'Browsed note titles' : 'Read notes',
        quote: null,
        context: join(topic, folder, u.detail),
        outcome: n === null ? '—' : plural(n, 'note'),
      };
    case 'review': {
      const kind =
        u.deliverable_kind && u.deliverable_kind !== 'other'
          ? `a ${u.deliverable_kind.replace(/_/g, ' ')} draft`
          : 'a draft';
      return {
        action: `Checked ${kind} against the vault`,
        quote: null,
        context: join(folder),
        outcome: u.cited ? plural(u.cited, 'note') + ' cited' : 'Reviewed',
      };
    }
    case 'recent_changes':
      return {
        action: 'Checked what changed',
        quote: null,
        context: join(u.detail),
        outcome: n === null ? '—' : plural(n, 'note'),
      };
    case 'work':
      return {
        action: 'Used a work agent',
        quote: text,
        context: join(folder),
        outcome: n === null ? 'Done' : plural(n, 'note') + ' used',
      };
    default:
      return { action: String(u.tool), quote: text, context: join(folder, u.detail), outcome: '—' };
  }
}

/** "AI tool" for MCP clients (Claude, ChatGPT…), "Web app" for the browser. */
export const channelLabel = (c: ContextUsageEntry['channel']) => (c === 'mcp' ? 'AI tool' : 'Web app');

export function fmtLatency(ms: number | null): string {
  if (!ms) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
