import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-closed-signup-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

afterEach(() => {
  // vitest.config runs the suite with SIGNUP_MODE=open; restore that after
  // each closed-mode case so ordering never leaks into other files.
  process.env.SIGNUP_MODE = 'open';
});

async function loadApp() {
  const mod = await import('./server.js?closed-signup=' + Date.now());
  return mod;
}

async function post(app: any, pathname: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await app.request(pathname, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

describe('closed signup (SIGNUP_MODE unset → invite-only sign-in)', () => {
  it('rejects magic-link for an unknown email with no_account + the configured contact', async () => {
    const { app } = await loadApp();
    delete process.env.SIGNUP_MODE;
    const r = await post(app, '/auth/magic-link', { email: 'stranger@example.com' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('no_account');
    expect(r.json.contact).toBeNull();
    process.env.CONTACT_EMAIL = 'admin@example.com';
    try {
      const r2 = await post(app, '/auth/magic-link', { email: 'stranger@example.com' });
      expect(r2.json.contact).toBe('admin@example.com');
    } finally {
      delete process.env.CONTACT_EMAIL;
    }
  });

  it('does not mint an account at exchange even with a valid code', async () => {
    const { app } = await loadApp();
    // Get a code while open (simulates an invite revoked mid-flow)…
    process.env.SIGNUP_MODE = 'open';
    const r1 = await post(app, '/auth/magic-link', { email: 'revoked@example.com' });
    expect(r1.status).toBe(200);
    // …then close signup before the exchange.
    delete process.env.SIGNUP_MODE;
    const r2 = await post(app, '/auth/exchange', { code: r1.json.dev_code });
    expect(r2.status).toBe(403);
    expect(r2.json.error).toBe('no_account');
  });

  it('lets an invited (pre-provisioned) user sign in while closed', async () => {
    const { app } = await loadApp();
    // Provision an owner while open, who then invites a teammate by email —
    // the invite creates the user row ahead of first login (routes POST
    // /workspaces/:ws/members → findOrCreateUser).
    process.env.SIGNUP_MODE = 'open';
    const m1 = await post(app, '/auth/magic-link', { email: 'owner@example.com' });
    const ex1 = await post(app, '/auth/exchange', { code: m1.json.dev_code });
    const token = ex1.json.session as string;
    const ws = await post(app, '/workspaces', { name: 'Acme' }, token);
    const invite = await post(
      app,
      `/workspaces/${ws.json.id}/members`,
      { email: 'invited@example.com', role: 'member' },
      token,
    );
    expect(invite.status).toBe(200);

    delete process.env.SIGNUP_MODE;
    const m2 = await post(app, '/auth/magic-link', { email: 'invited@example.com' });
    expect(m2.status).toBe(200);
    const ex2 = await post(app, '/auth/exchange', { code: m2.json.dev_code });
    expect(ex2.status).toBe(200);
    expect(ex2.json.user.email).toBe('invited@example.com');

    // And the owner themselves can still sign in again while closed.
    const m3 = await post(app, '/auth/magic-link', { email: 'owner@example.com' });
    expect(m3.status).toBe(200);
  });
});
