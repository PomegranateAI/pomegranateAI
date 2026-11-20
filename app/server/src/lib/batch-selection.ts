// Shared "select relevant items from a batch" step for app connectors that
// fetch a batch of raw content (Slack messages, GitHub files, ...) and let
// the user narrow it by topic instead of hand-picking individual items.
//
// This is deliberately a single one-shot structured LLM call — not the
// heavier add-source-agent tool-use loop (see routes.ts's
// runInstructedIngest), which decides a document's DESTINATION/transform
// after it already exists. This runs BEFORE a document exists, choosing which
// raw items compose it; it only ever keeps or drops whole items, never
// rewrites content, so citations stay traceable to the real source item.

import { z } from 'zod';
import { structuredCall, hasStructuredLLM, MODELS } from './anthropic.js';

export type SelectableItem = { id: string; meta: string; snippet: string };

export class BatchSelectionUnavailable extends Error {
  constructor(kind: string, cause?: string) {
    super(
      `the request names a topic but selection is unavailable${cause ? `: ${cause}` : ''} — refusing to ingest the whole ${kind} batch unfiltered`,
    );
  }
}

const SelectionShape = z.object({ included_ids: z.array(z.string()) });

function selectionSchema(itemNoun: string) {
  return {
    type: 'object',
    properties: {
      included_ids: {
        type: 'array',
        items: { type: 'string' },
        description: `Ids (from the batch, verbatim) of ${itemNoun} relevant to the topic. Empty array if none match.`,
      },
    },
    required: ['included_ids'],
  } as Record<string, unknown>;
}

function renderBatch(items: SelectableItem[]): string {
  return items.map((i) => `[${i.id}] ${i.meta}: ${i.snippet}`).join('\n');
}

/**
 * Topic-based selection over a whole fetched batch. Fail-closed: if no LLM
 * is available or the call errors, this throws rather than silently
 * returning the whole batch (which would mean "unfiltered" content reaching
 * the graph despite the user asking for a narrower subset) or an empty one
 * (which would silently drop everything).
 */
export async function selectRelevantItems<T extends SelectableItem>(
  items: T[],
  topic: string,
  opts: { itemNoun: string; testHook?: (items: T[], topic: string) => Promise<T[]> },
): Promise<T[]> {
  if (opts.testHook) return opts.testHook(items, topic);
  if (!hasStructuredLLM()) throw new BatchSelectionUnavailable(opts.itemNoun, 'no LLM available to select items');
  try {
    const res = await structuredCall({
      model: MODELS.triage,
      system: [
        `You select which ${opts.itemNoun}, from a batch, are relevant to a topic.`,
        `Emit exactly one select_items call with the ids of only the ${opts.itemNoun} that are`,
        'genuinely relevant. Be conservative: when in doubt, leave one out.',
        'Never invent an id that was not in the batch.',
      ].join(' '),
      user: `Topic: ${topic}\n\n${opts.itemNoun}:\n${renderBatch(items)}`,
      toolName: 'select_items',
      toolDescription: `Emit the ids of the ${opts.itemNoun} relevant to the topic.`,
      schema: selectionSchema(opts.itemNoun),
      maxTokens: 1024,
      task: 'batch-select-items',
    });
    const parsed = SelectionShape.safeParse(res.output);
    if (!parsed.success) throw new Error('malformed selection output');
    const keep = new Set(parsed.data.included_ids);
    return items.filter((i) => keep.has(i.id));
  } catch (err) {
    if (err instanceof BatchSelectionUnavailable) throw err;
    throw new BatchSelectionUnavailable(opts.itemNoun, err instanceof Error ? err.message : String(err));
  }
}
