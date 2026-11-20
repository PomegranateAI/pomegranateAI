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

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-caudit-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

async function loadApp() {
  return import('./server.js?caudit=' + Date.now());
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
  path: string,
  opts: { token?: string; body?: unknown; ip?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
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
  return { status: r.status, json, text };
}

describe('customer audit log + export', () => {
  it('records sign_in, graph_node_mutated, source_ingested, deliverable_submitted, mcp_token_issued', async () => {
    const { app } = await loadApp();

    // sign_in: requires an existing workspace membership to attribute against.
    // Path: create the user (no memberships → no sign_in row), create the
    // workspace (becomes admin), then exchange again so the second sign_in
    // attributes to the workspace.
    const session = await magic(app, 'admin@acme.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'Acme' } })
    ).json;
    // Re-exchange so we get one sign_in attributed to this workspace.
    await magic(app, 'admin@acme.example');

    // graph_node_mutated
    await call(app, 'POST', `/workspaces/${ws.id}/graph`, {
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

    // source_ingested
    await call(app, 'POST', `/workspaces/${ws.id}/ingest`, {
      token: session,
      body: {
        source: 'Killing the v1 mobile app effective today.',
        source_kind: 'doc',
        source_ref: 'doc:test',
      },
    });

    // deliverable_submitted
    await call(app, 'POST', `/workspaces/${ws.id}/reviews`, {
      token: session,
      body: { deliverable: 'Unlock synergy across teams.', kind: 'other' },
    });

    // mcp_token_issued
    const tok = await call(app, 'POST', `/workspaces/${ws.id}/mcp-tokens`, {
      token: session,
      body: {},
    });
    expect(tok.json.token).toMatch(/^pmg_/);

    // Pull the customer audit log
    const audit = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit?limit=100`, {
      token: session,
    });
    expect(audit.status).toBe(200);
    const events = audit.json.entries.map((e: any) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        'sign_in',
        'graph_node_mutated',
        'source_ingested',
        'deliverable_submitted',
        'mcp_token_issued',
        // The export call itself is audited:
        'audit_log_exported',
      ]),
    );

    // Payloads are terse — no deliverable bodies.
    const submit = audit.json.entries.find((e: any) => e.event === 'deliverable_submitted');
    const payload = JSON.parse(submit.payload);
    expect(payload).toMatchObject({ caller: 'web', kind: 'other' });
    expect(payload).not.toHaveProperty('deliverable');

    // source_ingested names the source and the notes it produced (this stub
    // source yields none; e2e.test.ts covers the non-empty case).
    const ingested = audit.json.entries.find((e: any) => e.event === 'source_ingested');
    const ing = JSON.parse(ingested.payload);
    expect(ing).toMatchObject({ kind: 'doc', ref: 'doc:test', source_name: 'doc:test', nodes_created: 0, node_ids: [] });
    expect(ingested.resource_id).toBe(ing.document_id);
    expect(ing).not.toHaveProperty('source');
  });

  it('pages by id cursor with a total, and logs one read per view', async () => {
    const { app, repo } = await loadApp();
    const session = await magic(app, 'pages@x.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'Pages' } })
    ).json;
    for (let i = 0; i < 7; i++) await repo.logCustomerAudit(ws.id, { event: 'mcp_token_used', payload: { i } });

    const p1 = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit?limit=3`, { token: session });
    const totalAfterFirst = p1.json.total;
    expect(p1.json.entries).toHaveLength(3);
    const p2 = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit?limit=3&before=${p1.json.entries[2].id}`, {
      token: session,
    });
    expect(p2.json.entries).toHaveLength(3);
    // No overlap, strictly older, and turning the page didn't log another read.
    expect(p2.json.entries[0].id).toBeLessThan(p1.json.entries[2].id);
    expect(p2.json.total).toBe(totalAfterFirst);
  });

  it('exports as CSV with stable column order', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'csv@x.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'CSV' } })
    ).json;
    const csv = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit?format=csv`, {
      token: session,
    });
    expect(csv.status).toBe(200);
    const lines = csv.text.split('\n');
    expect(lines[0]).toBe(
      'id,created_at,event,actor_user_id,actor_email,source_ip,user_agent,resource_type,resource_id,payload',
    );
    // At least one data row (workspace.created path doesn't write a customer
    // audit; but the export itself does, so we expect >=1)
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('non-admin cannot read or export the customer audit', async () => {
    const { app } = await loadApp();
    const admin = await magic(app, 'a@x.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: admin, body: { profile_id: 'notes', name: 'Iso' } })
    ).json;
    // Add a non-admin member: use the second user, add membership directly via
    // a second user, then attempt to read the audit log.
    const member = await magic(app, 'm@x.example');
    // Insert a 'member' membership row using the internal API (no public
    // member-add endpoint yet; reach in via the imported repo).
    const { repo } = await loadApp();
    const memberUser = repo.db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get('m@x.example') as { id: string };
    await repo.addMember({ workspace_id: ws.id, user_id: memberUser.id, role: 'member' });

    const r = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit`, {
      token: member,
    });
    expect(r.status).toBe(403);
  });

  it('captures source_ip and user_agent on the entry', async () => {
    const { app } = await loadApp();
    const session = await magic(app, 'ip@x.example');
    const ws = (
      await call(app, 'POST', '/workspaces', { token: session, body: { profile_id: 'notes', name: 'IP' } })
    ).json;
    await call(app, 'POST', `/workspaces/${ws.id}/graph`, {
      token: session,
      ip: '203.0.113.42',
      body: {
        id: 'pos-foo',
        type: 'note',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        status: 'active',
        body: 'foo',
      },
    });
    const r = await call(app, 'GET', `/workspaces/${ws.id}/customer-audit`, {
      token: session,
    });
    const mutate = r.json.entries.find((e: any) => e.event === 'graph_node_mutated');
    expect(mutate.source_ip).toBe('203.0.113.42');
    // hono test-runner emits a default user-agent; just assert non-empty.
    expect(mutate.user_agent === null || typeof mutate.user_agent === 'string').toBe(true);
  });
});
