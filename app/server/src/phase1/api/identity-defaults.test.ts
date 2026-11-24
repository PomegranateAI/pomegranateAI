import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Deterministic synth stub — this suite exercises identity/default CRUD, never
// the LLM, but server.js pulls the provider in transitively.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-idd-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  // These tests link identities directly; the link-code flow is covered in
  // identity-link.test.ts.
  process.env.POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK = '1';
});

async function loadApp() {
  return import('./server.js?idd=' + Date.now());
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

async function call(
  app: any,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

describe('profile: display name + slack identity', () => {
  it('GET /me returns email, display name, identities, defaults', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'ada@idd.example');
    const me = await call(app, 'GET', '/me', { token: session });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe('ada@idd.example');
    expect(me.json.display_name).toBeNull();
    expect(me.json.identities).toEqual([]);
    expect(me.json.defaults).toEqual([]);
  });

  it('PATCH /me sets and clears the display name', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'ada2@idd.example');
    const set = await call(app, 'PATCH', '/me', {
      token: session,
      body: { display_name: 'Ada Lovelace' },
    });
    expect(set.status).toBe(200);
    expect((await call(app, 'GET', '/me', { token: session })).json.display_name).toBe(
      'Ada Lovelace',
    );
    // Empty string clears (stored as NULL, not '').
    await call(app, 'PATCH', '/me', { token: session, body: { display_name: '' } });
    expect((await call(app, 'GET', '/me', { token: session })).json.display_name).toBeNull();
  });

  it('links a slack identity; a second user claiming the same one gets 409', async () => {
    const { app } = await loadApp();
    const ada = await magic(app, 'ada3@idd.example');
    const bob = await magic(app, 'bob3@idd.example');
    const linked = await call(app, 'PUT', '/me/identities/slack', {
      token: ada,
      body: { team_id: 'T01', external_id: 'U0AAA', handle: '@ada.l' },
    });
    expect(linked.status).toBe(200);
    // Handle is stored without the leading @.
    expect(linked.json.identity.handle).toBe('ada.l');

    const stolen = await call(app, 'PUT', '/me/identities/slack', {
      token: bob,
      body: { team_id: 'T01', external_id: 'U0AAA', handle: '@imposter' },
    });
    expect(stolen.status).toBe(409);

    // Re-linking by the same user updates the handle (upsert, not dup).
    const relinked = await call(app, 'PUT', '/me/identities/slack', {
      token: ada,
      body: { team_id: 'T01', external_id: 'U0AAA', handle: 'ada.lovelace' },
    });
    expect(relinked.status).toBe(200);
    const me = await call(app, 'GET', '/me', { token: ada });
    expect(me.json.identities).toHaveLength(1);
    expect(me.json.identities[0].handle).toBe('ada.lovelace');
  });
});

describe('default folder per surface', () => {
  it('sets, resolves (surface > all), and clears defaults; membership required', async () => {
    const { app, repo } = await loadApp();
    const session = await magic(app, 'carol@idd.example');
    const wsA = (
      await call(app, 'POST', '/workspaces', { token: session, body: { name: 'FolderA' } })
    ).json.id;
    const wsB = (
      await call(app, 'POST', '/workspaces', { token: session, body: { name: 'FolderB' } })
    ).json.id;

    // Non-member workspace → 403.
    const other = await magic(app, 'dave@idd.example');
    const denied = await call(app, 'PUT', '/me/defaults/all', {
      token: other,
      body: { workspace_id: wsA },
    });
    expect(denied.status).toBe(403);

    // 'all' default + slack-specific override.
    expect(
      (await call(app, 'PUT', '/me/defaults/all', { token: session, body: { workspace_id: wsA } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(app, 'PUT', '/me/defaults/slack', {
          token: session,
          body: { workspace_id: wsB },
        })
      ).status,
    ).toBe(200);

    // Resolution: surface-specific wins, 'all' is the fallback.
    const me = await call(app, 'GET', '/me', { token: session });
    const user_id = me.json.user_id as string;
    expect((await repo.getUserDefault(user_id, 'slack'))?.workspace_id).toBe(wsB);
    expect((await repo.getUserDefault(user_id, 'mcp'))?.workspace_id).toBe(wsA);

    // Invalid surface → 400.
    expect(
      (
        await call(app, 'PUT', '/me/defaults/webhook', {
          token: session,
          body: { workspace_id: wsA },
        })
      ).status,
    ).toBe(400);

    // Clear the slack override → falls back to 'all'.
    await call(app, 'DELETE', '/me/defaults/slack', { token: session });
    expect((await repo.getUserDefault(user_id, 'slack'))?.workspace_id).toBe(wsA);
  });

  it('a stale default (membership revoked) silently falls through at read time', async () => {
    const { app, repo } = await loadApp();
    const admin = await magic(app, 'erin@idd.example');
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: admin, body: { name: 'Shared' } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsId}/members`, {
      token: admin,
      body: { email: 'frank@idd.example', role: 'member' },
    });
    const frank = await magic(app, 'frank@idd.example');
    const set = await call(app, 'PUT', '/me/defaults/all', {
      token: frank,
      body: { workspace_id: wsId },
    });
    expect(set.status).toBe(200);
    const frankId = (await call(app, 'GET', '/me', { token: frank })).json.user_id as string;
    expect((await repo.getUserDefault(frankId, 'mcp'))?.workspace_id).toBe(wsId);

    // Remove Frank; the pointer must stop resolving (never imply access).
    await call(app, 'DELETE', `/workspaces/${wsId}/members/${frankId}`, { token: admin });
    expect(await repo.getUserDefault(frankId, 'mcp')).toBeUndefined();
  });
});

describe('directory projection', () => {
  it('team directory carries display_name, slack handle, and default folder', async () => {
    const { app } = await loadApp();
    const gina = await magic(app, 'gina@dir.example');
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: gina, body: { name: 'GinaFolder' } })
    ).json.id;
    await call(app, 'PATCH', '/me', { token: gina, body: { display_name: 'Gina Torres' } });
    await call(app, 'PUT', '/me/identities/slack', {
      token: gina,
      body: { team_id: 'T02', external_id: 'U0GGG', handle: 'gina.t' },
    });
    await call(app, 'PUT', '/me/defaults/all', { token: gina, body: { workspace_id: wsId } });

    const dir = await call(app, 'GET', '/team/directory', { token: gina });
    expect(dir.status).toBe(200);
    const row = dir.json.users.find((u: any) => u.email === 'gina@dir.example');
    expect(row.display_name).toBe('Gina Torres');
    expect(row.slack).toEqual({ team_id: 'T02', external_id: 'U0GGG', handle: 'gina.t' });
    expect(row.default_folder).toEqual({ workspace_id: wsId, surface: 'all' });
  });

  it('workspace members include display_name', async () => {
    const { app } = await loadApp();
    const hana = await magic(app, 'hana@dir.example');
    const wsId = (
      await call(app, 'POST', '/workspaces', { token: hana, body: { name: 'HanaFolder' } })
    ).json.id;
    await call(app, 'PATCH', '/me', { token: hana, body: { display_name: 'Hana Kim' } });
    const members = await call(app, 'GET', `/workspaces/${wsId}/members`, { token: hana });
    expect(members.status).toBe(200);
    expect(members.json.members[0].display_name).toBe('Hana Kim');
  });
});
