/**
 * ingest_document's `subgraph` arg (registry.ts): forces the destination the
 * same way the web ingest routes' `subgraph_id` does (routes.ts
 * runTextIngest's forcedSubgraphId) — skips the router entirely, and rejects
 * an inactive subgraph rather than silently filing into it. This is the one
 * piece of net-new ingestion capability the Add Source agent (and any other
 * MCP-connected agent) needs to file a document into a folder it picked
 * itself, or one it just created via create_subfolder.
 *
 * Named `subgraph`, not `folder` — every registry tool already accepts a
 * `folder` arg (the withFolder wrapper, registry.ts ~304) meaning "run this
 * call against a DIFFERENT workspace"; that arg is stripped out and resolved
 * before a tool's own handler ever sees it, so reusing the name for
 * "subfolder within THIS workspace" would silently be swallowed by the
 * wrapper instead of reaching ingest_document's own logic.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-subgraph-arg-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('../api/server.js?mcp-subgraph-arg=' + Date.now());
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

const SOURCE = 'Attendees at the offsite: Priya, Marcus, and Jo — planning the Q3 launch.';

describe('ingest_document subgraph arg', () => {
  it('forces the document into the named subfolder, skipping the router', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-subgraph-force@pome.test', {
      name: 'SubgraphForce',
      profile_id: 'notes',
    });
    const created = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token: session,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    expect(created.status).toBe(200);
    const peopleId = created.json.subgraph_id as string;

    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: SOURCE, source_kind: 'doc', source_ref: 'offsite.md', subgraph: 'people' },
    });
    expect(ingest.status).toBe(200);
    expect(ingest.json.pending_approval).toBeFalsy();
    expect(ingest.json.dropped).toBeFalsy();
    const documentId = ingest.json.document_id as string;
    expect(documentId).toBeTruthy();

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, {
      method: 'GET',
      token: session,
    });
    expect(routing.status).toBe(200);
    expect(routing.json.routing.map((r: any) => r.subgraph_id)).toEqual([peopleId]);
  });

  it('rejects a subfolder slug/id that is not active', async () => {
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-subgraph-inactive@pome.test', {
      name: 'SubgraphInactive',
      profile_id: 'notes',
    });
    const created = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token: session,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    const peopleId = created.json.subgraph_id as string;
    const archived = await jsonCall(app, `/workspaces/${ws}/subgraphs/${peopleId}`, {
      method: 'DELETE',
      token: session,
    });
    expect(archived.status).toBe(200);

    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: SOURCE, source_kind: 'doc', subgraph: 'people' },
    });
    expect(ingest.status).toBe(400);
  });
});
