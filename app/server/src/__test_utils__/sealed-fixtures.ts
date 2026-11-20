// Values for tests that seed seal-map columns with raw SQL (to control
// timestamps, visibility, ids…). They go through the same sealing helpers the
// repo uses, so a fixture is stored exactly as production would store it:
// unchanged with POMEGRANATE_SEAL=0, sealed with POMEGRANATE_SEAL=1 (the
// sealed CI leg runs the whole suite that way).

import type { Repo } from '../phase1/db/repo.js';
import { sealBlob, sealJson, sealText } from '../phase1/db/repo/sealing.js';

/** graph_nodes.data for row `id` (pass the object or its JSON). */
export function sealedNodeData(repo: Repo, ws: string, id: string, data: object | string): Promise<string> {
  return sealJson(repo, ws, 'graph_nodes.data', id, typeof data === 'string' ? data : JSON.stringify(data));
}

export function sealedNodeEmbedding<T extends Buffer | null>(repo: Repo, ws: string, id: string, embedding: T): Promise<T> {
  return sealBlob(repo, ws, 'graph_nodes.embedding', id, embedding);
}

export function sealedDocumentSummary<T extends string | null | undefined>(repo: Repo, ws: string, docId: string, summary: T): Promise<T> {
  return sealText(repo, ws, 'documents.summary', docId, summary);
}

export function sealedEvidenceQuote(repo: Repo, ws: string, nodeId: string, docId: string, quote: string): Promise<string> {
  return sealText(repo, ws, 'node_evidence.quote', `${nodeId}\u0000${docId}`, quote);
}
