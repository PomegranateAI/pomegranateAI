/**
 * The Report generator (spec-data-agents-and-subfolder-wiki.md §4.3).
 *
 * Unlike the wiki, there is no planning pass and no page tree: the section
 * list is DERIVED, deterministically, from whichever taxonomy currently
 * governs the subfolder (the caller resolves that — baseline notes, or an
 * attached data agent's kinds — and hands it in as `kinds`). For each kind:
 *   - nodes split into groups by the kind's own `buckets` declaration, or
 *     by `progress` (needs-attention nodes before settled ones), or one
 *     flat group when the kind declares neither (§5.1 — no new taxonomy,
 *     just a new reader of an existing one);
 *   - each group's prose is synthesized by the SAME node-fill LLM call the
 *     wiki's thematic pages already use (`wiki-fill-nodes.md`), one call per
 *     kind covering all its groups as that page's `sections`.
 * A kind with zero active nodes is omitted entirely — an empty section is
 * not a legitimate report section.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import type { Repo } from '../db/repo.js';
import type { NodeKindDef } from '../../lib/schemas.js';
import { hasStructuredLLM, structuredCall } from '../../lib/anthropic.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { log } from '../../lib/log.js';
import { ReportContent, type ReportBlock, type ReportGroup, type ReportSection } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../lib/prompts');
const NODE_MODEL = 'claude-haiku-4-5-20251001';
const BODY_CHARS = 400;
const MAX_NODES_PER_KIND = 40;

interface ReportNode {
  id: string;
  title: string;
  body: string;
  groupKey: string;
}

const WIKI_FILL_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section_key: { type: 'string', description: 'The heading this block belongs under.' },
          type: { type: 'string', enum: ['paragraph', 'list'] },
          text: { type: 'string', description: 'Prose for a paragraph block.' },
          items: { type: 'array', items: { type: 'string' }, description: 'Bullets for a list block.' },
          cited_node_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the nodes this block states.' },
        },
        required: ['type', 'cited_node_ids'],
      },
    },
  },
  required: ['blocks'],
} as const;

function loadPrompt(name: string): { body: string; version: number | undefined } {
  const raw = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), 'utf8');
  const parsed = matter(raw);
  return { body: parsed.content.trim(), version: (parsed.data as { version?: number }).version };
}

function bodyOf(n: Record<string, unknown>): string {
  const b = (n.body as string | undefined) ?? (n.summary as string | undefined) ?? '';
  return b.slice(0, BODY_CHARS);
}
function titleOf(n: Record<string, unknown>): string {
  return (n.title as string | undefined) ?? (n.name as string | undefined) ?? (n.id as string);
}

// Same fallback chain the client's Library grouping reads (Graph.tsx
// `bucketKey`) — kept identical so a kind's Report groups and its Library
// groups always agree, even though this runs server-side.
function bucketValue(n: Record<string, unknown>): string {
  const attrs = (n.attrs as Record<string, unknown> | undefined) ?? {};
  return (
    (n.priority as string | undefined) ??
    (n.subkind as string | undefined) ??
    (n.kind as string | undefined) ??
    (n.category as string | undefined) ??
    (typeof attrs.category === 'string' ? (attrs.category as string) : undefined) ??
    '_'
  );
}

/** Split one kind's active nodes into the groups its own declaration calls
 *  for: buckets > progress (needs-attention / settled) > one flat group. */
function groupNodes(
  kind: NodeKindDef,
  nodes: Array<Record<string, unknown>>,
): Array<{ key: string; label: string; nodes: Array<Record<string, unknown>> }> {
  if (kind.buckets && kind.buckets.length > 0) {
    const labels = new Map(kind.buckets.map((b) => [b.key, b.label]));
    const buckets = new Map<string, Array<Record<string, unknown>>>();
    for (const n of nodes) {
      const key = bucketValue(n);
      const bucketed = labels.has(key) ? key : 'other';
      if (!buckets.has(bucketed)) buckets.set(bucketed, []);
      buckets.get(bucketed)!.push(n);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, ns]) => ({ key, label: key === 'other' ? 'Other' : (labels.get(key) ?? key), nodes: ns }));
  }
  if (kind.progress) {
    const { attr, settled_values } = kind.progress;
    const settled = new Set(settled_values);
    const attention: Array<Record<string, unknown>> = [];
    const done: Array<Record<string, unknown>> = [];
    for (const n of nodes) {
      const attrs = (n.attrs as Record<string, unknown> | undefined) ?? {};
      const v = attrs[attr];
      (typeof v === 'string' && settled.has(v) ? done : attention).push(n);
    }
    const groups: Array<{ key: string; label: string; nodes: Array<Record<string, unknown>> }> = [];
    if (attention.length > 0) groups.push({ key: 'attention', label: 'Needs attention', nodes: attention });
    if (done.length > 0) groups.push({ key: 'settled', label: 'Settled', nodes: done });
    return groups;
  }
  return [{ key: '_', label: kind.label_plural, nodes }];
}

/** One kind's section: synthesize prose for every one of its groups in a
 *  single LLM call (the group list becomes that call's page `sections`). */
async function synthesizeSection(
  kind: NodeKindDef,
  groups: Array<{ key: string; label: string; nodes: Array<Record<string, unknown>> }>,
  workspace_id: string,
  caller: string,
): Promise<ReportSection | null> {
  if (groups.length === 0) return null;

  const flatNodes: ReportNode[] = [];
  for (const g of groups) {
    for (const n of g.nodes.slice(0, MAX_NODES_PER_KIND)) {
      flatNodes.push({ id: n.id as string, title: titleOf(n), body: bodyOf(n), groupKey: g.key });
    }
  }

  // Deterministic fallback — one paragraph per node, grounded and citing
  // itself. Used wholesale when no LLM is wired or the call itself throws,
  // and per-group when the call returns but a particular group's blocks
  // didn't survive grounding (below) — so the report always renders real,
  // cited content rather than a blank section.
  const fallbackInto = (target: ReportGroup[], onlyKey?: string) => {
    for (const n of flatNodes) {
      if (onlyKey !== undefined && n.groupKey !== onlyKey) continue;
      const g = target.find((x) => x.key === n.groupKey);
      g?.blocks.push({ type: 'paragraph', text: n.body ? `${n.title}: ${n.body}` : n.title, cited_node_ids: [n.id] });
    }
  };

  const emptyGroups: ReportGroup[] = groups.map((g) => ({ key: g.key, label: g.label, blocks: [] }));
  if (!hasStructuredLLM()) {
    fallbackInto(emptyGroups);
    return { kind_key: kind.key, label: kind.label_plural, color: kind.color, groups: emptyGroups };
  }

  const { body: system, version } = loadPrompt('wiki-fill-nodes');
  const user = JSON.stringify(
    {
      page: {
        title: kind.label_plural,
        sections: groups.map((g) => ({ heading: g.key, intent: `The "${g.label}" ${kind.label_plural.toLowerCase()}.` })),
      },
      nodes: flatNodes.map((n) => ({ id: n.id, kind: kind.key, title: n.title, body: n.body, in_document: false })),
    },
    null,
    2,
  );

  let res;
  try {
    res = await structuredCall({
      model: NODE_MODEL,
      system,
      user: `<input>\n${user}\n</input>`,
      toolName: 'emit_wiki_fill',
      toolDescription: 'Emit cited prose blocks for the report groups.',
      schema: WIKI_FILL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3072,
      task: 'report_fill',
      preferAnthropic: true,
    });
  } catch (err) {
    log.warn('report.fill_llm_failed', { kind: kind.key, msg: (err as Error).message?.slice(0, 200) });
    res = null;
  }
  if (!res) {
    fallbackInto(emptyGroups);
    return { kind_key: kind.key, label: kind.label_plural, color: kind.color, groups: emptyGroups };
  }

  const ctx = getLlmContext();
  writeLlmCall({
    task: 'report_fill',
    caller: ctx.caller ?? caller,
    workspace_id,
    user_id: ctx.user_id,
    mcp_token_id: ctx.mcp_token_id,
    model: res.modelLabel,
    prompt_version: version,
    output: res.noToolUse ? null : res.output,
    tokens: res.tokens,
    latency_ms: res.latency_ms,
  });

  const nodeIds = new Set(flatNodes.map((n) => n.id));
  const raw = (res.noToolUse ? [] : ((res.output as { blocks?: unknown[] })?.blocks ?? [])) as Array<{
    section_key?: string;
    type?: 'paragraph' | 'list';
    text?: string;
    items?: string[];
    cited_node_ids?: string[];
  }>;
  for (const b of raw) {
    const g = emptyGroups.find((x) => x.key === b.section_key);
    if (!g) continue;
    const cited = (b.cited_node_ids ?? []).filter((id) => nodeIds.has(id));
    const block: ReportBlock = { type: b.type === 'list' ? 'list' : 'paragraph', text: b.text, items: b.items, cited_node_ids: cited };
    if (!block.text?.trim() && !(block.items && block.items.length > 0)) continue;
    if (cited.length === 0) continue; // grounding — same rule as the wiki node path
    g.blocks.push(block);
  }
  // A group whose call produced nothing usable falls back to a deterministic
  // one-liner per node rather than rendering a blank section.
  for (const g of emptyGroups) {
    if (g.blocks.length === 0) fallbackInto(emptyGroups, g.key);
  }
  return { kind_key: kind.key, label: kind.label_plural, color: kind.color, groups: emptyGroups };
}

/** Generate the whole Report for a subfolder. `kinds` is whichever taxonomy
 *  currently governs it — the caller resolves that (baseline vs. an
 *  attached agent's template) exactly the way capture itself does. */
export async function generateReport(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  kinds: NodeKindDef[],
  opts: { hasSources: boolean; caller?: string },
): Promise<ReportContent> {
  const caller = opts.caller ?? 'api.report_generate';
  const allNodes = await repo.listNodes(workspace_id, { activeOnly: true, teamOnly: true }, subgraph_id) as unknown as Array<
    Record<string, unknown>
  >;

  const sections: ReportSection[] = [];
  for (const kind of kinds) {
    const kindNodes = allNodes.filter((n) => n.type === kind.key);
    if (kindNodes.length === 0) continue;
    const groups = groupNodes(kind, kindNodes);
    const section = await synthesizeSection(kind, groups, workspace_id, caller);
    if (section) sections.push(section);
  }

  const content: ReportContent = { sections, has_sources: opts.hasSources };
  log.info('report.generated', { workspace: workspace_id, subgraph: subgraph_id, sections: sections.length });
  return ReportContent.parse(content);
}
