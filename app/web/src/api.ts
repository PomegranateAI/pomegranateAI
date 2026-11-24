// The dev server / reverse proxy maps '/api' → the server. An embedding host
// can inject window.pomegranate.apiBase pointing at its own server
// (same origin), so calls go straight there with no '/api' prefix.
const BASE = (globalThis as { pomegranate?: { apiBase?: string } }).pomegranate?.apiBase ?? '/api';

import type { Audience } from './audience.js';

/** Privacy for notes added from the app when the destination folder has no
 *  default_audience of its own. */
export const APP_DEFAULT_AUDIENCE: Audience = 'only_me';

// ── Context profile shapes (spec B2) ──────────────────────────────────────
export type AttrDef = {
  key: string;
  label: string;
  type: 'string' | 'date' | 'enum' | 'object';
  values?: string[]; // for type 'enum'
  description?: string;
  required?: boolean;
};
export type NodeKindDef = {
  key: string;
  label: string;
  label_plural: string;
  description: string;
  color: 1 | 2 | 3 | 4 | 5 | 6;
  subkinds?: Array<{ key: string; label: string; description?: string }>;
  categories?: Array<{ key: string; label: string }>;
  attrs?: AttrDef[];
  buckets?: Array<{ key: string; label: string; match?: unknown }>;
  body_spec?: string;
};
export type DimDef = { key: string; label: string; description: string };

// ── Document registry + evidence ledger shapes (server: documents endpoint) ──
// ── Wiki (spec-wiki.md / wiki-milestones.md M1) ──
export interface WikiSection {
  key?: string;
  heading: string;
  intent?: string;
}
export interface WikiPageRecord {
  id: string;
  kind: 'category' | 'page';
  parent_id: string | null;
  slug: string;
  title: string;
  anchor: { kind?: string; scope_value?: string; doc_id?: string } | null;
  sections: WikiSection[] | null;
  source_doc_ids: string[];
  sort_order: number;
  visibility: 'team' | 'private' | 'only_me';
  status: 'active' | 'archived';
}
export interface WikiTreeNode extends WikiPageRecord {
  children: WikiTreeNode[];
}
export interface WikiBlockContent {
  section_key?: string;
  text?: string;
  items?: string[];
  url?: string;
  alt?: string;
}
export interface WikiBlockRecord {
  id: string;
  type: string;
  content: WikiBlockContent;
  cited_node_ids: string[];
  provenance: string;
  review_state: string;
}
export interface WikiTreeResponse {
  wiki: { profile_id: string; status: string; content_watermark: string | null; updated_at: string } | null;
  stale: boolean;
  latest_change: string;
  tree: WikiTreeNode[];
}

// ── The Report (spec-data-agents-and-subfolder-wiki.md §4.3) ──
// Deliberately NOT a page tree: one document, regenerated wholesale. Mirrors
// server phase1/report/types.ts.
export interface ReportBlock {
  type: 'paragraph' | 'list';
  text?: string;
  items?: string[];
  cited_node_ids: string[];
}
export interface ReportGroup {
  key: string;
  label: string;
  blocks: ReportBlock[];
}
export interface ReportSection {
  kind_key: string;
  label: string;
  color: 1 | 2 | 3 | 4 | 5 | 6;
  groups: ReportGroup[];
}
export interface ReportContent {
  sections: ReportSection[];
  has_sources: boolean;
}
export interface ReportRecord {
  content: ReportContent;
  generated_at: string;
}

// ── Subscribe to Updates (spec-subscribe-to-updates.md / U2) ──
export type UpdateMedium = 'email' | 'slack';
// 'autonomous' sends each update straight away; 'review' holds it for the owner
// to approve (they're notified in-app + on their channel) before it's sent.
export type UpdateApprovalMode = 'autonomous' | 'review';
// Delivery lifecycle: 'sent' (delivered), 'pending' (awaiting approval),
// 'discarded' (owner rejected a pending update).
export type UpdateDeliveryStatus = 'pending' | 'sent' | 'discarded';
// Which agent owns a watch. 'get' is the collab agent (Get updates): I follow a
// topic and the update comes to me. 'give' is the work agent (Give updates): I
// broadcast updates about my own folder to a list of teammates.
export type UpdateKind = 'get' | 'give';
export interface UpdateTarget {
  workspace_id: string;
  subgraph_id: string;
}
export interface UpdateSubscription {
  id: string;
  topic: string;
  targets: UpdateTarget[];
  cadence_ms: number;
  medium: UpdateMedium;
  kind: UpdateKind;
  /** Recipients, comma-separated. One address for 'get'; a list for 'give'. */
  destination: string | null;
  approval_mode: UpdateApprovalMode;
  status: 'active' | 'paused';
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}
export interface UpdateSubscriptionInput {
  topic: string;
  targets?: UpdateTarget[];
  /** Folder ids/names, teammate emails, @handles, display names to watch. */
  target_refs?: string[];
  cadence_ms?: number;
  medium?: UpdateMedium;
  kind?: UpdateKind;
  destination?: string | null;
  /** Many recipients — the 'give' agent's broadcast list. Wins over destination. */
  recipients?: string[];
  approval_mode?: UpdateApprovalMode;
}
/** A named, reusable audience for the 'give' agent. */
export interface RecipientList {
  id: string;
  name: string;
  recipients: string[];
  created_at: string;
  updated_at: string;
}
export interface UpdateDelivery {
  id: string;
  subscription_id: string;
  window_from: string | null;
  window_to: string;
  title: string;
  body: string;
  cited_node_ids: string[];
  change_count: number;
  medium: UpdateMedium;
  status: UpdateDeliveryStatus;
  delivered_at: string | null;
  view_count: number;
  click_count: number;
  opened_at: string | null;
  created_at: string;
}

export type DocumentRecord = {
  id: string;
  source_ref: string;
  source_kind: string;
  version: number;
  summary: string | null;
  stakeholders: string[];
  created_at: string;
  // Recency of the last (re-)ingest; the list is ordered by it so a re-added
  // source floats to the top. null on pre-column rows (falls back to created_at).
  last_ingested_at?: string | null;
  // Whether GET /documents/:id/content can serve this document's raw text —
  // false only for text-channel ingests from before canonical-text persistence.
  downloadable?: boolean;
  // Extraction outcomes across every subgraph — drives the per-source
  // processing-status badge (needs review / integrated / nothing extracted).
  // Absent on older server responses.
  candidates?: { pending: number; approved: number; rejected: number };
};
// ── "From your apps" (Sources view) ──
export type AppSourceItem = { id: string; title: string; meta: string; snippet: string };
export type NodeEvidence = {
  document_id: string;
  source_ref: string | null;
  source_kind: string | null;
  quote: string;
  captured_at: string;
  document: {
    id: string;
    source_ref: string;
    summary: string | null;
    version: number;
    stakeholders: string[];
  } | null;
};
export type ScopeDef = { key: string; label: string; kind_keys: string[] | 'all' };
export type ContextProfile = {
  id: string;
  name: string;
  description: string;
  shape?: string;
  routing_hint?: string;
  kinds: NodeKindDef[];
  edge_kinds?: Array<{
    key: string;
    label: string;
    description: string;
    src_kinds: string[] | 'any';
    dst_kinds: string[] | 'any';
    directed?: boolean;
  }>;
  /** See ContextProfile.edges_deliberately_empty (schemas.ts) — an empty
   *  edge_kinds is a design choice, not an omission, when set. */
  edges_deliberately_empty?: boolean;
  source_types?: Array<{
    key: string;
    label: string;
    description: string;
    extraction_guidance: string;
    source_kinds?: string[];
  }>;
  feedback_dimensions: DimDef[];
  review_kinds: string[];
  query_scopes: ScopeDef[];
  flag_semantics: { red: string; yellow: string; green: string };
  seed_questions: string[];
};

/** Response shape shared by /ingest and /ingest/file. The plain-router fields
 *  (candidates, pending_approval, ...) are present either way; the
 *  `agent`-tagged fields only show up when `instructions` drove the ingest. */
export type IngestResult = {
  candidates: number;
  document_id?: string;
  routed?: unknown;
  zero_yield?: boolean;
  notice?: string | null;
  pending_approval?: boolean;
  pending_route_id?: string;
  agent?: boolean;
  message?: string;
  subgraph?: { id: string; name: string } | null;
};
export type Subgraph = {
  id: string;
  slug: string;
  name: string;
  /** User-authored description of the subfolder (defaults to 'miscellaneous'). */
  description: string;
  /** Persisted LLM Overview synthesis, refreshed each overview call — unless
   *  generated_description_locked, in which case it holds the last manual
   *  edit and is left alone by the automatic refresh. Null until the
   *  subfolder has a graph to summarize. */
  generated_description: string | null;
  generated_description_at: string | null;
  /** True once a human hand-edits generated_description; blocks the automatic
   *  refresh until "Regenerate" clears it. */
  generated_description_locked: boolean;
  /** Whether automatic routing (ingest router / query classifier) may pick
   *  this folder unprompted. An explicit #slug pin or a direct pick always
   *  reaches it either way. */
  routable: boolean;
  /** Folder-level default privacy for new notes; null = not set (the app
   *  then falls back to 'only_me'). */
  default_audience?: Audience | null;
  status: string;
  profile_id: string;
  node_count: number;
};
export type DocumentRouting = {
  subgraph_id: string;
  slug: string;
  name: string;
  routed_by: string;
  router_reason: string | null;
  created_at: string;
};
/** A routing decision the router couldn't auto-apply — new folder or a
 *  low-confidence pick — held for a human to approve, choose, or reject. */
export type PendingRoute = {
  id: string;
  document_id: string;
  reason: string;
  proposed_targets: string[];
  proposed_new_folder: { name: string; description: string } | null;
  low_confidence_targets: string[];
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  ingested_by?: string | null;
  /** Email of whoever ingested the held document (null for legacy rows). */
  ingested_by_email?: string | null;
  /** Server-computed: may the current user approve/choose/reject this row?
   *  Only the ingester or a directory owner/admin can. */
  can_resolve?: boolean;
};

let _session: string | null = localStorage.getItem('pmg_session');
let _workspaceId: string | null = localStorage.getItem('pmg_ws');
// Active subgraph (multi-profile partition). null = the workspace's 'default'
// subgraph. Sent as x-subgraph-id so every read/write scopes to it.
let _subgraphId: string | null = localStorage.getItem('pmg_sg');

export function setSession(s: string | null) {
  _session = s;
  if (s) localStorage.setItem('pmg_session', s);
  else localStorage.removeItem('pmg_session');
}
export function getSession(): string | null { return _session; }

/** Fired on `window` when the server rejects our session (expired, revoked,
 *  or the account is gone). App listens and drops back to the login screen,
 *  instead of leaving the user on a home page where every action errors. */
export const SESSION_EXPIRED_EVENT = 'pmg:session-expired';
// The auth middleware's "you are not signed in" answers. Other 401s
// (wrong current password, MFA challenge, expired magic link) are answers to
// a specific action and must not sign the user out.
const SESSION_REJECTED = new Set(['unauthorized', 'invalid session', 'unknown user', 'unknown_user']);
function expireSessionOn401(status: number, body: string) {
  if (status !== 401 || !_session) return;
  try {
    const j = JSON.parse(body) as { error?: string };
    if (!j.error || !SESSION_REJECTED.has(j.error)) return;
  } catch {
    return;
  }
  setSession(null);
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

// Signed-in user id (from /auth/exchange). Used to exclude yourself from the
// "share with…" member picker in the cloud app. Cleared on sign-out.
let _userId: string | null = localStorage.getItem('pmg_user');
export function setUserId(id: string | null) {
  _userId = id;
  if (id) localStorage.setItem('pmg_user', id);
  else localStorage.removeItem('pmg_user');
}
export function getUserId(): string | null { return _userId; }

export function setWorkspaceId(id: string | null) {
  _workspaceId = id;
  if (id) localStorage.setItem('pmg_ws', id);
  else localStorage.removeItem('pmg_ws');
  // Switching workspace resets the active subgraph to the workspace default.
  setSubgraphId(null);
}
export function getWorkspaceId(): string | null { return _workspaceId; }

export function setSubgraphId(id: string | null) {
  _subgraphId = id;
  if (id) localStorage.setItem('pmg_sg', id);
  else localStorage.removeItem('pmg_sg');
}
export function getSubgraphId(): string | null { return _subgraphId; }

/** `?subgraph=` query suffix — explicit per-call scoping that overrides the
 * Library-pinned `x-subgraph-id` header (the unified Curate inbox spans every
 * subgraph and routes each action to its source's subgraph). */
function sgq(subgraph: string): string {
  return `?subgraph=${encodeURIComponent(subgraph)}`;
}

type SignInResult = {
  session: string;
  user: { id: string; email: string };
  /** Set when policy requires MFA and this account has no password yet. */
  mfa_enrollment_required?: boolean;
};

/** The password was right; the account's second step is a link emailed to
 *  it. `devToken` is that link's token, returned inline only when the server
 *  has no mailer (local dev). */
export class MfaRequiredError extends Error {
  constructor(readonly devToken: string | null) {
    super('mfa_required');
  }
}

/** Turn the server's 401 { error: 'mfa_required' } into a MfaRequiredError
 *  the login screen can branch on. */
async function withMfaChallenge<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    const brace = msg.indexOf('{');
    if (msg.startsWith('401') && brace >= 0) {
      try {
        const body = JSON.parse(msg.slice(brace));
        if (body?.error === 'mfa_required') {
          throw new MfaRequiredError(typeof body.dev_mfa_token === 'string' ? body.dev_mfa_token : null);
        }
      } catch (inner) {
        if (inner instanceof MfaRequiredError) throw inner;
      }
    }
    throw e;
  }
}

async function call<T>(path: string, opts: { method?: string; body?: unknown; noSubgraph?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (_session) headers['Authorization'] = `Bearer ${_session}`;
  if (_workspaceId) headers['x-workspace-id'] = _workspaceId;
  // The Library page pins x-subgraph-id to the selected subgraph; it scopes
  // graph/curation reads to that partition. Workspace-wide surfaces (the Curate
  // inbox + its badge) opt out with noSubgraph so the server spans every
  // subgraph and each per-source action re-scopes via an explicit ?subgraph=.
  if (_subgraphId && !opts.noSubgraph) headers['x-subgraph-id'] = _subgraphId;
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text();
    expireSessionOn401(r.status, text);
    throw new Error(governanceMessage(text) ?? `${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

/** Plain-language errors for directory governance refusals (server: governance.ts). */
function governanceMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: string };
    if (j.error === 'read_only') return 'You have view-only access to this directory: you can view and ask, not add or change.';
    if (j.error === 'mfa_required_for_sensitive_directory')
      return 'This directory is marked sensitive. Turn on two-step verification in Setup → General to open it.';
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * The values the server refused as update recipients (400
 * `recipients_not_allowed`: only members of the directory may receive
 * updates), or null when `err` is some other failure.
 */
export function rejectedRecipients(err: unknown): string[] | null {
  const msg = err instanceof Error ? err.message : '';
  if (!msg.startsWith('400')) return null;
  const brace = msg.indexOf('{');
  if (brace < 0) return null;
  try {
    const j = JSON.parse(msg.slice(brace)) as { error?: string; rejected?: unknown };
    if (j.error !== 'recipients_not_allowed' || !Array.isArray(j.rejected)) return null;
    return j.rejected.map(String);
  } catch {
    return null;
  }
}

async function callForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (_session) headers['Authorization'] = `Bearer ${_session}`;
  if (_workspaceId) headers['x-workspace-id'] = _workspaceId;
  if (_subgraphId) headers['x-subgraph-id'] = _subgraphId;
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: form });
  if (!r.ok) {
    const text = await r.text();
    expireSessionOn401(r.status, text);
    throw new Error(governanceMessage(text) ?? `${r.status} ${r.statusText}: ${text}`);
  }
  return (await r.json()) as T;
}

// ── Team directory (people on the same email domain + their workspaces) ──
export type TeamWorkspace = {
  id: string;
  name: string;
  owner_email: string;
  role: string;
  created_at: string;
  // The signed-in user's own access to this workspace: their membership role, or
  // null if they aren't a member (→ show "Request access"). A member needs no
  // per-folder connector: their own connection already reaches this folder.
  viewer_role: string | null;
  profiles: Array<{ subgraph_id: string; slug: string; name: string; status: string; profile_id: string }>;
};
export type WorkspaceMember = {
  user_id: string;
  email: string;
  role: string;
  display_name?: string | null;
  /** 1 = viewer (view and ask only). */
  read_only?: number;
  /** The directory owner — can't leave or be removed. */
  is_owner?: boolean;
};
export type DirectoryGovernance = { sensitive: boolean; assistants_allowed: boolean; agents_read_only: boolean };
export type AssistantConnection = {
  id: string;
  user_id: string;
  email: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
};
export type TeamUser = {
  user_id: string;
  email: string;
  created_at: string;
  display_name?: string | null;
  slack?: { team_id: string | null; external_id: string; handle: string | null } | null;
  default_folder?: { workspace_id: string; surface: string } | null;
  workspaces: TeamWorkspace[];
};

// ── Me: profile, linked identities, per-surface default folder ─────────────
export type DefaultSurface = 'all' | 'slack' | 'mcp' | 'whatsapp';
export type UserIdentity = {
  id: string;
  user_id: string;
  kind: 'slack' | 'whatsapp';
  team_id: string | null;
  external_id: string;
  handle: string | null;
  created_at: string;
};
export type UserDefault = {
  user_id: string;
  surface: DefaultSurface;
  workspace_id: string;
  subgraph_id: string | null;
  updated_at: string;
};
export type Me = {
  user_id: string;
  email: string;
  is_admin?: boolean;
  display_name: string | null;
  has_password: boolean;
  /** Signed in with an administrator-set password that must be replaced. */
  password_must_change?: boolean;
  identities: UserIdentity[];
  defaults: UserDefault[];
};
export type AdminUser = {
  id: string;
  email: string;
  is_admin: number;
  created_at: string;
  has_password: number;
  workspace_count: number;
};
export type TeamDirectory = {
  domain: string;
  // Whether that domain groups anybody. 'org' = a company domain (same domain,
  // same team). 'personal' = a public mailbox provider (gmail.com, outlook.com,
  // …): strangers share it, so the directory is you alone and teammates arrive
  // by folder invite instead.
  domain_kind: 'org' | 'personal';
  me: { user_id: string; email: string };
  mcp_path: string;
  users: TeamUser[];
};

// ── Ingestion/sharing rules (spec-directory-tracking-and-ingestion-rules.md) ──
// Scope uses the unified 3-tier model (Only me / AI agents / Team). Phase = when
// the rule fires (store = at ingest, use = at retrieval).
export type RuleScope = 'only_me' | 'private' | 'team';
export type RulePhase = 'store' | 'use';
// There is no longer any action but 'shape' — auto_approve/auto_reject/surface
// were removed (they never applied to a live document once every capture
// started auto-applying immediately; see anthropic.ts's runClassifyRule).
export type RuleAction = 'shape';
export type Rule = {
  id: string;
  workspace_id: string;
  instructions: string;
  scopes: RuleScope[];
  phases: RulePhase[];
  action: RuleAction | null;
  target: 'node' | 'source' | 'both';
  enabled: boolean;
  owner_user_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};
// Phase + action are inferred by the model from `instructions` (spec §5.2), so
// they are NOT part of the input — the user only writes the intent and picks a
// scope. They come back populated on the returned Rule.
export type RuleInput = {
  id?: string;
  instructions: string;
  scopes: RuleScope[];
  enabled?: boolean;
  sort_order?: number;
};
// A candidate returned by the dry-run rule test (§5.5). Ephemeral — never
// persisted; ids are `cpv_`/`npv_` previews.
export type RuleTestCandidate = {
  id: string;
  flag: 'red' | 'yellow' | 'green';
  source_quote?: string;
  conflicts_with?: string | null;
  proposed_node: {
    type?: string;
    kind?: string;
    summary?: string;
    title?: string;
    body?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};
export type RuleAnswer = { answer: string; cited_node_ids: string[]; has_answer: boolean };
// The rule test returns a shape that depends on WHAT the rule does (spec §5.5).
export type RuleTestResult =
  | { mode: 'ingestion'; rule_id: string; with_rule: RuleTestCandidate[]; without_rule: RuleTestCandidate[]; zero_yield: boolean }
  | { mode: 'source'; rule_id: string; original: string; processed: string; changed: boolean }
  | { mode: 'use'; rule_id: string; question: string; without_rule_answer: RuleAnswer; with_rule_answer: RuleAnswer };
export type RuleTestMode = RuleTestResult['mode'];

// ── Unified automations (redesign of the Automations tab) ──────────────────
// Supersedes Rule/RuleInput/RuleTestResult above, which are kept as deprecated
// aliases for one release so any other importer keeps compiling. Stage 2 only
// exercises kind='shape' (today's shape/use-phase/curation rules, re-homed);
// apps_pull/slack_listen/track_directory land in later stages.
export type AutomationKind = 'shape' | 'apps_pull' | 'slack_listen' | 'track_directory';
export type Automation = {
  id: string;
  workspace_id: string;
  kind: AutomationKind;
  // shape kind
  instructions: string | null;
  scopes: RuleScope[];
  phases: RulePhase[];
  action: RuleAction | null;
  target: 'node' | 'source' | 'both';
  // ingestion kinds (apps_pull / slack_listen / track_directory) — unused until later stages
  connector: string | null;
  criteria: Record<string, unknown> | null;
  subgraph_id: string | null;
  run_instructions: string | null;
  cadence_ms: number | null;
  status: 'active' | 'paused';
  last_run_at: string | null;
  next_run_at: string | null;
  watermark: string | null;
  fail_count: number;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  device_id: string | null;
  local_path: string | null;
  enabled: boolean;
  owner_user_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};
export type AutomationInput = {
  id?: string;
  instructions: string;
  scopes: RuleScope[];
  enabled?: boolean;
  sort_order?: number;
};
export type AutomationTestResult = RuleTestResult;
export type AutomationRun = {
  id: string;
  workspace_id: string;
  automation_id: string;
  trigger: 'scheduled' | 'manual_run';
  outcome: 'ok' | 'empty' | 'error';
  window_from: string | null;
  window_to: string | null;
  items_seen: number;
  items_ingested: number;
  document_ids: string[];
  candidate_count: number;
  summary: string | null;
  error: string | null;
  created_at: string;
};

export interface MediaJob { id:string; name:string; status:string; error:string|null; asset_id:string; subgraph_id:string }
export interface MediaReaderBinding { capability:'audio'|'image'; enabled:number; version:number; config:{output:'capture'|'log';language?:string} }
export interface MediaAttachment { id:string; name:string; mime:string; bytes:number; href:string; visibility:'private'|'team'; can_share:boolean; has_text?:boolean }

export const api = {
  mediaJobs:(ws:string)=>call<{jobs:MediaJob[]}>(`/workspaces/${ws}/media-jobs`),
  retryMediaJob:(ws:string,id:string)=>call(`/workspaces/${ws}/media-jobs/${id}/retry`,{method:'POST',body:{}}),
  mediaReaders:(ws:string,target:string)=>call<{bindings:MediaReaderBinding[];can_manage:boolean}>(`/workspaces/${ws}/media-readers/${encodeURIComponent(target)}`),
  setMediaReader:(ws:string,target:string,capability:string,body:{enabled:boolean;config:MediaReaderBinding['config']})=>call(`/workspaces/${ws}/media-readers/${encodeURIComponent(target)}/${capability}`,{method:'PUT',body}),
  nodeAssets:(ws:string,node:string)=>call<{assets:MediaAttachment[]}>(`/workspaces/${ws}/graph/${node}/assets`),
  documentAssets:(ws:string,doc:string)=>call<{assets:MediaAttachment[]}>(`/workspaces/${ws}/documents/${doc}/assets`),
  // The data agent's own reading of an attachment — a voice note's transcript,
  // an image's OCR. Absent (404) for media no reader has processed.
  assetText:(ws:string,id:string)=>call<{asset_id:string;name:string;text:string;run_id:string}>(`/workspaces/${ws}/assets/${id}/text`),
  shareAsset:(ws:string,id:string,visibility:'private'|'team')=>call(`/workspaces/${ws}/assets/${id}`,{method:'PATCH',body:{visibility}}),
  assetContent:async(ws:string,id:string):Promise<Blob>=>{
    const headers:Record<string,string>={};if(_session)headers.Authorization=`Bearer ${_session}`;
    const response=await fetch(`${BASE}/workspaces/${ws}/assets/${id}/content`,{headers});
    if(!response.ok){expireSessionOn401(response.status,await response.text());throw new Error('Original unavailable');}return response.blob();
  },
  health: () => call<{ ok: boolean; provider: string }>(`/healthz`),
  requestMagic: (email: string) =>
    call<{ sent: boolean; dev_code?: string }>(`/auth/magic-link`, { method: 'POST', body: { email } }),
  /** Revoke the current session server-side. Best-effort: sign-out must
   *  always clear local state, even when the server is unreachable. */
  logout: async () => {
    try {
      await call<{ ok: true }>(`/auth/logout`, { method: 'POST' });
    } catch {
      /* already invalid, or offline: local sign-out still proceeds */
    }
  },
  /** Revoke every session of the signed-in user, this one included. */
  logoutAll: () => call<{ ok: true; revoked: number }>(`/auth/logout-all`, { method: 'POST' }),
  // Single sign-on: config for the login screen, the redirect that
  // starts it, and the one-time hand-off code the callback leaves in ?sso=.
  ssoConfig: () => call<{ enabled: boolean; required: boolean; label: string }>(`/auth/sso/config`),
  assistantConfig: () => call<{ oauth_only: boolean }>(`/auth/assistant-config`, { noSubgraph: true }),
  ssoStartUrl: () => `${BASE}/auth/sso/start`,
  ssoExchange: async (code: string) => {
    const r = await withMfaChallenge(() => call<SignInResult>(`/auth/sso/exchange`, { method: 'POST', body: { code } }));
    setUserId(r.user.id);
    return r;
  },
  exchange: async (code: string) => {
    const r = await withMfaChallenge(() =>
      call<SignInResult>(`/auth/exchange`, {
        method: 'POST',
        body: { code },
      }),
    );
    setUserId(r.user.id); // remember who we are for the share picker
    return r;
  },
  /** Second sign-in step for an account with MFA on: the token from the
   *  emailed link (`/?mfa=<token>`). */
  verifyMfa: async (mfa_token: string) => {
    const r = await call<SignInResult>(`/auth/mfa/verify`, { method: 'POST', body: { mfa_token } });
    setUserId(r.user.id);
    return r;
  },
  getMfa: () =>
    call<{ enabled: boolean; required: boolean; has_password: boolean }>(`/me/mfa`, { noSubgraph: true }),
  mfaEnable: () => call<{ ok: true }>(`/me/mfa/enable`, { method: 'POST', noSubgraph: true }),
  mfaDisable: (current_password: string) =>
    call<{ ok: true }>(`/me/mfa/disable`, { method: 'POST', body: { current_password }, noSubgraph: true }),
  // Password sign-in — a second path onto the same session mechanism as
  // exchange() above. Only works for an account that already has a password
  // set (today, by an admin at provisioning time; see Setup for changing it).
  // Forgotten password: email a single-use reset link (same answer whether or
  // not the account exists; dev_reset_token only when no mailer is set up),
  // check a link before asking for the new password, then spend it.
  forgotPassword: (email: string) =>
    call<{ sent: boolean; dev_reset_token?: string }>(`/auth/password/forgot`, { method: 'POST', body: { email }, noSubgraph: true }),
  checkPasswordReset: (token: string) =>
    call<{ valid: boolean }>(`/auth/password/reset/check`, { method: 'POST', body: { token }, noSubgraph: true }),
  resetPassword: (token: string, new_password: string) =>
    call<{ ok: boolean }>(`/auth/password/reset`, { method: 'POST', body: { token, new_password }, noSubgraph: true }),
  loginPassword: async (email: string, password: string) => {
    const r = await withMfaChallenge(() =>
      call<SignInResult>(`/auth/password/login`, {
        method: 'POST',
        body: { email, password },
      }),
    );
    setUserId(r.user.id);
    return r;
  },
  setPassword: (new_password: string, current_password?: string) =>
    call<{ ok: boolean }>(`/me/password`, {
      method: 'PUT',
      body: current_password ? { current_password, new_password } : { new_password },
      noSubgraph: true,
    }),
  listWorkspaces: () =>
    call<{ workspaces: Array<{ id: string; name: string; can_manage?: boolean }> }>(
      `/workspaces`,
    ),
  getAiAccess: (wsId: string) => call<{ ai_allowed: boolean }>(`/workspaces/${wsId}/ai-access`, { noSubgraph: true }),
  setAiAccess: (wsId: string, ai_allowed: boolean) =>
    call<{ ai_allowed: boolean }>(`/workspaces/${wsId}/ai-access`, { method: 'PUT', body: { ai_allowed }, noSubgraph: true }),
  // Everyone on the caller's email domain + each person's workspaces, with the
  // MCP endpoint and profile type per workspace. Not workspace-scoped, so skip
  // the x-subgraph-id header.
  teamDirectory: () => call<TeamDirectory>(`/team/directory`, { noSubgraph: true }),
  // Own profile: display name, linked identities, per-surface default folder.
  getMe: () => call<Me>(`/me`, { noSubgraph: true }),
  listAdminUsers: () => call<{ users: AdminUser[] }>(`/admin/users`, { noSubgraph: true }),
  // `password` empty → the server generates one. `send_invite` emails the
  // account its address and temporary password; `emailed` says if it went.
  createAdminUser: (email: string, password: string, send_invite: boolean) =>
    call<{ user: { id: string; email: string }; temporary_password: string; emailed: boolean }>(`/admin/users`, {
      method: 'POST',
      body: { email, password, send_invite },
      noSubgraph: true,
    }),
  resetAdminUserPassword: (id: string, password: string, send_invite: boolean) =>
    call<{ ok: boolean; temporary_password: string; emailed: boolean }>(`/admin/users/${encodeURIComponent(id)}/password`, {
      method: 'PUT',
      body: { password, send_invite },
      noSubgraph: true,
    }),
  adminUserDeletion: (id: string) =>
    call<{ user: { id: string; email: string }; owned_workspaces: Array<{ id: string; name: string; member_count: number }> }>(`/admin/users/${encodeURIComponent(id)}/deletion`, { noSubgraph: true }),
  deleteAdminUser: (id: string, confirm_email: string) =>
    call<{ ok: boolean; deleted_workspaces: number }>(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', body: { confirm_email }, noSubgraph: true }),
  patchMe: (displayName: string | null) =>
    call<{ ok: boolean; display_name: string | null }>(`/me`, {
      method: 'PATCH',
      body: { display_name: displayName },
      noSubgraph: true,
    }),
  // Identity linking: mint a single-use code the person sends to the bot from
  // the Slack account / phone being linked (proof of ownership).
  createIdentityLinkCode: (kind: 'slack' | 'whatsapp') =>
    call<{ code: string; expires_at: string; instructions: string }>(`/me/identities/${kind}/link-code`, {
      method: 'POST',
      noSubgraph: true,
    }),
  unlinkIdentity: (kind: 'slack' | 'whatsapp') =>
    call<{ ok: boolean; removed: number }>(`/me/identities/${kind}`, { method: 'DELETE', noSubgraph: true }),
  putDefault: (surface: DefaultSurface, workspaceId: string, subgraphId?: string) =>
    call<{ default: UserDefault }>(`/me/defaults/${surface}`, {
      method: 'PUT',
      body: { workspace_id: workspaceId, ...(subgraphId ? { subgraph_id: subgraphId } : {}) },
      noSubgraph: true,
    }),
  deleteDefault: (surface: DefaultSurface) =>
    call<{ ok: boolean }>(`/me/defaults/${surface}`, { method: 'DELETE', noSubgraph: true }),
  // Connected apps — the caller's Gmail IMAP credential (Settings). The app
  // password is write-only: the GET returns only whether/which address is
  // connected, never the secret.
  getGmailConnection: () =>
    call<{ configured: boolean; address: string | null }>(`/me/apps/gmail`, { noSubgraph: true }),
  putGmailConnection: (address: string, appPassword: string) =>
    call<{ configured: boolean; address: string }>(`/me/apps/gmail`, {
      method: 'PUT',
      body: { address, app_password: appPassword },
      noSubgraph: true,
    }),
  deleteGmailConnection: () =>
    call<{ ok: boolean }>(`/me/apps/gmail`, { method: 'DELETE', noSubgraph: true }),
  // Composio-backed OAuth connectors (GitHub, Slack, ...) — connected inline
  // in Add Sources, not Settings. ONE generic `:toolkit` route family backs
  // every connector; see routes.ts's COMPOSIO_CONNECTORS registry.
  getAppConnection: (toolkit: string) =>
    call<{ configured: boolean; status: string | null }>(`/me/apps/${toolkit}`, { noSubgraph: true }),
  connectApp: (toolkit: string, callbackUrl?: string) =>
    call<{ redirect_url: string | null }>(`/me/apps/${toolkit}/connect`, {
      method: 'POST',
      body: callbackUrl ? { callback_url: callbackUrl } : {},
      noSubgraph: true,
    }),
  refreshAppConnection: (toolkit: string) =>
    call<{ configured: boolean; status: string | null }>(`/me/apps/${toolkit}/refresh`, {
      method: 'POST',
      noSubgraph: true,
    }),
  disconnectApp: (toolkit: string) =>
    call<{ ok: boolean }>(`/me/apps/${toolkit}`, { method: 'DELETE', noSubgraph: true }),
  listAppPickerItems: (toolkit: string) =>
    call<{ items: unknown[] }>(`/me/apps/${toolkit}/picker`, { noSubgraph: true }),
  // GitHub-only: branches for a given repo, used by the files-from-branch picker.
  listGithubBranches: (repo: string) =>
    call<{ branches: Array<{ name: string; protected: boolean }> }>(
      `/me/apps/github/branches?repo=${encodeURIComponent(repo)}`,
      { noSubgraph: true },
    ),
  // Ask a workspace owner for access (you're not a member). Emails the owner; in
  // dev with no mail provider the response carries a preview instead.
  requestAccess: (wsId: string, message?: string) =>
    call<{ sent: boolean; preview?: { to: string; subject: string; text: string } }>(
      `/workspaces/${wsId}/request-access`,
      { method: 'POST', body: message ? { message } : {}, noSubgraph: true },
    ),
  // Workspace members (the share-workspace surface).
  listMembers: (wsId: string) =>
    call<{ members: WorkspaceMember[] }>(`/workspaces/${wsId}/members`, { noSubgraph: true }),
  addMember: (wsId: string, email: string, role: string = 'member') =>
    call<WorkspaceMember>(`/workspaces/${wsId}/members`, {
      method: 'POST',
      body: { email, role },
      noSubgraph: true,
    }),
  removeMember: (wsId: string, userId: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/members/${userId}`, { method: 'DELETE', noSubgraph: true }),
  // role: 'workspace_admin' | 'leader' | 'member' | 'viewer'
  setMemberRole: (wsId: string, userId: string, role: string) =>
    call<{ user_id: string; role: string }>(`/workspaces/${wsId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
      noSubgraph: true,
    }),
  getGovernance: (wsId: string) => call<DirectoryGovernance>(`/workspaces/${wsId}/governance`, { noSubgraph: true }),
  setGovernance: (wsId: string, flags: DirectoryGovernance) =>
    call<DirectoryGovernance>(`/workspaces/${wsId}/governance`, { method: 'PUT', body: flags, noSubgraph: true }),
  listAssistantConnections: (wsId: string) =>
    call<{ connections: AssistantConnection[] }>(`/workspaces/${wsId}/assistant-connections`, { noSubgraph: true }),
  revokeAssistantConnection: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/assistant-connections/${id}`, { method: 'DELETE', noSubgraph: true }),
  // Multi-profile onboarding: pass one or more profile ids. The first becomes
  // the workspace's 'default' subgraph; each additional one gets its own.
  // `descriptions` maps a profile id → the user's subfolder description; blank
  // or missing entries default to 'miscellaneous' server-side.
  createWorkspace: (name: string, profileIds?: string[], descriptions?: Record<string, string>) =>
    call<{ id: string; name: string; profile_id: string; subgraphs: Array<{ subgraph_id: string; slug: string; name: string; description: string; profile_id: string }> }>(`/workspaces`, {
      method: 'POST',
      body: profileIds && profileIds.length ? { name, profile_ids: profileIds, descriptions } : { name },
    }),
  deleteWorkspace: (wsId: string) =>
    call<{ ok: boolean; deleted: Record<string, number> }>(`/workspaces/${wsId}`, { method: 'DELETE' }),

  // ── Subgraphs (multi-profile partitions) ──
  listSubgraphs: (wsId: string, opts?: { includeArchived?: boolean }) =>
    call<{ subgraphs: Subgraph[] }>(`/workspaces/${wsId}/subgraphs${opts?.includeArchived ? '?archived=true' : ''}`),
  createSubgraph: (wsId: string, body: { profile_id: string; name?: string; slug?: string; description?: string }) =>
    call<{ subgraph_id: string; slug: string; name: string; description: string; profile_id: string }>(`/workspaces/${wsId}/subgraphs`, { method: 'POST', body }),
  // Edit a subfolder's name, user description, content-summary override,
  // and/or auto-routing eligibility. At least one field must be given.
  // A non-empty generated_description locks it against the automatic
  // refresh — see regenerateSubgraphSummary to clear that.
  updateSubgraph: (
    wsId: string,
    id: string,
    body: {
      name?: string;
      description?: string;
      generated_description?: string;
      routable?: boolean;
      default_audience?: Audience | null;
    },
  ) =>
    call<{
      ok: boolean;
      subgraph_id: string;
      name: string;
      description: string;
      generated_description: string | null;
      generated_description_locked: boolean;
      routable: boolean;
      default_audience: Audience | null;
    }>(`/workspaces/${wsId}/subgraphs/${id}`, { method: 'PATCH', body }),
  renameSubgraph: (wsId: string, id: string, name: string) =>
    call<{ ok: boolean; subgraph_id: string; name: string; description: string }>(`/workspaces/${wsId}/subgraphs/${id}`, { method: 'PATCH', body: { name } }),
  // Discards a manual generated_description override and forces a fresh synthesis.
  regenerateSubgraphSummary: (wsId: string, id: string) =>
    call<{ ok: boolean; subgraph_id: string; summary: string | null }>(`/workspaces/${wsId}/subgraphs/${id}/regenerate-summary`, { method: 'POST' }),
  archiveSubgraph: (wsId: string, id: string) =>
    call<{ ok: boolean; subgraph_id: string }>(`/workspaces/${wsId}/subgraphs/${id}`, { method: 'DELETE' }),
  // Irreversible: purges the subfolder AND every node/candidate/edge/etc. it contains.
  deleteSubgraph: (wsId: string, id: string) =>
    call<{ ok: boolean; subgraph_id: string; deleted: Record<string, number>; migrated?: Record<string, number> }>(`/workspaces/${wsId}/subgraphs/${id}/purge`, { method: 'DELETE' }),
  // ── Data agents (spec-data-agents-and-subfolder-wiki.md) ──
  listDataAgentTemplates: (wsId: string) =>
    call<{
      templates: Array<{ id: string; name: string; standard: boolean; profile: ContextProfile; active_subfolders: number }>;
    }>(`/workspaces/${wsId}/data-agent-templates`),
  saveDataAgentTemplate: (
    wsId: string,
    body: { id?: string; name: string; profile: ContextProfile; forked_from?: string },
  ) => call<{ ok: boolean; id: string; warnings: string[] }>(`/workspaces/${wsId}/data-agent-templates`, { method: 'POST', body }),
  deleteDataAgentTemplate: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/data-agent-templates/${id}`, { method: 'DELETE' }),
  getActiveDataAgent: (wsId: string, subgraphId: string) =>
    call<{
      active: {
        template_id: string;
        template: ContextProfile;
        cadence: 'once' | 'per_document' | 'scheduled';
        cadence_ms: number | null;
        attached_at: string;
        last_run_at: string | null;
      } | null;
    }>(`/workspaces/${wsId}/subgraphs/${subgraphId}/data-agent`),
  attachDataAgent: (
    wsId: string,
    subgraphId: string,
    body: {
      template_id: string;
      cadence: 'once' | 'per_document' | 'scheduled';
      cadence_ms?: number;
      /** 'new_only' (default): only future documents. 'backfill': re-run
       *  capture on every document already here, archiving what's active. */
      run?: 'new_only' | 'backfill';
    },
  ) =>
    call<{
      ok: boolean;
      active: unknown;
      backfill?: { archived: number; documents: number; documents_skipped: number; candidates: number };
    }>(`/workspaces/${wsId}/subgraphs/${subgraphId}/data-agent`, { method: 'POST', body }),
  detachDataAgent: (wsId: string, subgraphId: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/subgraphs/${subgraphId}/data-agent`, { method: 'DELETE' }),

  // ── The Report (spec-data-agents-and-subfolder-wiki.md §4.3) ──
  getReport: (wsId: string, subgraphId: string) =>
    call<{ report: ReportRecord | null; stale: boolean; latest_change: string }>(
      `/workspaces/${wsId}/subgraphs/${subgraphId}/report`,
    ),
  generateReport: (wsId: string, subgraphId: string) =>
    call<{ ok: boolean; report: ReportRecord }>(`/workspaces/${wsId}/subgraphs/${subgraphId}/report/generate`, {
      method: 'POST',
    }),

  getDocumentRouting: (wsId: string, docId: string) =>
    call<{ document_id: string; routing: DocumentRouting[] }>(`/workspaces/${wsId}/documents/${docId}/routing`),

  // Pending routing decisions (new-folder proposals + low-confidence picks).
  listPendingRoutes: (wsId: string) =>
    call<{ pending_routes: PendingRoute[] }>(`/workspaces/${wsId}/pending-routes`),
  approveRoute: (wsId: string, id: string) =>
    call<{ ok: true; targets: string[]; new_subgraph_id?: string }>(`/workspaces/${wsId}/pending-routes/${id}/approve`, { method: 'POST' }),
  chooseRoute: (wsId: string, id: string, targetIds: string[]) =>
    call<{ ok: true; targets: string[] }>(`/workspaces/${wsId}/pending-routes/${id}/choose`, {
      method: 'POST',
      body: { target_ids: targetIds },
    }),
  rejectRoute: (wsId: string, id: string) =>
    call<{ ok: true }>(`/workspaces/${wsId}/pending-routes/${id}/reject`, { method: 'POST' }),

  // Context profiles (B7). The server may not yet implement these (Phase-1
  // build still in flight); callers fall back to the founding defaults on a
  // 404 so onboarding and the profile-driven views degrade gracefully.
  listProfiles: () => call<{ profiles: ContextProfile[] }>(`/profiles`),
  getProfile: (wsId: string) =>
    call<{ profile_id: string; profile: ContextProfile }>(`/workspaces/${wsId}/profile`),
  // Short LLM synthesis of what the library actually contains (dashboard
  // blurb). null = empty graph / synthesis unavailable; callers fall back
  // to the static profile description.
  getLibraryOverview: (wsId: string) =>
    call<{ summary: string | null }>(`/workspaces/${wsId}/overview`),

  listGraph: (wsId: string, opts?: { includeArchived?: boolean; kind?: string; category?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.includeArchived) qs.set('active', 'false');
    if (opts?.kind) qs.set('kind', opts.kind);
    if (opts?.category) qs.set('category', opts.category);
    const q = qs.toString();
    return call<{ nodes: any[] }>(`/workspaces/${wsId}/graph${q ? `?${q}` : ''}`);
  },
  // Document registry (Library › Sources) + node evidence ledger (Canon).
  // Workspace-wide by default (Sources.tsx's "Manage Data" page deliberately
  // spans every subfolder); pass subgraphId to narrow to documents actually
  // routed into one subfolder — see the data-agent Sources section in
  // Graph.tsx, which otherwise showed every document in the workspace.
  listDocuments: (wsId: string, subgraphId?: string) =>
    call<{ documents: DocumentRecord[] }>(
      `/workspaces/${wsId}/documents${subgraphId ? `?subgraph=${encodeURIComponent(subgraphId)}` : ''}`,
    ),

  // ── Wiki (spec-wiki.md / wiki-milestones.md M1) ──
  getWiki: (wsId: string) => call<WikiTreeResponse>(`/workspaces/${wsId}/wiki`),
  buildWiki: (wsId: string) =>
    call<{ ok: boolean; via: 'llm' | 'fallback'; categories: number; pages: number; tree: WikiTreeNode[] }>(
      `/workspaces/${wsId}/wiki/plan`,
      { method: 'POST' },
    ),
  getWikiPage: (wsId: string, id: string) =>
    call<{ page: WikiPageRecord; blocks: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/pages/${id}`),
  addWikiPage: (wsId: string, body: { kind: 'category' | 'page'; title: string; parent_id?: string | null }) =>
    call<{ ok: boolean; id: string; tree: WikiTreeNode[] }>(`/workspaces/${wsId}/wiki/pages`, { method: 'POST', body }),
  updateWikiPage: (
    wsId: string,
    id: string,
    body: { title?: string; parent_id?: string | null; sort_order?: number },
  ) => call<{ ok: boolean; tree: WikiTreeNode[] }>(`/workspaces/${wsId}/wiki/pages/${id}`, { method: 'PATCH', body }),
  removeWikiPage: (wsId: string, id: string) =>
    call<{ ok: boolean; archived: number; tree: WikiTreeNode[] }>(`/workspaces/${wsId}/wiki/pages/${id}`, {
      method: 'DELETE',
    }),
  fillWikiPage: (wsId: string, id: string) =>
    call<{ ok: boolean; blocks: number; via: string; blocks_list: WikiBlockRecord[] }>(
      `/workspaces/${wsId}/wiki/pages/${id}/fill`,
      { method: 'POST' },
    ),
  fillWiki: (wsId: string) =>
    call<{ ok: boolean; pages: number; filled: number; blocks: number; added_pages: number; tree: WikiTreeNode[] }>(
      `/workspaces/${wsId}/wiki/fill`,
      { method: 'POST' },
    ),
  reviewWikiBlock: (wsId: string, id: string, action: 'accept' | 'reject') =>
    call<{ ok: boolean; blocks_list: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/blocks/${id}/${action}`, {
      method: 'POST',
    }),
  addWikiBlock: (wsId: string, pageId: string, block: { type: 'paragraph' | 'list' | 'image'; content: WikiBlockContent }) =>
    call<{ ok: boolean; id: string; blocks_list: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/pages/${pageId}/blocks`, {
      method: 'POST',
      body: block,
    }),
  editWikiBlock: (wsId: string, id: string, content: WikiBlockContent) =>
    call<{ ok: boolean; blocks_list: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/blocks/${id}`, {
      method: 'PATCH',
      body: { content },
    }),
  deleteWikiBlock: (wsId: string, id: string) =>
    call<{ ok: boolean; blocks_list: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/blocks/${id}`, { method: 'DELETE' }),
  // Unified editor: save the whole page body at once (reconciled by block id).
  saveWikiBody: (wsId: string, pageId: string, blocks: Array<{ id?: string; type: string; content: WikiBlockContent }>) =>
    call<{ ok: boolean; blocks_list: WikiBlockRecord[] }>(`/workspaces/${wsId}/wiki/pages/${pageId}/body`, {
      method: 'PUT',
      body: { blocks },
    }),
  setWikiPageVisibility: (wsId: string, id: string, visibility: 'team' | 'private' | 'only_me') =>
    call<{ ok: boolean; visibility: string }>(`/workspaces/${wsId}/wiki/pages/${id}/visibility`, {
      method: 'PATCH',
      body: { visibility },
    }),

  // ── Subscribe to Updates (spec-subscribe-to-updates.md / U2) ──
  // `kind` keeps each agent to its own watches; omitted returns them all.
  listUpdates: (wsId: string, kind?: UpdateKind) =>
    call<{ subscriptions: UpdateSubscription[] }>(
      `/workspaces/${wsId}/updates${kind ? `?kind=${kind}` : ''}`,
    ),
  createUpdate: (wsId: string, body: UpdateSubscriptionInput) =>
    call<{ subscription: UpdateSubscription; first_run: unknown }>(`/workspaces/${wsId}/updates`, {
      method: 'POST',
      body,
    }),
  editUpdate: (wsId: string, id: string, body: Partial<UpdateSubscriptionInput> & { catch_up?: boolean }) =>
    call<{ subscription: UpdateSubscription }>(`/workspaces/${wsId}/updates/${id}`, { method: 'PATCH', body }),
  pauseUpdate: (wsId: string, id: string) =>
    call<{ subscription: UpdateSubscription }>(`/workspaces/${wsId}/updates/${id}/pause`, { method: 'POST' }),
  resumeUpdate: (wsId: string, id: string) =>
    call<{ subscription: UpdateSubscription }>(`/workspaces/${wsId}/updates/${id}/resume`, { method: 'POST' }),
  removeUpdate: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/updates/${id}`, { method: 'DELETE' }),
  // All delivered updates for the current user (reverse-chron).
  listUpdateDeliveries: (wsId: string) =>
    call<{ deliveries: UpdateDelivery[] }>(`/workspaces/${wsId}/updates/deliveries`),
  // One delivery — the GET marks it viewed (view tracking, spec §8).
  openUpdateDelivery: (wsId: string, deliveryId: string) =>
    call<{ delivery: UpdateDelivery }>(`/workspaces/${wsId}/updates/delivery/${deliveryId}`),
  // Approve a pending (review-mode) update → send it now over its medium.
  sendUpdateDelivery: (wsId: string, deliveryId: string) =>
    call<{ delivery: UpdateDelivery }>(`/workspaces/${wsId}/updates/delivery/${deliveryId}/send`, {
      method: 'POST',
    }),
  // Discard a pending update → owner rejected it; never sent.
  discardUpdateDelivery: (wsId: string, deliveryId: string) =>
    call<{ delivery: UpdateDelivery }>(`/workspaces/${wsId}/updates/delivery/${deliveryId}/discard`, {
      method: 'POST',
    }),
  // Count of updates awaiting my approval (drives the nav badge).
  pendingUpdatesCount: (wsId: string) =>
    call<{ count: number }>(`/workspaces/${wsId}/updates/pending-count`),

  // ── Saved recipient lists (the Give-updates agent's address book) ──
  listRecipientLists: (wsId: string) =>
    call<{ lists: RecipientList[] }>(`/workspaces/${wsId}/recipient-lists`),
  // Saving under an existing name overwrites that list.
  saveRecipientList: (wsId: string, body: { name: string; recipients: string[] }) =>
    call<{ list: RecipientList }>(`/workspaces/${wsId}/recipient-lists`, { method: 'POST', body }),
  deleteRecipientList: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/recipient-lists/${id}`, { method: 'DELETE' }),

  // Raw text of one document (Sources download icon). Returns a text/plain
  // blob; the caller turns it into an <a download> click.
  downloadDocumentText: async (wsId: string, docId: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    if (_session) headers['Authorization'] = `Bearer ${_session}`;
    const r = await fetch(`${BASE}/workspaces/${wsId}/documents/${docId}/content`, { headers });
    if (!r.ok) {
    const text = await r.text();
    expireSessionOn401(r.status, text);
    throw new Error(governanceMessage(text) ?? `${r.status} ${r.statusText}: ${text}`);
  }
    return r.blob();
  },
  getNodeEvidence: (wsId: string, nodeId: string) =>
    call<{ node_id: string; evidence: NodeEvidence[] }>(
      `/workspaces/${wsId}/graph/${nodeId}/evidence`,
    ),

  saveNode: (wsId: string, node: any) =>
    call<{ ok: boolean; node: any }>(`/workspaces/${wsId}/graph`, { method: 'POST', body: node }),
  archiveNode: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/graph/${id}`, { method: 'DELETE' }),

  // ---------- sharing / audience ----------
  // One audience model, three tiers (spec-unified-sharing-and-always-sync.md):
  //   'only_me'  — you in the app UI only; hidden from ALL AI agents
  //   'private'  — you and your own AI agents (not the team)
  //   'team'     — everyone in the folder + their agents
  // The cloud web app hits the workspace sync routes directly.
  setNodeVisibility: (wsId: string, nodeId: string, visibility: Audience) =>
    call<{ ok: boolean; node_id: string; visibility: string }>(
      `/workspaces/${wsId}/sync/nodes/${encodeURIComponent(nodeId)}/visibility`,
      { method: 'POST', body: { visibility } },
    ),
  // Share a whole source: fan-out the audience over every node from the document.
  setSourceVisibility: (wsId: string, docId: string, visibility: Audience) =>
    call<{ ok: boolean; document_id: string; visibility: string; changed: number; skipped: number; total: number }>(
      `/workspaces/${wsId}/sync/document/${encodeURIComponent(docId)}/visibility`,
      { method: 'POST', body: { visibility } },
    ),
  // Share a whole category (profile kind): fan-out over every node of that kind.
  setKindVisibility: (wsId: string, kind: string, visibility: Audience) =>
    call<{ ok: boolean; kind: string; visibility: string; changed: number; skipped: number; total: number }>(
      `/workspaces/${wsId}/sync/kind/${encodeURIComponent(kind)}/visibility`,
      { method: 'POST', body: { visibility } },
    ),

  // ---------- ingestion/sharing rules ----------
  // Workspace-global; GET seeds the three defaults on first access. Writes are
  // owner-gated server-side (can_edit reports whether this caller may write).
  listRules: (wsId: string) =>
    call<{ rules: Rule[]; can_edit: boolean }>(`/workspaces/${wsId}/rules`),
  saveRule: (wsId: string, rule: RuleInput) =>
    call<{ rule: Rule }>(`/workspaces/${wsId}/rules`, { method: 'POST', body: rule }),
  patchRule: (wsId: string, id: string, patch: Partial<RuleInput>) =>
    call<{ rule: Rule }>(`/workspaces/${wsId}/rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  deleteRule: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Dry-run a rule against a sample document — persists nothing; returns the
  // with-rule and without-rule candidate lists for the test diff.
  testRule: (
    wsId: string,
    id: string,
    body: { text?: string; question?: string; source_kind?: string; subgraph_id?: string },
  ) =>
    call<RuleTestResult>(`/workspaces/${wsId}/rules/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body,
    }),

  // ---------- unified automations (redesign of the Automations tab) ----------
  // Supersedes the rule methods above. Same can_edit / owner-gated-writes
  // contract.
  listAutomations: (wsId: string, kind?: AutomationKind) =>
    call<{ automations: Automation[]; can_edit: boolean }>(
      `/workspaces/${wsId}/automations${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
    ),
  saveAutomation: (wsId: string, automation: AutomationInput) =>
    call<{ automation: Automation }>(`/workspaces/${wsId}/automations`, { method: 'POST', body: automation }),
  patchAutomation: (wsId: string, id: string, patch: Partial<AutomationInput>) =>
    call<{ automation: Automation }>(`/workspaces/${wsId}/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  deleteAutomation: (wsId: string, id: string) =>
    call<{ ok: boolean }>(`/workspaces/${wsId}/automations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // "One-time run" (replaces Test): dry-run for a shape automation — persists
  // nothing; returns the same with/without candidate diff as before.
  testAutomation: (
    wsId: string,
    id: string,
    body: { text?: string; question?: string; source_kind?: string; subgraph_id?: string },
  ) =>
    call<AutomationTestResult>(`/workspaces/${wsId}/automations/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body,
    }),
  listAutomationRuns: (wsId: string, id: string, limit?: number) =>
    call<{ runs: AutomationRun[] }>(
      `/workspaces/${wsId}/automations/${encodeURIComponent(id)}/runs${limit ? `?limit=${limit}` : ''}`,
    ),
  // Ingestion-kind automations (apps_pull) — Stage 3, manual-run only so far.
  saveAppsPullAutomation: (
    wsId: string,
    input: {
      connector: string;
      criteria: Record<string, unknown>;
      subgraph_id?: string;
      run_instructions?: string;
      cadence_ms?: number;
    },
  ) =>
    call<{ automation: Automation }>(`/workspaces/${wsId}/automations`, {
      method: 'POST',
      body: { kind: 'apps_pull', ...input },
    }),
  patchAppsPullAutomation: (
    wsId: string,
    id: string,
    patch: Partial<{
      connector: string;
      criteria: Record<string, unknown>;
      subgraph_id: string;
      run_instructions: string;
      cadence_ms: number;
      enabled: boolean;
    }>,
  ) =>
    call<{ automation: Automation }>(`/workspaces/${wsId}/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  runAutomationNow: (wsId: string, id: string) =>
    call<{ run: AutomationRun; pull?: unknown; preview?: unknown }>(
      `/workspaces/${wsId}/automations/${encodeURIComponent(id)}/run-now`,
      { method: 'POST', body: {} },
    ),
  previewAppsPullAutomation: (wsId: string, id: string) =>
    call<{ app: string; unit: string; items: AppSourceItem[]; live?: boolean; plan?: Record<string, unknown> }>(
      `/workspaces/${wsId}/automations/${encodeURIComponent(id)}/preview`,
      { method: 'POST', body: {} },
    ),

  // Workspace-wide: no subgraph header, so the server spans every subgraph.
  // Each row carries its subgraph_id.
  listCandidates: (wsId: string, status: string = 'pending') =>
    call<{ candidates: any[] }>(`/workspaces/${wsId}/candidates?status=${status}`, { noSubgraph: true }),

  // subgraphId, when set, skips routing entirely and files the source directly into that folder.
  // instructions, when set, ignores subgraphId — an agent decides transform + destination
  // instead (may create a new folder) and the response carries `agent: true` + a summary
  // message instead of the plain candidates count.
  ingest: (
    wsId: string,
    source: string,
    source_kind = 'doc',
    source_ref?: string,
    subgraphId?: string,
    instructions?: string,
  ) =>
    call<IngestResult>(`/workspaces/${wsId}/ingest`, {
      method: 'POST',
      // Notes added from the app default to Only me unless the destination
      // folder sets its own default privacy (resolved server-side per folder).
      body: { source, source_kind, source_ref, subgraph_id: subgraphId, instructions, default_audience: APP_DEFAULT_AUDIENCE },
    }),
  ingestFile: (wsId: string, file: File, subgraphId?: string, instructions?: string) => {
    const f = new FormData();
    f.append('file', file);
    if (subgraphId) f.append('subgraph_id', subgraphId);
    if (instructions) f.append('instructions', instructions);
    f.append('default_audience', APP_DEFAULT_AUDIENCE);
    return callForm<{ source_id: string; ext: string; kind: string; text_chars?: number } & IngestResult>(
      `/workspaces/${wsId}/ingest/file`,
      f,
    );
  },

  // ---------- "From your apps" (Sources view) ----------
  // Composio-backed connectors. Connection status per app — `connected` once
  // the user has connected their own account; preview/pull answer 409
  // app_not_connected until then.
  appsStatus: (wsId: string) =>
    call<{ apps: Array<{ id: string; name: string; unit: string; connected: boolean }> }>(
      `/workspaces/${wsId}/apps`,
    ),
  appsPreview: (
    wsId: string,
    app: string,
    query: string,
    githubFiles?: { repo?: string; branch?: string; path?: string },
    slackChannel?: string,
  ) =>
    call<{ app: string; unit: string; items: AppSourceItem[] }>(
      `/workspaces/${wsId}/apps/${app}/preview`,
      {
        method: 'POST',
        body: githubFiles
          ? { query, mode: 'files', ...githubFiles }
          : slackChannel
            ? { query, channel: slackChannel }
            : { query },
      },
    ),
  appsPull: (
    wsId: string,
    app: string,
    query: string,
    item_ids: string[],
    subgraphId?: string,
    instructions?: string,
    githubFiles?: { repo?: string; branch?: string; path?: string },
    slackChannel?: string,
  ) =>
    call<{
      app: string;
      query: string;
      results: Array<{ id: string; title: string; document_id: string; candidates: number }>;
      total_candidates: number;
      // Present when an agent (instructions given) decided not to ingest —
      // e.g. judged the instructions out of scope. No candidate count to show.
      message?: string;
    }>(`/workspaces/${wsId}/apps/${app}/pull`, {
      method: 'POST',
      body: {
        query,
        ...(slackChannel ? { channel: slackChannel } : {}),
        item_ids,
        subgraph_id: subgraphId,
        instructions,
        ...(githubFiles ? { mode: 'files', ...githubFiles } : {}),
      },
    }),
  listVisibleApps: (wsId: string) =>
    call<{ visible_apps: string[] }>(`/workspaces/${wsId}/apps/visibility`, { noSubgraph: true }),
  showApp: (wsId: string, app: string) =>
    call<{ visible_app: string }>(`/workspaces/${wsId}/apps/visibility/${app}`, { method: 'POST', noSubgraph: true }),
  hideApp: (wsId: string, app: string) =>
    call<{ ok: boolean; visible_app: string }>(`/workspaces/${wsId}/apps/visibility/${app}`, {
      method: 'DELETE',
      noSubgraph: true,
    }),

  submitReview: (wsId: string, deliverable: string, kind?: string) =>
    call<{ id: string; findings: any[] }>(`/workspaces/${wsId}/reviews`, { method: 'POST', body: { deliverable, kind } }),

  // Alignment: turn an uploaded file or a link into text (no ingest), then the
  // caller runs submitReview against each selected folder.
  alignExtractFile: (wsId: string, file: File) => {
    const f = new FormData();
    f.append('file', file);
    return callForm<{ text: string; source_ref: string; kind: string }>(
      `/workspaces/${wsId}/align/extract`,
      f,
    );
  },
  alignExtractUrl: (wsId: string, url: string) =>
    call<{ text: string; source_ref: string; kind: string }>(`/workspaces/${wsId}/align/extract`, {
      method: 'POST',
      body: { url },
    }),
  // Resolve "check against" references (folder / teammate / free-typed) to
  // member folders, the same way the Updates target picker does.
  alignResolve: (wsId: string, refs: string[]) =>
    call<{
      resolved: Array<{ ref: string; workspace_id: string; name: string }>;
      errors: Array<{ ref: string; detail: string }>;
    }>(`/workspaces/${wsId}/align/resolve`, { method: 'POST', body: { refs } }),

  listReviews: (wsId: string) =>
    call<{ reviews: Array<{ id: string; caller: string; kind: string; red: number; yellow: number; green: number; created_at: string }> }>(
      `/workspaces/${wsId}/reviews`,
    ),

  query: (wsId: string, question: string, scope = 'all') =>
    call<{ answer: string; cited_node_ids: string[]; has_answer: boolean }>(`/workspaces/${wsId}/query`, {
      method: 'POST',
      body: { question, scope },
    }),

  // Work agents (spec-work-agents.md) — act on the caller's OWN context in the
  // current folder to produce a finished artifact. `empty` = no material yet;
  // `error` = LLM/key failure the view shows softly (the server degrades, not 500s).
  runWorkAgent: (
    wsId: string,
    agent: 'draft' | 'synthesize' | 'catchup' | 'followup',
    body: { input?: string; docType?: string; since?: string },
  ) =>
    call<{
      agent: string;
      title: string;
      output: string;
      cited_node_ids: string[];
      empty?: boolean;
      error?: string;
    }>(`/workspaces/${wsId}/work/${agent}`, { method: 'POST', body }),

  listMcpQueries: (wsId: string) =>
    call<{ queries: Array<{ created_at: string; scope: string; has_answer: boolean; cited: number; latency_ms: number | null }> }>(
      `/workspaces/${wsId}/mcp-queries`,
    ),

  issueMcpToken: (wsId: string) =>
    call<{ id: string; token: string }>(`/workspaces/${wsId}/mcp-tokens`, { method: 'POST', body: {} }),

  // claude.ai connectors — self-serve capability URLs. `path` is relative to the
  // app origin; the UI prepends window.location.origin to form the full URL.
  createConnector: (wsId: string, label?: string) =>
    call<{ id: string; secret: string; path: string }>(`/workspaces/${wsId}/connectors`, {
      method: 'POST',
      body: { label },
    }),
  listConnectors: (wsId: string) =>
    call<{ connectors: Array<{ id: string; label: string | null; created_at: string; last_used_at: string | null }> }>(
      `/workspaces/${wsId}/connectors`,
    ),
  revokeConnector: (wsId: string, id: string) =>
    call<{ ok: true }>(`/workspaces/${wsId}/connectors/${id}`, { method: 'DELETE' }),

  // Day-1 Audit
  runDay1Audit: (wsId: string, deliverables: Array<{ source_ref?: string; kind?: string; content: string }>) =>
    call<any>(`/workspaces/${wsId}/day-1-audit`, { method: 'POST', body: { deliverables } }),
  listDay1Audits: (wsId: string) =>
    call<{ reports: Array<{ id: string; created_at: string; deliverables_count: number }> }>(
      `/workspaces/${wsId}/day-1-audit`,
    ),
  getDay1Audit: (wsId: string, id: string) =>
    call<any>(`/workspaces/${wsId}/day-1-audit/${id}`),

  // Cross-user context usage. Who drew on this workspace's context, the
  // shape of the request, and (as of 2026-08) the verbatim request text.
  // Paged newest-first: `before` = the last row id of the previous page.
  listContextUsage: (wsId: string, opts: { limit?: number; before?: number; unanswered?: boolean } = {}) =>
    call<{ usage: ContextUsageEntry[]; total: number; unanswered_total: number }>(
      `/workspaces/${wsId}/context-usage${pageQuery(opts.limit, opts.before, opts.unanswered ? { filter: 'unanswered' } : {})}`,
    ),
  // The requester-side mirror: my own requests across every workspace I'm in.
  myContextUsage: () =>
    call<{ usage: MyContextUsageEntry[] }>(`/me/context-usage`),
  // Owner-only LLM narratives of how the context is being used — one for the
  // team's use, one for the owner's own. 403 for non-owners — callers hide
  // the passages on error.
  getUsageAnalysis: (wsId: string) =>
    call<UsageAnalysis>(`/workspaces/${wsId}/usage-analysis`),

  // customer audit (admin)
  listCustomerAudit: (wsId: string, opts: { limit?: number; before?: number } = {}) =>
    call<{ entries: any[]; total: number }>(
      `/workspaces/${wsId}/customer-audit${pageQuery(opts.limit ?? 200, opts.before)}`,
    ),
};

/** `?limit=…&before=…` for the id-cursor paged list endpoints. */
function pageQuery(limit?: number, before?: number, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (limit) p.set('limit', String(limit));
  if (before) p.set('before', String(before));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export type ContextUsageEntry = {
  id: number;
  actor_user_id: string | null;
  actor_email: string | null;
  channel: 'web' | 'mcp';
  tool: 'query' | 'context_pack' | 'review' | 'recent_changes' | 'search' | 'work';
  scope: string | null;
  deliverable_kind: string | null;
  has_answer: boolean | null;
  cited: number | null;
  request_text: string | null;
  /** Human-readable call options, e.g. "titles only, added since 1 Oct 2026". */
  detail?: string | null;
  /** Notes returned (reads) or considered (questions/reviews). */
  node_count?: number | null;
  /** Display name of the folder the request ran against. */
  folder_name?: string | null;
  latency_ms: number | null;
  created_at: string;
};
export type MyContextUsageEntry = ContextUsageEntry & {
  workspace_id: string;
  workspace_name: string;
  owner_email: string;
  own_context: boolean;
};
export type ContextUsageStats = {
  total: number;
  distinct_users: number;
  by_tool: Record<string, number>;
  by_scope: Record<string, number>;
  by_deliverable_kind: Record<string, number>;
};
export type UsageAnalysis = {
  self: { summary: string | null; stats: ContextUsageStats };
  team: { summary: string | null; stats: ContextUsageStats };
};
