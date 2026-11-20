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

let filesDir: string;
beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-doctxt-'));
  process.env.POMEGRANATE_DB_PATH = path.join(tmp, 'p.db');
  filesDir = path.join(tmp, 'files');
  process.env.POMEGRANATE_FILES_DIR = filesDir;
});

async function loadApp() {
  return import('./server.js?doctxt=' + Date.now());
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
async function setupWs(app: any, token: string, name = 'DocTxt') {
  const ws = (
    await app.request('/workspaces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  ).json();
  return ws as any;
}
async function ingestText(app: any, wsId: string, token: string, source: string, source_ref: string) {
  const r = await app.request(`/workspaces/${wsId}/ingest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source, source_kind: 'doc', source_ref }),
  });
  return { status: r.status, json: await r.json() };
}

describe('GET /workspaces/:ws/documents/:id/content', () => {
  it('round-trips a text ingest as a .txt attachment and marks it downloadable', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader@doctxt.example');
    const ws = await setupWs(app, token);
    const source = 'Killing the v1 mobile app. Our north star is mid-market ARR.';
    const ing = await ingestText(app, ws.id, token, source, 'roadmap-memo.md');
    expect(ing.status).toBe(200);
    const docId = ing.json.document_id;
    expect(docId).toBeTruthy();

    // Listed as downloadable
    const list = await app.request(`/workspaces/${ws.id}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { documents } = await list.json();
    const doc = documents.find((d: any) => d.id === docId);
    expect(doc.downloadable).toBe(true);

    // Content round-trips verbatim, served as a .txt attachment
    const r = await app.request(`/workspaces/${ws.id}/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="roadmap-memo.txt"');
    expect(await r.text()).toBe(source);
  });

  it('serves extracted text for a file upload', async () => {
    const { app } = await loadApp();
    const token = await magic(app, 'leader2@doctxt.example');
    const ws = await setupWs(app, token);
    const body = 'Killing the legacy onboarding flow. North star: activation rate.';
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(body)], { type: 'text/plain' }), 'onboarding memo.txt');
    const up = await app.request(`/workspaces/${ws.id}/ingest/file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const upJson = await up.json();
    expect(up.status).toBe(200);

    const r = await app.request(`/workspaces/${ws.id}/documents/${upJson.document_id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    // Filename: basename of the source ref, sanitized, extension → .txt
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="onboarding_memo.txt"');
    expect(await r.text()).toContain('Killing the legacy onboarding flow');
  });

  it('404s for an unknown document and for legacy documents without stored text', async () => {
    const { app, repo } = await loadApp();
    const token = await magic(app, 'leader3@doctxt.example');
    const ws = await setupWs(app, token);
    // Unknown id
    const missing = await app.request(`/workspaces/${ws.id}/documents/doc_nope/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);

    // Legacy text-channel document: registered before canonical-text
    // persistence — simulate by deleting the persisted .txt.
    const source = 'Killing the EU launch. North star unchanged.';
    const ing = await ingestText(app, ws.id, token, source, 'eu-launch.md');
    const docId = ing.json.document_id;
    const dv = repo.db
      .prepare(`SELECT version FROM documents WHERE workspace_id = ? AND id = ?`)
      .get(ws.id, docId) as { version: number };
    await fs.rm(path.join(filesDir, ws.id, 'docs', `${docId}-v${dv.version}.txt`));
    const r = await app.request(`/workspaces/${ws.id}/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('content_not_stored');

    // And the listing reports it as not downloadable
    const list = await app.request(`/workspaces/${ws.id}/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { documents } = await list.json();
    expect(documents.find((d: any) => d.id === docId).downloadable).toBe(false);
  });

  it('is workspace-gated: tenant A cannot download tenant B documents', async () => {
    const { app } = await loadApp();
    const tokA = await magic(app, 'tenant-a@doctxt.example');
    const tokB = await magic(app, 'tenant-b@doctxt.example');
    const wsA = await setupWs(app, tokA, 'A');
    const wsB = await setupWs(app, tokB, 'B');
    const ing = await ingestText(app, wsB.id, tokB, 'Killing the B-only secret plan.', 'secret.md');
    const docId = ing.json.document_id;
    // A attacks B's workspace path with A's session → gated
    const cross = await app.request(`/workspaces/${wsB.id}/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${tokA}` },
    });
    expect([401, 403, 404]).toContain(cross.status);
    // A's own workspace can't resolve B's document id
    const wrongWs = await app.request(`/workspaces/${wsA.id}/documents/${docId}/content`, {
      headers: { Authorization: `Bearer ${tokA}` },
    });
    expect(wrongWs.status).toBe(404);
  });
});
