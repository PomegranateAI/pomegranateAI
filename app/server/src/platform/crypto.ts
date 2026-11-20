// the encryption API.
//
// Per-workspace envelope encryption: each workspace has a data-encryption key
// (DEK) wrapped by Pomegranate's key-encryption key (KEK — Key Vault on Azure,
// a local key in dev). Customer-held keys are NOT built (decision D).
//
// Text columns:  seal(ws, "<table>.<column>", rowId, text)
//                  → "v1:<keyVersion>:<nonce>:<ciphertext>"  (base64 parts)
//   Stays TEXT, so no column-type changes on either engine. The AAD binds
//   workspace id, column and row id, so a value copied into another row,
//   column or workspace fails to open.
// Binary:        sealBytes / openBytes, in the PGE1 format harvested from the
//   encryption branch (lib/at-rest.ts): MAGIC "PGE1" | kid | iv | tag | ct.
//   Used for embeddings and blob-store objects.
//
// Two setups, no data migration:
//   - POMEGRANATE_SEAL=0 (default): seal() returns the text unchanged and
//     sealBytes() the bytes unchanged; open() passes plaintext through.
//   - Azure, POMEGRANATE_SEAL=1 from its first write: there are no legacy
//     plaintext rows, so open()/openBytes() FAIL CLOSED on a value without
//     the v1: / PGE1 marker (CryptoError 'plaintext_refused'). A plaintext
//     value in a sealed column on Azure is a bug or tampering, never data.
//
// Implementation: A7 (lib/crypto/**). This file holds the contract and the
// pass-through implementation used with SEAL=0.

/** "<table>.<column>" — must be a key of SEAL_MAP (platform/seal-map.ts). */
export type SealColumn = string;

export const SEALED_TEXT_PREFIX = 'v1:';
export const SEALED_BYTES_MAGIC = 'PGE1';

export interface Crypto {
  /** True when this process actually encrypts (POMEGRANATE_SEAL=1). */
  readonly sealing: boolean;
  seal(workspaceId: string, column: SealColumn, rowId: string, text: string): Promise<string>;
  /** Plaintext. Throws CryptoError on tamper or unknown key, and (when sealing) on a value without the v1: prefix. */
  open(workspaceId: string, column: SealColumn, rowId: string, value: string): Promise<string>;
  /** `context` is a stable label for the AAD, e.g. "graph_nodes.embedding:<id>" or a blob key. */
  sealBytes(workspaceId: string, context: string, bytes: Uint8Array): Promise<Buffer>;
  /** When sealing, bytes without the PGE1 magic are refused. */
  openBytes(workspaceId: string, context: string, bytes: Uint8Array): Promise<Buffer>;
  /**
   * Destroy the workspace's DEK. Every sealed value of that workspace becomes
   * unreadable (crypto-shred deletion, inventory 4.6). Irreversible.
   */
  shredWorkspace(workspaceId: string): Promise<void>;
}

export type CryptoErrorCode =
  | 'tampered'
  | 'unknown_key_version'
  | 'key_unwrap_failed'
  | 'workspace_shredded'
  | 'plaintext_refused';

export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CryptoError';
  }
}

/** True when `value` is a sealed text value (and so must go through open()). */
export function isSealedText(value: string): boolean {
  return value.startsWith(SEALED_TEXT_PREFIX);
}

/** True when `bytes` start with the PGE1 magic. */
export function isSealedBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === SEALED_BYTES_MAGIC;
}

/**
 * POMEGRANATE_SEAL=0: the identity on write, pass-through on read. Reading a
 * value that IS sealed throws — a SEAL=0 process has no keys, and returning
 * ciphertext as if it were text would corrupt whatever reads it next.
 */
export function passthroughCrypto(): Crypto {
  return {
    sealing: false,
    async seal(_ws, _col, _id, text) {
      return text;
    },
    async open(_ws, col, _id, value) {
      if (isSealedText(value)) throw new CryptoError('key_unwrap_failed', `sealed value in ${col} but sealing is off`);
      return value;
    },
    async sealBytes(_ws, _ctx, bytes) {
      return Buffer.from(bytes);
    },
    async openBytes(_ws, ctx, bytes) {
      if (isSealedBytes(bytes)) throw new CryptoError('key_unwrap_failed', `sealed bytes for ${ctx} but sealing is off`);
      return Buffer.from(bytes);
    },
    async shredWorkspace() {
      // Nothing is sealed, so there is no key to destroy; deletion falls back
      // to deleting the rows (today's behaviour).
    },
  };
}
