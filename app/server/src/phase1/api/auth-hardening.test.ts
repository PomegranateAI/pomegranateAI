import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-auth-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  // Tight bucket so the test deterministically trips the limiter, and a long
  // refill so it stays tripped for the duration of the test.
  process.env.POMEGRANATE_AUTH_RL_CAPACITY = '3';
  process.env.POMEGRANATE_AUTH_RL_REFILL_MS = '600000';
});

async function loadApp() {
  return import('./server.js?auth-hardening-test=' + Date.now());
}

function reqMagicLink(app: any, ip: string) {
  return app.request('/auth/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: 'rl@example.com' }),
  });
}

describe('/auth/* rate limiting (spec C3)', () => {
  it('throttles after the configured burst and reports retry-after', async () => {
    const { app } = await loadApp();
    const ip = '203.0.113.7';
    for (let i = 0; i < 3; i++) {
      const r = await reqMagicLink(app, ip);
      expect(r.status).toBe(200);
    }
    const blocked = await reqMagicLink(app, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = await blocked.json();
    expect(body.error).toBe('rate_limited');
  });

  it('throttles per-IP — a different client is unaffected', async () => {
    const { app } = await loadApp();
    // First IP exhausts its bucket.
    const ip1 = '198.51.100.1';
    for (let i = 0; i < 4; i++) await reqMagicLink(app, ip1);
    // A second IP still gets through.
    const r = await reqMagicLink(app, '198.51.100.2');
    expect(r.status).toBe(200);
  });
});

describe('magic-link dev fallback (SMTP_URL unset)', () => {
  it('returns the dev_code inline when no SMTP is configured', async () => {
    delete process.env.SMTP_URL;
    const { app } = await loadApp();
    const r = await app.request('/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.55' },
      body: JSON.stringify({ email: 'dev@example.com' }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.sent).toBe(true);
    expect(j.dev_code).toBeTruthy();
  });
});
