# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.
Read [README.md](README.md) first for what Pomegranate is and how to run it.

## Layout

Four packages, each with its own `package.json` and lockfile. They are not
wired into one build — run commands from the package directory.

| Path | What | Key commands |
|---|---|---|
| `app/server` | Hono API, MCP server, pipeline | `npm run dev:p1`, `npm run build`, `npm run test:run` |
| `app/web` | React + Vite SPA (talks to the server at `/api`) | `npm run dev`, `npm run build`, `npm run test:e2e` |
| `surfaces/slack` | Slack bot | `npm test`, `npm run typecheck` |
| `surfaces/whatsapp` | WhatsApp bot | `npm test`, `npm run typecheck` |

`npm run build` in `app/server` matters more than it looks: `npm start` runs
the compiled `dist/`, so a failing build ships stale code. CI runs it.

## Architecture rules (read before changing the pipeline)

- **No vendor lock-in in the server.** Hono on Node, `better-sqlite3`, the
  filesystem, an in-process job queue. Keep cloud-specific code behind the existing driver flags in
  `src/platform/`.
- **Phase 0 vs Phase 1.** `src/phase0/` is the original single-user CLI
  (local markdown storage, a Claude Stop hook). `src/phase1/` is the
  multi-tenant product and where nearly all work happens. `src/lib/` is shared.
- **Workspace isolation is enforced in the application layer, not the DB.**
  Every table has a composite key `(workspace_id, id)` and every query carries
  `workspace_id`. Cross-tenant tripwire tests (`src/phase1/db/repo.test.ts`,
  isolation cases in `server.test.ts` and `mcp/adversarial.test.ts`) must stay
  green, and any new table or query must be workspace-scoped.
- **Subgraphs partition a workspace.** In the UI a workspace is a
  "directory" and a subgraph is a "folder". Nodes are subgraph-local;
  documents are shared across the workspace. Requests carry `x-subgraph-id`.
- **One LLM seam.** `configureLlmProvider()` in `src/lib/llm-provider.ts` runs
  at boot (`POMEGRANATE_LLM_PROVIDER=together | hosted | anthropic`); every
  call goes through `callStructured` in `src/lib/anthropic.ts`.
- **Migrations are additive and idempotent.** `migrate()` in
  `src/phase1/db/schema.ts` runs on every open. Add columns with
  `addColumnIfMissing` and keep the `CREATE TABLE` in sync. Never write a
  destructive migration.
- **Embeddings** go through the `Embedder` interface in `src/lib/embeddings.ts`;
  without `OPENAI_API_KEY` the deterministic `StubEmbedder` is used.
- **Auth defaults are safety rails.** Sign-up is closed unless
  `SIGNUP_MODE=open`. Sign-in codes are never returned in API responses
  unless `POMEGRANATE_DEV_INLINE_CODES=1` (tests only). Don't weaken either.

## LLM-call conventions (mandatory — see docs/llm-calls.md)

- Prompts live in `app/server/src/lib/prompts/<task>.md`, one file per task,
  with YAML frontmatter (`name`, `purpose`, `inputs`, `output_schema`,
  `model`, `version`). Never inline a prompt as a string constant. Load with
  `loadPrompt('<task>')`; bump `version` when the body changes meaningfully.
- Every call returns structured output validated by a Zod schema in
  `src/lib/schemas.ts`. No free-text outputs.
- Every call appends one JSON line to the LLM log (automatic in
  `callStructured`): who/what/why, tokens, latency, structured output — never
  the system prompt or verbatim user text.
- Per-call context rides `AsyncLocalStorage` (`src/lib/llm-context.ts`); wrap
  calls in `withLlmContext({...}, () => ...)`.
- Unit tests use `TestSynthStub` (`src/__test_utils__/synth-stub.ts`). Never
  add a real model call to a unit test; the suites must pass with no API keys.

## Configuration

Every environment variable has a row in `app/server/src/platform/config.ts`.
After adding one, run `npm run env:example` in `app/server`; a test fails if
`.env.example` drifts from the registry.

## Git hygiene

Stage explicit paths and check `git diff --cached --name-only` before
committing. Never commit `.env` files, databases, logs or anything under
`data/`.
