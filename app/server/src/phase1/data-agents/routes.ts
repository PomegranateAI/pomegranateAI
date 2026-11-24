import type { Hono, MiddlewareHandler } from 'hono';
import type { AppVars } from '../api/routes.js';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ReaderConfig, MAX_MEDIA_BYTES } from './media-types.js';
import { MediaService, MediaError } from './media-service.js';
import { RedactionUnavailableError } from '../ingest/redaction-error.js';

export function registerMediaRoutes(
  app: Hono<{ Variables: AppVars }>,
  media: MediaService,
  authn: MiddlewareHandler<{ Variables: AppVars }>,
  gate: MiddlewareHandler<{ Variables: AppVars }>,
  canManage: (c: any, ws: string) => Promise<boolean>,
) {
  const repo = media.repo;
  const descriptor = async (asset: Awaited<ReturnType<MediaService['authorized']>>) => ({
    id: asset.id,
    name: asset.original_name,
    mime: asset.mime,
    bytes: asset.bytes,
    visibility: asset.visibility,
    href: `/workspaces/${encodeURIComponent(asset.workspace_id)}/assets/${encodeURIComponent(asset.id)}/content`,
    has_text: !!(await media.runText(asset.workspace_id, asset.id)),
  });
  app.use(
    '/workspaces/:ws/ingest/file',
    bodyLimit({ maxSize: MAX_MEDIA_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'file_too_large' }, 413) }),
  );
  app.get('/workspaces/:ws/graph/:id/assets', authn, gate, async (c) =>
    c.json({
      assets: await Promise.all((await media
        .nodeAssets(c.get('workspace_id'), c.req.param('id'), c.get('user_id')))
        .map(async (a) => ({ ...(await descriptor(a)), can_share: a.owner_user_id === c.get('user_id') }))),
    }),
  );
  app.get('/workspaces/:ws/documents/:id/assets', authn, gate, async (c) => {
    const ws = c.get('workspace_id');
    const user = c.get('user_id');
    if (!await repo.getDocument(ws, c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
    const assets = await media.documentAssets(ws, c.req.param('id'), user);
    return c.json({ assets: await Promise.all(assets.map(async (a) => ({ ...(await descriptor(a)), can_share: a.owner_user_id === user }))) });
  });
  app.get('/workspaces/:ws/assets/:id/text', authn, gate, async (c) => {
    try {
      const asset = await media.authorized(c.get('workspace_id'), c.req.param('id'), c.get('user_id'));
      const reading = await media.runText(asset.workspace_id, asset.id);
      if (!reading) return c.json({ error: 'no_text' }, 404);
      return c.json({ asset_id: asset.id, name: asset.original_name, ...reading }, 200, { 'cache-control': 'private, no-store' });
    } catch (error) {
      return c.json({ error: error instanceof MediaError ? error.code : 'asset_unavailable' }, error instanceof MediaError ? error.status : 503);
    }
  });
  app.get('/workspaces/:ws/assets/:id/content', authn, gate, async (c) => {
    return serveMediaContent(c, media, c.get('workspace_id'), c.req.param('id'), c.get('user_id'));
  });
  app.patch('/workspaces/:ws/assets/:id', authn, gate, async (c) => {
    const ws = c.get('workspace_id'),
      user = c.get('user_id');
    const asset = await media.get(ws, c.req.param('id'));
    if (!asset || asset.owner_user_id !== user) return c.json({ error: 'not_found' }, 404);
    const parsed = z
      .object({ visibility: z.enum(['private', 'team']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    await repo.setMediaAssetVisibility(parsed.data.visibility, ws, asset.id);
    await repo.logAudit(ws, {
      actor: user,
      event: 'asset.visibility_changed',
      resource_type: 'asset',
      resource_id: asset.id,
      payload: parsed.data,
    });
    return c.json({ ok: true });
  });
  // "surface" targets are resolved to the authenticated user's own connection.
  const targetFor = (c: any) =>
    c.req.param('target') === 'whatsapp' ? `whatsapp:${c.get('user_id')}` : `subgraph:${c.req.param('target')}`;
  app.get('/workspaces/:ws/media-readers/:target', authn, gate, async (c) => {
    const ws = c.get('workspace_id'),
      target = targetFor(c);
    const bindings = await repo.listMediaBindings(ws, target) as Array<{ capability: string; config: string; enabled: number; version: number }>;
    return c.json({
      bindings: bindings.map((b) => ({ ...b, config: JSON.parse(b.config) })),
      can_manage: target.startsWith('whatsapp:') || (await canManage(c, ws)),
    });
  });
  app.get('/workspaces/:ws/media-jobs', authn, gate, async (c) => {
    const rows = await repo.listMediaIngestJobsForUser(c.get('workspace_id'), c.get('user_id')) as Array<{
      id: string;
      status: string;
      error: string | null;
      asset_id: string;
      payload: string;
      name: string;
    }>;
    return c.json({
      jobs: rows.map(({ payload, ...job }) => ({ ...job, subgraph_id: JSON.parse(payload).subgraph_id })),
    });
  });
  app.post('/workspaces/:ws/media-jobs/:id/retry', authn, gate, async (c) => {
    try {
      return c.json(await media.runIngest(c.get('workspace_id'), c.req.param('id'), c.get('user_id')));
    } catch (error) {
      if (error instanceof RedactionUnavailableError) return c.json(error.body(), 422);
      return c.json(
        { error: error instanceof MediaError ? error.code : 'media_processing_failed' },
        error instanceof MediaError ? error.status : 503,
      );
    }
  });
  app.put('/workspaces/:ws/media-readers/:target/:capability', authn, gate, async (c) => {
    const ws = c.get('workspace_id'),
      target = targetFor(c),
      capability = c.req.param('capability');
    if (!['audio', 'image'].includes(capability)) return c.json({ error: 'invalid_capability' }, 400);
    if (!target.startsWith('whatsapp:')) {
      if (!(await canManage(c, ws))) return c.json({ error: 'forbidden' }, 403);
      if ((await repo.getSubgraph(ws, c.req.param('target')))?.status !== 'active')
        return c.json({ error: 'invalid_subgraph' }, 400);
    }
    const parsed = z
      .object({ enabled: z.boolean(), config: ReaderConfig })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    await repo.upsertMediaBinding(ws, target, capability, JSON.stringify(parsed.data.config), Number(parsed.data.enabled), new Date().toISOString());
    await repo.logAudit(ws, {
      actor: c.get('user_id'),
      event: 'media_reader.configured',
      resource_type: 'data_agent',
      resource_id: target,
      payload: { capability, enabled: parsed.data.enabled },
    });
    return c.json({ ok: true });
  });
}

/** Shared byte response for session and MCP authenticated downloads. */
export async function serveMediaContent(c: any, media: MediaService, ws: string, id: string, user: string) {
    try {
      const asset = await media.authorized(ws, id, user);
      const bytes = await media.read(asset);
      const headers: Record<string, string> = {
        'content-type': asset.mime,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(asset.original_name)}`,
      };
      const range = c.req.header('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return c.body(null, 416, { 'content-range': `bytes */${bytes.length}` });
        const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length)
          return c.body(null, 416, { 'content-range': `bytes */${bytes.length}` });
        return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          'content-length': String(end - start + 1),
        });
      }
      return c.body(new Uint8Array(bytes), 200, { ...headers, 'content-length': String(bytes.length) });
    } catch (error) {
      return c.json(
        { error: error instanceof MediaError ? error.code : 'asset_unavailable' },
        error instanceof MediaError ? error.status : 503,
      );
    }
}
