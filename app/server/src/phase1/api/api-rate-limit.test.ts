import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from './routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { rateLimitKey } from './rate-limit.js';

const ENV = [
  'POMEGRANATE_API_RL_CAPACITY',
  'POMEGRANATE_API_RL_REFILL_MS',
  'POMEGRANATE_HEAVY_RL_CAPACITY',
  'POMEGRANATE_HEAVY_RL_REFILL_MS',
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pome-api-rl-'));
  const repo = new Repo(openDb(path.join(dir, 'db.sqlite')));
  const app = buildApp({ repo, synth: TestSynthStub, filesDir: path.join(dir, 'files') });
  return { app, repo };
}

async function signIn(app: any, email: string): Promise<string> {
  const m = await app.request('/auth/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  const code = (await m.json()).dev_code;
  const ex = await app.request('/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return (await ex.json()).session;
}

describe('API-wide rate limit', () => {
  it('throttles one credential with 429 + Retry-After, leaving others alone', async () => {
    process.env.POMEGRANATE_API_RL_CAPACITY = '5';
    process.env.POMEGRANATE_API_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    // The two sign-ins spend 4 of the per-IP bucket (no credential yet).
    const a = await signIn(app, 'rl-a@example.com');
    const b = await signIn(app, 'rl-b@example.com');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await app.request('/me', { headers: { Authorization: `Bearer ${a}` } })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    const limited = await app.request('/me', { headers: { Authorization: `Bearer ${a}` } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await app.request('/me', { headers: { Authorization: `Bearer ${b}` } })).status).toBe(200);
    // Health checks are never limited.
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('applies the tighter heavy limit to ingest', async () => {
    process.env.POMEGRANATE_HEAVY_RL_CAPACITY = '2';
    process.env.POMEGRANATE_HEAVY_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    const token = await signIn(app, 'rl-heavy@example.com');
    const ws = await (await app.request('/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ profile_id: 'notes', name: 'RL' }),
    })).json();
    const ingest = () =>
      app.request(`/workspaces/${ws.id}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: '' }),
      });
    expect((await ingest()).status).not.toBe(429);
    expect((await ingest()).status).not.toBe(429);
    expect((await ingest()).status).toBe(429);
    // Ordinary reads still go through.
    expect((await app.request('/me', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('rateLimitKey', () => {
  const ctx = (url: string, auth?: string) => ({
    req: { url, header: (h: string) => (h === 'Authorization' ? auth : undefined) },
  });
  it('keys by a hash of the credential, never the credential itself', () => {
    const k = rateLimitKey(ctx('https://x/me', 'Bearer sess_secret'), '1.2.3.4');
    expect(k).toMatch(/^cred:[0-9a-f]{32}$/);
    expect(k).not.toContain('sess_secret');
    expect(rateLimitKey(ctx('https://x/mcp/connector/abcSecret'), '1.2.3.4')).toMatch(/^cred:/);
    expect(rateLimitKey(ctx('https://x/healthz'), '1.2.3.4')).toBe('ip:1.2.3.4');
  });
});
