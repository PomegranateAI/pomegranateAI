import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrateMedia } from '../data-agents/schema.js';

/**
 * SQLite schema for Phase 1. One DB per deployment. Workspace isolation
 * is enforced at the application layer (every query carries workspace_id).
 *
 * Open-source choice: SQLite via better-sqlite3 (synchronous, in-process,
 * no extra services). Replaces Cloudflare D1 (which is also SQLite under
 * the hood — port is mechanical).
 */
export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateMedia(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'trial', -- legacy column, unused
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      UNIQUE(email)
    );

    CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('workspace_admin', 'leader', 'member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      mfa_enrollment_required INTEGER NOT NULL DEFAULT 0,
      password_change_required INTEGER NOT NULL DEFAULT 0
    );

    -- External identities linked to a user (surface-unification overhaul).
    -- Lets any surface resolve "who is @alice.martin" server-side instead
    -- of a per-surface static mapping. 'whatsapp' (external_id = E.164 phone
    -- number, team_id always NULL — one bot number, no per-team routing)
    -- joined 'slack' 2026-09-10.
    -- UNIQUE(kind, team_id, external_id) prevents two users claiming the same
    -- Slack identity; handles are self-claimed (acceptable inside a
    -- domain-scoped org — the invite flow gates who has an account at all).
    CREATE TABLE IF NOT EXISTS user_identities (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('slack','whatsapp')),
      team_id     TEXT,               -- Slack team id (T…); NULL = any team
      external_id TEXT NOT NULL,      -- Slack user id (U…) or WhatsApp E.164 number
      handle      TEXT,               -- e.g. 'alice.martin' (no @)
      created_at  TEXT NOT NULL,
      UNIQUE (kind, team_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);

    -- Per-user default folder (workspace), optionally per surface. The 'all'
    -- row is the fallback when no surface-specific row exists. A default is a
    -- POINTER, not a grant: readers still need membership in the workspace.
    CREATE TABLE IF NOT EXISTS user_defaults (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      surface      TEXT NOT NULL CHECK (surface IN ('all','slack','mcp','whatsapp')),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id  TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, surface)
    );

    -- Per-user third-party app credentials (e.g. the Gmail IMAP app password),
    -- entered in Settings. secret is an AES-256-GCM blob sealed with the
    -- POMEGRANATE_CREDENTIALS_KEY env key (lib/credentials.ts) — never
    -- plaintext, so DB backups don't leak replayable passwords. USER-scoped,
    -- not workspace-scoped: an inbox belongs to a person, and pulls run with
    -- the caller's own connection in whatever workspace they target.
    CREATE TABLE IF NOT EXISTS user_app_credentials (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      app        TEXT NOT NULL,
      secret     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, app)
    );

    -- Password sign-in, alongside magic-link (never a replacement — magic
    -- link keeps working for every account regardless of this table). One
    -- row per account with a password set; no row = password sign-in is
    -- unavailable for that account (POST /auth/password/login rejects it the
    -- same way as a wrong password, so the response can't be used to tell
    -- the two apart). Kept OUT of the users table on purpose: this repo's
    -- User-returning call sites do SELECT * FROM users and hand the row
    -- straight to API responses, so a password_hash column there would be
    -- one missed omit() away from leaking a hash to the client. password_hash
    -- is a one-way scrypt digest (lib/passwords.ts) — the server never holds
    -- the plaintext beyond the request that sets it.
    CREATE TABLE IF NOT EXISTS user_passwords (
      user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      must_change   INTEGER NOT NULL DEFAULT 0
    );

    -- Failed sign-in attempts per account (password or second factor), in a
    -- rolling window. Drives the audit alert and the temporary lock that the
    -- per-IP limiter can't give against attempts spread over many addresses.
    CREATE TABLE IF NOT EXISTS user_auth_failures (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      window_start TEXT NOT NULL,
      failures     INTEGER NOT NULL,
      alerted      INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );

    -- Second factor: an emailed sign-in link after the password. A row = the
    -- account turned it on itself; the MFA_REQUIRED policy covers others
    -- without a row. (The TOTP tables user_mfa / user_mfa_recovery_codes
    -- from the earlier authenticator-app version stay on databases that have
    -- them, unused; enrolled rows carry over below.)
    CREATE TABLE IF NOT EXISTS user_email_mfa (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled_at TEXT NOT NULL
    );
    -- The password passed, second step pending: the token in the emailed link,
    -- traded for a session at POST /auth/mfa/verify. Hashed like sessions;
    -- single use. (attempts is unused since the switch to emailed links.)
    -- Forgotten-password links (POST /auth/password/forgot). Hash only, single
    -- use, short-lived; one live link per account (a new request replaces it).
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mfa_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method     TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL
    );

    -- Composio auth configs. ONE row per toolkit, created lazily the first
    -- time anyone connects that app — Composio's default managed auth config
    -- for a toolkit (its own OAuth app registration), so we never register
    -- e.g. our own GitHub OAuth app. Not workspace- or user-scoped: it's
    -- ours-as-an-operator, shared by every user who connects that toolkit.
    CREATE TABLE IF NOT EXISTS composio_auth_configs (
      toolkit        TEXT NOT NULL PRIMARY KEY,
      auth_config_id TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );

    -- Per-user Composio-mediated connections (GitHub, Slack, ...). Composio
    -- custodies the actual OAuth tokens on their infra; this row holds only a
    -- reference (connected_account_id) plus the last-known status, refreshed
    -- by a live check against Composio rather than trusted at rest. USER-
    -- scoped like user_app_credentials, for the same reason: a connected
    -- account belongs to a person, not a workspace.
    CREATE TABLE IF NOT EXISTS user_composio_connections (
      user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      toolkit              TEXT NOT NULL,
      connected_account_id TEXT NOT NULL,
      status               TEXT NOT NULL, -- 'initiated' | 'active' | 'failed' (Composio's ConnectedAccountStatuses, lowercased)
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      PRIMARY KEY (user_id, toolkit)
    );

    -- Per-user visible agents (collab agents + work agents). The absence of a
    -- row means the app is hidden for that user/workspace, which makes the
    -- backend default to no apps shown until the user explicitly adds one.
    CREATE TABLE IF NOT EXISTS user_workspace_app_visibility (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      app          TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, workspace_id, app)
    );

    -- Surface-agent conversation state (one row per Slack thread/DM). Holds
    -- the resolved identity and the folder the thread last ran against.
    -- pending_action is vestigial: confirm-first was removed (tools execute on
    -- first call), so it is always written NULL — kept for schema stability.
    CREATE TABLE IF NOT EXISTS agent_threads (
      surface        TEXT NOT NULL,
      team_id        TEXT NOT NULL,
      thread_key     TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      workspace_id   TEXT NOT NULL,
      pending_action TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (surface, team_id, thread_key)
    );

    CREATE TABLE IF NOT EXISTS agent_thread_messages (
      id         TEXT PRIMARY KEY,
      surface    TEXT NOT NULL,
      team_id    TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      role       TEXT NOT NULL CHECK (role IN ('user','agent','event')),
      body       TEXT NOT NULL,
      receipts   TEXT,
      created_at TEXT NOT NULL,
      workspace_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_msgs_thread
      ON agent_thread_messages(surface, team_id, thread_key, created_at);

    -- Per-workspace context profile (spec B4). Stores the full resolved
    -- ContextProfile JSON as a self-contained snapshot so a profile edit or a
    -- built-in profile change never silently re-interprets a workspace's canon.
    CREATE TABLE IF NOT EXISTS workspace_profiles (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id  TEXT NOT NULL DEFAULT 'default',  -- multi-profile partition
      profile_id   TEXT NOT NULL,        -- 'todo_list' | 'project_status' | 'brand_voice' | 'custom-…'
      profile      TEXT NOT NULL,        -- full resolved ContextProfile JSON snapshot
      created_at   INTEGER,
      updated_at   INTEGER,
      PRIMARY KEY (workspace_id, subgraph_id)
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      -- the type column holds the profile KIND KEY (spec B1). For the founding
      -- profile these are goal/positioning/decision; non-founding profiles use
      -- their own kind keys. Kind validity is enforced against the workspace
      -- ContextProfile at capture output (enforceProfileKinds), candidate
      -- insert (repo.insertCandidate), approval (repo.approveCandidate), and
      -- the node-writing routes (validateNode) — so no enum CHECK here.
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      data TEXT NOT NULL,             -- JSON blob of the Node payload
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded TEXT,
      embedding BLOB,                 -- Float32Array bytes (1536 dim for openai 3-small); null if not yet computed
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_status ON graph_nodes(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_type ON graph_nodes(workspace_id, type);

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      flag TEXT NOT NULL CHECK (flag IN ('red', 'yellow', 'green')),
      proposed_node TEXT NOT NULL,    -- JSON blob
      source_quote TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      conflicts_with TEXT,
      confidence REAL NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'edited')),
      proposed_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_ws_status ON candidates(workspace_id, status);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      caller TEXT NOT NULL CHECK (caller IN ('web', 'mcp', 'slack')),
      kind TEXT NOT NULL DEFAULT 'other',
      deliverable TEXT NOT NULL,
      findings TEXT NOT NULL,         -- JSON array of Finding
      submitted_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      object_path TEXT NOT NULL,      -- relative path under FILES_DIR
      original_name TEXT,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL,         -- file path / slack channel / caller-supplied ref
      source_kind TEXT NOT NULL,        -- doc | slack | transcript | interaction
      sha256 TEXT NOT NULL,             -- content hash; same ref + new hash bumps version
      version INTEGER NOT NULL DEFAULT 1,
      summary TEXT,                     -- 2-3 sentence document summary (router-extracted)
      stakeholders TEXT,                -- JSON array of authors/participants
      created_at TEXT NOT NULL,
      last_ingested_at TEXT,            -- bumped on every (re-)ingest, incl. idempotent + new-subgraph extraction; Sources sorts by this so a re-added source resurfaces (created_at stays first-seen)
      ingested_by TEXT,                 -- user who first ingested this version (NULL = pre-column row)
      audience TEXT,                    -- audience that ingest explicitly asked for, if any (team|private|only_me)
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_ws_ref ON documents(workspace_id, source_ref);

    -- Source-RAG chunk store (spec-source-rag-hybrid-answering.md §2.1). One row
    -- per ~1k-char window of a document's full text, carrying a Float32Array
    -- embedding in the same BLOB encoding as graph_nodes.embedding. Populated at
    -- ingest when POMEGRANATE_SOURCE_RAG is on; read by the source retrieval path
    -- alongside the node canon. document_id is version-specific (registerDocument
    -- mints a new id per changed version), so superseded versions' chunks linger
    -- but are filtered out at retrieval by the latest-version gate. subgraph_ref
    -- is advisory only — documents are shared across subgraphs, so source
    -- retrieval is workspace-scoped. Cascades with the document on delete.
    CREATE TABLE IF NOT EXISTS source_chunks (
      id            TEXT NOT NULL,        -- deterministic: <document_id>:c<index>
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id   TEXT NOT NULL,
      subgraph_ref  TEXT,                 -- nullable: docs are shared across subgraphs
      chunk_index   INTEGER NOT NULL,
      text          TEXT NOT NULL,
      char_start    INTEGER NOT NULL,     -- offsets into the persisted .txt
      char_end      INTEGER NOT NULL,
      embedding     BLOB,                 -- Float32Array bytes; null if not yet computed
      sha256        TEXT NOT NULL,        -- of the chunk text, for idempotent re-ingest
      created_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_chunks_ws_doc ON source_chunks(workspace_id, document_id);

    -- Ingestion/sharing rules (spec-directory-tracking-and-ingestion-rules.md).
    -- A standing, workspace-global policy authored by the workspace owner and
    -- synced like documents (mirror-diff on pull; /sync/rule on push). Two axes:
    --   scopes  JSON subset of ["only_me","private","team"] — which audience tier(s)
    --           (unified 3-tier model: Only me / AI agents / Team; see
    --           spec-unified-sharing-and-always-sync.md — no legacy "local")
    --   phases  JSON subset of ["store","use"]              — when it fires (ingest / retrieval)
    -- action is always 'shape' (auto_approve/auto_reject/surface were removed —
    -- they never applied to a live document); the free-text instructions remain
    -- the source of truth the LLM applies. target = node|source.
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      instructions TEXT NOT NULL,
      scopes TEXT NOT NULL,             -- JSON array
      phases TEXT NOT NULL,             -- JSON array
      action TEXT,                      -- always 'shape' (legacy rows may still say otherwise; see migrate() cleanup)
      target TEXT NOT NULL DEFAULT 'node',  -- node | source
      enabled INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT,               -- the workspace owner; NULL = workspace-native
      sort_order INTEGER NOT NULL DEFAULT 0,  -- precedence; lower fires first
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_rules_ws ON rules(workspace_id);

    -- Unified automations (supersedes rules -- left in place, unused, per the
    -- no-destructive-migration rule; see repo.migrateRulesToAutomations). Four
    -- kinds share one row shape: 'shape' (today's shape/use-phase rules,
    -- columns mirror rules 1:1), 'apps_pull' (recurring app-connector
    -- ingestion with user-defined criteria + cadence), 'slack_listen' (migrated
    -- from surfaces/slack's JSON file), 'track_directory' (standalone Track
    -- directories, represented centrally but never centrally scheduled --
    -- cadence_ms is always NULL for this kind since the cloud cannot scan a
    -- user's filesystem; see idx_automations_due).
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT NOT NULL,                 -- au_<nanoid>
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('shape','apps_pull','slack_listen','track_directory')),

      -- shape kind
      instructions TEXT,
      scopes TEXT,                      -- JSON array
      phases TEXT,                      -- JSON array
      action TEXT,                      -- always 'shape' (legacy rows may still say otherwise; see migrate() cleanup)
      target TEXT DEFAULT 'node',       -- node | source | both

      -- ingestion kinds (apps_pull / slack_listen / track_directory)
      connector TEXT,                   -- 'gmail'|'github'|'slack'|'gdrive'|'notion'|'jira'|'fathom'|'microsoft_teams'|'directory'
      criteria TEXT,                    -- JSON IngestionCriteria
      subgraph_id TEXT,                 -- forced destination, or NULL = router/agent decides
      run_instructions TEXT,             -- optional free-text steer (Add Source's InstructionsField equivalent)
      cadence_ms INTEGER,                -- NULL = never scheduled centrally (always NULL for track_directory)
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
      last_run_at TEXT,
      next_run_at TEXT,
      watermark TEXT,                    -- ISO cutoff / connector cursor (Slack ts, Drive modifiedAfter, ...)
      fail_count INTEGER NOT NULL DEFAULT 0,  -- drives backoff

      -- slack_listen only
      slack_team_id TEXT,
      slack_channel_id TEXT,

      -- track_directory only (device-local; row is inert centrally)
      device_id TEXT,
      local_path TEXT,

      enabled INTEGER NOT NULL DEFAULT 1,
      owner_user_id TEXT,                -- NULL = workspace-native (shape defaults); ingestion kinds always set
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_automations_ws ON automations(workspace_id, kind);
    CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(status, next_run_at);

    -- One row per automation execution — scheduled tick or manual "run now".
    -- Dry-run previews persist nothing here (see automations/test.ts).
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT NOT NULL,                 -- ar_<nanoid>
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      automation_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','manual_run')),
      outcome TEXT NOT NULL CHECK (outcome IN ('ok','empty','error')),
      window_from TEXT,                 -- watermark at run start
      window_to TEXT,                   -- watermark after this run (only advanced on ok/empty)
      items_seen INTEGER NOT NULL DEFAULT 0,
      items_ingested INTEGER NOT NULL DEFAULT 0,
      document_ids TEXT,                -- JSON string[]
      candidate_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_ws_auto ON automation_runs(workspace_id, automation_id, created_at);

    -- Evidence ledger (corroboration): one row per (node, document) support.
    -- Dedup's "drop as duplicate" verdicts append here instead of discarding
    -- the corroboration signal; node approval seeds the origin row.
    CREATE TABLE IF NOT EXISTS node_evidence (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      document_id TEXT,
      source_ref TEXT,
      source_kind TEXT,
      quote TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, node_id, document_id, quote)
    );
    CREATE INDEX IF NOT EXISTS idx_node_evidence_ws_node ON node_evidence(workspace_id, node_id);

    -- Typed node↔node edges. Relation vocabulary lives on the workspace
    -- profile (edge_kinds); src/dst kind constraints are enforced at write
    -- time, not by the schema. created_by records origin (deterministic |
    -- llm | manual | migration) so edges are auditable and removable by
    -- batch. The unique (src, dst, kind) index makes every writer idempotent.
    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_by TEXT NOT NULL DEFAULT 'manual',
      document_id TEXT,
      quote TEXT,
      confidence REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_uniq
      ON graph_edges(workspace_id, src, dst, kind);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(workspace_id, src);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(workspace_id, dst);

    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT,
      -- Set only when a TOOL actually ran on this credential. last_used_at is
      -- stamped the moment the credential resolves (which a client's
      -- validation probe does), so it answers "the link was reached"; this one
      -- answers "an assistant used it". Get started shows them as different
      -- states — see spec-first-run-onboarding.md §4.3.
      last_tool_call_at TEXT,
      revoked_at TEXT,
      PRIMARY KEY (workspace_id, id)
    );

    -- claude.ai connectors — self-serve capability URLs. claude.ai's custom
    -- connector UI can't send a bearer header (OAuth or no-auth only), so the
    -- secret path IS the credential: https://<host>/mcp/connector/<secret>.
    -- Resolved in-app (secret_hash lookup → workspace + user), which is what
    -- lets connectors be created from Settings with no reverse-proxy or server changes —
    -- the static per-connector Caddy blocks are the legacy mechanism. The
    -- plaintext secret is shown once at creation and never stored.
    CREATE TABLE IF NOT EXISTS claude_ai_connectors (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      secret_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      -- See mcp_tokens.last_tool_call_at: reached vs actually used.
      last_tool_call_at TEXT,
      revoked_at TEXT,
      PRIMARY KEY (workspace_id, id)
    );

    -- OAuth 2.1 credentials for remote MCP clients. This is deliberately
    -- additive: legacy mcp_tokens and claude_ai_connectors continue to work.
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL,
      scopes TEXT NOT NULL,
      workspace_ids TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      scopes TEXT NOT NULL,
      workspace_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      token_hash TEXT NOT NULL UNIQUE,
      family_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);

    -- Envelope encryption (C3, A7 4.3): each workspace's data keys (DEKs),
    -- stored ONLY wrapped by the key-encryption key (KEK: POMEGRANATE_LOCAL_KEK
    -- here, Key Vault on Azure). version 1 is minted lazily at the first seal;
    -- rotation adds version n+1 and retires the old one, which still opens
    -- what it sealed. kek_version names the KEK that wrapped the row, so a KEK
    -- rotation can find and rewrap the rest. No FK to workspaces: a key row
    -- must be removable on its own (crypto-shred), and deletion lists it.
    CREATE TABLE IF NOT EXISTS workspace_keys (
      workspace_id TEXT NOT NULL,
      version      INTEGER NOT NULL,
      wrapped_dek  BLOB NOT NULL,
      kek_version  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      retired_at   TEXT,
      PRIMARY KEY (workspace_id, version)
    );
    -- A shredded workspace's keys are gone for good; this marker makes a
    -- later seal fail (workspace_shredded) instead of quietly minting a new key.
    CREATE TABLE IF NOT EXISTS workspace_key_shreds (
      workspace_id TEXT PRIMARY KEY,
      shredded_at  TEXT NOT NULL
    );

    -- (The per-node share ACL node_shares was removed with the "share with
    -- specific people" tier — spec-unified-sharing-and-always-sync.md. Existing
    -- tables are dropped by the migration below.)

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      actor TEXT,
      event TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      payload TEXT,                   -- JSON
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ws_created ON audit_log(workspace_id, created_at);

    -- Customer-facing audit log (distinct from internal audit_log). Exported
    -- by Workspace Admin as JSON/CSV. Event vocabulary is fixed and tracked
    -- against the PRD's enterprise-acceptance requirements. Includes source
    -- IP and user-agent so the customer's SIEM can correlate.
    CREATE TABLE IF NOT EXISTS customer_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      event TEXT NOT NULL,            -- enum: see CUSTOMER_AUDIT_EVENTS in repo.ts
      actor_user_id TEXT,
      actor_email TEXT,
      source_ip TEXT,
      user_agent TEXT,
      resource_type TEXT,
      resource_id TEXT,
      payload TEXT,                   -- JSON (kept terse; no deliverable bodies)
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_caudit_ws_created ON customer_audit_log(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_caudit_ws_event ON customer_audit_log(workspace_id, event);
    CREATE INDEX IF NOT EXISTS idx_caudit_actor ON customer_audit_log(actor_user_id, id);

    -- Customer-audit rows of DELETED workspaces. Deleting a workspace used to
    -- erase its audit trail with it (ON DELETE CASCADE above), including the
    -- workspace_deleted row itself — so nobody could later show who deleted
    -- what. deleteWorkspaceRows copies the rows here first. No FK on purpose:
    -- the workspace row is gone. Kept AUDIT_ARCHIVE_RETENTION_DAYS (default
    -- 365), pruned on each deletion. Payloads are metadata only (ids, roles,
    -- folder names), never document content.
    CREATE TABLE IF NOT EXISTS deleted_workspace_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_id INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT,
      event TEXT NOT NULL,
      actor_user_id TEXT,
      actor_email TEXT,
      source_ip TEXT,
      user_agent TEXT,
      resource_type TEXT,
      resource_id TEXT,
      payload TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dwaudit_ws ON deleted_workspace_audit(workspace_id, original_id);
    CREATE INDEX IF NOT EXISTS idx_dwaudit_archived ON deleted_workspace_audit(archived_at);

    -- Cross-user context usage — ATTRIBUTED log. One row per context access
    -- (web or MCP): who drew on the workspace's context, what KIND of request
    -- it was (tool, scope, deliverable kind, whether the graph had an
    -- answer), and — as of 2026-08 — the verbatim request text itself. This
    -- reverses the original (2026-06) attribution-without-content split for
    -- this table specifically: the product decision is now that the owner
    -- and team see both who asked and what they asked, on the Usage view.
    -- context_request_texts (below) still exists as the actor-free anonymized
    -- store feeding the usage-analysis synthesis — leave that split alone.
    CREATE TABLE IF NOT EXISTS context_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_user_id TEXT,
      actor_email TEXT,
      channel TEXT NOT NULL CHECK (channel IN ('web', 'mcp')),
      tool TEXT NOT NULL,             -- query | context_pack | review | recent_changes | work | search
      scope TEXT,
      deliverable_kind TEXT,
      has_answer INTEGER,             -- 0/1; null where N/A (packs, reviews)
      cited INTEGER,                  -- citations returned (query) / nodes packed
      node_count INTEGER,
      latency_ms INTEGER,
      request_text TEXT,              -- verbatim question/request; NULL where N/A
      detail TEXT,                    -- human-readable call options ("titles only, since 1 Oct 2026"); never user content
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_usage_ws_created ON context_usage_log(workspace_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ctx_usage_actor ON context_usage_log(actor_user_id, created_at);

    -- Cross-user context usage — ANONYMIZED verbatim store. Feeds the
    -- owner-facing usage-analysis synthesis and testing, with deliberately NO
    -- actor columns, independent of the attributed copy now kept alongside
    -- identity in context_usage_log.request_text above.
    CREATE TABLE IF NOT EXISTS context_request_texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      scope TEXT,
      deliverable_kind TEXT,
      request_text TEXT NOT NULL,
      has_answer INTEGER,
      cited_node_ids TEXT,            -- JSON array of node ids the answer cited
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ctx_texts_ws_created ON context_request_texts(workspace_id, created_at);

    -- Synthesis cache (replaces Cloudflare KV)
    CREATE TABLE IF NOT EXISTS synth_cache (
      cache_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      value TEXT NOT NULL,            -- JSON
      created_at TEXT NOT NULL,
      ttl_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_synth_cache_ttl ON synth_cache(ttl_at);

    -- Slack ingest mock state
    CREATE TABLE IF NOT EXISTS slack_channels (
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      watching INTEGER NOT NULL DEFAULT 0,
      auto_scan INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, channel)
    );

    -- Day-1 Audit (PRD Goal #6). Single persisted report per run.
    -- Stored as a JSON blob so the report shape can evolve without migrations.
    CREATE TABLE IF NOT EXISTS day1_audit_reports (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      requested_by TEXT,
      deliverables_count INTEGER NOT NULL,
      report TEXT NOT NULL,            -- JSON: aggregated shape, see day1Audit.ts
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_day1_ws_created ON day1_audit_reports(workspace_id, created_at);

    -- Grouping cache. PRD § Synthesis > Grouping synthesis specifies that
    -- grouping is auto-triggered after every successful ingest and the
    -- result is persisted keyed by the pending-id-set signature. The
    -- /candidates/groups endpoint reads from this cache by default; the
    -- LLM only re-runs when the signature changes (a candidate was
    -- approved/rejected or new ones were ingested).
    CREATE TABLE IF NOT EXISTS candidate_groups (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      signature TEXT NOT NULL,           -- sha256 of sorted pending candidate ids
      groups TEXT NOT NULL,              -- JSON: CandidateGroup[]
      candidate_count INTEGER NOT NULL,  -- length of the pending set at compute time
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_groups_ws_created
      ON candidate_groups(workspace_id, created_at);

    -- Context-aware triage.
    -- One row per (document, pending-set signature): the LLM assessment is
    -- immutable per signature (same compute-once economics as
    -- candidate_groups); answers append onto the row and replay through the
    -- deterministic decision table. status tracks the doc-level outcome.
    CREATE TABLE IF NOT EXISTS doc_triage (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      subgraph_id TEXT NOT NULL DEFAULT 'default',  -- multi-profile partition
      signature TEXT NOT NULL,           -- sha256 of the doc's sorted pending candidate ids
      assessment TEXT NOT NULL,          -- JSON DocTriagePayload
      answers TEXT,                      -- JSON { question_id: answer }
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','committed','discarded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, document_id, subgraph_id, signature)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_triage_ws_doc ON doc_triage(workspace_id, document_id);

    -- Conversational curation.
    -- One conversation per (workspace, document). document_id '' is the
    -- synthetic "Loose items" conversation for candidates with no document.
    -- case_opened records which of the three openings (§2) the conversation
    -- started with; status is the thread lifecycle, not candidate state
    -- (candidate rows stay the source of truth for what is pending).
    CREATE TABLE IF NOT EXISTS curation_conversations (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,         -- '' = loose items
      subgraph_id TEXT NOT NULL DEFAULT 'default',  -- multi-profile partition
      case_opened TEXT NOT NULL CHECK (case_opened IN ('1','2','3')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, document_id, subgraph_id)
    );

    -- Thread rows. role 'event' records UI-button actions and out-of-band
    -- state changes (MCP/Slack approvals) so the thread never silently
    -- diverges from candidate state. receipts is the structured action log
    -- [{tool, ids, result}] for agent turns and UI actions alike.
    CREATE TABLE IF NOT EXISTS curation_messages (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('agent','user','event')),
      body TEXT NOT NULL,
      receipts TEXT,                     -- JSON: ActionReceipt[]
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_curation_msgs_ws_doc_created
      ON curation_messages(workspace_id, document_id, created_at);

    -- "Mark feedback as wrong" — IC-side negative-space loop.
    -- PRD: "captured silently for the v1 negative-space loop. Not surfaced to
    -- the leader yet." Data shape exists now so the v1 surface has corpus.
    -- Unique on (workspace, review, finding_index) keeps it idempotent.
    CREATE TABLE IF NOT EXISTS finding_rejections (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      review_id TEXT NOT NULL,
      finding_index INTEGER NOT NULL,
      marked_by_user_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, review_id, finding_index)
    );
    CREATE INDEX IF NOT EXISTS idx_finding_rej_ws ON finding_rejections(workspace_id);

    -- Multi-subgraph (multi-profile) support. A workspace (= the account) holds
    -- N subgraphs, each bound to one ContextProfile via workspace_profiles
    -- keyed by (workspace_id, subgraph_id). Pre-feature workspaces carry a
    -- single subgraph id 'default' so all existing graph data (whose
    -- subgraph_id column defaults to 'default') keeps resolving identically.
    -- slug is the hashtag token used to pin routing on ingest/query.
    CREATE TABLE IF NOT EXISTS subgraphs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id           TEXT NOT NULL,          -- 'default' | sg_<nanoid>
      slug         TEXT NOT NULL,          -- '#'-token target, unique per workspace
      name         TEXT NOT NULL,
      -- User-authored, one-line "what this subfolder is for" (e.g. "Product
      -- ground truth for the Pomegranate Slack app"). Distinct from the
      -- generated_description below (the LLM synthesis of the graph). Defaults
      -- to 'miscellaneous' when the creator leaves it blank.
      description  TEXT NOT NULL DEFAULT 'miscellaneous',
      -- The LLM-generated Overview summary, persisted per subfolder and
      -- refreshed every time the /overview call recomputes it (see the overview
      -- route). NULL until the first synthesis runs (empty graph / failure).
      generated_description    TEXT,
      generated_description_at TEXT,        -- ISO timestamp of the last persist
      -- Set when a human has hand-edited generated_description (PATCH
      -- .../subgraphs/:id). While locked, refreshSubgraphOverview's automatic
      -- recompute (triggered by /overview and by every ingest) leaves the row
      -- untouched instead of silently overwriting the edit — the "regenerate
      -- summary" action clears the lock and forces a fresh synthesis.
      generated_description_locked INTEGER NOT NULL DEFAULT 0,
      -- Whether this folder is eligible to be picked by an AUTOMATIC routing
      -- decision (the ingest router's folder catalog, the query classifier).
      -- A message that explicitly addresses the folder — a '#slug' pin, an
      -- MCP 'subgraph' arg, or a caller-picked destination — always reaches
      -- it regardless of this flag; those paths never consult it. Defaults to
      -- routable so existing folders are unaffected.
      routable     INTEGER NOT NULL DEFAULT 1,
      -- Folder-level privacy: the audience ('only_me' | 'private' | 'team')
      -- given to nodes captured into this folder when the ingest named no
      -- explicit audience. NULL = not set (the caller's fallback applies —
      -- the web app's is 'only_me', everything else stays 'team').
      default_audience TEXT,
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subgraphs_ws_slug ON subgraphs(workspace_id, slug);

    -- Per-(document, subgraph) routing record. Documents are workspace-shared
    -- (one upload), but a document is extracted/curated independently into each
    -- subgraph it routes to. routed_by records how the target was chosen.
    CREATE TABLE IF NOT EXISTS document_routing (
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id   TEXT NOT NULL,
      subgraph_id   TEXT NOT NULL,
      routed_by     TEXT NOT NULL DEFAULT 'router' CHECK (routed_by IN ('router','pinned','manual')),
      router_reason TEXT,
      -- The document's source-type AS CLASSIFIED AGAINST THIS SUBGRAPH's
      -- profile (each profile defines its own source_types). Captured for free
      -- from the per-subgraph extraction pass; per-subgraph triage keys
      -- commit_unit / currency / authority off it. NULL until capture runs or
      -- when the subgraph's profile has no matching type → triage falls back to
      -- the shared documents.source_type.
      source_type   TEXT,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, document_id, subgraph_id)
    );
    CREATE INDEX IF NOT EXISTS idx_doc_routing_ws_doc ON document_routing(workspace_id, document_id);

    -- A routing decision the router could not auto-apply: either it wants to
    -- create a brand-new folder, or its chosen existing folder has neither an
    -- owner description nor a generated content digest (routing blind). Held
    -- here instead of committing document_routing/capture until a human
    -- approves, chooses a different folder, or rejects it. See
    -- spec-pomegranate-light.md "Routing is the most important stage".
    CREATE TABLE IF NOT EXISTS pending_routes (
      workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id                      TEXT NOT NULL,
      document_id             TEXT NOT NULL,
      reason                  TEXT NOT NULL DEFAULT '',
      proposed_targets        TEXT NOT NULL DEFAULT '[]',
      proposed_new_folder     TEXT,
      low_confidence_targets  TEXT NOT NULL DEFAULT '[]',
      status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      resolved_by             TEXT,
      resolved_at             TEXT,
      created_at              TEXT NOT NULL,
      -- The audience the ORIGINAL ingest asked for, and who asked. Capture is
      -- deferred until the hold resolves, so without these the choice is lost
      -- and a privately-staged document would be captured team-visible on
      -- approval. NULL = pre-column row, or an ingest that named no audience.
      audience                TEXT,
      ingested_by             TEXT,
      -- The ingest's fallback audience (used only when neither audience
      -- nor the target folder's default_audience is set).
      fallback_audience       TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_routes_ws_doc ON pending_routes(workspace_id, document_id);

    -- Retired feature (recommendation cards). The tables stay so existing
    -- databases keep migrating cleanly; nothing reads or writes them now.
    CREATE TABLE IF NOT EXISTS workspace_recommendations (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id           TEXT NOT NULL,
      kind         TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed','superseded')),
      created_at   TEXT NOT NULL,
      resolved_at  TEXT,
      resolved_by  TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_recs_ws_status ON workspace_recommendations(workspace_id, status);

    CREATE TABLE IF NOT EXISTS recommendation_state (
      workspace_id   TEXT NOT NULL PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      node_watermark INTEGER NOT NULL DEFAULT 0,
      generated_at   TEXT
    );

  `);

  // Idempotent additive migrations: run after CREATE TABLE blocks above so
  // the target tables exist. SQLite has no `ALTER TABLE ADD COLUMN IF NOT
  // EXISTS`, hence the helper. Append-only; never rename or drop.
  addColumnIfMissing(db, 'graph_nodes', 'embedding', 'BLOB');
  // Human display name ("Alice Martin"), used by surfaces to resolve
  // teammate references. Not unique — ambiguity is handled at resolution time.
  addColumnIfMissing(db, 'users', 'display_name', 'TEXT');
  addColumnIfMissing(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  // The name this user calls their assistant on chat surfaces ("Mango"). Each
  // user picks their own — it is a personal wake name, not a team-wide one.
  addColumnIfMissing(db, 'users', 'assistant_nickname', 'TEXT');
  // Structured UI payload on a thread message (conversational curation):
  // {suggested_actions, item_list} rendered by the web client as inline
  // action buttons / item cards. NULL = plain text message.
  addColumnIfMissing(db, 'curation_messages', 'ui', 'TEXT');
  // The candidate ids the assessment was computed over (JSON array). Enables
  // shrink-reuse: when the current pending set is a SUBSET of these ids
  // (items resolved, nothing new), the assessment + answers are reused with
  // no LLM call — the doc's legitimacy/currency didn't change because an
  // item got approved. NULL = pre-reuse row; falls back to exact-signature.
  addColumnIfMissing(db, 'doc_triage', 'assessed_ids', 'TEXT');
  addColumnIfMissing(db, 'candidates', 'document_id', 'TEXT');
  addColumnIfMissing(db, 'graph_nodes', 'document_id', 'TEXT');
  // The router's content-aware source-type classification, persisted (it was
  // previously computed per-ingest and dropped). Context-aware triage keys
  // per-type behavior (commit_unit / currency / authority_kinds) off this.
  // NULL = pre-triage row or router returned no classification.
  addColumnIfMissing(db, 'documents', 'source_type', 'TEXT');
  // Recency of the last (re-)ingest, distinct from created_at (first-seen).
  // Bumped even on an idempotent re-ingest or extraction into a new subgraph,
  // so the Sources list can float a just-added source to the top the way the
  // Curate inbox does. NULL = pre-column row (Sources falls back to created_at).
  addColumnIfMissing(db, 'documents', 'last_ingested_at', 'TEXT');
  // Document audience (repo.documentVisibilityFilter): who ingested a document
  // and the audience they explicitly asked for. Only consulted for a document
  // that produced no notes — otherwise its notes' audiences decide.
  addColumnIfMissing(db, 'documents', 'ingested_by', 'TEXT');
  addColumnIfMissing(db, 'documents', 'audience', 'TEXT');
  // The ingest-time audience choice + the user who made it, held with the
  // routing decision so capture-on-resolve can honor it (see pending_routes).
  addColumnIfMissing(db, 'pending_routes', 'audience', 'TEXT');
  addColumnIfMissing(db, 'pending_routes', 'ingested_by', 'TEXT');
  addColumnIfMissing(db, 'pending_routes', 'fallback_audience', 'TEXT');
  // One-time backfill for pre-column rows: seed last_ingested_at from the most
  // recent candidate extracted from each document (a re-ingest — including into
  // a new subgraph — mints fresh candidates), so a source that was already
  // re-added surfaces by its real recency on first upgrade instead of its
  // first-seen date. Runs once (WHERE last_ingested_at IS NULL); new ingests
  // set the column, so they're excluded.
  db.exec(`
    UPDATE documents SET last_ingested_at = COALESCE(
      (SELECT MAX(c.created_at) FROM candidates c
         WHERE c.workspace_id = documents.workspace_id AND c.document_id = documents.id),
      created_at)
    WHERE last_ingested_at IS NULL
  `);
  // One-time backfill for graph_nodes.document_id (the column above, added
  // without a backfill). Nodes approved before the node→document linkage was
  // recorded have document_id = NULL, so the source-level sharing fan-out
  // (repo.listNodeIdsByDocument → POST .../sync/document/:id/visibility) finds
  // zero nodes and returns 404 "no nodes for document" even though the document
  // clearly produced nodes. Recover the linkage best-effort, in priority order:
  //   1. the candidate this node was approved from (post-column candidates that
  //      carry document_id, in case the node copy at approve time was missed),
  //   2. the evidence-ledger row for the node,
  //   3. the node's source_ref (from evidence, then candidate) matched to the
  //      LATEST document version with that ref — ancient nodes predate
  //      document_id everywhere, and the latest version is the row the Sources
  //      UI shares against (registerDocument mints a new id per changed version
  //      but keeps one row per source_ref for idempotent re-ingest).
  // Runs once per row (WHERE document_id IS NULL); new approvals set it directly.
  db.exec(`
    UPDATE graph_nodes SET document_id = COALESCE(
      (SELECT c.document_id FROM candidates c
         WHERE c.workspace_id = graph_nodes.workspace_id
           AND json_extract(c.proposed_node, '$.id') = graph_nodes.id
           AND c.document_id IS NOT NULL
         ORDER BY c.created_at DESC LIMIT 1),
      (SELECT ne.document_id FROM node_evidence ne
         WHERE ne.workspace_id = graph_nodes.workspace_id
           AND ne.node_id = graph_nodes.id
           AND ne.document_id IS NOT NULL
         ORDER BY ne.captured_at DESC LIMIT 1),
      (SELECT d.id FROM documents d
         WHERE d.workspace_id = graph_nodes.workspace_id
           AND d.source_ref = (
             SELECT ne.source_ref FROM node_evidence ne
               WHERE ne.workspace_id = graph_nodes.workspace_id
                 AND ne.node_id = graph_nodes.id
                 AND ne.source_ref IS NOT NULL
               ORDER BY ne.captured_at DESC LIMIT 1)
         ORDER BY d.version DESC LIMIT 1),
      (SELECT d.id FROM documents d
         WHERE d.workspace_id = graph_nodes.workspace_id
           AND d.source_ref = (
             SELECT c.source_ref FROM candidates c
               WHERE c.workspace_id = graph_nodes.workspace_id
                 AND json_extract(c.proposed_node, '$.id') = graph_nodes.id
                 AND c.source_ref IS NOT NULL
               ORDER BY c.created_at DESC LIMIT 1)
         ORDER BY d.version DESC LIMIT 1)
    )
    WHERE document_id IS NULL
  `);
  // by_owner: 1 when the request came from the workspace owner, else 0.
  // The ONLY identity-adjacent bit on the anonymized store, and a deliberate
  // one: it lets the usage-analysis narrative split "your own use" from
  // "your team's use". Owner texts are self-attributable (shown only to the
  // owner, about the owner); non-owner texts stay an undifferentiated pool.
  // NULL = recorded before this column existed (treated as team).
  addColumnIfMissing(db, 'context_request_texts', 'by_owner', 'INTEGER');
  // 2026-08: attributed usage now also carries the verbatim request text
  // (see the table comment above) — additive column for pre-existing rows.
  addColumnIfMissing(db, 'context_usage_log', 'request_text', 'TEXT');
  // Human-readable options of the call (filters, mode, date range) for the
  // Usage view's per-row sentence. Built from arguments only, never user text.
  addColumnIfMissing(db, 'context_usage_log', 'detail', 'TEXT');

  // Constraint migration: databases created before context profiles (spec B1)
  // still carry `CHECK (type IN ('goal','positioning','decision'))` on
  // graph_nodes — CREATE TABLE IF NOT EXISTS never alters an existing table.
  // On those DBs every approve of a non-founding kind (e.g. the product
  // profile's `competitor`) fails with a CHECK error. SQLite can't drop a
  // CHECK in place, so rebuild the table without it. Runs after
  // addColumnIfMissing so legacy DBs already have embedding/document_id.
  rebuildGraphNodesIfLegacyKindCheck(db);

  // Multi-subgraph partition (spec: multi-profile users). Each subgraph-local
  // table carries a `subgraph_id` defaulting to 'default'; a NOT NULL ADD
  // COLUMN with a DEFAULT backfills every existing row to 'default' in one
  // statement, so pre-feature workspaces become a single 'default' subgraph
  // with byte-identical behavior. Node/candidate/edge ids stay globally
  // unique, so subgraph_id is a column (not a PK member) on those tables.
  // Runs after rebuildGraphNodesIfLegacyKindCheck so the column isn't dropped
  // by that table rebuild.
  for (const table of [
    'graph_nodes',
    'candidates',
    'graph_edges',
    'node_evidence',
    'candidate_groups',
    'curation_messages',
    'context_usage_log',
    'context_request_texts',
  ]) {
    addColumnIfMissing(db, table, 'subgraph_id', "TEXT NOT NULL DEFAULT 'default'");
  }
  // Per-(document, subgraph) source-type classification (see table comment).
  addColumnIfMissing(db, 'document_routing', 'source_type', 'TEXT');

  // Per-subfolder descriptions (see the subgraphs CREATE TABLE comments).
  // `description` is user-authored and defaults to 'miscellaneous' so existing
  // subgraphs backfill to a sensible label in one statement. The generated_*
  // pair persists the LLM Overview summary per subfolder (NULL until synthesized).
  addColumnIfMissing(db, 'subgraphs', 'description', "TEXT NOT NULL DEFAULT 'miscellaneous'");
  addColumnIfMissing(db, 'subgraphs', 'generated_description', 'TEXT');
  addColumnIfMissing(db, 'subgraphs', 'generated_description_at', 'TEXT');
  // Manual-edit lock on generated_description, and the auto-routing eligibility
  // flag — both default to the pre-feature behaviour (unlocked / routable) so
  // existing subgraphs are unaffected. See the CREATE TABLE comments above.
  addColumnIfMissing(db, 'subgraphs', 'generated_description_locked', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'subgraphs', 'routable', 'INTEGER NOT NULL DEFAULT 1');
  // Folder-level default privacy (NULL = not set). See the CREATE TABLE comment.
  addColumnIfMissing(db, 'subgraphs', 'default_audience', 'TEXT');

  // Per-node sharing audience + owner (unified sharing model,
  // spec-unified-sharing-and-always-sync.md). Added AFTER
  // rebuildGraphNodesIfLegacyKindCheck so the rebuild can't drop them (same
  // reasoning as subgraph_id above).
  //   visibility: 'team'    — all workspace members + their agents (DEFAULT;
  //                           = today's cloud behavior, existing graphs unchanged)
  //               'private' — owner + owner's AI agents (the "AI agents" tier)
  //               'only_me' — owner in the app UI only; hidden from ALL LLM/agent
  //                           reads, including the owner's own (aiRead filter)
  //   owner_user_id: the member who owns a node; NULL for cloud-native nodes
  //                  (no owner gate — treated as team).
  addColumnIfMissing(db, 'graph_nodes', 'visibility', "TEXT NOT NULL DEFAULT 'team'");
  addColumnIfMissing(db, 'graph_nodes', 'owner_user_id', 'TEXT');
  // Use-phase ingestion-rule redaction (spec §5.3c). When a node is team-visible
  // and a `use`-phase redact rule applies, we materialize a redacted copy of its
  // node JSON here; reads by anyone OTHER than the owner serve this instead of
  // `data`. NULL = no redaction (serve the full `data`), so it's inert until a
  // rule produces a variant.
  addColumnIfMissing(db, 'graph_nodes', 'redacted_data', 'TEXT');

  // Migration off the removed "share with specific people" tier: collapse any
  // existing 'shared' nodes to 'team' and drop the node_shares ACL table.
  db.exec(`UPDATE graph_nodes SET visibility = 'team' WHERE visibility = 'shared'`);
  db.exec(`DROP TABLE IF EXISTS node_shares`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_sg_status ON graph_nodes(workspace_id, subgraph_id, status);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_sg_type ON graph_nodes(workspace_id, subgraph_id, type);
    CREATE INDEX IF NOT EXISTS idx_candidates_ws_sg_status ON candidates(workspace_id, subgraph_id, status);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_ws_sg_src ON graph_edges(workspace_id, subgraph_id, src);
    CREATE INDEX IF NOT EXISTS idx_node_evidence_ws_sg_node ON node_evidence(workspace_id, subgraph_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_curation_msgs_ws_sg_doc ON curation_messages(workspace_id, subgraph_id, document_id, created_at);
  `);

  // PK rebuilds for tables whose primary key must gain subgraph_id. These
  // tables are keyed by the SHARED document_id (or workspace alone), so two
  // subgraphs assessing/curating the same document would collide without
  // subgraph_id in the PK. Same SQLite 12-step rebuild as the kind-check fix.
  rebuildWorkspaceProfilesForSubgraphs(db);
  rebuildDocTriageForSubgraphs(db);
  rebuildCurationConversationsForSubgraphs(db);

  // Wiki (spec-wiki.md / wiki-milestones.md M1). A wiki is a generated,
  // editable read-projection of the node canon, one per (workspace, subgraph).
  // M1 stores structure only: a page tree (categories + pages, planner-proposed
  // then user-editable) with per-page planned `sections`; block bodies fill in
  // M2. Additive CREATE-only — no data migration needed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wikis (
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id    TEXT NOT NULL DEFAULT 'default',
      profile_id     TEXT NOT NULL,
      plan_signature TEXT,                 -- (profile + doc set + census) hash → replan trigger
      status         TEXT NOT NULL DEFAULT 'built' CHECK (status IN ('draft','built','stale')),
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subgraph_id)
    );

    -- The page tree. kind='category' rows are the (LLM-proposed, user-editable)
    -- grouping layer; kind='page' rows are articles. parent_id + sort_order give
    -- the orderable, reparent-able tree the /wiki UI edits directly. The sections
    -- column is the planned per-page section list [{key,heading,intent}] the M2
    -- fill pass populates; anchor ties a page to a kind+scope value / doc / overview.
    CREATE TABLE IF NOT EXISTS wiki_pages (
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id    TEXT NOT NULL DEFAULT 'default',
      id             TEXT NOT NULL,        -- wp_<nanoid>
      kind           TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('category','page')),
      parent_id      TEXT,                 -- null = top-level; else another wiki_page id
      slug           TEXT NOT NULL,
      title          TEXT NOT NULL,
      anchor         TEXT,                 -- JSON {kind?,scope_value?,doc_id?,overview?}
      sections       TEXT,                 -- JSON [{key,heading,intent}]
      source_doc_ids TEXT,                 -- JSON array of document ids
      sort_order     INTEGER NOT NULL DEFAULT 0,
      visibility     TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team','private','only_me')),
      owner_user_id  TEXT,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_pages_tree
      ON wiki_pages(workspace_id, subgraph_id, parent_id, sort_order);

    -- Filled content (M2+). Every prose block cites node ids (the trust chain);
    -- provenance/review_state carry the inference + update accept/reject model
    -- (spec section 7). Unused by the M1 read render (which shows planned
    -- sections placeholders) but created now so M2 has its target.
    CREATE TABLE IF NOT EXISTS wiki_blocks (
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      page_id        TEXT NOT NULL,
      id             TEXT NOT NULL,        -- wb_<nanoid>
      sort_order     INTEGER NOT NULL DEFAULT 0,
      type           TEXT NOT NULL,        -- heading|paragraph|list|node_ref|link|image|file|table
      content        TEXT NOT NULL,        -- JSON
      cited_node_ids TEXT,                 -- JSON array
      provenance     TEXT NOT NULL DEFAULT 'in_document', -- in_document|inferred|user
      review_state   TEXT NOT NULL DEFAULT 'accepted',    -- accepted|pending|rejected
      edited_by_user INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_blocks_page
      ON wiki_blocks(workspace_id, page_id, sort_order);
  `);
  // Currency (M4): the graph-change watermark the wiki was last built/filled
  // against. Drift = a node/document changed after this. Additive so a wiki
  // built by an M1–M3 database picks it up on next boot (null → treated stale
  // until the first refresh stamps it).
  addColumnIfMissing(db, 'wikis', 'content_watermark', 'TEXT');

  // Subscribe to Updates (spec-subscribe-to-updates.md / U1). Standing NL topic
  // watches with scheduled delivery — the push side of living context. A
  // subscription is USER-OWNED (may span the owner's folders); the scheduler
  // runs due watches, detects topical change since a watermark, synthesizes a
  // cited update, delivers it (email in U1), and keeps every delivery in-app
  // with view/engagement counts. Additive CREATE-only — no data migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS update_subscriptions (
      id              TEXT NOT NULL,        -- sub_<nanoid>
      owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic           TEXT NOT NULL,        -- the natural-language topic
      topic_embedding BLOB,                 -- Float32 (node-embedding dim) for relevance
      targets         TEXT NOT NULL,        -- JSON [{workspace_id, subgraph_id}] resolved at create time
      cadence_ms      INTEGER NOT NULL,     -- interval; clamped to [MIN,MAX]
      medium          TEXT NOT NULL DEFAULT 'email' CHECK (medium IN ('slack','email')),
      -- 'get' = the collab agent (I subscribe, updates come to me); 'give' = the
      -- work agent (I broadcast updates about MY OWN folder to teammates). Same
      -- machinery end to end; the kind only partitions the two agents' lists.
      kind            TEXT NOT NULL DEFAULT 'get' CHECK (kind IN ('get','give')),
      -- Recipients, comma-separated: email addrs / slack channel|DM ids. One
      -- value for a 'get' watch (null = owner default); a list for a 'give' one.
      destination     TEXT,
      -- 'autonomous' sends the synthesized update straight away; 'review' holds it
      -- as a PENDING delivery and notifies the owner to approve before it is sent.
      approval_mode   TEXT NOT NULL DEFAULT 'autonomous' CHECK (approval_mode IN ('autonomous','review')),
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
      last_run_at     TEXT,
      next_run_at     TEXT NOT NULL,
      watermark       TEXT,                 -- ISO cutoff: only changes strictly after this are reported
      fail_count      INTEGER NOT NULL DEFAULT 0,   -- drives backoff
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_update_subs_due ON update_subscriptions(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_update_subs_owner ON update_subscriptions(owner_user_id);

    CREATE TABLE IF NOT EXISTS update_deliveries (
      id              TEXT NOT NULL,        -- upd_<nanoid>
      subscription_id TEXT NOT NULL REFERENCES update_subscriptions(id) ON DELETE CASCADE,
      owner_user_id   TEXT NOT NULL,
      window_from     TEXT,                 -- watermark at run start (null = first run)
      window_to       TEXT NOT NULL,        -- new watermark
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,        -- rendered update (markdown/text)
      -- Delivery lifecycle: 'sent' (autonomous or approved & delivered),
      -- 'pending' (review-mode, awaiting owner approval), 'discarded' (owner
      -- rejected the pending update). delivered_at still stamps the actual send.
      status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','discarded')),
      cited_node_ids  TEXT,                 -- JSON — the trust chain
      change_count    INTEGER NOT NULL DEFAULT 0,   -- nodes/docs that moved this window
      medium          TEXT NOT NULL,
      delivered_at    TEXT,                 -- null until send succeeds
      delivery_error  TEXT,
      view_count      INTEGER NOT NULL DEFAULT 0,   -- engagement
      click_count     INTEGER NOT NULL DEFAULT 0,
      opened_at       TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_update_deliveries_sub ON update_deliveries(subscription_id, created_at);
  `);
  // Per-watch approval workflow: databases created before this column get it
  // idempotently. Existing subscriptions default to autonomous (prior behavior);
  // existing deliveries are historical sends, so default 'sent' is correct.
  addColumnIfMissing(
    db,
    'update_subscriptions',
    'approval_mode',
    `TEXT NOT NULL DEFAULT 'autonomous' CHECK (approval_mode IN ('autonomous','review'))`,
  );
  addColumnIfMissing(
    db,
    'update_deliveries',
    'status',
    `TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','discarded'))`,
  );
  // The 'give' work agent (broadcast my own work to teammates) rides the same
  // table as the 'get' collab agent. Pre-existing rows are all 'get' watches.
  addColumnIfMissing(
    db,
    'update_subscriptions',
    'kind',
    `TEXT NOT NULL DEFAULT 'get' CHECK (kind IN ('get','give'))`,
  );
  // "Reached" vs "actually used" for an MCP credential. `last_used_at` is
  // stamped when the credential RESOLVES — before the transport is even known
  // to be a valid MCP call — so a client validating a pasted connector flips
  // it. These record a real tools/call instead, which is what Get started's
  // green "your assistant used it" state means. Pre-existing rows stay NULL:
  // an old connector shows as reached until its owner's assistant calls again.
  addColumnIfMissing(db, 'mcp_tokens', 'last_tool_call_at', 'TEXT');
  addColumnIfMissing(db, 'claude_ai_connectors', 'last_tool_call_at', 'TEXT');
  // Pending deliveries are queried for the owner's approval queue + nav badge.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_update_deliveries_owner_status ON update_deliveries(owner_user_id, status);`,
  );

  // Saved recipient lists for the 'give' agent — name a group of teammates once
  // ("the design team") and reuse it across broadcasts instead of retyping the
  // addresses. Owner-scoped like the subscriptions they serve, and additionally
  // workspace-scoped: a list is authored in, and belongs to, one folder.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipient_lists (
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,        -- rcp_<nanoid>
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,        -- what the owner calls this group
      recipients    TEXT NOT NULL,        -- JSON string[] of email addrs
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_recipient_lists_owner
      ON recipient_lists(workspace_id, owner_user_id, name);
  `);

  // Data agents (spec-data-agents-and-subfolder-wiki.md). A workspace's own
  // custom templates — built-ins ship as code (lib/profiles/templates/*.ts),
  // mirroring BUILTIN_PROFILES; only custom ones need a row. `profile` is the
  // AUTHORED (Tier A/B) fields only — Tier C is regenerated at read time by
  // resolveDataAgentTemplate, never stored, so a validator fix upstream
  // reaches every stored custom template on next read without a migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_agent_templates (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id           TEXT NOT NULL,        -- tpl_<nanoid>
      name         TEXT NOT NULL,
      profile      TEXT NOT NULL,        -- authored ContextProfile fields (Tier A/B), JSON
      forked_from  TEXT,                 -- template id this was "Save as new" from, if any
      created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);

  // One binding per subfolder — the schema's own PK enforces "one agent at a
  // time" (spec §6, locked in scoping) structurally, not just in application
  // logic. `template` is a FROZEN resolved-ContextProfile snapshot at
  // attach/change time (same snapshot discipline as workspace_profiles) so a
  // template edit never silently reaches an attached folder (spec §5.3) —
  // reaching it is the explicit "push to folders using this template" action.
  // status='detached' rows are kept, not deleted: capture reads only
  // status='active' (i.e. `WHERE status = 'active'`, never a bare row-exists
  // check), and the detached row is the record of "this folder used to have
  // an agent" for the Library dot / Setup list to reason about later.
  db.exec(`
    CREATE TABLE IF NOT EXISTS subfolder_data_agents (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id  TEXT NOT NULL,
      template_id  TEXT NOT NULL,        -- built-in template key, or data_agent_templates.id
      template     TEXT NOT NULL,        -- frozen resolved ContextProfile JSON snapshot
      cadence      TEXT NOT NULL DEFAULT 'per_document' CHECK (cadence IN ('once','per_document','scheduled')),
      cadence_ms   INTEGER,              -- only meaningful when cadence = 'scheduled'
      status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','detached')),
      attached_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      attached_at  TEXT NOT NULL,
      detached_at  TEXT,
      last_run_at  TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subgraph_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subfolder_data_agents_active
      ON subfolder_data_agents(workspace_id, subgraph_id, status);
  `);

  // The Report (spec-data-agents-and-subfolder-wiki.md §4.3) — ONE row per
  // subfolder, replaced wholesale on each generate. Deliberately NOT the
  // wiki's page-tree model: a single current-state document, synthesized
  // fresh every time from whichever taxonomy currently governs the folder
  // (baseline notes, or an attached agent's kinds) — no planning, no diffing,
  // no per-block review state. `content` is the full ReportContent JSON
  // (phase1/report/types.ts): one section per kind, each split into groups
  // (buckets, or needs-attention/settled, or one flat group).
  db.exec(`
    CREATE TABLE IF NOT EXISTS subfolder_reports (
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id   TEXT NOT NULL,
      content       TEXT NOT NULL,        -- ReportContent JSON
      generated_at  TEXT NOT NULL,
      PRIMARY KEY (workspace_id, subgraph_id)
    );
  `);

  // Data cleanup, not a schema change: auto_approve/auto_reject/surface were
  // removed as a live action (they never applied to a real document — the
  // product auto-applies every capture immediately). Normalize any stale rows
  // from before the removal so nothing keeps displaying a dead disposition.
  db.exec(`
    UPDATE rules SET action = 'shape' WHERE action IS NOT NULL AND action != 'shape';
    UPDATE automations SET action = 'shape' WHERE action IS NOT NULL AND action != 'shape';
  `);

  // WhatsApp surface (surfaces/whatsapp): widen the identity-kind and
  // default-surface CHECK constraints to admit 'whatsapp' alongside 'slack'.
  rebuildUserIdentitiesForWhatsapp(db);
  rebuildUserDefaultsForWhatsapp(db);

  // Directory-wide AI access. Existing directories retain their current access.
  addColumnIfMissing(db, 'workspaces', 'ai_allowed', 'INTEGER NOT NULL DEFAULT 1');
  // Idle timeout: when the session was last used (NULL = never since this
  // column was added; the created_at stands in).
  addColumnIfMissing(db, 'sessions', 'last_seen_at', 'TEXT');
  // The workspace whose key sealed an agent-thread message (C3). A thread can
  // be re-pointed at another folder, so each message records its own; also
  // lets deletion sweep a workspace's messages directly. NULL on old rows.
  addColumnIfMissing(db, 'agent_thread_messages', 'workspace_id', 'TEXT');
  // A session minted for a user who must enrol in MFA (MFA_REQUIRED policy)
  // but hasn't yet: it can only reach the enrolment endpoints.
  addColumnIfMissing(db, 'sessions', 'mfa_enrollment_required', 'INTEGER NOT NULL DEFAULT 0');
  // Accounts that enrolled an authenticator app under the earlier TOTP version
  // keep a second factor: they move to the emailed link. Idempotent.
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_mfa'`).get()) {
    db.exec(`INSERT OR IGNORE INTO user_email_mfa (user_id, enabled_at)
             SELECT user_id, enabled_at FROM user_mfa WHERE enabled_at IS NOT NULL`);
  }
  // A password set by an administrator must be replaced by its owner at first
  // use; the session that signs in with it can only reach the change-password
  // endpoint until they do.
  addColumnIfMissing(db, 'user_passwords', 'must_change', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'sessions', 'password_change_required', 'INTEGER NOT NULL DEFAULT 0');
  // Directory governance (phase1/governance.ts): a viewer flag on
  // the membership (the role CHECK can't be widened additively) and three
  // per-directory flags. All default 0 = existing behaviour.
  addColumnIfMissing(db, 'memberships', 'read_only', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'workspaces', 'sensitive', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'workspaces', 'assistants_allowed', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'workspaces', 'agents_read_only', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'sessions', 'via_sso', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'users', 'disabled_at', 'TEXT');
  addColumnIfMissing(db, 'oauth_grants', 'last_used_at', 'TEXT');
  addColumnIfMissing(db, 'oauth_grants', 'last_tool_call_at', 'TEXT');
  // Sessions from before the column count as seen at this boot, so adding the
  // idle timeout doesn't sign out active users whose sessions are older than
  // the idle window. New sessions always set it, so this is a one-time fill.
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE last_seen_at IS NULL`).run(new Date().toISOString());
  hashPlaintextSessionTokens(db);
}

/**
 * Session tokens are stored hashed (`h:` + sha256 hex), like MCP tokens, so a
 * copy of the database or a backup doesn't hand out live sign-ins. Rows from
 * before hashing hold the raw `sess_…` token: hash them in place. Idempotent
 * (hashed rows never start with `sess_`), and existing sign-ins keep working
 * because lookups hash the presented token the same way.
 */
export function sessionTokenKey(token: string): string {
  return 'h:' + createHash('sha256').update(token).digest('hex');
}

function hashPlaintextSessionTokens(db: Database.Database): void {
  const plain = db
    .prepare(`SELECT token FROM sessions WHERE substr(token, 1, 5) = 'sess_'`)
    .all() as Array<{ token: string }>;
  if (plain.length === 0) return;
  const update = db.prepare(`UPDATE sessions SET token = ? WHERE token = ?`);
  db.transaction(() => {
    for (const { token } of plain) update.run(sessionTokenKey(token), token);
  })();
}

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  migrate(db);
  return db;
}

/**
 * Idempotent `ALTER TABLE ADD COLUMN`. SQLite doesn't support `IF NOT EXISTS`
 * for columns, so we check `PRAGMA table_info` first. Used for additive
 * schema migrations so existing databases pick up new fields on next boot.
 */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * One-time table rebuild for pre-profile databases whose graph_nodes still
 * has the founding-only kind CHECK. Detected via the stored DDL in
 * sqlite_master; no-op on current databases. The standard SQLite "12-step"
 * rebuild: copy into a new table with the current DDL, drop, rename,
 * recreate indexes — all in one transaction, with FKs off so the drop
 * doesn't cascade-check.
 */
function rebuildGraphNodesIfLegacyKindCheck(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'graph_nodes'`)
    .get() as { sql: string } | undefined;
  if (!row || !/CHECK\s*\(\s*type\s+IN/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE graph_nodes_rebuild (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded TEXT,
      embedding BLOB,
      document_id TEXT,
      PRIMARY KEY (workspace_id, id)
    );
    INSERT INTO graph_nodes_rebuild
      (id, workspace_id, type, status, data, created_at, updated_at, superseded, embedding, document_id)
      SELECT id, workspace_id, type, status, data, created_at, updated_at, superseded, embedding, document_id
      FROM graph_nodes;
    DROP TABLE graph_nodes;
    ALTER TABLE graph_nodes_rebuild RENAME TO graph_nodes;
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_status ON graph_nodes(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_ws_type ON graph_nodes(workspace_id, type);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Rebuild `workspace_profiles` to key on (workspace_id, subgraph_id). Pre-
 * multi-subgraph DBs have PK (workspace_id) and no subgraph_id column; detected
 * by the absence of 'subgraph_id' in the stored DDL. Existing rows backfill to
 * subgraph_id='default'. No-op once rebuilt.
 */
function rebuildWorkspaceProfilesForSubgraphs(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_profiles'`)
    .get() as { sql: string } | undefined;
  if (!row || /subgraph_id/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE workspace_profiles_rebuild (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id  TEXT NOT NULL DEFAULT 'default',
      profile_id   TEXT NOT NULL,
      profile      TEXT NOT NULL,
      created_at   INTEGER,
      updated_at   INTEGER,
      PRIMARY KEY (workspace_id, subgraph_id)
    );
    INSERT INTO workspace_profiles_rebuild
      (workspace_id, subgraph_id, profile_id, profile, created_at, updated_at)
      SELECT workspace_id, 'default', profile_id, profile, created_at, updated_at
      FROM workspace_profiles;
    DROP TABLE workspace_profiles;
    ALTER TABLE workspace_profiles_rebuild RENAME TO workspace_profiles;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Rebuild `doc_triage` to key on (workspace_id, document_id, subgraph_id,
 * signature). The shared document_id means two subgraphs assessing the same
 * document would collide on the old PK. Runs after the assessed_ids ADD COLUMN.
 */
function rebuildDocTriageForSubgraphs(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'doc_triage'`)
    .get() as { sql: string } | undefined;
  if (!row || /subgraph_id/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE doc_triage_rebuild (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      subgraph_id TEXT NOT NULL DEFAULT 'default',
      signature TEXT NOT NULL,
      assessment TEXT NOT NULL,
      answers TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','committed','discarded')),
      assessed_ids TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, document_id, subgraph_id, signature)
    );
    INSERT INTO doc_triage_rebuild
      (workspace_id, document_id, subgraph_id, signature, assessment, answers, status, assessed_ids, created_at, updated_at)
      SELECT workspace_id, document_id, 'default', signature, assessment, answers, status, assessed_ids, created_at, updated_at
      FROM doc_triage;
    DROP TABLE doc_triage;
    ALTER TABLE doc_triage_rebuild RENAME TO doc_triage;
    CREATE INDEX IF NOT EXISTS idx_doc_triage_ws_doc ON doc_triage(workspace_id, document_id);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Rebuild `curation_conversations` to key on (workspace_id, document_id,
 * subgraph_id). Curation is subgraph-local, so the same document carries an
 * independent conversation per subgraph it routed to.
 */
function rebuildCurationConversationsForSubgraphs(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'curation_conversations'`)
    .get() as { sql: string } | undefined;
  if (!row || /subgraph_id/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE curation_conversations_rebuild (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      subgraph_id TEXT NOT NULL DEFAULT 'default',
      case_opened TEXT NOT NULL CHECK (case_opened IN ('1','2','3')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, document_id, subgraph_id)
    );
    INSERT INTO curation_conversations_rebuild
      (workspace_id, document_id, subgraph_id, case_opened, status, created_at, updated_at)
      SELECT workspace_id, document_id, 'default', case_opened, status, created_at, updated_at
      FROM curation_conversations;
    DROP TABLE curation_conversations;
    ALTER TABLE curation_conversations_rebuild RENAME TO curation_conversations;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Rebuild `user_identities` for pre-WhatsApp databases whose `kind` CHECK
 * still only admits 'slack'. Detected via the stored DDL; no-op once
 * rebuilt (or on a fresh DB, which is created with the current CHECK
 * already). Same 12-step rebuild as the other CHECK-widening migrations.
 */
function rebuildUserIdentitiesForWhatsapp(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_identities'`)
    .get() as { sql: string } | undefined;
  if (!row || /kind\s+IN\s*\(\s*'slack'\s*,\s*'whatsapp'\s*\)/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE user_identities_rebuild (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('slack','whatsapp')),
      team_id     TEXT,
      external_id TEXT NOT NULL,
      handle      TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE (kind, team_id, external_id)
    );
    INSERT INTO user_identities_rebuild
      (id, user_id, kind, team_id, external_id, handle, created_at)
      SELECT id, user_id, kind, team_id, external_id, handle, created_at
      FROM user_identities;
    DROP TABLE user_identities;
    ALTER TABLE user_identities_rebuild RENAME TO user_identities;
    CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

/**
 * Rebuild `user_defaults` for pre-WhatsApp databases whose `surface` CHECK
 * doesn't yet admit 'whatsapp'. Same detect-and-rebuild pattern.
 */
function rebuildUserDefaultsForWhatsapp(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_defaults'`)
    .get() as { sql: string } | undefined;
  if (!row || /'whatsapp'/i.test(row.sql)) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE user_defaults_rebuild (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      surface      TEXT NOT NULL CHECK (surface IN ('all','slack','mcp','whatsapp')),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      subgraph_id  TEXT,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (user_id, surface)
    );
    INSERT INTO user_defaults_rebuild
      (user_id, surface, workspace_id, subgraph_id, updated_at)
      SELECT user_id, surface, workspace_id, subgraph_id, updated_at
      FROM user_defaults;
    DROP TABLE user_defaults;
    ALTER TABLE user_defaults_rebuild RENAME TO user_defaults;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
