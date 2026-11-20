// Workspace data keys (A7, inventory 4.3) — the DEK lifecycle behind C3
//.
//
//   mint     version 1 is created lazily, at the workspace's first seal.
//            Concurrent first seals race on the primary key; the loser reads
//            the winner's key, so a workspace never has two version-1 DEKs.
//   rotate   rotateDek adds version n+1 and retires n. Retired keys still open
//            what they sealed (the version is in every sealed value); only the
//            newest seals.
//   rewrap   rewrapAll re-wraps every DEK whose kek_version isn't the
//            provider's current one: the KEK-rotation step. DEK bytes are
//            unchanged, so no sealed value has to be rewritten.
//   shred    shredWorkspace deletes the wrapped DEKs and leaves a marker, so
//            everything the workspace sealed is unreadable from then on and a
//            later seal fails instead of minting a fresh key.
//
// Storage is the workspace_keys table through the C1 Db handle (repo.sql), so
// the same code runs on SQLite and Postgres. Raw DEKs live only in DekCache
// memory; never log or return one.

import { CryptoError } from '../../platform/crypto.js';
import type { Db } from '../../platform/db.js';
import { DekCache, generateDek, type DekCacheOptions, type KeyProvider } from './key-provider.js';

export interface ActiveKey {
  version: number;
  dek: Buffer;
}

interface KeyRow {
  version: number;
  wrapped_dek: Buffer | Uint8Array;
  kek_version: string;
}

export interface WorkspaceKeyStoreOptions extends DekCacheOptions {}

export class WorkspaceKeyStore {
  private readonly cache: DekCache;

  constructor(
    private readonly sql: Db,
    readonly provider: KeyProvider,
    opts: WorkspaceKeyStoreOptions = {},
  ) {
    this.cache = new DekCache(provider, opts);
  }

  /** The key new values are sealed with; mints version 1 on first use. */
  async activeKey(workspaceId: string): Promise<ActiveKey> {
    const row = await this.newestRow(workspaceId);
    if (row) return { version: row.version, dek: await this.unwrap(workspaceId, row) };
    await this.assertNotShredded(workspaceId);
    return this.mint(workspaceId, 1);
  }

  /** The key a sealed value names. */
  async keyFor(workspaceId: string, version: number): Promise<Buffer> {
    const row = (await this.sql.one<any>(
      `SELECT version, wrapped_dek, kek_version FROM workspace_keys WHERE workspace_id = ? AND version = ?`,
      [workspaceId, version],
    )) as KeyRow | undefined;
    if (!row) {
      await this.assertNotShredded(workspaceId);
      throw new CryptoError('unknown_key_version', `no key version ${version} for this workspace`);
    }
    return this.unwrap(workspaceId, row);
  }

  /** New DEK version for the workspace; the previous one is retired (still opens). */
  async rotateDek(workspaceId: string): Promise<number> {
    await this.assertNotShredded(workspaceId);
    const newest = await this.newestRow(workspaceId);
    const next = (newest?.version ?? 0) + 1;
    const minted = await this.mint(workspaceId, next);
    if (newest) {
      await this.sql.exec(`UPDATE workspace_keys SET retired_at = ? WHERE workspace_id = ? AND version < ? AND retired_at IS NULL`, [
        new Date().toISOString(),
        workspaceId,
        minted.version,
      ]);
    }
    return minted.version;
  }

  /**
   * KEK rotation: re-wrap every DEK not wrapped by the provider's current KEK
   * version. Returns how many rows changed. Safe to re-run (rows already on
   * the current version are skipped) and to interrupt.
   */
  async rewrapAll(): Promise<number> {
    const current = await this.provider.currentKekVersion();
    const rows = (await this.sql.query<any>(
      `SELECT workspace_id, version, wrapped_dek, kek_version FROM workspace_keys WHERE kek_version != ?`,
      [current],
    )) as Array<KeyRow & { workspace_id: string }>;
    let changed = 0;
    for (const row of rows) {
      const dek = await this.unwrap(row.workspace_id, row);
      const rewrapped = await this.provider.wrap(dek);
      const r = await this.sql.exec(
        `UPDATE workspace_keys SET wrapped_dek = ?, kek_version = ? WHERE workspace_id = ? AND version = ? AND kek_version = ?`,
        [rewrapped.wrapped, rewrapped.kekVersion, row.workspace_id, row.version, row.kek_version],
      );
      changed += r.changes;
    }
    return changed;
  }

  /** Crypto-shred: destroy every DEK of the workspace. Irreversible. */
  async shredWorkspace(workspaceId: string): Promise<void> {
    await this.sql.tx(async () => {
      await this.sql.exec(`DELETE FROM workspace_keys WHERE workspace_id = ?`, [workspaceId]);
      await this.sql.exec(
        `INSERT INTO workspace_key_shreds (workspace_id, shredded_at) VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId, new Date().toISOString()],
      );
    });
    this.cache.evict(workspaceId);
  }

  private async newestRow(workspaceId: string): Promise<KeyRow | undefined> {
    return (await this.sql.one<any>(
      `SELECT version, wrapped_dek, kek_version FROM workspace_keys WHERE workspace_id = ? ORDER BY version DESC LIMIT 1`,
      [workspaceId],
    )) as KeyRow | undefined;
  }

  private async mint(workspaceId: string, version: number): Promise<ActiveKey> {
    const dek = generateDek();
    const wrapped = await this.provider.wrap(dek);
    const r = await this.sql.exec(
      `INSERT INTO workspace_keys (workspace_id, version, wrapped_dek, kek_version, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, version) DO NOTHING`,
      [workspaceId, version, wrapped.wrapped, wrapped.kekVersion, new Date().toISOString()],
    );
    if (r.changes === 1) {
      this.cache.prime(workspaceId, version, dek);
      return { version, dek };
    }
    // Lost the race: another seal minted this version first. Use theirs.
    const row = (await this.sql.one<any>(
      `SELECT version, wrapped_dek, kek_version FROM workspace_keys WHERE workspace_id = ? AND version = ?`,
      [workspaceId, version],
    )) as KeyRow;
    return { version, dek: await this.unwrap(workspaceId, row) };
  }

  private unwrap(workspaceId: string, row: KeyRow): Promise<Buffer> {
    return this.cache.get(workspaceId, row.version, {
      wrapped: Buffer.from(row.wrapped_dek),
      kekVersion: row.kek_version,
    });
  }

  private async assertNotShredded(workspaceId: string): Promise<void> {
    const shred = await this.sql.one<any>(`SELECT 1 AS x FROM workspace_key_shreds WHERE workspace_id = ?`, [workspaceId]);
    if (shred) throw new CryptoError('workspace_shredded', 'this workspace was deleted and its keys destroyed');
  }
}
