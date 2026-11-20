import { createHash } from 'node:crypto';

/**
 * Simple in-process token-bucket rate limiter (spec C3).
 *
 * Also backs the API-wide limits in routes.ts (every route, per credential)
 * and the tighter one on the LLM-heavy routes (ingest, MCP).
 *
 * Used to throttle `/auth/*` — the only unauthenticated, abusable surface on
 * an internet-facing instance. In-process is sufficient for a single-server
 * topology (one app container); a distributed limiter is a Phase-2 concern if
 * the deploy ever fans out.
 *
 * Generous defaults so legitimate sign-in flows are never throttled:
 *   - capacity 20 tokens per client (burst), refilled at 1 token / 3s.
 * Override via env (POMEGRANATE_AUTH_RL_CAPACITY, POMEGRANATE_AUTH_RL_REFILL_MS).
 */
export interface TokenBucketOptions {
  /** Max tokens (burst capacity). */
  capacity: number;
  /** Milliseconds to regenerate one token. */
  refillIntervalMs: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly opts: TokenBucketOptions) {}

  /**
   * Try to consume one token for `key`. Returns true if allowed, false if the
   * bucket is empty. Refills lazily on each call (no timers).
   */
  take(key: string, now: number = Date.now()): boolean {
    this.maybeSweep(now);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, last: now };
      this.buckets.set(key, b);
    }
    // Lazy refill.
    const elapsed = now - b.last;
    if (elapsed > 0) {
      const refill = elapsed / this.opts.refillIntervalMs;
      b.tokens = Math.min(this.opts.capacity, b.tokens + refill);
      b.last = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Seconds until at least one token is available for `key` (for Retry-After). */
  retryAfterSec(key: string, now: number = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b || b.tokens >= 1) return 0;
    const needed = 1 - b.tokens;
    return Math.ceil((needed * this.opts.refillIntervalMs) / 1000);
  }

  /** Drop full buckets occasionally so memory doesn't grow unbounded. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets) {
      const elapsed = now - b.last;
      const refilled = Math.min(this.opts.capacity, b.tokens + elapsed / this.opts.refillIntervalMs);
      if (refilled >= this.opts.capacity) this.buckets.delete(k);
    }
  }

  /** Test seam: reset all state. */
  reset(): void {
    this.buckets.clear();
    this.lastSweep = Date.now();
  }
}

/** Build the /auth limiter from env, with generous defaults. */
export function authLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): TokenBucketLimiter {
  const capacity = Number(env.POMEGRANATE_AUTH_RL_CAPACITY ?? 20);
  const refillIntervalMs = Number(env.POMEGRANATE_AUTH_RL_REFILL_MS ?? 3000);
  return new TokenBucketLimiter({
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : 20,
    refillIntervalMs: Number.isFinite(refillIntervalMs) && refillIntervalMs > 0 ? refillIntervalMs : 3000,
  });
}

/** A limiter from `<PREFIX>_CAPACITY` / `<PREFIX>_REFILL_MS`, falling back to the given defaults. */
export function limiterFromEnv(
  prefix: string,
  defaults: TokenBucketOptions,
  env: NodeJS.ProcessEnv = process.env,
): TokenBucketLimiter {
  const capacity = Number(env[`${prefix}_CAPACITY`] ?? defaults.capacity);
  const refillIntervalMs = Number(env[`${prefix}_REFILL_MS`] ?? defaults.refillIntervalMs);
  return new TokenBucketLimiter({
    capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : defaults.capacity,
    refillIntervalMs: Number.isFinite(refillIntervalMs) && refillIntervalMs > 0 ? refillIntervalMs : defaults.refillIntervalMs,
  });
}

/**
 * Who a request counts against: its credential when it carries one (a session,
 * pmg_ token, OAuth token, or the secret in a /mcp/connector/:secret URL),
 * else its client IP. Keys hold a hash, never the credential itself.
 */
export function rateLimitKey(c: any, ip: string | undefined): string {
  const auth = c.req.header('Authorization') as string | undefined;
  const fromPath = /^\/mcp\/connector\/([^/]+)/.exec(new URL(c.req.url).pathname)?.[1];
  const credential = auth?.startsWith('Bearer ') ? auth.slice(7) : fromPath;
  if (credential) return 'cred:' + createHash('sha256').update(credential).digest('hex').slice(0, 32);
  return 'ip:' + (ip ?? 'unknown');
}
