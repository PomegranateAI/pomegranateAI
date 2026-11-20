import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { promptMeta, loadPromptBody, structuredCall, usingLocalLLM } from '../../lib/anthropic.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { log } from '../../lib/log.js';
import { ToolError } from '../mcp/errors.js';
import { toolJsonSchema, type ToolCtx, type ToolDef } from '../mcp/registry.js';

/**
 * The surface agent — the LLM brain behind chat surfaces (Slack today).
 *
 * One loop, the MCP tool catalog. The tools are EXACTLY the registry
 * ToolDefs the MCP transports serve (createTools output), executed in-process
 * with a server-resolved ToolCtx — so a Slack user and a claude.ai connector
 * get identical capability, authorization (membership-gated folder
 * targeting), auditing, and visibility semantics by construction.
 *
 * Tools execute on first call — there is no confirm-first gate. The agent
 * infers the right tool and acts; every action is audited and (for the
 * additive flows) reviewable/revertible downstream, so the model reports what
 * it did rather than asking permission first. Registry-level authorization and
 * visibility are still enforced on every call.
 *
 * Stateless like the curation agent: the route provides history and the agent
 * returns the receipts of what ran.
 */

const MODEL = process.env.SURFACE_AGENT_MODEL ?? process.env.CURATOR_MODEL ?? 'claude-sonnet-4-6';
const MAX_STEPS = Number(process.env.SURFACE_AGENT_MAX_STEPS ?? 8);
// Chat replies are normally short, but a "show me everything" reply enumerating
// a full folder's items needs real headroom — 1500 truncated mid-JSON on a
// 24-item listing (2026-07-26 incident, hosted Qwen "unbalanced JSON"), and
// 4000 still wasn't enough for a multi-clause question that made the hosted
// model ramble past its "one short line" instruction in `thought` before
// ever reaching `tool`/`reply` (2026-08-08 incident, same failure mode).
const MAX_TOKENS = Number(process.env.SURFACE_AGENT_MAX_TOKENS ?? 8000);
const HISTORY_CHAR_BUDGET = 12_000;
const TOOL_RESULT_CHAR_BUDGET = 20_000;

/** The Slack/chat surface's own prompt — the loop itself is generic over any
 *  task's prompt (see SurfaceAgentParams.systemPrompt); other callers (e.g.
 *  the add-source agent) load and pass their own. */
export const SURFACE_AGENT_PROMPT = loadPromptBody('surface-agent');
export const SURFACE_AGENT_PROMPT_VERSION = promptMeta('surface-agent').version;

/** Retained for the agent_threads column / route contract; no longer armed. */
export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  summary?: string;
  created_at: string;
}

export interface SurfaceAgentParams {
  /** The MCP registry tools (createTools output) — the whole catalog, or a
   *  task-specific subset (e.g. the add-source agent only gets ingest_document
   *  + create_subfolder). */
  tools: ToolDef[];
  /** Resolved identity + effective folder for this turn. */
  ctx: ToolCtx;
  history: Array<{ role: string; body: string }>;
  user_message: string;
  /** Vestigial: the thread once carried a pending action; nothing arms one now. */
  pending_action?: PendingAction | null;
  /** Display context rendered into the first user block. */
  folder_name?: string;
  user_label?: string;
  /** The user's chosen wake name for this assistant on chat surfaces. */
  assistant_nickname?: string;
  /** The folder's active subfolders, so a named one ("subfolder Warda") can be
   *  passed as ingest_document's `subgraph` instead of left to the router. */
  subfolders?: Array<{ id: string; slug: string; name: string }>;
  /** The task's system prompt body (loadPromptBody('<task>')). */
  systemPrompt: string;
  /** LLM-log task tag for this call (e.g. 'surface-agent', 'add-source-agent'). */
  promptTask: string;
  /** LLM-log prompt version, from the prompt file's frontmatter. */
  promptVersion: number | undefined;
  /** Output token budget — chat replies are short; document transforms need more room. */
  maxTokens?: number;
  /**
   * Overrides the module-wide MODEL default (SURFACE_AGENT_MODEL/CURATOR_MODEL
   * env var, else 'claude-sonnet-4-6') for this call only. For a high-output,
   * low-reasoning task — retype/clean a document, not open-ended chat
   * reasoning — a cheaper, higher-throughput model can be both faster and
   * correct: add-source-agent sets this to Haiku 4.5 (see its own comment)
   * after the default Sonnet-tier model's lower output-token throughput
   * turned a ~4000-token document transform into a reliable timeout (observed
   * 2026-08-19, ~120-180s per attempt, 100% failure rate) — the exact same
   * class of work (classify/route/propose-folder on comparably large page
   * text) already runs on Haiku 4.5 elsewhere in this codebase in 1-3s. Leave
   * unset to keep the shared default (e.g. the Slack surface agent, which may
   * genuinely benefit from a heavier model for open-ended chat turns).
   */
  model?: string;
  /**
   * Structured mode ONLY (runSurfaceAgentStructured) — override the generic
   * registry-wide per-step schema (stepSchemaFor) with one built for this
   * task's own narrower decision space. Called fresh every step with the
   * receipts so far, so it can tighten choices as the run progresses (e.g.
   * a field's enum growing to include a folder id create_subfolder just
   * returned). Native tool-use mode ignores this — it already builds a real
   * per-tool schema from each tool's own inputShape.
   */
  buildStepSchema?: (tools: ToolDef[], receipts: SurfaceAgentResult['receipts']) => Record<string, unknown>;
}

export interface SurfaceAgentResult {
  message: string;
  receipts: Array<{ tool: string; args: Record<string, unknown>; result: Record<string, unknown>; ok: boolean }>;
  /** Always null — confirm-first was removed; kept for the route/thread shape. */
  pending_action: PendingAction | null;
}

/** Injectable model call — tests script the conversation without the API. */
export type CreateMessage = (req: {
  model: string;
  max_tokens: number;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}) => Promise<Anthropic.Message>;

let _client: Anthropic | null = null;
function defaultCreateMessage(): CreateMessage {
  // Native fetch over the SDK's vendored shim — see lib/anthropic.ts
  // (Node 22.23+ "Premature close").
  //
  // maxRetries explicitly capped at 1 (SDK default is 2 → up to 3 attempts):
  // a hung/timing-out request retried against the same congested backend
  // just repeats the hang, so the uncapped default turned one stuck call
  // into a ~180s wait (60s timeout × 3 attempts) — observed 2026-08-19 on
  // an add-source-agent call (see llm.log latency_ms:181292, error:"Request
  // timed out."). One retry bounds the worst case to ~120s instead, and
  // callers that can't afford even that (e.g. runInstructedIngest) fall back
  // to a plain ingest rather than block the caller on it — see
  // registry.ts's ingest_document handler.
  if (!_client) _client = new Anthropic({ timeout: 60_000, maxRetries: 1, fetch: (...args) => globalThis.fetch(...args) });
  return (req) => _client!.messages.create(req);
}

function isMutating(tool: ToolDef): boolean {
  return tool.annotations.readOnlyHint !== true;
}

/** Keys kept on a mutating tool's receipt — broad enough to cover every tool
 *  in the catalog (approve/reject flows, routing, ingestion, folder creation)
 *  so a caller can tell what actually happened (which folder, which document)
 *  without re-deriving it. */
const RECEIPT_KEYS = [
  'ok',
  'approved',
  'rejected',
  'reverted',
  'candidates',
  'error',
  'status',
  'node_id',
  'superseded_node_id',
  'rule',
  'document_id',
  'filed_to',
  'subgraph_id',
  'routed',
  'dropped',
  'pending_approval',
  'pending_route_id',
  'pending_route',
  'zero_yield',
  'slug',
  'name',
  'template_id',
];

function renderContext(params: SurfaceAgentParams): string {
  const parts: string[] = [];
  parts.push(
    `## Where you are\nDirectory: ${params.folder_name ?? params.ctx.ws}\nUser: ${params.user_label ?? params.ctx.user_id}` +
      (params.assistant_nickname
        ? `\nYour name on this surface: ${params.assistant_nickname}. Treat that name as a direct address to you, not as a person or directory.`
        : '') +
      (params.subfolders && params.subfolders.length > 0
        ? `\nFolders: ${params.subfolders.map((s) => `${s.name} (subgraph: "${s.slug}")`).join(', ')}`
        : ''),
  );
  if (params.history.length > 0) {
    const lines = params.history.map((m) => `${m.role === 'agent' ? 'You' : m.role === 'user' ? 'User' : '·'}: ${m.body ?? ''}`);
    parts.push('## Conversation so far\n' + lines.join('\n').slice(-HISTORY_CHAR_BUDGET));
  }
  if (params.pending_action) {
    parts.push(
      '## Unresolved decision from the previous turn\n' +
        `Tool: ${params.pending_action.tool}\n` +
        `Arguments: ${JSON.stringify(params.pending_action.args)}\n` +
        (params.pending_action.summary ? `Question already asked: ${params.pending_action.summary}\n` : '') +
        'Resolve this decision from the user\'s answer. Do not ingest the source again. For a pending route, call approve_route, choose_route, or reject_route with the stored id.',
    );
  }
  parts.push("## The user's message (this turn)\n" + params.user_message);
  return parts.join('\n\n');
}

/**
 * Execute one registry tool with transport-grade arg validation, mapping
 * ToolError into an observation object instead of a throw (the model reacts
 * conversationally, same contract as the MCP transports).
 */
export async function executeRegistryTool(
  tools: ToolDef[],
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<{ outcome: Record<string, unknown>; ok: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { outcome: { error: 'unknown_tool', tool: name }, ok: false };
  const parsed = z.object(tool.inputShape).safeParse(rawArgs);
  if (!parsed.success) {
    return { outcome: { error: 'invalid', detail: parsed.error.issues.map((i) => i.message).join('; ') }, ok: false };
  }
  try {
    const result = await tool.handler(parsed.data, ctx);
    const outcome = (result && typeof result === 'object' ? result : { result }) as Record<string, unknown>;
    return { outcome, ok: !('error' in outcome) };
  } catch (err) {
    if (err instanceof ToolError) return { outcome: err.body(), ok: false };
    throw err;
  }
}

export async function runSurfaceAgent(
  params: SurfaceAgentParams,
  createMessage?: CreateMessage,
): Promise<SurfaceAgentResult> {
  if (!createMessage) {
    // Provider selection: when a structured-output override is installed
    // (hosted Together/Qwen, or a local model) the loop
    // runs through THAT seam — one grammar-constrained step per turn, the
    // curation agent's local pattern. Otherwise the native Anthropic
    // tool-use loop (needs a key); neither → explicit 501, which the route
    // maps to a friendly reply.
    if (usingLocalLLM()) return runSurfaceAgentStructured(params);
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ToolError('not_supported', 501, {
        detail: 'the surface agent requires an LLM provider (structured override or Anthropic key)',
      });
    }
    createMessage = defaultCreateMessage();
  }

  const model = params.model ?? MODEL;
  const anthropicTools: Anthropic.Tool[] = params.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toolJsonSchema(t) as Anthropic.Tool.InputSchema,
  }));

  const receipts: SurfaceAgentResult['receipts'] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: renderContext(params) },
  ];
  const maxTokens = params.maxTokens ?? MAX_TOKENS;
  let finalText = '';
  let exhausted = true;
  for (let step = 0; step < MAX_STEPS; step++) {
    const t0 = Date.now();
    let response: Anthropic.Message;
    try {
      response = await createMessage({
        model,
        max_tokens: maxTokens,
        system: params.systemPrompt,
        tools: anthropicTools,
        messages,
      });
    } catch (err) {
      writeLlmCall({
        ...getLlmContext(),
        task: params.promptTask,
        model,
        prompt_version: params.promptVersion,
        input: { step, history_messages: messages.length },
        output: null,
        latency_ms: Date.now() - t0,
        error: (err as Error).message?.slice(0, 300),
      });
      throw err;
    }
    writeLlmCall({
      ...getLlmContext(),
      task: params.promptTask,
      model,
      prompt_version: params.promptVersion,
      input: { step, history_messages: messages.length, stop_reason: response.stop_reason },
      output: { blocks: response.content.map((b) => b.type) },
      tokens: {
        input: response.usage?.input_tokens,
        cache_read: (response.usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens,
        cache_write: (response.usage as { cache_creation_input_tokens?: number })?.cache_creation_input_tokens,
        output: response.usage?.output_tokens,
      },
      latency_ms: Date.now() - t0,
    });

    const textParts = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text);
    if (textParts.length > 0) finalText = textParts.join('\n\n').trim();
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      exhausted = false;
      break;
    }
    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const tool = params.tools.find((t) => t.name === tu.name);

      // Tools execute on first call — no confirm-first gate. The result rides
      // back as an observation; mutating calls also record a receipt.
      const { outcome, ok } = await executeRegistryTool(params.tools, tu.name, input, params.ctx);
      if (tool && isMutating(tool)) {
        receipts.push({
          tool: tu.name,
          args: input,
          result: Object.fromEntries(Object.entries(outcome).filter(([k]) => RECEIPT_KEYS.includes(k))),
          ok,
        });
      }
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(outcome).slice(0, TOOL_RESULT_CHAR_BUDGET),
        is_error: !ok,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  if (exhausted) {
    finalText =
      finalText ||
      'I hit my step limit before finishing — the actions taken so far are recorded above. Tell me how to continue.';
  }
  if (!finalText) {
    finalText = receipts.length > 0 ? 'Done.' : "I couldn't produce a reply — try rephrasing.";
  }
  log.info('surface.agent_run', {
    workspace: params.ctx.ws,
    user: params.ctx.user_id,
    receipts: receipts.length,
  });
  return { message: finalText, receipts, pending_action: null };
}

// ---- structured-per-turn variant (the hosted Together / local Qwen seam) ----
//
// The structured-output override can't express Anthropic native multi-turn
// tool_use, so when it's installed the agent runs the curation agent's local
// pattern: each step is ONE grammar-constrained `surface_step` object — pick
// one tool (or finish) with FLAT argument fields — executed through the same
// registry handlers, with the result fed back as a text observation. Same
// execute-on-first-call behaviour and receipts as the native loop; the only
// difference is one-action-per-turn, which small hosted/local models handle
// far more reliably than parallel tool blocks.

/** Flat argument fields a step may set; mapped onto the chosen tool's own
 *  inputShape keys (extras dropped, then zod-validated like any transport). */
const STEP_ARG_FIELDS: Record<string, unknown> = {
  question: { type: ['string', 'null'], description: 'Question text (query_context, test_rule use-mode).' },
  scope: { type: ['string', 'null'], description: "Scope key (query_context/get_context); default 'all'." },
  subgraph: { type: ['string', 'null'], description: 'Folder slug or id.' },
  folder: { type: ['string', 'null'], description: 'Target directory reference (id, name, teammate email/@handle/display name).' },
  content: { type: ['string', 'null'], description: 'Draft text (review_deliverable).' },
  kind: { type: ['string', 'null'], description: 'Deliverable kind (review_deliverable).' },
  source: { type: ['string', 'null'], description: 'Source text (ingest_document).' },
  source_kind: { type: ['string', 'null'], description: "One of doc|slack|transcript|interaction." },
  source_ref: { type: ['string', 'null'], description: 'Source name/reference.' },
  audience: { type: ['string', 'null'], description: "team|private|only_me (ingest/accept_source)." },
  document_id: { type: ['string', 'null'], description: "Document id, or 'loose'." },
  note: { type: ['string', 'null'], description: 'One-line reason (accept/reject/revert).' },
  id: { type: ['string', 'null'], description: 'Candidate, rule, or node id (approve/reject_candidate, delete/test/upsert_rule, update_node, update_attribute).' },
  attribute: { type: ['string', 'null'], description: "The attrs key to set (update_attribute), e.g. 'status'." },
  value: { type: ['string', 'number', 'boolean', 'null'], description: 'The value to set it to (update_attribute).' },
  item_ids: { type: 'array', items: { type: 'string' }, description: 'Candidate ids (accept/reject/revert_items).' },
  ids: { type: 'array', items: { type: 'string' }, description: 'Specific node ids to retrieve (get_context) — from a prior index/search/citation.' },
  query: { type: ['string', 'null'], description: 'Free-text search query (search_context).' },
  question_id: { type: ['string', 'null'], description: 'Open-question id (answer_question).' },
  answer: { type: ['string', 'null'], description: 'Chosen answer (answer_question).' },
  status: { type: ['string', 'null'], description: 'pending|approved|rejected (list_candidates).' },
  limit: { type: ['number', 'null'], description: 'Max items/nodes to return (list_candidates, get_context, search_context).' },
  since: { type: ['string', 'null'], description: 'Only items/nodes on or after this ISO date (list_recent_changes, get_context).' },
  until: { type: ['string', 'null'], description: 'Only nodes created on or before this ISO date (get_context) — page a large directory by passing the oldest `created_at` from the previous call.' },
  sort: { type: ['string', 'null'], description: "newest|oldest — order by creation date instead of relevance (get_context)." },
  mode: { type: ['string', 'null'], description: "full|index — 'index' returns one compact line per node instead of full content (get_context)." },
  include_superseded: { type: ['boolean', 'null'], description: 'Also return archived/superseded nodes, not just the current statement on each topic (get_context, search_context). Default false.' },
  instructions: { type: ['string', 'null'], description: 'Rule instructions in plain language (upsert_rule).' },
  scopes: { type: 'array', items: { type: 'string' }, description: 'Rule visibility tiers (upsert_rule).' },
  enabled: { type: ['boolean', 'null'], description: 'Rule enabled flag (upsert_rule).' },
  sort_order: { type: ['number', 'null'], description: 'Rule precedence (upsert_rule).' },
  text: { type: ['string', 'null'], description: 'Sample text (test_rule).' },
  surface: { type: ['string', 'null'], description: "all|slack|mcp|whatsapp (set_default_folder)." },
  template_id: { type: ['string', 'null'], description: 'Template id from list_templates (create_subfolder).' },
  name: { type: ['string', 'null'], description: 'Display name (create_subfolder).' },
  slug: { type: ['string', 'null'], description: '#slug for the new folder (create_subfolder); auto-generated if omitted.' },
  description: { type: ['string', 'null'], description: "What the new folder is for, in your own words (create_subfolder) — outranks the router's inference." },
};

function stepSchemaFor(tools: ToolDef[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'One short line: what you are doing this turn and why.' },
      tool: {
        type: 'string',
        enum: [...tools.map((t) => t.name), 'none'],
        description: "The single tool to run this turn, or 'none' when you are done and just replying.",
      },
      ...STEP_ARG_FIELDS,
      reply: { type: 'string', description: 'Your message to the user, plain words. REQUIRED when tool is "none".' },
    },
    required: ['thought', 'tool'],
  };
}

/** Compact tool catalog for the structured protocol (descriptions truncated). */
function renderToolCatalog(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const args = Object.keys(t.inputShape).join(', ') || '(no args)';
      const desc = t.description.replace(/\s+/g, ' ').slice(0, 140);
      return `- ${t.name} — ${desc} [args: ${args}]`;
    })
    .join('\n');
}

function structuredProtocol(tools: ToolDef[]): string {
  return `# How to act (structured mode — one step at a time)

You do NOT call tools directly. Each turn you emit ONE \`surface_step\` object. The system runs the tool you chose, shows you the result, then asks you again — repeat until you finish with \`tool\`:"none" and a \`reply\`.

Each turn set \`thought\`, \`tool\`, the flat argument fields that tool needs (see the catalog — field names match the tool's args), and \`reply\` when finishing. Every Voice and Ground rule above still applies. Tools run as soon as you emit them — act on what the user asked, then report what you did in \`reply\`.

## Tool catalog
${renderToolCatalog(tools)}`;
}

interface SurfaceStep extends Record<string, unknown> {
  thought?: string;
  tool?: string;
  reply?: string;
}

export async function runSurfaceAgentStructured(
  params: SurfaceAgentParams,
): Promise<SurfaceAgentResult> {
  const system = `${params.systemPrompt}\n\n${structuredProtocol(params.tools)}`;
  const baseContext = renderContext(params);
  const maxTokens = params.maxTokens ?? MAX_TOKENS;
  const model = params.model ?? MODEL;
  const observations: string[] = [];
  const receipts: SurfaceAgentResult['receipts'] = [];
  let finalText = '';
  let exhausted = true;

  for (let step = 0; step < MAX_STEPS; step++) {
    const user =
      observations.length === 0
        ? baseContext
        : `${baseContext}\n\n## Actions you've already taken this turn\n${observations
            .join('\n')
            .slice(-TOOL_RESULT_CHAR_BUDGET)}`;
    // Recomputed every step (not hoisted above the loop) so a caller-supplied
    // builder can react to what's happened so far this run — e.g. the add-
    // source agent adds a just-created folder's id to a field's valid enum
    // once create_subfolder has actually returned it.
    const schema = params.buildStepSchema ? params.buildStepSchema(params.tools, receipts) : stepSchemaFor(params.tools);
    const t0 = Date.now();
    let res;
    try {
      res = await structuredCall({
        model,
        system,
        user,
        toolName: 'surface_step',
        toolDescription: 'Emit your single decision for this step of the conversation.',
        schema,
        maxTokens,
        task: params.promptTask,
      });
    } catch (err) {
      writeLlmCall({
        ...getLlmContext(),
        task: params.promptTask,
        model: `structured:${model}`,
        prompt_version: params.promptVersion,
        input: { step, observations: observations.length, mode: 'structured' },
        output: null,
        latency_ms: Date.now() - t0,
        error: (err as Error).message?.slice(0, 300),
      });
      throw err;
    }
    const decision = (res.output ?? {}) as SurfaceStep;
    writeLlmCall({
      ...getLlmContext(),
      task: params.promptTask,
      model: res.modelLabel,
      prompt_version: params.promptVersion,
      input: { step, observations: observations.length, mode: 'structured' },
      output: { tool: decision.tool ?? null, has_reply: typeof decision.reply === 'string' && decision.reply.trim().length > 0 },
      tokens: res.tokens,
      latency_ms: res.latency_ms,
    });

    if (typeof decision.reply === 'string' && decision.reply.trim()) finalText = decision.reply.trim();

    const toolName = decision.tool;
    const tool = toolName && toolName !== 'none' ? params.tools.find((t) => t.name === toolName) : undefined;
    if (!tool) {
      // 'none', missing, or unknown tool → final turn.
      exhausted = false;
      break;
    }

    // Project the step's flat fields onto the tool's own argument names.
    const args: Record<string, unknown> = {};
    for (const key of Object.keys(tool.inputShape)) {
      const v = decision[key];
      if (v !== undefined && v !== null && v !== '') args[key] = v;
    }

    // Tools execute on first emit — no confirm-first gate.
    const { outcome, ok } = await executeRegistryTool(params.tools, tool.name, args, params.ctx);
    if (isMutating(tool)) {
      receipts.push({
        tool: tool.name,
        args,
        result: Object.fromEntries(Object.entries(outcome).filter(([k]) => RECEIPT_KEYS.includes(k))),
        ok,
      });
    }
    observations.push(
      `${tool.name}(${JSON.stringify(args).slice(0, 300)}) -> ${JSON.stringify(outcome).slice(0, 800)}`,
    );
  }

  if (exhausted) {
    finalText =
      finalText ||
      'I hit my step limit before finishing — the actions taken so far are recorded above. Tell me how to continue.';
  }
  if (!finalText) {
    finalText = receipts.length > 0 ? 'Done.' : "I couldn't produce a reply — try rephrasing.";
  }
  log.info('surface.agent_run', {
    workspace: params.ctx.ws,
    user: params.ctx.user_id,
    mode: 'structured',
    receipts: receipts.length,
  });
  return { message: finalText, receipts, pending_action: null };
}
