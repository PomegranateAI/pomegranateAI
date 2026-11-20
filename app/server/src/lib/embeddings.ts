/**
 * Embedding provider abstraction, used for semantic search and retrieval
 * (query/source-RAG) across the active graph.
 *
 * Storage: every active `graph_nodes` row carries a `Float32Array`-as-BLOB
 * embedding in the `embedding` column. Computed on `upsertNode` and
 * back-filled at server boot for any rows still missing one.
 *
 * Default provider: OpenAI text-embedding-3-small (1536 dim, ~$0.02 / 1M
 * tokens). Override by exporting an alternative `Embedder` and selecting
 * via `POMEGRANATE_EMBEDDER`. A no-op `StubEmbedder` exists for tests.
 *
 * Conventions: this module is part of the LLM call surface — every batch
 * embedding call writes an `llm.log` row with task=`embed` so cost +
 * latency are observable. See
 * docs/llm-calls.md.
 */
import { writeLlmCall } from './llm-log.js';
import { getLlmContext } from './llm-context.js';
import { log } from './log.js';

export interface Embedder {
  /** Provider name for logging. */
  name: string;
  /** Output dimension. */
  dim: number;
  /**
   * Embed a batch of texts in a single call. Returns one Float32Array per
   * input, in the same order. Throws on transient API errors; callers
   * should catch and fall back to the lexical Jaccard layer.
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

// ─── BLOB encoding (Float32Array ↔ Buffer for SQLite) ──────────────────

/** Pack a Float32Array into a Node Buffer for `BLOB` storage. */
export function embeddingToBlob(v: Float32Array): Buffer {
  // Float32Array's underlying buffer may have a non-zero byteOffset (when
  // it's a view onto a larger buffer); slice to a fresh ArrayBuffer of the
  // exact size so SQLite sees only the embedding bytes.
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Read a `BLOB` back into a Float32Array. Returns null on null input. */
export function blobToEmbedding(b: Buffer | null | undefined): Float32Array | null {
  if (!b || b.length === 0) return null;
  // Copy into a fresh ArrayBuffer so the result is independent of the
  // pooled SQLite buffer.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

// ─── Cosine similarity ────────────────────────────────────────────────

/**
 * Cosine similarity between two same-length embeddings. Returns 0 on
 * mismatched dimensions or zero-norm vectors; never throws.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ─── Request shaping ──────────────────────────────────────────────────

/**
 * Embedding endpoints enforce two separate limits, and a whole-document node
 * can breach either one. text-embedding-3 takes 8191 tokens per input, and a
 * request as a whole takes 300k tokens. Before whole-doc capture a node was a
 * one-line claim and neither mattered; now a single node can be hundreds of
 * thousands of characters, so both are enforced here rather than by the caller.
 */
export const MAX_INPUT_TOKENS = 8000;
const MAX_REQUEST_TOKENS = 250_000;

/**
 * Tokens without a tokenizer. Prose runs about 4 ASCII characters per token,
 * but node bodies are not prose: they carry HTML attributes and, in the worst
 * case seen in production, base64 data URIs, which tokenize near 2 characters
 * per token. Non-ASCII is denser still. The divisors below are deliberately
 * pessimistic — an overestimate costs some truncated tail, an underestimate
 * costs the whole request, which is how 46 nodes went unembedded for a day.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 2 + (text.length - ascii));
}

/** The provider says an input was too long, whatever the wording. */
function isInputTooLong(err: unknown): boolean {
  return /maximum input length|maximum context length|too many tokens/i.test((err as Error)?.message ?? '');
}

/**
 * Estimation can still be beaten by content we have not seen. Rather than
 * trust it absolutely, halve the per-input cap and retry when the provider
 * rejects an input for length: a cheap, bounded way to stay correct without
 * over-truncating every ordinary body to cover a rare one.
 */
async function embedWithCap(
  texts: readonly string[],
  provider: string,
  send: (batch: readonly string[]) => Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  let cap = MAX_INPUT_TOKENS;
  for (let attempt = 0; ; attempt++) {
    try {
      const out: Float32Array[] = [];
      for (const batch of batchByTokens(texts.map((t) => truncateToTokens(t, cap)))) {
        out.push(...(await send(batch)));
      }
      return out;
    } catch (err) {
      if (attempt >= 2 || !isInputTooLong(err)) throw err;
      cap = Math.floor(cap / 2);
      log.warn('embeddings.input_cap_reduced', { provider, cap, attempt: attempt + 1 });
    }
  }
}

/** Cut a text to fit `maxTokens`, keeping the head — for a document, the part that says what it is. */
export function truncateToTokens(text: string, maxTokens = MAX_INPUT_TOKENS): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * Split inputs into requests that stay under the per-request token ceiling.
 * Every input is already capped at MAX_INPUT_TOKENS, so no single one can
 * exceed a request on its own.
 */
export function batchByTokens(texts: readonly string[], maxTokens = MAX_REQUEST_TOKENS): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const cost = estimateTokens(text);
    if (current.length && tokens + cost > maxTokens) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

// ─── OpenAI provider ──────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class OpenAIEmbedder implements Embedder {
  readonly name = 'openai:text-embedding-3-small';
  readonly dim = 1536;
  private readonly apiKey: string;
  private readonly url = 'https://api.openai.com/v1/embeddings';
  private readonly model = 'text-embedding-3-small';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return embedWithCap(texts, this.name, (batch) => this.embedOneRequest(batch));
  }

  /** One HTTP call. Inputs are already capped and the batch already fits. */
  private async embedOneRequest(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const t0 = Date.now();
    const total_chars = texts.reduce((s, t) => s + t.length, 0);
    log.debug('embeddings.batch_start', {
      provider: this.name,
      count: texts.length,
      total_chars,
    });
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenAI embeddings HTTP ${resp.status}: ${body.slice(0, 400)}`);
    }
    const json = (await resp.json()) as OpenAIEmbeddingResponse;
    // The API contract sorts by index, but be defensive — explicitly order.
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    const out = ordered.map((d) => new Float32Array(d.embedding));

    const ctx = getLlmContext();
    const latency_ms = Date.now() - t0;
    const tokens_input = json.usage?.prompt_tokens ?? 0;
    log.info('embeddings.batch_complete', {
      provider: this.name,
      count: out.length,
      total_chars,
      dim: this.dim,
      tokens_input,
      latency_ms,
      workspace: ctx.workspace_id,
      caller: ctx.caller,
    });
    // LLM-log entry per the conventions doc. `embed` is a task like any
    // other; the audit trail should answer "when did we pay for embeddings,
    // how many, what cost". Body content is not logged (per the rule).
    writeLlmCall({
      task: 'embed',
      caller: ctx.caller,
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      mcp_token_id: ctx.mcp_token_id,
      model: this.model,
      prompt_version: undefined,
      context: ctx.context,
      input: { batch_size: texts.length, total_chars },
      output: { dim: this.dim, count: out.length },
      tokens: {
        input: tokens_input,
        cache_read: 0,
        cache_write: 0,
        output: 0,
      },
      latency_ms,
    });
    return out;
  }
}

// ─── Stub provider (for tests and when no key is set) ─────────────────

/**
 * Deterministic stub. Each text gets a fixed-dim embedding derived from a
 * stable hash of the text. Two identical texts produce identical vectors;
 * two different texts produce orthogonal-ish vectors. Useful for unit tests
 * that want to assert "this candidate was deduped because its body matches
 * this existing node" without paying for the real API.
 */
export class StubEmbedder implements Embedder {
  readonly name = 'stub';
  readonly dim = 64;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const t0 = Date.now();
    const out = texts.map((t) => stubEmbedOne(t, this.dim));
    // Debug-only so the very chatty test suite doesn't fill stdout, but the
    // signal is still grep-able when POMEGRANATE_LOG_LEVEL=debug.
    log.debug('embeddings.batch_complete', {
      provider: this.name,
      count: out.length,
      total_chars: texts.reduce((s, t) => s + t.length, 0),
      dim: this.dim,
      latency_ms: Date.now() - t0,
    });
    return out;
  }
}

function stubEmbedOne(text: string, dim: number): Float32Array {
  // Map text → deterministic seed → fill vector with a small PRNG.
  // The vector for the same text is identical across calls (allowing
  // cosine = 1.0 for self-comparison), and different texts produce
  // mostly-orthogonal vectors thanks to the hash-derived seed.
  let seed = 2166136261; // FNV-1a initial
  for (let i = 0; i < text.length; i++) {
    seed = Math.imul(seed ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  const v = new Float32Array(dim);
  let state = seed >>> 0;
  for (let i = 0; i < dim; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    v[i] = ((state >>> 0) / 0xffffffff) * 2 - 1; // [-1, 1]
  }
  // Normalize so cosine math is well-conditioned.
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] = v[i]! / n;
  return v;
}

// ─── Hosted provider (OpenAI-compatible /embeddings, e.g. Together.ai) ──

/**
 * Embedder backed by an OpenAI-compatible `/embeddings` endpoint — the same
 * base URL + key as the hosted-Qwen synthesis seam (lib/hosted-llm.ts), so a
 * dev box with only Together.ai creds can embed without an OpenAI key. Selected
 * when POMEGRANATE_HOSTED_EMBED_MODEL is set. Dimension is discovered from the
 * first response (providers/models vary), so `dim` starts at the configured
 * hint and self-corrects; cosine only needs equal-length vectors, which holds
 * because chunks and the question are embedded by the same instance.
 */
export class HostedEmbedder implements Embedder {
  readonly name: string;
  dim: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string; dim?: number }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.POMEGRANATE_HOSTED_BASE_URL ?? '').replace(/\/$/, '');
    this.apiKey = opts?.apiKey ?? process.env.POMEGRANATE_HOSTED_API_KEY ?? '';
    this.model = opts?.model ?? process.env.POMEGRANATE_HOSTED_EMBED_MODEL ?? '';
    this.dim = opts?.dim ?? Number(process.env.POMEGRANATE_HOSTED_EMBED_DIM ?? '1024');
    if (!this.baseUrl || !this.apiKey || !this.model) {
      throw new Error(
        'HostedEmbedder needs POMEGRANATE_HOSTED_BASE_URL, POMEGRANATE_HOSTED_API_KEY, POMEGRANATE_HOSTED_EMBED_MODEL',
      );
    }
    this.name = `hosted-embed:${this.model}`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return embedWithCap(texts, this.name, (batch) => this.embedOneRequest(batch));
  }

  /** One HTTP call. Inputs are already capped and the batch already fits. */
  private async embedOneRequest(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const t0 = Date.now();
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`hosted embeddings HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    const json = (await resp.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    const out = ordered.map((d) => new Float32Array(d.embedding));
    if (out[0]) this.dim = out[0].length;
    const ctx = getLlmContext();
    writeLlmCall({
      task: 'embed',
      caller: ctx.caller,
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      mcp_token_id: ctx.mcp_token_id,
      model: this.model,
      prompt_version: undefined,
      context: ctx.context,
      input: { batch_size: texts.length, total_chars: texts.reduce((s, t) => s + t.length, 0) },
      output: { dim: this.dim, count: out.length },
      tokens: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
      latency_ms: Date.now() - t0,
    });
    return out;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────

let _embedder: Embedder | null = null;

/**
 * Resolve the active embedder. Order:
 *   1. POMEGRANATE_EMBEDDER=stub → StubEmbedder (tests and offline dev)
 *   2. OPENAI_API_KEY set → OpenAIEmbedder
 *   3. Otherwise → StubEmbedder (with a warn so this doesn't go unnoticed)
 *
 * Memoized so we don't reconstruct on every call.
 */
export function getEmbedder(): Embedder {
  if (_embedder) return _embedder;
  const forced = process.env.POMEGRANATE_EMBEDDER;
  if (forced === 'stub') {
    _embedder = new StubEmbedder();
    log.info('embeddings.provider_selected', { provider: _embedder.name, dim: _embedder.dim, reason: 'POMEGRANATE_EMBEDDER=stub' });
    return _embedder;
  }
  // Hosted (OpenAI-compatible) embeddings — Together.ai etc. Opt-in via
  // POMEGRANATE_HOSTED_EMBED_MODEL so default behavior is unchanged.
  if (forced === 'hosted' || process.env.POMEGRANATE_HOSTED_EMBED_MODEL) {
    _embedder = new HostedEmbedder();
    log.info('embeddings.provider_selected', { provider: _embedder.name, dim: _embedder.dim, reason: forced ? 'forced' : 'hosted_embed_model_set' });
    return _embedder;
  }
  const key = process.env.OPENAI_API_KEY;
  if (forced === 'openai' || (key && !forced)) {
    if (!key) {
      log.warn('embeddings.no_openai_key', {
        msg: 'POMEGRANATE_EMBEDDER=openai requested but OPENAI_API_KEY missing — falling back to stub',
      });
      _embedder = new StubEmbedder();
      log.info('embeddings.provider_selected', { provider: _embedder.name, dim: _embedder.dim, reason: 'fallback_no_key' });
      return _embedder;
    }
    _embedder = new OpenAIEmbedder(key);
    log.info('embeddings.provider_selected', { provider: _embedder.name, dim: _embedder.dim, reason: forced ? 'forced' : 'openai_key_present' });
    return _embedder;
  }
  // Default branch — no key, no override. Use stub but emit a warn at
  // boot so this doesn't silently disable semantic dedup in production.
  log.warn('embeddings.using_stub_default', {
    msg: 'No OPENAI_API_KEY set; semantic dedup degraded to deterministic stub. Set OPENAI_API_KEY in .env to enable real embeddings.',
  });
  _embedder = new StubEmbedder();
  log.info('embeddings.provider_selected', { provider: _embedder.name, dim: _embedder.dim, reason: 'default_stub' });
  return _embedder;
}

/** Test seam: swap the embedder for the duration of a test. */
export function __setEmbedderForTesting(e: Embedder | null): void {
  _embedder = e;
}

/**
 * Install a custom embedder (e.g. an embedding host's local
 * llama.cpp embedder). Memoized like the factory result, so call once at boot
 * before any node is embedded. Pass null to fall back to the env factory.
 */
export function setEmbedder(e: Embedder | null): void {
  _embedder = e;
}

// ─── Helpers for callers ──────────────────────────────────────────────

/**
 * The text we hash into an embedding for a node. Keeping the projection
 * centralized so candidate and node bodies are compared on the same
 * dimension.
 */
export function embeddingTextForNode(n: {
  type: string;
  title?: string;
  summary?: string;
  body?: string;
  kind?: string;
  category?: string;
}): string {
  if (n.type === 'goal') return `goal: ${n.title ?? ''} | ${n.body ?? ''}`;
  if (n.type === 'decision')
    return `decision [${n.category ?? '?'}]: ${n.summary ?? ''} | ${n.body ?? ''}`;
  // positioning
  return `positioning [${n.kind ?? '?'}]: ${n.body ?? ''}`;
}
