import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { PORTABLE_SQL_MODE, scanPortableSql } from './portable-sql.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** The repo modules (phase1/db/repo/**) plus repo.ts while it still exists. */
function repoFiles(): string[] {
  const files: string[] = [];
  const single = join(SRC, 'phase1/db/repo.ts');
  if (existsSync(single)) files.push(single);
  const dir = join(SRC, 'phase1/db/repo');
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

describe('portable SQL scanner (C2)', () => {
  it('flags each banned construct', () => {
    const src = [
      "db.prepare('INSERT OR REPLACE INTO t VALUES (?)')",
      "db.prepare('insert or ignore into t values (?)')",
      "db.prepare(\"UPDATE t SET at = datetime('now')\")",
      "db.prepare(\"SELECT strftime('%s', at) FROM t\")",
      "db.prepare('SELECT julianday(at) FROM t')",
    ].join('\n');
    expect(scanPortableSql('x.ts', src).map((v) => v.rule)).toEqual([
      'INSERT OR REPLACE',
      'INSERT OR IGNORE',
      'datetime(',
      'strftime(',
      'julianday(',
    ]);
  });

  it('accepts portable SQL and ignores comments', () => {
    const src = [
      '// never INSERT OR REPLACE here',
      ' * datetime( is banned',
      "db.prepare('INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v')",
      "db.prepare('UPDATE t SET at = ? WHERE id = ?')",
    ].join('\n');
    expect(scanPortableSql('x.ts', src)).toEqual([]);
  });

  it(`repo modules follow the portable rules (${PORTABLE_SQL_MODE} mode)`, () => {
    const violations = repoFiles().flatMap((f) => scanPortableSql(relative(SRC, f), readFileSync(f, 'utf8')));
    if (PORTABLE_SQL_MODE === 'error') {
      expect(violations).toEqual([]);
    } else if (violations.length) {
      const byRule = new Map<string, number>();
      for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
      console.warn(
        `[portable-sql] ${violations.length} non-portable SQL constructs in repo modules (warn mode until Wave 2 ends): ` +
          [...byRule].map(([r, n]) => `${r}×${n}`).join(', '),
      );
    }
  });
});
