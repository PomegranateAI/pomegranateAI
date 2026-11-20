import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-api-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

// dynamic import after env is set
async function loadApp() {
  // server module mutates module-scope; re-import via fresh path
  const mod = await import('./server.js?test=' + Date.now());
  return mod;
}

async function magic(app: any, email: string) {
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

async function api(app: any, method: string, path: string, opts: { token?: string; ws?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.ws) headers['x-workspace-id'] = opts.ws;
  const r = await app.request(path, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

describe('API: auth + workspace + graph', () => {
  it('healthz', async () => {
    const { app } = await loadApp();
    const r = await app.request('/healthz');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });

  it('magic-link → exchange → create workspace → CRUD graph', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@example.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'Acme' } })).json;
    expect(ws.id).toMatch(/^ws_/);
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: foundingProfile } });
    const list1 = (await api(app, 'GET', `/workspaces/${ws.id}/graph`, { token })).json;
    expect(list1.nodes).toHaveLength(0);

    const node = {
      id: 'pos-killed-allinone',
      type: 'positioning',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      status: 'active',
      body: 'We are not the all-in-one platform',
      kind: 'killed_messaging',
    };
    const post = await api(app, 'POST', `/workspaces/${ws.id}/graph`, { token, body: node });
    expect(post.status).toBe(200);
    const list2 = (await api(app, 'GET', `/workspaces/${ws.id}/graph`, { token })).json;
    expect(list2.nodes).toHaveLength(1);

    const del = await api(app, 'DELETE', `/workspaces/${ws.id}/graph/${node.id}`, { token });
    expect(del.status).toBe(200);
    const list3 = (await api(app, 'GET', `/workspaces/${ws.id}/graph`, { token })).json;
    expect(list3.nodes).toHaveLength(0);
  });

  it('GET /graph?active=false includes archived nodes (for supersession chain rendering)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'graph@example.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'G' } })).json;
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: foundingProfile } });
    const TS = '2026-01-01T00:00:00Z';
    // One active, one that we'll archive
    for (const id of ['pos-a', 'pos-b']) {
      await api(app, 'POST', `/workspaces/${ws.id}/graph`, {
        token,
        body: {
          id,
          type: 'positioning',
          created_at: TS,
          updated_at: TS,
          status: 'active',
          body: id,
          kind: 'stance',
        },
      });
    }
    await api(app, 'DELETE', `/workspaces/${ws.id}/graph/pos-b`, { token });

    const activeOnly = (await api(app, 'GET', `/workspaces/${ws.id}/graph`, { token })).json;
    expect(activeOnly.nodes.map((n: any) => n.id)).toEqual(['pos-a']);

    const all = (await api(app, 'GET', `/workspaces/${ws.id}/graph?active=false`, { token })).json;
    expect(all.nodes.map((n: any) => n.id).sort()).toEqual(['pos-a', 'pos-b']);
    expect(all.nodes.find((n: any) => n.id === 'pos-b').status).toBe('archived');
  });

  it('isolation: user from workspace A cannot access workspace B', async () => {
    const { app } = await loadApp();
    const tokenA = await magic(app, 'alice@x.com');
    const tokenB = await magic(app, 'bob@y.com');
    const wsA = (await api(app, 'POST', '/workspaces', { token: tokenA, body: { profile_id: 'notes', name: 'A' } })).json;
    const forbidden = await api(app, 'GET', `/workspaces/${wsA.id}/graph`, { token: tokenB });
    expect(forbidden.status).toBe(403);
  });

  it('workspace app visibility is persisted per user + workspace', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'visibility@example.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'Visibility Test' } })).json;

    const listBefore = await api(app, 'GET', `/workspaces/${ws.id}/apps/visibility`, { token });
    expect(listBefore.status).toBe(200);
    expect(listBefore.json.visible_apps).toEqual([]);

    const add = await api(app, 'POST', `/workspaces/${ws.id}/apps/visibility/ask`, { token });
    expect(add.status).toBe(200);
    expect(add.json.visible_app).toBe('ask');

    const listAfterAdd = await api(app, 'GET', `/workspaces/${ws.id}/apps/visibility`, { token });
    expect(listAfterAdd.status).toBe(200);
    expect(listAfterAdd.json.visible_apps).toEqual(['ask']);

    const remove = await api(app, 'DELETE', `/workspaces/${ws.id}/apps/visibility/ask`, { token });
    expect(remove.status).toBe(200);
    expect(remove.json.ok).toBe(true);
    expect(remove.json.visible_app).toBe('ask');

    const listAfterRemove = await api(app, 'GET', `/workspaces/${ws.id}/apps/visibility`, { token });
    expect(listAfterRemove.status).toBe(200);
    expect(listAfterRemove.json.visible_apps).toEqual([]);
  });

  it('feedback endpoint returns findings (heuristic provider)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'cmo@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'Q' } })).json;
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: foundingProfile } });
    // Seed a banned phrase
    await api(app, 'POST', `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'pos-banned-synergy',
        type: 'positioning',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        body: 'synergy',
        kind: 'banned_phrase',
      },
    });
    const r = await api(app, 'POST', `/workspaces/${ws.id}/reviews`, {
      token,
      body: { deliverable: 'Unlock synergy across teams', kind: 'campaign' },
    });
    expect(r.status).toBe(200);
    expect(r.json.findings.length).toBeGreaterThan(0);
    const reds = r.json.findings.filter((f: any) => f.flag === 'red');
    expect(reds.length).toBeGreaterThan(0);
    expect(reds[0].node_id).toBe('pos-banned-synergy');
  });

  // The `/candidates/groups` endpoint (grouping a pending-review queue into
  // buckets) was removed with conversational curation — Light auto-applies
  // every candidate, so there is no pending queue left to group. See routes.ts
  // "Light auto-applies, always" (api.ingest).

  it('mcp token issuance: admin only', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'admin@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'M' } })).json;
    const r = await api(app, 'POST', `/workspaces/${ws.id}/mcp-tokens`, { token, body: {} });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^pmg_/);
  });

  it('audit log records workspace and graph events', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'aud@x.com');
    const ws = (await api(app, 'POST', '/workspaces', { token, body: { profile_id: 'notes', name: 'A' } })).json;
    await api(app, 'PUT', `/workspaces/${ws.id}/profile`, { token, body: { profile: foundingProfile } });
    await api(app, 'POST', `/workspaces/${ws.id}/graph`, {
      token,
      body: {
        id: 'pos-a',
        type: 'positioning',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        body: 'foo',
        kind: 'stance',
      },
    });
    const r = await api(app, 'GET', `/workspaces/${ws.id}/audit`, { token });
    const events = r.json.entries.map((e: any) => e.event);
    expect(events).toEqual(expect.arrayContaining(['workspace.created', 'graph.node.created']));
  });

  it('GET /team/directory lists domain teammates + workspaces, scoped to the caller domain', async () => {
    const { app } = await loadApp();
    // Two teammates on team.co, one outsider on other.co.
    const adaTok = await magic(app, 'ada@team.co');
    const benTok = await magic(app, 'ben@team.co');
    await magic(app, 'zoe@other.co');
    const wsA = (await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'Ada WS' } })).json;
    await api(app, 'POST', '/workspaces', { token: benTok, body: { profile_id: 'notes', name: 'Ben WS' } });

    const r = await api(app, 'GET', '/team/directory', { token: adaTok });
    expect(r.status).toBe(200);
    expect(r.json.domain).toBe('team.co');
    expect(r.json.domain_kind).toBe('org');
    expect(r.json.mcp_path).toBe('/mcp/server');
    const emails = r.json.users.map((u: any) => u.email).sort();
    expect(emails).toEqual(['ada@team.co', 'ben@team.co']); // outsider excluded
    const ada = r.json.users.find((u: any) => u.email === 'ada@team.co');
    expect(ada.workspaces.map((w: any) => w.id)).toContain(wsA.id);
    expect(ada.workspaces[0].profiles.length).toBeGreaterThanOrEqual(1);
  });

  // A personal email provider is not a company. Two people on gmail.com are
  // strangers, so the explorer must show each of them only their own folders.
  it('GET /team/directory does not group people who share a personal email provider', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada.explorer@gmail.com');
    const benTok = await magic(app, 'ben.explorer@gmail.com');
    const cleoTok = await magic(app, 'cleo.explorer@outlook.com');
    const adaWs = (
      await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'Ada Private' } })
    ).json;
    await api(app, 'POST', '/workspaces', { token: benTok, body: { profile_id: 'notes', name: 'Ben Private' } });

    const ada = await api(app, 'GET', '/team/directory', { token: adaTok });
    expect(ada.status).toBe(200);
    expect(ada.json.domain).toBe('gmail.com');
    expect(ada.json.domain_kind).toBe('personal');
    expect(ada.json.users.map((u: any) => u.email)).toEqual(['ada.explorer@gmail.com']);
    expect(JSON.stringify(ada.json)).not.toContain('Ben Private');

    const ben = await api(app, 'GET', '/team/directory', { token: benTok });
    expect(ben.json.users.map((u: any) => u.email)).toEqual(['ben.explorer@gmail.com']);
    expect(JSON.stringify(ben.json)).not.toContain('Ada Private');

    // Another provider is its own island too — and never sees the first.
    const cleo = await api(app, 'GET', '/team/directory', { token: cleoTok });
    expect(cleo.json.domain_kind).toBe('personal');
    expect(cleo.json.users.map((u: any) => u.email)).toEqual(['cleo.explorer@outlook.com']);

    // Sharing a provider is not a relationship: Ben cannot even petition Ada.
    const denied = await api(app, 'POST', `/workspaces/${adaWs.id}/request-access`, { token: benTok });
    expect(denied.status).toBe(403);

    // An invite is still the way in, and it is enough: Ben reaches the folder
    // he was added to without ever appearing in Ada's directory.
    await api(app, 'POST', `/workspaces/${adaWs.id}/members`, {
      token: adaTok,
      body: { email: 'ben.explorer@gmail.com', role: 'member' },
    });
    const benWorkspaces = await api(app, 'GET', '/workspaces', { token: benTok });
    expect(benWorkspaces.json.workspaces.map((w: any) => w.id)).toContain(adaWs.id);
    const adaAgain = await api(app, 'GET', '/team/directory', { token: adaTok });
    expect(adaAgain.json.users.map((u: any) => u.email)).toEqual(['ada.explorer@gmail.com']);
  });

  it('GET /team/directory requires auth', async () => {
    const { app } = await loadApp();
    const r = await api(app, 'GET', '/team/directory');
    expect(r.status).toBe(401);
  });

  it('directory reports viewer_role; per-folder connection links are gone', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada@share.co');
    const benTok = await magic(app, 'ben@share.co');
    const ws = (await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'Ada WS' } })).json;

    // Ada is a member (admin) of her workspace; Ben is not. viewer_role is the
    // whole access story now — a member reaches the folder with the connector
    // they already have, by naming it.
    const adaDir = (await api(app, 'GET', '/team/directory', { token: adaTok })).json;
    const adaWs = adaDir.users.find((u: any) => u.email === 'ada@share.co').workspaces.find((w: any) => w.id === ws.id);
    expect(adaWs.viewer_role).toBe('workspace_admin');
    expect(adaWs.has_mcp).toBeUndefined();

    const benDir = (await api(app, 'GET', '/team/directory', { token: benTok })).json;
    const benSeesAdaWs = benDir.users.find((u: any) => u.email === 'ada@share.co').workspaces.find((w: any) => w.id === ws.id);
    expect(benSeesAdaWs.viewer_role).toBeNull(); // Ben has no access

    // The per-folder connection-link route is retired — one connector per
    // person reaches every folder they belong to.
    const gone = await api(app, 'POST', `/workspaces/${ws.id}/connection-link`, { token: adaTok });
    expect(gone.status).toBe(404);
  });

  it('request-access: same-domain non-member emails owner (dev preview); membership blocks it', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada@req.co');
    const benTok = await magic(app, 'ben@req.co');
    const outTok = await magic(app, 'zoe@other.co');
    const ws = (await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'Ada WS' } })).json;

    // Ben (same domain, non-member) can request access — dev returns a preview to the owner.
    const req = await api(app, 'POST', `/workspaces/${ws.id}/request-access`, { token: benTok, body: { message: 'pls' } });
    expect(req.status).toBe(200);
    expect(req.json.preview.to).toBe('ada@req.co');
    expect(req.json.preview.text).toContain('pls');

    // Outsider on another domain is forbidden.
    const out = await api(app, 'POST', `/workspaces/${ws.id}/request-access`, { token: outTok });
    expect(out.status).toBe(403);

    // The owner (already a member) gets 409.
    const self = await api(app, 'POST', `/workspaces/${ws.id}/request-access`, { token: adaTok });
    expect(self.status).toBe(409);
  });

  it('request-access: a shared personal provider is not an org, but your own folder still is yours', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada.req@gmail.com');
    const benTok = await magic(app, 'ben.req@gmail.com');
    const ws = (
      await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'Ada Req' } })
    ).json;

    // Ben shares gmail.com with Ada — that buys him nothing.
    const denied = await api(app, 'POST', `/workspaces/${ws.id}/request-access`, { token: benTok });
    expect(denied.status).toBe(403);

    // Ada owns it, so she is already a member: 409, not the domain 403 — the
    // owner's own folder never depends on the domain relationship.
    const own = await api(app, 'POST', `/workspaces/${ws.id}/request-access`, { token: adaTok });
    expect(own.status).toBe(409);
  });

  it('members: admin adds + removes; owner cannot be removed; non-admin blocked', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada@team2.co');
    const ws = (await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'WS' } })).json;

    const add = await api(app, 'POST', `/workspaces/${ws.id}/members`, {
      token: adaTok,
      body: { email: 'ben@team2.co', role: 'member' },
    });
    expect(add.status).toBe(200);
    const benId = add.json.user_id;

    const members = (await api(app, 'GET', `/workspaces/${ws.id}/members`, { token: adaTok })).json.members;
    expect(members.map((m: any) => m.email).sort()).toEqual(['ada@team2.co', 'ben@team2.co']);

    // Ben (member, not admin) cannot add others.
    const benTok = await magic(app, 'ben@team2.co');
    const denied = await api(app, 'POST', `/workspaces/${ws.id}/members`, {
      token: benTok,
      body: { email: 'cat@team2.co' },
    });
    expect(denied.status).toBe(403);

    // Owner can't be removed.
    const adaId = members.find((m: any) => m.email === 'ada@team2.co').user_id;
    const rmOwner = await api(app, 'DELETE', `/workspaces/${ws.id}/members/${adaId}`, { token: adaTok });
    expect(rmOwner.status).toBe(400);

    // But Ben can be removed.
    const rmBen = await api(app, 'DELETE', `/workspaces/${ws.id}/members/${benId}`, { token: adaTok });
    expect(rmBen.status).toBe(200);
    const after = (await api(app, 'GET', `/workspaces/${ws.id}/members`, { token: adaTok })).json.members;
    expect(after.map((m: any) => m.email)).toEqual(['ada@team2.co']);
  });

  it('members: anyone can leave a directory themselves, except the owner and the last admin', async () => {
    const { app } = await loadApp();
    const adaTok = await magic(app, 'ada@leave.co');
    const ws = (await api(app, 'POST', '/workspaces', { token: adaTok, body: { profile_id: 'notes', name: 'WS' } })).json;
    const benId = (await api(app, 'POST', `/workspaces/${ws.id}/members`, { token: adaTok, body: { email: 'ben@leave.co', role: 'member' } })).json.user_id;
    const catId = (await api(app, 'POST', `/workspaces/${ws.id}/members`, { token: adaTok, body: { email: 'cat@leave.co', role: 'member' } })).json.user_id;
    const benTok = await magic(app, 'ben@leave.co');

    const listed = (await api(app, 'GET', `/workspaces/${ws.id}/members`, { token: benTok })).json.members;
    expect(listed.find((m: any) => m.email === 'ada@leave.co').is_owner).toBe(true);
    expect(listed.find((m: any) => m.email === 'ben@leave.co').is_owner).toBe(false);

    // A plain member still can't remove someone else...
    expect((await api(app, 'DELETE', `/workspaces/${ws.id}/members/${catId}`, { token: benTok })).status).toBe(403);
    // ...but can remove themselves, and then the directory is closed to them.
    expect((await api(app, 'DELETE', `/workspaces/${ws.id}/members/${benId}`, { token: benTok })).status).toBe(200);
    expect((await api(app, 'GET', `/workspaces/${ws.id}/members`, { token: benTok })).status).toBeGreaterThanOrEqual(403);

    // The owner can't leave their own directory.
    const adaId = listed.find((m: any) => m.email === 'ada@leave.co').user_id;
    expect((await api(app, 'DELETE', `/workspaces/${ws.id}/members/${adaId}`, { token: adaTok })).status).toBe(400);
  });
});
