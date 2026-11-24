// Types and row helpers shared by the repo modules (split from repo.ts,
// the repo split). Re-exported from ../repo.ts; import from there outside db/.
import { createHash } from 'node:crypto';
import {
  Node,
  ProfileNode,
  GraphEdge,
  IngestionCriteria,
} from '../../../lib/schemas.js';
import type { Node as NodeT, GraphEdge as GraphEdgeT } from '../../../lib/schemas.js';
import { blobToEmbedding } from '../../../lib/embeddings.js';

// ---------- Subscribe to Updates types (spec-subscribe-to-updates.md / U1) ----------

export type UpdateMedium = 'email' | 'slack';
export type UpdateSubscriptionStatus = 'active' | 'paused';
export type UpdateApprovalMode = 'autonomous' | 'review';
export type UpdateDeliveryStatus = 'pending' | 'sent' | 'discarded';
/**
 * Which agent owns a watch. 'get' is the collab agent — I subscribe to a topic
 * and the update comes to me. 'give' is the work agent — I broadcast updates
 * about my own folder to a list of teammates. Identical machinery; the kind
 * keeps each agent's list to its own watches.
 */
export type UpdateKind = 'get' | 'give';
/** A watch target: a folder = (workspace, subgraph) pair the owner can read. */
export interface UpdateTarget {
  workspace_id: string;
  subgraph_id: string;
}
export interface UpdateSubscription {
  id: string;
  owner_user_id: string;
  topic: string;
  topic_embedding: Float32Array | null;
  targets: UpdateTarget[];
  cadence_ms: number;
  medium: UpdateMedium;
  kind: UpdateKind;
  destination: string | null;
  approval_mode: UpdateApprovalMode;
  status: UpdateSubscriptionStatus;
  last_run_at: string | null;
  next_run_at: string;
  watermark: string | null;
  fail_count: number;
  created_at: string;
  updated_at: string;
}
export interface UpdateDelivery {
  id: string;
  subscription_id: string;
  owner_user_id: string;
  window_from: string | null;
  window_to: string;
  title: string;
  body: string;
  cited_node_ids: string[];
  change_count: number;
  medium: UpdateMedium;
  status: UpdateDeliveryStatus;
  delivered_at: string | null;
  delivery_error: string | null;
  view_count: number;
  click_count: number;
  opened_at: string | null;
  created_at: string;
}

/** A named, reusable group of addresses the 'give' agent broadcasts to. */
export interface RecipientList {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  name: string;
  recipients: string[];
  created_at: string;
  updated_at: string;
}

export interface RecipientListRow {
  workspace_id: string;
  id: string;
  owner_user_id: string;
  name: string;
  recipients: string;
  created_at: string;
  updated_at: string;
}

export function rowToRecipientList(r: RecipientListRow): RecipientList {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    owner_user_id: r.owner_user_id,
    name: r.name,
    recipients: JSON.parse(r.recipients) as string[],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export interface UpdateSubscriptionRow {
  id: string;
  owner_user_id: string;
  topic: string;
  topic_embedding: Buffer | null;
  targets: string;
  cadence_ms: number;
  medium: UpdateMedium;
  kind: UpdateKind;
  destination: string | null;
  approval_mode: UpdateApprovalMode;
  status: UpdateSubscriptionStatus;
  last_run_at: string | null;
  next_run_at: string;
  watermark: string | null;
  fail_count: number;
  created_at: string;
  updated_at: string;
}
export interface UpdateDeliveryRow {
  id: string;
  subscription_id: string;
  owner_user_id: string;
  window_from: string | null;
  window_to: string;
  title: string;
  body: string;
  cited_node_ids: string | null;
  change_count: number;
  medium: UpdateMedium;
  status: UpdateDeliveryStatus;
  delivered_at: string | null;
  delivery_error: string | null;
  view_count: number;
  click_count: number;
  opened_at: string | null;
  created_at: string;
}

export function rowToUpdateSubscription(r: UpdateSubscriptionRow): UpdateSubscription {
  return {
    id: r.id,
    owner_user_id: r.owner_user_id,
    topic: r.topic,
    topic_embedding: blobToEmbedding(r.topic_embedding),
    targets: JSON.parse(r.targets) as UpdateTarget[],
    cadence_ms: r.cadence_ms,
    medium: r.medium,
    kind: r.kind ?? 'get',
    destination: r.destination,
    approval_mode: r.approval_mode,
    status: r.status,
    last_run_at: r.last_run_at,
    next_run_at: r.next_run_at,
    watermark: r.watermark,
    fail_count: r.fail_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
export function rowToUpdateDelivery(r: UpdateDeliveryRow): UpdateDelivery {
  return {
    id: r.id,
    subscription_id: r.subscription_id,
    owner_user_id: r.owner_user_id,
    window_from: r.window_from,
    window_to: r.window_to,
    title: r.title,
    body: r.body,
    cited_node_ids: r.cited_node_ids ? (JSON.parse(r.cited_node_ids) as string[]) : [],
    change_count: r.change_count,
    medium: r.medium,
    status: r.status,
    delivered_at: r.delivered_at,
    delivery_error: r.delivery_error,
    view_count: r.view_count,
    click_count: r.click_count,
    opened_at: r.opened_at,
    created_at: r.created_at,
  };
}

/**
 * Parse a stored `proposed_node` JSON blob. Founding-union first (preserves
 * the legacy-field backfill), then the generalized `ProfileNode` envelope for
 * non-founding profile kinds — same fallback order as the API write path
 * (api/server.ts). Stored blobs passed validation at write time, so one of
 * the two always succeeds.
 */
export function parseStoredNode(json: string): NodeT {
  const raw = JSON.parse(json);
  const founding = Node.safeParse(raw);
  return (founding.success ? founding.data : ProfileNode.parse(raw)) as NodeT;
}

/**
 * Canonical form for a WhatsApp phone number: digits only, no leading `+`,
 * spaces, dashes, or JID suffix (`@s.whatsapp.net` / `@lid`). Both the
 * self-link route and the inbound webhook run numbers through this before
 * comparing, so "+1 (415) 555-0100" and "14155550100@s.whatsapp.net" resolve
 * to the same identity.
 */
export function normalizePhoneDigits(raw: string): string {
  return raw.split('@')[0]!.replace(/\D/g, '');
}

/** Map a graph_edges row (SQL nulls) onto the GraphEdge schema. */
export function rowToEdge(r: Record<string, unknown>): GraphEdgeT {
  return GraphEdge.parse({
    id: r.id,
    src: r.src,
    dst: r.dst,
    kind: r.kind,
    status: r.status,
    created_by: r.created_by,
    document_id: r.document_id ?? undefined,
    quote: r.quote ?? undefined,
    confidence: r.confidence ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });
}

/** A routing decision held for human review — see schema.ts `pending_routes`. */
export interface PendingRouteRow {
  id: string;
  document_id: string;
  reason: string;
  proposed_targets: string[];
  proposed_new_folder: { name: string; description: string } | null;
  low_confidence_targets: string[];
  status: 'pending' | 'approved' | 'rejected';
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  /** The audience the original ingest asked for, and who asked — capture runs
   *  when the hold resolves, so the choice has to survive the wait. */
  audience: 'team' | 'private' | 'only_me' | null;
  ingested_by: string | null;
  /** Fallback when neither `audience` nor the target folder's default is set. */
  fallback_audience: 'team' | 'private' | 'only_me' | null;
}

export interface RawPendingRouteRow {
  id: string;
  document_id: string;
  reason: string;
  proposed_targets: string;
  proposed_new_folder: string | null;
  low_confidence_targets: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  audience: string | null;
  ingested_by: string | null;
  fallback_audience?: string | null;
}

export function parsePendingRouteRow(r: RawPendingRouteRow): PendingRouteRow {
  return {
    id: r.id,
    document_id: r.document_id,
    reason: r.reason,
    proposed_targets: JSON.parse(r.proposed_targets),
    proposed_new_folder: r.proposed_new_folder ? JSON.parse(r.proposed_new_folder) : null,
    low_confidence_targets: JSON.parse(r.low_confidence_targets),
    status: r.status as PendingRouteRow['status'],
    resolved_by: r.resolved_by,
    resolved_at: r.resolved_at,
    created_at: r.created_at,
    audience: (r.audience as PendingRouteRow['audience']) ?? null,
    ingested_by: r.ingested_by ?? null,
    fallback_audience: (r.fallback_audience as PendingRouteRow['fallback_audience']) ?? null,
  };
}

/**
 * Repository — workspace-scoped DB access. Every query takes workspace_id
 * as a non-optional first argument. This is the integrity-gate enforcement
 * point for cross-tenant isolation.
 */

export interface Workspace {
  id: string;
  name: string;
  owner_email: string;
  created_at: string;
  ai_allowed?: number;
  sensitive?: number;
  assistants_allowed?: number;
  agents_read_only?: number;
}

/** A subgraph = a "subfolder". `description` is the user-authored blurb
 *  (defaults to 'miscellaneous'); `generated_description` is the persisted LLM
 *  Overview summary, refreshed each time the overview route runs — unless
 *  `generated_description_locked`, meaning a human hand-edited it and the
 *  automatic refresh must leave it alone. `routable` gates whether automatic
 *  routing (the ingest router, the query classifier) may pick this folder
 *  without an explicit address; a `#slug` pin or a caller-picked destination
 *  always reaches it regardless. */
export interface SubgraphRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  generated_description: string | null;
  generated_description_at: string | null;
  generated_description_locked: boolean;
  routable: boolean;
  /** Folder-level default privacy for captured nodes; null = not set. */
  default_audience: 'team' | 'private' | 'only_me' | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export const SUBGRAPH_SELECT =
  `SELECT id, slug, name, description, generated_description, generated_description_at,
          generated_description_locked, routable, default_audience, status, created_at, updated_at FROM subgraphs`;

/** SUBGRAPH_SELECT reads INTEGER 0/1 columns straight off the driver — cast
 *  them to real booleans once here rather than at every call site. */
export function mapSubgraphRow(row: Record<string, unknown>): SubgraphRow {
  return {
    ...(row as unknown as SubgraphRow),
    generated_description_locked: !!(row.generated_description_locked as number),
    routable: !!(row.routable as number),
    default_audience: (['team', 'private', 'only_me'] as const).includes(row.default_audience as any)
      ? (row.default_audience as SubgraphRow['default_audience'])
      : null,
  };
}

export interface Rule {
  id: string;
  workspace_id: string;
  instructions: string;
  scopes: string[];
  phases: string[];
  action: string | null;
  target: string;
  enabled: boolean;
  owner_user_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type AutomationKind = 'shape' | 'apps_pull' | 'slack_listen' | 'track_directory';

export interface Automation {
  id: string;
  workspace_id: string;
  kind: AutomationKind;
  // shape kind
  instructions: string | null;
  scopes: string[];
  phases: string[];
  action: string | null;
  target: string;
  // ingestion kinds (apps_pull / slack_listen / track_directory)
  connector: string | null;
  criteria: IngestionCriteria | null;
  subgraph_id: string | null;
  run_instructions: string | null;
  cadence_ms: number | null;
  status: 'active' | 'paused';
  last_run_at: string | null;
  next_run_at: string | null;
  watermark: string | null;
  fail_count: number;
  // slack_listen only
  slack_team_id: string | null;
  slack_channel_id: string | null;
  // track_directory only
  device_id: string | null;
  local_path: string | null;
  enabled: boolean;
  owner_user_id: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
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
}

export interface User {
  id: string;
  email: string;
  is_admin?: number;
  display_name?: string | null;
  /** What this user calls the assistant on chat surfaces. Per-user, not per-team. */
  assistant_nickname?: string | null;
  created_at: string;
}

/** An external identity (Slack, WhatsApp) linked to a user. */
export interface UserIdentity {
  id: string;
  user_id: string;
  kind: 'slack' | 'whatsapp';
  team_id: string | null;
  external_id: string;
  handle: string | null;
  created_at: string;
}

export type DefaultSurface = 'all' | 'slack' | 'mcp' | 'whatsapp';

/** A user's default folder (workspace), optionally surface-specific. */
export interface UserDefault {
  user_id: string;
  surface: DefaultSurface;
  workspace_id: string;
  subgraph_id: string | null;
  updated_at: string;
}

/** One surface-agent conversation (Slack thread/DM) and its confirm state. */
export interface AgentThread {
  surface: string;
  team_id: string;
  thread_key: string;
  user_id: string;
  workspace_id: string;
  pending_action: { tool: string; args: Record<string, unknown>; summary?: string; created_at: string } | null;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  workspace_id: string;
  user_id: string;
  role: 'workspace_admin' | 'leader' | 'member';
  created_at: string;
  read_only?: number;
}

export interface AuditEntry {
  actor?: string;
  event: string;
  resource_type?: string;
  resource_id?: string;
  payload?: unknown;
}

/**
 * Customer-facing audit events. Distinct from the internal `audit_log` (which
 * tracks every node mutation for debugging) — this is the export-friendly,
 * SIEM-ready stream the PRD's enterprise-acceptance section requires.
 *
 * The vocabulary is intentionally closed: adding an event here is a
 * deliberate decision visible to customers via the export schema, not an
 * accidental leak from a dev who reused logAudit().
 */
export const CUSTOMER_AUDIT_EVENTS = [
  'sign_in',
  'sign_in_failed',
  'sign_out',
  'password_changed',
  'mfa_enabled',
  'mfa_disabled',
  'mfa_recovery_code_used',
  'sign_in_failures_alert',
  'sso_config_changed',
  'member_added',
  'member_removed',
  'member_role_changed',
  'access_requested',
  'mcp_token_issued',
  'mcp_token_used',
  'mcp_token_revoked',
  'connector_created',
  'connector_revoked',
  'slack_channel_watched',
  'slack_channel_unwatched',
  'profile_assigned',
  'profile_updated',
  'source_ingested',
  'graph_node_mutated',
  'deliverable_submitted',
  'context_accessed',
  'candidates_bulk_approved',
  'candidates_bulk_rejected',
  'candidates_reverted',
  'audit_log_exported',
  'workspace_deleted',
  'subgraph_deleted',
  'identity_linked',
  'identity_unlinked',
  'default_folder_set',
  'surface_agent_used',
  'app_connected',
  'app_disconnected',
  'data_agent_attached',
  'data_agent_detached',
  'plan_changed',
  // MCP OAuth (phase1/oauth): one row per folder the grant covers.
  'oauth_consent_granted',
  'oauth_token_issued',
  'oauth_grant_revoked',
  'ai_access_changed',
  'governance_changed',
  'workspace_exported',
  'document_held_injection',
  'account_disabled',
  'account_enabled',
] as const;
export type CustomerAuditEvent = (typeof CUSTOMER_AUDIT_EVENTS)[number];

/**
 * Every table carrying a `subgraph_id` column that is genuinely OWNED by a
 * subgraph (as opposed to a shared/advisory pointer — see the exclusions
 * below). Used by deleteSubgraphRows/countSubgraphRows so the two can't drift
 * apart. subgraph_id is never a FK (schema.ts's multi-subgraph comment), so
 * there is no ON DELETE CASCADE to lean on the way workspace deletion does.
 *
 * Deliberately excluded:
 *   - documents, sources, source_chunks — shared across subgraphs (a document
 *     can route into more than one); source_chunks.subgraph_ref is advisory only.
 *   - user_defaults — a per-user POINTER, cleared (not deleted) by deleteSubgraphRows.
 *   - wiki_blocks — no subgraph_id column of its own; resolved via wiki_pages.
 */
export const SUBGRAPH_SCOPED_TABLES = [
  'curation_messages',
  'curation_conversations',
  'wiki_pages',
  'wikis',
  'doc_triage',
  'candidate_groups',
  'context_usage_log',
  'context_request_texts',
  'node_evidence',
  'graph_edges',
  'document_routing',
  'candidates',
  'graph_nodes',
  'workspace_profiles',
] as const;

export interface CustomerAuditEntry {
  event: CustomerAuditEvent;
  actor_user_id?: string;
  actor_email?: string;
  source_ip?: string;
  user_agent?: string;
  resource_type?: string;
  resource_id?: string;
  payload?: unknown;
}

export interface CustomerAuditRow {
  id: number;
  event: string;
  actor_user_id: string | null;
  actor_email: string | null;
  source_ip: string | null;
  user_agent: string | null;
  resource_type: string | null;
  resource_id: string | null;
  payload: string | null;
  created_at: string;
}

// ---- cross-user context usage (attribution-without-content model) ----

export type ContextUsageTool = 'query' | 'context_pack' | 'review' | 'recent_changes' | 'work' | 'search';

export interface ContextAccessEntry {
  actor_user_id?: string;
  channel: 'web' | 'mcp';
  tool: ContextUsageTool;
  scope?: string;
  deliverable_kind?: string;
  has_answer?: boolean;
  cited?: number;
  node_count?: number;
  latency_ms?: number;
  /** Verbatim question. Stored alongside the actor in context_usage_log and,
   *  anonymized (actor-free), in context_request_texts. */
  request_text?: string;
  /** Human-readable options of the call ("titles only, since 1 Oct 2026") for
   *  the Usage view. Built from arguments only — never user content. */
  detail?: string;
  /** Node ids the answer cited; stored with the anonymized text so the
   *  usage-analysis synthesis can say WHAT the context provided. */
  cited_node_ids?: string[];
  accessed_node_ids?: string[];
  source_ip?: string;
  user_agent?: string;
  subgraph_id?: string;
}

/** Node ids returned by a context read, for optional document access auditing. */
export function nodeIdsOf(items: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    const row = item as { id?: unknown; node_id?: unknown };
    const id = typeof row?.id === 'string' ? row.id : typeof row?.node_id === 'string' ? row.node_id : undefined;
    if (id) out.push(id);
  }
  return out;
}

export interface ContextUsageRow {
  id: number;
  workspace_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  channel: 'web' | 'mcp';
  tool: ContextUsageTool;
  scope: string | null;
  deliverable_kind: string | null;
  has_answer: number | null;
  cited: number | null;
  node_count: number | null;
  latency_ms: number | null;
  request_text: string | null;
  detail: string | null;
  subgraph_id: string | null;
  /** Folder display name (joined from subgraphs; null if the folder is gone). */
  subgraph_name: string | null;
  created_at: string;
}



export interface WikiPage {
  id: string;
  kind: 'category' | 'page';
  parent_id: string | null;
  slug: string;
  title: string;
  anchor: unknown | null;
  sections: Array<{ key?: string; heading: string; intent?: string }> | null;
  source_doc_ids: string[];
  sort_order: number;
  visibility: 'team' | 'private' | 'only_me';
  owner_user_id: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface WikiBlock {
  id: string;
  page_id: string;
  sort_order: number;
  type: string;
  content: unknown;
  cited_node_ids: string[];
  provenance: string;
  review_state: string;
  edited_by_user: boolean;
  created_at: string;
  updated_at: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
