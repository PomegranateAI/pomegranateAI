/**
 * The inbound side: a tiny HTTP server for WasenderAPI's webhook. Unlike
 * surfaces/slack (socket mode, no inbound ports), a WhatsApp webhook MUST be
 * a publicly reachable HTTPS URL, so this process listens on PORT and expects
 * to sit behind a TLS-terminating reverse proxy (see README.md's "Running in
 * production" section).
 *
 * No framework — two routes, plain `node:http`.
 */
import { createServer, type IncomingMessage as HttpIncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parseWebhookMessages } from './webhook.js';
import type { IncomingMessage } from './types.js';
import { logEvent } from './log.js';

export interface ServerDeps {
  webhookSecret: string;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  /** Per-IP webhook budget: burst, then one request per refillMs. */
  rateLimit?: { capacity: number; refillMs: number };
}

/** Largest webhook body accepted. Wasender posts JSON metadata; media is
 *  fetched separately by URL, so a large body is not a legitimate delivery. */
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Per-IP token bucket for the webhook. It runs BEFORE the secret check, so
 * nobody can try secrets at speed; the defaults (burst 120, then 4/s) sit far
 * above Wasender's delivery rate. WasenderAPI doesn't publish source IPs, so
 * this and the secret are the controls on this public path.
 */
class IpLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private readonly capacity: number, private readonly refillMs: number) {}
  take(key: string, now = Date.now()): boolean {
    if (this.buckets.size > 10_000) this.buckets.clear(); // bound memory under a flood
    const b = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.last) / this.refillMs);
    b.last = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

function clientIp(req: HttpIncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/** Constant-time comparison against the configured Wasender webhook secret. */
function secretOk(header: string | string[] | undefined, secret: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

class BodyTooLarge extends Error {}

function readBody(req: HttpIncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createWhatsappServer(deps: ServerDeps) {
  const limiter = new IpLimiter(deps.rateLimit?.capacity ?? 120, deps.rateLimit?.refillMs ?? 250);
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && req.url === '/webhook') {
        if (!limiter.take(clientIp(req))) {
          logEvent('warn', 'whatsapp_webhook_rate_limited', {});
          res.writeHead(429, { 'retry-after': '1' }).end();
          return;
        }
        if (!secretOk(req.headers['x-webhook-signature'], deps.webhookSecret)) {
          res.writeHead(401).end();
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          res.writeHead(err instanceof BodyTooLarge ? 413 : 400, { connection: 'close' }).end();
          return;
        }

        // WasenderAPI's docs: "Always respond with 200 OK quickly to
        // acknowledge receipt, even when processing occurs asynchronously."
        // Answer first, then fan the messages out to the relay handler.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        const messages = parseWebhookMessages(body);
        for (const msg of messages) {
          deps.onMessage(msg).catch((err) => {
            logEvent('error', 'whatsapp_message_unhandled', {
              phone: msg.phone,
              reason: (err as Error).message,
            });
          });
        }
        return;
      }

      res.writeHead(404).end();
    } catch (err) {
      logEvent('error', 'whatsapp_server_error', { reason: (err as Error).message });
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}
