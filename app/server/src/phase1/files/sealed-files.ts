// Encryption at rest for files on disk (C5).
//
// Everything a workspace stores under FILES_DIR — uploaded originals, the
// extracted text of each document, media assets — is sealed with that
// workspace's data key when POMEGRANATE_SEAL=1 (PGE1 bytes, AES-256-GCM),
// bound to the file's path relative to FILES_DIR so a file copied elsewhere
// fails to open. Deleting the workspace destroys the key, which makes its
// files unreadable on disk and in every backup.
//
// Files written before sealing was on stay readable as plaintext (they carry
// no PGE1 magic); `keys.js seal-files` encrypts them in place.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SEALED_BYTES_MAGIC, type Crypto } from '../../platform/crypto.js';
import type { AssetStore } from '../data-agents/asset-store.js';

const MAGIC = Buffer.from(SEALED_BYTES_MAGIC, 'utf8');

export function isSealedFile(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC);
}

/** AAD label for a file: its path relative to FILES_DIR, posix-style. */
export function fileContext(filesDir: string, absPath: string): string {
  return 'file:' + path.relative(path.resolve(filesDir), path.resolve(absPath)).split(path.sep).join('/');
}

export async function sealFileBytes(crypto: Crypto, ws: string, context: string, data: Buffer | string): Promise<Buffer> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return crypto.sealing ? crypto.sealBytes(ws, context, bytes) : bytes;
}

export async function openFileBytes(crypto: Crypto, ws: string, context: string, bytes: Buffer): Promise<Buffer> {
  return isSealedFile(bytes) ? crypto.openBytes(ws, context, bytes) : bytes;
}

/** Write a workspace file under FILES_DIR, sealed when sealing is on. */
export async function writeWorkspaceFile(
  crypto: Crypto,
  ws: string,
  filesDir: string,
  absPath: string,
  data: Buffer | string,
): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, await sealFileBytes(crypto, ws, fileContext(filesDir, absPath), data));
}

/** Read a workspace file under FILES_DIR (sealed or legacy plaintext). */
export async function readWorkspaceFile(crypto: Crypto, ws: string, filesDir: string, absPath: string): Promise<Buffer> {
  return openFileBytes(crypto, ws, fileContext(filesDir, absPath), await fs.readFile(absPath));
}

export async function readWorkspaceText(crypto: Crypto, ws: string, filesDir: string, absPath: string): Promise<string> {
  return (await readWorkspaceFile(crypto, ws, filesDir, absPath)).toString('utf8');
}

/**
 * Wrap an asset store so media originals are sealed too. Asset keys start with
 * the workspace id (`<ws>/assets/<id>/original`) and equal the file's path
 * under FILES_DIR, so they share the `file:<path>` label with every other file. `getCrypto` is read per call
 * because the server swaps repo.crypto in at boot.
 */
export function sealingAssetStore(inner: AssetStore, getCrypto: () => Crypto): AssetStore {
  const wsOf = (key: string) => key.split('/')[0]!;
  return {
    backend: inner.backend,
    async put(key, bytes, mime) {
      await inner.put(key, await sealFileBytes(getCrypto(), wsOf(key), `file:${key}`, bytes), mime);
    },
    async read(key) {
      return openFileBytes(getCrypto(), wsOf(key), `file:${key}`, await inner.read(key));
    },
    delete: (key) => inner.delete(key),
  };
}

/**
 * Encrypt, in place, every plaintext file of a workspace under FILES_DIR
 * (files written before sealing was on). Returns how many changed.
 */
export async function sealExistingFiles(crypto: Crypto, ws: string, filesDir: string): Promise<{ sealed: number; already: number }> {
  let sealed = 0;
  let already = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.isFile() || e.name.endsWith('.tmp')) continue;
      const bytes = await fs.readFile(p);
      if (isSealedFile(bytes)) {
        already++;
        continue;
      }
      const tmp = `${p}.seal.tmp`;
      await fs.writeFile(tmp, await crypto.sealBytes(ws, fileContext(filesDir, p), bytes));
      await fs.rename(tmp, p);
      sealed++;
    }
  };
  await walk(path.join(filesDir, ws));
  return { sealed, already };
}
