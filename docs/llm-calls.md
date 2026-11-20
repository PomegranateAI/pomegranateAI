# Convention: LLM calls

How every Claude / open-source-model call in this codebase is authored, logged,
and traced. Applies to all synthesis tasks (triage, capture, feedback, query,
grouping) and any new task added in the future. Eval scripts that issue LLM
calls (e.g. `evals/group-judge.ts`) follow the same rules.

Goals:

- A reader can find every prompt without reading code.
- An auditor (us, a design partner, a regulator) can answer "who asked what,
  in which workspace, against which source / deliverable, what did the model
  return, what did it cost" by reading one append-only log.
- Tests can pin a prompt version. Production can swap a prompt without
  shipping new code.

## 0. Provider scope

Two third-party providers are in the data path today: Anthropic for triage /
capture / feedback / query / grouping synthesis, and OpenAI for the
embedding model used by the Layer-3 dedup pass (`lib/embeddings.ts`). The
embedding provider is pluggable behind a small `Embedder` interface — when
no `OPENAI_API_KEY` is set the system falls back to `StubEmbedder` and
emits a `embeddings.using_stub_default` warn at boot. Stub mode keeps the
pipeline working but degrades paraphrase dedup to "best effort via the
Layer 2 prompt".

The embedder is logged like any other LLM call: every batch call writes
one `llm.log` row with `task: 'embed'`. Per-row contents follow the same
rule as the rest of the file — log counts and token usage, never the
input text.

## 1. Prompt storage

All system prompts live in `app/server/src/lib/prompts/<task>.md`. One file
per LLM task. The file is the source of truth — never duplicate the prompt
body into a `const PROMPT = '...'` inside a `.ts` file.

The file is markdown with YAML frontmatter:

```markdown
---
name: capture
purpose: Extract candidate graph updates (goal / positioning / decision) from a source artifact.
inputs:
  - graph         # active graph_nodes, serialized as JSON
  - source_kind   # doc | slack | transcript | interaction
  - source        # the artifact text, possibly chunked
output_schema: CapturePayload (lib/schemas.ts)
model: claude-sonnet-4-5-20250929
version: 2
---

You are the CAPTURE synthesis component of Pomegranate.
…body of the prompt…
```

Rules:

- `name` matches the filename (kebab-case).
- `purpose` is one sentence. A reader skimming the file should understand
  why this call exists.
- `inputs` lists the variables the user message will contain. The runtime
  doesn't validate this — it's documentation for humans.
- `output_schema` names the Zod schema in `lib/schemas.ts` that re-validates
  the model's output. Every LLM call must have a parseable structured-output
  contract; freeform text is not acceptable.
- `model` is the default. The runtime may override (e.g. capture currently
  uses Sonnet 4.5; if a future iteration wants Haiku for triage, the
  override lives in the dispatcher).
- `version` bumps any time the prompt body changes meaningfully. The LLM
  log records the version per call.

A prompt is loaded via `loadPrompt('capture')` (`lib/anthropic.ts`). The
loader strips the frontmatter and returns only the body for the model.
Frontmatter is exposed separately for the LLM log.

Where prompts may NOT live:

- Inline string constants in `.ts` files.
- Inside test fixtures.
- Inside eval scripts. The judge prompt for the grouping eval is in
  `lib/prompts/judge-group.md`, not inside `evals/group-judge.ts`.

## 2. The LLM-call log

Every LLM call writes one JSON-line record to a separate file (default
`./data/llm.log`, override with `POMEGRANATE_LLM_LOG_PATH`). This is in
addition to the server's structured log — it does not replace it.

Each record explains **who, what, why**:

| field | what it says |
|---|---|
| `ts` | ISO timestamp |
| `task` | the prompt name (`capture`, `feedback`, `group_candidates`, …) |
| `caller` | the code path (`api.ingest_file`, `api.candidates_groups`, `mcp.review_deliverable`, `eval.group_judge`) — answers **why** the call happened |
| `workspace_id` | always present when called from an authenticated request |
| `user_id` | the leader or IC behind the request (`u_…`) |
| `model` | the resolved model |
| `prompt_version` | the `version` field from the prompt's frontmatter |
| `context` | task-specific identifiers (see below) — answers **what** the call is about |
| `input` | a structured summary of the user message: counts, names, kinds. NOT the verbatim user text and NOT the system prompt body. |
| `output` | the parsed structured output from the model (full) — or `null` plus an `error` field on failure |
| `tokens` | `{ input, cache_read, cache_write, output }` from the Anthropic usage block |
| `latency_ms` | wall clock |
| `error` | `null` on success; error message on failure |

Task-specific `context` rules:

- **`capture`** (analyzing a source): must include `source_id`, `source_name`,
  `source_kind`, `source_chars`, `chunk_index` and `chunk_count` (chunks emit
  one log line each).
- **`feedback`** (reviewing a deliverable): must include `deliverable_kind`,
  `deliverable_chars`, `caller_kind` (`web` vs `mcp`), and the deliverable's
  `source_ref` if it was uploaded from a file.
- **`query`** (MCP `query_context`): `scope`, `question_chars`,
  `mcp_token_id` (when called from MCP, not when web).
- **`group_candidates`** (aggregating items for bulk curation): must name
  the workspace, the **candidate_count**, the **candidate_ids** (the actual
  list — small enough to keep), and a `sources_summary` listing each source
  represented in the set with its item count, e.g. `{ "investor-pitch.md":
  26, "operator.md": 17 }`. Answers "which items are being grouped".
- **`triage`** / **`judge-group`** / other meta tasks: include the parent
  `task` and the input that prompted them.

The `input` and `output` blocks are intentionally structured (not free
text) so the log is grep-friendly:

```jsonl
{"ts":"2026-05-17T23:46:48Z","task":"group_candidates","caller":"api.candidates_groups","workspace_id":"ws_example01","user_id":"u_abc","model":"claude-sonnet-4-5-20250929","prompt_version":1,"context":{"candidate_count":111,"candidate_ids":["c_aBc",…],"sources_summary":{"investor-pitch.md":26,"operator.md":17,"product-strategy.md":15,"gtm-positioning.md":40,"prd-minimal.md":13}},"input":{"candidates_kinds":{"goal":9,"positioning":67,"decision":35},"flag_breakdown":{"red":0,"yellow":7,"green":104}},"output":{"groups":[…full GroupingPayload…]},"tokens":{"input":12054,"cache_read":1452,"cache_write":0,"output":3355},"latency_ms":90059}
```

Rules:

- One line per call. Never split a call across lines.
- **Never log the system prompt body or the verbatim user text.** The
  system prompt is in the .md file under version control; logging it on
  every call wastes disk and reveals nothing new. The verbatim user text
  (deliverable, source, question) belongs in the `reviews` / `sources` /
  `audit_log` tables — not here.
- **Always log the full structured output.** That's the answer the model
  produced; it's what a future auditor needs.
- The log is append-only. Never rotate or rewrite in place.

## 3. Call context propagation

The API and MCP entry points are responsible for setting the per-call
context before invoking a synth function. The mechanism is an
`AsyncLocalStorage` instance in `lib/llm-context.ts`. There are two layers:

- **Auth middleware** sets `{ workspace_id, user_id }` once per request.
  Inherited by every synth call inside that request.
- **Endpoint-specific** context (e.g. the file-ingest endpoint adding
  `source_id`, `source_name`, `source_kind`) wraps the synth call in
  `withLlmContext({...}, () => synth.capture(...))`.

A synth call invoked with no context (e.g. from a one-off script) still
logs — with `workspace_id: null`, `user_id: null`, and `caller: 'unknown'`.

## 4. Eval and judge calls

Eval scripts (`evals/*.ts`) use the same logger. The `caller` field is
`eval.<script>` (e.g. `eval.group_judge`). The prompt comes from the same
`prompts/` directory.

A judge call about another call should record the parent call's `id` (we
add a synthesized `call_id` to every record). This lets the log answer
"which judge call rated this grouping" by linking.

## 5. PII and trust

The LLM log is **not** the customer-audit log. It is an internal
engineering artifact, intended for prompt tuning, regression triage, and
cost analysis. It does NOT include verbatim user prompts or deliverable
text. Customer-facing audit of "a deliverable was submitted" lives in
`customer_audit_log`.

Workspace deletion does not cascade to this file. If a customer demands
data deletion under DPA, the operator runs `npm run llm-log:scrub --
--workspace=ws_XXX` (script TBD) which rewrites the file dropping rows
for that workspace.

## 6. Anti-patterns to reject in review

- Adding an inline `const PROMPT = '...'` string in a `.ts` file.
- Logging `console.error(...)` for an LLM result instead of using the
  llm-log.
- Skipping the log on a cache hit. The cache hit is the most interesting
  signal for cost analysis — record `cache_read: <tokens>` and proceed.
- Logging the verbatim user message body (the source, the deliverable,
  the question) into the LLM log. That data is in the DB; don't duplicate.
- Free-text outputs. Every LLM call uses Anthropic tool-use (or equivalent
  for other providers) so the output passes through a Zod schema.

## 7. File checklist for a new LLM call

When adding a new task (call it `X`):

1. Create `app/server/src/lib/prompts/X.md` with frontmatter (`name`,
   `purpose`, `inputs`, `output_schema`, `model`, `version: 1`).
2. Create the Zod schema in `lib/schemas.ts` (e.g. `XPayload`).
3. Add the call in `lib/anthropic.ts` as `runX()`. Use `loadPrompt('X')`,
   pass a JSON-schema input shape, parse the result with the Zod schema.
4. Add it to the `SynthesisProvider` interface in `lib/synthesis.ts`.
5. Wire the API or MCP endpoint to set `withLlmContext({...}, () => synth.X(...))`.
6. No new log code — `callStructured` writes the llm-log automatically.
