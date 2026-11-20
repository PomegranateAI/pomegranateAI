import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/schema.js';
import { createSqliteDb } from '../db/driver/sqlite.js';
import { cryptoFromEnv } from '../../lib/crypto/boot.js';
import { encryptSecret, sealedWithCurrentKey } from '../../lib/credentials.js';
import { secretFromEnv } from '../../lib/secret-env.js';
import type { Db } from '../../platform/db.js';
import { runKeys } from './keys.js';

const newKey = () => randomBytes(32).toString('base64');

let dir: string;
let sql: Db;
let out: string[];
const savedCredentials = process.env.POMEGRANATE_CREDENTIALS_KEY;

function secretFile(name: string, value: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, `${value}\n`, { mode: 0o400 });
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pom-keys-'));
  sql = createSqliteDb(openDb(path.join(dir, 'p.db')));
  out = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: string) => void out.push(String(m)));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.POMEGRANATE_CREDENTIALS_KEY_PREVIOUS;
  if (savedCredentials === undefined) delete process.env.POMEGRANATE_CREDENTIALS_KEY;
  else process.env.POMEGRANATE_CREDENTIALS_KEY = savedCredentials;
});

describe('secret files', () => {
  it('reads NAME_FILE, trims it, and refuses NAME and NAME_FILE together', () => {
    const p = secretFile('kek', 'abc');
    expect(secretFromEnv('POMEGRANATE_LOCAL_KEK', { POMEGRANATE_LOCAL_KEK_FILE: p })).toBe('abc');
    expect(() =>
      secretFromEnv('POMEGRANATE_LOCAL_KEK', { POMEGRANATE_LOCAL_KEK_FILE: p, POMEGRANATE_LOCAL_KEK: 'abc' }),
    ).toThrow(/both set/);
    expect(secretFromEnv('POMEGRANATE_LOCAL_KEK_PREVIOUS', { POMEGRANATE_LOCAL_KEK_PREVIOUS_FILE: secretFile('prev', '') })).toBeUndefined();
  });

  it('names the path but never the value when the file is missing', () => {
    expect(() => secretFromEnv('POMEGRANATE_LOCAL_KEK', { POMEGRANATE_LOCAL_KEK_FILE: path.join(dir, 'nope') })).toThrow(
      /POMEGRANATE_LOCAL_KEK_FILE: cannot read .*nope \(ENOENT\)/,
    );
  });

  it('boots sealing from a KEK secret file', () => {
    const boot = cryptoFromEnv(sql, { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK_FILE: secretFile('kek', newKey()) });
    expect(boot.keys).toBeDefined();
  });
});

/** The authenticator-app (TOTP) table: new databases no longer create it,
 *  but a server upgraded from that version keeps its rows, and the keys
 *  tooling still verifies and re-encrypts them. */
async function legacyTotpTable() {
  await sql.exec(`CREATE TABLE IF NOT EXISTS user_mfa (
    user_id TEXT PRIMARY KEY, secret_enc TEXT NOT NULL, enabled_at TEXT, last_step INTEGER, created_at TEXT NOT NULL)`);
}

describe('keys admin command', () => {
  it('verifies, rotates data keys, and rotates the KEK through rewrap', async () => {
    const kekA = newKey();
    const envA = { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK_FILE: secretFile('kek-a', kekA) };
    const keys = cryptoFromEnv(sql, envA).keys!;
    await keys.activeKey('ws_a');
    await keys.activeKey('ws_b');

    expect(await runKeys(['verify', '--require-seal'], sql, envA)).toBe(0);
    expect(out).toContain('workspace keys: 2/2 unwrap');

    expect(await runKeys(['rotate-dek', '--all'], sql, envA)).toBe(0);
    expect(out).toContain('ws_a: now sealing with v2');
    expect(await runKeys(['verify'], sql, envA)).toBe(0);
    expect(out).toContain('workspace keys: 4/4 unwrap');

    // A new KEK without the old one cannot open anything yet.
    const kekB = newKey();
    const envBOnly = { POMEGRANATE_SEAL: '1', POMEGRANATE_LOCAL_KEK_FILE: secretFile('kek-b', kekB) };
    expect(await runKeys(['verify'], sql, envBOnly)).toBe(1);

    // New KEK + old one as previous → rewrap moves every key over.
    const envB = { ...envBOnly, POMEGRANATE_LOCAL_KEK_PREVIOUS_FILE: secretFile('kek-prev', kekA) };
    expect(await runKeys(['rewrap'], sql, envB)).toBe(0);
    expect(out.some((l) => /^re-wrapped 4 key\(s\)/.test(l))).toBe(true);
    // …after which the old KEK can be dropped.
    expect(await runKeys(['verify'], sql, envBOnly)).toBe(0);
    expect(out.join('\n')).not.toContain(kekA);
    expect(out.join('\n')).not.toContain(kekB);
  });

  it('fails verify when sealing is required but off, or a two-step secret does not decrypt', async () => {
    expect(await runKeys(['verify', '--require-seal'], sql, {})).toBe(1);

    process.env.POMEGRANATE_CREDENTIALS_KEY = newKey();
    await sql.exec(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'u1@acme.test', '2026-10-07T00:00:00Z')`);
    await legacyTotpTable();
    await sql.exec(`INSERT INTO user_mfa (user_id, secret_enc, created_at) VALUES ('u1', ?, '2026-10-07T00:00:00Z')`, [
      encryptSecret('JBSWY3DPEHPK3PXP'),
    ]);
    expect(await runKeys(['verify'], sql, {})).toBe(0);
    expect(out).toContain('two-step secrets: 1/1 decrypt');

    process.env.POMEGRANATE_CREDENTIALS_KEY = newKey(); // wrong key
    expect(await runKeys(['verify'], sql, {})).toBe(1);
  });

  it('rotates the credentials key: old key as previous, rewrap, then drop it', async () => {
    const keyA = newKey();
    process.env.POMEGRANATE_CREDENTIALS_KEY = keyA;
    await sql.exec(`INSERT INTO users (id, email, created_at) VALUES ('u2', 'u2@acme.test', '2026-10-07T00:00:00Z')`);
    await legacyTotpTable();
    await sql.exec(`INSERT INTO user_mfa (user_id, secret_enc, created_at) VALUES ('u2', ?, '2026-10-07T00:00:00Z')`, [encryptSecret('TOTPSECRET')]);

    const keyB = newKey();
    process.env.POMEGRANATE_CREDENTIALS_KEY = keyB;
    process.env.POMEGRANATE_CREDENTIALS_KEY_PREVIOUS = keyA;
    expect(await runKeys(['verify'], sql, {})).toBe(0); // still readable through the previous key
    expect(await runKeys(['rewrap-credentials'], sql, {})).toBe(0);
    expect(out).toContain('re-encrypted 1 credential(s) under the current credentials key');
    const blob = ((await sql.one<any>(`SELECT secret_enc FROM user_mfa WHERE user_id = 'u2'`)) as { secret_enc: string }).secret_enc;
    expect(sealedWithCurrentKey(blob)).toBe(true);

    delete process.env.POMEGRANATE_CREDENTIALS_KEY_PREVIOUS;
    expect(await runKeys(['verify'], sql, {})).toBe(0);
    expect(out.join('\n')).not.toContain(keyA);
  });

  it('rejects unknown commands and rotation without sealing', async () => {
    expect(await runKeys(['nope'], sql, {})).toBe(2);
    expect(await runKeys(['rewrap'], sql, {})).toBe(2);
  });
});
