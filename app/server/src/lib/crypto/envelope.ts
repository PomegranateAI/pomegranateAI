// seal / open (A7, inventory 4.2) — the C3 Crypto contract implemented with
// per-workspace DEKs.
//
// Text:   seal(ws, "<table>.<column>", rowId, text)
//           → "v1:<keyVersion>:<nonce b64>:<ciphertext+tag b64>"
//         AES-256-GCM under the workspace DEK. The AAD binds the workspace,
//         the column and the row id, so a value copied into another row,
//         column or workspace fails to open ('tampered').
// Bytes:  sealBytes(ws, context, bytes) → PGE1 | kid(8) | iv(12) | tag(16) | ct
//         kid = the DEK version, 8 bytes big-endian. Same AAD idea, bound to
//         `context` (e.g. "graph_nodes.embedding:<id>" or a blob key).
//
// This is the SEAL=1 implementation: open/openBytes FAIL CLOSED on a value
// without the v1: / PGE1 marker ('plaintext_refused'). A sealed column that
// holds plaintext is a bug or tampering, never data.
//
// JSON columns sealed field by field (seal-map kind 'json-fields') go through
// sealJsonFields / openJsonFields below, which seal each listed top-level field
// under the column name "<table>.<column>#<field>".

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  CryptoError,
  SEALED_BYTES_MAGIC,
  SEALED_TEXT_PREFIX,
  isSealedBytes,
  isSealedText,
  type Crypto,
} from '../../platform/crypto.js';
import { sealEntry } from '../../platform/seal-map.js';
import type { WorkspaceKeyStore } from './key-store.js';

const IV = 12;
const TAG = 16;
const KID = 8;
const MAGIC = Buffer.from(SEALED_BYTES_MAGIC, 'ascii');

function textAad(ws: string, column: string, rowId: string): Buffer {
  return Buffer.from(`pomegranate/seal/v1\u0000${ws}\u0000${column}\u0000${rowId}`, 'utf8');
}

function bytesAad(ws: string, context: string): Buffer {
  return Buffer.from(`pomegranate/seal-bytes/v1\u0000${ws}\u0000${context}`, 'utf8');
}

/** Sealing a column that isn't in the seal map is a programming error. */
function assertMapped(column: string): void {
  const base = column.split('#', 1)[0]!;
  if (!sealEntry(base)) throw new Error(`seal: ${base} is not in the seal map (platform/seal-map.ts)`);
}

function encrypt(dek: Buffer, aad: Buffer, plain: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function decrypt(dek: Buffer, aad: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, what: string): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError('tampered', `${what} failed authentication`);
  }
}

function parseVersion(raw: string | undefined, what: string): number {
  const v = Number(raw);
  if (!raw || !Number.isInteger(v) || v < 1) throw new CryptoError('tampered', `${what} has a malformed key version`);
  return v;
}

export function envelopeCrypto(keys: WorkspaceKeyStore): Crypto {
  return {
    sealing: true,

    async seal(ws, column, rowId, text) {
      assertMapped(column);
      const key = await keys.activeKey(ws);
      const { iv, ct, tag } = encrypt(key.dek, textAad(ws, column, rowId), Buffer.from(text, 'utf8'));
      return `${SEALED_TEXT_PREFIX}${key.version}:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
    },

    async open(ws, column, rowId, value) {
      if (!isSealedText(value)) throw new CryptoError('plaintext_refused', `${column} holds a value that isn't sealed`);
      const parts = value.slice(SEALED_TEXT_PREFIX.length).split(':');
      if (parts.length !== 3) throw new CryptoError('tampered', `${column} value is malformed`);
      const version = parseVersion(parts[0], column);
      const iv = Buffer.from(parts[1]!, 'base64');
      const body = Buffer.from(parts[2]!, 'base64');
      if (iv.length !== IV || body.length < TAG) throw new CryptoError('tampered', `${column} value is malformed`);
      const dek = await keys.keyFor(ws, version);
      return decrypt(dek, textAad(ws, column, rowId), iv, body.subarray(0, body.length - TAG), body.subarray(body.length - TAG), column).toString('utf8');
    },

    async sealBytes(ws, context, bytes) {
      const key = await keys.activeKey(ws);
      const { iv, ct, tag } = encrypt(key.dek, bytesAad(ws, context), Buffer.from(bytes));
      const kid = Buffer.alloc(KID);
      kid.writeBigUInt64BE(BigInt(key.version));
      return Buffer.concat([MAGIC, kid, iv, tag, ct]);
    },

    async openBytes(ws, context, bytes) {
      if (!isSealedBytes(bytes)) throw new CryptoError('plaintext_refused', `${context} holds bytes that aren't sealed`);
      const buf = Buffer.from(bytes);
      const head = MAGIC.length + KID + IV + TAG;
      if (buf.length < head) throw new CryptoError('tampered', `${context} bytes are malformed`);
      const big = buf.readBigUInt64BE(MAGIC.length);
      if (big < 1n || big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CryptoError('tampered', `${context} has a malformed key version`);
      const iv = buf.subarray(MAGIC.length + KID, MAGIC.length + KID + IV);
      const tag = buf.subarray(MAGIC.length + KID + IV, head);
      const dek = await keys.keyFor(ws, Number(big));
      return decrypt(dek, bytesAad(ws, context), iv, buf.subarray(head), tag, context);
    },

    async shredWorkspace(ws) {
      await keys.shredWorkspace(ws);
    },
  };
}

/**
 * Seal the listed top-level fields of a JSON value (seal-map kind
 * 'json-fields'): each string field becomes a v1: value; everything else
 * (title, type, attrs…) stays readable. Non-string and absent fields are left
 * alone. Returns a new object.
 */
export async function sealJsonFields<T extends Record<string, unknown>>(
  crypto: Crypto,
  ws: string,
  column: string,
  rowId: string,
  value: T,
): Promise<T> {
  const entry = sealEntry(column);
  if (entry?.kind !== 'json-fields' || !entry.fields) throw new Error(`seal: ${column} is not a json-fields column`);
  if (!crypto.sealing) return value;
  const out: Record<string, unknown> = { ...value };
  for (const f of entry.fields) {
    const v = out[f];
    if (typeof v === 'string') out[f] = await crypto.seal(ws, `${column}#${f}`, rowId, v);
  }
  return out as T;
}

/** Inverse of sealJsonFields. Under SEAL=1 a listed field holding plaintext is refused. */
export async function openJsonFields<T extends Record<string, unknown>>(
  crypto: Crypto,
  ws: string,
  column: string,
  rowId: string,
  value: T,
): Promise<T> {
  const entry = sealEntry(column);
  if (entry?.kind !== 'json-fields' || !entry.fields) throw new Error(`open: ${column} is not a json-fields column`);
  const out: Record<string, unknown> = { ...value };
  for (const f of entry.fields) {
    const v = out[f];
    if (typeof v === 'string') out[f] = await crypto.open(ws, `${column}#${f}`, rowId, v);
  }
  return out as T;
}
