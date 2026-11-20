// Routes: auth.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import type { User } from '../../db/repo.js';
import { log } from '../../../lib/log.js';
import { verifyPassword, DUMMY_PASSWORD_HASH, hashPassword, passwordPolicyError, isBreachedPassword } from '../../../lib/passwords.js';
import { sendMagicLinkEmail, passwordResetContent } from '../../mail/smtp.js';
import { sendMagicLinkViaResend } from '../../mail/resend.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import { completeFirstFactor, inlineCodesAllowed, noteAuthFailure } from './mfa.js';
import { isBreakGlass, ssoBlocksLocalSignIn } from './sso.js';

export function registerAuth(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  authn,
  authRateLimit,
  repo,
  resendConfig,
  smtpConfig,
  PUBLIC_ORIGIN,
  logAccountAudit,
  deliverEmail,
} = core;
// ---------- auth: magic link (mock email) ----------
const magicLinks = new Map<string, { email: string; expires: number }>();

// Sign-up policy. Closed (the default) means sign-in only works for accounts
// that already exist — provisioned by a workspace invite (POST /members creates
// the user ahead of first login) or an admin import. Unknown emails get a
// machine-readable `no_account`, plus CONTACT_EMAIL (or null) so clients can
// tell people who to ask. Read at request time (not module load) so tests can
// flip it per-case; the test suite runs open via vitest.config env.
function signupIsOpen(): boolean {
  return process.env.SIGNUP_MODE === 'open';
}
function contactEmail(): string | null {
  return process.env.CONTACT_EMAIL?.trim() || null;
}

app.post('/auth/magic-link', authRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: z.string().email() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid email' }, 400);
  // SSO_REQUIRED: sign in through the identity provider (routes/sso.ts).
  if (ssoBlocksLocalSignIn(parsed.data.email)) return c.json({ error: 'sso_required' }, 403);
  if (!signupIsOpen() && !await repo.findUserByEmail(parsed.data.email)) {
    return c.json({ error: 'no_account', contact: contactEmail() }, 403);
  }
  const code = nanoid(20);
  magicLinks.set(code, {
    email: parsed.data.email,
    expires: Date.now() + 10 * 60 * 1000,
  });
  // Mail delivery (spec C2): when RESEND_API_KEY or SMTP_URL is configured,
  // email the code and do NOT echo it in the response. With no mailer, the
  // code is never returned over HTTP unless POMEGRANATE_DEV_INLINE_CODES=1
  // (tests and local dev only): echoing it would let anyone who knows an
  // account's email sign in as them. Instead the sign-in link goes to the
  // server log, where only the operator can read it. Email send failure is
  // soft: log it and still report sent so the endpoint doesn't leak address
  // existence via error/timing.
  if (resendConfig || smtpConfig) {
    const origin = PUBLIC_ORIGIN?.split(',')[0]?.trim();
    try {
      if (resendConfig) {
        await sendMagicLinkViaResend({ config: resendConfig, to: parsed.data.email, code, origin });
      } else {
        await sendMagicLinkEmail({ config: smtpConfig!, to: parsed.data.email, code, origin });
      }
    } catch (err) {
      log.warn('auth.magic_link_email_failed', { msg: (err as Error).message?.slice(0, 200) });
    }
    return c.json({ sent: true });
  }
  if (inlineCodesAllowed()) return c.json({ sent: true, dev_code: code });
  const origin = PUBLIC_ORIGIN?.split(',')[0]?.trim();
  log.warn('auth.magic_link_unsent', {
    reason: 'no mailer configured (set RESEND_API_KEY or SMTP_URL)',
    to_domain: parsed.data.email.split('@')[1] ?? '?',
    link: origin ? `${origin.replace(/\/$/, '')}/?code=${encodeURIComponent(code)}` : undefined,
    code,
  });
  return c.json({ sent: true });
});

app.post('/auth/exchange', authRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ code: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid code' }, 400);
  const entry = magicLinks.get(parsed.data.code);
  if (!entry || entry.expires < Date.now()) return c.json({ error: 'expired' }, 401);
  magicLinks.delete(parsed.data.code);
  // Closed signup, defense in depth: even with a valid code, never mint an
  // account for an email that doesn't exist (e.g. the invite was revoked
  // between requesting the code and exchanging it).
  if (!signupIsOpen() && !await repo.findUserByEmail(entry.email)) {
    return c.json({ error: 'no_account', contact: contactEmail() }, 403);
  }
  if (ssoBlocksLocalSignIn(entry.email)) return c.json({ error: 'sso_required' }, 403);
  const user = await repo.findOrCreateUser(entry.email);
  if (await repo.isUserDisabled(user.id)) return c.json({ error: 'account_disabled' }, 403);
  return completeFirstFactor(c, core, user, 'magic_link', { forceMfa: isBreakGlass(user.email) });
});

// Password sign-in — a second, independent path onto the same session
// mechanism as magic-link exchange above. Nothing about this disables or
// supersedes the magic link: an account can have both, either, or (until a
// password is set) just the one. No account has a password by default —
// today an admin sets the first one out-of-band (pomegranate-user-admin's
// `password` subcommand); PUT /me/password (below, authenticated) lets a
// signed-in user change it afterwards.
app.post('/auth/password/login', authRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  if (ssoBlocksLocalSignIn(parsed.data.email)) return c.json({ error: 'sso_required' }, 403);
  const user = await repo.findUserByEmail(parsed.data.email);
  const hash = user ? await repo.getPasswordHash(user.id) : undefined;
  // Always run a real scrypt verify, even for an unknown email or an account
  // with no password set, against a fixed dummy hash — so response timing
  // can't be used to distinguish "no such account" from "wrong password".
  const ok = await verifyPassword(parsed.data.password, hash ?? DUMMY_PASSWORD_HASH);
  // An account locked after repeated failures answers exactly like a wrong
  // password (no oracle), even for the right one, until the lock expires.
  if (user && (await repo.isAuthLocked(user.id))) {
    log.warn('auth.sign_in_locked', { method: 'password' });
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (!user || !hash || !ok) {
    // A failed attempt against a real account is audited in that account's
    // workspaces (brute-force and credential-stuffing show up in the export).
    // Unknown emails have no workspace to log into; the app log records the
    // attempt without the address.
    if (user) await noteAuthFailure(c, core, user, 'password');
    else log.warn('auth.sign_in_failed', { method: 'password', known_account: false });
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (await repo.isUserDisabled(user.id)) return c.json({ error: 'invalid_credentials' }, 401);
  await repo.clearAuthFailures(user.id);
  return completeFirstFactor(c, core, user, 'password', {
    passwordChangeRequired: await repo.passwordMustChange(user.id),
    // Break-glass admins under SSO_REQUIRED must use local two-step.
    forceMfa: isBreakGlass(user.email),
  });
});

// Forgotten password. Step 1: email a single-use link (30 min). The answer is
// the same whether or not the address has an account, so this can't be used
// to find out who has one. Without a mailer the token comes back inline only
// under POMEGRANATE_DEV_INLINE_CODES=1 (tests, local dev), as the magic link
// and the MFA link do; otherwise the link goes to the server log.
app.post('/auth/password/forgot', authRateLimit, async (c) => {
  const parsed = z.object({ email: z.string().trim().email() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_email' }, 400);
  const email = parsed.data.email.toLowerCase();
  const user = await repo.findUserByEmail(email);
  if (!user || ssoBlocksLocalSignIn(email) || (await repo.isUserDisabled(user.id))) {
    log.info('auth.password_reset_requested', { known_account: false });
    return c.json({ sent: true });
  }
  const token = await repo.createPasswordResetToken(user.id);
  const origin = PUBLIC_ORIGIN?.split(',')[0]?.trim();
  const { subject, text } = passwordResetContent(token, origin);
  const delivered = await deliverEmail(user.email, subject, text);
  log.info('auth.password_reset_requested', { known_account: true, emailed: delivered });
  const mailerConfigured = !!(resendConfig || smtpConfig);
  if (!mailerConfigured && !inlineCodesAllowed()) {
    log.warn('auth.password_reset_unsent', {
      reason: 'no mailer configured (set RESEND_API_KEY or SMTP_URL)',
      link: text.match(/https?:\/\/\S+/)?.[0],
      token,
    });
  }
  return c.json({ sent: true, ...(mailerConfigured || !inlineCodesAllowed() ? {} : { dev_reset_token: token }) });
});

// Is a reset link still good? Lets the screen say "expired" up front instead
// of after the person has typed a new password twice. Spends nothing.
app.post('/auth/password/reset/check', authRateLimit, async (c) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ valid: false });
  return c.json({ valid: !!(await repo.peekPasswordResetToken(parsed.data.token)) });
});

// Step 2: spend the link and set the new password. Every session is ended
// (whoever had the old password is out), failed-attempt counters are cleared,
// and the person signs in normally afterwards — password, then the emailed
// sign-in link — so the reset link alone never yields a session.
app.post('/auth/password/reset', authRateLimit, async (c) => {
  const parsed = z
    .object({ token: z.string().min(1), new_password: z.string().min(1) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  // Check the password BEFORE spending the link, so a too-short password
  // doesn't burn it and send the person back to their inbox.
  const peekId = await repo.peekPasswordResetToken(parsed.data.token);
  const peekUser = peekId ? await repo.getUserById(peekId) : undefined;
  if (!peekUser) return c.json({ error: 'expired' }, 400);
  const policyError = passwordPolicyError(parsed.data.new_password, { email: peekUser.email });
  if (policyError) return c.json({ error: policyError }, 400);
  if (await isBreachedPassword(parsed.data.new_password)) {
    return c.json({ error: 'password has appeared in a data breach; choose another' }, 400);
  }
  const user_id = await repo.takePasswordResetToken(parsed.data.token);
  if (!user_id) return c.json({ error: 'expired' }, 400);
  const user = await repo.getUserById(user_id);
  if (!user || (await repo.isUserDisabled(user.id))) return c.json({ error: 'expired' }, 400);
  await repo.setPasswordHash(user.id, await hashPassword(parsed.data.new_password));
  const revoked = await repo.deleteUserSessions(user.id);
  await repo.clearAuthFailures(user.id);
  await logAccountAudit(c, user, 'password_changed', { via: 'reset_link', other_sessions_revoked: revoked });
  return c.json({ ok: true });
});

// Sign-out revokes the session server-side. Without this, "log out" only
// forgot the token in the browser: a copied or stolen token stayed valid until
// it expired.
app.post('/auth/logout', authn, async (c) => {
  const token = c.req.header('Authorization')!.slice(7);
  await repo.deleteSession(token);
  const user = await repo.getUserById(c.get('user_id'));
  if (user) await logAccountAudit(c, user, 'sign_out');
  return c.json({ ok: true });
});

// Sign out everywhere: revoke every session of the caller, this one included
// (lost laptop, shared computer). Connection tokens for assistants are managed
// separately in Setup.
app.post('/auth/logout-all', authn, async (c) => {
  const user_id = c.get('user_id');
  const revoked = await repo.deleteUserSessions(user_id);
  const user = await repo.getUserById(user_id);
  if (user) await logAccountAudit(c, user, 'sign_out', { all_sessions: true, revoked });
  return c.json({ ok: true, revoked });
});

}
