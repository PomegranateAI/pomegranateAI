import { createHash } from 'node:crypto';
import { clientIp } from '../../lib/client-ip.js';

/**
 * Simple in-process token-bucket rate limiter (spec C3).
 *
 * Also backs the API-wide limits in routes.ts (every route, per verified
 * credential or per IP; see rateLimitKey)
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
    const b = this.refilled(key, now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Whether `key` has a token to spend, without spending it. */
  available(key: string, now: number = Date.now()): boolean {
    return this.refilled(key, now).tokens >= 1;
  }

  private refilled(key: string, now: number): Bucket {
    this.maybeSweep(now);
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.opts.capacity, last: now };
      this.buckets.set(key, b);
    }
    // Lazy refill.
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(this.opts.capacity, b.tokens + elapsed / this.opts.refillIntervalMs);
      b.last = now;
    }
    return b;
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

export const hashCredential = (credential: string): string => createHash('sha256').update(credential).digest('hex').slice(0, 32);

/**
 * Credential checks under a per-IP failure budget, plus the set of credentials
 * that authenticated recently (only those get their own rate-limit bucket; see
 * rateLimitKey). One per app; every credential gate (session, MCP token,
 * connector secret, SCIM bearer, surface secret) goes through check().
 *
 * Failure budget: capacity 30 per client IP, one token back every 2s; override
 * with POMEGRANATE_AUTH_FAIL_RL_CAPACITY / _REFILL_MS. Each failed check spends
 * a token; with none left the request gets a 429 before the credential is
 * looked at, so a guesser cannot keep probing.
 */
export class AuthGuard {
  readonly failures: TokenBucketLimiter;
  /** credential hash -> expiry (ms). Map insertion order doubles as LRU order. */
  private readonly verified = new Map<string, number>();

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly maxVerified = 10_000,
    private readonly verifiedTtlMs = 10 * 60_000,
  ) {
    this.failures = limiterFromEnv('POMEGRANATE_AUTH_FAIL_RL', { capacity: 30, refillIntervalMs: 2000 }, env);
  }

  /**
   * Run `verify` for a presented `credential`. A truthy result marks the
   * credential verified; a falsy one spends a token of the client IP's failure
   * budget. With the budget empty, `verify` is not run and `limited` holds the
   * 429. No credential presented: `verify` runs unmetered (nothing to guess).
   */
  async check<T>(
    c: any,
    credential: string | undefined,
    verify: () => T | Promise<T>,
  ): Promise<{ value?: T; limited?: Response }> {
    if (!credential) return { value: await verify() };
    const ipKey = 'ip:' + (clientIp(c) ?? 'unknown');
    if (!this.failures.available(ipKey)) {
      const retryAfter = Math.max(1, this.failures.retryAfterSec(ipKey));
      return {
        limited: c.json({ error: 'rate_limited', retry_after_s: retryAfter }, 429, { 'retry-after': String(retryAfter) }),
      };
    }
    const value = await verify();
    if (value) this.markVerified(credential);
    else this.failures.take(ipKey);
    return { value };
  }

  markVerified(credential: string, now: number = Date.now()): void {
    const h = hashCredential(credential);
    this.verified.delete(h);
    this.verified.set(h, now + this.verifiedTtlMs);
    if (this.verified.size > this.maxVerified) this.verified.delete(this.verified.keys().next().value!);
  }

  isVerified(hash: string, now: number = Date.now()): boolean {
    const exp = this.verified.get(hash);
    if (exp === undefined) return false;
    if (exp > now) return true;
    this.verified.delete(hash);
    return false;
  }
}

/**
 * Who a request counts against: its credential (a session, pmg_ token, OAuth
 * token, or the secret in a /mcp/connector/:secret URL) once that credential
 * has authenticated recently, else its client IP. An unverified credential gets
 * no bucket of its own, so random Bearer values all share the IP's bucket.
 * Keys hold a hash, never the credential itself.
 */
export function rateLimitKey(c: any, ip: string | undefined, guard?: AuthGuard): string {
  const auth = c.req.header('Authorization') as string | undefined;
  const fromPath = /^\/mcp\/connector\/([^/]+)/.exec(new URL(c.req.url).pathname)?.[1];
  const credential = auth?.startsWith('Bearer ') ? auth.slice(7) : fromPath;
  if (credential && guard) {
    const h = hashCredential(credential);
    if (guard.isVerified(h)) return 'cred:' + h;
  }
  return 'ip:' + (ip ?? 'unknown');
}
