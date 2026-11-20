// =============================================================================
// GitHub LIVE connector via Composio (PROTOTYPE — prototype/composio-github)
//
// This is the Composio-backed sibling of gmail-live.ts, built to test the
// architecture question raised for "From your apps": what changes if OAuth
// connectors are built on Composio (github.com/ComposioHQ/composio) instead
// of hand-rolled per app (as Gmail's IMAP connector is)?
//
// Auth: Composio custodies the actual GitHub OAuth token; we only ever hold a
// `connected_account_id` reference (user_composio_connections). Flow:
//   1. ensureGithubAuthConfig() — get-or-create ONE Composio-managed auth
//      config for the 'github' toolkit (composio_auth_configs), shared by
//      every user. Composio owns the OAuth app registration, not us.
//   2. startGithubConnect(userId, callbackUrl) — composio.connectedAccounts
//      .link(...) returns a redirect URL to GitHub's real OAuth consent
//      screen; the caller (routes.ts) stores the pending connection row and
//      sends the user there.
//   3. refreshGithubConnection(userId) — live status check against Composio
//      (never trust the redirect completing as proof; always re-verify).
//   4. disconnectGithub(...) — revokes the connection at Composio AND drops
//      our local row.
//
// Fetch, mirroring Gmail's plan → fetch → filter → aggregate shape:
//   1. planGithubPull(query) — one structured LLM call turns free text into
//      {repo (owner/name — required, GitHub has no single inbox), count,
//      filter, audience, title}.
//   2. fetchRecentGithubPRs(...) — composio.tools.execute() against the
//      user's connected account. The exact tool slug is discovered at
//      runtime via composio.tools.get({toolkits:['github'], search: ...})
//      rather than hardcoded, since toolkit tool slugs are Composio-defined
//      and this prototype was written without a live API key to confirm one.
//   3. filterGithubItems(...) — same conservative Rules-matcher pattern as
//      Gmail, fail-closed.
//   4. The route aggregates matched PRs into ONE document, ONE runTextIngest
//      call per run — identical shape to Gmail's pull.
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getProvider } from '../../lib/synthesis.js';
import { getComposioClient } from '../../lib/composio.js';
import type { Repo } from '../db/repo.js';

export type GithubPullPlan = {
  /** "owner/repo" — required; GitHub has no single inbox to default to. */
  repo: string;
  /** How many recent PRs to fetch (1..100; 20 unless the request says otherwise). */
  count: number;
  /** Selection criteria to apply per PR (Rules-style free text), or null for "all of them". */
  filter: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type GithubLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

/** A repo the connected account can see — lets the UI offer a picker instead of asking the user to type "owner/name" freehand. */
export type GithubRepoOption = {
  full_name: string; // "owner/name"
  private: boolean;
};

/** A branch the picker can offer once a repo is chosen. */
export type GithubBranchOption = {
  name: string;
  protected: boolean;
};

export type GithubFilesPullPlan = {
  /** "owner/repo" — required. */
  repo: string;
  /** null = the repo's default branch. */
  branch: string | null;
  /** '' = repo root. */
  path: string;
  /** A topic to select files by (e.g. "files about auth"), or null for "every file at this path". */
  filter: string | null;
  audience: 'team' | 'private' | 'only_me';
  title: string;
};

export class GithubAgentUnavailable extends Error {
  constructor() {
    super('github pull needs an LLM to plan the request and none is available');
  }
}
export class GithubRepoRequired extends Error {
  constructor() {
    super('which repo? include one like "owner/name" in your request');
  }
}
export class GithubFilterUnavailable extends Error {
  constructor(cause?: string) {
    super(`the request carries a filter but rule evaluation is unavailable${cause ? `: ${cause}` : ''} — refusing to ingest unfiltered`);
  }
}
export class GithubNotConnected extends Error {
  constructor() {
    super('github is not connected for this user');
  }
}
export class GithubUnsupportedContentType extends Error {
  constructor(path: string) {
    super(`${path} looks like a binary file — not text, skipping extraction`);
  }
}

// toItem() base64-decodes file.content as UTF-8 and hands it straight to the
// router LLM as the document's real content — there is no image/binary
// transcription anywhere in this codebase, so decoding a binary file this way
// doesn't fail loudly, it silently feeds garbled bytes-as-text to the LLM
// (same failure mode confirmed live for Drive's video pulls 2026-07-30: a
// confidently-worded fabricated summary of content the system never read).
// Extension-based (not mime-based, unlike Drive) because GitHub's content API
// doesn't return a mime type — just path/name — and a repo directory listing
// is expected to mix real source/text files with the occasional binary asset.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff',
  'mp4', 'mov', 'avi', 'mkv', 'webm',
  'mp3', 'wav', 'flac', 'ogg', 'm4a',
  'zip', 'gz', 'tar', 'rar', '7z', 'bz2',
  'pdf', 'docx', 'xlsx', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'db', 'sqlite', 'sqlite3',
]);

function isBinaryPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return !!ext && ext !== path.toLowerCase() && BINARY_EXTENSIONS.has(ext);
}

const DEFAULT_COUNT = 20;
const MAX_COUNT = 100;
const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const FILTER_CONCURRENCY = 4;
const TOOLKIT = 'github';

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// gmail-live.ts's __setGmailLiveTestHooks convention.

type GithubTestHooks = {
  planner?: (query: string) => Promise<GithubPullPlan>;
  fetcher?: (plan: GithubPullPlan, userId: string, connectedAccountId: string) => Promise<GithubLiveItem[]>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
  repoLister?: (userId: string, connectedAccountId: string) => Promise<GithubRepoOption[]>;
  branchLister?: (userId: string, connectedAccountId: string, repo: string) => Promise<GithubBranchOption[]>;
  filesFetcher?: (plan: GithubFilesPullPlan, userId: string, connectedAccountId: string) => Promise<GithubLiveItem[]>;
  filesPlanner?: (query: string) => Promise<GithubFilesPullPlan>;
};
let testHooks: GithubTestHooks | null = null;
export function __setGithubLiveTestHooks(hooks: GithubTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function githubLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the github toolkit. */
export async function ensureGithubAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/**
 * Start a GitHub connection: mints a Composio Connect link the caller
 * redirects the browser to. Composio-managed OAuth uses `.link()`, not the
 * deprecated `.initiate()` (retired for Composio-managed auth configs as of
 * 2026-07-03 — see ComposioHQ/composio changelog 2026/04/24).
 */
export async function startGithubConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureGithubAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureGithubAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshGithubConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectGithub(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).nullable(),
  count: z.number().int().min(1).max(MAX_COUNT),
  filter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: {
      type: ['string', 'null'],
      description: 'The repo to pull from, as "owner/name" (e.g. "your-org/your-repo"). null if the request names no repo.',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_COUNT,
      description: `How many of the most recent pull requests to download. Use ${DEFAULT_COUNT} unless the request names a number. Never exceed ${MAX_COUNT}.`,
    },
    filter: {
      type: ['string', 'null'],
      description: 'Selection criteria to apply to each PR, phrased as standalone rule criteria. null when the request wants every downloaded PR.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Recent PRs on your-org/your-repo".',
    },
  },
  required: ['repo', 'count', 'filter', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling GitHub pull requests into a fetch plan.',
  'Emit exactly one plan_github_pull call. Be literal: extract only what the request states;',
  'do not invent a repo, filter, or count the user did not mention.',
].join(' ');

export async function planGithubPull(query: string): Promise<GithubPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new GithubAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_github_pull',
    toolDescription: 'Emit the fetch plan for this GitHub pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'github-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new GithubAgentUnavailable();
  if (!parsed.data.repo) throw new GithubRepoRequired();
  return parsed.data as GithubPullPlan;
}

// ---------- 1b. plan (files mode) ----------
//
// Deliberately NOT the primary path: when the UI's repo/branch/path pickers
// were used, the plan is constructed directly from those structured
// selections (see routes.ts) — no LLM involved, no ambiguity to mis-parse.
// This planner exists only for a free-text fallback ("files under src/ on
// the release branch" typed without touching a picker). Branch names
// containing '/' (e.g. "feature/foo") are exactly the kind of thing a
// string-injected-then-re-parsed query mangles — reserving the picker path
// as primary avoids that whole class of bug, proven once already this
// session with the PR planner's repo field.
const FilesPlanShape = z.object({
  repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).nullable(),
  branch: z.string().trim().min(1).nullable(),
  path: z.string().trim().nullable(),
  filter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const FILES_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: {
      type: ['string', 'null'],
      description: 'The repo to pull from, as "owner/name". null if the request names no repo.',
    },
    branch: {
      type: ['string', 'null'],
      description: 'The branch to read from. null to use the repo\'s default branch.',
    },
    path: {
      type: ['string', 'null'],
      description: 'A file or directory path within the repo. null (or empty) for the repo root.',
    },
    filter: {
      type: ['string', 'null'],
      description: 'A topic to select files by, e.g. "files about authentication". null when the request wants every file at the path.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Files under src/ on your-org/your-repo".',
    },
  },
  required: ['repo', 'branch', 'path', 'filter', 'audience', 'title'],
} as const;

const FILES_PLAN_SYSTEM = [
  'You turn a natural-language request about pulling GitHub files into a fetch plan.',
  'Emit exactly one plan_github_files_pull call. Be literal: extract only what the request states;',
  'do not invent a repo, branch, path, or topic the user did not mention.',
].join(' ');

export async function planGithubFilesPull(query: string): Promise<GithubFilesPullPlan> {
  if (testHooks?.filesPlanner) return testHooks.filesPlanner(query);
  if (!hasStructuredLLM()) throw new GithubAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: FILES_PLAN_SYSTEM,
    user: query,
    toolName: 'plan_github_files_pull',
    toolDescription: 'Emit the fetch plan for this GitHub files pull request.',
    schema: FILES_PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'github-files-pull-plan',
  });
  const parsed = FilesPlanShape.safeParse(res.output);
  if (!parsed.success) throw new GithubAgentUnavailable();
  if (!parsed.data.repo) throw new GithubRepoRequired();
  return { ...parsed.data, repo: parsed.data.repo, path: parsed.data.path ?? '' };
}

// ---------- 2. fetch ----------

// Confirmed against a live Composio account (COMPOSIO_API_KEY) on 2026-07-27:
// runtime discovery via tools.get({search: 'list pull requests'}) matched the
// wrong tool (GITHUB_GENERATE_RELEASE_NOTES) — Composio's search isn't a
// reliable relevance rank for this phrase. The real tool, and its response
// shape (`result.data.pull_requests`, not `.items` or a bare array), were
// verified directly; hardcoding both here beats a "smart" lookup that silently
// picks the wrong tool.
const LIST_PULL_REQUESTS_TOOL = 'GITHUB_LIST_PULL_REQUESTS';
// Same verification as above: GET /user/repos, response at `result.data.repositories`.
const LIST_REPOS_TOOL = 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER';

/** Repos the connected account can see — powers a picker so users don't have to type "owner/name" from memory. */
export async function listGithubRepos(userId: string, connectedAccountId: string): Promise<GithubRepoOption[]> {
  if (testHooks?.repoLister) return testHooks.repoLister(userId, connectedAccountId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_REPOS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { per_page: 100, sort: 'updated' },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`github tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const repos = Array.isArray((result.data as { repositories?: unknown[] } | undefined)?.repositories)
    ? ((result.data as { repositories: unknown[] }).repositories as Array<Record<string, unknown>>)
    : [];
  return repos.map((r) => ({ full_name: String(r.full_name ?? ''), private: !!r.private })).filter((r) => r.full_name);
}

export async function fetchRecentGithubPRs(
  plan: GithubPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<GithubLiveItem[]> {
  if (testHooks?.fetcher) return testHooks.fetcher(plan, userId, connectedAccountId);
  const [owner, repoName] = plan.repo.split('/');
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_PULL_REQUESTS_TOOL, {
    userId,
    connectedAccountId,
    // Confirmed 2026-07-27: GitHub's list-PRs endpoint defaults to ascending
    // creation order (oldest first) when sort/direction are omitted — without
    // these, "recent PRs" silently returned the OLDEST N instead.
    arguments: { owner, repo: repoName, state: 'all', per_page: plan.count, sort: 'created', direction: 'desc' },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`github tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const prs = Array.isArray((result.data as { pull_requests?: unknown[] } | undefined)?.pull_requests)
    ? ((result.data as { pull_requests: unknown[] }).pull_requests as Array<Record<string, unknown>>)
    : [];
  return prs.slice(0, plan.count).map((pr) => {
    const number = pr.number ?? pr.id;
    const title = String(pr.title ?? `PR #${number}`);
    const author = (pr.user as { login?: string } | undefined)?.login ?? 'unknown';
    const date = String(pr.updated_at ?? pr.created_at ?? '').slice(0, 10);
    const body = String(pr.body ?? '').trim();
    const text = body.length > BODY_CHAR_CAP ? `${body.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : body;
    return {
      id: String(number),
      title,
      meta: [`@${author}`, date, String(pr.state ?? '')].filter(Boolean).join(' · '),
      snippet: text.replace(/\s+/g, ' ').slice(0, 140),
      body: [`Repo: ${plan.repo}`, `PR #${number}: ${title}`, `Author: ${author}`, `State: ${pr.state ?? ''}`, '', text].join('\n'),
    };
  });
}

// ---------- 2b. fetch (files mode) ----------
//
// Both tools below were live-verified against a real connected account on
// 2026-07-28 (owner/repo/ref/path parameter names, and the response shapes
// commented at each call) before any of this was written — same discipline
// that caught the PR-listing tool/sort bugs earlier this session.
const LIST_BRANCHES_TOOL = 'GITHUB_LIST_BRANCHES';
const GET_CONTENT_TOOL = 'GITHUB_GET_REPOSITORY_CONTENT';
/** Cap on files fetched per pull when a path resolves to a directory — each file is its own content-fetch call. */
const MAX_FILES = 20;

/** Branches the connected account can see for a repo — powers a picker so branch names (which can contain '/') are never typed freehand. */
export async function listGithubBranches(
  userId: string,
  connectedAccountId: string,
  repo: string,
): Promise<GithubBranchOption[]> {
  if (testHooks?.branchLister) return testHooks.branchLister(userId, connectedAccountId, repo);
  const [owner, repoName] = repo.split('/');
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_BRANCHES_TOOL, {
    userId,
    connectedAccountId,
    arguments: { owner, repo: repoName, per_page: 100 },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`github tool call failed: ${result.error ?? 'unknown error'}`);
  }
  // Verified shape: result.data.branches: [{ name, commit: {sha, url}, protected }].
  const branches = Array.isArray((result.data as { branches?: unknown[] } | undefined)?.branches)
    ? ((result.data as { branches: unknown[] }).branches as Array<Record<string, unknown>>)
    : [];
  return branches.map((b) => ({ name: String(b.name ?? ''), protected: !!b.protected })).filter((b) => b.name);
}

/**
 * Files at a path on a branch — one GithubLiveItem per file (each file is
 * its own document at pull time, unlike PR-pulling's aggregate-into-one-doc
 * behavior; see the Stage 1 plan notes on why these two modes differ).
 */
export async function fetchGithubFilesFromBranch(
  plan: GithubFilesPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<GithubLiveItem[]> {
  if (testHooks?.filesFetcher) return testHooks.filesFetcher(plan, userId, connectedAccountId);
  const [owner, repoName] = plan.repo.split('/');
  const composio = getComposioClient();

  async function getContent(path: string): Promise<unknown> {
    const result = await composio.tools.execute(GET_CONTENT_TOOL, {
      userId,
      connectedAccountId,
      // ref omitted -> Composio uses the repo's default branch (verified).
      arguments: { owner, repo: repoName, path, ...(plan.branch ? { ref: plan.branch } : {}) },
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) {
      throw new Error(`github tool call failed: ${result.error ?? 'unknown error'}`);
    }
    // Verified shape: a directory path -> result.data.content is an ARRAY of
    // {name, path, type: 'dir'|'file', ...}; a file path -> a single OBJECT
    // with base64 `content`, `encoding`, `size`, `name`, `path`, `sha`.
    return (result.data as { content?: unknown } | undefined)?.content;
  }

  function toItem(file: Record<string, unknown>): GithubLiveItem {
    const path = String(file.path ?? plan.path);
    const name = String(file.name ?? path);
    const encoded = String(file.content ?? '');
    const text = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const capped = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : text;
    return {
      id: path,
      title: name,
      meta: [`${plan.repo}@${plan.branch ?? 'default'}`, path].filter(Boolean).join(' · '),
      snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
      body: [`Repo: ${plan.repo}`, `Branch: ${plan.branch ?? '(default)'}`, `Path: ${path}`, '', text].join('\n'),
    };
  }

  const rootContent = await getContent(plan.path);
  if (rootContent && typeof rootContent === 'object' && !Array.isArray(rootContent)) {
    // The path pointed directly at a file — content already included, no second call needed.
    if (isBinaryPath(plan.path)) throw new GithubUnsupportedContentType(plan.path);
    return [toItem(rootContent as Record<string, unknown>)];
  }
  const entries = Array.isArray(rootContent) ? (rootContent as Array<Record<string, unknown>>) : [];
  const fileEntries = entries.filter((e) => e.type === 'file' && !isBinaryPath(String(e.path ?? ''))).slice(0, MAX_FILES);
  const items: GithubLiveItem[] = [];
  for (const entry of fileEntries) {
    const path = String(entry.path ?? '');
    const raw = await getContent(path);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue; // shouldn't happen for a file path, but stay defensive
    items.push(toItem(raw as Record<string, unknown>));
  }
  return items;
}

// ---------- 3. filter (same matcher as the Rules engine, fail-closed) ----------

export async function filterGithubItems(items: GithubLiveItem[], filter: string): Promise<GithubLiveItem[]> {
  const synth = getProvider();
  if (!synth.evaluateRules) throw new GithubFilterUnavailable('provider has no rule matcher');
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
    throw new GithubFilterUnavailable(err instanceof Error ? err.message : String(err));
  }
  return items.filter((_, i) => matched[i]);
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: GithubPullPlan; items: GithubLiveItem[]; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheGithubPreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getGithubPreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// Separate cache for files mode — distinct plan shape (repo/branch/path, no
// aggregate render), not worth unioning with the PR cache above.
type CachedFilesPreview = { query: string; plan: GithubFilesPullPlan; items: GithubLiveItem[]; expires: number };
const filesPreviewCache = new Map<string, CachedFilesPreview>();

export function cacheGithubFilesPreview(key: string, entry: Omit<CachedFilesPreview, 'expires'>): void {
  filesPreviewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getGithubFilesPreview(key: string, query: string): CachedFilesPreview | null {
  const hit = filesPreviewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 4. aggregate document ----------

/** No '#' anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderGithubAggregate(opts: { query: string; plan: GithubPullPlan; items: GithubLiveItem[] }): string {
  const { query, plan, items } = opts;
  const head = [
    `GitHub pull — ${plan.title}`,
    `Repo: ${plan.repo}`,
    `Request: ${query}`,
    plan.filter ? `Filter applied: ${plan.filter}` : 'Filter: none (all downloaded PRs included)',
    `PRs included: ${items.length}`,
  ].join('\n');
  const sections = items.map((item, i) => `=== PR ${i + 1} of ${items.length} ===\n${item.body}`);
  return [head, ...sections].join('\n\n');
}

export function githubRunRef(plan: GithubPullPlan): string {
  return `github: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
