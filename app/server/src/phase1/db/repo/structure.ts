// Repo methods: workspace profiles, subgraphs, document routing, pending routes.
// Split from repo.ts.
// Methods take `this: Repo` so they can call across modules; repo.ts
// mixes every module class into Repo, so callers still use `repo.method()`.

import { nanoid } from 'nanoid';
import { ContextProfile } from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import type { PendingRouteViewer } from './shared.js';
import {
  PendingRouteRow,
  SubgraphRow,
  RawPendingRouteRow,
  parsePendingRouteRow,
  pendingRouteVisibleTo,
  SUBGRAPH_SELECT,
  mapSubgraphRow,
  SUBGRAPH_SCOPED_TABLES,
} from './shared.js';
import type { SqlValue } from '../../../platform/db.js';
import type { Repo } from '../repo.js';

export class StructureRepo {
  // ---------- workspace profiles (spec B4) ----------

  /**
   * The resolved ContextProfile for a workspace, or undefined if none has been
   * assigned (a workspace that predates profiles and hasn't been migrated).
   * Callers default to FALLBACK_PROFILE on undefined.
   */
  async getWorkspaceProfile(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<ContextProfileT | undefined> {
    const row = (await this.sql.one<any>(`SELECT profile FROM workspace_profiles WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { profile: string } | undefined;
    if (!row) return undefined;
    return ContextProfile.parse(JSON.parse(row.profile));
  }

  /** Raw profile_id (without parsing the full snapshot). */
  async getWorkspaceProfileId(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT profile_id FROM workspace_profiles WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { profile_id: string } | undefined;
    return row?.profile_id;
  }

  /**
   * Set or replace a workspace's context profile. Stores the full resolved
   * profile JSON as a self-contained snapshot. Upsert: preserves created_at on
   * replace.
   */
  async setWorkspaceProfile(this: Repo,
    workspace_id: string,
    profile_id: string,
    profile: ContextProfileT,
    subgraph_id = 'default',
  ): Promise<void> {
    const now = Date.now();
    const existing = (await this.sql.one<any>(`SELECT created_at FROM workspace_profiles WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { created_at: number | null } | undefined;
    const created_at = existing?.created_at ?? now;
    (await this.sql.exec(`INSERT OR REPLACE INTO workspace_profiles (workspace_id, subgraph_id, profile_id, profile, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`, [workspace_id, subgraph_id, profile_id, JSON.stringify(profile), created_at, now]));
  }

  // ---------- subgraphs (multi-profile partition) ----------

  /** Seed the always-present 'default' subgraph. Idempotent. */
  async ensureDefaultSubgraph(this: Repo, workspace_id: string): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT OR IGNORE INTO subgraphs (workspace_id, id, slug, name, status, created_at, updated_at)
         VALUES (?, 'default', 'default', 'Default', 'active', ?, ?)`, [workspace_id, now, now]));
  }

  async createSubgraph(this: Repo,
    workspace_id: string,
    opts: { id?: string; slug: string; name: string; description?: string },
  ): Promise<{ id: string }> {
    const id = opts.id ?? `sg_${nanoid(10)}`;
    const now = new Date().toISOString();
    // Blank/whitespace-only description falls back to the column default.
    const description = opts.description?.trim() || 'miscellaneous';
    (await this.sql.exec(`INSERT INTO subgraphs (workspace_id, id, slug, name, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`, [workspace_id, id, opts.slug, opts.name, description, now, now]));
    return { id };
  }

  async getSubgraph(this: Repo, workspace_id: string, id: string): Promise<SubgraphRow | undefined> {
    const row = (await this.sql.one<any>(`${SUBGRAPH_SELECT} WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as Record<string, unknown> | undefined;
    return row ? mapSubgraphRow(row) : undefined;
  }

  async getSubgraphBySlug(this: Repo, workspace_id: string, slug: string): Promise<SubgraphRow | undefined> {
    const row = (await this.sql.one<any>(`${SUBGRAPH_SELECT} WHERE workspace_id = ? AND slug = ?`, [workspace_id, slug])) as Record<string, unknown> | undefined;
    return row ? mapSubgraphRow(row) : undefined;
  }

  async listSubgraphs(this: Repo, workspace_id: string, opts?: { activeOnly?: boolean }): Promise<SubgraphRow[]> {
    const rows = (await this.sql.query<any>(`${SUBGRAPH_SELECT} WHERE workspace_id = ? ${opts?.activeOnly ? "AND status = 'active'" : ''}
         ORDER BY created_at ASC`, [workspace_id])) as Array<Record<string, unknown>>;
    return rows.map(mapSubgraphRow);
  }

  /** Update a subgraph's display metadata (slug/name/description), its
   *  auto-routing eligibility, and/or a manual override of the content
   *  summary. Used to rename the auto-seeded 'default' subgraph onto the
   *  first profile chosen at onboarding, to edit the user-authored
   *  description, to hand-edit `generated_description` (locks it against the
   *  next automatic refresh — see `unlockSubgraphOverview`), and to flip
   *  `routable`. A blank description resets to the 'miscellaneous' default; a
   *  blank/whitespace-only `generated_description` is rejected by the route
   *  layer rather than accepted here (blanking the routing digest silently
   *  is never the intent — use the regenerate action instead). */
  async updateSubgraph(this: Repo,
    workspace_id: string,
    id: string,
    opts: { slug?: string; name?: string; description?: string; generated_description?: string; routable?: boolean;
      default_audience?: 'team' | 'private' | 'only_me' | null },
  ): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (opts.slug !== undefined) { sets.push('slug = ?'); params.push(opts.slug); }
    if (opts.name !== undefined) { sets.push('name = ?'); params.push(opts.name); }
    if (opts.description !== undefined) { sets.push('description = ?'); params.push(opts.description.trim() || 'miscellaneous'); }
    if (opts.generated_description !== undefined) {
      sets.push('generated_description = ?', 'generated_description_at = ?', 'generated_description_locked = 1');
      params.push(opts.generated_description.trim(), new Date().toISOString());
    }
    if (opts.routable !== undefined) { sets.push('routable = ?'); params.push(opts.routable ? 1 : 0); }
    if (opts.default_audience !== undefined) { sets.push('default_audience = ?'); params.push(opts.default_audience); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), workspace_id, id);
    (await this.sql.exec(`UPDATE subgraphs SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, params));
  }

  /** Persist the LLM-generated Overview summary onto a subfolder. Called every
   *  time the overview route recomputes the summary, so each subfolder keeps its
   *  own latest synthesis (and the timestamp it was produced). Does not touch
   *  updated_at — a regenerated summary isn't a user edit of the subfolder.
   *  Callers (refreshSubgraphOverview) are responsible for checking
   *  `generated_description_locked` before calling this — it does not check
   *  the lock itself, so the explicit "regenerate" path can unlock-then-call. */
  async setSubgraphOverview(this: Repo, workspace_id: string, id: string, generated_description: string | null): Promise<void> {
    (await this.sql.exec(`UPDATE subgraphs SET generated_description = ?, generated_description_at = ?
         WHERE workspace_id = ? AND id = ?`, [generated_description, new Date().toISOString(), workspace_id, id]));
  }

  /** Clear a manual-edit lock on `generated_description` so the next automatic
   *  refresh (or an immediately-following explicit regenerate) is free to
   *  overwrite it again. Does not itself recompute anything. */
  async unlockSubgraphOverview(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`UPDATE subgraphs SET generated_description_locked = 0 WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  /** Archive (never delete) a subgraph; its nodes/edges stay intact. */
  async archiveSubgraph(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`UPDATE subgraphs SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?`, [new Date().toISOString(), workspace_id, id]));
  }

  /**
   * Move all data owned by one folder into another folder before removing it.
   * Rows are copied with INSERT OR IGNORE so a document or node that already
   * exists in the destination is preserved once, then the source rows are
   * removed by deleteSubgraphRows. The table list is deliberately shared with
   * the purge path so new folder-scoped tables cannot be missed silently.
   */
  async migrateSubgraphRows(this: Repo, workspace_id: string, from_id: string, to_id: string): Promise<Record<string, number>> {
    if (from_id === to_id) throw new Error('cannot migrate a folder into itself');
    const counts: Record<string, number> = {};
    await this.sql.tx(async () => {
      for (const table of SUBGRAPH_SCOPED_TABLES) {
        const columns = (await this.sql.query(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
        const names = columns.map((c) => c.name);
        if (!names.includes('subgraph_id')) continue;
        try {
          const result = (await this.sql.exec(`UPDATE ${table} SET subgraph_id = ? WHERE workspace_id = ? AND subgraph_id = ?`, [to_id, workspace_id, from_id]));
          counts[table] = result.changes;
        } catch {
          // A composite key may already exist in the destination (for example
          // the same document is routed to both folders). Preserve the
          // destination row and let the purge remove the source row.
          const select = names.map((name) => (name === 'subgraph_id' ? '?' : `"${name.replaceAll('"', '""')}"`)).join(', ');
          const result = (await this.sql.exec(`INSERT OR IGNORE INTO ${table} (${names.map((n) => `"${n.replaceAll('"', '""')}"`).join(', ')})
               SELECT ${select} FROM ${table} WHERE workspace_id = ? AND subgraph_id = ?`, [to_id, workspace_id, from_id]));
          counts[table] = result.changes;
        }
      }
      (await this.sql.exec(`UPDATE user_defaults SET subgraph_id = ? WHERE workspace_id = ? AND subgraph_id = ?`, [to_id, workspace_id, from_id]));
    });
    return counts;
  }

  /**
   * Hard-delete a subgraph AND every row scoped to it (the opposite of
   * archiveSubgraph). Unlike workspace deletion, subgraph_id is never a FK —
   * see schema.ts's multi-subgraph comment — so there is no ON DELETE CASCADE
   * safety net here; every subgraph-scoped table must be swept explicitly.
   * Shared data (documents, sources, source_chunks) is untouched: a document
   * can still be routed into other subgraphs. wiki_blocks has no subgraph_id
   * of its own, so its page ids are resolved first and it's deleted ahead of
   * wiki_pages. user_defaults is a per-user POINTER, not subgraph-owned data,
   * so a default pointing at this subgraph is cleared rather than deleted.
   * Returns a per-table delete count so the test can assert nothing remains.
   */
  async deleteSubgraphRows(this: Repo, workspace_id: string, subgraph_id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await this.sql.tx(async () => {
      const pageIds = (await this.sql.query<any>(`SELECT id FROM wiki_pages WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { id: string }[];
      if (pageIds.length > 0) {
        const placeholders = pageIds.map(() => '?').join(',');
        const r = (await this.sql.exec(`DELETE FROM wiki_blocks
             WHERE workspace_id = ? AND page_id IN (${placeholders})
               AND NOT EXISTS (
                 SELECT 1 FROM wiki_pages p
                 WHERE p.workspace_id = wiki_blocks.workspace_id
                   AND p.id = wiki_blocks.page_id
                   AND p.subgraph_id != ?
               )`, [workspace_id, ...pageIds.map((p) => p.id), subgraph_id]));
        counts['wiki_blocks'] = r.changes;
      } else {
        counts['wiki_blocks'] = 0;
      }
      for (const t of SUBGRAPH_SCOPED_TABLES) {
        const r = (await this.sql.exec(`DELETE FROM ${t} WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id]));
        counts[t] = r.changes;
      }
      const cleared = (await this.sql.exec(`UPDATE user_defaults SET subgraph_id = NULL WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id]));
      counts['user_defaults_cleared'] = cleared.changes;
      const r = (await this.sql.exec(`DELETE FROM subgraphs WHERE workspace_id = ? AND id = ?`, [workspace_id, subgraph_id]));
      counts['subgraphs'] = r.changes;
    });
    return counts;
  }

  /**
   * Assert (post-deletion) that no rows for this subgraph remain in any
   * subgraph-scoped table. Tripwire for the delete-subgraph test — a future
   * table added to SUBGRAPH_SCOPED_TABLES without also being swept in
   * deleteSubgraphRows would fail here. wiki_blocks is checked separately by
   * the test (it has no subgraph_id column to filter on directly).
   */
  async countSubgraphRows(this: Repo, workspace_id: string, subgraph_id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const t of SUBGRAPH_SCOPED_TABLES) {
      const r = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { n: number };
      counts[t] = r.n;
    }
    const sg = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM subgraphs WHERE workspace_id = ? AND id = ?`, [workspace_id, subgraph_id])) as { n: number };
    counts['subgraphs'] = sg.n;
    return counts;
  }

  // ---------- document routing (per-document → subgraph) ----------

  async routeDocument(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id: string,
    opts?: { routed_by?: 'router' | 'pinned' | 'manual'; router_reason?: string },
  ): Promise<void> {
    (await this.sql.exec(`INSERT OR IGNORE INTO document_routing (workspace_id, document_id, subgraph_id, routed_by, router_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`, [workspace_id, document_id, subgraph_id, opts?.routed_by ?? 'router', opts?.router_reason ?? null, new Date().toISOString()]));
  }

  async listDocumentSubgraphs(this: Repo,
    workspace_id: string,
    document_id: string,
  ): Promise<Array<{ subgraph_id: string; routed_by: string; router_reason: string | null; source_type: string | null; created_at: string }>> {
    return (await this.sql.query<any>(`SELECT subgraph_id, routed_by, router_reason, source_type, created_at FROM document_routing
         WHERE workspace_id = ? AND document_id = ? ORDER BY created_at ASC`, [workspace_id, document_id])) as Array<{
      subgraph_id: string;
      routed_by: string;
      router_reason: string | null;
      source_type: string | null;
      created_at: string;
    }>;
  }

  /** Persist the per-subgraph source-type classification onto an existing
   *  routing row (set after the subgraph's extraction pass classifies it). */
  async setDocumentRoutingSourceType(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id: string,
    source_type: string,
  ): Promise<void> {
    (await this.sql.exec(`UPDATE document_routing SET source_type = ?
         WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ?`, [source_type, workspace_id, document_id, subgraph_id]));
  }

  /** The source-type to use for a (document, subgraph): the per-subgraph
   *  classification if present, else the shared documents.source_type. */
  async getDocumentSourceType(this: Repo,
    workspace_id: string,
    document_id: string,
    subgraph_id = 'default',
  ): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT source_type FROM document_routing WHERE workspace_id = ? AND document_id = ? AND subgraph_id = ?`, [workspace_id, document_id, subgraph_id])) as { source_type: string | null } | undefined;
    if (row?.source_type) return row.source_type;
    const doc = (await this.sql.one<any>(`SELECT source_type FROM documents WHERE workspace_id = ? AND id = ?`, [workspace_id, document_id])) as { source_type: string | null } | undefined;
    return doc?.source_type ?? undefined;
  }

  async listSubgraphDocuments(this: Repo,
    workspace_id: string,
    subgraph_id: string,
  ): Promise<Array<{ document_id: string; routed_by: string; router_reason: string | null; created_at: string }>> {
    return (await this.sql.query<any>(`SELECT document_id, routed_by, router_reason, created_at FROM document_routing
         WHERE workspace_id = ? AND subgraph_id = ? ORDER BY created_at ASC`, [workspace_id, subgraph_id])) as Array<{
      document_id: string;
      routed_by: string;
      router_reason: string | null;
      created_at: string;
    }>;
  }

  // ---------- pending routes ----------

  async createPendingRoute(this: Repo,
    workspace_id: string,
    opts: {
      document_id: string;
      reason: string;
      proposed_targets: string[];
      proposed_new_folder?: { name: string; description: string } | null;
      low_confidence_targets: string[];
      /** Carried so capture-on-resolve honors the original ingest's choice. */
      audience?: 'team' | 'private' | 'only_me';
      ingested_by?: string;
      /** Used only when neither `audience` nor the folder's default is set. */
      fallback_audience?: 'team' | 'private' | 'only_me';
    },
  ): Promise<{ id: string }> {
    const id = `pr_${nanoid(10)}`;
    (await this.sql.exec(`INSERT INTO pending_routes
           (workspace_id, id, document_id, reason, proposed_targets, proposed_new_folder, low_confidence_targets, status, created_at, audience, ingested_by, fallback_audience)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`, [workspace_id, id, opts.document_id, opts.reason, JSON.stringify(opts.proposed_targets), opts.proposed_new_folder ? JSON.stringify(opts.proposed_new_folder) : null, JSON.stringify(opts.low_confidence_targets), new Date().toISOString(), opts.audience ?? null, opts.ingested_by ?? null, opts.fallback_audience ?? null]));
    return { id };
  }

  /**
   * With `viewer`, a route the viewer may not see (someone else's private
   * hold — see pendingRouteVisibleTo) reads as missing, so every caller 404s
   * instead of leaking it. Without `viewer` (local mode, internal callers)
   * the read is unfiltered.
   */
  async getPendingRoute(this: Repo,
    workspace_id: string,
    id: string,
    opts?: { viewer?: PendingRouteViewer },
  ): Promise<PendingRouteRow | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM pending_routes WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as RawPendingRouteRow | undefined;
    if (!row) return undefined;
    const parsed = parsePendingRouteRow(row);
    return pendingRouteVisibleTo(parsed, opts?.viewer) ? parsed : undefined;
  }

  async listPendingRoutes(this: Repo,
    workspace_id: string,
    opts?: { status?: string; viewer?: PendingRouteViewer },
  ): Promise<PendingRouteRow[]> {
    const status = opts?.status ?? 'pending';
    const rows = (await this.sql.query<any>(`SELECT * FROM pending_routes WHERE workspace_id = ? AND status = ? ORDER BY created_at ASC`, [workspace_id, status])) as RawPendingRouteRow[];
    return rows.map(parsePendingRouteRow).filter((r) => pendingRouteVisibleTo(r, opts?.viewer));
  }

  /**
   * Build the viewer for pending-route visibility/resolution: admin when the
   * membership role is workspace_admin or the user is the workspace owner
   * (same owner-tier test as ruleWriteAllowed). `role` may be passed when the
   * caller already has it (REST workspaceGate); otherwise it is looked up.
   */
  async pendingRouteViewer(this: Repo, workspace_id: string, user_id: string, role?: string): Promise<PendingRouteViewer> {
    const r = role ?? (await this.getMembership(workspace_id, user_id))?.role;
    if (r === 'workspace_admin') return { user_id, is_admin: true };
    const owner_email = ((await this.getWorkspace(workspace_id))?.owner_email ?? '').toLowerCase();
    const email = ((await this.getUserEmailRow(user_id))?.email ?? '').toLowerCase();
    return { user_id, is_admin: !!owner_email && owner_email === email };
  }

  async resolvePendingRoute(this: Repo,
    workspace_id: string,
    id: string,
    opts: { status: 'approved' | 'rejected'; resolved_by: string },
  ): Promise<void> {
    (await this.sql.exec(`UPDATE pending_routes SET status = ?, resolved_by = ?, resolved_at = ?
         WHERE workspace_id = ? AND id = ?`, [opts.status, opts.resolved_by, new Date().toISOString(), workspace_id, id]));
  }
}
