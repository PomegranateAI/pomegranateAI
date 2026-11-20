// SQLite adapter for the C1 Db interface.
//
// The default engine (POMEGRANATE_DB_DRIVER=sqlite,
// the default). It wraps an existing better-sqlite3 handle, so while the repo
// moves to Db one module at a time, the old synchronous code
// and the new async code share one connection and one transaction state.
//
// better-sqlite3 is synchronous, so every method runs the statement at once
// and resolves; the async signature is what lets one repo run on both
// engines. What the adapter adds:
//   - tx(): BEGIN / COMMIT / ROLLBACK around an async fn, nested calls as
//     savepoints, and a lock so a statement from another async context waits
//     instead of landing inside someone else's open transaction (the
//     connection is shared, so that is the one way async code could interleave);
//   - withWorkspace(): a transaction, exactly as on Postgres (no RLS here;
//     the WHERE workspace_id = ? on every query is the isolation);
//   - parameters: Uint8Array → Buffer, bigint passed through; a
//     placeholder/parameter count mismatch throws, as on Postgres;
//   - a bounded cache of prepared statements.
//
// Values come back as better-sqlite3 returns them, which is the C1 baseline
// the Postgres adapter normalises to: integers as number, BLOB as Buffer,
// text as string, booleans stored and returned as 0/1.

import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { Db, DbQueryable, Dialect, ExecResult, Row, SqlValue } from '../../../platform/db.js';

// ── Dialect ─────────────────────────────────────────────────────────────────

const SQL_STRING = /^'(?:[^']|'')*'$/;

export const sqliteDialect: Dialect = Object.freeze({
  driver: 'sqlite' as const,
  ilike: (expr: string) => `${expr} LIKE ? COLLATE NOCASE`,
  groupConcat: (expr: string, sep = "','") => {
    if (!SQL_STRING.test(sep)) throw new Error(`groupConcat separator must be a SQL string literal, got ${sep}`);
    return `group_concat(${expr}, ${sep})`;
  },
  // CAST to TEXT so numbers come back as text, like Postgres `->>`.
  jsonText: (column: string, field: string) => {
    if (!/^[A-Za-z0-9_]+$/.test(field)) throw new Error(`jsonText field must be a plain identifier, got ${field}`);
    return `CAST(json_extract(${column}, '$.${field}') AS TEXT)`;
  },
});

// ── Adapter ─────────────────────────────────────────────────────────────────

export interface SqliteDbOptions {
  /** Close the handle on db.close(). Default false: the caller (openDb) owns it. */
  ownsHandle?: boolean;
  /** Prepared-statement cache size. */
  cacheSize?: number;
}

function toParam(v: SqlValue): unknown {
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

interface TxFrame {
  depth: number;
}

export function createSqliteDb(raw: Database.Database, opts: SqliteDbOptions = {}): Db {
  const cacheSize = opts.cacheSize ?? 500;
  const cache = new Map<string, Database.Statement>();
  const current = new AsyncLocalStorage<TxFrame>();
  // The top-level transaction in flight, if any. Statements and transactions
  // from other async contexts wait for it to settle.
  let active: Promise<void> | null = null;

  function prepare(sql: string): Database.Statement {
    let st = cache.get(sql);
    if (st) {
      // refresh LRU position
      cache.delete(sql);
      cache.set(sql, st);
      return st;
    }
    st = raw.prepare(sql);
    cache.set(sql, st);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return st;
  }

  async function outsideOthersTx(): Promise<void> {
    if (current.getStore()) return;
    while (active) await active;
  }

  const params = (p: readonly SqlValue[] | undefined) => (p ?? []).map(toParam);

  const q: DbQueryable = {
    dialect: sqliteDialect,
    async query<T extends Row = Row>(sql: string, p?: readonly SqlValue[]): Promise<T[]> {
      await outsideOthersTx();
      return prepare(sql).all(...params(p)) as T[];
    },
    async one<T extends Row = Row>(sql: string, p?: readonly SqlValue[]): Promise<T | undefined> {
      await outsideOthersTx();
      return prepare(sql).get(...params(p)) as T | undefined;
    },
    async exec(sql: string, p?: readonly SqlValue[]): Promise<ExecResult> {
      await outsideOthersTx();
      let st: Database.Statement;
      try {
        st = prepare(sql);
      } catch (err) {
        // Several statements and no parameters (a migration): run them as a script.
        if ((p ?? []).length === 0 && /more than one statement/i.test((err as Error).message)) {
          raw.exec(sql);
          return { changes: 0 };
        }
        throw err;
      }
      return { changes: st.run(...params(p)).changes };
    },
  };

  async function tx<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T> {
    const frame = current.getStore();
    if (frame) {
      const name = `sp_${frame.depth + 1}`;
      raw.exec(`SAVEPOINT ${name}`);
      try {
        const out = await current.run({ depth: frame.depth + 1 }, () => fn(q));
        raw.exec(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err) {
        raw.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        raw.exec(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    }
    while (active) await active;
    let settle!: () => void;
    active = new Promise<void>((r) => (settle = r));
    try {
      raw.exec('BEGIN');
      try {
        const out = await current.run({ depth: 0 }, () => fn(q));
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        if (raw.inTransaction) raw.exec('ROLLBACK');
        throw err;
      }
    } finally {
      active = null;
      settle();
    }
  }

  return {
    driver: 'sqlite',
    dialect: sqliteDialect,
    query: q.query,
    one: q.one,
    exec: q.exec,
    tx,
    withWorkspace: (workspaceId, fn) => {
      if (!workspaceId) throw new Error('withWorkspace needs a workspace id');
      return tx(fn);
    },
    close: async () => {
      cache.clear();
      if (opts.ownsHandle) raw.close();
    },
  };
}
