---
name: pomegranate-ingest
description: Build or refresh the Pomegranate strategy graph from strategy docs, prior captured Claude interactions, and any user-designated source files. Propose candidate Goal/Positioning/Decision updates into .pomegranate/backlog.md with red/yellow/green flags for leader triage. Run after meetings, after editing strategy docs, or whenever the graph might be stale.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# pomegranate-ingest

You build and maintain the Pomegranate strategy graph from existing strategy materials and ongoing Claude interactions.

## When to run

- The user explicitly invokes you ("refresh the graph", "any new candidates", "/pomegranate-ingest").
- After strategy docs have been edited.
- On a periodic schedule via `/loop` or a cron.

## How to run

1. Identify the source scope:
   - Default: the current working directory's strategy docs (typically `strategy/`).
   - Plus `.pomegranate/interactions/` — relevant Claude interactions captured by `pomegranate-review`.
   - Plus any files or directories the user explicitly names in their prompt.

2. Invoke the CLI:

   ```bash
   POMEGRANATE_DATA_DIR=.pomegranate \
     node /path/to/pomegranate/app/server/dist/phase0/bin/ingest.js <sources...> --verbose
   ```

   (Or run via `npx tsx` against `src/phase0/bin/ingest.ts` if the build directory is not present.)

3. Open `.pomegranate/backlog.md`. Summarize the new candidates by flag count:

   > Refreshed graph from N sources. M candidates: R red, Y yellow, G green.

4. Tell the user:
   - "Open `.pomegranate/backlog.md` to review. Reds are at the top — those are proposals that override active graph nodes. Edit, approve, or reject each by marking it in the file."

5. Do NOT auto-approve. Approval is a leader action.

## Constraints

- Do not modify `.pomegranate/graph/` directly. Only `pomegranate-ingest` writes to `backlog.md`; only the user (manually editing) promotes backlog entries into active graph nodes.
- Do not double-process: the CLI's state.json hashes track what's already been seen. Pass `--force` only when the user explicitly asks for a fresh re-scan.
- Source quotes in candidates must be verbatim from the source artifact.
- Never invent candidates the source does not support.
- A content-rich source that yields ZERO candidates is a pipeline failure to investigate (server-side: check the route log and the source type's `group_floor`; see pomegranate-profile-builder), never evidence the source was empty.

## Output to user

A short summary message + an explicit "open backlog.md" instruction. No interpretation, no recommendations — the leader curates.
