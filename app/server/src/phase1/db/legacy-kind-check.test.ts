import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

// Regression: databases created before context profiles carried
// `CHECK (type IN ('goal','positioning','decision'))` on graph_nodes.
// CREATE TABLE IF NOT EXISTS never alters an existing table, so on those
// DBs approving any non-founding kind (e.g. product's `competitor`) failed
// with a CHECK error. migrate() must rebuild the table without the CHECK
// and preserve every row.

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  // The pre-profiles DDL, verbatim (minus columns later added by
  // addColumnIfMissing — the migration must cope with their presence too,
  // which mirrors a legacy DB that has already booted on newer code).
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'trial',
      created_at TEXT NOT NULL
    );
    CREATE TABLE graph_nodes (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('goal', 'positioning', 'decision')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX idx_graph_nodes_ws_status ON graph_nodes(workspace_id, status);
    CREATE INDEX idx_graph_nodes_ws_type ON graph_nodes(workspace_id, type);
    INSERT INTO workspaces VALUES ('ws_1', 'Legacy', 'o@x.com', 'trial', '2025-01-01');
    INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at)
      VALUES ('g-1', 'ws_1', 'goal', 'active', '{"id":"g-1"}', '2025-01-01', '2025-01-01');
  `);
  return db;
}

describe('legacy graph_nodes kind-CHECK rebuild', () => {
  it('drops the founding-only CHECK so non-founding kinds insert', () => {
    const db = legacyDb();
    // Sanity: the legacy constraint really blocks profile kinds.
    expect(() =>
      db
        .prepare(
          `INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at)
           VALUES ('c-1', 'ws_1', 'competitor', 'active', '{}', '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK/);

    migrate(db);

    // Existing rows survived the rebuild…
    const g = db.prepare(`SELECT type FROM graph_nodes WHERE id = 'g-1'`).get() as any;
    expect(g.type).toBe('goal');
    // …and non-founding kinds now insert (write-time profile validation is
    // the application layer's job, not the schema's).
    db.prepare(
      `INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at)
       VALUES ('c-1', 'ws_1', 'competitor', 'active', '{}', '2026-01-01', '2026-01-01')`,
    ).run();
    const c = db.prepare(`SELECT type FROM graph_nodes WHERE id = 'c-1'`).get() as any;
    expect(c.type).toBe('competitor');
    // The status CHECK is still enforced.
    expect(() =>
      db
        .prepare(
          `INSERT INTO graph_nodes (id, workspace_id, type, status, data, created_at, updated_at)
           VALUES ('c-2', 'ws_1', 'segment', 'bogus', '{}', '2026-01-01', '2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('is idempotent and a no-op on current databases', () => {
    const db = legacyDb();
    migrate(db);
    migrate(db); // second run must not throw or duplicate
    const ddl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'graph_nodes'`)
      .get() as any;
    expect(ddl.sql).not.toMatch(/CHECK\s*\(\s*type\s+IN/i);
    expect(db.prepare(`SELECT count(*) n FROM graph_nodes`).get()).toMatchObject({ n: 1 });

    const fresh = new Database(':memory:');
    migrate(fresh);
    migrate(fresh);
    expect(
      (fresh.prepare(`SELECT sql FROM sqlite_master WHERE name='graph_nodes'`).get() as any).sql,
    ).not.toMatch(/CHECK\s*\(\s*type\s+IN/i);
  });
});
