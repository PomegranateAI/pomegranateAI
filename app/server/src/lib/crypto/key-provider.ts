// Key providers (A7, inventory 4.1) — the KEK side of C3's envelope encryption
//.
//
// Each workspace has a 32-byte data key (DEK). The DEK is stored only in
// wrapped form (workspace_keys.wrapped_dek, item 4.3); a KeyProvider turns a
// wrapped DEK back into the raw key and back again. Two providers:
//
//   local    LocalKeyProvider — a master key from POMEGRANATE_LOCAL_KEK.
//            Tests, dev and single-server installs.
//   azurekv  AzureKeyVaultProvider — RSA-OAEP-256 wrap/unwrap on the
//            kek-tenant-data key in Key Vault. The KEK never leaves the vault.
//
// Selected by C9 POMEGRANATE_KEY_PROVIDER. Nothing here reads process.env:
// the caller passes config values in (C7).
//
// DekCache sits in front of either provider: unwrapped DEKs stay in memory
// for 15 minutes, and concurrent misses for the same key share one unwrap,
// so a burst of reads costs one Key Vault call, not one per row.
//
// Never log, return in an error, or otherwise print a key — raw or wrapped.

import { randomBytes } from 'node:crypto';
import { CryptoError } from '../../platform/crypto.js';

export const DEK_BYTES = 32;

/** A DEK as stored: the wrapped bytes plus which KEK version wrapped them. */
export interface WrappedDek {
  wrapped: Buffer;
  /** The KEK version that produced `wrapped` (workspace_keys.kek_version). */
  kekVersion: string;
}

export interface KeyProvider {
  readonly kind: 'local' | 'azurekv';
  /** Wrap a raw DEK with the CURRENT KEK version. */
  wrap(dek: Buffer): Promise<WrappedDek>;
  /** Unwrap with whichever KEK version `w.kekVersion` names. Throws CryptoError('key_unwrap_failed'). */
  unwrap(w: WrappedDek): Promise<Buffer>;
  /** The KEK version wrap() uses now. KEK rotation rewraps every DEK not on it. */
  currentKekVersion(): Promise<string>;
}

/** A fresh random DEK. */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/** Wrap `fn`'s failures as key_unwrap_failed without echoing anything key-shaped. */
export async function unwrapOrThrow(what: string, fn: () => Promise<Buffer>): Promise<Buffer> {
  let dek: Buffer;
  try {
    dek = await fn();
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    // The underlying message can carry vault URLs or request ids but never
    // key bytes; keep only its class name to stay safe either way.
    throw new CryptoError('key_unwrap_failed', `${what}: ${(err as Error)?.name ?? 'error'}`);
  }
  if (dek.length !== DEK_BYTES) throw new CryptoError('key_unwrap_failed', `${what}: unwrapped key has the wrong length`);
  return dek;
}

export interface DekCacheOptions {
  /** Default 15 minutes (plan: A7 4.1). */
  ttlMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  /** Called once per failed unwrap — 4.3 wires this to the key.unwrap_failed audit event. */
  onUnwrapFailed?: (workspaceId: string, keyVersion: number, err: CryptoError) => void;
}

interface Entry {
  dek: Buffer;
  expiresAt: number;
}

/**
 * In-memory cache of unwrapped DEKs, keyed by workspace + DEK version, with
 * one in-flight unwrap per key. Failures are not cached: the next read
 * retries (a Key Vault blip must not pin a workspace dark for 15 minutes).
 */
export class DekCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  // Bumped by evict(): an unwrap that started before the eviction must not
  // repopulate the cache when it lands (shred → late unwrap → key resurrected).
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly provider: KeyProvider,
    private readonly opts: DekCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async get(workspaceId: string, keyVersion: number, wrapped: WrappedDek): Promise<Buffer> {
    const k = `${workspaceId}\u0000${keyVersion}`;
    const hit = this.entries.get(k);
    if (hit && hit.expiresAt > this.now()) return hit.dek;
    if (hit) this.entries.delete(k);

    const pending = this.inflight.get(k);
    if (pending) return pending;

    const gen = this.generation.get(workspaceId) ?? 0;
    const p = unwrapOrThrow(`workspace key v${keyVersion}`, () => this.provider.unwrap(wrapped))
      .then((dek) => {
        if ((this.generation.get(workspaceId) ?? 0) === gen) {
          this.entries.set(k, { dek, expiresAt: this.now() + this.ttlMs });
        }
        return dek;
      })
      .catch((err: CryptoError) => {
        this.opts.onUnwrapFailed?.(workspaceId, keyVersion, err);
        throw err;
      })
      .finally(() => {
        if (this.inflight.get(k) === p) this.inflight.delete(k);
      });
    this.inflight.set(k, p);
    return p;
  }

  /** Put a DEK we just minted (no unwrap needed). */
  prime(workspaceId: string, keyVersion: number, dek: Buffer): void {
    this.entries.set(`${workspaceId}\u0000${keyVersion}`, { dek, expiresAt: this.now() + this.ttlMs });
  }

  /** Drop every cached version for a workspace (shred, key retirement). */
  evict(workspaceId: string): void {
    this.generation.set(workspaceId, (this.generation.get(workspaceId) ?? 0) + 1);
    const prefix = `${workspaceId}\u0000`;
    for (const k of [...this.entries.keys()]) {
      // Not zeroed: a seal/open already holding this buffer must finish intact.
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
    for (const k of [...this.inflight.keys()]) if (k.startsWith(prefix)) this.inflight.delete(k);
  }

  /** Number of live cached keys — for tests and metrics, never the keys themselves. */
  size(): number {
    return this.entries.size;
  }
}
