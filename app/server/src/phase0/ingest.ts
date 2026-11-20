import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { FileStorage } from '../lib/storage.js';
import { getProvider } from '../lib/synthesis.js';
import { assignFlag } from '../lib/diff.js';
import type { Candidate } from '../lib/schemas.js';

interface IngestState {
  lastRun?: string;
  hashes?: Record<string, string>;
}

const STRATEGY_EXTS = new Set(['.md', '.txt', '.markdown']);
const TRANSCRIPT_EXTS = new Set(['.vtt']);

export interface IngestOptions {
  storage: FileStorage;
  sources: string[]; // file or directory paths to scan
  force?: boolean; // ignore state.json
  dryRun?: boolean; // don't write
  verbose?: boolean;
}

export interface IngestResult {
  filesProcessed: number;
  filesSkipped: number;
  candidates: Candidate[];
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const { storage } = opts;
  const runCapture = getProvider().capture;
  await storage.init();

  const state = (await storage.readState()) as IngestState;
  const hashes = state.hashes ?? {};

  const allFiles: string[] = [];
  for (const src of opts.sources) {
    const stat = await fs.stat(src).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      allFiles.push(src);
    } else if (stat.isDirectory()) {
      await walk(src, allFiles);
    }
  }

  // Also include relevant interactions from .pomegranate/interactions/
  const interactionFiles = await listInteractions(storage);
  allFiles.push(...interactionFiles);

  const graph = await storage.readGraph();
  const candidates: Candidate[] = [];
  let processed = 0;
  let skipped = 0;

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    const isInteraction = file.startsWith(storage.interactionsDir);
    const isStrategy = STRATEGY_EXTS.has(ext) && !isInteraction;
    const isTranscript = TRANSCRIPT_EXTS.has(ext);
    if (!isInteraction && !isStrategy && !isTranscript) continue;

    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const hash = sha256(content);
    if (!opts.force && hashes[file] === hash) {
      skipped++;
      continue;
    }

    if (opts.verbose) console.error(`[ingest] processing ${file}`);

    const sourceKind = isInteraction ? 'interaction' : isTranscript ? 'transcript' : 'doc';
    let raw: Candidate[];
    try {
      raw = await runCapture({ graph, sourceKind, source: content });
    } catch (err) {
      await storage.appendDebug(`capture failed on ${file}: ${(err as Error).message}`);
      continue;
    }

    // Apply deterministic diff: trust diff over model flag when they disagree
    const enriched = raw.map((c) => {
      const checked = assignFlag(c, graph);
      const id = c.id || nanoid(10);
      return {
        ...c,
        id,
        flag: checked.flag,
        conflicts_with: checked.conflicts_with,
        reason: c.reason ?? checked.reason,
        source_ref: c.source_ref || path.relative(process.cwd(), file),
      };
    });

    candidates.push(...enriched);
    hashes[file] = hash;
    processed++;
  }

  if (!opts.dryRun) {
    await storage.appendBacklog(candidates);
    await storage.writeState({
      ...state,
      lastRun: new Date().toISOString(),
      hashes,
    });
  }

  return { filesProcessed: processed, filesSkipped: skipped, candidates };
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile()) out.push(full);
  }
}

async function listInteractions(storage: FileStorage): Promise<string[]> {
  try {
    const entries = await fs.readdir(storage.interactionsDir);
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => path.join(storage.interactionsDir, e));
  } catch {
    return [];
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
