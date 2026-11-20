// =============================================================================
// Microsoft Teams LIVE connector via Composio (mirrors github-live.ts's
// architecture — see that file first; this is its Teams sibling, built the
// same session as a parallel Slack port).
//
// Auth: identical shape to github-live.ts, against the SAME generic shared
// tables (composio_auth_configs / user_composio_connections, keyed by a
// `toolkit` string column — no schema changes needed):
//   1. ensureTeamsAuthConfig(repo) — get-or-create ONE Composio-managed auth
//      config for the toolkit, shared by every user.
//   2. startTeamsConnect(repo, userId, callbackUrl) — composio.connectedAccounts
//      .link(...) returns a redirect URL to Microsoft's real OAuth consent
//      screen.
//   3. refreshTeamsConnectionStatus(connectedAccountId) — live status check.
//   4. disconnectTeams(connectedAccountId) — revokes at Composio + drops the
//      local row.
//
// Fetch, mirroring github-live.ts's plan → fetch → (topic-select) → aggregate
// shape, but with two pull MODES instead of two separate files (Teams has no
// natural single-inbox default, same reason GitHub requires a repo):
//   - 'channel': messages from a channel inside a Team (like Slack's channel
//     pull).
//   - 'chat': messages from a 1:1 or group chat (like Slack's DM/MPIM pull).
//   1. planTeamsPull(query) — one structured LLM call turns free text into a
//      plan naming the team/channel OR chat by human-readable label (Graph
//      ids are opaque GUIDs/thread-ids an LLM cannot know), a message count,
//      an optional topic, audience, and title.
//   2. fetchTeamsMessages(plan, userId, connectedAccountId) — resolves the
//      named team/channel or chat against a live listing (fail-closed: an
//      ambiguous or missing name throws rather than guessing), then calls
//      composio.tools.execute(...) against the resolved id(s), paginating as
//      needed.
//   3. Unlike github-live.ts's per-item Rules-matcher filter, the topic step
//      here reuses the SHARED src/lib/batch-selection.ts `selectRelevantItems`
//      helper (per architecture direction for this connector) — one-shot
//      structured LLM call over the whole fetched batch, fail-closed.
//   4. The caller aggregates the returned messages into ONE document, ONE
//      runTextIngest call per run — identical shape to GitHub's PR pull.
//
// ---------------------------------------------------------------------------
// LIVE VERIFICATION LOG (2026-07-29, COMPOSIO_API_KEY, metadata-only calls —
// no connected account exists for this toolkit yet, so composio.tools.execute
// was NEVER called; only composio.toolkits.get(...) and composio.tools.get({
// tools: [...] }) parameter-schema lookups, which need no connected account):
//
// - Toolkit slug: CONFIRMED as 'microsoft_teams' via
//   `composio.toolkits.get('microsoft_teams')` (169 tools, OAUTH2
//   composio-managed auth available — `authConfigDetails[0].mode === 'OAUTH2'`,
//   same as github's `use_composio_managed_auth`). Candidates 'msteams',
//   'microsoft-teams', 'teams', 'ms_teams' were tried first and each 404'd
//   ("Couldn't fetch Toolkit with slug: ...") — confirming 'microsoft_teams'
//   by elimination, not by fuzzy search (composio.toolkits.list({search:...})
//   isn't a function on this SDK version; toolkits.get(slug) was used
//   directly instead, exactly to avoid the fuzzy-match trap that picked the
//   wrong GitHub tool earlier this session).
// - Tool slugs below: CONFIRMED by listing all 169 `microsoft_teams` tools
//   (`composio.tools.get('default_user', { toolkits: ['microsoft_teams'],
//   limit: 500 })`) and reading each candidate's name + description +
//   full input parameter schema (`composio.tools.get('default_user', { tools:
//   [...] })`) myself — not chosen by search-string relevance. Several
//   same-purpose tools are marked DEPRECATED in their own descriptions (e.g.
//   MICROSOFT_TEAMS_LIST_CHAT → "DEPRECATED: Use MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS
//   instead", MICROSOFT_TEAMS_TEAMS_LIST_CHAT_MESSAGES → "DEPRECATED: Use
//   ListUserChatMessages instead"); the non-deprecated replacement was picked
//   in each case. Every parameter name used below (team_id, channel_id,
//   chat_id, user_id, top, page_token, ...) is taken verbatim from the live
//   `parameters` schema of that tool, not guessed.
// - Response BODY shape: NOT VERIFIED. Composio's own tool descriptions state
//   the pagination contract in words ("returns one page per call... plus a
//   `next_page_token`; pass that back as `page_token`"), so `next_page_token`
//   as the cursor field name is taken as documented fact. But no example
//   response and no `output`/response schema is exposed by `tools.get` (only
//   `type` + `function` keys came back — checked directly), and
//   `tools.execute` cannot be called without a live connected account (none
//   exists for this toolkit). So the exact key each array of results is
//   nested under (Graph's own convention is a bare `value` array — see
//   learn.microsoft.com/graph — but github-live.ts's own precedent shows
//   Composio sometimes renames the container, e.g. GitHub's PR list came back
//   as `result.data.pull_requests`, not `.items` or a raw array) is UNVERIFIED
//   here. `pickArray()` below defensively tries `value` first (the Graph
//   convention, and consistent with the "next_page_token" pagination wording)
//   then a semantic fallback name per endpoint. Likewise the per-item field
//   names used in `toItem`/team/channel/chat mapping below (`displayName`,
//   `from.user.displayName`, `body.content`, `chatType`, ...) are the
//   WELL-DOCUMENTED Microsoft Graph resource schema (team/channel/chat/
//   chatMessage — learn.microsoft.com/graph/api/resources/chatmessage etc.),
//   which is safe to state as fact independent of Composio's wrapping, but
//   whether Composio delivers them verbatim/nested exactly like that (vs.
//   flattening some field) is UNVERIFIED.
// TODO(needs a live connected account): once a real Microsoft Teams OAuth
// connection exists, call each tool once for real, log `result.data` raw, and
// (a) confirm/fix the array container keys in `pickArray`'s candidate lists,
// (b) confirm the per-message/team/channel/chat field names in the mapping
// functions below, (c) confirm `next_page_token` really appears where the
// tool descriptions say it does. Do not remove this comment until that's done.
// ---------------------------------------------------------------------------
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import { selectRelevantItems } from '../../lib/batch-selection.js';
import type { Repo } from '../db/repo.js';

export type TeamsPullPlan = {
  /** Which shape of target this pull names. */
  mode: 'channel' | 'chat';
  /** Team display name (required when mode === 'channel'). Human label — Graph team ids are opaque GUIDs an LLM cannot know. */
  team: string | null;
  /** Channel display name within that team (required when mode === 'channel'). */
  channel: string | null;
  /** A label identifying the chat: its topic (group chats) or a description of the other participant (required when mode === 'chat'). */
  chat: string | null;
  /** How many of the most recent messages to fetch (1..200; 50 unless the request says otherwise). */
  count: number;
  /** A topic to select messages by (run through the shared batch-selection step), or null for "all fetched messages". */
  topic: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type TeamsLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

/** A Microsoft Teams "team" the connected account belongs to — powers a picker. */
export type TeamsTeamOption = {
  id: string;
  display_name: string;
};

/** A channel within a team — powers a picker once a team is chosen. */
export type TeamsChannelOption = {
  id: string;
  display_name: string;
};

/** A 1:1 or group chat the connected account is part of — powers a picker. */
export type TeamsChatOption = {
  id: string;
  /** Topic for group chats; a generic "1:1 chat"/"Group chat"/"Meeting chat" label when no topic is set (see LIVE VERIFICATION LOG — per-participant labels would need a per-chat expand=members call this v1 doesn't make). */
  label: string;
  chat_type: string;
};

export class TeamsAgentUnavailable extends Error {
  constructor() {
    super('teams pull needs an LLM to plan the request and none is available');
  }
}
export class TeamsTargetRequired extends Error {
  constructor() {
    super('which team/channel or chat? include one in your request (e.g. "the Engineering team, #general channel" or "my group chat about Project X")');
  }
}
export class TeamsTargetNotFound extends Error {
  constructor(what: string) {
    super(`could not find ${what} — refusing to guess which one you meant`);
  }
}
export class TeamsNotConnected extends Error {
  constructor() {
    super('microsoft teams is not connected for this user');
  }
}

const DEFAULT_COUNT = 50;
const MAX_COUNT = 200;
/** Microsoft Graph's own per-request cap for these list endpoints (confirmed in each tool's `top` schema: minimum 1, maximum 50). */
const PAGE_SIZE = 50;
/** Cap on picker listings (teams/channels/chats) — these have no natural "count" from the user, just "give me what's there". */
const MAX_PICKER = 200;
const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'microsoft_teams';

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API, batch selection) is
// behind a hook so unit tests never touch the network or need a live
// COMPOSIO_API_KEY, matching github-live.ts's __setGithubLiveTestHooks
// convention.

type TeamsTestHooks = {
  planner?: (query: string) => Promise<TeamsPullPlan>;
  /** Replaces the RAW fetch only — the real topic-selection step (selectRelevantItems) still runs on top unless `selector` is also set. */
  fetcher?: (plan: TeamsPullPlan, userId: string, connectedAccountId: string) => Promise<TeamsLiveItem[]>;
  /** Bypasses selectRelevantItems' own LLM call — same shape as its `testHook` option. */
  selector?: (items: TeamsLiveItem[], topic: string) => Promise<TeamsLiveItem[]>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
  teamLister?: (userId: string, connectedAccountId: string) => Promise<TeamsTeamOption[]>;
  channelLister?: (userId: string, connectedAccountId: string, teamId: string) => Promise<TeamsChannelOption[]>;
  chatLister?: (userId: string, connectedAccountId: string) => Promise<TeamsChatOption[]>;
};
let testHooks: TeamsTestHooks | null = null;
export function __setTeamsLiveTestHooks(hooks: TeamsTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function teamsLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the microsoft_teams toolkit. */
export async function ensureTeamsAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/** Start a Teams connection: mints a Composio Connect link the caller redirects the browser to (Composio-managed OAuth uses `.link()`, same as github-live.ts). */
export async function startTeamsConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureTeamsAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureTeamsAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshTeamsConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectTeams(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  mode: z.enum(['channel', 'chat']),
  team: z.string().trim().min(1).nullable(),
  channel: z.string().trim().min(1).nullable(),
  chat: z.string().trim().min(1).nullable(),
  count: z.number().int().min(1).max(MAX_COUNT),
  topic: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['channel', 'chat'],
      description: "'channel' when the request names a Team/channel; 'chat' when it names a 1:1 or group chat/DM.",
    },
    team: {
      type: ['string', 'null'],
      description: "The Microsoft Teams team's display name (mode: 'channel' only). null otherwise or if not named.",
    },
    channel: {
      type: ['string', 'null'],
      description: "The channel's display name within that team (mode: 'channel' only). null otherwise or if not named.",
    },
    chat: {
      type: ['string', 'null'],
      description: "A label identifying the chat — its topic, or who it's with (mode: 'chat' only). null otherwise or if not named.",
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_COUNT,
      description: `How many of the most recent messages to fetch. Use ${DEFAULT_COUNT} unless the request names a number. Never exceed ${MAX_COUNT}.`,
    },
    topic: {
      type: ['string', 'null'],
      description: 'A topic to select messages by, phrased as standalone criteria. null when the request wants every fetched message.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Engineering channel — last 50 messages".',
    },
  },
  required: ['mode', 'team', 'channel', 'chat', 'count', 'topic', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling Microsoft Teams messages into a fetch plan.',
  "Two modes: 'channel' (a channel inside a Team) or 'chat' (a 1:1 or group chat/DM).",
  'Emit exactly one plan_teams_pull call. Be literal: extract only what the request states;',
  'do not invent a team, channel, chat, count, or topic the user did not mention.',
].join(' ');

export async function planTeamsPull(query: string): Promise<TeamsPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new TeamsAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_teams_pull',
    toolDescription: 'Emit the fetch plan for this Microsoft Teams pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'teams-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new TeamsAgentUnavailable();
  const { mode, team, channel, chat } = parsed.data;
  if (mode === 'channel' && (!team || !channel)) throw new TeamsTargetRequired();
  if (mode === 'chat' && !chat) throw new TeamsTargetRequired();
  return parsed.data as TeamsPullPlan;
}

// ---------- 2. fetch ----------

// See the LIVE VERIFICATION LOG at the top of this file for exactly how each
// slug below and its parameter names were confirmed, and what about the
// RESPONSE shape (array container key, per-item field nesting) remains
// unverified pending a live connected account.
const LIST_JOINED_TEAMS_TOOL = 'MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS'; // params: user_id (required), page_token
const LIST_CHANNELS_TOOL = 'MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS'; // params: team_id (required, GUID), filter, select, page_token, include_shared_channels
const LIST_CHANNEL_MESSAGES_TOOL = 'MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES'; // params: team_id, channel_id (required), top (max 50), expand, page_token
const LIST_CHATS_TOOL = 'MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS'; // params: user_id (default 'me'), top (max 50), filter, select, page_token
const LIST_CHAT_MESSAGES_TOOL = 'MICROSOFT_TEAMS_LIST_USER_CHAT_MESSAGES'; // params: user_id, chat_id (required), top (max 50), filter, orderby, page_token

/** Defensive array extraction — see LIVE VERIFICATION LOG: the container key each of these endpoints nests its results under was NOT confirmed against a real response. 'value' (Graph's own collection convention) is tried first, then a semantic fallback per endpoint's domain concept. */
function pickArray(data: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key] as Array<Record<string, unknown>>;
  }
  return [];
}

/** Paginates a Graph-list tool via its documented `page_token`/`next_page_token` contract (see LIVE VERIFICATION LOG) until `want` items are collected or the tool stops returning a next_page_token. */
async function paginate(
  toolSlug: string,
  baseArgs: Record<string, unknown>,
  userId: string,
  connectedAccountId: string,
  arrayKeys: string[],
  want: number,
): Promise<Array<Record<string, unknown>>> {
  const composio = getComposioClient();
  const out: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  let guard = 0;
  while (out.length < want && guard < 20) {
    guard++;
    const result = await composio.tools.execute(toolSlug, {
      userId,
      connectedAccountId,
      arguments: { ...baseArgs, ...(pageToken ? { page_token: pageToken } : {}) },
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) {
      throw new Error(`teams tool call failed: ${result.error ?? 'unknown error'}`);
    }
    const data = result.data as Record<string, unknown> | undefined;
    const batch = pickArray(data, arrayKeys);
    out.push(...batch);
    const next = data?.next_page_token;
    if (!next || typeof next !== 'string' || batch.length === 0) break;
    pageToken = next;
  }
  return out.slice(0, want);
}

/** Exact (case-insensitive) match preferred; falls back to a UNIQUE substring match. Ambiguous or absent -> undefined (fail closed, never guesses which one was meant). */
function matchByName<T>(options: T[], query: string, label: (t: T) => string): T | undefined {
  const q = query.trim().toLowerCase();
  const exact = options.filter((o) => label(o).trim().toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const partial = options.filter((o) => label(o).trim().toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

/** Teams the connected account belongs to — powers a picker so users don't have to type a team name and hope it resolves. */
export async function listTeamsTeams(userId: string, connectedAccountId: string): Promise<TeamsTeamOption[]> {
  if (testHooks?.teamLister) return testHooks.teamLister(userId, connectedAccountId);
  const raw = await paginate(LIST_JOINED_TEAMS_TOOL, { user_id: 'me' }, userId, connectedAccountId, ['value', 'teams'], MAX_PICKER);
  return raw.map((t) => ({ id: String(t.id ?? ''), display_name: String(t.displayName ?? '') })).filter((t) => t.id);
}

/** Channels within a team — powers a picker once a team is chosen. */
export async function listTeamsChannels(userId: string, connectedAccountId: string, teamId: string): Promise<TeamsChannelOption[]> {
  if (testHooks?.channelLister) return testHooks.channelLister(userId, connectedAccountId, teamId);
  const raw = await paginate(LIST_CHANNELS_TOOL, { team_id: teamId }, userId, connectedAccountId, ['value', 'channels'], MAX_PICKER);
  return raw.map((c) => ({ id: String(c.id ?? ''), display_name: String(c.displayName ?? '') })).filter((c) => c.id);
}

/** 1:1 and group chats the connected account is part of — powers a picker. */
export async function listTeamsChats(userId: string, connectedAccountId: string): Promise<TeamsChatOption[]> {
  if (testHooks?.chatLister) return testHooks.chatLister(userId, connectedAccountId);
  const raw = await paginate(LIST_CHATS_TOOL, { user_id: 'me', top: PAGE_SIZE }, userId, connectedAccountId, ['value', 'chats'], MAX_PICKER);
  return raw
    .map((c) => {
      const chatType = String(c.chatType ?? 'unknown');
      const topic = c.topic ? String(c.topic) : null;
      const label = topic ?? (chatType === 'oneOnOne' ? '1:1 chat' : chatType === 'meeting' ? 'Meeting chat' : 'Group chat');
      return { id: String(c.id ?? ''), label, chat_type: chatType };
    })
    .filter((c) => c.id);
}

async function resolveChannelTarget(
  plan: TeamsPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<{ team_id: string; channel_id: string }> {
  if (!plan.team || !plan.channel) throw new TeamsTargetRequired();
  const teams = await listTeamsTeams(userId, connectedAccountId);
  const team = matchByName(teams, plan.team, (t) => t.display_name);
  if (!team) throw new TeamsTargetNotFound(`team ${JSON.stringify(plan.team)}`);
  const channels = await listTeamsChannels(userId, connectedAccountId, team.id);
  const channel = matchByName(channels, plan.channel, (c) => c.display_name);
  if (!channel) throw new TeamsTargetNotFound(`channel ${JSON.stringify(plan.channel)} in team ${JSON.stringify(plan.team)}`);
  return { team_id: team.id, channel_id: channel.id };
}

async function resolveChatTarget(plan: TeamsPullPlan, userId: string, connectedAccountId: string): Promise<{ chat_id: string }> {
  if (!plan.chat) throw new TeamsTargetRequired();
  const chats = await listTeamsChats(userId, connectedAccountId);
  const chat = matchByName(chats, plan.chat, (c) => c.label);
  if (!chat) throw new TeamsTargetNotFound(`chat ${JSON.stringify(plan.chat)}`);
  return { chat_id: chat.id };
}

/** From/body field names are the well-documented Graph `chatMessage` resource shape — see LIVE VERIFICATION LOG for what is and isn't confirmed. */
function fromLabel(raw: Record<string, unknown>): string {
  const from = raw.from as { user?: { displayName?: string }; application?: { displayName?: string } } | undefined;
  return from?.user?.displayName ?? from?.application?.displayName ?? 'unknown';
}

function messageBodyText(raw: Record<string, unknown>): string {
  const body = raw.body as { contentType?: string; content?: string } | undefined;
  const content = body?.content ?? '';
  return body?.contentType === 'html' ? stripHtml(content) : content;
}

/** Minimal HTML→text for Teams messages whose body.contentType is 'html' (common for anything sent with rich formatting). */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function toItem(raw: Record<string, unknown>): TeamsLiveItem {
  const id = String(raw.id ?? '');
  const author = fromLabel(raw);
  const date = String(raw.createdDateTime ?? '').slice(0, 10);
  const subject = raw.subject ? String(raw.subject) : '';
  const text = messageBodyText(raw).trim();
  const capped = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : text;
  return {
    id,
    title: subject || `Message from ${author}`,
    meta: [`@${author}`, date].filter(Boolean).join(' · '),
    snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
    body: [subject ? `Subject: ${subject}` : null, `From: ${author}`, `Date: ${date}`, '', capped]
      .filter((l): l is string => l !== null)
      .join('\n'),
  };
}

async function fetchTeamsMessagesRaw(
  plan: TeamsPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<TeamsLiveItem[]> {
  if (plan.mode === 'channel') {
    const { team_id, channel_id } = await resolveChannelTarget(plan, userId, connectedAccountId);
    const raw = await paginate(
      LIST_CHANNEL_MESSAGES_TOOL,
      { team_id, channel_id, top: PAGE_SIZE },
      userId,
      connectedAccountId,
      ['value', 'messages'],
      plan.count,
    );
    return raw.map(toItem);
  }
  const { chat_id } = await resolveChatTarget(plan, userId, connectedAccountId);
  const raw = await paginate(
    LIST_CHAT_MESSAGES_TOOL,
    { user_id: 'me', chat_id, top: PAGE_SIZE },
    userId,
    connectedAccountId,
    ['value', 'messages'],
    plan.count,
  );
  return raw.map(toItem);
}

/**
 * Fetches a batch of Teams messages (channel or chat, per plan.mode) and, if
 * the plan carries a topic, narrows it via the SHARED
 * src/lib/batch-selection.ts `selectRelevantItems` step before returning —
 * fail-closed: an unavailable LLM throws rather than silently returning the
 * whole unfiltered batch.
 */
export async function fetchTeamsMessages(
  plan: TeamsPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<TeamsLiveItem[]> {
  const rawItems = testHooks?.fetcher
    ? await testHooks.fetcher(plan, userId, connectedAccountId)
    : await fetchTeamsMessagesRaw(plan, userId, connectedAccountId);
  if (!plan.topic) return rawItems;
  return selectRelevantItems(rawItems, plan.topic, { itemNoun: 'messages', testHook: testHooks?.selector });
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: TeamsPullPlan; items: TeamsLiveItem[]; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheTeamsPreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getTeamsPreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 3. aggregate document ----------

/** No '#' anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderTeamsAggregate(opts: { query: string; plan: TeamsPullPlan; items: TeamsLiveItem[] }): string {
  const { query, plan, items } = opts;
  const target = plan.mode === 'channel' ? `Team: ${plan.team} · Channel: ${plan.channel}` : `Chat: ${plan.chat}`;
  const head = [
    `Microsoft Teams pull — ${plan.title}`,
    target,
    `Request: ${query}`,
    plan.topic ? `Topic applied: ${plan.topic}` : 'Topic: none (all fetched messages included)',
    `Messages included: ${items.length}`,
  ].join('\n');
  const sections = items.map((item, i) => `=== Message ${i + 1} of ${items.length} ===\n${item.body}`);
  return [head, ...sections].join('\n\n');
}

export function teamsRunRef(plan: TeamsPullPlan): string {
  return `teams: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
