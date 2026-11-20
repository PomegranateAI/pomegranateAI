// the seal map.
//
// The exact list of columns that hold customer content and are encrypted with
// the workspace DEK once POMEGRANATE_SEAL=1. A0 drafts it; A7 owns it from G0a.
// Port agents (A4–A6) seal on write / open on read for every entry that falls
// in their module; T2's canary scan fails if a planted canary string shows up
// in plaintext in any column listed here.
//
// Titles stay plaintext (decision B): they drive lists, search and the index
// view, and are short. That is why graph_nodes.data is sealed field-by-field
// (the JSON keeps `title`, `type`, `attrs` readable and seals `body`) rather
// than as a whole.
//
// status:
//   'agreed'   — on the plan's list; port agents implement it.
//   'proposed' — found by the A0 inventory, holds verbatim customer text, not
//                on the plan's list. A7 + owner confirm or drop at G0a review.

export type SealKind =
  /** Whole TEXT column → v1: sealed string. */
  | 'text'
  /** TEXT column holding JSON: only the listed top-level fields are sealed (each becomes a v1: string). */
  | 'json-fields'
  /** BLOB column → PGE1 bytes (sealBytes). */
  | 'bytes';

export interface SealEntry {
  kind: SealKind;
  /** For 'json-fields' only. */
  fields?: readonly string[];
  /** Repo module that owns the table. */
  module: 'identity' | 'structure' | 'graph' | 'ingest' | 'features' | 'media';
  status: 'agreed' | 'proposed';
  note?: string;
}

export const SEAL_MAP_VERSION = 1;

export const SEAL_MAP: Readonly<Record<string, SealEntry>> = Object.freeze({
  // --- node body + content text ---
  'graph_nodes.data': { kind: 'json-fields', fields: ['body'], module: 'graph', status: 'agreed' },
  'graph_nodes.redacted_data': {
    kind: 'json-fields',
    fields: ['body'],
    module: 'graph',
    status: 'agreed',
    note: 'rule-produced redacted variant of data; same shape',
  },
  // --- embeddings ---
  'graph_nodes.embedding': { kind: 'bytes', module: 'graph', status: 'agreed' },
  'source_chunks.embedding': { kind: 'bytes', module: 'ingest', status: 'agreed' },
  // --- extracted chunks (source text lives in the blob store; chunks copy it into the DB) ---
  'source_chunks.text': { kind: 'text', module: 'ingest', status: 'agreed' },
  // --- agent-thread messages (verbatim Slack / WhatsApp bodies) ---
  'agent_thread_messages.body': { kind: 'text', module: 'identity', status: 'agreed' },
  // --- wiki page HTML (wiki_blocks.content JSON; `text` holds the editor HTML) ---
  'wiki_blocks.content': { kind: 'json-fields', fields: ['text'], module: 'features', status: 'agreed' },
  // --- user app credentials (today sealed with POMEGRANATE_CREDENTIALS_KEY; moves to the DEK, item 4.5) ---
  // Not yet ported: the row is per user, not per workspace, and its existing
  // AES-GCM blob also starts with "v1:", so it can't share the seal marker
  // until 4.5 re-encrypts it. Already encrypted at rest meanwhile.
  'user_app_credentials.secret': { kind: 'text', module: 'identity', status: 'agreed', note: 'port deferred to 4.5' },

  // --- found by the A0 inventory; agreed by the owner 2026-10-05 (all 7 kept) ---
  'documents.summary': { kind: 'text', module: 'ingest', status: 'agreed', note: 'LLM summary of the document' },
  'candidates.proposed_node': { kind: 'json-fields', fields: ['body'], module: 'ingest', status: 'agreed' },
  'candidates.source_quote': { kind: 'text', module: 'ingest', status: 'agreed', note: 'verbatim quote' },
  'node_evidence.quote': { kind: 'text', module: 'ingest', status: 'agreed', note: 'verbatim quote' },
  'curation_messages.body': { kind: 'text', module: 'ingest', status: 'agreed' },
  'context_request_texts.request_text': {
    kind: 'text',
    module: 'features',
    status: 'agreed',
    note: 'verbatim user question text',
  },
  'synth_cache.value': { kind: 'text', module: 'ingest', status: 'agreed', note: 'cached LLM output JSON' },
  // --- found during the A4–A6 port (2026-10-07): the attributed usage log keeps
  // the same verbatim question as context_request_texts, so it is sealed the
  // same way. No query filters on it.
  'context_usage_log.request_text': {
    kind: 'text',
    module: 'features',
    status: 'proposed',
    note: 'verbatim user question, attributed copy',
  },
});

/**
 * Files are sealed at the blob layer, not here: every BlobStore object is
 * sealed (C5), which covers document originals and extracted .txt under
 * FILES_DIR/<ws>/ and media originals.
 */
export function sealEntry(column: string): SealEntry | undefined {
  return SEAL_MAP[column];
}
