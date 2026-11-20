/**
 * Multi-subgraph (multi-profile) surface: workspace creation with multiple
 * profiles, subgraph CRUD, and subgraph-scoped profile resolution. No ingest
 * here (Phase 2 is the registry + selection layer); fan-out is covered
 * separately.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-sg-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?sg=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string; ws?: string; subgraph?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.ws) headers['x-workspace-id'] = opts.ws;
  if (opts.subgraph) headers['x-subgraph-id'] = opts.subgraph;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
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

async function magic(app: any, email: string): Promise<string> {
  const r1 = await jsonCall(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await jsonCall(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

describe('multi-subgraph surface', () => {
  it('creates a workspace with multiple subgraphs, lists them, resolves profile per subgraph, and CRUDs', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'multi@pome.test');

    // There is only one template (`notes`) post-Light, so three subgraphs of
    // it — distinguished by slug/name, not profile_id (see the 'purging a
    // subgraph' test below for the same pattern). First → 'default' subgraph.
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Multi', profile_ids: ['notes', 'notes', 'notes'] },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    expect(created.json.subgraphs).toHaveLength(3);
    expect(created.json.subgraphs[0].subgraph_id).toBe('default');
    expect(created.json.subgraphs[0].profile_id).toBe('notes');
    const bySlugAtCreate = Object.fromEntries(created.json.subgraphs.map((s: any) => [s.slug, s]));
    expect(Object.keys(bySlugAtCreate).sort()).toEqual(['notes', 'notes-2', 'notes-3']);

    // List subgraphs — three, each bound to the same template.
    const list = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(list.status).toBe(200);
    expect(list.json.subgraphs).toHaveLength(3);
    const bySlug = Object.fromEntries(list.json.subgraphs.map((s: any) => [s.slug, s]));

    // Profile resolution is per-subgraph: the header selects which one.
    const defProfile = await jsonCall(app, `/workspaces/${ws}/profile`, { token, ws });
    expect(defProfile.json.profile_id).toBe('notes');
    expect(defProfile.json.subgraph_id).toBe('default');

    const secondSg = bySlug['notes-2'];
    const secondProfile = await jsonCall(app, `/workspaces/${ws}/profile`, { token, ws, subgraph: secondSg.id });
    expect(secondProfile.json.profile_id).toBe('notes');
    expect(secondProfile.json.subgraph_id).toBe(secondSg.id);

    // Selecting by slug also works.
    const bySlugSelector = await jsonCall(app, `/workspaces/${ws}/profile`, { token, ws, subgraph: secondSg.slug });
    expect(bySlugSelector.json.profile_id).toBe('notes');

    // Unknown subgraph selector → 400.
    const bad = await jsonCall(app, `/workspaces/${ws}/profile`, { token, ws, subgraph: 'nope-xyz' });
    expect(bad.status).toBe(400);

    // Add a fourth subgraph.
    const add = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      ws,
      body: { profile_id: 'notes', name: 'Design system' },
    });
    expect(add.status).toBe(200);
    expect(add.json.profile_id).toBe('notes');
    const designSg = add.json.subgraph_id as string;

    const list2 = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(list2.json.subgraphs).toHaveLength(4);

    // Archive it — drops from the active list, default cannot be archived.
    const delDefault = await jsonCall(app, `/workspaces/${ws}/subgraphs/default`, { method: 'DELETE', token, ws });
    expect(delDefault.status).toBe(400);

    const del = await jsonCall(app, `/workspaces/${ws}/subgraphs/${designSg}`, { method: 'DELETE', token, ws });
    expect(del.status).toBe(200);
    const list3 = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(list3.json.subgraphs).toHaveLength(3);
  });

  it('subfolders carry a user description (default miscellaneous) editable via PATCH', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'descr@pome.test');
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Descr', profile_id: 'notes' },
    });
    const ws = created.json.id as string;

    // Default subgraph has no explicit description → 'miscellaneous'.
    const l0 = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(l0.json.subgraphs[0].description).toBe('miscellaneous');

    // Create with an explicit description — echoed back and persisted.
    const add = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      ws,
      body: { profile_id: 'notes', name: 'Product', description: 'Product ground truth for the Slack app' },
    });
    expect(add.status).toBe(200);
    expect(add.json.description).toBe('Product ground truth for the Slack app');
    const sg = add.json.subgraph_id as string;

    // Blank description falls back to the default.
    const addBlank = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token,
      ws,
      body: { profile_id: 'notes', name: 'Mkt', description: '   ' },
    });
    expect(addBlank.json.description).toBe('miscellaneous');

    // PATCH edits the description; name is optional now.
    const patch = await jsonCall(app, `/workspaces/${ws}/subgraphs/${sg}`, {
      method: 'PATCH',
      token,
      ws,
      body: { description: 'Tracking project Pomegranate' },
    });
    expect(patch.status).toBe(200);
    expect(patch.json.description).toBe('Tracking project Pomegranate');
    expect(patch.json.name).toBe('Product');

    // Empty PATCH (neither field) is rejected.
    const patchEmpty = await jsonCall(app, `/workspaces/${ws}/subgraphs/${sg}`, {
      method: 'PATCH',
      token,
      ws,
      body: {},
    });
    expect(patchEmpty.status).toBe(400);

    const l1 = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    const row = l1.json.subgraphs.find((s: any) => s.id === sg);
    expect(row.description).toBe('Tracking project Pomegranate');
    // Not yet synthesized → no generated description.
    expect(row.generated_description).toBeNull();
  });

  it('single-profile workspace creation stays backward compatible (one default subgraph)', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'solo@pome.test');
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Solo', profile_id: 'notes' },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    const list = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect(list.json.subgraphs).toHaveLength(1);
    expect(list.json.subgraphs[0].id).toBe('default');
    expect(list.json.subgraphs[0].profile_id).toBe('notes');
  });

  it('purging a subgraph hard-deletes its nodes/routing but leaves other subgraphs and the shared document intact', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'purge@pome.test');

    // There is only one template, so two subgraphs of it — distinguished by
    // slug, not profile_id (both are 'notes').
    const created = await jsonCall(app, '/workspaces', {
      method: 'POST',
      token,
      body: { name: 'Purge', profile_ids: ['notes', 'notes'] },
    });
    expect(created.status).toBe(200);
    const ws = created.json.id as string;
    const bySlug = Object.fromEntries((created.json.subgraphs as any[]).map((s) => [s.slug, s]));
    const defaultId = bySlug['notes'].subgraph_id as string; // 'default'
    const targetId = bySlug['notes-2'].subgraph_id as string;

    // Seed a node in EACH subgraph directly at the repo layer (bypassing the
    // capture pipeline, which isn't what this test is about) and a shared
    // document routed into both, so the assertions below can prove the purge
    // only touches the target subgraph's copy.
    const ts = '2026-01-01T00:00:00Z';
    const seedNode = async (subgraph_id: string, id: string) =>
      await repo.upsertNode(
        ws,
        { id, type: 'positioning', created_at: ts, updated_at: ts, status: 'active', body: 'x', kind: 'stance' } as any,
        undefined,
        undefined,
        subgraph_id,
      );
    await seedNode(defaultId, 'n_keep');
    await seedNode(targetId, 'n_gone');
    const doc = await repo.registerDocument(ws, { source_ref: 'purge-test.md', source_kind: 'doc', sha256: 'sha-purge' });
    await repo.routeDocument(ws, doc.id, defaultId);
    await repo.routeDocument(ws, doc.id, targetId);

    // Sanity: the target subgraph actually has rows to purge.
    const pre = await repo.countSubgraphRows(ws, targetId);
    expect(pre.graph_nodes).toBeGreaterThan(0);
    expect(pre.document_routing).toBeGreaterThan(0);

    // NOTE: this test used to assert the default folder could never be purged.
    // PR #234 deliberately lifted that: it can be purged once another active
    // folder exists to migrate its rows into. Purging it here would migrate
    // rows into the sibling and invalidate the assertions below, so the new
    // contract (migrate-then-delete, and the refusal when it is the only
    // folder left) is covered in repo.test.ts instead.

    // Purge the target subgraph.
    const del = await jsonCall(app, `/workspaces/${ws}/subgraphs/${targetId}/purge`, {
      method: 'DELETE',
      token,
      ws,
    });
    expect(del.status).toBe(200);
    expect(del.json.ok).toBe(true);
    expect(del.json.deleted.graph_nodes).toBeGreaterThan(0);

    // Every subgraph-scoped row for the purged subgraph is gone; the sibling
    // subgraph's copy is untouched.
    const post = await repo.countSubgraphRows(ws, targetId);
    for (const [table, n] of Object.entries(post)) {
      expect(n, `table ${table} still has rows for the purged subgraph`).toBe(0);
    }
    expect(await repo.getSubgraph(ws, targetId)).toBeUndefined();
    expect(await repo.getNode(ws, 'n_gone')).toBeUndefined();
    expect(await repo.getNode(ws, 'n_keep')).toBeTruthy();

    // The subgraph is gone from the list.
    const list = await jsonCall(app, `/workspaces/${ws}/subgraphs`, { token, ws });
    expect((list.json.subgraphs as any[]).map((s) => s.id)).not.toContain(targetId);

    // The shared document survives — it was also routed to the default subgraph.
    const docRow = repo.db
      .prepare(`SELECT id FROM documents WHERE workspace_id = ? AND id = ?`)
      .get(ws, doc.id);
    expect(docRow).toBeTruthy();

    // Purging a nonexistent subgraph 404s; a non-admin gets 403.
    const notFound = await jsonCall(app, `/workspaces/${ws}/subgraphs/${targetId}/purge`, {
      method: 'DELETE',
      token,
      ws,
    });
    expect(notFound.status).toBe(404);

    const memberToken = await magic(app, 'purge-member@pome.test');
    const userRow = repo.db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get('purge-member@pome.test') as { id: string };
    await repo.addMember({ workspace_id: ws, user_id: userRow.id, role: 'member' });
    const forbidden = await jsonCall(app, `/workspaces/${ws}/subgraphs/${defaultId}/purge`, {
      method: 'DELETE',
      token: memberToken,
      ws,
    });
    expect(forbidden.status).toBe(403);
  });
});
