#!/usr/bin/env node
import 'dotenv/config';
import * as path from 'node:path';
import { FileStorage } from '../../lib/storage.js';
import { ingest } from '../ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const opts = {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };
  const sources = args.filter((a) => !a.startsWith('-'));
  if (sources.length === 0) {
    console.error('usage: ingest <source-dir-or-file> [...] [--force] [--dry-run] [-v]');
    process.exit(1);
  }
  const root = process.env.POMEGRANATE_DATA_DIR ?? '.pomegranate';
  const storage = new FileStorage({ rootDir: path.resolve(root) });
  const result = await ingest({
    storage,
    sources: sources.map((s) => path.resolve(s)),
    ...opts,
  });
  console.log(
    `[ingest] processed=${result.filesProcessed} skipped=${result.filesSkipped} candidates=${result.candidates.length}`,
  );
  if (opts.verbose) {
    for (const c of result.candidates) {
      console.log(`  <${c.flag}> ${c.proposed_node.type}: ${candidateSummary(c)}`);
    }
  }
}

function candidateSummary(c: { proposed_node: any }): string {
  const n = c.proposed_node;
  if (n.type === 'goal') return n.title;
  if (n.type === 'decision') return n.summary;
  return n.body.slice(0, 80);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
