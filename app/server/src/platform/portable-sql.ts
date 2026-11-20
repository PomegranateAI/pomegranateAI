// portable SQL rules.
//
// One SQL string must run on SQLite and Postgres. This module holds the
// banned constructs and a scanner; portable-sql.test.ts runs it over the repo
// modules. The test stays in WARN mode (report, don't fail) until Wave 2 ends,
// then A0 flips PORTABLE_SQL_MODE to 'error'.

export const PORTABLE_SQL_MODE: 'warn' | 'error' = 'warn';

export interface BannedSql {
  pattern: RegExp;
  rule: string;
  use: string;
}

export const BANNED_SQL: readonly BannedSql[] = [
  {
    pattern: /INSERT\s+OR\s+REPLACE/i,
    rule: 'INSERT OR REPLACE',
    use: 'INSERT … ON CONFLICT (…) DO UPDATE SET … — REPLACE deletes and reinserts, cascading deletes to child rows',
  },
  { pattern: /INSERT\s+OR\s+IGNORE/i, rule: 'INSERT OR IGNORE', use: 'INSERT … ON CONFLICT DO NOTHING' },
  { pattern: /\bdatetime\s*\(/i, rule: 'datetime(', use: 'a nowIso() parameter made in TypeScript' },
  { pattern: /\bstrftime\s*\(/i, rule: 'strftime(', use: 'compute the value in TypeScript and pass it as a parameter' },
  { pattern: /\bjulianday\s*\(/i, rule: 'julianday(', use: 'compare ISO-8601 strings, or compute in TypeScript' },
];

export interface SqlViolation {
  file: string;
  line: number;
  rule: string;
  use: string;
  text: string;
}

/** Scan one file's source text. Comment-only lines are skipped. */
export function scanPortableSql(file: string, source: string): SqlViolation[] {
  const out: SqlViolation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const b of BANNED_SQL) {
      if (b.pattern.test(text)) out.push({ file, line: i + 1, rule: b.rule, use: b.use, text: trimmed.slice(0, 160) });
    }
  }
  return out;
}
