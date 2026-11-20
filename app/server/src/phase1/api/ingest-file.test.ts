import { describe, it, expect, beforeAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/synthesis.js')>('../../lib/synthesis.js');
  const stub = await import('../../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../ingest/__fixtures__');

let filesDir: string;
beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-ingf-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  filesDir = path.join(tmp, 'files');
  process.env.POMEGRANATE_FILES_DIR = filesDir;
});

async function loadApp() {
  return import('./server.js?ingf=' + Date.now());
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

async function uploadFile(
  app: any,
  url: string,
  opts: { token: string; filename: string; bytes: Buffer; mime?: string },
) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([opts.bytes], { type: opts.mime ?? 'application/octet-stream' }),
    opts.filename,
  );
  const r = await app.request(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function setupWs(app: any, token: string) {
  const ws = await (
    await app.request('/workspaces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'IngF', profile_id: 'notes' }),
    })
  ).json();
  // The stub synthesis provider's capture heuristics target decision/goal/
  // positioning kinds (killed-messaging, north-star goals, banned phrases) —
  // install the rich founding fixture profile so those kinds validate at
  // the ingest kind-gate instead of being dropped as foreign to `notes`.
  await app.request(`/workspaces/${ws.id}/profile`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ profile: foundingProfile }),
  });
  return ws as any;
}

describe('POST /workspaces/:ws/ingest/file', () => {
  it('accepts a .txt and runs the capture pipeline', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@if.example');
    const ws = await setupWs(app, token);
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'memo.txt',
      bytes: Buffer.from('Killing the v1 mobile app. Our north star is mid-market ARR.'),
      mime: 'text/plain',
    });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('doc');
    expect(r.json.ext).toBe('.txt');
    expect(r.json.text_chars).toBeGreaterThan(0);
    // Heuristic provider hits on "killing"
    expect(r.json.candidates).toBeGreaterThanOrEqual(1);

    // The audit trail names the upload by its file name and lists its notes.
    const audit = await (
      await app.request(`/workspaces/${ws.id}/customer-audit?limit=100`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    const ingested = audit.entries.find((e: any) => e.event === 'source_ingested');
    const ing = JSON.parse(ingested.payload);
    expect(ing).toMatchObject({ source_name: 'memo.txt', source_id: r.json.source_id });
    expect(ing.node_ids).toHaveLength(ing.nodes_created);
    expect(ing.nodes_created).toBeGreaterThanOrEqual(1);
  });

  it('accepts a .vtt as transcript kind', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader2@if.example');
    const ws = await setupWs(app, token);
    const vtt = Buffer.from(
      `WEBVTT

00:00:01.000 --> 00:00:05.000
<v CRO>We're killing the v1 mobile app next week.</v>
`,
    );
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'meeting.vtt',
      bytes: vtt,
      mime: 'text/vtt',
    });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('transcript');
    expect(r.json.candidates).toBeGreaterThanOrEqual(1);
  });

  it('accepts a .docx fixture', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader3@if.example');
    const ws = await setupWs(app, token);
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.docx'));
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'strategy.docx',
      bytes: buf,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(r.status).toBe(200);
    expect(r.json.ext).toBe('.docx');
    expect(r.json.candidates).toBeGreaterThanOrEqual(1);
  });

  it('accepts .pptx/.xlsx and legacy .doc/.ppt/.xls fixtures', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader3b@if.example');
    const ws = await setupWs(app, token);
    for (const [filename, mime] of [
      ['roadmap-review.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['roadmap.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['memo.doc', 'application/msword'],
      ['roadmap-review.ppt', 'application/vnd.ms-powerpoint'],
      ['roadmap.xls', 'application/vnd.ms-excel'],
    ]) {
      const buf = await fs.readFile(path.join(FIXTURES, `sample${filename.slice(filename.lastIndexOf('.'))}`));
      const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, { token, filename, bytes: buf, mime });
      expect(r.status, filename).toBe(200);
      expect(r.json.ext).toBe(filename.slice(filename.lastIndexOf('.')));
      expect(r.json.kind).toBe('doc');
    }
  });

  it('rejects a corrupt .xlsx with extraction_failed', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader3c@if.example');
    const ws = await setupWs(app, token);
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'broken.xlsx',
      bytes: Buffer.from('not a zip'),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('extraction_failed');
  });

  it('accepts a .pdf fixture', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader4@if.example');
    const ws = await setupWs(app, token);
    const buf = await fs.readFile(path.join(FIXTURES, 'sample.pdf'));
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'memo.pdf',
      bytes: buf,
      mime: 'application/pdf',
    });
    expect(r.status).toBe(200);
    expect(r.json.ext).toBe('.pdf');
    expect(r.json.candidates).toBeGreaterThanOrEqual(1);
  });

  it('accepts an .html file, converting to markdown and stripping non-prose', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leaderhtml@if.example');
    const ws = await setupWs(app, token);
    const html = Buffer.from(
      `<!doctype html><html><head><title>Roadmap</title><style>b{color:red}</style></head>
       <body>
         <script>track()</script>
         <h1>Roadmap decision</h1>
         <p>We're <strong>killing the v1 mobile app</strong>; north star is mid-market ARR.</p>
         <img src="chart.png" alt="chart"><svg><path d="M0 0"/></svg>
       </body></html>`,
    );
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'memo.html',
      bytes: html,
      mime: 'text/html',
    });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('doc');
    expect(r.json.ext).toBe('.html');
    expect(r.json.candidates).toBeGreaterThanOrEqual(1);
  });

  it('rejects unsupported extensions with 415', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader5@if.example');
    const ws = await setupWs(app, token);
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'archive.zip',
      bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      mime: 'application/zip',
    });
    expect(r.status).toBe(415);
    expect(r.json.error).toBe('unsupported_extension');
  });

  // Regression: provider-supplied candidate ids (e.g. heuristic's `heur-c1`)
  // collide on the second upload to the same workspace. The API must mint
  // fresh persistence-layer ids.
  it('accepts two uploads to the same workspace without UNIQUE-constraint collision', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leaderx@if.example');
    const ws = await setupWs(app, token);
    for (const filename of ['memo-a.txt', 'memo-b.txt', 'memo-c.txt']) {
      const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
        token,
        filename,
        bytes: Buffer.from('Killing the v1 mobile app. north star.'),
        mime: 'text/plain',
      });
      expect(r.status, `upload ${filename}`).toBe(200);
      expect(r.json.candidates).toBeGreaterThanOrEqual(1);
    }
  });

  // Regression: the file route used to carry an inline copy of the ingest
  // pipeline that skipped redactSourceText — source-level redaction rules
  // silently did not apply to uploads. Now that it delegates to runTextIngest,
  // the stored document text must be scrubbed exactly like a text ingest.
  it('applies source-level redaction rules to the stored document text', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader-redact@if.example');
    const ws = await setupWs(app, token);
    // The stub classifies "…from transcripts" as a source rule and redacts
    // any >4-char word of the rule that appears in the text ("reseller").
    const ruleRes = await app.request(`/workspaces/${ws.id}/rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instructions: 'Remove reseller mentions from transcripts', scopes: ['team'] }),
    });
    expect(ruleRes.status).toBe(200);

    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'memo.txt',
      bytes: Buffer.from('Killing the reseller program. north star is mid-market ARR.'),
      mime: 'text/plain',
    });
    expect(r.status).toBe(200);

    const content = await app.request(`/workspaces/${ws.id}/documents/${r.json.document_id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await content.text();
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('reseller');
  });

  it('persists the source row and the file on disk; both wiped on workspace delete', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'leader6@if.example');
    const ws = await setupWs(app, token);
    const r = await uploadFile(app, `/workspaces/${ws.id}/ingest/file`, {
      token,
      filename: 'memo.txt',
      bytes: Buffer.from('Killing the v1 mobile app. mid-market north star.'),
      mime: 'text/plain',
    });
    expect(r.status).toBe(200);
    const sourceId = r.json.source_id;

    const sources = repo.db
      .prepare(`SELECT id, kind, original_name FROM sources WHERE workspace_id = ?`)
      .all(ws.id) as any[];
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(sourceId);

    const wsFilesDir = path.join(filesDir, ws.id);
    const entries = await fs.readdir(path.join(wsFilesDir, 'sources'));
    expect(entries.length).toBeGreaterThan(0);

    // Delete the workspace; the file dir is gone.
    await app.request(`/workspaces/${ws.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(fs.access(wsFilesDir)).rejects.toBeTruthy();
  });
});
