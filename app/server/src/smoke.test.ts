import { describe, it, expect } from 'vitest';
import 'dotenv/config';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';

describe('smoke', () => {
  // A local-env sanity check, not a code assertion: it catches a malformed key
  // in a developer's .env. CI deliberately has no key (the suite runs on stubs,
  // and the app itself defaults to the hosted provider), so it skips there
  // rather than failing the build.
  it.skipIf(!process.env.ANTHROPIC_API_KEY)('reads a well-formed ANTHROPIC_API_KEY from env', () => {
    expect(process.env.ANTHROPIC_API_KEY!.startsWith('sk-ant-')).toBe(true);
  });

  it('opens an in-memory sqlite db', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER, name TEXT)');
    db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'hello');
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as { id: number; name: string };
    expect(row.name).toBe('hello');
    db.close();
  });

  it('imports Anthropic SDK', () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    expect(client).toBeDefined();
  });
});
