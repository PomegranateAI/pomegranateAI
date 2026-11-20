// Boot wiring for C3: pick the Crypto implementation from the C9 flags.
//
//   POMEGRANATE_SEAL=0 (default)  passthroughCrypto(): nothing is encrypted,
//                                 the default setting.
//   POMEGRANATE_SEAL=1            envelopeCrypto over workspace_keys, with the
//                                 KEK from POMEGRANATE_KEY_PROVIDER:
//     local    POMEGRANATE_LOCAL_KEK (32 random bytes, base64; generate with
//              `openssl rand -base64 32`). For KEK rotation, put the old value
//              in POMEGRANATE_LOCAL_KEK_PREVIOUS (comma-separated) and run
//              `keys rewrap` (phase1/admin/keys.ts). This is the single-server
//              / on-prem setup: there the KEK is a Docker secret
//              (POMEGRANATE_LOCAL_KEK_FILE → /run/secrets/...), see
//              lib/secret-env.ts; the DEKs live wrapped in SQLite.
//     azurekv  the Key Vault provider; its client wiring (@azure/identity,
//              @azure/keyvault-keys) is not bundled, so this build
//              refuses it rather than starting without keys.
//
// Turning SEAL on is a one-way, per-deployment decision made before the first
// write: under SEAL=1, sealed columns refuse plaintext (fail closed).

import { parseFlags } from '../../platform/flags.js';
import { passthroughCrypto, type Crypto } from '../../platform/crypto.js';
import type { Db } from '../../platform/db.js';
import { envelopeCrypto } from './envelope.js';
import { WorkspaceKeyStore } from './key-store.js';
import { localKeyProvider, parseLocalKek } from './local.js';
import { secretFromEnv } from '../secret-env.js';
import type { DekCacheOptions } from './key-provider.js';

export interface CryptoBoot {
  crypto: Crypto;
  /** Present when sealing: the key store, for rotation and rewrap jobs. */
  keys?: WorkspaceKeyStore;
}

export function cryptoFromEnv(
  sql: Db,
  env: Record<string, string | undefined> = process.env,
  opts: Pick<DekCacheOptions, 'onUnwrapFailed'> = {},
): CryptoBoot {
  const flags = parseFlags(env);
  if (!flags.seal) return { crypto: passthroughCrypto() };
  if (flags.keyProvider === 'azurekv') {
    throw new Error('POMEGRANATE_KEY_PROVIDER=azurekv is not wired in this build; use POMEGRANATE_KEY_PROVIDER=local');
  }
  const raw = secretFromEnv('POMEGRANATE_LOCAL_KEK', env);
  if (!raw) {
    throw new Error('POMEGRANATE_SEAL=1 with the local key provider needs POMEGRANATE_LOCAL_KEK (or POMEGRANATE_LOCAL_KEK_FILE)');
  }
  const previous = (secretFromEnv('POMEGRANATE_LOCAL_KEK_PREVIOUS', env) ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseLocalKek);
  const provider = localKeyProvider({ current: parseLocalKek(raw), previous });
  const keys = new WorkspaceKeyStore(sql, provider, opts);
  return { crypto: envelopeCrypto(keys), keys };
}
