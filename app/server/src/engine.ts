/**
 * Public engine surface for hosts that embed the server in their own process.
 *
 * This is the ONLY entry point external consumers should import. It re-exports
 * the route builder, the storage layer, the synthesis provider, and the two
 * model-injection seams — everything needed to run the engine in-process
 * against local models, with no cloud/auth/listener concerns.
 *
 * Importing this module has no side effects (unlike phase1/api/server.ts, which
 * is the cloud bootstrap): it neither opens a DB nor starts a server.
 */
export { buildApp, backfillMissingEmbeddings } from './phase1/api/routes.js';
export type { RouteCtx, AppVars } from './phase1/api/routes.js';
export { openDb } from './phase1/db/schema.js';
export { Repo } from './phase1/db/repo.js';
export { getProvider } from './lib/synthesis.js';
export type { SynthesisProvider } from './lib/synthesis.js';
export { setStructuredLLM, usingLocalLLM, structuredCall } from './lib/anthropic.js';
export type { StructuredLLMOverride, StructuredCallResult } from './lib/anthropic.js';
// Subgraph routing surface — exported so the routing eval harness can exercise
// the REAL classifier (not a copy) against a labeled golden set, and sweep
// prompt/hint variants. Production routing calls these internally.
export {
  routeToSubgraphs,
  subgraphRoutingAbout,
  buildSubgraphRouteCatalog,
  SUBGRAPH_ROUTE_SYSTEM,
} from './lib/anthropic.js';
export type { RouteSubgraph } from './lib/anthropic.js';
export { HostedStructuredLLM } from './lib/hosted-llm.js';
export type { HostedLLMOptions } from './lib/hosted-llm.js';
export { configureLlmProvider } from './lib/llm-provider.js';
export { setEmbedder } from './lib/embeddings.js';
export type { Embedder } from './lib/embeddings.js';
export { withLlmContext } from './lib/llm-context.js';
export { notesTemplate } from './lib/profiles/index.js';
export { DEFAULT_PROFILE_ID, getBuiltinProfile, listBuiltinProfiles } from './lib/profiles/index.js';
