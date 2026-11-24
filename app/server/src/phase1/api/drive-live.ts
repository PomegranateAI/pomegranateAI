// =============================================================================
// Google Drive LIVE connector via Composio (mirrors github-live.ts)
//
// Scope: a SINGLE-document pull ("the Q3 roadmap doc", "the deck alice
// shared last week") — NOT a batch/aggregate flow like GitHub's PR-pulling or
// files-from-branch modes. A free-text query becomes ONE structured LLM plan
// (a Drive search query + optional owner/date scoping), we search Drive via
// Composio, and if more than one document matches we return them as picker
// items so the user can pick the ONE they meant — the same shape as GitHub's
// repo/branch pickers, not a topic-based batch-selection step
// (src/lib/batch-selection.ts is deliberately NOT used here: that helper
// exists for "keep some subset of a batch", whereas here the user picks
// exactly one document to pull). Each picked result becomes its own document
// at pull time (the generic per-item pull path) — there is no aggregate-into-one-document mode for Drive.
//
// Auth: identical shape to github-live.ts, against the ALREADY-GENERIC shared
// tables (composio_auth_configs / user_composio_connections, both keyed by a
// `toolkit` string — no schema changes needed):
//   1. ensureDriveAuthConfig(repo) — get-or-create the ONE Composio-managed
//      auth config for the 'googledrive' toolkit.
//   2. startDriveConnect(repo, userId, callbackUrl) — composio.connectedAccounts
//      .link(...) returns a redirect URL to Google's OAuth consent screen.
//   3. refreshDriveConnectionStatus(connectedAccountId) — live status check.
//   4. disconnectDrive(connectedAccountId) — revokes at Composio + drops the
//      local row (caller's job, same as github-live.ts).
//
// Fetch:
//   1. planDrivePull(query) — one structured LLM call turns free text into a
//      Drive search plan: { searchQuery (fullText phrase), owner (email or
//      null), modifiedAfter (RFC3339 or null), audience, title }.
//   2. searchDriveFiles(...) — composio.tools.execute(GOOGLEDRIVE_FIND_FILE),
//      returns file metadata (id, name, mimeType, modifiedTime, webViewLink,
//      owners) for up to MAX_RESULTS matches — this is the picker list.
//   3. fetchDriveFileContent(...) — composio.tools.execute(GOOGLEDRIVE_DOWNLOAD_FILE)
//      (native files, and Workspace docs exported to a mime type) to get the
//      body of ONE chosen file. Called once per user-picked item (via
//      fetchDriveItems), not eagerly for every search match (unlike GitHub's
//      files-from-branch mode, which eagerly fetches every file in a capped
//      directory listing) — Drive search result sets are typically much
//      larger than a repo directory listing, so eagerly downloading every
//      match's content would be both slow and a needless rate-limit risk for
//      documents the user never intended to pull.
//
// ---------------------------------------------------------------------------
// LIVE VERIFICATION (2026-07-29, COMPOSIO_API_KEY, metadata-lookup only at
// first pass — no connected account existed yet for this toolkit, so
// composio.tools.execute() could NOT be exercised against real data; only
// composio.toolkits.get() and composio.tools.get() schema lookups were run.
// A real connected account showed up later the same day once a user actually
// connected Drive in prod, and its first live pull 502'd on exactly the
// unverified-shape TODO below — see the follow-up note after item 2.
//
// - Toolkit slug: confirmed 'googledrive' (NOT 'google_drive' or 'drive') via
//   `composio.toolkits.get({ search: 'drive' })` — the full unfiltered
//   toolkit catalog (search is fuzzy and returns ~1000 toolkits regardless of
//   the term; the catalog was scanned by eye for the toolkit named
//   "Google Drive", exactly the caution this task called for, since fuzzy
//   `search:` matching burned this session twice already on GitHub). Sibling
//   toolkits confirmed present under DIFFERENT slugs so they aren't confused
//   with this one: 'googledocs' (Google Docs), 'googlesheets' (Google Sheets).
// - Search tool: GOOGLEDRIVE_FIND_FILE — confirmed via
//   `composio.tools.get(undefined, { toolkits: ['googledrive'] })` (90 tools
//   returned, inspected by name). Its own description explicitly says
//   "DEPRECATED: Use GOOGLEDRIVE_FIND_FILE instead" on GOOGLEDRIVE_LIST_FILES,
//   so FIND_FILE (not LIST_FILES) is the current, correct tool — this is
//   exactly the "picked the deprecated/wrong tool via fuzzy search" failure
//   mode this task warned about, avoided by reading the full tool list
//   instead of trusting a single search hit.
//   Params (schema-verified): `q` (Drive API v3 query syntax, e.g.
//   `fullText contains 'roadmap'` / `name contains 'Q3'` / `'user@x.com' in
//   owners` / `modifiedTime > '2026-01-01T00:00:00'`, combinable with `and`),
//   `orderBy` (NOTE: cannot be combined with a `fullText` clause in `q` — the
//   schema explicitly says so), `pageSize`, `fields` (defaults to
//   `id, name, mimeType, size, modifiedTime, createdTime, parents,
//   webViewLink, trashed, starred` when omitted — no file body/content field
//   exists here; content always requires a separate download/export call).
//   Response shape: NOT independently confirmed by executing the tool (no
//   connected account) — inferred from the parameter schema alone, which
//   mirrors the raw Google Drive API v3 `files.list` response (`fields`
//   examples like `"files(id,name,mimeType)"` and `"nextPageToken,files(...)"`
//   strongly imply a top-level `{ files: [...], nextPageToken }` shape, same
//   as Drive's REST API). TODO: once a real connected account exists, log one
//   raw response and confirm the parse below (`result.data.files`) against
//   it; until then this is a best-effort guess, not a verified fact — the
//   parser below is defensive (tolerates a bare array or a `data.files`
//   array) specifically because of this gap.
// - Content tool: GOOGLEDRIVE_DOWNLOAD_FILE — schema-verified params: `fileId`
//   (required), `mime_type` (optional; ONLY affects Google Workspace docs —
//   Docs/Sheets/Slides — where it selects the export format; has no effect on
//   non-Workspace files, which always download in their native format;
//   defaults to PDF for Workspace files if omitted). One call suffices for
//   both cases — unlike GitHub, which needed a separate
//   GET_REPOSITORY_CONTENT call after listing because its list call already
//   returns metadata only by design; here that is *also* true (FIND_FILE
//   never returns body), so a second call is likewise required, but it is the
//   SAME tool regardless of file type — no branching between a "workspace
//   export" tool and a "raw download" tool is needed for the primary path.
//   (GOOGLEDRIVE_EXPORT_GOOGLE_WORKSPACE_FILE is a second, Workspace-only tool
//   that does the same export; DOWNLOAD_FILE was chosen because it also
//   handles the non-Workspace case, so one code path covers both — see the
//   isWorkspaceDoc/WORKSPACE_EXPORT_MIME branch in fetchDriveFileContent
//   below, which still has to happen client-side to pick the right
//   `mime_type` argument.)
//   Response shape: CONFIRMED live 2026-07-29 (real connected account,
//   real file, both native-mime and text/plain-export calls). Unlike GitHub,
//   Composio does NOT inline the bytes at all: `result.data` is
//   `{ id, name, mimeType, kind, display_url, link_label, export_applied,
//   composio_execution_message, downloaded_file_content: { mimetype, name,
//   s3url } }` — `downloaded_file_content.s3url` is a presigned R2/S3 GET URL
//   (~1hr TTL) that must be fetched separately to get the actual body; the
//   earlier "maybe base64 under `data`, by analogy with GitHub" guess was
//   wrong. extractDownloadedText() below fetches `s3url` when present and
//   falls back to the original guessed field names
//   (`data.file`/`data.content`/`data.fileContent`/bare `data` string, treated
//   as base64 if it looks like it) only if Composio ever inlines a payload on
//   some other path — not known to happen, kept defensively. Throws a
//   descriptive DriveContentUnavailable if nothing matches, rather than
//   silently returning empty/garbled content.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import { safeFetch, UnsafeUrlError, ResponseTooLargeError, type SafeFetchResult } from '../../lib/safe-fetch.js';
import type { Repo } from '../db/repo.js';

export type DrivePullPlan = {
  /** Drive search text — a name/content phrase (e.g. "Q3 roadmap"), or null if the request gives nothing to search on. */
  searchQuery: string | null;
  /** Restrict to files owned by this email, or null for no owner restriction. */
  owner: string | null;
  /** RFC3339 lower bound on modifiedTime (e.g. from "last week"), or null. */
  modifiedAfter: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type DriveLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

export class DriveAgentUnavailable extends Error {
  constructor() {
    super('drive pull needs an LLM to plan the request and none is available');
  }
}
export class DriveQueryRequired extends Error {
  constructor() {
    super('what should I search for? include something to search on, like a title or topic');
  }
}
export class DriveNotConnected extends Error {
  constructor() {
    super('google drive is not connected for this user');
  }
}
export class DriveContentUnavailable extends Error {
  constructor(fileId: string, cause?: string) {
    super(`could not extract content for drive file ${fileId}${cause ? `: ${cause}` : ''}`);
  }
}
export class DriveUnsupportedContentType extends Error {
  constructor(fileId: string, mimeType: string) {
    super(`drive file ${fileId} has an unsupported content type (${mimeType}) — not text, skipping extraction`);
  }
}

// Downloaded bytes get decoded as UTF-8 text and handed straight to the
// router LLM (routeDocument, lib/anthropic.ts) as if they were the document's
// real content. There is no video/image/archive transcription anywhere in
// this codebase, so doing that for a binary file doesn't fail loudly — it
// silently feeds garbled bytes-as-text to the LLM, which then confidently
// narrates content it never actually read (burned live 2026-07-30: an .mp4
// pull got a fabricated multi-sentence summary of its "content"). Reject
// known-binary mime types here, before extractDownloadedText ever calls
// resp.text() — better to skip the file with a clear reason than to ingest a
// hallucinated note. This is a denylist (not an allowlist of text/*) because
// legitimate text-ish Drive content shows up under non-'text/' mime types too
// (e.g. application/json).
const BINARY_MIME_PATTERNS = [
  /^video\//,
  /^image\//,
  /^audio\//,
  /^font\//,
  /^application\/zip/,
  /^application\/x-zip/,
  /^application\/x-rar/,
  /^application\/x-7z/,
  /^application\/x-tar/,
  /^application\/gzip/,
  /^application\/x-msdownload/,
  /^application\/octet-stream/,
  /^application\/pdf/, // no PDF text extraction on this path (unlike the manual-upload path's extract.ts)
  /^application\/vnd\.openxmlformats-officedocument/, // docx/xlsx/pptx — same reason
  /^application\/vnd\.ms-/, // legacy binary Office formats
];

function isBinaryMimeType(mimeType: string | undefined): boolean {
  return !!mimeType && BINARY_MIME_PATTERNS.some((re) => re.test(mimeType));
}

/** How many results the picker shows — capped well below what Drive can return, since Drive search sets tend to be large and this is a "pick the one" UI, not a browsable list. */
const MAX_RESULTS = 10;
/** Page size requested from Composio itself (kept a bit above MAX_RESULTS in case some results turn out to have no id and get filtered). */
const SEARCH_PAGE_SIZE = 25;
const BODY_CHAR_CAP = 4000;
/** Cap on the presigned-URL download, matching the 25 MiB upload limit. */
const DRIVE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DRIVE_DOWNLOAD_TIMEOUT_MS = 30_000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'googledrive';

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// github-live.ts's __setGithubLiveTestHooks convention.

export type DriveSearchResult = { items: DriveLiveItem[]; mimeTypesById: Map<string, string> };

type DriveTestHooks = {
  planner?: (query: string) => Promise<DrivePullPlan>;
  searcher?: (plan: DrivePullPlan, userId: string, connectedAccountId: string) => Promise<DriveSearchResult>;
  contentFetcher?: (fileId: string, mimeType: string | undefined, userId: string, connectedAccountId: string) => Promise<string>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
  /** Replaces safeFetch for the presigned download URL (same signature). */
  downloadFetcher?: typeof safeFetch;
};
let testHooks: DriveTestHooks | null = null;
export function __setDriveLiveTestHooks(hooks: DriveTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function driveLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the googledrive toolkit. */
export async function ensureDriveAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/**
 * Start a Google Drive connection: mints a Composio Connect link the caller
 * redirects the browser to. Same `.link()` (not the deprecated `.initiate()`)
 * convention as github-live.ts's startGithubConnect.
 */
export async function startDriveConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureDriveAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureDriveAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshDriveConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectDrive(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  searchQuery: z.string().trim().min(1).nullable(),
  owner: z.string().trim().email().nullable(),
  modifiedAfter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    searchQuery: {
      type: ['string', 'null'],
      description:
        'Words to search for in the document\'s title or content (e.g. "Q3 roadmap", "onboarding deck"). null if the request gives nothing to search on beyond an owner/date.',
    },
    owner: {
      type: ['string', 'null'],
      description: 'Email address of the document owner/sharer, if the request names one (e.g. "shared by alice" -> her email if known, otherwise null). null if no owner is named.',
    },
    modifiedAfter: {
      type: ['string', 'null'],
      description:
        'RFC3339 timestamp (e.g. "2026-07-21T00:00:00") to only consider documents modified after this time, derived from relative phrases like "last week". null if the request names no time bound.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Q3 roadmap doc".',
    },
  },
  required: ['searchQuery', 'owner', 'modifiedAfter', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling ONE Google Drive document into a search plan.',
  'Emit exactly one plan_drive_pull call. Be literal: extract only what the request states;',
  'do not invent a search phrase, owner, or date the user did not mention.',
].join(' ');

export async function planDrivePull(query: string): Promise<DrivePullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new DriveAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_drive_pull',
    toolDescription: 'Emit the search plan for this Google Drive pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'drive-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new DriveAgentUnavailable();
  if (!parsed.data.searchQuery && !parsed.data.owner) throw new DriveQueryRequired();
  return parsed.data as DrivePullPlan;
}

// ---------- 2. search + fetch ----------

// Verified 2026-07-29 against the live tool catalog (see the file-header
// comment for the full trail): GOOGLEDRIVE_FIND_FILE is the current search
// tool (GOOGLEDRIVE_LIST_FILES is explicitly marked deprecated in its own
// description, in favor of this one).
const FIND_FILE_TOOL = 'GOOGLEDRIVE_FIND_FILE';
// Verified 2026-07-29 (schema only, not executed): fileId + optional
// mime_type; works for both native files and Workspace-doc exports.
const DOWNLOAD_FILE_TOOL = 'GOOGLEDRIVE_DOWNLOAD_FILE';

const WORKSPACE_MIME_PREFIX = 'application/vnd.google-apps.';
/** Export format to request for a Google Workspace doc; native (non-Workspace) files ignore mime_type entirely. */
const WORKSPACE_EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

function buildDriveQuery(plan: DrivePullPlan): string {
  const clauses: string[] = [];
  if (plan.searchQuery) clauses.push(`fullText contains '${plan.searchQuery.replace(/'/g, "\\'")}'`);
  if (plan.owner) clauses.push(`'${plan.owner.replace(/'/g, "\\'")}' in owners`);
  if (plan.modifiedAfter) clauses.push(`modifiedTime > '${plan.modifiedAfter}'`);
  clauses.push('trashed = false');
  return clauses.join(' and ');
}

/**
 * Search Drive for documents matching the plan — this is the picker list
 * when more than one file matches (mirrors GitHub's repo/branch pickers, not
 * a topic-filtered batch). Returns metadata only; body is empty here (Drive's
 * search/list endpoints never include file content — see the file-header
 * comment) and filled in per-item by fetchDriveFileContent for whichever
 * item(s) the user actually picks. mimeTypesById rides alongside the wire
 * items (rather than as a field on DriveLiveItem) so DriveLiveItem stays
 * byte-identical to the catalog's AppSourceItem shape the generic preview/pull
 * UI already expects.
 */
export async function searchDriveFiles(
  plan: DrivePullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<DriveSearchResult> {
  if (testHooks?.searcher) return testHooks.searcher(plan, userId, connectedAccountId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(FIND_FILE_TOOL, {
    userId,
    connectedAccountId,
    arguments: {
      q: buildDriveQuery(plan),
      pageSize: SEARCH_PAGE_SIZE,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners)',
      // orderBy is deliberately omitted: the schema states it cannot be
      // combined with a fullText clause, which buildDriveQuery emits whenever
      // plan.searchQuery is set.
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`drive tool call failed: ${result.error ?? 'unknown error'}`);
  }
  // See the file-header TODO: this parse is a best-effort guess (Drive API v3
  // files.list shape), not independently confirmed against a live response.
  const data = result.data as { files?: unknown[] } | unknown[] | undefined;
  const files = Array.isArray(data) ? data : Array.isArray((data as { files?: unknown[] })?.files) ? (data as { files: unknown[] }).files : [];
  const mimeTypesById = new Map<string, string>();
  const items = (files as Array<Record<string, unknown>>)
    .slice(0, MAX_RESULTS)
    .map((f) => {
      const id = String(f.id ?? '');
      const name = String(f.name ?? '(untitled)');
      const mimeType = String(f.mimeType ?? '');
      const owners = Array.isArray(f.owners) ? (f.owners as Array<{ emailAddress?: string }>).map((o) => o.emailAddress).filter(Boolean) : [];
      const modified = String(f.modifiedTime ?? '').slice(0, 10);
      if (id) mimeTypesById.set(id, mimeType);
      return {
        id,
        title: name,
        meta: [owners[0], modified, mimeType].filter(Boolean).join(' · '),
        snippet: '', // no content available from the search call — see fetchDriveFileContent
        body: '', // filled in per-item at pull time, not eagerly for the whole result set
      };
    })
    .filter((item) => item.id);
  return { items, mimeTypesById };
}

/**
 * Fetch the body of ONE chosen Drive file. Called per user-picked item, not
 * eagerly for every search match (see the file-header comment for why).
 */
export async function fetchDriveFileContent(
  fileId: string,
  mimeType: string | undefined,
  userId: string,
  connectedAccountId: string,
): Promise<string> {
  if (testHooks?.contentFetcher) return testHooks.contentFetcher(fileId, mimeType, userId, connectedAccountId);
  const composio = getComposioClient();
  const isWorkspaceDoc = !!mimeType?.startsWith(WORKSPACE_MIME_PREFIX);
  const exportMime = isWorkspaceDoc ? (WORKSPACE_EXPORT_MIME[mimeType!] ?? 'text/plain') : undefined;
  const result = await composio.tools.execute(DOWNLOAD_FILE_TOOL, {
    userId,
    connectedAccountId,
    arguments: { fileId, ...(exportMime ? { mime_type: exportMime } : {}) },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`drive tool call failed: ${result.error ?? 'unknown error'}`);
  }
  return extractDownloadedText(fileId, result.data);
}

/**
 * Extraction of downloaded text — verified 2026-07-29 against a live
 * connected account (see the file-header note). GOOGLEDRIVE_DOWNLOAD_FILE
 * does NOT inline content: it returns
 * `downloaded_file_content: { mimetype, name, s3url }`, an R2/S3 presigned
 * URL (~1hr TTL per X-Amz-Expires) that must be fetched separately — true for
 * both native files and Workspace exports. The `file`/`content`/`fileContent`/
 * bare-`data`-string branch is kept as a fallback in case Composio inlines
 * small payloads on some other path; it was the pre-verification guess and is
 * not known to fire.
 */
async function extractDownloadedText(fileId: string, data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const downloaded = d.downloaded_file_content as { mimetype?: unknown; s3url?: unknown } | undefined;
    if (downloaded && typeof downloaded.s3url === 'string') {
      const mimeType = typeof downloaded.mimetype === 'string' ? downloaded.mimetype : undefined;
      if (isBinaryMimeType(mimeType)) throw new DriveUnsupportedContentType(fileId, mimeType!);
      // The URL comes from a third-party API response, so it goes through
      // safeFetch (SSRF guard, size cap, timeout) rather than raw fetch.
      const download = testHooks?.downloadFetcher ?? safeFetch;
      let resp: SafeFetchResult;
      try {
        resp = await download(downloaded.s3url, {
          maxBytes: DRIVE_DOWNLOAD_MAX_BYTES,
          timeoutMs: DRIVE_DOWNLOAD_TIMEOUT_MS,
          maxRedirects: 3,
        });
      } catch (err) {
        if (err instanceof UnsafeUrlError || err instanceof ResponseTooLargeError) {
          throw new DriveContentUnavailable(fileId, `download url refused: ${err.message}`);
        }
        throw err;
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new DriveContentUnavailable(fileId, `download url returned ${resp.status}`);
      }
      return resp.body.toString('utf8');
    }
    for (const key of ['file', 'content', 'fileContent', 'data']) {
      const v = d[key];
      if (typeof v === 'string' && v.length > 0) {
        // If it looks like base64 (GitHub's content tool returns base64 —
        // the closest verified precedent in this codebase), decode it;
        // otherwise assume it's already plain text.
        return looksLikeBase64(v) ? Buffer.from(v, 'base64').toString('utf8') : v;
      }
    }
  }
  throw new DriveContentUnavailable(fileId, 'unrecognized response shape — see the extractDownloadedText TODO in drive-live.ts');
}

function looksLikeBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/**
 * Fetch content for a set of already-searched items, selected by id — this is
 * the "pull" step for Drive's single-document-picker flow: unlike GitHub's
 * files-from-branch mode (which eagerly loads every file's body during
 * search), Drive loads body lazily, only for the id(s) the caller actually
 * picked.
 */
export async function fetchDriveItems(
  items: DriveLiveItem[],
  itemIds: string[],
  mimeTypesById: Map<string, string>,
  userId: string,
  connectedAccountId: string,
): Promise<DriveLiveItem[]> {
  const wanted = new Set(itemIds);
  const chosen = items.filter((i) => wanted.has(i.id));
  const out: DriveLiveItem[] = [];
  for (const item of chosen) {
    const text = await fetchDriveFileContent(item.id, mimeTypesById.get(item.id), userId, connectedAccountId);
    const capped = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : text;
    out.push({
      ...item,
      snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
      body: [`Drive file: ${item.title}`, `Id: ${item.id}`, '', capped].join('\n'),
    });
  }
  return out;
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: DrivePullPlan; items: DriveLiveItem[]; mimeTypesById: Map<string, string>; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheDrivePreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getDrivePreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 3. per-document render ----------

/** No '#' anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderDriveDocument(item: DriveLiveItem): string {
  return item.body;
}

export function driveRunRef(item: DriveLiveItem): string {
  return `drive: ${item.title} — ${new Date().toISOString().slice(0, 10)}`;
}
