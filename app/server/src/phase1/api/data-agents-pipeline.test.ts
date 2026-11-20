/**
 * Integration test for the exclusive-path capture branch
 * (spec-data-agents-and-subfolder-wiki.md §3, §8 "Exclusive-path routing").
 *
 * A document takes EXACTLY ONE of two capture paths per subfolder, decided
 * by whether that subfolder has an active data agent at ingest time:
 *   - no agent  → the note pass (unchanged baseline)
 *   - an agent  → the agent's structured entries, never a note, with
 *                 supersede applied for operation "change"/"nuance"
 *
 * Uses a test-local capture stub (not the shared TestSynthStub, which is
 * hand-tuned to founding-profile keywords) so this test controls exactly
 * what candidates come back, including `operation`/`amends`, without any
 * real LLM call.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextProfile, Candidate } from '../../lib/schemas.js';

const betTemplate: ContextProfile = {
  id: 'bet_tracker',
  name: 'Bet Tracker',
  description: 'Tracks product bets and their status, for testing.',
  shape: 'items',
  kinds: [
    {
      key: 'bet',
      label: 'Bet',
      label_plural: 'Bets',
      color: 2,
      description: 'A product direction being pursued.',
      attrs: [{ key: 'status', label: 'Status', type: 'enum', values: ['proposed', 'active', 'shelved'] }],
      progress: { attr: 'status', settled_values: ['shelved'] },
    },
  ],
  feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: 'x' }],
  review_kinds: ['bet'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: { red: 'x', yellow: 'y', green: 'z' },
  edge_kinds: [],
  edges_deliberately_empty: true,
};

// Test-local deterministic capture stub. Emits ONE candidate of whatever
// kind the given profile declares first — 'note' for the baseline `notes`
// template, 'bet' for betTemplate — so the same test drives both branches
// without a real model. A source containing "SUPERSEDE:<id>" emits a
// change/amends candidate instead of a plain addition, to exercise the
// supersede write path deterministically.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  let seq = 0;
  const stub: (typeof real)['getProvider'] extends () => infer P ? P : never = {
    name: 'data-agent-test-stub',
    async triage() {
      return { relevant: true, reason: 'stub', confidence: 0.9 };
    },
    async capture({ profile, source }) {
      const kind = profile?.kinds?.[0]?.key ?? 'note';
      const ts = new Date().toISOString();
      seq += 1;
      const m = /SUPERSEDE:(\S+)/.exec(source);
      const base = {
        id: `stub-c${seq}`,
        flag: 'green' as const,
        source_quote: source.slice(0, 80),
        source_ref: 'doc',
        confidence: 0.9,
      };
      const proposed_node: Record<string, unknown> = {
        id: `stub-n${seq}`,
        type: kind,
        created_at: ts,
        updated_at: ts,
        status: 'active',
        title: `Stub ${kind} ${seq}`,
        body: source.slice(0, 200),
        ...(kind === 'bet' ? { attrs: { status: m ? 'shelved' : 'active' } } : {}),
      };
      const candidate = m
        ? { ...base, proposed_node, operation: 'change', amends: m[1] }
        : { ...base, proposed_node };
      return [candidate] as unknown as Candidate[];
    },
    async feedback() {
      return [];
    },
    async query() {
      return { answer: '', cited_node_ids: [], has_answer: false };
    },
    async overview() {
      return '';
    },
  } as unknown as (typeof real)['getProvider'] extends () => infer P ? P : never;
  return { ...real, getProvider: () => stub };
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-data-agents-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

async function loadApp() {
  return import('./server.js?data-agents=' + Date.now());
}

async function jsonCall(
  app: any,
  pathname: string,
  opts: { method?: string; body?: unknown; token?: string; ws?: string } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.ws) headers['x-workspace-id'] = opts.ws;
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

describe('exclusive-path capture branch', () => {
  it('no agent attached: produces a note, zero structured entries — the unchanged baseline', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-a-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'A' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };

    const r = await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'A plain note about something.', source_kind: 'doc', subgraph_id: sg.id },
    });
    expect(r.status).toBe(200);

    const nodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('note');
  });

  it('agent attached: produces ZERO note nodes, only structured entries citing the document directly', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-b-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'B' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };
    const owner = await repo.findOrCreateUser((await jsonCall(app, '/me', { token: tok })).json.email ?? '');

    await repo.attachDataAgent(ws.id, sg.id, {
      template_id: 'bet_tracker',
      template: betTemplate,
      cadence: 'per_document',
      attached_by: owner.id,
    });

    const r = await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'We should try an async standup digest.', source_kind: 'doc', subgraph_id: sg.id },
    });
    expect(r.status).toBe(200);

    const nodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(nodes.filter((n: { type: string }) => n.type === 'note')).toHaveLength(0);
    expect(nodes.filter((n: { type: string }) => n.type === 'bet')).toHaveLength(1);
    // Cites the document directly via the evidence ledger — no note
    // intermediary node sits between the entry and its source.
    const documentId = r.json.document_id;
    expect(await repo.listNodeIdsByDocument(ws.id, documentId)).toContain(nodes[0]!.id);
  });

  it('agent attached: a "change" candidate supersedes (archives) the node it amends', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-c-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'C' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };
    const owner = await repo.findOrCreateUser((await jsonCall(app, '/me', { token: tok })).json.email ?? '');
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'per_document', attached_by: owner.id });

    const first = await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'Bet: try the digest.', source_kind: 'doc', subgraph_id: sg.id },
    });
    expect(first.status).toBe(200);
    const firstNode = (await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id))[0];
    expect(firstNode.status).toBe('active');

    const second = await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: `SUPERSEDE:${firstNode.id} The digest bet is now shelved.`, source_kind: 'doc', subgraph_id: sg.id },
    });
    expect(second.status).toBe(200);

    const allNodes = repo.listNodesIncludingArchived
      ? repo.listNodesIncludingArchived(ws.id, sg.id)
      : [await repo.getNode(ws.id, firstNode.id), ...await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id)];
    const original = await repo.getNode(ws.id, firstNode.id);
    expect(original?.status).toBe('archived');

    const active = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(firstNode.id);
    void allNodes;
  });

  it('detach: future documents resume the note path; past entries are untouched', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-d-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'D' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };
    const owner = await repo.findOrCreateUser((await jsonCall(app, '/me', { token: tok })).json.email ?? '');
    await repo.attachDataAgent(ws.id, sg.id, { template_id: 'bet_tracker', template: betTemplate, cadence: 'per_document', attached_by: owner.id });

    await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'A bet while the agent is active.', source_kind: 'doc', subgraph_id: sg.id },
    });
    await repo.detachDataAgent(ws.id, sg.id);
    await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'A plain note after detach.', source_kind: 'doc', subgraph_id: sg.id },
    });

    const nodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(nodes.filter((n: { type: string }) => n.type === 'bet')).toHaveLength(1);
    expect(nodes.filter((n: { type: string }) => n.type === 'note')).toHaveLength(1);
  });

  it('attach with run:"backfill" archives every existing node and re-runs capture on every document already in the subfolder', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-f-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'F' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };
    const owner = await repo.findOrCreateUser((await jsonCall(app, '/me', { token: tok })).json.email ?? '');

    // Two documents ingested BEFORE any agent is attached — plain notes.
    await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'First backlog item worth keeping.', source_kind: 'doc', subgraph_id: sg.id },
    });
    await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'Second backlog item worth keeping.', source_kind: 'doc', subgraph_id: sg.id },
    });
    const beforeNodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(beforeNodes).toHaveLength(2);
    expect(beforeNodes.every((n: { type: string }) => n.type === 'note')).toBe(true);

    // Register the template as this workspace's own (mirrors how attach
    // resolves a custom template_id via resolveDataAgentTemplate).
    await repo.saveDataAgentTemplate(ws.id, { id: 'bet_tracker', name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });

    const attachRes = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sg.id}/data-agent`, {
      method: 'POST',
      token: tok,
      body: { template_id: 'bet_tracker', cadence: 'per_document', run: 'backfill' },
    });
    expect(attachRes.status).toBe(200);
    expect(attachRes.json.backfill).toEqual({ archived: 2, documents: 2, documents_skipped: 0, candidates: 2 });

    // The pre-existing note nodes are archived, not deleted and not left active.
    for (const n of beforeNodes) {
      expect((await repo.getNode(ws.id, n.id))?.status).toBe('archived');
    }

    // Fresh structured entries, one per document, replace them.
    const afterNodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(afterNodes).toHaveLength(2);
    expect(afterNodes.every((n: { type: string }) => n.type === 'bet')).toBe(true);
  });

  it('attach with run:"new_only" (the default) leaves existing content untouched — only future documents are affected', async () => {
    const { app, repo } = (await loadApp()) as any;
    const tok = await magic(app, `owner-g-${Date.now()}@ex.com`);
    const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: 'G' }, token: tok })).json;
    const sgRes = (await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, { method: 'POST', token: tok, body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' } })).json;
    const sg = { id: sgRes.subgraph_id };
    const owner = await repo.findOrCreateUser((await jsonCall(app, '/me', { token: tok })).json.email ?? '');

    await jsonCall(app, `/workspaces/${ws.id}/ingest`, {
      method: 'POST',
      token: tok,
      body: { source: 'A note from before the agent existed.', source_kind: 'doc', subgraph_id: sg.id },
    });
    const beforeNode = (await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id))[0];

    await repo.saveDataAgentTemplate(ws.id, { id: 'bet_tracker', name: 'Bet Tracker', profile: betTemplate, created_by: owner.id });
    const attachRes = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sg.id}/data-agent`, {
      method: 'POST',
      token: tok,
      body: { template_id: 'bet_tracker', cadence: 'per_document' }, // run omitted → defaults to 'new_only'
    });
    expect(attachRes.status).toBe(200);
    expect(attachRes.json.backfill).toBeUndefined();

    // The old note is exactly as it was — active, untouched.
    expect((await repo.getNode(ws.id, beforeNode.id))?.status).toBe('active');
    const nodes = await repo.listNodes(ws.id, { activeOnly: true, aiRead: false }, sg.id);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(beforeNode.id);
  });
});
