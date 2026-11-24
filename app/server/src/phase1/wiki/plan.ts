/**
 * Wiki plan pass (spec-wiki.md §4 / wiki-milestones.md M1).
 *
 * Decides the STRUCTURE of a wiki — categories, pages, and per-page sections —
 * from a compact digest of one workspace folder (its bound profile, documents
 * with classified source_type, and node/edge census). The LLM never sees the
 * full graph (same compute-once economics as recommendations.ts): only names,
 * counts, and truncated summaries.
 *
 * Two entry points:
 *  - `planWikiStructure` — LLM plan (gated on hasStructuredLLM).
 *  - `fallbackPlan`      — deterministic structure from the profile's groups +
 *                          scope values, used when no structured LLM is wired
 *                          (dev / offline) and as the seed the eval fixtures
 *                          assert against. Both feed `materializeWikiPlan`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Repo } from '../db/repo.js';
import type { ContextProfile as ContextProfileT } from '../../lib/schemas.js';
import { hasStructuredLLM, structuredCall } from '../../lib/anthropic.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { log } from '../../lib/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../lib/prompts');
// Planning is a nested-tree synthesis over the whole digest (docs + census).
// Haiku ignores the "one sentence" reasoning cap and, at a small token budget,
// spends the whole budget on reasoning prose — the tool call then truncates
// BEFORE the required `categories` array, so every plan fell back to the
// deterministic structure. Sonnet respects the schema and emits categories
// reliably; planning is cached by signature so it runs rarely.
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 4096;

// ---------- plan shape ----------

export interface WikiSection {
  key?: string;
  heading: string;
  intent?: string;
}
export interface WikiPlanPage {
  title: string;
  anchor?: { kind?: string; scope_value?: string; doc_id?: string } | null;
  source_doc_ids?: string[];
  sections?: WikiSection[];
  children?: WikiPlanPage[];
}
export interface WikiPlanCategory {
  title: string;
  pages: WikiPlanPage[];
}
export interface WikiPlan {
  categories: WikiPlanCategory[];
  reasoning?: string;
}

const SectionZ = z.object({
  key: z.string().optional(),
  heading: z.string().min(1),
  intent: z.string().optional(),
});
const PageZ: z.ZodType<WikiPlanPage> = z.lazy(() =>
  z.object({
    title: z.string().min(1),
    anchor: z
      .object({ kind: z.string().optional(), scope_value: z.string().optional(), doc_id: z.string().optional() })
      .nullish(),
    source_doc_ids: z.array(z.string()).optional(),
    sections: z.array(SectionZ).optional(),
    children: z.array(PageZ).optional(),
  }),
);
export const WikiPlanPayload = z.object({
  categories: z
    .array(z.object({ title: z.string().min(1), pages: z.array(PageZ) }))
    .min(1),
  reasoning: z.string().optional(),
});

const WIKI_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      description: '2–6 top-level categories in reading order; each must have ≥1 page.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Human category name, e.g. "Products".' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                anchor: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string' },
                    scope_value: { type: 'string' },
                    doc_id: { type: 'string' },
                  },
                },
                source_doc_ids: { type: 'array', items: { type: 'string' } },
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      heading: { type: 'string' },
                      intent: { type: 'string' },
                    },
                    required: ['heading'],
                  },
                },
                children: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      source_doc_ids: { type: 'array', items: { type: 'string' } },
                      sections: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { heading: { type: 'string' }, intent: { type: 'string' } },
                          required: ['heading'],
                        },
                      },
                    },
                    required: ['title'],
                  },
                },
              },
              required: ['title'],
            },
          },
        },
        required: ['title', 'pages'],
      },
    },
    reasoning: { type: 'string', description: 'One or two sentences on the structure chosen.' },
  },
  required: ['categories'],
} as const;

// ---------- digest ----------

export interface WikiDigest {
  profile: {
    id: string;
    name: string;
    description: string;
    groups: Array<{ key: string; label: string; kind_keys: string[] }>;
    scopes: string[];
    kinds: Array<{ key: string; label: string; subkinds: string[] }>;
    edge_kinds: string[];
    seed_questions: string[];
  };
  documents: Array<{
    id: string;
    name: string;
    source_type: string | null;
    summary: string | null;
    /** How many active nodes this document contributed — a proxy for how
     *  substantial/authoritative it is in the graph (its "weight"). */
    node_count: number;
  }>;
  /** The actual named things in the graph, grouped by kind, so the planner can
   *  structure around what is really there (how many products / specs /
   *  projects, and their names) instead of replaying the profile taxonomy. */
  entities: Array<{ kind: string; count: number; examples: string[] }>;
  census: {
    by_kind: Record<string, number>;
    by_product: Record<string, number>;
    total_nodes: number;
  };
}

const SUMMARY_CHARS = 360;
// Bounds so a large graph doesn't blow the digest.
const ENTITY_EXAMPLES_PER_KIND = 15;
const ENTITY_TITLE_CHARS = 90;

function nodeTitle(n: unknown): string {
  const a = n as { title?: string; name?: string; id?: string };
  return String(a.title ?? a.name ?? a.id ?? '').slice(0, ENTITY_TITLE_CHARS);
}

export async function buildWikiDigest(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  profile: ContextProfileT,
): Promise<WikiDigest> {
  const nodes = await repo.listNodes(workspace_id, { activeOnly: true, teamOnly: true }, subgraph_id);
  const by_kind: Record<string, number> = {};
  const by_product: Record<string, number> = {};
  const titlesByKind = new Map<string, string[]>();
  for (const n of nodes) {
    by_kind[n.type] = (by_kind[n.type] ?? 0) + 1;
    const product = (n.attrs?.product as string | undefined) ?? undefined;
    if (product) by_product[product] = (by_product[product] ?? 0) + 1;
    // Collect a bounded sample of real node names per kind.
    let ex = titlesByKind.get(n.type);
    if (!ex) { ex = []; titlesByKind.set(n.type, ex); }
    if (ex.length < ENTITY_EXAMPLES_PER_KIND) {
      const t = nodeTitle(n);
      if (t) ex.push(t);
    }
  }
  // Entities: named things per kind, heaviest kinds first.
  const entities = [...titlesByKind.keys()]
    .map((kind) => ({ kind, count: by_kind[kind] ?? 0, examples: titlesByKind.get(kind) ?? [] }))
    .sort((a, b) => b.count - a.count);

  // Documents carry their graph weight (node_count) so the planner can tell a
  // substantial roadmap/spec from a one-line note, and are sorted heaviest-first.
  //
  // SUBFOLDER SCOPE: documents are workspace-SHARED (one row), but a document
  // belongs to a subfolder only where it was routed/ingested (document_routing).
  // Listing every workspace document here let the planner anchor this subfolder's
  // pages to OTHER subfolders' documents, and the fill pass then read their full
  // source text in — the reported "wiki has content from other subfolders" bug.
  // Restrict to documents routed to THIS subgraph, and weigh each by only its
  // nodes in this subgraph (a shared doc has separate nodes per subgraph).
  const routedDocIds = new Set(
    (await repo.listSubgraphDocuments(workspace_id, subgraph_id)).map((r) => r.document_id),
  );
  const subgraphNodeIds = new Set(nodes.map((n) => n.id));
  //
  // AUDIENCE SCOPE: the planner only ever produces team pages, so the digest
  // carries only documents every workspace member may see (teamOnly) — a
  // member's private document must not leak its name or summary into a plan.
  const documents = (await Promise.all((await repo
    .listDocuments(workspace_id, { teamOnly: true }))
    .filter((d) => routedDocIds.has(d.id))
    .map(async (d) => ({
      id: d.id,
      name: d.source_ref?.split('/').pop() ?? d.id,
      source_type: d.source_type,
      summary: d.summary ? d.summary.slice(0, SUMMARY_CHARS) : null,
      node_count: (await repo.listNodeIdsByDocument(workspace_id, d.id)).filter((id) => subgraphNodeIds.has(id)).length,
    }))))
    .sort((a, b) => b.node_count - a.node_count);
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      description: (profile.description ?? '').slice(0, 600),
      groups: (profile.extraction_groups ?? []).map((g) => ({
        key: g.key,
        label: g.label,
        kind_keys: g.kind_keys,
      })),
      scopes: (profile.query_scopes ?? []).map((s) => s.key),
      kinds: profile.kinds.map((k) => ({
        key: k.key,
        label: k.label,
        subkinds: (k.subkinds ?? []).map((s) => s.key),
      })),
      edge_kinds: (profile.edge_kinds ?? []).map((e) => e.key),
      seed_questions: profile.seed_questions ?? [],
    },
    documents,
    entities,
    census: { by_kind, by_product, total_nodes: nodes.length },
  };
}

export function computePlanSignature(digest: WikiDigest): string {
  // Stable over the inputs that should trigger a replan: profile identity, the
  // document set, and the kind/product census. Not over summaries (prose drift
  // shouldn't rebuild structure).
  const shape = {
    profile: digest.profile.id,
    groups: digest.profile.groups.map((g) => g.key).sort(),
    docs: digest.documents.map((d) => `${d.id}:${d.source_type ?? ''}`).sort(),
    by_kind: digest.census.by_kind,
    by_product: Object.keys(digest.census.by_product).sort(),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 32);
}

// ---------- deterministic fallback ----------

/**
 * A profile-driven structure with no LLM: one category per extraction group (or
 * per query scope when a profile has no groups), and — for kinds that carry a
 * `product` scope — one page per distinct product value, sections seeded from
 * the kind's subkinds. Guarantees the "one product page, specs nested" shape the
 * eval fixtures assert against even offline.
 */
export function fallbackPlan(digest: WikiDigest): WikiPlan {
  const d = digest;
  const products = Object.keys(d.census.by_product);
  const categories: WikiPlanCategory[] = [];

  if (products.length > 0) {
    categories.push({
      title: 'Products',
      pages: products.map((p) => ({
        title: p,
        anchor: { kind: 'product', scope_value: p },
        sections: [
          { key: 'definition', heading: 'Definition', intent: `What ${p} is and the problem it solves.` },
          { key: 'goals', heading: 'Goals it serves', intent: `The goals ${p} advances.` },
          { key: 'decisions', heading: 'Decisions', intent: `Decisions that shaped ${p}.` },
        ],
      })),
    });
  }

  const groups = d.profile.groups.length > 0
    ? d.profile.groups
    : d.profile.scopes.map((s) => ({ key: s, label: s, kind_keys: [] as string[] }));
  for (const g of groups) {
    // Skip a group whose kinds have no nodes at all.
    const has = g.kind_keys.length === 0 || g.kind_keys.some((k) => (d.census.by_kind[k] ?? 0) > 0);
    if (!has) continue;
    categories.push({
      title: g.label,
      pages: [
        {
          title: g.label,
          anchor: null,
          sections: [{ key: 'overview', heading: g.label, intent: `Everything in the ${g.label.toLowerCase()} area.` }],
        },
      ],
    });
  }

  if (categories.length === 0) {
    categories.push({
      title: 'Overview',
      pages: [{ title: 'Overview', anchor: { kind: 'overview' } as any, sections: [{ heading: 'Overview' }] }],
    });
  }
  return { categories, reasoning: 'deterministic fallback (no structured LLM)' };
}

// ---------- LLM plan ----------

function loadPrompt(): { body: string; version: number | undefined } {
  const raw = readFileSync(resolve(PROMPTS_DIR, 'wiki-plan.md'), 'utf8');
  const parsed = matter(raw);
  return { body: parsed.content.trim(), version: (parsed.data as { version?: number }).version };
}

export async function planWikiStructure(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  profile: ContextProfileT,
  caller = 'api.wiki_plan',
): Promise<{ plan: WikiPlan; digest: WikiDigest; via: 'llm' | 'fallback' }> {
  const digest = await buildWikiDigest(repo, workspace_id, subgraph_id, profile);
  if (!hasStructuredLLM()) {
    return { plan: fallbackPlan(digest), digest, via: 'fallback' };
  }
  const { body: system, version } = loadPrompt();
  let res;
  try {
    res = await structuredCall({
      model: MODEL,
      system,
      user: `<digest>\n${JSON.stringify(digest, null, 2)}\n</digest>`,
      toolName: 'emit_wiki_plan',
      toolDescription: 'Emit the wiki structure: categories → pages → sections.',
      schema: WIKI_PLAN_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: MAX_TOKENS,
      task: 'wiki_plan',
      // Structure planning is a nested-tree synthesis Qwen handles poorly — prefer
      // Anthropic when a key is available (falls back to the provider otherwise).
      preferAnthropic: true,
    });
  } catch (err) {
    // A thrown LLM error (no override to catch it, or the override also failed)
    // must not 500 the wiki build — degrade to the deterministic plan.
    log.warn('wiki_plan.llm_failed', { workspace: workspace_id, msg: (err as Error).message?.slice(0, 200) });
    return { plan: fallbackPlan(digest), digest, via: 'fallback' };
  }
  const ctx = getLlmContext();
  writeLlmCall({
    task: 'wiki_plan',
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
  if (res.noToolUse) {
    log.warn('wiki_plan.llm_no_tool_use', { workspace: workspace_id });
    return { plan: fallbackPlan(digest), digest, via: 'fallback' };
  }
  const parsed = WikiPlanPayload.safeParse(res.output);
  if (!parsed.success) {
    log.warn('wiki_plan.parse_failed', { workspace: workspace_id, msg: parsed.error.message.slice(0, 200) });
    return { plan: fallbackPlan(digest), digest, via: 'fallback' };
  }
  return { plan: parsed.data, digest, via: 'llm' };
}

// ---------- materialize ----------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'page'
  );
}

/**
 * Write a plan into wiki_pages, replacing the current active tree. Categories
 * become kind='category' rows; pages/children become kind='page' rows carrying
 * their planned `sections`. Returns the counts written.
 */
export async function materializeWikiPlan(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  profile_id: string,
  plan: WikiPlan,
  plan_signature?: string,
): Promise<{ categories: number; pages: number }> {
  const rows: Array<Parameters<Repo['insertWikiPage']>[2]> = [];
  let catN = 0;
  let pageN = 0;
  let order = 0;

  // Per-build salt + a monotonic sequence, placed at the FRONT of every id.
  // replaceWikiPages archives (does not delete) the prior tree, and a rebuild
  // with unchanged inputs would otherwise regenerate the SAME deterministic ids
  // and collide with those archived rows (UNIQUE constraint on
  // wiki_pages.workspace_id, id). The salt makes ids unique across builds; the
  // leading position means the readable slug tail can be truncated safely
  // without ever removing the unique part.
  const salt = nanoid(6);
  let seq = 0;
  const mkId = (kind: 'c' | 'p', title: string) => `wp_${kind}_${salt}_${seq++}_${slugify(title).slice(0, 24)}`.slice(0, 60);

  for (const cat of plan.categories) {
    const catId = mkId('c', cat.title);
    rows.push({
      id: catId,
      kind: 'category',
      parent_id: null,
      slug: slugify(cat.title),
      title: cat.title,
      sort_order: order++,
    });
    catN++;
    let pOrder = 0;
    for (const page of cat.pages) {
      const pageId = mkId('p', page.title);
      rows.push({
        id: pageId,
        kind: 'page',
        parent_id: catId,
        slug: slugify(page.title),
        title: page.title,
        anchor: page.anchor ?? null,
        sections: page.sections ?? [],
        source_doc_ids: page.source_doc_ids ?? [],
        sort_order: pOrder++,
      });
      pageN++;
      let cOrder = 0;
      for (const child of page.children ?? []) {
        rows.push({
          id: mkId('p', child.title),
          kind: 'page',
          parent_id: pageId,
          slug: slugify(child.title),
          title: child.title,
          anchor: child.anchor ?? null,
          sections: child.sections ?? [],
          source_doc_ids: child.source_doc_ids ?? [],
          sort_order: cOrder++,
        });
        pageN++;
      }
    }
  }

  await repo.replaceWikiPages(workspace_id, subgraph_id, rows);
  await repo.upsertWiki(workspace_id, subgraph_id, { profile_id, plan_signature: plan_signature ?? null, status: 'built' });
  return { categories: catN, pages: pageN };
}

/** Title key for matching a planned page against an existing one. */
function titleKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fold a fresh plan into the EXISTING tree instead of replacing it — the refresh
 * path (spec §11.4), as opposed to `materializeWikiPlan`'s rebuild.
 *
 * Refresh runs over a wiki people have already read and edited, so it must not
 * churn ids (blocks hang off page ids) or discard structure work. The rules:
 *   - a planned page that MATCHES an existing one (same title, same category)
 *     keeps its row, its blocks and its user edits — we only refresh its
 *     `anchor` / `source_doc_ids`, which is what lets a page planned before the
 *     document-reproduction fix (or by `fallbackPlan`, which anchors nothing)
 *     start filling from its source document instead of filling empty;
 *   - a planned page with NO match is inserted (this is how newly-ingested
 *     documents earn a page on refresh);
 *   - an existing page absent from the plan is LEFT ALONE — it may be one the
 *     user wrote by hand. Only an explicit rebuild prunes the tree.
 */
export async function reconcileWikiPlan(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  profile_id: string,
  plan: WikiPlan,
  plan_signature?: string,
): Promise<{ added_categories: number; added_pages: number; rehomed_pages: number }> {
  const existing = await repo.listWikiPages(workspace_id, subgraph_id);
  const categoriesByTitle = new Map(
    existing.filter((p) => p.kind === 'category').map((p) => [titleKey(p.title), p]),
  );
  // Pages are matched within their parent, so the same title under two different
  // categories stays two distinct pages.
  const pagesByParentTitle = new Map(
    existing.filter((p) => p.kind === 'page').map((p) => [`${p.parent_id ?? ''} ${titleKey(p.title)}`, p]),
  );

  const salt = nanoid(6);
  let seq = 0;
  const mkId = (kind: 'c' | 'p', title: string) => `wp_${kind}_${salt}_${seq++}_${slugify(title).slice(0, 24)}`.slice(0, 60);

  let added_categories = 0;
  let added_pages = 0;
  let rehomed_pages = 0;

  // Append position per parent, seeded from the existing tree and advanced as we
  // insert (so two new pages under one category don't both land at order 0).
  const orderCursor = new Map<string, number>();
  const nextOrder = (parentId: string | null): number => {
    const key = parentId ?? '';
    let n = orderCursor.get(key);
    if (n === undefined) {
      n = Math.max(-1, ...existing.filter((p) => (p.parent_id ?? '') === key).map((p) => p.sort_order)) + 1;
    }
    orderCursor.set(key, n + 1);
    return n;
  };

  const upsertPage = async (page: WikiPlanPage, parentId: string) => {
    const match = pagesByParentTitle.get(`${parentId} ${titleKey(page.title)}`);
    let pageId: string;
    if (match) {
      // Re-home the page onto the current plan's sources. Title, sections, order
      // and blocks are the reader's/user's — untouched.
      await repo.updateWikiPage(workspace_id, match.id, {
        anchor: page.anchor ?? match.anchor ?? null,
        source_doc_ids: page.source_doc_ids ?? match.source_doc_ids ?? [],
      });
      rehomed_pages++;
      pageId = match.id;
    } else {
      pageId = mkId('p', page.title);
      await repo.insertWikiPage(workspace_id, subgraph_id, {
        id: pageId,
        kind: 'page',
        parent_id: parentId,
        slug: slugify(page.title),
        title: page.title,
        anchor: page.anchor ?? null,
        sections: page.sections ?? [],
        source_doc_ids: page.source_doc_ids ?? [],
        // Appended after the category's current last child — a new page must not
        // reshuffle the order the reader already knows.
        sort_order: nextOrder(parentId),
      });
      added_pages++;
    }
    for (const child of page.children ?? []) await upsertPage(child, pageId);
  };

  await repo.tx(async () => {
    for (const cat of plan.categories) {
      let catId = categoriesByTitle.get(titleKey(cat.title))?.id;
      if (!catId) {
        catId = mkId('c', cat.title);
        await repo.insertWikiPage(workspace_id, subgraph_id, {
          id: catId,
          kind: 'category',
          parent_id: null,
          slug: slugify(cat.title),
          title: cat.title,
          sort_order: nextOrder(null),
        });
        added_categories++;
      }
      for (const page of cat.pages) await upsertPage(page, catId);
    }
    await repo.upsertWiki(workspace_id, subgraph_id, { profile_id, plan_signature: plan_signature ?? null, status: 'built' });
  });

  return { added_categories, added_pages, rehomed_pages };
}
