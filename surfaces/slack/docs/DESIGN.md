# Pomegranate Slack Bot — Design Doc

**Status:** Draft v0 · **Companion to:** SPEC.md, ENGINEERING.md
**Last updated:** 2026-06-02

---

## 1. Context

The Pomegranate app (`app/server`) already exposes the two capabilities this
surface needs, behind a clean `SynthesisProvider` interface
(`app/server/src/lib/synthesis.ts`):

- **feedback** → `Finding[]` (categorized, flagged, cited) — what "review" means.
- **query** → `{ answer, cited_node_ids, has_answer }` — what "GetContext" means.

Both are reachable over HTTP today:
- Session-authed REST: `POST /workspaces/:ws/reviews`, `POST /workspaces/:ws/query`.
- MCP-token-authed: `POST /mcp/tools/review_deliverable`,
  `POST /mcp/tools/query_context` (see `phase1/mcp/server.ts`).

Both already enforce the integrity gates Pomegranate cares about (drop reds
without citations; drop cited ids not in the graph; never fabricate on empty).

The Slack surface is therefore **a thin, stateless adapter**: Slack event →
parse → resolve subject → resolve payload to text → call the Pomegranate API →
format the response back into Slack. It deliberately owns **no synthesis logic
and no graph storage**.

```
┌──────────┐  event   ┌───────────────────────┐  HTTP   ┌────────────────┐
│  Slack   │ ───────► │  surfaces/slack (this) │ ──────► │   app/server   │
│ workspace│ ◄─────── │  parse · resolve · fmt │ ◄────── │  (synthesis,   │
└──────────┘  reply   └───────────────────────┘  JSON   │   graph, gates)│
                                                          └───────┬────────┘
                                                                  │ Anthropic API
                                                                  ▼
                                                          ┌────────────────┐
                                                          │  claude-* model│
                                                          └────────────────┘
```

---

## 2. Architecture

### 2.1 Components

| Component | Responsibility |
|---|---|
| **Event receiver** | Receives Slack events (`app_mention`, message events, file-shared) via Bolt. Verifies Slack signatures. Acks Slack within 3s, processes async. |
| **Command parser** | Normalizes the message (strips bot mention), matches the verb (`review` / `getcontext`), extracts the subject mention and the raw payload region. |
| **Config / resolver** | Loads the static mapping file. Resolves Slack team id → Pomegranate workspace; resolves subject Slack user id → Pomegranate user → subject graph (workspace). |
| **Payload resolver** | Turns the message into plain text: downloads & extracts files, fetches linked docs, or takes inline text. |
| **Pomegranate client** | Typed HTTP client over `app/server`. Two methods: `review()` and `getContext()`. Carries the workspace service credential. |
| **Responder / formatter** | Renders `Finding[]` and query answers into Slack-friendly text (mrkdwn), posts the ack and the final reply in-thread. |

### 2.2 Why an adapter, not a fork

The single most important design rule here: **do not reimplement review.** The
brief says review should "use the API for review in the folder
`~/dev/pomegranate/app`." We honor that literally — `review` calls the same
feedback synthesis and the same integrity gate the web UI and MCP use, so a
finding produced in Slack is byte-identical in meaning to one produced in the
app. Any drift between surfaces is a bug.

---

## 3. The subject → graph resolution

This is the one genuine modeling decision, because the brief and the data model
disagree in vocabulary:

- **Brief:** "using the documents/graph of the user alice.martin."
- **Model:** the graph is **workspace-scoped**. `graph_nodes` is keyed by
  `(workspace_id, id)`; there is no per-user graph
  (`app/server/src/phase1/db/schema.ts`).

**v0 resolution (decided).** The config maps **each Slack user to their own
Pomegranate workspace** — that user's canon. `@alice.martin` →
`ws_alice`; `@sam` → `ws_sam`. So a subject mention resolves to *that
subject's* workspace graph, and `review … from @alice` and
`review … from @sam` return genuinely different results. This sidesteps the
"graph is workspace-scoped but the feature is per-person" tension by making the
unit of mapping the **person→workspace** pair: in Pomegranate today, one
person's canon *is* one workspace. The MCP token is per-workspace, so it lives
on each user's config entry alongside their workspace id (DESIGN §4 / ENG §4).

A subject is only reviewable if they have a mapped canon (workspace + token);
an unmapped subject is refused before any synthesis call.

**Forward compatibility.** If Pomegranate later introduces per-user or
per-subject sub-graphs, only the resolver changes: it would resolve
subject → `{ workspace_id, subject_filter }` and pass a scope/filter to the
client. The config schema already carries the Pomegranate user id per subject,
so no Slack-side migration is needed. We keep the resolver returning an opaque
"canon handle" so callers never assume "handle == workspace."

**We also resolve the *requester*** (the person who typed the command), using
the same Slack-user→Pomegranate-user map. In v0 the requester identity is not
used for access control — canons read unfiltered (the project assumption). We
resolve and thread it through anyway because **future requirement #3** (a
subject's documents become gated per requester) needs the requester's identity
to reach the app. Resolving it now is near-zero cost (same map, one extra
lookup) and means the gating change later is entirely app-side — the surface
already supplies "who is asking." If the requester's Slack id isn't in the map,
v0 still proceeds (reads are public); a future gated mode would refuse.

```
resolveCanon(slackTeamId, subjectSlackUserId)
  → { workspaceId, subjectPomegranateUserId, token }   // the "canon handle"
  // workspaceId + token both come from the SUBJECT's own config entry
  → throws SubjectNotMapped | TeamNotMapped

resolveRequester(slackTeamId, requesterSlackUserId)
  → { pomegranateUserId | null }                  // "who is asking" — for future authz
  // v0: null is tolerated; a future gated mode may require non-null
```

---

## 4. Authentication & the "no auth to read" assumption

The brief states reads need no authentication — the canon is public within the
boundary. But `app/server`'s read endpoints are all authed (session or MCP
token). We reconcile this **without weakening the app's auth model** and without
inventing a public, unauthenticated graph endpoint:

**Decision: the bot holds one workspace-scoped MCP token per mapped Pomegranate
workspace, stored in the config.** The bot authenticates *as the surface*, not
as the requester. This:
- satisfies "the requester needs no auth" (the human never logs in);
- keeps the app's existing token model intact (MCP tokens are already
  workspace-scoped and audited — every call logs an `mcp_token_used`
  customer-audit event in `phase1/mcp/server.ts`);
- gives the workspace admin a revocation handle (delete the token → bot dark).

The MCP HTTP transport is the natural fit because `review_deliverable` and
`query_context` are exactly our two operations, already bearer-authed, already
integrity-gated, already audited. **The Slack bot is just another MCP client.**

> Alternative considered: add `GET/POST` "public canon" endpoints with no auth.
> Rejected — it creates a second, unaudited read path into customer data and
> contradicts the app's "every egress is logged" posture
> (`customer_audit_log`). A scoped, revocable token gives the same UX with an
> audit trail.

### 4.1 Authn vs authz — keeping the door open for per-requester gating

Two distinct questions hide inside "auth," and separating them now is what makes
**future requirement #3** cheap:

- **Authn (is this caller allowed to call at all?)** — answered by the
  workspace MCP token. The *surface* is the authenticated principal. This does
  not change when gating arrives.
- **Authz (which of the subject's documents may *this requester* see?)** —
  answered, in v0, by "all of them" (canons are public per the assumption). In
  the future, by a per-requester filter applied **inside the app** over the
  subject's graph.

The seam: the bot passes the resolved requester identity as an explicit
**on-behalf-of claim** on every call (an `on_behalf_of` field / header). v0 app
ignores it for filtering (logs it at most); a future app filters the returned
graph/findings by it before synthesis. Crucially, **the gating logic lives in
the app, never in the surface** — every surface (Slack, Claude, ChatGPT) stays
dumb about document ACLs and just forwards "who is asking." When the future
requirement itself changes shape (different ACL model), only the app moves; the
surfaces keep sending the same claim.

Note the one place the token model *will* have to grow: a **write path**
(future requirement #2) cannot ride a shared surface token — writing to a
subject's graph on someone's behalf needs that person's real authenticated
identity, not a service credential. So writes are explicitly out of the
"reads are public" assumption and will require per-requester authn. The read
adapter is built so that adding a write path is additive, not a rewrite (see
§11).

---

## 5. Data flow

### 5.1 `review` (sequence)

```
Requester: "@pomegranate review from @alice.martin" [+ launch.docx]
  │
  ├─ Slack → app_mention event → Event receiver (verify sig, ack <3s)
  ├─ Parser: verb=review, subject=<@U_ALICE>, payload=file(launch.docx)
  ├─ Resolver: team T → ws_ABC ; <@U_ALICE> → pg_user_alice ✓
  ├─ Payload resolver: download launch.docx → extract text (server-side)
  ├─ Bot reaction :eyes: on the message (ack)
  ├─ Client.review(ws_ABC, text, kind?) 
  │     → POST /mcp/tools/review_deliverable  (Bearer <ws token>)
  │     → synth.feedback(graph, deliverable) → Finding[]
  │     → integrity gate (drop uncited reds) → persist review caller='slack'
  ├─ Formatter: group findings by flag, render mrkdwn
  └─ Responder: thread reply with findings + citations
```

### 5.2 `GetContext` (sequence)

```
Requester: "@pomegranate GetContext about <text/file> from @alice.martin"
  │
  ├─ … (receive, parse, resolve subject identical to review) …
  ├─ Payload resolver → text P
  ├─ Client.getContext(ws_ABC, P)
  │     → build question = "Which parts of this canon are relevant to the
  │        following material, and what do they say?\n\n<P>"
  │     → POST /mcp/tools/query_context  (Bearer <ws token>)
  │     → synth.query(graph, scope='all', question) → {answer, cited, has_answer}
  │     → anti-hallucination gate (drop cited ids not in graph)
  ├─ if has_answer=false → "nothing relevant" reply
  └─ else thread reply with answer (extracts) + cited nodes
```

### 5.3 Payload resolution

`extract()` in `app/server/src/phase1/ingest/extract.ts` already turns
pdf/docx/txt/md into text (via `mammoth`, `pdf-parse`). Two options:

- **A. Server-side extraction (chosen).** The bot streams the file bytes to a
  Pomegranate endpoint that extracts and runs synthesis in one call. Keeps file
  parsing dependencies (`mammoth`, `pdf-parse`) out of the Slack surface and
  reuses the tested extractor.
- **B. Client-side extraction.** Bot extracts text itself, posts text to the
  existing `review_deliverable`/`query_context`. Simpler transport but
  duplicates extraction libs and logic.

We choose **A for files** (a small new endpoint, see ENGINEERING.md §"App-side
changes") and use the existing text-in tools for inline/linked text. For inline
text and already-text links, no extraction is needed → existing MCP tools
unchanged.

---

## 6. App-side changes required

Minimal. The app already supports everything except file-bytes-in over the
MCP/token path:

1. **`reviews.caller` already includes `'slack'`** — no migration. ✓
2. **`query_context` / `review_deliverable`** accept text today — reused as-is
   for inline/linked-text payloads. ✓
3. **New (small): token-authed "review/getcontext from file" endpoints** that
   accept `multipart/form-data`, run the existing `extract()`, then the existing
   `feedback`/`query` synthesis + gates. This mirrors the session-authed
   `POST /workspaces/:ws/ingest/file` but for the review/query operations and
   under MCP-token auth. (Alternatively, keep extraction in the bot — see §5.3
   option B — and ship zero app changes. Recommended path: the small endpoints,
   to keep extraction single-sourced.)
4. **Accept an optional `on_behalf_of` field** (the requester's Pomegranate
   user id) on the review/query tools — both the existing text tools and the
   new file tools. v0 **ignores it for filtering** (it may log it). This costs
   one optional, validated field today and makes future requirement #3
   (per-requester document gating) a self-contained app-side change: the
   filter reads `on_behalf_of`, the wire shape never moves, and no surface has
   to be re-released. Because it's optional and unused in v0, it is safe even
   if the eventual gating model differs from today's guess.

No graph, schema, or synthesis changes. No new auth mechanism. The
`on_behalf_of` field is additive and optional.

---

## 7. Failure modes & handling

| Failure | Detection | Handling |
|---|---|---|
| Bad Slack signature | Bolt signature check | Drop; 401. Never process. |
| Duplicate event delivery (Slack retries) | `X-Slack-Retry-Num` header / event id dedup | Idempotency: ack and no-op on repeats. |
| Subject/workspace unmapped | Resolver throws | Clean Slack reply (SPEC §7); **no** API call. |
| Payload empty | Payload resolver returns null | Usage hint. |
| File too large / unsupported | Size + extension check (mirror app limits) | Clean reply with caps/types. |
| Pomegranate API 5xx / timeout | Client error | "Something went wrong reaching Pomegranate." Log full error server-side. |
| Synthesis returns `has_answer=false` | Field on query result | "Nothing relevant" — not an error. |
| Anthropic slow (P95 ~20–45s) | n/a | Ack-first pattern absorbs it; final reply when done. |

Everything is **stateless** between events — the bot keeps no DB. If it crashes
mid-request, the requester re-sends. (Slack's own retry may also re-deliver;
dedup prevents double-posting.)

---

## 8. Security & privacy

- **Egress is audited.** Because the bot uses MCP tokens, every review/query is
  logged in `customer_audit_log` (`mcp_token_used`, plus per-tool audit rows).
  A workspace admin sees Slack-originated reads in the same export as MCP reads.
- **Token storage.** The per-workspace MCP token lives in the config file
  (gitignored) or, preferably, an env-referenced secret. Never logged, never
  echoed to Slack.
- **No raw errors to Slack.** Stack traces and API bodies stay in server logs.
- **Blast radius of the assumption.** "Reads need no auth" means any workspace
  member can query any mapped subject. We accept this for v0 (SPEC §8) and flag
  consent-gating as v1 (Risks).
- **Requester payloads** flow to Anthropic via the existing synthesis path — no
  new data path, no new processor.

---

## 9. Alternatives considered

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Reuse synthesis vs reimplement | Reuse via app API | Local review logic | Single source of truth; brief says "use the API." |
| Transport into app | MCP HTTP (bearer token) | New public unauthed endpoints | Keeps auth model + audit trail intact. |
| File extraction site | App-side (reuse `extract()`) | Bot-side libs | Single-sourced parsing; tested extractor. |
| GetContext implementation | Reuse `query_context` with a derived question | New "getcontext" synthesis prompt | `query` already does grounded retrieval-with-citations; a new prompt is unneeded surface area for v0. **Validated by `test/contract.mjs` (2026-06-03): doc-as-question returns grounded extracts; off-topic → `has_answer=false`.** |
| Bot framework | Slack Bolt (JS) | Raw Events API + custom HTTP | Bolt handles signatures, retries, socket mode; matches the app's TS/Node stack. |
| State | Stateless adapter | Local DB of requests | Nothing here needs persistence; the app owns all durable state. |

---

## 10. Risks & v1 backlog

1. **Consent / per-requester gating of canons** (future req #3) — v0 lets
   anyone query anyone mapped. The seam is built (§4.1, requester threaded as
   `on_behalf_of`); the gating itself is a future app-side filter. See §11.
2. **Per-user graphs** — if Pomegranate adds them, the resolver gains a subject
   filter; config already carries the user id. Low-cost change, isolated to the
   resolver + client.
3. **Link fetching breadth** — Google Docs / Notion / authed links need their
   own OAuth; deferred. v0 supports Slack files + public URLs.
4. **Block Kit UX** — buttons ("mark finding wrong", "open in app"), a Home tab,
   shortcuts. The app already has a `findings/:index/wrong` endpoint to wire a
   button to later.
5. **Rate limiting / cost** — a noisy channel could fan out many reviews
   (cost target: <$1/review). v1: per-user throttle + cost ceiling.

---

## 11. Forward-compatibility (multi-surface, write path, per-requester gating)

These are **not** built in v0 and **not** in the spec. This section records the
seams we keep clean now so that each becomes a contained change later. Guiding
rule: *thread the right identities and keep the right boundaries now; build no
future machinery, and assume each requirement may still change shape.*

### 11.1 Multiple surfaces (Slack, Claude, ChatGPT) — code factoring

Three buckets, by what varies:

| Bucket | Holds | Examples |
|---|---|---|
| **`app/server`** | Everything touching the canon or the model. Never duplicated per surface. | synthesis, graph storage, integrity gates, the MCP tools + new file tools, **future** document-level gating. |
| **`surfaces/shared`** *(future — not created yet)* | Surface-agnostic adapter logic identical across surfaces. | the Pomegranate HTTP client, the config schema + resolvers, the abstract verb/command model, the "derive a query question from a payload" helper, typed error kinds. |
| **`surfaces/slack`** *(this dir)* | Everything tied to Slack as a medium. | Bolt wiring + signature verification, mention/mrkdwn parsing, Slack file download & link fetch, mrkdwn formatting. |

**We do not create `surfaces/shared` now.** With exactly one surface, extracting
it would be premature abstraction against an unknown second consumer. Instead we
pay a near-zero discipline cost: the shared-*candidate* modules
(`client.ts`, `config.ts`, `resolve.ts`, the verb model, `errors.ts`) are
written with **zero Slack imports**, so lifting them to `surfaces/shared` when
the Claude/ChatGPT surface lands is a `git mv` + import-path change, not a
rewrite. The boundary is enforced by that no-import rule, not by a folder that
doesn't earn its keep yet. (ENGINEERING.md §2 annotates which modules are which.)

When the second surface arrives, the resolver and config generalize from
"Slack team / Slack user" to "surface id / surface principal" — the mapping file
already has the right *shape* (a surface keyed to a Pomegranate workspace, with
a per-principal user map); only the key names broaden.

### 11.2 Write path — adding documents to a graph from a surface (future req #2)

The app already owns the write pipeline (`/workspaces/:ws/ingest/file`, capture
synthesis, candidates). What v0 must avoid is foreclosing it:

- **Verb dispatch is open.** Handlers route on a verb *map*, not a hardcoded
  two-branch `if`. Adding `add`/`remember` later is a new entry, not surgery.
- **The client is an interface**, free to grow `addDocument()` alongside
  `review()`/`getContext()`.
- **We stop calling the surface "read-only forever."** v0 has no write path; the
  architecture does not preclude one.
- **Writes need real per-requester authn** (§4.1) — the shared service token is
  fine for public reads but not for mutating someone's graph. So a write path is
  a new auth story (per-user OAuth / token), additively, not a retrofit of the
  read path.

### 11.3 Per-requester document gating (future req #3)

Built seam, restated in one place:
- Requester identity is **resolved and threaded** on every call today (§3, §4.1).
- It rides as an optional **`on_behalf_of`** claim the app accepts now and
  ignores for filtering in v0 (§6.4).
- The eventual filter — "which of the subject's documents may this requester
  see" — lives **in the app**, over the subject's graph, before synthesis.
- Therefore: zero surface change when gating ships, and zero re-release of any
  surface when the gating *model* later changes. The surface's only obligation,
  fixed forever, is "say truthfully who is asking."
