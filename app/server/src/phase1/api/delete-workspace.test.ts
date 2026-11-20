import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-del-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?del=' + Date.now());
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

describe('workspace deletion end-to-end', () => {
  it('admin can delete a workspace; every workspace-scoped row is purged', async () => {
    const { app, repo } = await loadApp();
    const session = await magic(app, 'admin@del.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'ToDelete' } })
    ).json;
    const wsId = ws.id;

    // Seed many tables: graph node, candidate (via ingest), review,
    // mcp token, synth cache (implicitly via review), customer audit.
    await call(app, 'POST', `/workspaces/${wsId}/graph`, {
      token: session,
      body: {
        id: 'pos-banned-synergy',
        type: 'note',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        body: 'synergy',
      },
    });
    await call(app, 'POST', `/workspaces/${wsId}/ingest`, {
      token: session,
      body: {
        source: 'Killing the v1 mobile app.',
        source_kind: 'doc',
        source_ref: 'doc:del',
      },
    });
    await call(app, 'POST', `/workspaces/${wsId}/reviews`, {
      token: session,
      body: { deliverable: 'Unlock synergy across teams.', kind: 'other' },
    });
    const tok = await call(app, 'POST', `/workspaces/${wsId}/mcp-tokens`, {
      token: session,
      body: {},
    });
    expect(tok.status).toBe(200);

    // Seed a Slack agent thread + message — these have no FK to workspaces
    // (agent_thread_messages has no workspace_id column at all), so they must
    // be swept explicitly by deleteWorkspaceRows or they leak verbatim Slack
    // Q&A bodies past a workspace deletion.
    const adminRow = repo.db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get('admin@del.example') as { id: string };
    await repo.upsertAgentThread({
      surface: 'slack',
      team_id: 'T_DEL',
      thread_key: 'C_DEL:1',
      user_id: adminRow.id,
      workspace_id: wsId,
      pending_action: null,
    });
    await repo.appendAgentMessage({
      surface: 'slack',
      team_id: 'T_DEL',
      thread_key: 'C_DEL:1',
      role: 'user',
      body: 'what is the roadmap decision',
      workspace_id: wsId,
    });

    // Drop a file under FILES_DIR/<ws>/ to simulate an uploaded source.
    const wsFilesDir = path.join(process.env.POMEGRANATE_FILES_DIR!, wsId);
    await fs.mkdir(wsFilesDir, { recursive: true });
    await fs.writeFile(path.join(wsFilesDir, 'transcript.txt'), 'sensitive content');
    expect(await fs.readFile(path.join(wsFilesDir, 'transcript.txt'), 'utf8')).toBe(
      'sensitive content',
    );

    // Sanity: pre-deletion, rows exist.
    const pre = await repo.countWorkspaceRows(wsId);
    expect(pre.workspaces).toBe(1);
    expect(pre.graph_nodes).toBeGreaterThan(0);
    expect(pre.mcp_tokens).toBeGreaterThan(0);
    expect(pre.memberships).toBe(1);
    expect(pre.agent_threads).toBe(1);
    expect(pre.agent_thread_messages).toBe(1);

    // Delete
    const del = await call(app, 'DELETE', `/workspaces/${wsId}`, { token: session });
    expect(del.status).toBe(200);
    expect(del.json.ok).toBe(true);

    // Every row in every workspace-scoped table is gone.
    const post = await repo.countWorkspaceRows(wsId);
    for (const [table, n] of Object.entries(post)) {
      expect(n, `table ${table} still has rows`).toBe(0);
    }

    // Files on disk are gone.
    await expect(fs.access(wsFilesDir)).rejects.toBeTruthy();

    // ...but the audit trail survives in the archive, ending with the deletion
    // itself, attributed to the admin who did it.
    const archived = await repo.listDeletedWorkspaceAudit(wsId);
    expect(archived.length).toBeGreaterThan(0);
    const last = archived[archived.length - 1];
    expect(last.event).toBe('workspace_deleted');
    expect(last.actor_email).toBe('admin@del.example');
    expect(archived.every((r) => r.workspace_id === wsId)).toBe(true);
    expect(archived[0].workspace_name).toBeTruthy();
  });

  it('prunes archived audit trails past their retention on the next deletion', async () => {
    const { app, repo } = await loadApp();
    repo.db
      .prepare(
        `INSERT INTO deleted_workspace_audit (original_id, workspace_id, event, created_at, archived_at)
         VALUES (1, 'ws_ancient', 'workspace_deleted', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      )
      .run();
    const session = await magic(app, 'prune@del.example');
    const ws = (await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'Prune' } })).json;
    expect((await call(app, 'DELETE', `/workspaces/${ws.id}`, { token: session })).status).toBe(200);
    expect(await repo.listDeletedWorkspaceAudit('ws_ancient')).toHaveLength(0);
    expect((await repo.listDeletedWorkspaceAudit(ws.id)).length).toBeGreaterThan(0);
  });

  it('non-admin cannot delete a workspace', async () => {
    const { app, repo } = await loadApp();
    const adminSession = await magic(app, 'a2@del.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: adminSession, body: { profile_id: 'notes', name: 'KeepMe' } })
    ).json;
    const memberSession = await magic(app, 'm2@del.example');
    const memberRow = repo.db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get('m2@del.example') as { id: string };
    await repo.addMember({ workspace_id: ws.id, user_id: memberRow.id, role: 'member' });

    const r = await call(app, 'DELETE', `/workspaces/${ws.id}`, { token: memberSession });
    expect(r.status).toBe(403);
    // Workspace row still present.
    const post = await repo.countWorkspaceRows(ws.id);
    expect(post.workspaces).toBe(1);
  });

  it('deletion of workspace A does not touch workspace B', async () => {
    const { app, repo } = await loadApp();
    const sessA = await magic(app, 'tenA@del.example');
    const sessB = await magic(app, 'tenB@del.example');
    const wsA = (
      await call(app, 'POST', '/workspaces', { token: sessA, body: { profile_id: 'notes', name: 'A' } })
    ).json;
    const wsB = (
      await call(app, 'POST', '/workspaces', { token: sessB, body: { profile_id: 'notes', name: 'B' } })
    ).json;
    await call(app, 'POST', `/workspaces/${wsB.id}/graph`, {
      token: sessB,
      body: {
        id: 'pos-b',
        type: 'note',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        body: 'keep me',
      },
    });
    await call(app, 'DELETE', `/workspaces/${wsA.id}`, { token: sessA });

    const a = await repo.countWorkspaceRows(wsA.id);
    const b = await repo.countWorkspaceRows(wsB.id);
    expect(a.workspaces).toBe(0);
    expect(b.workspaces).toBe(1);
    expect(b.graph_nodes).toBe(1);
  });
});
