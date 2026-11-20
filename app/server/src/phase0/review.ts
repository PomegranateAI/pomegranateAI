import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { FileStorage } from '../lib/storage.js';
import { getProvider } from '../lib/synthesis.js';
import type { Review } from '../lib/schemas.js';

export interface ReviewInput {
  prompt: string;
  response: string;
  working_directory?: string;
  timestamp?: string;
}

export interface ReviewOptions {
  storage: FileStorage;
  /** Skip triage entirely; assume relevant. For tests / manual fallback. */
  forceRelevant?: boolean;
  /** Treat the deliverable kind hint as this. Defaults to "other". */
  kind?: 'prd' | 'exec_update' | 'campaign' | 'sales_email' | 'deck' | 'other';
}

export interface ReviewResult {
  reviewed: boolean;
  reviewPath?: string;
  reason: string;
}

export async function review(input: ReviewInput, opts: ReviewOptions): Promise<ReviewResult> {
  const { storage } = opts;
  const synth = getProvider();
  const runTriage = synth.triage.bind(synth);
  const runFeedback = synth.feedback.bind(synth);
  await storage.init();

  const ts = input.timestamp ?? new Date().toISOString();
  const hash = sha256(`${input.prompt}\n${input.response}`).slice(0, 8);
  const id = `${ts.replace(/[:.]/g, '-')}-${hash}`;

  // 1. Triage
  let triage = opts.forceRelevant
    ? { relevant: true, reason: 'forced', confidence: 1.0 }
    : await runTriage(input.prompt, input.response);

  if (!triage.relevant) {
    const line = `${ts}\t${triage.confidence.toFixed(2)}\t${triage.reason.replace(/\t/g, ' ')}\t${input.prompt.slice(
      0,
      160,
    ).replace(/\n/g, ' ')}`;
    await storage.appendSkipped(line);
    return { reviewed: false, reason: triage.reason };
  }

  // 2. Capture the full interaction (relevant only) for later ingest
  await storage.writeInteraction(id, {
    id,
    timestamp: ts,
    working_directory: input.working_directory,
    prompt: input.prompt,
    response: input.response,
    triage,
  });

  // 3. Synthesis against the graph
  const graph = await storage.readGraph();
  let findings: Awaited<ReturnType<typeof runFeedback>>;
  try {
    findings = await runFeedback({
      graph,
      kind: opts.kind ?? 'other',
      deliverable: input.response,
    });
  } catch (err) {
    await storage.appendDebug(`feedback failed on ${id}: ${(err as Error).message}`);
    return { reviewed: false, reason: `feedback failed: ${(err as Error).message}` };
  }

  // 4. Integrity gate: drop any <red> finding without a real node citation
  const realIds = new Set(graph.map((n) => n.id));
  const safe = findings.filter((f) => {
    if (f.flag === 'red' && (!f.node_id || !realIds.has(f.node_id))) {
      return false;
    }
    if (f.node_id && !realIds.has(f.node_id)) {
      return false;
    }
    return true;
  });

  const r: Review = {
    id,
    created_at: ts,
    prompt: input.prompt,
    response: input.response,
    working_directory: input.working_directory,
    triage,
    findings: safe,
  };

  const reviewPath = await storage.writeReview(r);
  const summary = safe.length === 0 ? 'no findings' : `${safe.length} finding${safe.length === 1 ? '' : 's'}`;
  await storage.appendIndex(reviewPath, summary);

  return { reviewed: true, reviewPath, reason: 'reviewed' };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
