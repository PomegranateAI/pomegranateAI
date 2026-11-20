// Routes: single sign-on and the SSO-required policy.
//
// OpenID Connect against the organisation's identity provider (Microsoft Entra ID or
// Google Workspace), configured from env:
//
//   SSO_OIDC_ISSUER        e.g. https://login.microsoftonline.com/<tenant-id>/v2.0
//                          or https://accounts.google.com
//   SSO_OIDC_CLIENT_ID     the app registration's client id
//   SSO_OIDC_CLIENT_SECRET its secret (or SSO_OIDC_CLIENT_SECRET_FILE, a Docker secret)
//   SSO_OIDC_REDIRECT_URI  default <PUBLIC_ORIGIN>/api/auth/sso/callback
//   SSO_ALLOWED_DOMAINS    comma-separated email domains (recommended)
//   SSO_LABEL              button text, e.g. "Microsoft" or "Google"
//   SSO_SESSION_HOURS      SSO session lifetime, default 12 (leavers drop off fast)
//   SSO_REQUIRED=1         email links and passwords off, except…
//   SSO_BREAK_GLASS_EMAILS …these admins (comma-separated): password + local
//                          two-step, for identity-provider outages
//   SSO_IDP_ENFORCES_MFA=1 the provider enforces MFA: SSO sessions count as
//                          two-step (sensitive directories, MFA_REQUIRED)
//
// Invitation only still holds: SSO signs in existing accounts, never creates
// one. Disabled accounts (SCIM / admin) are refused.

import type { Hono } from 'hono';
import { log } from '../../../lib/log.js';
import { OidcClient, OidcError, pkcePair, randomToken } from '../../../lib/oidc.js';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import { readFileSync } from 'node:fs';
import { inlineCodesAllowed, mfaAppliesTo, mfaRequiredFor, sendMfaLink } from './mfa.js';

export function ssoConfigured(env = process.env): boolean {
  return !!(env.SSO_OIDC_ISSUER && env.SSO_OIDC_CLIENT_ID && (env.SSO_OIDC_CLIENT_SECRET || env.SSO_OIDC_CLIENT_SECRET_FILE));
}

/** SSO_REQUIRED blocks this email's email-link and password sign-in (it isn't break-glass). */
export function ssoBlocksLocalSignIn(email: string, env = process.env): boolean {
  if (env.SSO_REQUIRED !== '1' || !ssoConfigured(env)) return false;
  return !breakGlassEmails(env).includes(email.trim().toLowerCase());
}

export function isBreakGlass(email: string, env = process.env): boolean {
  return env.SSO_REQUIRED === '1' && breakGlassEmails(env).includes(email.trim().toLowerCase());
}

function breakGlassEmails(env: NodeJS.ProcessEnv): string[] {
  return (env.SSO_BREAK_GLASS_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function clientSecret(env: NodeJS.ProcessEnv): string {
  if (env.SSO_OIDC_CLIENT_SECRET_FILE) return readFileSync(env.SSO_OIDC_CLIENT_SECRET_FILE, 'utf8').trim();
  return env.SSO_OIDC_CLIENT_SECRET ?? '';
}

export function registerSso(app: Hono<{ Variables: AppVars }>, core: RouteCore, fetchImpl?: typeof fetch): void {
  const { authRateLimit, repo, PUBLIC_ORIGIN, logAccountAudit } = core;
  const origin = () => (PUBLIC_ORIGIN?.split(',')[0]?.trim() || '').replace(/\/$/, '');

  let client: OidcClient | null = null;
  const getClient = (): OidcClient => {
    if (!client) {
      const env = process.env;
      client = new OidcClient(
        {
          issuer: env.SSO_OIDC_ISSUER!,
          clientId: env.SSO_OIDC_CLIENT_ID!,
          clientSecret: clientSecret(env),
          redirectUri: env.SSO_OIDC_REDIRECT_URI || `${origin()}/api/auth/sso/callback`,
          allowedDomains: (env.SSO_ALLOWED_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
        },
        fetchImpl,
      );
    }
    return client;
  };

  // In-flight logins and one-time hand-off codes (single server process, like
  // the magic-link codes). Both expire fast.
  const pending = new Map<string, { nonce: string; verifier: string; expires: number }>();
  const handoffs = new Map<string, { session?: string; mfaRequired?: boolean; devMfaToken?: string; user: unknown; expires: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    for (const [k, v] of handoffs) if (v.expires < now) handoffs.delete(k);
  };

  app.get('/auth/sso/config', (c) =>
    c.json({
      enabled: ssoConfigured(),
      required: ssoConfigured() && process.env.SSO_REQUIRED === '1',
      label: process.env.SSO_LABEL || 'your organisation',
    }),
  );

  app.get('/auth/sso/start', authRateLimit, async (c) => {
    if (!ssoConfigured()) return c.json({ error: 'sso_not_configured' }, 404);
    sweep();
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkcePair();
    pending.set(state, { nonce, verifier, expires: Date.now() + 10 * 60_000 });
    try {
      const hint = c.req.query('login_hint') || undefined;
      return c.redirect(await getClient().authorizationUrl({ state, nonce, codeChallenge: challenge, loginHint: hint }), 302);
    } catch (err) {
      log.warn('auth.sso_start_failed', { code: (err as OidcError).code ?? 'unknown' });
      return c.redirect(`${origin()}/?sso_error=provider_unreachable`, 302);
    }
  });

  app.get('/auth/sso/callback', authRateLimit, async (c) => {
    sweep();
    const fail = (code: string) => c.redirect(`${origin()}/?sso_error=${encodeURIComponent(code)}`, 302);
    if (c.req.query('error')) return fail('provider_denied');
    const state = c.req.query('state') ?? '';
    const flow = pending.get(state);
    pending.delete(state);
    if (!flow || flow.expires < Date.now()) return fail('expired');
    let email: string;
    try {
      ({ email } = await getClient().completeLogin({ code: c.req.query('code') ?? '', codeVerifier: flow.verifier, nonce: flow.nonce }));
    } catch (err) {
      const code = err instanceof OidcError ? err.code : 'sso_failed';
      log.warn('auth.sso_failed', { code });
      return fail(code === 'domain_not_allowed' ? 'domain_not_allowed' : 'sso_failed');
    }
    const user = await repo.findUserByEmail(email);
    if (!user) {
      log.warn('auth.sso_no_account', {});
      return fail('no_account');
    }
    if (await repo.isUserDisabled(user.id)) {
      await logAccountAudit(c, user, 'sign_in_failed', { method: 'sso', reason: 'disabled' });
      return fail('account_disabled');
    }
    const idpMfa = process.env.SSO_IDP_ENFORCES_MFA === '1';
    const handoff = randomToken();
    await repo.clearAuthFailures(user.id);
    // MFA comes from the identity provider when it enforces it. Otherwise the
    // account's own two-step applies: a second step if enrolled, enrollment
    // if the MFA_REQUIRED policy covers it.
    if (!idpMfa && await mfaAppliesTo(repo, user.id)) {
      const mfa_token = await repo.createMfaChallenge(user.id, 'sso');
      const sent = await sendMfaLink(core, user.email, mfa_token);
      handoffs.set(handoff, { mfaRequired: true, devMfaToken: sent || !inlineCodesAllowed() ? undefined : mfa_token, user, expires: Date.now() + 60_000 });
      return c.redirect(`${origin()}/?sso=${handoff}`, 302);
    }
    const hours = Number(process.env.SSO_SESSION_HOURS ?? 12);
    const session = await repo.createSession(user.id, Math.max(1, hours) * 3600, {
      viaSso: true,
      mfaEnrollmentRequired: idpMfa ? false : await mfaRequiredFor(repo, user.id),
    });
    await logAccountAudit(c, user, 'sign_in', { method: 'sso', idp_mfa: idpMfa });
    handoffs.set(handoff, { session, user, expires: Date.now() + 60_000 });
    return c.redirect(`${origin()}/?sso=${handoff}`, 302);
  });

  // The SPA trades the one-time hand-off code for its session (keeps the
  // session token out of the URL and browser history).
  app.post('/auth/sso/exchange', authRateLimit, async (c) => {
    sweep();
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const h = body.code ? handoffs.get(body.code) : undefined;
    if (!h || h.expires < Date.now()) return c.json({ error: 'expired' }, 401);
    handoffs.delete(body.code!);
    // Same shape as /auth/exchange, so the web app's sign-in flow (including
    // the second step) handles both.
    if (h.mfaRequired) return c.json({ error: 'mfa_required', method: 'email', ...(h.devMfaToken ? { dev_mfa_token: h.devMfaToken } : {}) }, 401);
    return c.json({ session: h.session, user: h.user, via_sso: true });
  });
}
