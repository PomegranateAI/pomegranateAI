#!/usr/bin/env node
/**
 * Manual review CLI — counterpart to the Stop hook for the pomegranate-review skill.
 *
 *   review-cli --prompt-file p.txt --response-file r.txt [--kind prd] [--force-relevant]
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileStorage } from '../../lib/storage.js';
import { review } from '../review.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const promptFile = arg('prompt-file');
  const responseFile = arg('response-file');
  const kind = (arg('kind') ?? 'other') as
    | 'prd'
    | 'exec_update'
    | 'campaign'
    | 'sales_email'
    | 'deck'
    | 'other';
  const forceRelevant = process.argv.includes('--force-relevant');
  if (!responseFile) {
    console.error('usage: review-cli --response-file <file> [--prompt-file <file>] [--kind <kind>] [--force-relevant]');
    process.exit(1);
  }
  const prompt = promptFile ? await fs.readFile(promptFile, 'utf8') : '(no prompt)';
  const response = await fs.readFile(responseFile, 'utf8');
  const root = process.env.POMEGRANATE_DATA_DIR ?? '.pomegranate';
  const storage = new FileStorage({ rootDir: path.resolve(root) });
  const r = await review({ prompt, response }, { storage, kind, forceRelevant });
  if (r.reviewed) {
    console.log(`Wrote ${r.reviewPath}`);
  } else {
    console.log(`Skipped: ${r.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
