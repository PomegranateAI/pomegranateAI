/**
 * Subgraph routing tokens. A `#<slug>` token in ingest/query text pins routing
 * to a named subgraph. This is a pure parser — no DB access — so both the API
 * and MCP paths can extract the same tokens before resolving them to subgraph
 * ids.
 *
 * A slug starts with [a-z0-9] and may continue with [a-z0-9-], up to 41 chars
 * total. Matching is case-insensitive; returned slugs are lowercased and
 * de-duplicated in first-seen order.
 */

const TOKEN_RE = /(?:^|\s)#([a-z0-9][a-z0-9-]{0,40})\b/gi;

export function parseSubgraphTokens(text: string): { stripped: string; slugs: string[] } {
  const slugs: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const slug = (m[1] ?? '').toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }

  if (slugs.length === 0) {
    return { stripped: text, slugs };
  }

  // Remove the matched `#slug` tokens, preserving the leading whitespace/anchor
  // the regex consumed, then collapse the resulting runs of spaces and trim.
  const stripped = text
    .replace(TOKEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { stripped, slugs };
}
