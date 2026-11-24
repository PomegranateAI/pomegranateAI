/**
 * Resend HTTPS magic-link delivery.
 *
 * Some cloud hosts block outbound SMTP ports (25/465/587), so the SMTP path
 * in smtp.ts can time out. When `RESEND_API_KEY` is set we deliver the same
 * message over Resend's HTTPS API (port 443) instead. This path takes
 * precedence over `SMTP_URL` when both are configured.
 *
 * MAIL_FROM is required with RESEND_API_KEY: it must be an address on a
 * domain you have verified with Resend.
 */
import { log } from '../../lib/log.js';
import { magicLinkContent, assertHeaderSafe, sanitizeSubject } from './smtp.js';

export interface ResendConfig {
  apiKey: string;
  from: string;
}

/** Parse RESEND_API_KEY into a config, or null when unset/blank (fall through to SMTP / dev). */
export function resendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const from = env.MAIL_FROM?.trim();
  if (!from) {
    log.warn('mail.resend_disabled', { reason: 'RESEND_API_KEY is set but MAIL_FROM is not' });
    return null;
  }
  return { apiKey, from };
}

/**
 * Send the magic-link email via Resend. Resolves on 2xx, rejects otherwise.
 * Same soft-failure contract as sendMagicLinkEmail: the auth endpoint logs a
 * rejection and still returns `{ sent: true }`.
 */
export async function sendMagicLinkViaResend(opts: {
  config: ResendConfig;
  to: string;
  code: string;
  origin?: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { subject, text } = magicLinkContent(opts.code, opts.origin);
  await sendMailViaResend({ config: opts.config, to: opts.to, subject, text, fetchImpl: opts.fetchImpl });
  log.info('auth.magic_link_emailed', { provider: 'resend', to_domain: opts.to.split('@')[1] ?? '?' });
}

/**
 * Send an arbitrary plaintext transactional email over Resend's HTTPS API.
 * Same delivery path as the magic-link mail — the magic link is just one
 * caller. Resolves on 2xx, rejects otherwise.
 */
export async function sendMailViaResend(opts: {
  config: ResendConfig;
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body (enables tracking pixels / rich formatting). */
  html?: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<void> {
  // Resend builds the headers, but refuse line breaks in addresses and flatten
  // them in the subject the same way the SMTP path does — defence in depth.
  assertHeaderSafe('from', opts.config.from);
  assertHeaderSafe('to', opts.to);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: opts.config.from,
      to: opts.to,
      subject: sanitizeSubject(opts.subject),
      text: opts.text,
      ...(opts.html ? { html: opts.html } : {}),
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
}
