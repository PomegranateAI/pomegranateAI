// =============================================================================
// Jira LIVE connector via Composio — mirrors github-live.ts's architecture
// exactly (same auth glue, same test-hook convention, same fail-loud-don't-
// guess philosophy), extended from GitHub's TWO modes to Jira's THREE:
// mode: 'project' | 'board' | 'ticket'.
//
// Auth: identical shape to GitHub — Composio custodies the Jira OAuth token;
// we only ever hold a `connected_account_id` (user_composio_connections),
// against the shared, already-generic `composio_auth_configs` /
// `user_composio_connections` tables (no schema changes needed — both are
// keyed by a `toolkit` string column already).
//   1. ensureJiraAuthConfig(repo) — get-or-create ONE Composio-managed auth
//      config for the 'jira' toolkit, shared by every user.
//   2. startJiraConnect(repo, userId, callbackUrl) — mints a Connect link to
//      Jira's real OAuth consent screen.
//   3. refreshJiraConnectionStatus(connectedAccountId) — live status check.
//   4. disconnectJira(connectedAccountId) — revokes at Composio + local row.
//
// Fetch — three independent fetchers sharing one JQL-based search primitive:
//   1. planJiraPull(query) — ONE structured LLM call turns free text into
//      {mode, project, board, ticketKeys, filter, audience, title}. Mode is
//      inferred from phrasing ("the whole POM project" -> project; "the
//      Sharing board" -> board; "POM-123" or "issues closed this sprint"
//      -> ticket). Deliberately ONE plan shape for all three modes (unlike
//      GitHub's two separate plan types) per this feature's own spec — each
//      fetcher independently validates the fields IT requires, since a
//      picker-built plan (constructed directly from structured UI selections,
//      bypassing this planner entirely — see github-live.ts's files-mode
//      comment for why that bypass matters) never runs through here at all.
//   2. fetchJiraProject / fetchJiraBoard / fetchJiraTickets — all three
//      resolve down to ONE search primitive (JIRA_SEARCH_ISSUES via JQL) plus
//      mode-specific metadata lookups (JIRA_GET_PROJECT for project mode;
//      JIRA_LIST_BOARDS + JIRA_LIST_SPRINTS for board mode). Ticket mode is
//      the one naturally-batch mode: when a topic/filter rides on top of a
//      project/board scope, it narrows the batch with the shared
//      selectRelevantItems (lib/batch-selection.ts), itemNoun: 'tickets'.
//   3. Aggregation: project and board modes render ALL matched issues into
//      ONE document (renderJiraProjectAggregate / renderJiraBoardAggregate),
//      mirroring GitHub's PR-mode aggregate. Ticket mode returns items
//      un-aggregated — each ticket becomes its own document at pull time,
//      mirroring GitHub's files-mode (see fetchJiraTickets's doc comment).
//
// Live verification (2026-07-29, COMPOSIO_API_KEY against the real Composio
// API, NO connected Jira account exists yet so NONE of this was tools.execute
// ()'d against real data — see the per-tool comments below for exactly what
// was and wasn't confirmed):
//   - Exact toolkit slug: composio.toolkits.get('jira') (a direct slug
//     lookup, NOT toolkits.get({search:'jira'}) — that search call returned
//     Gmail, Composio, GitHub, Google Calendar and NOT Jira at all. Repeats
//     this session's standing lesson: Composio's `search` ranking is not a
//     reliable way to find a toolkit OR a tool; a direct slug/name lookup is.
//   - Full tool inventory: composio.tools.get('default', {toolkits:['jira'],
//     limit:200}) returned 102 tools; every tool slug used below was picked
//     from that exact list by name+description, never by fuzzy search.
//   - Every tool's input/output JSON Schema (composio.tools.getRawComposioTools
//     ({toolkits:['jira']})) was read in full before being wired up — this is
//     a genuine schema read, not a guess, but it is NOT the same as a live
//     execute() against real data (GitHub's tool discovery had that; this
//     doesn't, because no user has connected Jira yet). Where the schema
//     shape looked surprising or inconsistent, it's called out at the call
//     site with a TODO to confirm against a live connected account.
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import { selectRelevantItems } from '../../lib/batch-selection.js';
import type { Repo } from '../db/repo.js';

// ---------- shared types ----------

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type JiraLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
  /** Raw status name (e.g. "In Progress") — carried alongside `meta` so board
   *  mode can group issues by column without re-parsing the meta string. */
  status: string;
};

export type JiraMode = 'project' | 'board' | 'ticket';

export type JiraPullPlan = {
  mode: JiraMode;
  /** Project key or name — required for project mode; also the scope for a kanban board and an optional scope for ticket search. */
  project: string | null;
  /** Board name (or numeric id as a string) — required for board mode; an optional extra scope for ticket mode. */
  board: string | null;
  /** Explicit ticket keys (e.g. ["POM-123"]) — ticket mode only. null when the request is a search/topic instead of named tickets. */
  ticketKeys: string[] | null;
  /** Selection criteria for ticket mode (Rules-style free text, e.g. "closed this sprint"), or null for "every ticket the scope matches". */
  filter: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** A project the connected account can see — powers a picker instead of asking the user to type a project key freehand. */
export type JiraProjectOption = { key: string; name: string; id: string };

/** A board the connected account can see — powers a picker once a project is chosen (or across all projects). */
export type JiraBoardOption = { id: number; name: string; type: string | null };

export type JiraProjectMeta = { key: string; name: string; description: string | null };

export type JiraBoardMeta = {
  id: number;
  name: string;
  /** 'scrum' | 'kanban' | other Jira board types; null for boards the account can only partially see (Composio's own schema note). */
  type: string | null;
  /** The active sprint, for scrum boards only. null for kanban (no sprint concept) or a scrum board with nothing active right now. */
  sprint: { id: number; name: string; goal: string | null } | null;
};

// ---------- errors ----------

export class JiraAgentUnavailable extends Error {
  constructor() {
    super('jira pull needs an LLM to plan the request and none is available');
  }
}
export class JiraProjectRequired extends Error {
  constructor() {
    super('which project? include a project name or key (e.g. "POM") in your request');
  }
}
export class JiraBoardRequired extends Error {
  constructor() {
    super('which board? include the board name in your request');
  }
}
export class JiraTicketScopeRequired extends Error {
  constructor() {
    super('ticket pulls need explicit ticket keys, or a project/board to search within — none given');
  }
}
export class JiraBoardNotFound extends Error {
  constructor(name: string) {
    super(`no board named "${name}" was found`);
  }
}
export class JiraBoardNoActiveSprint extends Error {
  constructor(name: string) {
    super(`board "${name}" is a scrum board with no active sprint right now`);
  }
}
export class JiraBoardProjectRequired extends Error {
  constructor(name: string) {
    super(`board "${name}" is not a scrum board — include a project so we know which issues count as "on the board" (see the fetchJiraBoard comment for why)`);
  }
}
export class JiraNotConnected extends Error {
  constructor() {
    super('jira is not connected for this user');
  }
}

const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'jira';
/** JIRA_SEARCH_ISSUES caps at 100 results per page (its own documented limit) — matched here rather than invented. */
const MAX_SEARCH_PAGE = 100;
/** Ticket-mode's pre-narrowing pool size, before selectRelevantItems narrows by topic. */
const TICKET_SEARCH_POOL = 100;

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// github-live.ts's __setGithubLiveTestHooks convention. Lower-level hooks
// (searcher / projectMetaFetcher / boardResolver) exist alongside the
// top-level per-mode ones so tests can exercise the REAL mode-branching and
// selectRelevantItems-narrowing logic without a full Composio client.

type JiraTestHooks = {
  planner?: (query: string) => Promise<JiraPullPlan>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
  projectLister?: (userId: string, connectedAccountId: string) => Promise<JiraProjectOption[]>;
  boardLister?: (userId: string, connectedAccountId: string, projectKeyOrId?: string) => Promise<JiraBoardOption[]>;
  // Lower-level primitives shared by all three fetchers:
  searcher?: (jql: string, maxResults: number, userId: string, connectedAccountId: string) => Promise<JiraLiveItem[]>;
  projectMetaFetcher?: (projectKeyOrName: string, userId: string, connectedAccountId: string) => Promise<JiraProjectMeta>;
  boardResolver?: (
    boardName: string,
    projectHint: string | null,
    userId: string,
    connectedAccountId: string,
  ) => Promise<{ meta: JiraBoardMeta; jql: string }>;
  /** Forwarded as selectRelevantItems's own testHook for ticket-mode narrowing. */
  ticketsSelector?: (items: JiraLiveItem[], topic: string) => Promise<JiraLiveItem[]>;
  // Top-level full-bypass hooks, one per fetcher — mirrors github-live.ts's fetcher/filesFetcher.
  projectFetcher?: (plan: JiraPullPlan, userId: string, connectedAccountId: string) => Promise<{ meta: JiraProjectMeta; issues: JiraLiveItem[] }>;
  boardFetcher?: (plan: JiraPullPlan, userId: string, connectedAccountId: string) => Promise<{ meta: JiraBoardMeta; issues: JiraLiveItem[] }>;
  ticketsFetcher?: (plan: JiraPullPlan, userId: string, connectedAccountId: string) => Promise<JiraLiveItem[]>;
};
let testHooks: JiraTestHooks | null = null;
export function __setJiraLiveTestHooks(hooks: JiraTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function jiraLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect (identical shape to github-live.ts) ----------

/** Get-or-create the ONE shared Composio-managed auth config for the jira toolkit. */
export async function ensureJiraAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/** Start a Jira connection: mints a Composio Connect link the caller redirects the browser to. */
export async function startJiraConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureJiraAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureJiraAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshJiraConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectJira(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const ModeEnum = z.enum(['project', 'board', 'ticket']);
const PlanShape = z.object({
  mode: ModeEnum,
  project: z.string().trim().min(1).nullable(),
  board: z.string().trim().min(1).nullable(),
  ticketKeys: z.array(z.string().trim().min(1)).nullable(),
  filter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['project', 'board', 'ticket'],
      description:
        '"project" for an entire project as one document (e.g. "the whole POM project"). "board" for an entire board as one document (e.g. "the Sharing board"). "ticket" for one or more specific tickets, whether named by key ("POM-123") or found by a search/topic ("issues closed this sprint in the Sharing project").',
    },
    project: {
      type: ['string', 'null'],
      description: 'The project name or key the request names (e.g. "POM" or "Sharing"). null if none is named.',
    },
    board: {
      type: ['string', 'null'],
      description: 'The board name the request names (e.g. "Sharing board"). null if none is named.',
    },
    ticketKeys: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Explicit ticket keys the request names (e.g. ["POM-123"]). null when the request describes a search/topic instead of naming tickets.',
    },
    filter: {
      type: ['string', 'null'],
      description: 'Selection criteria for ticket mode, phrased as standalone rule criteria (e.g. "closed this sprint"). null when the request wants every matching ticket, or is not ticket mode.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "POM project pull" or "Tickets closed this sprint".',
    },
  },
  required: ['mode', 'project', 'board', 'ticketKeys', 'filter', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling Jira content into a fetch plan.',
  'Emit exactly one plan_jira_pull call. Be literal: extract only what the request states;',
  'do not invent a project, board, ticket key, or filter the user did not mention.',
  'Infer mode from phrasing: pulling an entire project is "project"; an entire board is "board";',
  'one or more named/searched-for tickets is "ticket".',
].join(' ');

/** Each fetcher independently re-checks this too — a structurally-built plan (from a picker) never runs through planJiraPull at all, so validation can't live here alone. */
function requireJiraPullPlanScope(plan: JiraPullPlan): void {
  if (plan.mode === 'project' && !plan.project) throw new JiraProjectRequired();
  if (plan.mode === 'board' && !plan.board) throw new JiraBoardRequired();
  if (plan.mode === 'ticket' && !(plan.ticketKeys && plan.ticketKeys.length) && !plan.project && !plan.board && !plan.filter) {
    throw new JiraTicketScopeRequired();
  }
}

export async function planJiraPull(query: string): Promise<JiraPullPlan> {
  if (testHooks?.planner) {
    const plan = await testHooks.planner(query);
    requireJiraPullPlanScope(plan);
    return plan;
  }
  if (!hasStructuredLLM()) throw new JiraAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_jira_pull',
    toolDescription: 'Emit the fetch plan for this Jira pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'jira-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new JiraAgentUnavailable();
  requireJiraPullPlanScope(parsed.data);
  return parsed.data;
}

// ---------- JQL helpers ----------

function jqlQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// ---------- 2. search primitive (shared by all three modes) ----------

// Verified via composio.tools.getRawComposioTools({toolkits:['jira']}) on
// 2026-07-29 (schema only — NOT execute()'d, no connected account exists).
// JIRA_SEARCH_ISSUES takes raw `jql` (which "takes precedence over filters"
// per its own description) OR structured filters (project_key, sprint_id_or_
// name, status_id_or_name, ...). We always build raw JQL ourselves rather
// than the structured filters, so one code path covers project/board/ticket
// scoping uniformly. Response: result.data.issues (array of JiraIssue),
// result.data.total, .jql_used, .max_results — a SINGLE level under `data`,
// unlike JIRA_GET_ALL_PROJECTS below. Each JiraIssue already carries a
// PLAIN-TEXT/markdown `description` (Composio's own schema says "in markdown
// format") — notably NOT Atlassian Document Format (ADF), unlike
// JIRA_GET_ISSUE / JIRA_FETCH_BULK_ISSUES, whose `fields.description` IS a
// raw ADF document tree. We deliberately build every mode on top of
// JIRA_SEARCH_ISSUES instead, so nothing here needs an ADF walker.
const SEARCH_ISSUES_TOOL = 'JIRA_SEARCH_ISSUES';

type RawSearchIssue = {
  key?: string;
  summary?: string;
  description?: string;
  status?: { name?: string };
  assignee?: { display_name?: string };
  priority?: { name?: string };
  issue_type?: { name?: string };
};

function toJiraLiveItem(issue: RawSearchIssue): JiraLiveItem {
  const key = String(issue.key ?? '');
  const summary = String(issue.summary ?? key);
  const statusName = issue.status?.name ?? '';
  const assigneeName = issue.assignee?.display_name ?? 'unassigned';
  const priorityName = issue.priority?.name ?? '';
  const typeName = issue.issue_type?.name ?? '';
  const desc = String(issue.description ?? '').trim();
  const capped = desc.length > BODY_CHAR_CAP ? `${desc.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : desc;
  return {
    id: key,
    title: summary,
    meta: [typeName, statusName, `@${assigneeName}`, priorityName].filter(Boolean).join(' · '),
    status: statusName,
    snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
    body: [`Key: ${key}`, `Type: ${typeName}`, `Status: ${statusName}`, `Assignee: ${assigneeName}`, `Priority: ${priorityName}`, '', capped].join('\n'),
  };
}

async function realSearchJiraIssues(jql: string, maxResults: number, userId: string, connectedAccountId: string): Promise<JiraLiveItem[]> {
  const composio = getComposioClient();
  const result = await composio.tools.execute(SEARCH_ISSUES_TOOL, {
    userId,
    connectedAccountId,
    arguments: { jql, max_results: Math.min(maxResults, MAX_SEARCH_PAGE) },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`jira tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const issues = Array.isArray((result.data as { issues?: unknown[] } | undefined)?.issues)
    ? ((result.data as { issues: unknown[] }).issues as RawSearchIssue[])
    : [];
  return issues.slice(0, maxResults).map(toJiraLiveItem);
}

async function searchJiraIssues(jql: string, maxResults: number, userId: string, connectedAccountId: string): Promise<JiraLiveItem[]> {
  if (testHooks?.searcher) return testHooks.searcher(jql, maxResults, userId, connectedAccountId);
  return realSearchJiraIssues(jql, maxResults, userId, connectedAccountId);
}

// ---------- 2a. project metadata + picker ----------

// Verified via schema on 2026-07-29: JIRA_GET_PROJECT's response
// (result.data) is a SINGLE level under `data` — {id, key, name, self, style,
// isPrivate, properties, simplified, description, emailAddress,
// projectTypeKey, additional_properties}. `description` is a plain string
// here (NOT ADF) when `expand=description` is passed — confirmed from the
// schema's own field description ("A brief description of the project"),
// unlike JIRA_GET_ISSUE's description field.
const GET_PROJECT_TOOL = 'JIRA_GET_PROJECT';

async function realFetchJiraProjectMeta(projectKeyOrName: string, userId: string, connectedAccountId: string): Promise<JiraProjectMeta> {
  const composio = getComposioClient();
  const result = await composio.tools.execute(GET_PROJECT_TOOL, {
    userId,
    connectedAccountId,
    arguments: { project_id_or_key: projectKeyOrName, expand: 'description' },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`jira tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const data = result.data as { key?: string; name?: string; description?: string } | undefined;
  return {
    key: String(data?.key ?? projectKeyOrName),
    name: String(data?.name ?? projectKeyOrName),
    description: data?.description?.trim() || null,
  };
}

async function fetchJiraProjectMeta(projectKeyOrName: string, userId: string, connectedAccountId: string): Promise<JiraProjectMeta> {
  if (testHooks?.projectMetaFetcher) return testHooks.projectMetaFetcher(projectKeyOrName, userId, connectedAccountId);
  return realFetchJiraProjectMeta(projectKeyOrName, userId, connectedAccountId);
}

// Verified via schema on 2026-07-29: JIRA_GET_ALL_PROJECTS is the modern,
// non-deprecated project list (JIRA_LIST_ALL_PROJECTS wraps the deprecated
// GET /project and its own description says to prefer this one instead).
//
// NOT LIVE-VERIFIED — flagging explicitly per instructions: the declared JSON
// Schema nests the project list TWO levels under `data`
// (result.data.data.values) — GetAllProjectsResponse's only property is
// itself called `data`, pointing at ProjectSearchResult.values. Every OTHER
// Jira tool checked here nests exactly ONE level under `data`
// (result.data.<field>). This double-nesting was read off the schema, never
// exercised against a live connected account (none exists for this toolkit
// yet) — TODO: confirm the real payload shape once a Jira account is
// connected, and delete whichever branch below turns out to be dead. Coded
// defensively (tries the single-level shape too) rather than trusting either
// blindly.
const GET_ALL_PROJECTS_TOOL = 'JIRA_GET_ALL_PROJECTS';

async function realListJiraProjects(userId: string, connectedAccountId: string): Promise<JiraProjectOption[]> {
  const composio = getComposioClient();
  const result = await composio.tools.execute(GET_ALL_PROJECTS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { maxResults: 100 },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`jira tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const wrapper = result.data as { data?: { values?: unknown[] }; values?: unknown[] } | undefined;
  const values = Array.isArray(wrapper?.data?.values)
    ? (wrapper!.data!.values as unknown[])
    : Array.isArray(wrapper?.values)
      ? (wrapper!.values as unknown[])
      : [];
  return (values as Array<Record<string, unknown>>)
    .map((p) => ({ key: String(p.key ?? ''), name: String(p.name ?? p.key ?? ''), id: String(p.id ?? '') }))
    .filter((p) => p.key);
}

/** Projects the connected account can see — powers a picker so users don't have to type a project key freehand. */
export async function listJiraProjects(userId: string, connectedAccountId: string): Promise<JiraProjectOption[]> {
  if (testHooks?.projectLister) return testHooks.projectLister(userId, connectedAccountId);
  return realListJiraProjects(userId, connectedAccountId);
}

// ---------- 2b. board resolution (metadata + JQL scope) ----------

// Verified via schema on 2026-07-29. JIRA_LIST_BOARDS's BoardDetails is
// {id, name, self, type, isPrivate} ONLY — no location/project field and no
// filterId. JIRA_LIST_SPRINTS(board_id, state) is Scrum-only ("Kanban boards
// do not support sprints and will return no results" — its own schema note).
// Across the FULL 102-tool inventory there is no board-configuration tool and
// no "issues on this board" tool (checked by regex over every tool name/
// description, not just eyeballing) — real Jira's Agile REST API has one
// (GET .../board/{id}/issue) but Composio does not currently expose it here.
// That means: given only a board id/name, there is NO way through this
// toolkit to ask "what issues are on it" directly.
//
// So this resolves a board to a JQL scope via the closest thing Composio DOES
// expose, and is honest about the approximation:
//   - scrum board: JIRA_LIST_SPRINTS(board_id, state='active') -> `sprint = <id>`.
//     This is the standard meaning of "issues on a scrum board" (its active
//     sprint) and needs no project hint.
//   - kanban (or type unknown/private) board: no sprint concept and no
//     board->project mapping available, so a project scope MUST be supplied
//     by the caller (via the plan, itself either picker-supplied or LLM-
//     inferred from phrasing like "the Sharing board" alongside a project
//     mention). Resolves to `project = <key> AND statusCategory != "Done"` —
//     an intentional, DOCUMENTED approximation of "currently on the board"
//     (not-yet-done work in that project), not a verified board membership.
//     TODO: if Composio adds a board-configuration/board-issues tool, or a
//     live connected account confirms LIST_BOARDS returns a location/filter
//     field this schema didn't show, replace this approximation.
const LIST_BOARDS_TOOL = 'JIRA_LIST_BOARDS';
const LIST_SPRINTS_TOOL = 'JIRA_LIST_SPRINTS';

async function realResolveJiraBoardScope(
  boardName: string,
  projectHint: string | null,
  userId: string,
  connectedAccountId: string,
): Promise<{ meta: JiraBoardMeta; jql: string }> {
  const composio = getComposioClient();
  const listResult = await composio.tools.execute(LIST_BOARDS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { name: boardName, projectKeyOrId: projectHint ?? undefined, max_results: 50 },
    dangerouslySkipVersionCheck: true,
  });
  if (!listResult.successful) {
    throw new Error(`jira tool call failed: ${listResult.error ?? 'unknown error'}`);
  }
  const boards = Array.isArray((listResult.data as { values?: unknown[] } | undefined)?.values)
    ? ((listResult.data as { values: unknown[] }).values as Array<{ id: number; name?: string; type?: string }>)
    : [];
  if (!boards.length) throw new JiraBoardNotFound(boardName);
  const exact = boards.find((b) => (b.name ?? '').toLowerCase() === boardName.toLowerCase());
  const board = exact ?? boards[0]!;
  const meta: JiraBoardMeta = { id: board.id, name: board.name ?? boardName, type: board.type ?? null, sprint: null };

  if (meta.type === 'scrum') {
    const sprintResult = await composio.tools.execute(LIST_SPRINTS_TOOL, {
      userId,
      connectedAccountId,
      arguments: { board_id: meta.id, state: 'active' },
      dangerouslySkipVersionCheck: true,
    });
    if (!sprintResult.successful) {
      throw new Error(`jira tool call failed: ${sprintResult.error ?? 'unknown error'}`);
    }
    const sprints = Array.isArray((sprintResult.data as { values?: unknown[] } | undefined)?.values)
      ? ((sprintResult.data as { values: unknown[] }).values as Array<{ id: number; name?: string; goal?: string }>)
      : [];
    const active = sprints[0];
    if (!active) throw new JiraBoardNoActiveSprint(meta.name);
    meta.sprint = { id: active.id, name: active.name ?? `Sprint ${active.id}`, goal: active.goal?.trim() || null };
    return { meta, jql: `sprint = ${active.id}` };
  }

  if (!projectHint) throw new JiraBoardProjectRequired(meta.name);
  return { meta, jql: `project = ${jqlQuote(projectHint)} AND statusCategory != "Done"` };
}

async function resolveJiraBoardScope(
  boardName: string,
  projectHint: string | null,
  userId: string,
  connectedAccountId: string,
): Promise<{ meta: JiraBoardMeta; jql: string }> {
  if (testHooks?.boardResolver) return testHooks.boardResolver(boardName, projectHint, userId, connectedAccountId);
  return realResolveJiraBoardScope(boardName, projectHint, userId, connectedAccountId);
}

/** Boards the connected account can see — powers a picker; pass projectKeyOrId to scope it to a chosen project (also the only way to structurally tie a board to a project, since board objects don't carry one — see resolveJiraBoardScope's comment). */
export async function listJiraBoards(userId: string, connectedAccountId: string, projectKeyOrId?: string): Promise<JiraBoardOption[]> {
  if (testHooks?.boardLister) return testHooks.boardLister(userId, connectedAccountId, projectKeyOrId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_BOARDS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { projectKeyOrId, max_results: 100 },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`jira tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const values = Array.isArray((result.data as { values?: unknown[] } | undefined)?.values)
    ? ((result.data as { values: unknown[] }).values as Array<Record<string, unknown>>)
    : [];
  return values
    .map((b) => ({ id: Number(b.id), name: String(b.name ?? ''), type: b.type ? String(b.type) : null }))
    .filter((b) => Number.isFinite(b.id));
}

// ---------- 3. fetch: project mode ----------

/** One document per project pulled — project description (if any) + its issue list, aggregated by renderJiraProjectAggregate. */
export async function fetchJiraProject(
  plan: JiraPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<{ meta: JiraProjectMeta; issues: JiraLiveItem[] }> {
  if (testHooks?.projectFetcher) return testHooks.projectFetcher(plan, userId, connectedAccountId);
  if (!plan.project) throw new JiraProjectRequired();
  const meta = await fetchJiraProjectMeta(plan.project, userId, connectedAccountId);
  const issues = await searchJiraIssues(`project = ${jqlQuote(plan.project)} ORDER BY updated DESC`, MAX_SEARCH_PAGE, userId, connectedAccountId);
  return { meta, issues };
}

// ---------- 3b. fetch: board mode ----------

/** One document per board pulled — all issues currently on the board (see resolveJiraBoardScope for exactly what "on the board" means per board type), grouped by column/status via renderJiraBoardAggregate. */
export async function fetchJiraBoard(
  plan: JiraPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<{ meta: JiraBoardMeta; issues: JiraLiveItem[] }> {
  if (testHooks?.boardFetcher) return testHooks.boardFetcher(plan, userId, connectedAccountId);
  if (!plan.board) throw new JiraBoardRequired();
  const { meta, jql } = await resolveJiraBoardScope(plan.board, plan.project, userId, connectedAccountId);
  const issues = await searchJiraIssues(jql, MAX_SEARCH_PAGE, userId, connectedAccountId);
  return { meta, issues };
}

// ---------- 3c. fetch: ticket mode ----------

/**
 * One or more SPECIFIC tickets — the one mode that's naturally a batch.
 * Each ticket becomes its OWN document (per-item, NOT aggregated), mirroring
 * GitHub's files-mode rather than its PR-mode aggregate (see
 * fetchGithubFilesFromBranch's doc comment in github-live.ts for that
 * precedent). Two paths:
 *   - Explicit ticketKeys ("POM-123") -> `key in (...)`, no narrowing needed
 *     (the user named exactly what they want).
 *   - A project/board scope with a topic/filter ("issues closed this sprint
 *     in the Sharing project") -> search the scope broadly, then narrow with
 *     the shared selectRelevantItems (lib/batch-selection.ts), itemNoun:
 *     'tickets' — exactly as instructed, since fuzzy phrases like "closed
 *     this sprint" aren't reliable raw JQL to construct ourselves.
 */
export async function fetchJiraTickets(plan: JiraPullPlan, userId: string, connectedAccountId: string): Promise<JiraLiveItem[]> {
  if (testHooks?.ticketsFetcher) return testHooks.ticketsFetcher(plan, userId, connectedAccountId);

  if (plan.ticketKeys && plan.ticketKeys.length) {
    const jql = `key in (${plan.ticketKeys.map(jqlQuote).join(', ')})`;
    return searchJiraIssues(jql, plan.ticketKeys.length, userId, connectedAccountId);
  }

  const clauses: string[] = [];
  if (plan.project) clauses.push(`project = ${jqlQuote(plan.project)}`);
  if (plan.board) {
    const { jql: boardJql } = await resolveJiraBoardScope(plan.board, plan.project, userId, connectedAccountId);
    clauses.push(`(${boardJql})`);
  }
  if (!clauses.length) throw new JiraTicketScopeRequired();
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  const pool = await searchJiraIssues(jql, TICKET_SEARCH_POOL, userId, connectedAccountId);
  if (!plan.filter) return pool;
  return selectRelevantItems(pool, plan.filter, { itemNoun: 'tickets', testHook: testHooks?.ticketsSelector });
}

// ---------- preview → pull handoff ----------

type CachedProjectPreview = { query: string; plan: JiraPullPlan; meta: JiraProjectMeta; issues: JiraLiveItem[]; expires: number };
const projectPreviewCache = new Map<string, CachedProjectPreview>();
export function cacheJiraProjectPreview(key: string, entry: Omit<CachedProjectPreview, 'expires'>): void {
  projectPreviewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}
export function getJiraProjectPreview(key: string, query: string): CachedProjectPreview | null {
  const hit = projectPreviewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

type CachedBoardPreview = { query: string; plan: JiraPullPlan; meta: JiraBoardMeta; issues: JiraLiveItem[]; expires: number };
const boardPreviewCache = new Map<string, CachedBoardPreview>();
export function cacheJiraBoardPreview(key: string, entry: Omit<CachedBoardPreview, 'expires'>): void {
  boardPreviewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}
export function getJiraBoardPreview(key: string, query: string): CachedBoardPreview | null {
  const hit = boardPreviewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

type CachedTicketsPreview = { query: string; plan: JiraPullPlan; items: JiraLiveItem[]; expires: number };
const ticketsPreviewCache = new Map<string, CachedTicketsPreview>();
export function cacheJiraTicketsPreview(key: string, entry: Omit<CachedTicketsPreview, 'expires'>): void {
  ticketsPreviewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}
export function getJiraTicketsPreview(key: string, query: string): CachedTicketsPreview | null {
  const hit = ticketsPreviewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 4. aggregate documents (project + board modes only) ----------

/** No '#' anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderJiraProjectAggregate(opts: { query: string; plan: JiraPullPlan; meta: JiraProjectMeta; issues: JiraLiveItem[] }): string {
  const { query, plan, meta, issues } = opts;
  const head = [
    `Jira project pull — ${plan.title}`,
    `Project: ${meta.name} (${meta.key})`,
    meta.description ? `Description: ${meta.description}` : 'Description: (none)',
    `Request: ${query}`,
    `Issues included: ${issues.length}`,
  ].join('\n');
  const sections = issues.map((item, i) => `=== Issue ${i + 1} of ${issues.length}: ${item.id} ===\n${item.body}`);
  return [head, ...sections].join('\n\n');
}

export function renderJiraBoardAggregate(opts: { query: string; plan: JiraPullPlan; meta: JiraBoardMeta; issues: JiraLiveItem[] }): string {
  const { query, plan, meta, issues } = opts;
  const head = [
    `Jira board pull — ${plan.title}`,
    `Board: ${meta.name} (${meta.type ?? 'unknown type'})`,
    meta.sprint ? `Sprint: ${meta.sprint.name}${meta.sprint.goal ? ` — ${meta.sprint.goal}` : ''}` : 'Sprint: n/a (not a scrum board, or no active sprint scope)',
    `Request: ${query}`,
    `Issues included: ${issues.length}`,
  ].join('\n');
  // Group by column/status, preserving first-seen column order (not alphabetical — reads closer to a real board).
  const order: string[] = [];
  const byStatus = new Map<string, JiraLiveItem[]>();
  for (const item of issues) {
    const key = item.status || '(no status)';
    if (!byStatus.has(key)) {
      byStatus.set(key, []);
      order.push(key);
    }
    byStatus.get(key)!.push(item);
  }
  const sections: string[] = [];
  for (const status of order) {
    const group = byStatus.get(status)!;
    sections.push(`--- ${status} (${group.length}) ---`);
    sections.push(...group.map((item) => `=== ${item.id}: ${item.title} ===\n${item.body}`));
  }
  return [head, ...sections].join('\n\n');
}

export function jiraProjectRunRef(plan: JiraPullPlan): string {
  return `jira project: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
export function jiraBoardRunRef(plan: JiraPullPlan): string {
  return `jira board: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
export function jiraTicketsRunRef(plan: JiraPullPlan): string {
  return `jira tickets: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
