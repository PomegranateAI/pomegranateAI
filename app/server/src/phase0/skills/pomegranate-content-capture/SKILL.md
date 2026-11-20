---
name: pomegranate-content-capture
description: Capture a content-strategy work session — the content artifacts produced (LinkedIn posts, essays, taglines, page copy, podcast outlines, sales emails, decks) and the verbatim feedback the user gave on them (rewrites, rejections, banned phrases, tone corrections, approvals) — as a structured interaction record under .pomegranate/interactions/ for downstream graph capture. Run at the end of any content-drafting session, when the user signals they're done iterating on a piece, or when invoked as /pomegranate-content-capture.
allowed-tools:
  - Bash
  - Read
  - Write
---

# pomegranate-content-capture

You capture content-strategy work sessions into Pomegranate's interaction store. The next `pomegranate-ingest` run will read them and propose brand-voice, positioning, and decision candidates into `.pomegranate/backlog.md` for leader triage.

This skill writes interactions only. It does not modify the graph. Promotion to graph nodes is a separate, leader-curated action via `pomegranate-ingest`.

## When to run

- The user signals a content-drafting session is wrapping ("ship this", "save this", "ok that's it").
- The user explicitly invokes you (`/pomegranate-content-capture`).
- After any conversation that produced at least two iterations of a content artifact plus the user's reactions to them.
- Do not run on conversations that produced no real content artifacts — this is not a transcript backup.

## What counts as a content artifact

Any piece of customer-facing or category-creating copy you helped the user draft, edit, or iterate on:

- LinkedIn posts, X threads, founder commentary
- Newsletter essays, blog posts, long-form pieces
- Taglines, one-liners, page H1s/H2s
- Sales email drafts
- Deck/slide copy
- Press releases, analyst briefing copy
- Podcast outlines, talk abstracts

Internal docs (PRDs, strategy memos, planning notes) are out of scope here. Those flow through the strategy-doc path that `pomegranate-ingest` already covers.

## What counts as feedback

Any user message that corrects, approves, rejects, or redirects an artifact. Examples from real sessions:

- "Use he/him for the head of product." — audience / persona detail
- "Remove AI-tell wording — 'Not X, Y' patterns, 'That's not a X but Y' constructions." — style/voice rule
- "His calendar stopped agreeing with him is the wrong tone." — banned phrasing
- "Make the first few words stronger for LinkedIn feed preview." — channel modifier
- "Drop leverage / unlock / revolutionize." — banned vocabulary
- "Yes ship it." — approval (the accepted version becomes a positive example)

Approvals matter as much as corrections. Capture both.

## How to run

1. Scan the current conversation. Identify, in order:
   - The **topic** (one sentence): e.g., "LinkedIn launch post anchoring the content-strategy thesis."
   - The **artifacts** produced: each distinct draft of each piece. Use the *verbatim* text — do not summarize. Label them (`v1`, `v2`, `final`) so feedback can target a specific version.
   - The **feedback** the user gave: each correction, rejection, approval, or stylistic note. Verbatim where the user's wording is the signal (banned phrases, tone notes, persona swaps). Tag `kind` only when you are certain; leave it undefined otherwise.
   - Any explicit **decisions** the user named in passing (e.g., "we're calling the newsletter Voice & Direction").

2. Build a JSON payload that conforms to the `ContentSession` schema:

   ```json
   {
     "kind": "content-strategy-session",
     "schema_version": 1,
     "captured_at": "<ISO timestamp>",
     "topic": "<one sentence>",
     "artifacts": [
       { "surface": "linkedin-post", "label": "v1", "text": "<verbatim>" },
       { "surface": "linkedin-post", "label": "v2", "text": "<verbatim>" }
     ],
     "feedback": [
       { "on": "v2", "kind": "style", "note": "<verbatim user note>" }
     ],
     "decisions": [
       { "summary": "<short>" }
     ]
   }
   ```

3. Write the payload to a tmp file with the `Write` tool, then invoke the CLI:

   ```bash
   POMEGRANATE_DATA_DIR=.pomegranate \
     node /path/to/pomegranate/app/server/dist/phase0/bin/capture-session.js \
       --payload-file /tmp/pom-capture-<timestamp>.json
   ```

   Or, if the build directory is not present, run via `npx tsx` against `app/server/src/phase0/bin/capture-session.ts` from the `app/server` directory.

4. Report to the user with one short message — count of artifacts + feedback, the interaction filename, and a pointer to the next step:

   > Captured N artifact(s), M feedback note(s) → .pomegranate/interactions/<id>.json.
   > Run /pomegranate-ingest to propose backlog candidates.

5. Do not run `pomegranate-ingest` automatically. Promotion to graph candidates is a separate, leader-curated action.

## Constraints

- **Verbatim only.** Do not paraphrase artifacts or feedback. The downstream capture LLM relies on exact source quotes for canonicalization and dedup.
- **No interpretation.** Do not tag a feedback note with a `kind` you are guessing. Leave `kind` undefined when uncertain.
- **No new graph nodes.** This skill writes interactions only. Ingest writes backlog candidates. The user manually promotes them to graph nodes.
- **No retroactive surveillance.** Do not scan unrelated transcripts to backfill. Capture only the current session you participated in.
- **Skip empty sessions.** A conversation with no real iteration is not a content session. Capture only when there are at least 2 artifacts, or at least 1 artifact plus 2 distinct feedback notes.
- **Tmp-file hygiene.** Write the payload to `/tmp/pom-capture-<timestamp>.json` and let the OS reap it. Do not leave the payload in the repo.

## Output to user

One short message: count of artifacts + feedback, the resulting interaction filename, and `/pomegranate-ingest` as the next step. No interpretation, no editorial commentary on the captured content.
