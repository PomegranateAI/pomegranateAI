// T2 canary scan (CONTRACTS.md §C4): with POMEGRANATE_SEAL=1, a canary string
// that enters through the real write paths (graph API, ingest, query, wiki,
// curation, agent threads, LLM cache) must never be stored in plaintext in any
// seal-map column — and must still read back in plaintext through the API.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { SEAL_MAP } from '../../platform/seal-map.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

const CANARY = 'CANARY7f3a9c';
const ENV_KEYS = ['POMEGRANATE_SOURCE_RAG', 'POMEGRANATE_SEAL', 'POMEGRANATE_LOCAL_KEK'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeAll(async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-seal-canary-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmpDir, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmpDir, 'files');
  process.env.POMEGRANATE_EMBEDDER = 'stub';
  process.env.POMEGRANATE_SOURCE_RAG = '1'; // so ingest writes source_chunks too
  process.env.POMEGRANATE_SEAL = '1';
  process.env.POMEGRANATE_LOCAL_KEK = randomBytes(32).toString('base64');
});

async function loadApp() {
  return import('./server.js?seal-canary-test=' + Date.now());
}

async function call(app: any, p: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(p, { method: opts.method ?? 'POST', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

describe('seal-map canary scan (SEAL=1)', () => {
  it('no seal-map column stores the canary in plaintext, and the API still reads it back', async () => {
    const { app, repo } = (await loadApp()) as any;
    expect(repo.crypto.sealing).toBe(true);

    const m = await call(app, '/auth/magic-link', { body: { email: 'canary@example.com' } });
    const token = (await call(app, '/auth/exchange', { body: { code: m.json.dev_code } })).json.session;
    const ws = (await call(app, '/workspaces', { body: { profile_id: 'notes', name: 'Canary' }, token })).json;
    const W = `/workspaces/${ws.id}`;

    // 1. A node written through the graph API.
    const node = {
      id: 'n_canary',
      type: 'note',
      created_at: '2026-10-07T00:00:00Z',
      updated_at: '2026-10-07T00:00:00Z',
      status: 'active',
      title: 'Homework policy',
      body: `Homework is capped at 30 minutes ${CANARY} for Years 7 to 9.`,
    };
    expect((await call(app, `${W}/graph`, { body: node, token })).status).toBe(200);

    // 2. A document through ingest (documents, chunks, candidates, evidence, nodes).
    const ingest = await call(app, `${W}/ingest`, {
      body: { source: `Maths department meeting. Decision: ${CANARY} homework capped at 30 minutes. No weekend tasks.`, source_ref: 'maths-meeting.md' },
      token,
    });
    expect(ingest.status).toBe(200);

    // 3. A question (context_request_texts keeps the verbatim text).
    await call(app, `${W}/query`, { body: { question: `What did we decide about ${CANARY} homework?` }, token });

    // 4. Wiki structure + fill (wiki_blocks.content).
    await call(app, `${W}/wiki/plan`, { token });
    const tree = (await call(app, `${W}/wiki`, { method: 'GET', token })).json.tree ?? [];
    for (const cat of tree) for (const page of cat.children ?? []) await call(app, `${W}/wiki/pages/${page.id}/fill`, { token });

    // 5. Paths without a simple HTTP entry: curation thread, agent thread, LLM cache, redaction.
    const doc = (await repo.listDocuments(ws.id))[0];
    await repo.appendCurationMessage(ws.id, doc?.id ?? 'd_x', 'user', `keep the ${CANARY} part`);
    await repo.appendAgentMessage({ surface: 'slack', team_id: 'T1', thread_key: 'C1:1', role: 'user', body: `ask ${CANARY}`, workspace_id: ws.id });
    await repo.cacheSet({ cache_key: 'k_canary', workspace_id: ws.id, value: { answer: CANARY }, ttlSec: 3600 });
    await repo.setNodeRedaction(ws.id, 'n_canary', JSON.stringify({ ...node, body: `redacted ${CANARY}` }));
    await repo.insertWikiBlock(ws.id, 'wp_x', { sort_order: 0, type: 'paragraph', content: { text: `<p>${CANARY}</p>` } });

    // --- scan every seal-map column ---
    const db = repo.db;
    const scanned: Record<string, number> = {};
    for (const [col, entry] of Object.entries(SEAL_MAP)) {
      if (col === 'user_app_credentials.secret') continue; // sealed with POMEGRANATE_CREDENTIALS_KEY (item 4.5 deferred)
      const [table, column] = col.split('.') as [string, string];
      const rows = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ v: unknown }>;
      scanned[col] = rows.length;
      for (const { v } of rows) {
        if (entry.kind === 'bytes') {
          expect(Buffer.from(v as Buffer).subarray(0, 4).toString('ascii'), col).toBe('PGE1');
        } else if (entry.kind === 'text') {
          expect(String(v), col).toMatch(/^v1:\d+:/);
          expect(String(v), col).not.toContain(CANARY);
        } else {
          const obj = JSON.parse(String(v));
          for (const f of entry.fields ?? []) {
            if (typeof obj?.[f] !== 'string') continue;
            expect(obj[f], `${col}#${f}`).toMatch(/^v1:\d+:/);
            expect(obj[f], `${col}#${f}`).not.toContain(CANARY);
          }
        }
      }
    }
    // The paths above actually reached these columns (a scan of empty tables proves nothing).
    for (const col of [
      'graph_nodes.data',
      'graph_nodes.redacted_data',
      'graph_nodes.embedding',
      'source_chunks.text',
      'source_chunks.embedding',
      'agent_thread_messages.body',
      'wiki_blocks.content',
      'curation_messages.body',
      'context_request_texts.request_text',
      'context_usage_log.request_text',
      'synth_cache.value',
    ]) {
      expect(scanned[col], `no rows reached ${col}`).toBeGreaterThan(0);
    }

    // --- and the plaintext is still there for the people who may read it ---
    const nodes = (await call(app, `${W}/graph`, { method: 'GET', token })).json.nodes as Array<{ id: string; body: string }>;
    expect(nodes.find((n) => n.id === 'n_canary')?.body).toContain(CANARY);
    expect((await repo.listAgentMessages('slack', 'T1', 'C1:1'))[0].body).toBe(`ask ${CANARY}`);
    expect(await repo.cacheGet('k_canary')).toEqual({ answer: CANARY });
    const chunks = await repo.listSourceChunkRowsForSearch(ws.id);
    expect(chunks.some((c: any) => c.text.includes(CANARY))).toBe(true);

    // --- deleting the folder destroys the key: the ciphertext left in any copy is dead ---
    const sealedBody = JSON.parse((db.prepare(`SELECT data FROM graph_nodes WHERE workspace_id = ? AND id = 'n_canary'`).get(ws.id) as any).data).body;
    expect((await call(app, W, { method: 'DELETE', token })).status).toBe(200);
    await expect(repo.crypto.open(ws.id, 'graph_nodes.data#body', 'n_canary', sealedBody)).rejects.toThrow(/workspace_shredded/);
  });
});
