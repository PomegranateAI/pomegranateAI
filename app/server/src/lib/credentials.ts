// Reversible secrets at rest (third-party app credentials the server must
// replay, e.g. a Gmail IMAP app password). Unlike session/MCP tokens these
// cannot be hashed — the server needs the plaintext back — so they are
// AES-256-GCM encrypted with a key derived from POMEGRANATE_CREDENTIALS_KEY.
// The env var holds a KEY, never a credential: rotating a user's password is
// a Settings action, not an .env edit, and a leaked DB backup stays sealed.
//
// Without the env key the store is read-only-dark: encryptSecret throws
// (callers surface 501 credentials_key_missing) and decryptSecret returns
// null, so features degrade to "not connected" instead of erroring.

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { secretFromEnv } from './secret-env.js';

const VERSION = 'v1';

export function credentialsKeyConfigured(): boolean {
  return !!secretFromEnv('POMEGRANATE_CREDENTIALS_KEY');
}

function key(): Buffer {
  // From POMEGRANATE_CREDENTIALS_KEY or, on-prem, its Docker secret file
  // (POMEGRANATE_CREDENTIALS_KEY_FILE) — see secret-env.ts.
  const raw = secretFromEnv('POMEGRANATE_CREDENTIALS_KEY');
  if (!raw) throw new Error('credentials_key_missing');
  return createHash('sha256').update(raw).digest();
}

/** Encrypt a plaintext secret into a self-describing blob: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Keys that may have sealed an existing blob: the current key, then any
 * POMEGRANATE_CREDENTIALS_KEY_PREVIOUS values (comma- or newline-separated;
 * a Docker secret on-prem) kept during a rotation.
 */
function candidateKeys(): Buffer[] {
  const raws = [secretFromEnv('POMEGRANATE_CREDENTIALS_KEY'), ...(secretFromEnv('POMEGRANATE_CREDENTIALS_KEY_PREVIOUS') ?? '').split(/[,\n]/)]
    .map((r) => r?.trim())
    .filter((r): r is string => !!r);
  return raws.map((r) => createHash('sha256').update(r).digest());
}

/** Decrypt a blob produced by encryptSecret. null on missing key, foreign format, or tamper. */
export function decryptSecret(blob: string): string | null {
  if (!credentialsKeyConfigured()) return null;
  const [version, iv, tag, ciphertext] = blob.split(':');
  if (version !== VERSION || !iv || !tag || !ciphertext) return null;
  for (const k of candidateKeys()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // try the next (previous) key
    }
  }
  return null;
}

/** Whether a blob opens with the CURRENT key (false → still on a previous key, or unreadable). */
export function sealedWithCurrentKey(blob: string): boolean {
  const [version, iv, tag, ciphertext] = blob.split(':');
  if (version !== VERSION || !iv || !tag || !ciphertext || !credentialsKeyConfigured()) return false;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    decipher.update(Buffer.from(ciphertext, 'base64'));
    decipher.final();
    return true;
  } catch {
    return false;
  }
}
