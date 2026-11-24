// Repo methods: media (data-agent media bindings, surface media deliveries).
// Lives beside features.ts. Created to
// take the media SQL that lived outside the repo.
// Methods take `this: Repo` so they can call across modules; repo.ts mixes
// every module class into Repo, so callers still use `repo.method()`.

import type { ExecResult } from '../../../platform/db.js';
import type { Repo } from '../repo.js';

export class MediaRepo {
  // ---------- moved from api/routes (all SQL in repo/) ----------


  async getMediaBindingEnabled(this: Repo, ws: string, target: string, capability: string): Promise<{ enabled: number } | undefined> {
    return (await this.sql.one<any>('SELECT enabled FROM data_agent_media_bindings WHERE workspace_id=? AND target=? AND capability=?', [ws, target, capability])) as { enabled: number } | undefined;
  }

  /** WhatsApp media relay idempotency: the delivery row for one inbound message. */
  async getMediaSurfaceDelivery(this: Repo, ws: string, user_id: string, message_id: string): Promise<{ response: string | null; lease_until: number } | undefined> {
    return (await this.sql.one<any>('SELECT response,lease_until FROM media_surface_deliveries WHERE workspace_id=? AND user_id=? AND message_id=?', [ws, user_id, message_id])) as { response: string | null; lease_until: number } | undefined;
  }

  async leaseMediaSurfaceDelivery(this: Repo, ws: string, user_id: string, message_id: string, lease_until: number, created_at: string): Promise<void> {
    (await this.sql.exec(`INSERT INTO media_surface_deliveries VALUES (?,?,?,NULL,?,?) ON CONFLICT(workspace_id,user_id,message_id) DO UPDATE SET lease_until=excluded.lease_until`, [ws, user_id, message_id, lease_until, created_at]));
  }

  async completeMediaSurfaceDelivery(this: Repo, ws: string, user_id: string, message_id: string, response: string): Promise<void> {
    (await this.sql.exec('UPDATE media_surface_deliveries SET response=?,lease_until=0 WHERE workspace_id=? AND user_id=? AND message_id=?', [response, ws, user_id, message_id]));
  }

  async releaseMediaSurfaceDelivery(this: Repo, ws: string, user_id: string, message_id: string): Promise<void> {
    (await this.sql.exec('UPDATE media_surface_deliveries SET lease_until=0 WHERE workspace_id=? AND user_id=? AND message_id=?', [ws, user_id, message_id]));
  }

  // ---------- moved from data-agents/media-service.ts + routes.ts  ----------

  async getMediaAsset(this: Repo, ws: string, id: string): Promise<unknown> {
    return (await this.sql.one('SELECT * FROM media_assets WHERE workspace_id = ? AND id = ? AND deleting=0', [ws, id]));
  }

  async findMediaAssetByContent(this: Repo, ws: string, owner_user_id: string, sha256: string, original_name: string): Promise<unknown> {
    return (await this.sql.one('SELECT * FROM media_assets WHERE workspace_id = ? AND owner_user_id = ? AND sha256 = ? AND original_name = ? AND deleting=0', [ws, owner_user_id, sha256, original_name]));
  }

  async getMediaAssetDeleting(this: Repo, ws: string, id: string): Promise<unknown> {
    return (await this.sql.one('SELECT deleting FROM media_assets WHERE workspace_id=? AND id=?', [ws, id]));
  }

  async insertMediaAsset(this: Repo, asset: {
    workspace_id: string; id: string; object_key: string; backend: string; original_name: string; mime: string;
    bytes: number; sha256: string; owner_user_id: string; visibility: string; created_at: string;
  }): Promise<ExecResult> {
    // Positional, not @named: the C1 Db interface takes `?` placeholders only.
    return (await this.sql.exec(`INSERT OR IGNORE INTO media_assets(workspace_id,id,object_key,backend,original_name,mime,bytes,sha256,owner_user_id,visibility,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [asset.workspace_id, asset.id, asset.object_key, asset.backend, asset.original_name, asset.mime, asset.bytes, asset.sha256, asset.owner_user_id, asset.visibility, asset.created_at]));
  }

  async getMediaBindingConfig(this: Repo, ws: string, target: string, capability: string): Promise<unknown> {
    return (await this.sql.one('SELECT config,enabled FROM data_agent_media_bindings WHERE workspace_id = ? AND target = ? AND capability = ?', [ws, target, capability]));
  }

  async insertMediaRun(this: Repo, ws: string, id: string, asset_id: string, config: string, created_at: string, updated_at: string): Promise<ExecResult> {
    return (await this.sql.exec(`INSERT OR IGNORE INTO data_agent_media_runs
      (workspace_id,id,asset_id,config,status,created_at,updated_at) VALUES (?,?,?,?,'queued',?,?)`, [ws, id, asset_id, config, created_at, updated_at]));
  }

  async getMediaRunResult(this: Repo, ws: string, id: string): Promise<unknown> {
    return (await this.sql.one('SELECT status,result FROM data_agent_media_runs WHERE workspace_id = ? AND id = ?', [ws, id]));
  }

  async getSucceededMediaRunText(this: Repo, ws: string, asset_id: string, run_id?: string): Promise<{ id: string; result: string } | undefined> {
    const row = run_id
      ? await this.sql.one('SELECT id,result FROM data_agent_media_runs WHERE workspace_id=? AND asset_id=? AND id=? AND status=? AND result IS NOT NULL', [ws, asset_id, run_id, 'succeeded'])
      : await this.sql.one("SELECT id,result FROM data_agent_media_runs WHERE workspace_id=? AND asset_id=? AND status='succeeded' AND result IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1", [ws, asset_id]);
    return row as { id: string; result: string } | undefined;
  }

  async countActiveMediaRuns(this: Repo, ws: string, now: number): Promise<unknown> {
    return (await this.sql.one("SELECT COUNT(*) AS n FROM data_agent_media_runs WHERE workspace_id=? AND status='running' AND lease_until>?", [ws, now]));
  }

  async claimMediaRun(this: Repo, lease_until: number, updated_at: string, ws: string, id: string, now: number): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE data_agent_media_runs SET status='running',attempts=attempts+1,lease_until=?,updated_at=?
      WHERE workspace_id=? AND id=? AND status<>'succeeded' AND lease_until<?`, [lease_until, updated_at, ws, id, now]));
  }

  async completeMediaRun(this: Repo, result: string, updated_at: string, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE data_agent_media_runs SET status='succeeded',result=?,error=NULL,lease_until=0,updated_at=? WHERE workspace_id=? AND id=?`, [result, updated_at, ws, id]));
  }

  async failMediaRun(this: Repo, updated_at: string, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE data_agent_media_runs SET status='failed',error='media_read_failed',lease_until=0,updated_at=? WHERE workspace_id=? AND id=?`, [updated_at, ws, id]));
  }

  async linkDocumentAsset(this: Repo, ws: string, document_id: string, version: number, asset_id: string, run_id: string | null): Promise<ExecResult> {
    return (await this.sql.exec('INSERT OR IGNORE INTO document_assets VALUES (?,?,?,?,?)', [ws, document_id, version, asset_id, run_id]));
  }

  async getNodeVisibleToUser(this: Repo, ws: string, node_id: string, user_id: string): Promise<unknown> {
    return (await this.sql.one("SELECT id FROM graph_nodes WHERE workspace_id=? AND id=? AND (visibility='team' OR owner_user_id=?)", [ws, node_id, user_id]));
  }

  async listNodeMediaAssets(this: Repo, ws: string, user_id: string, node_id: string): Promise<unknown[]> {
    return (await this.sql.query(`SELECT DISTINCT a.* FROM media_assets a JOIN document_assets da ON da.workspace_id=a.workspace_id AND da.asset_id=a.id
      WHERE a.workspace_id=? AND a.deleting=0 AND (a.visibility='team' OR a.owner_user_id=?) AND da.document_id IN (
        SELECT document_id FROM graph_nodes WHERE workspace_id=? AND id=?
        UNION SELECT document_id FROM node_evidence WHERE workspace_id=? AND node_id=?)`, [ws, user_id, ws, node_id, ws, node_id]));
  }

  async listDocumentMediaAssets(this: Repo, ws: string, user_id: string, document_id: string): Promise<unknown[]> {
    return await this.sql.query(`SELECT DISTINCT a.* FROM media_assets a JOIN document_assets da ON da.workspace_id=a.workspace_id AND da.asset_id=a.id
      WHERE a.workspace_id=? AND a.deleting=0 AND da.document_id=? AND (a.visibility='team' OR a.owner_user_id=?)`, [ws, document_id, user_id]);
  }

  /**
   * Attachment-level access for an AI (MCP) read of an asset. `attached` says
   * whether the asset is linked to any document at all; `readable` says
   * whether at least one link reaches the viewer through AI-readable content:
   *   - a linked document visible under the aiRead document filter (it has an
   *     AI-readable note, or it has no notes and its ingest is readable), or
   *   - a node that cites a linked document through the evidence ledger and is
   *     itself AI-readable: team, or the viewer's own non-'only_me' node.
   * 'only_me' material never counts, even for its owner.
   */
  async getMediaAssetAiAttachment(this: Repo, ws: string, asset_id: string, viewer: string): Promise<{ attached: boolean; readable: boolean }> {
    const f = this.documentVisibilityFilter(viewer, { aiRead: true, alias: 'd' });
    const row = await this.sql.one<any>(`SELECT
        EXISTS(SELECT 1 FROM document_assets da0 WHERE da0.workspace_id=? AND da0.asset_id=?) AS attached,
        (EXISTS(SELECT 1 FROM document_assets da JOIN documents d ON d.workspace_id=da.workspace_id AND d.id=da.document_id
           WHERE da.workspace_id=? AND da.asset_id=?${f.sql})
         OR EXISTS(SELECT 1 FROM document_assets da2
           JOIN node_evidence ne ON ne.workspace_id=da2.workspace_id AND ne.document_id=da2.document_id
           JOIN graph_nodes n ON n.workspace_id=ne.workspace_id AND n.id=ne.node_id
           WHERE da2.workspace_id=? AND da2.asset_id=?
             AND (n.visibility='team' OR (n.owner_user_id=? AND n.visibility<>'only_me')))) AS readable`,
      [ws, asset_id, ws, asset_id, ...f.params, ws, asset_id, viewer]);
    return { attached: !!row?.attached, readable: !!row?.readable };
  }

  async listWorkspaceMediaAssets(this: Repo, ws: string): Promise<unknown[]> {
    return (await this.sql.query('SELECT * FROM media_assets WHERE workspace_id=?', [ws]));
  }

  async insertMediaIngestJob(this: Repo, ws: string, id: string, asset_id: string, user_id: string, payload: string, created_at: string, updated_at: string): Promise<ExecResult> {
    return (await this.sql.exec(`INSERT OR IGNORE INTO media_ingest_jobs
      (workspace_id,id,asset_id,user_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`, [ws, id, asset_id, user_id, payload, created_at, updated_at]));
  }

  async getMediaIngestJob(this: Repo, ws: string, id: string, user_id: string): Promise<unknown> {
    return (await this.sql.one('SELECT * FROM media_ingest_jobs WHERE workspace_id=? AND id=? AND user_id=?', [ws, id, user_id]));
  }

  async failMediaIngestJobDestination(this: Repo, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec("UPDATE media_ingest_jobs SET status='failed',attempts=3,error='destination_unavailable',lease_until=0 WHERE workspace_id=? AND id=?", [ws, id]));
  }

  async claimMediaIngestJob(this: Repo, lease_until: number, updated_at: string, ws: string, id: string, now: number): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE media_ingest_jobs SET status='running',attempts=attempts+1,lease_until=?,updated_at=?
      WHERE workspace_id=? AND id=? AND receipt IS NULL AND lease_until<?`, [lease_until, updated_at, ws, id, now]));
  }

  async completeMediaIngestJob(this: Repo, receipt: string, updated_at: string, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE media_ingest_jobs SET status='succeeded',receipt=?,error=NULL,lease_until=0,updated_at=? WHERE workspace_id=? AND id=?`, [receipt, updated_at, ws, id]));
  }

  async failMediaIngestJob(this: Repo, error: string, retry_at: number, updated_at: string, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE media_ingest_jobs SET status='failed',error=?,lease_until=0,retry_at=?,updated_at=? WHERE workspace_id=? AND id=?`, [error, retry_at, updated_at, ws, id]));
  }

  async listDueMediaIngestJobs(this: Repo, lease_before: number, retry_before: number): Promise<unknown[]> {
    return (await this.sql.query(`SELECT workspace_id,id,user_id FROM media_ingest_jobs
      WHERE receipt IS NULL AND attempts<3 AND lease_until<? AND retry_at<? ORDER BY created_at LIMIT 4`, [lease_before, retry_before]));
  }

  async listUnfiledMediaAssets(this: Repo, created_before: string, job_lease_after: number, run_lease_after: number): Promise<unknown[]> {
    return (await this.sql.query(`SELECT a.* FROM media_assets a WHERE a.created_at<?
      AND NOT EXISTS(SELECT 1 FROM document_assets d WHERE d.workspace_id=a.workspace_id AND d.asset_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM media_ingest_jobs j WHERE j.workspace_id=a.workspace_id AND j.asset_id=a.id AND j.lease_until>?)
      AND NOT EXISTS(SELECT 1 FROM data_agent_media_runs r WHERE r.workspace_id=a.workspace_id AND r.asset_id=a.id AND r.lease_until>?)
      LIMIT 10`, [created_before, job_lease_after, run_lease_after]));
  }

  async reserveMediaAssetDeletion(this: Repo, ws: string, id: string, job_lease_after: number, run_lease_after: number): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE media_assets SET deleting=1 WHERE workspace_id=? AND id=?
          AND NOT EXISTS(SELECT 1 FROM document_assets WHERE workspace_id=? AND asset_id=?)
          AND NOT EXISTS(SELECT 1 FROM media_ingest_jobs WHERE workspace_id=? AND asset_id=? AND lease_until>?)
          AND NOT EXISTS(SELECT 1 FROM data_agent_media_runs WHERE workspace_id=? AND asset_id=? AND lease_until>?)`, [ws, id, ws, id, ws, id, job_lease_after, ws, id, run_lease_after]));
  }

  async deleteMediaAsset(this: Repo, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec('DELETE FROM media_assets WHERE workspace_id=? AND id=?', [ws, id]));
  }

  async setMediaAssetVisibility(this: Repo, visibility: string, ws: string, id: string): Promise<ExecResult> {
    return (await this.sql.exec('UPDATE media_assets SET visibility=? WHERE workspace_id=? AND id=?', [visibility, ws, id]));
  }

  async listMediaBindings(this: Repo, ws: string, target: string): Promise<unknown[]> {
    return (await this.sql.query('SELECT capability,config,enabled,version FROM data_agent_media_bindings WHERE workspace_id=? AND target=?', [ws, target]));
  }

  async listMediaIngestJobsForUser(this: Repo, ws: string, user_id: string): Promise<unknown[]> {
    return (await this.sql.query(`SELECT j.id,j.status,j.error,j.asset_id,j.payload,a.original_name AS name
      FROM media_ingest_jobs j JOIN media_assets a ON a.workspace_id=j.workspace_id AND a.id=j.asset_id
      WHERE j.workspace_id=? AND j.user_id=? ORDER BY j.created_at DESC LIMIT 50`, [ws, user_id]));
  }

  async upsertMediaBinding(this: Repo, ws: string, target: string, capability: string, config: string, enabled: number, updated_at: string): Promise<ExecResult> {
    return (await this.sql.exec(`INSERT INTO data_agent_media_bindings(workspace_id,target,capability,config,enabled,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(workspace_id,target,capability) DO UPDATE SET config=excluded.config,enabled=excluded.enabled,version=version+1,updated_at=excluded.updated_at`, [ws, target, capability, config, enabled, updated_at]));
  }
}
