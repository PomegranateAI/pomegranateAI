// Key administration for sealed (POMEGRANATE_SEAL=1) deployments.
//
// Runs inside the app container, against the live database, with the same
// key configuration the server has (Docker secrets on-prem):
//
//   docker compose exec -T app node dist/phase1/admin/keys.js <command>
//
//   status                 what is configured and how keys are spread; no key material
//   verify [--require-seal] unwrap every workspace key and decrypt every stored
//                          two-step secret; exit 1 on any failure. Run after
//                          every deploy and daily (deploy/keys-verify.sh).
//   rewrap                 KEK rotation: re-wrap every workspace key under the
//                          current KEK (old KEK must be in ..._PREVIOUS), then verify
//   rotate-dek <ws>|--all  new data key version per workspace; old versions stay
//                          readable. Takes effect in the running app immediately.
//   seal-files             encrypt, in place, files written to FILES_DIR before
//                          sealing was on; safe to re-run
//   rewrap-credentials     credentials-key rotation: re-encrypt every
//                          stored two-step secret / app credential under the
//                          current key (old key in ..._CREDENTIALS_KEY_PREVIOUS)
//
// Prints counts, versions and KEK fingerprints only — never a key, raw or
// wrapped. Exit codes: 0 ok, 1 check failed, 2 usage/configuration error.

import 'dotenv/config';
import { openDb } from '../db/schema.js';
import { createSqliteDb } from '../db/driver/sqlite.js';
import { parseFlags } from '../../platform/flags.js';
import { cryptoFromEnv } from '../../lib/crypto/boot.js';
import { credentialsKeyConfigured, decryptSecret, encryptSecret, sealedWithCurrentKey } from '../../lib/credentials.js';
import { log } from '../../lib/log.js';
import { sealExistingFiles } from '../files/sealed-files.js';
import type { Db } from '../../platform/db.js';

const USAGE = 'usage: keys.js status | verify [--require-seal] | rewrap | rotate-dek <workspace_id>|--all | rewrap-credentials | seal-files';

interface KeyRow {
  workspace_id: string;
  version: number;
  kek_version: string;
  created_at: string;
  retired_at: string | null;
}

async function tableExists(sql: Db, name: string): Promise<boolean> {
  return !!(await sql.one<any>(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]));
}

async function keyRows(sql: Db): Promise<KeyRow[]> {
  if (!(await tableExists(sql, 'workspace_keys'))) return [];
  return (await sql.query<any>(
    `SELECT workspace_id, version, kek_version, created_at, retired_at FROM workspace_keys ORDER BY workspace_id, version`,
  )) as KeyRow[];
}

/** Run one keys command against `sql`, with key configuration from `env`. Returns the exit code. */
export async function runKeys(argv: string[], sql: Db, env: Record<string, string | undefined> = process.env): Promise<number> {
  const [cmd, arg] = argv;
  if (!cmd || !['status', 'verify', 'rewrap', 'rotate-dek', 'rewrap-credentials', 'seal-files'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  const flags = parseFlags(env);

  let boot;
  try {
    boot = cryptoFromEnv(sql, env);
  } catch (err) {
    console.error(`key configuration error: ${(err as Error).message}`);
    return 2;
  }
  const keys = boot.keys;

  if (cmd === 'status') {
    const rows = await keyRows(sql);
    const byKek = new Map<string, number>();
    for (const r of rows) byKek.set(r.kek_version, (byKek.get(r.kek_version) ?? 0) + 1);
    const active = rows.filter((r) => !r.retired_at);
    const oldestActive = active.map((r) => r.created_at).sort()[0];
    const shredded = (await tableExists(sql, 'workspace_key_shreds'))
      ? ((await sql.one<any>(`SELECT COUNT(*) AS n FROM workspace_key_shreds`)) as { n: number }).n
      : 0;
    const mfa = (await tableExists(sql, 'user_mfa'))
      ? ((await sql.one<any>(`SELECT COUNT(*) AS n FROM user_mfa`)) as { n: number }).n
      : 0;
    console.log(`sealing:            ${flags.seal ? 'ON' : 'off'}`);
    console.log(`key provider:       ${flags.keyProvider}`);
    if (keys) console.log(`current KEK:        ${await keys.provider.currentKekVersion()}`);
    console.log(`workspaces w/ keys: ${new Set(rows.map((r) => r.workspace_id)).size}`);
    console.log(`data keys:          ${rows.length} (${active.length} active, ${rows.length - active.length} retired)`);
    for (const [kek, n] of byKek) console.log(`  wrapped by ${kek}: ${n}`);
    console.log(`oldest active key:  ${oldestActive ?? '—'}`);
    console.log(`shredded folders:   ${shredded}`);
    console.log(`credentials key:    ${credentialsKeyConfigured() ? 'configured' : 'MISSING'} (${mfa} two-step secrets stored)`);
    return 0;
  }

  if (cmd === 'verify') {
    const requireSeal = arg === '--require-seal';
    let failures = 0;
    if (!flags.seal) {
      if (requireSeal) {
        console.error('verify FAILED: POMEGRANATE_SEAL is not 1 on a deployment that requires encryption at rest');
        return 1;
      }
      console.log('sealing off: no workspace keys to verify');
    } else if (keys) {
      const rows = await keyRows(sql);
      for (const r of rows) {
        try {
          await keys.keyFor(r.workspace_id, r.version);
        } catch (err) {
          failures++;
          console.error(`  cannot unwrap ${r.workspace_id} v${r.version} (wrapped by ${r.kek_version}): ${(err as Error).message}`);
        }
      }
      const current = await keys.provider.currentKekVersion();
      const notCurrent = rows.filter((r) => r.kek_version !== current).length;
      console.log(`workspace keys: ${rows.length - failures}/${rows.length} unwrap`);
      if (notCurrent > 0) console.log(`  note: ${notCurrent} key(s) still wrapped by a previous KEK — run \`keys.js rewrap\``);
    }
    if (await tableExists(sql, 'user_mfa')) {
      const mfa = (await sql.query<any>(`SELECT user_id, secret_enc FROM user_mfa`)) as Array<{ user_id: string; secret_enc: string }>;
      if (mfa.length > 0 && !credentialsKeyConfigured()) {
        failures += mfa.length;
        console.error(`  credentials key missing: ${mfa.length} two-step secret(s) cannot be read`);
      } else {
        let bad = 0;
        for (const m of mfa) if (decryptSecret(m.secret_enc) === null) bad++;
        failures += bad;
        console.log(`two-step secrets: ${mfa.length - bad}/${mfa.length} decrypt`);
        if (bad) console.error(`  ${bad} two-step secret(s) do not decrypt with the configured credentials key`);
      }
    }
    if (failures > 0) {
      console.error(`verify FAILED: ${failures} problem(s)`);
      log.error('keys.verify_failed', { failures });
      return 1;
    }
    console.log('verify OK');
    log.info('keys.verify_ok', {});
    return 0;
  }

  if (cmd === 'rewrap-credentials') {
    if (!credentialsKeyConfigured()) {
      console.error('rewrap-credentials needs POMEGRANATE_CREDENTIALS_KEY');
      return 2;
    }
    let changed = 0;
    let unreadable = 0;
    for (const [table, keyCols, col] of [
      ['user_mfa', ['user_id'], 'secret_enc'],
      ['user_app_credentials', ['user_id', 'app'], 'secret'],
    ] as const) {
      if (!(await tableExists(sql, table))) continue;
      const rows = (await sql.query<any>(`SELECT ${keyCols.join(', ')}, ${col} AS blob FROM ${table}`)) as Array<Record<string, string>>;
      for (const r of rows) {
        if (sealedWithCurrentKey(r.blob!)) continue;
        const plain = decryptSecret(r.blob!);
        if (plain === null) {
          unreadable++;
          continue;
        }
        await sql.exec(`UPDATE ${table} SET ${col} = ? WHERE ${keyCols.map((k) => `${k} = ?`).join(' AND ')}`, [
          encryptSecret(plain),
          ...keyCols.map((k) => r[k]!),
        ]);
        changed++;
      }
    }
    console.log(`re-encrypted ${changed} credential(s) under the current credentials key`);
    log.info('keys.rewrap_credentials', { changed, unreadable });
    if (unreadable > 0) {
      console.error(`  ${unreadable} credential(s) open with no configured key — left unchanged`);
      return 1;
    }
    return runKeys(['verify'], sql, env);
  }

  if (!flags.seal || !keys) {
    console.error(`${cmd} needs POMEGRANATE_SEAL=1`);
    return 2;
  }

  if (cmd === 'rewrap') {
    const changed = await keys.rewrapAll();
    const current = await keys.provider.currentKekVersion();
    console.log(`re-wrapped ${changed} key(s) under ${current}`);
    log.info('keys.rewrap', { changed, kek_version: current });
    return runKeys(['verify'], sql, env);
  }

  if (cmd === 'seal-files') {
    const filesDir = env.POMEGRANATE_FILES_DIR ?? process.env.POMEGRANATE_FILES_DIR ?? './data/files';
    const workspaces = (await sql.query<any>(`SELECT id FROM workspaces`)) as Array<{ id: string }>;
    let sealed = 0;
    let already = 0;
    for (const w of workspaces) {
      const r = await sealExistingFiles(boot.crypto, w.id, filesDir);
      sealed += r.sealed;
      already += r.already;
    }
    console.log(`sealed ${sealed} file(s); ${already} already sealed`);
    log.info('keys.seal_files', { sealed, already });
    return 0;
  }

  // rotate-dek
  if (!arg) {
    console.error(USAGE);
    return 2;
  }
  const targets = arg === '--all' ? [...new Set((await keyRows(sql)).map((r) => r.workspace_id))] : [arg];
  for (const ws of targets) {
    const version = await keys.rotateDek(ws);
    console.log(`${ws}: now sealing with v${version}`);
    log.info('keys.rotate_dek', { workspace_id: ws, version });
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sql = createSqliteDb(openDb(process.env.POMEGRANATE_DB_PATH ?? './data/pomegranate.db'));
  runKeys(process.argv.slice(2), sql).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`keys: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
