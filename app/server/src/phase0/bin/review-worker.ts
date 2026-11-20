#!/usr/bin/env node
/**
 * Detached worker that actually runs the review. Spawned by review-hook.ts
 * so the hook returns immediately.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileStorage } from '../../lib/storage.js';
import { review } from '../review.js';

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

interface TranscriptEntry {
  type: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
  // older shape
  role?: string;
  content?: string;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b as any).type === 'text' && typeof (b as any).text === 'string')
      .map((b) => (b as any).text as string)
      .join('\n');
  }
  return '';
}

async function readLastInteraction(transcriptPath: string): Promise<{ prompt: string; response: string } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries: TranscriptEntry[] = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l));
    } catch {
      // skip malformed
    }
  }
  // Find the latest assistant text and the user message that triggered it
  let lastAssistant: { idx: number; text: string } | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const role = e.message?.role ?? e.role;
    const text = extractText(e.message?.content ?? e.content);
    if (role === 'assistant' && text.trim()) {
      lastAssistant = { idx: i, text };
      break;
    }
  }
  if (!lastAssistant) return null;
  for (let i = lastAssistant.idx - 1; i >= 0; i--) {
    const e = entries[i]!;
    const role = e.message?.role ?? e.role;
    const text = extractText(e.message?.content ?? e.content);
    if (role === 'user' && text.trim()) {
      return { prompt: text, response: lastAssistant.text };
    }
  }
  return null;
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
  try {
    payload = JSON.parse(stdin || '{}') as HookPayload;
  } catch {
    /* tolerate */
  }
  const cwd = payload.cwd ?? process.cwd();
  const dataDir = process.env.POMEGRANATE_DATA_DIR ?? '.pomegranate';
  const storage = new FileStorage({ rootDir: path.resolve(cwd, dataDir) });
  await storage.init();
  if (!payload.transcript_path) {
    await storage.appendDebug('no transcript_path in payload; nothing to review');
    return;
  }
  const interaction = await readLastInteraction(payload.transcript_path);
  if (!interaction) {
    await storage.appendDebug(`no interaction extractable from ${payload.transcript_path}`);
    return;
  }
  try {
    await review(interaction, { storage });
  } catch (err) {
    await storage.appendDebug(`review failed: ${(err as Error).message}`);
  }
}

main().catch(() => process.exit(0));
