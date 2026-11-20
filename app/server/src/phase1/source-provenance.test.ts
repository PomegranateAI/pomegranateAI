/**
 * What happens to a source added via the WEB app (the cloud server).
 *
 * The web app has no per-source privacy: adding a source to a workspace IS
 * sharing it with that workspace. Its approved nodes default to visibility
 * 'team', so every member (and their AI agents) can see them, and the document
 * itself is workspace-shared.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { foundingProfile } from '../lib/profiles/__fixtures__/founding.js';

vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-prov-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./api/server.js?prov-test=' + Date.now());
}
async function magic(app: any, email: string) {
  const r1 = await app.request('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' } });
  const j1 = await r1.json();
  const r2 = await app.request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: j1.dev_code }), headers: { 'content-type': 'application/json' } });
  return (await r2.json()).session as string;
}
async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, { method: opts.method ?? 'POST', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json() };
}

describe('source added via the web app', () => {
  it('approves to team-visible nodes that every member sees, and a workspace-shared document', async () => {
    const { app, repo } = (await loadApp()) as any;
    const ownerSess = await magic(app, 'owner@prov.test');
    const ws = (await call(app, '/workspaces', { body: { name: 'Prov', profile_id: 'notes' }, token: ownerSess })).json;
    // The stub's capture heuristics extract decision-kind candidates —
    // install the founding fixture profile so they validate.
    await call(app, `/workspaces/${ws.id}/profile`, { method: 'PUT', token: ownerSess, body: { profile: foundingProfile } });
    const owner = (await repo.findOrCreateUser('owner@prov.test')).id;
    const bob = (await repo.findOrCreateUser('bob@prov.test')).id;
    await repo.addMember({ workspace_id: ws.id, user_id: bob, role: 'member' });

    // Add a source via the web ingest path.
    const ing = await call(app, `/workspaces/${ws.id}/ingest`, {
      token: ownerSess,
      body: { source_kind: 'doc', source: 'We are killing the v1 mobile app effective today. Mid-market wedge stays.', source_ref: 'web-paste' },
    });
    expect(ing.status).toBe(200);
    expect(ing.json.candidates).toBeGreaterThan(0);

    // Light auto-applies on ingest (no manual approve step) — the source's
    // candidates are already active nodes.
    const approvedIds = (await repo
      .listNodesWithEmbeddings(ws.id, { activeOnly: true }))
      .map((r: { node: { id: string } }) => r.node.id);
    expect(approvedIds.length).toBeGreaterThan(0);

    // Every approved node is team-visible — no per-source privacy on the web.
    for (const id of approvedIds) {
      expect((await repo.getNodeVisibility(ws.id, id))?.visibility).toBe('team');
    }

    // A DIFFERENT member's AI agent sees them (shared with the workspace).
    const bobTok = (await repo.issueMcpToken({ workspace_id: ws.id, user_id: bob })).token;
    const recent = await call(app, '/mcp/tools/list_recent_changes', { body: { since: '2020-01-01T00:00:00Z' }, token: bobTok });
    const seen = new Set<string>((recent.json.nodes ?? []).map((n: any) => n.id));
    for (const id of approvedIds) expect(seen.has(id)).toBe(true);

    // The document is visible to that member too (workspace-shared).
    const bobSess = await magic(app, 'bob@prov.test');
    const docs = await call(app, `/workspaces/${ws.id}/documents`, { method: 'GET', token: bobSess });
    expect(docs.json.documents.length).toBeGreaterThan(0);
  });
});
