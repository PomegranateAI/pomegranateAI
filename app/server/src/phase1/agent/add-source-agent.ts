import { z } from 'zod';
import { loadPromptBody, promptMeta } from '../../lib/anthropic.js';
import { runSurfaceAgent, type CreateMessage, type SurfaceAgentResult } from './surface-agent.js';
import type { ToolCtx, ToolDef } from '../mcp/registry.js';

/**
 * The Add Source instructions agent — same engine as the Slack surface agent
 * (runSurfaceAgent), a different prompt and a narrow two-tool catalog. Given a
 * document and free-text instructions ("pull out the people mentioned into a
 * People folder, make one if it doesn't exist"), it decides whether to
 * transform the text, picks or creates the destination folder, and ingests —
 * using the exact same ingest_document / create_subfolder tools an MCP client
 * or the Slack agent would use themselves. No new ingestion path.
 */

const ADD_SOURCE_AGENT_PROMPT = loadPromptBody('add-source-agent');
const ADD_SOURCE_AGENT_PROMPT_VERSION = promptMeta('add-source-agent').version;

/** Output token budget for this task — a document transform needs more room
 *  than the surface agent's short chat replies. */
const MAX_TOKENS = 4000;

/**
 * This task is high-output, low-reasoning — retype/clean a document, not
 * open-ended chat judgment — so it overrides runSurfaceAgent's shared
 * Sonnet-tier default (see SurfaceAgentParams.model's doc comment) with
 * Haiku 4.5, matching the model classify-whole-doc/route-document/
 * propose-new-folder already use successfully on comparably large page text
 * (1-3s, prod-verified) elsewhere in this codebase. The default model's
 * lower output-token throughput made a ~4000-token document transform
 * reliably exceed the client timeout (observed 2026-08-19: 100% failure
 * rate across 5 real captures, ~120-180s each, zero successes) — not a
 * broken call, just the wrong tier for how much text this task has to
 * generate. Pinned to the same dated id already proven live in this
 * deployment rather than an untested undated alias.
 */
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Hard ceiling on the document text embedded in the prompt (composeUserMessage
 * puts the whole thing in a single turn — unlike the main capture pipeline,
 * there's no chunkMarkdown splitting here, since a free-form cleanup transform
 * can't safely run per-chunk and get reassembled the way discrete candidate
 * extraction can: a chunk boundary landing mid-thought would either lose
 * content or need the model to somehow merge partial rewrites back together).
 * Real whole-page captures observed in prod run 15K-40K chars; this leaves
 * generous headroom while bounding the worst case (an oversized/duplicated
 * DOM scrape) instead of gambling on however long a huge single-turn
 * completion takes. Over the ceiling, runAddSourceAgent throws instead of
 * calling the model — callers (runInstructedIngest → registry.ts's
 * ingest_document handler) catch that and fall back to the plain path, same
 * as any other cleanup failure.
 */
export const MAX_CLEANUP_SOURCE_CHARS = 60_000;

const TOOL_NAMES = ['ingest_document', 'create_subfolder'];

export interface AddSourceFolder {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

export interface AddSourceTemplate {
  id: string;
  name: string;
  description: string;
}

export interface AddSourceAgentParams {
  instructions: string;
  source: string;
  source_kind: 'doc' | 'slack' | 'transcript' | 'interaction';
  source_ref?: string;
  ctx: ToolCtx;
  /** The full registry catalog (createTools output) — filtered down here. */
  tools: ToolDef[];
  /** The workspace's existing active subfolders, for the agent to pick from. */
  folders: AddSourceFolder[];
  /** The template catalog, for the agent to pick from when creating a folder. */
  templates: AddSourceTemplate[];
  /** Overrides whatever audience the model picks — see wrapIngestDocument §3. */
  audience?: 'team' | 'private' | 'only_me';
  /** Pins the destination folder, bypassing the model's own choice — see
   *  wrapIngestDocument §4. When set, the agent's only job is the content
   *  transform; it never sees create_subfolder (nothing to create). */
  forcedSubgraph?: string;
}

/** Structured-mode sentinel for "the instructions say nothing about
 *  destination — let the normal router decide" (see buildStepSchema below).
 *  Needs to be a real enum value rather than "leave subgraph unset": in the
 *  per-step JSON schema `subgraph` is REQUIRED on every turn regardless of
 *  which tool is chosen (a flat schema can't conditionally require a field
 *  only when tool === 'ingest_document'), so there has to be a valid value
 *  meaning "no destination" for the model to fall back on. */
export const DEFER_TO_ROUTER = 'let_the_router_decide';

/**
 * Wrap ingest_document to take over two things the model has proven unreliable
 * at deciding on its own (see template-eval-results / eval-add-source-agent.ts):
 *
 * 1. Passthrough text. "File this as-is" used to require the model to retype
 *    the entire document into `source` in the same step that also decides the
 *    tool/folder — wasted tokens and latency, and a real risk of silently
 *    dropping or altering content nobody asked to have touched. `source` is
 *    optional now: when the model leaves it unset, the ORIGINAL text is
 *    substituted here, before the real handler ever runs — a transform is
 *    only present when the model deliberately emitted one, which also makes
 *    it self-auditing (a receipt carrying `source` means a transform
 *    happened; one without it didn't).
 * 2. The router-deferral sentinel. Translates DEFER_TO_ROUTER back into "no
 *    subgraph arg at all" before it reaches the real tool — the model always
 *    answers the subgraph question (see buildStepSchema), but the real
 *    ingest_document call only gets `subgraph` when a folder was genuinely
 *    chosen.
 * 3. Audience. When the caller (not the model) already knows who this should
 *    reach — e.g. a visibility picker the user set outside the instructions
 *    text — `forcedAudience` overrides whatever the model picks, the same
 *    way `subgraph`/`folder` pickers stay authoritative elsewhere. Instructions
 *    are free text about WHAT to keep and WHERE it goes, not a reliable place
 *    to also relitigate WHO sees it.
 * 4. Destination. Same reasoning as #3, for WHERE instead of WHO: a caller
 *    that already pinned a folder outside the instructions text (e.g. the
 *    Chrome extension's destination picker) wants the agent's cleanup without
 *    handing it the routing decision too. `forcedSubgraph` overrides whatever
 *    the model answered — it still has to answer (see buildStepSchema), the
 *    answer just never reaches the real tool.
 */
function wrapIngestDocument(
  tool: ToolDef,
  originalSource: string,
  forcedAudience?: 'team' | 'private' | 'only_me',
  forcedSubgraph?: string,
): ToolDef {
  return {
    ...tool,
    inputShape: { ...tool.inputShape, source: z.string().optional() },
    async handler(args: Record<string, unknown>, ctx) {
      const transformed = typeof args.source === 'string' ? args.source.trim() : '';
      const subgraph = forcedSubgraph ?? (args.subgraph === DEFER_TO_ROUTER ? undefined : args.subgraph);
      return tool.handler(
        { ...args, source: transformed || originalSource, subgraph, ...(forcedAudience ? { audience: forcedAudience } : {}) },
        ctx,
      );
    },
  };
}

/**
 * Structured-mode (hosted/local Qwen) per-step schema, built fresh for THIS
 * two-tool catalog instead of reusing the surface agent's generic, registry-
 * wide flat schema (surface-agent.ts's stepSchemaFor). That shared schema
 * buries `subgraph` as one of ~25 loosely-typed optional fields with no
 * per-tool relevance signal — measured (eval-add-source-agent.ts) to make the
 * model skip it almost every time, even when the instructions plainly name a
 * matching folder. Here `subgraph` is a REQUIRED, enumerated choice — the
 * existing folders shown, plus any folder create_subfolder has already
 * created THIS run, plus DEFER_TO_ROUTER — so hallucinating an arbitrary
 * string is no longer a possible output, and answering the destination
 * question isn't optional. Recomputed every step so the enum can grow once a
 * new folder's real id comes back.
 */
export function buildStepSchema(
  tools: ToolDef[],
  receipts: SurfaceAgentResult['receipts'],
  folders: AddSourceFolder[],
  templates: AddSourceTemplate[],
): Record<string, unknown> {
  const createdIds = receipts
    .filter((r) => r.tool === 'create_subfolder' && r.ok && typeof r.result.subgraph_id === 'string')
    .map((r) => r.result.subgraph_id as string);
  const subgraphChoices = [...new Set([...folders.map((f) => f.slug), ...createdIds, DEFER_TO_ROUTER])];
  const templateChoices = templates.map((t) => t.id);
  return {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'One short line: what you are doing this turn and why.' },
      tool: {
        type: 'string',
        enum: [...tools.map((t) => t.name), 'none'],
        description: "The single tool to run this turn, or 'none' when you are done and just replying.",
      },
      source: {
        type: ['string', 'null'],
        description:
          'ONLY set this when tool is ingest_document AND you are deliberately rewriting/trimming the document. Leave it unset to file the document unchanged — the system substitutes the original text itself. Never retype the document just to pass it through.',
      },
      source_kind: { type: ['string', 'null'], enum: ['doc', 'slack', 'transcript', 'interaction', null] },
      source_ref: { type: ['string', 'null'], description: 'A name/reference for the source (ingest_document).' },
      audience: { type: ['string', 'null'], enum: ['team', 'private', 'only_me', null] },
      subgraph: {
        type: 'string',
        enum: subgraphChoices,
        description: `REQUIRED whenever tool is ingest_document (ignored otherwise). One of the existing folders (${
          folders.length ? folders.map((f) => f.slug).join(', ') : 'none yet'
        })${createdIds.length ? `, the folder you just created (${createdIds.join(', ')})` : ''}, or '${DEFER_TO_ROUTER}' only when the instructions say nothing at all about destination.`,
      },
      template_id: {
        type: ['string', 'null'],
        enum: [...templateChoices, null],
        description: 'REQUIRED whenever tool is create_subfolder (ignored otherwise) — pick from the template catalog.',
      },
      name: { type: ['string', 'null'], description: 'Display name for a new folder (create_subfolder).' },
      slug: { type: ['string', 'null'], description: '#slug for a new folder; auto-generated if omitted (create_subfolder).' },
      description: { type: ['string', 'null'], description: "What a new folder is for, in your own words (create_subfolder) — outranks the router's inference." },
      reply: { type: 'string', description: 'Your message to the user, plain words. REQUIRED when tool is "none".' },
    },
    required: ['thought', 'tool', 'subgraph'],
  };
}

function renderFolders(folders: AddSourceFolder[]): string {
  if (folders.length === 0) return '(none yet — this workspace has no folders beyond the default.)';
  return folders.map((f) => `- ${f.slug} (id ${f.id}): ${f.description?.trim() || 'no description'}`).join('\n');
}

function renderTemplates(templates: AddSourceTemplate[]): string {
  return templates.map((t) => `- ${t.id} (${t.name}): ${t.description}`).join('\n');
}

function composeUserMessage(params: AddSourceAgentParams): string {
  const sections = [
    `## Instructions from the user\n${params.instructions}`,
    `## Document to process (source_kind: ${params.source_kind}${params.source_ref ? `, ref: ${params.source_ref}` : ''})\n${params.source}`,
  ];
  if (params.forcedSubgraph) {
    // No folder catalog/templates when the destination is already fixed —
    // there's nothing left to choose or create, and showing them would just
    // invite the model to second-guess a decision it doesn't own.
    sections.push('## Destination\nAlready decided by the caller — do not choose or create a folder. Focus only on what to keep.');
  } else {
    sections.push(`## Folders already in this workspace\n${renderFolders(params.folders)}`);
    sections.push(`## Templates available for a new folder\n${renderTemplates(params.templates)}`);
  }
  return sections.join('\n\n');
}

export async function runAddSourceAgent(
  params: AddSourceAgentParams,
  /** Test seam only — production callers never pass this (see runSurfaceAgent). */
  createMessage?: CreateMessage,
): Promise<SurfaceAgentResult> {
  // See MAX_CLEANUP_SOURCE_CHARS: bail out before spending a model call on a
  // document too large to safely clean in one turn. Callers are expected to
  // catch this and fall back to filing the document uncleaned.
  if (params.source.length > MAX_CLEANUP_SOURCE_CHARS) {
    throw new Error(
      `document too large for instructions-driven cleanup (${params.source.length} chars, max ${MAX_CLEANUP_SOURCE_CHARS})`,
    );
  }
  // With a forced destination there's nothing to create, so create_subfolder
  // never enters the catalog — one fewer tool the model could reach for.
  const allowedToolNames = params.forcedSubgraph ? TOOL_NAMES.filter((n) => n !== 'create_subfolder') : TOOL_NAMES;
  const tools = params.tools
    .filter((t) => allowedToolNames.includes(t.name))
    .map((t) => (t.name === 'ingest_document' ? wrapIngestDocument(t, params.source, params.audience, params.forcedSubgraph) : t));
  return runSurfaceAgent(
    {
      tools,
      ctx: params.ctx,
      history: [],
      user_message: composeUserMessage(params),
      pending_action: null,
      systemPrompt: ADD_SOURCE_AGENT_PROMPT,
      promptTask: 'add-source-agent',
      promptVersion: ADD_SOURCE_AGENT_PROMPT_VERSION,
      maxTokens: MAX_TOKENS,
      model: MODEL,
      buildStepSchema: (tools, receipts) => buildStepSchema(tools, receipts, params.folders, params.templates),
    },
    createMessage,
  );
}
