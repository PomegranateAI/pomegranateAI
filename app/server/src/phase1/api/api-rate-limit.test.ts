import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { buildApp } from './routes.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { AuthGuard, hashCredential, rateLimitKey } from './rate-limit.js';

const ENV = [
  'POMEGRANATE_API_RL_CAPACITY',
  'POMEGRANATE_API_RL_REFILL_MS',
  'POMEGRANATE_HEAVY_RL_CAPACITY',
  'POMEGRANATE_HEAVY_RL_REFILL_MS',
  'POMEGRANATE_AUTH_FAIL_RL_CAPACITY',
  'POMEGRANATE_AUTH_FAIL_RL_REFILL_MS',
  'SURFACE_AGENT_SECRET',
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

/** Hono env with a socket address, which is what clientIp() reads (no proxy hops trusted by default). */
const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const post = (body: unknown, token?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

async function signIn(app: any, email: string, ip = '10.0.0.1'): Promise<string> {
  const code = (await (await app.request('/auth/magic-link', post({ email }), from(ip))).json()).dev_code;
  return (await (await app.request('/auth/exchange', post({ code }), from(ip))).json()).session;
}

describe('API-wide rate limit', () => {
  it('throttles one credential with 429 + Retry-After, leaving others alone', async () => {
    process.env.POMEGRANATE_API_RL_CAPACITY = '6';
    process.env.POMEGRANATE_API_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    // The two sign-ins spend 4 of the per-IP bucket (no credential yet). Each
    // session's first request also counts against the IP; after that it is
    // verified and gets its own bucket.
    const a = await signIn(app, 'rl-a@example.com');
    const b = await signIn(app, 'rl-b@example.com');
    expect((await app.request('/me', bearer(b), from('10.0.0.1'))).status).toBe(200);
    const statuses: number[] = [];
    // a: 1 request on the IP bucket, then 6 on its own.
    for (let i = 0; i < 7; i++) statuses.push((await app.request('/me', bearer(a), from('10.0.0.1'))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200]);
    const limited = await app.request('/me', bearer(a), from('10.0.0.1'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // b has its own credential bucket, though the shared IP bucket is empty.
    expect((await app.request('/me', bearer(b), from('10.0.0.1'))).status).toBe(200);
    // Health checks are never limited.
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('puts random (unverified) Bearer values from one IP into that IP bucket', async () => {
    process.env.POMEGRANATE_API_RL_CAPACITY = '5';
    process.env.POMEGRANATE_API_RL_REFILL_MS = '60000';
    process.env.POMEGRANATE_AUTH_FAIL_RL_CAPACITY = '1000';
    const { app } = await fixture();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await app.request('/me', bearer(`random-${i}`), from('6.6.6.6'))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Another IP is untouched.
    expect((await app.request('/me', bearer('random-x'), from('7.7.7.7'))).status).toBe(401);
  });

  it('applies the tighter heavy limit to ingest', async () => {
    process.env.POMEGRANATE_HEAVY_RL_CAPACITY = '2';
    process.env.POMEGRANATE_HEAVY_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    const token = await signIn(app, 'rl-heavy@example.com');
    const ws = await (await app.request('/workspaces', post({ profile_id: 'notes', name: 'RL' }, token))).json();
    const ingest = () => app.request(`/workspaces/${ws.id}/ingest`, post({ text: '' }, token));
    expect((await ingest()).status).not.toBe(429);
    expect((await ingest()).status).not.toBe(429);
    expect((await ingest()).status).toBe(429);
    // Ordinary reads still go through.
    expect((await app.request('/me', bearer(token))).status).toBe(200);
  });
});

describe('credential failure limit (per IP)', () => {
  it('429s an IP that keeps sending invalid sessions, before checking them; other IPs unaffected', async () => {
    process.env.POMEGRANATE_AUTH_FAIL_RL_CAPACITY = '3';
    process.env.POMEGRANATE_AUTH_FAIL_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    const good = await signIn(app, 'fail-good@example.com', '2.2.2.2');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await app.request('/me', bearer(`sess_bogus${i}`), from('6.6.6.6'))).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // With the budget spent, the credential isn't even looked at.
    const r = await app.request('/me', bearer(good), from('6.6.6.6'));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    // A valid caller from another IP is unaffected.
    expect((await app.request('/me', bearer(good), from('2.2.2.2'))).status).toBe(200);
  });

  it('429s repeated invalid MCP tokens (well-formed pmg_ values) from one IP', async () => {
    process.env.POMEGRANATE_AUTH_FAIL_RL_CAPACITY = '4';
    process.env.POMEGRANATE_AUTH_FAIL_RL_REFILL_MS = '60000';
    const { app } = await fixture();
    const session = await signIn(app, 'fail-mcp@example.com', '3.3.3.3');
    const ws = await (await app.request('/workspaces', post({ profile_id: 'notes', name: 'MCP' }, session), from('3.3.3.3'))).json();
    const mcp = (await (await app.request(`/workspaces/${ws.id}/mcp-tokens`, post({}, session), from('3.3.3.3'))).json()).token as string;
    expect(mcp).toMatch(/^pmg_/);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const fake = mcp.slice(0, -1) + (mcp.endsWith('x') ? 'y' : 'x') + i;
      statuses.push((await app.request('/mcp/tools', bearer(fake), from('6.6.6.6'))).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
    // Bad connector secrets draw on the same budget.
    expect((await app.request('/mcp/connector/nope', { method: 'POST' }, from('6.6.6.6'))).status).toBe(429);
    // The real token from another IP still works.
    expect((await app.request('/mcp/tools', bearer(mcp), from('3.3.3.3'))).status).toBe(200);
  });

  it('429s a wrong X-Surface-Secret once the budget is spent', async () => {
    process.env.POMEGRANATE_AUTH_FAIL_RL_CAPACITY = '2';
    process.env.POMEGRANATE_AUTH_FAIL_RL_REFILL_MS = '60000';
    process.env.SURFACE_AGENT_SECRET = 'relay-secret';
    const { app } = await fixture();
    const due = (secret: string, ip: string) =>
      app.request('/agent/surface/automations/due?team_id=T1', { headers: { 'x-surface-secret': secret } }, from(ip));
    expect((await due('wrong-1', '6.6.6.6')).status).toBe(401);
    expect((await due('wrong-2', '6.6.6.6')).status).toBe(401);
    expect((await due('wrong-3', '6.6.6.6')).status).toBe(429);
    expect((await due('relay-secret', '6.6.6.6')).status).toBe(429);
    expect((await due('relay-secret', '4.4.4.4')).status).toBe(200);
  });

  it('leaves the expired-session-per-page-load flow alone under the default budget', async () => {
    const { app } = await fixture();
    for (let i = 0; i < 10; i++) expect((await app.request('/me', bearer('sess_expired'), from('5.5.5.5'))).status).toBe(401);
  });
});

describe('rateLimitKey', () => {
  const ctx = (url: string, auth?: string) => ({
    req: { url, header: (h: string) => (h === 'Authorization' ? auth : undefined) },
  });
  it('keys only a verified credential by its hash, never the credential itself', () => {
    const guard = new AuthGuard({});
    expect(rateLimitKey(ctx('https://x/me', 'Bearer sess_secret'), '1.2.3.4', guard)).toBe('ip:1.2.3.4');
    guard.markVerified('sess_secret');
    const k = rateLimitKey(ctx('https://x/me', 'Bearer sess_secret'), '1.2.3.4', guard);
    expect(k).toMatch(/^cred:[0-9a-f]{32}$/);
    expect(k).not.toContain('sess_secret');
    expect(rateLimitKey(ctx('https://x/mcp/connector/abcSecret'), '1.2.3.4', guard)).toBe('ip:1.2.3.4');
    guard.markVerified('abcSecret');
    expect(rateLimitKey(ctx('https://x/mcp/connector/abcSecret'), '1.2.3.4', guard)).toMatch(/^cred:/);
    expect(rateLimitKey(ctx('https://x/healthz'), '1.2.3.4', guard)).toBe('ip:1.2.3.4');
  });

  it('forgets verified credentials after the TTL and beyond the size bound', () => {
    const guard = new AuthGuard({}, 2, 1000);
    const t0 = 1_000_000;
    guard.markVerified('a', t0);
    guard.markVerified('b', t0);
    guard.markVerified('c', t0); // over the bound: evicts the oldest, 'a'
    expect(guard.isVerified(hashCredential('a'), t0)).toBe(false);
    expect(guard.isVerified(hashCredential('b'), t0)).toBe(true);
    expect(guard.isVerified(hashCredential('c'), t0 + 999)).toBe(true);
    expect(guard.isVerified(hashCredential('c'), t0 + 1001)).toBe(false);
  });
});
