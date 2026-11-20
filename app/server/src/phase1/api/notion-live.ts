// =============================================================================
// Notion LIVE connector via Composio ("pull from your apps" — single-document
// pull). Mirrors github-live.ts's architecture, but the shape of the pull
// differs: the user names ONE page ("the onboarding doc", "the Q3 roadmap
// page"), and if several pages match they pick the one they meant from a
// list — there is no batch-selection / topic-filter flow here (contrast
// gmail-live.ts / github-live.ts's PR mode, which aggregate many matched
// items into one document; see batch-selection.ts for that shape, unused by
// this file on purpose).
//
// Auth: identical to github-live.ts — Composio custodies the real Notion
// OAuth token; we only ever hold a connected_account_id reference in the
// already-generic user_composio_connections table (toolkit = 'notion').
//   1. ensureNotionAuthConfig(repo)      — get-or-create the ONE
//      Composio-managed auth config for the 'notion' toolkit
//      (composio_auth_configs), shared by every user.
//   2. startNotionConnect(repo, userId, callbackUrl) — composio
//      .connectedAccounts.link(...) returns a redirect to Notion's real
//      OAuth consent screen.
//   3. refreshNotionConnectionStatus(connectedAccountId) — live status
//      check against Composio (never trust the redirect completing as
//      proof).
//   4. disconnectNotion(connectedAccountId) — revokes at Composio and drops
//      our local row.
//
// Fetch, single-document shape:
//   1. planNotionPull(query) — one structured LLM call turns free text like
//      "the onboarding doc" or "the Q3 roadmap page" into {query (search
//      text, required), database (optional scoping hint), audience, title}.
//   2. fetchNotionPages(plan, userId, connectedAccountId) — searches Notion
//      via Composio and returns LIGHTWEIGHT picker items (id/title/meta/
//      snippet, no body) so the caller can show a "which one did you mean?"
//      list when more than one page matches. Deliberately does NOT fetch
//      full content for every match — see the tool-verification comment
//      block above searchNotionPages for why.
//   3. fetchNotionPageContent(pageId, userId, connectedAccountId) — once the
//      user (or an unambiguous single match) has picked ONE page, fetches
//      its full content and flattens it to ONE {id, title, meta, snippet,
//      body} item — the same wire shape as GithubLiveItem, so the generic
//      per-item pull path (routes.ts's `ingestForAppsPull`, see the "files
//      mode" per-item loop in github-live.ts's caller) needs no changes.
//
// No aggregate/renderNotionAggregate function exists here on purpose: each
// pulled page becomes its own document, exactly like github-live.ts's
// "files mode" (fetchGithubFilesFromBranch), not its PR-mode aggregate.
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import type { Repo } from '../db/repo.js';

export type NotionPullPlan = {
  /** Free-text search for the page's title/topic (e.g. "onboarding", "Q3 roadmap"). Required — Notion has no single inbox to default to. */
  query: string;
  /** A database or section name to narrow the search to, or null to search the whole workspace. Best-effort (see searchNotionPages). */
  database: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** A search hit, before the user has picked which one they meant — deliberately lighter than NotionLiveItem (no body: see searchNotionPages). */
export type NotionPageMatch = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
};

/** Same wire shape as GithubLiveItem — the shape the existing generic preview/pull UI expects. */
export type NotionLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

export class NotionAgentUnavailable extends Error {
  constructor() {
    super('notion pull needs an LLM to plan the request and none is available');
  }
}
export class NotionQueryRequired extends Error {
  constructor() {
    super('which page? name it or a topic, e.g. "the onboarding doc" or "the Q3 roadmap page"');
  }
}
export class NotionNotConnected extends Error {
  constructor() {
    super('notion is not connected for this user');
  }
}

const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'notion';
const DEFAULT_PAGE_SIZE = 25;

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// github-live.ts's __setGithubLiveTestHooks convention.

type NotionTestHooks = {
  planner?: (query: string) => Promise<NotionPullPlan>;
  searcher?: (plan: NotionPullPlan, userId: string, connectedAccountId: string) => Promise<NotionPageMatch[]>;
  contentFetcher?: (pageId: string, userId: string, connectedAccountId: string) => Promise<NotionLiveItem>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
};
let testHooks: NotionTestHooks | null = null;
export function __setNotionLiveTestHooks(hooks: NotionTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function notionLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the notion toolkit. */
export async function ensureNotionAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/**
 * Start a Notion connection: mints a Composio Connect link the caller
 * redirects the browser to. Verified live 2026-07-29 (composio.toolkits
 * .getToolkitBySlug('notion')): the 'notion' toolkit supports
 * composioManagedAuthSchemes: ['OAUTH2'], so `.link()` (Composio-managed
 * OAuth) applies exactly like github-live.ts — no per-integration API key
 * needed from us (Notion also offers a user-supplied-API-key auth scheme,
 * but we deliberately use the Composio-managed OAuth one, same as GitHub).
 */
export async function startNotionConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureNotionAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureNotionAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshNotionConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
  if (testHooks?.statusChecker) return testHooks.statusChecker(connectedAccountId);
  const composio = getComposioClient();
  const accounts = await composio.connectedAccounts.list({ toolkitSlugs: [TOOLKIT] });
  const match = accounts.items.find((a) => a.id === connectedAccountId);
  if (!match) return 'failed';
  const status = String(match.status).toUpperCase();
  if (status === 'ACTIVE') return 'active';
  if (status === 'FAILED' || status === 'EXPIRED' || status === 'REVOKED') return 'failed';
  return 'initiated';
}

export async function disconnectNotion(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  query: z.string().trim().min(1).nullable(),
  database: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: ['string', 'null'],
      description: 'The title or topic of the ONE Notion page the request names (e.g. "onboarding", "Q3 roadmap"). null if the request names no page.',
    },
    database: {
      type: ['string', 'null'],
      description: 'A Notion database or section name to narrow the search to, if the request mentions one (e.g. "in the Product Wiki"). null otherwise.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Onboarding doc (Notion)".',
    },
  },
  required: ['query', 'database', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling a SINGLE Notion page or document into a search plan.',
  'Emit exactly one plan_notion_pull call. Be literal: extract only the page/topic, database, and audience the request',
  'actually states; do not invent one the user did not mention. This is a single-document pull, not a bulk export —',
  'never infer a request for "all pages" or "everything in a database".',
].join(' ');

export async function planNotionPull(query: string): Promise<NotionPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new NotionAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_notion_pull',
    toolDescription: 'Emit the search plan for this Notion pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'notion-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new NotionAgentUnavailable();
  if (!parsed.data.query) throw new NotionQueryRequired();
  return parsed.data as NotionPullPlan;
}

// ---------- 2. search ----------
//
// Tool discovery performed live against a real Composio account
// (COMPOSIO_API_KEY set, no connected Notion account — metadata lookups
// only, no tools.execute()) on 2026-07-29:
//
//   composio.toolkits.getToolkitBySlug('notion') -> confirmed the toolkit
//   slug is exactly 'notion' (not 'notionhq' or similar), 45-48 tools,
//   composioManagedAuthSchemes: ['OAUTH2'] (so startNotionConnect's `.link()`
//   Composio-managed flow applies unchanged from github-live.ts).
//
//   composio.tools.get('default', { toolkits: ['notion'], limit: 100 })
//   listed all 48 tool slugs. I read every name/description before picking
//   these three (did NOT rely on `search:` fuzzy matching alone — this
//   session already got burned twice trusting that for GitHub):
//     - NOTION_SEARCH_NOTION_PAGE: "Searches Notion pages and databases by
//       title." Params (confirmed from the tool's input schema): query,
//       filter_value ('page'|'database', default 'page'), page_size (1-100,
//       default 25), timestamp ('last_edited_time'), direction
//       ('ascending'|'descending'), start_cursor, filter_properties.
//     - NOTION_RETRIEVE_PAGE: "Retrieve a Notion page's properties/metadata
//       (not block content) by page_id." Params: page_id only.
//     - NOTION_GET_PAGE_MARKDOWN: "Retrieve a Notion page's full content
//       rendered as Notion-flavored Markdown in a single API call. Use when
//       you need the readable content of a page without recursive
//       block-children fetching." Params: page_id, include_transcript
//       (bool, default false).
//
//   CONFIRMED FLATTENED, NOT RAW BLOCKS: NOTION_GET_PAGE_MARKDOWN's own
//   description states it avoids "recursive block-children fetching" and
//   returns ready-to-read markdown directly — this is the tool to use
//   instead of walking NOTION_FETCH_BLOCK_CONTENTS / block children
//   ourselves. No manual block-flattening logic is needed in this file.
//
//   NOT VERIFIED — TODO before this ships live: `tools.get()` only exposes
//   each tool's INPUT schema (OpenAI function-calling format), never its
//   response shape, and no connected Notion account exists yet to actually
//   call tools.execute() and observe a real response. So the exact JSON
//   paths below (extractSearchResults / extractPageObject / extractMarkdown)
//   are an informed guess grounded in Notion's public API v1 shapes
//   (developers.notion.com: /search -> {results: [...]}, /pages/{id} ->
//   {properties: {..title-type prop..}, last_edited_time, last_edited_by,
//   url, ...}) PLUS the precedent github-live.ts already established that
//   Composio sometimes RENAMES the raw provider field into a wrapper key
//   (GitHub's bare-array PR list became `result.data.pull_requests`) rather
//   than passing it through verbatim — so a single hardcoded path is not
//   safe to assume here the way it was for GitHub's already-verified calls.
//   Each extractor below therefore tries several plausible keys defensively
//   and is covered by test hooks in every real code path, but the FIRST live
//   run against a real connected Notion account must confirm which key
//   actually comes back, then this comment + the extractors should be
//   simplified to the one true shape (mirroring how github-live.ts's
//   LIST_PULL_REQUESTS_TOOL comment reads once VERIFIED, not guessed).
const SEARCH_TOOL = 'NOTION_SEARCH_NOTION_PAGE';
const RETRIEVE_PAGE_TOOL = 'NOTION_RETRIEVE_PAGE';
const GET_MARKDOWN_TOOL = 'NOTION_GET_PAGE_MARKDOWN';

type NotionRawObject = Record<string, unknown>;

function asRecord(v: unknown): NotionRawObject {
  return v && typeof v === 'object' ? (v as NotionRawObject) : {};
}

/** TODO (see tool-verification comment above): unverified against a live response — tries every plausible key before giving up. */
function extractSearchResults(data: unknown): NotionRawObject[] {
  if (Array.isArray(data)) return data as NotionRawObject[];
  const d = asRecord(data);
  for (const key of ['results', 'pages', 'items']) {
    if (Array.isArray(d[key])) return d[key] as NotionRawObject[];
  }
  return [];
}

/** TODO (see tool-verification comment above): a single-page response may or may not be wrapped under a key. */
function extractPageObject(data: unknown): NotionRawObject {
  const d = asRecord(data);
  if (d.properties || d.object === 'page') return d;
  if (d.page && typeof d.page === 'object') return asRecord(d.page);
  return d;
}

/** TODO (see tool-verification comment above): guesses the field the flattened markdown string comes back under. */
function extractMarkdown(data: unknown): string {
  if (typeof data === 'string') return data;
  const d = asRecord(data);
  for (const key of ['markdown', 'content', 'text']) {
    if (typeof d[key] === 'string') return d[key] as string;
  }
  return '';
}

/** A Notion "title"-type rich-text property (or a database's top-level title) -> plain text. Handles both page (properties.<key>.title) and database (top-level title) shapes per Notion's documented API. */
function extractTitle(raw: NotionRawObject): string {
  const props = asRecord(raw.properties);
  for (const val of Object.values(props)) {
    const v = asRecord(val);
    if (v.type === 'title' && Array.isArray(v.title)) {
      const text = joinRichText(v.title);
      if (text) return text;
    }
  }
  if (Array.isArray(raw.title)) {
    const text = joinRichText(raw.title as unknown[]);
    if (text) return text;
  }
  if (typeof raw.title === 'string' && raw.title) return raw.title;
  return String(raw.id ?? 'Untitled');
}

function joinRichText(arr: unknown[]): string {
  return arr
    .map((t) => {
      const r = asRecord(t);
      if (typeof r.plain_text === 'string') return r.plain_text;
      const text = asRecord(r.text);
      return typeof text.content === 'string' ? text.content : '';
    })
    .join('');
}

function parentDatabaseId(raw: NotionRawObject): string | null {
  const parent = asRecord(raw.parent);
  return parent.type === 'database_id' && typeof parent.database_id === 'string' ? parent.database_id : null;
}

/** Best-effort: only present when the search response happens to embed enriched user info (unverified — see comment above); never an extra API call, to avoid an N-lookup fan-out over every search match. */
function embeddedAuthorName(userRef: unknown): string | null {
  const r = asRecord(userRef);
  if (typeof r.name === 'string' && r.name) return r.name;
  const person = asRecord(r.person);
  if (typeof person.email === 'string' && person.email) return person.email;
  return null;
}

function toPageMatch(raw: NotionRawObject): NotionPageMatch {
  const title = extractTitle(raw);
  const editedDate = String(raw.last_edited_time ?? '').slice(0, 10);
  const author = embeddedAuthorName(raw.last_edited_by);
  const meta = [editedDate && `edited ${editedDate}`, author].filter(Boolean).join(' · ');
  return {
    id: String(raw.id ?? ''),
    title,
    meta,
    // Notion's search endpoint returns no content/body — there is nothing to
    // snippet from at this stage (unlike GitHub's PR listing, which returns
    // full PR bodies inline). The real snippet only exists once
    // fetchNotionPageContent runs for the one page the user picks.
    snippet: '',
  };
}

/**
 * Search for candidate pages — the "which one did you mean?" list. Does NOT
 * fetch page content (see the tool-verification comment above
 * NOTION_GET_PAGE_MARKDOWN: that call is per-page and deliberately deferred
 * to fetchNotionPageContent, run only for the ONE page finally chosen).
 */
export async function fetchNotionPages(
  plan: NotionPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<NotionPageMatch[]> {
  if (testHooks?.searcher) return testHooks.searcher(plan, userId, connectedAccountId);
  const composio = getComposioClient();

  let scopeDatabaseId: string | null = null;
  if (plan.database) {
    // Best-effort scoping: NOTION_SEARCH_NOTION_PAGE has no "search within
    // this database" parameter (confirmed from its input schema above), so
    // resolve the named database to an id first, then filter page results
    // by parent below. If nothing resolves, we don't filter — no silent
    // wrong-scope narrowing to zero results.
    try {
      const dbResult = await composio.tools.execute(SEARCH_TOOL, {
        userId,
        connectedAccountId,
        arguments: { query: plan.database, filter_value: 'database', page_size: 5 },
        dangerouslySkipVersionCheck: true,
      });
      if (dbResult.successful) {
        const dbs = extractSearchResults(dbResult.data);
        if (dbs[0]) scopeDatabaseId = String(dbs[0].id ?? '') || null;
      }
    } catch {
      // best-effort only — fall through unscoped
    }
  }

  const result = await composio.tools.execute(SEARCH_TOOL, {
    userId,
    connectedAccountId,
    arguments: {
      query: plan.query,
      filter_value: 'page',
      page_size: DEFAULT_PAGE_SIZE,
      timestamp: 'last_edited_time',
      direction: 'descending',
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`notion tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const raw = extractSearchResults(result.data);
  const matches = raw.map(toPageMatch).map((m, i) => ({ m, raw: raw[i]! }));
  const scoped = scopeDatabaseId ? matches.filter(({ raw: r }) => parentDatabaseId(r) === scopeDatabaseId) : matches;
  return scoped.map(({ m }) => m);
}

/**
 * Full content for the ONE page the user picked, flattened to plain
 * markdown (see NOTION_GET_PAGE_MARKDOWN's verified description above —
 * already flattened, no block-tree walking needed here). Metadata (title,
 * last-edited date/author, url) comes from a parallel NOTION_RETRIEVE_PAGE
 * call, since GET_PAGE_MARKDOWN returns content only, not properties.
 */
export async function fetchNotionPageContent(
  pageId: string,
  userId: string,
  connectedAccountId: string,
): Promise<NotionLiveItem> {
  if (testHooks?.contentFetcher) return testHooks.contentFetcher(pageId, userId, connectedAccountId);
  const composio = getComposioClient();

  const [metaResult, mdResult] = await Promise.all([
    composio.tools.execute(RETRIEVE_PAGE_TOOL, {
      userId,
      connectedAccountId,
      arguments: { page_id: pageId },
      dangerouslySkipVersionCheck: true,
    }),
    composio.tools.execute(GET_MARKDOWN_TOOL, {
      userId,
      connectedAccountId,
      arguments: { page_id: pageId },
      dangerouslySkipVersionCheck: true,
    }),
  ]);
  if (!metaResult.successful) {
    throw new Error(`notion tool call failed: ${metaResult.error ?? 'unknown error'}`);
  }
  if (!mdResult.successful) {
    throw new Error(`notion tool call failed: ${mdResult.error ?? 'unknown error'}`);
  }

  const rawPage = extractPageObject(metaResult.data);
  const title = extractTitle(rawPage);
  const editedDate = String(rawPage.last_edited_time ?? '').slice(0, 10);
  const url = String(rawPage.url ?? '');

  // One extra lookup, affordable here because it runs for exactly the ONE
  // page the user chose (unlike the search step, which never resolves
  // author names to avoid an N-lookup fan-out over every match).
  let author = embeddedAuthorName(rawPage.last_edited_by);
  if (!author) {
    const editorId = asRecord(rawPage.last_edited_by).id;
    if (typeof editorId === 'string' && editorId) {
      try {
        const userResult = await composio.tools.execute('NOTION_GET_ABOUT_USER', {
          userId,
          connectedAccountId,
          arguments: { user_id: editorId },
          dangerouslySkipVersionCheck: true,
        });
        if (userResult.successful) author = embeddedAuthorName(extractPageObject(userResult.data)) ?? embeddedAuthorName(userResult.data);
      } catch {
        // best-effort only
      }
    }
  }

  const markdown = extractMarkdown(mdResult.data);
  const capped = markdown.length > BODY_CHAR_CAP ? `${markdown.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : markdown;

  return {
    id: pageId,
    title,
    meta: [editedDate && `edited ${editedDate}`, author && `by ${author}`].filter(Boolean).join(' · '),
    snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
    body: [`Notion page: ${title}`, url ? `URL: ${url}` : '', '', capped].filter(Boolean).join('\n'),
  };
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: NotionPullPlan; matches: NotionPageMatch[]; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheNotionPreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getNotionPreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

export function notionRunRef(plan: NotionPullPlan): string {
  return `notion: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
