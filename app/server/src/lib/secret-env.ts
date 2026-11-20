// Key material from Docker secret files (on-prem deployments).
//
// For each name below, NAME_FILE may point at a file holding the value;
// e.g. Docker secrets mounted at /run/secrets/<name>. This keeps the keys
// out of .env, `docker inspect` and process-environment dumps.
//
// Setting both NAME and NAME_FILE is refused: a stale copy left in .env must
// not silently win over the secret file. Error messages name the variable and
// path, never the value.

import { readFileSync } from 'node:fs';

export const FILE_BACKED_SECRETS = [
  'POMEGRANATE_LOCAL_KEK',
  'POMEGRANATE_LOCAL_KEK_PREVIOUS',
  'POMEGRANATE_CREDENTIALS_KEY',
  'POMEGRANATE_CREDENTIALS_KEY_PREVIOUS',
] as const;

export type FileBackedSecret = (typeof FILE_BACKED_SECRETS)[number];

/** The secret's value from NAME_FILE (trimmed) or NAME; undefined when neither is set or the file is empty. */
export function secretFromEnv(
  name: FileBackedSecret,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  const direct = env[name];
  if (file && direct) {
    throw new Error(`${name} and ${name}_FILE are both set; keep only the secret file`);
  }
  if (!file) return direct?.trim() || undefined;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new Error(`${name}_FILE: cannot read ${file} (${code})`);
  }
  return raw.trim() || undefined;
}
