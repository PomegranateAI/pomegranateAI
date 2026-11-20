import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Sign-in codes must never come back in an API response on a real server.
// With no mailer configured, only POMEGRANATE_DEV_INLINE_CODES=1 (set by
// vitest.config for the rest of the suite) may echo them; otherwise anyone
// who knows an account's email could sign in as that person.

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-inline-codes-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

afterEach(() => {
  process.env.POMEGRANATE_DEV_INLINE_CODES = '1';
});

async function loadApp() {
  return import('./server.js?inline-codes=' + Date.now());
}

async function post(app: any, pathname: string, body: unknown) {
  const r = await app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

describe('sign-in codes without a mailer', () => {
  it('magic link: returns the code only when POMEGRANATE_DEV_INLINE_CODES=1', async () => {
    const { app } = await loadApp();
    process.env.POMEGRANATE_DEV_INLINE_CODES = '1';
    const dev = await post(app, '/auth/magic-link', { email: 'dev@example.com' });
    expect(dev.status).toBe(200);
    expect(dev.json.dev_code).toBeTruthy();

    delete process.env.POMEGRANATE_DEV_INLINE_CODES;
    const prod = await post(app, '/auth/magic-link', { email: 'prod@example.com' });
    expect(prod.status).toBe(200);
    expect(prod.json).toEqual({ sent: true });
  });

  it('password reset: never returns the reset token unless the dev flag is set', async () => {
    const { app } = await loadApp();
    // Create the account first (the reset answer is identical for unknown emails).
    const link = await post(app, '/auth/magic-link', { email: 'reset@example.com' });
    await post(app, '/auth/exchange', { code: link.json.dev_code });

    delete process.env.POMEGRANATE_DEV_INLINE_CODES;
    const prod = await post(app, '/auth/password/forgot', { email: 'reset@example.com' });
    expect(prod.status).toBe(200);
    expect(prod.json).toEqual({ sent: true });

    process.env.POMEGRANATE_DEV_INLINE_CODES = '1';
    const dev = await post(app, '/auth/password/forgot', { email: 'reset@example.com' });
    expect(dev.json.dev_reset_token).toBeTruthy();
  });
});
