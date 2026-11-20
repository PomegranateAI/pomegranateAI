// Repo methods: users, workspaces, passwords, identities + defaults, surface-agent threads, sessions, MCP tokens, claude.ai connectors, audit, workspace deletion, customer audit.
// Split from repo.ts.
// Methods take `this: Repo` so they can call across modules; repo.ts
// mixes every module class into Repo, so callers still use `repo.method()`.

import { nanoid } from 'nanoid';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { log } from '../../../lib/log.js';
import { forwardAudit } from '../../../lib/audit-stream.js';
import {
  normalizePhoneDigits,
  Workspace,
  User,
  UserIdentity,
  DefaultSurface,
  UserDefault,
  AgentThread,
  Membership,
  AuditEntry,
  CustomerAuditEvent,
  CustomerAuditEntry,
  CustomerAuditRow,
  sha256,
} from './shared.js';
import type { SqlValue } from '../../../platform/db.js';
import type { Repo } from '../repo.js';
import { sessionTokenKey } from '../schema.js';
import { openText, sealText } from './sealing.js';


/**
 * Session limits, read per call so an operator's env applies without code and
 * tests can vary it. Defaults keep the hosted product's behaviour (14-day
 * sessions) and add a 7-day idle timeout; an on-prem deployment typically sets
 * SESSION_TTL_HOURS=12 and SESSION_IDLE_MINUTES=60.
 */
/**
 * Failed sign-ins per account: alert (audit + log) at AUTH_ALERT_FAILURES in a
 * window, lock password and second-factor sign-in for AUTH_LOCK_MINUTES at
 * AUTH_LOCK_FAILURES. Magic-link sign-in is not locked: it proves control of
 * the mailbox, and leaves the owner a way in while someone hammers the
 * password.
 */
export function authFailurePolicy(): { windowMs: number; alertAt: number; lockAt: number; lockMs: number } {
  const n = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  return {
    windowMs: 15 * 60_000,
    alertAt: n(process.env.AUTH_ALERT_FAILURES, 5),
    lockAt: n(process.env.AUTH_LOCK_FAILURES, 10),
    lockMs: n(process.env.AUTH_LOCK_MINUTES, 15) * 60_000,
  };
}

function sessionPolicy(): { ttlSec: number; idleSec: number } {
  const ttlHours = Number(process.env.SESSION_TTL_HOURS);
  const idleMinutes = Number(process.env.SESSION_IDLE_MINUTES);
  return {
    ttlSec: (ttlHours > 0 ? ttlHours : 14 * 24) * 3600,
    idleSec: (idleMinutes > 0 ? idleMinutes : 7 * 24 * 60) * 60,
  };
}

/** Shared filter for listing and counting a workspace's customer audit rows. */
function customerAuditWhere(
  workspace_id: string,
  opts: { since?: string; event?: CustomerAuditEvent },
): { where: string[]; params: SqlValue[] } {
  const where = ['workspace_id = ?'];
  const params: SqlValue[] = [workspace_id];
  if (opts.since) {
    where.push('created_at >= ?');
    params.push(opts.since);
  }
  if (opts.event) {
    where.push('event = ?');
    params.push(opts.event);
  }
  return { where, params };
}

/** The workspaces table keeps a legacy `plan` column (migrations are additive
 *  only); it is never read and never returned. */
function withoutLegacyPlan<T>(rows: T[]): T[] {
  return rows.map((r) => {
    const { plan: _legacy, ...rest } = r as Record<string, unknown>;
    return rest as T;
  });
}

export class IdentityRepo {
  // ---------- workspaces / users ----------

  async createWorkspace(this: Repo, opts: { name: string; owner_email: string }): Promise<Workspace> {
    const id = `ws_${nanoid(10)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO workspaces (id, name, owner_email, created_at) VALUES (?, ?, ?, ?)`, [id, opts.name, opts.owner_email, now]));

    // Auto-create the owner user + admin membership
    const user = await this.findOrCreateUser(opts.owner_email);
    (await this.sql.exec(`INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'workspace_admin', ?)`, [id, user.id, now]));
    // Every workspace starts with a single 'default' subgraph so all
    // subgraph-keyed reads/writes resolve identically pre-feature.
    await this.ensureDefaultSubgraph(id);
    await this.logAudit(id, {
      actor: user.id,
      event: 'workspace.created',
      resource_type: 'workspace',
      resource_id: id,
    });
    return { id, name: opts.name, owner_email: opts.owner_email, created_at: now };
  }

  /**
   * Idempotently create a workspace with a FIXED id (createWorkspace mints a
   * random one). Used by single-user mode, which has exactly one
   * implicit owner + workspace ("local") and no signup flow. Seeds the owner
   * user, admin membership, default subgraph, and the given context profile.
   */
  async ensureFixedWorkspace(this: Repo, opts: {
    id: string;
    owner_email: string;
    name?: string;
    profile_id: string;
    profile: ContextProfileT;
  }): Promise<void> {
    if (await this.getWorkspace(opts.id)) return;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO workspaces (id, name, owner_email, plan, created_at) VALUES (?, ?, ?, 'local', ?)`, [opts.id, opts.name ?? 'Local', opts.owner_email, now]));
    const user = await this.findOrCreateUser(opts.owner_email);
    (await this.sql.exec(`INSERT OR IGNORE INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'workspace_admin', ?)`, [opts.id, user.id, now]));
    await this.ensureDefaultSubgraph(opts.id);
    await this.setWorkspaceProfile(opts.id, opts.profile_id, opts.profile);
  }

  async getWorkspace(this: Repo, id: string): Promise<Workspace | undefined> {
    const row = await this.sql.one<any>(`SELECT * FROM workspaces WHERE id = ?`, [id]);
    return row ? (withoutLegacyPlan([row])[0] as Workspace) : undefined;
  }

  async setWorkspaceAiAllowed(this: Repo, workspace_id: string, allowed: boolean): Promise<void> {
    await this.sql.exec(`UPDATE workspaces SET ai_allowed = ? WHERE id = ?`, [allowed ? 1 : 0, workspace_id]);
  }

  /** Case-insensitive lookup, no side effects — the closed-signup gate must be
   *  able to ask "does this account exist?" without minting one. */
  async findUserByEmail(this: Repo, email: string): Promise<User | undefined> {
    return (await this.sql.one<any>(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`, [email.toLowerCase()])) as User | undefined;
  }

  async findOrCreateUser(this: Repo, email: string): Promise<User> {
    // Email is case-insensitive as an identity key: match any existing row
    // regardless of case (so "Sam@X" and "sam@x" resolve to ONE user), and
    // store new rows lowercased so future exact-case lookups elsewhere agree.
    const normalized = email.toLowerCase();
    const existing = (await this.sql.one<any>(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`, [normalized])) as User | undefined;
    if (existing) return existing;
    const id = `u_${nanoid(10)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)`, [id, normalized, now]));
    return { id, email: normalized, created_at: now };
  }

  async addMember(this: Repo, opts: {
    workspace_id: string;
    user_id: string;
    role: Membership['role'];
  }): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`, [opts.workspace_id, opts.user_id, opts.role, now]));
  }

  /** Change a member's role and viewer flag (governance.ts). */
  async setMemberAccess(this: Repo, workspace_id: string, user_id: string, role: Membership['role'], read_only: boolean): Promise<void> {
    await this.sql.exec(`UPDATE memberships SET role = ?, read_only = ? WHERE workspace_id = ? AND user_id = ?`, [role, read_only ? 1 : 0, workspace_id, user_id]);
  }

  /** Set the directory governance flags (governance.ts). */
  async setWorkspaceGovernance(this: Repo, workspace_id: string, flags: { sensitive: boolean; assistants_allowed: boolean; agents_read_only: boolean }): Promise<void> {
    await this.sql.exec(`UPDATE workspaces SET sensitive = ?, assistants_allowed = ?, agents_read_only = ? WHERE id = ?`, [
      flags.sensitive ? 1 : 0,
      flags.assistants_allowed ? 1 : 0,
      flags.agents_read_only ? 1 : 0,
      workspace_id,
    ]);
  }

  async getMembership(this: Repo, workspace_id: string, user_id: string): Promise<Membership | undefined> {
    return (await this.sql.one<any>(`SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?`, [workspace_id, user_id])) as Membership | undefined;
  }

  /** Remove a member from a workspace. No-op if they weren't a member. */
  async removeMember(this: Repo, workspace_id: string, user_id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?`, [workspace_id, user_id]));
    // A default-folder pointer into a directory you've left would route your
    // Slack/MCP/WhatsApp writes to a place you can no longer reach.
    (await this.sql.exec(`DELETE FROM user_defaults WHERE workspace_id = ? AND user_id = ?`, [workspace_id, user_id]));
  }

  async getUserById(this: Repo, user_id: string): Promise<User | undefined> {
    return (await this.sql.one<any>(`SELECT * FROM users WHERE id = ?`, [user_id])) as User | undefined;
  }

  async listAdminUsers(this: Repo): Promise<Array<{ id: string; email: string; is_admin: number; created_at: string; has_password: number; workspace_count: number }>> {
    return await this.sql.query<any>(`SELECT u.id, u.email, u.is_admin, u.created_at,
      CASE WHEN p.user_id IS NULL THEN 0 ELSE 1 END AS has_password,
      (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS workspace_count
      FROM users u LEFT JOIN user_passwords p ON p.user_id = u.id ORDER BY u.created_at DESC`);
  }

  async listOwnedWorkspaces(this: Repo, email: string): Promise<Array<{ id: string; name: string; member_count: number }>> {
    return await this.sql.query<any>(`SELECT w.id, w.name,
      (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id) AS member_count
      FROM workspaces w WHERE LOWER(w.owner_email) = ?`, [email.toLowerCase()]);
  }

  async deleteAdminUser(this: Repo, id: string): Promise<void> {
    await this.sql.exec(`DELETE FROM users WHERE id = ?`, [id]);
  }

  // ---------- password sign-in (alongside magic-link) ----------
  // Deliberately a separate table from `users` — see the user_passwords
  // CREATE TABLE comment in schema.ts. Callers pass an already-hashed value
  // (lib/passwords.ts hashPassword); the repo never sees plaintext.

  /** Store a password hash. `mustChange` marks an administrator-set password
   *  the owner has to replace at first sign-in; a password the owner sets
   *  themselves clears the flag (and the restriction on their sessions). */
  async setPasswordHash(this: Repo, user_id: string, password_hash: string, opts: { mustChange?: boolean } = {}): Promise<void> {
    const now = new Date().toISOString();
    const mustChange = opts.mustChange ? 1 : 0;
    await this.sql.tx(async () => {
      await this.sql.exec(`INSERT INTO user_passwords (user_id, password_hash, updated_at, must_change) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at, must_change = excluded.must_change`, [user_id, password_hash, now, mustChange]);
      // An owner-set password also completes required-MFA enrolment: from now
      // on the account signs in with password + emailed link.
      if (!mustChange) await this.sql.exec(`UPDATE sessions SET password_change_required = 0, mfa_enrollment_required = 0 WHERE user_id = ?`, [user_id]);
    });
  }

  async passwordMustChange(this: Repo, user_id: string): Promise<boolean> {
    const row = (await this.sql.one<any>(`SELECT must_change FROM user_passwords WHERE user_id = ?`, [user_id])) as { must_change: number } | undefined;
    return !!row?.must_change;
  }

  // ---------- failed sign-in tracking (per account) ----------

  /** Record one failed attempt. Returns the count in the current window, and
   *  whether this attempt crossed the alert threshold (once per window). */
  async recordAuthFailure(this: Repo, user_id: string, policy = authFailurePolicy()): Promise<{ failures: number; alert: boolean; locked: boolean }> {
    const now = Date.now();
    const row = (await this.sql.one<any>(`SELECT window_start, failures, alerted FROM user_auth_failures WHERE user_id = ?`, [user_id])) as
      | { window_start: string; failures: number; alerted: number }
      | undefined;
    const fresh = !row || now - Date.parse(row.window_start) > policy.windowMs;
    const failures = fresh ? 1 : row!.failures + 1;
    const alert = failures >= policy.alertAt && (fresh || !row!.alerted);
    const locked = failures >= policy.lockAt;
    await this.sql.exec(`INSERT INTO user_auth_failures (user_id, window_start, failures, alerted, locked_until) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures,
           alerted = excluded.alerted, locked_until = COALESCE(excluded.locked_until, user_auth_failures.locked_until)`, [
      user_id,
      fresh ? new Date(now).toISOString() : row!.window_start,
      failures,
      alert || (!fresh && row!.alerted) ? 1 : 0,
      locked ? new Date(now + policy.lockMs).toISOString() : null,
    ]);
    return { failures, alert, locked };
  }

  async isAuthLocked(this: Repo, user_id: string): Promise<boolean> {
    const row = (await this.sql.one<any>(`SELECT locked_until FROM user_auth_failures WHERE user_id = ?`, [user_id])) as { locked_until: string | null } | undefined;
    return !!row?.locked_until && Date.parse(row.locked_until) > Date.now();
  }

  async clearAuthFailures(this: Repo, user_id: string): Promise<void> {
    await this.sql.exec(`DELETE FROM user_auth_failures WHERE user_id = ?`, [user_id]);
  }

  async getPasswordHash(this: Repo, user_id: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT password_hash FROM user_passwords WHERE user_id = ?`, [user_id])) as
      | { password_hash: string }
      | undefined;
    return row?.password_hash;
  }

  async hasPassword(this: Repo, user_id: string): Promise<boolean> {
    return await this.getPasswordHash(user_id) !== undefined;
  }

  async clearPassword(this: Repo, user_id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM user_passwords WHERE user_id = ?`, [user_id]));
  }

  // ---------- second factor (emailed link after the password) ----------

  async emailMfaEnabled(this: Repo, user_id: string): Promise<boolean> {
    return !!(await this.sql.one<any>(`SELECT 1 AS x FROM user_email_mfa WHERE user_id = ?`, [user_id]));
  }

  async enableEmailMfa(this: Repo, user_id: string): Promise<void> {
    await this.sql.exec(`INSERT INTO user_email_mfa (user_id, enabled_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING`, [user_id, new Date().toISOString()]);
  }

  /** Turn it off (user disable, or operator reset); pending links die too. */
  async disableEmailMfa(this: Repo, user_id: string): Promise<void> {
    await this.sql.tx(async () => {
      await this.sql.exec(`DELETE FROM user_email_mfa WHERE user_id = ?`, [user_id]);
      await this.sql.exec(`DELETE FROM mfa_challenges WHERE user_id = ?`, [user_id]);
    });
  }

  async createMfaChallenge(this: Repo, user_id: string, method: string, ttlSec = 10 * 60): Promise<string> {
    const token = `mfa_${nanoid(32)}`;
    const now = Date.now();
    // Housekeeping: expired challenges are useless; drop them as we go.
    await this.sql.exec(`DELETE FROM mfa_challenges WHERE expires_at < ?`, [new Date(now).toISOString()]);
    await this.sql.exec(`INSERT INTO mfa_challenges (token_hash, user_id, method, attempts, expires_at) VALUES (?, ?, ?, 0, ?)`, [sha256(token), user_id, method, new Date(now + ttlSec * 1000).toISOString()]);
    return token;
  }

  /** A forgotten-password link for this account. Replaces any earlier one, so
   *  only the newest email works. Stored as a hash, like sessions. */
  async createPasswordResetToken(this: Repo, user_id: string, ttlSec = 30 * 60): Promise<string> {
    const token = `pwr_${nanoid(32)}`;
    const now = Date.now();
    await this.sql.exec(`DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < ?`, [user_id, new Date(now).toISOString()]);
    await this.sql.exec(`INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)`, [
      sha256(token),
      user_id,
      new Date(now + ttlSec * 1000).toISOString(),
    ]);
    return token;
  }

  /** Spend a forgotten-password link: the account it names, or undefined when
   *  unknown, used or expired. Conditional delete → single use under races. */
  async takePasswordResetToken(this: Repo, token: string): Promise<string | undefined> {
    const key = sha256(token);
    const row = (await this.sql.one<any>(`SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?`, [key])) as
      | { user_id: string; expires_at: string }
      | undefined;
    if (!row) return undefined;
    const r = await this.sql.exec(`DELETE FROM password_reset_tokens WHERE token_hash = ?`, [key]);
    if (r.changes !== 1 || Date.parse(row.expires_at) <= Date.now()) return undefined;
    return row.user_id;
  }

  /** The account a live forgotten-password link belongs to, without spending
   *  it — the reset screen checks the link up front, and the reset route
   *  checks the new password before the link is used up. */
  async peekPasswordResetToken(this: Repo, token: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?`, [sha256(token)])) as
      | { user_id: string; expires_at: string }
      | undefined;
    return row && Date.parse(row.expires_at) > Date.now() ? row.user_id : undefined;
  }

  /** Spend an emailed sign-in link: the live challenge it names, or undefined.
   *  The delete is conditional, so two concurrent clicks can't both succeed. */
  async takeMfaChallenge(this: Repo, token: string): Promise<{ user_id: string; method: string } | undefined> {
    const key = sha256(token);
    const row = (await this.sql.one<any>(`SELECT user_id, method, expires_at FROM mfa_challenges WHERE token_hash = ?`, [key])) as
      | { user_id: string; method: string; expires_at: string }
      | undefined;
    if (!row) return undefined;
    const r = await this.sql.exec(`DELETE FROM mfa_challenges WHERE token_hash = ?`, [key]);
    if (r.changes !== 1 || Date.parse(row.expires_at) <= Date.now()) return undefined;
    return { user_id: row.user_id, method: row.method };
  }

  /** Workspace admin anywhere: the MFA_REQUIRED=admins policy targets these. */
  async isAnyWorkspaceAdmin(this: Repo, user_id: string): Promise<boolean> {
    const row = await this.sql.one<any>(`SELECT 1 AS x FROM memberships WHERE user_id = ? AND role = 'workspace_admin' LIMIT 1`, [user_id]);
    return !!row;
  }

  // ---------- identity + defaults (surface unification) ----------

  async updateUserDisplayName(this: Repo, user_id: string, display_name: string | null): Promise<void> {
    (await this.sql.exec(`UPDATE users SET display_name = ? WHERE id = ?`, [display_name, user_id]));
  }

  /** The caller's own wake name for the assistant on chat surfaces. Personal:
   *  two users on the same team can call it different things. */
  async updateUserAssistantNickname(this: Repo, user_id: string, assistant_nickname: string | null): Promise<void> {
    (await this.sql.exec(`UPDATE users SET assistant_nickname = ? WHERE id = ?`, [assistant_nickname, user_id]));
  }

  /**
   * Case-insensitive display-name lookup. Returns ALL matches — display names
   * are deliberately not unique, so ambiguity is the caller's to resolve
   * (surfaces list the options rather than guessing).
   */
  async findUsersByDisplayName(this: Repo, name: string): Promise<User[]> {
    return (await this.sql.query<any>(`SELECT * FROM users WHERE display_name = ? COLLATE NOCASE`, [name.trim()])) as User[];
  }

  /**
   * Link (or re-link) an external identity to a user. Upserts on the
   * UNIQUE(kind, team_id, external_id) key; a conflicting claim by ANOTHER
   * user throws (two users can't own one Slack identity).
   */
  async upsertUserIdentity(this: Repo, opts: {
    user_id: string;
    kind: 'slack' | 'whatsapp';
    team_id?: string | null;
    external_id: string;
    handle?: string | null;
  }): Promise<UserIdentity> {
    // WhatsApp identities are always keyed by digits-only phone (see
    // findUserByWhatsappIdentity) — normalize here so every caller (the
    // self-link route, admin scripts, tests) agrees on one canonical form.
    const externalId =
      opts.kind === 'whatsapp' ? normalizePhoneDigits(opts.external_id) : opts.external_id;
    if (!externalId) throw new Error('invalid_external_id');
    const existing = (await this.sql.one<any>(`SELECT * FROM user_identities WHERE kind = ? AND team_id IS ? AND external_id = ?`, [opts.kind, opts.team_id ?? null, externalId])) as UserIdentity | undefined;
    if (existing && existing.user_id !== opts.user_id) {
      throw new Error('identity_claimed_by_other_user');
    }
    const now = new Date().toISOString();
    if (existing) {
      (await this.sql.exec(`UPDATE user_identities SET handle = ? WHERE id = ?`, [opts.handle ?? existing.handle, existing.id]));
      return { ...existing, handle: opts.handle ?? existing.handle };
    }
    const id = `uid_${nanoid(10)}`;
    (await this.sql.exec(`INSERT INTO user_identities (id, user_id, kind, team_id, external_id, handle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, opts.user_id, opts.kind, opts.team_id ?? null, externalId, opts.handle ?? null, now]));
    return {
      id,
      user_id: opts.user_id,
      kind: opts.kind,
      team_id: opts.team_id ?? null,
      external_id: externalId,
      handle: opts.handle ?? null,
      created_at: now,
    };
  }

  async listUserIdentities(this: Repo, user_id: string): Promise<UserIdentity[]> {
    return (await this.sql.query<any>(`SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at`, [user_id])) as UserIdentity[];
  }

  /**
   * Resolve a Slack reference to a user. `ref` may be a Slack user id (U…) or
   * a handle (with or without a leading @), matched case-insensitively.
   * With a team_id, team-scoped identities must match it (NULL-team ones
   * match any team); with team_id null (a non-Slack surface resolving a
   * teammate ref), any team's identity matches.
   */
  async findUserBySlackIdentity(this: Repo, team_id: string | null, ref: string): Promise<User | undefined> {
    const cleaned = ref.replace(/^@/, '').trim();
    const row = (await this.sql.one<any>(`SELECT u.* FROM user_identities ui JOIN users u ON u.id = ui.user_id
         WHERE ui.kind = 'slack'
           AND (? IS NULL OR ui.team_id IS NULL OR ui.team_id = ?)
           AND (ui.external_id = ? OR ui.handle = ? COLLATE NOCASE)
         LIMIT 1`, [team_id, team_id, cleaned, cleaned])) as User | undefined;
    return row;
  }

  /**
   * Resolve a WhatsApp phone number to a user. `phone` may carry a leading
   * `+`, spaces, or the WhatsApp JID suffix (`@s.whatsapp.net`) — matched by
   * digits only, so linking "+1 (415) 555-0100" and a webhook's
   * "14155550100@s.whatsapp.net" resolve to the same identity. There is no
   * team scoping for WhatsApp (one bot number, kind='whatsapp' rows always
   * carry team_id NULL).
   */
  async findUserByWhatsappIdentity(this: Repo, phone: string): Promise<User | undefined> {
    const digits = normalizePhoneDigits(phone);
    if (!digits) return undefined;
    const row = (await this.sql.one<any>(`SELECT u.* FROM user_identities ui JOIN users u ON u.id = ui.user_id
         WHERE ui.kind = 'whatsapp' AND ui.external_id = ?
         LIMIT 1`, [digits])) as User | undefined;
    return row;
  }

  /**
   * Set the user's default folder for a surface. A default is a pointer, not
   * a grant — callers must verify the user's membership BEFORE writing, and
   * readers re-check at resolution time (getUserDefault).
   */
  async setUserDefault(this: Repo,
    user_id: string,
    surface: DefaultSurface,
    workspace_id: string,
    subgraph_id?: string | null,
  ): Promise<UserDefault> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO user_defaults (user_id, surface, workspace_id, subgraph_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, surface) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           subgraph_id = excluded.subgraph_id,
           updated_at = excluded.updated_at`, [user_id, surface, workspace_id, subgraph_id ?? null, now]));
    return { user_id, surface, workspace_id, subgraph_id: subgraph_id ?? null, updated_at: now };
  }

  async clearUserDefault(this: Repo, user_id: string, surface: DefaultSurface): Promise<void> {
    (await this.sql.exec(`DELETE FROM user_defaults WHERE user_id = ? AND surface = ?`, [user_id, surface]));
  }

  /** Raw default rows for a user (Setup UI needs all three surfaces). */
  async listUserDefaults(this: Repo, user_id: string): Promise<UserDefault[]> {
    return (await this.sql.query<any>(`SELECT * FROM user_defaults WHERE user_id = ?`, [user_id])) as UserDefault[];
  }

  async listUserWorkspaceVisibleApps(this: Repo, user_id: string, workspace_id: string): Promise<string[]> {
    const rows = (await this.sql.query<any>(`SELECT app FROM user_workspace_app_visibility
         WHERE user_id = ? AND workspace_id = ?
         ORDER BY app`, [user_id, workspace_id])) as Array<{ app: string }>;
    return rows.map((row) => row.app);
  }

  async setUserWorkspaceVisibleApp(this: Repo, user_id: string, workspace_id: string, app: string): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO user_workspace_app_visibility
         (user_id, workspace_id, app, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, workspace_id, app) DO UPDATE SET
           updated_at = excluded.updated_at`, [user_id, workspace_id, app, now, now]));
  }

  async clearUserWorkspaceVisibleApp(this: Repo, user_id: string, workspace_id: string, app: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM user_workspace_app_visibility
         WHERE user_id = ? AND workspace_id = ? AND app = ?`, [user_id, workspace_id, app]));
  }

  /**
   * Per-user third-party app credential (user_app_credentials). `secret` is
   * an opaque encrypted blob — sealing/unsealing is the caller's job
   * (lib/credentials.ts); the repo never sees plaintext.
   */
  async setUserAppSecret(this: Repo, user_id: string, app: string, secret: string): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO user_app_credentials (user_id, app, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, app) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at`, [user_id, app, secret, now, now]));
  }

  async getUserAppSecret(this: Repo, user_id: string, app: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT secret FROM user_app_credentials WHERE user_id = ? AND app = ?`, [user_id, app])) as { secret: string } | undefined;
    return row?.secret;
  }

  async deleteUserAppSecret(this: Repo, user_id: string, app: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM user_app_credentials WHERE user_id = ? AND app = ?`, [user_id, app]));
  }

  /** The operator-level Composio auth config id for a toolkit, if one has been created. */
  async getComposioAuthConfig(this: Repo, toolkit: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT auth_config_id FROM composio_auth_configs WHERE toolkit = ?`, [toolkit])) as { auth_config_id: string } | undefined;
    return row?.auth_config_id;
  }

  async setComposioAuthConfig(this: Repo, toolkit: string, auth_config_id: string): Promise<void> {
    (await this.sql.exec(`INSERT INTO composio_auth_configs (toolkit, auth_config_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (toolkit) DO UPDATE SET auth_config_id = excluded.auth_config_id`, [toolkit, auth_config_id, new Date().toISOString()]));
  }

  async getUserComposioConnection(this: Repo,
    user_id: string,
    toolkit: string,
  ): Promise<{ connected_account_id: string; status: string } | undefined> {
    return (await this.sql.one<any>(`SELECT connected_account_id, status FROM user_composio_connections WHERE user_id = ? AND toolkit = ?`, [user_id, toolkit])) as { connected_account_id: string; status: string } | undefined;
  }

  async upsertUserComposioConnection(this: Repo,
    user_id: string,
    toolkit: string,
    connected_account_id: string,
    status: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO user_composio_connections
           (user_id, toolkit, connected_account_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, toolkit) DO UPDATE SET
           connected_account_id = excluded.connected_account_id,
           status = excluded.status,
           updated_at = excluded.updated_at`, [user_id, toolkit, connected_account_id, status, now, now]));
  }

  async deleteUserComposioConnection(this: Repo, user_id: string, toolkit: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM user_composio_connections WHERE user_id = ? AND toolkit = ?`, [user_id, toolkit]));
  }

  /**
   * The user's effective default folder for a surface: the surface-specific
   * row, else the 'all' row. Membership is RE-CHECKED at read time — a
   * default pointing at a folder the user was removed from silently falls
   * through (stale pointers must never grant or imply access).
   */
  async getUserDefault(this: Repo, user_id: string, surface: DefaultSurface): Promise<UserDefault | undefined> {
    const rows = await this.listUserDefaults(user_id);
    const pick =
      rows.find((r) => r.surface === surface) ?? rows.find((r) => r.surface === 'all');
    if (!pick) return undefined;
    if (!await this.getMembership(pick.workspace_id, user_id)) return undefined;
    return pick;
  }

  /**
   * The folder of the user's most recent recorded activity: the newest
   * customer_audit_log row they authored, restricted to folders they are
   * still a member of. Serves as the IMPLICIT default when no explicit
   * default folder is set — same pointer-never-grant rule as getUserDefault.
   *
   * Account events (sign_in, sign_out, sign_in_failed, password_changed) and
   * identity_linked are excluded: they fan out one row per membership in a
   * single action, so the "newest" of them is an arbitrary
   * workspace, not where the user actually worked.
   */
  async getLastActivityWorkspace(this: Repo, user_id: string): Promise<string | undefined> {
    const row = (await this.sql.one<any>(`SELECT cal.workspace_id AS workspace_id
           FROM customer_audit_log cal
           JOIN memberships m
             ON m.workspace_id = cal.workspace_id AND m.user_id = cal.actor_user_id
          WHERE cal.actor_user_id = ?
            AND cal.event NOT IN ('sign_in', 'sign_out', 'sign_in_failed', 'password_changed', 'mfa_enabled', 'mfa_disabled', 'mfa_recovery_code_used', 'sign_in_failures_alert', 'identity_linked')
          ORDER BY cal.id DESC
          LIMIT 1`, [user_id])) as { workspace_id: string } | undefined;
    return row?.workspace_id;
  }

  // ---------- surface-agent threads (Slack relay conversation state) ----------

  async getAgentThread(this: Repo,
    surface: string,
    team_id: string,
    thread_key: string,
  ): Promise<AgentThread | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM agent_threads WHERE surface = ? AND team_id = ? AND thread_key = ?`, [surface, team_id, thread_key])) as
      | (Omit<AgentThread, 'pending_action'> & { pending_action: string | null })
      | undefined;
    if (!row) return undefined;
    return {
      ...row,
      pending_action: row.pending_action ? JSON.parse(row.pending_action) : null,
    };
  }

  async upsertAgentThread(this: Repo, opts: {
    surface: string;
    team_id: string;
    thread_key: string;
    user_id: string;
    workspace_id: string;
    pending_action: unknown | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO agent_threads (surface, team_id, thread_key, user_id, workspace_id, pending_action, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(surface, team_id, thread_key) DO UPDATE SET
           user_id = excluded.user_id,
           workspace_id = excluded.workspace_id,
           pending_action = excluded.pending_action,
           updated_at = excluded.updated_at`, [opts.surface, opts.team_id, opts.thread_key, opts.user_id, opts.workspace_id, opts.pending_action ? JSON.stringify(opts.pending_action) : null, now, now]));
  }

  async appendAgentMessage(this: Repo, opts: {
    surface: string;
    team_id: string;
    thread_key: string;
    role: 'user' | 'agent' | 'event';
    body: string;
    receipts?: unknown;
    /** The folder the conversation is acting on; its key seals the body. */
    workspace_id?: string;
  }): Promise<void> {
    const id = `am_${nanoid(12)}`;
    if (this.crypto.sealing && !opts.workspace_id) throw new Error('appendAgentMessage: workspace_id is required when sealing');
    const body = opts.workspace_id ? await sealText(this, opts.workspace_id, 'agent_thread_messages.body', id, opts.body) : opts.body;
    (await this.sql.exec(`INSERT INTO agent_thread_messages (id, surface, team_id, thread_key, role, body, receipts, created_at, workspace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, opts.surface, opts.team_id, opts.thread_key, opts.role, body, opts.receipts ? JSON.stringify(opts.receipts) : null, new Date().toISOString(), opts.workspace_id ?? null]));
  }

  /** The LAST `limit` messages of a thread, oldest first. */
  async listAgentMessages(this: Repo,
    surface: string,
    team_id: string,
    thread_key: string,
    limit = 30,
  ): Promise<Array<{ role: string; body: string; created_at: string }>> {
    const rows = (await this.sql.query<any>(`SELECT id, role, body, created_at, workspace_id FROM agent_thread_messages
          WHERE surface = ? AND team_id = ? AND thread_key = ?
          ORDER BY created_at DESC, id DESC LIMIT ?`, [surface, team_id, thread_key, limit])) as Array<{
      id: string;
      role: string;
      body: string;
      created_at: string;
      workspace_id: string | null;
    }>;
    const out: Array<{ role: string; body: string; created_at: string }> = [];
    for (const r of rows.reverse()) {
      const body = r.workspace_id ? await openText(this, r.workspace_id, 'agent_thread_messages.body', r.id, r.body) : r.body;
      out.push({ role: r.role, body, created_at: r.created_at });
    }
    return out;
  }

  // ---------- sessions ----------

  async createSession(
    this: Repo,
    user_id: string,
    ttlSec = sessionPolicy().ttlSec,
    opts: { mfaEnrollmentRequired?: boolean; passwordChangeRequired?: boolean; viaSso?: boolean } = {},
  ): Promise<string> {
    const token = `sess_${nanoid(24)}`;
    const now = new Date();
    const exp = new Date(now.getTime() + ttlSec * 1000);
    (await this.sql.exec(`INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at, mfa_enrollment_required, password_change_required, via_sso) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [sessionTokenKey(token), user_id, now.toISOString(), exp.toISOString(), now.toISOString(), opts.mfaEnrollmentRequired ? 1 : 0, opts.passwordChangeRequired ? 1 : 0, opts.viaSso ? 1 : 0]));
    return token;
  }

  /**
   * Disable an account (leaver via SCIM or an admin): every way in
   * ends at once — web sessions, MCP connection tokens, claude.ai connector
   * links and assistant (OAuth) connections. Memberships stay, so re-enabling
   * restores access. Returns what was revoked.
   */
  async disableUser(this: Repo, user_id: string): Promise<{ sessions: number; mcp_tokens: number; connectors: number; oauth_grants: number }> {
    const now = new Date().toISOString();
    await this.sql.exec(`UPDATE users SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?`, [now, user_id]);
    const sessions = (await this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, [user_id])).changes;
    const mcp_tokens = (await this.sql.exec(`UPDATE mcp_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now, user_id])).changes;
    const connectors = (await this.sql.exec(`UPDATE claude_ai_connectors SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [now, user_id])).changes;
    const grants = (await this.sql.query<any>(`SELECT id FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL`, [user_id])) as Array<{ id: string }>;
    for (const g of grants) {
      await this.sql.exec(`UPDATE oauth_grants SET revoked_at = ? WHERE id = ?`, [now, g.id]);
      await this.sql.exec(`UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`, [now, g.id]);
    }
    return { sessions, mcp_tokens, connectors, oauth_grants: grants.length };
  }

  async enableUser(this: Repo, user_id: string): Promise<void> {
    await this.sql.exec(`UPDATE users SET disabled_at = NULL WHERE id = ?`, [user_id]);
  }

  async isUserDisabled(this: Repo, user_id: string): Promise<boolean> {
    return !!((await this.sql.one<any>(`SELECT disabled_at FROM users WHERE id = ?`, [user_id])) as { disabled_at: string | null } | undefined)?.disabled_at;
  }

  /**
   * Resolve a session, enforcing both limits: the absolute lifetime
   * (expires_at) and the idle timeout (no request for SESSION_IDLE_MINUTES).
   * A session past either limit is deleted. Activity is stamped at most once a
   * minute so a busy client doesn't write on every request. Times are compared
   * as Dates: the columns hold ISO strings, which don't compare correctly as
   * text against SQLite's datetime('now') format.
   */
  async getSession(this: Repo, token: string): Promise<
    { user_id: string; mfa_enrollment_required: boolean; password_change_required: boolean; via_sso: boolean } | undefined
  > {
    const key = sessionTokenKey(token);
    const row = (await this.sql.one<any>(`SELECT user_id, created_at, expires_at, last_seen_at, mfa_enrollment_required, password_change_required, via_sso FROM sessions WHERE token = ?`, [key])) as
      | { user_id: string; created_at: string; expires_at: string; last_seen_at: string | null; mfa_enrollment_required: number; password_change_required: number; via_sso: number }
      | undefined;
    if (!row) return undefined;
    const now = Date.now();
    const lastSeen = Date.parse(row.last_seen_at ?? row.created_at);
    if (Date.parse(row.expires_at) <= now || now - lastSeen > sessionPolicy().idleSec * 1000) {
      await this.sql.exec(`DELETE FROM sessions WHERE token = ?`, [key]);
      return undefined;
    }
    if (now - lastSeen > 60_000) {
      await this.sql.exec(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`, [new Date(now).toISOString(), key]);
    }
    return {
      user_id: row.user_id,
      mfa_enrollment_required: !!row.mfa_enrollment_required,
      password_change_required: !!row.password_change_required,
      via_sso: !!row.via_sso,
    };
  }

  /** Revoke every session of a user ("sign out everywhere", password change),
   *  optionally keeping the one the request came from. Returns how many. */
  async deleteUserSessions(this: Repo, user_id: string, opts: { except?: string } = {}): Promise<number> {
    const r = opts.except
      ? await this.sql.exec(`DELETE FROM sessions WHERE user_id = ? AND token != ?`, [user_id, sessionTokenKey(opts.except)])
      : await this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, [user_id]);
    return r.changes;
  }

  /** Revoke one session (sign-out). Idempotent: an unknown token is a no-op. */
  async deleteSession(this: Repo, token: string): Promise<void> {
    await this.sql.exec(`DELETE FROM sessions WHERE token = ?`, [sessionTokenKey(token)]);
  }

  // ---------- MCP tokens ----------

  async issueMcpToken(this: Repo, opts: {
    workspace_id: string;
    user_id: string;
    ttlDays?: number;
  }): Promise<{ id: string; token: string }> {
    const id = `mcp_${nanoid(12)}`;
    const token = `pmg_${nanoid(40)}`;
    const tokenHash = sha256(token);
    const now = new Date();
    const exp = new Date(now.getTime() + (opts.ttlDays ?? 90) * 24 * 3600 * 1000);
    (await this.sql.exec(`INSERT INTO mcp_tokens (id, workspace_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, opts.workspace_id, opts.user_id, tokenHash, now.toISOString(), exp.toISOString()]));
    await this.logAudit(opts.workspace_id, {
      actor: opts.user_id,
      event: 'mcp_token.issued',
      resource_type: 'mcp_token',
      resource_id: id,
    });
    return { id, token };
  }

  /**
   * Resolve an MCP bearer token to a (workspace, user). Tokens carry a
   * workspace claim implicitly via the row — there is no way for a token
   * from workspace A to authenticate against workspace B. This is the
   * tripwire from the PRD's integrity gates.
   */
  async resolveMcpToken(this: Repo, token: string): Promise<{ workspace_id: string; user_id: string } | undefined> {
    const res = await this.resolveMcpTokenWithId(token);
    return res ? { workspace_id: res.workspace_id, user_id: res.user_id } : undefined;
  }

  async resolveMcpTokenWithId(this: Repo,
    token: string,
  ): Promise<{ id: string; workspace_id: string; user_id: string } | undefined> {
    const tokenHash = sha256(token);
    const row = (await this.sql.one<any>(`SELECT id, workspace_id, user_id FROM mcp_tokens
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, [tokenHash, new Date().toISOString()])) as { id: string; workspace_id: string; user_id: string } | undefined;
    if (row) {
      (await this.sql.exec(`UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE token_hash = ?`, [tokenHash]));
    }
    return row;
  }

  async revokeMcpToken(this: Repo, workspace_id: string, id: string, actor?: string): Promise<void> {
    (await this.sql.exec(`UPDATE mcp_tokens SET revoked_at = datetime('now') WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'mcp_token.revoked',
      resource_type: 'mcp_token',
      resource_id: id,
    });
  }

  // ---------- claude.ai connectors ----------
  //
  // A connector is a workspace-scoped capability URL for claude.ai (which can't
  // send bearer headers). The secret path is the credential: it resolves in-app
  // to (workspace, user) exactly the way an MCP token does, so a connector can
  // be minted from Settings with no infra changes. The plaintext secret is
  // returned once at creation; only its hash is persisted.

  async createConnector(this: Repo, opts: {
    workspace_id: string;
    user_id: string;
    label?: string;
  }): Promise<{ id: string; secret: string }> {
    const id = `con_${nanoid(12)}`;
    // nanoid's default alphabet is URL-path-safe (A-Za-z0-9_-); 48 chars is the
    // same entropy budget as the legacy openssl-hex Caddy secrets.
    const secret = nanoid(48);
    const secretHash = sha256(secret);
    (await this.sql.exec(`INSERT INTO claude_ai_connectors (id, workspace_id, user_id, label, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, opts.workspace_id, opts.user_id, opts.label ?? null, secretHash, new Date().toISOString()]));
    await this.logAudit(opts.workspace_id, {
      actor: opts.user_id,
      event: 'connector.created',
      resource_type: 'claude_ai_connector',
      resource_id: id,
    });
    return { id, secret };
  }

  /**
   * Resolve a connector secret to (id, workspace, user). Same shape as
   * resolveMcpTokenWithId so the MCP transport can treat the two identically.
   * A revoked connector resolves to undefined (fail-closed).
   */
  async resolveConnectorSecret(this: Repo,
    secret: string,
  ): Promise<{ id: string; workspace_id: string; user_id: string } | undefined> {
    const secretHash = sha256(secret);
    const row = (await this.sql.one<any>(`SELECT id, workspace_id, user_id FROM claude_ai_connectors
         WHERE secret_hash = ? AND revoked_at IS NULL`, [secretHash])) as { id: string; workspace_id: string; user_id: string } | undefined;
    if (row) {
      (await this.sql.exec(`UPDATE claude_ai_connectors SET last_used_at = datetime('now') WHERE secret_hash = ?`, [secretHash]));
    }
    return row;
  }

  /**
   * Record that a TOOL actually ran on an MCP credential — as opposed to
   * `last_used_at`, which resolveMcpTokenWithId/resolveConnectorSecret stamp
   * the moment the credential resolves (a client validating a pasted
   * connector does that much). Get started's indicator treats the two as
   * different states: "link reached" vs "your assistant used it". Called from
   * every tool dispatch path in mcp/server.ts; `kind` says which table the
   * credential id belongs to.
   */
  async recordCredentialToolCall(this: Repo,
    kind: 'token' | 'connector' | 'oauth',
    workspace_id: string,
    id: string,
  ): Promise<void> {
    // OAuth: `id` is the access token's id; the state lives on its grant.
    if (kind === 'oauth') {
      await this.sql.exec(
        `UPDATE oauth_grants SET last_tool_call_at = datetime('now') WHERE id = (SELECT grant_id FROM oauth_tokens WHERE id = ?)`,
        [id],
      );
      return;
    }
    const table = kind === 'token' ? 'mcp_tokens' : 'claude_ai_connectors';
    (await this.sql.exec(`UPDATE ${table} SET last_tool_call_at = datetime('now') WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  async listConnectors(this: Repo,
    workspace_id: string,
  ): Promise<Array<{
    id: string;
    label: string | null;
    created_at: string;
    last_used_at: string | null;
    last_tool_call_at: string | null;
  }>> {
    return (await this.sql.query<any>(`SELECT id, label, created_at, last_used_at, last_tool_call_at FROM claude_ai_connectors
         WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`, [workspace_id])) as Array<{
      id: string;
      label: string | null;
      created_at: string;
      last_used_at: string | null;
      last_tool_call_at: string | null;
    }>;
  }

  async revokeConnector(this: Repo, workspace_id: string, id: string, actor?: string): Promise<void> {
    (await this.sql.exec(`UPDATE claude_ai_connectors SET revoked_at = datetime('now') WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
    await this.logAudit(workspace_id, {
      actor,
      event: 'connector.revoked',
      resource_type: 'claude_ai_connector',
      resource_id: id,
    });
  }

  // ---------- audit ----------

  async logAudit(this: Repo, workspace_id: string, entry: AuditEntry): Promise<void> {
    (await this.sql.exec(`INSERT INTO audit_log (workspace_id, actor, event, resource_type, resource_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`, [workspace_id, entry.actor ?? null, entry.event, entry.resource_type ?? null, entry.resource_id ?? null, entry.payload ? JSON.stringify(entry.payload) : null]));
    // Internal audit payloads are not vetted content-free; only the key alarm
    // is forwarded to the customer's monitoring.
    if (entry.event === 'key.unwrap_failed') {
      await forwardAudit({ stream: 'internal', workspace_id, event: entry.event, resource_type: entry.resource_type ?? null, resource_id: entry.resource_id ?? null, payload: (entry.payload as Record<string, unknown>) ?? null });
    }
  }

  async listAudit(this: Repo, workspace_id: string, limit = 100): Promise<Array<{ event: string; actor: string | null; created_at: string }>> {
    return (await this.sql.query<any>(`SELECT event, actor, created_at, resource_type, resource_id, payload
         FROM audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [workspace_id, limit])) as Array<{
      event: string;
      actor: string | null;
      created_at: string;
    }>;
  }

  // ---------- workspace deletion (right-to-erasure) ----------

  /**
   * Delete every row scoped to this workspace, in dependency-safe order.
   *
   * The PRD's "data deletion path, end-to-end documented and tested" gate
   * lives here. Internal `audit_log` and `synth_cache` are *not* covered by
   * ON DELETE CASCADE because they don't have FK references; both are wiped
   * explicitly. File-on-disk cleanup is the caller's responsibility (see
   * `deleteWorkspaceWithFiles` in api/server.ts).
   *
   * Returns a per-table delete count so the test can assert nothing remains.
   */
  async deleteWorkspaceRows(this: Repo, workspace_id: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    // Order: tables without dependents first; workspaces last.
    const tables = [
      'doc_triage',
      'candidate_groups',
      'day1_audit_reports',
      'finding_rejections',
      'context_usage_log',
      'context_request_texts',
      'customer_audit_log',
      'audit_log',
      'synth_cache',
      'slack_channels',
      'sources',
      'node_evidence',
      'graph_edges',
      'document_routing',
      'documents',
      'reviews',
      'candidates',
      'graph_nodes',
      'subgraphs',
      'workspace_profiles',
      'mcp_tokens',
      'claude_ai_connectors',
      'workspace_keys',
      'agent_threads',
      'memberships',
      // workspaces row last; sessions live on the user (not workspace-scoped).
    ];
    await this.sql.tx(async () => {
      // agent_thread_messages has no workspace_id column of its own (keyed by
      // surface/team_id/thread_key) — resolve which threads belong to this
      // workspace via agent_threads BEFORE that table's rows are deleted below.
      // Left unswept, this is a privacy leak: verbatim Slack Q&A bodies survive
      // a workspace deletion (see workspace-deletion-gaps memory).
      const agentMsgs = (await this.sql.exec(`DELETE FROM agent_thread_messages WHERE workspace_id = ? OR (surface, team_id, thread_key) IN (
             SELECT surface, team_id, thread_key FROM agent_threads WHERE workspace_id = ?
           )`, [workspace_id, workspace_id]));
      counts['agent_thread_messages'] = agentMsgs.changes;
      // Keep the audit trail (who did what, including this deletion) past the
      // workspace's own lifetime: copy it out before customer_audit_log is
      // wiped below, and prune archives past their retention.
      const now = new Date();
      const retentionDays = Number(process.env.AUDIT_ARCHIVE_RETENTION_DAYS ?? 365);
      const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000).toISOString();
      await this.sql.exec(`DELETE FROM deleted_workspace_audit WHERE archived_at < ?`, [cutoff]);
      await this.sql.exec(`INSERT INTO deleted_workspace_audit
           (original_id, workspace_id, workspace_name, event, actor_user_id, actor_email, source_ip,
            user_agent, resource_type, resource_id, payload, created_at, archived_at)
         SELECT cal.id, cal.workspace_id, w.name, cal.event, cal.actor_user_id, cal.actor_email, cal.source_ip,
                cal.user_agent, cal.resource_type, cal.resource_id, cal.payload, cal.created_at, ?
           FROM customer_audit_log cal LEFT JOIN workspaces w ON w.id = cal.workspace_id
          WHERE cal.workspace_id = ?
          ORDER BY cal.id`, [now.toISOString(), workspace_id]);
      for (const t of tables) {
        const r = (await this.sql.exec(`DELETE FROM ${t} WHERE workspace_id = ?`, [workspace_id]));
        counts[t] = r.changes;
      }
      const r = (await this.sql.exec(`DELETE FROM workspaces WHERE id = ?`, [workspace_id]));
      counts['workspaces'] = r.changes;
    });
    return counts;
  }

  /** The archived audit trail of a deleted workspace, oldest first. Operator
   *  access only (no route): the workspace and its admins no longer exist. */
  async listDeletedWorkspaceAudit(this: Repo, workspace_id: string): Promise<Array<CustomerAuditRow & { workspace_name: string | null; archived_at: string }>> {
    return (await this.sql.query<any>(`SELECT original_id AS id, workspace_id, workspace_name, event, actor_user_id, actor_email,
              source_ip, user_agent, resource_type, resource_id, payload, created_at, archived_at
         FROM deleted_workspace_audit WHERE workspace_id = ? ORDER BY original_id`, [workspace_id])) as any;
  }

  /**
   * Assert (post-deletion) that no rows for this workspace remain in any
   * table. Used by the deletion test as a tripwire — if a future table is
   * added and not registered in `deleteWorkspaceRows`, this catches it.
   */
  async countWorkspaceRows(this: Repo, workspace_id: string): Promise<Record<string, number>> {
    const tables = [
      'doc_triage',
      'candidate_groups',
      'day1_audit_reports',
      'finding_rejections',
      'context_usage_log',
      'context_request_texts',
      'customer_audit_log',
      'audit_log',
      'synth_cache',
      'slack_channels',
      'sources',
      'node_evidence',
      'graph_edges',
      'document_routing',
      'documents',
      'reviews',
      'candidates',
      'graph_nodes',
      'subgraphs',
      'workspace_profiles',
      'mcp_tokens',
      'claude_ai_connectors',
      'workspace_keys',
      'agent_threads',
      'memberships',
      'workspaces',
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const col = t === 'workspaces' ? 'id' : 'workspace_id';
      const r = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, [workspace_id])) as { n: number };
      counts[t] = r.n;
    }
    // agent_thread_messages has no workspace_id column — count it via the
    // same join deleteWorkspaceRows uses to sweep it.
    const agentMsgs = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM agent_thread_messages WHERE workspace_id = ? OR (surface, team_id, thread_key) IN (
           SELECT surface, team_id, thread_key FROM agent_threads WHERE workspace_id = ?
         )`, [workspace_id, workspace_id])) as { n: number };
    counts['agent_thread_messages'] = agentMsgs.n;
    return counts;
  }

  // ---------- customer audit (export-friendly) ----------

  /**
   * Write an entry to the customer-facing audit log. Closed event vocabulary
   * enforced at the type level; payload bodies should be terse summaries
   * (counts, ids, kinds) — never deliverable text or graph contents.
   */
  async logCustomerAudit(this: Repo, workspace_id: string, entry: CustomerAuditEntry): Promise<void> {
    (await this.sql.exec(`INSERT INTO customer_audit_log
         (workspace_id, event, actor_user_id, actor_email, source_ip, user_agent, resource_type, resource_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, [workspace_id, entry.event, entry.actor_user_id ?? null, entry.actor_email ?? null, entry.source_ip ?? null, entry.user_agent ?? null, entry.resource_type ?? null, entry.resource_id ?? null, entry.payload ? JSON.stringify(entry.payload) : null]));
    await forwardAudit({ stream: 'customer', workspace_id, ...entry, payload: (entry.payload as Record<string, unknown> | undefined) ?? null });
  }

  async listCustomerAudit(this: Repo,
    workspace_id: string,
    opts: { limit?: number; since?: string; event?: CustomerAuditEvent; before?: number } = {},
  ): Promise<CustomerAuditRow[]> {
    const { where, params } = customerAuditWhere(workspace_id, opts);
    // `before` pages by id (rows older than it), so events logged mid-paging
    // never shift a row onto the next page.
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    const limit = Math.min(opts.limit ?? 200, 10_000);
    params.push(limit);
    return (await this.sql.query<any>(`SELECT id, event, actor_user_id, actor_email, source_ip, user_agent,
                resource_type, resource_id, payload, created_at
         FROM customer_audit_log
         WHERE ${where.join(' AND ')}
         ORDER BY id DESC LIMIT ?`, [...params])) as CustomerAuditRow[];
  }

  async countCustomerAudit(this: Repo,
    workspace_id: string,
    opts: { since?: string; event?: CustomerAuditEvent } = {},
  ): Promise<number> {
    const { where, params } = customerAuditWhere(workspace_id, opts);
    const row = (await this.sql.one<any>(
      `SELECT COUNT(*) AS n FROM customer_audit_log WHERE ${where.join(' AND ')}`,
      params,
    )) as { n: number };
    return Number(row.n);
  }

  // ---------- moved from api/routes (all SQL in repo/) ----------


  async getUserEmailRow(this: Repo, user_id: string): Promise<{ email: string } | undefined> {
    return (await this.sql.one<any>(`SELECT email FROM users WHERE id = ?`, [user_id])) as { email: string } | undefined;
  }

  /** Single-user local mode: every workspace, as admin. */
  async listAllWorkspaceRowsAsAdmin(this: Repo): Promise<unknown[]> {
    return withoutLegacyPlan(await this.sql.query(`SELECT w.*, 'workspace_admin' AS member_role FROM workspaces w ORDER BY w.created_at DESC`));
  }

  async listWorkspaceRowsForUser(this: Repo, user_id: string): Promise<unknown[]> {
    return withoutLegacyPlan(await this.sql.query(`SELECT w.*, m.role AS member_role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at DESC`, [user_id]));
  }

  async listMembershipWorkspaceIds(this: Repo, user_id: string): Promise<Array<{ workspace_id: string }>> {
    return (await this.sql.query<any>(`SELECT workspace_id FROM memberships WHERE user_id = ?`, [user_id])) as Array<{ workspace_id: string }>;
  }

  async getWorkspaceRow(this: Repo, ws: string): Promise<Record<string, unknown> | undefined> {
    return (await this.sql.one<any>(`SELECT id, name, owner_email, plan, created_at FROM workspaces WHERE id = ?`, [ws])) as Record<string, unknown> | undefined;
  }

  /** An MCP request authenticated with this OAuth access token: the grant's
   *  "reached" state (the counterpart of a connector's last_used_at). */
  async recordOAuthUse(this: Repo, access_token_id: string): Promise<void> {
    await this.sql.exec(
      `UPDATE oauth_grants SET last_used_at = datetime('now') WHERE id = (SELECT grant_id FROM oauth_tokens WHERE id = ?)`,
      [access_token_id],
    );
  }

  /** MCP query_context audit rows (Mirror: GET /workspaces/:ws/mcp-queries). */
  async listMcpQueryAuditRows(this: Repo, ws: string, limit: number): Promise<Array<{ created_at: string; payload: string | null }>> {
    return (await this.sql.query<any>(`SELECT created_at, payload FROM audit_log
       WHERE workspace_id = ? AND event = 'mcp.query_context'
       ORDER BY id DESC LIMIT ?`, [ws, limit])) as Array<{ created_at: string; payload: string | null }>;
  }
}
