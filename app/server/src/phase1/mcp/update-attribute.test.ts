/**
 * `update_attribute` (registry.ts): a flat-args convenience wrapper over the
 * same merge/archive/supersede core as `update_node` (applyNodeUpdate),
 * scoped to a single attrs key — e.g. "mark this message's `status` attr
 * 'sent'". Covers add-vs-overwrite of the one key, that every other field
 * (including other attrs keys) carries over untouched, the archive/supersede
 * fallout, the already-archived guard, and the unknown-node-id 404.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-update-attribute-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?mcp-update-attribute=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await jsonCall(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await jsonCall(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

async function setupWorkspaceAndToken(app: any, email: string, body: Record<string, unknown>) {
  const session = await magic(app, email);
  const created = await jsonCall(app, '/workspaces', { method: 'POST', token: session, body });
  const ws = created.json.id as string;
  const tokenRes = await jsonCall(app, `/workspaces/${ws}/mcp-tokens`, { method: 'POST', token: session, body: {} });
  return { ws, mcpToken: tokenRes.json.token as string, session };
}

/** Seed a 'note'-kind node directly (POST /workspaces/:ws/graph), no LLM involved. */
async function seedNote(app: any, ws: string, session: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const node = {
    id: 'roadmap-note',
    type: 'note',
    title: 'Roadmap',
    body: 'We are shipping v1 in Q3.',
    attrs: { owner: 'alice' },
    created_at: now,
    updated_at: now,
    status: 'active',
    ...overrides,
  };
  const r = await jsonCall(app, `/workspaces/${ws}/graph`, { method: 'POST', token: session, body: node });
  expect(r.status).toBe(200);
  return node;
}

describe('MCP update_attribute', () => {
  it('adds a new attrs key, carrying every other field (including other attrs) over untouched', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-attr-add@pome.test', {
      name: 'UpdateAttrAdd',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);

    const res = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', attribute: 'status', value: 'sent' },
    });
    expect(res.status).toBe(200);
    expect(res.json.superseded_node_id).toBe('roadmap-note');
    const successor = res.json.node;
    expect(successor.id).not.toBe('roadmap-note');
    expect(successor.attrs.status).toBe('sent');
    expect(successor.attrs.owner).toBe('alice'); // untouched attrs key carries over
    expect(successor.body).toBe('We are shipping v1 in Q3.'); // untouched field carries over
    expect(successor.title).toBe('Roadmap');
    expect(successor.status).toBe('active');

    const all = await jsonCall(app, `/workspaces/${ws}/graph?active=false`, { method: 'GET', token: session });
    const original = (all.json.nodes as any[]).find((n) => n.id === 'roadmap-note');
    const created = (all.json.nodes as any[]).find((n) => n.id === successor.id);
    expect(original.status).toBe('archived');
    expect(original.superseded).toBe(successor.id);
    expect(created.status).toBe('active');
  });

  it('overwrites an existing attrs key', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-attr-overwrite@pome.test', {
      name: 'UpdateAttrOverwrite',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session, { attrs: { status: 'open', owner: 'alice' } });

    const res = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', attribute: 'status', value: 'sent' },
    });
    expect(res.status).toBe(200);
    expect(res.json.node.attrs.status).toBe('sent');
    expect(res.json.node.attrs.owner).toBe('alice');
  });

  it('accepts number and boolean values, not just strings', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-attr-types@pome.test', {
      name: 'UpdateAttrTypes',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);

    const numeric = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', attribute: 'priority', value: 2 },
    });
    expect(numeric.status).toBe(200);
    expect(numeric.json.node.attrs.priority).toBe(2);

    const bool = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: numeric.json.node.id, attribute: 'archived_by_bot', value: true },
    });
    expect(bool.status).toBe(200);
    expect(bool.json.node.attrs.archived_by_bot).toBe(true);
  });

  it('rejects updating a node that is already archived, naming its successor', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-attr-archived@pome.test', {
      name: 'UpdateAttrArchived',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);
    const first = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', attribute: 'status', value: 'sent' },
    });
    expect(first.status).toBe(200);

    const again = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', attribute: 'status', value: 'delivered' },
    });
    expect(again.status).toBe(409);
    expect(again.json.detail).toContain(first.json.node.id);
  });

  it('rejects an unknown node id', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken } = await setupWorkspaceAndToken(app, 'update-attr-missing@pome.test', {
      name: 'UpdateAttrMissing',
      profile_id: 'notes',
    });

    const missing = await jsonCall(app, '/mcp/tools/update_attribute', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'does-not-exist', attribute: 'status', value: 'sent' },
    });
    expect(missing.status).toBe(404);
  });
});
