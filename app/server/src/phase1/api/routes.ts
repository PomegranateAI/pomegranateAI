import { registerMediaRoutes } from '../data-agents/routes.js';
import { bodyLimit } from 'hono/body-limit';
import { withMediaProvenance } from '../data-agents/context.js';
import { RedactionUnavailableError } from '../ingest/redaction-error.js';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import * as path from 'node:path';
import { Repo } from '../db/repo.js';
import type { SynthesisProvider } from '../../lib/synthesis.js';
import { log } from '../../lib/log.js';
import { mountMcpHttp, capabilityUrlsEnabled } from '../mcp/server.js';
import { mountOAuth } from '../oauth/server.js';
import { limiterFromEnv, rateLimitKey } from './rate-limit.js';
import { embeddingToBlob, embeddingTextForNode, getEmbedder } from '../../lib/embeddings.js';
import type { UpdateScheduler } from '../updates/scheduler.js';
import { createRouteCore } from './routes/core.js';
import { registerAuth } from './routes/auth.js';
import { registerSso } from './routes/sso.js';
import { registerScim } from './routes/scim.js';
import { registerMfa } from './routes/mfa.js';
import { registerWiki } from './routes/wiki.js';
import { registerWorkspaces } from './routes/workspaces.js';
import { registerMe } from './routes/me.js';
import { registerMembers } from './routes/members.js';
import { registerStructure } from './routes/structure.js';
import { registerDataAgents } from './routes/data-agents.js';
import { registerRouting } from './routes/routing.js';
import { registerGraph } from './routes/graph.js';
import { registerAutomations } from './routes/automations.js';
import { registerGraphWrites } from './routes/graph-writes.js';
import { registerCuration } from './routes/curation.js';
import { registerIngest } from './routes/ingest.js';
import { registerSources } from './routes/sources.js';
import { registerAgents } from './routes/agents.js';
import { registerFeedback } from './routes/feedback.js';
import { registerMirror } from './routes/mirror.js';
import { registerUsage } from './routes/usage.js';
import { registerAdmin } from './routes/admin.js';
import { registerDeletionAudit } from './routes/deletion-audit.js';
import { registerSurfaceAgent } from './routes/surface-agent.js';
import { registerSlackListen } from './routes/slack-listen.js';


export type AppVars = {
  user_id: string;
  workspace_id: string;
  role: string;
  /** Session opened through the identity provider (single sign-on). */
  via_sso?: boolean;
};

export interface RouteCtx {
  repo: Repo;
  synth: SynthesisProvider;
  /** Directory for persisted source files / doc text. */
  filesDir: string;
  onMediaWorker?: (tick: () => Promise<void>) => void;
  /**
   * Authentication middleware. Omit to use the default session-Bearer gate
   * (cloud). An embedding host can inject a no-op that pins a single
   * local identity (no sessions, no membership).
   */
  authn?: MiddlewareHandler<{ Variables: AppVars }>;
  /**
   * Workspace gate. Omit to use the default membership check (cloud). The
   * standalone app injects one that pins workspace_id from the URL param with
   * admin role and no membership lookup.
   */
  workspaceGate?: MiddlewareHandler<{ Variables: AppVars }>;
  /**
   * The update scheduler (Subscribe to Updates). When provided, the internal
   * `POST /internal/updates/run-due` endpoint drives it for backfill/tests.
   * Omit (standalone) to leave the endpoint returning 501.
   */
  updateScheduler?: UpdateScheduler;
}

/**
 * Build the fully-routed Hono app. Both the cloud server (server.ts) and the
 * embedding hosts consume this; they differ only in the auth
 * middleware + ctx injected. No module side effects — importing this file
 * neither opens a DB nor starts a listener.
 */
export function buildApp(ctx: RouteCtx): Hono<{ Variables: AppVars }> {
  const app = new Hono<{ Variables: AppVars }>();
  const core = createRouteCore(ctx, app);
  const {
    repo,
    corsOrigins,
    synth,
    media,
    runInstructedIngest,
    runTextIngest,
    authn,
    workspaceGate,
    isWorkspaceOwnerTier,
    mcpDeps,
    clientIp,
  } = core;
app.use('*', cors({ origin: corsOrigins }));

// Request-body size limits, so an oversized body (signed in or not) cannot
// exhaust memory: small for sign-in and OAuth, the upload cap for multipart
// file uploads, and a generous ceiling for everything else (pasted text).
const payloadTooLarge = (c: any) => c.json({ error: 'payload_too_large' }, 413);
app.use('/auth/*', bodyLimit({ maxSize: 64 * 1024, onError: payloadTooLarge }));
app.use('/mcp/oauth/*', bodyLimit({ maxSize: 64 * 1024, onError: payloadTooLarge }));
const multipartLimit = bodyLimit({ maxSize: 26 * 1024 * 1024, onError: payloadTooLarge });
const jsonLimit = bodyLimit({ maxSize: 10 * 1024 * 1024, onError: payloadTooLarge });
app.use('*', (c, next) =>
  ((c.req.header('content-type') ?? '').toLowerCase().startsWith('multipart/') ? multipartLimit : jsonLimit)(c, next),
);

// ---------- request logging + error capture ----------
// Logged for every request: method, path, status, wall-clock ms. The path
// includes the workspace id when present, so a `grep ws_example01` is enough
// to trace one workspace's activity across the file.
app.use('*', async (c, next) => {
  const t0 = Date.now();
  let status = 0;
  try {
    await next();
    status = c.res.status;
  } finally {
    const fields: Record<string, unknown> = {
      method: c.req.method,
      // The capability-URL connector path carries its secret; never log it.
      path: new URL(c.req.url).pathname.replace(/^(\/mcp\/connector\/)[^/]+/, '$1<redacted>'),
      status: status || c.res.status || 0,
      ms: Date.now() - t0,
    };
    // Health checks are noisy and uninteresting; demote to debug.
    if (fields.path === '/healthz') log.debug('api.request', fields);
    else log.info('api.request', fields);
  }
});

// ---------- rate limits ----------
// Per credential (or per IP without one). Two buckets: a generous one for every
// route, and a tighter one for the routes that run the LLM pipeline on each
// call (ingest, MCP), where a runaway client or a stolen token costs real
// money and can starve the serialized ingest queue. Defaults allow 10 req/s
// sustained (burst 600) overall and 1 req/s (burst 60) on the heavy routes;
// override with POMEGRANATE_API_RL_* / POMEGRANATE_HEAVY_RL_* (CAPACITY,
// REFILL_MS). /auth/* keeps its own stricter per-IP limiter.
const apiLimiter = limiterFromEnv('POMEGRANATE_API_RL', { capacity: 600, refillIntervalMs: 100 });
const heavyLimiter = limiterFromEnv('POMEGRANATE_HEAVY_RL', { capacity: 60, refillIntervalMs: 1000 });
const HEAVY_ROUTE = /^\/(mcp\/(server|tools\/|connector\/)|workspaces\/[^/]+\/ingest)/;
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/healthz' || c.req.method === 'OPTIONS') return next();
  const key = rateLimitKey(c, clientIp(c));
  const heavy = c.req.method === 'POST' && HEAVY_ROUTE.test(path);
  const limiter = !apiLimiter.take(key) ? apiLimiter : heavy && !heavyLimiter.take(key) ? heavyLimiter : null;
  if (limiter) {
    const retryAfter = limiter.retryAfterSec(key);
    log.warn('api.rate_limited', { heavy, key_kind: key.slice(0, key.indexOf(':')), retry_after_s: retryAfter });
    return c.json({ error: 'rate_limited', retry_after_s: retryAfter }, 429, { 'retry-after': String(retryAfter) });
  }
  return next();
});

app.onError((err, c) => {
  // A fail-closed source-redaction refusal (see redactSourceText) is a clean,
  // expected outcome for every ingest entry point, not an internal error.
  if (err instanceof RedactionUnavailableError) return c.json(err.body(), 422);
  const path = new URL(c.req.url).pathname;
  log.error('api.uncaught', {
    method: c.req.method,
    path,
    workspace: (c.get('workspace_id') as string | undefined) ?? undefined,
    user: (c.get('user_id') as string | undefined) ?? undefined,
    msg: (err as Error).message?.slice(0, 400),
    name: (err as Error).name,
  });
  return c.json({ error: 'internal_error', detail: (err as Error).message?.slice(0, 200) }, 500);
});

// ---------- health ----------
app.get('/healthz', (c) => c.json({ ok: true, provider: synth.name }));
app.get('/auth/assistant-config', (c) => c.json({ oauth_only: !capabilityUrlsEnabled() }));
registerAuth(app, core);
registerSso(app, core);
registerScim(app, core);
registerMfa(app, core);
registerWorkspaces(app, core);
registerMe(app, core);
registerMembers(app, core);
registerStructure(app, core);
registerDataAgents(app, core);
registerRouting(app, core);
registerWiki(app, core);
registerGraph(app, core);
registerAutomations(app, core);

// Evidence detail for one node (Graph UI: the corroboration list behind the
// [evidence: N sources] badge).
media.ingest = async (asset, input, processed) =>
  withMediaProvenance(
    [{ workspace_id: asset.workspace_id, asset_id: asset.id, run_id: processed.run_id }],
    async () => {
      const common = {
        ws: asset.workspace_id,
        user_id: asset.owner_user_id,
        source: processed.result.text,
        source_kind: asset.mime.startsWith('audio/') ? ('transcript' as const) : ('doc' as const),
        source_ref: asset.original_name,
        audience: input.audience,
      };
      const result = input.instructions
        ? await runInstructedIngest({
            ...common,
            instructions: input.instructions,
            forcedSubgraph: input.subgraph_id,
          })
        : await runTextIngest({
            ...common,
            via: 'file',
            caller: 'api.media_ingest',
            forcedSubgraphId: input.subgraph_id,
            mediaLog: input.config.output === 'log',
          });
      return {
        ...result,
        agent: !!input.instructions,
        text_chars: processed.result.text.length,
        kind: asset.mime.startsWith('audio/') ? 'audio' : 'image',
      };
    },
  );
ctx.onMediaWorker?.(() => media.runDue());
registerMediaRoutes(app, media, authn, workspaceGate, isWorkspaceOwnerTier);
registerGraphWrites(app, core);
registerCuration(app, core);
registerIngest(app, core);
registerSources(app, core);
registerAgents(app, core);
registerFeedback(app, core);
registerMirror(app, core);
registerUsage(app, core);
registerAdmin(app, core);
registerDeletionAudit(app, core);
mountOAuth(app, repo);
mountMcpHttp(app, mcpDeps);
registerSurfaceAgent(app, core);
registerSlackListen(app, core);

  return app;
}

/**
 * Walk every active `graph_nodes` row that has no embedding and embed it.
 * Batched into chunks of 50 inputs per API call to keep token budgets sane.
 * Logged at start and end with counts. Takes `repo` explicitly so both the
 * cloud bootstrap and the standalone app can run it after building the app.
 */
export async function backfillMissingEmbeddings(repo: Repo): Promise<void> {
  const missing = await repo.listActiveNodesMissingEmbedding();
  if (missing.length === 0) {
    log.info('embeddings.backfill_skip', { reason: 'no missing rows' });
    return;
  }
  log.info('embeddings.backfill_start', { rows: missing.length });
  const embedder = getEmbedder();
  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const texts = batch.map((m) => embeddingTextForNode(m.node as any));
    try {
      const vecs = await embedder.embed(texts);
      await repo.tx(async () => {
        for (let j = 0; j < batch.length; j++) {
          const v = vecs[j];
          if (!v) continue;
          await repo.setNodeEmbedding(batch[j]!.workspace_id, batch[j]!.node.id, embeddingToBlob(v));
        }
      });
      done += batch.length;
    } catch (err) {
      log.warn('embeddings.backfill_batch_failed', {
        batch_start: i,
        batch_size: batch.length,
        msg: (err as Error).message?.slice(0, 200),
      });
    }
  }
  log.info('embeddings.backfill_done', { embedded: done, total: missing.length });
}
