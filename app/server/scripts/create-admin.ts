/**
 * Create (or promote) the first system administrator.
 *
 *   npm run create-admin -- --email you@example.com
 *
 * Sign-up is closed by default (SIGNUP_MODE unset), so a fresh server has no
 * way in until an account exists. This writes one directly to the database
 * named by POMEGRANATE_DB_PATH (the same file the server uses), marks it as a
 * system administrator, and gives it a one-time temporary password that must
 * be changed at first sign-in. From there the admin invites everyone else
 * from Setup in the web app.
 *
 * Re-running it for an existing email promotes that account to administrator
 * and issues a new temporary password.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { openDb } from '../src/phase1/db/schema.js';
import { Repo } from '../src/phase1/db/repo.js';
import { cryptoFromEnv } from '../src/lib/crypto/boot.js';
import { generateTemporaryPassword, hashPassword } from '../src/lib/passwords.js';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

const email = argValue('--email')?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run create-admin -- --email you@example.com');
  process.exit(1);
}

const DB_PATH = process.env.POMEGRANATE_DB_PATH ?? './data/pomegranate.db';
await fs.mkdir(path.dirname(DB_PATH), { recursive: true });

const db = openDb(DB_PATH);
const repo = new Repo(db);
repo.crypto = cryptoFromEnv(repo.sql, process.env).crypto;

const existed = !!(await repo.findUserByEmail(email));
const password = generateTemporaryPassword();
const hash = await hashPassword(password);
const user = await repo.tx(async () => {
  const u = await repo.findOrCreateUser(email);
  await repo.sql.exec('UPDATE users SET is_admin = 1 WHERE id = ?', [u.id]);
  await repo.setPasswordHash(u.id, hash, { mustChange: true });
  return u;
});
db.close();

const origin = (process.env.PUBLIC_APP_URL ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:5173').split(',')[0]!.trim();
console.log(`${existed ? 'Promoted' : 'Created'} administrator ${user.email} in ${DB_PATH}`);
console.log('');
console.log(`  Sign in at:          ${origin}`);
console.log(`  Temporary password:  ${password}`);
console.log('');
console.log('You will be asked to choose your own password at first sign-in.');
console.log('Invite everyone else from Setup in the web app.');
