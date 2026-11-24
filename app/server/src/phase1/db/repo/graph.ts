// Repo methods: graph nodes, node visibility, edges, reviews, finding rejections, blast-radius signals.
// Split from repo.ts.
// Methods take `this: Repo` so they can call across modules; repo.ts
// mixes every module class into Repo, so callers still use `repo.method()`.

import { nanoid } from 'nanoid';
import { Node, Candidate } from '../../../lib/schemas.js';
import type {
  Node as NodeT,
  Candidate as CandidateT,
  Finding as FindingT,
  GraphEdge as GraphEdgeT,
  EdgeOrigin as EdgeOriginT,
  EdgeKindDef as EdgeKindDefT,
} from '../../../lib/schemas.js';
import { resolveEdgeKinds, validateEdge } from '../../../lib/edges.js';
import { emailDomain, isPersonalEmailDomain } from '../../../lib/email-domain.js';
import {
  Workspace,
  parseStoredNode,
  rowToEdge,
} from './shared.js';
import type Database from 'better-sqlite3';
import type { SqlValue } from '../../../platform/db.js';
import type { Repo } from '../repo.js';
import { openBlob, openJson, openRows, openText, sealBlob, sealJson } from './sealing.js';

export class GraphRepo {
  // ---------- graph nodes ----------

  async insertNode(this: Repo, workspace_id: string, node: NodeT, actor?: string, embedding?: Buffer | null, subgraph_id = 'default'): Promise<void> {
    const now = new Date().toISOString();
    const data = await sealJson(this, workspace_id, 'graph_nodes.data', node.id, JSON.stringify(node));
    const emb = await sealBlob(this, workspace_id, 'graph_nodes.embedding', node.id, embedding ?? null);
    (await this.sql.exec(`INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at, superseded, embedding, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [node.id, workspace_id, node.type, node.status, data, node.created_at ?? now, node.updated_at ?? now, node.superseded ?? null, emb, subgraph_id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'graph.node.created',
      resource_type: 'graph_node',
      resource_id: node.id,
    });
  }

  async upsertNode(this: Repo, workspace_id: string, node: NodeT, actor?: string, embedding?: Buffer | null, subgraph_id = 'default'): Promise<void> {
    const existing = await this.getNode(workspace_id, node.id);
    if (existing) {
      await this.updateNode(workspace_id, node.id, node, actor, embedding);
    } else {
      await this.insertNode(workspace_id, node, actor, embedding, subgraph_id);
    }
  }

  /**
   * Set or replace just the embedding column for an existing node. Used by
   * the boot-time backfill so we can lazily fill missing embeddings on
   * older rows without rewriting the rest of the row.
   */
  async setNodeEmbedding(this: Repo, workspace_id: string, id: string, embedding: Buffer): Promise<void> {
    const emb = await sealBlob(this, workspace_id, 'graph_nodes.embedding', id, embedding);
    (await this.sql.exec(`UPDATE graph_nodes SET embedding = ? WHERE workspace_id = ? AND id = ?`, [emb, workspace_id, id]));
  }

  /**
   * Like `listNodes` but also returns each row's stored embedding (as a
   * Buffer; null if not yet computed). Used by the dedup pass.
   */
  /**
   * Visibility filter for viewer-facing node reads (unified sharing model,
   * spec-unified-sharing-and-always-sync.md). Returns an `AND (...)` SQL fragment
   * + bind params to append to a query over `graph_nodes`. Modes:
   *   - default (no opts)  → no filter (system reads: dedup, signals, backfill)
   *   - { teamOnly: true } → only visibility='team' (workspace-overview synthesis)
   *   - { viewer: uid }    → a HUMAN/UI read: team OR everything the viewer owns
   *                          (incl. their 'only_me' nodes — they see them in the app).
   *   - { viewer: uid, aiRead: true } → an LLM-FACING read: team OR the viewer's
   *                          own nodes EXCEPT 'only_me'. 'only_me' is human-eyes-only
   *                          and must never be fed to the owner's own agents.
   *   - { aiRead: true } with NO viewer → team only. An LLM-facing read that
   *                          forgot its viewer fails CLOSED instead of reading
   *                          everyone's private/only_me nodes. The single-user
   *                          local engine (POMEGRANATE_SINGLE_USER=1) is the one
   *                          exception: it owns its whole DB and never passes a viewer.
   * A cloud-native node (visibility default 'team') passes for everyone, so
   * existing graphs read identically.
   */
  async visibilityFilter(this: Repo, opts?: { viewer?: string; teamOnly?: boolean; aiRead?: boolean }): Promise<{
    sql: string;
    params: SqlValue[];
  }> {
    if (opts?.teamOnly) return { sql: " AND visibility = 'team'", params: [] };
    if (opts?.aiRead && !opts.viewer && process.env.POMEGRANATE_SINGLE_USER !== '1') {
      return { sql: " AND visibility = 'team'", params: [] };
    }
    if (opts?.viewer) {
      if (opts.aiRead)
        return {
          sql: " AND (visibility = 'team' OR (owner_user_id = ? AND visibility <> 'only_me'))",
          params: [opts.viewer],
        };
      return {
        sql: ' AND (visibility = \'team\' OR owner_user_id = ?)',
        params: [opts.viewer],
      };
    }
    return { sql: '', params: [] };
  }

  async listNodesWithEmbeddings(this: Repo,
    workspace_id: string,
    opts?: { activeOnly?: boolean; viewer?: string; teamOnly?: boolean; aiRead?: boolean },
    subgraph_id = 'default',
  ): Promise<Array<{ node: NodeT; embedding: Buffer | null }>> {
    const vis = await this.visibilityFilter(opts);
    const rows = (await this.sql.query<any>(`SELECT id, data, embedding FROM graph_nodes WHERE workspace_id = ? AND subgraph_id = ? ${
          opts?.activeOnly ? "AND status = 'active'" : ''
        }${vis.sql} ORDER BY updated_at DESC`, [workspace_id, subgraph_id, ...vis.params])) as Array<{ id: string; data: string; embedding: Buffer | null }>;
    const out: Array<{ node: NodeT; embedding: Buffer | null }> = [];
    for (const r of rows) {
      out.push({
        node: parseStoredNode(await openJson(this, workspace_id, 'graph_nodes.data', r.id, r.data)),
        embedding: await openBlob(this, workspace_id, 'graph_nodes.embedding', r.id, r.embedding),
      });
    }
    return out;
  }

  /**
   * The set of active-node ids whose originating (approved) candidate carried
   * a `red` flag. Used by embedding-ranked context packing (spec B6.2) to
   * guarantee every red-flagged node is included in a packed slice regardless
   * of its cosine rank. The node id is read out of the candidate's stored
   * `proposed_node` JSON — the approve flow re-ids the node before upsert, so
   * that JSON carries the final persisted node id.
   */
  async redFlaggedNodeIds(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<Set<string>> {
    const rows = (await this.sql.query<any>(`SELECT proposed_node FROM candidates
         WHERE workspace_id = ? AND subgraph_id = ? AND status = 'approved' AND flag = 'red'`, [workspace_id, subgraph_id])) as Array<{ proposed_node: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      try {
        const id = (JSON.parse(r.proposed_node) as { id?: string }).id;
        if (id) out.add(id);
      } catch {
        // skip unparseable rows
      }
    }
    return out;
  }

  /**
   * List active nodes that are missing an embedding. Used by the boot-time
   * backfill in api/server.ts.
   */
  async listActiveNodesMissingEmbedding(this: Repo): Promise<Array<{ workspace_id: string; node: NodeT }>> {
    const rows = (await this.sql.query<any>(`SELECT id, workspace_id, data FROM graph_nodes WHERE status = 'active' AND embedding IS NULL`)) as Array<{ id: string; workspace_id: string; data: string }>;
    const out: Array<{ workspace_id: string; node: NodeT }> = [];
    for (const r of rows) {
      out.push({ workspace_id: r.workspace_id, node: parseStoredNode(await openJson(this, r.workspace_id, 'graph_nodes.data', r.id, r.data)) });
    }
    return out;
  }

  /**
   * The originating document of a node (set on approve from the candidate's
   * registry row). Edge inference uses it as provenance for llm edges.
   */
  async getNodeDocumentId(this: Repo, workspace_id: string, id: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT document_id FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { document_id: string | null } | undefined;
    return row?.document_id ?? undefined;
  }

  /**
   * The active node ids extracted from a given document, in the current
   * subgraph-agnostic workspace scope. Backs source-level ("share this whole
   * source") fan-out: the caller sets the same audience on every returned node.
   *
   * Matches across EVERY document version sharing the requested document's
   * source_ref, not just the exact id. A re-ingest with changed content mints a
   * new document id (registerDocument: doc_<nanoid>, version+1) while older
   * nodes keep the previous version's id — so an exact-id match would return []
   * (→ the caller's 404 "no nodes for document") whenever the Sources UI shares
   * the latest version but the nodes were captured under an earlier one.
   * Sharing "this source" should mean all of its nodes regardless of version.
   */
  async listNodeIdsByDocument(this: Repo, workspace_id: string, document_id: string): Promise<string[]> {
    const rows = (await this.sql.query<any>(`SELECT gn.id FROM graph_nodes gn
           WHERE gn.workspace_id = ? AND gn.status = 'active'
             AND gn.document_id IN (
               SELECT d.id FROM documents d
                 WHERE d.workspace_id = ?
                   AND d.source_ref = (
                     SELECT source_ref FROM documents
                       WHERE workspace_id = ? AND id = ?))`, [workspace_id, workspace_id, workspace_id, document_id])) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * Active node ids corroborated by a document THROUGH THE EVIDENCE LEDGER
   * (node_evidence), complementing listNodeIdsByDocument (which keys off the
   * node's own document_id). The wiki fill spine is the union of the two so a
   * node restated by, but not first-extracted from, a document still counts as
   * "in the document." Matches on the document's source_ref (any version).
   */
  async listNodeIdsByDocumentEvidence(this: Repo, workspace_id: string, document_id: string): Promise<string[]> {
    const rows = (await this.sql.query<any>(`SELECT DISTINCT ne.node_id AS id FROM node_evidence ne
           JOIN graph_nodes gn ON gn.workspace_id = ne.workspace_id AND gn.id = ne.node_id
           WHERE ne.workspace_id = ? AND gn.status = 'active'
             AND ne.document_id IN (
               SELECT d.id FROM documents d
                 WHERE d.workspace_id = ?
                   AND d.source_ref = (
                     SELECT source_ref FROM documents WHERE workspace_id = ? AND id = ?))`, [workspace_id, workspace_id, workspace_id, document_id])) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * The active node ids of a given kind (graph_nodes.type = the profile kind
   * key, subgraph-agnostic in the current workspace scope). Backs category-level
   * ("share every node in this category") fan-out, mirroring listNodeIdsByDocument.
   */
  async listNodeIdsByKind(this: Repo, workspace_id: string, kind: string): Promise<string[]> {
    const rows = (await this.sql.query<any>(`SELECT id FROM graph_nodes WHERE workspace_id = ? AND type = ? AND status = 'active'`, [workspace_id, kind])) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async getNode(this: Repo, workspace_id: string, id: string): Promise<NodeT | undefined> {
    const row = (await this.sql.one<any>(`SELECT data FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { data: string } | undefined;
    if (!row) return undefined;
    return parseStoredNode(await openJson(this, workspace_id, 'graph_nodes.data', id, row.data));
  }

  /**
   * The subgraph a node lives in, or undefined if it doesn't exist in this
   * workspace at all. Exists for the `amends` edge's write-time isolation
   * check: capture only ever sees ONE subfolder's nodes, so an `amends` id
   * naming a node in a DIFFERENT subgraph is fabricated model output, not a
   * legitimate cross-subgraph reference — see CLAUDE.md's isolation invariant
   * and spec-pomegranate-light.md §4's "refuse, not downgrade" rule.
   */
  async getNodeSubgraph(this: Repo, workspace_id: string, id: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT subgraph_id FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { subgraph_id: string } | undefined;
    return row?.subgraph_id;
  }

  async listNodes(this: Repo,
    workspace_id: string,
    opts?: { activeOnly?: boolean; viewer?: string; teamOnly?: boolean; aiRead?: boolean },
    subgraph_id = 'default',
  ): Promise<NodeT[]> {
    const vis = await this.visibilityFilter(opts);
    const rows = (await this.sql.query<any>(`SELECT id, data, owner_user_id, redacted_data FROM graph_nodes WHERE workspace_id = ? AND subgraph_id = ? ${
          opts?.activeOnly ? "AND status = 'active'" : ''
        }${vis.sql} ORDER BY updated_at DESC`, [workspace_id, subgraph_id, ...vis.params])) as {
      id: string;
      data: string;
      owner_user_id: string | null;
      redacted_data: string | null;
    }[];
    // Use-phase redaction (spec §5.3c): a viewer who is NOT the node's owner
    // sees the materialized redacted copy when one exists. The owner (and local
    // single-user reads, viewer undefined) always see the full data. NULL
    // redacted_data → serve full → byte-identical until a rule produces a variant.
    const out: NodeT[] = [];
    for (const r of rows) {
      const redacted = !!(r.redacted_data && opts?.viewer && opts.viewer !== r.owner_user_id);
      out.push(
        parseStoredNode(
          redacted
            ? await openJson(this, workspace_id, 'graph_nodes.redacted_data', r.id, r.redacted_data!)
            : await openJson(this, workspace_id, 'graph_nodes.data', r.id, r.data),
        ),
      );
    }
    return out;
  }

  /**
   * Store (or clear, with null) the use-phase redacted copy of a node's JSON.
   * Served to non-owner viewers by listNodes; see spec §5.3c.
   */
  async setNodeRedaction(this: Repo, workspace_id: string, id: string, redacted_data: string | null): Promise<void> {
    const sealed = await sealJson(this, workspace_id, 'graph_nodes.redacted_data', id, redacted_data);
    (await this.sql.exec(`UPDATE graph_nodes SET redacted_data = ? WHERE workspace_id = ? AND id = ?`, [sealed, workspace_id, id]));
  }

  /** The full stored node JSON + its owner (for materializing redaction). */
  async getNodeForRedaction(this: Repo,
    workspace_id: string,
    id: string,
  ): Promise<{ node: NodeT; owner_user_id: string | null; visibility: string } | undefined> {
    const r = (await this.sql.one<any>(`SELECT data, owner_user_id, visibility FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { data: string; owner_user_id: string | null; visibility: string } | undefined;
    if (!r) return undefined;
    return {
      node: parseStoredNode(await openJson(this, workspace_id, 'graph_nodes.data', id, r.data)),
      owner_user_id: r.owner_user_id,
      visibility: r.visibility,
    };
  }

  async updateNode(this: Repo,
    workspace_id: string,
    id: string,
    node: NodeT,
    actor?: string,
    embedding?: Buffer | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const data = await sealJson(this, workspace_id, 'graph_nodes.data', id, JSON.stringify(node));
    // If `embedding` is undefined, preserve the existing value (don't blank it).
    // If `embedding` is a Buffer or null, overwrite explicitly.
    const res =
      embedding === undefined
        ? (await this.sql.exec(`UPDATE graph_nodes SET type=?, status=?, data=?, updated_at=?, superseded=? WHERE workspace_id=? AND id=?`, [node.type, node.status, data, now, node.superseded ?? null, workspace_id, id]))
        : (await this.sql.exec(`UPDATE graph_nodes SET type=?, status=?, data=?, updated_at=?, superseded=?, embedding=? WHERE workspace_id=? AND id=?`, [node.type, node.status, data, now, node.superseded ?? null, await sealBlob(this, workspace_id, 'graph_nodes.embedding', id, embedding), workspace_id, id]));
    if (res.changes === 0) throw new Error(`Node not found in workspace ${workspace_id}: ${id}`);
    await this.logAudit(workspace_id, {
      actor,
      event: 'graph.node.updated',
      resource_type: 'graph_node',
      resource_id: id,
    });
  }

  /**
   * `supersededBy`, when given, stamps the node's `superseded` column with the
   * id of the node that replaces it (update_node's MCP path). Plain archives
   * (manual delete, ingest amends) leave it null — same as before this param
   * existed.
   */
  async archiveNode(this: Repo, workspace_id: string, id: string, actor?: string, supersededBy?: string): Promise<void> {
    const node = await this.getNode(workspace_id, id);
    if (!node) return;
    node.status = 'archived';
    if (supersededBy) node.superseded = supersededBy;
    await this.updateNode(workspace_id, id, node, actor);
    // Edges pointing at an archived node are stale by definition.
    await this.archiveEdgesForNode(workspace_id, id);
    await this.logAudit(workspace_id, {
      actor,
      event: 'graph.node.archived',
      resource_type: 'graph_node',
      resource_id: id,
      payload: supersededBy ? { superseded_by: supersededBy } : undefined,
    });
  }

  // ---------- node visibility / sharing (graph sync, Phase 2) ----------
  //
  // All sharing enforcement lives here, on the server (unified sharing model,
  // spec-unified-sharing-and-always-sync.md). A node's audience is the
  // `visibility` column alone — three tiers: 'team' (everyone), 'private' (owner
  // + owner's AI agents), 'only_me' (owner in the UI only, hidden from agents).

  /** Current sharing state of a node. Defaults match a cloud-native node. */
  async getNodeVisibility(this: Repo,
    workspace_id: string,
    node_id: string,
  ): Promise<{ visibility: 'team' | 'private' | 'only_me'; owner_user_id: string | null } | undefined> {
    const r = (await this.sql.one<any>(`SELECT visibility, owner_user_id FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, node_id])) as
      | { visibility: 'team' | 'private' | 'only_me'; owner_user_id: string | null }
      | undefined;
    return r;
  }

  /**
   * Set a node's audience. `owner_user_id` is the publishing member; once set it
   * is sticky (a teammate can't silently re-own a node). Idempotent.
   *
   * Passing `owner_user_id` CLAIMS an ownerless node for that member. Only
   * the ingester may be assigned this way: the ingest paths pass the ingesting
   * member, update_node's successor inherits the original's owner, and the
   * audience-change routes in curation.ts pass the node's document ingester
   * (getNodeIngester), never the caller. An admin changing an ownerless node's
   * audience must not become its owner.
   */
  async setNodeVisibility(this: Repo,
    workspace_id: string,
    node_id: string,
    visibility: 'team' | 'private' | 'only_me',
    owner_user_id?: string,
    actor?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`UPDATE graph_nodes
           SET visibility = ?,
               owner_user_id = COALESCE(owner_user_id, ?),
               updated_at = ?
         WHERE workspace_id = ? AND id = ?`, [visibility, owner_user_id ?? null, now, workspace_id, node_id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'graph.node.visibility_set',
      resource_type: 'graph_node',
      resource_id: node_id,
      payload: { visibility },
    });
  }

  /**
   * Whether `viewer` may read `node_id`. The single read-side policy:
   *   - visibility='team'    → any workspace member (membership checked upstream)
   *   - visibility='private' → the owner (and, for AI reads, the owner's agents)
   *   - visibility='only_me' → the owner in the UI; hidden from AI reads even for
   *                            the owner (`aiRead` true → false regardless of owner)
   * A cloud-native node (visibility default 'team', owner NULL) is visible to
   * all, preserving today's behavior.
   */
  async nodeVisibleToViewer(this: Repo,
    workspace_id: string,
    node_id: string,
    viewer_user_id: string,
    aiRead = false,
  ): Promise<boolean> {
    const v = await this.getNodeVisibility(workspace_id, node_id);
    if (!v) return false;
    if (v.visibility === 'team') return true;
    if (aiRead && v.visibility === 'only_me') return false; // human-eyes-only
    return !!v.owner_user_id && v.owner_user_id === viewer_user_id;
  }

  /**
   * Audience filter for DOCUMENT reads (raw text, summaries, source chunks).
   * Documents carry no audience of their own; a document's audience is the
   * union of the notes it produced (graph_nodes.document_id):
   *   - it has ≥1 note the viewer may see (team, or theirs) → visible;
   *   - it has notes, none visible to the viewer → hidden;
   *   - it has NO notes (zero-yield, held, or not yet captured) → visible only
   *     to whoever ingested it, unless that ingest was explicitly 'team'.
   *     Legacy rows with no recorded ingester stay visible, as before. A held
   *     route that asked for private/only_me hides it from everyone else too.
   * `aiRead` excludes the viewer's own only_me material, as for nodes.
   * Returns an `AND (...)` fragment over a `documents` table aliased `alias`.
   * No viewer → no filter (system reads + the single-user local engine).
   *
   * `teamOnly` → what EVERY workspace member may see, independent of any
   * viewer (it takes precedence over `viewer`): a document with ≥1 team note,
   * or a note-less document ingested as 'team' (or a legacy row with no
   * recorded ingester) that no pending private/only_me route is holding. Used
   * for team-audience generated content (wiki plan/fill of team pages).
   */
  documentVisibilityFilter(this: Repo, viewer: string | undefined, opts?: { aiRead?: boolean; alias?: string; teamOnly?: boolean }): { sql: string; params: SqlValue[] } {
    const d = opts?.alias ?? 'd';
    if (opts?.teamOnly) {
      return {
        sql: ` AND (
        EXISTS (SELECT 1 FROM graph_nodes gn WHERE gn.workspace_id = ${d}.workspace_id AND gn.document_id = ${d}.id AND gn.visibility = 'team')
        OR (
          NOT EXISTS (SELECT 1 FROM graph_nodes gn2 WHERE gn2.workspace_id = ${d}.workspace_id AND gn2.document_id = ${d}.id)
          AND (${d}.ingested_by IS NULL OR ${d}.audience = 'team')
          AND NOT EXISTS (SELECT 1 FROM pending_routes pr WHERE pr.workspace_id = ${d}.workspace_id AND pr.document_id = ${d}.id
                            AND pr.status = 'pending' AND pr.audience IN ('private', 'only_me'))
        )
      )`,
        params: [],
      };
    }
    if (!viewer) return { sql: '', params: [] };
    const nodeOk = opts?.aiRead
      ? "(gn.visibility = 'team' OR (gn.owner_user_id = ? AND gn.visibility <> 'only_me'))"
      : "(gn.visibility = 'team' OR gn.owner_user_id = ?)";
    const ownOk = opts?.aiRead
      ? `(${d}.ingested_by = ? AND COALESCE(${d}.audience, '') <> 'only_me')`
      : `${d}.ingested_by = ?`;
    return {
      sql: ` AND (
        EXISTS (SELECT 1 FROM graph_nodes gn WHERE gn.workspace_id = ${d}.workspace_id AND gn.document_id = ${d}.id AND ${nodeOk})
        OR (
          NOT EXISTS (SELECT 1 FROM graph_nodes gn2 WHERE gn2.workspace_id = ${d}.workspace_id AND gn2.document_id = ${d}.id)
          AND (${d}.ingested_by IS NULL OR ${d}.audience = 'team' OR ${ownOk})
          AND NOT EXISTS (SELECT 1 FROM pending_routes pr WHERE pr.workspace_id = ${d}.workspace_id AND pr.document_id = ${d}.id
                            AND pr.status = 'pending' AND pr.audience IN ('private', 'only_me')
                            AND COALESCE(pr.ingested_by, '') <> ?)
        )
      )`,
      params: [viewer, viewer, viewer],
    };
  }

  /** True when `viewer` may read document `document_id` (see documentVisibilityFilter; `teamOnly` → every member may). */
  async documentVisibleToViewer(this: Repo, workspace_id: string, document_id: string, viewer: string | undefined, aiRead = false, opts?: { teamOnly?: boolean }): Promise<boolean> {
    const f = this.documentVisibilityFilter(viewer, { aiRead, teamOnly: opts?.teamOnly });
    const r = await this.sql.one<any>(`SELECT 1 AS ok FROM documents d WHERE d.workspace_id = ? AND d.id = ?${f.sql}`, [workspace_id, document_id, ...f.params]);
    return !!r;
  }

  /**
   * Who ingested the document a node was extracted from (documents.ingested_by),
   * or undefined when the node has no document or the ingest predates the stamp.
   * The natural owner of an ownerless node: an audience change by an admin hands
   * the node to the person who brought the content in, never to the admin.
   */
  async getNodeIngester(this: Repo, workspace_id: string, node_id: string): Promise<string | undefined> {
    const r = await this.sql.one<any>(`SELECT d.ingested_by AS ingested_by FROM graph_nodes gn
         JOIN documents d ON d.workspace_id = gn.workspace_id AND d.id = gn.document_id
        WHERE gn.workspace_id = ? AND gn.id = ?`, [workspace_id, node_id]) as { ingested_by: string | null } | undefined;
    return r?.ingested_by ?? undefined;
  }

  /** Record who ingested a document, and the audience they asked for (if any). First writer wins. */
  async stampDocumentIngest(this: Repo, workspace_id: string, document_id: string, ingested_by: string, audience?: string | null): Promise<void> {
    await this.sql.exec(`UPDATE documents SET ingested_by = COALESCE(ingested_by, ?), audience = COALESCE(audience, ?) WHERE workspace_id = ? AND id = ?`, [ingested_by, audience ?? null, workspace_id, document_id]);
  }

  /** Visibility + owner for a batch of node ids (missing ids are absent from the map). */
  async getNodeAccessMap(this: Repo, workspace_id: string, ids: string[]): Promise<Map<string, { visibility: string; owner_user_id: string | null }>> {
    const out = new Map<string, { visibility: string; owner_user_id: string | null }>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = (await this.sql.query<any>(`SELECT id, visibility, owner_user_id FROM graph_nodes WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(',')})`, [workspace_id, ...chunk])) as Array<{ id: string; visibility: string; owner_user_id: string | null }>;
      for (const r of rows) out.set(r.id, { visibility: r.visibility ?? 'team', owner_user_id: r.owner_user_id });
    }
    return out;
  }

  /** Workspace members (id + email + role) — backs the "share with…" picker. */
  async listWorkspaceMembers(this: Repo,
    workspace_id: string,
  ): Promise<Array<{ user_id: string; email: string; role: string; display_name: string | null; read_only: number }>> {
    return (await this.sql.query<any>(`SELECT m.user_id AS user_id, u.email AS email, m.role AS role,
                u.display_name AS display_name, COALESCE(m.read_only, 0) AS read_only
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ? ORDER BY u.email ASC`, [workspace_id])) as Array<{
      user_id: string;
      email: string;
      role: string;
      display_name: string | null;
      read_only: number;
    }>;
  }

  /**
   * The viewer's own memberships with workspace metadata — backs the MCP
   * `list_folders` tool and the folder-reference resolver.
   */
  async listMembershipsWithWorkspace(this: Repo,
    user_id: string,
  ): Promise<Array<{ id: string; name: string; owner_email: string; role: string; created_at: string }>> {
    return (await this.sql.query<any>(`SELECT w.id AS id, w.name AS name, w.owner_email AS owner_email,
                m.role AS role, w.created_at AS created_at
           FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
          WHERE m.user_id = ? ORDER BY w.created_at DESC`, [user_id])) as Array<{
      id: string;
      name: string;
      owner_email: string;
      role: string;
      created_at: string;
    }>;
  }

  /**
   * Team directory: every user whose email is on `domain`, each with the
   * workspaces they belong to and, per workspace, its context profile
   * type(s). Cross-workspace by design — the caller is exploring
   * teammates' workspaces across the shared email domain, so this deliberately
   * reaches past the single-workspace membership gate. The route that calls it
   * derives `domain` from the authenticated caller's own email, which keeps the
   * blast radius to one org's own people.
   *
   * ONLY an org domain groups people. A public mailbox provider (gmail.com,
   * outlook.com, …) is not an org — everyone on it is a stranger — so on such a
   * domain the directory collapses to `viewerUserId` alone, and is empty
   * without one: there is no "everyone on gmail.com" to hand out. This is the
   * single chokepoint for that rule; every caller (the web explorer, the MCP
   * `list_team` / `explore_team_folders` tools, the folder-reference resolver)
   * inherits it. See `src/lib/email-domain.ts`.
   */
  async listDomainDirectory(this: Repo,
    domain: string,
    viewerUserId?: string,
  ): Promise<Array<{
    user_id: string;
    email: string;
    created_at: string;
    display_name: string | null;
    // The user's linked Slack identity (first one), for teammate resolution.
    slack: { team_id: string | null; external_id: string; handle: string | null } | null;
    // The user's default folder pointer (the 'all'-surface view; membership
    // re-checked). Null when unset.
    default_folder: { workspace_id: string; surface: string } | null;
    workspaces: Array<{
      id: string;
      name: string;
      owner_email: string;
      role: string;
      created_at: string;
      // The viewer's own access to this workspace: their membership role, or
      // null if they are not a member. Drives whether a surface treats the
      // folder as reachable (one connection reaches every folder you're a
      // member of) or offers "request access" (non-member).
      viewer_role: string | null;
      profiles: Array<{ subgraph_id: string; slug: string; name: string; status: string; profile_id: string }>;
    }>;
  }>> {
    const d = domain.toLowerCase();
    if (!d) return [];
    const users = (await this.sql.query<any>(`SELECT id, email, created_at, display_name FROM users ORDER BY email ASC`)) as Array<{ id: string; email: string; created_at: string; display_name: string | null }>;
    const onDomain = users.filter((u) => emailDomain(u.email) === d);
    // Personal domains don't make a team: the viewer sees only themselves.
    const matched = isPersonalEmailDomain(d)
      ? onDomain.filter((u) => !!viewerUserId && u.id === viewerUserId)
      : onDomain;
    const result = [];
    for (const u of matched) {
      const slackId = (await this.listUserIdentities(u.id)).find((i) => i.kind === 'slack');
      const dflt = await this.getUserDefault(u.id, 'all');
      const wss = (await this.sql.query<any>(`SELECT w.id AS id, w.name AS name, w.owner_email AS owner_email,
                  w.created_at AS created_at, m.role AS role
             FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
            WHERE m.user_id = ? ORDER BY w.created_at DESC`, [u.id])) as Array<{
        id: string;
        name: string;
        owner_email: string;
        created_at: string;
        role: string;
      }>;
      const workspaces = [];
      for (const w of wss) {
        // Each subgraph is bound to one profile; the 'default' subgraph is the
        // workspace's primary type. LEFT JOIN so a subgraph with no profile row
        // still shows up (as 'unknown') rather than vanishing.
        const subs = (await this.sql.query<any>(`SELECT s.id AS subgraph_id, s.slug AS slug, s.name AS name, s.status AS status,
                    p.profile_id AS profile_id
               FROM subgraphs s
               LEFT JOIN workspace_profiles p
                 ON p.workspace_id = s.workspace_id AND p.subgraph_id = s.id
              WHERE s.workspace_id = ?
              ORDER BY (s.id = 'default') DESC, s.created_at ASC`, [w.id])) as Array<{
          subgraph_id: string;
          slug: string;
          name: string;
          status: string;
          profile_id: string | null;
        }>;
        // Legacy/standalone workspaces may predate the subgraphs table; fall
        // back to the workspace's default profile so the type is never blank.
        const profiles =
          subs.length > 0
            ? subs.map((s) => ({ ...s, profile_id: s.profile_id ?? 'unknown' }))
            : [
                {
                  subgraph_id: 'default',
                  slug: 'default',
                  name: 'Default',
                  status: 'active',
                  profile_id: await this.getWorkspaceProfileId(w.id) ?? 'unknown',
                },
              ];
        const viewer_role = viewerUserId
          ? ((await this.getMembership(w.id, viewerUserId))?.role ?? null)
          : null;
        workspaces.push({ ...w, viewer_role, profiles });
      }
      result.push({
        user_id: u.id,
        email: u.email,
        created_at: u.created_at,
        display_name: u.display_name ?? null,
        slack: slackId
          ? { team_id: slackId.team_id, external_id: slackId.external_id, handle: slackId.handle }
          : null,
        default_folder: dflt
          ? { workspace_id: dflt.workspace_id, surface: dflt.surface }
          : null,
        workspaces,
      });
    }
    return result;
  }

  /**
   * Hard-remove a published node copy from the shared graph (unpublish). Drops
   * the node row, its share ACL, evidence ledger, and any edges touching it. The
   * device keeps the local original (it is the source of truth), so re-publish
   * simply re-creates the copy.
   */
  async deleteSharedNode(this: Repo, workspace_id: string, node_id: string): Promise<void> {
    await this.sql.tx(async () => {
      (await this.sql.exec(`DELETE FROM node_evidence WHERE workspace_id = ? AND node_id = ?`, [workspace_id, node_id]));
      (await this.sql.exec(`DELETE FROM graph_edges WHERE workspace_id = ? AND (src = ? OR dst = ?)`, [workspace_id, node_id, node_id]));
      (await this.sql.exec(`DELETE FROM graph_nodes WHERE workspace_id = ? AND id = ?`, [workspace_id, node_id]));
    });
  }

  // ---------- graph edges (typed node↔node relations) ----------

  /**
   * Insert a typed edge, enforcing the profile's edge-kind taxonomy at write
   * time: both nodes must exist, the kind must be declared by the workspace
   * profile, and the nodes' kinds must satisfy the edge's src/dst constraints.
   * Idempotent on (src, dst, kind): re-adding an existing edge reactivates it
   * if archived and refreshes provenance only where the new write carries it.
   */
  async addEdge(this: Repo,
    workspace_id: string,
    edge: {
      src: string;
      dst: string;
      kind: string;
      created_by: EdgeOriginT;
      document_id?: string;
      quote?: string;
      confidence?: number;
    },
    actor?: string,
    subgraph_id = 'default',
    // Caller-supplied taxonomy, when the caller already resolved one (see
    // EdgeRepo.addEdge in edge-inference.ts) — bypasses re-deriving it via
    // `this.getWorkspaceProfile` below, which only ever sees this subgraph's
    // stored baseline profile, never a caller's override (e.g. the active
    // data agent's template). Omitted, behavior is unchanged.
    edgeKinds?: EdgeKindDefT[],
  ): Promise<{ id: string; existing: boolean }> {
    const src = await this.getNode(workspace_id, edge.src);
    if (!src) throw new Error(`edge source node not found: ${edge.src}`);
    const dst = await this.getNode(workspace_id, edge.dst);
    if (!dst) throw new Error(`edge destination node not found: ${edge.dst}`);
    const kinds = edgeKinds ?? resolveEdgeKinds(await this.getWorkspaceProfile(workspace_id, subgraph_id));
    const v = validateEdge(kinds, { kind: edge.kind, src_type: src.type, dst_type: dst.type });
    if (!v.ok) throw new Error(v.error);

    // Directed-edge hygiene: A→B and B→A of the same kind contradict each
    // other (observed: LLM inference proposing depends_on in both directions
    // across batches). First writer wins; the reverse is rejected like any
    // other invalid edge. Undirected kinds are exempt.
    if (v.def.directed !== false) {
      const reverse = (await this.sql.one<any>(`SELECT id FROM graph_edges WHERE workspace_id = ? AND subgraph_id = ? AND src = ? AND dst = ? AND kind = ? AND status = 'active'`, [workspace_id, subgraph_id, edge.dst, edge.src, edge.kind])) as { id: string } | undefined;
      if (reverse) {
        throw new Error(
          `reverse edge already active for directed kind '${edge.kind}' (${edge.dst} → ${edge.src})`,
        );
      }
    }

    const now = new Date().toISOString();
    const prior = (await this.sql.one<any>(`SELECT id FROM graph_edges WHERE workspace_id = ? AND subgraph_id = ? AND src = ? AND dst = ? AND kind = ?`, [workspace_id, subgraph_id, edge.src, edge.dst, edge.kind])) as { id: string } | undefined;
    if (prior) {
      (await this.sql.exec(`UPDATE graph_edges SET status = 'active',
             document_id = COALESCE(?, document_id),
             quote = COALESCE(?, quote),
             confidence = COALESCE(?, confidence),
             updated_at = ?
           WHERE workspace_id = ? AND id = ?`, [edge.document_id ?? null, edge.quote ?? null, edge.confidence ?? null, now, workspace_id, prior.id]));
      return { id: prior.id, existing: true };
    }
    const id = `e_${nanoid(10)}`;
    (await this.sql.exec(`INSERT INTO graph_edges (id, workspace_id, src, dst, kind, status, created_by, document_id, quote, confidence, created_at, updated_at, subgraph_id)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`, [id, workspace_id, edge.src, edge.dst, edge.kind, edge.created_by, edge.document_id ?? null, edge.quote ?? null, edge.confidence ?? null, now, now, subgraph_id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'graph.edge.created',
      resource_type: 'graph_edge',
      resource_id: id,
    });
    return { id, existing: false };
  }

  async getEdge(this: Repo, workspace_id: string, id: string): Promise<GraphEdgeT | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM graph_edges WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as Record<string, unknown> | undefined;
    return row ? rowToEdge(row) : undefined;
  }

  /** Active edges by default; `node` matches either end. */
  async listEdges(this: Repo,
    workspace_id: string,
    opts?: { node?: string; src?: string; dst?: string; kind?: string; includeArchived?: boolean },
    subgraph_id = 'default',
  ): Promise<GraphEdgeT[]> {
    const where: string[] = ['workspace_id = ?', 'subgraph_id = ?'];
    const params: SqlValue[] = [workspace_id, subgraph_id];
    if (opts?.node) {
      where.push('(src = ? OR dst = ?)');
      params.push(opts.node, opts.node);
    }
    if (opts?.src) {
      where.push('src = ?');
      params.push(opts.src);
    }
    if (opts?.dst) {
      where.push('dst = ?');
      params.push(opts.dst);
    }
    if (opts?.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (!opts?.includeArchived) where.push(`status = 'active'`);
    const rows = (await this.sql.query<any>(`SELECT * FROM graph_edges WHERE ${where.join(' AND ')} ORDER BY created_at ASC`, [...params])) as Array<Record<string, unknown>>;
    return rows.map(rowToEdge);
  }

  async archiveEdge(this: Repo, workspace_id: string, id: string, actor?: string): Promise<boolean> {
    const r = (await this.sql.exec(`UPDATE graph_edges SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'active'`, [new Date().toISOString(), workspace_id, id]));
    if (r.changes > 0) {
      await this.logAudit(workspace_id, {
        actor,
        event: 'graph.edge.archived',
        resource_type: 'graph_edge',
        resource_id: id,
      });
    }
    return r.changes > 0;
  }

  /**
   * Hard-delete every edge of an origin batch (e.g. wipe 'deterministic'
   * before a re-run, or roll back a bad 'llm' pass). Returns rows removed.
   */
  async removeEdgesByOrigin(this: Repo, workspace_id: string, created_by: EdgeOriginT): Promise<number> {
    const r = (await this.sql.exec(`DELETE FROM graph_edges WHERE workspace_id = ? AND created_by = ?`, [workspace_id, created_by]));
    return r.changes;
  }

  /** Archive all active edges touching a node (call when the node is archived). */
  async archiveEdgesForNode(this: Repo, workspace_id: string, node_id: string): Promise<number> {
    const r = (await this.sql.exec(`UPDATE graph_edges SET status = 'archived', updated_at = ?
         WHERE workspace_id = ? AND (src = ? OR dst = ?) AND status = 'active'`, [new Date().toISOString(), workspace_id, node_id, node_id]));
    return r.changes;
  }

  async listCandidates(this: Repo,
    workspace_id: string,
    opts?: { status?: 'pending' | 'approved' | 'rejected' | 'edited' },
    subgraph_id = 'default',
  ): Promise<Array<CandidateT & { status: string; created_at: string; document_id?: string; subgraph_id: string; created_by?: string }>> {
    // status is BOUND, never interpolated: it arrives from a query string.
    const rows = (await this.sql.query<any>(`SELECT * FROM candidates WHERE workspace_id = ? AND subgraph_id = ? ${
          opts?.status ? 'AND status = ?' : ''
        } ORDER BY
          CASE flag WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'green' THEN 2 END,
          created_at DESC`, opts?.status ? [workspace_id, subgraph_id, opts.status] : [workspace_id, subgraph_id])) as Array<{
      id: string;
      flag: 'red' | 'yellow' | 'green';
      proposed_node: string;
      source_quote: string;
      source_ref: string;
      conflicts_with: string | null;
      confidence: number;
      reason: string | null;
      status: string;
      created_at: string;
      document_id: string | null;
      subgraph_id: string | null;
      created_by: string | null;
    }>;
    const out: Array<CandidateT & { status: string; created_at: string; document_id?: string; subgraph_id: string; created_by?: string }> = [];
    for (const r of rows) out.push({
      id: r.id,
      proposed_node: parseStoredNode(await openJson(this, workspace_id, 'candidates.proposed_node', r.id, r.proposed_node)),
      flag: r.flag,
      source_quote: await openText(this, workspace_id, 'candidates.source_quote', r.id, r.source_quote),
      source_ref: r.source_ref,
      conflicts_with: r.conflicts_with ?? undefined,
      confidence: r.confidence,
      reason: r.reason ?? undefined,
      status: r.status,
      created_at: r.created_at,
      document_id: r.document_id ?? undefined,
      subgraph_id: r.subgraph_id ?? subgraph_id,
      created_by: r.created_by ?? undefined,
    });
    return out;
  }

  async approveCandidate(this: Repo, workspace_id: string, id: string, actor?: string): Promise<NodeT> {
    const row = (await this.sql.one<any>(`SELECT * FROM candidates WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as
      | {
          id: string;
          flag: string;
          proposed_node: string;
          source_ref: string;
        }
      | undefined;
    if (!row) throw new Error(`Candidate not found: ${id}`);
    const node = parseStoredNode(await openJson(this, workspace_id, 'candidates.proposed_node', id, row.proposed_node));
    const subgraph_id = (row as { subgraph_id?: string | null }).subgraph_id ?? 'default';
    // Approval-time kind gate: a node whose type is not a profile kind would
    // be invisible in the Library (the UI buckets strictly by profile kinds)
    // — refuse to materialize it rather than approve it into a black hole.
    const badKind = await this.invalidKindFor(workspace_id, subgraph_id, node);
    if (badKind !== null) {
      throw new Error(
        `invalid_kind: candidate ${id} proposes kind '${badKind}', which is not in folder '${subgraph_id}'s profile — reject it or fix the workspace profile`,
      );
    }
    await this.upsertNode(workspace_id, node, actor, undefined, subgraph_id);
    // Evidence ledger: origin row + node→document linkage.
    const docId = (row as { document_id?: string | null }).document_id ?? null;
    if (docId) {
      (await this.sql.exec(`UPDATE graph_nodes SET document_id = ? WHERE workspace_id = ? AND id = ?`, [docId, workspace_id, node.id]));
    }
    await this.addNodeEvidence(workspace_id, {
      node_id: node.id,
      document_id: docId ?? undefined,
      source_ref: (row as { source_ref?: string }).source_ref,
      source_kind: (node as { source?: string }).source,
      quote: (await openText(this, workspace_id, 'candidates.source_quote', id, (row as { source_quote?: string }).source_quote)) ?? '',
    }, subgraph_id);
    (await this.sql.exec(`UPDATE candidates SET status='approved', resolved_at=datetime('now') WHERE workspace_id=? AND id=?`, [workspace_id, id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'candidate.approved',
      resource_type: 'candidate',
      resource_id: id,
    });
    return node;
  }

  async rejectCandidate(this: Repo, workspace_id: string, id: string, actor?: string): Promise<void> {
    (await this.sql.exec(`UPDATE candidates SET status='rejected', resolved_at=datetime('now') WHERE workspace_id=? AND id=?`, [workspace_id, id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'candidate.rejected',
      resource_type: 'candidate',
      resource_id: id,
    });
  }

  // ---------- reviews ----------

  async insertReview(this: Repo, opts: {
    workspace_id: string;
    caller: 'web' | 'mcp' | 'slack';
    kind?: string;
    deliverable: string;
    findings: FindingT[];
    submitted_by?: string;
  }): Promise<{ id: string }> {
    const id = `rev_${nanoid(12)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO reviews (id, workspace_id, caller, kind, deliverable, findings, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, opts.workspace_id, opts.caller, opts.kind ?? 'other', opts.deliverable, JSON.stringify(opts.findings), opts.submitted_by ?? null, now]));
    await this.logAudit(opts.workspace_id, {
      actor: opts.submitted_by,
      event: 'review.submitted',
      resource_type: 'review',
      resource_id: id,
      payload: { caller: opts.caller, kind: opts.kind, findings_count: opts.findings.length },
    });
    return { id };
  }

  // ---------- blast-radius signals (triage scorer inputs; all one GROUP BY) ----------

  /** node id → count of ACTIVE inbound edges. */
  async inboundEdgeCounts(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<Map<string, number>> {
    const rows = (await this.sql.query<any>(`SELECT dst, COUNT(*) AS n FROM graph_edges WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active' GROUP BY dst`, [workspace_id, subgraph_id])) as Array<{ dst: string; n: number }>;
    return new Map(rows.map((r) => [r.dst, r.n]));
  }

  /**
   * node id → times cited by query answers. Read from the ANONYMIZED text
   * store's cited_node_ids — aggregate counts only, no identity involved,
   * consistent with the attribution-without-content split.
   */
  async citedNodeCounts(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<Map<string, number>> {
    const rows = (await this.sql.query<any>(`SELECT cited_node_ids FROM context_request_texts WHERE workspace_id = ? AND subgraph_id = ? AND cited_node_ids IS NOT NULL`, [workspace_id, subgraph_id])) as Array<{ cited_node_ids: string }>;
    const out = new Map<string, number>();
    for (const r of rows) {
      try {
        for (const id of JSON.parse(r.cited_node_ids) as string[]) {
          out.set(id, (out.get(id) ?? 0) + 1);
        }
      } catch {
        // skip unparseable rows
      }
    }
    return out;
  }

  /** Corroboration rows recorded against one document (dossier signal). */
  async documentCorroborationCount(this: Repo, workspace_id: string, document_id: string): Promise<number> {
    const r = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM node_evidence WHERE workspace_id = ? AND document_id = ?`, [workspace_id, document_id])) as { n: number };
    return r.n;
  }

  // ---------- finding rejections (IC "this is wrong") ----------

  /**
   * Idempotent: re-marking the same finding overwrites reason and timestamp
   * but does not create a duplicate row. PRD: silent negative-space capture
   * for the v1 loop; no customer-audit event today.
   */
  async markFindingWrong(this: Repo, opts: {
    workspace_id: string;
    review_id: string;
    finding_index: number;
    marked_by_user_id?: string;
    reason?: string;
  }): Promise<{ newly_recorded: boolean }> {
    const existing = (await this.sql.one(`SELECT 1 FROM finding_rejections WHERE workspace_id = ? AND review_id = ? AND finding_index = ?`, [opts.workspace_id, opts.review_id, opts.finding_index]));
    (await this.sql.exec(`INSERT OR REPLACE INTO finding_rejections
         (workspace_id, review_id, finding_index, marked_by_user_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`, [opts.workspace_id, opts.review_id, opts.finding_index, opts.marked_by_user_id ?? null, opts.reason ?? null]));
    return { newly_recorded: !existing };
  }

  async listFindingRejections(this: Repo,
    workspace_id: string,
    opts: { review_id?: string } = {},
  ): Promise<Array<{
    review_id: string;
    finding_index: number;
    marked_by_user_id: string | null;
    reason: string | null;
    created_at: string;
  }>> {
    if (opts.review_id) {
      return (await this.sql.query<any>(`SELECT review_id, finding_index, marked_by_user_id, reason, created_at
           FROM finding_rejections WHERE workspace_id = ? AND review_id = ?
           ORDER BY created_at DESC`, [workspace_id, opts.review_id])) as any;
    }
    return (await this.sql.query<any>(`SELECT review_id, finding_index, marked_by_user_id, reason, created_at
         FROM finding_rejections WHERE workspace_id = ?
         ORDER BY created_at DESC`, [workspace_id])) as any;
  }

  /** Used by the integrity gate: a review row must belong to this workspace. */
  async reviewExists(this: Repo, workspace_id: string, review_id: string): Promise<boolean> {
    const row = (await this.sql.one(`SELECT 1 FROM reviews WHERE workspace_id = ? AND id = ?`, [workspace_id, review_id]));
    return !!row;
  }

  /** Used by the index check on mark-wrong. */
  async getReviewFindingsCount(this: Repo, workspace_id: string, review_id: string): Promise<number> {
    const row = (await this.sql.one<any>(`SELECT findings FROM reviews WHERE workspace_id = ? AND id = ?`, [workspace_id, review_id])) as { findings: string } | undefined;
    if (!row) return -1;
    try {
      const arr = JSON.parse(row.findings);
      return Array.isArray(arr) ? arr.length : -1;
    } catch {
      return -1;
    }
  }

  // ---------- moved from api/routes (all SQL in repo/) ----------


  async setNodeDocumentId(this: Repo, ws: string, node_id: string, document_id: string): Promise<void> {
    (await this.sql.exec('UPDATE graph_nodes SET document_id=? WHERE workspace_id=? AND id=?', [document_id, ws, node_id]));
  }

  /** Catch-up work agent: ids of nodes updated since `cutoff` (SQLite datetime text). */
  async listRecentlyUpdatedNodeIds(this: Repo, ws: string, subgraph_id: string, cutoff: string, limit: number): Promise<{ id: string }[]> {
    return (await this.sql.query<any>(`SELECT id FROM graph_nodes WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`, [ws, subgraph_id, cutoff, limit])) as { id: string }[];
  }

  /** Per-node sharing metadata for one subfolder (document_id, visibility, owner). */
  async listNodeMetaRows(this: Repo, ws: string, subgraph_id: string): Promise<Array<{
    id: string;
    document_id: string | null;
    visibility: string;
    owner_user_id: string | null;
  }>> {
    return (await this.sql.query<any>(`SELECT id, document_id, visibility, owner_user_id FROM graph_nodes WHERE workspace_id = ? AND subgraph_id = ?`, [ws, subgraph_id])) as Array<{
      id: string;
      document_id: string | null;
      visibility: string;
      owner_user_id: string | null;
    }>;
  }

  /** Anonymized review log (Mirror: GET /workspaces/:ws/reviews). */
  async listReviewLogRows(this: Repo, ws: string, limit: number): Promise<Array<{
    id: string;
    caller: string;
    kind: string;
    findings: string;
    created_at: string;
  }>> {
    return (await this.sql.query<any>(`SELECT id, caller, kind, findings, created_at FROM reviews
       WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`, [ws, limit])) as Array<{
      id: string;
      caller: string;
      kind: string;
      findings: string;
      created_at: string;
    }>;
  }

  // ---------- moved from outside db/ (all SQL in repo/) ----------

  async listNodesChangedSince(this: Repo, ws: string, subgraph_id: string, since: string): Promise<unknown[]> {
    const rows = (await this.sql.query<any>(`SELECT id, data, updated_at FROM graph_nodes
         WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active' AND updated_at > ?
         ORDER BY updated_at DESC`, [ws, subgraph_id, since]));
    return openRows(rows, async (r) => { r.data = await openJson(this, ws, 'graph_nodes.data', r.id, r.data); });
  }

  /**
   * Documents (re-)ingested after `since`, routed to `subgraph_id`. When a
   * `viewer` is given the rows pass through `documentVisibilityFilter` (with
   * `aiRead` excluding their own only_me material), so another member's
   * private document — and its summary — never reaches the viewer's change
   * window or digest. No viewer → unfiltered (single-user local engine).
   */
  async listDocumentsIngestedSince(this: Repo, ws: string, since: string, subgraph_id: string, opts?: { viewer?: string; aiRead?: boolean }): Promise<unknown[]> {
    const vis = this.documentVisibilityFilter(opts?.viewer, { aiRead: opts?.aiRead, alias: 'd' });
    const rows = (await this.sql.query(`SELECT d.id AS id, d.summary AS summary, d.last_ingested_at AS last_ingested_at
         FROM documents d
        WHERE d.workspace_id = ? AND d.last_ingested_at IS NOT NULL AND d.last_ingested_at > ?
          AND (
            EXISTS (SELECT 1 FROM document_routing r
                      WHERE r.workspace_id = d.workspace_id AND r.document_id = d.id AND r.subgraph_id = ?)
            OR (? = 'default' AND NOT EXISTS (SELECT 1 FROM document_routing r2
                      WHERE r2.workspace_id = d.workspace_id AND r2.document_id = d.id))
          )${vis.sql}
        ORDER BY d.last_ingested_at DESC`, [ws, since, subgraph_id, subgraph_id, ...vis.params])) as any[];
    return openRows(rows, async (r) => { r.summary = await openText(this, ws, 'documents.summary', r.id, r.summary); });
  }

  /**
   * Nodes changed since `since`, as an LLM-facing read for `viewer`: filtered
   * to what the viewer's agent may see (team, or their own non-only_me nodes)
   * and serving the use-phase REDACTED copy to anyone but the node's owner —
   * the same rule as `listNodes`. Returns `{ id, data }` with `data` as JSON text.
   */
  async listNodesUpdatedSinceForTool(this: Repo, ws: string, since: string, viewer?: string): Promise<Array<{ id: string; data: string }>> {
    const vis = await this.visibilityFilter({ viewer, aiRead: true });
    const rows = (await this.sql.query<any>(`SELECT id, data, owner_user_id, redacted_data FROM graph_nodes WHERE workspace_id = ? AND status = 'active' AND updated_at >= ?${vis.sql} ORDER BY updated_at DESC`, [ws, since, ...vis.params])) as Array<{ id: string; data: string; owner_user_id: string | null; redacted_data: string | null }>;
    const out: Array<{ id: string; data: string }> = [];
    for (const r of rows) {
      const redacted = !!(r.redacted_data && viewer && viewer !== r.owner_user_id);
      out.push({
        id: r.id,
        data: redacted
          ? await openJson(this, ws, 'graph_nodes.redacted_data', r.id, r.redacted_data!)
          : await openJson(this, ws, 'graph_nodes.data', r.id, r.data),
      });
    }
    return out;
  }

  async listRecentNodeDataForAppsSync(this: Repo, ws: string, limit: number): Promise<unknown[]> {
    const rows = (await this.sql.query<any>(`SELECT id, data FROM graph_nodes
       WHERE workspace_id = ? AND status = 'active' AND visibility != 'only_me'
       ORDER BY created_at DESC LIMIT ?`, [ws, limit]));
    for (const r of rows) r.data = await openJson(this, ws, 'graph_nodes.data', r.id, r.data);
    return rows.map((r) => ({ data: r.data }));
  }

  /** Embeddings for a list of node ids (callers chunk the list under SQLite's variable limit). */
  async listNodeEmbeddingsByIds(this: Repo, ws: string, ids: string[]): Promise<unknown[]> {
    const placeholders = ids.map(() => '?').join(',');
    const rows = (await this.sql.query<any>(`SELECT id, embedding FROM graph_nodes WHERE workspace_id = ? AND id IN (${placeholders})`, [ws, ...ids]));
    return openRows(rows, async (r) => { r.embedding = await openBlob(this, ws, 'graph_nodes.embedding', r.id, r.embedding); });
  }
}
