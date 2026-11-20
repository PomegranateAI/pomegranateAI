/**
 * Per-call context for LLM logging, threaded through AsyncLocalStorage.
 *
 * The request-handler layer sets `{ workspace_id, user_id, caller }` once
 * per request. Endpoint-specific code (e.g. file ingest) layers more
 * context onto that (source_id, source_name) via `withLlmContext`. The
 * synth wrappers in `lib/anthropic.ts` read the active context via
 * `getLlmContext` and stamp it on every LLM-call log line.
 *
 * Why AsyncLocalStorage and not a function parameter: the SynthesisProvider
 * interface has five methods that each take task-specific inputs; adding a
 * `context` arg to all of them ripples through every test, every cache
 * wrapper, every entry point. ALS hides the plumbing — set it at the
 * boundary, every nested LLM call inside that boundary inherits it.
 *
 * Conventions: docs/llm-calls.md § 3.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LlmContext {
  /** Source of the call, e.g. `api.ingest_file`, `mcp.review_deliverable`, `eval.group_judge`. */
  caller?: string;
  /** Authenticated workspace id (`ws_...`) when called from an HTTP request. */
  workspace_id?: string;
  /** Authenticated user id (`u_...`) when called from a session-authed request. */
  user_id?: string;
  /** MCP token id (`mtok_...`) when called from an MCP-token-authed request. */
  mcp_token_id?: string;
  /** Free-form per-call hints: { source_id, source_name, source_kind, deliverable_kind, ... }. */
  context?: Record<string, unknown>;
}

const als = new AsyncLocalStorage<LlmContext>();

/**
 * Run `fn` with the supplied LLM context. Nested calls layer their fields
 * on top of the parent context (child wins on conflict).
 */
export function withLlmContext<T>(ctx: LlmContext, fn: () => T): T {
  const parent = als.getStore() ?? {};
  const merged: LlmContext = {
    caller: ctx.caller ?? parent.caller,
    workspace_id: ctx.workspace_id ?? parent.workspace_id,
    user_id: ctx.user_id ?? parent.user_id,
    mcp_token_id: ctx.mcp_token_id ?? parent.mcp_token_id,
    context: { ...(parent.context ?? {}), ...(ctx.context ?? {}) },
  };
  return als.run(merged, fn);
}

/** Read the active LLM context. Returns an empty object if none is set. */
export function getLlmContext(): LlmContext {
  return als.getStore() ?? {};
}
