import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import { log } from './log.js';
import { getLlmContext } from './llm-context.js';
import { writeLlmCall } from './llm-log.js';
import {
  embeddingTextForNode,
  type Embedder,
} from './embeddings.js';
import { FALLBACK_PROFILE } from './profiles/index.js';
import {
  renderPrompt,
  captureSlots,
  feedbackSlots,
  querySlots,
  docTriageSlots,
  resolveSourceGuidance,
} from './prompt-render.js';
import {
  CapturePayload,
  ProfileCapturePayload,
  Candidate as CandidateSchema,
  ProfileCandidate as ProfileCandidateSchema,
  DocumentRoute,
  MergeVerdicts,
  FeedbackPayload,
  GroupingPayload,
  OverviewPayload,
  UsageAnalysisPayload,
  WorkAgentPayload,
  QueryPayload,
  QueryHybridPayload,
  TriageResult,
  DocTriagePayload,
  type Candidate,
  type CandidateGroup,
  type ContextProfile,
  type DocTriageDossier,
  type DocTriagePayload as DocTriagePayloadT,
  type DocTriageSlimCandidate,
  type Finding,
  type Node,
  type TriageResult as TriageResultT,
  type DocumentRoute as DocumentRouteT,
  type ProposeNewFolder as ProposeNewFolderT,
  type GraphEdge as GraphEdgeT,
  type UsageAnalysisInput,
} from './schemas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, 'prompts');

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
    // Use the runtime's native fetch instead of the SDK's vendored HTTP shim,
    // which throws "Premature close" on every request under Node 22.23+.
    _client = new Anthropic({ apiKey, fetch: (...args) => globalThis.fetch(...args) });
  }
  return _client;
}

/**
 * Optional structured-output provider override. Default is null → the Anthropic
 * tool-use path below runs unchanged (production is byte-identical). The
 * embedding host can call `setStructuredLLM` at boot to route every
 * structured call through a local llama.cpp model instead — no other engine
 * code changes. The implementation is supplied by the caller and only needs to
 * turn (system, user, schema) into a schema-valid object.
 */
export interface StructuredLLMOverride {
  readonly name?: string;
  readonly supportsImages?: boolean;
  callStructured(opts: {
    model: string;
    system: string;
    user: string;
    images?: Array<{ mime: string; data: string }>;
    toolName: string;
    toolDescription: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
    task: string;
  }): Promise<unknown>;
}

let _structuredOverride: StructuredLLMOverride | null = null;

/** Install (or clear, with null) the local structured-output provider. */
export function setStructuredLLM(o: StructuredLLMOverride | null): void {
  _structuredOverride = o;
}

/**
 * Whether a structured-output LLM is available to call — either the local
 * override is installed (standalone) or an Anthropic key is set (cloud).
 * Feature gates that need an LLM (e.g. the dedup judge) must key off THIS, not
 * ANTHROPIC_API_KEY directly, so they light up in both deployments.
 */
export function hasStructuredLLM(): boolean {
  return _structuredOverride != null || !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Whether the LOCAL structured-output provider is the active backend (the
 * embedding host installed one). Callers that run their own model loop
 * (the curation agent) key off this to pick a local, grammar-friendly path
 * instead of Anthropic native tool-use, which the local provider can't express.
 */
export function usingLocalLLM(): boolean {
  return _structuredOverride != null;
}

export interface StructuredCallResult {
  /** The schema-valid object, or undefined when the Anthropic path returned no tool_use. */
  output: unknown;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  latency_ms: number;
  /** Model label for the caller's llm.log row: `<model>` or `local:<model>`. */
  modelLabel: string;
  local: boolean;
  /** True when the Anthropic response carried no tool_use block (caller falls back). */
  noToolUse: boolean;
}

/**
 * One forced-structured-output call that honors the local provider override.
 * Unlike `callStructured` (which owns its own llm.log row, verbatim handling and
 * no-tool-use error), this is a thin primitive that returns the raw result plus
 * token/latency so callers keeping bespoke llm.log rows — dedup-judge,
 * edge-inference, and the local curation loop — log it themselves. On the local
 * path tokens are 0 and `modelLabel` is `local:<model>`.
 */
export async function structuredCall(opts: {
  model: string;
  system: string;
  user: string;
  images?: Array<{ mime: string; data: string }>;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  task: string;
  /**
   * Heavy, structure-sensitive synthesis (the wiki plan/fill passes) prefers the
   * Anthropic tool-use path even when a local/hosted-Qwen override is installed:
   * Qwen degrades badly on long, grammar-constrained array outputs (it emits a
   * single degenerate block to satisfy the grammar and stops). When an Anthropic
   * key is configured we bypass the override for these calls; with no key we fall
   * back to the override so the standalone/local build still works (best effort).
   */
  preferAnthropic?: boolean;
}): Promise<StructuredCallResult> {
  const override = _structuredOverride;
  if (opts.images?.length && override && !override.supportsImages) throw new Error('image_reader_requires_vision_provider');

  const runOverride = async (o: StructuredLLMOverride): Promise<StructuredCallResult> => {
    const t0 = Date.now();
    const output = await o.callStructured({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      images: opts.images,
      toolName: opts.toolName,
      toolDescription: opts.toolDescription,
      schema: opts.schema,
      maxTokens: opts.maxTokens,
      task: opts.task,
    });
    return {
      output,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      latency_ms: Date.now() - t0,
      modelLabel: `local:${opts.model}`,
      local: true,
      noToolUse: false,
    };
  };

  const runAnthropic = async (): Promise<StructuredCallResult> => {
    const t0 = Date.now();
    const resp = await client().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }] as unknown as string,
      tools: [
        {
          name: opts.toolName,
          description: opts.toolDescription,
          input_schema: opts.schema as Anthropic.Tool.InputSchema,
          cache_control: { type: 'ephemeral' },
        } as unknown as Anthropic.Tool,
      ],
      tool_choice: { type: 'tool', name: opts.toolName },
      messages: [{ role: 'user', content: opts.images?.length
        ? [{ type: 'text', text: opts.user }, ...opts.images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mime as 'image/png' | 'image/jpeg' | 'image/webp', data: image.data } }))]
        : opts.user }],
    });
    const latency_ms = Date.now() - t0;
    const u =
      (resp.usage as unknown as {
        input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
        output_tokens?: number;
      }) ?? {};
    const tokens = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cache_read: u.cache_read_input_tokens ?? 0,
      cache_write: u.cache_creation_input_tokens ?? 0,
    };
    const toolUse = resp.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === opts.toolName,
    );
    return {
      output: toolUse ? toolUse.input : undefined,
      tokens,
      latency_ms,
      modelLabel: opts.model,
      local: false,
      noToolUse: !toolUse,
    };
  };

  // POMEGRANATE_PROVIDER_ONLY=1 (on-prem): every task goes to the
  // provider the customer chose — a stray Anthropic key never pulls the wiki
  // or reports to Anthropic when the customer picked another provider.
  const bypassOverride =
    !!opts.preferAnthropic && !!process.env.ANTHROPIC_API_KEY && process.env.POMEGRANATE_PROVIDER_ONLY !== '1';
  if (override && !bypassOverride) return runOverride(override);
  if (bypassOverride && override) {
    // Preferred-Anthropic path with an override available to catch us: if the
    // Anthropic call fails (exhausted/invalid key, network, premature-close), do
    // NOT hard-fail — degrade to the installed provider (Qwen) so the wiki still
    // renders. Better a lower-quality plan/fill than a 500.
    try {
      return await runAnthropic();
    } catch (err) {
      log.warn('structuredCall.anthropic_failed_override_fallback', {
        task: opts.task,
        msg: (err as Error).message?.slice(0, 200),
      });
      return runOverride(override);
    }
  }
  return runAnthropic();
}

const MODELS = {
  triage: 'claude-haiku-4-5-20251001',
  // Extraction recall is where model quality pays for itself: a 20-minute
  // interview costs far more than the tokens to extract it well. Sonnet 4.6
  // upgrade after a 4.5 extractor missed an explicit willingness-to-pay
  // signal (Dan interview, 2026-06-04).
  capture: 'claude-sonnet-4-6',
  // Gleaning (POMEGRANATE_CAPTURE_GLEAN=1) is a second capture-quality pass, so
  // it uses the capture-tier model.
  glean: 'claude-sonnet-4-6',
  feedback: 'claude-sonnet-4-5-20250929',
  query: 'claude-sonnet-4-5-20250929',
  // Work agents (spec-work-agents.md) produce a finished artifact from the
  // user's OWN graph — a drafting/synthesis task where quality matters; Sonnet.
  workAgent: 'claude-sonnet-4-5-20250929',
  // Grouping is a clustering + summarization task — Sonnet handles it
  // reliably and the prompt explicitly tightens its schema. Haiku is too
  // loose on the "every id appears exactly once" coverage invariant.
  grouping: 'claude-sonnet-4-5-20250929',
  // The dashboard overview is the "we understand your library" moment —
  // quality over cost, and it's cached by graph hash so it runs rarely.
  overview: 'claude-sonnet-4-5-20250929',
  // Usage analysis is the owner's "what is my context doing for the team"
  // moment — same quality-over-cost call as overview, cached by usage state.
  usage_analysis: 'claude-sonnet-4-5-20250929',
  // Doc triage decides whether a whole document can skip item review —
  // question quality is the feature's biggest risk (spec §13), so Sonnet,
  // and it's cached per (document, pending-set signature) so it runs rarely.
  doc_triage: 'claude-sonnet-4-5-20250929',
} as const;

export interface PromptMeta {
  name: string;
  purpose?: string;
  inputs?: string[];
  output_schema?: string;
  model?: string;
  version?: number;
}

/**
 * Prompts live as markdown with YAML frontmatter under lib/prompts/<name>.md.
 * The frontmatter documents the call (purpose, inputs, output schema, model,
 * version); the body is the system prompt sent to the model. The runtime
 * uses only the body; the metadata is exposed for the LLM-call log so
 * `prompt_version` lands in every record. See
 * docs/llm-calls.md.
 */
function loadPromptFile(name: string): { body: string; meta: PromptMeta } {
  const raw = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), 'utf8');
  const parsed = matter(raw);
  return {
    body: parsed.content.trim(),
    meta: { name, ...(parsed.data as Omit<PromptMeta, 'name'>) },
  };
}

function loadPrompt(name: string): string {
  return loadPromptFile(name).body;
}

export function promptMeta(name: string): PromptMeta {
  return loadPromptFile(name).meta;
}

/** Prompt body for callers that run their own model loop (curation agent). */
export function loadPromptBody(name: string): string {
  return loadPrompt(name);
}

/**
 * Force the model to emit structured output via tool-use. The schema parameter
 * defines the shape; the model returns it as tool_use input which Anthropic
 * validates against the schema for us — no fragile regex JSON extraction.
 */
async function callStructured(opts: {
  model: string;
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** The task name (matches a prompts/*.md file). Used for the LLM log. */
  task: string;
  /** Version of the prompt (from its frontmatter). Used for the LLM log. */
  promptVersion?: number;
  /** Structured summary of the user message for the LLM log. NEVER the verbatim text. */
  inputSummary?: Record<string, unknown>;
}): Promise<unknown> {
  // Local-provider override (installed by an embedding host). Runs the same call shape
  // against an in-process model and still writes the LLM-call log so the audit
  // trail is consistent. Token counts are zero locally (no metered usage).
  if (_structuredOverride) {
    const t0o = Date.now();
    const ctx = getLlmContext();
    try {
      const output = await _structuredOverride.callStructured({
        model: opts.model,
        system: opts.system,
        user: opts.user,
        toolName: opts.toolName,
        toolDescription: opts.toolDescription,
        schema: opts.schema,
        maxTokens: opts.maxTokens,
        task: opts.task,
      });
      const latency_ms = Date.now() - t0o;
      // Same operational line the cloud path emits, so on-device inference is
      // visible in app.log identically (tokens are 0 — no metered usage).
      log.info('synth.call', {
        tool: opts.toolName,
        task: opts.task,
        model: `local:${opts.model}`,
        ms: latency_ms,
        input_tokens: 0,
        cache_write: 0,
        cache_read: 0,
        output_tokens: 0,
      });
      writeLlmCall({
        task: opts.task,
        caller: ctx.caller,
        workspace_id: ctx.workspace_id,
        user_id: ctx.user_id,
        mcp_token_id: ctx.mcp_token_id,
        model: `local:${opts.model}`,
        prompt_version: opts.promptVersion,
        context: ctx.context,
        input: opts.inputSummary,
        output,
        tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
        latency_ms,
      });
      return output;
    } catch (err) {
      writeLlmCall({
        task: opts.task,
        caller: ctx.caller,
        workspace_id: ctx.workspace_id,
        user_id: ctx.user_id,
        mcp_token_id: ctx.mcp_token_id,
        model: `local:${opts.model}`,
        prompt_version: opts.promptVersion,
        context: ctx.context,
        input: opts.inputSummary,
        output: null,
        tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
        latency_ms: Date.now() - t0o,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  // Ephemeral prompt cache on the system block. The capture/feedback/query
  // prompts are large (~2-4K tokens each) and identical across calls; caching
  // means subsequent calls within the 5-min TTL cost ~10% of the normal input rate
  // for those tokens. The tools array also gets a cache breakpoint so the
  // schema doesn't re-bill on every call. See:
  //   https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  // `cache_control` is accepted by the Anthropic API but the SDK types in
  // 0.30.1 predate the GA of prompt caching. Cast the create args to bypass
  // the stale type without losing strictness elsewhere.
  const t0 = Date.now();
  const resp = await client().messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: [
      {
        type: 'text',
        text: opts.system,
        cache_control: { type: 'ephemeral' },
      },
    ] as unknown as string,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: opts.schema as Anthropic.Tool.InputSchema,
        cache_control: { type: 'ephemeral' },
      } as unknown as Anthropic.Tool,
    ],
    tool_choice: { type: 'tool', name: opts.toolName },
    messages: [{ role: 'user', content: opts.user }],
  });
  // Pull cache + token stats once so we can log both to the server log
  // (for grep-friendly observability) and to the dedicated LLM-call log
  // (for who/what/why auditability per the conventions doc).
  const latency_ms = Date.now() - t0;
  const u =
    (resp.usage as unknown as {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    }) ?? {};
  const tokens = {
    input: u.input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };

  // Testing aid: when POMEGRANATE_LLM_LOG_VERBATIM=1, attach the full prompt
  // (system + user, exactly as sent) to the LLM-log entry. OFF by default —
  // this writes verbatim user content (deliverables/questions/graph) to disk,
  // which the standard convention deliberately avoids. Local testing only.
  const verbatim =
    process.env.POMEGRANATE_LLM_LOG_VERBATIM === '1'
      ? { system: opts.system, user: opts.user }
      : undefined;

  log.info('synth.call', {
    tool: opts.toolName,
    task: opts.task,
    model: opts.model,
    ms: latency_ms,
    input_tokens: tokens.input,
    cache_write: tokens.cache_write,
    cache_read: tokens.cache_read,
    output_tokens: tokens.output,
  });

  const toolUse = resp.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === opts.toolName,
  );
  if (!toolUse) {
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const errMsg = `No tool_use in response: ${text.slice(0, 400)}`;
    const ctx = getLlmContext();
    writeLlmCall({
      task: opts.task,
      caller: ctx.caller,
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      mcp_token_id: ctx.mcp_token_id,
      model: opts.model,
      prompt_version: opts.promptVersion,
      context: ctx.context,
      input: opts.inputSummary,
      prompt: verbatim,
      output: null,
      tokens,
      latency_ms,
      error: errMsg,
    });
    throw new Error(errMsg);
  }

  const output = toolUse.input;
  const ctx = getLlmContext();
  writeLlmCall({
    task: opts.task,
    caller: ctx.caller,
    workspace_id: ctx.workspace_id,
    user_id: ctx.user_id,
    mcp_token_id: ctx.mcp_token_id,
    model: opts.model,
    prompt_version: opts.promptVersion,
    context: ctx.context,
    input: opts.inputSummary,
    prompt: verbatim,
    output,
    tokens,
    latency_ms,
  });
  return output;
}

// ---- Header-aware chunking ----

/**
 * Default soft cap on a single chunk's character length. Sized to leave
 * comfortable headroom inside Sonnet 4.5's input window once you add the
 * system prompt + graph + schema + the model's own emit budget.
 */
// Default capture chunk size. Configurable so a deployment with a small model
// context window (the local llama.cpp build, ~8K tokens) can shrink it; the
// cloud (200K context) keeps the 8000-char default. ~8000 chars ≈ 2K tokens.
const DEFAULT_CHUNK_CHARS = Number(process.env.POMEGRANATE_CHUNK_CHARS) || 8000;

/**
 * Split a markdown / plain-text document into chunks whose boundaries fall
 * on section headers (`#`, `##`, `###`) wherever possible.
 *
 * Rules:
 *   - Sections that fit under `maxChars` are emitted as one chunk.
 *   - Sections larger than `maxChars` are sliced at paragraph breaks (and
 *     finally at hard char limits) so no chunk ever exceeds the budget.
 *   - Documents with no headers fall back to paragraph-aware sliding-window
 *     chunking with overlap to preserve cross-paragraph context.
 *   - A document shorter than `maxChars` returns a single chunk (no split).
 *
 * Exported for testing.
 */
export function chunkMarkdown(source: string, maxChars = DEFAULT_CHUNK_CHARS): string[] {
  if (source.length <= maxChars) return [source];

  const headerRegex = /^(#{1,3})\s+/gm;
  const headerPositions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(source))) headerPositions.push(m.index);

  // No headers → paragraph-aware sliding window with 200-char overlap.
  if (headerPositions.length === 0) {
    return slidingWindow(source, maxChars, 200);
  }

  // Build header-bounded sections.
  const sections: string[] = [];
  for (let i = 0; i < headerPositions.length; i++) {
    const start = headerPositions[i]!;
    const end = i + 1 < headerPositions.length ? headerPositions[i + 1]! : source.length;
    sections.push(source.slice(start, end));
  }
  // Prepend any preamble text before the first header.
  if (headerPositions[0]! > 0) {
    sections.unshift(source.slice(0, headerPositions[0]!));
  }

  // Pack consecutive small sections together; split sections that are still
  // bigger than the budget on paragraph breaks.
  const out: string[] = [];
  let buf = '';
  for (const sec of sections) {
    if (sec.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      for (const piece of slidingWindow(sec, maxChars, 200)) out.push(piece);
      continue;
    }
    if (buf.length + sec.length > maxChars) {
      out.push(buf);
      buf = sec;
    } else {
      buf += sec;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function slidingWindow(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    // Prefer to cut at a paragraph break (double newline) within the last
    // 20% of the window so we don't slice a sentence in half.
    if (end < text.length) {
      const tail = text.lastIndexOf('\n\n', end);
      if (tail > start + Math.floor(maxChars * 0.8)) end = tail;
    }
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

// ---- Schemas (JSON Schema for tool input_schema) ----
// Kept loose so the model can fill optional fields; we re-validate via Zod.

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    reason: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['relevant', 'reason', 'confidence'],
} as const;

// Kept profile-flexible: `type` carries the profile kind key, and the
// kind-specific classifiers (`kind`/`subkind`/`category`) are free strings
// validated downstream against the workspace profile rather than hard-enumed
// here. The founding kind names (goal/positioning/decision) and their
// classifiers still pass cleanly; this just stops the tool schema from
// rejecting non-founding profile kinds.
const PROPOSED_NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    status: { type: 'string', enum: ['active', 'archived'] },
    source: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    body: { type: 'string' },
    priority: { type: ['string', 'null'], enum: ['north_star', 'priority', 'supporting', null] },
    period: { type: ['string', 'null'] },
    // `kind` is the legacy positioning classifier; `subkind` is the
    // generalized-envelope equivalent. Both accepted.
    kind: { type: ['string', 'null'] },
    subkind: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    decided_on: { type: ['string', 'null'] },
    decided_by: { type: ['string', 'null'] },
    category: { type: ['string', 'null'] },
    // A profile-driven template's typed extras (ContextProfile kind.attrs —
    // e.g. appointment.date, policy.verdict, status_section.section). Without
    // a declared slot here the model has nowhere to put them: structured
    // output only fills properties the tool schema names, no matter what the
    // rendered prompt (kind_field_specs) asks for. Loose `object` because the
    // keys are per-profile; ProfileNode/Zod re-validates and downstream
    // sanitizes (strips unknown enum values) against the workspace's actual
    // taxonomy.
    attrs: { type: ['object', 'null'] },
  },
  required: ['id', 'type', 'created_at', 'updated_at', 'body'],
} as const;

const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          proposed_node: PROPOSED_NODE_SCHEMA,
          flag: { type: 'string', enum: ['red', 'yellow', 'green'] },
          source_quote: { type: 'string' },
          source_ref: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          conflicts_with: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
        },
        required: ['id', 'proposed_node', 'flag', 'source_quote', 'source_ref', 'confidence'],
      },
    },
  },
  required: ['candidates'],
} as const;

// Whole-doc (simple/generic) capture: the document is stored verbatim as one
// node; this call only infers the two label fields. See classifyWholeDoc.
const WHOLE_DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['title', 'category'],
} as const;

const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          // Profile-flexible: the category is one of the workspace profile's
          // feedback-dimension keys (founding: decisions / goals_priorities /
          // positioning / brand_voice / context_recency). Validated downstream.
          category: { type: 'string' },
          flag: { type: 'string', enum: ['red', 'yellow', 'green'] },
          node_id: { type: ['string', 'null'] },
          quote_from_deliverable: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['category', 'flag', 'quote_from_deliverable', 'summary'],
      },
    },
  },
  required: ['findings'],
} as const;

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    cited_node_ids: { type: 'array', items: { type: 'string' } },
    has_answer: { type: 'boolean' },
  },
  required: ['answer', 'cited_node_ids', 'has_answer'],
} as const;

// Always-hybrid answering (spec-source-rag-hybrid-answering.md §2.4).
const QUERY_HYBRID_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    cited_node_ids: { type: 'array', items: { type: 'string' } },
    cited_chunk_ids: { type: 'array', items: { type: 'string' } },
    has_answer: { type: 'boolean' },
    answered_from: { type: 'string', enum: ['canon', 'source', 'both', 'none'] },
  },
  required: ['answer', 'cited_node_ids', 'cited_chunk_ids', 'has_answer', 'answered_from'],
} as const;

const OVERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
} as const;

const USAGE_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
} as const;

// Work-agent artifact (spec-work-agents.md).
const WORK_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    output: { type: 'string' },
    cited_node_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'output', 'cited_node_ids'],
} as const;

const GROUPING_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          candidate_ids: { type: 'array', items: { type: 'string' } },
          recommended_action: {
            type: 'string',
            enum: ['approve_all', 'review_individually', 'reject_all'],
          },
          rationale: { type: 'string' },
        },
        required: ['title', 'summary', 'candidate_ids', 'recommended_action', 'rationale'],
      },
    },
  },
  required: ['groups'],
} as const;

const DOC_TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    legitimacy: { type: 'number', minimum: 0, maximum: 1 },
    currency: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    doc_kind_claim: { type: 'string' },
    stakeholder_assessment: { type: 'string' },
    rationale: { type: 'string' },
    questions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['attest', 'clarify'] },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          affects: { type: 'string', enum: ['legitimacy', 'currency', 'scope'] },
          resolution: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                legitimacy: { type: 'number', minimum: 0, maximum: 1 },
                currency: { type: 'number', minimum: 0, maximum: 1 },
                disposition: { type: 'string', enum: ['commit_doc', 'triage_items', 'quarantine'] },
              },
            },
          },
        },
        required: ['id', 'kind', 'text', 'affects', 'resolution'],
      },
    },
  },
  required: ['legitimacy', 'currency', 'doc_kind_claim', 'stakeholder_assessment', 'rationale', 'questions'],
} as const;

/**
 * Context-aware triage: assess one document's legitimacy/currency and emit
 * decision-changing questions (spec §6). Reasons about the dossier, never
 * the document body. Deterministic enforcement happens downstream
 * (triage-policy.ts); this call only scores and asks.
 */
export async function runDocTriage(opts: {
  dossier: DocTriageDossier;
  candidates: ReadonlyArray<DocTriageSlimCandidate>;
  profile: ContextProfile;
}): Promise<DocTriagePayloadT> {
  const { body: template, meta } = loadPromptFile('doc-triage');
  const system = renderPrompt(template, docTriageSlots(opts.profile, opts.dossier.source_type || undefined));
  const user = `<dossier>\n${JSON.stringify(opts.dossier, null, 2)}\n</dossier>\n\n<candidates>\n${JSON.stringify(
    opts.candidates,
    null,
    1,
  )}\n</candidates>`;
  const parsed = await callStructured({
    model: MODELS.doc_triage,
    system,
    user,
    toolName: 'emit_doc_triage',
    toolDescription: 'Emit the document triage assessment (legitimacy, currency, questions).',
    schema: DOC_TRIAGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2048,
    task: 'doc-triage',
    promptVersion: meta.version,
    inputSummary: {
      source_ref: opts.dossier.source_ref,
      source_type: opts.dossier.source_type || null,
      candidate_count: opts.candidates.length,
      contradiction_rate: opts.dossier.contradiction_rate,
      corroboration_count: opts.dossier.corroboration_count,
    },
  });
  const payload = DocTriagePayload.parse(parsed);
  // Structural enforcement of the point_in_time rule (the prompt asks; we
  // verify): currency and currency-questions are stripped, not trusted.
  const typeDef = (opts.profile.source_types ?? []).find((s) => s.key === opts.dossier.source_type);
  if (typeDef && (typeDef.currency ?? 'decaying') === 'point_in_time') {
    return {
      ...payload,
      currency: null,
      questions: payload.questions.filter((q) => q.affects !== 'currency'),
    };
  }
  return payload;
}

export async function runTriage(prompt: string, response: string): Promise<TriageResultT> {
  const { body: system, meta } = loadPromptFile('triage');
  const user = `<prompt>${prompt.slice(0, 12000)}</prompt>\n\n<response>${response.slice(
    0,
    12000,
  )}</response>`;
  const parsed = await callStructured({
    model: MODELS.triage,
    system,
    user,
    toolName: 'emit_triage',
    toolDescription: 'Emit the triage classification for the supplied prompt/response.',
    schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'triage',
    promptVersion: meta.version,
    inputSummary: {
      prompt_chars: prompt.length,
      response_chars: response.length,
    },
  });
  return TriageResult.parse(parsed);
}

/** Observability event pushed by the routed capture pipeline. */
export type CaptureTraceEvent = { stage: string; [k: string]: unknown };

export type CaptureOpts = {
  /**
   * The nodes this subfolder already holds. Capture READS them: it renders
   * them into the `{{subfolder_nodes}}` slot as context for how existing
   * content is worded.
   *
   * This was dead weight until 2026-07-17 — passed in, then dropped on the floor
   * because no slot rendered it, which is what made capture graph-blind and
   * forced a downstream dedup judge to reconstruct what capture could not see.
   * Connecting it is what let that whole stage be deleted.
   */
  graph: readonly Node[];
  sourceKind: 'doc' | 'slack' | 'transcript' | 'interaction';
  source: string;
  /** Workspace context profile. Defaults to FALLBACK_PROFILE. */
  profile?: ContextProfile;
  /** Optional observability collector for the routed pipeline's stage events. */
  trace?: CaptureTraceEvent[];
  /** Optional file path / ref for the router's path priors. */
  sourceRef?: string;
  /**
   * Optional store-phase ingestion-rule policy (newline-joined instructions)
   * injected into the capture prompt — suppress/redact per the workspace owner's
   * rules (spec-directory-tracking-and-ingestion-rules.md §5.3b). Empty/absent →
   * byte-identical to the historic prompt.
   */
  rulePolicy?: string;
  /** See Synth.capture's doc comment (synthesis.ts) — same field, same default. */
  dataAgentActive?: boolean;
};

const RULE_EVAL_SCHEMA = {
  type: 'object',
  properties: {
    applicable: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of the rules whose criteria clearly apply to this document.',
    },
  },
  required: ['applicable'],
  additionalProperties: false,
} as const;

/**
 * Evaluate which store-phase curation-automation rules (auto-approve / reject /
 * surface) apply to a source document (spec §5.3a). Runs on the SMALL model —
 * routes through the hosted (Together Qwen) override when installed, else the
 * Anthropic triage-tier model. Conservative + fail-open: returns only clearly-
 * applicable rule ids; any error or no-tool-use → empty, so the machine-derived
 * curation disposition stands.
 */
export async function runEvaluateRules(opts: {
  rules: ReadonlyArray<{ id: string; action: string; instructions: string }>;
  document: { summary: string; source_ref: string; source_kind: string };
  items: ReadonlyArray<{ id: string; flag: string; summary: string }>;
}): Promise<{ applicable: string[] }> {
  if (opts.rules.length === 0) return { applicable: [] };
  const system = [
    "You decide which of a workspace owner's ingestion-automation RULES apply to a source document.",
    'Each rule has an id and free-text criteria. A rule APPLIES only when the document clearly and',
    'specifically matches its criteria. Be conservative: when in doubt, do NOT include the rule.',
    'Judge only whether the criteria match — not what the rule then does. Return the ids that apply.',
  ].join('\n');
  const user = JSON.stringify(
    {
      document: opts.document,
      items: opts.items,
      rules: opts.rules.map((r) => ({ id: r.id, criteria: r.instructions })),
    },
    null,
    2,
  );
  try {
    const res = await structuredCall({
      model: MODELS.triage,
      system,
      user,
      toolName: 'emit_applicable_rules',
      toolDescription: 'Emit the ids of the rules whose criteria clearly apply to this document.',
      schema: RULE_EVAL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 512,
      task: 'rule_eval',
    });
    if (res.noToolUse) return { applicable: [] };
    const out = res.output as { applicable?: unknown };
    const valid = new Set(opts.rules.map((r) => r.id));
    const applicable = Array.isArray(out.applicable)
      ? out.applicable.filter((x): x is string => typeof x === 'string' && valid.has(x))
      : [];
    return { applicable };
  } catch (err) {
    log.warn('rule_eval.failed_open', { msg: (err as Error).message?.slice(0, 200) });
    return { applicable: [] };
  }
}

const REDACT_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'The same field keys, each with disallowed spans replaced by "[redacted]".',
    },
    changed: { type: 'boolean', description: 'True if any field was redacted.' },
  },
  required: ['fields', 'changed'],
  additionalProperties: false,
} as const;

/**
 * Apply the workspace owner's shape rules to text fields — a graph node's
 * fields before they are served to a broader audience (use-phase, spec §5.3c),
 * or a whole source document before it is stored and captured (source-target
 * store rules). Spans a rule masks come back as "[redacted]"; spans a rule
 * says must not be stored/indexed at all are removed outright. Returns the
 * fields plus a `changed` flag. Runs on the small model (Together Qwen when
 * hosted, else Anthropic triage-tier).
 * Fail-open: any error / no-tool-use → the fields unchanged (serve full).
 */
export async function runRedactFields(opts: {
  fields: Record<string, string>;
  rules: ReadonlyArray<{ instructions: string }>;
}): Promise<{ fields: Record<string, string>; changed: boolean }> {
  const keys = Object.keys(opts.fields);
  if (keys.length === 0 || opts.rules.length === 0) return { fields: opts.fields, changed: false };
  const system = [
    "You apply a workspace owner's data-handling rules to text fields (a graph node's fields, or",
    'a whole source document) before the text is stored or shared. For each field, return the',
    'SAME text except where a rule applies:',
    '- a span a rule says must not be SHARED: replace it with the literal token "[redacted]".',
    '- content a rule says must not be STORED or INDEXED at all (e.g. "do not index casual',
    '  chatter"): remove those spans entirely — no placeholder — keeping the surviving text',
    '  coherent.',
    'Preserve everything else verbatim. If nothing matches any rule, return the fields unchanged',
    'and changed=false.',
  ].join('\n');
  const user = JSON.stringify({ rules: opts.rules.map((r) => r.instructions), fields: opts.fields }, null, 2);
  try {
    const res = await structuredCall({
      model: MODELS.triage,
      system,
      user,
      toolName: 'emit_redacted_fields',
      toolDescription: 'Emit the node text fields with disallowed content redacted.',
      schema: REDACT_SCHEMA as unknown as Record<string, unknown>,
      // Node fields are short, but this same call also redacts a whole source
      // document (source-target rules), so give it generous output headroom.
      maxTokens: 8192,
      task: 'rule_redact',
    });
    if (res.noToolUse) return { fields: opts.fields, changed: false };
    const out = res.output as { fields?: Record<string, unknown>; changed?: boolean };
    const redacted: Record<string, string> = {};
    for (const k of keys) {
      redacted[k] = typeof out.fields?.[k] === 'string' ? (out.fields![k] as string) : opts.fields[k]!;
    }
    return { fields: redacted, changed: !!out.changed };
  } catch (err) {
    log.warn('rule_redact.failed_open', { msg: (err as Error).message?.slice(0, 200) });
    return { fields: opts.fields, changed: false };
  }
}

const RULE_CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    phases: {
      type: 'array',
      items: { type: 'string', enum: ['store', 'use'] },
      description: 'When the rule applies: store (at ingest) and/or use (at retrieval).',
    },
    target: {
      type: 'string',
      enum: ['node', 'source', 'both'],
      description:
        'What the rule changes: node (only the extracted graph nodes), source (only the stored source document), or both.',
    },
  },
  required: ['phases', 'target'],
  additionalProperties: false,
} as const;

export type RuleClassification = {
  phases: ('store' | 'use')[];
  target: 'node' | 'source' | 'both';
};

/**
 * Classify a free-text content rule into its phase(s) and target (spec §5.2).
 * The user writes the intent in plain language; the model decides WHEN it
 * applies and WHAT it touches, so the UI needn't ask. Runs on the small model
 * (Together Qwen when hosted, else Anthropic triage-tier). Fail-open →
 * { phases:['store'], target:'node' } (the safe, most-common default).
 *
 * There used to be a third axis here — action (shape/auto_approve/auto_reject/
 * surface) — but auto_approve/auto_reject/surface never applied to a live
 * document: the product collapsed to one builtin profile that auto-applies
 * every capture immediately, so those three curation actions only ever
 * affected the rule-test dry-run preview. Worse, the model routinely
 * misclassified plain redaction intent ("do not index casual chatter...")
 * as auto_reject even though the prompt's own guidance listed "do-not-index"
 * under shape — asking it to choose between three dead options and one real
 * one was the bug. Every content rule just shapes/redacts now; there's
 * nothing left to classify on that axis.
 *
 * Guidance encoded in the prompt:
 *  - phase: redact/withhold at share time → use; suppress at ingest → store;
 *    "hide PII" → both (must hold on the local copy AND at share time).
 */
export async function runClassifyRule(opts: { instructions: string }): Promise<RuleClassification> {
  const fallback: RuleClassification = { phases: ['store'], target: 'node' };
  if (!opts.instructions.trim()) return fallback;
  const system = [
    "You classify a workspace owner's free-text content rule (redact, hide, mask, do-not-index,",
    "do-not-extract, or do-not-share some content) into a phase and a target.",
    'PHASES — include each that applies:',
    '- store: acts as data is ingested (suppress/redact at capture).',
    '- use: acts when data is served/shared to an audience (redact or withhold at retrieval).',
    'Redaction that must also hold on the local copy (e.g. hide PII) is BOTH store and use.',
    'TARGET — what the rule changes:',
    '- node: only the extracted graph nodes — rules about how notes/nodes are phrased or what',
    '  extracted items may contain.',
    '- source: the source document itself, at the FIRST stage of ingest. Rules about what part of',
    '  a document should be indexed/stored at all — "do not index casual chatter", "skip small',
    '  talk in transcripts or Slack", "drop off-topic discussion" — are source rules: they act on',
    '  the document BEFORE it is stored or processed further, so downstream extraction never sees',
    '  the excluded content.',
    '- both: the stored source AND the extracted nodes. "Remove/redact PII from the transcript"',
    '  scrubs the stored document too, so it is "both".',
  ].join('\n');
  try {
    const res = await structuredCall({
      model: MODELS.triage,
      system,
      user: `Rule: ${opts.instructions.trim()}`,
      toolName: 'emit_rule_classification',
      toolDescription: 'Emit the phase(s) and target for this rule.',
      schema: RULE_CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 96,
      task: 'rule_classify',
    });
    if (res.noToolUse) return fallback;
    const out = res.output as { phases?: unknown; target?: unknown };
    const phases = Array.isArray(out.phases)
      ? (out.phases.filter((p) => p === 'store' || p === 'use') as ('store' | 'use')[])
      : [];
    const target = out.target === 'source' || out.target === 'both' || out.target === 'node' ? out.target : 'node';
    return { phases: phases.length > 0 ? phases : ['store'], target };
  } catch (err) {
    log.warn('rule_classify.failed_open', { msg: (err as Error).message?.slice(0, 200) });
    return fallback;
  }
}

const DOCUMENT_ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    target_subgraph_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ids of every folder whose job this document genuinely feeds. EMPTY when no folder ' +
        'fits — that is a valid, expected answer, not a failure.',
    },
    reason: {
      type: 'string',
      description:
        'One sentence: what the document gives each named folder, or — when none are named — ' +
        'what the document is and why no folder covers it.',
    },
    summary: {
      type: 'string',
      description:
        "2-3 sentences describing the document on its own terms, for a reader who will never " +
        'see it. Not written against any one folder.',
    },
    stakeholders: {
      type: 'array',
      items: { type: 'string' },
      description: 'People named as authors, participants, or owners. Empty when undeterminable.',
    },
  },
  required: ['target_subgraph_ids', 'reason', 'summary', 'stakeholders'],
} as const;

/**
 * Flat wire shape for the model's own output — plain required strings, no
 * nullable/object union. A nullable nested object (`propose_new_folder: {...}
 * | null`) turned out to be exactly where an earlier version of this call
 * broke on a weak model: the `reason` text correctly reasoned about a name
 * while the object field stayed null anyway — the free-text reasoning and the
 * structured slot-filling diverged. Flat, always-required strings give the
 * constrained decoder nothing to get wrong about SHAPE.
 */
const PROPOSE_NEW_FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'A short name for the new folder, e.g. "Client feedback" or "Vendor contracts".' },
    description: {
      type: 'string',
      description: "One line: what this folder is for, in the owner's voice.",
    },
    reason: {
      type: 'string',
      description: 'One sentence: why this document warrants its own folder.',
    },
  },
  required: ['name', 'description', 'reason'],
} as const;

const ProposeNewFolderWire = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  reason: z.string().default(''),
});

/** A folder as the INGEST router sees it (spec-pomegranate-light.md §4, "What
 * the router must read"). The router never sees the template's extraction
 * charter — only the folder's `type` (which template it's built from), the
 * OWNER's own name and description for it (`name`/`ownerDescription` — outrank
 * inference), and what it actually HOLDS (`contentDigest`). */
export interface RouteFolder {
  id: string;
  /** The owner-given folder name (`subgraphs.name`). */
  name: string;
  /** The template this folder is built from, e.g. "To-do list". */
  type: string;
  /** The owner's own one-line "what this folder is for" (`subgraphs.description`). */
  ownerDescription?: string;
  /**
   * What the folder currently holds: the persisted Overview synthesis
   * (`subgraphs.generated_description`), refreshed by the /overview route.
   * Absent on an empty folder — and absence must read as "nothing to say about
   * this folder yet", never as "this folder is wrong for the document".
   *
   * A CACHED digest by design: routing runs once per document, so reading a
   * folder summary here is affordable, but a per-ingest FULL read of the folder
   * would reintroduce exactly the cost the one-job-per-folder rule exists to
   * avoid (spec §4).
   */
  contentDigest?: string;
}

/** Build the `<folders>` block the ingest router reads. Pure + exported so a
 * test can assert the routing data without an LLM. */
export function buildDocumentRouteCatalog(folders: RouteFolder[]): string {
  return folders
    .map((f) => {
      const lines = [`- id: ${f.id}`, `  name: ${f.name}`, `  type: ${f.type}`];
      const owner = (f.ownerDescription ?? '').trim();
      // 'miscellaneous' is the DB default when the creator left it blank — it is
      // the absence of an owner statement, not an owner statement. Passing it as
      // one would invite the router to read "miscellaneous" as "anything fits".
      if (owner && owner.toLowerCase() !== 'miscellaneous') lines.push(`  owner_says: ${owner.slice(0, 700)}`);
      const holds = (f.contentDigest ?? '').trim();
      lines.push(holds ? `  currently_holds: ${holds.slice(0, 1200)}` : '  currently_holds: (empty folder — nothing filed yet)');
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Head + middle + tail sampling, capped at `max` chars: transcripts bury the
 * decisive part in the back half, so a head-only truncation systematically
 * kills them. Shared by routeDocument and proposeNewFolder so both calls see
 * the document the same way.
 */
function sampleDocument(source: string, max = 12000): { text: string; truncated: boolean } {
  if (source.length <= max) return { text: source, truncated: false };
  const head = source.slice(0, 6000);
  const midStart = Math.floor(source.length / 2) - 1500;
  const middle = source.slice(midStart, midStart + 3000);
  const tail = source.slice(-3000);
  return { text: `${head}\n…[gap]…\n${middle}\n…[gap]…\n${tail}`, truncated: true };
}

/**
 * The ingest router. ONE pass over the document that answers both questions the
 * ingest path needs: which folders does this belong in (possibly NONE), and what
 * IS this document (summary + stakeholders, which ride `attrs.context` on every
 * node captured from it).
 *
 * Replaced `runRouteCapture` + the ingest-side `routeToSubgraphs` on 2026-07-17.
 * The old pair read the document twice and routed on the SUMMARY, which was
 * itself written against one folder's profile — so a brand-voice document got a
 * to-do-list-flavoured summary and was routed to nothing. The router now reads
 * the document itself. See spec-pomegranate-light.md §4 and the removals doc §4
 * task #11.
 *
 * THROWS on call failure — it does NOT fail open to `[]`. `[]` means the model
 * decided no folder fits, which is a real verdict the caller reports as a drop;
 * a transient timeout must never be indistinguishable from that. Callers decide
 * what a failure means (`resolveIngestTargets` files to the default folder and
 * says so), because silently discarding a document on a 401 is the worst
 * available outcome.
 *
 * `routeToSubgraphs` remains the QUERY-side router and is deliberately NOT this
 * function: a query wants no summary, floors an empty verdict to "ask every
 * folder", and must not pay for content digests on every question.
 */
export async function routeDocument(opts: {
  source: string;
  folders: RouteFolder[];
  /** File path / ref shown to the router (path priors: customer discovery/, research/…). */
  sourceRef?: string;
}): Promise<DocumentRouteT> {
  const { body: template, meta } = loadPromptFile('route-document');
  const validIds = new Set(opts.folders.map((f) => f.id));
  const outline = opts.source
    .split('\n')
    .filter((l) => /^#{1,3}\s/.test(l))
    .slice(0, 40)
    .join('\n');
  const { text, truncated } = sampleDocument(opts.source);
  const refLine = opts.sourceRef ? `<source_path>${opts.sourceRef}</source_path>\n\n` : '';
  const catalog = buildDocumentRouteCatalog(opts.folders);
  const user =
    `<folders>\n${catalog}\n</folders>\n\n${refLine}<outline>\n${outline || '(no headings)'}\n</outline>\n\n` +
    `<document sampled="${truncated}">\n${text}\n</document>`;
  const parsed = await callStructured({
    model: MODELS.triage,
    system: template,
    user,
    toolName: 'route_document',
    toolDescription: 'Say which folders the document belongs in (possibly none) and what it is.',
    schema: DOCUMENT_ROUTE_SCHEMA as unknown as Record<string, unknown>,
    // Qwen writes a fuller `reason` than Haiku and overran 512 on the old
    // router — the JSON truncated mid-object and parsed to [], which under
    // Light's drop semantics would silently DISCARD the document rather than
    // merely under-route it. Budget generously; the cost is negligible.
    maxTokens: 1536,
    task: 'route-document',
    promptVersion: meta.version,
    inputSummary: {
      source_chars: opts.source.length,
      folders: opts.folders.length,
      truncated,
    },
  });
  const route = DocumentRoute.parse(parsed);
  // Drop hallucinated ids: a fabricated folder id is not a routing decision.
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of route.target_subgraph_ids) {
    const id = String(raw);
    if (validIds.has(id) && !seen.has(id)) {
      seen.add(id);
      targets.push(id);
    } else if (!validIds.has(id)) {
      log.warn('synth.route_document.unknown_folder', { id: id.slice(0, 60) });
    }
  }
  return { ...route, target_subgraph_ids: targets };
}

/**
 * SEPARATE, single-job follow-up call — run ONLY when `routeDocument` named
 * no folder for a document. Names a new folder for it: routing never ends in
 * a silent drop, so once nothing existing fits, the only remaining question
 * is what the new folder should be called and described (see
 * resolveIngestTargets / runTextIngest in phase1/api/routes.ts, which always
 * turns the result into a pending-route for a human to approve or reject).
 *
 * Split out of routeDocument deliberately (see propose-new-folder.md's
 * frontmatter): bolted onto the routing call as a second job, this
 * consistently lost to the primary "which existing folder" job on a weak
 * model — real eval runs (scripts/eval-routing.ts) showed it being ignored
 * rather than attended to. Isolating it as the ONLY job in its own call,
 * triggered only on the subset of documents that fit nothing existing, costs
 * nothing on the common case (something already fits).
 *
 * Best-effort from the caller's perspective: a failure here must still result
 * in a pending-route, never a drop — callers catch and fall back to a generic
 * proposal (see resolveIngestTargets).
 */
export async function proposeNewFolder(opts: {
  source: string;
  sourceRef?: string;
}): Promise<ProposeNewFolderT> {
  const { body: template, meta } = loadPromptFile('propose-new-folder');
  const { text, truncated } = sampleDocument(opts.source);
  const refLine = opts.sourceRef ? `<source_path>${opts.sourceRef}</source_path>\n\n` : '';
  const user = `${refLine}<document sampled="${truncated}">\n${text}\n</document>`;
  const parsed = await callStructured({
    model: MODELS.triage,
    system: template,
    user,
    toolName: 'propose_new_folder',
    toolDescription: 'Name a new folder for this document, since nothing existing fits.',
    schema: PROPOSE_NEW_FOLDER_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'propose-new-folder',
    promptVersion: meta.version,
    inputSummary: { source_chars: opts.source.length, truncated },
  });
  const wire = ProposeNewFolderWire.parse(parsed);
  const name = wire.name.trim() || 'New folder';
  return { propose_new_folder: { name, description: wire.description }, reason: wire.reason };
}

const SUBGRAPH_ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    target_subgraph_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of every subgraph whose subject this document materially informs.',
    },
    reason: {
      type: 'string',
      description:
        'One short clause per included id explaining what the document feeds that subgraph ' +
        '(name the shared zone when an id is included because of overlap).',
    },
  },
  required: ['target_subgraph_ids', 'reason'],
} as const;

/** A subgraph as the router sees it. `routingHint`, when present, is the
 * discriminative routing blurb; otherwise the comprehensive `description` is
 * used (and capped). The router NEVER sees the full extraction charter. */
export interface RouteSubgraph {
  id: string;
  name: string;
  description: string;
  routingHint?: string;
}

/** The single line of routing text the router weighs for a subgraph: the
 * discriminative `routing_hint` when set, else the (capped) extraction
 * `description`. Exported so the routing surface is unit-testable without the
 * API. The cap is generous so a hint is never truncated; it only bounds the
 * fallback description. */
export function subgraphRoutingAbout(
  p: { routingHint?: string; description?: string },
  cap = 700,
): string {
  const hint = (p.routingHint ?? '').trim();
  if (hint) return hint.slice(0, cap);
  return (p.description ?? '').slice(0, cap);
}

/**
 * The router's system prompt, loaded from `prompts/route-to-subgraphs.md` — it
 * was an inlined `const` string until 2026-07-17, which broke the one-prompt-
 * per-file convention (docs/llm-calls.md) and made
 * it the one stage the diagnostics tool could not show you. Moved VERBATIM: the
 * body is byte-identical to the old constant, so routing behaviour is unchanged.
 *
 * Kept as an exported binding because `engine.ts` re-exports it and
 * `subgraph-route-data.test.ts` asserts against it. Loaded once at module init,
 * like every other prompt.
 *
 * THIS IS THE QUERY-SIDE ROUTER ONLY, as of 2026-07-17. It used to serve ingest
 * too; ingest now has `routeDocument`, which reads the document once, weighs
 * each folder's content and its owner's description, and may drop. Routing a
 * QUESTION is a different job and keeps this simpler prompt deliberately:
 *
 *  - an empty verdict here means "ask every folder", not "drop" — the opposite
 *    reflex to ingest's, which is why the two must not share a prompt;
 *  - it must not read folder content digests. Routing is affordable once per
 *    DOCUMENT; per QUESTION it is the cost the one-job rule exists to avoid
 *    (spec §4).
 */
export const SUBGRAPH_ROUTE_SYSTEM = loadPrompt('route-to-subgraphs');

/** Build the `<subgraphs>` catalog block the router reads. Pure + exported so a
 * test can assert the routing data (hint preferred over charter). */
export function buildSubgraphRouteCatalog(subgraphs: RouteSubgraph[]): string {
  return subgraphs
    .map((s) => `- id: ${s.id}\n  name: ${s.name}\n  about: ${subgraphRoutingAbout(s)}`)
    .join('\n');
}

/**
 * Multi-subgraph router: decide which knowledge subgraphs a document is ABOUT.
 * One cheap Haiku call. Returns the subset of input subgraph ids the document
 * materially informs (a document may belong to several). Validates returned ids
 * against the input set, dropping unknowns. On ANY error returns [] — the caller
 * floors that to the default subgraph. Only called for multi-subgraph
 * workspaces without an explicit `#slug` pin, so it never runs in the
 * single-subgraph regression suites.
 */
export async function routeToSubgraphs(
  source: string,
  subgraphs: RouteSubgraph[],
  opts?: { system?: string },
): Promise<string[]> {
  if (subgraphs.length === 0) return [];
  const validIds = new Set(subgraphs.map((s) => s.id));
  // Head + tail sampling (same style as runRouteCapture) so a long document's
  // subject is visible without paying for the whole body.
  const MAX = 12000;
  let text: string;
  if (source.length <= MAX) {
    text = source;
  } else {
    const head = source.slice(0, 8000);
    const tail = source.slice(-3000);
    text = `${head}\n…[gap]…\n${tail}`;
  }
  // The system prompt is overridable so the routing eval harness can A/B prompt
  // variants without a rebuild; production callers pass nothing and get the
  // default intersection-aware prompt.
  const system = opts?.system ?? SUBGRAPH_ROUTE_SYSTEM;
  const catalog = buildSubgraphRouteCatalog(subgraphs);
  const user = `<subgraphs>\n${catalog}\n</subgraphs>\n\n<document sampled="${source.length > MAX}">\n${text}\n</document>`;
  try {
    const parsed = (await callStructured({
      model: MODELS.triage,
      system,
      user,
      toolName: 'route_to_subgraphs',
      toolDescription: 'Route the document to the subgraphs it is about.',
      schema: SUBGRAPH_ROUTE_SCHEMA as unknown as Record<string, unknown>,
      // 512 was enough for Haiku's terse output but Qwen writes a fuller `reason`
      // and overran it — the JSON got truncated mid-object, parsed to [], and the
      // caller floored the doc to the default subgraph (a silent under-route).
      // The reliable ids come first in the object, so this only needs to cover a
      // verbose justification; 1536 clears it with margin at negligible cost.
      maxTokens: 1536,
      task: 'route-to-subgraphs',
      inputSummary: { source_chars: source.length, subgraphs: subgraphs.length, truncated: source.length > MAX },
    })) as { target_subgraph_ids?: unknown };
    const ids = Array.isArray(parsed.target_subgraph_ids) ? parsed.target_subgraph_ids : [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = String(raw);
      if (validIds.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  } catch (err) {
    log.warn('synth.subgraph_route.failed', { msg: (err as Error).message?.slice(0, 200) });
    return [];
  }
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          idx: { type: 'integer' },
          action: { type: 'string', enum: ['keep', 'drop'] },
          reason: { type: 'string' },
        },
        required: ['idx', 'action'],
      },
    },
  },
  required: ['verdicts'],
} as const;

/**
 * Arbiter pass: drops cross-specialist duplicates and generic wrappers.
 * Fail-open at every level — a merge error, or a candidate missing from the
 * verdicts, keeps the candidate (the downstream graph-dedup is a second net).
 */
export async function runMergeCandidates(opts: {
  candidates: Candidate[];
  profile: ContextProfile;
  trace?: CaptureTraceEvent[];
}): Promise<Candidate[]> {
  const { candidates, profile } = opts;
  const { body: template, meta } = loadPromptFile('merge-candidates');
  const system = renderPrompt(template, { profile_description: profile.description });
  const compact = candidates.map((c, idx) => {
    const n = c.proposed_node as Record<string, unknown>;
    return {
      idx,
      kind: n.type,
      subkind: (n as { subkind?: string }).subkind ?? null,
      category: (n as { category?: string }).category ?? null,
      flag: c.flag,
      title: (n as { title?: string }).title ?? (n as { summary?: string }).summary ?? null,
      body: String(n.body ?? '').slice(0, 220),
    };
  });
  try {
    const parsed = await callStructured({
      model: MODELS.triage,
      system,
      user: `<candidates>\n${JSON.stringify(compact, null, 1)}\n</candidates>`,
      toolName: 'emit_verdicts',
      toolDescription: 'Keep/drop verdicts for merged specialist candidates.',
      schema: MERGE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 8192,
      task: 'merge-candidates',
      promptVersion: meta.version,
      inputSummary: { candidate_count: candidates.length },
    });
    const { verdicts } = MergeVerdicts.parse(parsed);
    const byIdx = new Map(verdicts.map((v) => [v.idx, v]));
    const kept = candidates.filter((_, idx) => (byIdx.get(idx)?.action ?? 'keep') === 'keep');
    opts.trace?.push({
      stage: 'merge',
      input: candidates.length,
      kept: kept.length,
      drops: verdicts
        .filter((v) => v.action === 'drop')
        .map((v) => ({ idx: v.idx, reason: v.reason ?? null })),
    });
    return kept;
  } catch (err) {
    log.warn('synth.merge.failed_open', { msg: (err as Error).message?.slice(0, 200) });
    return candidates;
  }
}

/**
 * Capture dispatcher. Profiles WITHOUT extraction_groups (every current
 * builtin) take the original single-call path, unchanged. Profiles WITH
 * groups run the routed pipeline:
 * route → parallel layer specialists → signature dedup → arbiter merge.
 */
/**
 * Capture entry point. Runs the base extraction, then — ONLY when
 * `POMEGRANATE_CAPTURE_GLEAN=1` — a second "completeness" pass (runGlean) that
 * recovers claims the first pass missed. Off by default, so with the flag unset
 * this is byte-identical to the prior behaviour (no extra call, no dedup). The
 * gleaning pass is aimed at weaker local models, where a single pass under-
 * extracts subtle kinds (non-goals/boundaries, value-props, constraints).
 */
/**
 * Should the glean (completeness) pass run? Pure so the gate is unit-testable
 * without an LLM. Glean normally augments a non-empty first pass. The one case
 * that MOST needs a second pass is a zero-yield: the router judged the document
 * relevant yet every extraction specialist returned nothing — a weak-model
 * miss, not an empty source. We gate an empty base on the `zero_yield` trace,
 * NOT on `base.length` alone: a router REJECTION (relevant:false) also yields an
 * empty base but pushes no zero_yield event, so correct "not for this profile"
 * rejections stay empty and are never force-extracted.
 *
 * `log` shape is excluded outright, regardless of the env flag: `runCapture`
 * unions glean's output as SEPARATE candidates (`[...base, ...added]`), never
 * merged into an existing one — see the union logic just below. A `log`
 * profile's whole point is batching everything from one document into ONE
 * node per kind; a second, non-duplicate thing glean finds becomes a rival
 * node from the same document, fragmenting exactly the invariant the shape
 * exists to hold. Glean's actual purpose (recovering a whole missed KIND,
 * per glean.md) doesn't even apply to a single-kind `log` template like
 * `notes` — the failure mode worth guarding there is capture truncating
 * content WITHIN the one node, which appending a rival candidate doesn't fix.
 */
export function shouldGlean(
  baseLen: number,
  trace: readonly CaptureTraceEvent[] | undefined,
  profile?: ContextProfile,
): boolean {
  if (process.env.POMEGRANATE_CAPTURE_GLEAN !== '1') return false;
  if (profile?.shape === 'log') return false;
  if (baseLen > 0) return true;
  return trace?.some((t) => t.stage === 'zero_yield') ?? false;
}

/**
 * Deterministic per-candidate hygiene against a profile: normalize scoping
 * attrs, strip invalid subkind/category, strip out-of-enum attr values.
 * Module-level (not a closure in runCaptureBase) so EVERY producer of
 * candidates — base specialists AND the glean pass — runs the same
 * sanitizer; glean output used to skip it entirely.
 */
function sanitizeCandidateForProfile(
  c: Candidate,
  profile: ContextProfile,
  trace?: CaptureTraceEvent[],
): Candidate {
  const n = c.proposed_node as Record<string, unknown>;
  // Normalize scoping-attr casing so dedup keys and downstream filters match
  // (product profile scopes by `product`, program profile by `project` —
  // prod data showed uncontrolled vocabulary on these breaks exact matching).
  const attrs = n.attrs as Record<string, unknown> | undefined;
  for (const scopeAttr of ['product', 'project'] as const) {
    if (attrs && typeof attrs[scopeAttr] === 'string') {
      attrs[scopeAttr] = (attrs[scopeAttr] as string).trim().toLowerCase();
    }
  }
  const def = profile.kinds.find((k) => k.key === String(n.type));
  if (def) {
    const sub = (n as { subkind?: string }).subkind;
    if (sub && !(def.subkinds ?? []).some((x) => x.key === sub)) {
      trace?.push({ stage: 'sanitize', action: 'strip_subkind', title: String((n as { title?: string }).title ?? ''), invalid: sub });
      delete (n as Record<string, unknown>).subkind;
    }
    const cat = (n as { category?: string }).category;
    if (cat && !(def.categories ?? []).some((x) => x.key === cat)) {
      trace?.push({ stage: 'sanitize', action: 'strip_category', title: String((n as { title?: string }).title ?? ''), invalid: cat });
      delete (n as Record<string, unknown>).category;
    }
    // Enum attrs: strip values outside the declared enum (e.g. horizon "phase_1").
    if (attrs) {
      for (const a of def.attrs ?? []) {
        if (a.type === 'enum' && a.values?.length && typeof attrs[a.key] === 'string' && !a.values.includes(attrs[a.key] as string)) {
          trace?.push({ stage: 'sanitize', action: 'strip_attr', attr: a.key, invalid: attrs[a.key] });
          delete attrs[a.key];
        }
      }
    }
  }
  return c;
}

/**
 * Deterministic profile-kind enforcement: drop candidates whose node type is
 * not a kind of the target profile. This is the LAST gate before capture
 * output leaves this module, and the ONLY one that covers every path — the
 * per-group scope filter only runs on the routed pipeline, and the glean
 * (completeness) pass unions its candidates in AFTER runCaptureBase's
 * filters entirely (prod incident: a Program-subgraph glean emitted a
 * `competitor` node, which persisted, got approved, and was then invisible
 * in the Library UI because the view buckets strictly by profile kinds).
 * Pure and exported for unit tests.
 */
export function enforceProfileKinds(
  candidates: Candidate[],
  profile: ContextProfile,
  trace?: CaptureTraceEvent[],
): Candidate[] {
  const allowed = new Set(profile.kinds.map((k) => k.key));
  const dropped: string[] = [];
  const kept = candidates.filter((c) => {
    const n = c.proposed_node as Record<string, unknown>;
    const kind = String(n.type);
    if (allowed.has(kind)) return true;
    dropped.push(`${kind}:${String((n as { title?: string }).title ?? '').slice(0, 50)}`);
    return false;
  });
  if (dropped.length > 0) {
    trace?.push({ stage: 'kind_enforced', profile: profile.id, dropped });
    log.warn('synth.capture.kind_enforced', {
      profile: profile.id,
      dropped: dropped.length,
      kinds: dropped.join(', ').slice(0, 300),
    });
  }
  return kept;
}

/**
 * Whole-document classifier for the simple/generic capture mode: infer a short
 * title + a single free-form category label. Reads only the head of the
 * document — the body is stored verbatim regardless, so a bounded slice is
 * enough to label it, and this keeps the call cheap (Haiku, tiny output).
 */
async function classifyWholeDoc(
  source: string,
  _profile: ContextProfile,
): Promise<{ title: string; category: string }> {
  const { body: template, meta } = loadPromptFile('classify-whole-doc');
  const head = source.slice(0, 8000);
  const parsed = (await callStructured({
    model: MODELS.triage,
    system: template,
    user: `<source>\n${head}\n</source>`,
    toolName: 'emit_label',
    toolDescription: 'Emit the whole-document title and category label.',
    schema: WHOLE_DOC_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 256,
    task: 'classify-whole-doc',
    promptVersion: meta.version,
    inputSummary: { source_chars: source.length },
  })) as { title?: unknown; category?: unknown } | null;
  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  const category =
    typeof parsed?.category === 'string' ? parsed.category.trim().toLowerCase() : '';
  return { title, category };
}

/**
 * Deterministic capture for `log`-shape profiles (today, every workspace —
 * `notes` is the only builtin and `FALLBACK_PROFILE`). Node count used to be
 * left to capture.md's shape-rule wording taking hold on the model; #141
 * traced a live incident to that wording contradicting the base prompt's
 * per-item guidance, and even after dewording the contradiction, cardinality-
 * by-prompt is still a coin a smaller hosted model flips: identical content
 * would occasionally batch into one node, occasionally split one-per-line
 * (a 10-item checklist → 10 nodes), and occasionally yield none. None of that
 * is decidable by better wording, so it isn't asked of the model anymore:
 * exactly one node is built here in code, and the only call left is
 * `classifyWholeDoc`'s cheap title label — never a cardinality judgment.
 */
async function runWholeDocCapture(opts: CaptureOpts): Promise<Candidate[]> {
  const profile = opts.profile ?? FALLBACK_PROFILE;
  const kind = profile.kinds[0]?.key ?? 'note';
  const source = opts.source.trim();
  if (!source) return [];
  // The label call is enrichment, not a gate: a title-classification failure
  // (rate limit, invalid key, timeout) must never cost the document its node —
  // fall back to the source ref/a generic label and keep going.
  let title = '';
  try {
    title = (await classifyWholeDoc(source, profile)).title;
  } catch (err) {
    log.warn('synth.capture.whole_doc_label_failed', { msg: (err as Error).message?.slice(0, 200) });
  }
  const now = new Date().toISOString();
  const node = {
    id: `npv_${randomUUID()}`,
    type: kind,
    created_at: now,
    updated_at: now,
    status: 'active' as const,
    body: source,
    title: title || (opts.sourceRef ?? '').slice(0, 120) || 'Untitled',
  };
  const candidate = {
    id: `cpv_${randomUUID()}`,
    proposed_node: node,
    flag: 'green' as const,
    source_quote: source.slice(0, 4000),
    source_ref: opts.sourceRef ?? '',
    confidence: 1,
  };
  return [candidate as unknown as Candidate];
}

export async function runCapture(opts: CaptureOpts): Promise<Candidate[]> {
  const profile = opts.profile ?? FALLBACK_PROFILE;
  // Kind gate + hygiene on EVERY base path: the routed pipeline sanitizes
  // internally (this re-run is an idempotent no-op there), but the groupless
  // single-call path used to return raw specialist output with neither.
  const base = enforceProfileKinds(await runCaptureBase(opts), profile, opts.trace).map((c) =>
    sanitizeCandidateForProfile(c, profile, opts.trace),
  );
  if (!shouldGlean(base.length, opts.trace, profile)) return base;
  try {
    // Glean output gets the same deterministic gates as the base pass: it is
    // unioned in past every runCaptureBase filter, so without these it can
    // smuggle foreign kinds and invalid subkinds/categories/attrs into the
    // subgraph (see enforceProfileKinds / sanitizeCandidateForProfile above).
    const gleaned = enforceProfileKinds(await runGlean(opts, base), profile, opts.trace).map((c) =>
      sanitizeCandidateForProfile(c, profile, opts.trace),
    );
    if (gleaned.length === 0) return base;
    // Union: drop gleaned candidates that duplicate a base one (kind + normalized text).
    const gkey = (c: Candidate): string => {
      const pn = c.proposed_node as Record<string, unknown>;
      const txt = String((pn.title ?? pn.summary ?? pn.body ?? '') as string)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${String(pn.type)}|${txt}`;
    };
    const seen = new Set(base.map(gkey));
    const added: Candidate[] = [];
    for (const g of gleaned) {
      const k = gkey(g);
      if (!seen.has(k)) {
        seen.add(k);
        added.push(g);
      }
    }
    opts.trace?.push({ stage: 'glean', returned: gleaned.length, added: added.length });
    log.info('synth.capture.gleaned', { base: base.length, returned: gleaned.length, added: added.length });
    return [...base, ...added];
  } catch (err) {
    // Fail open: a gleaning error must never lose the base candidates.
    log.warn('synth.glean.failed_open', { msg: (err as Error).message?.slice(0, 200) });
    return base;
  }
}

/**
 * Completeness pass: given the source and the base pass's candidates, extract
 * ONLY the claims it missed (glean.md). Same schema + canonical-form + flag rules
 * as capture, so gleaned candidates match base-pass quality.
 */
async function runGlean(opts: CaptureOpts, found: Candidate[]): Promise<Candidate[]> {
  const profile = opts.profile ?? FALLBACK_PROFILE;
  const { body: template, meta } = loadPromptFile('glean');
  const system = renderPrompt(
    template,
    captureSlots(profile, undefined, undefined, undefined, opts.graph, opts.dataAgentActive ?? false),
  );
  const already =
    found
      .map((c) => {
        const pn = c.proposed_node as Record<string, unknown>;
        const txt = String((pn.title ?? pn.summary ?? pn.body ?? '') as string).slice(0, 140);
        return `- ${String(pn.type)}: ${txt}`;
      })
      .join('\n') || '(none)';
  const user = `<source_kind>${opts.sourceKind}</source_kind>\n\n<already_found>\n${already}\n</already_found>\n\n<source>\n${opts.source}\n</source>`;
  const parsed = await callStructured({
    model: MODELS.glean,
    system,
    user,
    toolName: 'emit_candidates',
    toolDescription: 'Emit ONLY candidates the first pass missed, in canonical form.',
    schema: CAPTURE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16384,
    task: 'glean',
    promptVersion: meta.version,
    inputSummary: {
      source_kind: opts.sourceKind,
      already_found: found.length,
      source_chars: opts.source.length,
    },
  });
  try {
    return ProfileCapturePayload.parse(parsed).candidates as unknown as Candidate[];
  } catch {
    // Salvage survivors from a partially-malformed payload; never throw away the pass.
    const arr = (parsed as { candidates?: unknown } | null)?.candidates;
    if (!Array.isArray(arr)) return [];
    const elementSchema = ProfileCandidateSchema;
    const kept: Candidate[] = [];
    for (const item of arr) {
      const one = elementSchema.safeParse(item);
      if (one.success) kept.push(one.data as unknown as Candidate);
    }
    return kept;
  }
}

/**
 * Capture entry point for one folder.
 *
 * Until 2026-07-17 this dispatched two ways: templates WITHOUT
 * `extraction_groups` took a single call, and templates WITH them ran a routed
 * pipeline (route-capture → parallel per-group specialists → signature dedup →
 * LLM arbiter merge). Light deleted extraction groups (spec §2: "routing on kind
 * taxonomies, extraction groups, relevance gates ... is gone"), so the grouped
 * branch became unreachable — all four templates declare zero groups — and it
 * went with `runRouteCapture`, its only caller. What died with it, deliberately:
 *
 * - the per-group specialist fan-out, arbiter merge, and cross-group exact-dedup
 *   (nothing to fan out or merge with one call);
 * - the `route-capture.relevant` gate, which decided whether a document deserved
 *   extraction at all. Light asks that question ONCE, at routing, for the whole
 *   document — see `routeDocument`;
 * - deterministic speaker enforcement, which re-attributed evidence quotes to
 *   their true speaker and dropped evidence voiced by our own side. It keyed off
 *   an `evidence` extraction group and `route-capture.internal_stakeholders`, so
 *   it has been inert for every Light template. If a template ever needs it back
 *   it belongs HERE, on the single path, not behind a group.
 */
async function runCaptureBase(opts: CaptureOpts): Promise<Candidate[]> {
  const profile = opts.profile ?? FALLBACK_PROFILE;
  // `log`-shape profiles get the deterministic one-node path (see
  // runWholeDocCapture's docstring) instead of the chunked, model-decided-
  // cardinality extraction below. `items`/`slots` profiles (none built in
  // today, only reachable via an old per-workspace snapshot) are unaffected.
  const candidates =
    profile.shape === 'log' ? await runWholeDocCapture(opts) : await runCaptureSingle(opts);
  // Zero-yield tripwire: a document routed INTO this folder that yields nothing
  // is more often an extraction miss than an empty source, and a silent zero is
  // the hardest ingest failure to diagnose ([[ingest-zero-yield-causes]]).
  //
  // This is the heir of the tripwire that lived in the deleted grouped path —
  // where it could only ever fire for a grouped template, i.e. never, for any
  // Light template. Moving it onto the single path is what makes `zero_yield`
  // (and the caller-facing notice built on it) mean something again. A document
  // that fits NO folder is a different signal entirely and never reaches here:
  // routing drops it, and the ingest reports that separately.
  if (candidates.length === 0) {
    log.warn('synth.capture.zero_yield', {
      source_kind: opts.sourceKind,
      source_chars: opts.source.length,
    });
    opts.trace?.push({ stage: 'zero_yield', source_kind: opts.sourceKind });
  }
  return candidates;
}

async function runCaptureSingle(
  opts: CaptureOpts,
  groupKey?: string,
  sourceGuidance?: string,
): Promise<Candidate[]> {
  const { body: template, meta } = loadPromptFile('capture');
  const profile = opts.profile ?? FALLBACK_PROFILE;
  // Guidance is resolved from the ingestion channel, deterministically. The
  // `sourceGuidance` override is what the deleted routed path passed in from the
  // router's classification; no caller sets it now.
  const guidance = sourceGuidance !== undefined ? sourceGuidance : resolveSourceGuidance(profile, opts.sourceKind);
  const system = renderPrompt(
    template,
    captureSlots(profile, groupKey, guidance, opts.rulePolicy, opts.graph, opts.dataAgentActive ?? false),
  );

  // The founding profile's kinds (goal | positioning | decision) ARE the
  // strict `Node` discriminated union, so it keeps the strict `CapturePayload`
  // parse — founding behaviour stays byte-identical. Any non-founding profile
  // emits kinds outside that union (voice, audience, channel, principle, …);
  // those must be parsed with the generalized `ProfileNode` envelope or they
  // fail the discriminator and get silently dropped in the catch below. See
  // `ProfileCapturePayload` in schemas.ts. Kind validity is enforced
  // downstream against the workspace profile, not here.
  // Escape unescaped double quotes INSIDE string values of a loose JSON
  // string — the model copies markdown like `"Pomegranate."` into
  // source_quote verbatim, which breaks JSON.parse. Heuristic: a quote only
  // closes a string when the next non-whitespace char is a JSON structural
  // character (, } ] :) or end of input; otherwise it is content. A wrong
  // guess yields invalid JSON, which the caller treats as the original
  // failure — this can rescue a chunk, never corrupt a healthy one.
  const repairLooseJson = (s: string): string => {
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (!inStr) {
        if (ch === '"') inStr = true;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        out += ch + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j]!)) j++;
        const next = s[j];
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inStr = false;
          out += ch;
        } else {
          out += '\\"';
        }
        continue;
      }
      out += ch;
    }
    return out;
  };
  const parseCapture = (raw: unknown): Candidate[] => {
    try {
      return ProfileCapturePayload.parse(raw).candidates as unknown as Candidate[];
    } catch (err) {
      // Salvage pass: one malformed candidate (the model occasionally emits a
      // number where a string belongs, or drops a required field) must not
      // throw away the chunk's VALID candidates. Re-validate per element and
      // keep the survivors; only a non-array payload still throws to the
      // chunk-level catch below.
      let arr = (raw as { candidates?: unknown } | null)?.candidates;
      // The model intermittently emits `candidates` as a JSON-encoded STRING
      // instead of an array (observed on content-bearing chunks too, not just
      // prose-only ones) — decode it before giving up on the chunk.
      if (typeof arr === 'string') {
        const rawStr = arr;
        try {
          arr = JSON.parse(rawStr);
        } catch {
          try {
            arr = JSON.parse(repairLooseJson(rawStr));
          } catch {
            throw err;
          }
        }
      }
      if (!Array.isArray(arr)) throw err;
      const elementSchema = ProfileCandidateSchema;
      const kept: Candidate[] = [];
      for (const item of arr) {
        const one = elementSchema.safeParse(item);
        if (one.success) kept.push(one.data as unknown as Candidate);
      }
      log.warn('synth.capture.candidates_salvaged', {
        total: arr.length,
        kept: kept.length,
        dropped: arr.length - kept.length,
        msg: (err as Error).message?.slice(0, 150) ?? 'unknown',
      });
      return kept;
    }
  };

  // Header-aware chunking. Long-form positioning docs (gtm-positioning.md
  // was the canary) reliably overflowed the 8K output cap mid-JSON, breaking
  // the tool_use parse. Splitting on `##` boundaries means each call emits a
  // bounded number of candidates and we dedup at the end.
  const chunks = chunkMarkdown(opts.source);

  // Parallel-fan-out is bounded by Anthropic's per-key concurrency; for a
  // typical doc (1-6 chunks) we just run them all at once. The prompt cache
  // turns this into one expensive call followed by N-1 cheap ones because
  // every chunk shares the same system + tool schema. Since v3 the user
  // message is short (just source_kind + chunk text — no graph payload),
  // so the input footprint per chunk is ~chunk_chars + a few hundred bytes,
  // not chunk_chars + ~20K for the graph as it was in v2.
  const results = await Promise.all(
    chunks.map(async (chunk, i) => {
      const user = `<source_kind>${opts.sourceKind}</source_kind>\n\n<source_chunk index="${i + 1}" of="${chunks.length}" trust="untrusted">\n${chunk}\n</source_chunk>`;
      const attempt = async () => {
        const parsed = await callStructured({
          model: MODELS.capture,
          system,
          user,
          toolName: 'emit_candidates',
          toolDescription: 'Emit candidate graph updates derived from the source.',
          schema: CAPTURE_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: 16384,
          task: 'capture',
          promptVersion: meta.version,
          inputSummary: {
            source_kind: opts.sourceKind,
            extraction_group: groupKey ?? null,
            source_chars_total: opts.source.length,
            chunk_index: i + 1,
            chunk_count: chunks.length,
            chunk_chars: chunk.length,
          },
        });
        return parseCapture(parsed);
      };
      try {
        return await attempt();
      } catch (err) {
        // A transport-level timeout/abort has ALREADY been retried, with the
        // full per-attempt timeout budget, inside the structured-LLM client
        // (HostedStructuredLLM.fetchWithRetry retries `POMEGRANATE_HOSTED_RETRIES`
        // times before giving up). Retrying the whole chunk again here on TOP
        // of that only multiplies the wait (measured: a slow capture call
        // stacked with this outer retry burned 9+ minutes on one document
        // before zero-yielding) for no real chance of a different outcome —
        // the same congestion/latency that caused the first timeout is still
        // there. Give up immediately and record it distinctly so the
        // caller-facing notice can say "this timed out", not "the model
        // found nothing" (see `capture_timeout` in routes.ts summarizeZeroYield).
        if ((err as Error).name === 'AbortError') {
          log.warn('synth.capture.chunk_timeout', {
            chunk: `${i + 1}/${chunks.length}`,
            source_kind: opts.sourceKind,
          });
          opts.trace?.push({ stage: 'capture_timeout', chunk: `${i + 1}/${chunks.length}` });
          return [] as Candidate[];
        }
        // One bad chunk shouldn't poison the whole doc. The model intermittently
        // emits `{candidates: "<string>"}` instead of an array — sometimes with
        // unescaped quotes inside, so even the string-decode salvage in
        // parseCapture can't recover it. It is flaky, not systematic (observed
        // on content-bearing chunks that parse fine on re-run), so retry the
        // chunk ONCE before giving up; only then treat as zero candidates.
        log.warn('synth.capture.chunk_retry', {
          chunk: `${i + 1}/${chunks.length}`,
          source_kind: opts.sourceKind,
          msg: (err as Error).message?.slice(0, 200) ?? 'unknown',
        });
        try {
          return await attempt();
        } catch (err2) {
          if ((err2 as Error).name === 'AbortError') {
            log.warn('synth.capture.chunk_timeout', {
              chunk: `${i + 1}/${chunks.length}`,
              source_kind: opts.sourceKind,
            });
            opts.trace?.push({ stage: 'capture_timeout', chunk: `${i + 1}/${chunks.length}` });
            return [] as Candidate[];
          }
          log.warn('synth.capture.chunk_skipped', {
            chunk: `${i + 1}/${chunks.length}`,
            source_kind: opts.sourceKind,
            msg: (err2 as Error).message?.slice(0, 200) ?? 'unknown',
          });
          return [] as Candidate[];
        }
      }
    }),
  );

  // Dedup: candidates emitted from multiple chunks of the same doc (overlap
  // windows, recurring themes) get collapsed by a normalized body/summary
  // signature. Keep the first occurrence — it carries the earliest source
  // quote and is usually the strongest hit.
  //
  // Graph-aware dedup (the embedding-cosine pass that compares each
  // candidate against the active graph) lives in `dedupAgainstGraph` and
  // is invoked by the API layer where graph embeddings + the embedder
  // dependency are available. runCapture intentionally returns the
  // intra-doc-deduped raw set so the caller can do the graph compare.
  const seen = new Set<string>();
  const dedupedFromChunks: Candidate[] = [];
  for (const candidate of results.flat()) {
    const sig = candidateSignature(candidate);
    if (seen.has(sig)) continue;
    seen.add(sig);
    dedupedFromChunks.push(candidate);
  }
  return dedupedFromChunks;
}

function candidateSignature(c: Candidate): string {
  const pn = c.proposed_node;
  return pn.type === 'goal'
    ? `goal:${normalize(pn.title)}`
    : pn.type === 'decision'
      ? `decision:${normalize(pn.summary)}`
      : `positioning:${pn.kind ?? 'unknown'}:${normalize(pn.body)}`;
}

function normalize(s: string | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Project a candidate's `source_ref` into a short, human-readable label
 * for the LLM-call log. Matches the Today-tab source chip rendering so
 * the log and UI agree on what to call a source.
 */
function sourceLabel(source_ref: string): string {
  if (!source_ref) return 'unknown';
  if (source_ref.startsWith('source:')) return source_ref.slice('source:'.length);
  if (source_ref.startsWith('slack:')) return source_ref.slice('slack:'.length);
  if (source_ref.includes('/')) return source_ref.slice(source_ref.lastIndexOf('/') + 1);
  return source_ref;
}

/**
 * Render the edges a query/feedback prompt is given: what the model needs to
 * resolve currency (which node an edge starts/ends at, and what kind it is).
 * Drops internal bookkeeping (id, timestamps, provenance) that would only cost
 * tokens — the model needs the graph SHAPE, not the edge rows.
 */
function renderEdgesForPrompt(edges: readonly GraphEdgeT[]): string {
  return JSON.stringify(
    edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind })),
    null,
    2,
  );
}

export async function runFeedback(opts: {
  graph: readonly Node[];
  /**
   * Every edge in the subfolder this profile has declared, if any. Optional
   * only for a caller that hasn't been updated.
   */
  edges?: readonly GraphEdgeT[];
  kind?: string;
  deliverable: string;
  /** Workspace context profile. Defaults to FALLBACK_PROFILE. */
  profile?: ContextProfile;
}): Promise<Finding[]> {
  const { body: template, meta } = loadPromptFile('feedback');
  const system = renderPrompt(template, feedbackSlots(opts.profile ?? FALLBACK_PROFILE));
  const graphJson = JSON.stringify(opts.graph, null, 2);
  const edgesJson = renderEdgesForPrompt(opts.edges ?? []);
  const user = `<graph>\n${graphJson}\n</graph>\n\n<edges>\n${edgesJson}\n</edges>\n\n<kind>${opts.kind ?? 'other'}</kind>\n\n<deliverable>\n${opts.deliverable.slice(
    0,
    40000,
  )}\n</deliverable>`;
  const parsed = await callStructured({
    model: MODELS.feedback,
    system,
    user,
    toolName: 'emit_findings',
    toolDescription: 'Emit categorized findings for the deliverable against the graph.',
    schema: FEEDBACK_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8192,
    task: 'feedback',
    promptVersion: meta.version,
    inputSummary: {
      deliverable_kind: opts.kind ?? 'other',
      deliverable_chars: opts.deliverable.length,
      graph_node_count: opts.graph.length,
      edge_count: (opts.edges ?? []).length,
    },
  });
  const result = FeedbackPayload.parse(parsed);
  return result.findings;
}

export async function runQuery(opts: {
  graph: readonly Node[];
  /**
   * Every edge in the subfolder this profile has declared, if any — a vault
   * does not pre-filter, it loads every node and every edge. Optional only
   * for a caller that hasn't been updated.
   */
  edges?: readonly GraphEdgeT[];
  scope: string;
  question: string;
  /** Workspace context profile. Defaults to FALLBACK_PROFILE. */
  profile?: ContextProfile;
  /**
   * Source-RAG excerpts (spec-source-rag-hybrid-answering.md). When present and
   * non-empty, answering runs the always-hybrid path: a second, subordinate
   * SOURCE tier is added to the prompt and the model may cite excerpt ids. When
   * absent/empty the node-only path runs BYTE-IDENTICALLY to before (the source
   * RAG flag being off guarantees this), keeping the query eval gates valid.
   */
  sourceExcerpts?: ReadonlyArray<{ chunk_id: string; source_ref: string; text: string }>;
}): Promise<{
  answer: string;
  cited_node_ids: string[];
  has_answer: boolean;
  cited_chunk_ids?: string[];
  answered_from?: 'canon' | 'source' | 'both' | 'none';
}> {
  const excerpts = opts.sourceExcerpts ?? [];
  const edgesJson = renderEdgesForPrompt(opts.edges ?? []);

  // ── Node-only path ───────────────────────────────────────────────────────
  if (excerpts.length === 0) {
    const { body: template, meta } = loadPromptFile('query');
    const system = renderPrompt(template, querySlots(opts.profile ?? FALLBACK_PROFILE));
    const graphJson = JSON.stringify(opts.graph, null, 2);
    const user = `<graph>\n${graphJson}\n</graph>\n\n<edges>\n${edgesJson}\n</edges>\n\n<scope>${opts.scope}</scope>\n\n<question>\n${opts.question}\n</question>`;
    const parsed = await callStructured({
      model: MODELS.query,
      system,
      user,
      toolName: 'emit_answer',
      toolDescription: 'Emit a graph-grounded answer with citations.',
      schema: QUERY_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2048,
      task: 'query',
      promptVersion: meta.version,
      inputSummary: {
        scope: opts.scope,
        question_chars: opts.question.length,
        graph_node_count: opts.graph.length,
        edge_count: (opts.edges ?? []).length,
      },
    });
    return QueryPayload.parse(parsed);
  }

  // ── Always-hybrid path ──────────────────────────────────────────────────
  const { body: template, meta } = loadPromptFile('query-hybrid');
  const system = renderPrompt(template, querySlots(opts.profile ?? FALLBACK_PROFILE));
  const graphJson = JSON.stringify(opts.graph, null, 2);
  const excerptBlock = excerpts
    .map(
      (e) =>
        `--- excerpt id: ${e.chunk_id} | source: ${JSON.stringify(e.source_ref)} ---\n${e.text}`,
    )
    .join('\n\n');
  const user =
    `<graph>\n${graphJson}\n</graph>\n\n` +
    `<edges>\n${edgesJson}\n</edges>\n\n` +
    `<source_excerpts>\n${excerptBlock}\n</source_excerpts>\n\n` +
    `<scope>${opts.scope}</scope>\n\n<question>\n${opts.question}\n</question>`;
  const parsed = await callStructured({
    model: MODELS.query,
    system,
    user,
    toolName: 'emit_answer',
    toolDescription: "Emit a currency-aware answer citing graph nodes and/or source excerpts.",
    schema: QUERY_HYBRID_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 2048,
    task: 'query',
    promptVersion: meta.version,
    inputSummary: {
      scope: opts.scope,
      question_chars: opts.question.length,
      graph_node_count: opts.graph.length,
      edge_count: (opts.edges ?? []).length,
      source_excerpts: excerpts.length,
    },
  });
  return QueryHybridPayload.parse(parsed);
}

/**
 * Short dashboard description of what the active graph actually contains —
 * concrete, named themes/goals/decisions, NOT a profile-template blurb. See
 * prompts/overview.md. Cached upstream by graph hash (CachedSynth), so this
 * runs once per graph state, not per dashboard view.
 */
// Body excerpt length for a node that carries no summary of its own.
const OVERVIEW_FALLBACK_CHARS = 280;

function oneLine(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The overview's input: one line per node, built from SUMMARIES only — the
 * source document's summary (`attrs.context`, written at routing time), the
 * node's own `summary`, or a short body excerpt as a last resort. Never the
 * full node: under whole-doc capture a node body IS the document, so sending
 * the graph as JSON grew the prompt linearly with the folder (~1.3K tokens a
 * node) until a large folder could not fit at all. Duplicate lines (several
 * nodes captured from one document) are sent once.
 */
export function overviewDigest(graph: readonly Node[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const n of graph) {
    const raw = n as unknown as Record<string, unknown>;
    const attrs = (raw.attrs ?? {}) as Record<string, unknown>;
    const kind = [raw.type, raw.subkind ?? raw.kind].filter((x) => typeof x === 'string' && x).join('/');
    const title = oneLine(raw.title ?? attrs.title);
    let summary = oneLine(attrs.context) || oneLine(raw.summary);
    if (!summary) {
      const body = oneLine(raw.body);
      summary = body.length > OVERVIEW_FALLBACK_CHARS ? `${body.slice(0, OVERVIEW_FALLBACK_CHARS)}…` : body;
    }
    const line = `- [${kind}]${title ? ` ${title}:` : ''} ${summary}`.trimEnd();
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}

export async function runOverview(opts: {
  graph: readonly Node[];
  /** Workspace context profile. Defaults to FALLBACK_PROFILE. */
  profile?: ContextProfile;
}): Promise<{ summary: string }> {
  const { body: template, meta } = loadPromptFile('overview');
  const profile = opts.profile ?? FALLBACK_PROFILE;
  const system = renderPrompt(template, { profile_description: profile.description });
  const parsed = await callStructured({
    model: MODELS.overview,
    system,
    user: `<items>\n${overviewDigest(opts.graph)}\n</items>`,
    toolName: 'emit_overview',
    toolDescription: 'Emit a short, concrete description of the library contents.',
    schema: OVERVIEW_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'overview',
    promptVersion: meta.version,
    inputSummary: { graph_node_count: opts.graph.length },
  });
  const { summary } = OverviewPayload.parse(parsed);
  // Defensive cap: the prompt asks for ≤60 words; a verbose response gets
  // truncated rather than parse-failed (see OverviewPayload in schemas.ts).
  return { summary: summary.trim().slice(0, 600) };
}

// Per-agent instruction block injected into the shared work-agent prompt. Kept
// here (not in the .md) so the four agents share one template and one code path
// (spec-work-agents.md §5.1). Second person throughout — this is the user's own
// work coming back to them.
const WORK_AGENT_INSTRUCTIONS: Record<string, string> = {
  draft:
    'DRAFT. Write a first draft of the deliverable the user asked for' +
    ' ({{doc_type}}), built from their own material in <graph>. Match their' +
    ' vocabulary and prior decisions. Produce a usable first draft, not an' +
    ' outline — the user will edit it. Structure it appropriately for the' +
    " document type. If <input> is empty, draft the most useful {{doc_type}}\n" +
    ' the graph supports.',
  synthesize:
    'SYNTHESIZE. Pull together everything in <graph> that bears on the topic in' +
    ' <input> into ONE coherent document: merge overlapping notes, resolve' +
    ' duplication, and order it so it reads as a single considered piece. Do' +
    ' not invent connections the nodes do not support. If <input> is empty,' +
    ' synthesize the single most prominent theme in the graph.',
  catchup:
    "CATCH-UP. The nodes in <graph> are the user's OWN items that were added or" +
    ' changed recently. Write a short, skimmable recap of where they left off' +
    ' and what has moved — grouped by theme, newest and most consequential' +
    ' first. This is a re-orientation, not an essay: bullets and short lines.' +
    ' If <input> is non-empty, focus the recap on that.',
  followup:
    "FOLLOW-UP. Scan <graph> for the user's OWN open loops: commitments they" +
    ' made, things they owe people, decisions left dangling, questions raised' +
    ' but not resolved. Return them as an actionable checklist, each item tied' +
    ' to the node it came from, ordered by apparent urgency. If <input> names a' +
    ' focus, filter to it. Do NOT fabricate obligations the nodes do not show.',
};

/**
 * Work agent (spec-work-agents.md) — produce a finished artifact (draft /
 * synthesis / catch-up / follow-up) from the CALLER'S OWN graph. Own context
 * only: the route hands us the caller's own active nodes and never crosses
 * folders. Not cached (free-text input, one-shot artifact).
 */
export async function runWorkAgent(opts: {
  agent: 'draft' | 'synthesize' | 'catchup' | 'followup';
  graph: readonly Node[];
  input: string;
  docType?: string;
  profile?: ContextProfile;
}): Promise<{ title: string; output: string; cited_node_ids: string[] }> {
  const { body: template, meta } = loadPromptFile('work-agent');
  const profile = opts.profile ?? FALLBACK_PROFILE;
  const docType = (opts.docType || 'document').trim();
  const agentInstructions = renderPrompt(WORK_AGENT_INSTRUCTIONS[opts.agent] ?? '', {
    doc_type: docType,
  });
  const system = renderPrompt(template, {
    profile_description: profile.description,
    agent_instructions: agentInstructions,
  });
  const graphJson = JSON.stringify(opts.graph, null, 2);
  const user =
    `<graph>\n${graphJson}\n</graph>\n\n` +
    `<agent>${opts.agent}</agent>\n\n` +
    `<input>\n${opts.input}\n</input>`;
  const parsed = await callStructured({
    model: MODELS.workAgent,
    system,
    user,
    toolName: 'emit_artifact',
    toolDescription: "Emit a finished work artifact grounded in the user's own graph.",
    schema: WORK_AGENT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 3072,
    task: 'work_agent',
    promptVersion: meta.version,
    inputSummary: {
      agent: opts.agent,
      input_chars: opts.input.length,
      graph_node_count: opts.graph.length,
    },
  });
  const result = WorkAgentPayload.parse(parsed);
  return {
    title: result.title.trim().slice(0, 200),
    output: result.output.trim(),
    cited_node_ids: result.cited_node_ids,
  };
}

/**
 * Owner-facing narrative of HOW the workspace's context is being used —
 * "your context was called to review 3 PRDs 20 times; it mostly supplied the
 * ICP definition…". Input questions are ANONYMIZED upstream (see
 * context_request_texts in phase1/db/schema.ts) and the prompt forbids any
 * attribution in the output. Cached upstream by usage signature (CachedSynth).
 */
export async function runUsageAnalysis(opts: {
  usage: UsageAnalysisInput;
  profile?: ContextProfile;
}): Promise<{ summary: string }> {
  const { body: template, meta } = loadPromptFile('usage-analysis');
  const profile = opts.profile ?? FALLBACK_PROFILE;
  const system = renderPrompt(template, { profile_description: profile.description });
  const parsed = await callStructured({
    model: MODELS.usage_analysis,
    system,
    user: `<usage>\n${JSON.stringify(opts.usage, null, 2)}\n</usage>`,
    toolName: 'emit_usage_analysis',
    toolDescription: 'Emit a short, concrete narrative of how the context is being used.',
    schema: USAGE_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 512,
    task: 'usage-analysis',
    promptVersion: meta.version,
    inputSummary: {
      request_count: opts.usage.stats.total,
      question_count: opts.usage.questions.length,
    },
  });
  const { summary } = UsageAnalysisPayload.parse(parsed);
  // Same degrade-don't-fail cap as runOverview (prompt asks for ≤90 words).
  return { summary: summary.trim().slice(0, 900) };
}

/**
 * Cluster a workspace's pending candidates into coherent groups for bulk
 * curation. The leader operates at the group level by default; individual
 * candidates remain accessible by expanding a group. See PRD § Curate UI.
 *
 * The LLM is asked to:
 *   1. emit 3-7 groups,
 *   2. cover every input candidate exactly once,
 *   3. pick a recommended_action and explain it.
 *
 * We then enforce the coverage invariant ourselves before returning — any
 * missing or duplicated id is repaired by dropping into a fallback
 * "Uncategorized" group rather than silently losing items.
 */
export async function runGroupCandidates(opts: {
  candidates: ReadonlyArray<{
    id: string;
    flag: 'red' | 'yellow' | 'green';
    type: string;
    kind?: string;
    category?: string;
    priority?: string;
    summary: string;
    source_ref: string;
  }>;
  profile?: ContextProfile;
}): Promise<CandidateGroup[]> {
  if (opts.candidates.length === 0) return [];

  const { body: system, meta } = loadPromptFile('group-candidates');
  const user = `<candidates>\n${JSON.stringify(opts.candidates, null, 2)}\n</candidates>`;

  // Build the "what is being aggregated" summary the conventions doc
  // requires: candidate ids, per-source counts, kind + flag breakdown.
  const sourcesSummary: Record<string, number> = {};
  const kindBreakdown: Record<string, number> = { goal: 0, positioning: 0, decision: 0 };
  const flagBreakdown: Record<string, number> = { red: 0, yellow: 0, green: 0 };
  for (const c of opts.candidates) {
    const srcKey = sourceLabel(c.source_ref);
    sourcesSummary[srcKey] = (sourcesSummary[srcKey] ?? 0) + 1;
    kindBreakdown[c.type] = (kindBreakdown[c.type] ?? 0) + 1;
    flagBreakdown[c.flag] = (flagBreakdown[c.flag] ?? 0) + 1;
  }

  const parsed = await callStructured({
    model: MODELS.grouping,
    system,
    user,
    toolName: 'emit_groups',
    toolDescription:
      'Cluster pending candidates into 3-7 coherent groups with bulk-curation recommendations.',
    schema: GROUPING_SCHEMA as unknown as Record<string, unknown>,
    // 100+ candidate sets produce ~4-5K-token grouping responses (10 groups
    // × multi-sentence summary + id lists). The original 4096 cap meant a
    // server 500 whenever output exceeded the budget. 16K leaves headroom
    // for the realistic upper bound (~200 candidates ≈ 8-10K tokens).
    maxTokens: 16384,
    task: 'group_candidates',
    promptVersion: meta.version,
    inputSummary: {
      candidate_count: opts.candidates.length,
      candidate_ids: opts.candidates.map((c) => c.id),
      sources_summary: sourcesSummary,
      kinds: kindBreakdown,
      flags: flagBreakdown,
    },
  });
  const result = GroupingPayload.parse(parsed);

  // Coverage enforcement: every input id must appear in exactly one group.
  // The PRD treats coverage as zero-tolerance, so we defensively repair
  // here rather than crash downstream when the model misses a candidate.
  const inputIds = new Set(opts.candidates.map((c) => c.id));
  const seen = new Set<string>();
  const groups: CandidateGroup[] = [];
  for (const g of result.groups) {
    const filtered = g.candidate_ids.filter((id) => inputIds.has(id) && !seen.has(id));
    for (const id of filtered) seen.add(id);
    if (filtered.length === 0) continue; // empty group after dedup → drop
    groups.push({ ...g, candidate_ids: filtered });
  }
  const missing = [...inputIds].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    groups.push({
      title: 'Uncategorized',
      summary:
        `${missing.length} candidate(s) the grouping model did not place in any other group. ` +
        `Review individually — the grouping LLM is supposed to cover every candidate, so this ` +
        `is a fallback bucket and a calibration signal.`,
      candidate_ids: missing,
      recommended_action: 'review_individually',
      rationale: 'Grouping LLM left these out of every emitted group.',
    });
  }
  return groups;
}

export { MODELS };
