/**
 * The Report's data shape (spec-data-agents-and-subfolder-wiki.md §4.3).
 * Kept separate from `generate.ts` so `db/repo.ts` can import just the type
 * without pulling in the LLM call machinery.
 */
import { z } from 'zod';

export const ReportBlock = z.object({
  type: z.enum(['paragraph', 'list']).default('paragraph'),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  cited_node_ids: z.array(z.string()).default([]),
});
export type ReportBlock = z.infer<typeof ReportBlock>;

/** One sub-structure within a kind's section — a bucket (§5.1's existing
 *  `buckets` mechanism), or the needs-attention/settled split (`progress`,
 *  §5.2), or a single flat group when the kind declares neither. */
export const ReportGroup = z.object({
  key: z.string(),
  label: z.string(),
  blocks: z.array(ReportBlock),
});
export type ReportGroup = z.infer<typeof ReportGroup>;

export const ReportSection = z.object({
  kind_key: z.string(),
  label: z.string(),
  color: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  groups: z.array(ReportGroup),
});
export type ReportSection = z.infer<typeof ReportSection>;

export const ReportContent = z.object({
  sections: z.array(ReportSection),
  // Sources listing only accompanies an agent-attached report (§4.3) — the
  // no-agent Notes section already IS a 1:1 read of the documents.
  has_sources: z.boolean(),
});
export type ReportContent = z.infer<typeof ReportContent>;
