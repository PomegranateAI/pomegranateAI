import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Substitute the production Anthropic provider with the deterministic test
// stub so pull exercises the real ingest pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-apps-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?apps=' + Date.now());
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await app.request('/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json' },
  });
  const { dev_code } = await r1.json();
  const r2 = await app.request('/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code: dev_code }),
    headers: { 'content-type': 'application/json' },
  });
  const { session } = await r2.json();
  return session as string;
}

async function setupWs(app: any, token: string) {
  const r = await app.request('/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Apps' }),
  });
  return r.json() as any;
}

async function post(app: any, token: string, url: string, body: unknown) {
  const r = await app.request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

describe('apps connector registry (preview + pull)', () => {
  it('preview and pull answer app_not_connected until the user connects the app', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'apps-preview@test.dev');
    const ws = await setupWs(app, token);

    const preview = await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, { query: 'last week' });
    expect(preview.status).toBe(409);
    expect(preview.json).toMatchObject({ error: 'app_not_connected', app: 'gmail' });

    const pull = await post(app, token, `/workspaces/${ws.id}/apps/gmail/pull`, { query: 'last week', item_ids: ['x'] });
    expect(pull.status).toBe(409);
    expect(pull.json).toMatchObject({ error: 'app_not_connected', app: 'gmail' });
  });

  it('rejects unknown apps and invalid bodies', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'apps-invalid@test.dev');
    const ws = await setupWs(app, token);

    expect((await post(app, token, `/workspaces/${ws.id}/apps/dropbox/preview`, { query: 'x' })).status).toBe(404);
    expect((await post(app, token, `/workspaces/${ws.id}/apps/gmail/preview`, {})).status).toBe(400);
    expect((await post(app, token, `/workspaces/${ws.id}/apps/gmail/pull`, { query: 'x', item_ids: [] })).status).toBe(400);
  });

  it('reports every catalog app as disconnected with no Composio connection', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'apps-status@test.dev');
    const ws = await setupWs(app, token);

    const r = await app.request(`/workspaces/${ws.id}/apps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const { apps } = (await r.json()) as {
      apps: Array<{ id: string; name: string; connected: boolean }>;
    };
    const ids = apps.map((a) => a.id);
    expect(ids).toContain('github');
    expect(ids).toContain('jira');
    for (const a of apps) expect(a.connected).toBe(false);
  });
});
