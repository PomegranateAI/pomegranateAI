import { describe, it, expect, vi } from 'vitest';
import { constants, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { CryptoError } from '../../platform/crypto.js';
import { DekCache, generateDek, type KeyProvider } from './key-provider.js';
import { localKekVersion, localKeyProvider, parseLocalKek } from './local.js';
import { azureKeyVaultProvider, keyVersionFromKeyId, type VaultCryptoClient } from './azure-kv.js';

// A stand-in for Key Vault: real RSA-OAEP-256 with one key pair per version,
// answering with keyIDs shaped like the vault's.
function fakeVault() {
  const versions = new Map<string, { publicKey: KeyObject; privateKey: KeyObject }>();
  let current = '';
  const calls = { wrap: 0, unwrap: 0 };
  const rotate = () => {
    current = randomBytes(16).toString('hex');
    versions.set(current, generateKeyPairSync('rsa', { modulusLength: 2048 }));
    return current;
  };
  rotate();
  const keyId = (v: string) => `https://kv-example.vault.azure.net/keys/kek-tenant-data/${v}`;
  const oaep = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
  const clientFor = (version?: string): VaultCryptoClient => ({
    async wrapKey(_alg, key) {
      calls.wrap++;
      const v = version ?? current;
      const kp = versions.get(v)!;
      return { result: publicEncrypt({ key: kp.publicKey, ...oaep }, key), keyID: keyId(v) };
    },
    async unwrapKey(_alg, encryptedKey) {
      calls.unwrap++;
      const kp = version ? versions.get(version) : undefined;
      if (!kp) throw Object.assign(new Error('Key not found'), { name: 'RestError', statusCode: 404 });
      return { result: privateDecrypt({ key: kp.privateKey, ...oaep }, encryptedKey), keyID: keyId(version!) };
    },
  });
  return { clientFor, rotate, calls };
}

const providers: Array<[string, () => { p: KeyProvider; rotate: () => Promise<KeyProvider> }]> = [
  [
    'local',
    () => {
      const k1 = randomBytes(32);
      return {
        p: localKeyProvider({ current: k1 }),
        rotate: async () => localKeyProvider({ current: randomBytes(32), previous: [k1] }),
      };
    },
  ],
  [
    'azurekv (fake vault)',
    () => {
      const v = fakeVault();
      const p = azureKeyVaultProvider({ clientFor: v.clientFor });
      return {
        p,
        rotate: async () => {
          v.rotate();
          return p;
        },
      };
    },
  ],
];

describe.each(providers)('KeyProvider conformance: %s', (_name, make) => {
  it('round-trips a DEK and never stores it in the clear', async () => {
    const { p } = make();
    const dek = generateDek();
    const w = await p.wrap(dek);
    expect(w.wrapped.includes(dek)).toBe(false);
    expect(w.kekVersion).toBe(await p.currentKekVersion());
    expect((await p.unwrap(w)).equals(dek)).toBe(true);
  });

  it('wraps the same DEK differently each time', async () => {
    const { p } = make();
    const dek = generateDek();
    const [a, b] = [await p.wrap(dek), await p.wrap(dek)];
    expect(a.wrapped.equals(b.wrapped)).toBe(false);
  });

  it('fails closed with key_unwrap_failed on a flipped byte or an unknown KEK version', async () => {
    const { p } = make();
    const w = await p.wrap(generateDek());
    const flipped = Buffer.from(w.wrapped);
    flipped[flipped.length - 1]! ^= 1;
    await expect(p.unwrap({ ...w, wrapped: flipped })).rejects.toMatchObject({ code: 'key_unwrap_failed' });
    await expect(p.unwrap({ ...w, kekVersion: 'nope' })).rejects.toMatchObject({ code: 'key_unwrap_failed' });
  });

  it('keeps unwrapping DEKs wrapped by the previous KEK after rotation', async () => {
    const { p, rotate } = make();
    const dek = generateDek();
    const old = await p.wrap(dek);
    const p2 = await rotate();
    expect(await p2.currentKekVersion()).not.toBe(old.kekVersion);
    expect((await p2.unwrap(old)).equals(dek)).toBe(true);
    const fresh = await p2.wrap(dek);
    expect(fresh.kekVersion).toBe(await p2.currentKekVersion());
    expect((await p2.unwrap(fresh)).equals(dek)).toBe(true);
  });

  it('refuses a DEK of the wrong size', async () => {
    const { p } = make();
    await expect(p.wrap(randomBytes(16))).rejects.toThrow();
  });
});

describe('LocalKeyProvider config', () => {
  it('accepts 32 bytes of base64 and rejects anything else without echoing it', () => {
    const good = randomBytes(32).toString('base64');
    expect(parseLocalKek(` ${good}\n`).length).toBe(32);
    for (const bad of ['', 'not base64!!', randomBytes(16).toString('base64'), 'hunter2-secret']) {
      try {
        parseLocalKek(bad);
        expect.unreachable();
      } catch (err) {
        if (bad) expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  it('names a KEK by a stable fingerprint that does not reveal it', () => {
    const k = randomBytes(32);
    expect(localKekVersion(k)).toBe(localKekVersion(Buffer.from(k)));
    expect(localKekVersion(k)).toMatch(/^local-[0-9a-f]{8}$/);
    expect(localKekVersion(randomBytes(32))).not.toBe(localKekVersion(k));
  });
});

describe('Key Vault keyID parsing', () => {
  it('takes the version from the key id', () => {
    expect(keyVersionFromKeyId('https://kv.vault.azure.net/keys/kek-tenant-data/abc123')).toBe('abc123');
    expect(keyVersionFromKeyId('https://kv.vault.azure.net/keys/kek-tenant-data/abc123/')).toBe('abc123');
    expect(() => keyVersionFromKeyId(undefined)).toThrow(CryptoError);
    expect(() => keyVersionFromKeyId('https://kv.vault.azure.net/keys/kek-tenant-data')).toThrow(CryptoError);
  });

  it('turns a vault error into key_unwrap_failed without its message', async () => {
    const p = azureKeyVaultProvider({
      clientFor: () => ({
        wrapKey: async () => ({ result: new Uint8Array(256), keyID: 'https://kv/keys/k/v1' }),
        unwrapKey: async () => {
          throw Object.assign(new Error('Forbidden: request id 1234, caller xyz'), { name: 'RestError' });
        },
      }),
    });
    const err = await p.unwrap({ wrapped: Buffer.alloc(256), kekVersion: 'v1' }).catch((e) => e);
    expect(err).toBeInstanceOf(CryptoError);
    expect(err.code).toBe('key_unwrap_failed');
    expect(err.message).not.toContain('1234');
  });
});

describe('DekCache', () => {
  function counting() {
    const v = fakeVault();
    return { v, p: azureKeyVaultProvider({ clientFor: v.clientFor }) };
  }

  it('shares one unwrap between concurrent misses and serves hits from memory', async () => {
    const { v, p } = counting();
    const dek = generateDek();
    const w = await p.wrap(dek);
    const cache = new DekCache(p);
    const got = await Promise.all(Array.from({ length: 20 }, () => cache.get('ws1', 1, w)));
    expect(got.every((d) => d.equals(dek))).toBe(true);
    await cache.get('ws1', 1, w);
    expect(v.calls.unwrap).toBe(1);
  });

  it('expires entries after the TTL (15 minutes by default)', async () => {
    const { v, p } = counting();
    const w = await p.wrap(generateDek());
    let t = 0;
    const cache = new DekCache(p, { now: () => t });
    await cache.get('ws1', 1, w);
    t = 15 * 60_000 - 1;
    await cache.get('ws1', 1, w);
    expect(v.calls.unwrap).toBe(1);
    t = 15 * 60_000;
    await cache.get('ws1', 1, w);
    expect(v.calls.unwrap).toBe(2);
  });

  it('keys by workspace and DEK version', async () => {
    const { v, p } = counting();
    const w = await p.wrap(generateDek());
    const cache = new DekCache(p);
    await cache.get('ws1', 1, w);
    await cache.get('ws2', 1, w);
    await cache.get('ws1', 2, w);
    expect(v.calls.unwrap).toBe(3);
    expect(cache.size()).toBe(3);
  });

  it('does not cache failures, and reports each one', async () => {
    const { p } = counting();
    const w = await p.wrap(generateDek());
    const onUnwrapFailed = vi.fn();
    const cache = new DekCache(p, { onUnwrapFailed });
    await expect(cache.get('ws1', 1, { ...w, kekVersion: 'gone' })).rejects.toMatchObject({ code: 'key_unwrap_failed' });
    expect(onUnwrapFailed).toHaveBeenCalledWith('ws1', 1, expect.any(CryptoError));
    expect(cache.size()).toBe(0);
    expect((await cache.get('ws1', 1, w)).length).toBe(32);
  });

  it('evict() drops a workspace, and an unwrap in flight at eviction does not repopulate it', async () => {
    const dek = generateDek();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: KeyProvider = {
      kind: 'local',
      currentKekVersion: async () => 'v',
      wrap: async () => ({ wrapped: Buffer.alloc(0), kekVersion: 'v' }),
      unwrap: async () => {
        await gate;
        return Buffer.from(dek);
      },
    };
    const cache = new DekCache(slow);
    cache.prime('ws2', 1, generateDek());
    const pending = cache.get('ws1', 1, { wrapped: Buffer.alloc(0), kekVersion: 'v' });
    cache.evict('ws1');
    release();
    expect((await pending).equals(dek)).toBe(true);
    expect(cache.size()).toBe(1); // only ws2
    cache.evict('ws2');
    expect(cache.size()).toBe(0);
  });
});
