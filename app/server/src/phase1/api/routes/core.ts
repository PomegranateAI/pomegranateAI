// Route helpers shared across areas: everything buildApp() declared that more than one area uses.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { readWorkspaceText, writeWorkspaceFile } from '../../files/sealed-files.js';
import { detectInjection, injectionCheckEnabled } from '../../../lib/injection-check.js';
import { viewerMayRequest } from '../../governance.js';
import { MediaService, MediaError } from '../../data-agents/media-service.js';
import {
  RedactionUnavailableError,
  redactFailOpen,
  type RedactionUnavailableReason,
} from '../../ingest/redaction-error.js';
import { mediaProvenance } from '../../data-agents/context.js';
import type { MiddlewareHandler, Context } from 'hono';
import type { CustomerAuditEvent, PendingRouteViewer } from '../../db/repo.js';
import { pendingRouteResolvableBy } from '../../db/repo.js';
import { MFA_ENROLLMENT_PATHS, PASSWORD_CHANGE_PATHS, hasTwoStep } from './mfa.js';
import { promises as fs, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import {
  Node,
  ProfileNode,
  Candidate,
  ContextProfile,
} from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT, Node as NodeT } from '../../../lib/schemas.js';
import { FALLBACK_PROFILE } from '../../../lib/profiles/index.js';
import { listBuiltinProfiles, getBuiltinProfile, DEFAULT_PROFILE_ID } from '../../../lib/profiles/index.js';
import { log } from '../../../lib/log.js';
import { sameOrgDomain } from '../../../lib/email-domain.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { CachedSynth } from '../../synth/cached.js';
import { createTools, type McpDeps, type ToolCtx } from '../../mcp/registry.js';
import { runAddSourceAgent } from '../../agent/add-source-agent.js';
import {
  routeDocument,
  proposeNewFolder,
  routeToSubgraphs,
  type CaptureTraceEvent,
  type RouteFolder,
} from '../../../lib/anthropic.js';
import { parseSubgraphTokens } from '../../../lib/subgraph-routing.js';
import { embeddingToBlob, embeddingTextForNode, getEmbedder } from '../../../lib/embeddings.js';
import { buildScopedGraph, edgesForPackedGraph } from '../../retrieval/pack.js';
import { sourceRagEnabled, embedAndStoreChunks } from '../../retrieval/source-rag.js';
import { AuthGuard, authLimiterFromEnv } from '../rate-limit.js';
import {
  ensureGmailAuthConfig,
  startGmailConnect,
  refreshGmailConnectionStatus,
  disconnectGmail,
} from '../gmail-live.js';
import {
  ensureGithubAuthConfig,
  startGithubConnect,
  refreshGithubConnectionStatus,
  listGithubRepos,
  disconnectGithub,
} from '../github-live.js';
import {
  ensureSlackAuthConfig,
  startSlackConnect,
  refreshSlackConnectionStatus,
  listSlackConversations,
  disconnectSlack,
} from '../slack-live.js';
import {
  ensureDriveAuthConfig,
  startDriveConnect,
  refreshDriveConnectionStatus,
  disconnectDrive,
} from '../drive-live.js';
import {
  ensureNotionAuthConfig,
  startNotionConnect,
  refreshNotionConnectionStatus,
  disconnectNotion,
} from '../notion-live.js';
import {
  ensureFathomAuthConfig,
  startFathomConnect,
  refreshFathomConnectionStatus,
  disconnectFathom,
} from '../fathom-live.js';
import {
  ensureTeamsAuthConfig,
  startTeamsConnect,
  refreshTeamsConnectionStatus,
  disconnectTeams,
  listTeamsTeams,
} from '../teams-live.js';
import {
  ensureJiraAuthConfig,
  startJiraConnect,
  refreshJiraConnectionStatus,
  disconnectJira,
  listJiraProjects,
} from '../jira-live.js';
import { smtpConfigFromEnv, sendMail } from '../../mail/smtp.js';
import { resendConfigFromEnv, sendMailViaResend } from '../../mail/resend.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clientIp as clientIpOf } from '../../../lib/client-ip.js';
import { inferLlmEdges, type EdgeRepo } from '../../../lib/edge-inference.js';
import type { Hono } from 'hono';
import type { AppVars, RouteCtx } from '../routes.js';
import type { ComposioConnectorSpec, RuleTestMode, RoutedSubgraphResult, IngestRouting, ResolvePendingRouteResult } from './types.js';

export function createRouteCore(ctx: RouteCtx, app: Hono<{ Variables: AppVars }>) {
void app;
  const { repo, synth } = ctx;
  const FILES_DIR = ctx.filesDir;
  const media = new MediaService(repo, FILES_DIR);
  if (ctx.workspaceGate) media.canIngest = async (ws) => !!(await repo.getWorkspace(ws));

// CORS locked to PUBLIC_ORIGIN when set (production / internet-facing);
// permissive when unset (local dev), so the existing dev flow and tests are
// unchanged. PUBLIC_ORIGIN may be a comma-separated allow-list.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.trim();
const corsOrigins = PUBLIC_ORIGIN
  ? PUBLIC_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : '*';

// In-process token-bucket rate limiter on /auth/* (spec C3). Generous
// defaults; configurable via env. Keyed by client IP. Applied below to the
// two auth routes only.
const authLimiter = authLimiterFromEnv();
// Per-IP budget for failed credential checks + the verified-credential set the
// API-wide limiter keys on (rate-limit.ts). Shared by every credential gate.
const authGuard = new AuthGuard();
async function authRateLimit(c: any, next: any) {
  const key = clientIp(c) ?? 'unknown';
  if (!authLimiter.take(key)) {
    const retryAfter = authLimiter.retryAfterSec(key);
    log.warn('auth.rate_limited', { ip_present: key !== 'unknown', retry_after_s: retryAfter });
    return c.json({ error: 'rate_limited', retry_after_s: retryAfter }, 429, {
      'retry-after': String(retryAfter),
    });
  }
  await next();
}

/**
 * Canonical on-disk text of a registered document, persisted at registration
 * so Sources can serve "download as .txt" for every ingest channel (file,
 * paste, MCP, Slack). Lives under the workspace's files dir — workspace
 * deletion sweeps it with everything else.
 */
function docTextPath(ws: string, document_id: string, version: number): string {
  return path.join(FILES_DIR, ws, 'docs', `${document_id}-v${version}.txt`);
}

/**
 * Filenames present in a workspace's persisted-text dir, read once. Used to
 * check `downloadable` for every document in a listing without one blocking
 * existsSync syscall per row.
 */
function docTextFilenames(ws: string): Set<string> {
  try {
    return new Set(readdirSync(path.join(FILES_DIR, ws, 'docs')));
  } catch {
    return new Set();
  }
}

// Single-user-local mode (POMEGRANATE_SINGLE_USER=1): there is exactly one
// person on the device, and the local graph only ever contains data that person
// is entitled to (sync pull is server-side viewer-filtered). So the local engine
// skips per-viewer node-visibility filtering — the user sees their whole DB,
// including private/shared nodes mirrored from the server. Default off (unset),
// so the cloud build keeps enforcing visibility exactly as before.
const SINGLE_USER_LOCAL = process.env.POMEGRANATE_SINGLE_USER === '1';
/** The viewer to filter reads by, or undefined to skip filtering (local mode). */
function viewerFor(c: { get: (k: 'user_id') => string }): string | undefined {
  return SINGLE_USER_LOCAL ? undefined : c.get('user_id');
}

/**
 * Document registry + node-context stamping (evidence-ledger build).
 * Registers the ingested document (content-hash versioning) and returns the
 * deterministic context line every candidate node from this document carries in
 * attrs.context.
 *
 * `summary` + `stakeholders` come FROM THE CALLER, not from a router call in
 * here. Until 2026-07-17 this function ran `runRouteCapture` itself to get them,
 * which is how the ingest path came to read every document twice and — worse —
 * how routing came to run on a summary written against ONE folder's profile.
 * `routeDocument` now reads the document once, before registration, and hands
 * its findings down. See spec-pomegranate-light.md §4, removals doc §4 task #11.
 */
async function registerIngestDocument(opts: {
  ws: string;
  source: string;
  sourceKind: 'doc' | 'slack' | 'transcript' | 'interaction';
  sourceRef: string;
  profile: Awaited<ReturnType<typeof profileFor>>;
  /** From `routeDocument` — it already read the document. */
  summary: string;
  stakeholders: string[];
}): Promise<{ document_id: string; version: number; contextLine: string; summary: string; stakeholders: string[] }> {
  const summary = opts.summary.slice(0, 600);
  const stakeholders = opts.stakeholders;
  const sha = createHash('sha256').update(opts.source).digest('hex');
  // Source type is the DETERMINISTIC channel match, and only that (owner
  // decision 2026-07-17): the router used to also classify the document against
  // the template's source_types, but Light's router decides which folder a
  // document belongs in and nothing else. Every template declares source_kinds,
  // so the channel match covers what the classification did.
  const sourceType =
    (opts.profile.source_types ?? []).find((s) => (s.source_kinds ?? []).includes(opts.sourceKind))?.key ||
    undefined;
  const doc = await repo.registerDocument(opts.ws, {
    source_ref: opts.sourceRef,
    source_kind: opts.sourceKind,
    sha256: sha,
    summary,
    stakeholders,
    source_type: sourceType,
  });
  // Persist the canonical text for download-as-.txt (GET /documents/:id/
  // content). Best-effort: a disk failure must not fail the ingest.
  try {
    await writeWorkspaceFile(repo.crypto, opts.ws, FILES_DIR, docTextPath(opts.ws, doc.id, doc.version), opts.source);
  } catch (err) {
    log.warn('ingest.doc_text_persist_failed', {
      workspace: opts.ws,
      document: doc.id,
      msg: (err as Error).message?.slice(0, 200),
    });
  }
  // Source-RAG chunk + embed (spec §2.2). Only on a new version (a new
  // document id) — an idempotent re-ingest already has its chunks. Best-effort:
  // a chunk/embed failure must not fail the ingest, same posture as the .txt.
  if (sourceRagEnabled() && !doc.existing) {
    try {
      await embedAndStoreChunks({
        repo,
        workspace_id: opts.ws,
        document_id: doc.id,
        text: opts.source,
        now: new Date().toISOString(),
      });
    } catch (err) {
      log.warn('source_rag.ingest_failed', {
        workspace: opts.ws,
        document: doc.id,
        msg: (err as Error).message?.slice(0, 200),
      });
    }
  }
  const contextLine = buildContextLine({
    sourceType,
    profile: opts.profile,
    sourceKind: opts.sourceKind,
    sourceRef: opts.sourceRef,
    version: doc.version,
    summary,
    stakeholders,
  });
  return { document_id: doc.id, version: doc.version, contextLine, summary, stakeholders };
}

/**
 * The one-line provenance summary threaded through capture as `attrs.context`
 * on every node born from a document — extracted so it can be recomputed for
 * a document whose routing was held (resolvePendingRoute), not just at the
 * original registerIngestDocument call.
 */
function buildContextLine(opts: {
  sourceType?: string;
  profile: Awaited<ReturnType<typeof profileFor>>;
  sourceKind: 'doc' | 'slack' | 'transcript' | 'interaction';
  sourceRef: string;
  version: number;
  summary: string;
  stakeholders: string[];
}): string {
  const who = opts.stakeholders.length > 0 ? `; stakeholders: ${opts.stakeholders.slice(0, 6).join(', ')}` : '';
  // Origin clarity: name the resolved source TYPE (e.g. "team conversation"),
  // not just the ingestion channel, so a node born in chat says so on its face.
  // Reads the same deterministic `sourceType` persisted at registration — it
  // used to read the router's classification, which meant the label silently
  // vanished on every document the router didn't classify.
  const typeLabel = opts.sourceType
    ? (opts.profile.source_types ?? []).find((s) => s.key === opts.sourceType)?.label
    : undefined;
  const originLabel = typeLabel ? `${typeLabel.toLowerCase()} (${opts.sourceKind})` : opts.sourceKind;
  return `From ${originLabel} "${opts.sourceRef}" (v${opts.version}${who}): ${opts.summary}`.slice(0, 700);
}

/** Annotate nodes with evidence strength for synthesis prompts. */
async function withEvidence(ws: string, nodes: readonly unknown[]): Promise<typeof nodes> {
  const counts = await repo.evidenceCounts(ws);
  return nodes.map((n) => {
    const node = n as { id: string };
    const ev = counts.get(node.id);
    return ev && ev.sources > 1
      ? { ...(n as object), evidence: { sources: ev.sources, latest: ev.latest } }
      : n;
  });
}

// Mail config resolved once at boot. Resend (HTTPS) takes precedence over
// SMTP — some cloud hosts block outbound SMTP ports, so HTTPS is
// the reliable production path. Both null → dev fallback (code returned inline).
const resendConfig = resendConfigFromEnv();
const smtpConfig = smtpConfigFromEnv();

/**
 * Deliver a transactional email through whichever provider is configured
 * (Resend over HTTPS wins; SMTP next). Returns `true` when a provider actually
 * sent it and `false` in dev (no provider) so callers can surface a preview
 * instead. Send failures are swallowed to a `false` — a notification email is
 * best-effort and must never fail the request that triggered it.
 */
async function deliverEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!resendConfig && !smtpConfig) return false;
  try {
    if (resendConfig) await sendMailViaResend({ config: resendConfig, to, subject, text });
    else await sendMail({ config: smtpConfig!, to, subject, text });
    return true;
  } catch (err) {
    log.warn('mail.notification_failed', { msg: (err as Error).message?.slice(0, 200) });
    return false;
  }
}

// Client IP: socket address, or the trusted proxy's entry in X-Forwarded-For
// (POMEGRANATE_TRUSTED_PROXY_HOPS) — never the spoofable leftmost value.
const clientIp = clientIpOf;

/**
 * The resolved ContextProfile for a workspace. Workspaces with no stored
 * profile (pre-profile, unmigrated) fall back to FALLBACK_PROFILE.
 */
async function profileFor(workspace_id: string, subgraph_id = 'default'): Promise<ContextProfileT> {
  return await repo.getWorkspaceProfile(workspace_id, subgraph_id) ?? FALLBACK_PROFILE;
}

/**
 * THE single resolver for "what profile governs a capture into this
 * subfolder right now" (spec-data-agents-and-subfolder-wiki.md §3's
 * branch). An active data agent's frozen template REPLACES the baseline
 * profile entirely — every caller that needs to interpret capture output
 * (the capture call itself, the kind-validity gate at insert) MUST go
 * through this, not re-derive `profileFor` independently, or a candidate
 * carrying the agent's kind keys gets validated against the wrong
 * taxonomy and silently dropped as "invalid_kind_dropped".
 */
/**
 * Owner-tier gate (spec-data-agents-and-subfolder-wiki.md §4.2): the
 * workspace owner OR a workspace_admin — the exact existing pattern already
 * used by `GET /workspaces/:ws/usage-analysis`, not a new check. Every
 * route this spec adds (attach/detach/change, template catalog CRUD, Save/
 * Save-as-new) uses this, deliberately narrower than the self-serve spec's
 * own `workspace_admin`/`leader` bound (§4.2 explains why).
 */
async function isWorkspaceOwnerTier(c: Context, ws: string): Promise<boolean> {
  const owner_email = ((await repo.getWorkspace(ws))?.owner_email ?? '').toLowerCase();
  const isOwner = owner_email === (await userEmail(c.get('user_id')) ?? '').toLowerCase();
  return isOwner || c.get('role') === 'workspace_admin';
}

async function capturingProfileFor(
  workspace_id: string,
  subgraph_id: string,
): Promise<{ profile: ContextProfileT; dataAgentActive: boolean }> {
  const activeAgent = await repo.getActiveDataAgent(workspace_id, subgraph_id);
  return activeAgent
    ? { profile: activeAgent.template, dataAgentActive: true }
    : { profile: await profileFor(workspace_id, subgraph_id), dataAgentActive: false };
}

/**
 * Slugify a profile id/name into a '#'-token slug, made unique against an
 * already-taken set. Lowercase, alnum + dashes only.
 */
function uniqueSlug(base: string, taken: Set<string>): string {
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'subgraph';
  let slug = root;
  let n = 2;
  while (taken.has(slug)) slug = `${root}-${n++}`;
  taken.add(slug);
  return slug;
}

/**
 * The active subgraph id for a request: an explicit `x-subgraph-id` header or
 * `?subgraph=` query (slug or id), validated against the workspace's
 * subgraphs; falls back to 'default'. Returns null when an explicit selector
 * names a subgraph that doesn't exist (caller turns that into a 400).
 */
async function resolveSubgraph(c: any, workspace_id: string): Promise<{ id: string } | null> {
  // Explicit `?subgraph=` query wins over the `x-subgraph-id` header. The web
  // client keeps the header pinned to the Library page's selected subgraph, so
  // per-action surfaces (e.g. the unified Curate inbox, which spans every
  // subgraph) pass an explicit query param to override that ambient header.
  const sel = c.req.query('subgraph') ?? c.req.header('x-subgraph-id');
  if (!sel || sel === 'default') return { id: 'default' };
  const byId = await repo.getSubgraph(workspace_id, sel);
  if (byId) return { id: byId.id };
  const bySlug = await repo.getSubgraphBySlug(workspace_id, sel);
  if (bySlug) return { id: bySlug.id };
  return null;
}

/**
 * Every subgraph id in a workspace, with 'default' always first. Used by the
 * whole-workspace curation surfaces (candidates list, conversation list) that
 * span subgraphs rather than scoping to one.
 */
async function subgraphIds(workspace_id: string): Promise<string[]> {
  const ids = new Set<string>(['default']);
  for (const s of await repo.listSubgraphs(workspace_id)) ids.add(s.id);
  return [...ids];
}

// ---------- middleware ----------
// Default (cloud) auth: session Bearer + workspace membership. The standalone
// embedding host can override both via ctx with single-local-identity no-ops.
const authn: MiddlewareHandler<{ Variables: AppVars }> =
  ctx.authn ??
  (async (c: any, next: any) => {
    const auth = c.req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    const token = auth.slice(7);
    const { value: sess, limited } = await authGuard.check(c, token, () => repo.getSession(token));
    if (limited) return limited;
    if (!sess) return c.json({ error: 'invalid session' }, 401);
    // MFA_REQUIRED policy, not yet enrolled: only the enrolment endpoints.
    if (sess.mfa_enrollment_required && !MFA_ENROLLMENT_PATHS.has(c.req.path)) {
      return c.json({ error: 'mfa_enrollment_required' }, 403);
    }
    // Signed in with an administrator-set password: replace it first.
    if (sess.password_change_required && !PASSWORD_CHANGE_PATHS.has(c.req.path)) {
      return c.json({ error: 'password_change_required' }, 403);
    }
    c.set('user_id', sess.user_id);
    c.set('via_sso', sess.via_sso);
    // Every LLM call made inside this request inherits the user_id. The
    // workspace_id and the caller-specific context (source_name, deliverable_kind…)
    // get layered on by workspaceGate + the specific endpoint via withLlmContext.
    await withLlmContext({ user_id: sess.user_id }, () => next());
  });

const workspaceGate: MiddlewareHandler<{ Variables: AppVars }> =
  ctx.workspaceGate ??
  (async (c: any, next: any) => {
    const workspace_id = c.req.param('ws') ?? c.req.header('x-workspace-id');
    if (!workspace_id) return c.json({ error: 'missing workspace_id' }, 400);
    // The reserved eval workspace is code-only: no product request may reach it,
    // even if a membership somehow exists. It has no members by construction, so
    // this is belt-and-suspenders over the getMembership check below.
    const mem = await repo.getMembership(workspace_id, c.get('user_id'));
    if (!mem) return c.json({ error: 'forbidden' }, 403);
    // Directory governance (phase1/governance.ts): viewers view and ask only;
    // a sensitive directory needs two-step verification on the account.
    if (mem.read_only && !viewerMayRequest(c.req.method, c.req.path, workspace_id)) {
      return c.json({ error: 'read_only', detail: 'you have view-only access to this directory' }, 403);
    }
    const wsRow = await repo.getWorkspace(workspace_id);
    const idpMfa = !!c.get('via_sso') && process.env.SSO_IDP_ENFORCES_MFA === '1';
    if (wsRow?.sensitive && !idpMfa && !(await hasTwoStep(repo, c.get('user_id')))) {
      return c.json({ error: 'mfa_required_for_sensitive_directory', detail: 'turn on two-step sign-in in Setup to open this directory' }, 403);
    }
    c.set('workspace_id', workspace_id);
    c.set('role', mem.role);
    // Layer the workspace onto the LLM-call context (user_id was set by authn).
    await withLlmContext({ workspace_id }, () => next());
  });

// ---------- Connected apps (per-user credentials, Settings) ----------

/**
 * Whether an app is connected for this user: every app in the catalog is a
 * Composio-backed connector, connected once the user has an active
 * user_composio_connections row. Default: disconnected.
 */
async function appConnected(appId: string, user_id: string): Promise<boolean> {
  if (COMPOSIO_CONNECTORS[appId]) return (await repo.getUserComposioConnection(user_id, appId))?.status === 'active';
  return false;
}

const COMPOSIO_CONNECTORS: Record<string, ComposioConnectorSpec> = {
  gmail: {
    ensureAuthConfig: ensureGmailAuthConfig,
    startConnect: startGmailConnect,
    refreshStatus: refreshGmailConnectionStatus,
    disconnect: disconnectGmail,
    listPickerItems: async () => [], // aggregate/filter pull, not a browsable list — see gmail-live.ts
  },
  github: {
    ensureAuthConfig: ensureGithubAuthConfig,
    startConnect: startGithubConnect,
    refreshStatus: refreshGithubConnectionStatus,
    disconnect: disconnectGithub,
    listPickerItems: listGithubRepos,
  },
  slack: {
    ensureAuthConfig: ensureSlackAuthConfig,
    startConnect: startSlackConnect,
    refreshStatus: refreshSlackConnectionStatus,
    disconnect: disconnectSlack,
    listPickerItems: listSlackConversations,
  },
  gdrive: {
    ensureAuthConfig: ensureDriveAuthConfig,
    startConnect: startDriveConnect,
    refreshStatus: refreshDriveConnectionStatus,
    disconnect: disconnectDrive,
    listPickerItems: async () => [], // single-document search picker, not a browsable list — see drive-live.ts
  },
  notion: {
    ensureAuthConfig: ensureNotionAuthConfig,
    startConnect: startNotionConnect,
    refreshStatus: refreshNotionConnectionStatus,
    disconnect: disconnectNotion,
    listPickerItems: async () => [], // single-document search picker, not a browsable list — see notion-live.ts
  },
  fathom: {
    ensureAuthConfig: ensureFathomAuthConfig,
    startConnect: startFathomConnect,
    refreshStatus: refreshFathomConnectionStatus,
    disconnect: disconnectFathom,
    listPickerItems: async () => [], // meeting search picker, not a browsable list — see fathom-live.ts
  },
  microsoft_teams: {
    ensureAuthConfig: ensureTeamsAuthConfig,
    startConnect: startTeamsConnect,
    refreshStatus: refreshTeamsConnectionStatus,
    disconnect: disconnectTeams,
    listPickerItems: listTeamsTeams,
  },
  jira: {
    ensureAuthConfig: ensureJiraAuthConfig,
    startConnect: startJiraConnect,
    refreshStatus: refreshJiraConnectionStatus,
    disconnect: disconnectJira,
    listPickerItems: listJiraProjects,
  },
};

/**
 * Ask the owner of a workspace for access — shared by the web route below and
 * the MCP `request_folder_access` tool, so the two cannot drift. The caller is
 * (by definition) NOT a member, so there is no workspaceGate here; the guard
 * rails are inside: the target workspace must be on the caller's own email
 * domain (you can only petition your own org), and the caller must not already
 * be a member. A public mailbox provider is not an org, so sharing gmail.com
 * with the owner buys nothing — only the owner's own folders resolve there
 * (`src/lib/email-domain.ts`). Emails the owner; the request is audited against
 * the target workspace so the owner sees it in their audit log even before they
 * grant.
 *
 * Returns the email preview when no mail provider is configured, so the flow is
 * testable (and usable in dev) without SMTP.
 */
async function requestWorkspaceAccess(opts: {
  workspace_id: string;
  user_id: string;
  message?: string;
  source_ip?: string;
  user_agent?: string;
}): Promise<
  | { ok: true; sent: boolean; owner_email: string; preview: { to: string; subject: string; text: string } }
  | { ok: false; error: 'unknown_user' | 'not_found' | 'forbidden' | 'already_member'; status: 401 | 403 | 404 | 409 }
> {
  const me = await repo.getUserById(opts.user_id);
  if (!me) return { ok: false, error: 'unknown_user', status: 401 };
  const ws = opts.workspace_id;
  const workspace = await repo.getWorkspace(ws);
  if (!workspace) return { ok: false, error: 'not_found', status: 404 };
  // Your own org, or your own folder (an owner who somehow holds no membership
  // row can still ask for it back — that one needs no domain relationship).
  const isOwner = me.email.trim().toLowerCase() === workspace.owner_email.trim().toLowerCase();
  if (!isOwner && !sameOrgDomain(me.email, workspace.owner_email)) {
    return { ok: false, error: 'forbidden', status: 403 };
  }
  if (await repo.getMembership(ws, opts.user_id)) return { ok: false, error: 'already_member', status: 409 };
  const note = typeof opts.message === 'string' ? opts.message.slice(0, 500).trim() : '';

  const subject = `${me.email} is requesting access to "${workspace.name}" on Pomegranate`;
  const text = [
    `${me.email} would like access to your Pomegranate workspace "${workspace.name}".`,
    ...(note ? ['', 'They added:', `    ${note}`] : []),
    '',
    'To grant access, open Pomegranate → Setup → Members and add them by email.',
    '',
    `Workspace id: ${ws}`,
  ].join('\n');
  const sent = await deliverEmail(workspace.owner_email, subject, text);

  await repo.logCustomerAudit(ws, {
    event: 'access_requested',
    actor_user_id: opts.user_id,
    actor_email: me.email,
    source_ip: opts.source_ip,
    user_agent: opts.user_agent,
    resource_type: 'workspace',
    resource_id: ws,
    payload: { requester: me.email, owner: workspace.owner_email, note: note || undefined },
  });
  return {
    ok: true,
    sent,
    owner_email: workspace.owner_email,
    preview: { to: workspace.owner_email, subject, text },
  };
}

// Short LLM synthesis of what the workspace's library ACTUALLY contains —
// the dashboard's "The context" blurb, and the ingest router's `currently_holds`
// input (RouteFolder.contentDigest). Cached by graph hash (CachedSynth), so it
// costs one Sonnet call per graph state; the long TTL is safe because any
// active-node mutation re-keys the cache. Failure degrades to summary:null —
// the dashboard falls back to the static profile description, and the router
// falls back to "(empty folder — nothing filed yet)".
const OVERVIEW_TTL_SEC = 7 * 24 * 3600;

/** Shared by the `/overview` route and `captureIntoSubgraph`'s first-node
 * trigger below — both need the identical compute-and-persist logic, not two
 * copies that can drift. Caller decides when it's worth paying for.
 *
 * Respects `generated_description_locked`: a human hand-edited the content
 * summary via PATCH .../subgraphs/:id, so an automatic refresh (triggered by
 * every ingest, and by opening Overview) leaves it untouched and just returns
 * the current value — the only way to recompute a locked summary is the
 * explicit regenerate endpoint, which clears the lock first. */
async function refreshSubgraphOverview(ws: string, subgraph_id: string): Promise<string | null> {
  const sg = await repo.getSubgraph(ws, subgraph_id);
  if (sg?.generated_description_locked) return sg.generated_description;
  // The workspace overview is one shared summary, so it's computed over team
  // nodes only (spec-node-visibility-controls §3.4) — private/shared nodes
  // never enter a synthesis every member reads. teamOnly keeps the cache key
  // identical across viewers. (Single-user-local mode sees its whole graph.)
  const graph = await repo.listNodes(ws, { activeOnly: true, teamOnly: !SINGLE_USER_LOCAL }, subgraph_id);
  if (graph.length === 0) {
    // No graph yet — clear any stale persisted synthesis for this subfolder.
    await repo.setSubgraphOverview(ws, subgraph_id, null);
    return null;
  }
  const profile = await profileFor(ws, subgraph_id);
  const cached = new CachedSynth(synth, repo, ws, OVERVIEW_TTL_SEC, profile);
  try {
    const { summary } = await withLlmContext(
      { caller: 'api.overview', context: { graph_node_count: graph.length } },
      () => cached.overview({ graph }),
    );
    // Persist the LLM-generated description onto THIS subfolder every call, so
    // each subgraph keeps its own latest synthesis independent of the others.
    await repo.setSubgraphOverview(ws, subgraph_id, summary || null);
    return summary || null;
  } catch (err) {
    log.warn('overview.failed', { workspace: ws, subgraph: subgraph_id, msg: (err as Error).message?.slice(0, 200) });
    return null;
  }
}

// ---- Ingestion/sharing rules (spec-directory-tracking-and-ingestion-rules.md) --
// Workspace-global policy authored by the workspace owner, synced like documents.
// Reads are open to any member; writes are gated to the owner (or a workspace
// admin — in the standalone the single local user is always both). GET seeds the
// three default rules on first access (idempotent — never resurrects a deleted
// default). Scope uses the unified 3-tier model (only_me | private | team).
const ruleWriteAllowed = async (ws: string, user_id: string, role: string | undefined): Promise<boolean> => {
  const owner_email = ((await repo.getWorkspace(ws))?.owner_email ?? '').toLowerCase();
  return owner_email === (await userEmail(user_id) ?? '').toLowerCase() || role === 'workspace_admin';
};

// Phase and target are inferred from the rule's free text by the model (spec
// §5.2), not asked of the user. Fail-open to the safe, most-common default.
// action is always 'shape' — the auto_approve/auto_reject/surface curation
// actions never applied to a live document (the product auto-applies every
// capture immediately) and are not classified anymore.
async function classifyRulePhaseAction(instructions: string): Promise<{
  phases: ('store' | 'use')[];
  target: 'node' | 'source' | 'both';
}> {
  // Blank drafts (freshly added rules) get the default without an LLM call.
  if (synth.classifyRule && instructions.trim()) {
    try {
      return await synth.classifyRule({ instructions });
    } catch {
      /* fall through to default */
    }
  }
  return { phases: ['store'], target: 'node' };
}

// Render a set of rule instructions into the capture-prompt policy block
// (numbered). Shared by the rule test and the live-ingest injection (R2).
function buildRulePolicy(rules: Array<{ instructions: string }>): string {
  const lines = rules.map((r) => r.instructions.trim()).filter(Boolean);
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

/**
 * Enabled shape automations for store/use-phase enforcement, merged with any
 * not-yet-migrated legacy `rules` rows (deduped by id — an automation row
 * always wins over a legacy row of the same id). This dual read closes the
 * ordering gap between "a workspace's rules were lazily migrated to
 * automations" (triggered by GET /automations) and "store ingest / use-phase
 * enforcement ran" — both must see the same active policy regardless of which
 * happened first. See repo.migrateRulesToAutomations.
 */
async function listShapeAutomations(ws: string): Promise<Array<{
  id: string;
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
}>> {
  const automations = await repo.listAutomations(ws, 'shape');
  const covered = new Set(automations.map((a) => a.id));
  const legacy = (await repo.listRules(ws)).filter((r) => !covered.has(r.id));
  return [
    ...automations.map((a) => ({
      id: a.id,
      instructions: a.instructions ?? '',
      scopes: a.scopes,
      phases: a.phases,
      action: a.action,
      target: a.target,
      enabled: a.enabled,
      owner_user_id: a.owner_user_id,
      sort_order: a.sort_order,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
    ...legacy.map((r) => ({
      id: r.id,
      instructions: r.instructions,
      scopes: r.scopes,
      phases: r.phases,
      action: r.action,
      target: r.target,
      enabled: r.enabled,
      owner_user_id: r.owner_user_id,
      sort_order: r.sort_order,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  ];
}

// The store-phase shaping policy for a workspace's live ingest (spec §5.3b):
// enabled rules whose phase includes `store` and whose action shapes/redacts
// content (auto-approve/reject/surface are curation-automation, handled at the
// disposition seam, not the capture prompt). Empty → undefined so capture is
// byte-identical when no shaping rules apply.
async function storeShapePolicy(ws: string): Promise<string | undefined> {
  const rules = (await listShapeAutomations(ws)).filter(
    (r) => r.enabled && r.phases.includes('store') && (r.action === 'shape' || r.action === null),
  );
  const policy = buildRulePolicy(rules);
  return policy || undefined;
}

// Source-level redaction (spec §5.2, source rules): enabled shape rules whose
// target includes the stored source scrub the document TEXT itself before it is
// persisted and captured — so PII/etc. is removed from the on-disk source too,
// not just the extracted nodes. Guarded to a size the small model can redact in
// a single call.
//
// FAILS CLOSED: when a rule applies but the scrub cannot run (no redactor, text
// over the size guard, or the redactor throws), this throws
// RedactionUnavailableError and the ingest stops before anything is stored,
// routed or captured. POMEGRANATE_REDACT_FAIL_OPEN=1 restores the old
// behaviour (store the original, warn). No applicable rule → unchanged.
const SOURCE_REDACT_MAX_CHARS = 20000;
async function redactSourceText(ws: string, text: string): Promise<{ text: string; changed: boolean }> {
  const rules = (await listShapeAutomations(ws)).filter(
    (r) =>
      r.enabled &&
      r.phases.includes('store') &&
      (r.action === 'shape' || r.action === null) &&
      (r.target === 'source' || r.target === 'both'),
  );
  if (rules.length === 0 || !text.trim()) return { text, changed: false };
  const refuse = (reason: RedactionUnavailableReason, event: string, fields: Record<string, unknown> = {}) => {
    if (redactFailOpen()) {
      log.warn(event, { workspace: ws, ...fields, fail_open: true });
      return { text, changed: false };
    }
    log.warn('rule_redact.source_refused', { workspace: ws, reason, ...fields });
    throw new RedactionUnavailableError(reason);
  };
  if (!synth.redactFields) return refuse('unavailable', 'rule_redact.source_skipped_no_redactor');
  if (text.length > SOURCE_REDACT_MAX_CHARS) {
    return refuse('too_long', 'rule_redact.source_skipped_too_long', { chars: text.length });
  }
  try {
    const { fields, changed } = await synth.redactFields({
      fields: { text },
      rules: rules.map((r) => ({ instructions: r.instructions })),
    });
    return { text: changed ? (fields.text ?? text) : text, changed };
  } catch (err) {
    return refuse('failed', 'rule_redact.source_failed_open', { msg: (err as Error).message?.slice(0, 200) });
  }
}

/**
 * Materialize (or clear) use-phase redaction for a set of nodes after their
 * audience changed (spec §5.3c). Only team-visible nodes get a redacted copy —
 * only_me/private are owner-scoped, so there is no broader audience to redact
 * for. When no use-phase shape rule applies (or nothing matches), the redaction
 * is cleared (NULL → non-owner reads serve the full node again). The redacted
 * copy is served to non-owner viewers by repo.listNodes.
 */
async function materializeUsePhaseRedaction(ws: string, nodeIds: string[], visibility: string): Promise<void> {
  if (nodeIds.length === 0) return;
  const rules = (await listShapeAutomations(ws)).filter(
    (r) => r.enabled && r.phases.includes('use') && (r.action === 'shape' || r.action === null),
  );
  const active = visibility === 'team' && rules.length > 0 && !!synth.redactFields;
  for (const id of nodeIds) {
    if (!active) {
      await repo.setNodeRedaction(ws, id, null);
      continue;
    }
    const info = await repo.getNodeForRedaction(ws, id);
    if (!info) continue;
    const node = info.node as unknown as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const k of ['title', 'summary', 'body']) {
      const v = node[k];
      if (typeof v === 'string' && v.length > 0) fields[k] = v;
    }
    if (Object.keys(fields).length === 0) {
      await repo.setNodeRedaction(ws, id, null);
      continue;
    }
    try {
      const { fields: red, changed } = await synth.redactFields!({
        fields,
        rules: rules.map((r) => ({ instructions: r.instructions })),
      });
      await repo.setNodeRedaction(ws, id, changed ? JSON.stringify({ ...node, ...red }) : null);
    } catch (err) {
      log.warn('rule_redact.materialize_failed', {
        workspace: ws,
        node_id: id,
        msg: (err as Error).message?.slice(0, 200),
      });
      await repo.setNodeRedaction(ws, id, null);
    }
  }
}
function ruleTestMode(rule: { phases: string[]; target: string }): RuleTestMode {
  if (rule.target === 'source' || rule.target === 'both') return 'source';
  if (rule.phases.includes('use')) return 'use';
  return 'ingestion';
}

/**
 * Resolve a shape rule/automation by id, trying the new `automations` table
 * first and falling back to the legacy `rules` table — same automations-row-
 * wins dual-read discipline as listShapeAutomations, so a preview/test works
 * against either an already-migrated automation or an unmigrated legacy rule.
 */
async function getShapeAutomationOrRule(
  ws: string,
  id: string,
): Promise<{ id: string; instructions: string; action: string | null; phases: string[]; target: string } | undefined> {
  const a = await repo.getAutomation(ws, id);
  if (a) return { id: a.id, instructions: a.instructions ?? '', action: a.action, phases: a.phases, target: a.target };
  const r = await repo.getRule(ws, id);
  return r ? { id: r.id, instructions: r.instructions, action: r.action, phases: r.phases, target: r.target } : undefined;
}

/**
 * Dry-run a rule against sample text/question (spec §5.5) — shared by the web
 * route and the MCP `test_rule` tool. Persists nothing. Callers gate on
 * ruleWriteAllowed BEFORE calling (LLM cost + owner tooling).
 */
async function testRuleAction(opts: {
  ws: string;
  rule_id: string;
  user_id: string;
  text?: string;
  question?: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  subgraph_id?: string;
}): Promise<{ ok: false; status: 400 | 404; error: string } | { ok: true; result: Record<string, unknown> }> {
  const { ws, user_id } = opts;
  const rule = await getShapeAutomationOrRule(ws, opts.rule_id);
  if (!rule) return { ok: false, status: 404, error: 'not_found' };
  const subgraph_id = opts.subgraph_id ?? 'default';
  const sourceRef = `rule-test:${rule.id}`;
  const mode = ruleTestMode(rule);
  log.info('rules.tested', { workspace: ws, user: user_id, rule_id: rule.id, mode });

  // SOURCE — show the document after the rule scrubs it.
  if (mode === 'source') {
    const text = opts.text ?? '';
    if (!text.trim()) return { ok: false, status: 400, error: 'text required' };
    let processed = text;
    let changed = false;
    if (synth.redactFields) {
      try {
        const r = await synth.redactFields({ fields: { text }, rules: [{ instructions: rule.instructions }] });
        changed = r.changed;
        processed = r.changed ? (r.fields.text ?? text) : text;
      } catch {
        /* fail-open: unchanged */
      }
    }
    return { ok: true, result: { mode, rule_id: rule.id, original: text, processed, changed } };
  }

  // USE — ask the same question with and without the rule's redaction on the
  // retrieved context, then show both answers (reuses the Ask synthesis).
  if (mode === 'use') {
    const question = (opts.question ?? opts.text ?? '').trim();
    if (!question) return { ok: false, status: 400, error: 'question required' };
    const profile = await profileFor(ws, subgraph_id);
    const pack = await buildScopedGraph({
      repo,
      workspace_id: ws,
      profile,
      scope: 'all',
      question,
      embedder: getEmbedder(),
      subgraph_id,
      // An LLM read on the tester's behalf: team + their own non-only_me notes.
      viewer: user_id,
    });
    // Node ids are the same before/after redaction (redaction rewrites text
    // fields, not membership), so the edge set is computed once and reused.
    const edges = await edgesForPackedGraph(repo, ws, [subgraph_id], pack.nodes);
    const ask = (graph: typeof pack.nodes) =>
      withLlmContext({ caller: 'rule_test.query', context: { subgraph_id } }, () =>
        synth.query({ graph, edges, scope: 'all', question, profile }),
      );
    const withoutAnswer = await ask(pack.nodes);
    // Redact each retrieved node's text fields with the rule, then re-ask.
    let redacted = pack.nodes;
    if (synth.redactFields) {
      redacted = await Promise.all(
        pack.nodes.map(async (n) => {
          const node = n as unknown as Record<string, unknown>;
          const fields: Record<string, string> = {};
          for (const k of ['title', 'summary', 'body']) {
            const v = node[k];
            if (typeof v === 'string' && v.length > 0) fields[k] = v;
          }
          if (Object.keys(fields).length === 0) return n;
          try {
            const r = await synth.redactFields!({ fields, rules: [{ instructions: rule.instructions }] });
            return (r.changed ? { ...node, ...r.fields } : node) as typeof n;
          } catch {
            return n;
          }
        }),
      );
    }
    const withAnswer = await ask(redacted);
    return { ok: true, result: { mode, rule_id: rule.id, question, without_rule_answer: withoutAnswer, with_rule_answer: withAnswer } };
  }

  // INGESTION (default) — the candidate diff, with vs without the rule injected.
  const text = opts.text ?? '';
  if (!text.trim()) return { ok: false, status: 400, error: 'text required' };
  const policy = buildRulePolicy([rule]);
  const withoutRule = await captureDryRun({ ws, source: text, source_kind: opts.source_kind, sourceRef, subgraph_id, viewer: user_id });
  const withRule = await captureDryRun({
    ws,
    source: text,
    source_kind: opts.source_kind,
    sourceRef,
    subgraph_id,
    rulePolicy: policy,
    viewer: user_id,
  });
  return {
    ok: true,
    result: {
      mode: 'ingestion',
      rule_id: rule.id,
      with_rule: withRule.candidates,
      without_rule: withoutRule.candidates,
      zero_yield: withRule.zeroYield,
    },
  };
}

async function userEmail(user_id: string): Promise<string | undefined> {
  const row = await repo.getUserEmailRow(user_id);
  return row?.email;
}

/**
 * Customer-audit for an account-level event (sign-in, sign-out, failed
 * sign-in, password change). The account spans every workspace the user is a
 * member of, so log one row per membership: each workspace's export then shows
 * every account event that affects who can act in it.
 */
async function logAccountAudit(
  c: any,
  user: { id: string; email: string },
  event: CustomerAuditEvent,
  payload?: Record<string, unknown>,
): Promise<void> {
  for (const w of await repo.listMembershipWorkspaceIds(user.id)) {
    await repo.logCustomerAudit(w.workspace_id, {
      event,
      actor_user_id: user.id,
      actor_email: user.email,
      source_ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? undefined,
      payload,
    });
  }
}


/**
 * Compute and store the embedding for a single graph_node row. Used by
 * the approve flow and by the boot-time backfill. Idempotent.
 */
async function embedAndStoreNode(ws: string, node: any): Promise<void> {
  const t0 = Date.now();
  const text = embeddingTextForNode(node);
  const embedder = getEmbedder();
  const vecs = await embedder.embed([text]);
  const v = vecs[0];
  if (!v) {
    log.warn('embeddings.node_no_vector', { workspace: ws, node_id: node.id, type: node.type });
    return;
  }
  await repo.setNodeEmbedding(ws, node.id, embeddingToBlob(v));
  log.debug('embeddings.node_stored', {
    workspace: ws,
    node_id: node.id,
    type: node.type,
    kind: node.kind,
    category: node.category,
    priority: node.priority,
    provider: embedder.name,
    dim: embedder.dim,
    text_chars: text.length,
    latency_ms: Date.now() - t0,
  });
}

// ---------- bulk curation (PRD § Curate UI > grouped inbox) ----------

/**
 * Stable, content-addressed signature of a pending candidate set. Used as
 * the cache key in `candidate_groups`. Sorted to make order-independent;
 * sha-256 truncated to 32 chars because collisions are not a security
 * concern (worst case we recompute a grouping for a workspace whose set
 * shape happens to hash-collide — astronomically unlikely).
 */
function pendingSignature(pendingIds: readonly string[]): string {
  return createHash('sha256').update([...pendingIds].sort().join(',')).digest('hex').slice(0, 32);
}

/** Type breakdown of a candidate batch, e.g. `{goal:2,decision:1}`. */
function candidatesByType(cands: ReadonlyArray<{ proposed_node?: any }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cands) {
    const t = c.proposed_node?.type ?? 'unknown';
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

function slimCandidate(c: {
  id: string;
  flag: 'red' | 'yellow' | 'green';
  proposed_node: any;
  source_ref: string;
}) {
  const pn = c.proposed_node;
  const summary =
    pn.type === 'goal'
      ? pn.title
      : pn.type === 'decision'
        ? pn.summary
        : (pn.body ?? '').slice(0, 200);
  return {
    id: c.id,
    flag: c.flag,
    type: pn.type as 'goal' | 'positioning' | 'decision',
    kind: pn.type === 'positioning' ? (pn.kind as string | undefined) : undefined,
    category: pn.type === 'decision' ? (pn.category as string | undefined) : undefined,
    priority: pn.type === 'goal' ? (pn.priority as string | undefined) : undefined,
    summary,
    source_ref: c.source_ref,
  };
}

/**
 * Compute-once grouping. Used by both the post-ingest auto-trigger and the
 * `/candidates/groups` endpoint. The grouping LLM is invoked at most ONCE
 * per workspace — the first time the workspace has pending candidates. Every
 * subsequent call returns the cached groups verbatim, regardless of whether
 * the pending set has changed (approve, reject, or new ingest). Items the
 * leader has since approved or rejected simply stop appearing on the Today
 * card because the UI filters group `candidate_ids` through its `byId` map of
 * the current pending set — depleted-to-empty groups render as empty cards.
 *
 * This is a deliberate departure from the PRD's "recompute on pending-set
 * drift" behavior; see commit message for rationale. The old signature-keyed
 * `getGroupsCache` / `setGroupsCache` primitives remain on the repo for
 * tests and future re-enable.
 */
async function ensureGroupsForWorkspace(
  ws: string,
  caller: string,
  subgraph_id = 'default',
): Promise<{
  groups: unknown[];
  candidates: any[];
  cached: boolean;
}> {
  const pending = await repo.listCandidates(ws, { status: 'pending' }, subgraph_id);

  // Compute-once: any prior cached entry for this workspace wins, even if
  // the pending-id-set has drifted since it was computed.
  const existing = await repo.getLatestGroupsCache(ws, subgraph_id);
  if (existing) {
    log.info('groups.cache_hit', {
      workspace: ws,
      caller,
      mode: 'compute_once',
      cached_signature: existing.signature,
      cached_candidate_count: existing.candidate_count,
      pending_now: pending.length,
      groups: existing.groups.length,
      cached_at: existing.created_at,
    });
    return { groups: existing.groups, candidates: pending, cached: true };
  }

  // Nothing cached yet. Need at least one pending candidate to compute.
  if (pending.length === 0) {
    log.debug('groups.skip_empty', { workspace: ws, caller });
    return { groups: [], candidates: [], cached: false };
  }

  const signature = pendingSignature(pending.map((p) => p.id));
  log.info('groups.compute_first', {
    workspace: ws,
    caller,
    candidate_count: pending.length,
    signature,
  });
  const slim = pending.map((c) => slimCandidate(c));
  const groups = await withLlmContext(
    {
      caller,
      context: { pending_count: pending.length, signature, mode: 'compute_once' },
    },
    () => synth.groupCandidates({ candidates: slim }),
  );
  await repo.setGroupsCache({
    workspace_id: ws,
    signature,
    groups,
    candidate_count: pending.length,
    subgraph_id,
  });
  log.info('groups.cache_write', {
    workspace: ws,
    signature,
    candidate_count: pending.length,
    groups: groups.length,
    mode: 'compute_once',
  });
  return { groups, candidates: pending, cached: false };
}



// ---------- context-aware triage (doc-centric review plan) ----------
// the internal design notes. The triage layer is policy
// + presentation only: it decides WHAT to show, WHAT to ask, and WHAT
// validation to seek, then routes every commit through the existing
// approve/reject primitives. Extraction, dedup, and approval semantics are
// untouched; flags/confidence are never rewritten.


/** Doc-id sentinel for candidates that arrived without a document. */
const LOOSE_PARAM = 'loose';

async function listCurationSources(ws: string, subgraph_id = 'default') {
  const docs = new Map((await repo.listDocuments(ws)).map((d) => [d.id, d]));
  const all = await repo.listCandidates(ws, undefined, subgraph_id);
  const counts = new Map<string, { pending: number; approved: number; rejected: number }>();
  for (const cand of all) {
    const key = cand.document_id ?? '';
    const row = counts.get(key) ?? { pending: 0, approved: 0, rejected: 0 };
    if (cand.status === 'pending') row.pending++;
    else if (cand.status === 'approved') row.approved++;
    else if (cand.status === 'rejected') row.rejected++;
    counts.set(key, row);
  }
  const convs = new Map((await repo.listCurationConversations(ws, subgraph_id)).map((r) => [r.document_id, r]));
  // The subgraph this list is scoped to — its slug/name tag each row so a
  // workspace-wide Curate inbox can show which subgraph an item belongs to.
  const sgMeta = await repo.getSubgraph(ws, subgraph_id);
  const ids = new Set<string>([...convs.keys()]);
  for (const [key, n] of counts) if (n.pending > 0) ids.add(key);
  const sources = [...ids].map((docId) => {
    const doc = docId ? docs.get(docId) : null;
    const conv = convs.get(docId);
    const n = counts.get(docId) ?? { pending: 0, approved: 0, rejected: 0 };
    return {
      document_id: docId || LOOSE_PARAM,
      source_ref: doc?.source_ref ?? (docId ? 'unknown' : 'Loose items'),
      source_kind: doc?.source_kind ?? null,
      version: doc?.version ?? null,
      summary: doc?.summary ?? null,
      subgraph_id,
      subgraph_slug: sgMeta?.slug ?? subgraph_id,
      subgraph_name: sgMeta?.name ?? subgraph_id,
      case: conv?.case_opened ?? null,
      status: conv?.status ?? 'new',
      counts: n,
      updated_at: conv?.updated_at ?? doc?.created_at ?? null,
    };
  });
  // Needs-attention first (pending desc), then recency.
  sources.sort((a, b) => (b.counts.pending - a.counts.pending) || String(b.updated_at).localeCompare(String(a.updated_at)));
  return sources;
}

/**
 * Derive the caller-facing zero-yield signal from a fan-out result. We only flag
 * it when the ingest produced NO candidates at all AND at least one target
 * subgraph tripped the relevant-but-empty tripwire — i.e. the extraction model
 * whiffed on a document the router thought was in-scope. A plain 0 with no
 * tripwire (routed irrelevant, or everything deduped as already-covered) is a
 * legitimate outcome and is NOT flagged, so the notice stays high-signal.
 *
 * A timeout is a DIFFERENT failure from a genuine miss (the request never
 * finished, rather than finishing and finding nothing) and gets its own
 * notice — telling someone to "check the source" for a capture that never
 * ran is actively misleading (2026-07-17 incident: a plain to-do list burned
 * 9+ minutes to a hosted-LLM timeout and reported the generic miss notice).
 */
function summarizeZeroYield(
  totalCandidates: number,
  routed: RoutedSubgraphResult[],
): { zero_yield: boolean; notice: string | null } {
  const tripped = totalCandidates === 0 && routed.some((r) => r.zero_yield);
  if (!tripped) return { zero_yield: false, notice: null };
  if (routed.some((r) => r.timed_out)) {
    return {
      zero_yield: true,
      notice:
        'This document was filed into a folder, but extraction timed out before it finished — ' +
        'the request never completed, so nothing was missed by the model. Re-ingest to retry; ' +
        'if it keeps timing out, the hosted extraction backend is overloaded or unreachable.',
    };
  }
  return {
    zero_yield: true,
    notice:
      'This document was filed into a folder, but the extraction model took nothing out of it. ' +
      'That usually means the extractor under-performed on this source, not that the document ' +
      'has nothing to say — re-ingest or check the source before assuming it was empty. ' +
      '(A document that fits no folder at all is reported separately, as a drop.)',
  };
}

/**
 * Decide which folder(s) a document feeds, and read the document once while
 * doing it. Rewritten 2026-07-17 (spec-pomegranate-light.md §4 "Routing ALWAYS
 * runs"; removals doc §4 task #11), then again to remove the silent drop:
 * routing now only ever decides (1) file into an existing folder or (2) ask a
 * human to create a new one — an empty verdict from the router is never the
 * end of the story, `proposeNewFolder` always follows it.
 *
 * Routing is the budget. Retrieval reads a whole folder, so the size of a folder
 * is the cost of every question ever asked of it, and nothing downstream can
 * undo a bad route — a misfiled document makes that folder slower, dearer, and
 * less accurate forever. Three gates used to make filing unconditional, and all
 * three are gone:
 *
 *  1. `if (subs.length <= 1) return ['default']` — routing never ran for a
 *     single-folder workspace, i.e. every new one, so the one folder that most
 *     needs guarding was the one nothing guarded. The router now ALWAYS runs:
 *     the question is not "which of these?" but "does this belong here at all?"
 *  2. `route-capture.relevant` — computed, then discarded. Gone with the prompt.
 *  3. `routed.length > 0 ? routed : ['default']` — one line that overruled every
 *     empty verdict into the default folder. An empty verdict is now returned as
 *     an empty verdict, and the caller always follows up by proposing a new folder.
 *
 * `slugs` are `#tokens` parsed from the raw source. A pin still wins — the user
 * said where it goes, and the user outranks inference — but the router runs
 * anyway, because it is also the thing that reads the document (summary +
 * stakeholders). A pinned document always has a non-empty target, so it never
 * reaches the new-folder proposal.
 *
 * A router CALL failure is not "nothing fits" — `[]` means the model decided
 * nothing fits; a timeout means we don't know. A failure therefore becomes a
 * pending routing decision instead of silently filing the document in a
 * special default folder.
 */
async function resolveIngestTargets(
  ws: string,
  slugs: string[],
  source: string,
  sourceRef: string,
): Promise<IngestRouting> {
  const pins: string[] = [];
  const seenPin = new Set<string>();
  for (const slug of slugs) {
    const sg = await repo.getSubgraphBySlug(ws, slug);
    if (!sg) {
      log.warn('ingest.unknown_subgraph_token', { workspace: ws, slug });
      continue;
    }
    if (!seenPin.has(sg.id)) {
      seenPin.add(sg.id);
      pins.push(sg.id);
    }
  }

  const subs = await repo.listSubgraphs(ws, { activeOnly: true });
  // A folder marked non-routable is excluded from the catalog the router
  // reads, so automatic inference can never pick it — UNLESS this document
  // pins it explicitly (#slug), which bypasses inference entirely anyway (see
  // `targets` below). This is the only place ingest routability is enforced;
  // `routeDocument`'s `validIds` (built from this same filtered list) is a
  // second backstop against a hallucinated id.
  const folders: RouteFolder[] = await Promise.all(subs
    .filter((s) => s.routable || pins.includes(s.id))
    .map(async (s) => {
      const p = await profileFor(ws, s.id);
      return {
        id: s.id,
        name: s.name,
        // The template's own name, e.g. "To-do list" — not its extraction
        // charter. Two folders built from the same template (identical charter)
        // are told apart by name/ownerDescription/contentDigest, not by charter
        // text repeated verbatim into the prompt.
        type: p.name,
        // The owner's own words for this folder, and what the folder actually
        // holds — the two inputs routing has never had. `generated_description` is
        // the persisted Overview synthesis, refreshed by the /overview route, and
        // is null until a folder has content: an empty folder routes on its
        // type + the owner's description alone, exactly as spec §4 says.
        ownerDescription: s.description,
        contentDigest: s.generated_description ?? undefined,
      };
    }));

  let route: Awaited<ReturnType<typeof routeDocument>>;
  try {
    route = await routeDocument({ source, folders, sourceRef });
  } catch (err) {
    log.warn('ingest.route_failed', {
      workspace: ws,
      msg: (err as Error).message?.slice(0, 200),
      pinned: pins.length > 0,
    });
    // With exactly one candidate folder there is no routing decision to hold
    // for — the document can only go one place, so a router outage must not
    // stall it. (This is the common case for a new workspace, and it is what
    // the old `default` fallback accidentally covered.) A MULTI-folder
    // workspace still holds for a human below: there the destination really
    // is unknown, and unknown ≠ nothing fits.
    if (pins.length === 0 && folders.length === 1) {
      const sole = folders[0]!;
      log.warn('ingest.route_failed.sole_folder', { workspace: ws, subgraph: sole.id });
      return {
        targets: [sole.id],
        pinned: false,
        summary: '',
        stakeholders: [],
        reason: 'Automatic routing was unavailable; this workspace has one folder, so the document was filed there.',
        failed: false,
        proposeNewFolder: null,
        needsApprovalTargets: [],
      };
    }
    // Unknown ≠ nothing fits. Hold it for a human instead of silently filing
    // it in the legacy default folder. The generic proposal keeps the existing
    // approval flow usable while the reason tells the user why it was held.
    return {
      targets: pins,
      pinned: pins.length > 0,
      summary: '',
      stakeholders: [],
      reason: 'Automatic routing failed, so this document needs a folder decision before it can be filed.',
      failed: true,
      proposeNewFolder: pins.length > 0 ? null : { name: 'New folder', description: '' },
      needsApprovalTargets: [],
    };
  }

  const pinned = pins.length > 0;
  const targets = pinned ? pins : route.target_subgraph_ids;
  // A pin is an explicit human instruction — it already outranks inference,
  // so neither gate applies: a new-folder proposal is moot (the user picked
  // an existing folder) and a low-confidence target isn't a guess anymore.
  const foldersById = new Map(folders.map((f) => [f.id, f]));
  const needsApprovalTargets = pinned
    ? []
    : targets.filter((id) => {
        const f = foldersById.get(id);
        if (!f) return false;
        const noOwnerDesc = !f.ownerDescription || f.ownerDescription.trim().toLowerCase() === 'miscellaneous';
        const noDigest = !f.contentDigest;
        return noOwnerDesc && noDigest;
      });

  // Nothing fit, and nothing was pinned — a SEPARATE single-job call names a
  // new folder for it (see proposeNewFolder's docstring for why this isn't
  // asked in the same call as routing). This ALWAYS ends up set: routing
  // never ends in a silent drop, so even a failed call here falls back to a
  // generic proposal rather than leaving the document filed nowhere with no
  // human ever asked.
  let folderProposal: IngestRouting['proposeNewFolder'] = null;
  if (!pinned && targets.length === 0) {
    try {
      const proposal = await proposeNewFolder({ source, sourceRef });
      folderProposal = proposal.propose_new_folder;
    } catch (err) {
      log.warn('ingest.propose_new_folder_failed', {
        workspace: ws,
        msg: (err as Error).message?.slice(0, 200),
      });
      folderProposal = { name: 'New folder', description: '' };
    }
  }

  return {
    targets,
    pinned,
    summary: route.summary,
    stakeholders: route.stakeholders,
    reason: route.reason,
    failed: false,
    proposeNewFolder: folderProposal,
    needsApprovalTargets,
  };
}

/**
 * Resolve which subgraph(s) a QUERY or DELIVERABLE should run against, and
 * their profiles (Phase 4). Mirrors `resolveIngestTargets` for the retrieval
 * side: a `#<slug>` token pins; otherwise the multi-subgraph classifier routes
 * (or, on empty/error, every active subgraph is queried — query everything
 * rather than nothing). A single-subgraph workspace takes a fast path with NO
 * classifier call, so it is byte-identical to the legacy path.
 *
 * `stripped` (the text with `#tokens` removed) is what callers MUST feed to
 * synthesis and recordContextAccess.request_text, so tokens never leak.
 *
 * `extraPin` (an optional slug/id from an MCP `subgraph` arg) is prepended to
 * any token-derived pins.
 */
async function resolveQueryTargets(
  ws: string,
  text: string,
  extraPin?: string,
): Promise<{
  targets: Array<{ subgraph_id: string; profile: ContextProfileT }>;
  stripped: string;
  pinned: boolean;
}> {
  const { stripped, slugs } = parseSubgraphTokens(text);
  const subs = await repo.listSubgraphs(ws, { activeOnly: true });

  // Single-subgraph fast path: no classifier, identical to legacy behaviour.
  if (subs.length <= 1) {
    const target = subs[0];
    if (!target) return { targets: [], stripped, pinned: false };
    return {
      targets: [{ subgraph_id: target.id, profile: await profileFor(ws, target.id) }],
      stripped,
      pinned: false,
    };
  }

  // Pins: an explicit `subgraph` arg (extraPin) prepends to token-derived slugs.
  const pinSelectors: string[] = [];
  if (extraPin) pinSelectors.push(extraPin);
  for (const s of slugs) pinSelectors.push(s);
  if (pinSelectors.length > 0) {
    const seen = new Set<string>();
    const targets: Array<{ subgraph_id: string; profile: ContextProfileT }> = [];
    for (const sel of pinSelectors) {
      // Accept a slug or an id (extraPin may be either; tokens are slugs).
      const sg = await repo.getSubgraphBySlug(ws, sel) ?? await repo.getSubgraph(ws, sel);
      if (!sg) {
        log.warn('query.unknown_subgraph_token', { workspace: ws, selector: sel });
        continue;
      }
      if (!seen.has(sg.id)) {
        seen.add(sg.id);
        targets.push({ subgraph_id: sg.id, profile: await profileFor(ws, sg.id) });
      }
    }
    if (targets.length > 0) return { targets, stripped, pinned: true };
    // Every pin was unknown → fall through to content routing.
  }

  // No (valid) pin: classify across ROUTABLE subgraphs only — a subfolder
  // marked non-routable is never picked by automatic classification, and
  // never entered in the empty/error "query ALL of them" fallback either
  // (only an explicit pin above ever reaches it). If every subgraph happens
  // to be marked non-routable — a degenerate config, not the expected case —
  // fall back to the full set rather than answering nothing.
  const routableSubs = subs.filter((s) => s.routable);
  const classifyPool = routableSubs.length > 0 ? routableSubs : subs;
  let routed: string[] = [];
  try {
    routed = await routeToSubgraphs(
      stripped,
      await Promise.all(classifyPool.map(async (s) => {
        const p = await profileFor(ws, s.id);
        return { id: s.id, name: s.name, description: p.description, routingHint: p.routing_hint };
      })),
    );
  } catch (err) {
    log.warn('query.subgraph_route_failed', { workspace: ws, msg: (err as Error).message?.slice(0, 200) });
    routed = [];
  }
  const ids = routed.length > 0 ? routed : classifyPool.map((s) => s.id);
  const targets = await Promise.all(ids.map(async (id) => ({ subgraph_id: id, profile: await profileFor(ws, id) })));
  return { targets, stripped, pinned: false };
}

/**
 * Capture one (already-stripped) source into ONE subgraph: subgraph-scoped
 * graph read → capture → dedup → evidence ledger → candidates → grouping →
 * curation. The same per-subgraph body the legacy single-subgraph ingest ran,
 * now scoped by `subgraph_id`. The shared document is registered once by the
 * caller; this routes/extracts INDEPENDENTLY into each target.
 */
/**
 * The persist-free core of a capture: build the subgraph's active graph →
 * LLM capture (optionally shaped by store-phase ingestion rules via rulePolicy)
 * (capture names its own amendments). Returns the candidates + the
 * capture trace WITHOUT writing anything (no insertCandidate, no evidence, no
 * audit/group/curation). Shared by the live `captureIntoSubgraph` (which then
 * persists) and the rule-test dry run (which discards). Factoring this out is
 * what keeps the rule test running the SAME capture the live ingest runs.
 */
async function captureAndDedup(opts: {
  ws: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  sourceRef: string;
  subgraph_id: string;
  caller: string;
  via: string;
  /** Store-phase rule policy injected into the capture prompt; omit = none. */
  rulePolicy?: string;
  viewer?: string;
}): Promise<{
  candidates: Candidate[];
  captureTrace: CaptureTraceEvent[];
  zeroYield: boolean;
  timedOut: boolean;
  rawCount: number;
}> {
  const { ws, source, source_kind, sourceRef, subgraph_id, caller, via, viewer } = opts;
  // The branch (spec §3): exactly one of the note path or the structured
  // path runs, decided once, here — never both.
  const { profile, dataAgentActive } = await capturingProfileFor(ws, subgraph_id);
  const graph = (await repo.listNodes(ws, { activeOnly: true, viewer, aiRead: true }, subgraph_id)).slice(0, 150);
  const captureTrace: CaptureTraceEvent[] = [];
  const rawCandidates = await withLlmContext(
    { caller, context: { source_kind, source_name: sourceRef, subgraph_id } },
    () =>
      synth.capture({
        graph,
        sourceKind: source_kind,
        source,
        profile,
        trace: captureTrace,
        sourceRef,
        rulePolicy: opts.rulePolicy,
        dataAgentActive,
      }),
  );
  log.info('ingest.captured', {
    workspace: ws,
    via,
    subgraph: subgraph_id,
    raw_candidates: rawCandidates.length,
    by_type: candidatesByType(rawCandidates),
  });
  const zeroYield = captureTrace.some((t) => t.stage === 'zero_yield');
  // A chunk that timed out (see anthropic.ts runCaptureSingle) is a DIFFERENT
  // failure than the model genuinely looking and finding nothing — surfaced
  // separately so the caller-facing notice doesn't say "the extractor
  // under-performed" when the real story is "the request never finished."
  const timedOut = captureTrace.some((t) => t.stage === 'capture_timeout');
  // The `items`-shape same-title dedup guard that used to live here converted
  // a repeated entity mention into an `amends` edge against the existing node.
  // Removed along with edge writing/inference (see notes.ts / edges.ts) —
  // `items`-shape has no live profile today, and a future one will need its
  // own dedup strategy designed around whatever, if anything, replaces
  // amends-style linking.
  const candidates: Candidate[] = rawCandidates;
  return { candidates, captureTrace, zeroYield, timedOut, rawCount: rawCandidates.length };
}

/**
 * Dry-run a capture for the rule-test loop (spec §5.5): run the exact same
 * capture+dedup the live ingest runs, optionally with a rule injected, but
 * persist NOTHING. Returns the candidate list in-memory (fresh preview ids).
 */
async function captureDryRun(opts: {
  ws: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  sourceRef: string;
  subgraph_id: string;
  rulePolicy?: string;
  viewer: string;
}): Promise<{ candidates: Candidate[]; zeroYield: boolean }> {
  const { candidates, zeroYield } = await captureAndDedup({
    ws: opts.ws,
    source: opts.source,
    source_kind: opts.source_kind,
    sourceRef: opts.sourceRef,
    subgraph_id: opts.subgraph_id,
    caller: 'rule_test',
    via: 'rule_test',
    rulePolicy: opts.rulePolicy,
    viewer: opts.viewer,
  });
  // Give each candidate a fresh in-memory preview id so the UI has stable keys;
  // nothing is written to the DB.
  const previewed = candidates.map((cand) => ({
    ...cand,
    id: `cpv_${nanoid(10)}`,
    proposed_node: { ...cand.proposed_node, id: `npv_${nanoid(10)}` },
  })) as Candidate[];
  return { candidates: previewed, zeroYield };
}

async function captureIntoSubgraph(opts: {
  ws: string;
  user_id: string;
  /** Stripped source text (no #tokens). */
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  /** Display/evidence source_ref shown to capture + the evidence ledger. */
  sourceRef: string;
  /** Fallback source_ref stored on the candidate row (e.g. `source:src_…`). */
  candidateSourceRef?: string;
  documentId: string;
  contextLine: string;
  subgraph_id: string;
  via: string;
  caller: string;
  source_ip?: string;
  user_agent?: string;
  /** Audience for nodes auto-integrated from this source (spec §4.3). */
  audience?: 'team' | 'private' | 'only_me';
  /** Used when `audience` is unset AND this folder has no default_audience. */
  fallbackAudience?: 'team' | 'private' | 'only_me';
  /** Owner recorded alongside `audience`; defaults to `user_id`. Differs only
   *  when capture is deferred and later run by someone else — a routing hold
   *  resolved by a teammate still belongs to whoever staged the document. */
  audienceOwnerUserId?: string;
  /** Run id shared with the routing call (and sibling folders of the same
   *  ingest) so diagnostics groups them as one document. Minted here if absent
   *  (e.g. a caller that captures without a preceding route). */
  ingestRunId?: string;
}): Promise<{ candidates: number; zeroYield: boolean; timedOut: boolean }> {
  const { ws, user_id, source, source_kind, sourceRef, documentId, contextLine, subgraph_id, via, caller } = opts;
  const candidateSourceRef = opts.candidateSourceRef ?? sourceRef;
  // Effective audience: an explicit choice wins, then the folder-level default,
  // then the caller's fallback. Unset at all three = the column default ('team').
  const audience =
    opts.audience ?? (await repo.getSubgraph(ws, subgraph_id))?.default_audience ?? opts.fallbackAudience;

  // Capture + dedup (persist-free core). Store-phase shaping rules (§5.3b) are
  // injected into the capture prompt; with none enabled, storeShapePolicy()
  // returns undefined and capture is byte-identical to before rules existed.
  // Diagnostics correlation: stamp one content-free run id on every LLM call of
  // this ingest (route → capture → glean → dedup all inherit it through the
  // AsyncLocalStorage context), so the local pipeline-diagnostics tool can group
  // a source's calls into a single run. Opaque id + the document id only — no
  // verbatim content reaches the log, so prod stays clean. See diag/.
  const ingest_run_id = opts.ingestRunId ?? `irun_${nanoid(10)}`;
  const { candidates, captureTrace, zeroYield, timedOut, rawCount } = await withLlmContext(
    { context: { ingest_run_id, document_id: documentId } },
    async () =>
      captureAndDedup({
        ws,
        source,
        source_kind,
        sourceRef,
        subgraph_id,
        caller,
        via,
        rulePolicy: await storeShapePolicy(ws),
        viewer: user_id,
      }),
  );
  // A per-subgraph `document_routing.source_type` write lived here, fed by the
  // capture route stage's classification. Removed 2026-07-17 with route-capture:
  // both ends of it are gone. The producer only ever fired for a template with
  // extraction_groups (none do), and the consumer was per-subgraph doc triage,
  // which Light deleted — so it wrote a column nothing reads, from an event
  // nothing emits. `repo.getDocumentSourceType` survives and falls back to the
  // shared `documents.source_type`, which registerIngestDocument still sets from
  // the deterministic channel match; that is the whole resolution now.
  //
  // Kind gate at the ingest sink: capture already enforces profile kinds, but
  // insertCandidate now throws on a foreign kind and one bad candidate must
  // not abort the whole ingest — filter here, warn, and keep the rest.
  // MUST resolve the same profile the capture call itself ran against
  // (capturingProfileFor, not the bare workspace baseline) — an active data
  // agent's candidates carry ITS kind keys (e.g. "bet"), which the baseline
  // `notes` profile doesn't declare; re-deriving the wrong profile here
  // would silently drop every one of them as "invalid_kind_dropped".
  const capturingProfile = await capturingProfileFor(ws, subgraph_id);
  const profileKinds = new Set(capturingProfile.profile.kinds.map((k) => k.key));
  const insertable = candidates.filter((cand) => {
    const kind = String((cand.proposed_node as { type?: unknown }).type);
    if (profileKinds.has(kind)) return true;
    log.warn('ingest.invalid_kind_dropped', { workspace: ws, subgraph: subgraph_id, kind, via });
    return false;
  });
  const insertedCandidateIds: string[] = [];
  // What each candidate does to the subfolder, keyed by the candidate row id
  // so the approve loop below can act on it once the node actually exists.
  // Read HERE, before insertCandidate, because `operation`/`amends` live on
  // ProfileCandidate but the strict `Candidate` type this function is typed
  // against (captureAndDedup's return) does not declare them — they die at
  // the candidate→node boundary otherwise (spec §2, and the historical
  // amendmentPlan this mirrors, recovered at commit 088fe51^). Only
  // meaningful when a data agent is active — see below.
  const amendmentPlan = new Map<string, { operation: string; amends?: string }>();
  for (const cand of insertable) {
    // Provider-supplied ids are advisory and collide across calls — always
    // mint a fresh persistence-layer id for both the candidate row and the
    // proposed node so a second ingest doesn't fail a UNIQUE constraint.
    const candId = `c_${nanoid(10)}`;
    const nodeId = `n_${nanoid(10)}`;
    const loose = cand as unknown as { operation?: string; amends?: string };
    amendmentPlan.set(candId, { operation: loose.operation ?? 'addition', amends: loose.amends });
    await repo.insertCandidate(
      ws,
      {
        ...cand,
        source_ref: cand.source_ref || candidateSourceRef || source_kind,
        id: candId,
        proposed_node: {
          ...cand.proposed_node,
          id: nodeId,
          attrs: {
            ...((cand.proposed_node as { attrs?: Record<string, unknown> }).attrs ?? {}),
            context: contextLine,
          },
        } as typeof cand.proposed_node,
      },
      documentId,
      subgraph_id,
    );
    insertedCandidateIds.push(candId);
  }
  log.info('ingest.committed', { workspace: ws, via, subgraph: subgraph_id, candidates: insertable.length });
  // Light auto-applies, always. Nothing is proposed for human approval, so a
  // candidate is an internal write-then-apply step rather than a review queue:
  // every insertable candidate becomes a node here. This branch was the
  // whole-doc special case pre-Light; it is now the ONLY path. Grouping and
  // conversational curation used to run below and are deleted — they existed to
  // make a review queue reviewable, and there is no queue. See spec §2.
  {
    const approvedNodeIds: string[] = [];
    for (const candId of insertedCandidateIds) {
      try {
        const node = await repo.approveCandidate(ws, candId, user_id);
        approvedNodeIds.push(node.id);
        if (audience) {
          const owner = opts.audienceOwnerUserId ?? user_id;
          await repo.setNodeVisibility(ws, node.id, audience, owner, user_id);
        }
        embedAndStoreNode(ws, node).catch((err) => {
          log.warn('embed_on_ingest_failed', {
            workspace: ws,
            node_id: node.id,
            msg: (err as Error).message?.slice(0, 200),
          });
        });

        // Supersede (spec §2/§3.1): scoped to an active data agent ONLY — a
        // folder with no agent never supersedes, matching the note baseline's
        // unchanged behavior. Three fail-safe rules, none of which existed
        // before this (the PR #128 lesson this codebase already learned once:
        // a rule the code doesn't enforce is a suggestion, not a guarantee).
        if (capturingProfile.dataAgentActive) {
          const plan = amendmentPlan.get(candId);
          if (plan && (plan.operation === 'change' || plan.operation === 'nuance')) {
            if (!plan.amends) {
              // Rule 1: no target named. Downgrades to a plain addition — the
              // node stays active, nothing archived.
              log.warn('ingest.amend_no_target', { workspace: ws, subgraph: subgraph_id, node: node.id, operation: plan.operation });
            } else {
              const target = await repo.getNode(ws, plan.amends);
              const targetSubgraph = target ? await repo.getNodeSubgraph(ws, plan.amends) : undefined;
              if (!target || targetSubgraph === undefined) {
                // Rule 2: named a node that doesn't exist (hallucinated id, or
                // one the subfolder no longer holds). Downgrade, same as above.
                log.warn('ingest.amend_target_missing', { workspace: ws, subgraph: subgraph_id, node: node.id, amends: plan.amends });
              } else if (targetSubgraph !== subgraph_id) {
                // Rule 3: named a node OUTSIDE this subfolder. Capture only
                // ever sees ONE subfolder's entries, so a foreign id is
                // fabricated — REFUSE, don't archive across a subgraph
                // boundary (isolation tripwire territory, CLAUDE.md).
                log.warn('ingest.amend_cross_subgraph_refused', {
                  workspace: ws,
                  subgraph: subgraph_id,
                  node: node.id,
                  amends: plan.amends,
                  amends_subgraph: targetSubgraph,
                });
              } else if (target.status === 'active') {
                await repo.archiveNode(ws, plan.amends, user_id);
                await repo.logAudit(ws, {
                  actor: user_id,
                  event: 'graph.node.superseded',
                  resource_type: 'graph_node',
                  resource_id: plan.amends,
                  payload: { superseded_by: node.id, operation: plan.operation },
                });
              }
              // target already archived: nothing to do — a later document
              // can't re-supersede an already-superseded entry.
            }
          }
        }
      } catch (err) {
        log.warn('ingest.auto_approve_failed', {
          workspace: ws,
          subgraph: subgraph_id,
          candidate: candId,
          msg: (err as Error).message?.slice(0, 200),
        });
      }
    }
    // Written after auto-apply so the trail names the notes this source produced.
    // source_name is the uploaded file's own name when there is one (file
    // uploads arrive as `source:<id>`); pasted/MCP text falls back to its ref.
    // `ref` is kept alongside it for existing audit exports.
    const sourceId = candidateSourceRef.startsWith('source:') ? candidateSourceRef.slice('source:'.length) : null;
    const fileName = sourceId ? await repo.getSourceOriginalName(ws, sourceId) : null;
    await repo.logCustomerAudit(ws, {
      event: 'source_ingested',
      actor_user_id: user_id,
      actor_email: await userEmail(user_id),
      source_ip: opts.source_ip,
      user_agent: opts.user_agent,
      resource_type: 'source',
      resource_id: documentId,
      payload: {
        kind: source_kind,
        ref: sourceRef,
        source_name: fileName ?? sourceRef,
        ...(sourceId ? { source_id: sourceId } : {}),
        document_id: documentId,
        candidates: insertable.length,
        nodes_created: approvedNodeIds.length,
        node_ids: approvedNodeIds,
        subgraph_id,
      },
    });
    if (approvedNodeIds.length > 0) {
      await repo.markWikisStale(ws, subgraph_id);
      log.info('ingest.auto_approved', {
        workspace: ws,
        via,
        subgraph: subgraph_id,
        nodes: approvedNodeIds.length,
      });
      await scheduleIngestFollowups(ws, subgraph_id, approvedNodeIds, caller, capturingProfile.dataAgentActive);
      // Fire-and-forget: don't make the ingest response wait on a Sonnet call.
      // `generated_description` (the router's `currently_holds` input) is
      // otherwise only refreshed by a human opening the Overview tab, so it
      // stays fresh for the router only if we resync it here on every ingest.
      refreshSubgraphOverview(ws, subgraph_id).catch((err) => {
        log.warn('ingest.overview_refresh_failed', {
          workspace: ws,
          subgraph: subgraph_id,
          msg: (err as Error).message?.slice(0, 200),
        });
      });
    }
    return { candidates: insertable.length, zeroYield, timedOut };
  }
}

/**
 * Re-run capture on every document currently in a subfolder, against
 * whatever profile now governs it — the "run now" action attach/change can
 * opt into instead of only ever catching future documents (spec-data-
 * agents-and-subfolder-wiki.md §6/§8's "once" cadence, offered in the UI
 * with nothing behind it until now: nothing read the cadence value, so
 * picking "Once" silently behaved exactly like "Every new document"). Must
 * run AFTER attachDataAgent so capturingProfileFor resolves the just-
 * attached template, not the outgoing one.
 *
 * Archives every currently-active node in the subfolder FIRST, not after —
 * the point of running immediately is a clean re-extraction under the new
 * taxonomy, not layering fresh structured entries on top of whatever the
 * old one (baseline notes, or a previous agent) left behind. This also
 * keeps captureAndDedup's own context window (it reads `activeOnly` nodes
 * as the model's "what's already known" input) clean of leftovers with a
 * completely different kind taxonomy that could never sensibly dedup
 * against the new entries anyway.
 */
async function runDataAgentBackfill(opts: {
  ws: string;
  subgraph_id: string;
  user_id: string;
  caller: string;
}): Promise<{ archived: number; documents: number; documents_skipped: number; candidates: number }> {
  const { ws, subgraph_id, user_id, caller } = opts;

  const existing = await repo.listNodes(ws, { activeOnly: true }, subgraph_id);
  for (const n of existing) await repo.archiveNode(ws, n.id, user_id);

  const profile = (await capturingProfileFor(ws, subgraph_id)).profile;
  const docs = await repo.listSubgraphDocuments(ws, subgraph_id);
  let documents = 0;
  let documents_skipped = 0;
  let candidates = 0;

  for (const row of docs) {
    const doc = await repo.getDocument(ws, row.document_id);
    if (!doc) {
      documents_skipped++;
      continue;
    }
    let text: string;
    try {
      text = await readWorkspaceText(repo.crypto, ws, FILES_DIR, docTextPath(ws, doc.id, doc.version));
    } catch {
      // Older ingest, or synced in without the text blob — skip, don't fail
      // the whole backfill over one unreadable document.
      documents_skipped++;
      continue;
    }
    if (!text.trim()) {
      documents_skipped++;
      continue;
    }
    const sourceKind = doc.source_kind as 'doc' | 'slack' | 'transcript' | 'interaction';
    const contextLine = buildContextLine({
      sourceType: doc.source_type ?? undefined,
      profile,
      sourceKind,
      sourceRef: doc.source_ref,
      version: doc.version,
      summary: doc.summary ?? '',
      stakeholders: doc.stakeholders,
    });
    try {
      const r = await captureIntoSubgraph({
        ws,
        user_id,
        source: text,
        source_kind: sourceKind,
        sourceRef: doc.source_ref,
        documentId: doc.id,
        contextLine,
        subgraph_id,
        via: 'data_agent_backfill',
        caller,
      });
      documents++;
      candidates += r.candidates;
    } catch (err) {
      log.warn('data_agent.backfill_document_failed', {
        workspace: ws,
        subgraph: subgraph_id,
        document: doc.id,
        msg: (err as Error).message?.slice(0, 200),
      });
      documents_skipped++;
    }
  }

  log.info('data_agent.backfilled', {
    workspace: ws,
    subgraph: subgraph_id,
    archived: existing.length,
    documents,
    documents_skipped,
    candidates,
  });
  return { archived: existing.length, documents, documents_skipped, candidates };
}

/**
 * THE text-ingest pipeline: source redaction → shared document registry →
 * target resolution → per-subgraph capture fan-out. Every ingest entry point
 * (web text route, web file route, MCP `ingest_document`, any future channel)
 * MUST call this — never copy the pipeline inline. The file route used to
 * carry its own copy and drifted: it silently skipped `redactSourceText`, so
 * source-level redaction rules did not apply to PDF/DOCX uploads.
 *
 * The HARD INVARIANT: a workspace with one ('default') subgraph and no #pin
 * runs exactly one capture into 'default', byte-identical to before fan-out.
 */
async function runTextIngest(opts: {
  ws: string;
  user_id: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  source_ref?: string;
  /** Candidate-row source_ref override (file route: `source:src_…`). */
  candidate_source_ref?: string;
  /** Log tag distinguishing the entry point ('text' web route, 'file', 'mcp'). */
  via: string;
  /** LLM-context caller tag (e.g. 'api.ingest', 'mcp.ingest_document'). */
  caller: string;
  source_ip?: string;
  user_agent?: string;
  /** Audience for nodes auto-integrated from this source (spec §4.3). Defaults
   * to 'team'. Flows to every target subgraph's capture. */
  audience?: 'team' | 'private' | 'only_me';
  /** Applied per target folder only when `audience` is unset and the folder has
   *  no default_audience of its own (the web app passes 'only_me'). */
  fallbackAudience?: 'team' | 'private' | 'only_me';
  /**
   * Caller already knows the destination folder — skip `resolveIngestTargets`
   * entirely (no router LLM call, not even for the summary). The UI's "add
   * directly to a folder" control and any future caller with a known
   * destination use this. Invalid/inactive id is the caller's job to reject
   * before calling (see the route handlers) — this function trusts it.
   */
  forcedSubgraphId?: string;
  mediaLog?: boolean;
}): Promise<{
  candidates: number;
  document_id: string;
  routed: RoutedSubgraphResult[];
  /** True when the doc was routed INTO a folder but extraction yielded nothing. */
  zero_yield: boolean;
  /** Human-readable caller hint, present only when zero_yield is true. */
  notice: string | null;
  /**
   * The router wanted to create a new folder, or picked an existing one with
   * neither an owner description nor content to go on. Routing was NOT
   * committed and capture did NOT run — resolve via resolvePendingRoute
   * (POST /workspaces/:ws/pending-routes/:id/{approve,choose,reject} or the
   * matching MCP/Slack tools) before this document is filed anywhere.
   */
  pending_approval?: boolean;
  /** Present only when `pending_approval` — id to resolve against. */
  pending_route_id?: string;
}> {
  const { ws, user_id, source, source_kind, source_ref, via, caller } = opts;
  const provenance = [];
  const readings: Array<{ name: string; mime: string; text: string }> = [];
  const seenAssets = new Set<string>();
  for (const ref of mediaProvenance()) {
    if (!(await media.canIngest(ref.workspace_id, user_id)) || !(await media.canIngest(ws, user_id)))
      throw new MediaError('asset_workspace_mismatch', 403);
    const original = await media.authorized(ref.workspace_id, ref.asset_id, user_id);
    const key = `${ref.workspace_id}:${ref.asset_id}`;
    if (!seenAssets.has(key)) {
      const reading = await media.runText(ref.workspace_id, ref.asset_id, ref.run_id);
      if (reading) readings.push({ name: original.original_name, mime: original.mime, text: reading.text });
      seenAssets.add(key);
    }
    if (ref.workspace_id === ws) provenance.push(ref);
    else {
      // Explicit surface filing into another authorized workspace gets its own
      // private asset reference. Never make a cross-workspace DB relationship.
      const copy = await media.upload(ws, user_id, original.original_name, original.mime, await media.read(original));
      provenance.push({ workspace_id: ws, asset_id: copy.id });
    }
  }

  // The filing agent may replace a full transcript with a short summary. Keep
  // the actual reading in the source before routing, redaction, and capture.
  // Read before a cross-workspace asset copy, which has no media run of its own.
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
  const originalText = normalize(source);
  const additions = readings
    .filter(({ text }) => !originalText.includes(normalize(text)))
    .map(({ name, mime, text }) => `[${mime.startsWith('audio/') ? 'Transcript' : 'Text read from image'} — ${name}]\n${text}`);
  const sourceText = additions.length ? [source.trim(), ...additions].filter(Boolean).join('\n\n') : source;

  log.info('ingest.received', {
    workspace: ws,
    user: user_id,
    via,
    kind: source_kind,
    source_ref: source_ref ?? null,
    source_chars: sourceText.length,
    media_text_appended: additions.length > 0,
  });

  // A faithful media log treats hashtags as source text, not routing commands.
  const { stripped: rawStripped, slugs } = opts.mediaLog && opts.forcedSubgraphId
    ? { stripped: sourceText, slugs: [] }
    : parseSubgraphTokens(sourceText);
  // Source-level rules scrub the document text BEFORE it is stored + captured, so
  // the redaction holds on the on-disk source and every node derived from it.
  const { text: stripped, changed: sourceRedacted } = await redactSourceText(ws, rawStripped);
  if (sourceRedacted) log.info('ingest.source_redacted', { workspace: ws, via });
  const ingestRef = source_ref ?? `${source_kind}-${new Date().toISOString().slice(0, 10)}`;

  // One content-free run id for the WHOLE ingest — the route call, and every
  // per-folder capture below, are stamped with it so the local diagnostics tool
  // groups them into a single document/session (a routed-nowhere document then
  // still shows as one document, not an orphan route call). Minted here, before
  // routing, because routing runs before the document is registered (no
  // document_id yet); the run id is the only key the route call can carry. See
  // diag/ correlate.ts (ingest_run_id → document_id bridge).
  const ingest_run_id = `irun_${nanoid(10)}`;

  // ROUTE FIRST, then register. The old order was the reverse — registration ran
  // the router to produce the summary, and routing then ran on that summary —
  // which is how a brand-voice document came to be dropped for "no rules on how
  // to sound": the summary was written against the DEFAULT folder's to-do-list
  // profile, so the router never saw the document, only a to-do list's
  // description of it. The router reads the document itself now, and its summary
  // flows down into registration. See removals doc §4 task #11.
  // A caller-supplied destination outranks inference the same way a `#pin`
  // does (see resolveIngestTargets's doc comment), but goes one step further:
  // it skips the router LLM call altogether rather than just overriding its
  // target list, because the caller isn't guessing — they picked the folder
  // before this document existed. No summary/stakeholders come out of this
  // (nothing read the document), same degraded-but-safe shape as the
  // route-call-failed fallback below already produces.
  const routing: IngestRouting = opts.forcedSubgraphId
    ? {
        targets: [opts.forcedSubgraphId],
        pinned: true,
        summary: '',
        stakeholders: [],
        reason: 'Added directly to this folder; routing skipped.',
        failed: false,
        proposeNewFolder: null,
        needsApprovalTargets: [],
      }
    : await withLlmContext({ context: { ingest_run_id } }, () => resolveIngestTargets(ws, slugs, stripped, ingestRef));

  // Register the shared document. Uses the default subgraph's profile for the
  // shared doc metadata (summary and stakeholders are profile-agnostic; the
  // shared documents.source_type is a fallback — each subgraph stores its own
  // source_type via document_routing).
  //
  // A DROPPED document is still registered: it is stored, downloadable, and
  // visible in Sources, with no routing rows and no nodes. That is what makes a
  // wrong drop diagnosable instead of a mystery zero-yield — the alternative is
  // a document that vanishes on upload with nothing to inspect.
  const ingestDoc = await registerIngestDocument({
    ws,
    source: stripped,
    sourceKind: source_kind,
    sourceRef: ingestRef,
    profile: await profileFor(ws, 'default'),
    summary: routing.summary,
    stakeholders: routing.stakeholders,
  });
  // Record who ingested it (and any explicit audience) — a document that yields
  // no notes is otherwise unattributable, and repo.documentVisibilityFilter
  // keeps such a document to its ingester.
  await repo.stampDocumentIngest(ws, ingestDoc.document_id, user_id, opts.audience ?? null);
  await media.link(ws, ingestDoc.document_id, ingestDoc.version, provenance, user_id);
  if (opts.mediaLog && opts.forcedSubgraphId) {
    const sg = opts.forcedSubgraphId;
    const nodeId = `media_note_${createHash('sha256')
      .update(JSON.stringify([ingestDoc.document_id, sg, user_id, provenance.map((p) => p.asset_id).sort()]))
      .digest('hex')
      .slice(0, 24)}`;
    const node = ProfileNode.parse({
      id: nodeId,
      type: 'note',
      status: 'active',
      title: ingestRef,
      body: stripped,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: ingestRef,
    });
    await repo.tx(async () => {
      if (!await repo.getNode(ws, nodeId)) {
        await repo.insertNode(ws, node as NodeT, user_id, undefined, sg);
        const sgAudience = opts.audience ?? (await repo.getSubgraph(ws, sg))?.default_audience ?? opts.fallbackAudience;
        await repo.setNodeVisibility(ws, nodeId, sgAudience ?? 'private', user_id, user_id);
        await repo.setNodeDocumentId(ws, nodeId, ingestDoc.document_id);
      }
      await repo.routeDocument(ws, ingestDoc.document_id, sg, { routed_by: 'manual' });
    });
    await scheduleIngestFollowups(ws, sg, [nodeId], caller);
    return {
      document_id: ingestDoc.document_id,
      candidates: 1,
      routed: [{ subgraph_id: sg, candidates: 1, zero_yield: false, timed_out: false }],
      zero_yield: false,
      notice: null,
    };
  }

  // registerIngestDocument persisted `stripped`; overwrite the download-as-txt
  // artifact with the ORIGINAL source so it is the verbatim input (tokens kept)
  // — UNLESS a source-level rule scrubbed the text, in which case the redacted
  // version is the canonical stored source (the whole point of a source rule).
  try {
    await writeWorkspaceFile(
      repo.crypto,
      ws,
      FILES_DIR,
      docTextPath(ws, ingestDoc.document_id, ingestDoc.version),
      sourceRedacted ? stripped : sourceText,
    );
  } catch (err) {
    log.warn('ingest.doc_text_persist_failed', {
      workspace: ws,
      document: ingestDoc.document_id,
      msg: (err as Error).message?.slice(0, 200),
    });
  }

  const { targets, pinned } = routing;

  log.info('ingest.routed', {
    workspace: ws,
    via,
    document: ingestDoc.document_id,
    targets,
    pinned,
    no_existing_folder: targets.length === 0,
    route_failed: routing.failed,
    reason: routing.reason.slice(0, 200) || '-',
  });

  // The router wants a new folder, or picked an existing one it had nothing
  // to go on (no owner description, no content yet). Hold the decision for a
  // human instead of committing routing/capture — see spec-pomegranate-light.md
  // "Routing is the most important stage": a wrong file-anywhere is expensive
  // and invisible, so the one case where the router is genuinely guessing gets
  // a checkpoint instead of an auto-apply. `proposeNewFolder` is ALWAYS set
  // when `targets` is empty and the document isn't pinned (resolveIngestTargets
  // guarantees it, falling back to a generic proposal on failure) — so an
  // empty `targets` always lands here, never falls through to a silent drop.
  // Prompt-injection check: text that addresses the AI is stored but
  // not captured until a person approves it, through the same hold.
  const injection = injectionCheckEnabled() ? detectInjection(source) : [];
  if (injection.length > 0) {
    const { id: pending_route_id } = await repo.createPendingRoute(ws, {
      document_id: ingestDoc.document_id,
      reason: `Possible prompt injection — review before it is filed: ${injection.map((m) => `[${m.rule}] "${m.excerpt}"`).join('; ')}`.slice(0, 1000),
      proposed_targets: targets,
      proposed_new_folder: routing.proposeNewFolder,
      low_confidence_targets: routing.needsApprovalTargets,
      audience: opts.audience,
      fallback_audience: opts.fallbackAudience,
      ingested_by: user_id,
    });
    await repo.logCustomerAudit(ws, {
      event: 'document_held_injection',
      actor_user_id: user_id,
      source_ip: opts.source_ip,
      user_agent: opts.user_agent,
      resource_type: 'document',
      resource_id: ingestDoc.document_id,
      payload: { rules: injection.map((m) => m.rule), pending_route_id, via },
    });
    log.warn('ingest.injection_held', { workspace: ws, via, document: ingestDoc.document_id, rules: injection.map((m) => m.rule) });
    return {
      candidates: 0,
      document_id: ingestDoc.document_id,
      routed: [],
      zero_yield: false,
      notice: 'held for review: possible prompt injection',
      pending_approval: true,
      pending_route_id,
    };
  }

  if (routing.proposeNewFolder || routing.needsApprovalTargets.length > 0) {
    const { id: pending_route_id } = await repo.createPendingRoute(ws, {
      document_id: ingestDoc.document_id,
      reason: routing.reason,
      proposed_targets: targets,
      proposed_new_folder: routing.proposeNewFolder,
      low_confidence_targets: routing.needsApprovalTargets,
      // Capture is deferred to the resolution, so the audience the caller
      // asked for has to be held with the decision — otherwise a document
      // staged 'private' comes back team-visible once it's approved.
      audience: opts.audience,
      fallback_audience: opts.fallbackAudience,
      ingested_by: user_id,
    });
    log.info('ingest.routing_pending_approval', {
      workspace: ws,
      via,
      document: ingestDoc.document_id,
      pending_route_id,
      new_folder: routing.proposeNewFolder?.name ?? null,
      low_confidence_targets: routing.needsApprovalTargets,
    });
    return {
      candidates: 0,
      document_id: ingestDoc.document_id,
      routed: [],
      zero_yield: false,
      notice: null,
      pending_approval: true,
      pending_route_id,
    };
  }

  const applied = await applyRoutedCapture({
    ws,
    user_id,
    documentId: ingestDoc.document_id,
    contextLine: ingestDoc.contextLine,
    targets,
    routedBy: pinned ? 'pinned' : 'router',
    source: stripped,
    source_kind,
    sourceRef: ingestRef,
    candidateSourceRef: opts.candidate_source_ref ?? source_ref,
    via,
    caller,
    source_ip: opts.source_ip,
    user_agent: opts.user_agent,
    audience: opts.audience,
    fallbackAudience: opts.fallbackAudience,
    ingestRunId: ingest_run_id,
  });
  return {
    candidates: applied.candidates,
    document_id: ingestDoc.document_id,
    routed: applied.routed,
    zero_yield: applied.zero_yield,
    notice: applied.notice,
  };
}

/**
 * Commit routing rows for every target and fan out capture into each,
 * independently. Extracted from `runTextIngest` so the same logic runs both
 * on the normal (confident) auto-apply path and when a held routing decision
 * is later resolved via `resolvePendingRoute`.
 *
 * Persists ALL routing rows up front, before any capture runs: capture is
 * slow and fallible (LLM latency/timeout), and doing it inline per target
 * meant a mid-fan-out failure aborted the loop and silently dropped every
 * LATER subgraph, leaving the document recorded only in the first target.
 * Committing routing first decouples the routing decision from capture
 * reliability — the document is correctly filed under every chosen subgraph,
 * and a failed capture can be retried without losing routing.
 */
async function applyRoutedCapture(opts: {
  ws: string;
  user_id: string;
  documentId: string;
  contextLine: string;
  targets: string[];
  routedBy: 'router' | 'pinned' | 'manual';
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  sourceRef: string;
  candidateSourceRef?: string;
  via: string;
  caller: string;
  source_ip?: string;
  user_agent?: string;
  audience?: 'team' | 'private' | 'only_me';
  fallbackAudience?: 'team' | 'private' | 'only_me';
  /** Owner to record for `audience`; defaults to `user_id`. Set only when the
   *  capture runs on someone else's behalf (routing resolved after a hold). */
  audienceOwnerUserId?: string;
  ingestRunId: string;
}): Promise<{
  candidates: number;
  routed: RoutedSubgraphResult[];
  zero_yield: boolean;
  notice: string | null;
}> {
  for (const sg of opts.targets) {
    await repo.routeDocument(opts.ws, opts.documentId, sg, { routed_by: opts.routedBy });
  }

  // Sequential — correctness over latency (better-sqlite3 is synchronous; the
  // awaited LLM calls would interleave, but a for-loop keeps the per-subgraph
  // reads/writes strictly ordered).
  const routed: RoutedSubgraphResult[] = [];
  for (const sg of opts.targets) {
    const result = await captureIntoSubgraph({
      ws: opts.ws,
      user_id: opts.user_id,
      source: opts.source,
      source_kind: opts.source_kind,
      sourceRef: opts.sourceRef,
      candidateSourceRef: opts.candidateSourceRef,
      documentId: opts.documentId,
      contextLine: opts.contextLine,
      subgraph_id: sg,
      via: opts.via,
      caller: opts.caller,
      source_ip: opts.source_ip,
      user_agent: opts.user_agent,
      audience: opts.audience,
      fallbackAudience: opts.fallbackAudience,
      audienceOwnerUserId: opts.audienceOwnerUserId,
      ingestRunId: opts.ingestRunId,
    });
    routed.push({
      subgraph_id: sg,
      candidates: result.candidates,
      zero_yield: result.zeroYield,
      timed_out: result.timedOut,
    });
  }

  const totalCandidates = routed.reduce((sum, r) => sum + r.candidates, 0);
  const { zero_yield, notice } = summarizeZeroYield(totalCandidates, routed);
  return { candidates: totalCandidates, routed, zero_yield, notice };
}

/**
 * Resolve a routing decision a human held (`pending_routes`) — approve it as
 * the router proposed (creating the folder first if one was proposed), pick
 * a different existing folder, or reject the document out of that folder
 * entirely. Status-guarded the same way `approveCandidate`/`approve_candidate`
 * are: a second resolution on an already-resolved row is `already_resolved`,
 * not a silent re-run.
 */
async function resolvePendingRoute(
  ws: string,
  pending_route_id: string,
  decision: { action: 'approve' | 'choose' | 'reject'; chosen_target_ids?: string[]; resolved_by: string },
  /**
   * Who is resolving. Required (not optional) so no caller can forget it:
   * pass null only for local single-user mode / internal callers, where the
   * check is skipped. A route the actor cannot see is not_found (404, so a
   * private hold isn't confirmed to exist); one they can see but didn't
   * ingest and aren't admin for is not_your_route (403).
   */
  actor: PendingRouteViewer | null,
): Promise<ResolvePendingRouteResult> {
  const pending = await repo.getPendingRoute(ws, pending_route_id, { viewer: actor ?? undefined });
  if (!pending) return { ok: false, error: 'not_found', status: 404 };
  if (!pendingRouteResolvableBy(pending, actor ?? undefined)) return { ok: false, error: 'not_your_route', status: 403 };
  if (pending.status !== 'pending') return { ok: false, error: 'already_resolved', status: 409 };

  if (decision.action === 'reject') {
    await repo.resolvePendingRoute(ws, pending_route_id, { status: 'rejected', resolved_by: decision.resolved_by });
    log.info('routing.pending_rejected', { workspace: ws, pending_route_id, document: pending.document_id });
    return { ok: true, action: 'rejected', targets: [] };
  }

  let targets: string[];
  let new_subgraph_id: string | undefined;

  if (decision.action === 'choose') {
    const chosen = decision.chosen_target_ids ?? [];
    const validIds = new Set((await repo.listSubgraphs(ws, { activeOnly: true })).map((s) => s.id));
    if (chosen.length === 0 || !chosen.every((id) => validIds.has(id))) {
      return { ok: false, error: 'invalid_targets', status: 400 };
    }
    targets = chosen;
  } else {
    // approve: use the router's own targets, creating the proposed folder first.
    // Always built from the one built-in template (DEFAULT_PROFILE_ID, 'notes') —
    // there's nothing else to choose between since the template collapse.
    targets = [...pending.proposed_targets];
    if (pending.proposed_new_folder) {
      const profile = getBuiltinProfile(DEFAULT_PROFILE_ID)!;
      const taken = new Set((await repo.listSubgraphs(ws)).map((s) => s.slug));
      const slug = uniqueSlug(pending.proposed_new_folder.name || profile.id, taken);
      const { id } = await repo.createSubgraph(ws, {
        slug,
        name: pending.proposed_new_folder.name || profile.name,
        description: pending.proposed_new_folder.description,
      });
      await repo.setWorkspaceProfile(ws, profile.id, profile, id);
      new_subgraph_id = id;
      targets = [id, ...targets];
    }
  }

  const doc = await repo.getDocument(ws, pending.document_id);
  if (!doc) return { ok: false, error: 'not_found', status: 404 };
  let source: string;
  try {
    source = await readWorkspaceText(repo.crypto, ws, FILES_DIR, docTextPath(ws, doc.id, doc.version));
  } catch {
    return { ok: false, error: 'not_found', status: 404 };
  }

  await repo.resolvePendingRoute(ws, pending_route_id, { status: 'approved', resolved_by: decision.resolved_by });

  // Same provenance line capture would have gotten at the original ingest —
  // recomputed here since it isn't persisted (registerIngestDocument only
  // stores summary/stakeholders, not the derived line itself).
  const contextLine = buildContextLine({
    sourceType: doc.source_type ?? undefined,
    profile: await profileFor(ws, 'default'),
    sourceKind: doc.source_kind as 'doc' | 'slack' | 'transcript' | 'interaction',
    sourceRef: doc.source_ref,
    version: doc.version,
    summary: doc.summary ?? '',
    stakeholders: doc.stakeholders,
  });

  const applied = await applyRoutedCapture({
    ws,
    user_id: decision.resolved_by,
    documentId: pending.document_id,
    contextLine,
    targets,
    routedBy: 'manual',
    source,
    source_kind: doc.source_kind as 'doc' | 'slack' | 'transcript' | 'interaction',
    sourceRef: doc.source_ref,
    via: 'pending-route-resolution',
    caller: decision.action === 'choose' ? 'routing.choose_route' : 'routing.approve_route',
    // Honor the audience the original ingest asked for. The nodes belong to
    // whoever staged the document, not to whoever resolved the hold — a
    // teammate approving Alice's private ingest must not take ownership of it
    // (nor publish it to the folder, which is what happened before this).
    audience: pending.audience ?? undefined,
    fallbackAudience: pending.fallback_audience ?? undefined,
    audienceOwnerUserId: pending.ingested_by ?? undefined,
    ingestRunId: `irun_${nanoid(10)}`,
  });

  log.info('routing.pending_resolved', {
    workspace: ws,
    pending_route_id,
    document: pending.document_id,
    action: decision.action,
    targets,
    new_subgraph_id: new_subgraph_id ?? null,
  });

  return {
    ok: true,
    action: decision.action === 'choose' ? 'chosen' : 'approved',
    targets,
    new_subgraph_id,
    candidates: applied.candidates,
    routed: applied.routed,
  };
}

/**
 * The instructions path for Add Source: instead of the plain router
 * (runTextIngest above), hand the document to the add-source agent — same
 * engine as the Slack surface agent, a narrow ingest_document/create_subfolder
 * tool catalog — and let it decide whether to transform the text and where it
 * goes. The agent's own ingest_document call is what actually runs
 * runTextIngest under the hood, so redaction/registration/capture are
 * unchanged; this just decides the destination and shape first.
 */
async function runInstructedIngest(opts: {
  ws: string;
  user_id: string;
  instructions: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  source_ref?: string;
  source_ip?: string;
  user_agent?: string;
  // Overrides whatever audience the model picks — see add-source-agent.ts's
  // wrapIngestDocument §3. Callers that already have an explicit
  // visibility/audience picker outside the instructions text (e.g. the
  // Chrome extension's capture card) should pass it here rather than leaving
  // it to the model's judgment.
  audience?: 'team' | 'private' | 'only_me';
  // Used when neither `audience`, the model, nor the destination folder's
  // default_audience picks one (the web app passes 'only_me').
  fallbackAudience?: 'team' | 'private' | 'only_me';
  // Pins the destination folder instead of leaving it to the agent — see
  // add-source-agent.ts's wrapIngestDocument §4. Already-resolved subgraph
  // id; callers that only have a slug/id from user input resolve it before
  // calling in (mirrors how the plain ingest_document path validates it).
  forcedSubgraph?: string;
}) {
  const folders = (await repo.listSubgraphs(opts.ws, { activeOnly: true })).map((s) => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
  }));
  const templates = listBuiltinProfiles().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
  }));
  const ctx: ToolCtx = {
    ws: opts.ws,
    home_ws: opts.ws,
    user_id: opts.user_id,
    source_ip: opts.source_ip,
    user_agent: opts.user_agent,
    via: 'in_app_agent',
    fallback_audience: opts.fallbackAudience,
  };
  const result = await withLlmContext(
    { workspace_id: opts.ws, user_id: opts.user_id, caller: 'api.add_source_agent' },
    () =>
      runAddSourceAgent({
        instructions: opts.instructions,
        source: opts.source,
        source_kind: opts.source_kind,
        source_ref: opts.source_ref,
        ctx,
        tools: surfaceTools,
        folders,
        templates,
        audience: opts.audience,
        forcedSubgraph: opts.forcedSubgraph,
      }),
  );
  const ingestReceipt = result.receipts.find((r) => r.tool === 'ingest_document' && r.ok);
  // The agent's ingest_document call hit a fail-closed source-redaction rule
  // and nothing else was filed: surface the refusal to the caller (422) rather
  // than a 200 with the agent's prose about it.
  const refused = result.receipts.find(
    (r) => r.tool === 'ingest_document' && !r.ok && r.result.error === 'redaction_unavailable',
  );
  if (!ingestReceipt && refused) {
    const reason = refused.result.reason;
    throw new RedactionUnavailableError(reason === 'too_long' || reason === 'unavailable' ? reason : 'failed');
  }
  const subfolderReceipt = result.receipts.find((r) => r.tool === 'create_subfolder');
  return {
    message: result.message,
    receipts: result.receipts,
    candidates: typeof ingestReceipt?.result.candidates === 'number' ? ingestReceipt.result.candidates : 0,
    document_id: typeof ingestReceipt?.result.document_id === 'string' ? ingestReceipt.result.document_id : null,
    subgraph:
      subfolderReceipt && typeof subfolderReceipt.result.subgraph_id === 'string'
        ? { id: subfolderReceipt.result.subgraph_id, name: String(subfolderReceipt.result.name ?? '') }
        : null,
  };
}

/**
 * Shared ingest step for the apps/:app/pull route — mirrors /ingest's
 * instructions branch (same runInstructedIngest engine, never a separate
 * one) so a connector pull gets identical destination/transform behavior to
 * Upload/Paste. When no instructions are given, falls through to the plain
 * runTextIngest path exactly as before this existed.
 */
async function ingestForAppsPull(opts: {
  ws: string;
  user_id: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  source_ref: string;
  source_ip?: string;
  user_agent?: string;
  audience?: 'team' | 'private' | 'only_me';
  forcedSubgraphId?: string;
  instructions?: string;
}): Promise<{ document_id: string | null; candidates: number; message?: string }> {
  if (opts.instructions) {
    const result = await runInstructedIngest({
      ws: opts.ws,
      user_id: opts.user_id,
      instructions: opts.instructions,
      source: opts.source,
      source_kind: opts.source_kind,
      source_ref: opts.source_ref,
      source_ip: opts.source_ip,
      user_agent: opts.user_agent,
    });
    // The agent can legitimately decide not to ingest (e.g. it judges the
    // instructions out of scope) — document_id stays null rather than faking
    // a result; the route surfaces result.message in that case instead of a
    // candidate count.
    return { document_id: result.document_id, candidates: result.candidates, message: result.message };
  }
  const result = await runTextIngest({
    ws: opts.ws,
    user_id: opts.user_id,
    source: opts.source,
    source_kind: opts.source_kind,
    source_ref: opts.source_ref,
    via: 'app',
    caller: 'api.apps_pull',
    source_ip: opts.source_ip,
    user_agent: opts.user_agent,
    audience: opts.audience,
    forcedSubgraphId: opts.forcedSubgraphId,
  });
  return { document_id: result.document_id, candidates: result.candidates };
}

// Background follow-ups after a batch of nodes is auto-approved. Used to also
// schedule LLM edge inference here directly; that pass (and the `amends` edge
// kind it existed to maintain) was removed 2026-07-31 — this stayed the one
// choke point every node-creating path already goes through for what was
// left. Edge inference is revived here (spec-data-agents-and-subfolder-
// wiki.md §2/§3.1/§7), scoped to `dataAgentActive` batches only: a data
// agent's content is auto-applied with no candidate-approval queue for this
// call to wait on (unlike the recovered prompt's own frontmatter, which
// still says "after candidate approval" — that queue doesn't exist on this
// path, so this IS the correct trigger, not a placeholder for a better one).
// Fire-and-forget like scheduleAutoGroup: a hiccup here must not impact the
// approval that already committed the node.
async function scheduleIngestFollowups(
  workspace_id: string,
  subgraph_id: string,
  node_ids: string[],
  caller: string,
  dataAgentActive = false,
): Promise<void> {
  if (node_ids.length === 0) return;
  // Wiki currency (spec §11.3 event-driven mark): the canon just changed, so the
  // affected subfolder's wiki is now potentially stale. Nodes are subgraph-local,
  // so flag only the subfolder(s) this batch touched — a change in one subfolder
  // must not read as staleness in the others. Per-subgraph staleness is then
  // recomputed against the watermark on read.
  for (const sg of await repo.subgraphIdsForNodes(workspace_id, node_ids)) {
    await repo.markWikisStale(workspace_id, sg);
  }
  if (dataAgentActive) {
    // Adapter: inferLlmEdges reads `getWorkspaceProfile` to resolve the
    // taxonomy — but for this batch that MUST be the agent's template, not
    // the subfolder's baseline (the same class of bug fixed in
    // capturingProfileFor/invalidKindFor above). Override just that one
    // method rather than touch the recovered file.
    // NOT a spread — `repo`'s methods live on the class prototype, not as
    // own properties, so `{ ...repo }` silently drops every method and
    // leaves only its data fields. Bind explicitly.
    const edgeRepo: EdgeRepo = {
      getWorkspaceProfile: async (ws: string, sg?: string) => (await capturingProfileFor(ws, sg ?? 'default')).profile,
      listNodes: repo.listNodes.bind(repo),
      addEdge: repo.addEdge.bind(repo),
      getNodeDocumentId: repo.getNodeDocumentId.bind(repo),
    };
    setImmediate(() => {
      inferLlmEdges(edgeRepo, workspace_id, subgraph_id, node_ids).catch((err) => {
        log.warn('edge_inference.auto_trigger_failed', {
          workspace: workspace_id,
          subgraph: subgraph_id,
          caller,
          msg: (err as Error).message?.slice(0, 200),
        });
      });
    });
  }
}

// ---------- MCP HTTP transport ----------
const mcpDeps: McpDeps = {
  repo,
  media,
  baseSynth: synth,
  ingestText: runTextIngest,
  // Same instructions-driven agent "Add Source → Instructions" uses (see
  // runInstructedIngest) — the ingest_document MCP tool's `instructions` arg
  // routes here instead of the plain router when set.
  ingestInstructed: runInstructedIngest,
  // Sources stay: a vault still shows you what went in. Everything that used to
  // hang off them — accept/reject source, bulk accept/reject items, revert,
  // answer-question — is gone with curation. Ingest applies; there is nothing to
  // accept.
  listSources: listCurationSources,
  // Routing approval: the one place ingest still holds for a human — see
  // resolveIngestTargets / runTextIngest.
  resolvePendingRoute,
  // Discovery: request_folder_access runs the SAME orchestration as the web
  // "Request access" button (domain gate, membership check, owner email).
  requestFolderAccess: async (opts) => {
    const r = await requestWorkspaceAccess(opts);
    if (r.ok) return { ok: true, sent: r.sent, owner_email: r.owner_email };
    // 'unknown_user' can't happen behind MCP auth (the token resolved a user);
    // fold it into not_found rather than widening the tool's error surface.
    if (r.error === 'unknown_user') return { ok: false, error: 'not_found', status: 404 };
    if (r.error === 'forbidden') return { ok: false, error: 'forbidden', status: 403 };
    if (r.error === 'already_member') return { ok: false, error: 'already_member', status: 409 };
    return { ok: false, error: 'not_found', status: 404 };
  },
  // Rules: same owner gate + instruction classifier + dry-run as the web routes.
  ruleWriteAllowed: async (ws, user_id) =>
    await ruleWriteAllowed(ws, user_id, (await repo.getMembership(ws, user_id))?.role),
  classifyRule: classifyRulePhaseAction,
  testRule: testRuleAction,
};

// ---------- surface agent (Slack relay) ----------
//
// One endpoint takes a Slack-shaped message, resolves the sender to a
// Pomegranate user via their linked identity (Setup → Profile), and runs the
// LLM agent over the SAME tool catalog the MCP transports serve — identical
// capability and authorization on every surface. The relay authenticates
// with a single shared secret (env on both sides); per-user trust comes from
// Slack itself (the surface verifies Slack's signatures / socket auth).

const surfaceTools = createTools(mcpDeps);

/** Constant-time check of the relay's shared secret. */
function surfaceSecretOk(header: string | undefined): boolean {
  const secret = process.env.SURFACE_AGENT_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The relay's secret check under the per-IP failure budget: a 401/429 to return, or undefined when it passes. */
async function surfaceDenied(c: any): Promise<Response | undefined> {
  const header = c.req.header('x-surface-secret') as string | undefined;
  const { value: ok, limited } = await authGuard.check(c, header, () => surfaceSecretOk(header));
  return limited ?? (ok ? undefined : c.json({ error: 'unauthorized' }, 401));
}

/**
 * The effective folder for a surface call: the user's per-surface default,
 * else the folder of their last recorded activity, else their only folder.
 * Null when they have several, no default, and no activity yet — the caller
 * turns that into a "pick a default in Setup" reply.
 */
async function surfaceFolderFor(user_id: string, surface: 'slack' | 'mcp' | 'whatsapp'): Promise<string | null> {
  const dflt = await repo.getUserDefault(user_id, surface);
  if (dflt) return dflt.workspace_id;
  const lastActive = await repo.getLastActivityWorkspace(user_id);
  if (lastActive) return lastActive;
  const memberships = await repo.listMembershipsWithWorkspace(user_id);
  return memberships.length === 1 ? memberships[0]!.id : null;
}

const UNMAPPED_REPLY =
  "I don't know who you are on Pomegranate yet. To link this Slack account, open Pomegranate → Setup → Your profile → Connect Slack, get a link code, and send it to me here in a direct message.";
const NO_DEFAULT_REPLY =
  'You belong to several directories and none is set as your Slack default. Open Pomegranate → Setup in the directory you want and press "Make default" for Slack.';

return {
  ctx,
  repo,
  synth,
  FILES_DIR,
  media,
  PUBLIC_ORIGIN,
  corsOrigins,
  authLimiter,
  authRateLimit,
  docTextPath,
  docTextFilenames,
  SINGLE_USER_LOCAL,
  viewerFor,
  registerIngestDocument,
  buildContextLine,
  withEvidence,
  resendConfig,
  smtpConfig,
  deliverEmail,
  clientIp,
  profileFor,
  isWorkspaceOwnerTier,
  capturingProfileFor,
  uniqueSlug,
  resolveSubgraph,
  subgraphIds,
  authn,
  workspaceGate,
  appConnected,
  COMPOSIO_CONNECTORS,
  requestWorkspaceAccess,
  OVERVIEW_TTL_SEC,
  refreshSubgraphOverview,
  ruleWriteAllowed,
  classifyRulePhaseAction,
  buildRulePolicy,
  listShapeAutomations,
  storeShapePolicy,
  SOURCE_REDACT_MAX_CHARS,
  redactSourceText,
  materializeUsePhaseRedaction,
  ruleTestMode,
  getShapeAutomationOrRule,
  testRuleAction,
  userEmail,
  logAccountAudit,
  embedAndStoreNode,
  pendingSignature,
  candidatesByType,
  slimCandidate,
  ensureGroupsForWorkspace,
  LOOSE_PARAM,
  listCurationSources,
  summarizeZeroYield,
  resolveIngestTargets,
  resolveQueryTargets,
  captureAndDedup,
  captureDryRun,
  captureIntoSubgraph,
  runDataAgentBackfill,
  runTextIngest,
  applyRoutedCapture,
  resolvePendingRoute,
  runInstructedIngest,
  ingestForAppsPull,
  scheduleIngestFollowups,
  mcpDeps,
  surfaceTools,
  surfaceSecretOk,
  surfaceDenied,
  authGuard,
  surfaceFolderFor,
  UNMAPPED_REPLY,
  NO_DEFAULT_REPLY,
};
}

export type RouteCore = ReturnType<typeof createRouteCore>;
