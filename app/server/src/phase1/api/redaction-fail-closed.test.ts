/**
 * Source-redaction store rules FAIL CLOSED: when a rule says the source text
 * must be scrubbed before it is stored, and the scrub cannot run (no redactor,
 * text over SOURCE_REDACT_MAX_CHARS, or the redactor throws), the ingest stops
 * with 422 redaction_unavailable and nothing is stored. The
 * POMEGRANATE_REDACT_FAIL_OPEN=1 escape hatch restores the old behaviour, and a
 * workspace with no source rule is unaffected.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';

vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

const realRedact = TestSynthStub.redactFields;

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-redact-fc-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  process.env.POMEGRANATE_FILES_DIR = path.join(tmp, 'files');
});

afterEach(() => {
  TestSynthStub.redactFields = realRedact;
  delete process.env.POMEGRANATE_REDACT_FAIL_OPEN;
});

let loaded: any;
async function loadApp() {
  loaded ??= await import('./server.js?redact-fc=' + Date.now());
  return loaded as { app: any; repo: any };
}

async function call(app: any, pathname: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const r = await app.request(pathname, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function magic(app: any, email: string): Promise<string> {
  const r1 = await call(app, '/auth/magic-link', { method: 'POST', body: { email } });
  const r2 = await call(app, '/auth/exchange', { method: 'POST', body: { code: r1.json.dev_code } });
  return r2.json.session as string;
}

let n = 0;
async function setup(withRule: boolean) {
  const { app } = await loadApp();
  const token = await magic(app, `redact-fc-${++n}@pome.test`);
  const ws = (await call(app, '/workspaces', { method: 'POST', token, body: { name: `RFC ${n}`, profile_id: 'notes' } })).json
    .id as string;
  if (withRule) {
    // The stub classifies "…from transcripts" as a store-phase rule targeting
    // the source, and redacts "reseller" (a >4-char rule word) from text.
    const rule = await call(app, `/workspaces/${ws}/rules`, {
      method: 'POST',
      token,
      body: { instructions: 'Remove reseller mentions from transcripts', scopes: ['team'] },
    });
    expect(rule.status).toBe(200);
  }
  return { token, ws };
}

const SOURCE = 'Killing the reseller program. north star is mid-market ARR.';

async function ingest(ws: string, token: string, source = SOURCE) {
  const { app } = await loadApp();
  return call(app, `/workspaces/${ws}/ingest`, { method: 'POST', token, body: { source } });
}

async function docCount(ws: string): Promise<number> {
  const { repo } = await loadApp();
  return (await repo.listDocuments(ws)).length;
}

describe('source-redaction rules fail closed', () => {
  it('422 unavailable when no redactor is configured; nothing stored', async () => {
    const { ws, token } = await setup(true);
    TestSynthStub.redactFields = undefined;
    const r = await ingest(ws, token);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('redaction_unavailable');
    expect(r.json.reason).toBe('unavailable');
    expect(typeof r.json.detail).toBe('string');
    expect(r.json.detail.length).toBeGreaterThan(20);
    expect(await docCount(ws)).toBe(0);
  });

  it('422 too_long when the text exceeds the redaction size guard; nothing stored', async () => {
    const { ws, token } = await setup(true);
    const r = await ingest(ws, token, SOURCE + ' ' + 'x'.repeat(20_001));
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: 'redaction_unavailable', reason: 'too_long' });
    expect(await docCount(ws)).toBe(0);
  });

  it('422 failed when the redactor throws; nothing stored', async () => {
    const { ws, token } = await setup(true);
    TestSynthStub.redactFields = async () => {
      throw new Error('provider timeout');
    };
    const r = await ingest(ws, token);
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: 'redaction_unavailable', reason: 'failed' });
    expect(await docCount(ws)).toBe(0);
  });

  it('file upload: 422 and no document row', async () => {
    const { app } = await loadApp();
    const { ws, token } = await setup(true);
    TestSynthStub.redactFields = undefined;
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(SOURCE)], { type: 'text/plain' }), 'memo.txt');
    const r = await app.request(`/workspaces/${ws}/ingest/file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe('redaction_unavailable');
    expect(await docCount(ws)).toBe(0);
  });

  it('MCP ingest_document: ToolError redaction_unavailable, nothing stored', async () => {
    const { app } = await loadApp();
    const { ws, token } = await setup(true);
    const mcp = (await call(app, `/workspaces/${ws}/mcp-tokens`, { method: 'POST', token, body: {} })).json.token as string;
    TestSynthStub.redactFields = async () => {
      throw new Error('boom');
    };
    const r = await call(app, '/mcp/tools/ingest_document', {
      method: 'POST',
      token: mcp,
      body: { source: SOURCE, source_kind: 'doc', source_ref: 'memo.md' },
    });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ error: 'redaction_unavailable', reason: 'failed' });
    expect(typeof r.json.detail).toBe('string');
    expect(await docCount(ws)).toBe(0);
  });

  it('POMEGRANATE_REDACT_FAIL_OPEN=1 restores fail-open (original text stored)', async () => {
    const { app } = await loadApp();
    const { ws, token } = await setup(true);
    process.env.POMEGRANATE_REDACT_FAIL_OPEN = '1';
    TestSynthStub.redactFields = undefined;
    const r = await ingest(ws, token);
    expect(r.status).toBe(200);
    expect(await docCount(ws)).toBe(1);
    const content = await app.request(`/workspaces/${ws}/documents/${r.json.document_id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await content.text()).toContain('reseller');
  });

  it('still redacts normally when the redactor works', async () => {
    const { app } = await loadApp();
    const { ws, token } = await setup(true);
    const r = await ingest(ws, token);
    expect(r.status).toBe(200);
    const content = await app.request(`/workspaces/${ws}/documents/${r.json.document_id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await content.text();
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('reseller');
  });

  it('no source rule: ingest is unchanged even with no redactor and long text', async () => {
    const { app } = await loadApp();
    const { ws, token } = await setup(false);
    TestSynthStub.redactFields = undefined;
    const r = await ingest(ws, token, SOURCE + ' ' + 'y'.repeat(20_001));
    expect(r.status).toBe(200);
    expect(await docCount(ws)).toBe(1);
    const content = await app.request(`/workspaces/${ws}/documents/${r.json.document_id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await content.text()).toContain('reseller');
  });
});
