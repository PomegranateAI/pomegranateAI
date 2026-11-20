/**
 * Dedicated, append-only log of every LLM call. One JSON-line per call.
 *
 * File path:
 *   - POMEGRANATE_LLM_LOG_PATH (env override)
 *   - else ./data/llm.log (sibling of pomegranate.db)
 *
 * What lives here (and what doesn't): see
 * docs/llm-calls.md. Verbatim user content
 * (sources, deliverables, questions) is NOT written here — only structured
 * summaries (counts, names, kinds) and the model's full structured output.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { log } from './log.js';

const DEFAULT_PATH = resolve(process.cwd(), 'data', 'llm.log');
const PATH = process.env.POMEGRANATE_LLM_LOG_PATH ?? DEFAULT_PATH;

let initialized = false;
function ensureDir(): void {
  if (initialized) return;
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    initialized = true;
  } catch (err) {
    log.error('llm_log.init_failed', { path: PATH, msg: (err as Error).message });
    initialized = true; // don't keep retrying
  }
}

export interface LlmCallEntry {
  call_id: string;
  ts: string;
  task: string;
  caller?: string;
  workspace_id?: string;
  user_id?: string;
  mcp_token_id?: string;
  model: string;
  prompt_version?: number;
  context?: Record<string, unknown>;
  /** Structured summary of the user message — NOT the verbatim text. */
  input?: Record<string, unknown>;
  /**
   * Full verbatim prompt (system + user) actually sent to the model. ONLY
   * populated when POMEGRANATE_LLM_LOG_VERBATIM=1 — off by default, since this
   * writes verbatim user content (deliverables, questions, graph) to disk,
   * which the default convention deliberately avoids. For local testing only.
   */
  prompt?: { system: string; user: string };
  /** Parsed structured output from the model (full). Null on error. */
  output: unknown;
  tokens?: {
    input?: number;
    cache_read?: number;
    cache_write?: number;
    output?: number;
  };
  latency_ms: number;
  error?: string;
}

/**
 * Write one record to the LLM log. Failure to write is logged via the
 * server logger but never thrown — logging must not break a successful
 * synthesis call.
 */
export function writeLlmCall(entry: Omit<LlmCallEntry, 'call_id' | 'ts'>): string {
  ensureDir();
  const call_id = `llmcall_${nanoid(12)}`;
  const full: LlmCallEntry = {
    call_id,
    ts: new Date().toISOString(),
    ...entry,
  };
  try {
    appendFileSync(PATH, JSON.stringify(full) + '\n');
  } catch (err) {
    log.error('llm_log.append_failed', {
      path: PATH,
      call_id,
      task: entry.task,
      msg: (err as Error).message,
    });
  }
  return call_id;
}
