// AzureKeyVaultProvider (A7 4.1): DEKs wrapped by the kek-tenant-data RSA key
// in Azure Key Vault (A1 1.2), RSA-OAEP-256. The KEK never leaves the vault;
// the app's managed identity holds only wrapKey/unwrapKey on it.
//
// The vault client is injected, shaped like @azure/keyvault-keys'
// CryptographyClient (wrapKey / unwrapKey), so this file needs no SDK import:
// boot wiring builds one CryptographyClient per key version with
// DefaultAzureCredential, tests pass a fake backed by a local RSA key.
//
// Versions: wrap() always uses the current key version and records it from
// the result's keyID (".../keys/<name>/<version>"). unwrap() asks for the
// client of the exact version that wrapped the DEK, so DEKs wrapped before a
// KEK rotation keep opening until crypto.rewrap moves them (item 4.3).

import { CryptoError } from '../../platform/crypto.js';
import { DEK_BYTES, unwrapOrThrow, type KeyProvider, type WrappedDek } from './key-provider.js';

export const KEK_WRAP_ALGORITHM = 'RSA-OAEP-256';

/** The subset of @azure/keyvault-keys CryptographyClient this provider uses. */
export interface VaultCryptoClient {
  wrapKey(algorithm: typeof KEK_WRAP_ALGORITHM, key: Uint8Array): Promise<{ result: Uint8Array; keyID?: string }>;
  unwrapKey(algorithm: typeof KEK_WRAP_ALGORITHM, encryptedKey: Uint8Array): Promise<{ result: Uint8Array; keyID?: string }>;
}

export interface AzureKeyVaultProviderOptions {
  /**
   * A client for the KEK. `version` undefined = the current version (wrap);
   * otherwise that exact version (unwrap). Implementations should cache clients.
   */
  clientFor(version?: string): VaultCryptoClient;
}

/** ".../keys/kek-tenant-data/<version>" → "<version>". */
export function keyVersionFromKeyId(keyId: string | undefined): string {
  const m = keyId ? /\/keys\/[^/]+\/([^/?#]+)\/?(?:[?#].*)?$/.exec(keyId) : null;
  if (!m?.[1]) throw new CryptoError('key_unwrap_failed', 'Key Vault returned no key version');
  return m[1];
}

export function azureKeyVaultProvider(opts: AzureKeyVaultProviderOptions): KeyProvider {
  return {
    kind: 'azurekv',
    async currentKekVersion() {
      // A wrap is the cheapest call that names the current version without
      // also needing get-key permission; the probe is all zeros and dropped.
      const probe = await opts.clientFor().wrapKey(KEK_WRAP_ALGORITHM, new Uint8Array(DEK_BYTES));
      return keyVersionFromKeyId(probe.keyID);
    },
    async wrap(dek) {
      if (dek.length !== DEK_BYTES) throw new Error('DEK must be 32 bytes');
      const res = await opts.clientFor().wrapKey(KEK_WRAP_ALGORITHM, dek);
      return { wrapped: Buffer.from(res.result), kekVersion: keyVersionFromKeyId(res.keyID) };
    },
    async unwrap(w: WrappedDek) {
      return unwrapOrThrow(`Key Vault KEK ${w.kekVersion}`, async () => {
        const res = await opts.clientFor(w.kekVersion).unwrapKey(KEK_WRAP_ALGORITHM, w.wrapped);
        return Buffer.from(res.result);
      });
    },
  };
}
