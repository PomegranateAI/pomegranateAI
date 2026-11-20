# Providers

Pomegranate talks to a small number of outside services. Each one sits behind a
single seam in `app/server`, is selected by environment variables (every one is
listed in `app/server/src/platform/config.ts` and `app/server/.env.example`),
and can be swapped without code changes. Only an LLM is required; everything
else is optional or has a local default.

## LLM: Together AI, any OpenAI-compatible endpoint, or Anthropic

Every model call (capture, routing, dedup, query, feedback, the curation
agent, …) goes through `callStructured` in `src/lib/anthropic.ts`. The provider
is chosen once at boot by `configureLlmProvider()` in `src/lib/llm-provider.ts`:

| `POMEGRANATE_LLM_PROVIDER` | What it uses |
|---|---|
| `together` (default) | Together AI's OpenAI-compatible API |
| `hosted` | Any other OpenAI-compatible endpoint: a different cloud provider or a model you run yourself |
| `anthropic` | Claude through Anthropic's native tool-use |

### Low-cost models instead of Anthropic

Pomegranate does **not** need Anthropic. It was built so that small, inexpensive
open-weight models can do the work:

- **Structured output works without tool-use.** With `together` or `hosted`,
  each call asks the endpoint for JSON matching the task's schema
  (`POMEGRANATE_HOSTED_SCHEMA_MODE`, default `json_schema`), and the result is
  validated with Zod like any other call. The curation agent and the Slack and
  WhatsApp surface agent switch to a step-by-step structured loop that small
  models handle well, instead of Anthropic's native tool-use.
- **Reasoning traces are off by default** (`POMEGRANATE_LLM_THINKING=0`), which
  keeps answers fast and cheap. A healthy call returns in roughly 1–5 seconds.
- **It fails safely.** Calls have a timeout, a small number of retries and a
  circuit breaker, so a stalled provider can't block the ingest queue. A
  missing `POMEGRANATE_HOSTED_*` setting stops the server at boot instead of
  silently using a different model.
- **One key can cover embeddings too.** Setting `POMEGRANATE_HOSTED_EMBED_MODEL`
  sends embeddings to the same endpoint, so no OpenAI key is needed.

**Tested model:** the full solution has been running and tested on
**Qwen 9B**, both hosted on Together AI and running locally.

Together AI setup:

```bash
POMEGRANATE_LLM_PROVIDER=together
POMEGRANATE_HOSTED_BASE_URL=https://api.together.xyz/v1
POMEGRANATE_HOSTED_API_KEY=<your Together key>
POMEGRANATE_HOSTED_MODEL=<Together's id for the Qwen model>
```

Local setup: point `hosted` at any local server that exposes an
OpenAI-compatible `/v1/chat/completions` endpoint (for example vLLM, llama.cpp
or Ollama):

```bash
POMEGRANATE_LLM_PROVIDER=hosted
POMEGRANATE_HOSTED_BASE_URL=http://localhost:8000/v1
POMEGRANATE_HOSTED_API_KEY=local            # any non-empty value if the server ignores it
POMEGRANATE_HOSTED_MODEL=<the model name your server reports>
# If the server doesn't support json_schema, try guided_json or json_object:
# POMEGRANATE_HOSTED_SCHEMA_MODE=json_object
```

Other tuning knobs: `POMEGRANATE_HOSTED_TEMP` (default 0.2),
`POMEGRANATE_HOSTED_CONCURRENCY` (default 2), `POMEGRANATE_HOSTED_RETRIES`
(default 2) and `POMEGRANATE_HOSTED_TIMEOUT_MS` (default 45000).

**Where Anthropic still helps (optional).** Long, heavily structured outputs,
mainly the wiki plan and fill passes, come out better on Claude. If
`ANTHROPIC_API_KEY` is set alongside a Together/hosted provider, those calls
use Claude, and they fall back to your configured model if Claude fails.
Without the key they run on your configured model. Set
`POMEGRANATE_PROVIDER_ONLY=1` to keep every call on your chosen provider even
when an Anthropic key is present.

## Embeddings

Used for search and near-duplicate detection (`src/lib/embeddings.ts`):

| Setting | Embedder |
|---|---|
| `POMEGRANATE_HOSTED_EMBED_MODEL` set | Your Together/hosted endpoint |
| `OPENAI_API_KEY` set | OpenAI embeddings |
| Neither (or `POMEGRANATE_EMBEDDER=stub`) | Built-in deterministic stub: works offline, weaker duplicate detection |

## Speech-to-text

Transcribes audio from WhatsApp voice notes and uploads.
`POMEGRANATE_STT_PROVIDER` picks one of:

- **OpenAI** (Whisper): uses `OPENAI_API_KEY`
- **Deepgram**: `DEEPGRAM_API_KEY`
- **Munsit**: `MUNSIT_API_KEY`, for Arabic speech

## Email

Sends sign-in links, invitations and password emails (`src/phase1/mail/`):

- **Resend** (`RESEND_API_KEY`), or
- **any mail server over SMTP** (`SMTP_URL`).

`MAIL_FROM` sets the sender address.

## Connected apps (Composio)

Pulling content from other tools goes through **Composio** (`COMPOSIO_API_KEY`),
which handles each app's sign-in. Supported apps, one module each in
`src/phase1/api/*-live.ts`: Google Drive, Gmail, Slack, Microsoft Teams,
Notion, GitHub, Jira and Fathom.

## Chat surfaces

- **Slack** (`surfaces/slack`): a bot built on Slack Bolt.
  Needs `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (and `SLACK_APP_TOKEN`
  for socket mode).
- **WhatsApp** (`surfaces/whatsapp`): sends and receives messages through
  **WasenderAPI** (`WASENDER_API_TOKEN`, `WASENDER_WEBHOOK_SECRET`).

Both talk to the server with `SURFACE_AGENT_SECRET`.

## Infrastructure

Everything runs locally by default. Cloud options sit behind driver flags in
`src/platform/`:

| What | Default | Alternatives |
|---|---|---|
| Database (`POMEGRANATE_DB_DRIVER`) | SQLite | Postgres (`DATABASE_URL`) |
| File storage (`POMEGRANATE_BLOB_DRIVER`) | Local disk | Azure Storage; media can also go to any S3-compatible bucket (`POMEGRANATE_ASSET_*`) |
| Encryption keys (`POMEGRANATE_KEY_PROVIDER`) | Local key (`POMEGRANATE_LOCAL_KEK`) | Azure Key Vault (`AZURE_KEYVAULT_URL`) |
| Job queue (`POMEGRANATE_JOB_QUEUE`) | In-process | — |

## Other services

- **Have I Been Pwned** (Pwned Passwords range API): new passwords are
  checked against known breaches. Only a short hash prefix is sent.
- **claude.ai / MCP clients**: any MCP client (Claude, Cursor, …) can connect to
  the built-in MCP server with OAuth or a connection token.
