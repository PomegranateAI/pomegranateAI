/**
 * changesSince — "what changed in this (workspace, subgraph) since watermark T,
 * under aiRead?". The single shared change-detection primitive for
 * spec-subscribe-to-updates.md (§5.2) and, when it lands, the Wiki M4 currency
 * sweep (spec-wiki.md §11.2). Both features ask the identical question against
 * the identical three signals; this helper is the one place the query lives so
 * we never build it twice.
 *
 * Privacy: nodes are filtered through `repo.nodeVisibleToViewer(..., aiRead)`,
 * so an `only_me` (or another owner's `private`) node never enters a window —
 * an update can only ever surface what the subscriber could read directly.
 */
import type { Repo } from '../db/repo.js';

/** A node that moved in the window, with its parsed data payload. */
export interface ChangedNode {
  id: string;
  updated_at: string;
  data: Record<string, unknown>;
}

/** A document (re-)ingested in the window, scoped to the target subgraph. */
export interface ChangedDocument {
  id: string;
  summary: string | null;
  last_ingested_at: string;
}

export interface ChangeWindow {
  /** Active nodes with `updated_at` strictly after `since`, viewer-visible. */
  nodes: ChangedNode[];
  /** Candidates resolved after `since` (approve/reject counts). */
  resolvedCandidates: { approved: number; rejected: number };
  /** Documents (re-)ingested after `since`, routed to this subgraph. */
  documents: ChangedDocument[];
}

interface NodeRow {
  id: string;
  data: string;
  updated_at: string;
}
interface DocRow {
  id: string;
  summary: string | null;
  last_ingested_at: string;
}

/** Default lookback when a subscription has no watermark yet (first run). */
const DEFAULT_LOOKBACK_MS = 30 * 24 * 3600 * 1000;

export async function changesSince(
  repo: Repo,
  target: { workspace_id: string; subgraph_id: string },
  sinceIso: string | null,
  opts: { viewer_user_id: string; aiRead?: boolean },
): Promise<ChangeWindow> {
  const { workspace_id, subgraph_id } = target;
  const aiRead = opts.aiRead ?? true;
  const since = sinceIso ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();

  // 1. Nodes — active, updated strictly after the watermark, viewer-visible.
  //    The boundary is exclusive so nothing pre-watermark reappears.
  const nodeRows = await repo.listNodesChangedSince(workspace_id, subgraph_id, since) as NodeRow[];
  const nodes: ChangedNode[] = [];
  for (const r of nodeRows) {
    if (await repo.nodeVisibleToViewer(workspace_id, r.id, opts.viewer_user_id, aiRead)) {
      nodes.push({ id: r.id, updated_at: r.updated_at, data: safeParse(r.data) });
    }
  }

  // 2. Resolved candidates — reuse the existing curation-absorption signal.
  const resolvedCandidates = await repo.resolvedCandidatesSince(workspace_id, null, since, subgraph_id);

  // 3. Documents — (re-)ingested after the watermark, routed to this subgraph.
  //    A 'default' subgraph also picks up documents with no routing rows at all
  //    (single-subgraph workspaces route everything to default implicitly).
  const docRows = await repo.listDocumentsIngestedSince(workspace_id, since, subgraph_id) as DocRow[];
  const documents: ChangedDocument[] = docRows.map((r) => ({
    id: r.id,
    summary: r.summary,
    last_ingested_at: r.last_ingested_at,
  }));

  return { nodes, resolvedCandidates, documents };
}

/** Total count of things that moved in a window — the "change_count" number. */
export function changeCount(w: ChangeWindow): number {
  return w.nodes.length + w.documents.length + w.resolvedCandidates.approved + w.resolvedCandidates.rejected;
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
