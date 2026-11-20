/**
 * MCP tool registry — the single source of truth for the tools Pomegranate
 * exposes to AI clients, shared by both transports (server.ts):
 *
 *   - REST:  POST /mcp/tools/<name>   (bearer token; Slack bot, curl)
 *   - MCP:   POST /mcp/server         (streamable HTTP; Claude Code, claude.ai)
 *
 * Each tool is a transport-agnostic handler (args, ctx) → result. Transport
 * concerns (auth, HTTP status codes, JSON-RPC envelopes) live in server.ts;
 * handlers throw ToolError and the transport translates it — REST into a
 * status code, MCP into an isError tool result the model can react to.
 *
 * The zod shapes here are canonical: REST validation, the REST tool listing,
 * and the MCP tools/list schemas are all derived from them.
 */
import { z } from 'zod';
import type { MediaService } from '../data-agents/media-service.js';
import { Repo } from '../db/repo.js';
import type { SynthesisProvider } from '../../lib/synthesis.js';
import { CachedSynth } from '../synth/cached.js';
import { withLlmContext } from '../../lib/llm-context.js';
import { FALLBACK_PROFILE, getBuiltinProfile, listBuiltinProfiles } from '../../lib/profiles/index.js';
import { Node, ProfileNode, type ContextProfile, type Node as NodeT } from '../../lib/schemas.js';
import {
  buildScopedGraph,
  buildContextPack,
  buildScopedGraphMulti,
  edgesForPackedGraph,
  filterNodesToScope,
  selectNodesDirect,
  renderContextPack,
  renderIndex,
  searchNodes,
  searchNodesMulti,
  type SearchHit,
} from '../retrieval/pack.js';
import { retrieveSourceExcerpts } from '../retrieval/source-rag.js';
import { getEmbedder, embeddingTextForNode, embeddingToBlob } from '../../lib/embeddings.js';
import { parseSubgraphTokens } from '../../lib/subgraph-routing.js';
import { routeToSubgraphs } from '../../lib/anthropic.js';
import { validateNode, validateReviewKind } from '../../lib/profile-validate.js';
import { log } from '../../lib/log.js';
import { emailDomain } from '../../lib/email-domain.js';
import { ToolError } from './errors.js';
import { resolveFolderRef, resolveFolderRefUngated } from './folder-resolve.js';
import { withGovernance } from '../governance.js';
import { nodeIdsOf } from '../db/repo/shared.js';

export interface McpDeps {
  repo: Repo;
  baseSynth: SynthesisProvider;
  media?: MediaService;
  /**
   * The shared text-ingest pipeline (capture → registry → dedup → candidates).
   * Owned by api/server.ts; injected here so the `ingest_document` tool runs
   * the exact same pipeline as the web ingest route.
   */
  ingestText?: (opts: {
    ws: string;
    user_id: string;
    source: string;
    source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
    source_ref?: string;
    via: string;
    caller: string;
    source_ip?: string;
    user_agent?: string;
    audience?: 'team' | 'private' | 'only_me';
    fallbackAudience?: 'team' | 'private' | 'only_me';
    forcedSubgraphId?: string;
    }) => Promise<{
    candidates: number;
    document_id: string;
    routed?: Array<{ subgraph_id: string; candidates: number; zero_yield?: boolean }>;
    /** Routed into a folder, but extraction produced nothing (weak-model miss). */
    zero_yield?: boolean;
    /** Caller-facing hint, present only when zero_yield is true. */
    notice?: string | null;
    /**
     * The router wants a new folder, or picked an existing one it had nothing
     * to go on — routing/capture did NOT run. Resolve with approve_route /
     * choose_route / reject_route (`pending_route_id`) before retrying.
     */
    pending_approval?: boolean;
    pending_route_id?: string;
  }>;
  /**
   * The instructions-driven path (same engine "Add Source → Instructions" in
   * the web app uses): hands the document to an agent that decides whether to
   * transform the text and where it goes, instead of the plain router.
   * Invoked by `ingest_document` when its `instructions` arg is set.
   */
  ingestInstructed?: (opts: {
    ws: string;
    user_id: string;
    instructions: string;
    source: string;
    source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
    source_ref?: string;
    source_ip?: string;
    user_agent?: string;
    audience?: 'team' | 'private' | 'only_me';
    // Pins the destination when `subgraph` is ALSO given alongside
    // `instructions` — resolved+validated by the handler below, same as the
    // plain (non-instructed) path. Lets a caller with its own destination
    // picker still get the agent's cleanup instead of forfeiting it.
    forcedSubgraph?: string;
  }) => Promise<{
    message: string;
    candidates: number;
    document_id: string | null;
    subgraph: { id: string; name: string } | null;
    receipts: unknown;
  }>;
  /**
   * Per-source view of what came in — a vault still shows you what went in,
   * even though nothing hangs off it to accept/reject anymore.
   */
  listSources?: (ws: string) => Promise<CurationSourceRow[]>;
  /**
   * Resolve a routing decision held for human review (pending_routes) — the
   * SAME orchestration api/routes.ts's REST endpoints use: approve creates
   * the proposed folder (if any) and files the document as the router
   * proposed; choose overrides with caller-supplied folder ids; reject
   * leaves the document filed nowhere. Both approve and choose run capture.
   */
  resolvePendingRoute?: (
    ws: string,
    pending_route_id: string,
    decision: { action: 'approve' | 'choose' | 'reject'; chosen_target_ids?: string[]; resolved_by: string },
  ) => Promise<
    | {
        ok: true;
        action: 'approved' | 'chosen' | 'rejected';
        targets: string[];
        new_subgraph_id?: string;
        candidates?: number;
        routed?: Array<{ subgraph_id: string; candidates: number; zero_yield?: boolean }>;
      }
    | {
        ok: false;
        error: 'not_found' | 'already_resolved' | 'invalid_targets';
        status: 400 | 404 | 409;
      }
  >;
  /**
   * Ask the owner of a folder the caller CANNOT reach for membership — the
   * same orchestration behind the web's POST /workspaces/:ws/request-access
   * (domain gate, already-a-member check, owner email, audit). Injected so
   * `request_folder_access` and the web button cannot diverge.
   */
  requestFolderAccess?: (opts: {
    workspace_id: string;
    user_id: string;
    message?: string;
    source_ip?: string;
    user_agent?: string;
  }) => Promise<
    | { ok: true; sent: boolean; owner_email: string }
    | { ok: false; error: 'not_found' | 'forbidden' | 'already_member'; status: 403 | 404 | 409 }
  >;
  /** Rules (spec-directory-tracking-and-ingestion-rules.md): owner gate +
   *  instruction classifier + dry-run tester, shared with the web routes. */
  ruleWriteAllowed?: (ws: string, user_id: string) => Promise<boolean>;
  classifyRule?: (instructions: string) => Promise<{
    phases: ('store' | 'use')[];
    target: 'node' | 'source' | 'both';
  }>;
  testRule?: (opts: {
    ws: string;
    rule_id: string;
    user_id: string;
    text?: string;
    question?: string;
    source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
    subgraph_id?: string;
  }) => Promise<
    | { ok: false; status: 400 | 404; error: string }
    | { ok: true; result: Record<string, unknown> }
  >;
}

/** One row of the per-source curation state (list_sources). */
export interface CurationSourceRow {
  document_id: string;
  source_ref: string;
  source_kind: string | null;
  version: number | null;
  summary: string | null;
  case: '1' | '2' | '3' | null;
  status: string;
  counts: { pending: number; approved: number; rejected: number };
  updated_at: string | null;
}

/** Per-call identity + request metadata, resolved by the transport's auth. */
export type ToolCtx = {
  /** The EFFECTIVE workspace this call runs against (folder arg / default). */
  ws: string;
  /** The workspace the credential is bound to (before folder targeting). */
  home_ws?: string;
  origin?: string;
  user_id: string;
  /** OAuth grants may restrict a connection to an explicit folder subset. */
  allowed_workspace_ids?: string[];
  via?: 'in_app_agent';
  /** In-app agent only: the audience an ingest falls back to when neither the
   *  call nor the target folder's default_audience sets one (web app = 'only_me'). */
  fallback_audience?: 'team' | 'private' | 'only_me';
  source_ip?: string;
  user_agent?: string;
};

export { ToolError } from './errors.js';

/**
 * JSON schema for one tool, derived from its canonical zod shape. Shared by
 * the REST tool listing, the MCP tools/list response, and the surface agent's
 * Anthropic tool array — one source of truth.
 */
export function toolJsonSchema(tool: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(tool.inputShape), { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: any, ctx: ToolCtx) => Promise<unknown>;
};

/**
 * Server-level usage guidance, sent to MCP clients in the initialize
 * handshake. Mirrors the orchestration the Slack bot hardcodes so a bare
 * client (no companion skill) still uses the tools idiomatically.
 */
export const SERVER_INSTRUCTIONS = `Pomegranate is a vault: it sits between your conversations, files, tools, and documents and your AI, holding what a team cares to track and share, organized into directories. Each directory contains folders, and each folder holds notes — a running record of whatever information arrives, with no assumption about what it's about. Ingestion applies immediately; the newest statement on a topic wins over older ones (which stay readable, not erased), so answers reflect what's currently true, not a human-arbitrated consensus.
- User-facing names: a workspace is a "directory", a subgraph is a "folder", and the stored knowledge is the "vault". The navigation section is "Folders". Keep tool names and argument keys unchanged: \`folder\` targets a directory and \`subgraph\` targets a folder inside it. Do not call directories "folders", or call the vault "context", "canon", or "library" in replies.
- Use query_context for a specific question. It answers only from the directory's current content, with node-id citations, or says "I don't know" — never guesses.
- Use get_context to pull a directory's current content directly before drafting or rewriting; cite node ids in what you produce. In a large directory (hundreds/thousands of nodes), call it with \`mode: "index"\` first — one compact line per node — before pulling full content for specific ids; or narrow by \`since\`/\`until\`/\`sort\`/\`limit\` instead of a relevance pack. When none of that surfaces the right thing, use search_context — a ranked free-text lookup, with or without naming a folder. Both default to only the current statement on each topic; pass \`include_superseded: true\` to see the history too (a superseded node stays in the graph, marked \`status: "archived"\` and \`superseded\`).
- Use review_deliverable before a draft ships: it returns red/yellow/green findings, each citing the node it conflicts with or supports — red means it contradicts what currently holds, not a vault vote.
- Use ingest_document to add new source material (notes, transcripts, docs). Normally it's routed to the folder(s) it belongs to and applied straight away — no approval step. But one outcome REQUIRES you to stop and ask the user: the router may HOLD the document — it wants to create a new folder, or found nothing to go on for an existing one, or found no existing folder fits at all. The response says so (\`pending_approval\`, \`status: "awaiting_user_decision"\`, a \`notice\`, and a \`pending_route\` describing the proposal and the question to ask). A held document is NOT ingested: do not report it as added, put the question in \`pending_route.ask_user\` to the user, and resolve their answer with approve_route / choose_route / reject_route. Until you do, the document is filed nowhere. There is no silent-drop outcome: a document that fits nothing existing always proposes a new folder rather than being discarded.
- Collaboration and privacy didn't go away — they moved to \`audience\` on ingest_document: 'private' stages content for the user alone (and their own AI) to vet before anyone else sees it, 'team' (the default) shares it with the whole directory immediately, 'only_me' hides it even from the user's own AI. Ask the user which they want when it's not obvious; never assume 'team' for anything that reads as personal or unreviewed.
- Use list_sources to see what's been ingested into a directory and what it produced — a receipt, not a queue to act on.
- Use list_templates to see the folder shapes available, then create_subfolder to make a new one (name it, describe what it's for — your description outranks the router's own guess about the folder's job). Owner/admin only.
- list_recent_changes shows what changed in a directory since a date.
- Use update_node when the user corrects or extends something already in the directory (a decision changed, a status moved, a deadline slipped) — pass only the fields that changed. It never overwrites the original: it creates a new node with the merged content and archives the original, marking it superseded, so the newest statement wins without losing the trail. Don't use it for brand-new information — that's ingest_document.
- Use update_attribute instead of update_node when the change is a single attrs field (a status, an owner, a flag) — same non-destructive supersede mechanics, but a flatter call: \`{ id, attribute, value }\`.
- Every tool accepts an optional \`folder\` to target another directory (workspace) the user can access: a directory id, directory name, teammate email, @slack-handle, or display name ("Alice Martin"). A teammate reference targets THEIR default directory. Access requires membership — a denial names the directory and how to request access.
- Use list_folders to see the directories the user can reach (and the #slugs of their folders), and list_team to see teammates (name, email, slack handle, default directory). Omit \`folder\` to stay in the default directory.
- ONE connection reaches every directory the user is a member of — there is no per-directory connector to set up. To go wider, explore first and then ask for membership: explore_team_folders lists everyone on the domain, their directories, and each directory's folders (including directories NOT yet shared with the user), and request_folder_access emails a directory's owner asking them to add the user. Once they do, the same connection reaches it via \`folder\`.
- set_default_folder changes which directory this connection (and teammates referencing this user) lands on by default — only on the user's explicit ask.`;

/**
 * Slugify a template id/name into a '#'-token slug, unique against an
 * already-taken set. Mirrors api/routes.ts's uniqueSlug (POST
 * /workspaces/:ws/subgraphs) — duplicated locally rather than imported to
 * avoid a circular import (routes.ts imports createTools from this file).
 */
/** Compact search_context result summary — one line per hit, score included. */
/** "2026-10-01T…" → "1 Oct 2026"; anything unparseable passes through. */
function humanDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Human-readable options of an MCP read for the Usage view
 * ("titles only, added since 1 Oct 2026, oldest first"). Arguments only —
 * never user content, so it is stored unsealed in context_usage_log.detail.
 */
export function describeReadOptions(args: {
  mode?: 'full' | 'index';
  ids?: string[];
  since?: string;
  until?: string;
  sort?: 'newest' | 'oldest';
  limit?: number;
  include_superseded?: boolean;
}): string | undefined {
  const parts: string[] = [];
  if (args.mode === 'index') parts.push('titles only');
  if (args.ids?.length) parts.push(args.ids.length === 1 ? '1 specific note' : `${args.ids.length} specific notes`);
  if (args.since && args.until) parts.push(`added ${humanDate(args.since)} – ${humanDate(args.until)}`);
  else if (args.since) parts.push(`added since ${humanDate(args.since)}`);
  else if (args.until) parts.push(`added before ${humanDate(args.until)}`);
  if (args.sort === 'oldest') parts.push('oldest first');
  if (args.limit) parts.push(`up to ${args.limit}`);
  if (args.include_superseded) parts.push('including older versions');
  return parts.length ? parts.join(', ') : undefined;
}

function renderSearchMarkdown(query: string, hits: readonly SearchHit[]): string {
  const header = `# Search: "${query}" (${hits.length} match${hits.length === 1 ? '' : 'es'})`;
  if (hits.length === 0) return `${header}\n\n_No matches._`;
  const lines = hits.map((h) => {
    const tags = [h.kind, h.subkind, h.category].filter(Boolean).join(' · ');
    const sup = h.status === 'archived' ? ` [SUPERSEDED${h.superseded ? ` by \`${h.superseded}\`` : ''}]` : '';
    const sg = h.subgraph_id ? ` (${h.subgraph_id})` : '';
    return `- \`${h.id}\`${sg} score ${h.score.toFixed(3)}${tags ? ` [${tags}]` : ''} — ${h.summary}${sup}`;
  });
  return [header, ...lines].join('\n');
}

function uniqueSubgraphSlug(base: string, taken: Set<string>): string {
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'subgraph';
  let slug = root;
  let n = 2;
  while (taken.has(slug)) slug = `${root}-${n++}`;
  taken.add(slug);
  return slug;
}

export function createTools(deps: McpDeps): ToolDef[] {
  async function assertAiAllowed(ws: string): Promise<void> {
    if ((await deps.repo.getWorkspace(ws))?.ai_allowed === 0) {
      throw new ToolError('not_found', 404, { detail: 'directory not found' });
    }
  }

  function withAiAccess(def: ToolDef): ToolDef {
    return { ...def, async handler(args: any, ctx: ToolCtx) {
      await assertAiAllowed(ctx.ws);
      return def.handler(args, ctx);
    } };
  }

  /** The profile for a (workspace, subgraph), falling back to FALLBACK_PROFILE. */
  async function profileFor(ws: string, subgraph_id = 'default'): Promise<ContextProfile> {
    return await deps.repo.getWorkspaceProfile(ws, subgraph_id) ?? FALLBACK_PROFILE;
  }

  /**
   * Resolve an optional `subgraph` arg (slug or id) against the EFFECTIVE
   * workspace. Curation tools use this so cross-folder calls land in the
   * right partition instead of silently hitting 'default'.
   */
  async function resolveSubgraphArg(ws: string, subgraph?: string): Promise<string> {
    if (!subgraph || subgraph === 'default') return 'default';
    const sg = await deps.repo.getSubgraphBySlug(ws, subgraph) ?? await deps.repo.getSubgraph(ws, subgraph);
    if (sg) return sg.id;
    // People (and chat agents relaying them) name a subfolder by its display
    // name — "Warda" — while its slug is often auto-derived from the template
    // ("notes-3"), so a slug-only match silently misses. Accept an exact,
    // case-insensitive name match among active subfolders when unambiguous.
    const want = subgraph.trim().toLowerCase();
    const byName = (await deps.repo
      .listSubgraphs(ws, { activeOnly: true }))
      .filter((s) => s.name.trim().toLowerCase() === want);
    if (byName.length === 1) return byName[0]!.id;
    throw new ToolError('not_found', 404, {
      detail:
        byName.length > 1
          ? `folder name '${subgraph}' is ambiguous — pass its slug or id`
          : `no folder '${subgraph}'`,
    });
  }

  /** Where an ingested document actually landed, for the caller to report
   *  truthfully instead of echoing back where it was asked to go. */
  async function filedTo(ws: string, document_id?: string | null) {
    if (!document_id) return undefined;
    return await Promise.all((await deps.repo.listDocumentSubgraphs(ws, document_id)).map(async (r) => await folderRef(ws, r.subgraph_id)));
  }

  /** Shared inputShape fragment for curation tools. */
  const subgraphArg = z
    .string()
    .optional()
    .describe("Folder (slug or id) within the directory; omit for 'default'.");

  /** A folder id rendered as something a human can be asked about. */
  async function folderRef(ws: string, id: string): Promise<{ id: string; name: string; slug: string | null }> {
    const sg = await deps.repo.getSubgraph(ws, id);
    return { id, name: sg?.name ?? id, slug: sg?.slug ?? null };
  }

  /**
   * Mint a fresh node id for update_node's successor node. Node ids are
   * short kebab-case slugs (capture.md's convention), so a plain re-suffix
   * off the ORIGINAL base — not the node being updated, which may already
   * carry a `-2`-style suffix from a prior update — keeps a chain of updates
   * readable (`x`, `x-2`, `x-3`, …) instead of nesting (`x-2-2`).
   */
  async function uniqueNodeId(ws: string, baseId: string): Promise<string> {
    const root = baseId.replace(/-\d+$/, '');
    let n = 2;
    let candidate = `${root}-${n}`;
    while (await deps.repo.getNode(ws, candidate)) {
      n += 1;
      candidate = `${root}-${n}`;
    }
    return candidate;
  }

  /**
   * Shared core behind update_node and update_attribute: merge `updates`
   * onto the node named `id`, mint a successor carrying the result, archive
   * the original with `superseded` stamped to the successor's id. Never
   * rewrites the row in place — see update_node's tool comment below for why.
   * `via` labels the audit-log/log-line/error-log event name so the two
   * callers stay distinguishable in `llm.log`-adjacent operational logs.
   */
  async function applyNodeUpdate(
    ctx: ToolCtx,
    id: string,
    updates: Record<string, unknown>,
    via: string,
  ): Promise<{ node_id: string; node: NodeT; superseded_node_id: string }> {
    const old = await deps.repo.getNode(ctx.ws, id);
    if (!old) throw new ToolError('not_found', 404, { detail: `no node '${id}' in this directory` });
    if (old.status !== 'active') {
      throw new ToolError('invalid', 409, {
        detail: `node '${id}' is already archived${
          old.superseded ? ` — superseded by '${old.superseded}'` : ''
        }; update that node instead of this one`,
      });
    }
    if (!await deps.repo.nodeVisibleToViewer(ctx.ws, id, ctx.user_id, true)) {
      throw new ToolError('forbidden', 403, { detail: `node '${id}' is not visible to you` });
    }
    const subgraph_id = await deps.repo.getNodeSubgraph(ctx.ws, id) ?? 'default';

    // Strip fields this helper owns — a caller-supplied value for any of
    // these would fight the merge/archive logic below.
    const { id: _id, type: _type, created_at: _created_at, status: _status, superseded: _superseded, ...patch } =
      (updates ?? {}) as Record<string, unknown>;
    const oldRec = old as unknown as Record<string, unknown>;
    const mergedAttrs =
      patch.attrs && typeof patch.attrs === 'object' && !Array.isArray(patch.attrs)
        ? { ...(oldRec.attrs as Record<string, unknown> | undefined), ...(patch.attrs as Record<string, unknown>) }
        : oldRec.attrs;
    const newId = await uniqueNodeId(ctx.ws, old.id);
    const now = new Date().toISOString();
    const draft = {
      ...oldRec,
      ...patch,
      attrs: mergedAttrs,
      id: newId,
      type: old.type,
      status: 'active',
      created_at: now,
      updated_at: now,
      superseded: undefined,
    };

    // Same dual-parse as POST /workspaces/:ws/graph: the founding union
    // first, the generalized envelope for profile-driven kinds beyond
    // goal/positioning/decision. Kind/subkind/category validity against
    // the workspace profile is checked separately below.
    const founding = Node.safeParse(draft);
    const generalized = founding.success ? null : ProfileNode.safeParse(draft);
    if (!founding.success && !generalized!.success) {
      throw new ToolError('invalid', 400, {
        detail: 'updates produce an invalid node',
        issues: founding.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const updated = (founding.success ? founding.data : generalized!.data) as NodeT;
    const kindErr = validateNode(await profileFor(ctx.ws, subgraph_id), updated as { type: string } & Record<string, unknown>);
    if (kindErr) throw new ToolError('invalid', 422, { detail: kindErr });

    await deps.repo.insertNode(ctx.ws, updated, ctx.user_id, undefined, subgraph_id);
    // Carry the original's audience forward — a private/only_me node's
    // successor must not silently become visible to the whole team.
    const vis = await deps.repo.getNodeVisibility(ctx.ws, old.id);
    if (vis && vis.visibility !== 'team') {
      await deps.repo.setNodeVisibility(ctx.ws, newId, vis.visibility, vis.owner_user_id ?? ctx.user_id, ctx.user_id);
    }
    await deps.repo.archiveNode(ctx.ws, old.id, ctx.user_id, newId);
    await deps.repo.markWikisStale(ctx.ws, subgraph_id);

    // Best-effort embedding, same as every other node-write path —
    // failure just means the next dedup/retrieval pass falls back to
    // lexical match for this row until backfill picks it up.
    (async () => {
      const text = embeddingTextForNode(updated as { type: string; title?: string; summary?: string; body?: string; kind?: string; category?: string });
      const embedder = getEmbedder();
      const [v] = await embedder.embed([text]);
      if (v) await deps.repo.setNodeEmbedding(ctx.ws, newId, embeddingToBlob(v));
    })().catch((err) => {
      log.warn(`${via}_embed_failed`, {
        workspace: ctx.ws,
        node_id: newId,
        msg: (err as Error).message?.slice(0, 200),
      });
    });

    await deps.repo.logCustomerAudit(ctx.ws, {
      event: 'graph_node_mutated',
      actor_user_id: ctx.user_id,
      source_ip: ctx.source_ip,
      user_agent: ctx.user_agent,
      resource_type: 'graph_node',
      resource_id: newId,
      payload: { type: updated.type, status: updated.status, via, supersedes: old.id },
    });
    log.info(via, { workspace: ctx.ws, user: ctx.user_id, id: old.id, new_id: newId, subgraph: subgraph_id });
    return { node_id: updated.id, node: updated, superseded_node_id: old.id };
  }

  /**
   * Describe a HELD routing decision in terms a client can put to the user.
   *
   * Why this exists: `runTextIngest` reports a hold as `candidates: 0`,
   * `routed: []`, `notice: null` plus a `pending_approval` flag. Over MCP that
   * payload is indistinguishable from a quiet no-op — nothing in it says what
   * was proposed, or that a PERSON has to decide — so clients reported the
   * ingest as done (or said nothing at all) and the document sat in
   * pending_routes forever: the "stuck silently instead of asking" bug. Every
   * tool that can surface a hold routes through here so the question, the
   * proposal, and the three tools that resolve it ride in the response itself.
   */
  async function describePendingRoute(
    ws: string,
    pending_route_id: string,
  ): Promise<{
    pending_route_id: string;
    document_id: string;
    source_ref: string | null;
    router_reason: string;
    proposed_new_folder: { name: string; description: string } | null;
    proposed_folders: Array<{ id: string; name: string; slug: string | null }>;
    low_confidence_folders: Array<{ id: string; name: string; slug: string | null }>;
    created_at: string;
    ask_user: string;
    resolve_with: Record<string, string>;
  } | null> {
    const row = await deps.repo.getPendingRoute(ws, pending_route_id);
    if (!row) return null;
    const lowConfidence = await Promise.all(row.low_confidence_targets.map(async (id) => await folderRef(ws, id)));
    const proposed = await Promise.all(row.proposed_targets.map(async (id) => await folderRef(ws, id)));
    const newFolder = row.proposed_new_folder;

    // The question to put to the user, phrased for the case that actually
    // triggered the hold (new-folder proposal vs. a guess at an existing one).
    const ask_user = newFolder
      ? `No existing folder fits this document, so the router proposes a NEW folder "${newFolder.name}" (${newFolder.description}). Ask the user whether to create it and file the document there.`
      : `The router picked ${
          lowConfidence.map((f) => `"${f.name}"`).join(', ') || 'a folder'
        } but had nothing to go on — that folder has no owner description and no content yet, so this is a guess. Ask the user whether that is the right folder.`;

    return {
      pending_route_id,
      document_id: row.document_id,
      source_ref: (await deps.repo.getDocument(ws, row.document_id))?.source_ref ?? null,
      router_reason: row.reason,
      proposed_new_folder: newFolder,
      // Named `*_folders`, not `*_targets`: the raw row already carries those
      // keys as bare id arrays, and list_pending_routes merges both shapes.
      proposed_folders: proposed,
      low_confidence_folders: lowConfidence,
      created_at: row.created_at,
      ask_user,
      resolve_with: {
        approve_route: `approve_route({ id: "${pending_route_id}" }) — file it as proposed${
          newFolder ? `, creating the "${newFolder.name}" directory` : ''
        }.`,
        choose_route: `choose_route({ id: "${pending_route_id}", target_ids: [...] }) — file it into directory(s) the user names instead (list_folders shows the options).`,
        reject_route: `reject_route({ id: "${pending_route_id}" }) — file it nowhere.`,
      },
    };
  }

  /**
   * Resolve which subgraph(s) a query/deliverable runs against, and their
   * profiles (Phase 4). Mirrors the web `resolveQueryTargets`: a `#slug` token
   * (or an explicit `extraPin` slug/id arg, prepended) pins; otherwise the
   * classifier routes (empty/error → ALL active subgraphs). A single-subgraph
   * workspace takes the fast path with NO classifier call (byte-identical).
   * `stripped` (tokens removed) is what synthesis + usage records must use.
   */
  async function resolveTargets(
    ws: string,
    text: string,
    extraPin?: string,
  ): Promise<{
    targets: Array<{ subgraph_id: string; profile: ContextProfile }>;
    stripped: string;
    pinned: boolean;
  }> {
    const { stripped, slugs } = parseSubgraphTokens(text);
    const subs = await deps.repo.listSubgraphs(ws, { activeOnly: true });
    if (subs.length <= 1) {
      return { targets: [{ subgraph_id: 'default', profile: await profileFor(ws, 'default') }], stripped, pinned: false };
    }
    const pinSelectors: string[] = [];
    if (extraPin) pinSelectors.push(extraPin);
    for (const s of slugs) pinSelectors.push(s);
    if (pinSelectors.length > 0) {
      const seen = new Set<string>();
      const targets: Array<{ subgraph_id: string; profile: ContextProfile }> = [];
      for (const sel of pinSelectors) {
        const sg = await deps.repo.getSubgraphBySlug(ws, sel) ?? await deps.repo.getSubgraph(ws, sel);
        if (!sg) {
          log.warn('mcp.unknown_subgraph_token', { workspace: ws, selector: sel });
          continue;
        }
        if (!seen.has(sg.id)) {
          seen.add(sg.id);
          targets.push({ subgraph_id: sg.id, profile: await profileFor(ws, sg.id) });
        }
      }
      if (targets.length > 0) return { targets, stripped, pinned: true };
    }
    let routed: string[] = [];
    try {
      routed = await routeToSubgraphs(
        stripped,
        await Promise.all(subs.map(async (s) => {
          const p = await profileFor(ws, s.id);
          return { id: s.id, name: s.name, description: p.description, routingHint: p.routing_hint };
        })),
      );
    } catch (err) {
      log.warn('mcp.subgraph_route_failed', { workspace: ws, msg: (err as Error).message?.slice(0, 200) });
      routed = [];
    }
    const ids = routed.length > 0 ? routed : subs.map((s) => s.id);
    return { targets: await Promise.all(ids.map(async (id) => ({ subgraph_id: id, profile: await profileFor(ws, id) }))), stripped, pinned: false };
  }

  /**
   * Cross-folder targeting: every canon/curation tool accepts an optional
   * `folder` reference (id | name | teammate email | @slack-handle | display
   * name). The wrapper resolves it, enforces the MEMBERSHIP gate, and swaps
   * ctx.ws — handlers key everything (retrieval, visibility, subgraph
   * routing, audit, usage records) on ctx.ws with viewer ctx.user_id, so a
   * resolved call behaves exactly like a native call in the target folder.
   */
  function withFolder(def: ToolDef): ToolDef {
    return {
      ...def,
      inputShape: {
        ...def.inputShape,
        folder: z
          .string()
          .optional()
          .describe(
            "Target another directory you can access: directory id, directory name, teammate email, @slack-handle, or display name (resolves to that person's default directory). Omit for your default directory.",
          ),
      },
      async handler(args: any, ctx: ToolCtx) {
        const { folder, ...rest } = (args ?? {}) as { folder?: string };
        if (!folder) return def.handler(rest, ctx);
        const resolved = await resolveFolderRef(deps.repo, ctx.user_id, folder, 'mcp', true);
        if (ctx.allowed_workspace_ids && !ctx.allowed_workspace_ids.includes(resolved.workspace_id)) {
          throw new ToolError('forbidden', 403, { detail: 'this OAuth connection was not granted access to that folder' });
        }
        return def.handler(rest, { ...ctx, home_ws: ctx.home_ws ?? ctx.ws, ws: resolved.workspace_id });
      },
    };
  }

  const base: ToolDef[] = [
    {
      name: 'query_context',
      title: 'Ask the vault',
      description:
        "Ask what's currently true in a directory: voice, direction, decisions, status, recent shifts. Answers are grounded in the newest statement on each topic — older statements stay in the graph but don't win — with node-id citations, or 'I don't know' if nothing supports an answer.",
      inputShape: {
        question: z.string().min(1).describe('The question to ask the vault.'),
        scope: z
          .string()
          .default('all')
          .describe('Narrow the vault slice consulted (a scope key from the workspace profile).'),
        subgraph: z
          .string()
          .optional()
          .describe('Pin the question to a specific folder (slug or id). A `#slug` token in the question also pins.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args: { question: string; scope: string; subgraph?: string }, ctx) {
        const t0 = Date.now();
        // Phase 4: auto-route the question to the relevant subgraph(s); a
        // `#slug` token (or the `subgraph` arg) pins. A single-subgraph
        // workspace takes the fast path and is byte-equivalent below threshold.
        const { targets, stripped } = await resolveTargets(ctx.ws, args.question, args.subgraph);

        if (targets.length === 1) {
          const profile = targets[0]!.profile;
          // Scoped + embedding-ranked retrieval (spec B6.1/B6.2), shared with
          // the web /query path.
          const pack = await buildScopedGraph({
            repo: deps.repo,
            workspace_id: ctx.ws,
            profile,
            scope: args.scope,
            question: stripped,
            embedder: getEmbedder(),
            subgraph_id: targets[0]!.subgraph_id,
            viewer: ctx.user_id,
          });
          const graph = pack.nodes;
          // Always-hybrid: the source-RAG path (spec-source-rag-hybrid-answering.md).
          // Returns [] when the flag is off — node-only, byte-identical to before.
          const excerpts = await retrieveSourceExcerpts({
            repo: deps.repo,
            workspace_id: ctx.ws,
            question: stripped,
            embedder: getEmbedder(),
            viewer: ctx.user_id,
          });
          const edges = await edgesForPackedGraph(deps.repo, ctx.ws, [targets[0]!.subgraph_id], graph);
          log.info('query.retrieval', {
            workspace: ctx.ws,
            caller: 'mcp.query_context',
            scope: args.scope,
            ...pack.stats,
            edge_count: edges.length,
            source_excerpts: excerpts.length,
          });
          const cached = new CachedSynth(deps.baseSynth, deps.repo, ctx.ws, undefined, profile);
          const result = await withLlmContext(
            {
              caller: 'mcp.query_context',
              context: { scope: args.scope, question_chars: stripped.length },
            },
            () => cached.query({ graph, edges, scope: args.scope, question: stripped, profile, sourceExcerpts: excerpts }),
          );
          const realIds = new Set(graph.map((n) => n.id));
          // Integrity: drop any cited id that isn't in the graph (anti-hallucination)
          result.cited_node_ids = result.cited_node_ids.filter((id) => realIds.has(id));
          if (result.cited_chunk_ids) {
            const realChunkIds = new Set(excerpts.map((e) => e.chunk_id));
            result.cited_chunk_ids = result.cited_chunk_ids.filter((id) => realChunkIds.has(id));
          }
          await deps.repo.logAudit(ctx.ws, {
            actor: ctx.user_id,
            event: 'mcp.query_context',
            resource_type: 'mcp_call',
            payload: {
              question_len: stripped.length,
              scope: args.scope,
              latency_ms: Date.now() - t0,
              cited: result.cited_node_ids.length,
              has_answer: result.has_answer,
            },
          });
          // Cross-user usage record: identity + shape in the attributed log, the
          // verbatim question in the anonymized store (see Repo.recordContextAccess).
          await deps.repo.recordContextAccess(ctx.ws, {
            actor_user_id: ctx.user_id,
            channel: 'mcp',
            tool: 'query',
            scope: args.scope,
            has_answer: result.has_answer,
            cited: result.cited_node_ids.length,
            node_count: graph.length,
            latency_ms: Date.now() - t0,
            request_text: stripped,
            cited_node_ids: result.cited_node_ids,
            subgraph_id: targets[0]!.subgraph_id,
            source_ip: ctx.source_ip,
            user_agent: ctx.user_agent,
          });
          return result;
        }

        // Multi-target: query each subgraph against its OWN profile (scope
        // absent → 'all' there), merge, then ONE synthesis pass.
        const multi = await buildScopedGraphMulti({
          repo: deps.repo,
          workspace_id: ctx.ws,
          subgraphs: targets,
          scope: args.scope,
          question: stripped,
          embedder: getEmbedder(),
          viewer: ctx.user_id,
        });
        const graph = multi.nodes;
        // Source retrieval is workspace-scoped (docs are shared across subgraphs),
        // so it runs once regardless of target count.
        const excerpts = await retrieveSourceExcerpts({
          repo: deps.repo,
          workspace_id: ctx.ws,
          question: stripped,
          embedder: getEmbedder(),
          viewer: ctx.user_id,
        });
        const edges = await edgesForPackedGraph(deps.repo, ctx.ws, multi.perSubgraph.map((p) => p.subgraph_id), graph);
        log.info('query.retrieval', {
          workspace: ctx.ws,
          caller: 'mcp.query_context',
          scope: args.scope,
          multi: true,
          subgraphs: multi.perSubgraph.map((p) => p.subgraph_id),
          node_count: graph.length,
          edge_count: edges.length,
          source_excerpts: excerpts.length,
        });
        const cached = new CachedSynth(deps.baseSynth, deps.repo, ctx.ws, undefined, targets[0]!.profile);
        const result = await withLlmContext(
          {
            caller: 'mcp.query_context',
            context: { scope: args.scope, question_chars: stripped.length },
          },
          () => cached.query({ graph, edges, scope: args.scope, question: stripped, profile: targets[0]!.profile, sourceExcerpts: excerpts }),
        );
        const realIds = new Set(graph.map((n) => n.id));
        result.cited_node_ids = result.cited_node_ids.filter((id) => realIds.has(id));
        if (result.cited_chunk_ids) {
          const realChunkIds = new Set(excerpts.map((e) => e.chunk_id));
          result.cited_chunk_ids = result.cited_chunk_ids.filter((id) => realChunkIds.has(id));
        }
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.query_context',
          resource_type: 'mcp_call',
          payload: {
            question_len: stripped.length,
            scope: args.scope,
            latency_ms: Date.now() - t0,
            cited: result.cited_node_ids.length,
            has_answer: result.has_answer,
            subgraphs: multi.perSubgraph.map((p) => p.subgraph_id),
          },
        });
        for (const ps of multi.perSubgraph) {
          const sgIds = new Set(graph.filter((n) => (n as any).subgraph_id === ps.subgraph_id).map((n) => n.id));
          const sgCites = result.cited_node_ids.filter((id) => sgIds.has(id));
          await deps.repo.recordContextAccess(ctx.ws, {
            actor_user_id: ctx.user_id,
            channel: 'mcp',
            tool: 'query',
            scope: args.scope,
            has_answer: result.has_answer,
            cited: sgCites.length,
            node_count: sgIds.size,
            latency_ms: Date.now() - t0,
            request_text: stripped,
            cited_node_ids: sgCites,
            subgraph_id: ps.subgraph_id,
            source_ip: ctx.source_ip,
            user_agent: ctx.user_agent,
          });
        }
        return { ...result, subgraphs: targets.map((t) => t.subgraph_id) };
      },
    },

    {
      name: 'review_deliverable',
      title: 'Review a draft against the vault',
      description:
        "Submit a deliverable for review against what currently holds in the relevant directory(s). Returns structured findings with red/yellow/green flags and node-id citations — red means it contradicts the newest statement on something, not a vault vote.",
      inputShape: {
        content: z.string().min(1).describe('The full draft text to review.'),
        kind: z
          .string()
          .optional()
          .describe('What kind of deliverable this is (a review kind from the workspace profile).'),
        subgraph: z
          .string()
          .optional()
          .describe('Pin the review to a specific folder (slug or id). A `#slug` token in the content also pins.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args: { content: string; kind?: string; subgraph?: string }, ctx) {
        const t0 = Date.now();
        // Phase 4: route the deliverable to the relevant subgraph(s); `#slug`
        // (or the `subgraph` arg) pins. Single-subgraph → fast path.
        const { targets: allTargets, stripped } = await resolveTargets(ctx.ws, args.content, args.subgraph);

        // Per-target kind validation: keep only subgraphs whose profile accepts
        // the kind. Single-subgraph keeps the (now profile-driven) 400.
        let targets = allTargets;
        if (args.kind !== undefined) {
          if (allTargets.length === 1) {
            const kindErr = validateReviewKind(allTargets[0]!.profile, args.kind);
            if (kindErr) throw new ToolError('invalid', 400, { detail: kindErr });
          } else {
            targets = allTargets.filter((t) => validateReviewKind(t.profile, args.kind!) === null);
            if (targets.length === 0) {
              const allowed = [...new Set(allTargets.flatMap((t) => t.profile.review_kinds))].join(', ');
              throw new ToolError('invalid', 400, {
                detail: `review kind '${args.kind}' is not accepted by any targeted folder (allowed across folders: ${allowed})`,
              });
            }
          }
        }

        const multiMode = targets.length > 1;
        const merged: any[] = [];
        const perSub: Array<{ subgraph_id: string; cited: number; node_count: number }> = [];
        for (const t of targets) {
          // review_deliverable feeds the graph to an LLM → aiRead (exclude 'only_me').
          const graph = await deps.repo.listNodes(ctx.ws, { activeOnly: true, viewer: ctx.user_id, aiRead: true }, t.subgraph_id);
          const edges = await deps.repo.listEdges(ctx.ws, {}, t.subgraph_id);
          const cached = new CachedSynth(deps.baseSynth, deps.repo, ctx.ws, undefined, t.profile);
          const findings = await withLlmContext(
            {
              caller: 'mcp.review_deliverable',
              context: {
                deliverable_kind: args.kind ?? 'other',
                deliverable_chars: stripped.length,
              },
            },
            () =>
              cached.feedback({
                graph,
                edges,
                kind: args.kind as any,
                deliverable: stripped,
                profile: t.profile,
              }),
          );
          const realIds = new Set(graph.map((n) => n.id));
          const safe = findings.filter((f) => {
            if (f.flag === 'red' && (!f.node_id || !realIds.has(f.node_id))) return false;
            if (f.node_id && !realIds.has(f.node_id)) return false;
            return true;
          });
          for (const f of safe) merged.push(multiMode ? { ...f, subgraph_id: t.subgraph_id } : f);
          perSub.push({ subgraph_id: t.subgraph_id, cited: safe.length, node_count: graph.length });
        }

        const { id } = await deps.repo.insertReview({
          workspace_id: ctx.ws,
          caller: 'mcp',
          kind: args.kind,
          deliverable: args.content,
          findings: merged,
          submitted_by: ctx.user_id,
        });
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.review_deliverable',
          resource_type: 'review',
          resource_id: id,
          payload: {
            kind: args.kind,
            findings_count: merged.length,
            latency_ms: Date.now() - t0,
            subgraph_ids: targets.map((t) => t.subgraph_id),
          },
        });
        await deps.repo.logCustomerAudit(ctx.ws, {
          event: 'deliverable_submitted',
          actor_user_id: ctx.user_id,
          resource_type: 'review',
          resource_id: id,
          payload: {
            caller: 'mcp',
            kind: args.kind,
            findings_count: merged.length,
            reds: merged.filter((f) => f.flag === 'red').length,
            subgraph_ids: targets.map((t) => t.subgraph_id),
          },
        });
        // Cross-user usage record (shape only; deliverable body stays in
        // reviews) — one row per contributing subgraph.
        for (const ps of perSub) {
          await deps.repo.recordContextAccess(ctx.ws, {
            actor_user_id: ctx.user_id,
            channel: 'mcp',
            tool: 'review',
            deliverable_kind: args.kind ?? 'other',
            cited: ps.cited,
            node_count: ps.node_count,
            latency_ms: Date.now() - t0,
            subgraph_id: ps.subgraph_id,
            source_ip: ctx.source_ip,
            user_agent: ctx.user_agent,
          });
        }
        return multiMode ? { id, findings: merged, subgraphs: targets.map((t) => t.subgraph_id) } : { id, findings: merged };
      },
    },

    {
      name: 'list_recent_changes',
      title: "What's new in the vault",
      description: 'Structured retrieval of graph nodes added or modified since a given date.',
      inputShape: {
        since: z
          .string()
          .optional()
          .describe('ISO date; defaults to 30 days ago.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args: { since?: string }, ctx) {
        const cutoff = args.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        // Sharing enforcement in the repo: only nodes this caller's AGENT may
        // see (team, or the caller's own 'private' — an aiRead, so their own
        // 'only_me' is excluded), and the use-phase REDACTED copy of any node
        // the caller doesn't own.
        const rows = await deps.repo.listNodesUpdatedSinceForTool(ctx.ws, cutoff, ctx.user_id);
        const nodes = rows.map((r) => JSON.parse(r.data));
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.list_recent_changes',
          payload: { since: cutoff, returned: nodes.length },
        });
        await deps.repo.recordContextAccess(ctx.ws, {
          actor_user_id: ctx.user_id,
          channel: 'mcp',
          tool: 'recent_changes',
          detail: `since ${humanDate(cutoff)}`,
          node_count: nodes.length,
          accessed_node_ids: nodeIdsOf(nodes),
          source_ip: ctx.source_ip,
          user_agent: ctx.user_agent,
        });
        return { since: cutoff, nodes };
      },
    },

    {
      // update_node — a direct, non-LLM edit path: never rewrites the
      // original row. Mints a successor node (new id, fresh created_at)
      // carrying the merged content, archives the original and stamps its
      // `superseded` column with the successor's id (edges pointing at it
      // are archived too, same fallout as any archive) — "the newest
      // statement on a topic wins, older stays readable" (SERVER_INSTRUCTIONS
      // above) applied to a direct edit instead of a re-ingest. Mirrors the
      // ingest-time amends flow (routes.ts's `plan.amends` handling) but is
      // synchronous and caller-driven rather than something the capture LLM
      // proposes from a document.
      name: 'update_node',
      title: 'Update a node',
      description:
        "Update a node's content. This does NOT edit the node in place — it creates a NEW node carrying the merged content and archives the original, which is stamped with the new node's id (`superseded`) so it stays readable but no longer wins in answers or vault reads. Pass only the fields that changed in `updates`; everything else carries over from the original unchanged (`attrs` merges key-by-key rather than replacing the whole object). `id`, `type`, `created_at`, `status`, and `superseded` cannot be set here — a node's kind never changes on an update, and lifecycle is managed by this tool. Fails if the node is already archived/superseded — call it again on whatever superseded it (the error names that node's id).",
      inputShape: {
        id: z
          .string()
          .min(1)
          .describe('The node id to update (from get_context, query_context citations, or list_recent_changes).'),
        updates: z
          .record(z.string(), z.unknown())
          .describe(
            "Fields to change, e.g. { body: '...' } or { attrs: { deadline: '2026-10-01' } } — whatever fields this node's kind carries (get_context/query_context show the shape). Merged onto the existing node: keys you omit carry over unchanged; `attrs` merges key-by-key instead of replacing the whole object.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { id: string; updates: Record<string, unknown> }, ctx) {
        return applyNodeUpdate(ctx, args.id, args.updates, 'mcp.update_node');
      },
    },

    {
      // update_attribute — a flat-args convenience wrapper over the same
      // merge/archive/supersede core as update_node (applyNodeUpdate),
      // scoped to a single attrs key. Two reasons this exists alongside
      // update_node rather than just documenting the `{updates: {attrs:
      // {...}}}` shape: (1) most real edits ARE one field ("mark this
      // message sent", "flip this decision's owner") and that nested shape
      // is unnecessary ceremony for the common case; (2) its args are flat
      // scalars, so — unlike update_node — it's reachable from the Slack
      // surface agent's structured one-action-per-turn protocol, whose
      // STEP_ARG_FIELDS (surface-agent.ts) can only express scalar/array
      // fields, not an arbitrary nested object. See update_node's
      // "Remaining work" note in the internal design notes.
      name: 'update_attribute',
      title: 'Set one attribute on a node',
      description:
        "Add or overwrite a single attrs key on a node — e.g. set a message node's `status` attribute to 'sent'. Same non-destructive mechanics as update_node: creates a NEW node carrying every other field unchanged plus this one attribute set, archives the original and stamps it `superseded` with the new node's id. To change `body`, `title`, or more than one field at once, use update_node instead. Fails if the node is already archived/superseded — call it again on whatever superseded it (the error names that node's id).",
      inputShape: {
        id: z
          .string()
          .min(1)
          .describe('The node id to update (from get_context, query_context citations, or list_recent_changes).'),
        attribute: z.string().min(1).describe("The attrs key to set, e.g. 'status'."),
        value: z.union([z.string(), z.number(), z.boolean()]).describe("The value to set it to, e.g. 'sent'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { id: string; attribute: string; value: string | number | boolean }, ctx) {
        return applyNodeUpdate(ctx, args.id, { attrs: { [args.attribute]: args.value } }, 'mcp.update_attribute');
      },
    },

    {
      // get_context (spec B6.3). Returns the scoped, ranked, citation-ready
      // canon slice. Never calls the synthesis LLM — it's a direct canon dump
      // for the IC's tools to cite by node id.
      name: 'get_context',
      title: 'Pull the vault directly',
      description:
        "Pull a directory's current content directly: a scoped, ranked, citation-ready slice of its graph as markdown plus structured nodes — the newest statement on each topic, not a curated subset. Use this to ground a draft without asking a question. Cite nodes by their id. Attached originals appear in each node's `assets` and as download links in markdown; download using the same MCP bearer token.\n\n" +
        "A directory with hundreds or thousands of nodes needs more than one way in — three retrieval modes, on top of the default relevance pack:\n" +
        "1. `mode: 'index'` — one compact line per node (id, kind, date, a short auto-summary) instead of full content. Cheap enough to browse an entire large directory; re-call with `ids` to pull full content for the ones that matter.\n" +
        "2. `ids` / `since` / `until` / `sort` / `limit` — retrieve by specific node id, by creation-date range, in newest/oldest order, and cap how many come back. Any of these switches get_context from relevance-ranked packing to deterministic date/id-based retrieval (default sort then is 'newest'). Page a large directory by repeating the call with `until` set to the oldest `created_at` from the previous page.\n" +
        "3. When neither of the above surfaces the right thing, use search_context instead — a ranked lookup by free text, with or without naming a folder.\n\n" +
        "`include_superseded` (default false) controls whether archived/superseded nodes are excluded (the default — only the current statement on each topic) or included alongside the current ones (each carrying `status` and, once set, `superseded`: the id of the node that replaced it).",
      inputShape: {
        scope: z
          .string()
          .default('all')
          .describe("A scope key from the workspace profile (e.g. 'decisions', 'all')."),
        budget_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Approximate token budget for the packed slice. Ignored in index mode.'),
        subgraph: z
          .string()
          .optional()
          .describe('Pull from a specific folder (slug or id); omit to pull from all active folders.'),
        mode: z
          .enum(['full', 'index'])
          .default('full')
          .describe(
            "'full' (default) returns each node's complete content. 'index' returns one compact line per node — id, kind, date, and a short auto-summary, no full body — so you can see everything in a large directory cheaply, then re-call with `ids` to pull full content for just the ones you need.",
          ),
        ids: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Retrieve only these specific node ids (from a prior index/search/citation) instead of a relevance pack. Switches to deterministic retrieval — see the tool description.',
          ),
        since: z.string().optional().describe('Only nodes created on or after this ISO date. Switches to deterministic retrieval.'),
        until: z
          .string()
          .optional()
          .describe(
            'Only nodes created on or before this ISO date. Switches to deterministic retrieval; pass the oldest `created_at` from a previous page here to page further back.',
          ),
        sort: z
          .enum(['newest', 'oldest'])
          .optional()
          .describe(
            "Order by creation date instead of relevance, and switch to deterministic retrieval. Default 'newest' whenever `ids`/`since`/`until`/`mode: 'index'`/`limit` is set; ignored on a plain relevance pull.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Max nodes to return. Default: unlimited on a plain relevance pull (bounded by `budget_tokens`); 500 in index mode; 200 for id/date-based retrieval. The response says `total_matched` when more exist than `limit` returned.',
          ),
        include_superseded: z
          .boolean()
          .default(false)
          .describe(
            "false (default): only the current, active statement on each topic — a superseded node stays in the graph but is excluded here. true: also return archived/superseded nodes so you can see the history, each carrying its `status` and, once set, `superseded` (the id of the node that replaced it).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(
        args: {
          scope: string;
          budget_tokens?: number;
          subgraph?: string;
          mode: 'full' | 'index';
          ids?: string[];
          since?: string;
          until?: string;
          sort?: 'newest' | 'oldest';
          limit?: number;
          include_superseded: boolean;
        },
        ctx,
      ) {
        const withMedia = async <T extends { nodes: unknown[]; markdown: string }>(result: T) => {
          if (!deps.media) return result;
          const links: string[] = [];
          const nodes = await Promise.all(result.nodes.map(async (value) => {
            const node = value as { id: string };
            const assets = (await deps.media!.nodeAssets(ctx.ws, node.id, ctx.user_id)).map((a) => ({
              id: a.id, name: a.original_name, mime: a.mime, bytes: a.bytes, visibility: a.visibility,
              href: `${ctx.origin ?? ''}/mcp/workspaces/${encodeURIComponent(ctx.ws)}/assets/${encodeURIComponent(a.id)}/content`,
            }));
            if (!assets.length) return value;
            for (const a of assets) {
              const name = a.name.replace(/[\\[\]\r\n]/g, ' ');
              links.push(`- Node ${node.id}: [Download ${name}](${a.href})`);
            }
            return { ...node, assets };
          }));
          return { ...result, nodes, markdown: links.length
            ? `${result.markdown}\n\n### Media attachments\nUse the same MCP bearer token to download these originals.\n${links.join('\n')}`
            : result.markdown };
        };
        const t0 = Date.now();
        // Phase 4: this is a direct canon dump with no NL question, so we never
        // run the classifier. A `subgraph` arg pins one subgraph; absent a pin
        // we dump EVERY active subgraph. Single-subgraph → legacy path.
        const subs = await deps.repo.listSubgraphs(ctx.ws, { activeOnly: true });
        let targets: Array<{ subgraph_id: string; profile: ContextProfile }>;
        if (subs.length <= 1) {
          targets = [{ subgraph_id: 'default', profile: await profileFor(ctx.ws, 'default') }];
        } else if (args.subgraph && args.subgraph !== 'default') {
          const sg = await deps.repo.getSubgraphBySlug(ctx.ws, args.subgraph) ?? await deps.repo.getSubgraph(ctx.ws, args.subgraph);
          if (!sg) throw new ToolError('not_found', 404, { detail: `no folder '${args.subgraph}'` });
          targets = [{ subgraph_id: sg.id, profile: await profileFor(ctx.ws, sg.id) }];
        } else if (args.subgraph === 'default') {
          targets = [{ subgraph_id: 'default', profile: await profileFor(ctx.ws, 'default') }];
        } else {
          targets = await Promise.all(subs.map(async (s) => ({ subgraph_id: s.id, profile: await profileFor(ctx.ws, s.id) })));
        }

        // Any of these switches from the relevance pack to deterministic
        // id/date-based retrieval (see description). Bare calls (the common
        // case, and every pre-existing caller) take the untouched pack path
        // below — byte-identical to before these options existed.
        const useDirect =
          args.mode === 'index' || (args.ids && args.ids.length > 0) || !!args.since || !!args.until || !!args.sort;

        if (useDirect) {
          if (targets.length === 1 && !targets[0]!.profile.query_scopes.some((s) => s.key === args.scope)) {
            const allowed = targets[0]!.profile.query_scopes.map((s) => s.key).join(', ');
            throw new ToolError('invalid', 400, {
              detail: `scope '${args.scope}' is not in profile '${targets[0]!.profile.id}' (allowed: ${allowed})`,
            });
          }
          const defaultLimit = args.mode === 'index' ? 500 : 200;
          const limit = args.limit ?? defaultLimit;
          const perTarget = await Promise.all(targets.map(async (t) => {
            const raw = await deps.repo.listNodes(
              ctx.ws,
              { activeOnly: !args.include_superseded, viewer: ctx.user_id, aiRead: true },
              t.subgraph_id,
            );
            const scoped = filterNodesToScope(raw, t.profile, args.scope);
            const selected = selectNodesDirect({
              nodes: scoped,
              ids: args.ids,
              since: args.since,
              until: args.until,
              sort: args.sort ?? 'newest',
            });
            const total_matched = selected.length;
            const sliced = selected.slice(0, limit);
            const limitTruncated = total_matched > sliced.length;
            if (args.mode === 'index') {
              const idx = renderIndex({ profile: t.profile, scope: args.scope, nodes: sliced });
              return {
                subgraph_id: t.subgraph_id,
                profile_id: t.profile.id,
                node_count: idx.index.length,
                total_matched,
                truncated: limitTruncated,
                nodes: idx.index as unknown[],
                markdown: idx.markdown,
              };
            }
            const rendered = renderContextPack({
              profile: t.profile,
              scope: args.scope,
              nodes: sliced,
              packed: false,
              budget_tokens: args.budget_tokens,
            });
            return {
              subgraph_id: t.subgraph_id,
              profile_id: t.profile.id,
              node_count: rendered.node_count,
              total_matched,
              truncated: limitTruncated || rendered.truncated,
              nodes: rendered.nodes as unknown[],
              markdown: rendered.markdown,
            };
          }));

          const multi = targets.length > 1;
          const result = {
            scope: args.scope,
            mode: args.mode,
            profile_id: perTarget.map((p) => p.profile_id).join('+'),
            node_count: perTarget.reduce((a, p) => a + p.node_count, 0),
            total_matched: perTarget.reduce((a, p) => a + p.total_matched, 0),
            include_superseded: args.include_superseded,
            packed: false,
            budget_tokens: args.mode === 'index' ? undefined : args.budget_tokens,
            truncated: perTarget.some((p) => p.truncated),
            nodes: multi
              ? perTarget.flatMap((p) => p.nodes.map((n) => ({ ...(n as object), subgraph_id: p.subgraph_id })))
              : perTarget[0]!.nodes,
            markdown: multi
              ? perTarget.map((p) => p.markdown).join('\n\n---\n\n')
              : perTarget[0]!.markdown,
            ...(multi ? { subgraphs: targets.map((t) => t.subgraph_id) } : {}),
          };
          await deps.repo.logAudit(ctx.ws, {
            actor: ctx.user_id,
            event: 'mcp.get_context',
            resource_type: 'mcp_call',
            payload: {
              scope: args.scope,
              mode: args.mode,
              node_count: result.node_count,
              total_matched: result.total_matched,
              include_superseded: args.include_superseded,
              truncated: result.truncated,
              latency_ms: Date.now() - t0,
              subgraphs: targets.map((t) => t.subgraph_id),
            },
          });
          for (const p of perTarget) {
            await deps.repo.recordContextAccess(ctx.ws, {
              actor_user_id: ctx.user_id,
              channel: 'mcp',
              tool: 'context_pack',
              scope: args.scope,
              detail: describeReadOptions(args),
              node_count: p.node_count,
              accessed_node_ids: nodeIdsOf(p.nodes as unknown[]),
              latency_ms: Date.now() - t0,
              subgraph_id: p.subgraph_id,
              source_ip: ctx.source_ip,
              user_agent: ctx.user_agent,
            });
          }
          return await withMedia(result);
        }

        if (targets.length === 1) {
          const profile = targets[0]!.profile;
          if (!profile.query_scopes.some((s) => s.key === args.scope)) {
            const allowed = profile.query_scopes.map((s) => s.key).join(', ');
            throw new ToolError('invalid', 400, {
              detail: `scope '${args.scope}' is not in profile '${profile.id}' (allowed: ${allowed})`,
            });
          }
          const scopeDef = profile.query_scopes.find((s) => s.key === args.scope)!;
          const pack = await buildContextPack({
            repo: deps.repo,
            workspace_id: ctx.ws,
            profile,
            scope: args.scope,
            question: scopeDef.label,
            embedder: getEmbedder(),
            budget_tokens: args.budget_tokens,
            subgraph_id: targets[0]!.subgraph_id,
            viewer: ctx.user_id,
            activeOnly: !args.include_superseded,
          });
          await deps.repo.logAudit(ctx.ws, {
            actor: ctx.user_id,
            event: 'mcp.get_context',
            resource_type: 'mcp_call',
            payload: {
              scope: args.scope,
              node_count: pack.node_count,
              packed: pack.packed,
              truncated: pack.truncated,
              budget_tokens: args.budget_tokens ?? null,
              include_superseded: args.include_superseded,
              latency_ms: Date.now() - t0,
            },
          });
          await deps.repo.recordContextAccess(ctx.ws, {
            actor_user_id: ctx.user_id,
            channel: 'mcp',
            tool: 'context_pack',
            scope: args.scope,
            detail: describeReadOptions(args),
            node_count: pack.node_count,
            accessed_node_ids: nodeIdsOf(pack.nodes as unknown[]),
            latency_ms: Date.now() - t0,
            subgraph_id: targets[0]!.subgraph_id,
            source_ip: ctx.source_ip,
            user_agent: ctx.user_agent,
          });
          return await withMedia({ mode: 'full' as const, include_superseded: args.include_superseded, ...pack });
        }

        // Multi: build a pack per subgraph (scope absent → 'all' there),
        // concatenate the markdown, concat nodes (tagged with provenance).
        const packs: Array<{ subgraph_id: string; pack: Awaited<ReturnType<typeof buildContextPack>> }> = [];
        for (const t of targets) {
          const scopeDef = t.profile.query_scopes.find((s) => s.key === args.scope);
          const pack = await buildContextPack({
            repo: deps.repo,
            workspace_id: ctx.ws,
            profile: t.profile,
            scope: args.scope,
            question: scopeDef?.label ?? args.scope,
            embedder: getEmbedder(),
            budget_tokens: args.budget_tokens,
            subgraph_id: t.subgraph_id,
            viewer: ctx.user_id,
            activeOnly: !args.include_superseded,
          });
          packs.push({ subgraph_id: t.subgraph_id, pack });
        }
        const merged = {
          scope: args.scope,
          mode: 'full' as const,
          include_superseded: args.include_superseded,
          profile_id: targets.map((t) => t.profile.id).join('+'),
          node_count: packs.reduce((a, p) => a + p.pack.node_count, 0),
          packed: packs.some((p) => p.pack.packed),
          budget_tokens: args.budget_tokens,
          truncated: packs.some((p) => p.pack.truncated),
          nodes: packs.flatMap((p) => p.pack.nodes.map((n) => ({ ...n, subgraph_id: p.subgraph_id }))),
          markdown: packs.map((p) => p.pack.markdown).join('\n\n---\n\n'),
          subgraphs: targets.map((t) => t.subgraph_id),
        };
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.get_context',
          resource_type: 'mcp_call',
          payload: {
            scope: args.scope,
            node_count: merged.node_count,
            packed: merged.packed,
            truncated: merged.truncated,
            budget_tokens: args.budget_tokens ?? null,
            latency_ms: Date.now() - t0,
            subgraphs: merged.subgraphs,
          },
        });
        for (const p of packs) {
          await deps.repo.recordContextAccess(ctx.ws, {
            actor_user_id: ctx.user_id,
            channel: 'mcp',
            tool: 'context_pack',
            scope: args.scope,
            detail: describeReadOptions(args),
            node_count: p.pack.node_count,
            accessed_node_ids: nodeIdsOf(p.pack.nodes as unknown[]),
            latency_ms: Date.now() - t0,
            subgraph_id: p.subgraph_id,
            source_ip: ctx.source_ip,
            user_agent: ctx.user_agent,
          });
        }
        return await withMedia(merged);
      },
    },

    {
      // search_context — a raw ranked lookup, no synthesis. The fallback
      // when get_context's scope/date/id retrieval doesn't surface the right
      // thing: embed `query` once, rank every candidate node by cosine
      // similarity, and return the top matches with their score.
      name: 'search_context',
      title: 'Search the vault',
      description:
        "Ranked lookup by free text — no synthesis, no LLM answer, just the nodes that best match `query` by embedding similarity, each with its score. Use this when get_context's scope/date/id retrieval isn't surfacing the right thing: a broad or fuzzy question that doesn't map cleanly to a scope key, or you don't know which node ids to ask for. Decide whether to name a folder: pass `subgraph` to search one folder, or omit it to search every active folder in the directory at once (each hit then carries `subgraph_id`). `include_superseded` (default false) controls whether archived/superseded nodes are searched too.",
      inputShape: {
        query: z.string().min(1).describe('The free-text search query.'),
        subgraph: z
          .string()
          .optional()
          .describe('Search one folder (slug or id); omit to search every active folder in the directory.'),
        limit: z.number().int().positive().max(200).optional().describe('Max results (default 20).'),
        include_superseded: z
          .boolean()
          .default(false)
          .describe(
            "false (default): search only current, active nodes. true: also search archived/superseded nodes — each result then carries its `status` and, once set, `superseded` (the id of the node that replaced it).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(
        args: { query: string; subgraph?: string; limit?: number; include_superseded: boolean },
        ctx,
      ) {
        const t0 = Date.now();
        const subs = await deps.repo.listSubgraphs(ctx.ws, { activeOnly: true });
        let subgraphIds: string[];
        if (args.subgraph && args.subgraph !== 'default') {
          const sg = await deps.repo.getSubgraphBySlug(ctx.ws, args.subgraph) ?? await deps.repo.getSubgraph(ctx.ws, args.subgraph);
          if (!sg) throw new ToolError('not_found', 404, { detail: `no folder '${args.subgraph}'` });
          subgraphIds = [sg.id];
        } else if (subs.length <= 1) {
          subgraphIds = ['default'];
        } else {
          subgraphIds = subs.map((s) => s.id);
        }
        const multi = subgraphIds.length > 1;
        const hits = multi
          ? await searchNodesMulti({
              repo: deps.repo,
              workspace_id: ctx.ws,
              query: args.query,
              embedder: getEmbedder(),
              subgraph_ids: subgraphIds,
              activeOnly: !args.include_superseded,
              viewer: ctx.user_id,
              limit: args.limit,
            })
          : await searchNodes({
              repo: deps.repo,
              workspace_id: ctx.ws,
              query: args.query,
              embedder: getEmbedder(),
              subgraph_id: subgraphIds[0],
              activeOnly: !args.include_superseded,
              viewer: ctx.user_id,
              limit: args.limit,
            });
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.search_context',
          resource_type: 'mcp_call',
          payload: {
            query_len: args.query.length,
            include_superseded: args.include_superseded,
            hit_count: hits.length,
            subgraphs: subgraphIds,
            latency_ms: Date.now() - t0,
          },
        });
        await deps.repo.recordContextAccess(ctx.ws, {
          actor_user_id: ctx.user_id,
          channel: 'mcp',
          tool: 'search',
          request_text: args.query,
          detail: describeReadOptions({ limit: args.limit, include_superseded: args.include_superseded }),
          node_count: hits.length,
          accessed_node_ids: nodeIdsOf(hits as unknown[]),
          latency_ms: Date.now() - t0,
          subgraph_id: subgraphIds[0],
          source_ip: ctx.source_ip,
          user_agent: ctx.user_agent,
        });
        return {
          query: args.query,
          include_superseded: args.include_superseded,
          hit_count: hits.length,
          hits,
          markdown: renderSearchMarkdown(args.query, hits),
          ...(multi ? { subgraphs: subgraphIds } : {}),
        };
      },
    },

    {
      // ingest_document — same pipeline as the web ingest route (capture →
      // registry → dedup → candidates). Everything lands as PENDING
      // candidates; nothing mutates the graph here.
      name: 'ingest_document',
      title: 'Add a source to the vault',
      description:
        "Add a source document (text) to the directory: it's routed to the folder(s) it belongs to, written into that folder's shape, and linked with edges — usually applied immediately. Routing may instead be HELD for the user to decide: the router wants to create a new folder, or found nothing to go on for an existing one, or found no existing folder fits at all (there's no drop outcome: a document that fits nothing existing always proposes a new folder for a human to accept or reject). A held response has `pending_approval: true`, `status: \"awaiting_user_decision\"`, a `notice`, and `pending_route` (what was proposed, plus `ask_user` — the question to put to the user). When you see it, STOP: the document is NOT ingested and no content was captured, so never report it as added — ask the user, then call approve_route / choose_route / reject_route with the `pending_route_id`. Pass `audience` to choose who the integrated content reaches: this is how staging-then-sharing works now — ingest privately to vet it yourself first, or straight to the team when it's ready. Pass `instructions` for a free-text steer on WHAT to keep (e.g. \"strip navigation/ads/boilerplate, keep only the article\") and/or WHERE it goes — an agent decides the transform instead of the plain router. If `subgraph` is ALSO given, it's honored as the forced destination (skipping the router entirely, same as without instructions) and the agent's only job becomes the content transform; without `subgraph`, the agent picks or creates the folder itself, same as the web app's Add Source instructions field. The cleanup agent is best-effort: if it errors, times out, or the document is too large to clean in one turn, the document is still filed via the plain path (uncleaned) rather than lost — check the response for whether a transform actually happened before assuming one did.",
      inputShape: {
        source: z.string().min(1).describe('The full source text.'),
        source_kind: z
          .enum(['doc', 'slack', 'transcript', 'interaction'])
          .default('doc')
          .describe('What kind of source this is.'),
        source_ref: z.string().optional().describe('A name/reference for the source.'),
        audience: z
          .enum(['team', 'private', 'only_me'])
          .default('team')
          .describe(
            "Who can see the nodes integrated from this source: 'team' (everyone in the directory + their AI agents — the default), 'private' (you and your own AI agents only, not the team), 'only_me' (you in the app UI only — hidden from ALL AI agents, including your own). Applies to nodes auto-integrated at ingest. Still honored even when `instructions` is set — the agent it dispatches to cannot override your audience choice.",
          ),
        // NOTE: named `subgraph`, not `folder` — every tool already accepts a
        // `folder` arg (added by the withFolder wrapper below) meaning "run
        // this call against a DIFFERENT workspace"; `subgraph` here means "this
        // subfolder within the CURRENT workspace", matching subgraphArg above.
        subgraph: subgraphArg.describe(
          'Existing folder (slug or id) within THIS directory to force this document into, skipping the router entirely — no relevance check, even a wrong fit. Use the id create_subfolder returned for a folder you just created. Still honored when `instructions` is also set — it pins the destination while the agent handles the content transform.',
        ),
        instructions: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional free-text steer for how this document should be shaped and filed — e.g. "pull out the people mentioned into a People folder, create it if it doesn\'t exist" or "this is a raw web page scrape; strip navigation/ads/boilerplate and keep only the meaningful content." When set, an agent (not the plain router) decides whether to transform the text — same engine as the web app\'s Add Source "Instructions" field. It also decides WHERE the document goes, unless `subgraph` is set too, in which case that destination is pinned and the agent only handles the transform. `audience` still applies either way.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(
        args: {
          source: string;
          source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
          source_ref?: string;
          audience: 'team' | 'private' | 'only_me';
          subgraph?: string;
          instructions?: string;
        },
        ctx,
      ) {
        // Shared by both branches below: resolve+validate a caller-supplied
        // subgraph (slug or id) once, so an instructed ingest with a pinned
        // destination gets the exact same validation as the plain path.
        let forcedSubgraphId: string | undefined;
        if (args.subgraph) {
          forcedSubgraphId = await resolveSubgraphArg(ctx.ws, args.subgraph);
          if ((await deps.repo.getSubgraph(ctx.ws, forcedSubgraphId))?.status !== 'active') {
            throw new ToolError('invalid', 400, { detail: `folder '${args.subgraph}' is not active` });
          }
        }

        let cleanupFailed = false;
        if (args.instructions) {
          if (!deps.ingestInstructed) throw new ToolError('not_supported', 501);
          const t0 = Date.now();
          try {
            const result = await deps.ingestInstructed({
              ws: ctx.ws,
              user_id: ctx.user_id,
              instructions: args.instructions,
              source: args.source,
              source_kind: args.source_kind,
              source_ref: args.source_ref,
              source_ip: ctx.source_ip,
              user_agent: ctx.user_agent,
              audience: args.audience,
              forcedSubgraph: forcedSubgraphId,
            });
            if (!result.document_id) {
              // The agent ran without error but chose not to call
              // ingest_document at all — e.g. it judged the extraction to be
              // pure page furniture with nothing worth keeping. The prompt
              // (pageCleanupInstructions in the Chrome extension) asks it to
              // still file the metadata block alone rather than skip
              // ingest_document entirely, but a prompt rule nothing verifies
              // is a suggestion, not a guarantee — treat a pure decline the
              // same as a cleanup failure below and fall through to the
              // plain path, so at least the metadata header (baked into
              // `source` unconditionally regardless of what the model does —
              // see lib/api.js's buildCaptureSource) still gets filed.
              log.warn('mcp.ingest_document.instructed_declined', {
                workspace: ctx.ws,
                source_chars: args.source.length,
                latency_ms: Date.now() - t0,
                message: result.message?.slice(0, 200),
              });
              cleanupFailed = true;
            } else {
              await deps.repo.logAudit(ctx.ws, {
                actor: ctx.user_id,
                event: 'mcp.ingest_document',
                resource_type: 'mcp_call',
                payload: {
                  source_kind: args.source_kind,
                  source_ref: args.source_ref ?? null,
                  source_chars: args.source.length,
                  instructed: true,
                  candidates: result.candidates,
                  latency_ms: Date.now() - t0,
                },
              });
              // filed_to first: surface agents see a tool result truncated
              // to 800 chars, and the destination is what they must report.
              return { filed_to: await filedTo(ctx.ws, result.document_id), agent: true, ...result };
            }
          } catch (err) {
            // The cleanup agent is best-effort (a slow/erroring provider call,
            // or a document over MAX_CLEANUP_SOURCE_CHARS — see
            // add-source-agent.ts) and must never cost the document its
            // capture. Fall through to the plain deterministic path below
            // with whatever destination was already resolved: filed
            // uncleaned beats not filed at all, and a raw error here would
            // otherwise surface as an opaque 500 to the caller (observed
            // 2026-08-19: a 3-minute provider timeout on a whole-page
            // capture reached the caller as a bare "internal_error" with
            // nothing ingested).
            log.warn('mcp.ingest_document.instructed_failed', {
              workspace: ctx.ws,
              source_chars: args.source.length,
              latency_ms: Date.now() - t0,
              msg: (err as Error).message?.slice(0, 200),
            });
            cleanupFailed = true;
          }
        }

        if (!deps.ingestText) throw new ToolError('not_supported', 501);
        const t0 = Date.now();
        const result = await deps.ingestText({
          ws: ctx.ws,
          user_id: ctx.user_id,
          source: args.source,
          source_kind: args.source_kind,
          source_ref: args.source_ref,
          via: 'mcp',
          caller: 'mcp.ingest_document',
          source_ip: ctx.source_ip,
          user_agent: ctx.user_agent,
          audience: args.audience,
          fallbackAudience: ctx.fallback_audience,
          forcedSubgraphId,
        });
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.ingest_document',
          resource_type: 'mcp_call',
          payload: {
            source_kind: args.source_kind,
            source_ref: args.source_ref ?? null,
            source_chars: args.source.length,
            candidates: result.candidates,
            zero_yield: result.zero_yield ?? false,
            pending_approval: result.pending_approval ?? false,
            latency_ms: Date.now() - t0,
            ...(cleanupFailed ? { cleanup_failed: true } : {}),
          },
        });

        // A HELD route is not an ingest that produced nothing — it is an
        // unanswered question. Say so in the payload (`status`,
        // `action_required`, a plain-language `notice` and the proposal
        // itself) so the client asks the user instead of reporting a
        // zero-candidate success and dropping the thread.
        if (result.pending_approval && result.pending_route_id) {
          const pending = await describePendingRoute(ctx.ws, result.pending_route_id);
          // `notice` is null on the held result and would win the spread, so
          // drop it and lead with the decisive fields — surfaces that truncate
          // a tool result (the Slack agent's structured mode cuts at 800 chars)
          // must see the hold, not `candidates: 0`.
          const { notice: _held, ...rest } = result;
          return {
            status: 'awaiting_user_decision',
            action_required: 'ask_user_then_call_approve_route_choose_route_or_reject_route',
            notice:
              'NOT INGESTED YET — routing is held for a human decision: nothing was filed and no content ' +
              'was captured. Do not report this document as added. ' +
              (pending?.ask_user ?? '') +
              ` Then call approve_route, choose_route, or reject_route with id "${result.pending_route_id}".`,
            pending_route: pending,
            ...rest,
          };
        }
        return { filed_to: await filedTo(ctx.ws, result.document_id), ...result };
      },
    },

    {
      // list_sources — per-source curation state (spec-conversational-curation.md
      // §9): the document-level view of what needs curating, mirroring the web
      // Curate page's source list.
      name: 'list_sources',
      title: 'List what has been ingested',
      description:
        "Every document ingested into this directory: what it was, when, and what it produced. A receipt of what went into the vault, not an approval queue — ingestion already applied. document_id 'loose' is the bucket for items with no source document.",
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(_args: Record<string, never>, ctx) {
        if (!deps.listSources) throw new ToolError('not_supported', 501);
        const sources = await deps.listSources(ctx.ws);
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.list_sources',
          payload: { returned: sources.length },
        });
        return { sources };
      },
    },

    // ---------- routing approval ----------
    //
    // A routing decision the router could not auto-apply: it wants to create
    // a new folder, or picked an existing one it had nothing to go on (no
    // owner description, no content). Held in pending_routes until a human
    // resolves it — see resolveIngestTargets / runTextIngest (api/routes.ts)
    // and spec-pomegranate-light.md "Routing is the most important stage".

    {
      name: 'list_pending_routes',
      title: 'List routing decisions awaiting review',
      description:
        'List documents whose routing is being held for review: either the router wants to create a new folder, or it picked an existing folder with nothing to go on. Each entry carries the question to put to the user and the folder NAMES involved. Use approve_route, choose_route, or reject_route to resolve one.',
      inputShape: {
        status: z.enum(['pending', 'approved', 'rejected']).optional().describe("Defaults to 'pending'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args: { status?: 'pending' | 'approved' | 'rejected' }, ctx) {
        const rows = await deps.repo.listPendingRoutes(ctx.ws, { status: args.status ?? 'pending' });
        // Raw rows carry folder IDs only, which a user cannot be asked about.
        // Keep the row shape (callers read `proposed_new_folder`, `id`, …) and
        // add the resolved names + the question, same as ingest_document's
        // held response.
        const pending_routes = await Promise.all(rows.map(async (row) => ({ ...row, ...(await describePendingRoute(ctx.ws, row.id) ?? {}) })));
        return { pending_routes };
      },
    },

    {
      // approve_route / choose_route / reject_route: only a PENDING row can be
      // resolved — same second-click guard as approve_candidate/reject_candidate.
      name: 'approve_route',
      title: 'Approve a proposed routing decision',
      description:
        'Approve a held routing decision as the router proposed it: creates the new folder if one was proposed, files the document into it (and any other proposed folders), and runs capture. Only do this when the user explicitly decides.',
      inputShape: { id: z.string().min(1).describe('The pending route id (from list_pending_routes).') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { id: string }, ctx) {
        if (!deps.resolvePendingRoute) throw new ToolError('not_supported', 501);
        const result = await deps.resolvePendingRoute(ctx.ws, args.id, { action: 'approve', resolved_by: ctx.user_id });
        if (!result.ok) throw new ToolError(result.error, result.status);
        log.info('routing.approved', { workspace: ctx.ws, user: ctx.user_id, via: 'mcp', pending_route_id: args.id });
        return result;
      },
    },

    {
      name: 'choose_route',
      title: 'File a held document into a different folder',
      description:
        "Resolve a held routing decision by choosing folder(s) yourself instead of what the router proposed — for the low-confidence case (an empty, undocumented folder the router was guessing at). Files the document into the chosen folder(s) and runs capture; does NOT create a new folder. Only do this when the user explicitly decides.",
      inputShape: {
        id: z.string().min(1).describe('The pending route id (from list_pending_routes).'),
        target_ids: z.array(z.string().min(1)).min(1).describe('Folder ids or slugs to file the document into.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { id: string; target_ids: string[] }, ctx) {
        if (!deps.resolvePendingRoute) throw new ToolError('not_supported', 501);
        const resolvedTargets = await Promise.all(args.target_ids.map(async (t) => await resolveSubgraphArg(ctx.ws, t)));
        const result = await deps.resolvePendingRoute(ctx.ws, args.id, {
          action: 'choose',
          chosen_target_ids: resolvedTargets,
          resolved_by: ctx.user_id,
        });
        if (!result.ok) throw new ToolError(result.error, result.status);
        log.info('routing.chosen', {
          workspace: ctx.ws,
          user: ctx.user_id,
          via: 'mcp',
          pending_route_id: args.id,
          targets: resolvedTargets,
        });
        return result;
      },
    },

    {
      name: 'reject_route',
      title: 'Reject a held routing decision',
      description:
        'Reject a held routing decision: the document is not filed anywhere and no folder is created. Only do this when the user explicitly decides.',
      inputShape: { id: z.string().min(1).describe('The pending route id (from list_pending_routes).') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { id: string }, ctx) {
        if (!deps.resolvePendingRoute) throw new ToolError('not_supported', 501);
        const result = await deps.resolvePendingRoute(ctx.ws, args.id, { action: 'reject', resolved_by: ctx.user_id });
        if (!result.ok) throw new ToolError(result.error, result.status);
        log.info('routing.rejected', { workspace: ctx.ws, user: ctx.user_id, via: 'mcp', pending_route_id: args.id });
        return result;
      },
    },

    {
      // create_subfolder — proactive folder creation, mirroring
      // POST /workspaces/:ws/subgraphs (routes.ts): bind a new subgraph to a
      // built-in template. The router can also create a folder as a side
      // effect of approve_route, but that's reactive (document-triggered,
      // template picked by the router); this lets a user set one up ahead of
      // time and describe what it's for themselves — which routing weighs
      // above its own inference.
      name: 'create_subfolder',
      title: 'Create a folder',
      description:
        "Create a new folder (see list_templates for the template id — today there is just one, 'notes': a general record of whatever arrives). Give it your own description of what it holds; routing weighs that above its own guess. Owner/admin only.",
      inputShape: {
        template_id: z.string().min(1).describe('A template id from list_templates.'),
        name: z.string().min(1).optional().describe('Display name; defaults to the template name.'),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe('#slug used to pin queries to this folder; auto-generated from the template id if omitted.'),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("What this folder is for, in your own words — outranks the router's inference when deciding what goes here."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(
        args: { template_id: string; name?: string; slug?: string; description?: string },
        ctx,
      ) {
        if (!await deps.ruleWriteAllowed?.(ctx.ws, ctx.user_id)) {
          throw new ToolError('forbidden', 403, { detail: 'only the directory owner or an admin can create folders' });
        }
        const profile = getBuiltinProfile(args.template_id);
        if (!profile) {
          const allowed = listBuiltinProfiles().map((p) => p.id).join(', ');
          throw new ToolError('invalid', 400, {
            detail: `unknown template_id '${args.template_id}' (allowed: ${allowed})`,
          });
        }
        const taken = new Set((await deps.repo.listSubgraphs(ctx.ws)).map((s) => s.slug));
        const slug = uniqueSubgraphSlug(args.slug ?? profile.id, taken);
        const name = args.name ?? profile.name;
        const { id } = await deps.repo.createSubgraph(ctx.ws, { slug, name, description: args.description });
        await deps.repo.setWorkspaceProfile(ctx.ws, profile.id, profile, id);
        await deps.repo.logCustomerAudit(ctx.ws, {
          event: 'profile_assigned',
          actor_user_id: ctx.user_id,
          resource_type: 'workspace_profile',
          resource_id: id,
          payload: { profile_id: profile.id, subgraph_id: id, via: 'mcp' },
        });
        log.info('subgraph.created', {
          workspace: ctx.ws,
          user: ctx.user_id,
          via: 'mcp',
          subgraph_id: id,
          template_id: profile.id,
        });
        return {
          subgraph_id: id,
          slug,
          name,
          description: (await deps.repo.getSubgraph(ctx.ws, id))?.description ?? 'miscellaneous',
          template_id: profile.id,
        };
      },
    },

    // ---------- automation rules (spec-folder-tracking-and-ingestion-rules.md) ----------

    {
      name: 'list_rules',
      title: 'List automation rules',
      description:
        "The directory's automation rules (redaction/filtering at ingest and/or use-phase): instructions, scope tiers, phases, enabled state — plus whether the user may edit them (owner/admin only).",
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(_args: Record<string, never>, ctx) {
        // Repointed at the unified automations table (redesign of the
        // Automations tab): lazily migrate any legacy rules, seed defaults for
        // a genuinely fresh folder, same as the web GET /automations route.
        await deps.repo.migrateRulesToAutomations(ctx.ws);
        await deps.repo.seedDefaultAutomations(ctx.ws, null);
        const can_edit = await deps.ruleWriteAllowed?.(ctx.ws, ctx.user_id) ?? false;
        await deps.repo.logAudit(ctx.ws, { actor: ctx.user_id, event: 'mcp.list_rules' });
        return { rules: await deps.repo.listAutomations(ctx.ws, 'shape'), can_edit };
      },
    },

    {
      name: 'upsert_rule',
      title: 'Create or update an automation rule',
      description:
        'Create a rule from plain-language instructions, or update an existing one (pass its id). The server infers when the rule fires (store/use) and its target from the instructions. Owner/admin only. Only do this when the user explicitly decides.',
      inputShape: {
        id: z.string().optional().describe('Existing rule id to update; omit to create.'),
        instructions: z.string().min(1).describe('The rule, in plain language.'),
        scopes: z
          .array(z.enum(['only_me', 'private', 'team']))
          .default([])
          .describe('Visibility tiers the rule applies to (empty = all).'),
        enabled: z.boolean().optional(),
        sort_order: z.number().int().optional().describe('Precedence; lower fires first.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(
        args: {
          id?: string;
          instructions: string;
          scopes: Array<'only_me' | 'private' | 'team'>;
          enabled?: boolean;
          sort_order?: number;
        },
        ctx,
      ) {
        if (!deps.classifyRule) throw new ToolError('not_supported', 501);
        if (!await deps.ruleWriteAllowed?.(ctx.ws, ctx.user_id)) {
          throw new ToolError('forbidden', 403, { detail: 'only the directory owner or an admin can edit rules' });
        }
        // Repointed at the unified automations table — same tool name/shape,
        // new storage underneath (external MCP clients already depend on
        // `upsert_rule`, so the tool surface is kept stable).
        const existing = args.id ? await deps.repo.getAutomation(ctx.ws, args.id) : undefined;
        if (args.id && !existing) throw new ToolError('not_found', 404);
        const cls = await deps.classifyRule(args.instructions);
        const rule = await deps.repo.upsertAutomation(ctx.ws, {
          ...(existing
            ? {
                id: existing.id,
                kind: 'shape',
                owner_user_id: existing.owner_user_id,
                created_at: existing.created_at,
                scopes: args.scopes.length > 0 ? args.scopes : existing.scopes,
                enabled: args.enabled ?? existing.enabled,
                sort_order: args.sort_order ?? existing.sort_order,
              }
            : { kind: 'shape' as const, scopes: args.scopes, enabled: args.enabled, sort_order: args.sort_order }),
          instructions: args.instructions,
          phases: cls.phases,
          action: 'shape',
          target: cls.target,
        });
        log.info('rules.upserted', { workspace: ctx.ws, user: ctx.user_id, rule_id: rule.id, via: 'mcp' });
        return { rule };
      },
    },

    {
      name: 'delete_rule',
      title: 'Delete an automation rule',
      description: 'Delete a rule by id. Owner/admin only. Only do this when the user explicitly decides.',
      inputShape: { id: z.string().min(1).describe('The rule id.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async handler(args: { id: string }, ctx) {
        if (!await deps.ruleWriteAllowed?.(ctx.ws, ctx.user_id)) {
          throw new ToolError('forbidden', 403, { detail: 'only the directory owner or an admin can edit rules' });
        }
        if (!await deps.repo.getAutomation(ctx.ws, args.id)) throw new ToolError('not_found', 404);
        await deps.repo.deleteAutomation(ctx.ws, args.id);
        log.info('rules.deleted', { workspace: ctx.ws, user: ctx.user_id, rule_id: args.id, via: 'mcp' });
        return { ok: true };
      },
    },

    {
      name: 'test_rule',
      title: 'Dry-run a rule against sample text',
      description:
        'Test how a rule applies without persisting anything. The response shape depends on the rule: ingestion rules diff candidates with vs without; source rules show the scrubbed text; curation rules show the forced disposition; use-phase rules answer a question with vs without redaction. Owner/admin only.',
      inputShape: {
        id: z.string().min(1).describe('The rule id.'),
        text: z.string().optional().describe('Sample document text (ingestion/source/curation rules).'),
        question: z.string().optional().describe('Sample question (use-phase rules).'),
        source_kind: z.enum(['doc', 'slack', 'transcript', 'interaction']).default('doc'),
        subgraph: subgraphArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(
        args: { id: string; text?: string; question?: string; source_kind: 'doc' | 'slack' | 'transcript' | 'interaction'; subgraph?: string },
        ctx,
      ) {
        if (!deps.testRule) throw new ToolError('not_supported', 501);
        if (!await deps.ruleWriteAllowed?.(ctx.ws, ctx.user_id)) {
          throw new ToolError('forbidden', 403, { detail: 'only the directory owner or an admin can test rules' });
        }
        const r = await deps.testRule({
          ws: ctx.ws,
          rule_id: args.id,
          user_id: ctx.user_id,
          text: args.text,
          question: args.question,
          source_kind: args.source_kind,
          subgraph_id: await resolveSubgraphArg(ctx.ws, args.subgraph),
        });
        if (!r.ok) {
          throw new ToolError(r.status === 404 ? 'not_found' : 'invalid', r.status, { detail: r.error });
        }
        return r.result;
      },
    },
  ];

  // Discovery + defaults (surface unification). These are folder-agnostic —
  // they describe the caller's whole reach — so they are NOT withFolder-wrapped.
  const discovery: ToolDef[] = [
    {
      // list_templates — the built-in catalog (global, not per-folder), so it
      // lives here rather than in `base`. Pass the id as create_subfolder's
      // template_id.
      name: 'list_templates',
      title: 'List folder templates',
      description:
        "The shapes available when creating a folder: id, name, what it's for, and its cardinality (items = many entries per kind, slots = one node per named section). Pass the id as template_id to create_subfolder.",
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(_args: Record<string, never>, _ctx) {
        const templates = listBuiltinProfiles().map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          shape: p.shape,
          routing_hint: p.routing_hint ?? null,
        }));
        return { templates };
      },
    },

    {
      name: 'list_folders',
      title: 'List the directories you can access',
      description:
        "Every directory (workspace) the user is a member of: id, name, your role, its folders (#slugs usable to pin queries), whether it is the user's default directory, and whether it is the directory this connection is currently pointed at. Also `connected_as`: the account this connection signs in as — always tell the user which account that is, so they notice if the assistant is connected to someone else's account.",
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(_args: Record<string, never>, ctx) {
        const dflt = await deps.repo.getUserDefault(ctx.user_id, 'mcp');
        const folders = [];
        for (const m of await deps.repo.listMembershipsWithWorkspace(ctx.user_id)) {
          if ((await deps.repo.getWorkspace(m.id))?.ai_allowed === 0) continue;
          folders.push({
            id: m.id,
            name: m.name,
            role: m.role,
            is_default: dflt?.workspace_id === m.id,
            is_current: m.id === ctx.ws,
            subgraphs: (await deps.repo
              .listSubgraphs(m.id, { activeOnly: true }))
              .map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description })),
          });
        }
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.list_folders',
          payload: { returned: folders.length },
        });
        // Which account this connection is. An assistant keeps the account it
        // first connected with, so after switching people on one computer it
        // can still be someone else — this is how the user finds out.
        const me = await deps.repo.getUserById(ctx.user_id);
        return { connected_as: me?.email ?? null, folders };
      },
    },

    {
      name: 'list_team',
      title: 'List your teammates',
      description:
        'Everyone on the user\'s email domain: display name, email, slack handle, their default directory, and which of their directories are shared with the user. Use these references (name, email, @handle) as the `folder` argument of other tools. For what is INSIDE those directories (folders, and directories not shared with the user), use explore_team_folders. A company domain is what groups people: on a personal mailbox domain (gmail.com, outlook.com, …) this returns the user alone, because strangers who share a mailbox provider are not a team — their teammates reach them through directory membership instead.',
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(_args: Record<string, never>, ctx) {
        const me = await deps.repo.getUserById(ctx.user_id);
        const domain = emailDomain(me?.email);
        const rows = domain ? await deps.repo.listDomainDirectory(domain, ctx.user_id) : [];
        const allowed = new Set<string>();
        for (const u of rows) for (const w of u.workspaces) {
          if ((await deps.repo.getWorkspace(w.id))?.ai_allowed !== 0) allowed.add(w.id);
        }
        const team = rows.map((u) => ({
          display_name: u.display_name,
          email: u.email,
          slack_handle: u.slack?.handle ?? null,
          is_you: u.user_id === ctx.user_id,
          default_folder: u.default_folder && allowed.has(u.default_folder.workspace_id) ? u.default_folder.workspace_id : null,
          folders: u.workspaces.filter((w) => allowed.has(w.id)).map((w) => ({
            id: w.id,
            name: w.name,
            shared_with_you: w.viewer_role !== null,
          })),
        }));
        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.list_team',
          payload: { returned: team.length },
        });
        return { domain, team };
      },
    },

    {
      // explore_team_folders — the MCP twin of the web app's Setup → "Explore
      // team folders" page: the domain directory drilled all the way down to
      // SUBFOLDERS, including folders the caller cannot read yet. That last
      // part is the point: discovery is how you learn a folder exists before
      // you have access to it, and request_folder_access is the next step.
      //
      // Discovery reaches one ORG, never a mailbox provider: on a personal
      // domain the directory is the caller alone (src/lib/email-domain.ts), so
      // nothing of a stranger who happens to share gmail.com is browsable here.
      //
      // Exposure matches the web page exactly — a subfolder's name, slug,
      // status and template are directory metadata; its DESCRIPTIONS (what
      // the owner says it holds, and the generated routing digest, which is
      // derived from content) are attached only for folders the caller is a
      // member of.
      name: 'explore_team_folders',
      title: "Explore your team's directories and folders",
      description:
        "Browse the directories on the user's email domain and what's inside them: every teammate, each directory they belong to, and that directory's folders (#slug, name, what it holds). Includes directories NOT shared with the user — that is how you find one worth asking for; `shared_with_you` says whether the user can read it today, and request_folder_access asks its owner for membership. For a directory that is shared, pass its id (or name) as the `folder` argument of any other tool — the same connection reaches all of them, no per-directory setup. Only a company domain groups people: on a personal mailbox domain (gmail.com, outlook.com, …) this returns the user's own directories and nothing else.",
      inputShape: {
        query: z
          .string()
          .optional()
          .describe('Filter people by display name, email, or @slack handle (case-insensitive substring).'),
        access: z
          .enum(['all', 'shared', 'not_shared'])
          .default('all')
          .describe(
            "Which directories to return: 'all' (default), 'shared' (only directories the user can already read), or 'not_shared' (only directories they'd have to request access to).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(args: { query?: string; access: 'all' | 'shared' | 'not_shared' }, ctx) {
        const me = await deps.repo.getUserById(ctx.user_id);
        const domain = emailDomain(me?.email);
        const rows = domain ? await deps.repo.listDomainDirectory(domain, ctx.user_id) : [];
        const allowed = new Set<string>();
        for (const u of rows) for (const w of u.workspaces) {
          if ((await deps.repo.getWorkspace(w.id))?.ai_allowed !== 0) allowed.add(w.id);
        }
        const needle = args.query?.trim().toLowerCase() ?? '';
        const matched = needle
          ? rows.filter(
              (u) =>
                u.email.toLowerCase().includes(needle) ||
                (u.display_name ?? '').toLowerCase().includes(needle) ||
                (u.slack?.handle ?? '').toLowerCase().includes(needle),
            )
          : rows;

        // Subfolder details of every directory the viewer is a member of, read
        // once up front so the transform below stays a pure (synchronous) map.
        const memberSubgraphs = new Map<string, Awaited<ReturnType<typeof deps.repo.listSubgraphs>>>();
        for (const u of matched) {
          for (const w of u.workspaces) {
            if (!allowed.has(w.id)) continue;
            if (w.viewer_role !== null && !memberSubgraphs.has(w.id)) memberSubgraphs.set(w.id, await deps.repo.listSubgraphs(w.id));
          }
        }
        let folderCount = 0;
        const people = matched
          .map((u) => {
            const folders = u.workspaces
              .filter((w) => allowed.has(w.id))
              .filter((w) =>
                args.access === 'shared'
                  ? w.viewer_role !== null
                  : args.access === 'not_shared'
                    ? w.viewer_role === null
                    : true,
              )
              .map((w) => {
                const isMember = w.viewer_role !== null;
                // Owner-authored + generated descriptions are content, not
                // directory metadata — members only.
                const detail = isMember
                  ? new Map((memberSubgraphs.get(w.id) ?? []).map((s) => [s.id, s]))
                  : null;
                return {
                  id: w.id,
                  name: w.name,
                  owner_email: w.owner_email,
                  their_role: w.role,
                  your_role: w.viewer_role,
                  shared_with_you: isMember,
                  is_their_default: u.default_folder?.workspace_id === w.id,
                  subfolders: w.profiles.map((p) => {
                    const sg = detail?.get(p.subgraph_id);
                    return {
                      id: p.subgraph_id,
                      slug: p.slug,
                      name: p.name,
                      status: p.status,
                      template_id: p.profile_id,
                      ...(sg
                        ? {
                            description: sg.description,
                            generated_description: sg.generated_description ?? null,
                          }
                        : {}),
                    };
                  }),
                };
              });
            folderCount += folders.length;
            return {
              display_name: u.display_name,
              email: u.email,
              slack_handle: u.slack?.handle ?? null,
              is_you: u.user_id === ctx.user_id,
              default_folder: u.default_folder && allowed.has(u.default_folder.workspace_id) ? u.default_folder.workspace_id : null,
              folders,
            };
          })
          // A person with no folder left after filtering carries no signal.
          .filter((p) => p.folders.length > 0);

        await deps.repo.logAudit(ctx.ws, {
          actor: ctx.user_id,
          event: 'mcp.explore_team_folders',
          payload: { query: needle || null, access: args.access, people: people.length, folders: folderCount },
        });
        return { domain, people };
      },
    },

    {
      // request_folder_access — the "Request access" button from the same web
      // page. Resolution is deliberately UNGATED (the whole point is a folder
      // you are not a member of); the shared orchestration re-checks the
      // domain and membership before it emails anyone.
      name: 'request_folder_access',
      title: 'Ask for access to a directory',
      description:
        "Ask the owner of a directory the user cannot read for membership: emails them the request. Use it after explore_team_folders turns up a directory with `shared_with_you: false`. Once the owner adds the user, this same connection reaches that directory through the `folder` argument — nothing else to connect. Only call on the user's explicit ask.",
      inputShape: {
        folder: z
          .string()
          .min(1)
          .describe('The directory to request access to: a directory id or name (or a teammate reference, meaning their default directory).'),
        message: z
          .string()
          .max(500)
          .optional()
          .describe('An optional note to the owner explaining why (included verbatim in the email).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { folder: string; message?: string }, ctx) {
        if (!deps.requestFolderAccess) throw new ToolError('not_supported', 501);
        const resolved = await resolveFolderRefUngated(deps.repo, ctx.user_id, args.folder, 'mcp', true);
        const w = await deps.repo.getWorkspace(resolved.workspace_id);
        await assertAiAllowed(resolved.workspace_id);
        const r = await deps.requestFolderAccess({
          workspace_id: resolved.workspace_id,
          user_id: ctx.user_id,
          message: args.message,
          source_ip: ctx.source_ip,
          user_agent: ctx.user_agent,
        });
        if (!r.ok) {
          // Already a member is not a failure to report as one: the caller
          // asked for reach they already have, so say so and name the arg.
          if (r.error === 'already_member') {
            return {
              ok: true,
              already_a_member: true,
              folder: { id: resolved.workspace_id, name: w?.name ?? null },
              note: `You already have access — pass directory: '${resolved.workspace_id}' to any tool.`,
            };
          }
          throw new ToolError(r.error, r.status, {
            detail:
              r.error === 'forbidden'
                ? 'you can only request access to directories on your own email domain'
                : `no directory '${args.folder}'`,
          });
        }
        log.info('folder.access_requested', {
          workspace: resolved.workspace_id,
          user: ctx.user_id,
          via: 'mcp',
          sent: r.sent,
        });
        return {
          ok: true,
          requested: true,
          folder: { id: resolved.workspace_id, name: w?.name ?? null },
          owner_email: r.owner_email,
          emailed: r.sent,
        };
      },
    },

    {
      name: 'set_default_folder',
      title: 'Set the default directory',
      description:
        "Set the user's default directory — where this connection (and teammates referencing this user) lands when no directory is named. Membership required. Only call on the user's explicit ask.",
      inputShape: {
        folder: z
          .string()
          .min(1)
          .describe('The directory to make the default (id, name, or any directory reference).'),
        surface: z
          .enum(['all', 'slack', 'mcp', 'whatsapp'])
          .default('all')
          .describe("Which surface the default applies to; 'all' unless the user says otherwise."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(args: { folder: string; surface: 'all' | 'slack' | 'mcp' | 'whatsapp' }, ctx) {
        const resolved = await resolveFolderRef(deps.repo, ctx.user_id, args.folder, 'mcp', true);
        await assertAiAllowed(resolved.workspace_id);
        const dflt = await deps.repo.setUserDefault(ctx.user_id, args.surface, resolved.workspace_id);
        await deps.repo.logCustomerAudit(resolved.workspace_id, {
          event: 'default_folder_set',
          actor_user_id: ctx.user_id,
          source_ip: ctx.source_ip,
          user_agent: ctx.user_agent,
          resource_type: 'workspace',
          resource_id: resolved.workspace_id,
          payload: { surface: args.surface, via: 'mcp' },
        });
        const w = await deps.repo.getWorkspace(resolved.workspace_id);
        return { ok: true, default: { ...dflt, folder_name: w?.name ?? null } };
      },
    },
  ];

  return [
    ...base.map((def) => withFolder(withGovernance(deps.repo, withAiAccess(def)))),
    ...discovery.map((def) => withGovernance(deps.repo, def)),
  ];
}
