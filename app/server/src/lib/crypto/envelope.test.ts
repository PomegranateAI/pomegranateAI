import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { migrate, openDb } from '../../phase1/db/schema.js';
import { Repo } from '../../phase1/db/repo.js';
import { buildApp } from '../../phase1/api/routes.js';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { CryptoError, passthroughCrypto } from '../../platform/crypto.js';
import { envelopeCrypto, openJsonFields, sealJsonFields } from './envelope.js';
import { WorkspaceKeyStore } from './key-store.js';
import { localKeyProvider } from './local.js';
import { cryptoFromEnv } from './boot.js';

function setup(kek = randomBytes(32), previous: Buffer[] = []) {
  const db = new Database(':memory:');
  migrate(db);
  const repo = new Repo(db);
  const onUnwrapFailed = vi.fn();
  const keys = new WorkspaceKeyStore(repo.sql, localKeyProvider({ current: kek, previous }), { onUnwrapFailed });
  return { db, repo, keys, crypto: envelopeCrypto(keys), kek, onUnwrapFailed };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CryptoError) return e.code;
    throw e;
  }
  return 'resolved';
}

describe('seal / open (text)', () => {
  it('round-trips, in the v1:<version>:<nonce>:<ct> format, with a fresh nonce each time', async () => {
    const { crypto } = setup();
    const a = await crypto.seal('ws_a', 'source_chunks.text', 'row1', 'Year 9 moderation notes');
    const b = await crypto.seal('ws_a', 'source_chunks.text', 'row1', 'Year 9 moderation notes');
    expect(a).toMatch(/^v1:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('moderation');
    expect(await crypto.open('ws_a', 'source_chunks.text', 'row1', a)).toBe('Year 9 moderation notes');
    expect(await crypto.open('ws_a', 'source_chunks.text', 'row1', await crypto.seal('ws_a', 'source_chunks.text', 'row1', ''))).toBe('');
  });

  it('binds workspace, column and row: a copied value fails to open', async () => {
    const { crypto } = setup();
    const v = await crypto.seal('ws_a', 'source_chunks.text', 'row1', 'secret');
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'row2', v))).toBe('tampered');
    expect(await code(crypto.open('ws_a', 'documents.summary', 'row1', v))).toBe('tampered');
    await crypto.seal('ws_b', 'source_chunks.text', 'x', 'mint ws_b key');
    expect(await code(crypto.open('ws_b', 'source_chunks.text', 'row1', v))).toBe('tampered');
  });

  it('detects tampering and malformed values, and refuses plaintext (fail closed)', async () => {
    const { crypto } = setup();
    const v = await crypto.seal('ws_a', 'source_chunks.text', 'row1', 'secret');
    const [p, ver, nonce, body] = v.split(':');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] ^= 1;
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'row1', `${p}:${ver}:${nonce}:${flipped.toString('base64')}`))).toBe('tampered');
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'row1', `v1:1:${nonce}`))).toBe('tampered');
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'row1', `v1:7:${nonce}:${body}`))).toBe('unknown_key_version');
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'row1', 'plain text'))).toBe('plaintext_refused');
  });

  it('refuses a column that is not in the seal map', async () => {
    const { crypto } = setup();
    await expect(crypto.seal('ws_a', 'graph_nodes.title', 'r', 'x')).rejects.toThrow(/not in the seal map/);
  });
});

describe('sealBytes / openBytes (PGE1)', () => {
  it('round-trips with the PGE1 | kid | iv | tag | ct layout, bound to its context', async () => {
    const { crypto } = setup();
    const emb = Buffer.from(new Float32Array([0.1, -0.2, 0.3]).buffer);
    const sealed = await crypto.sealBytes('ws_a', 'graph_nodes.embedding:n1', emb);
    expect(sealed.subarray(0, 4).toString('ascii')).toBe('PGE1');
    expect(sealed.readBigUInt64BE(4)).toBe(1n);
    expect(sealed.length).toBe(4 + 8 + 12 + 16 + emb.length);
    expect((await crypto.openBytes('ws_a', 'graph_nodes.embedding:n1', sealed)).equals(emb)).toBe(true);
    expect(await code(crypto.openBytes('ws_a', 'graph_nodes.embedding:n2', sealed))).toBe('tampered');
    const bad = Buffer.from(sealed);
    bad[bad.length - 1] ^= 1;
    expect(await code(crypto.openBytes('ws_a', 'graph_nodes.embedding:n1', bad))).toBe('tampered');
    expect(await code(crypto.openBytes('ws_a', 'graph_nodes.embedding:n1', emb))).toBe('plaintext_refused');
  });
});

describe('json-fields columns', () => {
  it('seals only the listed fields; title, type and attrs stay readable', async () => {
    const { crypto } = setup();
    const node = { type: 'decision', title: 'Homework cap', body: 'Max 30 minutes for Years 7–9', attrs: { owner: 'maths' } };
    const sealed = await sealJsonFields(crypto, 'ws_a', 'graph_nodes.data', 'n1', node);
    expect(sealed.title).toBe('Homework cap');
    expect(sealed.attrs).toEqual({ owner: 'maths' });
    expect(sealed.body).toMatch(/^v1:/);
    expect(JSON.stringify(sealed)).not.toContain('30 minutes');
    expect(await openJsonFields(crypto, 'ws_a', 'graph_nodes.data', 'n1', sealed)).toEqual(node);
    // Field-bound: a body moved into another json column doesn't open.
    expect(await code(openJsonFields(crypto, 'ws_a', 'candidates.proposed_node', 'n1', sealed))).toBe('tampered');
  });

  it('is the identity under pass-through (SEAL=0)', async () => {
    const pt = passthroughCrypto();
    const node = { title: 't', body: 'b' };
    expect(await sealJsonFields(pt, 'ws', 'graph_nodes.data', 'n', node)).toEqual(node);
    expect(await openJsonFields(pt, 'ws', 'graph_nodes.data', 'n', node)).toEqual(node);
  });
});

describe('workspace keys (DEK lifecycle)', () => {
  it('mints version 1 lazily, stores it only wrapped, and never writes the DEK raw', async () => {
    const { db, keys, crypto } = setup();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workspace_keys`).get()).toEqual({ n: 0 });
    await crypto.seal('ws_a', 'source_chunks.text', 'r', 'x');
    const rows = db.prepare(`SELECT version, wrapped_dek, kek_version FROM workspace_keys`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].kek_version).toMatch(/^local-[0-9a-f]{8}$/);
    const dek = (await keys.activeKey('ws_a')).dek;
    expect(Buffer.from(rows[0].wrapped_dek).includes(dek)).toBe(false);
  });

  it('concurrent first seals share one key', async () => {
    const { db, crypto } = setup();
    const values = await Promise.all(
      Array.from({ length: 8 }, (_, i) => crypto.seal('ws_race', 'source_chunks.text', `r${i}`, `v${i}`)),
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = 'ws_race'`).get()).toEqual({ n: 1 });
    for (let i = 0; i < 8; i++) expect(await crypto.open('ws_race', 'source_chunks.text', `r${i}`, values[i]!)).toBe(`v${i}`);
  });

  it('rotateDek: new values use the new version, old values still open', async () => {
    const { db, keys, crypto } = setup();
    const old = await crypto.seal('ws_a', 'source_chunks.text', 'r', 'before');
    expect(await keys.rotateDek('ws_a')).toBe(2);
    const fresh = await crypto.seal('ws_a', 'source_chunks.text', 'r', 'after');
    expect(fresh.startsWith('v1:2:')).toBe(true);
    expect(await crypto.open('ws_a', 'source_chunks.text', 'r', old)).toBe('before');
    expect(await crypto.open('ws_a', 'source_chunks.text', 'r', fresh)).toBe('after');
    const retired = db.prepare(`SELECT version FROM workspace_keys WHERE retired_at IS NOT NULL`).all();
    expect(retired).toEqual([{ version: 1 }]);
  });

  it('KEK rotation: rewrapAll moves every DEK to the new KEK; the old KEK can then be dropped', async () => {
    const a = setup();
    const v = await a.crypto.seal('ws_a', 'source_chunks.text', 'r', 'kept across KEK rotation');
    await a.crypto.seal('ws_b', 'source_chunks.text', 'r', 'other workspace');
    const newKek = randomBytes(32);
    // Restart with the new KEK current and the old one as previous.
    const rotated = new WorkspaceKeyStore(a.repo.sql, localKeyProvider({ current: newKek, previous: [a.kek] }));
    expect(await rotated.rewrapAll()).toBe(2);
    expect(await rotated.rewrapAll()).toBe(0); // idempotent
    // Restart again with ONLY the new KEK: everything still opens.
    const only = envelopeCrypto(new WorkspaceKeyStore(a.repo.sql, localKeyProvider({ current: newKek })));
    expect(await only.open('ws_a', 'source_chunks.text', 'r', v)).toBe('kept across KEK rotation');
  });

  it('a wrong KEK fails closed with key_unwrap_failed and reports it', async () => {
    const a = setup();
    const v = await a.crypto.seal('ws_a', 'source_chunks.text', 'r', 'x');
    const onUnwrapFailed = vi.fn();
    const wrong = envelopeCrypto(new WorkspaceKeyStore(a.repo.sql, localKeyProvider({ current: randomBytes(32) }), { onUnwrapFailed }));
    expect(await code(wrong.open('ws_a', 'source_chunks.text', 'r', v))).toBe('key_unwrap_failed');
    expect(onUnwrapFailed).toHaveBeenCalledWith('ws_a', 1, expect.any(CryptoError));
  });

  it('shred: the workspace’s values become unreadable and no new key is minted; others are untouched', async () => {
    const { db, crypto } = setup();
    const a = await crypto.seal('ws_a', 'source_chunks.text', 'r', 'gone');
    const b = await crypto.seal('ws_b', 'source_chunks.text', 'r', 'stays');
    await crypto.shredWorkspace('ws_a');
    expect(await code(crypto.open('ws_a', 'source_chunks.text', 'r', a))).toBe('workspace_shredded');
    expect(await code(crypto.seal('ws_a', 'source_chunks.text', 'r', 'new'))).toBe('workspace_shredded');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = 'ws_a'`).get()).toEqual({ n: 0 });
    expect(await crypto.open('ws_b', 'source_chunks.text', 'r', b)).toBe('stays');
  });
});

describe('boot (cryptoFromEnv)', () => {
  const kek = randomBytes(32).toString('base64');
  const sql = () => {
    const db = new Database(':memory:');
    migrate(db);
    return new Repo(db).sql;
  };

  it('is pass-through unless POMEGRANATE_SEAL=1', () => {
    expect(cryptoFromEnv(sql(), {}).crypto.sealing).toBe(false);
    expect(cryptoFromEnv(sql(), { POMEGRANATE_SEAL: '0', POMEGRANATE_LOCAL_KEK: kek }).crypto.sealing).toBe(false);
  });

  it('SEAL=1 needs a valid local KEK, and refuses azurekv on this build', () => {
    expect(() => cryptoFromEnv(sql(), { POMEGRANATE_SEAL: '1' })).toThrow(/POMEGRANATE_LOCAL_KEK/);
    expect(() => cryptoFromEnv(sql(), { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK: 'too-short' })).toThrow(/32 random bytes/);
    expect(() => cryptoFromEnv(sql(), { POMEGRANATE_SEAL: '1', POMEGRANATE_KEY_PROVIDER: 'azurekv', POMEGRANATE_LOCAL_KEK: kek })).toThrow(/azurekv/);
    expect(() => cryptoFromEnv(sql(), { POMEGRANATE_SEAL: 'yes' })).toThrow();
    const boot = cryptoFromEnv(sql(), { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK: kek });
    expect(boot.crypto.sealing).toBe(true);
    expect(boot.keys).toBeDefined();
  });
});

describe('on SQLite, end to end', () => {
  it('nothing sealed is readable in the database file, and deleting the folder shreds its key', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-seal-'));
    const dbPath = path.join(dir, 'db.sqlite');
    const repo = new Repo(openDb(dbPath));
    repo.crypto = cryptoFromEnv(repo.sql, { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK: randomBytes(32).toString('base64') }).crypto;
    const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
    const j = (r: Response) => r.json() as Promise<any>;
    const m = await j(await app.request('/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'seal@example.com' }) }));
    const s = await j(await app.request('/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m.dev_code }) }));
    const auth = { 'content-type': 'application/json', Authorization: `Bearer ${s.session}` };
    const ws = await j(await app.request('/workspaces', { method: 'POST', headers: auth, body: JSON.stringify({ profile_id: 'notes', name: 'Sealed' }) }));

    const CANARY = 'CANARY-7f3a-sealed-chunk-text';
    const sealed = await repo.crypto.seal(ws.id, 'source_chunks.text', 'chunk1', CANARY);
    repo.db.prepare(`CREATE TABLE IF NOT EXISTS t_canary (v TEXT)`).run();
    repo.db.prepare(`INSERT INTO t_canary (v) VALUES (?)`).run(sealed);
    repo.db.pragma('wal_checkpoint(TRUNCATE)');
    expect((await readFile(dbPath)).includes(Buffer.from(CANARY))).toBe(false);

    const del = await app.request(`/workspaces/${ws.id}`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(200);
    expect(await code(repo.crypto.open(ws.id, 'source_chunks.text', 'chunk1', sealed))).toBe('workspace_shredded');
    repo.db.close();
  });
});
