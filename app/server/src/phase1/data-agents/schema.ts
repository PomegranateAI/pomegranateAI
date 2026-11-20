import type Database from 'better-sqlite3';

export function migrateMedia(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_surface_deliveries (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, message_id TEXT NOT NULL, response TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,user_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS media_assets (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id TEXT NOT NULL, object_key TEXT NOT NULL, backend TEXT NOT NULL,
      original_name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','team')),
      created_at TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,id)
    );
    CREATE TABLE IF NOT EXISTS data_agent_media_bindings (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      target TEXT NOT NULL, capability TEXT NOT NULL CHECK(capability IN ('audio','image')),
      config TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,target,capability)
    );
    CREATE TABLE IF NOT EXISTS data_agent_media_runs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id TEXT NOT NULL, asset_id TEXT NOT NULL, config TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,id),
      FOREIGN KEY(workspace_id,asset_id) REFERENCES media_assets(workspace_id,id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS document_assets (
      workspace_id TEXT NOT NULL, document_id TEXT NOT NULL, version INTEGER NOT NULL,
      asset_id TEXT NOT NULL, run_id TEXT,
      PRIMARY KEY(workspace_id,document_id,version,asset_id),
      FOREIGN KEY(workspace_id,document_id) REFERENCES documents(workspace_id,id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id,asset_id) REFERENCES media_assets(workspace_id,id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_document_assets_asset ON document_assets(workspace_id,asset_id);
    CREATE TABLE IF NOT EXISTS media_ingest_jobs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id TEXT NOT NULL, asset_id TEXT NOT NULL, user_id TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, receipt TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id,id),
      FOREIGN KEY(workspace_id,asset_id) REFERENCES media_assets(workspace_id,id) ON DELETE CASCADE
    );
  `);
  const columns = db.prepare('PRAGMA table_info(media_assets)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'deleting')) {
    db.exec('ALTER TABLE media_assets ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0');
  }
}
