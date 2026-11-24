// Config: the inventory of every environment variable app/server reads.
//
// ENV_SCHEMA below lists each variable with its group, whether it is a
// secret, and its default. Adding a variable means adding a row here first;
// app/server/.env.example is generated from this list (npm run env:example)
// and a test fails when the two drift apart.

import type { Flags } from './flags.js';

export type EnvGroup =
  | 'runtime'
  | 'flags'
  | 'llm'
  | 'hosted-llm'
  | 'embeddings'
  | 'speech'
  | 'storage'
  | 'logging'
  | 'auth'
  | 'mail'
  | 'surfaces'
  | 'schedulers'
  | 'retrieval'
  | 'connectors'
  | 'phase0'
  | 'test';

export interface EnvVar {
  name: string;
  group: EnvGroup;
  /** A secret goes to Key Vault and is never logged; a setting can live in plain app config. */
  secret: boolean;
  /** 'when' = required only under a condition, spelled out in `note`. */
  required: 'yes' | 'no' | 'when';
  /** Default when unset, as today's code applies it. */
  default?: string;
  note?: string;
}

export const ENV_SCHEMA: readonly EnvVar[] = [
  // runtime
  { name: 'PORT', group: 'runtime', secret: false, required: 'no', default: '3000' },
  { name: 'POMEGRANATE_DB_PATH', group: 'runtime', secret: false, required: 'no', default: './data/pomegranate.db', note: 'SQLite only' },
  { name: 'POMEGRANATE_FILES_DIR', group: 'runtime', secret: false, required: 'no', default: './data/files', note: 'BlobStore fs driver root' },
  { name: 'PUBLIC_ORIGIN', group: 'runtime', secret: false, required: 'no', note: 'MCP + OAuth issuer origin' },
  { name: 'PUBLIC_APP_URL', group: 'runtime', secret: false, required: 'no', note: 'links in emails / digests' },
  { name: 'PUBLIC_API_URL', group: 'runtime', secret: false, required: 'no', note: 'tracking links in update digests' },
  // drivers and feature flags
  { name: 'POMEGRANATE_DB_DRIVER', group: 'flags', secret: false, required: 'no', default: 'sqlite' },
  { name: 'POMEGRANATE_BLOB_DRIVER', group: 'flags', secret: false, required: 'no', default: 'fs' },
  { name: 'POMEGRANATE_KEY_PROVIDER', group: 'flags', secret: false, required: 'no', default: 'local' },
  { name: 'POMEGRANATE_JOB_QUEUE', group: 'flags', secret: false, required: 'no', default: 'inproc' },
  { name: 'POMEGRANATE_SEAL', group: 'flags', secret: false, required: 'no', default: '0' },
  { name: 'SURFACES', group: 'flags', secret: false, required: 'no', default: '' },
  { name: 'MCP_CAPABILITY_URLS', group: 'flags', secret: false, required: 'no', default: '1', note: '0 disables claude.ai capability-URL connectors (OAuth only)' },
  { name: 'DATABASE_URL', group: 'flags', secret: true, required: 'when', note: 'required when POMEGRANATE_DB_DRIVER=pg' },
  { name: 'AZURE_STORAGE_ACCOUNT', group: 'flags', secret: false, required: 'when', note: 'required when POMEGRANATE_BLOB_DRIVER=azure (auth by managed identity)' },
  { name: 'AZURE_KEYVAULT_URL', group: 'flags', secret: false, required: 'when', note: 'required when POMEGRANATE_KEY_PROVIDER=azurekv' },
  { name: 'POMEGRANATE_LOCAL_KEK', group: 'flags', secret: true, required: 'when', note: 'required when POMEGRANATE_SEAL=1 and POMEGRANATE_KEY_PROVIDER=local; base64 of 32 random bytes' },
  // llm
  { name: 'POMEGRANATE_LLM_PROVIDER', group: 'llm', secret: false, required: 'no', default: 'together', note: 'together | hosted (alias) | anthropic' },
  { name: 'POMEGRANATE_LLM_THINKING', group: 'llm', secret: false, required: 'no' },
  { name: 'ANTHROPIC_API_KEY', group: 'llm', secret: true, required: 'when', note: 'provider=anthropic, wiki (preferAnthropic), surface agent' },
  { name: 'POMEGRANATE_CAPTURE_GLEAN', group: 'llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_CHUNK_CHARS', group: 'llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_LLM_LOG_PATH', group: 'llm', secret: false, required: 'no', default: './data/llm.log' },
  { name: 'POMEGRANATE_LLM_LOG_VERBATIM', group: 'llm', secret: false, required: 'no', note: 'keep unset in production: the LLM log would then contain user text' },
  { name: 'CURATOR_MODEL', group: 'llm', secret: false, required: 'no' },
  { name: 'SURFACE_AGENT_MODEL', group: 'llm', secret: false, required: 'no' },
  { name: 'SURFACE_AGENT_MAX_STEPS', group: 'llm', secret: false, required: 'no' },
  { name: 'SURFACE_AGENT_MAX_TOKENS', group: 'llm', secret: false, required: 'no' },
  // hosted LLM (Together or any OpenAI-compatible endpoint)
  { name: 'POMEGRANATE_HOSTED_API_KEY', group: 'hosted-llm', secret: true, required: 'when', note: 'provider=together|hosted — boot hard-fails if unset' },
  { name: 'POMEGRANATE_HOSTED_BASE_URL', group: 'hosted-llm', secret: false, required: 'when', note: 'provider=together|hosted' },
  { name: 'POMEGRANATE_HOSTED_MODEL', group: 'hosted-llm', secret: false, required: 'when', note: 'provider=together|hosted' },
  { name: 'POMEGRANATE_HOSTED_CONCURRENCY', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_RETRIES', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_SCHEMA_MODE', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_TEMP', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_TIMEOUT_MS', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_THINKING_TIMEOUT_MS', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_EMBED_MODEL', group: 'hosted-llm', secret: false, required: 'no' },
  { name: 'POMEGRANATE_HOSTED_EMBED_DIM', group: 'hosted-llm', secret: false, required: 'no' },
  // embeddings
  { name: 'OPENAI_API_KEY', group: 'embeddings', secret: true, required: 'no', note: 'absent → StubEmbedder; also STT provider=openai' },
  { name: 'POMEGRANATE_EMBEDDER', group: 'embeddings', secret: false, required: 'no', note: 'stub forces StubEmbedder' },
  // speech-to-text
  { name: 'POMEGRANATE_STT_PROVIDER', group: 'speech', secret: false, required: 'no', note: 'openai | deepgram | munsit' },
  { name: 'POMEGRANATE_STT_MODEL', group: 'speech', secret: false, required: 'no' },
  { name: 'POMEGRANATE_STT_LANGUAGE', group: 'speech', secret: false, required: 'no' },
  { name: 'DEEPGRAM_API_KEY', group: 'speech', secret: true, required: 'when', note: 'STT provider=deepgram' },
  { name: 'MUNSIT_API_KEY', group: 'speech', secret: true, required: 'when', note: 'STT provider=munsit' },
  // storage (S3-compatible media asset store; superseded by BlobStore azure driver)
  { name: 'POMEGRANATE_ASSET_BUCKET', group: 'storage', secret: false, required: 'no' },
  { name: 'POMEGRANATE_ASSET_ENDPOINT', group: 'storage', secret: false, required: 'no' },
  { name: 'POMEGRANATE_ASSET_REGION', group: 'storage', secret: false, required: 'no' },
  { name: 'POMEGRANATE_ASSET_PATH_STYLE', group: 'storage', secret: false, required: 'no' },
  { name: 'AWS_ACCESS_KEY_ID', group: 'storage', secret: true, required: 'no', note: 'read implicitly by @aws-sdk, not by our code' },
  { name: 'AWS_SECRET_ACCESS_KEY', group: 'storage', secret: true, required: 'no', note: 'read implicitly by @aws-sdk, not by our code' },
  // logging
  { name: 'POMEGRANATE_LOG_LEVEL', group: 'logging', secret: false, required: 'no', default: 'info' },
  { name: 'POMEGRANATE_APP_LOG_PATH', group: 'logging', secret: false, required: 'no', default: './data/app.log', note: 'set empty to log to stdout only' },
  // auth
  { name: 'SIGNUP_MODE', group: 'auth', secret: false, required: 'no', default: 'closed', note: 'open | closed' },
  { name: 'CONTACT_EMAIL', group: 'auth', secret: false, required: 'no', note: 'shown to people without an account under closed signup' },
  { name: 'POMEGRANATE_DEV_INLINE_CODES', group: 'auth', secret: false, required: 'no', note: 'tests/local dev only: return sign-in codes in API responses when no mailer is set; NEVER on a reachable server' },
  { name: 'POMEGRANATE_SINGLE_USER', group: 'auth', secret: false, required: 'no', note: 'one implicit local identity, no sign-in; NEVER on a reachable server' },
  { name: 'POMEGRANATE_TRUSTED_PROXY_HOPS', group: 'auth', secret: false, required: 'no', default: '0', note: 'number of reverse proxies in front of the server; set 1 behind one proxy so rate limits and audit logs see the real client IP' },
  { name: 'POMEGRANATE_AUTH_RL_CAPACITY', group: 'auth', secret: false, required: 'no' },
  { name: 'POMEGRANATE_AUTH_RL_REFILL_MS', group: 'auth', secret: false, required: 'no' },
  { name: 'POMEGRANATE_CREDENTIALS_KEY', group: 'auth', secret: true, required: 'no', note: 'encrypts per-user app credentials at rest' },
  { name: 'POMEGRANATE_ORG_EMAIL_DOMAINS', group: 'auth', secret: false, required: 'no' },
  { name: 'POMEGRANATE_PERSONAL_EMAIL_DOMAINS', group: 'auth', secret: false, required: 'no' },
  // mail
  { name: 'RESEND_API_KEY', group: 'mail', secret: true, required: 'no' },
  { name: 'MAIL_FROM', group: 'mail', secret: false, required: 'when', note: 'sender address; required with RESEND_API_KEY' },
  { name: 'SMTP_URL', group: 'mail', secret: true, required: 'no', note: 'URL carries credentials' },
  // surfaces
  { name: 'SURFACE_AGENT_SECRET', group: 'surfaces', secret: true, required: 'no', note: 'shared secret for bot → API relay calls' },
  { name: 'SLACK_BOT_TOKEN', group: 'surfaces', secret: true, required: 'no', note: 'update delivery to Slack' },
  { name: 'UPDATES_SLACK_TOKEN', group: 'surfaces', secret: true, required: 'no' },
  // schedulers
  { name: 'POMEGRANATE_ALLOW_EXTERNAL_RECIPIENTS', group: 'schedulers', secret: false, required: 'no', note: '1 = let update subscriptions and give broadcasts send to addresses outside the directory (off: members and Slack channels only)' },
  { name: 'UPDATES_SCHEDULER', group: 'schedulers', secret: false, required: 'no', note: '1 = run the 60 s Get-updates scheduler tick' },
  { name: 'AUTOMATIONS_SCHEDULER', group: 'schedulers', secret: false, required: 'no', note: '1 = run the 60 s automations scheduler tick' },
  // retrieval
  { name: 'POMEGRANATE_SOURCE_RAG', group: 'retrieval', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SOURCE_RAG_K', group: 'retrieval', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SOURCE_RAG_MIN_SIM', group: 'retrieval', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SOURCE_RAG_PER_DOC', group: 'retrieval', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SOURCE_CHUNK_CHARS', group: 'retrieval', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SOURCE_CHUNK_OVERLAP_PCT', group: 'retrieval', secret: false, required: 'no' },
  // connectors
  { name: 'COMPOSIO_API_KEY', group: 'connectors', secret: true, required: 'no' },
  { name: 'POMEGRANATE_SLACK_TOKEN', group: 'connectors', secret: true, required: 'no', note: 'Slack bot token for update deliveries, used when SLACK_BOT_TOKEN is unset' },
  // phase0 CLI (not part of the server process)
  { name: 'POMEGRANATE_DATA_DIR', group: 'phase0', secret: false, required: 'no' },
  // test-only (never set in a deployed environment)
  { name: 'POMEGRANATE_DEDUP_NO_JUDGE', group: 'test', secret: false, required: 'no' },
  { name: 'POMEGRANATE_RUN_LIVE_TESTS', group: 'test', secret: false, required: 'no' },
  { name: 'POMEGRANATE_SKIP_INTEGRATION', group: 'test', secret: false, required: 'no' },
];

/**
 * The typed object config() returns. The per-group shapes are filled in
 * group by group; the contract fixed here is the top-level layout, that
 * `flags` is the parsed feature flags, and that the object is frozen.
 */
export interface Config {
  readonly env: 'dev' | 'prod' | 'test';
  readonly flags: Flags;
  readonly runtime: {
    readonly port: number;
    readonly publicOrigin?: string;
    readonly publicAppUrl?: string;
    readonly publicApiUrl?: string;
  };
  /** Per-group settings, keyed by EnvGroup. Values are parsed and validated (numbers are numbers). */
  readonly groups: { readonly [G in EnvGroup]?: Readonly<Record<string, string | number | boolean | undefined>> };
}

/** Signature of config(). */
export type ConfigFn = () => Readonly<Config>;

/** Names of every secret, for log redaction and the "no secret in a non-secret store" check. */
export function secretEnvNames(): string[] {
  return ENV_SCHEMA.filter((v) => v.secret).map((v) => v.name);
}
