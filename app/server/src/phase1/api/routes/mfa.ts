// Routes: second factor (an emailed sign-in link after the password).
//
// Sign-in with MFA is two steps: the password, then a one-time link emailed to
// the account's address. For an account MFA covers, password login answers
// 401 { error: 'mfa_required', method: 'email' } and emails a link to
// `${origin}/?mfa=<token>`; POST /auth/mfa/verify trades that token for the
// session. The link is only ever issued after a correct password, so it takes
// both the password and the inbox to sign in.
//
// Who is covered: accounts that turned it on (/me/mfa/enable), plus everyone
// the MFA_REQUIRED policy names (=admins: any workspace admin; =all). A
// covered account can't sign in with a magic link alone — that is a single
// factor (the inbox). If it has no password yet, the magic link gives a
// session that can only set one (authn enforces it); once set, the account
// signs in with password + link from then on.
//
// Scope: this guards the web sign-in. Connection tokens (MCP, Chrome
// extension) and WhatsApp numbers are separate credentials an admin issues
// and revokes; they don't pass through here.

import { z } from 'zod';
import { log } from '../../../lib/log.js';
import { verifyPassword } from '../../../lib/passwords.js';
import { mfaLinkContent, sendMail } from '../../mail/smtp.js';
import { sendMailViaResend } from '../../mail/resend.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import type { Repo, User } from '../../db/repo.js';

/** How long the emailed sign-in link works. */
const MFA_LINK_TTL_SEC = 10 * 60;

/** Does the MFA_REQUIRED policy cover this user? Read per call (env). */
export async function mfaRequiredFor(repo: Repo, user_id: string): Promise<boolean> {
  const policy = (process.env.MFA_REQUIRED ?? '').trim().toLowerCase();
  if (policy === 'all') return true;
  if (policy === 'admins') return repo.isAnyWorkspaceAdmin(user_id);
  return false;
}

/** Does sign-in for this user need the emailed second step? */
export async function mfaAppliesTo(repo: Repo, user_id: string): Promise<boolean> {
  return (await repo.emailMfaEnabled(user_id)) || (await mfaRequiredFor(repo, user_id));
}

export async function hasTwoStep(repo: Repo, user_id: string): Promise<boolean> {
  return (await mfaAppliesTo(repo, user_id)) && (await repo.hasPassword(user_id));
}

/**
 * Whether a sign-in code or second-step token may be returned in the HTTP
 * response when no mailer is configured. Only for tests and local dev: on any
 * reachable server it would let anyone who knows an account's email sign in.
 */
export function inlineCodesAllowed(): boolean {
  return process.env.POMEGRANATE_DEV_INLINE_CODES === '1';
}

/**
 * Finish a first-factor sign-in.
 *
 * - password, MFA covers the account: email the second-step link instead of
 *   minting a session.
 * - magic link, MFA covers the account: refused when the account has a
 *   password (sign in with it); otherwise a session limited to setting one.
 * - anything else: the session.
 */
export async function completeFirstFactor(
  c: any,
  core: RouteCore,
  user: User,
  method: 'magic_link' | 'password',
  opts: { passwordChangeRequired?: boolean; forceMfa?: boolean } = {},
): Promise<Response> {
  const { repo, logAccountAudit } = core;
  const covered = opts.forceMfa || await mfaAppliesTo(repo, user.id);
  if (covered && method === 'password') {
    const mfa_token = await repo.createMfaChallenge(user.id, method, MFA_LINK_TTL_SEC);
    const sent = await sendMfaLink(core, user.email, mfa_token);
    // No mailer configured: hand the token back inline only in tests and local
    // dev (POMEGRANATE_DEV_INLINE_CODES=1), exactly as the magic-link endpoint
    // does with dev_code. Otherwise the link goes to the server log, so the
    // second factor can't be skipped by reading the response.
    return c.json({ error: 'mfa_required', method: 'email', ...(sent || !inlineCodesAllowed() ? {} : { dev_mfa_token: mfa_token }) }, 401);
  }
  let enrollmentRequired = false;
  if (covered) {
    if (await repo.hasPassword(user.id)) return c.json({ error: 'password_required' }, 403);
    enrollmentRequired = true;
  }
  const token = await repo.createSession(user.id, undefined, {
    mfaEnrollmentRequired: enrollmentRequired,
    passwordChangeRequired: opts.passwordChangeRequired,
  });
  await logAccountAudit(c, user, 'sign_in', { method });
  return c.json({
    session: token,
    user,
    ...(enrollmentRequired ? { mfa_enrollment_required: true } : {}),
    ...(opts.passwordChangeRequired ? { password_change_required: true } : {}),
  });
}

/** Email the second-step link. False when no mailer is configured. A
 *  delivery failure is logged and still reads as sent, like the magic link. */
export async function sendMfaLink(core: RouteCore, to: string, token: string): Promise<boolean> {
  const { resendConfig, smtpConfig, PUBLIC_ORIGIN } = core;
  const origin = PUBLIC_ORIGIN?.split(',')[0]?.trim();
  const { subject, text } = mfaLinkContent(token, origin);
  if (!resendConfig && !smtpConfig) {
    // Not returned over HTTP outside dev (see inlineCodesAllowed): the
    // operator reads the link from the server log instead.
    if (!inlineCodesAllowed()) {
      log.warn('auth.mfa_link_unsent', {
        reason: 'no mailer configured (set RESEND_API_KEY or SMTP_URL)',
        link: text.match(/https?:\/\/\S+/)?.[0],
        token,
      });
    }
    return false;
  }
  try {
    if (resendConfig) await sendMailViaResend({ config: resendConfig, to, subject, text });
    else await sendMail({ config: smtpConfig!, to, subject, text });
    log.info('auth.mfa_link_emailed', { to_domain: to.split('@')[1] ?? '?' });
  } catch (err) {
    log.warn('auth.mfa_link_email_failed', { msg: (err as Error).message?.slice(0, 200) });
  }
  return true;
}

/**
 * A failed password or second-factor attempt on a real account: audit it,
 * count it, and raise the alert (audit + warning log) when the account
 * crosses the threshold in the window. The lock itself is enforced at the
 * next attempt (repo.isAuthLocked).
 */
export async function noteAuthFailure(
  c: any,
  core: RouteCore,
  user: User,
  method: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { repo, logAccountAudit } = core;
  await logAccountAudit(c, user, 'sign_in_failed', { method, ...extra });
  const r = await repo.recordAuthFailure(user.id);
  if (r.alert || r.locked) {
    log.warn('auth.repeated_failures', { failures: r.failures, locked: r.locked });
  }
  if (r.alert) await logAccountAudit(c, user, 'sign_in_failures_alert', { failures: r.failures, locked: r.locked });
}

export function registerMfa(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
  const { authn, authRateLimit, repo, logAccountAudit } = core;

  // Second step of sign-in: the token from the emailed link. Single use.
  app.post('/auth/mfa/verify', authRateLimit, async (c) => {
    const parsed = z.object({ mfa_token: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const challenge = await repo.takeMfaChallenge(parsed.data.mfa_token);
    if (!challenge) return c.json({ error: 'expired' }, 401);
    const user = await repo.getUserById(challenge.user_id);
    if (!user) return c.json({ error: 'expired' }, 401);
    // disableUser drops outstanding challenges; this covers one that raced it.
    if (await repo.isUserDisabled(user.id)) return c.json({ error: 'expired' }, 401);
    if (await repo.isAuthLocked(user.id)) {
      log.warn('auth.sign_in_locked', { method: challenge.method, factor: 'mfa' });
      return c.json({ error: 'expired' }, 401);
    }
    await repo.clearAuthFailures(user.id);
    const passwordChangeRequired = await repo.passwordMustChange(user.id);
    const token = await repo.createSession(user.id, undefined, { passwordChangeRequired, viaSso: challenge.method === 'sso' });
    await logAccountAudit(c, user, 'sign_in', { method: challenge.method, mfa: 'email' });
    return c.json({ session: token, user, ...(passwordChangeRequired ? { password_change_required: true } : {}) });
  });

  // Status for the Setup card and the enrolment screen.
  app.get('/me/mfa', authn, async (c) => {
    const user_id = c.get('user_id');
    return c.json({
      enabled: await repo.emailMfaEnabled(user_id),
      required: await mfaRequiredFor(repo, user_id),
      has_password: await repo.hasPassword(user_id),
    });
  });

  // Turn it on. Needs a password: with MFA on, password + link is the only
  // way in, so an account without one would lock itself out.
  app.post('/me/mfa/enable', authn, async (c) => {
    const user_id = c.get('user_id');
    if (!(await repo.hasPassword(user_id))) return c.json({ error: 'password_required' }, 409);
    if (await repo.emailMfaEnabled(user_id)) return c.json({ error: 'already_enabled' }, 409);
    await repo.enableEmailMfa(user_id);
    const user = await repo.getUserById(user_id);
    if (user) await logAccountAudit(c, user, 'mfa_enabled', { method: 'email' });
    return c.json({ ok: true });
  });

  // Turn it off. Needs the current password, so a stolen session alone can't
  // strip the second step; refused when policy requires MFA.
  app.post('/me/mfa/disable', authn, authRateLimit, async (c) => {
    const user_id = c.get('user_id');
    const parsed = z
      .object({ current_password: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    if (await mfaRequiredFor(repo, user_id)) return c.json({ error: 'required_by_policy' }, 403);
    const hash = await repo.getPasswordHash(user_id);
    if (!hash || !(await verifyPassword(parsed.data.current_password, hash))) {
      return c.json({ error: 'invalid_current_password' }, 401);
    }
    await repo.disableEmailMfa(user_id);
    const user = await repo.getUserById(user_id);
    if (user) await logAccountAudit(c, user, 'mfa_disabled', { method: 'email' });
    return c.json({ ok: true });
  });
}

/** Paths a session signed in with an administrator-set password may use
 *  until its owner replaces it. */
export const PASSWORD_CHANGE_PATHS = new Set(['/me', '/me/password', '/auth/logout', '/auth/logout-all']);

/** Paths a session waiting on MFA enrolment (MFA required, no password yet)
 *  may use: enough to set the password. */
export const MFA_ENROLLMENT_PATHS = new Set([
  '/me',
  '/me/mfa',
  '/me/password',
  '/auth/logout',
  '/auth/logout-all',
]);
