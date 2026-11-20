/**
 * HTTP-level tests for the data-agent API surface
 * (spec-data-agents-and-subfolder-wiki.md §4.2, §6): the template catalog,
 * the owner-tier permission gate, and attach/change/detach.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-data-agent-routes-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?data-agents-routes=' + Date.now());
}

async function jsonCall(app: any, pathname: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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

const minimalProfile = {
  id: 'bet_tracker',
  name: 'Bet Tracker',
  description: 'Tracks product bets, for testing.',
  shape: 'items',
  kinds: [
    {
      key: 'bet',
      label: 'Bet',
      label_plural: 'Bets',
      color: 2,
      description: 'A product direction being pursued, described precisely enough for a real template.',
    },
  ],
  feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: 'x' }],
  review_kinds: ['bet'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: { red: 'contradicts a bet', yellow: 'refers to an untracked bet', green: 'consistent' },
  edge_kinds: [],
  edges_deliberately_empty: true,
};

async function setupOwnerWorkspace(app: any) {
  const ownerTok = await magic(app, `owner-${Date.now()}-${Math.random()}@ex.com`);
  const ws = (await jsonCall(app, '/workspaces', { method: 'POST', token: ownerTok, body: { profile_id: 'notes', name: 'W' } })).json;
  const sg = (
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: ownerTok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })
  ).json;
  return { ownerTok, ws, subgraphId: sg.subgraph_id as string };
}

describe('Tier C derivation (spec-data-agents-and-subfolder-wiki.md §5.1/§5.2)', () => {
  it('a MINIMAL draft — no review_kinds/query_scopes/feedback_dimensions/flag_semantics at all — saves successfully', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws } = await setupOwnerWorkspace(app);
    const draft = {
      id: 'minimal_draft',
      name: 'Minimal Draft',
      description: minimalProfile.description,
      shape: 'items',
      kinds: minimalProfile.kinds,
      edge_kinds: [],
      edges_deliberately_empty: true,
      // Deliberately NOT included: review_kinds, query_scopes,
      // feedback_dimensions, flag_semantics — exactly what the editor
      // never asks a person to fill in.
    };
    const r = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Minimal Draft', profile: draft },
    });
    expect(r.status).toBe(200);
  });

  it('the derived template attaches and captures correctly (proves the derivation, not just that save succeeds)', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const created = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: {
        name: 'Minimal Draft',
        profile: {
          id: 'minimal_draft2',
          name: 'Minimal Draft',
          description: minimalProfile.description,
          shape: 'items',
          kinds: minimalProfile.kinds,
          edge_kinds: [],
          edges_deliberately_empty: true,
        },
      },
    });
    expect(created.status).toBe(200);
    const attach = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: created.json.id, cadence: 'once' },
    });
    expect(attach.status).toBe(200);
    // The derived query_scopes must include the mandatory 'all' scope and
    // one per declared kind — exactly what deriveTemplateProfile promises.
    const active = attach.json.active;
    const scopeKeys = active.template.query_scopes.map((s: any) => s.key);
    expect(scopeKeys).toContain('all');
    expect(scopeKeys).toContain('bet');
    expect(active.template.review_kinds).toEqual(['bet']);
    expect(active.template.flag_semantics.red).toBeTruthy();
  });
});

describe('data-agent template catalog', () => {
  it('GET returns the standard catalog even with no custom templates', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, { token: ownerTok });
    expect(r.status).toBe(200);
    const ids = r.json.templates.map((t: any) => t.id);
    expect(ids).toContain('todo_list');
    expect(ids).toContain('project_status');
    expect(r.json.templates.every((t: any) => t.active_subfolders === 0)).toBe(true);
  });

  it('POST (create) is rejected for a non-owner, non-admin member', async () => {
    const { app } = (await loadApp()) as any;
    const { ws } = await setupOwnerWorkspace(app);
    const memberTok = await magic(app, `member-${Date.now()}@ex.com`);
    // A freshly created user has no membership in ws yet — workspaceGate
    // itself would 403 first; this asserts the OWNER-TIER check specifically
    // by using a real member who is neither owner nor admin.
    const memberId = (await jsonCall(app, '/me', { token: memberTok })).json.id;
    // Add as a plain 'member' via the admin-only members route, using the owner token.
    const ownerTok2 = await magic(app, `owner2-${Date.now()}@ex.com`);
    const ws2 = (await jsonCall(app, '/workspaces', { method: 'POST', token: ownerTok2, body: { profile_id: 'notes', name: 'W2' } })).json;
    await jsonCall(app, `/workspaces/${ws2.id}/members`, {
      method: 'POST',
      token: ownerTok2,
      body: { email: (await jsonCall(app, '/me', { token: memberTok })).json.email, role: 'member' },
    });
    const r = await jsonCall(app, `/workspaces/${ws2.id}/data-agent-templates`, {
      method: 'POST',
      token: memberTok,
      body: { name: 'Bet Tracker', profile: minimalProfile },
    });
    expect(r.status).toBe(403);
    void ws;
    void memberId;
  });

  it('POST (create) succeeds for the owner and validates the profile', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws } = await setupOwnerWorkspace(app);
    const bad = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Broken', profile: { ...minimalProfile, kinds: [] } },
    });
    expect(bad.status).toBe(400);

    const good = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Bet Tracker', profile: minimalProfile },
    });
    expect(good.status).toBe(200);
    expect(good.json.id).toMatch(/^tpl_/);

    const list = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, { token: ownerTok });
    expect(list.json.templates.some((t: any) => t.id === good.json.id)).toBe(true);
  });

  it('Save (same id) edits in place; omitting id forks a new template', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws } = await setupOwnerWorkspace(app);
    const created = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Bet Tracker', profile: minimalProfile },
    });
    const editedProfile = { ...minimalProfile, description: 'Edited description, for testing purposes here.' };
    const saved = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { id: created.json.id, name: 'Bet Tracker', profile: editedProfile },
    });
    expect(saved.json.id).toBe(created.json.id);

    const forked = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Bet Tracker (copy)', profile: minimalProfile, forked_from: created.json.id },
    });
    expect(forked.json.id).not.toBe(created.json.id);

    const list = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, { token: ownerTok });
    expect(list.json.templates.filter((t: any) => !t.standard)).toHaveLength(2);
  });

  it('cannot delete a standard template', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates/todo_list`, { method: 'DELETE', token: ownerTok });
    expect(r.status).toBe(400);
  });

  it('delete is rejected (409) while a subfolder has the template actively attached', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const created = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates`, {
      method: 'POST',
      token: ownerTok,
      body: { name: 'Bet Tracker', profile: minimalProfile },
    });
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: created.json.id, cadence: 'per_document' },
    });
    const del = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates/${created.json.id}`, { method: 'DELETE', token: ownerTok });
    expect(del.status).toBe(409);

    await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { method: 'DELETE', token: ownerTok });
    const del2 = await jsonCall(app, `/workspaces/${ws.id}/data-agent-templates/${created.json.id}`, { method: 'DELETE', token: ownerTok });
    expect(del2.status).toBe(200);
  });
});

describe('attach / change / detach', () => {
  it('GET with no agent attached returns active: null', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { token: ownerTok });
    expect(r.status).toBe(200);
    expect(r.json.active).toBeNull();
  });

  it('attach with a standard template id succeeds; GET reflects it', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'todo_list', cadence: 'per_document' },
    });
    expect(r.status).toBe(200);
    expect(r.json.active.template_id).toBe('todo_list');

    const get = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { token: ownerTok });
    expect(get.json.active.template_id).toBe('todo_list');
  });

  it('scheduled cadence requires cadence_ms', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'todo_list', cadence: 'scheduled' },
    });
    expect(r.status).toBe(400);
  });

  it('unknown template_id is rejected', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    const r = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'does_not_exist', cadence: 'once' },
    });
    expect(r.status).toBe(404);
  });

  it('attaching a second template REPLACES the first (Change)', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'todo_list', cadence: 'once' },
    });
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'project_status', cadence: 'once' },
    });
    const get = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { token: ownerTok });
    expect(get.json.active.template_id).toBe('project_status');
  });

  it('detach turns it off; GET returns active: null again', async () => {
    const { app } = (await loadApp()) as any;
    const { ownerTok, ws, subgraphId } = await setupOwnerWorkspace(app);
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, {
      method: 'POST',
      token: ownerTok,
      body: { template_id: 'todo_list', cadence: 'once' },
    });
    const del = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { method: 'DELETE', token: ownerTok });
    expect(del.status).toBe(200);
    const get = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${subgraphId}/data-agent`, { token: ownerTok });
    expect(get.json.active).toBeNull();
  });
});
