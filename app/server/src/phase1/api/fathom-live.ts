// =============================================================================
// Fathom LIVE connector via Composio (fathom.video — AI meeting recorder /
// transcripts). Sibling of github-live.ts and gmail-live.ts; same shared
// tables (composio_auth_configs, user_composio_connections), same test-hook
// convention, same getComposioClient() seam. Read github-live.ts first — this
// file mirrors its auth section verbatim (toolkit renamed to 'fathom') and
// only the fetch shape differs.
//
// SHAPE DIFFERENCE FROM GITHUB/GMAIL: this is a SINGLE-ITEM pull, not a batch.
// The ask is "pull up the transcript of a specific meeting" — the user names
// ONE meeting (by title, date, or participant), not "the last N meetings".
// So there is no batch-selection.ts / Rules-filter step and no aggregate
// document: the pipeline is
//   1. planFathomPull(query)      — free text -> {search, dateFrom, dateTo,
//      participant, audience, title}, one structured LLM call.
//   2. fetchFathomMeetings(plan, userId, connectedAccountId) (aliased as
//      listFathomMeetings) — search Composio for matching meetings; returns
//      picker rows (id/title/meta only, no body) so the user disambiguates
//      "which meeting did you mean" exactly like GitHub's repo/branch
//      pickers narrow to one target, rather than silently guessing.
//   3. fetchFathomTranscript(meetingId, userId, connectedAccountId) — once a
//      single meeting is chosen, pull its full transcript as ONE
//      {id, title, meta, snippet, body} item (the generic shape the existing
//      preview/pull UI already expects). Each meeting pulled becomes its own
//      document — never aggregated, unlike PR-mode.
//
// ============================================================================
// LIVE-VERIFICATION STATUS — READ BEFORE TRUSTING ANY FIELD NAME BELOW
// ============================================================================
// Unlike github-live.ts (verified 2026-07-27/28 against a real Composio API
// key via tools.get()/tools.execute()), NO live Composio API call was made
// for this file: COMPOSIO_API_KEY was not actually present anywhere
// reachable in this sandboxed worktree (no app/server/.env, no
// process.env.COMPOSIO_API_KEY — checked directly) despite the task brief
// expecting one. Per instructions, guessing tool slugs/shapes with zero
// verification was refused; instead everything below was confirmed against
// Composio's PUBLIC documentation (composio.dev/toolkits/fathom and
// docs.composio.dev/toolkits/fathom, fetched 2026-07-29):
//
// CONFIRMED (doc-verified, not live-verified):
//   - Fathom IS a supported Composio toolkit. Toolkit slug: 'fathom'. 70
//     tools total, of which exactly 7 are documented actions:
//       FATHOM_LIST_MEETINGS, FATHOM_LIST_TEAMS, FATHOM_LIST_TEAM_MEMBERS,
//       FATHOM_GET_RECORDING_SUMMARY, FATHOM_GET_RECORDING_TRANSCRIPT,
//       FATHOM_CREATE_WEBHOOK, FATHOM_DELETE_WEBHOOK.
//   - The two used here, FATHOM_LIST_MEETINGS and
//     FATHOM_GET_RECORDING_TRANSCRIPT, are real actions with the parameter
//     schemas documented at each tool's constant below.
//   - Every Composio tool call returns the same generic envelope GitHub's
//     tools.execute() uses: { data, error, successful } — that part is a
//     platform-wide convention, not Fathom-specific, so it's trustworthy.
//   - IMPORTANT DESIGN-FORCING FACT: FATHOM_LIST_MEETINGS's own
//     `include_summary` / `include_transcript` params are documented as
//     "NOT SUPPORTED FOR OAUTH USERS" (API-key auth only). Our connections
//     are Composio-managed OAuth (ensureFathomAuthConfig uses
//     'use_composio_managed_auth', same as GitHub) — so inlining the
//     transcript into the list call is not just unavailable in practice,
//     it's a documented hard platform constraint. This is WHY the pipeline
//     above is a mandatory two-step list-then-fetch, not a convenience.
//
// UNVERIFIED (docs describe the tools but show no JSON example/response
// schema beyond the generic envelope — every one of these is a best-effort
// guess with defensive fallbacks, not a confirmed fact):
//   - The key inside `result.data` holding the meetings array for
//     FATHOM_LIST_MEETINGS (tried: 'items', 'meetings', 'recordings', or
//     `data` itself already being an array — see firstArray()).
//   - The field names for a meeting's title, id, date, and
//     participants/invitees (see meetingTitle/meetingId/meetingDate/
//     meetingParticipants below).
//   - The key inside `result.data` holding the transcript payload for
//     FATHOM_GET_RECORDING_TRANSCRIPT (guessed: 'transcript', falling back
//     to `data` itself — see fetchFathomTranscript).
//   - The full field set of a transcript segment. Docs confirmed ONE detail
//     explicitly: "speaker is an object — access speaker.display_name,
//     rather than treating speaker as a string." Segment text/timestamp
//     field names are guessed (see renderTranscript).
//
// TODO(live-verify): once a real connected account exists for this toolkit,
// call FATHOM_LIST_MEETINGS and FATHOM_GET_RECORDING_TRANSCRIPT once each,
// log the raw `result.data`, and replace every guessed field name above with
// the confirmed one — the same discipline that caught github-live.ts's wrong
// tool-search match and its default-sort-order bug.
// ============================================================================

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from '../../lib/anthropic.js';
import { getComposioClient } from '../../lib/composio.js';
import type { Repo } from '../db/repo.js';

export type FathomPullPlan = {
  /** Free-text search against the meeting title/name, or null if the request narrows only by date/participant. */
  search: string | null;
  /** ISO date (yyyy-mm-dd). Meetings recorded on/after this date, or null. */
  dateFrom: string | null;
  /** ISO date (yyyy-mm-dd). Meetings recorded on/before this date, or null. */
  dateTo: string | null;
  /** A participant or company name/email to narrow by, or null. */
  participant: string | null;
  /** Audience for nodes auto-integrated from the pulled transcript. */
  audience: 'team' | 'private' | 'only_me';
  /** Short human title; becomes part of the source_ref. */
  title: string;
};

/** A picker row for meeting search results — deliberately leaner than FathomLiveItem (no body/snippet): the transcript is only fetched once the user picks ONE. Mirrors GithubRepoOption/GithubBranchOption. */
export type FathomMeetingOption = {
  id: string;
  title: string;
  meta: string;
};

/** Same wire shape as the catalog's AppSourceItem so the preview UI needs no changes. */
export type FathomLiveItem = {
  id: string;
  title: string;
  meta: string;
  snippet: string;
  body: string;
};

export class FathomAgentUnavailable extends Error {
  constructor() {
    super('fathom pull needs an LLM to plan the request and none is available');
  }
}
export class FathomSearchRequired extends Error {
  constructor() {
    super('which meeting? include a title, date, or participant in your request');
  }
}
export class FathomNotConnected extends Error {
  constructor() {
    super('fathom is not connected for this user');
  }
}
export class FathomMeetingNotFound extends Error {
  constructor(meetingId: string) {
    super(`meeting ${meetingId} was not found (or is no longer accessible) via the connected Fathom account`);
  }
}

const MAX_MEETINGS = 20;
const BODY_CHAR_CAP = 20000;
const PREVIEW_TTL_MS = 10 * 60_000;
const TOOLKIT = 'fathom';

// ---------- test seams ----------
// Every real external call (LLM plan, Composio API) is behind a hook so unit
// tests never touch the network or need a live COMPOSIO_API_KEY, matching
// github-live.ts's __setGithubLiveTestHooks convention.

type FathomTestHooks = {
  planner?: (query: string) => Promise<FathomPullPlan>;
  meetingsFetcher?: (plan: FathomPullPlan, userId: string, connectedAccountId: string) => Promise<FathomMeetingOption[]>;
  transcriptFetcher?: (meetingId: string, userId: string, connectedAccountId: string) => Promise<FathomLiveItem>;
  linker?: (userId: string, authConfigId: string, callbackUrl?: string) => Promise<{ id: string; redirectUrl: string | null }>;
  statusChecker?: (connectedAccountId: string) => Promise<'initiated' | 'active' | 'failed'>;
  disconnector?: (connectedAccountId: string) => Promise<void>;
  authConfigCreator?: () => Promise<string>;
};
let testHooks: FathomTestHooks | null = null;
export function __setFathomLiveTestHooks(hooks: FathomTestHooks | null): void {
  testHooks = hooks;
}

// ---------- config ----------

/** Live when the calling user has an active Composio connection (or a test faked the seam). */
export function fathomLiveConfigured(connection: { status: string } | undefined): boolean {
  return !!testHooks || connection?.status === 'active';
}

// ---------- auth: connect / status / disconnect ----------
// Identical shape to ensureGithubAuthConfig/startGithubConnect/
// refreshGithubConnectionStatus/disconnectGithub — only TOOLKIT differs.

/** Get-or-create the ONE shared Composio-managed auth config for the fathom toolkit. */
export async function ensureFathomAuthConfig(repo: Repo): Promise<string> {
  if (testHooks?.authConfigCreator) return testHooks.authConfigCreator();
  const existing = await repo.getComposioAuthConfig(TOOLKIT);
  if (existing) return existing;
  const composio = getComposioClient();
  const authConfig = await composio.authConfigs.create(TOOLKIT, { type: 'use_composio_managed_auth' });
  await repo.setComposioAuthConfig(TOOLKIT, authConfig.id);
  return authConfig.id;
}

/**
 * Start a Fathom connection: mints a Composio Connect link the caller
 * redirects the browser to. Composio-managed OAuth uses `.link()`, not the
 * deprecated `.initiate()` (retired for Composio-managed auth configs as of
 * 2026-07-03 — see ComposioHQ/composio changelog 2026/04/24).
 */
export async function startFathomConnect(
  repo: Repo,
  userId: string,
  callbackUrl?: string,
): Promise<{ connectedAccountId: string; redirectUrl: string | null }> {
  if (testHooks?.linker) {
    const authConfigId = await ensureFathomAuthConfig(repo);
    const r = await testHooks.linker(userId, authConfigId, callbackUrl);
    return { connectedAccountId: r.id, redirectUrl: r.redirectUrl };
  }
  const authConfigId = await ensureFathomAuthConfig(repo);
  const composio = getComposioClient();
  const connectionRequest = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    allowMultiple: true, // reconnecting (e.g. after a revoke) shouldn't 400 on a stale row
  });
  return { connectedAccountId: connectionRequest.id, redirectUrl: connectionRequest.redirectUrl ?? null };
}

/** Live status check — never trust a browser redirect completing as proof the OAuth actually finished. */
export async function refreshFathomConnectionStatus(connectedAccountId: string): Promise<'initiated' | 'active' | 'failed'> {
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

export async function disconnectFathom(connectedAccountId: string): Promise<void> {
  if (testHooks?.disconnector) return testHooks.disconnector(connectedAccountId);
  const composio = getComposioClient();
  await composio.connectedAccounts.delete(connectedAccountId);
}

// ---------- 1. plan ----------

const PlanShape = z.object({
  search: z.string().trim().min(1).nullable(),
  dateFrom: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dateTo: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  participant: z.string().trim().min(1).nullable(),
  audience: z.enum(['team', 'private', 'only_me']),
  title: z.string().trim().min(1).max(120),
});

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search: {
      type: ['string', 'null'],
      description: 'A phrase to search for in the meeting title/topic (e.g. "Q3 planning"). null if the request narrows only by date or participant.',
    },
    dateFrom: {
      type: ['string', 'null'],
      description: 'Earliest recording date to consider, as YYYY-MM-DD. null if the request gives no start of a range.',
    },
    dateTo: {
      type: ['string', 'null'],
      description: 'Latest recording date to consider, as YYYY-MM-DD. null if the request gives no end of a range.',
    },
    participant: {
      type: ['string', 'null'],
      description: 'A participant name, company name, or email mentioned as being on the call (e.g. "Acme", "jane@acme.com"). null if none is named.',
    },
    audience: {
      type: 'string',
      enum: ['team', 'private', 'only_me'],
      description: "Visibility for what this pull adds to the graph. 'team' when the request asks to share with the team, otherwise 'private'.",
    },
    title: {
      type: 'string',
      description: 'Short title for the ingested source, e.g. "Transcript: Q3 planning meeting".',
    },
  },
  required: ['search', 'dateFrom', 'dateTo', 'participant', 'audience', 'title'],
} as const;

const PLAN_SYSTEM = [
  'You turn a natural-language request about pulling one Fathom meeting transcript into a search plan.',
  'Emit exactly one plan_fathom_pull call. Be literal: extract only what the request states — a search',
  'phrase (meeting title/topic), a date range, and/or a participant or company name. Do not invent any',
  'of these the request does not mention. This is a search for ONE specific meeting, not a batch —',
  'leave fields null rather than guessing when the request is vague.',
].join(' ');

export async function planFathomPull(query: string): Promise<FathomPullPlan> {
  if (testHooks?.planner) return testHooks.planner(query);
  if (!hasStructuredLLM()) throw new FathomAgentUnavailable();
  const res = await structuredCall({
    model: MODELS.triage,
    system: PLAN_SYSTEM,
    user: query,
    toolName: 'plan_fathom_pull',
    toolDescription: 'Emit the search plan for this Fathom meeting transcript pull.',
    schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'fathom-pull-plan',
  });
  const parsed = PlanShape.safeParse(res.output);
  if (!parsed.success) throw new FathomAgentUnavailable();
  const { search, dateFrom, dateTo, participant } = parsed.data;
  if (!search && !dateFrom && !dateTo && !participant) throw new FathomSearchRequired();
  return parsed.data as FathomPullPlan;
}

// ---------- 2. search meetings (picker) ----------
// See the file-header verification block for what is/isn't confirmed here.

const LIST_MEETINGS_TOOL = 'FATHOM_LIST_MEETINGS';
const GET_TRANSCRIPT_TOOL = 'FATHOM_GET_RECORDING_TRANSCRIPT';

/** UNVERIFIED: pulls the meetings array out of whichever container key the response actually uses (or `data` itself, if it's already the array). */
function firstArray(data: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** UNVERIFIED field name — guessing title/name/meeting_title in that order. */
function meetingTitle(m: Record<string, unknown>): string {
  const id = m.id ?? m.recording_id ?? '';
  return String(m.title ?? m.name ?? m.meeting_title ?? `Fathom meeting ${id}`).trim();
}

/** UNVERIFIED field name — guessing id/recording_id in that order. */
function meetingId(m: Record<string, unknown>): string {
  return String(m.id ?? m.recording_id ?? '').trim();
}

/** UNVERIFIED field name — guessing created_at/recorded_at/scheduled_start_time/date in that order. */
function meetingDate(m: Record<string, unknown>): string {
  return String(m.created_at ?? m.recorded_at ?? m.scheduled_start_time ?? m.date ?? '').slice(0, 10);
}

/** UNVERIFIED field name — guessing participants/invitees/calendar_invitees/attendees in that order. */
function meetingParticipants(m: Record<string, unknown>): string[] {
  const candidates = [m.participants, m.invitees, m.calendar_invitees, m.attendees];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return (c as unknown[])
        .map((p) => (typeof p === 'string' ? p : String((p as Record<string, unknown> | undefined)?.name ?? (p as Record<string, unknown> | undefined)?.email ?? '')))
        .filter(Boolean);
    }
  }
  return [];
}

/**
 * Search Composio for meetings matching the plan; returns picker rows so the
 * caller can offer "which meeting did you mean" rather than auto-selecting.
 * FATHOM_LIST_MEETINGS has no free-text search param (only structural
 * filters — teams, recorded_by, created_after/before, invitee domains — see
 * the header block), so `search`/`participant` are applied CLIENT-SIDE
 * against whichever fields the response actually carries.
 */
export async function fetchFathomMeetings(
  plan: FathomPullPlan,
  userId: string,
  connectedAccountId: string,
): Promise<FathomMeetingOption[]> {
  if (testHooks?.meetingsFetcher) return testHooks.meetingsFetcher(plan, userId, connectedAccountId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(LIST_MEETINGS_TOOL, {
    userId,
    connectedAccountId,
    arguments: {
      ...(plan.dateFrom ? { created_after: `${plan.dateFrom}T00:00:00Z` } : {}),
      ...(plan.dateTo ? { created_before: `${plan.dateTo}T23:59:59Z` } : {}),
      // recorded_by narrows by the meeting's RECORDER (documented), not
      // general attendees — passed as a best-effort structural hint only;
      // the authoritative narrowing for "a call with Acme" happens
      // client-side below against meetingParticipants() (UNVERIFIED fields).
      ...(plan.participant ? { recorded_by: [plan.participant] } : {}),
    },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`fathom tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const raw = firstArray(result.data, ['items', 'meetings', 'recordings']);
  const searchTerm = plan.search?.toLowerCase().trim();
  const participantTerm = plan.participant?.toLowerCase().trim();
  const matched = raw.filter((m) => {
    if (searchTerm && !meetingTitle(m).toLowerCase().includes(searchTerm)) return false;
    if (participantTerm && !meetingParticipants(m).join(' ').toLowerCase().includes(participantTerm)) return false;
    return true;
  });
  return matched
    .slice(0, MAX_MEETINGS)
    .map((m) => {
      const parts = meetingParticipants(m);
      return {
        id: meetingId(m),
        title: meetingTitle(m),
        meta: [meetingDate(m), parts.length ? parts.join(', ') : null].filter(Boolean).join(' · '),
      };
    })
    .filter((m) => m.id);
}

/** Alias: "list" reads better from a picker-focused caller, "fetch" from a plan-pipeline caller — same function, per the task's naming. */
export const listFathomMeetings = fetchFathomMeetings;

/** UNVERIFIED transcript segment shape — see file-header block. Docs confirmed only that `speaker` is an object with `display_name`. */
function renderTranscript(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (Array.isArray(payload)) {
    return (payload as Array<Record<string, unknown>>)
      .map((seg) => {
        const speakerRaw = seg.speaker;
        const speaker =
          speakerRaw && typeof speakerRaw === 'object'
            ? String((speakerRaw as Record<string, unknown>).display_name ?? 'Unknown speaker')
            : String(speakerRaw ?? 'Unknown speaker');
        const text = String(seg.text ?? seg.content ?? seg.line ?? '').trim();
        const timestamp = seg.timestamp ?? seg.start_time ?? seg.time ?? null;
        const prefix = timestamp != null ? `[${timestamp}] ` : '';
        return `${prefix}${speaker}: ${text}`;
      })
      .filter((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim().length > 0)
      .join('\n');
  }
  return '';
}

/**
 * Fetch the full transcript for ONE chosen meeting — producing the single
 * {id, title, meta, snippet, body} item the generic preview/pull UI expects.
 * Every meeting pulled becomes its own document (see the file-header note on
 * why this connector has no aggregate mode, unlike GitHub PR-mode).
 */
export async function fetchFathomTranscript(
  meetingId: string,
  userId: string,
  connectedAccountId: string,
): Promise<FathomLiveItem> {
  if (testHooks?.transcriptFetcher) return testHooks.transcriptFetcher(meetingId, userId, connectedAccountId);
  const recordingId = Number(meetingId);
  if (!Number.isFinite(recordingId)) throw new FathomMeetingNotFound(meetingId);
  const composio = getComposioClient();
  const result = await composio.tools.execute(GET_TRANSCRIPT_TOOL, {
    userId,
    connectedAccountId,
    arguments: { recording_id: recordingId },
    dangerouslySkipVersionCheck: true,
  });
  if (!result.successful) {
    throw new Error(`fathom tool call failed: ${result.error ?? 'unknown error'}`);
  }
  const data = result.data as Record<string, unknown> | undefined;
  // UNVERIFIED container key — guessed 'transcript'; falls back to treating
  // `data` itself as the segment array/string if that key is absent.
  const payload = data && 'transcript' in data ? (data as Record<string, unknown>).transcript : data;
  const text = renderTranscript(payload);
  const title = String(data?.title ?? data?.meeting_title ?? data?.name ?? `Fathom meeting ${meetingId}`);
  const capped = text.length > BODY_CHAR_CAP ? `${text.slice(0, BODY_CHAR_CAP)}\n…[truncated]` : text;
  return {
    id: meetingId,
    title,
    meta: `Fathom recording ${meetingId}`,
    snippet: capped.replace(/\s+/g, ' ').slice(0, 140),
    body: [`Fathom meeting: ${title}`, `Recording id: ${meetingId}`, '', text].join('\n'),
  };
}

// ---------- preview → pull handoff ----------
// Same TTL-cache pattern as github-live.ts's cacheGithubPreview/
// getGithubPreview: the search step (fetchFathomMeetings) is cached by
// (key, query) so a subsequent pick-one pull doesn't re-run the LLM plan.

type CachedPreview = { query: string; plan: FathomPullPlan; items: FathomMeetingOption[]; expires: number };
const previewCache = new Map<string, CachedPreview>();

export function cacheFathomPreview(key: string, entry: Omit<CachedPreview, 'expires'>): void {
  previewCache.set(key, { ...entry, expires: Date.now() + PREVIEW_TTL_MS });
}

export function getFathomPreview(key: string, query: string): CachedPreview | null {
  const hit = previewCache.get(key);
  if (!hit || hit.expires < Date.now() || hit.query !== query) return null;
  return hit;
}

export function fathomRunRef(item: FathomLiveItem): string {
  return `fathom: ${item.title} — ${new Date().toISOString().slice(0, 10)}`;
}
