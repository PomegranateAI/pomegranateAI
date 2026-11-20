# Pomegranate Slack Bot — Product Spec

**Status:** Draft v0 · **Surface:** `surfaces/slack` · **Depends on:** `app/server` (Pomegranate API)

---

## 1. Summary

A Slack app named **Pomegranate** that lets anyone in a Slack workspace pull a
named teammate's *strategy canon* into a conversation — either to **review** a
piece of work against it, or to **get the relevant context** out of it.

A Pomegranate user (e.g. `@alice.martin`) has, in the Pomegranate app, a
graph of **goals, positioning, and decisions** synthesized from their strategy
docs and work sessions. Today that canon is reachable through the web app and
through MCP. This surface makes it reachable from the place teams actually
work: a Slack message.

Two commands, both addressed to the bot via `@pomegranate`:

```
review {doc | text | file}  @pomegranate from @alice.martin
GetContext about {doc | file | text}  @pomegranate from @alice.martin
```

- **review** — run the attached/linked/quoted material through Pomegranate's
  feedback synthesis against Alice's canon, and reply with categorized
  findings (red/yellow/green flags + citations).
- **GetContext** — extract the parts of Alice's canon that are *relevant to*
  the attached/linked/quoted material, and reply with those extracts + citations.

`@alice.martin` is the **subject**: the person whose canon you are querying.
The person typing is the **requester**.

---

## 2. Goals / Non-goals

### Goals
- Let a requester invoke `review` and `GetContext` against any mapped subject's
  canon from inside Slack, with one message.
- Reuse the existing Pomegranate synthesis (`feedback`, `query`) and integrity
  gates verbatim — no second, divergent "review" implementation.
- Accept three payload shapes: an **uploaded file**, **inline/quoted text**, and
  a **linked doc** (a URL or Slack file the bot can fetch).
- Return results in-thread, formatted for Slack, with flags and source
  attribution preserved.

### Non-goals (v0)
- No write path. The bot never ingests Slack content into a graph, never
  approves candidates, never mutates a canon. (Capture-from-Slack already
  exists separately in `app/server/src/phase1/slack/mock.ts` and is out of
  scope here.)
- No per-message authentication / OAuth-per-user. Per the project assumption,
  **reading a subject's canon does not require authentication** — the canon is
  treated as publicly readable within the mapped Slack↔Pomegranate boundary.
- No interactive UI (no Block Kit buttons, modals, home tab) beyond formatted
  message replies. Deferred to v1.
- No cross-team querying. The bot only reaches Pomegranate workspaces named in
  the config for the requesting Slack team; each subject resolves to their own
  mapped workspace (decision #1).

---

## 3. Assumptions (given, for this initial project)

These are stated by the project brief (refined by decision #1) and treated as
fixed for v0:

1. **A static config file connects the surface to Pomegranate.** It registers
   the Slack workspace (team) and its Pomegranate API URL.
2. **Each Slack user maps to their own Pomegranate workspace — that user's
   canon (decision #1).** `@alice.martin` → `ws_alice`,
   `@sam` → `ws_sam`. The subject mention therefore selects *whose* graph is
   queried, and different subjects return genuinely different results. This is
   the unit of mapping because, in Pomegranate today, one person's canon *is*
   one workspace (the graph is workspace-scoped — see
   `app/server/src/phase1/db/schema.ts`). The same config entry also carries the
   person's Pomegranate user id (used as the requester identity) and the
   MCP token for their workspace.
3. **Reading a canon requires no authentication** — the graph/context is
   considered publicly available. The bot reads it with a workspace-scoped
   service credential (the subject's MCP token), not per-requester auth.
4. A named subject is reviewable only if they have a mapped canon (workspace +
   token); an unmapped subject is refused before any synthesis call.

---

## 4. Users & stories

| Actor | Story |
|---|---|
| **Requester (IC / teammate)** | "I drafted a launch email. I want to check it against Alice's positioning before I send it — without leaving Slack or opening the Pomegranate web app." |
| **Requester** | "I'm writing a doc and I don't know Alice's stance on the enterprise roadmap. I drop my outline and ask GetContext, and the bot hands me the relevant decisions and positioning with sources." |
| **Subject (canon owner)** | "My strategy canon stays the single source of truth. When teammates check work against it in Slack, they get the same findings and citations they'd get in the app." |
| **Workspace admin** | "I install the app once, drop a config mapping our Slack workspace to our Pomegranate workspace and our people to their Pomegranate accounts, and it just works." |

---

## 5. Command grammar

The bot is invoked by **@-mentioning it** in a channel or DM. The message body,
after the mention is normalized out, must match one of two verbs.

### 5.1 Grammar (informal)

```
command   := review_cmd | getcontext_cmd | ingest_cmd | pending_cmd | listen_cmd
review_cmd     := "review"     payload "@pomegranate"? "from" subject
getcontext_cmd := "getcontext" "about"? payload "@pomegranate"? "from" subject
ingest_cmd     := "ingest"     payload ("from" subject)?   ; subject must be the requester
pending_cmd    := ("pending" | "candidates") ("from" subject)?  ; subject must be the requester
listen_cmd     := "listen" ("every" N unit)?               ; subscribe THIS channel, default 24h
                | ("stop"|"quit") "listening" | "unlisten" ; unsubscribe
                | "listening"                              ; list the requester's subscriptions

subject   := slack_user_mention            ; e.g. <@U0123ABCD> rendered as @alice.martin
payload    := file_attachment              ; one or more uploaded Slack files
            | linked_doc                    ; a URL or Slack file link in the text
            | inline_text                   ; the remaining message text / quoted block
```

Notes:
- Verb matching is **case-insensitive** (`review`, `Review`, `GetContext`,
  `getcontext` all match). When several verb keywords appear, the **earliest
  in the message wins** (so ingested text mentioning "review" still ingests).
- `@pomegranate` is the bot mention and may appear anywhere; it is stripped
  before parsing.
- `from @subject` is **required** for `review`/`getcontext`. For
  `ingest`/`pending` it is optional and, when present, must name the
  requester: those verbs write to / curate a graph and are
  **self-workspace-only**.
- The `{doc | text | file}` token in the brief is descriptive, not literal —
  the bot infers payload shape from what's attached/linked/written.
- `ingest` proposes graph changes as **pending candidates** — nothing enters
  the graph without approval. `pending` lists those candidates with
  Approve/Reject buttons (Block Kit, action_ids `cand_approve`/`cand_reject`);
  a click resolves the candidate via the clicker's own MCP token and rewrites
  the message (buttons → resolution line). Stale clicks are safe: the app
  returns 409 for an already-resolved candidate and the bot annotates instead
  of re-resolving.
- **DMs to the app**: Slack never fires `app_mention` inside IMs, so the bot
  also subscribes to `message.im` and treats EVERY human DM message as a
  command — the mention is optional there (`pending`, `ingest …`, `listen`
  all work bare). Bot/system messages are filtered (no reply loops). Saying
  `listen` in the app DM turns it into a private drop-box: subsequent
  non-command DM lines batch-ingest on the interval. Requires the Slack app's
  Event Subscriptions to include the `message.im` bot event.
- `listen` subscribes the channel it is said in: every interval (default 24h,
  min 5m, max 7d) the scheduler batches ALL new human messages (threads
  included; bot messages, joins, and bot commands excluded) since the last
  watermark into ONE transcript and ingests it (`source_kind=slack`) into the
  **requester's own** workspace — again only as pending candidates. The
  watermark starts at the `listen` command (no backfill), survives restarts
  (subscriptions persist in `data/subscriptions.json`), and never advances on
  a failed run (errors back off at min(interval, 1h)). The bot announces a
  run in-channel only when it proposed changes; quiet runs stay quiet.

### 5.2 Payload resolution precedence

When more than one payload shape is present, resolve in this order:
1. **Uploaded file(s)** — if the message has file attachments, use them.
2. **Linked doc** — else if the text contains a fetchable URL or Slack file link.
3. **Inline text** — else use the message text with verb/mentions stripped.

If, after stripping, no usable payload remains → reply with a usage hint
(§7.4).

### 5.3 Examples

```
@pomegranate review from @alice.martin
   ⤷ [launch-email.docx attached]

@pomegranate GetContext about our Q3 enterprise roadmap from @alice.martin
   ⤷ inline_text payload = "our Q3 enterprise roadmap"

review this from @alice.martin @pomegranate
   ⤷ [thread reply quoting a doc link]
```

---

## 6. Behavior

### 6.1 `review`

1. Resolve the subject Slack mention → Pomegranate user → Pomegranate workspace.
2. Resolve the payload to plain text (download + extract file, fetch link, or
   take inline text).
3. Call Pomegranate **feedback synthesis** against the subject's active graph
   (the same path as `POST /workspaces/:ws/reviews` /
   MCP `review_deliverable`).
4. Apply the existing integrity gate (drop any `red` finding without a valid
   node citation; drop any finding citing a non-existent node).
5. Reply in-thread with findings grouped by flag, each showing its category,
   the quoted span from the deliverable, the one-line summary, and a citation
   to the source node.

**Output shape (per finding, from `Finding` in `lib/schemas.ts`):**
`category` ∈ {decisions, goals_priorities, positioning, brand_voice,
context_recency}, `flag` ∈ {red, yellow, green}, `node_id`,
`quote_from_deliverable`, `summary`, `source_link?`.

### 6.2 `GetContext`

1. Resolve subject → workspace (same as review).
2. Resolve the payload to plain text.
3. Call Pomegranate **query synthesis** with a question derived from the
   payload — effectively *"Which parts of {subject}'s canon are relevant to the
   following material, and what do they say? <payload text>"* — against the
   subject's active graph (same path as `POST /workspaces/:ws/query` /
   MCP `query_context`).
4. Apply the existing anti-hallucination gate (drop cited ids not in the
   graph; honor `has_answer=false` → "I don't know").
5. Reply in-thread with the relevant extracts (the `answer`) and the cited
   nodes. If `has_answer=false`, reply that the canon has no relevant context.

### 6.3 Acknowledgement & latency

- The bot **acknowledges immediately** (an eyes reaction or a "working…"
  thread reply) on a valid command, because synthesis is multi-second.
  (Operational targets from `app/plan.md`: query P50 < 8s / P95 < 20s; review
  P50 < 20s / P95 < 45s.)
- The final result is posted as a thread reply when synthesis completes.

---

## 7. Error & edge cases

| Case | Behavior |
|---|---|
| **Subject not in config** | Reply: "I don't have `@person` mapped to a Pomegranate account." No synthesis call. |
| **Slack workspace not in config** | Reply: "This Slack workspace isn't connected to Pomegranate yet." |
| **No `from @subject`** | Usage hint (§7.4). |
| **Empty / unusable payload** | Usage hint. |
| **Unsupported file type** | Reply listing supported types (pdf, docx, txt, md — per `app/server/src/phase1/ingest/extract.ts`). |
| **File too large** | Reply with the size cap. |
| **File extraction yields no text** | Reply: "I couldn't read any text out of that file." |
| **GetContext, `has_answer=false`** | Reply: "Nothing in @subject's canon is relevant to that." (no fabrication) |
| **Synthesis/API failure** | Reply: "Something went wrong reaching Pomegranate — try again." Log the error; never echo raw stack traces into Slack. |
| **Unknown verb** | Usage hint. |

### 7.4 Usage hint (canonical)

```
I can do two things — mention me with one of:
  • review <attach a file, paste text, or link a doc> from @person
  • GetContext about <topic / paste text / attach a file> from @person
where @person is someone connected to Pomegranate.
```

---

## 8. Privacy & trust posture (v0)

- The bot **reads** canons; it never writes. There is no path from a Slack
  message into anyone's graph in this surface.
- Per assumption, canons are treated as publicly readable inside the mapped
  boundary, so **any** member of the Slack workspace may query **any** mapped
  subject. This is a deliberate v0 simplification; v1 may gate by subject
  consent. (Flagged in DESIGN.md §"Risks".)
- The requester's payload (the doc/text being reviewed) is sent to the
  Pomegranate API and on to the Anthropic API for synthesis, exactly as the
  web and MCP paths already do. It is persisted as a `review` row with
  `caller='slack'` when the verb is `review` (the `reviews.caller` enum already
  includes `'slack'`).
- The bot posts results **in-thread by default**, visible to the channel.
  Requesters who want privacy should DM the bot.

---

## 9. Acceptance criteria

The surface is shippable when, against a running `app/server` and a real (or
mock) Slack workspace mapped via config:

1. `@pomegranate review from @subject` with a `.docx`/`.pdf`/`.txt`/`.md`
   attachment returns categorized findings with flags and citations, and a
   `review` row with `caller='slack'` is persisted.
2. `@pomegranate GetContext about <text> from @subject` returns relevant
   extracts with citations, or a clean "no relevant context" when the canon has
   none.
3. Inline-text and linked-doc payloads both work for both verbs.
4. Every error case in §7 produces a clean, human Slack reply — never a crash,
   never a raw stack trace.
5. Unmapped subjects and unmapped workspaces are refused before any synthesis
   call (no wasted API spend, no cross-boundary leakage).
6. Integrity gates are preserved end-to-end: no `red` finding without a valid
   citation reaches Slack; no cited node id that isn't in the graph reaches
   Slack; `has_answer=false` never fabricates.
7. Unit tests cover the command parser, payload resolution, config resolution,
   and the Slack-formatting of findings/answers. Integration tests cover the
   two happy paths against a stubbed Pomegranate client.

---

## 10. Open questions

1. **~~Per-user canons.~~ RESOLVED (decision #1).** Each Slack user maps to
   their own Pomegranate workspace, so a subject's canon is that subject's
   workspace graph — distinct per person. See §3 and DESIGN.md §3.
2. **Linked-doc fetching.** Which link types must v0 support — public URLs,
   Slack-hosted files, Google Docs? v0 baseline: Slack files + plain public
   URLs; Google/Notion deferred.
3. **Consent model.** Should a subject be able to opt their canon out of Slack
   querying? Deferred to v1; noted as a risk.
