// SQLite Db adapter: the C1 conformance cases (the same ones
// platform/db.conformance.test.ts runs against Postgres on azure-main) plus
// what is specific to sharing one better-sqlite3 handle with sync code.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Db } from '../../../platform/db.js';
import { createSqliteDb } from './sqlite.js';

const CREATE =
  'CREATE TABLE conf_items (workspace_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT, n INTEGER, f REAL, bin BLOB, flag INTEGER, PRIMARY KEY (workspace_id, id))';

let raw: BetterSqlite3.Database;
let db: Db;

beforeEach(async () => {
  raw = new BetterSqlite3(':memory:');
  db = createSqliteDb(raw);
  await db.exec(CREATE);
});
afterEach(async () => {
  await db.close();
  raw.close();
});

const insert = (d: { exec: Db['exec'] }, ws: string, id: string, text: string | null = null, n: number | null = null) =>
  d.exec('INSERT INTO conf_items (workspace_id, id, text, n) VALUES (?, ?, ?, ?)', [ws, id, text, n]);

describe('C1 Db conformance — SQLite (phase1/db/driver/sqlite.ts)', () => {
  it('round-trips integers, floats, text, null, binary, unicode and large text', async () => {
    const big = 'x'.repeat(1_000_000);
    const bin = Buffer.from([0, 1, 2, 254, 255]);
    await db.exec('INSERT INTO conf_items (workspace_id, id, text, n, f, bin, flag) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      'ws_a', 'r1', 'héllo — 漢字 🍎', 9_007_199_254_740_991, 0.1 + 0.2, bin, 1,
    ]);
    await db.exec('INSERT INTO conf_items (workspace_id, id, text) VALUES (?, ?, ?)', ['ws_a', 'r2', big]);
    await insert(db, 'ws_a', 'r3');
    const r1 = await db.one('SELECT text, n, f, bin, flag FROM conf_items WHERE id = ?', ['r1']);
    expect(r1).toEqual({ text: 'héllo — 漢字 🍎', n: 9_007_199_254_740_991, f: 0.1 + 0.2, bin, flag: 1 });
    expect(Buffer.isBuffer(r1!.bin)).toBe(true);
    expect((await db.one<{ text: string }>('SELECT text FROM conf_items WHERE id = ?', ['r2']))!.text).toHaveLength(1_000_000);
    expect(await db.one('SELECT text, n, bin FROM conf_items WHERE id = ?', ['r3'])).toEqual({ text: null, n: null, bin: null });
  });

  it('accepts a Uint8Array parameter and returns a Buffer', async () => {
    await db.exec('INSERT INTO conf_items (workspace_id, id, bin) VALUES (?, ?, ?)', ['ws_a', 'u8', new Uint8Array([7, 8, 9])]);
    const r = await db.one<{ bin: Buffer }>('SELECT bin FROM conf_items WHERE id = ?', ['u8']);
    expect(Buffer.isBuffer(r!.bin) && [...r!.bin]).toEqual([7, 8, 9]);
  });

  it('returns COUNT(*) and SUM as numbers, and one() undefined on no row', async () => {
    await insert(db, 'ws_a', 'a', null, 2);
    await insert(db, 'ws_a', 'b', null, 3);
    expect(await db.one('SELECT COUNT(*) AS c, SUM(n) AS s FROM conf_items')).toEqual({ c: 2, s: 5 });
    expect(await db.one('SELECT id FROM conf_items WHERE id = ?', ['missing'])).toBeUndefined();
  });

  it('leaves ? inside string literals untouched', async () => {
    await insert(db, 'ws_a', 'q', 'what?');
    const r = await db.one("SELECT 'is it?' AS t, id FROM conf_items WHERE text = ?", ['what?']);
    expect(r).toEqual({ t: 'is it?', id: 'q' });
  });

  it('reports changes for insert, update and delete', async () => {
    expect((await insert(db, 'ws_a', 'c1')).changes).toBe(1);
    await insert(db, 'ws_a', 'c2');
    expect((await db.exec('UPDATE conf_items SET n = ? WHERE workspace_id = ?', [1, 'ws_a'])).changes).toBe(2);
    expect((await db.exec('DELETE FROM conf_items WHERE id = ?', ['nope'])).changes).toBe(0);
  });

  it('upserts with ON CONFLICT DO UPDATE and DO NOTHING', async () => {
    const up =
      'INSERT INTO conf_items (workspace_id, id, text) VALUES (?, ?, ?) ON CONFLICT (workspace_id, id) DO UPDATE SET text = excluded.text';
    await db.exec(up, ['ws_a', 'u', 'one']);
    await db.exec(up, ['ws_a', 'u', 'two']);
    await db.exec('INSERT INTO conf_items (workspace_id, id, text) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', ['ws_a', 'u', 'three']);
    expect(await db.query('SELECT text FROM conf_items WHERE id = ?', ['u'])).toEqual([{ text: 'two' }]);
  });

  it('commits a transaction that resolves and rolls back one that throws', async () => {
    await db.tx(async (t) => {
      await insert(t, 'ws_a', 'ok');
    });
    await expect(
      db.tx(async (t) => {
        await insert(t, 'ws_a', 'gone');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query('SELECT id FROM conf_items ORDER BY id')).toEqual([{ id: 'ok' }]);
  });

  it('runs a nested tx as a savepoint', async () => {
    await db.tx(async (t) => {
      await insert(t, 'ws_a', 'outer');
      await expect(
        db.tx(async (inner) => {
          await insert(inner, 'ws_a', 'inner');
          throw new Error('inner fails');
        }),
      ).rejects.toThrow('inner fails');
      await insert(t, 'ws_a', 'after');
    });
    expect(await db.query('SELECT id FROM conf_items ORDER BY id')).toEqual([{ id: 'after' }, { id: 'outer' }]);
  });

  it('withWorkspace runs fn in a transaction and returns its value', async () => {
    const out = await db.withWorkspace('ws_a', async (t) => {
      await insert(t, 'ws_a', 'w');
      return 42;
    });
    expect(out).toBe(42);
    await expect(
      db.withWorkspace('ws_a', async (t) => {
        await insert(t, 'ws_a', 'w2');
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await db.query('SELECT id FROM conf_items')).toEqual([{ id: 'w' }]);
    expect(() => db.withWorkspace('', async () => 1)).toThrow();
  });

  it('rejects a placeholder/parameter count mismatch', async () => {
    await expect(db.query('SELECT id FROM conf_items WHERE id = ?', [])).rejects.toThrow();
    await expect(db.query('SELECT id FROM conf_items', ['extra'])).rejects.toThrow();
  });

  it('dialect helpers run', async () => {
    await insert(db, 'ws_a', 'd1', '{"kind":"Goal","n":5}');
    await insert(db, 'ws_a', 'd2', '{"kind":"note"}');
    const d = db.dialect;
    expect(await db.query(`SELECT id FROM conf_items WHERE ${d.ilike('text')} ORDER BY id`, ['%GOAL%'])).toEqual([{ id: 'd1' }]);
    expect(await db.one(`SELECT ${d.jsonText('text', 'kind')} AS k FROM conf_items WHERE id = ?`, ['d2'])).toEqual({ k: 'note' });
    // numbers come back as text, as with Postgres ->>
    expect(await db.one(`SELECT ${d.jsonText('text', 'n')} AS v FROM conf_items WHERE id = ?`, ['d1'])).toEqual({ v: '5' });
    const g = await db.one<{ ids: string }>(`SELECT ${d.groupConcat('id', "','")} AS ids FROM conf_items`);
    expect(g!.ids.split(',').sort()).toEqual(['d1', 'd2']);
    expect(() => d.groupConcat('id', ',')).toThrow();
    expect(() => d.jsonText('text', "x'); DROP TABLE t; --")).toThrow();
  });
});

describe('SQLite adapter on a shared better-sqlite3 handle', () => {
  it('sees writes made by sync code on the same handle, and vice versa', async () => {
    raw.prepare('INSERT INTO conf_items (workspace_id, id) VALUES (?, ?)').run('ws_a', 'sync');
    await insert(db, 'ws_a', 'async');
    expect(raw.prepare('SELECT COUNT(*) AS c FROM conf_items').get()).toEqual({ c: 2 });
    expect(await db.one('SELECT COUNT(*) AS c FROM conf_items')).toEqual({ c: 2 });
  });

  it('runs a multi-statement script through exec() when there are no parameters', async () => {
    await db.exec("CREATE TABLE s1 (x TEXT); INSERT INTO s1 VALUES ('a'); INSERT INTO s1 VALUES ('b');");
    expect(await db.query('SELECT x FROM s1 ORDER BY x')).toEqual([{ x: 'a' }, { x: 'b' }]);
  });

  it('makes a statement from another async context wait for an open transaction', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const t = db.tx(async (tx) => {
      await insert(tx, 'ws_a', 'in-tx');
      order.push('tx-wrote');
      await gate; // e.g. an LLM call in the middle of a transaction
      throw new Error('rollback');
    });
    // Not inside the tx: must not run inside it (it would be rolled back with it).
    const outside = (async () => {
      await new Promise((r) => setTimeout(r, 0));
      order.push('outside-start');
      await insert(db, 'ws_a', 'outside');
      order.push('outside-wrote');
    })();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['tx-wrote', 'outside-start']);
    release();
    await expect(t).rejects.toThrow('rollback');
    await outside;
    expect(order).toEqual(['tx-wrote', 'outside-start', 'outside-wrote']);
    expect(await db.query('SELECT id FROM conf_items')).toEqual([{ id: 'outside' }]);
  });

  it('serialises two top-level transactions', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = db.tx(async (t) => {
      await insert(t, 'ws_a', 'a');
      order.push('a1');
      await gate;
      order.push('a2');
    });
    const b = db.tx(async (t) => {
      order.push('b');
      await insert(t, 'ws_a', 'b');
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['a1']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    expect((await db.query('SELECT id FROM conf_items ORDER BY id')).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('close() leaves a handle it does not own open', async () => {
    await db.close();
    expect(raw.open).toBe(true);
    const owned = createSqliteDb(new BetterSqlite3(':memory:'), { ownsHandle: true });
    await owned.close();
  });

  it('keeps the statement cache bounded', async () => {
    const small = createSqliteDb(raw, { cacheSize: 3 });
    for (let i = 0; i < 10; i++) await small.query(`SELECT ${i} AS v`);
    expect(await small.one('SELECT 9 AS v')).toEqual({ v: 9 });
  });
});
