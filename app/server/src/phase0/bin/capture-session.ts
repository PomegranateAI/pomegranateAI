#!/usr/bin/env node
/**
 * capture-session — store a content-strategy session (artifacts + feedback)
 * as a Pomegranate interaction record under .pomegranate/interactions/.
 * Counterpart to ingest/review CLIs. Shape documented in the
 * pomegranate-content-capture skill manifest.
 *
 *   capture-session --payload-file <file.json> [--id <id>]
 *   echo '{...}' | capture-session
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { FileStorage } from '../../lib/storage.js';

export const ContentSession = z.object({
  kind: z.literal('content-strategy-session'),
  schema_version: z.literal(1).default(1),
  captured_at: z
    .string()
    .default(() => new Date().toISOString()),
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  topic: z.string().min(1),
  artifacts: z
    .array(
      z.object({
        surface: z.string().min(1),
        label: z.string().optional(),
        text: z.string().min(1),
      }),
    )
    .min(1),
  feedback: z.array(
    z.object({
      on: z.string().optional(),
      note: z.string().min(1),
      kind: z
        .enum([
          'rewrite',
          'rejection',
          'approval',
          'banned',
          'approved',
          'style',
          'positioning',
          'other',
        ])
        .optional(),
    }),
  ),
  decisions: z
    .array(z.object({ summary: z.string().min(1) }))
    .optional(),
});

export type ContentSession = z.infer<typeof ContentSession>;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function captureSession(payload: unknown, opts: { storage: FileStorage; id?: string }): Promise<{ filename: string; id: string; session: ContentSession }> {
  const result = ContentSession.safeParse(payload);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`invalid ContentSession payload: ${messages}`);
  }
  const session = result.data;
  await opts.storage.init();
  const id = opts.id ?? `content-${Date.now()}-${nanoid(8)}`;
  const filename = await opts.storage.writeInteraction(id, session);
  return { filename, id, session };
}

async function main() {
  const payloadFile = arg('payload-file');
  const idArg = arg('id');
  let raw: string;
  if (payloadFile) {
    raw = await fs.readFile(payloadFile, 'utf8');
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) {
    console.error('usage: capture-session --payload-file <file.json>   (or pipe JSON on stdin)');
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`invalid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  const root = process.env.POMEGRANATE_DATA_DIR ?? '.pomegranate';
  const storage = new FileStorage({ rootDir: path.resolve(root) });
  try {
    const { filename, session } = await captureSession(parsed, { storage, id: idArg });
    console.log(filename);
    console.log(`captured ${session.artifacts.length} artifact(s), ${session.feedback.length} feedback note(s)`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

// Run main when invoked as a CLI, not when imported as a module for tests.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const here = path.resolve(new URL(import.meta.url).pathname);
  return entry === here || entry.endsWith('/capture-session.js') || entry.endsWith('/capture-session.ts');
})();

if (invokedAsCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
