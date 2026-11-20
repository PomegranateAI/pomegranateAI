import 'dotenv/config';
import { serve } from '@hono/node-server';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { openDb } from '../db/schema.js';
import { cryptoFromEnv } from '../../lib/crypto/boot.js';
import { Repo } from '../db/repo.js';
import { getProvider } from '../../lib/synthesis.js';
import { log } from '../../lib/log.js';
import { configureLlmProvider } from '../../lib/llm-provider.js';
import { buildApp, backfillMissingEmbeddings } from './routes.js';
import { createUpdateScheduler } from '../updates/scheduler.js';
import { createAutomationScheduler } from '../automations/scheduler.js';

/**
 * Cloud bootstrap. Owns the process-level concerns (env, DB file, listener)
 * and wires the default session-Bearer auth by NOT injecting custom middleware
 * — `buildApp` falls back to its membership-based gate. All routes live in
 * routes.ts, shared verbatim with any embedding host (which can inject
 * single-local-identity auth instead).
 */
const DB_PATH = process.env.POMEGRANATE_DB_PATH ?? './data/pomegranate.db';
const FILES_DIR = process.env.POMEGRANATE_FILES_DIR ?? './data/files';
const PORT = Number(process.env.PORT ?? 3000);

await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
await fs.mkdir(FILES_DIR, { recursive: true });

const db = openDb(DB_PATH);
const repo = new Repo(db);
// Encryption at rest for the seal-map columns (C3): pass-through unless
// POMEGRANATE_SEAL=1. A failed key unwrap is recorded in the workspace's
// internal audit log (key.unwrap_failed) — it means a wrong or missing KEK.
repo.crypto = cryptoFromEnv(repo.sql, process.env, {
  onUnwrapFailed: (workspaceId, keyVersion) => {
    void repo.logAudit(workspaceId, { event: 'key.unwrap_failed', payload: { key_version: keyVersion } }).catch(() => {});
  },
}).crypto;
const synth = getProvider();

// Subscribe to Updates (spec-subscribe-to-updates.md / U1). The scheduler is
// constructed here (it owns transports built from env) and passed into buildApp
// so the internal run-due endpoint can drive it. The periodic tick is started
// only under isMain + the UPDATES_SCHEDULER flag (below), so importing this
// module for tests never starts a timer.
const updateScheduler = createUpdateScheduler({ repo });

let mediaTick: (() => Promise<void>) | undefined;
const app = buildApp({ repo, synth, filesDir: FILES_DIR, updateScheduler, onMediaWorker: tick => { mediaTick = tick; } });

// The automations scheduler (redesign of the Automations tab, Stage 4) has no
// dependency injected into buildApp — its `dispatch` just needs `app.request`
// (an internal, in-process call through the SAME route handlers the manual
// "Run now" action uses), which only exists once `app` above is built. See
// automations/scheduler.ts for why this reuses the routes rather than a
// separate per-connector implementation.
const automationScheduler = createAutomationScheduler({
  repo,
  dispatch: async (authHeader, method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  },
});

// Preserve the historical export surface — the test suite and the MCP host
// import `{ app, repo, synth }` from this module.
export { app, repo, synth };

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js');

if (isMain) {
  // Select the structured-LLM backend (Anthropic by default, or the hosted
  // OpenAI-compatible endpoint when POMEGRANATE_LLM_PROVIDER=hosted). Gated
  // behind isMain so importing this module for tests never installs an override.
  const llmProvider = configureLlmProvider();
  const mediaTimer = setInterval(() => { void mediaTick?.().catch(() => {}); }, 15_000);
  mediaTimer.unref();
  serve({ fetch: app.fetch, port: PORT });
  log.info('api.boot', {
    port: PORT,
    provider: synth.name,
    llm_provider: llmProvider,
    db: DB_PATH,
    files_dir: FILES_DIR,
  });
  // Fire-and-forget backfill of missing graph_node embeddings. Idempotent.
  // Runs in the background so boot isn't blocked on the embedding API.
  // PRD § Capture synthesis "Dedup precision ≥ 90%" depends on every active
  // node having an embedding; this closes the loop on databases that pre-date
  // the embedding column.
  setImmediate(() => {
    backfillMissingEmbeddings(repo).catch((err) => {
      log.error('embeddings.backfill_failed', {
        msg: (err as Error).message?.slice(0, 400),
      });
    });
  });

  // Start the update scheduler tick behind a flag (U1 ships dark). The internal
  // run-due endpoint works regardless, so this can stay off until we're ready.
  if (process.env.UPDATES_SCHEDULER === '1') {
    updateScheduler.start();
    log.info('updates.scheduler_started', { tick_ms: 60_000 });
  }

  // Same dark-ship discipline for the automations scheduler (Stage 4): manual
  // "Run now" already works regardless of this flag.
  if (process.env.AUTOMATIONS_SCHEDULER === '1') {
    automationScheduler.start();
    log.info('automations.scheduler_started', { tick_ms: 60_000 });
  }
}
