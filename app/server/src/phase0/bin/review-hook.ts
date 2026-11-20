#!/usr/bin/env node
/**
 * Stop hook for Claude Code. Receives the hook event payload on stdin,
 * extracts the most recent (prompt, response) pair from the session
 * transcript file referenced by the payload, and runs the Pomegranate
 * review pipeline asynchronously.
 *
 * Returns immediately with exit code 0 so the user's next prompt is
 * never blocked by hook latency.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const stdin = await readStdin();
  let payload: HookPayload = {};
  if (stdin.trim()) {
    try {
      payload = JSON.parse(stdin) as HookPayload;
    } catch {
      // Some hook versions pass plain text; tolerate.
    }
  }

  // Fork to a detached worker so we return immediately (PRD: async, non-blocking).
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(__dirname, 'review-worker.ts'),
    ],
    {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env },
    },
  );
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  child.unref();

  // Always exit 0 — failures live in .pomegranate/debug.log
  process.exit(0);
}

main().catch(() => process.exit(0));
