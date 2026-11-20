/**
 * Update synthesis (spec §5.4 / §9). Turns the topical changed set into a
 * grounded, cited `{ title, body, cited_node_ids, is_empty }` update.
 *
 * Two paths, same output shape:
 *  - `synthesizeUpdate` — the structured LLM (gated on hasStructuredLLM),
 *    logged like every other synthesis path (withLlmContext + writeLlmCall).
 *  - a deterministic fallback used when no structured LLM is wired (dev /
 *    offline / tests) — a plain roll-up of the changed node titles + counts,
 *    citing the real node ids, so the pipeline stays runnable and testable.
 */
import { hasStructuredLLM, structuredCall, promptMeta, loadPromptBody } from '../../lib/anthropic.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { log } from '../../lib/log.js';

const MODEL = 'claude-haiku-4-5-20251001';

export interface UpdateChangeNode {
  id: string;
  title: string;
  snippet: string;
}
export interface UpdateDigestInput {
  topic: string;
  window: { from: string | null; to: string };
  nodes: UpdateChangeNode[];
  documents: Array<{ id: string; summary: string | null }>;
  resolvedCandidates: { approved: number; rejected: number };
}
export interface UpdateDigest {
  title: string;
  body: string;
  cited_node_ids: string[];
  is_empty: boolean;
}

export const UPDATE_DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Specific headline for this update, ≤ 12 words.' },
    body: {
      type: 'string',
      description: 'The update text (markdown allowed), 1–4 short paragraphs. Empty string when is_empty.',
    },
    cited_node_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'The node ids the body relies on. Empty when is_empty.',
    },
    is_empty: {
      type: 'boolean',
      description: 'True when nothing in the changes is genuinely about the topic.',
    },
  },
  required: ['title', 'body', 'cited_node_ids', 'is_empty'],
  additionalProperties: false,
} as const;

/**
 * Synthesize the update. Callers should already have run relevance filtering;
 * an empty `nodes`+`documents` input returns an empty (never-delivered) digest.
 */
export async function synthesizeUpdate(input: UpdateDigestInput): Promise<UpdateDigest> {
  const hasChanges = input.nodes.length > 0 || input.documents.length > 0;
  if (!hasChanges) {
    return { title: input.topic, body: '', cited_node_ids: [], is_empty: true };
  }
  if (!hasStructuredLLM()) return fallbackDigest(input);

  const system = loadPromptBody('update-digest');
  const version = promptMeta('update-digest').version;
  const user = JSON.stringify(
    {
      topic: input.topic,
      window: input.window,
      changes: {
        nodes: input.nodes.map((n) => ({ id: n.id, title: n.title, text: n.snippet })),
        documents: input.documents.map((d) => ({ id: d.id, summary: d.summary })),
        resolved_candidates: input.resolvedCandidates,
      },
    },
    null,
    2,
  );

  try {
    const res = await structuredCall({
      model: MODEL,
      system,
      user: `<update_request>\n${user}\n</update_request>`,
      toolName: 'emit_update',
      toolDescription: 'Emit the synthesized topic update for the subscriber.',
      schema: UPDATE_DIGEST_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1024,
      task: 'update-digest',
    });

    const digest: UpdateDigest =
      res.noToolUse || !res.output
        ? { title: input.topic, body: '', cited_node_ids: [], is_empty: true }
        : (() => {
            const out = res.output as Record<string, unknown>;
            return {
              title: String(out.title ?? input.topic).slice(0, 140),
              body: String(out.body ?? ''),
              cited_node_ids: Array.isArray(out.cited_node_ids)
                ? (out.cited_node_ids as unknown[]).map(String)
                : [],
              is_empty: Boolean(out.is_empty),
            };
          })();

    // Log the call — counts + ids only, never node titles/bodies (customer
    // content stays out of llm.log per conventions/llm-calls.md).
    const ctx = getLlmContext();
    writeLlmCall({
      task: 'update-digest',
      caller: ctx.caller ?? 'updates.scheduler',
      workspace_id: ctx.workspace_id,
      user_id: ctx.user_id,
      mcp_token_id: ctx.mcp_token_id,
      model: res.modelLabel,
      prompt_version: version,
      context: ctx.context,
      input: { node_changes: input.nodes.length, doc_changes: input.documents.length },
      output: { is_empty: digest.is_empty, cited: digest.cited_node_ids.length },
      tokens: res.tokens,
      latency_ms: res.latency_ms,
    });

    if (res.noToolUse || !res.output) {
      log.warn('updates.synth_no_tool_use', {});
      return fallbackDigest(input);
    }
    // Grounding guard: a non-empty body with zero citations is not trustworthy;
    // treat it as empty rather than deliver an uncited update.
    if (!digest.is_empty && digest.body.trim() && digest.cited_node_ids.length === 0) {
      log.warn('updates.synth_uncited', {});
      return fallbackDigest(input);
    }
    return digest;
  } catch (err) {
    log.warn('updates.synth_failed', { msg: (err as Error).message?.slice(0, 200) });
    return fallbackDigest(input);
  }
}

/** Deterministic roll-up — grounded in the real changed node ids. */
export function fallbackDigest(input: UpdateDigestInput): UpdateDigest {
  const parts: string[] = [];
  const cited: string[] = [];
  if (input.nodes.length) {
    const lead = input.nodes.slice(0, 5);
    for (const n of lead) cited.push(n.id);
    const bullets = lead.map((n) => `- ${n.title}${n.snippet ? ` — ${n.snippet}` : ''}`).join('\n');
    const more = input.nodes.length > lead.length ? `\n- …and ${input.nodes.length - lead.length} more` : '';
    parts.push(`Changes on "${input.topic}":\n${bullets}${more}`);
  }
  if (input.documents.length) {
    parts.push(
      `${input.documents.length} document${input.documents.length === 1 ? '' : 's'} (re-)ingested in this window.`,
    );
  }
  const { approved, rejected } = input.resolvedCandidates;
  if (approved || rejected) {
    parts.push(`Curation: ${approved} approved, ${rejected} rejected.`);
  }
  const body = parts.join('\n\n');
  const total = input.nodes.length + input.documents.length;
  return {
    title: `${input.topic} — ${total} change${total === 1 ? '' : 's'}`,
    body,
    cited_node_ids: cited,
    is_empty: !body.trim(),
  };
}
