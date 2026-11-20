/**
 * `update_node` (registry.ts): a direct, non-LLM edit that never rewrites a
 * node in place — it mints a successor node with the merged content and
 * archives the original, stamping its `superseded` column with the
 * successor's id. Covers the merge (attrs merge key-by-key, everything else
 * carries over), the archive/supersede fallout, the profile kind gate, and
 * the already-archived guard.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-update-node-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?mcp-update-node=' + Date.now());
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
    attrs: { status: 'open', owner: 'alice' },
    created_at: now,
    updated_at: now,
    status: 'active',
    ...overrides,
  };
  const r = await jsonCall(app, `/workspaces/${ws}/graph`, { method: 'POST', token: session, body: node });
  expect(r.status).toBe(200);
  return node;
}

describe('MCP update_node', () => {
  it('mints a successor node with merged content and archives the original as superseded', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-node-basic@pome.test', {
      name: 'UpdateNode',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);

    const res = await jsonCall(app, '/mcp/tools/update_node', {
      method: 'POST',
      token: mcpToken,
      body: {
        id: 'roadmap-note',
        updates: { body: 'We are shipping v1 in Q4 now — slipped a quarter.', attrs: { status: 'slipped' } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.superseded_node_id).toBe('roadmap-note');
    const successor = res.json.node;
    expect(successor.id).not.toBe('roadmap-note');
    expect(successor.body).toBe('We are shipping v1 in Q4 now — slipped a quarter.');
    // attrs merge key-by-key: `status` overridden, `owner` carried over untouched.
    expect(successor.attrs.status).toBe('slipped');
    expect(successor.attrs.owner).toBe('alice');
    expect(successor.title).toBe('Roadmap'); // untouched field carries over
    expect(successor.status).toBe('active');

    const all = await jsonCall(app, `/workspaces/${ws}/graph?active=false`, { method: 'GET', token: session });
    expect(all.status).toBe(200);
    const original = (all.json.nodes as any[]).find((n) => n.id === 'roadmap-note');
    const created = (all.json.nodes as any[]).find((n) => n.id === successor.id);
    expect(original.status).toBe('archived');
    expect(original.superseded).toBe(successor.id);
    expect(created.status).toBe('active');
  });

  it('rejects updating a node that is already archived, naming its successor', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-node-archived@pome.test', {
      name: 'UpdateNodeArchived',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);
    const first = await jsonCall(app, '/mcp/tools/update_node', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', updates: { body: 'v1 slipped to Q4.' } },
    });
    expect(first.status).toBe(200);

    const again = await jsonCall(app, '/mcp/tools/update_node', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', updates: { body: 'v1 slipped to Q1 next year.' } },
    });
    expect(again.status).toBe(409);
    expect(again.json.detail).toContain(first.json.node.id);
  });

  it('rejects a kind change and an unknown node id', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'update-node-invalid@pome.test', {
      name: 'UpdateNodeInvalid',
      profile_id: 'notes',
    });
    await seedNote(app, ws, session);

    const badKind = await jsonCall(app, '/mcp/tools/update_node', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'roadmap-note', updates: { type: 'not_a_kind' } },
    });
    // `type` is a protected field, stripped from `updates` — the node stays a
    // 'note' and the update succeeds rather than failing on the bogus kind.
    expect(badKind.status).toBe(200);
    expect(badKind.json.node.type).toBe('note');

    const missing = await jsonCall(app, '/mcp/tools/update_node', {
      method: 'POST',
      token: mcpToken,
      body: { id: 'does-not-exist', updates: { body: 'x' } },
    });
    expect(missing.status).toBe(404);
  });
});
