# Pomegranate Slack Bot — Engineering Doc

**Status:** Draft v0 · **Companion to:** SPEC.md, DESIGN.md
**Location:** `surfaces/slack` · **Last updated:** 2026-06-02

This is the implementation plan: stack, layout, the exact wire calls into
`app/server`, the config schema, module-by-module responsibilities, the small
app-side additions, the test plan, and milestones.

---

## 1. Stack

Match the app's stack (`app/server` is TS + Node, ESM, `type: module`,
Hono, Vitest):

- **Runtime:** Node ≥ 20, TypeScript, ESM.
- **Slack:** `@slack/bolt` (handles signature verification, event routing,
  retries; supports both HTTP Events API and Socket Mode).
- **HTTP client:** native `fetch` (Node 20+) — no axios.
- **Validation:** `zod` (already in the app; reuse the version).
- **Test:** `vitest` (mirror the app's config).
- **Lint/build:** `tsc -p tsconfig.json`, same `tsconfig` shape as
  `app/server/tsconfig.json`.

Dev ergonomics: **Socket Mode** in development (no public URL needed), HTTP
Events API in production.

---

## 2. Directory layout

Each module is tagged `[slack]` (tied to Slack as a medium) or `[shared]`
(surface-agnostic — written with **zero Slack imports** so it can later move to
`surfaces/shared` verbatim; see §12). We do **not** create `surfaces/shared`
yet — one surface doesn't justify the abstraction — but we keep the seam clean
now at near-zero cost.

```
surfaces/slack/
  docs/                       SPEC.md · DESIGN.md · ENGINEERING.md (this)
  package.json
  tsconfig.json
  .env.example                SLACK_* tokens, POMEGRANATE_API_URL
  config/
    mapping.example.json      surface↔Pomegranate mapping (see §4)
  src/
    index.ts          [slack] bootstrap: load config, start Bolt app
    app.ts            [slack] Bolt app wiring: register event handlers
    config.ts         [shared] load + validate mapping (zod), accessors
    resolve.ts        [shared] resolveWorkspace(), resolveCanon(), resolveRequester()
    command.ts        [shared] verb model + dispatch map (review/getcontext, extensible)
    parse.ts          [slack] parseMention(text) → {verb, subjectMention, rest}
    payload.ts        [slack] resolvePayload(event) → {kind, text|fileRef}
    client.ts         [shared] PomegranateClient: review(), getContext()
    format.ts         [slack] findings → mrkdwn ; queryAnswer → mrkdwn
    handlers.ts       [slack] onAppMention(): orchestrate the whole flow
    errors.ts         [shared] typed errors (SubjectNotMapped, …) + user messages
    log.ts            [slack] structured logging (mirror app/server/src/lib/log.ts)
    __tests__/
      parse.test.ts
      resolve.test.ts
      payload.test.ts
      format.test.ts
      handlers.test.ts        happy paths against a stubbed client
```

`parse.ts` is `[slack]` because it tokenizes Slack mrkdwn and `<@U…>` mentions;
the *result* it produces — a `Command` value — is the `[shared]` contract
defined in `command.ts`. That split is what lets a future Claude/ChatGPT surface
write its own parser while reusing everything downstream.

Stateless: no DB, no migrations. All durable state lives in `app/server`.

---

## 3. The two wire calls into `app/server`

Both go through the **MCP HTTP transport** (`phase1/mcp/server.ts`), authed with
a workspace-scoped bearer token (DESIGN §4). Base URL = `POMEGRANATE_API_URL`.

### 3.1 review (text payload)

```http
POST {API}/mcp/tools/review_deliverable
Authorization: Bearer {ws_mcp_token}
Content-Type: application/json

{ "content": "<deliverable text>", "kind": "other" }
```
Response: `{ id, findings: Finding[] }` — already integrity-gated and persisted
with `caller='mcp'`. (To record `caller='slack'`, use the new file/slack
endpoints in §5, or accept `caller='mcp'` for v0 text payloads.)

`Finding` (from `app/server/src/lib/schemas.ts`):
```ts
{ category: 'decisions'|'goals_priorities'|'positioning'|'brand_voice'|'context_recency',
  flag: 'red'|'yellow'|'green',
  node_id: string|null,
  quote_from_deliverable: string,
  summary: string,
  source_link?: string }
```

### 3.2 GetContext (text payload)

```http
POST {API}/mcp/tools/query_context
Authorization: Bearer {ws_mcp_token}
Content-Type: application/json

{ "question": "Which parts of this canon are relevant to the following material, and what do they say?\n\n<payload>",
  "scope": "all" }
```
Response: `{ answer: string, cited_node_ids: string[], has_answer: boolean }`
— already anti-hallucination-gated.

### 3.3 Client interface

```ts
// src/client.ts
export interface PomegranateClient {
  review(canon: CanonHandle, req: RequesterRef, deliverable: string, kind?: DeliverableKind): Promise<ReviewResult>;
  getContext(canon: CanonHandle, req: RequesterRef, payload: string): Promise<QueryResult>;
  // file variants (see §5) — multipart, fall back to text if disabled:
  reviewFile?(canon: CanonHandle, req: RequesterRef, file: FileBytes, kind?: DeliverableKind): Promise<ReviewResult>;
  getContextFile?(canon: CanonHandle, req: RequesterRef, file: FileBytes): Promise<QueryResult>;
  // FUTURE (req #2) — not implemented in v0; the interface simply has room:
  // addDocument?(target: CanonHandle, req: RequesterRef, file: FileBytes): Promise<IngestResult>;
}
type CanonHandle  = { workspaceId: string; subjectUserId: string; token: string };
type RequesterRef = { pomegranateUserId: string | null };   // "who is asking" → on_behalf_of
```

`CanonHandle` is opaque to handlers (DESIGN §3) — they never read `workspaceId`
directly. `RequesterRef` is the **on-behalf-of claim**: the client serializes it
into the `on_behalf_of` field of every request. v0's app ignores it for
filtering; future requirement #3 (per-requester document gating) reads it
app-side with no change to this signature. Passing it from day one costs one
parameter and makes the gating change zero-touch for the surface (DESIGN §4.1,
§11.3).

---

## 4. Config schema (`config/mapping.json`)

Single static file, validated with zod at boot. Gitignored; only
`mapping.example.json` is committed.

**Decision #1: each Slack user maps to their own Pomegranate workspace (their
canon).** The team block just registers the Slack workspace + API URL; the
canon, and its MCP token, live on each **user** entry.

```jsonc
{
  "teams": [
    { "slack_team_id": "T0123ABCD",                       // the connected Slack workspace
      "pomegranate_api_url": "http://localhost:3000" }
  ],
  "users": [
    {
      "slack_team_id": "T0123ABCD",
      "slack_user_id": "U_ALICE",                          // resolution key (stable)
      "slack_handle": "alice.martin",                  // diagnostics/logs only
      "pomegranate_user_id": "u_alice",                // identity → on_behalf_of when requester
      "pomegranate_workspace_id": "ws_alice",          // THIS user's canon (the graph queried)
      "mcp_token_env": "POMEGRANATE_WS_ALICE_TOKEN"    // token scoped to that workspace
    },
    { "slack_team_id": "T0123ABCD", "slack_user_id": "U_SAM", "slack_handle": "sam",
      "pomegranate_user_id": "u_sam", "pomegranate_workspace_id": "ws_sam",
      "mcp_token_env": "POMEGRANATE_WS_SAM_TOKEN" }
  ]
}
```

- A **subject** lookup uses the user entry's `pomegranate_workspace_id` +
  `mcp_token_env` → the canon to query. A **requester** lookup uses the same
  entries' `pomegranate_user_id` → the `on_behalf_of` claim. One `users` list
  serves both roles.
- **Tokens referenced by env var name, not inlined** — secrets stay out of the
  file. `config.ts` resolves each `mcp_token_env` → `process.env[...]` at load
  and fails fast if a referenced var is missing.
- Resolution is by `slack_user_id` (stable; handles can change).
- zod schema rejects unknown teams, duplicate slack_user_ids, and missing token
  env vars at boot.
- **Implication:** a person can only be a *subject* (reviewed against) if they
  have a mapped workspace + token. Being only a *requester* needs just the
  `pomegranate_user_id` (and in v0 even that is optional — reads are public).

### 4.1 Resolution functions (`src/resolve.ts`)

The same `users` map resolves **both** roles — the *subject* (whose canon) and
the *requester* (who is asking). No schema additions are needed for future
requirement #3; the requester is just the other end of the lookup.

```ts
resolveTeam(teamId): TeamCfg                            // throws TeamNotMapped (api_url)
resolveCanon(teamId, subjectUserId): CanonHandle        // {workspaceId, subjectUserId, token}
                                                        //   from the subject's user entry;
                                                        //   throws SubjectNotMapped | TeamNotMapped
resolveRequester(teamId, requesterUserId): RequesterRef // never throws in v0; null if unmapped
```

`resolveRequester` returning `null` is tolerated in v0 (reads are public). A
future gated mode flips this to "require non-null" without touching the config
shape — only the policy that consumes it.

---

## 5. App-side additions (small, optional-but-recommended)

To (a) record `caller='slack'` and (b) accept file bytes through the
token-authed path with single-sourced extraction, add two MCP-token endpoints in
`app/server/src/phase1/mcp/server.ts`, mirroring the existing tools but
multipart and reusing `extract()` (`phase1/ingest/extract.ts`) +
`synth.feedback`/`synth.query` + the same integrity gates already in that file:

```
POST /mcp/tools/review_deliverable_file   (multipart: file, kind?)  → { id, findings }
POST /mcp/tools/query_context_file        (multipart: file)         → { answer, cited_node_ids, has_answer }
```

Also thread a `caller` through `insertReview` for the text tool, or default the
file tool's review to `caller='slack'` when the call originates from the Slack
token. (The `reviews.caller` CHECK already permits `'slack'` —
`phase1/db/schema.ts` — so no migration.)

**Add an optional `on_behalf_of` field** to all four tools (the two existing
text tools and the two new file tools). It is a validated, optional string (the
requester's Pomegranate user id). v0 **does not filter on it** — at most it is
recorded on the audit row. This is the single forward hook for future
requirement #3: per-requester document gating becomes an app-side filter keyed
on `on_behalf_of`, with no change to the wire contract and no surface
re-release. Cost today: one optional zod field per tool. (See DESIGN §6.4.)

**If we skip these:** the bot extracts text itself (add `mammoth` + `pdf-parse`
to the surface) and uses the existing text tools; reviews persist as
`caller='mcp'`. This ships zero app changes at the cost of duplicated
extraction. Default plan: **add the two endpoints** (cleaner, single-sourced).

---

## 6. Module responsibilities

### `parse.ts`
- Input: raw `event.text` (Slack mrkdwn, mentions as `<@U…>`).
- Strip the bot's own mention. Lowercase-match leading verb (`review` |
  `getcontext`, tolerating `get context` / `getcontext about`).
- Extract the single subject mention after `from`. Return
  `{ verb, subjectUserId, remainder }`. Reject (→ usage hint) on no verb / no
  subject / >1 subject.
- Pure function, fully unit-tested. No I/O.

### `payload.ts`
- Precedence (SPEC §5.2): files → links → inline text.
- Files: read `event.files[]`, check type against supported exts
  (pdf/docx/txt/md) and size cap; download bytes via Slack
  `files.info`/`url_private` with the bot token.
- Links: detect a URL or Slack file link in `remainder`; v0 fetch public URLs
  + Slack files only.
- Inline: the cleaned `remainder` text.
- Returns a discriminated union `{kind:'text',text} | {kind:'file',bytes,name}`
  or `null`.

### `command.ts` — verb model + dispatch (`[shared]`)
- Defines the `Verb` set and a **dispatch map** `Verb → handler`, not a
  hardcoded two-branch `if`. v0 registers `review` and `getcontext`; future
  requirement #2 (add-document) registers one more entry — additive, no surgery.
- Holds the surface-agnostic `Command` type that `parse.ts` produces.

### `handlers.ts` — `onAppMention(event)` (`[slack]`)
Orchestration, the only stateful-feeling part (but still no persistence):
1. `dedupe(event)` — drop Slack retries (`X-Slack-Retry-Num` / event id set with TTL).
2. `parseMention` → `Command` (verb + subject + remainder), or usage hint.
3. `resolveCanon(teamId, subjectUserId)` (or mapped-error reply) **and**
   `resolveRequester(teamId, event.user)` → `RequesterRef` (null tolerated in v0).
4. React `:eyes:` (ack).
5. `resolvePayload` → text or file (or usage hint / unsupported reply).
6. Dispatch via the `command.ts` map, passing `(canon, requester, payload)`:
   `review` → `client.review[File]`; `getcontext` → `client.getContext[File]`.
7. `format.*` → mrkdwn; post thread reply. On query `has_answer=false`, post the
   "nothing relevant" message.
8. Catch-all → generic failure reply + `log.error`.

### `format.ts`
- `formatFindings(findings)`: group by flag in order red → yellow → green; per
  finding render `:red_circle: *positioning* — <summary>` with the quoted span
  and, if `node_id`/`source_link`, a citation line. Cap length; summarize counts
  if long ("+6 more green").
- `formatAnswer(query)`: post `answer` as the body; append a compact "Sources: N
  nodes" line from `cited_node_ids`.
- Slack mrkdwn (not full markdown): `*bold*`, `_italic_`, ``code``.

### `errors.ts`
Typed errors each carry a `userMessage` (the clean Slack text from SPEC §7):
`WorkspaceNotMapped`, `SubjectNotMapped`, `EmptyPayload`, `UnsupportedFile`,
`FileTooLarge`, `NoTextExtracted`, `UpstreamError`. Handlers map error → reply
without leaking internals.

---

## 7. Slack app configuration

- **Scopes (bot token):** `app_mentions:read`, `chat:write`, `chat:write.customize`, `files:read`,
  `reactions:write`, `users:read`, `channels:history` (DM/threads as needed).
- **Event subscriptions:** `app_mention`. (No need for broad `message.*` — the
  bot only acts when mentioned.)
- **Dev:** Socket Mode (`SLACK_APP_TOKEN` xapp-…), no public URL.
- **Prod:** HTTP Events API endpoint (Bolt's `/slack/events`), Slack signature
  verification (Bolt built-in via `SLACK_SIGNING_SECRET`).

`.env.example`:
```
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=…
SLACK_APP_TOKEN=xapp-…        # socket mode (dev)
POMEGRANATE_API_URL=http://localhost:3000
POMEGRANATE_WS_T0123ABCD_TOKEN=<mcp bearer token>
SLACK_MODE=socket|http
```

---

## 8. Testing plan

Mirror the app's discipline (build → test → verify per `app/plan.md`).

| Layer | Tests |
|---|---|
| **parse** | verbs (case, `get context`), subject extraction, missing/duplicate subject, bot-mention stripping, payload region. |
| **resolve** | mapped team/user, unmapped team, unmapped subject, missing token env (fail fast). |
| **payload** | precedence (file>link>text), unsupported ext, oversize, empty, Slack-file vs URL detection. |
| **format** | findings grouped/ordered by flag, citation rendering, truncation; query answer + sources; `has_answer=false` message. |
| **handlers (integration)** | both happy paths against a **stubbed** `PomegranateClient`; assert the right client method + args, the ack reaction, and the posted reply. Reuse the app's stub philosophy (`__test_utils__/synth-stub.ts`). |
| **errors** | each typed error → correct `userMessage`, **no** upstream call past the failure point. |

**Contract test (already written + run): `test/contract.mjs`.** Drives the real
`app/server` MCP endpoints `client.ts` will call — provisions a throwaway canon,
seeds a graph, mints a token, then asserts the `review_deliverable` and
`query_context` response shapes + integrity behavior. This is the fidelity check
that stubs can't give. It spends a few cents of Anthropic tokens, so it runs on
demand (manual / pre-release), not in CI. **First run 2026-06-03: 17/17 PASS** —
which is also the validation that GetContext's reuse of `query_context`
(decision #2) is sound: a document stuffed into the `question` slot returned
grounded extracts citing only real nodes, and an off-topic payload correctly
returned `has_answer=false` (no fabrication, anti-injection guard intact).

---

## 9. Observability

- Structured logs (mirror `app/server/src/lib/log.ts`): one line per command
  with `team_id`, `verb`, `subject_user_id`, `payload_kind`, `latency_ms`,
  `outcome` (ok | mapped_error | upstream_error). **Never** log payload text,
  tokens, or file contents.
- The app side already logs the egress: `mcp_token_used` + per-tool audit rows
  in `customer_audit_log`. The Slack surface adds no audit store of its own.

---

## 10. Milestones

1. **M0 — scaffold.** `package.json`, `tsconfig.json`, Bolt app boots in Socket
   Mode, replies "pong" to a mention. Config loader + zod schema + resolvers
   with tests.
2. **M1 — review, text payload.** `parse` + `client.review` (existing
   `review_deliverable`) + `format.findings`. Happy path + error replies. Tests.
3. **M2 — GetContext, text payload.** `client.getContext` (`query_context` with
   derived question) + `format.answer` + `has_answer=false`. Tests.
4. **M3 — file & link payloads.** `payload.ts` downloads/links; add the two
   app-side file endpoints (§5) for single-sourced extraction + `caller='slack'`.
5. **M4 — hardening.** Retry dedup, length truncation, usage hints, generic
   failure path, structured logs. Manual `verify` against a live `app/server`.
6. **M5 (v1 backlog, not this project).** Block Kit buttons (incl. "mark finding
   wrong" → existing `reviews/:id/findings/:index/wrong`), consent gating,
   per-user throttle, Home tab.

---

## 11. Definition of done (engineering)

- `npm install && npm run build && npm test` green in `surfaces/slack`.
- With `app/server` running and a `mapping.json` + tokens in env, both commands
  work end-to-end against a real Slack workspace (or the Bolt local test client)
  for text, file, and link payloads.
- Every SPEC §7 error path produces a clean reply; no stack trace ever reaches
  Slack.
- No synthesis or graph logic lives in this surface — only adaptation. Reviews
  appear in the app with `caller='slack'` (M3+).

---

## 12. Forward-compatibility seams (not built in v0)

These three future requirements are **out of scope for this project** and **not
in the spec**. Listed here is only the cheap discipline v0 follows so each lands
as a contained change. Each seam is chosen to survive the requirement itself
changing shape.

| Future requirement | Seam paid for in v0 (cost) | What it buys |
|---|---|---|
| **#1 More surfaces** (Claude, ChatGPT) | `[shared]`-tagged modules carry **zero Slack imports** (`client.ts`, `config.ts`, `resolve.ts`, `command.ts`, `errors.ts`). No `surfaces/shared` folder yet. *(cost: an import-discipline rule)* | Extraction to `surfaces/shared` is a `git mv` + import-path change, not a rewrite. A second surface ships its own `[slack]`-equivalent layer and reuses the rest. |
| **#2 Write path** (add docs to a graph) | Verb **dispatch map** instead of a 2-branch `if`; `PomegranateClient` is an interface with room for `addDocument()`. *(cost: ~0 — a map vs an if)* | Adding the verb + client method is additive. Note: writes need real per-requester authn — a new auth story, not a retrofit of the read token. |
| **#3 Per-requester gating** | Resolve the **requester** and pass it as `on_behalf_of` on every call; new app tools accept the field (optional, unused for filtering in v0). *(cost: one param + one optional zod field per tool)* | Gating becomes an app-side graph filter keyed on `on_behalf_of`. Zero surface change, and zero surface re-release even if the gating model later changes. |

What v0 deliberately does **not** do, to avoid building against guesses that may
move: no `surfaces/shared` package, no ACL model, no write endpoints, no
per-user OAuth, no requester-required enforcement. The surface's one permanent
obligation is to **say truthfully who is asking and whose canon is meant** —
everything else stays in the app.
