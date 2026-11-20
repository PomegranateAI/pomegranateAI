# Pomegranate WhatsApp surface

A WhatsApp bot with the same job as `surfaces/slack`: forward whatever a
person sends to the app's LLM surface agent (the same MCP tool catalog every
other surface uses — see `app/server/src/phase1/agent/surface-agent.ts`) and
send the reply back. No verb grammar — plain language in, plain language
out, exactly like the Slack relay.

It runs one WhatsApp number (one [WasenderAPI](https://wasenderapi.com)
session) for the whole org. There is no per-team routing and no mapping file
— unlike Slack, WhatsApp has no "workspace"/"team" concept to key off, so the
only thing this surface needs to know is where the Pomegranate API lives and
the shared relay secret.

## How identity resolves

Exactly the Slack pattern (`user_identities`, kind `'whatsapp'` instead of
`'slack'`), just keyed by phone number instead of a Slack user id:

1. A person messages the bot's WhatsApp number from their own phone.
2. This surface reads the sender's phone number off the webhook payload,
   normalizes it to digits-only, and calls
   `POST /agent/surface/messages` with `{ surface: 'whatsapp', phone, ... }`.
3. The **server** (not this surface) looks up `user_identities` for a row
   with `kind='whatsapp'` and that phone number. If nothing matches, the
   agent replies asking the person to open the web app → **Setup → Your
   profile** and link their WhatsApp number (`PUT /me/identities/whatsapp`,
   wired into the `ProfileCard`'s "WhatsApp number" field).
4. Once linked, the reply resolves to that user's default folder for the
   `whatsapp` surface (**Setup → Default folder**), falling back to their
   last-active folder, falling back to their only folder if they have
   exactly one.

Numbers are compared digits-only everywhere (`+1 415 555 0100`,
`14155550100@s.whatsapp.net`, and `(415) 555-0100` all resolve to the same
identity) — see `normalizePhoneDigits` here and its twin in
`app/server/src/phase1/db/repo.ts`.

## Audio and image readers

The relay downloads/decrypts media through Wasender and sends the bytes to
`POST /agent/surface/media`. Pomegranate resolves the sender, stores a private
original, and runs the same data-agent reader used by folder uploads. It returns
text and an asset ID; both accompany the conversational turn. Voice commands
remain commands. Filing content preserves the original's provenance on its nodes.

Configure transcription credentials on the **app server**, not this container.
Users can configure or disable their readers in Setup → Agents → WhatsApp media
readers. Audio and images default to enabled; provider availability is checked
when processing. The server supports OpenAI, Deepgram, and Munsit transcription;
image reading requires a vision-capable structured model.

Downloads are bounded to 25 MiB. The server validates signatures and metadata,
limits audio to one hour and images to 40 megapixels / 16,000 pixels per side.
Failures return a retry message. Successful extraction and completed surface
responses are persisted server-side to avoid repeating work on redelivery.
Unfiled originals expire after seven days; filed originals follow document
retention. Original-file sharing is separate from node sharing.

Audio transcription and image reading are configured on the app server (see the media and speech-to-text variables in `.env.example` at the repo root).

## Groups

A group message only reaches the agent when it explicitly names the bot —
`/@?\bpomegranate\b/i` (the same deterministic address-check
`surfaces/slack/src/relay.ts` uses for a channel it's merely present in),
e.g. *"pomegranate what's the roadmap status?"* or *"@pomegranate ingest
this"*. The trigger word is stripped before the text reaches the agent.
Anything else in the group — chatter with no mention of the bot — gets **no
reply at all**; replying to everything in a group the bot happens to be in
would be noisy and unwanted.

Once addressed, a group message runs through the *exact same* pipeline as a
1:1 message: identity resolves from the individual sender's phone (see
below), `thread_key` is still that person's own number (so their
conversation stays continuous whether they DM the bot or address it from a
group, and doesn't mix with anyone else's), and every reply — mapped,
unmapped, no-default-folder — is the same text a DM would get. The one
difference is where the reply posts: back into the group, visible to
everyone there, not DMed to the sender. That's deliberate: whatever the
requester can see through the agent becomes visible to the group once they
ask for it there, same as reading your screen out loud in a meeting — this
surface doesn't try to prevent that, the requester owns that call.

The gate reads the message's own text or image caption, and is checked
*before* any media download — so unaddressed group chatter costs nothing
and leaves no stored asset behind. A bare voice note therefore can't
address the bot (WhatsApp has no caption on a voice note): name it in a
text message or an image caption.

**Setup requirement**: identifying *which* group member sent a message needs
WasenderAPI's `messages-group.received` event (participant info), which is
**separate** from `messages.received` — enable **Group Message Received**
in the Wasender dashboard alongside Message Received, or an addressed group
message has no resolvable sender and gets dropped (logged as
`whatsapp_message outcome=group_sender_unresolved`).

## What's NOT supported yet

- **Approve/reject actions.** Slack's candidate-approval buttons
  (`/agent/surface/actions`) have no WhatsApp equivalent wired up here yet,
  even though the server route is surface-generic. Everything the agent
  needs to do, it does through the conversational turn.
- **Channel-listen automations.** Slack's `listen` subscription verb has no
  WhatsApp analog (WhatsApp has no channels) — not attempted.

## Local development

```bash
npm install
cp .env.example .env   # fill in WASENDER_API_TOKEN, WASENDER_WEBHOOK_SECRET,
                        # POMEGRANATE_API_URL, SURFACE_AGENT_SECRET
                        # provider keys go on the app server
npm run dev             # listens on :3002 (or $PORT), POST /webhook
npm test                # vitest — no live WasenderAPI/Pomegranate calls
```

To receive real webhooks locally, tunnel `:3002` (e.g. `ngrok http 3002`) and
point the Wasender dashboard's Webhook URL at
`https://<tunnel>/webhook` with your `WASENDER_WEBHOOK_SECRET`. In
production the path is usually `/whatsapp/webhook` (see Running in production
below) — locally it's just `/webhook`, with no reverse proxy in front of it.

## WasenderAPI setup

1. Create a session in the [Wasender dashboard](https://wasenderapi.com) and
   connect the WhatsApp number this bot should answer as (scan the QR code
   with that number's WhatsApp app — same flow as WhatsApp Web).
2. Copy the session's API token into `WASENDER_API_TOKEN`.
3. In the session's settings, set **Webhook URL** to
   `https://<your-domain>/whatsapp/webhook` (must be HTTPS), generate a
   **Webhook Secret**, and copy it into `WASENDER_WEBHOOK_SECRET` — Wasender
   echoes this back verbatim as the `X-Webhook-Signature` header on every
   delivery, and requests without a matching header are rejected (401).
4. Enable the **Message Received** event (`messages.received`). This surface
   also tolerates `messages.upsert`'s array shape if you subscribe to that
   instead, but `messages.received` is the one to use — it's already
   filtered to inbound-only, which avoids receiving/echoing this bot's own
   outgoing sends.

## Running in production

This bot is its own process, separate from `app/`. Slack runs in socket mode
(an outbound WebSocket, no inbound port), but a WhatsApp webhook has to be a
public HTTPS URL. Put the bot behind any reverse proxy that terminates TLS
and forwards `/whatsapp/webhook` to `http://<bot-host>:3002/webhook`.

```bash
cp .env.example .env && $EDITOR .env  # fill in the real secrets
npm ci && npm run build
node dist/index.js
```

`SURFACE_AGENT_SECRET` must be the same value the app server has (its own
`.env`, `SURFACE_AGENT_SECRET`) — that's what lets `/agent/surface/messages`
trust this surface's identity claims.
