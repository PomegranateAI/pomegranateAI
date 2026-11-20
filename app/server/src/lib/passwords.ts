// Password hashing for password-based sign-in (alongside the magic-link
// flow). scrypt via Node's built-in crypto — no new dependency, and this
// repo already leans on stdlib crypto for secrets at rest (see
// lib/credentials.ts's AES-256-GCM). Unlike credentials.ts this is
// one-way: we only ever need to *verify* a password, never recover it.
//
// Hashes are self-describing (`scrypt:N:r:p:<saltB64>:<hashB64>`) so the
// cost params can be tuned later without invalidating already-stored hashes
// — verifyPassword reads N/r/p back out of the stored string instead of
// assuming today's constants.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const N = 16384; // CPU/memory cost factor
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt's default maxmem (32MB) is too small for N=16384,r=8 — bump it,
// same formula Node's docs use: 128 * N * r * (an approximate p+ margin).
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${derived.toString('base64')}`;
}

/** Verifies a password against a stored hash. Never throws — any malformed
 *  or foreign-format hash just fails closed. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64!, 'base64');
    expected = Buffer.from(hashB64!, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  try {
    const derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** A hash of no real password, spent on timing-equalizing failed logins for
 *  an unknown email or an account with no password set (see auth/password
 *  routes) — so response latency doesn't distinguish those from a genuine
 *  wrong-password attempt. Fixed, not derived at request time. */
export const DUMMY_PASSWORD_HASH =
  'scrypt:16384:8:1:LNCLNCLNCLNCLNCLNCLNCw==:qXXTvA5MZeVneQ8ScmnGrxZaJXKz2sxOgnhVR7T2R08Fs73wRfDvDTZ9tOoyd4gSj6+n2yJhk+aq9DPvxNOD3Q==';

/** Minimum bar for a new/changed password. Deliberately just a length floor
 *  — composition rules push people toward predictable substitutions and
 *  scrypt + the auth rate limiter already do the real work against
 *  brute force. Returns a user-facing message, or null when it passes. */
export function passwordPolicyError(plain: string, ctx: { email?: string } = {}): string | null {
  if (plain.length < 12) return 'password must be at least 12 characters';
  if (plain.length > 512) return 'password is too long';
  // NIST 800-63B §5.1.1.2: refuse values known to be commonly used or
  // derived from the account/service name, rather than imposing composition
  // rules. The list is small on purpose (the 12-char floor already excludes
  // most of any breach corpus); PASSWORD_BREACH_CHECK=hibp adds the full one.
  const lower = plain.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  if (new Set(lower).size < 4) return 'password is too easy to guess';
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(squashed)) return 'password is too common';
  if (COMMON_FRAGMENTS.some((f) => squashed.includes(f) && squashed.length - f.length < 6)) return 'password is too easy to guess';
  const local = ctx.email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (local && local.length >= 4 && squashed.includes(local)) return 'password must not contain your email name';
  if (squashed.includes('pomegranate')) return 'password must not contain the product name';
  return null;
}

/** Characters for generated passwords: lowercase letters and digits without
 *  the look-alikes (0/o, 1/l/i), so a password read from an email or a screen
 *  is typed right the first time. 31 symbols → ~5 bits each. */
const TEMP_PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * A random temporary password an admin hands to a new user: four groups of
 * four ("k7mq-x3vt-9hfr-2pwd"), ~79 bits from the CSPRNG. The account must
 * replace it at first sign-in (setPasswordHash mustChange). Re-drawn in the
 * (vanishingly rare) case it trips the policy.
 */
export function generateTemporaryPassword(): string {
  for (;;) {
    const bytes = randomBytes(16);
    const chars = Array.from(bytes, (b) => TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]);
    const pw = [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
    if (!passwordPolicyError(pw)) return pw;
  }
}

/** Common passwords that pass the 12-character floor. */
const COMMON_PASSWORDS = new Set([
  '123456789012', '1234567890123', '12345678901234', 'qwertyuiopas', 'qwertyuiop123', '1q2w3e4r5t6y',
  '1qaz2wsx3edc', 'qazwsxedcrfv', 'zaq12wsxcde3', 'password1234', 'password123!', 'passwordpassword',
  'iloveyou1234', 'welcome12345', 'letmein12345', 'administrator', 'changeme1234', 'abc123456789',
  'abcdefghijkl', 'aaaaaaaaaaaa', 'football1234', 'baseball1234', 'superman1234', 'princess1234',
  'sunshine1234', 'trustno11234', 'monkey123456', 'dragon123456', 'master123456', 'qwerty123456',
  'asdfghjkl123', 'computer1234', 'internet1234', 'whatever1234', 'starwars1234', 'correcthorsebatterystaple',
  'p@ssw0rd1234', 'p@ssword1234', 'passw0rd1234', 'welcome@1234', 'admin@123456', 'india@123456',
  'summer202520', 'winter202520', 'spring202520', 'autumn202520',
]);
/** Base words that, padded with a few digits or symbols, make a weak password. */
const COMMON_FRAGMENTS = ['password', 'passw0rd', 'qwerty', 'welcome', 'letmein', 'iloveyou', 'admin', 'changeme', '123456'];

/**
 * Optional check against the Have I Been Pwned corpus (PASSWORD_BREACH_CHECK=hibp).
 * k-anonymity: only the first 5 hex chars of the SHA-1 leave the server, never
 * the password. Fails open (a network failure doesn't block a password change)
 * so an on-prem server without outbound access still works.
 */
export async function isBreachedPassword(plain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if ((process.env.PASSWORD_BREACH_CHECK ?? '').toLowerCase() !== 'hibp') return false;
  const sha1 = createHash('sha1').update(plain).digest('hex').toUpperCase();
  try {
    const r = await fetchImpl(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const suffix = sha1.slice(5);
    return (await r.text()).split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}
