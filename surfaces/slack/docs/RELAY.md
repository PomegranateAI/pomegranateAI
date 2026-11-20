# Relay mode — the LLM surface agent

**Status:** Shipped (surface-unification overhaul) · **Supersedes** the regex
verb grammar described in SPEC.md/DESIGN.md §5 (kept as `legacy` mode for one
deploy cycle).

## What changed

The bot no longer parses verbs or holds per-user MCP tokens. Every mention/DM
is forwarded to the app server's **surface agent** — an LLM running the same
MCP tool catalog every other surface uses (`app/server/src/phase1/agent/
surface-agent.ts`) — and the reply is rendered back into the thread
(placeholder `_Thinking…_` → `chat.update`).

- **Identity** resolves SERVER-side: people link their Slack handle/member id
  in the web app (Setup → Your profile) and pick a **default folder** for
  Slack (Setup → Default folder). Unlinked users get a friendly pointer.
- **Authorization** is membership: "review this against Alice's folder"
  works only if the requester is a member of that folder (403 + request-access
  hint otherwise). Attribution is the REQUESTER, not a subject token.
- **Mutations are confirm-first**: the server intercepts the first call to any
  mutating tool, the agent states what will happen and asks; an explicit yes
  in the next message executes it.

## What stays on the surface

- `listen` / `stop listening` / `listening` (deterministic mini-grammar in
  `relay.ts`) + the interval scheduler — they need Slack channel-history APIs.
  The scheduler's ingest now goes through `/agent/surface/actions`.
- Approve/Reject buttons (`actions.ts`) → `/agent/surface/actions`
  (`approve_candidate` / `reject_candidate`); the click IS the confirmation.
- File download + `.txt`/`.md` extraction (Slack-authenticated URLs).
- Event dedup, DM drop-box heuristic (in a DM with an active subscription,
  only messages addressing the bot reach the agent).

## Wire calls

| Surface | Server endpoint | Auth |
|---|---|---|
| mention/DM | `POST /agent/surface/messages` | `X-Surface-Secret` |
| buttons + scheduler ingest | `POST /agent/surface/actions` | `X-Surface-Secret` |

`SURFACE_AGENT_SECRET` must be set to the same value on both the app server
and this surface. `mapping.json` shrinks to `teams` (team id → API base URL);
`users` entries and `POMEGRANATE_WS_*_TOKEN` env vars are legacy-only.

## Cutover checklist

1. Deploy the app server (schema migrates on boot). Set `SURFACE_AGENT_SECRET`
   in the app's env.
2. Link each Slack user to their account (Setup → Profile in the web app, or
   the identities API).
3. Set `SURFACE_AGENT_SECRET` in this surface's `.env` and restart the bot.
   Relay mode activates automatically when the secret is set.
4. Verify: mention the bot with a plain question; check `pending`-style asks,
   a confirm-first accept, and one button click.
5. Rollback: `SLACK_AGENT_MODE=legacy` (keeps working until the token keyring
   env vars are removed — leave them in place for one cycle).

New users onboard with **zero surface changes**: they link Slack + set a
default folder in the web app. `scripts/add-user.sh` is legacy-only.
