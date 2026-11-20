// the Db interface.
//
// Every repo module talks to the database through this interface, so the
// same module runs on SQLite (better-sqlite3, the default) and on
// Postgres (Azure Flexible Server) behind POMEGRANATE_DB_DRIVER.
//
// Rules the interface encodes:
//   - All methods are async. The SQLite adapter runs synchronously inside and
//     resolves immediately; the Postgres adapter really awaits.
//   - SQL uses `?` placeholders only. The Postgres adapter renumbers them to
//     $1..$n; nobody writes `$1` by hand.
//   - SQL must follow the portable rules in CONTRACTS.md §C2 (no INSERT OR
//     REPLACE, no datetime('now'), booleans 0/1, JSON as text). The few
//     functions that genuinely differ live on `db.dialect`.
//   - `withWorkspace` is how a request scopes itself to one tenant. On
//     Postgres it sets `app.workspace_id` for row-level security inside a
//     transaction; on SQLite it is a plain call (isolation stays enforced by
//     the WHERE workspace_id = ? every query already carries).
//
// Implementations: SQLite adapter, Postgres adapter.

export type SqlValue = string | number | bigint | Buffer | Uint8Array | null;

/** A result row. Column names are as selected; values are engine-normalised (see CONTRACTS.md §C1). */
export type Row = Record<string, unknown>;

export interface ExecResult {
  /** Rows inserted, updated or deleted by the statement. */
  changes: number;
}

export type DbDriver = 'sqlite' | 'pg';

/**
 * The handful of SQL fragments that cannot be written once for both engines.
 * Each returns a SQL snippet to splice into a query string. Arguments are SQL
 * expressions (usually a column name), never user input — user input still
 * goes through `?` parameters.
 */
export interface Dialect {
  readonly driver: DbDriver;
  /** Case-insensitive LIKE: `col LIKE ? COLLATE NOCASE` vs `col ILIKE ?`. */
  ilike(expr: string): string;
  /** Aggregate concat: `group_concat(expr, sep)` vs `string_agg(expr, sep)`. `sep` is a SQL string literal. */
  groupConcat(expr: string, sep?: string): string;
  /** Text value of a top-level JSON field: `json_extract(col, '$.f')` vs `(col::jsonb ->> 'f')`. */
  jsonText(column: string, field: string): string;
}

export interface DbQueryable {
  /** All rows. */
  query<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  /** First row, or undefined when there is none. */
  one<T extends Row = Row>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  /** A statement with no result rows (INSERT / UPDATE / DELETE / DDL). */
  exec(sql: string, params?: readonly SqlValue[]): Promise<ExecResult>;
  readonly dialect: Dialect;
}

export interface Db extends DbQueryable {
  readonly driver: DbDriver;
  /**
   * Run `fn` in one transaction. Commits when `fn` resolves, rolls back when
   * it throws. Use the `tx` handle inside — never the outer `db` — or the
   * statement runs outside the transaction on Postgres. Nested calls run in a
   * savepoint.
   */
  tx<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T>;
  /**
   * Run `fn` scoped to one workspace (Postgres: a transaction with
   * `SET LOCAL app.workspace_id`, which RLS policies read). Every
   * request-handling path that touches tenant data goes through this.
   */
  withWorkspace<T>(workspaceId: string, fn: (tx: DbQueryable) => Promise<T>): Promise<T>;
  /** Close the pool / file handle. Tests and graceful shutdown only. */
  close(): Promise<void>;
}

/** ISO-8601 UTC timestamp made in TypeScript — the only way timestamps enter SQL (§C2). */
export function nowIso(): string {
  return new Date().toISOString();
}
