// =============================================================================
// Slack LIVE connector via Composio
//
// Composio-backed sibling of github-live.ts (read that file first — it's the
// reference architecture every connector in this family mirrors). The auth
// model (connect/refresh/disconnect) is IDENTICAL to GitHub's —
// composio_auth_configs/user_composio_connections are already generic by
// `toolkit` column, so no schema changes were needed here either.
//
// One real difference from GitHub: Slack's message-history API needs a
// conversation ID (C.../G.../D...), not a name, so fetchRecentSlackMessages
// resolves a human channel name (or a picker-selected id) to a conversation
// via resolveSlackConversation — GitHub's repo API accepts "owner/name"
// directly, so that resolution step didn't exist there.
//
// Ported from the channel-only prototype at prototype/composio-github
// (slack-live.ts), live-verified there against a real Slack workspace
// 2026-07-27 for the channel-only path (SLACK_LIST_ALL_CHANNELS,
// SLACK_FETCH_CONVERSATION_HISTORY). This port additionally:
//   1. Replaces the prototype's own extractSlackSelection with the shared
//      selectRelevantItems (lib/batch-selection.ts) — same one-shot
//      topic-selection-over-a-batch model, now deduplicated across connectors.
//   2. Extends the picker beyond channels to DMs (im) and group DMs (mpim) —
//      see the "TOOL VERIFICATION" block below for exactly what was and
//      wasn't confirmed live for that extension.
//
// TOOL VERIFICATION (2026-07-29, via composio.tools.get({toolkits:['slack']})
// against the real Composio API with COMPOSIO_API_KEY — no connected Slack
// account exists in this environment, so nothing below was executed live;
// this is metadata/schema inspection only, not a runtime response check):
//
// - Listed ALL 167 slack toolkit tools and read them directly (no fuzzy
//   `search:` matching — this session was burned twice by that already: once
//   picking the wrong tool, once by a real tool defaulting to the wrong sort
//   order). Picked by exact name + description match.
// - SLACK_LIST_ALL_CHANNELS.parameters.types is a plain string field whose
//   description explicitly enumerates all four values and gives
//   "im,mpim" as one of its own examples:
//     "Comma-separated list of conversation types to include: `public_channel`
//      ..., `private_channel` ..., `im` (1-on-1 direct messages), `mpim`
//      (group direct messages with 3+ people). Defaults to `public_channel`
//      if omitted."
//   So `types: 'public_channel,private_channel,im,mpim'` is confirmed
//   accepted by the schema (not by a live call — see below for what that
//   means for the response shape).
// - SLACK_LIST_CONVERSATIONS (a sibling listing tool, same shape) documents
//   the response gap explicitly: "For `im` results, only user IDs are
//   returned; use a user-lookup tool to resolve display names." This is the
//   authoritative confirmation that an `im` entry carries a `user` id but NO
//   human-readable `name` — matching Slack's long-documented conversations.*
//   behavior, but note this sentence is on LIST_CONVERSATIONS's schema, not
//   LIST_ALL_CHANNELS's (they read as the same underlying Slack API wrapped
//   twice; TOOL SLUGS are still separate Composio tools).
// - SLACK_RETRIEVE_CONVERSATION_INFORMATION (conversations.info) is a
//   single-ID lookup — used here instead of re-listing everything when
//   resolving a raw id (e.g. one selected via the picker). Its schema doc
//   doesn't spell out the im/mpim field names either.
// - SLACK_RETRIEVE_DETAILED_USER_INFORMATION (users.info) — used to turn an
//   `im`'s bare `user` id into a display name.
// - SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST (conversations.members) — used
//   as a fallback to name a group DM when it has no usable `name` field.
//
// TODO(unverified — no live connected account to execute against): the EXACT
// JSON field names on an `im`/`mpim` entry from SLACK_LIST_ALL_CHANNELS /
// SLACK_RETRIEVE_CONVERSATION_INFORMATION are assumed, not confirmed, to
// mirror Slack's stable conversations.list/conversations.info Web API shape:
//   - im entry: { id, is_im: true, user: '<user id>' } — no `name`.
//   - mpim entry: { id, is_mpim: true, name: 'mpdm-alice--bob--carol-1' } —
//     Slack's well-known auto-generated slug naming for group DMs, which can
//     go stale (renamed/deactivated users) — code below treats an empty/
//     unparseable name as "no name" and falls back to resolving members.
// resolveSlackConversation()/listSlackConversations() below are written
// defensively against this being wrong (falls back through several field
// names, never throws on a shape mismatch — see toConversationOption/
// describeConversation), but this should be live-verified against a real
// connected Slack workspace before being fully trusted in production, same
// as the channel/message-history shapes were confirmed after the fact on
// 2026-07-27. Do not remove this TODO until that happens.
//
// SELECTION MODEL (unchanged from the prototype, differs from Gmail/GitHub's
// per-item filter): the user never hand-picks individual messages. A request
// is either count-based (no topic — the whole fetched batch is "the
// selection") or topic-based ("messages related to customer calls"), in
// which case ONE structured LLM call (selectRelevantItems, itemNoun:
// 'messages') reasons over the whole batch and keeps/drops whole messages —
// it never rewrites content. Either way, the preview shows ONE row ("a
// selection of messages"), not one row per message — see
// buildSlackSelectionItem.
// =============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import { selectRelevantItems } from '../../lib/batch-selection.js';
import type { Repo } from '../db/repo.js';

export type SlackPullPlan = {
  /** Channel name (with or without leading '#'), or a raw conversation id (C.../G.../D...) from a picker selection. Required — Slack has no single inbox to default to. */
  channel: string;
  /** How many recent messages to fetch (1..200; 30 unless the request says otherwise). */
  count: number;
  /** A topic/criteria to select messages by (e.g. "messages related to customer calls"), or null for "the N most recent, unfiltered". */
  filter: string | null;
  /** Audience for nodes auto-integrated from this pull. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type SlackLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

/**
 * A conversation the connected account can see — powers a picker instead of
 * asking the user to type a channel name freehand. `type` lets a future UI
 * tell channels apart from DMs/group DMs (e.g. different icon or section)
 * without any other shape change; this task does not touch that UI.
 */
export type SlackConversationOption = {
  id: string;
  type: 'channel' | 'im' | 'mpim';
  /** Human-readable label: '#general' for channels, 'DM with Alice' for an im, 'Group DM: Alice, Bob' for an mpim. */
  name: string;
};

/** @deprecated kept only as a type alias for callers still on the channel-only shape; use SlackConversationOption. */
export type SlackChannelOption = SlackConversationOption;

export class SlackAgentUnavailable extends Error {
  constructor() {
    super('slack pull needs an LLM to plan the request and none is available');
  }
}
export class SlackChannelRequired extends Error {
  constructor() {
    super('which channel or conversation? include one like "#general", or pick one from the connected workspace');
  }
}
export class SlackChannelNotFound extends Error {
  constructor(name: string) {
    super(`no channel matching "${name}" was found (or this connection can't see it)`);
  }
}
export class SlackNotConnected extends Error {
  constructor() {
    super('slack is not connected for this user');
  }
}

const DEFAULT_COUNT = 30;
const MAX_COUNT = 200;
const BODY_CHAR_CAP = 4000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'slack';
/** Soft cap on how many distinct user ids get a display-name lookup while building one picker listing — bounds worst-case cost on a workspace with many DMs. Past this, unresolved ids fall back to a raw-id label rather than blocking the whole picker. */
const MAX_USER_NAME_LOOKUPS = 200;

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// github-live.ts's __setGithubLiveTestHooks convention.

type SlackTestHooks = {
  planner?: (query: string) => Promise<SlackPullPlan>;
  fetcher?: (plan: SlackPullPlan, userId: string, connectedAccountId: string) => Promise<SlackLiveItem[]>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
  conversationLister?: (userId: string, connectedAccountId: string) => Promise<SlackConversationOption[]>;
  selector?: (items: SlackLiveItem[], topic: string) => Promise<SlackLiveItem[]>;
};
let testHooks: SlackTestHooks | null = null;
export function __setSlackLiveTestHooks(hooks: SlackTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function slackLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------

/** Get-or-create the ONE shared Composio-managed auth config for the slack toolkit. */
export async function ensureSlackAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/**
 * Start a Slack connection: mints a Composio Connect link the caller
 * redirects the browser to. Composio-managed OAuth uses `.link()`, not the
 * deprecated `.initiate()` (retired for Composio-managed auth configs as of
 * 2026-07-03 — see ComposioHQ/composio changelog 2026/04/24).
 */
export async function startSlackConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureSlackAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureSlackAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshSlackConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectSlack(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  channel: z.string().trim().min(1).nullable(),
  count: z.number().int().min(1).max(MAX_COUNT),
  filter: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    channel: {
      type: ['string', 'null'],
      description: 'The Slack channel to pull from, e.g. "general" or "#pome-product-update" (leading # optional). null if the request names no channel. (DMs/group DMs are picked from a conversation list in the UI, not typed here.)',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_COUNT,
      description: `How many of the most recent messages to download. Use ${DEFAULT_COUNT} unless the request names a number. Never exceed ${MAX_COUNT}.`,
    },
    filter: {
      type: ['string', 'null'],
      description: 'A topic or criteria to select messages by (e.g. "messages related to customer calls", "from zelta"). null when the request just wants the N most recent messages, unfiltered.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Recent messages in #pome-product-update".',
    },
  },
  required: ['channel', 'count', 'filter', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling Slack messages into a fetch plan.',
  'Emit exactly one plan_slack_pull call. Be literal: extract only what the request states;',
  'do not invent a channel, filter, or count the user did not mention.',
].join(' ');

export async function planSlackPull(query: string): Promise<SlackPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new SlackAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_slack_pull',
    toolDescription: 'Emit the fetch plan for this Slack pull request.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'slack-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new SlackAgentUnavailable();
  if (!parsed.data.channel) throw new SlackChannelRequired();
  return parsed.data as SlackPullPlan;
}

// ---------- 2. fetch ----------

const LIST_CHANNELS_TOOL = 'SLACK_LIST_ALL_CHANNELS';
const CONVERSATION_INFO_TOOL = 'SLACK_RETRIEVE_CONVERSATION_INFORMATION';
const USER_INFO_TOOL = 'SLACK_RETRIEVE_DETAILED_USER_INFORMATION';
const CONVERSATION_MEMBERS_TOOL = 'SLACK_RETRIEVE_CONVERSATION_MEMBERS_LIST';
const FETCH_HISTORY_TOOL = 'SLACK_FETCH_CONVERSATION_HISTORY';

/** Raw shape returned for one entry of SLACK_LIST_ALL_CHANNELS / SLACK_RETRIEVE_CONVERSATION_INFORMATION — see the TODO block at the top of this file for what's confirmed vs assumed here. */
type RawConversation = {
  id?: unknown;
  name?: unknown;
  is_im?: unknown;
  is_mpim?: unknown;
  is_channel?: unknown;
  is_group?: unknown;
  is_private?: unknown;
  user?: unknown; // im: the other party's user id
  members?: unknown; // not documented as present on list/info, but read defensively if it ever is
};

function classifyConversation(c: RawConversation): 'channel' | 'im' | 'mpim' {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  return 'channel';
}

/** Resolve a user id to a display name, memoized across one listing/resolution call so the same DM partner is never looked up twice. */
function makeUserNameResolver(userId: string, connectedAccountId: string) {
  const cache = new Map<string, string>();
  let lookups = 0;
  return async function resolveUserName(slackUserId: string): Promise<string> {
    if (!slackUserId) return 'unknown';
    const cached = cache.get(slackUserId);
    if (cached) return cached;
    if (lookups >= MAX_USER_NAME_LOOKUPS) return slackUserId; // soft cap — fall back to the raw id
    lookups++;
    try {
      const composio = getComposioClient();
      const result = await composio.tools.execute(USER_INFO_TOOL, {
        userId,
        connectedAccountId,
        arguments: { user: slackUserId },
        dangerouslySkipVersionCheck: true,
      });
      const u = (result.data as { user?: Record<string, unknown> } | undefined)?.user;
      const profile = u?.profile as Record<string, unknown> | undefined;
      const name =
        (typeof profile?.display_name === 'string' && profile.display_name) ||
        (typeof profile?.real_name === 'string' && profile.real_name) ||
        (typeof u?.real_name === 'string' && (u.real_name as string)) ||
        (typeof u?.name === 'string' && (u.name as string)) ||
        slackUserId;
      cache.set(slackUserId, name);
      return name;
    } catch {
      // A single failed lookup degrades to the raw id, not a picker-wide failure.
      return slackUserId;
    }
  };
}

/** Build a human label for one conversation, resolving im/mpim display names as needed (see file-top TODO — the exact response shape driving this is unverified live). */
async function describeConversation(
  c: RawConversation,
  type: 'channel' | 'im' | 'mpim',
  resolveUserName: (id: string) => Promise<string>,
  userId: string,
  connectedAccountId: string,
): Promise<string> {
  if (type === 'channel') {
    const name = typeof c.name === 'string' ? c.name : String(c.id ?? '');
    return `#${name}`;
  }
  if (type === 'im') {
    const other = typeof c.user === 'string' ? c.user : '';
    const name = other ? await resolveUserName(other) : 'unknown';
    return `DM with ${name}`;
  }
  // mpim
  if (typeof c.name === 'string' && c.name.trim()) return `Group DM (${c.name})`;
  // No usable name field — fall back to resolving members. mpims cap at a
  // handful of people, so this stays cheap even uncached.
  const members = Array.isArray(c.members) ? (c.members as unknown[]).map(String) : [];
  let memberIds = members;
  if (memberIds.length === 0 && typeof c.id === 'string') {
    try {
      const composio = getComposioClient();
      const result = await composio.tools.execute(CONVERSATION_MEMBERS_TOOL, {
        userId,
        connectedAccountId,
        arguments: { channel: c.id, limit: 20 },
        dangerouslySkipVersionCheck: true,
      });
      const raw = (result.data as { members?: unknown[] } | undefined)?.members;
      memberIds = Array.isArray(raw) ? raw.map(String) : [];
    } catch {
      memberIds = [];
    }
  }
  if (memberIds.length === 0) return `Group DM (${String(c.id ?? 'unknown')})`;
  const names = await Promise.all(memberIds.slice(0, 8).map((id) => resolveUserName(id)));
  return `Group DM: ${names.join(', ')}`;
}

/**
 * All conversations (public/private channels, DMs, group DMs) the connected
 * account can see — powers a single picker so users don't have to type a
 * channel name freehand, and so a future UI can group by `type`. See the
 * verification block at the top of this file for exactly what's confirmed
 * (the `types` param accepting "im,mpim") vs assumed (per-entry field names
 * for im/mpim, not live-executable without a connected account).
 */
export async function listSlackConversations(userId: string, connectedAccountId: string): Promise<SlackConversationOption[]> {
  if (testHooks?.conversationLister) return testHooks.conversationLister(userId, connectedAccountId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_CHANNELS_TOOL, {
    userId,
    connectedAccountId,
    arguments: { limit: 500, types: 'public_channel,private_channel,im,mpim' },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`slack tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const raw = Array.isArray((result.data as { channels?: unknown[] } | undefined)?.channels)
    ? ((result.data as { channels: unknown[] }).channels as RawConversation[])
    : [];
  // Resolving each conversation's display name is per-item network I/O for
  // im/mpim entries (user-info / member-list lookups) — doing this serially
  // in a for-loop measured at 16-20s wall time for ~30 conversations against
  // a real workspace (mostly waiting, not computing), slow enough that a dev
  // proxy can cut the response mid-stream. Promise.all bounds the wall time
  // to roughly the slowest single lookup instead of their sum.
  const resolveUserName = makeUserNameResolver(userId, connectedAccountId);
  const described = await Promise.all(
    raw.map(async (c): Promise<SlackConversationOption | null> => {
      const id = String(c.id ?? '');
      if (!id) return null;
      const type = classifyConversation(c);
      const name = await describeConversation(c, type, resolveUserName, userId, connectedAccountId);
      return { id, type, name };
    }),
  );
  return described.filter((x): x is SlackConversationOption => x !== null);
}

/** @deprecated use listSlackConversations; kept only so any caller still on the old name keeps working during the routes.ts wiring pass. */
export const listSlackChannels = listSlackConversations;

const RAW_ID_RE = /^[CGD][A-Z0-9]{8,}$/i;

/**
 * Resolve a channel name, or a picker-selected/raw conversation id, to
 * {id, type, label}. IDs are resolved via a single conversations.info-style
 * lookup (cheap); names are matched against the channel-type entries of the
 * full listing (DMs/group DMs have no natural freehand name — see file-top
 * notes — so name-based resolution deliberately stays channel-only, same
 * reasoning as github-live.ts reserving the branch PICKER as the only path
 * for branch names that can contain '/').
 */
async function resolveSlackConversation(
  userId: string,
  connectedAccountId: string,
  ref: string,
): Promise<{ id: string; type: 'channel' | 'im' | 'mpim'; label: string }> {
  if (RAW_ID_RE.test(ref)) {
    const composio = getComposioClient();
    const result = await composio.tools.execute(CONVERSATION_INFO_TOOL, {
      userId,
      connectedAccountId,
      arguments: { channel: ref },
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) throw new SlackChannelNotFound(ref);
    const c = (result.data as { channel?: RawConversation } | undefined)?.channel ?? {};
    const type = classifyConversation(c);
    const resolveUserName = makeUserNameResolver(userId, connectedAccountId);
    const label = await describeConversation({ ...c, id: ref }, type, resolveUserName, userId, connectedAccountId);
    return { id: ref, type, label };
  }
  const bare = ref.replace(/^#/, '').toLowerCase();
  const conversations = await listSlackConversations(userId, connectedAccountId);
  const match = conversations.find((c) => c.type === 'channel' && c.name.replace(/^#/, '').toLowerCase() === bare);
  if (!match) throw new SlackChannelNotFound(ref);
  return { id: match.id, type: match.type, label: match.name };
}

export async function fetchRecentSlackMessages(
  plan: SlackPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<SlackLiveItem[]> {
  if (testHooks?.fetcher) return testHooks.fetcher(plan, userId, connectedAccountId);
  const composio = getComposioClient();
  const { id: channelId, label: conversationLabel } = await resolveSlackConversation(userId, connectedAccountId, plan.channel);
  const result = await composio.tools.execute(FETCH_HISTORY_TOOL, {
    userId,
    connectedAccountId,
    arguments: { channel: channelId, limit: plan.count },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`slack tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const messages = Array.isArray((result.data as { messages?: unknown[] } | undefined)?.messages)
    ? ((result.data as { messages: unknown[] }).messages as Array<Record<string, unknown>>)
    : [];
  return messages.slice(0, plan.count).map((msg) => {
    const ts = String(msg.ts ?? '');
    const date = ts ? new Date(parseFloat(ts) * 1000).toISOString().slice(0, 10) : '';
    const user = String(msg.user ?? msg.username ?? 'unknown');
    const text = String(msg.text ?? '').trim();
    const body = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : text;
    return {
      id: ts || `${user}-${date}`,
      title: `Message from ${user}`,
      meta: [user, date].filter(Boolean).join(' · '),
      snippet: body.replace(/\s+/g, ' ').slice(0, 140),
      body: [`Conversation: ${conversationLabel}`, `From: ${user}`, `Time: ${date}`, '', body].join('\n'),
    };
  });
}

// ---------- 3. select (topic extraction via the shared batch-selection
// helper — not the per-item Rules-matcher other connectors use) ----------
//
// The user should never have to hand-pick individual messages: a request
// either wants "the N most recent" (no topic — the whole fetched batch is
// the selection) or names a topic ("messages related to customer calls"),
// in which case ONE call over the whole batch decides which message ids are
// relevant. This used to be a Slack-only copy (extractSlackSelection); it now
// rides the shared selectRelevantItems (lib/batch-selection.ts) that
// github-live.ts's files-mode already uses, with itemNoun: 'messages'. It
// still only ever KEEPS or DROPS existing messages (never rewrites content),
// so citations stay traceable to the real Slack message.

/** Thin wrapper so callers (and this file's own preview/pull helpers) don't need to know about SlackLiveItem's extra `title`/`body` fields when calling the generic selector. */
export async function extractSlackSelection(items: SlackLiveItem[], topic: string): Promise<SlackLiveItem[]> {
  return selectRelevantItems(items, topic, {
    itemNoun: 'messages',
    testHook: testHooks?.selector,
  });
}

/**
 * Collapse a fetched (and possibly topic-selected) batch into ONE preview/pull
 * row — "a selection of messages", not one row per message. Keeps the shared
 * Sources.tsx checkbox UI unchanged: it just renders a single always-checked
 * item instead of one per message.
 */
export function buildSlackSelectionItem(items: SlackLiveItem[], plan: SlackPullPlan): SlackLiveItem {
  const combined = items.map((i) => i.snippet).join(' — ');
  return {
    id: 'selection',
    title: plan.title,
    meta: `${items.length} message${items.length === 1 ? '' : 's'}`,
    snippet: combined.slice(0, 140),
    body: '', // unused — pull re-renders the real aggregate from the cached item list, not this summary row
  };
}

// ---------- preview → pull handoff ----------

type CachedPreview = { query: string; plan: SlackPullPlan; items: SlackLiveItem[]; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheSlackPreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getSlackPreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

// ---------- 4. aggregate document ----------

/** No '#' left dangling at line-start anywhere in the scaffold — parseSubgraphTokens treats #tokens as subgraph pins. */
export function renderSlackAggregate(opts: { query: string; plan: SlackPullPlan; items: SlackLiveItem[] }): string {
  const { query, plan, items } = opts;
  const channel = plan.channel.replace(/^#/, '');
  const head = [
    `Slack pull — ${plan.title}`,
    `Requested as: ${channel}`,
    `Request: ${query}`,
    plan.filter ? `Filter applied: ${plan.filter}` : 'Filter: none (all downloaded messages included)',
    `Messages included: ${items.length}`,
  ].join('\n');
  const sections = items.map((item, i) => `=== Message ${i + 1} of ${items.length} ===\n${item.body}`);
  return [head, ...sections].join('\n\n');
}

export function slackRunRef(plan: SlackPullPlan): string {
  return `slack: ${plan.title} — ${new Date().toISOString().slice(0, 10)}`;
}
