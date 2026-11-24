/**
 * Wiki fill pass (spec-wiki.md §5 / wiki-milestones.md M2).
 *
 * A wiki page is a LIVING REPRODUCTION of its source document(s): the fill pass
 * starts from the original document text and changes only what other sources have
 * since corrected. So for a page anchored to source documents we:
 *   1. load the original document text (the spine),
 *   2. gather the "corrections" — nodes from OTHER documents / later changes that
 *      touch this page's scope,
 *   3. hand both to the fill LLM, which reproduces the document section by
 *      section and rewrites only the paragraphs a correction actually changes,
 *   4. mark each section: unchanged → in_document/accepted; changed-or-added →
 *      inferred/pending (highlighted for review, spec §7).
 *
 * This heavy, structure-sensitive rewrite is forced onto Anthropic
 * (`preferAnthropic`) — a local/hosted-Qwen backend degrades on long,
 * grammar-constrained array outputs (it emits one degenerate block), which is
 * why the previous node-only fill "only filled the last block."
 *
 * Pages with no source document (thematic/entity pages) fall back to the
 * node-synthesis path (`wiki-fill-nodes.md`); a deterministic fallback runs when
 * no structured LLM is wired, so fill works offline and under test.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Repo, WikiPage } from '../db/repo.js';
import type { Node as NodeT } from '../../lib/schemas.js';
import { hasStructuredLLM, structuredCall } from '../../lib/anthropic.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { log } from '../../lib/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../lib/prompts');
// The node-synthesis fallback (thematic pages) is a light task → Haiku.
const NODE_MODEL = 'claude-haiku-4-5-20251001';
// Document reproduction takes a whole document + its corrections and rewrites the
// paragraphs that changed — a long, structure-sensitive task → Sonnet, on Anthropic.
const REPRO_MODEL = 'claude-sonnet-4-5-20250929';
const BODY_CHARS = 400;
const MAX_NODES = 40;
// Cap on how much source text we hand the model (a very large doc is rare; this
// keeps a runaway file from blowing the context / budget).
const DOC_TEXT_CHARS = 60_000;

export interface FillNode {
  id: string;
  kind: string;
  title: string;
  body: string;
  in_document: boolean;
}

interface OutBlock {
  section_key?: string;
  type: 'paragraph' | 'list';
  text?: string;
  items?: string[];
  cited_node_ids: string[];
  changed?: boolean;
}

const WikiFillPayload = z.object({
  blocks: z.array(
    z.object({
      section_key: z.string().optional(),
      type: z.enum(['paragraph', 'list']).default('paragraph'),
      text: z.string().optional(),
      items: z.array(z.string()).optional(),
      cited_node_ids: z.array(z.string()).default([]),
      changed: z.boolean().optional(),
    }),
  ),
});

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
          cited_node_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the correction nodes applied to this section. Empty when reproduced unchanged.',
          },
          changed: {
            type: 'boolean',
            description: 'True iff a correction altered this section; false when it reproduces the source as-is.',
          },
        },
        required: ['type', 'cited_node_ids'],
      },
    },
  },
  required: ['blocks'],
} as const;

// ---------- retrieval ----------

function bodyOf(n: NodeT): string {
  const anyN = n as unknown as { body?: string; summary?: string };
  return (anyN.body ?? anyN.summary ?? '').slice(0, BODY_CHARS);
}

function titleOf(n: NodeT): string {
  const anyN = n as unknown as { title?: string; name?: string };
  return anyN.title ?? anyN.name ?? '';
}

/**
 * Does a node's scope value (its product attribute, or its title) satisfy the
 * page anchor's `scope_value`? Case-insensitive, and tolerant of the digest's
 * 90-char title truncation: the planner sees truncated entity titles, so it may
 * emit a prefix of the real title (or vice versa). We accept a prefix match once
 * the shared text is long enough to be unambiguous.
 */
function scopeMatches(candidate: string, want: string): boolean {
  const c = candidate.trim().toLowerCase();
  const w = want.trim().toLowerCase();
  if (!c || !w) return false;
  if (c === w) return true;
  const short = c.length <= w.length ? c : w;
  const long = c.length <= w.length ? w : c;
  return short.length >= 8 && long.startsWith(short);
}

// ---------- page audience ----------

/**
 * Who a page's generated content is for, which decides which sources may feed
 * it (a page must never reproduce material its readers couldn't open):
 *   - a 'team' page (or no visibility set) → `{ teamOnly: true }`: only notes
 *     with visibility='team' and documents every workspace member may see;
 *   - a 'private' / 'only_me' page → its owner's AI-read view: team material
 *     plus the owner's own private notes/documents, never 'only_me' (which is
 *     human-eyes-only and excluded from every LLM read, even the owner's).
 * A private/only_me page with no recorded owner fails closed to team-only.
 */
export type PageAudience = { teamOnly: true } | { viewer: string; aiRead: true };

export function pageAudience(page: Pick<WikiPage, 'visibility' | 'owner_user_id'>): PageAudience {
  if ((page.visibility === 'private' || page.visibility === 'only_me') && page.owner_user_id) {
    return { viewer: page.owner_user_id, aiRead: true };
  }
  return { teamOnly: true };
}

/** May this page's audience read document `docId`? (documentVisibilityFilter.) */
async function docVisibleToAudience(repo: Repo, workspace_id: string, docId: string, audience: PageAudience): Promise<boolean> {
  return 'teamOnly' in audience
    ? repo.documentVisibleToViewer(workspace_id, docId, undefined, true, { teamOnly: true })
    : repo.documentVisibleToViewer(workspace_id, docId, audience.viewer, true);
}

/**
 * Candidate nodes for a page: origin-document nodes ∪ anchor-scope nodes, then a
 * tolerant one-hop edge walk. `in_document` is true only for the origin-doc
 * nodes — that split is what the provenance classification keys off, and what
 * tells the reproduction pass which nodes are "corrections" (in_document=false).
 */
export async function gatherPageNodes(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  page: WikiPage,
): Promise<{ nodes: FillNode[]; originIds: Set<string> }> {
  const originIds = new Set<string>();
  for (const docId of page.source_doc_ids ?? []) {
    // The spine is the union of the document's own nodes (graph_nodes.document_id)
    // and nodes the evidence ledger corroborates to that document.
    for (const id of await repo.listNodeIdsByDocument(workspace_id, docId)) originIds.add(id);
    for (const id of await repo.listNodeIdsByDocumentEvidence(workspace_id, docId)) originIds.add(id);
  }

  // Only nodes the page's audience may see (pageAudience): a team page never
  // draws on a member's private notes, even ones linked to its source docs or
  // reached by the edge walk — both are filtered through `byId` below.
  const all = await repo.listNodes(workspace_id, { activeOnly: true, ...pageAudience(page) }, subgraph_id);
  const byId = new Map(all.map((n) => [n.id, n]));

  const seed = new Set<string>(originIds);
  // Anchor resolution. The plan pass anchors a page to {kind, scope_value} for
  // ANY entity kind — a product, but also a project / spec / strategy / campaign
  // page. Fill must resolve all of them, not just products, or those pages find
  // no nodes and fill empty (the planner and filler must key on the same thing):
  //   - a product page (scope_value is a product) pulls every node scoped to
  //     that product via the `product` attribute;
  //   - any other entity page pulls the node that IS that entity, matched by
  //     title, constrained to the anchored kind so a title collision on another
  //     kind doesn't seed the page;
  //   - a kind-overview page (a kind, no scope_value) pulls every node of that
  //     kind.
  // The one-hop edge walk below then expands any of these seeds into the goals,
  // decisions and specs that hang off the entity.
  const anchor = (page.anchor as { kind?: string; scope_value?: string } | null) ?? null;
  const wantKind = anchor?.kind?.trim().toLowerCase();
  if (anchor?.scope_value) {
    const want = anchor.scope_value;
    for (const n of all) {
      const product = n.attrs?.product as string | undefined;
      if (product && scopeMatches(product, want)) {
        seed.add(n.id);
        continue;
      }
      if (!wantKind || wantKind === 'product' || n.type.toLowerCase() === wantKind) {
        if (scopeMatches(titleOf(n), want)) seed.add(n.id);
      }
    }
  } else if (wantKind && wantKind !== 'overview') {
    for (const n of all) {
      if (n.type.toLowerCase() === wantKind) seed.add(n.id);
    }
  }

  // Tolerant one-hop edge walk from the seed.
  const reached = new Set<string>(seed);
  for (const id of seed) {
    for (const e of await repo.listEdges(workspace_id, { node: id }, subgraph_id)) {
      const other = e.src === id ? e.dst : e.src;
      if (byId.has(other)) reached.add(other);
    }
  }

  const nodes: FillNode[] = [];
  for (const id of reached) {
    const n = byId.get(id);
    if (!n) continue;
    nodes.push({
      id: n.id,
      kind: n.type,
      title: (n as unknown as { title?: string }).title ?? n.id,
      body: bodyOf(n),
      in_document: originIds.has(id),
    });
    if (nodes.length >= MAX_NODES) break;
  }
  // Origin/in-document nodes first — they're the spine.
  nodes.sort((a, b) => Number(b.in_document) - Number(a.in_document));
  return { nodes, originIds };
}

/**
 * The page's source docs that actually belong to THIS subfolder. A wiki page is
 * scoped to one subgraph, but documents are workspace-SHARED — a doc routed only
 * to another subfolder must not have its text (or origin nodes) read into this
 * page, which is what surfaced as "the wiki has content from other subfolders".
 * Conservative: a doc with NO routing rows at all is kept (pre-routing ingests
 * have none, and dropping them would blank legitimate pages); a doc explicitly
 * routed to other subfolders but not this one is dropped. A doc the page's
 * audience can't see (pageAudience) is dropped too.
 */
async function scopedSourceDocIds(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  page: WikiPage,
): Promise<string[]> {
  const ids = page.source_doc_ids ?? [];
  if (ids.length === 0) return ids;
  const audience = pageAudience(page);
  const out: string[] = [];
  for (const docId of ids) {
    const routes = await repo.listDocumentSubgraphs(workspace_id, docId);
    if (!(routes.length === 0 || routes.some((r) => r.subgraph_id === subgraph_id))) continue;
    // Audience scope: a doc the page's readers may not open is silently skipped
    // (its text and origin nodes never reach the fill) — see pageAudience.
    if (!(await docVisibleToAudience(repo, workspace_id, docId, audience))) continue;
    out.push(docId);
  }
  return out;
}

/**
 * Load the original text of the page's source document(s) from the files dir
 * (persisted at ingest as `<filesDir>/<ws>/docs/<doc>-v<ver>.txt`). Returns the
 * concatenated text (primary document first) or null when nothing is readable —
 * which routes the page to the node-synthesis fallback.
 */
async function loadSourceText(
  repo: Repo,
  workspace_id: string,
  filesDir: string,
  page: WikiPage,
): Promise<string | null> {
  const ids = page.source_doc_ids ?? [];
  if (ids.length === 0) return null;
  const parts: string[] = [];
  const audience = pageAudience(page);
  for (const docId of ids) {
    // Defence in depth: callers pass a scoped page, but never read a source's
    // full text unless the page's audience may read that document.
    if (!(await docVisibleToAudience(repo, workspace_id, docId, audience))) continue;
    const doc = await repo.getDocument(workspace_id, docId);
    if (!doc) continue;
    try {
      const text = await readFile(join(filesDir, workspace_id, 'docs', `${docId}-v${doc.version}.txt`), 'utf8');
      if (text.trim()) parts.push(ids.length > 1 ? `# Source: ${doc.source_ref}\n\n${text}` : text);
    } catch {
      // Missing on disk (older ingest, or synced-in without the blob) — skip it.
    }
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n---\n\n').slice(0, DOC_TEXT_CHARS);
}

// ---------- shared block persistence ----------

function loadPrompt(name: string): { body: string; version: number | undefined } {
  const raw = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), 'utf8');
  const parsed = matter(raw);
  return { body: parsed.content.trim(), version: (parsed.data as { version?: number }).version };
}

/**
 * Clean, order, classify and persist the fill blocks. Shared by both paths.
 * `docSpine` = true for the document-reproduction path: there, a block with no
 * citation is a faithful reproduction (kept) rather than an ungrounded assertion
 * (dropped, as on the node path). Returns the number of blocks written.
 */
async function persistBlocks(
  repo: Repo,
  workspace_id: string,
  page: WikiPage,
  raw: OutBlock[],
  originIds: Set<string>,
  nodeIds: Set<string>,
  opts: { docSpine: boolean; orderBySection: boolean },
): Promise<number> {
  // Previously-rejected citation signatures (spec §7): a refill must not
  // re-propose a correction the user already rejected. Only citation-bearing
  // blocks carry a meaningful signature — reproduction blocks (no citation) all
  // share the empty signature and must never be suppressed by a rejection.
  const rejectedSigs = new Set(
    (await repo
      .listWikiBlocks(workspace_id, page.id))
      .filter((b) => b.review_state === 'rejected' && b.cited_node_ids.length > 0)
      .map((b) => [...b.cited_node_ids].sort().join(',')),
  );

  const cleaned = raw
    .map((b) => ({ ...b, cited_node_ids: (b.cited_node_ids ?? []).filter((id) => nodeIds.has(id)) }))
    // Keep a block if it has content AND (it's a doc-spine reproduction OR it
    // cites at least one real node). Drops empty blocks and — on the node path —
    // ungrounded ones (spec §5.5 / §10 grounding).
    .filter((b) => (b.text?.trim() || (b.items && b.items.length > 0)) && (opts.docSpine || b.cited_node_ids.length > 0))
    // Drop a citation-bearing block whose exact citation set was already rejected.
    .filter((b) => b.cited_node_ids.length === 0 || !rejectedSigs.has([...b.cited_node_ids].sort().join(',')));

  if (opts.orderBySection) {
    // Node path: order blocks by their section's order on the page; unknown last.
    const order = new Map((page.sections ?? []).map((s, i) => [s.heading, i]));
    cleaned.sort((a, b) => (order.get(a.section_key ?? '') ?? 999) - (order.get(b.section_key ?? '') ?? 999));
  }
  // Doc path: keep the model's order — it is the document's own reading order.

  const rows = cleaned.map((b, i) => {
    // Provenance. On the doc path a section is "inferred" iff a correction changed
    // it (it drew on a node outside the origin documents, or the model flagged it
    // changed). On the node path, inferred iff any cited node is non-origin.
    const drawsOnCorrection = b.cited_node_ids.some((id) => !originIds.has(id));
    const inferred = opts.docSpine ? (b.changed === true && b.cited_node_ids.length > 0) || drawsOnCorrection : drawsOnCorrection;
    return {
      sort_order: i,
      type: b.type,
      content: { section_key: b.section_key, text: b.text, items: b.items },
      cited_node_ids: b.cited_node_ids,
      provenance: inferred ? 'inferred' : 'in_document',
      // Governance (spec §7): reproduced/in-document blocks are accepted on
      // creation; changed/added blocks (a correction from another source) are
      // PENDING — highlighted and awaiting the user's accept/reject.
      review_state: inferred ? 'pending' : 'accepted',
    };
  });

  return await repo.replaceWikiBlocks(workspace_id, page.id, rows);
}

// ---------- deterministic offline fallback ----------

/** Deterministic offline fill: one paragraph per candidate node, distributed
 *  across the page's sections, each citing that node. Enough to render a real,
 *  grounded page without a model (and to exercise provenance in tests). */
function fallbackBlocks(page: WikiPage, nodes: FillNode[]): OutBlock[] {
  const sections = page.sections ?? [];
  return nodes.slice(0, 12).map((n, i) => ({
    section_key: sections.length ? sections[i % sections.length]?.heading : undefined,
    type: 'paragraph' as const,
    text: n.body ? `${n.title}: ${n.body}` : n.title,
    cited_node_ids: [n.id],
  }));
}

// ---------- fill ----------

/** Fill one page. Returns the number of blocks written and how it ran. */
export async function fillPage(
  repo: Repo,
  workspace_id: string,
  subgraph_id: string,
  page: WikiPage,
  opts: { caller?: string; filesDir?: string } = {},
): Promise<{ blocks: number; via: 'document' | 'nodes' | 'fallback' | 'empty' }> {
  const caller = opts.caller ?? 'api.wiki_fill';
  // Scope the page's source docs to this subfolder before gathering nodes or
  // reading text: a doc shared into another subfolder must not leak its content
  // here (see scopedSourceDocIds). Everything downstream reads source_doc_ids.
  const scopedPage: WikiPage = { ...page, source_doc_ids: await scopedSourceDocIds(repo, workspace_id, subgraph_id, page) };
  const { nodes, originIds } = await gatherPageNodes(repo, workspace_id, subgraph_id, scopedPage);
  if (nodes.length === 0) {
    // Nothing in the current canon resolves to this page — an anchor that stopped
    // matching, a node gone private, an older/fallback plan that anchored nothing.
    // That is not a reason to blank the page: replaceWikiBlocks spares the user's
    // own edits, but GENERATED prose has no such protection, so a refresh used to
    // strip a filled article back to nothing. Keep what is there; a fill only ever
    // replaces content with content.
    const existing = (await repo.listWikiBlocks(workspace_id, page.id)).length;
    log.info('wiki.fill_skipped_empty', { workspace: workspace_id, page: page.id, kept: existing });
    return { blocks: existing, via: 'empty' };
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Document-reproduction path: a page anchored to readable source text, with an
  // LLM available. This is the primary path — reproduce the document, kept current.
  const sourceText = opts.filesDir ? await loadSourceText(repo, workspace_id, opts.filesDir, scopedPage) : null;
  if (sourceText && hasStructuredLLM()) {
    const { body: system, version } = loadPrompt('wiki-fill');
    const user = JSON.stringify(
      {
        page: { title: page.title, sections: page.sections ?? [] },
        document: sourceText,
        nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, in_document: n.in_document })),
      },
      null,
      2,
    );
    let res;
    try {
      res = await structuredCall({
        model: REPRO_MODEL,
        system,
        user: `<input>\n${user}\n</input>`,
        toolName: 'emit_wiki_fill',
        toolDescription: 'Reproduce the document section by section, folding in the corrections.',
        schema: WIKI_FILL_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 8192,
        task: 'wiki_fill',
        preferAnthropic: true,
      });
    } catch (err) {
      // A thrown LLM error must not 500 the fill — fall through to the
      // node-synthesis / deterministic path below.
      log.warn('wiki_fill.document_llm_failed', { workspace: workspace_id, page: page.id, msg: (err as Error).message?.slice(0, 200) });
      res = null;
    }
    if (res) {
    const ctx = getLlmContext();
    writeLlmCall({
      task: 'wiki_fill',
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
    const parsed = res.noToolUse ? null : WikiFillPayload.safeParse(res.output);
    if (parsed && parsed.success && parsed.data.blocks.length > 0) {
      const raw = parsed.data.blocks as OutBlock[];
      // Adopt the document's own section structure onto the page so the reader's
      // nav mirrors the original (task: "start with the structure of the source").
      const headings: Array<{ heading: string }> = [];
      const seen = new Set<string>();
      for (const b of raw) {
        const h = b.section_key?.trim();
        if (h && !seen.has(h)) { seen.add(h); headings.push({ heading: h }); }
      }
      if (headings.length > 0) await repo.updateWikiPage(workspace_id, page.id, { sections: headings });
      const n = await persistBlocks(repo, workspace_id, page, raw, originIds, nodeIds, {
        docSpine: true,
        orderBySection: false,
      });
      log.info('wiki.filled', { workspace: workspace_id, page: page.id, blocks: n, via: 'document' });
      return { blocks: n, via: 'document' };
    }
    // LLM produced nothing usable — fall through to the node/fallback path below.
    }
  }

  // Node-synthesis path (thematic/entity pages with no source document) or the
  // deterministic fallback when no LLM is wired.
  let raw: OutBlock[];
  let via: 'nodes' | 'fallback';
  if (hasStructuredLLM()) {
    const { body: system, version } = loadPrompt('wiki-fill-nodes');
    const user = JSON.stringify(
      {
        page: { title: page.title, sections: page.sections ?? [] },
        nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, in_document: n.in_document })),
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
        toolDescription: 'Emit cited prose blocks for the page sections.',
        schema: WIKI_FILL_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 3072,
        task: 'wiki_fill',
        preferAnthropic: true,
      });
    } catch (err) {
      // Thrown LLM error → deterministic fallback instead of a 500.
      log.warn('wiki_fill.nodes_llm_failed', { workspace: workspace_id, page: page.id, msg: (err as Error).message?.slice(0, 200) });
      res = null;
    }
    if (res) {
      const ctx = getLlmContext();
      writeLlmCall({
        task: 'wiki_fill',
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
      const parsed = res.noToolUse ? null : WikiFillPayload.safeParse(res.output);
      if (parsed && parsed.success) {
        raw = parsed.data.blocks as OutBlock[];
        via = 'nodes';
      } else {
        raw = fallbackBlocks(page, nodes);
        via = 'fallback';
      }
    } else {
      raw = fallbackBlocks(page, nodes);
      via = 'fallback';
    }
  } else {
    raw = fallbackBlocks(page, nodes);
    via = 'fallback';
  }

  const n = await persistBlocks(repo, workspace_id, page, raw, originIds, nodeIds, {
    docSpine: false,
    orderBySection: true,
  });
  log.info('wiki.filled', { workspace: workspace_id, page: page.id, blocks: n, via });
  return { blocks: n, via };
}
