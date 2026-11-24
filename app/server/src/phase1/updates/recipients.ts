/**
 * Who an update may be sent to. An update subscription ('get') or a broadcast
 * ('give') carries content synthesized from one or more workspaces, so its
 * recipients are limited to people who can already read that content:
 *
 *   - an email address is allowed only if it belongs to a user who is a member
 *     of EVERY workspace the subscription draws from (the intersection: a
 *     member of A but not B must not receive an update that can quote B);
 *   - a Slack user (U…/W… id or @handle) is allowed only if it maps through
 *     user_identities (kind 'slack') to a user who passes the same rule;
 *   - a Slack channel (C…/G… id or #name) is allowed. ASSUMPTION: the Slack
 *     bot token belongs to the operator-installed Slack workspace, so posting
 *     into one of its channels is an internal destination. A deployment whose
 *     bot is shared into external Slack Connect channels is outside this model;
 *   - the subscription owner is always allowed (their own channel);
 *   - anything else is refused.
 *
 * POMEGRANATE_ALLOW_EXTERNAL_RECIPIENTS=1 switches all of this off and restores
 * the old "any non-empty string" behaviour.
 *
 * Shared by the HTTP routes (create/edit validation) and the scheduler
 * (re-validation at delivery time, since membership changes after creation).
 */
import type { Repo, UpdateTarget, User } from '../db/repo.js';

export const RECIPIENTS_NOT_ALLOWED_DETAIL = 'Updates can only go to members of this directory.';

export type RecipientKind = 'email' | 'slack_user' | 'slack_channel' | 'other';

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+$/;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;
const SLACK_HANDLE_RE = /^@[\w.\-]+$/;
const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{2,}$/;
const SLACK_CHANNEL_NAME_RE = /^#[\w.\-]+$/;

export function classifyRecipient(value: string): RecipientKind {
  const v = value.trim();
  if (SLACK_HANDLE_RE.test(v)) return 'slack_user';
  if (EMAIL_RE.test(v)) return 'email';
  if (SLACK_USER_ID_RE.test(v)) return 'slack_user';
  if (SLACK_CHANNEL_ID_RE.test(v) || SLACK_CHANNEL_NAME_RE.test(v)) return 'slack_channel';
  return 'other';
}

export function externalRecipientsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POMEGRANATE_ALLOW_EXTERNAL_RECIPIENTS === '1';
}

/** Split a stored `destination` (comma-separated) into trimmed recipients. */
export function splitDestination(destination: string | null | undefined): string[] {
  return (destination ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface RecipientCheck {
  allowed: string[];
  rejected: string[];
}

/**
 * Partition `recipients` into allowed and rejected for a subscription owned by
 * `ownerUserId` drawing content from `targets`. Order is preserved.
 */
export async function checkRecipients(
  repo: Repo,
  opts: {
    ownerUserId: string;
    targets: UpdateTarget[];
    recipients: string[];
    env?: NodeJS.ProcessEnv;
  },
): Promise<RecipientCheck> {
  if (externalRecipientsAllowed(opts.env)) return { allowed: [...opts.recipients], rejected: [] };
  const workspaceIds = [...new Set(opts.targets.map((t) => t.workspace_id))];
  const memberCache = new Map<string, boolean>();
  const isMemberOfAll = async (user: User | undefined): Promise<boolean> => {
    if (!user) return false;
    if (user.id === opts.ownerUserId) return true; // the owner's own channel
    if (workspaceIds.length === 0) return false;
    const cached = memberCache.get(user.id);
    if (cached !== undefined) return cached;
    let ok = true;
    for (const ws of workspaceIds) {
      if (!(await repo.getMembership(ws, user.id))) {
        ok = false;
        break;
      }
    }
    memberCache.set(user.id, ok);
    return ok;
  };

  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const raw of opts.recipients) {
    const value = raw.trim();
    let ok = false;
    switch (classifyRecipient(value)) {
      case 'email':
        // findUserByEmail compares case-insensitively.
        ok = await isMemberOfAll(await repo.findUserByEmail(value));
        break;
      case 'slack_user':
        ok = await isMemberOfAll(await repo.findUserBySlackIdentity(null, value));
        break;
      case 'slack_channel':
        ok = true; // internal: a channel of the operator-installed Slack workspace (see header)
        break;
      default:
        ok = false;
    }
    (ok ? allowed : rejected).push(raw);
  }
  return { allowed, rejected };
}
