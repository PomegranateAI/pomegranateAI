// =============================================================================
// Gmail LIVE connector via Composio ("pull from your apps" — aggregate pull).
// Mirrors github-live.ts's PR-mode architecture: fetch many items, optionally
// filter them down, aggregate the matched items into ONE document. Replaces
// the original IMAP app-password connector (2026-07-07/08) now that Gmail
// joins the same Composio-managed OAuth family as every other connector
// (github-live.ts / notion-live.ts / slack-live.ts / ...).
//
// Auth: identical shape to notion-live.ts / github-live.ts — Composio
// custodies the real Google OAuth token; we only ever hold a
// connected_account_id reference in the already-generic
// user_composio_connections table (toolkit = 'gmail').
//   1. ensureGmailAuthConfig(repo)      — get-or-create the ONE
//      Composio-managed auth config for the 'gmail' toolkit
//      (composio_auth_configs), shared by every user.
//   2. startGmailConnect(repo, userId, callbackUrl) — composio
//      .connectedAccounts.link(...) returns a redirect to Google's real
//      OAuth consent screen.
//   3. refreshGmailConnectionStatus(connectedAccountId) — live status check
//      against Composio (never trust the redirect completing as proof).
//   4. disconnectGmail(connectedAccountId) — revokes at Composio and drops
//      our local row.
// Verified live 2026-07-29 (composio.toolkits.getToolkitBySlug('gmail')): the
// 'gmail' toolkit supports composioManagedAuthSchemes: ['OAUTH2'], so
// `.link()` (Composio-managed OAuth) applies exactly like github-live.ts /
// notion-live.ts — no per-integration API key needed from us.
//
// Fetch, aggregate shape (unchanged from the IMAP version):
//   1. planGmailPull(request)  — one structured LLM call turns the user's
//      natural-language request into {count (default 20, cap 200), filter,
//      audience, title}.
//   2. fetchRecentGmail(count, userId, connectedAccountId) — pull the newest
//      N INBOX emails via Composio's GMAIL_FETCH_EMAILS tool.
//   3. filterGmailItems(...)   — when the request carries selection criteria,
//      match each email with synth.evaluateRules, the SAME conservative
//      matcher the Rules engine uses. FAIL-CLOSED: if the matcher is
//      unavailable or errors, the run aborts — "share John's emails with the
//      team" must never degrade into "share every email with the team".
//   4. The route aggregates the matched emails into ONE document and makes
//      ONE runTextIngest call (one source per run), threading the planned
//      audience so auto-integrated nodes land at the right visibility tier.
//
// Tool discovery performed live against a real Composio account
// (COMPOSIO_API_KEY set, no connected Gmail account — metadata lookups only,
// no tools.execute()) on 2026-07-29:
//
//   composio.tools.get('default', { toolkits: ['gmail'], limit: 100 }) listed
//   63 tool slugs. GMAIL_FETCH_EMAILS is the one that matches this
//   connector's shape — its own description/schema state (read verbatim from
//   the tool definition, not guessed):
//     - "Results are NOT sorted by recency; sort by internalDate client-side."
//       => fetchRecentGmail below sorts the returned batch itself; the API
//       call must never be assumed to hand back newest-first.
//     - "The messages field may be absent or empty (valid no-results state);
//       always null-check before accessing messageId or threadId."
//     - Params (confirmed from the tool's input schema): query (Gmail search
//       syntax, unused here — we filter client-side via the Rules matcher,
//       same as before), user_id (default 'me'), verbose (default true;
//       false trades body content for speed), ids_only, label_ids (system
//       IDs like 'INBOX' confirmed), page_token, max_results (1-500),
//       include_payload (default true; body/attachments require verbose=true
//       even when this is true), include_spam_trash.
//
//   NOT VERIFIED — TODO before this ships live: `tools.get()` only exposes
//   each tool's INPUT schema, never its response shape, and no connected
//   Gmail account exists yet to actually call tools.execute() and observe a
//   real response. The extractors below are grounded in the Gmail API v1's
//   public message resource shape (developers.google.com/gmail/api: a
//   message has id, threadId, labelIds, snippet, internalDate,
//   payload.headers[] ({name, value}), payload.body.data /
//   payload.parts[].body.data as base64url) PLUS the precedent notion-live.ts
//   / github-live.ts already established that Composio sometimes wraps the
//   raw provider payload under an extra key rather than passing it through
//   verbatim — so each extractor below tries several plausible keys
//   defensively and is covered by test hooks in every real code path. The
//   FIRST live run against a real connected Gmail account must confirm which
//   shape actually comes back, then this comment + the extractors should be
//   simplified to the one true shape.
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import { getProvider } from '../../lib/synthesis.js';
import type { Repo } from '../db/repo.js';

export type GmailPullPlan = {
  /** How many recent inbox emails to download (1..200; 20 unless the request says otherwise). */
  count: number;
  /** Selection criteria to apply per email (Rules-style free text), or null for "all of them". */
  filter: string | null;
  /** Audience for nodes auto-integrated from this pull. Personal inbox content defaults to 'private'. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type GmailLiveItem = {
  /** Gmail message id (stable). */
  id: string;
  title: string;
  meta: string;
  snippet: string;
  /** Rendered From/Date/Subject + plain-text body; concatenated into the run's single source. */
  body: string;
};

export class GmailAgentUnavailable extends Error {
  constructor() {
    super('gmail pull needs an LLM to plan the request and none is available');
  }
}
export class GmailFilterUnavailable extends Error {
  constructor(cause?: string) {
    super(`the request carries a filter but rule evaluation is unavailable${cause ? `: ${cause}` : ''} — refusing to ingest unfiltered`);
  }
}
export class GmailNotConnected extends Error {
  constructor() {
    super('gmail is not connected for this user');
  }
}

const DEFAULT_COUNT = 20;
const MAX_COUNT = 200;
/** Per-email body cap inside the aggregate — newsletters routinely carry 100KB+ of boilerplate. */
const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const FILTER_CONCURRENCY = 4;
const TOOLKIT = 'gmail';
const FETCH_EMAILS_TOOL = 'GMAIL_FETCH_EMAILS';

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// notion-live.ts's __setNotionLiveTestHooks convention.

type GmailTestHooks = {
  fetcher?: (count: number, userId: string, connectedAccountId: string) => Promise<GmailLiveItem[]>;
  planner?: (query: string) => Promise<GmailPullPlan>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
};
let testHooks: GmailTestHooks | null = null;
export function __setGmailLiveTestHooks(hooks: GmailTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function gmailLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the gmail toolkit. */
export async function ensureGmailAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/** Start a Gmail connection: mints a Composio Connect link the caller redirects the browser to. */
export async function startGmailConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureGmailAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureGmailAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshGmailConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectGmail(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  count: z.number().int().min(1).max(MAX_COUNT),
  filter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_COUNT,
      description: `How many of the most recent inbox emails to download. Use ${DEFAULT_COUNT} unless the request names a number or a range that implies one. Never exceed ${MAX_COUNT}.`,
    },
    filter: {
      type: ['string', 'null'],
      description:
        'Selection criteria to apply to each downloaded email, phrased as standalone rule criteria (e.g. "emails from John Zelta", "emails about the Northwind pilot"). null when the request wants every downloaded email.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description:
        "Visibility for what this pull adds to the graph. 'team' ONLY when the request explicitly asks to share with / make visible to the team. 'only_me' when it asks to hide the content even from AI agents. Otherwise 'private' — inbox content is personal by default.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Emails from John Zelta".',
    },
  },
  required: ['count', 'filter', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling emails from the user\'s Gmail inbox into a fetch plan.',
  'Emit exactly one plan_gmail_pull call. Be literal: extract only what the request states;',
  'do not invent filters or counts the user did not ask for.',
].join(' ');

export async function planGmailPull(query: string): Promise<GmailPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new GmailAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_gmail_pull',
    toolDescription: 'Emit the fetch plan for this Gmail pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'gmail-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new GmailAgentUnavailable();
  return parsed.data;
}

// ---------- 2. fetch ----------

type GmailRawObject = Record<string, unknown>;

function asRecord(v: unknown): GmailRawObject {
  return v && typeof v === 'object' ? (v as GmailRawObject) : {};
}

/** TODO (see tool-verification comment above): unverified against a live response — tries every plausible key before giving up. */
function extractMessages(data: unknown): GmailRawObject[] {
  if (Array.isArray(data)) return data as GmailRawObject[];
  const d = asRecord(data);
  for (const key of ['messages', 'data', 'items']) {
    if (Array.isArray(d[key])) return d[key] as GmailRawObject[];
  }
  return [];
}

/** Gmail message headers are an array of {name, value} — case-insensitive lookup per the public API shape. */
function header(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  for (const h of headers) {
    const r = asRecord(h);
    if (typeof r.name === 'string' && r.name.toLowerCase() === name.toLowerCase()) {
      return typeof r.value === 'string' ? r.value : '';
    }
  }
  return '';
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Walks payload.parts (MIME tree) for the first text/plain part, falling back to text/html, falling back to the top-level body. */
function extractBody(payload: GmailRawObject): string {
  const direct = asRecord(payload.body).data;
  const parts = Array.isArray(payload.parts) ? (payload.parts as GmailRawObject[]) : [];
  if (parts.length === 0 && typeof direct === 'string') return decodeBase64Url(direct);

  let htmlFallback = '';
  for (const part of parts) {
    const mimeType = String(part.mimeType ?? '');
    const partData = asRecord(part.body).data;
    if (typeof partData !== 'string') continue;
    if (mimeType === 'text/plain') return decodeBase64Url(partData);
    if (mimeType === 'text/html' && !htmlFallback) htmlFallback = decodeBase64Url(partData);
  }
  if (htmlFallback) return htmlFallback.replace(/<[^>]+>/g, ' ');
  return typeof direct === 'string' ? decodeBase64Url(direct) : '';
}

function toGmailItem(raw: GmailRawObject): GmailLiveItem {
  const payload = asRecord(raw.payload);
  const headers = payload.headers;
  const from = header(headers, 'From') || '(unknown sender)';
  const subject = header(headers, 'Subject') || '(no subject)';
  const internalDate = Number(raw.internalDate ?? 0);
  const date = internalDate ? new Date(internalDate).toISOString().slice(0, 10) : '';
  let text = extractBody(payload).trim() || String(raw.snippet ?? '').trim();
  if (text.length > BODY_CHAR_CAP) text = `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]`;
  return {
    id: String(raw.id ?? ''),
    title: subject,
    meta: [from, date].filter(Boolean).join(' · '),
    snippet: text.replace(/\s+/g, ' ').slice(0, 140),
    body: [`From: ${from}`, `Date: ${date}`, `Subject: ${subject}`, '', text].join('\n'),
  };
}

export async function fetchRecentGmail(count: number, userId: string, connectedAccountId: string): Promise<GmailLiveItem[]> {
  const n = Math.max(1, Math.min(MAX_COUNT, count));
  if (testHooks?.fetcher) return testHooks.fetcher(n, userId, connectedAccountId);

  const composio = getComposioClient();
  const result = await composio.tools.execute(FETCH_EMAILS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { label_ids: ['INBOX'], max_results: n, verbose: true, include_payload: true },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`gmail tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const raw = extractMessages(result.data);
  // GMAIL_FETCH_EMAILS's own description: "Results are NOT sorted by
  // recency; sort by internalDate client-side" — never assume API order.
  const sorted = [...raw].sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
  return sorted.slice(0, n).map(toGmailItem);
}

// ---------- 3. filter (same matcher as the Rules engine, fail-closed) ----------

export async function filterGmailItems(items: GmailLiveItem[], filter: string): Promise<GmailLiveItem[]> {
  const synth = getProvider();
  if (!synth.evaluateRules) throw new GmailFilterUnavailable('provider has no rule matcher');
  const evaluateRules = synth.evaluateRules.bind(synth);

  const matched = new Array<boolean>(items.length).fill(false);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      const item = items[i]!;
      const res = await evaluateRules({
        rules: [{ id: 'filter', action: 'surface', instructions: filter }],
        document: { summary: item.meta, source_ref: item.title, source_kind: 'doc' },
        items: [{ id: item.id, flag: 'green', summary: item.body.slice(0, 700) }],
      });
      matched[i] = res.applicable.includes('filter');
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(FILTER_CONCURRENCY, items.length) }, worker));
  } catch (err) {
    throw new GmailFilterUnavailable(err instanceof Error ? err.message : String(err));
  }
  return items.filter((_, i) => matched[i]);
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: GmailPullPlan; items: GmailLiveItem[]; expires: number };
const previewCache = new Map<string, CachedPreview>(); // one in-flight preview per workspace+user key

export function cacheGmailPreview(ws: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(ws, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getGmailPreview(ws: string, query: string): CachedPreview | null {
  const hit = previewCache.get(ws);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 4. aggregate document ----------

/** No '#' anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderGmailAggregate(opts: { query: string; plan: GmailPullPlan; items: GmailLiveItem[] }): string {
  const { query, plan, items } = opts;
  const head = [
    `Gmail pull — ${plan.title}`,
    `Request: ${query}`,
    plan.filter ? `Filter applied: ${plan.filter}` : 'Filter: none (all downloaded emails included)',
    `Emails included: ${items.length}`,
  ].join('\n');
  const sections = items.map((item, i) => `=== Email ${i + 1} of ${items.length} ===\n${item.body}`);
  return [head, ...sections].join('\n\n');
}

export function gmailRunRef(plan: GmailPullPlan): string {
  return `gmail: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
