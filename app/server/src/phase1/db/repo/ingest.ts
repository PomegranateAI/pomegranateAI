// Repo methods: candidates, documents + evidence, synth cache, grouping cache, doc triage, conversational curation.
// Split from repo.ts.
// Methods take `this: Repo` so they can call across modules; repo.ts
// mixes every module class into Repo, so callers still use `repo.method()`.

import { nanoid } from 'nanoid';
import { Node, Candidate } from '../../../lib/schemas.js';
import type { Candidate as CandidateT } from '../../../lib/schemas.js';
import { log } from '../../../lib/log.js';
import {
  parseStoredNode,
  sha256,
} from './shared.js';
import type { Repo } from '../repo.js';
import { openBlob, openJson, openRows, openText, sealBlob, sealJson, sealText } from './sealing.js';

export class IngestRepo {
  // ---------- candidates ----------

  /**
   * The write-time kind gate the graph_nodes schema comment promises: a
   * candidate/node type must be a kind of the target subgraph's stored
   * profile. Returns the offending kind, or null when valid — or when the
   * subgraph has no stored profile (pre-profile workspaces; the founding
   * union is already enforced by the strict Node schema). Capture has its
   * own gate (enforceProfileKinds), but candidates also arrive from the
   * direct API, agents, and sync — this is the one chokepoint they share.
   */
  async invalidKindFor(this: Repo, workspace_id: string, subgraph_id: string, node: unknown): Promise<string | null> {
    const profile = await this.getWorkspaceProfile(workspace_id, subgraph_id);
    const kind = String((node as { type?: unknown } | null)?.type ?? '');
    if (profile?.kinds.some((k) => k.key === kind)) return null;
    // A data agent's structured entries carry ITS kind keys (e.g. "bet"),
    // which the baseline profile never declares — this IS the exclusive-
    // path branch (spec-data-agents-and-subfolder-wiki.md §3), not an
    // invalid candidate. Check the active agent's template as a second,
    // equally-valid taxonomy before rejecting.
    const active = await this.getActiveDataAgent(workspace_id, subgraph_id);
    if (active?.template.kinds.some((k) => k.key === kind)) return null;
    if (!profile && !active) return null; // pre-profile workspace: unchanged behavior
    return kind;
  }

  async insertCandidate(this: Repo, workspace_id: string, candidate: CandidateT, document_id?: string, subgraph_id = 'default'): Promise<void> {
    const badKind = await this.invalidKindFor(workspace_id, subgraph_id, candidate.proposed_node);
    if (badKind !== null) {
      throw new Error(`invalid_kind: '${badKind}' is not a kind of folder '${subgraph_id}'s profile`);
    }
    const now = new Date().toISOString();
    const proposed = await sealJson(this, workspace_id, 'candidates.proposed_node', candidate.id, JSON.stringify(candidate.proposed_node));
    const quote = await sealText(this, workspace_id, 'candidates.source_quote', candidate.id, candidate.source_quote);
    (await this.sql.exec(`INSERT INTO candidates (id, workspace_id, flag, proposed_node, source_quote, source_ref, conflicts_with, confidence, reason, status, proposed_by, created_at, document_id, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'system', ?, ?, ?)`, [candidate.id, workspace_id, candidate.flag, proposed, quote, candidate.source_ref, candidate.conflicts_with ?? null, candidate.confidence, candidate.reason ?? null, now, document_id ?? null, subgraph_id]));
  }

  /**
   * Idempotent upsert of a full candidate row by id — for write-through sync
   * (device → cloud). Unlike insertCandidate (always fresh 'pending'/'system'),
   * this carries the row's real status/resolved_at/document_id/subgraph_id so a
   * re-pushed or already-resolved candidate mirrors exactly.
   */
  async upsertCandidate(this: Repo,
    workspace_id: string,
    row: {
      id: string;
      flag: 'red' | 'yellow' | 'green';
      proposed_node?: unknown;
      source_quote: string;
      source_ref: string;
      conflicts_with?: string | null;
      confidence: number;
      reason?: string | null;
      status?: 'pending' | 'approved' | 'rejected' | 'edited';
      proposed_by?: string;
      created_at?: string;
      resolved_at?: string | null;
      document_id?: string | null;
      subgraph_id?: string;
    },
  ): Promise<void> {
    // Sync mirrors an existing device row, so an invalid kind is logged, not
    // blocked — wedging write-through sync on a legacy row is worse than
    // storing it. The approval gate still keeps such a row out of the graph.
    try {
      const pn = typeof row.proposed_node === 'string' ? JSON.parse(row.proposed_node) : row.proposed_node;
      const badKind = await this.invalidKindFor(workspace_id, row.subgraph_id ?? 'default', pn);
      if (badKind !== null) {
        log.warn('candidate.upsert_invalid_kind', {
          workspace: workspace_id,
          candidate: row.id,
          kind: badKind,
          subgraph: row.subgraph_id ?? 'default',
        });
      }
    } catch {
      /* unparseable proposed_node mirrors as-is; the approval gate covers it */
    }
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO candidates (id, workspace_id, flag, proposed_node, source_quote, source_ref, conflicts_with, confidence, reason, status, proposed_by, created_at, resolved_at, document_id, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           flag = excluded.flag,
           proposed_node = excluded.proposed_node,
           source_quote = excluded.source_quote,
           source_ref = excluded.source_ref,
           conflicts_with = excluded.conflicts_with,
           confidence = excluded.confidence,
           reason = excluded.reason,
           status = excluded.status,
           resolved_at = excluded.resolved_at,
           document_id = excluded.document_id,
           subgraph_id = excluded.subgraph_id`, [row.id, workspace_id, row.flag, await sealJson(this, workspace_id, 'candidates.proposed_node', row.id, typeof row.proposed_node === 'string' ? row.proposed_node : JSON.stringify(row.proposed_node ?? {})), await sealText(this, workspace_id, 'candidates.source_quote', row.id, row.source_quote), row.source_ref, row.conflicts_with ?? null, row.confidence, row.reason ?? null, row.status ?? 'pending', row.proposed_by ?? 'system', row.created_at ?? now, row.resolved_at ?? null, row.document_id ?? null, row.subgraph_id ?? 'default']));
  }

  // ---------- documents (registry) + node_evidence (corroboration ledger) ----------

  /**
   * Register an ingested document. Same (source_ref, sha256) returns the
   * existing row (idempotent re-ingest); same source_ref with a NEW hash
   * registers the next version. Summary/stakeholders come from the capture
   * router and may be empty.
   */
  async registerDocument(this: Repo,
    workspace_id: string,
    doc: { source_ref: string; source_kind: string; sha256: string; summary?: string; stakeholders?: string[]; source_type?: string },
  ): Promise<{ id: string; version: number; existing: boolean }> {
    const prior = (await this.sql.one<any>(`SELECT id, version, sha256, source_type FROM documents WHERE workspace_id = ? AND source_ref = ? ORDER BY version DESC LIMIT 1`, [workspace_id, doc.source_ref])) as { id: string; version: number; sha256: string; source_type: string | null } | undefined;
    const now = new Date().toISOString();
    if (prior && prior.sha256 === doc.sha256) {
      // Idempotent re-ingest (same content, incl. extraction into another
      // subgraph): keep the row but refresh last_ingested_at so the Sources
      // list surfaces it as recently touched, and backfill the router
      // classification onto rows that predate the source_type column (triage
      // keys behavior off it).
      (await this.sql.exec(`UPDATE documents SET last_ingested_at = ?${doc.source_type ? ', source_type = COALESCE(source_type, ?)' : ''} WHERE workspace_id = ? AND id = ?`, [...(doc.source_type ? [now, doc.source_type, workspace_id, prior.id] : [now, workspace_id, prior.id])]));
      return { id: prior.id, version: prior.version, existing: true };
    }
    const id = `doc_${nanoid(10)}`;
    const version = (prior?.version ?? 0) + 1;
    (await this.sql.exec(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, summary, stakeholders, source_type, created_at, last_ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, workspace_id, doc.source_ref, doc.source_kind, doc.sha256, version, await sealText(this, workspace_id, 'documents.summary', id, doc.summary ?? null), doc.stakeholders ? JSON.stringify(doc.stakeholders) : null, doc.source_type ?? null, now, now]));
    return { id, version, existing: false };
  }

  // ─── Source-RAG chunks (spec-source-rag-hybrid-answering.md) ────────────

  /**
   * Idempotent upsert of a document's source chunks. Keyed by the deterministic
   * chunk id (`<document_id>:c<index>`) so a re-ingest of the same version
   * replaces in place. Runs in one transaction.
   */
  async upsertSourceChunks(this: Repo,
    workspace_id: string,
    rows: ReadonlyArray<{
      id: string;
      document_id: string;
      subgraph_ref?: string | null;
      chunk_index: number;
      text: string;
      char_start: number;
      char_end: number;
      embedding: Buffer | null;
      sha256: string;
      created_at: string;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const sql = `INSERT INTO source_chunks
         (id, workspace_id, document_id, subgraph_ref, chunk_index, text, char_start, char_end, embedding, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         document_id = excluded.document_id,
         subgraph_ref = excluded.subgraph_ref,
         chunk_index = excluded.chunk_index,
         text = excluded.text,
         char_start = excluded.char_start,
         char_end = excluded.char_end,
         embedding = excluded.embedding,
         sha256 = excluded.sha256`;
    await this.sql.tx(async (t) => {
      for (const r of rows) {
        await t.exec(sql, [
          r.id,
          workspace_id,
          r.document_id,
          r.subgraph_ref ?? null,
          r.chunk_index,
          await sealText(this, workspace_id, 'source_chunks.text', r.id, r.text),
          r.char_start,
          r.char_end,
          await sealBlob(this, workspace_id, 'source_chunks.embedding', r.id, r.embedding),
          r.sha256,
          r.created_at,
        ]);
      }
    });
  }

  /**
   * The candidate chunk set for source retrieval, with the §2.5 trust gate
   * applied in SQL:
   *   - latest version only — a chunk whose document is superseded by a newer
   *     version of the same source_ref is excluded.
   *   - not from a rejected source — a document with ≥1 rejected candidate and
   *     NO surviving (approved/pending/edited) candidate is treated as rejected
   *     (this is what `reject_source` produces) and excluded. A document that
   *     simply extracted nothing (zero candidates) is NOT rejected — it is the
   *     core source-answerable case and stays in.
   * `viewer` applies the document audience filter as an aiRead (source text
   * feeds an LLM): chunks of a document whose notes are all another member's
   * private/only_me notes, or the viewer's own only_me, are excluded.
   */
  async listSourceChunkRowsForSearch(this: Repo,
    workspace_id: string,
    viewer?: string,
  ): Promise<Array<{
    id: string;
    document_id: string;
    source_ref: string;
    text: string;
    char_start: number;
    char_end: number;
    embedding: Buffer | null;
  }>> {
    const rows = (await this.sql.query<any>(`SELECT sc.id, sc.document_id, sc.text, sc.char_start, sc.char_end, sc.embedding, d.source_ref
           FROM source_chunks sc
           JOIN documents d
             ON d.workspace_id = sc.workspace_id AND d.id = sc.document_id
          WHERE sc.workspace_id = ?
            AND d.version = (
              SELECT MAX(d2.version) FROM documents d2
               WHERE d2.workspace_id = d.workspace_id AND d2.source_ref = d.source_ref
            )
            AND NOT (
              EXISTS (SELECT 1 FROM candidates c
                        WHERE c.workspace_id = d.workspace_id AND c.document_id = d.id
                          AND c.status = 'rejected')
              AND NOT EXISTS (SELECT 1 FROM candidates c2
                        WHERE c2.workspace_id = d.workspace_id AND c2.document_id = d.id
                          AND c2.status IN ('approved', 'pending', 'edited'))
            )${this.documentVisibilityFilter(viewer, { aiRead: true }).sql}`, [workspace_id, ...this.documentVisibilityFilter(viewer, { aiRead: true }).params])) as Array<{
      id: string;
      document_id: string;
      source_ref: string;
      text: string;
      char_start: number;
      char_end: number;
      embedding: Buffer | null;
    }>;
    return openRows(rows, async (r) => {
      r.text = await openText(this, workspace_id, 'source_chunks.text', r.id, r.text);
      r.embedding = await openBlob(this, workspace_id, 'source_chunks.embedding', r.id, r.embedding);
    });
  }

  /**
   * Write-through mirror upsert (device → cloud): store the document under the
   * device's FIXED id. Candidates are mirrored with the device's document_id, so
   * a server-minted id would orphan them — Curate then lists the source as
   * "unknown" and opening it 404s. Same-id re-push refreshes the row in place.
   */
  async upsertDocumentById(this: Repo,
    workspace_id: string,
    doc: {
      id: string;
      source_ref: string;
      source_kind: string;
      sha256: string;
      version?: number;
      summary?: string;
      stakeholders?: string[];
      source_type?: string;
    },
  ): Promise<{ id: string; version: number; existing: boolean }> {
    const now = new Date().toISOString();
    const prior = (await this.sql.one<any>(`SELECT id, version FROM documents WHERE workspace_id = ? AND id = ?`, [workspace_id, doc.id])) as { id: string; version: number } | undefined;
    if (prior) {
      (await this.sql.exec(`UPDATE documents SET source_ref = ?, source_kind = ?, sha256 = ?, version = ?,
             summary = COALESCE(?, summary), stakeholders = COALESCE(?, stakeholders),
             source_type = COALESCE(?, source_type), last_ingested_at = ?
           WHERE workspace_id = ? AND id = ?`, [doc.source_ref, doc.source_kind, doc.sha256, doc.version ?? prior.version, await sealText(this, workspace_id, 'documents.summary', doc.id, doc.summary ?? null), doc.stakeholders ? JSON.stringify(doc.stakeholders) : null, doc.source_type ?? null, now, workspace_id, doc.id]));
      return { id: doc.id, version: doc.version ?? prior.version, existing: true };
    }
    // The device owns the version chain for its rows; without one, continue the
    // server-side chain for this source_ref (matches registerDocument).
    const priorRef = (await this.sql.one<any>(`SELECT version FROM documents WHERE workspace_id = ? AND source_ref = ? ORDER BY version DESC LIMIT 1`, [workspace_id, doc.source_ref])) as { version: number } | undefined;
    const version = doc.version ?? (priorRef?.version ?? 0) + 1;
    (await this.sql.exec(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, summary, stakeholders, source_type, created_at, last_ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [doc.id, workspace_id, doc.source_ref, doc.source_kind, doc.sha256, version, await sealText(this, workspace_id, 'documents.summary', doc.id, doc.summary ?? null), doc.stakeholders ? JSON.stringify(doc.stakeholders) : null, doc.source_type ?? null, now, now]));
    return { id: doc.id, version, existing: false };
  }

  async getDocument(this: Repo,
    workspace_id: string,
    id: string,
  ):
    Promise<| { id: string; source_ref: string; source_kind: string; source_type: string | null; version: number; summary: string | null; stakeholders: string[]; created_at: string }
    | undefined> {
    const r = (await this.sql.one<any>(`SELECT * FROM documents WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as
      | { id: string; source_ref: string; source_kind: string; source_type: string | null; version: number; summary: string | null; stakeholders: string | null; created_at: string }
      | undefined;
    if (!r) return undefined;
    r.summary = await openText(this, workspace_id, 'documents.summary', r.id, r.summary);
    return { ...r, stakeholders: r.stakeholders ? (JSON.parse(r.stakeholders) as string[]) : [] };
  }

  async listDocuments(this: Repo,
    workspace_id: string,
    opts?: { viewer?: string; aiRead?: boolean; teamOnly?: boolean },
  ): Promise<Array<{ id: string; source_ref: string; source_kind: string; source_type: string | null; version: number; summary: string | null; stakeholders: string[]; created_at: string; last_ingested_at: string | null }>> {
    // Ordered by last-ingest recency (falling back to first-seen for pre-column
    // rows), so a re-added source floats to the top of the Sources list the way
    // it does in the Curate inbox. `viewer` applies the document audience
    // filter (documentVisibilityFilter); `teamOnly` restricts to what every
    // member may see. Omit both only for system reads.
    const vis = this.documentVisibilityFilter(opts?.viewer, { aiRead: opts?.aiRead, teamOnly: opts?.teamOnly });
    const rows = (await this.sql.query<any>(`SELECT d.id, d.source_ref, d.source_kind, d.source_type, d.version, d.summary, d.stakeholders, d.created_at, d.last_ingested_at
         FROM documents d WHERE d.workspace_id = ?${vis.sql} ORDER BY COALESCE(d.last_ingested_at, d.created_at) DESC`, [workspace_id, ...vis.params])) as Array<{ id: string; source_ref: string; source_kind: string; source_type: string | null; version: number; summary: string | null; stakeholders: string | null; created_at: string; last_ingested_at: string | null }>;
    await openRows(rows, async (r) => { r.summary = await openText(this, workspace_id, 'documents.summary', r.id, r.summary); });
    return rows.map((r) => ({ ...r, stakeholders: r.stakeholders ? (JSON.parse(r.stakeholders) as string[]) : [] }));
  }

  // ---------- synth cache ----------

  async cacheGet(this: Repo, cache_key: string): Promise<unknown | undefined> {
    const row = (await this.sql.one<any>(`SELECT workspace_id, value FROM synth_cache WHERE cache_key = ? AND ttl_at > datetime('now')`, [cache_key])) as { workspace_id: string; value: string } | undefined;
    // Bound to its cache key (the table's primary key).
    return row ? JSON.parse(await openText(this, row.workspace_id, 'synth_cache.value', cache_key, row.value)) : undefined;
  }

  async cacheSet(this: Repo, opts: { cache_key: string; workspace_id: string; value: unknown; ttlSec: number }): Promise<void> {
    const now = new Date();
    const ttl = new Date(now.getTime() + opts.ttlSec * 1000);
    (await this.sql.exec(`INSERT OR REPLACE INTO synth_cache (cache_key, workspace_id, value, created_at, ttl_at) VALUES (?, ?, ?, ?, ?)`, [opts.cache_key, opts.workspace_id, await sealText(this, opts.workspace_id, 'synth_cache.value', opts.cache_key, JSON.stringify(opts.value)), now.toISOString(), ttl.toISOString()]));
  }

  // ---------- grouping cache (PRD § Curate UI > grouped inbox) ----------

  /**
   * Look up a previously-computed grouping for the workspace's current
   * pending candidate set. Returns null on miss. Callers compute the
   * `signature` via `groupsSignature(pending_ids)`.
   */
  async getGroupsCache(this: Repo,
    workspace_id: string,
    signature: string,
    subgraph_id = 'default',
  ): Promise<{ groups: unknown[]; candidate_count: number; created_at: string } | null> {
    const row = (await this.sql.one<any>(`SELECT groups, candidate_count, created_at FROM candidate_groups WHERE workspace_id = ? AND subgraph_id = ? AND signature = ?`, [workspace_id, subgraph_id, signature])) as
      | { groups: string; candidate_count: number; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      groups: JSON.parse(row.groups) as unknown[],
      candidate_count: row.candidate_count,
      created_at: row.created_at,
    };
  }

  async setGroupsCache(this: Repo, opts: {
    workspace_id: string;
    signature: string;
    groups: unknown;
    candidate_count: number;
    subgraph_id?: string;
  }): Promise<void> {
    const subgraph_id = opts.subgraph_id ?? 'default';
    (await this.sql.exec(`INSERT OR REPLACE INTO candidate_groups (workspace_id, signature, groups, candidate_count, created_at, subgraph_id)
         VALUES (?, ?, ?, ?, datetime('now'), ?)`, [opts.workspace_id, opts.signature, JSON.stringify(opts.groups), opts.candidate_count, subgraph_id]));
  }

  /**
   * Return the most recently written cached groups for this workspace,
   * regardless of which `signature` they were computed against. Powers the
   * "compute once, freeze" behavior in `ensureGroupsForWorkspace` — once
   * a workspace has any cached groups, they're served as-is no matter how
   * the pending set evolves. Returns null if the workspace has never had
   * groups computed.
   */
  async getLatestGroupsCache(this: Repo,
    workspace_id: string,
    subgraph_id = 'default',
  ): Promise<{ groups: unknown[]; candidate_count: number; created_at: string; signature: string } | null> {
    const row = (await this.sql.one<any>(`SELECT groups, candidate_count, created_at, signature
         FROM candidate_groups
         WHERE workspace_id = ? AND subgraph_id = ?
         ORDER BY created_at DESC
         LIMIT 1`, [workspace_id, subgraph_id])) as
      | { groups: string; candidate_count: number; created_at: string; signature: string }
      | undefined;
    if (!row) return null;
    return {
      groups: JSON.parse(row.groups) as unknown[],
      candidate_count: row.candidate_count,
      created_at: row.created_at,
      signature: row.signature,
    };
  }

  // ---------- doc triage (context-aware triage spec) ----------

  /**
   * The triage assessment for one (document, pending-set signature), or null.
   * The assessment is immutable per signature; `answers` accumulate onto the
   * row and replay through the deterministic decision table at read time.
   */
  async getDocTriage(this: Repo,
    workspace_id: string,
    document_id: string,
    signature: string,
    subgraph_id = 'default',
  ): Promise<{ assessment: unknown; answers: Record<string, string>; status: string; created_at: string } | null> {
    const row = (await this.sql.one<any>(`SELECT assessment, answers, status, created_at FROM doc_triage WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ? AND signature = ?`, [workspace_id, document_id, subgraph_id, signature])) as
      | { assessment: string; answers: string | null; status: string; created_at: string }
      | undefined;
    if (!row) return null;
    return {
      assessment: JSON.parse(row.assessment),
      answers: row.answers ? (JSON.parse(row.answers) as Record<string, string>) : {},
      status: row.status,
      created_at: row.created_at,
    };
  }

  async setDocTriage(this: Repo, opts: {
    workspace_id: string;
    document_id: string;
    signature: string;
    assessment: unknown;
    /** Candidate ids the assessment covered — the shrink-reuse key. */
    assessed_ids?: readonly string[];
    subgraph_id?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const subgraph_id = opts.subgraph_id ?? 'default';
    (await this.sql.exec(`INSERT OR REPLACE INTO doc_triage (workspace_id, document_id, subgraph_id, signature, assessment, answers, status, assessed_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?)`, [opts.workspace_id, opts.document_id, subgraph_id, opts.signature, JSON.stringify(opts.assessment), opts.assessed_ids ? JSON.stringify([...opts.assessed_ids]) : null, now, now]));
  }

  /**
   * The most recently updated assessment row for a document, regardless of
   * signature — the shrink-reuse candidate. The caller checks the subset
   * condition (current pending ⊆ assessed_ids) before reusing.
   */
  async latestDocTriageForDoc(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id = 'default',
  ): Promise<{
    signature: string;
    assessment: unknown;
    answers: Record<string, string>;
    status: string;
    assessed_ids: string[] | null;
  } | null> {
    const row = (await this.sql.one<any>(`SELECT signature, assessment, answers, status, assessed_ids FROM doc_triage
         WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`, [workspace_id, document_id, subgraph_id])) as
      | { signature: string; assessment: string; answers: string | null; status: string; assessed_ids: string | null }
      | undefined;
    if (!row) return null;
    return {
      signature: row.signature,
      assessment: JSON.parse(row.assessment),
      answers: row.answers ? (JSON.parse(row.answers) as Record<string, string>) : {},
      status: row.status,
      assessed_ids: row.assessed_ids ? (JSON.parse(row.assessed_ids) as string[]) : null,
    };
  }

  /** Merge one answer onto the row. Returns false when no row exists. */
  async addDocTriageAnswer(this: Repo,
    workspace_id: string,
    document_id: string,
    signature: string,
    question_id: string,
    answer: string,
    subgraph_id = 'default',
  ): Promise<boolean> {
    const existing = await this.getDocTriage(workspace_id, document_id, signature, subgraph_id);
    if (!existing) return false;
    const answers = { ...existing.answers, [question_id]: answer };
    (await this.sql.exec(`UPDATE doc_triage SET answers = ?, updated_at = ? WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ? AND signature = ?`, [JSON.stringify(answers), new Date().toISOString(), workspace_id, document_id, subgraph_id, signature]));
    return true;
  }

  async setDocTriageStatus(this: Repo,
    workspace_id: string,
    document_id: string,
    signature: string,
    status: 'open' | 'committed' | 'discarded',
    subgraph_id = 'default',
  ): Promise<void> {
    (await this.sql.exec(`UPDATE doc_triage SET status = ?, updated_at = ? WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ? AND signature = ?`, [status, new Date().toISOString(), workspace_id, document_id, subgraph_id, signature]));
  }

  // ---------- conversational curation (spec-conversational-curation.md) ----------

  async getCurationConversation(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id = 'default',
  ): Promise<{ document_id: string; case_opened: '1' | '2' | '3'; status: string; created_at: string; updated_at: string } | null> {
    const row = (await this.sql.one<any>(`SELECT document_id, case_opened, status, created_at, updated_at
         FROM curation_conversations WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ?`, [workspace_id, document_id, subgraph_id])) as
      | { document_id: string; case_opened: '1' | '2' | '3'; status: string; created_at: string; updated_at: string }
      | undefined;
    return row ?? null;
  }

  async listCurationConversations(this: Repo,
    workspace_id: string,
    subgraph_id = 'default',
  ): Promise<Array<{ document_id: string; case_opened: '1' | '2' | '3'; status: string; created_at: string; updated_at: string }>> {
    return (await this.sql.query<any>(`SELECT document_id, case_opened, status, created_at, updated_at
         FROM curation_conversations WHERE workspace_id = ? AND subgraph_id = ? ORDER BY updated_at DESC`, [workspace_id, subgraph_id])) as Array<{
      document_id: string;
      case_opened: '1' | '2' | '3';
      status: string;
      created_at: string;
      updated_at: string;
    }>;
  }

  /** Idempotent: a conversation already opened keeps its original case. */
  async createCurationConversation(this: Repo,
    workspace_id: string,
    document_id: string,
    case_opened: '1' | '2' | '3',
    subgraph_id = 'default',
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const r = (await this.sql.exec(`INSERT OR IGNORE INTO curation_conversations (workspace_id, document_id, subgraph_id, case_opened, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`, [workspace_id, document_id, subgraph_id, case_opened, now, now]));
    return r.changes > 0;
  }

  async setCurationConversationStatus(this: Repo, workspace_id: string, document_id: string, status: 'open' | 'resolved', subgraph_id = 'default'): Promise<void> {
    (await this.sql.exec(`UPDATE curation_conversations SET status = ?, updated_at = ? WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ?`, [status, new Date().toISOString(), workspace_id, document_id, subgraph_id]));
  }

  async appendCurationMessage(this: Repo,
    workspace_id: string,
    document_id: string,
    role: 'agent' | 'user' | 'event',
    body: string,
    receipts?: unknown[],
    ui?: unknown,
    subgraph_id = 'default',
  ): Promise<{ id: string; created_at: string }> {
    const id = `cm_${nanoid(12)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO curation_messages (id, workspace_id, document_id, role, body, receipts, ui, created_at, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, workspace_id, document_id, role, await sealText(this, workspace_id, 'curation_messages.body', id, body), receipts ? JSON.stringify(receipts) : null, ui ? JSON.stringify(ui) : null, now, subgraph_id]));
    (await this.sql.exec(`UPDATE curation_conversations SET updated_at = ? WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ?`, [now, workspace_id, document_id, subgraph_id]));
    return { id, created_at: now };
  }

  async listCurationMessages(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id = 'default',
  ): Promise<Array<{
    id: string;
    role: 'agent' | 'user' | 'event';
    body: string;
    receipts: unknown[] | null;
    ui: unknown | null;
    created_at: string;
  }>> {
    const rows = (await this.sql.query<any>(`SELECT id, role, body, receipts, ui, created_at FROM curation_messages
         WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ? ORDER BY rowid ASC`, [workspace_id, document_id, subgraph_id])) as Array<{
      id: string;
      role: 'agent' | 'user' | 'event';
      body: string;
      receipts: string | null;
      ui: string | null;
      created_at: string;
    }>;
    await openRows(rows, async (r) => { r.body = await openText(this, workspace_id, 'curation_messages.body', r.id, r.body); });
    return rows.map((r) => ({
      ...r,
      receipts: r.receipts ? (JSON.parse(r.receipts) as unknown[]) : null,
      ui: r.ui ? (JSON.parse(r.ui) as unknown) : null,
    }));
  }

  /**
   * Candidates of a document resolved after `sinceIso` — the external-change
   * absorption signal for curation threads. resolved_at is SQLite
   * `datetime('now')` ('YYYY-MM-DD HH:MM:SS', UTC); normalize the ISO cursor
   * to that shape for a correct lexicographic comparison.
   */
  async resolvedCandidatesSince(this: Repo,
    workspace_id: string,
    document_id: string | null,
    sinceIso: string,
    subgraph_id = 'default',
  ): Promise<{ approved: number; rejected: number }> {
    const since = sinceIso.slice(0, 19).replace('T', ' ');
    const docClause = document_id === null ? 'document_id IS NULL' : 'document_id = ?';
    const params =
      document_id === null
        ? [workspace_id, subgraph_id, since]
        : [workspace_id, subgraph_id, document_id, since];
    const rows = (await this.sql.query<any>(`SELECT status, COUNT(*) AS n FROM candidates
         WHERE workspace_id = ? AND subgraph_id = ? AND ${docClause} AND status IN ('approved','rejected') AND resolved_at > ?
         GROUP BY status`, [...params])) as Array<{ status: string; n: number }>;
    const out = { approved: 0, rejected: 0 };
    for (const r of rows) {
      if (r.status === 'approved') out.approved = r.n;
      else if (r.status === 'rejected') out.rejected = r.n;
    }
    return out;
  }

  /**
   * Un-integrate an approved candidate (Case 1 "do you want to change
   * anything?" / agent revert_items). Archives the node the approval created
   * (archiveNode also archives its edges) and flips the candidate to
   * 'rejected' — the closest status the schema has; the audit event carries
   * the revert semantics. Evidence rows stay on the archived node. Note: if
   * other approved candidates corroborated the same node, the node is still
   * archived — v1 keeps revert simple and loud rather than partial.
   */
  async revertCandidate(this: Repo, workspace_id: string, id: string, actor?: string): Promise<{ node_id: string }> {
    const row = (await this.sql.one<any>(`SELECT proposed_node, status FROM candidates WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { proposed_node: string; status: string } | undefined;
    if (!row) throw new Error(`Candidate not found: ${id}`);
    if (row.status !== 'approved') throw new Error(`Candidate ${id} is not approved (status: ${row.status})`);
    const node = parseStoredNode(await openJson(this, workspace_id, 'candidates.proposed_node', id, row.proposed_node));
    await this.archiveNode(workspace_id, node.id, actor);
    (await this.sql.exec(`UPDATE candidates SET status='rejected', resolved_at=datetime('now') WHERE workspace_id=? AND id=?`, [workspace_id, id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'candidate.reverted',
      resource_type: 'candidate',
      resource_id: id,
      payload: { node_id: node.id },
    });
    return { node_id: node.id };
  }

  // ---------- moved from api/routes (all SQL in repo/) ----------


  /** Desktop sync pull: every document row of the workspace. */
  async listDocumentRowsForSync(this: Repo, ws: string): Promise<unknown[]> {
    const rows = (await this.sql.query<any>(`SELECT id, source_ref, source_kind, sha256, version, summary, stakeholders, source_type, created_at
         FROM documents WHERE workspace_id = ?`, [ws]));
    return openRows(rows, async (r) => { r.summary = await openText(this, ws, 'documents.summary', r.id, r.summary); });
  }

  /** Desktop sync pull: every candidate row (pending and resolved); proposed_node is raw JSON text. */
  async listCandidateRowsForSync(this: Repo, ws: string): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.sql.query<any>(`SELECT id, flag, proposed_node, source_quote, source_ref, conflicts_with, confidence, reason, status, proposed_by, created_at, resolved_at, document_id, subgraph_id
           FROM candidates WHERE workspace_id = ?`, [ws])) as Array<Record<string, any>>;
    return openRows(rows, async (r) => {
      r.proposed_node = await openJson(this, ws, 'candidates.proposed_node', r.id, r.proposed_node);
      r.source_quote = await openText(this, ws, 'candidates.source_quote', r.id, r.source_quote);
    });
  }

  async getDocumentSha256Row(this: Repo, ws: string, document_id: string): Promise<{ sha256: string } | undefined> {
    return (await this.sql.one<any>(`SELECT sha256 FROM documents WHERE workspace_id = ? AND id = ?`, [ws, document_id])) as
      | { sha256: string }
      | undefined;
  }

  async getSourceBySha256(this: Repo, ws: string, sha256: string): Promise<{ object_path: string; original_name: string | null } | undefined> {
    return (await this.sql.one<any>(`SELECT object_path, original_name FROM sources WHERE workspace_id = ? AND sha256 = ?`, [ws, sha256])) as { object_path: string; original_name: string | null } | undefined;
  }

  async getSourceOriginalName(this: Repo, ws: string, source_id: string): Promise<string | null> {
    const row = (await this.sql.one<any>(`SELECT original_name FROM sources WHERE workspace_id = ? AND id = ?`, [ws, source_id])) as { original_name: string | null } | undefined;
    return row?.original_name ?? null;
  }

  async listDocumentSha256Rows(this: Repo, ws: string): Promise<Array<{ id: string; sha256: string }>> {
    return (await this.sql.query<any>(`SELECT id, sha256 FROM documents WHERE workspace_id = ?`, [ws])) as Array<{
      id: string;
      sha256: string;
    }>;
  }

  async listSourceSha256Rows(this: Repo, ws: string): Promise<Array<{ sha256: string }>> {
    return (await this.sql.query<any>(`SELECT sha256 FROM sources WHERE workspace_id = ?`, [ws])) as Array<{ sha256: string }>;
  }

  /** Candidate counts per (document, status), optionally within one subfolder. */
  async countCandidatesByDocumentStatus(this: Repo, ws: string, subgraph_id?: string): Promise<Array<{ document_id: string; status: string; n: number }>> {
    return (await this.sql.query<any>(`SELECT document_id, status, COUNT(*) AS n FROM candidates
       WHERE workspace_id = ? AND document_id IS NOT NULL ${subgraph_id ? 'AND subgraph_id = ?' : ''}
       GROUP BY document_id, status`, [...(subgraph_id ? [ws, subgraph_id] : [ws])])) as Array<{ document_id: string; status: string; n: number }>;
  }

  /** Source row for an uploaded file (referenced by candidates' source_ref). */
  async insertSource(this: Repo, opts: { id: string; ws: string; kind: string; object_path: string; original_name: string; sha256: string }): Promise<void> {
    (await this.sql.exec(`INSERT INTO sources (id, workspace_id, kind, object_path, original_name, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`, [opts.id, opts.ws, opts.kind, opts.object_path, opts.original_name, opts.sha256]));
  }
}
