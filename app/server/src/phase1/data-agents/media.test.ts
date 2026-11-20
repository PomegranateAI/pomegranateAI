import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { buildApp } from '../api/routes.js';
import { TestSynthStub } from '../../__test_utils__/synth-stub.js';
import { MediaService } from './media-service.js';
import { ReaderConfig } from './media-types.js';
import { readMedia } from './read-media.js';
import { runSurfaceAgent } from '../agent/surface-agent.js';

vi.mock('../agent/surface-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/surface-agent.js')>()),
  runSurfaceAgent: vi.fn(async () => ({ message: 'ok', receipts: [], pending_action: null })),
}));

vi.mock('./read-media.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read-media.js')>()),
  readMedia: vi.fn(async () => ({ text: '#roadmap\nHello, team.\nKeep every word.', provider: 'stub', model: 'test' })),
}));

let root: string, repo: Repo, app: ReturnType<typeof buildApp>, ws: string, user: string, token: string;
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16000, 40);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pom-media-'));
  repo = new Repo(openDb(path.join(root, 'db.sqlite')));
  ws = (await repo.createWorkspace({ name: 'Media', owner_email: 'owner@media.test' })).id;
  user = (await repo.findOrCreateUser('owner@media.test')).id;
  token = await repo.createSession(user);
  app = buildApp({ repo, synth: TestSynthStub, filesDir: root });
  vi.mocked(readMedia).mockClear();
  vi.mocked(runSurfaceAgent).mockClear();
});
afterEach(async () => {
  repo.db.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function request(route: string, body?: unknown, method = 'GET', auth = token) {
  const response = await app.request(route, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function upload() {
  const body = new FormData();
  body.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
  body.append('subgraph_id', 'default');
  const response = await app.request(`/workspaces/${ws}/ingest/file`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe('shared media runtime', () => {
  it('converges concurrent uploads on one stored asset', async () => {
    const service = new MediaService(repo, root);
    const [first, second] = await Promise.all([
      service.upload(ws, user, 'voice.wav', 'audio/wav', wav),
      service.upload(ws, user, 'voice.wav', 'audio/wav', wav),
    ]);
    expect(first.id).toBe(second.id);
    expect(await service.read(first)).toEqual(wav);
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE workspace_id=?').get(ws)).toEqual({ n: 1 });
  });
  it('logs faithful text once and links original bytes to the node', async () => {
    const binding = await request(
      `/workspaces/${ws}/media-readers/default/audio`,
      { enabled: true, config: { output: 'log' } },
      'PUT',
    );
    expect(binding.status).toBe(200);
    const first = await upload();
    expect(first.status).toBe(200);
    const second = await upload();
    expect(second.status).toBe(200);
    expect(first.body.document_id).toBe(second.body.document_id);
    expect(readMedia).toHaveBeenCalledTimes(1);
    const nodes = await repo.listNodes(ws);
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as any).body).toBe('#roadmap\nHello, team.\nKeep every word.');
    const attachments = await request(`/workspaces/${ws}/graph/${nodes[0]!.id}/assets`);
    expect(attachments.body.assets[0].id).toBe(first.body.asset_id);
    const content = await app.request(`/workspaces/${ws}/assets/${first.body.asset_id}/content`, {
      headers: { authorization: `Bearer ${token}`, range: 'bytes=0-3' },
    });
    expect(content.status).toBe(206);
    expect(await content.text()).toBe('RIFF');
    const reading = await request(`/workspaces/${ws}/assets/${first.body.asset_id}/text`);
    expect(reading.status).toBe(200);
    expect(reading.body.text).toContain('Keep every word.');
    const documentAssets = await request(`/workspaces/${ws}/documents/${first.body.document_id}/assets`);
    expect(documentAssets.body.assets[0].has_text).toBe(true);
  });
  it('keeps a voice-note transcript when the filing agent submits only a summary', async () => {
    vi.stubEnv('SURFACE_AGENT_SECRET', 'test-secret');
    await repo.upsertUserIdentity({ user_id: user, kind: 'whatsapp', external_id: '21612345678' });
    const form = new FormData();
    form.append('phone', '21612345678');
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
    const read = await app.request('/agent/surface/media', {
      method: 'POST', headers: { 'x-surface-secret': 'test-secret' }, body: form,
    });
    expect(read.status).toBe(200);
    const original = await read.json() as any;
    vi.mocked(runSurfaceAgent).mockImplementationOnce(async (options) => {
      const tool = options.tools.find((t) => t.name === 'ingest_document')!;
      const args = { source: 'Meeting notes with Hadi Faysal', source_kind: 'transcript', source_ref: 'voice-note', subgraph: 'default', audience: 'private' };
      const result = await tool.handler(args, options.ctx) as Record<string, unknown>;
      return { message: 'Filed', receipts: [{ tool: 'ingest_document', args, result, ok: true }], pending_action: null };
    });
    const sent = await app.request('/agent/surface/messages', {
      method: 'POST',
      headers: { 'x-surface-secret': 'test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'whatsapp', phone: '21612345678', thread_key: '21612345678', text: original.text, asset_ids: [original.asset_id], message_id: 'paraphrase-1' }),
    });
    expect(sent.status).toBe(200);
    const link = repo.db.prepare('SELECT document_id, run_id FROM document_assets WHERE workspace_id=? AND asset_id=?')
      .get(ws, original.asset_id) as { document_id: string; run_id: string | null };
    expect(link.run_id).toBeTruthy();
    const stored = await app.request(`/workspaces/${ws}/documents/${link.document_id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await stored.text();
    expect(text).toContain('Keep every word.');
    expect(text).toContain('Meeting notes with Hadi Faysal');
  });
  it('keeps private readings private and returns 404 before an asset is processed', async () => {
    const service = new MediaService(repo, root);
    const asset = await service.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    expect((await request(`/workspaces/${ws}/assets/${asset.id}/text`)).status).toBe(404);
    await service.process(asset, ReaderConfig.parse({}));
    const other = await repo.findOrCreateUser('member@media.test');
    await repo.addMember({ workspace_id: ws, user_id: other.id, role: 'member' });
    const otherToken = await repo.createSession(other.id);
    expect((await request(`/workspaces/${ws}/assets/${asset.id}/text`, undefined, 'GET', otherToken)).status).toBe(404);
  });
  it('returns downloadable originals in every get_context mode and preserves media privacy', async () => {
    await request(`/workspaces/${ws}/media-readers/default/audio`, { enabled: true, config: { output: 'log' } }, 'PUT');
    const uploaded = await upload();
    expect(uploaded.status).toBe(200);
    const node = (await repo.listNodes(ws))[0]!;
    const mcpToken = (await repo.issueMcpToken({ workspace_id: ws, user_id: user })).token;
    for (const controls of [{}, { ids: [node.id] }, { mode: 'index' }]) {
      const context = await request('/mcp/tools/get_context', { scope: 'all', ...controls }, 'POST', mcpToken);
      expect(context.status).toBe(200);
      const attachment = context.body.nodes[0].assets[0];
      expect(attachment).toMatchObject({ id: uploaded.body.asset_id, name: 'voice.wav', mime: 'audio/wav', bytes: wav.length });
      expect(context.body.markdown).toContain(attachment.href);
      const content = await app.request(attachment.href, { headers: { authorization: `Bearer ${mcpToken}` } });
      expect(content.status).toBe(200);
      expect(Buffer.from(await content.arrayBuffer())).toEqual(wav);
      expect((await app.request(attachment.href)).status).toBe(401);
    }
    repo.db.prepare("UPDATE graph_nodes SET visibility='team' WHERE workspace_id=? AND id=?").run(ws, node.id);
    const member = await repo.findOrCreateUser('mcp-member@media.test');
    await repo.addMember({ workspace_id: ws, user_id: member.id, role: 'member' });
    const memberToken = (await repo.issueMcpToken({ workspace_id: ws, user_id: member.id })).token;
    const privateContext = await request('/mcp/tools/get_context', { scope: 'all' }, 'POST', memberToken);
    expect(privateContext.body.nodes[0].assets).toBeUndefined();
    expect(privateContext.body.markdown).not.toContain(uploaded.body.asset_id);
    const href = `/mcp/workspaces/${ws}/assets/${uploaded.body.asset_id}/content`;
    expect((await app.request(href, { headers: { authorization: `Bearer ${memberToken}` } })).status).toBe(404);
    await request(`/workspaces/${ws}/assets/${uploaded.body.asset_id}`, { visibility: 'team' }, 'PATCH');
    const sharedContext = await request('/mcp/tools/get_context', { scope: 'all' }, 'POST', memberToken);
    expect(sharedContext.body.nodes[0].assets[0].id).toBe(uploaded.body.asset_id);
    expect((await app.request(href, { headers: { authorization: `Bearer ${memberToken}` } })).status).toBe(200);
  });
  it('requires a reader and rejects a disguised file', async () => {
    expect((await upload()).body.error).toBe('media_reader_required');
    const body = new FormData();
    body.append('file', new Blob(['not audio']), 'voice.wav');
    const response = await app.request(`/workspaces/${ws}/ingest/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body,
    });
    expect(response.status).toBe(415);
    expect(readMedia).not.toHaveBeenCalled();
  });
  it('checks original permissions separately from workspace membership', async () => {
    const media = new MediaService(repo, root);
    const asset = await media.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    const other = await repo.findOrCreateUser('member@media.test');
    await repo.addMember({ workspace_id: ws, user_id: other.id, role: 'member' });
    const memberToken = await repo.createSession(other.id);
    expect((await request(`/workspaces/${ws}/assets/${asset.id}/content`, undefined, 'GET', memberToken)).status).toBe(
      404,
    );
    expect(
      (await request(`/workspaces/${ws}/assets/${asset.id}`, { visibility: 'team' }, 'PATCH', memberToken)).status,
    ).toBe(404);
    expect((await request(`/workspaces/${ws}/assets/${asset.id}`, { visibility: 'team' }, 'PATCH')).status).toBe(200);
    const response = await app.request(`/workspaces/${ws}/assets/${asset.id}/content`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(response.status).toBe(200);
    const ws2 = (await repo.createWorkspace({ name: 'Other', owner_email: 'member@media.test' })).id;
    expect((await request(`/workspaces/${ws2}/assets/${asset.id}/content`, undefined, 'GET', memberToken)).status).toBe(
      404,
    );
  });
  it('reuses a persisted extraction after rebuilding the service and retries a failed one', async () => {
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ text: 'ok', provider: 'stub', model: 'test' });
    const service = new MediaService(repo, root, reader);
    const asset = await service.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    await expect(service.process(asset, ReaderConfig.parse({}))).rejects.toThrow('temporary');
    await service.process(asset, ReaderConfig.parse({}));
    await new MediaService(repo, root, reader).process(asset, ReaderConfig.parse({}));
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it('excludes concurrent processing and prevents cross-workspace provenance', async () => {
    let resolve!: (value: any) => void;
    const reader = vi.fn(
      () =>
        new Promise<any>((r) => {
          resolve = r;
        }),
    );
    const service = new MediaService(repo, root, reader);
    const asset = await service.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    const first = service.process(asset, ReaderConfig.parse({}));
    await expect(service.process(asset, ReaderConfig.parse({}))).rejects.toThrow('media_processing');
    await vi.waitFor(() => expect(reader).toHaveBeenCalled());
    resolve({ text: 'ok', provider: 'stub', model: 'test' });
    await first;
    await expect(async () => await service.link(ws, 'doc', 1, [{ workspace_id: 'another', asset_id: asset.id }], user)).rejects.toThrow(
      'asset_workspace_mismatch',
    );
  });
  it('uses the same saved extraction for WhatsApp and a folder, and preserves provenance through filing', async () => {
    vi.stubEnv('SURFACE_AGENT_SECRET', 'test-secret');
    await repo.upsertUserIdentity({ user_id: user, kind: 'whatsapp', external_id: '21612345678' });
    const form = new FormData();
    form.append('phone', '21612345678');
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
    const mediaResponse = await app.request('/agent/surface/media', {
      method: 'POST',
      headers: { 'x-surface-secret': 'test-secret' },
      body: form,
    });
    expect(mediaResponse.status).toBe(200);
    const original = (await mediaResponse.json()) as any;
    await request(`/workspaces/${ws}/media-readers/default/audio`, { enabled: true, config: { output: 'log' } }, 'PUT');
    const filed = await upload();
    expect(filed.status).toBe(200);
    expect(filed.body.asset_id).toBe(original.asset_id);
    expect(readMedia).toHaveBeenCalledTimes(1);
    vi.mocked(runSurfaceAgent).mockImplementationOnce(async (options) => {
      const tool = options.tools.find((t) => t.name === 'ingest_document')!;
      const args = {
        source: original.text,
        source_kind: 'transcript',
        source_ref: 'voice-command',
        subgraph: 'default',
        audience: 'private',
      };
      const result = (await tool.handler(args, options.ctx)) as Record<string, unknown>;
      return {
        message: 'Filed',
        receipts: [{ tool: 'ingest_document', args, result, ok: true }],
        pending_action: null,
      };
    });
    const payload = {
      surface: 'whatsapp',
      phone: '21612345678',
      thread_key: '21612345678',
      text: original.text,
      asset_ids: [original.asset_id],
      message_id: 'message-1',
    };
    const send = () =>
      app.request('/agent/surface/messages', {
        method: 'POST',
        headers: { 'x-surface-secret': 'test-secret', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(runSurfaceAgent).toHaveBeenCalledTimes(1);
    const docs = repo.db
      .prepare('SELECT document_id FROM document_assets WHERE workspace_id=? AND asset_id=?')
      .all(ws, original.asset_id);
    expect(docs).toHaveLength(2);
  });
  it('resumes a failed ingest job without another provider call', async () => {
    const service = new MediaService(repo, root);
    const asset = await service.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    service.ingest = vi
      .fn()
      .mockRejectedValueOnce(new Error('capture unavailable'))
      .mockResolvedValue({ document_id: 'done' });
    const job = await service.createIngest(asset, {
      subgraph_id: 'default',
      audience: 'private',
      config: ReaderConfig.parse({ output: 'log' }),
    });
    await expect(service.runIngest(ws, job, user)).rejects.toThrow('capture unavailable');
    const jobs = await request(`/workspaces/${ws}/media-jobs`);
    expect(jobs.body.jobs[0].status).toBe('failed');
    await service.runIngest(ws, job, user);
    await service.runIngest(ws, job, user);
    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(service.ingest).toHaveBeenCalledTimes(2);
  });
  it('cleans expired unfiled originals but preserves document references', async () => {
    const service = new MediaService(repo, root);
    const discarded = await service.upload(ws, user, 'discarded.wav', 'audio/wav', wav);
    const kept = await service.upload(ws, user, 'kept.wav', 'audio/wav', wav);
    const doc = await repo.registerDocument(ws, { source_ref: 'kept.wav', source_kind: 'transcript', sha256: 'hash' });
    await service.link(ws, doc.id, doc.version, [{ workspace_id: ws, asset_id: kept.id }], user);
    repo.db.prepare("UPDATE media_assets SET created_at='2000-01-01' WHERE workspace_id=?").run(ws);
    await service.cleanupUnfiled();
    expect(await service.get(ws, discarded.id)).toBeUndefined();
    expect(await service.read((await service.get(ws, kept.id))!)).toEqual(wav);
  });
  it('does not let a revoked member resume a saved job', async () => {
    const service = new MediaService(repo, root);
    const asset = await service.upload(ws, user, 'voice.wav', 'audio/wav', wav);
    service.ingest = vi.fn().mockResolvedValue({ document_id: 'never' });
    const job = await service.createIngest(asset, {
      subgraph_id: 'default',
      audience: 'private',
      config: ReaderConfig.parse({}),
    });
    repo.db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(ws, user);
    await expect(service.runIngest(ws, job, user)).rejects.toThrow('destination_unavailable');
    expect(service.ingest).not.toHaveBeenCalled();
    expect(readMedia).not.toHaveBeenCalled();
  });
});
