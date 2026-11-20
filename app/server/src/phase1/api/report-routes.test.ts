/**
 * The Report (spec-data-agents-and-subfolder-wiki.md §4.3).
 *
 * `hasStructuredLLM` is forced off (per repo convention: "do not add real
 * LLM calls to unit tests" — a real ANTHROPIC_API_KEY can be present in a
 * local dev shell's environment, and report/generate.ts calls
 * `structuredCall` directly, outside the synthesis-provider seam the other
 * data-agent tests stub instead). That routes every generate through the
 * deterministic offline fallback in report/generate.ts, which is enough to
 * exercise every branch this test cares about: which taxonomy governs the
 * report, the buckets/progress split, and the Sources flag — none of which
 * depend on what a model would actually write.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContextProfile } from '../../lib/schemas.js';

vi.mock('../../lib/anthropic.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/anthropic.js')>('../../lib/anthropic.js');
  return { ...real, hasStructuredLLM: () => false };
});

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
    {
      key: 'risk',
      label: 'Risk',
      label_plural: 'Risks',
      color: 4,
      description: 'Something that could sink a bet.',
      buckets: [
        { key: 'technical', label: 'Technical', match: 'category' },
        { key: 'adoption', label: 'Adoption', match: 'category' },
      ],
    },
  ],
  feedback_dimensions: [{ key: 'accuracy', label: 'Accuracy', description: 'x' }],
  review_kinds: ['bet', 'risk'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: { red: 'x', yellow: 'y', green: 'z' },
  edge_kinds: [],
  edges_deliberately_empty: true,
};

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-report-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
});

let loadSeq = 0;
async function loadApp() {
  return import('./server.js?report=' + Date.now() + '-' + loadSeq++);
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

async function setupWorkspace(app: any, label: string) {
  const tok = await magic(app, `owner-${label}-${Date.now()}@ex.com`);
  const ws = (await jsonCall(app, '/workspaces', { method: 'POST', body: { profile_id: 'notes', name: label }, token: tok })).json;
  const sgRes = (
    await jsonCall(app, `/workspaces/${ws.id}/subgraphs`, {
      method: 'POST',
      token: tok,
      body: { profile_id: 'notes', slug: 'ideas', name: 'Ideas' },
    })
  ).json;
  const owner = (
    await jsonCall(app, '/me', { token: tok })
  ).json;
  return { tok, ws, sgId: sgRes.subgraph_id, ownerEmail: owner.email as string };
}

describe('the Report', () => {
  it('GET before any generate returns report: null, stale: false', async () => {
    const { app } = (await loadApp()) as any;
    const { tok, ws, sgId } = await setupWorkspace(app, 'a');
    const r = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report`, { token: tok });
    expect(r.status).toBe(200);
    expect(r.json.report).toBeNull();
    expect(r.json.stale).toBe(false);
  });

  it('unknown subgraph 404s on both GET and generate', async () => {
    const { app } = (await loadApp()) as any;
    const { tok, ws } = await setupWorkspace(app, 'b');
    const r1 = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/sg_nope/report`, { token: tok });
    expect(r1.status).toBe(400);
    const r2 = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/sg_nope/report/generate`, { method: 'POST', token: tok });
    expect(r2.status).toBe(400);
  });

  it('no agent attached: generates a single Notes section, no Sources flag', async () => {
    const { app, repo } = (await loadApp()) as any;
    const { tok, ws, sgId } = await setupWorkspace(app, 'c');
    await repo.upsertNode(ws.id, { id: 'n1', type: 'note', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'active', title: 'A note', body: 'Something worth keeping.' } as any, undefined, undefined, sgId);

    const gen = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report/generate`, { method: 'POST', token: tok });
    expect(gen.status).toBe(200);
    expect(gen.json.report.content.has_sources).toBe(false);
    expect(gen.json.report.content.sections).toHaveLength(1);
    expect(gen.json.report.content.sections[0].kind_key).toBe('note');
    // Deterministic fallback grounds every block in the node it describes.
    expect(gen.json.report.content.sections[0].groups[0].blocks[0].cited_node_ids).toEqual(['n1']);

    const get = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report`, { token: tok });
    expect(get.status).toBe(200);
    expect(get.json.report.content.sections[0].kind_key).toBe('note');
    expect(get.json.stale).toBe(false); // no node changed since generate
  });

  it('agent attached: one section per kind, buckets split Risks, progress splits Bets, has_sources true', async () => {
    const { app, repo } = (await loadApp()) as any;
    const { tok, ws, sgId, ownerEmail } = await setupWorkspace(app, 'd');
    const owner = await repo.findOrCreateUser(ownerEmail);
    await repo.attachDataAgent(ws.id, sgId, {
      template_id: 'bet_tracker',
      template: betTemplate,
      cadence: 'per_document',
      attached_by: owner.id,
    });
    const now = new Date().toISOString();
    await repo.upsertNode(ws.id, { id: 'b1', type: 'bet', created_at: now, updated_at: now, status: 'active', title: 'Ship the thing', body: 'x', attrs: { status: 'active' } } as any, undefined, undefined, sgId);
    await repo.upsertNode(ws.id, { id: 'b2', type: 'bet', created_at: now, updated_at: now, status: 'active', title: 'Dropped bet', body: 'x', attrs: { status: 'shelved' } } as any, undefined, undefined, sgId);
    await repo.upsertNode(ws.id, { id: 'r1', type: 'risk', created_at: now, updated_at: now, status: 'active', title: 'Slow rollout', body: 'x', category: 'adoption' } as any, undefined, undefined, sgId);
    await repo.upsertNode(ws.id, { id: 'r2', type: 'risk', created_at: now, updated_at: now, status: 'active', title: 'Flaky infra', body: 'x', category: 'technical' } as any, undefined, undefined, sgId);

    const gen = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report/generate`, { method: 'POST', token: tok });
    expect(gen.status).toBe(200);
    const content = gen.json.report.content;
    expect(content.has_sources).toBe(true);
    expect(content.sections.map((s: any) => s.kind_key).sort()).toEqual(['bet', 'risk']);

    const betSection = content.sections.find((s: any) => s.kind_key === 'bet');
    const betGroupKeys = betSection.groups.map((g: any) => g.key).sort();
    expect(betGroupKeys).toEqual(['attention', 'settled']); // progress split, not a flat group

    const riskSection = content.sections.find((s: any) => s.kind_key === 'risk');
    const riskGroupKeys = riskSection.groups.map((g: any) => g.key).sort();
    expect(riskGroupKeys).toEqual(['adoption', 'technical']); // buckets split

    const staleAfterEdit = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report`, { token: tok });
    expect(staleAfterEdit.json.stale).toBe(false);
  });

  it('regenerate replaces the stored report wholesale — no versioning', async () => {
    const { app, repo } = (await loadApp()) as any;
    const { tok, ws, sgId } = await setupWorkspace(app, 'e');
    const now = new Date().toISOString();
    await repo.upsertNode(ws.id, { id: 'n1', type: 'note', created_at: now, updated_at: now, status: 'active', title: 'First', body: 'x' } as any, undefined, undefined, sgId);
    const first = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report/generate`, { method: 'POST', token: tok });
    expect(first.json.report.content.sections[0].groups[0].blocks).toHaveLength(1);

    await repo.upsertNode(ws.id, { id: 'n2', type: 'note', created_at: now, updated_at: now, status: 'active', title: 'Second', body: 'x' } as any, undefined, undefined, sgId);
    const second = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report/generate`, { method: 'POST', token: tok });
    expect(second.json.report.content.sections[0].groups[0].blocks).toHaveLength(2);

    const get = await jsonCall(app, `/workspaces/${ws.id}/subgraphs/${sgId}/report`, { token: tok });
    expect(get.json.report.content.sections[0].groups[0].blocks).toHaveLength(2); // the second, not the first
  });
});
