/**
 * HostedStructuredLLM — an OpenAI-compatible remote backend for the engine's
 * structured-output seam (`StructuredLLMOverride`).
 *
 * The cloud engine's `callStructured` (lib/anthropic.ts) forces schema-valid JSON
 * via Anthropic tool-use by default. Installing this override at boot routes every
 * structured call — capture, routing, dedup, feedback, query, the curation agent —
 * through an OpenAI-compatible chat-completions endpoint instead (Together, a
 * self-hosted model server, or any compatible API).
 *
 * The call shape is identical to the Anthropic path: (system, user, schema) in,
 * parsed schema-valid object out. Because the override is non-null, the engine's
 * `usingLocalLLM()` gate flips true and the curation agent takes its
 * grammar-friendly structured loop instead of Anthropic native tool-use — which
 * is exactly right, since an OpenAI-compatible endpoint can't express tool-use.
 *
 * Config (env):
 *   POMEGRANATE_HOSTED_BASE_URL    e.g. https://api.together.xyz/v1
 *   POMEGRANATE_HOSTED_API_KEY     provider key
 *   POMEGRANATE_HOSTED_MODEL       e.g. Qwen/Qwen2.5-7B-Instruct (provider's id)
 *   POMEGRANATE_HOSTED_SCHEMA_MODE json_schema (default) | json_object_schema |
 *                                  guided_json | json_object | none
 *   POMEGRANATE_HOSTED_TEMP        default 0.2
 *   POMEGRANATE_HOSTED_RETRIES     default 2
 *   POMEGRANATE_HOSTED_TIMEOUT_MS  default 45000 — non-thinking calls (routing, dedup, capture, ...).
 *                                  A healthy Qwen call answers in <1-5s, so this ceiling only
 *                                  needs to be big enough to absorb load, not to wait out a hang
 *                                  (2026-07-16 incident: the old 300000x4 let a hung upstream
 *                                  burn 25 min PER call, stalling the serialized ingest queue
 *                                  for an hour — see hosted-llm-retry-storm memory).
 *   POMEGRANATE_HOSTED_THINKING_TIMEOUT_MS  default 2x the above — for tasks that still
 *                                  think (see NO_THINK_TASKS below), which need a longer
 *                                  ceiling for the <think> trace
 *   POMEGRANATE_HOSTED_CONCURRENCY default 2
 *   POMEGRANATE_HOSTED_BREAKER_THRESHOLD    default 5 (consecutive failures → open)
 *   POMEGRANATE_HOSTED_BREAKER_COOLDOWN_MS  default 30000 (fail-fast window while open)
 *   POMEGRANATE_LLM_THINKING       0 to discourage <think> everywhere
 */
import type { StructuredLLMOverride } from './anthropic.js';

export interface HostedLLMOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  schemaMode?: 'json_schema' | 'json_object_schema' | 'guided_json' | 'json_object' | 'none';
  temperature?: number;
}

type StructuredOpts = {
  model: string;
  system: string;
  user: string;
  images?: Array<{ mime: string; data: string }>;
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  task: string;
};

export class HostedStructuredLLM implements StructuredLLMOverride {
  readonly name: string;
  readonly supportsImages = true;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly schemaMode: NonNullable<HostedLLMOptions['schemaMode']>;
  private readonly temperature: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly thinkingTimeoutMs: number;
  private readonly concurrency: number;
  // Circuit breaker: a hung upstream must not burn the full timeout×retry budget
  // on every call. After `breakerThreshold` consecutive failed calls the breaker
  // opens and calls fail instantly for `breakerCooldownMs`, so one dead-upstream
  // window degrades fast instead of clogging the serialized ingest queue for
  // tens of minutes (2026-07-16 incident). A single success closes it.
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(opts: HostedLLMOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.POMEGRANATE_HOSTED_BASE_URL ?? '').replace(/\/$/, '');
    this.apiKey = opts.apiKey ?? process.env.POMEGRANATE_HOSTED_API_KEY ?? '';
    this.model = opts.model ?? process.env.POMEGRANATE_HOSTED_MODEL ?? '';
    const defaultSchemaMode = this.baseUrl.includes('together') ? 'json_object_schema' : 'json_schema';
    this.schemaMode =
      opts.schemaMode ??
      (process.env.POMEGRANATE_HOSTED_SCHEMA_MODE as HostedLLMOptions['schemaMode']) ??
      defaultSchemaMode;
    this.temperature = opts.temperature ?? Number(process.env.POMEGRANATE_HOSTED_TEMP ?? '0.2');
    this.retries = Number(process.env.POMEGRANATE_HOSTED_RETRIES ?? '2');
    // 45s, not 5 min: a healthy Qwen call answers in <1-5s, so a lower ceiling
    // detects a hung upstream in seconds. At the old 300000x4 a dead endpoint
    // stalled 25 min PER call, and each ingest runs ~5 sequential LLM stages —
    // one bad window clogged the whole (serialized) ingest queue for an hour.
    this.timeoutMs = Number(process.env.POMEGRANATE_HOSTED_TIMEOUT_MS ?? '45000');
    // A thinking call spends tokens on a <think> trace BEFORE the JSON answer
    // even starts, so it routinely takes 2-3x as long as a non-thinking call
    // on the SAME endpoint. Capture used to be the one thinking task and was
    // the one that reliably tripped the flat `timeoutMs` under concurrent
    // load (2026-07-17 incident: a 1138-char document burned 561s and
    // zero-yielded in BOTH its target subgraphs) — capture is now in
    // NO_THINK_TASKS below, but this longer ceiling still applies to any
    // other task that thinks. Default is 2x the base timeout; override
    // independently if needed.
    this.thinkingTimeoutMs = Number(
      process.env.POMEGRANATE_HOSTED_THINKING_TIMEOUT_MS ?? String(this.timeoutMs * 2),
    );
    this.concurrency = Number(process.env.POMEGRANATE_HOSTED_CONCURRENCY ?? '2');
    this.breakerThreshold = Number(process.env.POMEGRANATE_HOSTED_BREAKER_THRESHOLD ?? '5');
    this.breakerCooldownMs = Number(process.env.POMEGRANATE_HOSTED_BREAKER_COOLDOWN_MS ?? '30000');
    if (!this.baseUrl || !this.apiKey || !this.model) {
      throw new Error(
        'HostedStructuredLLM needs POMEGRANATE_HOSTED_BASE_URL, POMEGRANATE_HOSTED_API_KEY, POMEGRANATE_HOSTED_MODEL',
      );
    }
    this.name = `hosted:${this.model}`;
  }

  async callStructured(opts: StructuredOpts): Promise<unknown> {
    // Reasoning is pure cost/latency — and a truncation/timeout hazard
    // (2026-07-17 incident: a 1138-char capture doc burned 561s and
    // zero-yielded). Disable thinking for these tasks, including capture.
    // POMEGRANATE_LLM_THINKING=0 forces it off everywhere.
    const NO_THINK_TASKS = new Set([
      'route-document',
      'route-to-subgraphs',
      'merge-candidates',
      'dedup_judge',
      'doc-triage',
      'triage',
      'rule_eval',
      'rule_redact',
      'rule_classify',
      'capture',
    ]);
    const wantThinking =
      process.env.POMEGRANATE_LLM_THINKING !== '0' && !NO_THINK_TASKS.has(opts.task);

    // Reasoning models (Qwen3.x) spend tokens on a <think> trace BEFORE emitting
    // the JSON answer, so a thinking call needs generous headroom; a non-thinking
    // call can use the engine's per-call ceiling directly.
    const maxTokens = wantThinking ? Math.max(opts.maxTokens ?? 0, 8192) : (opts.maxTokens ?? 8192);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.images?.length
          ? [{ type: 'text', text: opts.user }, ...opts.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }))]
          : opts.user },
      ],
      temperature: this.temperature,
      max_tokens: maxTokens,
      // Qwen3.x thinking toggle (honored by Together's chat template).
      ...(wantThinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    };

    // Hosted JSON-schema engines (xgrammar/outlines) are stricter than a local
    // GBNF compiler: they reject `null` inside an `enum` ("could not translate the
    // enum None") even when the type union allows null. Strip those — nullability
    // is still carried by `type: [..., "null"]`.
    const schema = sanitizeSchemaForHosted(opts.schema);

    // Structured-output constraint — the analogue of Anthropic's forced tool-use.
    // Providers differ; pick the mode that matches yours.
    switch (this.schemaMode) {
      case 'json_schema': // OpenAI-style structured outputs
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.toolName || 'output', strict: true, schema },
        };
        break;
      case 'json_object_schema': // Fireworks / Together native: json_object + schema
        body.response_format = { type: 'json_object', schema };
        break;
      case 'guided_json': // vLLM / SGLang OpenAI servers
        body.guided_json = schema;
        body.response_format = { type: 'json_object' };
        break;
      case 'json_object':
        body.response_format = { type: 'json_object' };
        break;
      case 'none':
        break;
    }

    const json = await this.fetchWithRetry(body, wantThinking ? this.thinkingTimeoutMs : this.timeoutMs);
    const choice = json.choices?.[0]?.message ?? {};
    // Reasoning models (Qwen3.x) put the answer in `content` and the think trace
    // in `reasoning`; fall back to reasoning only if content is empty.
    const content = choice.content || choice.reasoning || '';
    return parseJsonLoose(content);
  }

  /**
   * POST with a per-request timeout + retry/backoff. Hosted serverless endpoints
   * (esp. for big reasoning models) intermittently 503 / drop connections under
   * load; a single shallow retry isn't enough. Retries transport errors and
   * 408/409/425/429/5xx; a concurrency gate avoids bursting the provider with
   * all of a document's chunk requests at once.
   */
  private async fetchWithRetry(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
  }> {
    // Breaker open → fail instantly (before taking a concurrency slot), so a
    // dead upstream costs ~0ms per call during the cooldown rather than the full
    // timeout×retry budget. A non-retryable failure the caller degrades on.
    this.assertCircuitClosed();
    const release = await this.acquire();
    try {
      // A call may have waited in the concurrency queue while another call
      // opened the breaker. Do not send it upstream after the wait.
      this.assertCircuitClosed();
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        let retryable = true;
        try {
          const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: ac.signal,
          });
          if (res.ok) {
            const json = (await res.json()) as Awaited<ReturnType<typeof this.fetchWithRetry>>;
            this.onCallSuccess();
            return json;
          }
          const txt = await res.text().catch(() => '');
          // Retry on transient server/rate errors; fail fast on 4xx client errors.
          if (![408, 409, 425, 429, 500, 502, 503, 504].includes(res.status)) {
            retryable = false;
            lastErr = new Error(`hosted LLM ${res.status}: ${txt.slice(0, 300)}`);
          } else {
            lastErr = new Error(`hosted LLM ${res.status}: ${txt.slice(0, 200)}`);
          }
        } catch (err) {
          lastErr = err; // transport ("fetch failed") or abort timeout
        } finally {
          clearTimeout(timer);
        }
        // Client/configuration errors are not evidence of an upstream outage.
        if (!retryable) throw lastErr;
        if (attempt < this.retries) {
          const backoff = Math.min(20000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      // Every attempt exhausted → one logical failure for the breaker.
      this.onCallFailure();
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } finally {
      release();
    }
  }

  private assertCircuitClosed(): void {
    const openFor = this.breakerOpenUntil - Date.now();
    if (openFor > 0) {
      throw new Error(
        `hosted LLM circuit open — ${this.consecutiveFailures} consecutive failures, cooling down ${Math.ceil(openFor / 1000)}s`,
      );
    }
  }

  /** A successful call closes the breaker and clears the failure streak. */
  private onCallSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  /** A failed call extends the streak; at the threshold the breaker opens. */
  private onCallFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.breakerThreshold) {
      this.breakerOpenUntil = Date.now() + this.breakerCooldownMs;
    }
  }

  // Tiny concurrency gate so a document's parallel chunk calls don't burst the endpoint.
  private active = 0;
  private waiters: Array<() => void> = [];
  private async acquire(): Promise<() => void> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    return () => {
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

/** Deep-copy a JSON Schema, dropping `null` from any `enum` array (hosted schema
 *  engines can't translate it). Nullability stays expressed via `type` unions. */
function sanitizeSchemaForHosted(node: unknown): any {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForHosted);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'enum' && Array.isArray(v)) {
        const cleaned = v.filter((x) => x !== null);
        out[k] = cleaned.length ? cleaned : v; // keep original if it was all-null
      } else {
        out[k] = sanitizeSchemaForHosted(v);
      }
    }
    return out;
  }
  return node;
}

/** Extract the JSON object from a chat response: strip <think> blocks and code
 *  fences, then parse from the first balanced object. */
function parseJsonLoose(raw: string): unknown {
  let s = raw.trim();
  // Drop a leading <think>…</think> reasoning segment (Qwen3).
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Drop markdown code fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    // Salvage: parse from the first { to its matching }.
    const start = s.indexOf('{');
    if (start === -1) throw new Error(`hosted LLM returned no JSON object: ${s.slice(0, 200)}`);
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
    throw new Error(`hosted LLM returned unbalanced JSON: ${s.slice(0, 200)}`);
  }
}
