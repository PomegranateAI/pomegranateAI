/**
 * Shared contracts for the Pomegranate Slack surface.
 *
 * Modules tagged [shared] in the build plan import ONLY from this file and
 * other [shared] modules — never from `@slack/bolt`. That discipline is what
 * lets these modules later move to `surfaces/shared` verbatim (DESIGN §11.1).
 *
 * The result types mirror the subset of `app/server/src/lib/schemas.ts` that
 * the surface consumes. Validated live by `test/contract.mjs`.
 */

// ---- synthesis result shapes (from the app) ----
export type Flag = 'red' | 'yellow' | 'green';

export type FeedbackCategory =
  | 'decisions'
  | 'goals_priorities'
  | 'positioning'
  | 'brand_voice'
  | 'context_recency';

export interface Finding {
  category: FeedbackCategory;
  flag: Flag;
  node_id: string | null;
  quote_from_deliverable: string;
  summary: string;
  source_link?: string;
}

export interface ReviewResult {
  id: string;
  findings: Finding[];
}

export interface QueryResult {
  answer: string;
  cited_node_ids: string[];
  has_answer: boolean;
}

export type DeliverableKind =
  | 'prd'
  | 'exec_update'
  | 'campaign'
  | 'sales_email'
  | 'deck'
  | 'other';

// ---- curation shapes (MCP ingest/candidate tools) ----
export interface IngestResult {
  candidates: number;
  document_id: string;
}

export interface CandidateSummary {
  id: string;
  flag: Flag;
  type: string;
  summary: string;
  source_quote: string;
  source_ref: string;
  conflicts_with: string | null;
  reason: string | null;
  created_at: string;
}

export interface ListCandidatesResult {
  status: string;
  total: number;
  candidates: CandidateSummary[];
}

/** Outcome of approve/reject. `already_resolved` maps the app's 409. */
export type ResolveOutcome =
  | { ok: true; node_id?: string; summary?: string }
  | { ok: false; reason: 'already_resolved'; status: string }
  | { ok: false; reason: 'not_found' };

// ---- command model ----
export type Verb =
  | 'review'
  | 'getcontext'
  | 'ingest'
  | 'pending'
  | 'listen'
  | 'stoplisten'
  | 'listening';

/** Sharing tier for ingested content (mirrors the server + web app). */
export type Audience = 'only_me' | 'private' | 'team';

export interface Command {
  verb: Verb;
  /** Optional audience from an `ingest as <only me|private|team>` prefix. */
  audience?: Audience;
  /**
   * Slack user id of the subject named in `from @x` (e.g. "U_ALICE").
   * Null when the verb allows omitting the clause (ingest/pending), in which
   * case the requester is the subject — those verbs are self-workspace-only.
   */
  subjectUserId: string | null;
  /** Message text with the bot mention, verb keyword, and `from @x` removed. */
  remainder: string;
}

// ---- config ----
export interface TeamCfg {
  slack_team_id: string;
  pomegranate_api_url: string;
}

export interface UserCfg {
  slack_team_id: string;
  slack_user_id: string;
  slack_handle?: string;
  pomegranate_user_id: string;
  pomegranate_workspace_id: string;
  mcp_token_env: string;
}

export interface Config {
  teams: TeamCfg[];
  users: UserCfg[];
}

// ---- resolved handles ----
/** Everything the client needs to query one subject's canon. Opaque to handlers. */
export interface CanonHandle {
  workspaceId: string;
  subjectUserId: string; // the subject's Pomegranate user id
  token: string; // MCP bearer token scoped to workspaceId
  apiBaseUrl: string;
}

/** "Who is asking" — passed as the on_behalf_of claim (future req #3). */
export interface RequesterRef {
  pomegranateUserId: string | null;
}

// ---- payloads ----
export type Payload =
  | { kind: 'text'; text: string }
  | { kind: 'file'; name: string; text: string };

// ---- handler replies ----
/** What a verb handler returns: fallback text plus optional Block Kit blocks. */
export interface Reply {
  text: string;
  blocks?: unknown[];
}

// ---- the outbound client ----
export interface PomegranateClient {
  review(
    canon: CanonHandle,
    req: RequesterRef,
    deliverable: string,
    kind?: DeliverableKind,
  ): Promise<ReviewResult>;
  getContext(
    canon: CanonHandle,
    req: RequesterRef,
    payload: string,
  ): Promise<QueryResult>;
  ingest(
    canon: CanonHandle,
    req: RequesterRef,
    source: string,
    opts?: {
      sourceRef?: string;
      sourceKind?: 'doc' | 'slack' | 'transcript' | 'interaction';
      audience?: Audience;
    },
  ): Promise<IngestResult>;
  listCandidates(
    canon: CanonHandle,
    req: RequesterRef,
    opts?: { limit?: number },
  ): Promise<ListCandidatesResult>;
  approveCandidate(canon: CanonHandle, id: string): Promise<ResolveOutcome>;
  rejectCandidate(canon: CanonHandle, id: string): Promise<ResolveOutcome>;
}

// ---- the Slack-decoupled context handlers operate on ----
export interface SlackFileRef {
  name: string;
  mimetype?: string;
  url_private?: string;
  size?: number;
}

export interface MentionContext {
  /** Raw message text including the bot mention and `<@U…>` mentions. */
  text: string;
  files: SlackFileRef[];
  /** Slack user id of the person who sent the command (the requester). */
  requesterUserId: string;
  teamId: string;
  /** Channel (or DM) the mention was posted in — listen verbs subscribe it. */
  channelId: string;
  /** Stable thread identity (`channel:thread_root_ts`) — the surface agent's
   *  conversation key, so follow-ups in one thread share memory. */
  threadKey: string;
  /** A stable id for this event, used for retry de-duplication. */
  eventId: string;
  /** Add an emoji reaction to the triggering message (ack). */
  react(emoji: string): Promise<void>;
  /**
   * Post a reply in the triggering message's thread. `blocks` (Slack Block
   * Kit) is optional; `text` always carries the notification-safe fallback.
   */
  reply(text: string, blocks?: unknown[], username?: string): Promise<void>;
  /**
   * Post a placeholder reply and return an updater that rewrites it in place
   * (chat.update) — the relay's "Thinking…" → final-answer pattern.
   */
  replyEditable(text: string): Promise<(text: string, blocks?: unknown[]) => Promise<void>>;
  /** Download a Slack-hosted file and return its extracted text. */
  fetchFileText(file: SlackFileRef): Promise<string>;
}

// ---- the surface-agent relay (server-side LLM over the MCP tool catalog) ----

/** What POST /agent/surface/messages returns. */
export interface SurfaceMessageResult {
  reply: string;
  assistant_nickname?: string | null;
  receipts?: Array<Record<string, unknown>>;
  pending_confirmation?: { tool: string };
  unmapped?: boolean;
  needs_default?: boolean;
  folder?: { id: string; name: string };
}

/** What POST /agent/surface/actions returns. */
export interface SurfaceActionResult {
  ok: boolean;
  result: Record<string, unknown>;
}

// ---- block-action (button click) context, decoupled from Bolt ----
export interface ActionContext {
  teamId: string;
  /** Slack user id of the person who clicked the button. */
  actorUserId: string;
  /** Candidate id carried in the button's `value`. */
  candidateId: string;
  action: 'approve' | 'reject';
  /** Post a short follow-up in the source message's thread. */
  reply(text: string): Promise<void>;
  /**
   * Rewrite the source message's blocks (e.g. swap a candidate's buttons for
   * a resolution line). Best-effort — failures must not abort the action.
   */
  updateMessageBlocks(
    mutate: (blocks: unknown[]) => unknown[],
  ): Promise<void>;
}
