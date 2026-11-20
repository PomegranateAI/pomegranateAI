/**
 * Delivery transports for Subscribe to Updates (spec §7). A tiny interface with
 * pluggable implementations — no new infra. Email rides Resend's HTTPS API;
 * Slack (U3) posts via chat.postMessage over HTTPS with a bot token — the same
 * port-443 posture as email, so a host's SMTP block is irrelevant to
 * both. A logging transport stands in for either when its credential is unset.
 */
import { resendConfigFromEnv, sendMailViaResend, type ResendConfig } from '../mail/resend.js';
import { log } from '../../lib/log.js';

export interface UpdateMessage {
  to: string;
  title: string;
  body: string;
  /** Absolute link the "Open" affordance points at (may be a tracked redirect). */
  link?: string;
  /** Absolute URL of a 1×1 open-tracking pixel (email only); omitted = no pixel. */
  openPixelUrl?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface UpdateTransport {
  readonly medium: 'email' | 'slack';
  send(msg: UpdateMessage): Promise<void>;
}

/** Email via Resend's HTTPS API — the same transactional path as magic-link mail. */
export class EmailTransport implements UpdateTransport {
  readonly medium = 'email' as const;
  constructor(private readonly config: ResendConfig) {}

  async send(msg: UpdateMessage): Promise<void> {
    const text = msg.link ? `${msg.body}\n\n---\nOpen in Pomegranate: ${msg.link}` : msg.body;
    // HTML gives us the "Open" button + a 1×1 open-tracking pixel. Body is
    // plain paragraphs (already prose); the link is a tracked redirect.
    const paras = escapeHtml(msg.body)
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 14px;line-height:1.5">${p.replace(/\n/g, '<br/>')}</p>`)
      .join('');
    const button = msg.link
      ? `<p style="margin:18px 0 0"><a href="${msg.link}" style="display:inline-block;background:#D5402B;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">Open in Pomegranate →</a></p>`
      : '';
    const pixel = msg.openPixelUrl
      ? `<img src="${msg.openPixelUrl}" width="1" height="1" alt="" style="display:none"/>`
      : '';
    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#211c17;max-width:560px"><h2 style="font-weight:600;margin:0 0 12px">${escapeHtml(
      msg.title,
    )}</h2>${paras}${button}${pixel}</div>`;
    await sendMailViaResend({ config: this.config, to: msg.to, subject: msg.title, text, html });
  }
}

/**
 * Slack via chat.postMessage (HTTPS). `to` is either a channel id/name (post
 * there directly) or a Slack user id `U…`/`W…` (open a DM first). Formats the
 * update as Block Kit — header, body, a context line, and an "Open" link button
 * — with the plain body as the notification fallback text.
 */
export class SlackTransport implements UpdateTransport {
  readonly medium = 'slack' as const;
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.ok !== true) {
      throw new Error(`Slack ${method}: ${json.error ?? res.status}`);
    }
    return json;
  }

  async send(msg: UpdateMessage): Promise<void> {
    // A user id → open a DM channel; anything else is used as the channel as-is.
    let channel = msg.to;
    if (/^[UW][A-Z0-9]+$/.test(msg.to)) {
      const opened = await this.api('conversations.open', { users: msg.to });
      const ch = (opened.channel as { id?: string } | undefined)?.id;
      if (!ch) throw new Error('Slack conversations.open returned no channel');
      channel = ch;
    }
    const blocks: unknown[] = [
      { type: 'header', text: { type: 'plain_text', text: msg.title.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: msg.body.slice(0, 2900) } },
    ];
    if (msg.link) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open update ↗' },
            url: msg.link,
          },
        ],
      });
    }
    await this.api('chat.postMessage', { channel, blocks, text: `${msg.title} — ${msg.body}`.slice(0, 3000) });
  }
}

/**
 * Parse the Slack bot token from env, or null when unset. Prefers SLACK_BOT_TOKEN
 * — the same bot token the Slack surface already uses — so no new secret is
 * needed; the POMEGRANATE_/UPDATES_ names are accepted as explicit overrides.
 */
export function slackTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.SLACK_BOT_TOKEN?.trim() ||
    env.POMEGRANATE_SLACK_TOKEN?.trim() ||
    env.UPDATES_SLACK_TOKEN?.trim() ||
    null
  );
}

/**
 * Dev/offline transport — records that a send "happened" via the logger without
 * hitting a network. Used when a medium's credential is unset so the scheduler
 * still completes a run (delivery is recorded; engagement just can't be measured).
 */
export class LoggingTransport implements UpdateTransport {
  constructor(readonly medium: 'email' | 'slack' = 'email') {}
  async send(msg: UpdateMessage): Promise<void> {
    log.info('updates.delivery_logged', {
      medium: this.medium,
      to_domain: msg.to.includes('@') ? msg.to.split('@')[1] : msg.to,
      title_len: msg.title.length,
    });
  }
}

/**
 * Build the default transport set from the environment. Each medium uses its
 * real transport when its credential is present, else a logging stand-in so a
 * run still completes (delivery recorded, send is a no-op).
 */
export function defaultTransports(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<'email' | 'slack', UpdateTransport>> {
  const resend = resendConfigFromEnv(env);
  const slackToken = slackTokenFromEnv(env);
  return {
    email: resend ? new EmailTransport(resend) : new LoggingTransport('email'),
    slack: slackToken ? new SlackTransport(slackToken) : new LoggingTransport('slack'),
  };
}
