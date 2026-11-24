import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Deterministic synth stub — folder scoping never needs the LLM, but
// server.js pulls the provider in transitively.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-fold-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  // These tests link identities directly; the link-code flow is covered in
  // identity-link.test.ts.
  process.env.POMEGRANATE_ALLOW_UNVERIFIED_IDENTITY_LINK = '1';
});

async function loadApp() {
  return import('../api/server.js?fold=' + Date.now());
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
  return (await r2.json()).session as string;
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

function nodeBody(id: string, body: string) {
  return {
    id,
    type: 'note',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    body,
  };
}

/**
 * Fixture: Alice owns FolderA (token minted there) and is a member of Bob's
 * FolderB. Carol owns FolderC and is a member of nothing else.
 *
 * Every setup() runs against the SAME on-disk DB (one tmpdir per file), so
 * each fixture gets its own email DOMAIN — name/display-name resolution is
 * domain-scoped, and reusing a domain would make folder names ambiguous
 * across tests.
 */
let fixtureSeq = 0;
async function setup() {
  const mod = await loadApp();
  const { app, repo } = mod;
  const domain = `fold${++fixtureSeq}.example`;
  const emails = {
    alice: `alice@${domain}`,
    bob: `bob@${domain}`,
    carol: `carol@${domain}`,
  };
  const alice = await magic(app, emails.alice);
  const bob = await magic(app, emails.bob);
  const carol = await magic(app, emails.carol);

  const wsA = (await call(app, 'POST', '/workspaces', { token: alice, body: { profile_id: 'notes', name: 'FolderA' } }))
    .json.id;
  const wsB = (await call(app, 'POST', '/workspaces', { token: bob, body: { profile_id: 'notes', name: 'FolderB' } }))
    .json.id;
  const wsC = (await call(app, 'POST', '/workspaces', { token: carol, body: { profile_id: 'notes', name: 'FolderC' } }))
    .json.id;
  await call(app, 'POST', `/workspaces/${wsB}/members`, {
    token: bob,
    body: { email: emails.alice, role: 'member' },
  });

  // A recognizable node in each folder.
  await call(app, 'POST', `/workspaces/${wsA}/graph`, {
    token: alice,
    body: nodeBody('pos-in-a', 'folder A stance'),
  });
  await call(app, 'POST', `/workspaces/${wsB}/graph`, {
    token: bob,
    body: nodeBody('pos-in-b', 'folder B stance'),
  });

  const aliceToken = (
    await call(app, 'POST', `/workspaces/${wsA}/mcp-tokens`, { token: alice, body: {} })
  ).json.token as string;
  const carolToken = (
    await call(app, 'POST', `/workspaces/${wsC}/mcp-tokens`, { token: carol, body: {} })
  ).json.token as string;

  return { app, repo, alice, bob, carol, wsA, wsB, wsC, aliceToken, carolToken, domain, emails, tag: fixtureSeq };
}

async function recentIds(app: any, token: string, folder?: string): Promise<string[]> {
  const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
    token,
    body: { since: '1970-01-01T00:00:00Z', ...(folder ? { folder } : {}) },
  });
  expect(r.status).toBe(200);
  return r.json.nodes.map((n: any) => n.id);
}

describe('MCP folder targeting (membership-gated)', () => {
  it('AI access off hides a directory from agents while human members retain access', async () => {
    const { app, alice, bob, wsB, aliceToken } = await setup();
    expect((await call(app, 'PUT', `/workspaces/${wsB}/ai-access`, { token: alice, body: { ai_allowed: false } })).status).toBe(403);
    expect((await call(app, 'PUT', `/workspaces/${wsB}/ai-access`, { token: bob, body: { ai_allowed: false } })).status).toBe(200);
    const bobToken = (await call(app, 'POST', `/workspaces/${wsB}/mcp-tokens`, { token: bob, body: {} })).json.token as string;
    expect((await call(app, 'POST', '/mcp/tools/search_context', { token: bobToken, body: { query: 'folder B' } })).status).toBe(404);

    const listed = await call(app, 'POST', '/mcp/tools/list_folders', { token: aliceToken, body: {} });
    expect(listed.json.folders.some((f: any) => f.id === wsB)).toBe(false);
    const explored = await call(app, 'POST', '/mcp/tools/explore_team_folders', { token: aliceToken, body: {} });
    expect(explored.json.people.flatMap((p: any) => p.folders).some((f: any) => f.id === wsB)).toBe(false);
    expect((await call(app, 'POST', '/mcp/tools/list_recent_changes', { token: aliceToken, body: { folder: wsB } })).status).toBe(404);
    expect((await call(app, 'GET', `/workspaces/${wsB}/members`, { token: alice })).status).toBe(200);
    expect((await call(app, 'GET', `/workspaces/${wsB}/ai-access`, { token: alice })).json.ai_allowed).toBe(false);

    await call(app, 'PUT', `/workspaces/${wsB}/ai-access`, { token: bob, body: { ai_allowed: true } });
    expect(await recentIds(app, aliceToken, wsB)).toContain('pos-in-b');
  });

  it('targets a shared folder by id and by name; results come from the target', async () => {
    const { app, aliceToken, wsB } = await setup();
    expect(await recentIds(app, aliceToken)).toContain('pos-in-a');

    const byId = await recentIds(app, aliceToken, wsB);
    expect(byId).toContain('pos-in-b');
    expect(byId).not.toContain('pos-in-a');

    const byName = await recentIds(app, aliceToken, 'FolderB');
    expect(byName).toContain('pos-in-b');
  });

  it('resolves a teammate by email / @handle / display name to their default folder', async () => {
    const { app, aliceToken, bob, wsB, emails, tag } = await setup();
    // Bob names himself, links Slack, and sets FolderB as his default.
    await call(app, 'PATCH', '/me', { token: bob, body: { display_name: 'Bob Builder' } });
    await call(app, 'PUT', '/me/identities/slack', {
      token: bob,
      body: { team_id: 'T0F', external_id: `U0BOB${tag}`, handle: `bob.builder${tag}` },
    });
    await call(app, 'PUT', '/me/defaults/all', { token: bob, body: { workspace_id: wsB } });

    expect(await recentIds(app, aliceToken, emails.bob)).toContain('pos-in-b');
    expect(await recentIds(app, aliceToken, `@bob.builder${tag}`)).toContain('pos-in-b');
    expect(await recentIds(app, aliceToken, `U0BOB${tag}`)).toContain('pos-in-b');
    expect(await recentIds(app, aliceToken, 'Bob Builder')).toContain('pos-in-b');
  });

  it('with no default set, a teammate ref falls back to the single shared folder', async () => {
    const { app, aliceToken, emails } = await setup();
    // Alice and Bob share exactly FolderB; Bob has no default folder.
    expect(await recentIds(app, aliceToken, emails.bob)).toContain('pos-in-b');
  });

  it('with no default set, a teammate ref resolves to the folder of their last activity', async () => {
    const { app, aliceToken, bob, emails } = await setup();
    // Bob shares a SECOND folder with Alice — the single-shared fallback can
    // no longer decide — and his most recent activity is in the new one.
    const wsB2 = (
      await call(app, 'POST', '/workspaces', { token: bob, body: { profile_id: 'notes', name: 'FolderB2' } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsB2}/members`, {
      token: bob,
      body: { email: emails.alice, role: 'member' },
    });
    await call(app, 'POST', `/workspaces/${wsB2}/graph`, {
      token: bob,
      body: nodeBody('pos-in-b2', 'folder B2 stance'),
    });
    expect(await recentIds(app, aliceToken, emails.bob)).toContain('pos-in-b2');
  });

  it('an explicit default folder beats the last-activity folder', async () => {
    const { app, aliceToken, bob, wsB, emails } = await setup();
    // Bob defaults to FolderB, THEN works in a second shared folder — the
    // explicit default still wins over the fresher activity.
    await call(app, 'PUT', '/me/defaults/all', { token: bob, body: { workspace_id: wsB } });
    const wsB2 = (
      await call(app, 'POST', '/workspaces', { token: bob, body: { profile_id: 'notes', name: 'FolderB2' } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsB2}/members`, {
      token: bob,
      body: { email: emails.alice, role: 'member' },
    });
    await call(app, 'POST', `/workspaces/${wsB2}/graph`, {
      token: bob,
      body: nodeBody('pos-in-b2', 'folder B2 stance'),
    });
    expect(await recentIds(app, aliceToken, emails.bob)).toContain('pos-in-b');
  });

  it("a teammate's last-activity folder the viewer cannot see is never used or leaked", async () => {
    const { app, aliceToken, bob, emails } = await setup();
    // Bob's most recent activity is in a folder of his own; Alice referencing
    // him lands on their shared folder — never a denial naming the private one.
    await call(app, 'POST', '/workspaces', { token: bob, body: { profile_id: 'notes', name: 'BobPrivate' } });
    expect(await recentIds(app, aliceToken, emails.bob)).toContain('pos-in-b');
  });

  it('a non-member gets 403 forbidden with a request-access hint (default folder is not a grant)', async () => {
    const { app, carolToken, wsB, bob, emails } = await setup();
    await call(app, 'PUT', '/me/defaults/all', { token: bob, body: { workspace_id: wsB } });
    for (const ref of [wsB, 'FolderB', emails.bob]) {
      const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
        token: carolToken,
        body: { folder: ref },
      });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('forbidden');
      expect(String(r.json.hint)).toContain('Request access');
    }
  });

  it('an ambiguous display name is a 422 listing the options, never a guess', async () => {
    const { app, aliceToken, domain } = await setup();
    const dave1 = await magic(app, `dave1@${domain}`);
    const dave2 = await magic(app, `dave2@${domain}`);
    await call(app, 'PATCH', '/me', { token: dave1, body: { display_name: 'Dave Same' } });
    await call(app, 'PATCH', '/me', { token: dave2, body: { display_name: 'Dave Same' } });
    const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
      token: aliceToken,
      body: { folder: 'Dave Same' },
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('ambiguous');
    expect(r.json.options).toHaveLength(2);
  });

  it("an unknown reference is a 404 pointing at list_folders/list_team", async () => {
    const { app, aliceToken } = await setup();
    const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
      token: aliceToken,
      body: { folder: 'Nonexistent Folder' },
    });
    expect(r.status).toBe(404);
    expect(String(r.json.detail)).toContain('list_folders');
  });

  it("the user's 'mcp' default folder becomes the connection's effective workspace", async () => {
    const { app, aliceToken, alice, wsB } = await setup();
    // Token was minted on FolderA; Alice defaults MCP to FolderB.
    await call(app, 'PUT', '/me/defaults/mcp', { token: alice, body: { workspace_id: wsB } });
    const ids = await recentIds(app, aliceToken);
    expect(ids).toContain('pos-in-b');
    expect(ids).not.toContain('pos-in-a');
    // And the home folder stays reachable by reference.
    expect(await recentIds(app, aliceToken, 'FolderA')).toContain('pos-in-a');
  });

  it('cross-folder reads never leak other members’ private/only_me nodes', async () => {
    const { app, repo, aliceToken, bob, wsB, emails } = await setup();
    await call(app, 'POST', `/workspaces/${wsB}/graph`, {
      token: bob,
      body: nodeBody('pos-b-private', 'bob private stance'),
    });
    await call(app, 'POST', `/workspaces/${wsB}/graph`, {
      token: bob,
      body: nodeBody('pos-b-onlyme', 'bob only-me stance'),
    });
    const bobId = (await repo.findUserByEmail(emails.bob))!.id;
    repo.db
      .prepare(`UPDATE graph_nodes SET visibility = 'private', owner_user_id = ? WHERE id = 'pos-b-private'`)
      .run(bobId);
    repo.db
      .prepare(`UPDATE graph_nodes SET visibility = 'only_me', owner_user_id = ? WHERE id = 'pos-b-onlyme'`)
      .run(bobId);

    const ids = await recentIds(app, aliceToken, wsB);
    expect(ids).toContain('pos-in-b');
    expect(ids).not.toContain('pos-b-private');
    expect(ids).not.toContain('pos-b-onlyme');
  });
});

describe('MCP discovery tools', () => {
  it('list_folders returns memberships with role, default/current flags, and subgraph slugs', async () => {
    const { app, aliceToken, alice, wsA, wsB } = await setup();
    await call(app, 'PUT', '/me/defaults/mcp', { token: alice, body: { workspace_id: wsB } });
    const r = await call(app, 'POST', '/mcp/tools/list_folders', { token: aliceToken, body: {} });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.folders.map((f: any) => [f.id, f]));
    expect(byId[wsA].role).toBe('workspace_admin');
    expect(byId[wsB].role).toBe('member');
    expect(byId[wsB].is_default).toBe(true);
    expect(byId[wsB].is_current).toBe(true);
    expect(byId[wsA].subgraphs.map((s: any) => s.id)).toContain('default');
  });

  it('list_team returns domain-mates with identity + sharing info', async () => {
    const { app, aliceToken, bob, wsB, emails, tag } = await setup();
    await call(app, 'PATCH', '/me', { token: bob, body: { display_name: 'Bob Builder' } });
    await call(app, 'PUT', '/me/identities/slack', {
      token: bob,
      body: { team_id: 'T0F', external_id: `U0BOB${tag}`, handle: `bob.builder${tag}` },
    });
    const r = await call(app, 'POST', '/mcp/tools/list_team', { token: aliceToken, body: {} });
    expect(r.status).toBe(200);
    const bobRow = r.json.team.find((t: any) => t.email === emails.bob);
    expect(bobRow.display_name).toBe('Bob Builder');
    expect(bobRow.slack_handle).toBe(`bob.builder${tag}`);
    const bRow = bobRow.folders.find((f: any) => f.id === wsB);
    expect(bRow.shared_with_you).toBe(true);
  });

  it('set_default_folder resolves a reference, requires membership, and persists', async () => {
    const { app, repo, aliceToken, alice, wsB, wsC } = await setup();
    const ok = await call(app, 'POST', '/mcp/tools/set_default_folder', {
      token: aliceToken,
      body: { folder: 'FolderB', surface: 'mcp' },
    });
    expect(ok.status).toBe(200);
    const me = await call(app, 'GET', '/me', { token: alice });
    expect((await repo.getUserDefault(me.json.user_id, 'mcp'))?.workspace_id).toBe(wsB);

    const denied = await call(app, 'POST', '/mcp/tools/set_default_folder', {
      token: aliceToken,
      body: { folder: wsC },
    });
    expect(denied.status).toBe(403);
  });
});

describe('MCP team-folder exploration', () => {
  it('explore_team_folders reaches unshared folders, but their subfolder descriptions stay hidden', async () => {
    const { app, aliceToken, wsB, wsC, emails } = await setup();
    const r = await call(app, 'POST', '/mcp/tools/explore_team_folders', { token: aliceToken, body: {} });
    expect(r.status).toBe(200);

    const carol = r.json.people.find((p: any) => p.email === emails.carol);
    const folderC = carol.folders.find((f: any) => f.id === wsC);
    // Discovery reaches folders Alice cannot read — that's how she learns
    // FolderC exists — but only its directory metadata.
    expect(folderC.shared_with_you).toBe(false);
    expect(folderC.your_role).toBeNull();
    expect(folderC.subfolders.map((s: any) => s.id)).toContain('default');
    expect(folderC.subfolders[0].description).toBeUndefined();
    expect(folderC.subfolders[0].generated_description).toBeUndefined();

    // FolderB is shared with Alice, so its subfolder descriptions come along.
    const bob = r.json.people.find((p: any) => p.email === emails.bob);
    const folderB = bob.folders.find((f: any) => f.id === wsB);
    expect(folderB.shared_with_you).toBe(true);
    expect(folderB.your_role).toBe('member');
    expect(folderB.subfolders[0].description).toBe('miscellaneous');
  });

  it('explore_team_folders filters by access and by person', async () => {
    const { app, aliceToken, wsA, wsB, wsC, emails } = await setup();
    const unshared = await call(app, 'POST', '/mcp/tools/explore_team_folders', {
      token: aliceToken,
      body: { access: 'not_shared' },
    });
    const unsharedIds = unshared.json.people.flatMap((p: any) => p.folders.map((f: any) => f.id));
    expect(unsharedIds).toContain(wsC);
    expect(unsharedIds).not.toContain(wsA);
    expect(unsharedIds).not.toContain(wsB);

    const shared = await call(app, 'POST', '/mcp/tools/explore_team_folders', {
      token: aliceToken,
      body: { access: 'shared' },
    });
    const sharedIds = shared.json.people.flatMap((p: any) => p.folders.map((f: any) => f.id));
    expect(sharedIds).toEqual(expect.arrayContaining([wsA, wsB]));
    expect(sharedIds).not.toContain(wsC);

    const q = await call(app, 'POST', '/mcp/tools/explore_team_folders', {
      token: aliceToken,
      body: { query: 'carol' },
    });
    expect(q.json.people.map((p: any) => p.email)).toEqual([emails.carol]);
  });

  it('request_folder_access emails the owner of an unreachable folder; membership short-circuits it', async () => {
    const { app, aliceToken, wsB, wsC, emails } = await setup();
    const asked = await call(app, 'POST', '/mcp/tools/request_folder_access', {
      token: aliceToken,
      body: { folder: 'FolderC', message: 'launch copy' },
    });
    expect(asked.status).toBe(200);
    expect(asked.json.requested).toBe(true);
    expect(asked.json.folder.id).toBe(wsC);
    expect(asked.json.owner_email).toBe(emails.carol);
    // No mail provider in tests: the request is recorded, nothing is sent.
    expect(asked.json.emailed).toBe(false);

    // Asking for a folder she is already in is not an error — it's an answer.
    const already = await call(app, 'POST', '/mcp/tools/request_folder_access', {
      token: aliceToken,
      body: { folder: wsB },
    });
    expect(already.status).toBe(200);
    expect(already.json.already_a_member).toBe(true);
    expect(already.json.requested).toBeUndefined();
  });

  it('request_folder_access refuses folders outside your own email domain', async () => {
    const { app, aliceToken } = await setup();
    const outsider = await magic(app, `zoe@outsider${fixtureSeq}.example`);
    const wsOut = (
      await call(app, 'POST', '/workspaces', { token: outsider, body: { profile_id: 'notes', name: 'Outside' } })
    ).json.id;

    const denied = await call(app, 'POST', '/mcp/tools/request_folder_access', {
      token: aliceToken,
      body: { folder: wsOut },
    });
    expect(denied.status).toBe(403);
  });
});

// A personal email provider (gmail.com, outlook.com, …) is not a company, so it
// groups nobody: discovery, folder-name resolution and person references all
// stop at the viewer's own folders. Membership remains the only way across.
describe('MCP discovery on a personal email domain', () => {
  async function personalSetup() {
    const { app } = await loadApp();
    const tag = `p${++fixtureSeq}`;
    const emails = { ada: `ada.${tag}@gmail.com`, ben: `ben.${tag}@gmail.com` };
    const ada = await magic(app, emails.ada);
    const ben = await magic(app, emails.ben);
    await call(app, 'PATCH', '/me', { token: ada, body: { display_name: `Ada ${tag}` } });
    await call(app, 'PATCH', '/me', { token: ben, body: { display_name: `Ben ${tag}` } });

    const wsAda = (
      await call(app, 'POST', '/workspaces', { token: ada, body: { profile_id: 'notes', name: `AdaBox${tag}` } })
    ).json.id;
    const wsBen = (
      await call(app, 'POST', '/workspaces', { token: ben, body: { profile_id: 'notes', name: `BenBox${tag}` } })
    ).json.id;
    await call(app, 'POST', `/workspaces/${wsBen}/graph`, {
      token: ben,
      body: nodeBody(`pos-ben-${tag}`, 'ben stance'),
    });
    // Ben publishes a default folder — a pointer, never a grant.
    await call(app, 'PUT', '/me/defaults/all', { token: ben, body: { workspace_id: wsBen } });
    // Ada's MCP token is minted on her own folder.
    const adaToken = (await call(app, 'POST', `/workspaces/${wsAda}/mcp-tokens`, { token: ada, body: {} })).json
      .token as string;
    return { app, adaToken, ada, ben, wsAda, wsBen, emails, tag };
  }

  it('list_team and explore_team_folders return the caller alone', async () => {
    const { app, adaToken, wsAda, wsBen, emails } = await personalSetup();

    const team = await call(app, 'POST', '/mcp/tools/list_team', { token: adaToken, body: {} });
    expect(team.status).toBe(200);
    expect(team.json.team.map((t: any) => t.email)).toEqual([emails.ada]);
    expect(team.json.team[0].is_you).toBe(true);

    const explored = await call(app, 'POST', '/mcp/tools/explore_team_folders', {
      token: adaToken,
      body: {},
    });
    expect(explored.status).toBe(200);
    expect(explored.json.people.map((p: any) => p.email)).toEqual([emails.ada]);
    const ids = explored.json.people.flatMap((p: any) => p.folders.map((f: any) => f.id));
    expect(ids).toEqual([wsAda]);
    expect(ids).not.toContain(wsBen);
    // Nothing of the stranger's folder leaks, not even its name.
    expect(JSON.stringify(explored.json)).not.toContain('BenBox');
  });

  it("a stranger's folder name, email, and display name do not resolve", async () => {
    const { app, adaToken, emails, tag } = await personalSetup();
    for (const ref of [`BenBox${tag}`, emails.ben, `Ben ${tag}`]) {
      const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
        token: adaToken,
        body: { since: '1970-01-01T00:00:00Z', folder: ref },
      });
      // 404, not 403: a stranger's folder is not something to be denied — it
      // is nothing the caller can name at all.
      expect(r.status, ref).toBe(404);
      expect(r.json.error).toBe('not_found');
      // Nothing comes back but the reference the caller typed — a person ref
      // never reveals the folder name behind it.
      if (!ref.startsWith('BenBox')) expect(JSON.stringify(r.json)).not.toContain('BenBox');
    }
  });

  it('request_folder_access cannot petition someone who merely shares the provider', async () => {
    const { app, adaToken, wsBen } = await personalSetup();
    const denied = await call(app, 'POST', '/mcp/tools/request_folder_access', {
      token: adaToken,
      body: { folder: wsBen },
    });
    expect(denied.status).toBe(403);
  });

  it('an invite still works, and then the person reference resolves', async () => {
    const { app, adaToken, ben, wsBen, emails, tag } = await personalSetup();
    await call(app, 'POST', `/workspaces/${wsBen}/members`, {
      token: ben,
      body: { email: emails.ada, role: 'member' },
    });
    // Named directly, and via Ben — sharing a folder is the relationship the
    // domain never was.
    for (const ref of [`BenBox${tag}`, emails.ben]) {
      const r = await call(app, 'POST', '/mcp/tools/list_recent_changes', {
        token: adaToken,
        body: { since: '1970-01-01T00:00:00Z', folder: ref },
      });
      expect(r.status, ref).toBe(200);
      expect(r.json.nodes.map((n: any) => n.id)).toContain(`pos-ben-${tag}`);
    }
  });
});
