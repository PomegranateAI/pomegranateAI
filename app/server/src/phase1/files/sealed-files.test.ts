import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/schema.js';
import { createSqliteDb } from '../db/driver/sqlite.js';
import { cryptoFromEnv } from '../../lib/crypto/boot.js';
import type { Crypto } from '../../platform/crypto.js';
import { readWorkspaceText, sealExistingFiles, sealingAssetStore, writeWorkspaceFile } from './sealed-files.js';
import { LocalAssetStore } from '../data-agents/asset-store.js';

let dir: string;
let files: string;
let crypto: Crypto;
const CANARY = 'CANARY-Y8-fractions-plan';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pom-files-'));
  files = path.join(dir, 'files');
  const sql = createSqliteDb(openDb(path.join(dir, 'p.db')));
  crypto = cryptoFromEnv(sql, { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK: randomBytes(32).toString('base64') }).crypto;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('files at rest', () => {
  it('seals document text on disk and reads it back', async () => {
    const p = path.join(files, 'ws_a', 'docs', 'd1.v1.txt');
    await writeWorkspaceFile(crypto, 'ws_a', files, p, `notes ${CANARY}`);
    const raw = await fs.readFile(p);
    expect(raw.subarray(0, 4).toString()).toBe('PGE1');
    expect(raw.toString('latin1')).not.toContain(CANARY);
    expect(await readWorkspaceText(crypto, 'ws_a', files, p)).toBe(`notes ${CANARY}`);
  });

  it('a sealed file copied to another path or workspace does not open', async () => {
    const p = path.join(files, 'ws_a', 'docs', 'd1.v1.txt');
    await writeWorkspaceFile(crypto, 'ws_a', files, p, CANARY);
    const moved = path.join(files, 'ws_a', 'docs', 'd2.v1.txt');
    await fs.copyFile(p, moved);
    await expect(readWorkspaceText(crypto, 'ws_a', files, moved)).rejects.toThrow();
    const other = path.join(files, 'ws_b', 'docs', 'd1.v1.txt');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.copyFile(p, other);
    await expect(readWorkspaceText(crypto, 'ws_b', files, other)).rejects.toThrow();
  });

  it('legacy plaintext stays readable, and seal-files encrypts it in place', async () => {
    const p = path.join(files, 'ws_a', 'sources', 'abc.pdf');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, CANARY);
    expect(await readWorkspaceText(crypto, 'ws_a', files, p)).toBe(CANARY);
    expect(await sealExistingFiles(crypto, 'ws_a', files)).toEqual({ sealed: 1, already: 0 });
    expect((await fs.readFile(p)).toString('latin1')).not.toContain(CANARY);
    expect(await readWorkspaceText(crypto, 'ws_a', files, p)).toBe(CANARY);
    expect(await sealExistingFiles(crypto, 'ws_a', files)).toEqual({ sealed: 0, already: 1 });
  });

  it('media originals are sealed through the asset store, and shredding makes them unreadable', async () => {
    const store = sealingAssetStore(new LocalAssetStore(files), () => crypto);
    const key = 'ws_a/assets/as1/original';
    await store.put(key, Buffer.from(CANARY), 'image/png');
    expect((await fs.readFile(path.join(files, key))).toString('latin1')).not.toContain(CANARY);
    expect((await store.read(key)).toString()).toBe(CANARY);
    // Same label as document files: seal-files leaves it alone.
    expect((await sealExistingFiles(crypto, 'ws_a', files)).sealed).toBe(0);
    await crypto.shredWorkspace('ws_a');
    await expect(store.read(key)).rejects.toThrow();
  });
});
