/**
 * ingest_document's instructions-driven path (registry.ts) is best-effort: a
 * cleanup-agent failure must fall back to filing the document via the plain
 * deterministic path instead of losing the capture entirely — see the
 * 2026-08-19 incident this fixes (a 3-minute provider timeout reached the
 * MCP caller as a bare 500/"internal_error" with nothing ingested). This file
 * covers the fallback wiring at the MCP-tool level (mocking the agent module
 * the way apps-instructions.test.ts does); the agent's own
 * MAX_CLEANUP_SOURCE_CHARS ceiling — one trigger for this fallback — is unit
 * tested directly in add-source-agent.test.ts.
 *
 * Same fallback also covers a DECLINE — the agent runs without error but
 * chooses not to call ingest_document at all (e.g. it judges a page's
 * extraction to be pure furniture with nothing worth keeping). The prompt
 * (pageCleanupInstructions, Chrome extension) asks it to still file the
 * metadata block alone rather than skip filing entirely, but that's a prompt
 * rule nothing here verifies — so a decline is treated the same as a thrown
 * failure and falls through to the plain path, guaranteeing at least the
 * metadata header gets filed regardless of model compliance.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

// Same seam apps-instructions.test.ts uses: mock the agent itself (not the
// LLM/network underneath it) so this test proves the FALLBACK behavior, not
// the agent's own logic — that's covered by add-source-agent.test.ts.
const runAddSourceAgentMock = vi.fn();
vi.mock('../agent/add-source-agent.js', async () => {
  const real = await vi.importActual<typeof import('../agent/add-source-agent.js')>('../agent/add-source-agent.js');
  return { ...real, runAddSourceAgent: (...args: unknown[]) => runAddSourceAgentMock(...args) };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mcp-instr-fallback-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

afterEach(() => {
  runAddSourceAgentMock.mockReset();
});

async function loadApp() {
  return import('../api/server.js?mcp-instr-fallback=' + Date.now());
}

async function jsonCall(app: any, pathname: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
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

describe('ingest_document instructed-path fallback', () => {
  it('falls back to the plain path (still files the document) when the cleanup agent throws', async () => {
    runAddSourceAgentMock.mockRejectedValue(new Error('Request timed out.'));
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-fallback-throw@pome.test', {
      name: 'FallbackThrow',
      profile_id: 'notes',
    });
    const created = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token: session,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    const peopleId = created.json.subgraph_id as string;

    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: SOURCE, source_kind: 'doc', source_ref: 'offsite.md', subgraph: 'people', instructions: 'strip boilerplate' },
    });

    // The whole point: a thrown cleanup call must not surface as a 500 with
    // nothing ingested.
    expect(ingest.status).toBe(200);
    expect(ingest.json.agent).toBeFalsy(); // fell back, didn't take the agent's result
    expect(ingest.json.dropped).toBeFalsy();
    const documentId = ingest.json.document_id as string;
    expect(documentId).toBeTruthy();

    // Still landed in the forced subgraph, same as the plain (no-instructions) path.
    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, {
      method: 'GET',
      token: session,
    });
    expect(routing.json.routing.map((r: any) => r.subgraph_id)).toEqual([peopleId]);
  });

  it('falls back to the plain path when the agent declines without calling ingest_document at all', async () => {
    runAddSourceAgentMock.mockResolvedValue({
      message: 'The extraction is almost entirely navigation and ads — nothing substantive to file.',
      receipts: [],
      pending_action: null,
    });
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-fallback-decline@pome.test', {
      name: 'FallbackDecline',
      profile_id: 'notes',
    });
    const created = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token: session,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    const peopleId = created.json.subgraph_id as string;

    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: SOURCE, source_kind: 'doc', subgraph: 'people', instructions: 'strip boilerplate' },
    });

    // A decline (no ingest_document receipt, no error thrown) must not lose
    // the capture either — same guarantee as the thrown-error case above.
    expect(ingest.status).toBe(200);
    expect(ingest.json.agent).toBeFalsy();
    const documentId = ingest.json.document_id as string;
    expect(documentId).toBeTruthy();

    const routing = await jsonCall(app, `/workspaces/${ws}/documents/${documentId}/routing`, {
      method: 'GET',
      token: session,
    });
    expect(routing.json.routing.map((r: any) => r.subgraph_id)).toEqual([peopleId]);
  });

  it('still returns the agent result on success (fallback does not mask a working cleanup call)', async () => {
    runAddSourceAgentMock.mockResolvedValue({
      message: 'Filed under People.',
      receipts: [
        { tool: 'ingest_document', args: {}, ok: true, result: { candidates: 1, document_id: 'doc_from_agent', subgraph_id: 'sg_x' } },
      ],
      pending_action: null,
    });
    const { app } = await loadApp();
    const { ws, mcpToken, session } = await setupWorkspaceAndToken(app, 'mcp-fallback-success@pome.test', {
      name: 'FallbackSuccess',
      profile_id: 'notes',
    });
    const created = await jsonCall(app, `/workspaces/${ws}/subgraphs`, {
      method: 'POST',
      token: session,
      body: { profile_id: 'notes', name: 'People', slug: 'people' },
    });
    const peopleId = created.json.subgraph_id as string;

    const ingest = await jsonCall(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcpToken,
      body: { source: SOURCE, source_kind: 'doc', subgraph: 'people', instructions: 'strip boilerplate' },
    });
    expect(ingest.status).toBe(200);
    expect(ingest.json.agent).toBe(true);
    expect(ingest.json.document_id).toBe('doc_from_agent');
    expect(runAddSourceAgentMock).toHaveBeenCalledTimes(1);
    // forcedSubgraph reached the agent, resolved from the 'people' slug.
    expect(runAddSourceAgentMock.mock.calls[0]![0]).toMatchObject({ forcedSubgraph: peopleId });
  });
});
