// LocalKeyProvider (A7 4.1): DEKs wrapped by a master key held in config
// (POMEGRANATE_LOCAL_KEK). Used by tests, dev and single-server installs;
// with POMEGRANATE_KEY_PROVIDER=azurekv the KEK lives in Key Vault instead.
//
// Wrap = AES-256-GCM under the KEK: iv(12) | tag(16) | wrapped DEK(32), with
// a fixed AAD so the same KEK can't be confused with any other use of it.
//
// KEK value: 32 random bytes, base64 (`openssl rand -base64 32`). Rotation:
// pass the old keys as `previous`; they can still unwrap, only `current`
// wraps. A KEK's version is a short fingerprint of the key (8 hex chars of a
// domain-separated SHA-256), so a wrapped DEK names the KEK that opens it
// without the config having to number them.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CryptoError } from '../../platform/crypto.js';
import { DEK_BYTES, unwrapOrThrow, type KeyProvider, type WrappedDek } from './key-provider.js';

const WRAP_AAD = Buffer.from('pomegranate/dek-wrap/v1', 'utf8');
const IV = 12;
const TAG = 16;

/** Parse a POMEGRANATE_LOCAL_KEK value. Throws (without echoing it) unless it is 32 bytes of base64. */
export function parseLocalKek(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = Buffer.from(trimmed, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || key.length !== 32) {
    throw new Error('POMEGRANATE_LOCAL_KEK must be 32 random bytes, base64-encoded (openssl rand -base64 32)');
  }
  return key;
}

export function localKekVersion(kek: Buffer): string {
  return 'local-' + createHash('sha256').update('pomegranate/kek-id/v1\u0000').update(kek).digest('hex').slice(0, 8);
}

export interface LocalKeyProviderOptions {
  current: Buffer;
  previous?: Buffer[];
}

export function localKeyProvider(opts: LocalKeyProviderOptions): KeyProvider {
  const keks = new Map<string, Buffer>();
  for (const k of [opts.current, ...(opts.previous ?? [])]) {
    if (k.length !== 32) throw new Error('local KEK must be 32 bytes');
    keks.set(localKekVersion(k), Buffer.from(k));
  }
  const currentVersion = localKekVersion(opts.current);

  return {
    kind: 'local',
    async currentKekVersion() {
      return currentVersion;
    },
    async wrap(dek) {
      if (dek.length !== DEK_BYTES) throw new Error('DEK must be 32 bytes');
      const iv = randomBytes(IV);
      const cipher = createCipheriv('aes-256-gcm', keks.get(currentVersion)!, iv);
      cipher.setAAD(WRAP_AAD);
      const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
      return { wrapped: Buffer.concat([iv, cipher.getAuthTag(), ct]), kekVersion: currentVersion };
    },
    async unwrap(w: WrappedDek) {
      return unwrapOrThrow(`local KEK ${w.kekVersion}`, async () => {
        const kek = keks.get(w.kekVersion);
        if (!kek) throw new CryptoError('key_unwrap_failed', `local KEK ${w.kekVersion} is not configured`);
        if (w.wrapped.length !== IV + TAG + DEK_BYTES) throw new CryptoError('key_unwrap_failed', 'wrapped key is malformed');
        const decipher = createDecipheriv('aes-256-gcm', kek, w.wrapped.subarray(0, IV));
        decipher.setAAD(WRAP_AAD);
        decipher.setAuthTag(w.wrapped.subarray(IV, IV + TAG));
        return Buffer.concat([decipher.update(w.wrapped.subarray(IV + TAG)), decipher.final()]);
      });
    },
  };
}
