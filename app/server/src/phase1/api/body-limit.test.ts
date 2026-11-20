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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-body-limit-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

describe('request body size limits', () => {
  it('rejects an oversized body on an unauthenticated sign-in route', async () => {
    const { app } = await import('./server.js?body-limit=' + Date.now());
    const big = JSON.stringify({ email: 'a@example.com', pad: 'x'.repeat(200 * 1024) });
    const r = await app.request('/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    expect(r.status).toBe(413);
    expect((await r.json()).error).toBe('payload_too_large');
  });

  it('still accepts a normal sign-in request', async () => {
    const { app } = await import('./server.js?body-limit-ok=' + Date.now());
    const r = await app.request('/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com' }) });
    expect(r.status).toBe(200);
  });
});
