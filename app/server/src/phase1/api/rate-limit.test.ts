import { describe, it, expect } from 'vitest';
import { TokenBucketLimiter, authLimiterFromEnv } from './rate-limit.js';

describe('TokenBucketLimiter', () => {
  it('allows up to capacity, then throttles', () => {
    const rl = new TokenBucketLimiter({ capacity: 3, refillIntervalMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(false); // bucket empty
  });

  it('refills over time', () => {
    const rl = new TokenBucketLimiter({ capacity: 2, refillIntervalMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(false);
    // 1.1s later → ~1 token regenerated.
    expect(rl.take('ip', t0 + 1100)).toBe(true);
    expect(rl.take('ip', t0 + 1100)).toBe(false);
  });

  it('isolates buckets per key', () => {
    const rl = new TokenBucketLimiter({ capacity: 1, refillIntervalMs: 1000 });
    const t0 = 1_000_000;
    expect(rl.take('a', t0)).toBe(true);
    expect(rl.take('a', t0)).toBe(false);
    expect(rl.take('b', t0)).toBe(true); // separate bucket
  });

  it('reports a retry-after when throttled', () => {
    const rl = new TokenBucketLimiter({ capacity: 1, refillIntervalMs: 3000 });
    const t0 = 1_000_000;
    rl.take('ip', t0);
    expect(rl.take('ip', t0)).toBe(false);
    expect(rl.retryAfterSec('ip', t0)).toBe(3);
  });
});

describe('authLimiterFromEnv', () => {
  it('uses generous defaults when env is unset', () => {
    const rl = authLimiterFromEnv({} as NodeJS.ProcessEnv);
    const t0 = 2_000_000;
    // Default capacity is 20 — twenty sign-in attempts in a burst are fine.
    for (let i = 0; i < 20; i++) expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(false);
  });

  it('honors env overrides', () => {
    const rl = authLimiterFromEnv({
      POMEGRANATE_AUTH_RL_CAPACITY: '2',
      POMEGRANATE_AUTH_RL_REFILL_MS: '5000',
    } as unknown as NodeJS.ProcessEnv);
    const t0 = 3_000_000;
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(true);
    expect(rl.take('ip', t0)).toBe(false);
  });
});
