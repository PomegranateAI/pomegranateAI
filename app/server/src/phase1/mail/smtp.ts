/**
 * Minimal SMTP magic-link delivery (spec C2 / C3).
 *
 * When `SMTP_URL` is set, the magic-link code is emailed via a hand-rolled
 * SMTP client over Node's `net`/`tls` sockets — no new dependency (the spec
 * says prefer the lightest dependency, and a single transactional code email
 * doesn't justify pulling in nodemailer). When `SMTP_URL` is unset the auth
 * endpoint keeps returning the code inline (`dev_code`), so all existing tests
 * and local dev are unchanged.
 *
 * SMTP_URL format: `smtp://user:pass@host:port` or `smtps://user:pass@host:465`.
 *   - `smtps://` → implicit TLS from connect.
 *   - `smtp://`  → plaintext connect; STARTTLS is attempted when the server
 *     advertises it (port 587 style). Auth (AUTH LOGIN) only runs when a
 *     username is present in the URL.
 *
 * MAIL_FROM env overrides the envelope/header From (defaults to the SMTP user
 * or `no-reply@<host>`).
 *
 * This is deliberately small: it speaks just enough SMTP to deliver one short
 * plaintext message to one recipient. It is not a general mail library.
 */
import net from 'node:net';
import tls from 'node:tls';
import { log } from '../../lib/log.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // implicit TLS (smtps)
  user?: string;
  pass?: string;
  from: string;
}

/** Parse SMTP_URL into a config, or null when unset/blank (dev fallback). */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const raw = env.SMTP_URL?.trim();
  if (!raw) return null;
  const u = new URL(raw);
  const secure = u.protocol === 'smtps:';
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  const user = u.username ? decodeURIComponent(u.username) : undefined;
  const pass = u.password ? decodeURIComponent(u.password) : undefined;
  const from = env.MAIL_FROM?.trim() || user || `no-reply@${u.hostname}`;
  return { host: u.hostname, port, secure, user, pass, from };
}

/**
 * Subject + plaintext body for the magic-link email — shared between the SMTP
 * path here and the Resend HTTPS path (resend.ts). `text` uses `\n` newlines;
 * the SMTP path converts to CRLF when framing the RFC 5322 message.
 */
export function magicLinkContent(code: string, origin?: string): { subject: string; text: string } {
  const link = origin ? `${origin.replace(/\/$/, '')}/?code=${encodeURIComponent(code)}` : undefined;
  const bodyLines = [
    'Use this code to sign in to Pomegranate:',
    '',
    `    ${code}`,
    '',
    ...(link ? ['Or open this link:', '', `    ${link}`, ''] : []),
    'This code expires in 10 minutes. If you did not request it, ignore this email.',
  ];
  return { subject: 'Your Pomegranate sign-in link', text: bodyLines.join('\n') };
}

/**
 * The account email an admin sends from User admin: where to sign in, the
 * address, and the temporary password. `reset` is the same email for an
 * existing account whose password the admin replaced. The password is
 * temporary by construction — the account must choose its own at first
 * sign-in — and the second step (an emailed link) still follows it.
 */
export function passwordResetContent(token: string, origin?: string): { subject: string; text: string } {
  const base = origin ? origin.replace(/\/$/, '') : '';
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  return {
    subject: 'Reset your Pomegranate password',
    text: [
      'Someone asked to reset the password for your Pomegranate account. To choose a new one, open this link:',
      '',
      `    ${link}`,
      '',
      'The link works once, for 30 minutes.',
      '',
      'If you did not ask for this, you can ignore this email — your password stays the same.',
    ].join('\n'),
  };
}

export function accountInviteContent(opts: {
  email: string;
  password: string;
  origin?: string;
  reset?: boolean;
}): { subject: string; text: string } {
  const url = opts.origin ? opts.origin.replace(/\/$/, '') : '';
  const bodyLines = [
    opts.reset
      ? 'An administrator has set a new temporary password for your Pomegranate account.'
      : 'An administrator has created a Pomegranate account for you.',
    '',
    ...(url ? [`Sign in at:          ${url}`] : []),
    `Email:               ${opts.email}`,
    `Temporary password:  ${opts.password}`,
    '',
    'When you sign in you will be asked to choose your own password. After your',
    'password we email you a link to finish signing in — open it from this inbox.',
    '',
    'If you were not expecting this email, tell your administrator.',
  ];
  return {
    subject: opts.reset ? 'Your new Pomegranate temporary password' : 'Your Pomegranate account',
    text: bodyLines.join('\n'),
  };
}

/**
 * Subject + plaintext body for the second sign-in step (MFA): sent only after
 * a correct password, so the wording says so — an unexpected one means the
 * password is known to someone else. Link only, no code to copy: the token is
 * the whole credential.
 */
export function mfaLinkContent(token: string, origin?: string): { subject: string; text: string } {
  const base = origin ? origin.replace(/\/$/, '') : '';
  const link = `${base}/?mfa=${encodeURIComponent(token)}`;
  const bodyLines = [
    'Someone just entered your Pomegranate password. To finish signing in, open this link:',
    '',
    `    ${link}`,
    '',
    'This link expires in 10 minutes and works once.',
    '',
    'If this wasn’t you, don’t open the link, and change your password: someone else knows it.',
  ];
  return { subject: 'Finish signing in to Pomegranate', text: bodyLines.join('\n') };
}

/**
 * Send the magic-link email. Resolves on a 2xx final response, rejects on any
 * SMTP error or socket failure. The caller (auth endpoint) treats a rejection
 * as a soft failure: it logs and still returns `{ sent: true }` so the email
 * address isn't probed for existence via error timing.
 */
export async function sendMagicLinkEmail(opts: {
  config: SmtpConfig;
  to: string;
  code: string;
  origin?: string;
}): Promise<void> {
  const { subject, text } = magicLinkContent(opts.code, opts.origin);
  await sendMail({ config: opts.config, to: opts.to, subject, text });
  log.info('auth.magic_link_emailed', {
    host: opts.config.host,
    port: opts.config.port,
    to_domain: opts.to.split('@')[1] ?? '?',
  });
}

/**
 * Send an arbitrary plaintext transactional email over SMTP. Same delivery path
 * as the magic-link mail — the magic link is just one caller. `text` uses `\n`
 * newlines; they're converted to CRLF when framing the RFC 5322 message.
 */
export async function sendMail(opts: {
  config: SmtpConfig;
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  const message = buildMessage({
    from: opts.config.from,
    to: opts.to,
    subject: opts.subject,
    body: opts.text.replace(/\n/g, '\r\n'),
  });
  await deliver(opts.config, opts.to, message);
}

/** RFC 5322 message with CRLF line endings and dot-stuffing handled by deliver(). */
function buildMessage(opts: { from: string; to: string; subject: string; body: string }): string {
  const date = new Date().toUTCString();
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${opts.body}\r\n`;
}

// ─── tiny SMTP conversation ────────────────────────────────────────────

type Sock = net.Socket | tls.TLSSocket;

function deliver(config: SmtpConfig, to: string, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let active: Sock = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port });

    const ehloName = 'pomegranate';
    let buf = '';
    let settled = false;
    let starttlsUpgraded = false;
    let ehloAdvertisesStartTls = false;
    let phase = 0;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { active.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      try { active.end(); } catch { /* ignore */ }
      resolve();
    };
    const send = (line: string) => active.write(line + '\r\n');

    function onData(chunk: string) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // While in the EHLO phase, scan every line (continuation + final) for
        // advertised capabilities so we only attempt STARTTLS when offered.
        if (phase === 1 && /\bSTARTTLS\b/i.test(line)) ehloAdvertisesStartTls = true;
        // SMTP multiline: "250-" continuation, "250 " final. Act on final only.
        if (line.length >= 4 && line[3] === '-') continue;
        handleResponse(line);
      }
    }

    function wire(sock: Sock) {
      active = sock;
      sock.setEncoding('utf8');
      sock.setTimeout(15000, () => fail(new Error('SMTP timeout')));
      sock.on('data', onData);
      sock.on('error', fail);
    }

    wire(active);

    function handleResponse(line: string) {
      const code = Number(line.slice(0, 3));
      switch (phase) {
        case 0: // greeting → EHLO
          if (code !== 220) return fail(new Error(`SMTP greeting failed: ${line}`));
          phase = 1;
          return send(`EHLO ${ehloName}`);
        case 1: // EHLO → STARTTLS (plaintext) or AUTH/MAIL
          if (code !== 250) return fail(new Error(`EHLO failed: ${line}`));
          // Opportunistic STARTTLS: only when on a plaintext connection AND the
          // server advertised it. A server that doesn't offer STARTTLS (e.g. a
          // local relay or a test fixture) proceeds in the clear.
          if (!config.secure && !starttlsUpgraded && ehloAdvertisesStartTls) {
            phase = 2;
            return send('STARTTLS');
          }
          if (config.user) {
            phase = 3;
            return send('AUTH LOGIN');
          }
          phase = 5;
          return send(`MAIL FROM:<${envelopeAddr(config.from)}>`);
        case 2: // STARTTLS accepted → upgrade + re-EHLO
          if (code !== 220) return fail(new Error(`STARTTLS failed: ${line}`));
          return upgradeToTls();
        case 3: // AUTH LOGIN → username
          if (code !== 334) return fail(new Error(`AUTH LOGIN failed: ${line}`));
          phase = 4;
          return send(Buffer.from(config.user ?? '').toString('base64'));
        case 4: // username → password
          if (code !== 334) return fail(new Error(`AUTH user rejected: ${line}`));
          phase = 4.5;
          return send(Buffer.from(config.pass ?? '').toString('base64'));
        case 4.5: // auth result → MAIL FROM
          if (code !== 235) return fail(new Error(`AUTH failed: ${line}`));
          phase = 5;
          return send(`MAIL FROM:<${envelopeAddr(config.from)}>`);
        case 5: // MAIL FROM → RCPT TO
          if (code !== 250) return fail(new Error(`MAIL FROM rejected: ${line}`));
          phase = 6;
          return send(`RCPT TO:<${envelopeAddr(to)}>`);
        case 6: // RCPT TO → DATA
          if (code !== 250 && code !== 251) return fail(new Error(`RCPT TO rejected: ${line}`));
          phase = 7;
          return send('DATA');
        case 7: // DATA → body + dot
          if (code !== 354) return fail(new Error(`DATA rejected: ${line}`));
          phase = 8;
          // dot-stuffing: lines beginning '.' get an extra leading '.'
          return void active.write(message.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n');
        case 8: // accepted → QUIT
          if (code !== 250) return fail(new Error(`message not accepted: ${line}`));
          phase = 9;
          send('QUIT');
          return done();
      }
    }

    function upgradeToTls() {
      const plain = active as net.Socket;
      plain.removeListener('data', onData);
      plain.removeListener('error', fail);
      const upgraded = tls.connect({ socket: plain, servername: config.host }, () => {
        starttlsUpgraded = true;
        phase = 1;
        send(`EHLO ${ehloName}`);
      });
      wire(upgraded);
    }
  });
}

/** Strip display name, keep the bare addr-spec for envelope commands. */
function envelopeAddr(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m?.[1] ?? addr).trim();
}
