// Routes: surface-agent.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { validateMedia } from '../../data-agents/validate-media.js';
import { bodyLimit } from 'hono/body-limit';
import { MediaError } from '../../data-agents/media-service.js';
import { mediaMime, ReaderConfig } from '../../data-agents/media-types.js';
import { withMediaProvenance } from '../../data-agents/context.js';
import { z } from 'zod';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import { ToolError } from '../../mcp/errors.js';
import {
  runSurfaceAgent,
  executeRegistryTool,
  SURFACE_AGENT_PROMPT,
  SURFACE_AGENT_PROMPT_VERSION,
} from '../../agent/surface-agent.js';
import { TokenBucketLimiter } from '../rate-limit.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';

export function registerSurfaceAgent(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  surfaceDenied,
  repo,
  surfaceFolderFor,
  media,
  UNMAPPED_REPLY,
  NO_DEFAULT_REPLY,
  surfaceTools,
  clientIp,
} = core;
// Throttle per (team, slack user): each agent turn costs an LLM call.
const surfaceLimiter = new TokenBucketLimiter({ capacity: 10, refillIntervalMs: 5_000 });

// WhatsApp has no Slack-style "team" concept — one bot phone number serves
// the whole org (identities aren't team-scoped either, see
// findUserByWhatsappIdentity). agent_threads.team_id is NOT NULL, so this
// constant fills that slot for every WhatsApp thread/message row.
const WHATSAPP_TEAM_ID = 'whatsapp';

const SlackMsgBody = z.object({
  surface: z.literal('slack'),
  team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  channel_id: z.string().optional(),
  /** Stable thread identity: `channel:thread_ts` (or channel for DMs). */
  thread_key: z.string().min(1),
  text: z.string().min(1),
  files: z.array(z.object({ name: z.string(), text: z.string() })).max(5).optional(),
});
const WhatsappMsgBody = z.object({
  surface: z.literal('whatsapp'),
  /** Sender's phone number (any format — normalized on lookup). */
  phone: z.string().min(3),
  /** One continuous thread per contact: the normalized phone number. */
  thread_key: z.string().min(1),
  text: z.string().min(1),
  message_id: z.string().max(256).optional(),
  asset_ids: z.array(z.string()).max(5).optional(),
  files: z.array(z.object({ name: z.string(), text: z.string() })).max(5).optional(),
});
const SurfaceMsgBody = z.discriminatedUnion('surface', [SlackMsgBody, WhatsappMsgBody]);
const UNMAPPED_REPLY_WHATSAPP =
  "I don't know who you are on Pomegranate yet. Open the web app → Setup → Your profile and link this WhatsApp number, then try again.";
const NO_DEFAULT_REPLY_WHATSAPP =
  'You belong to several directories and none is set as your WhatsApp default. Open Pomegranate → Setup in the directory you want and press "Make default" for WhatsApp.';

app.use(
  '/agent/surface/media',
  bodyLimit({ maxSize: 25 * 1024 * 1024 + 64 * 1024, onError: (c) => c.json({ error: 'file_too_large' }, 413) }),
);
app.post('/agent/surface/media', async (c) => {
  const denied = await surfaceDenied(c);
  if (denied) return denied;
  const form = await c.req.parseBody();
  const phone = typeof form.phone === 'string' ? form.phone : '';
  const user = await repo.findUserByWhatsappIdentity(phone);
  if (!user) return c.json({ reply: UNMAPPED_REPLY_WHATSAPP, unmapped: true });
  const ws = await surfaceFolderFor(user.id, 'whatsapp');
  if (!ws) return c.json({ reply: NO_DEFAULT_REPLY_WHATSAPP, needs_default: true });
  if (!(await repo.listMembershipsWithWorkspace(user.id)).some((m) => m.id === ws))
    return c.json({ error: 'forbidden' }, 403);
  if (!surfaceLimiter.take(`media:${user.id}`)) return c.json({ error: 'rate_limited' }, 429);
  const file = form.file;
  if (!(file instanceof File) || file.size > 25 * 1024 * 1024) return c.json({ error: 'invalid_file' }, 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  const mime = mediaMime(bytes);
  if (!mime) return c.json({ error: 'unsupported_media' }, 415);
  const capability = mime.startsWith('image/') ? 'image' : 'audio';
  const target = `whatsapp:${user.id}`;
  const saved = await repo.getMediaBindingEnabled(ws, target, capability);
  if (saved && !saved.enabled) return c.json({ error: 'media_reader_disabled' }, 422);
  const config = await media.binding(ws, target, capability) ?? ReaderConfig.parse({});
  try {
    await validateMedia(bytes, mime);
    const asset = await media.upload(ws, user.id, file.name, mime, bytes);
    const processed = await withLlmContext({ workspace_id: ws, user_id: user.id, caller: 'api.surface_media' }, () =>
      media.process(asset, config),
    );
    return c.json({ asset_id: asset.id, text: processed.result.text, run_id: processed.run_id });
  } catch (error) {
    return c.json(
      { error: error instanceof MediaError ? error.code : 'media_processing_failed' },
      error instanceof MediaError ? error.status : 503,
    );
  }
});

app.post('/agent/surface/messages', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  const denied = await surfaceDenied(c);
  if (denied) return denied;
  const parsed = SurfaceMsgBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { surface, thread_key } = parsed.data;
  const team_id = surface === 'slack' ? parsed.data.team_id : WHATSAPP_TEAM_ID;
  const limiterKey =
    surface === 'slack' ? `${team_id}:${parsed.data.slack_user_id}` : `whatsapp:${parsed.data.phone}`;
  if (!surfaceLimiter.take(limiterKey)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const user =
    surface === 'slack'
      ? await repo.findUserBySlackIdentity(team_id, parsed.data.slack_user_id)
      : await repo.findUserByWhatsappIdentity(parsed.data.phone);
  if (!user) {
    return c.json({ reply: surface === 'slack' ? UNMAPPED_REPLY : UNMAPPED_REPLY_WHATSAPP, unmapped: true });
  }
  const assistantNickname = user.assistant_nickname ?? null;
  const wsId = await surfaceFolderFor(user.id, surface);
  if (!wsId) {
    return c.json({
      reply: surface === 'slack' ? NO_DEFAULT_REPLY : NO_DEFAULT_REPLY_WHATSAPP,
      needs_default: true,
    });
  }

  if (!(await repo.listMembershipsWithWorkspace(user.id)).some((m) => m.id === wsId))
    return c.json({ error: 'forbidden' }, 403);
  const sources =
    surface === 'whatsapp' ? (parsed.data.asset_ids ?? []).map((id) => ({ workspace_id: wsId, asset_id: id })) : [];
  try {
    for (const source of sources) await media.authorized(wsId, source.asset_id, user.id);
  } catch {
    return c.json({ error: 'asset_not_found' }, 404);
  }

  const deliveryId = surface === 'whatsapp' ? parsed.data.message_id : undefined;
  if (deliveryId) {
    const previous = await repo.getMediaSurfaceDelivery(wsId, user.id, deliveryId);
    if (previous?.response) return c.json(JSON.parse(previous.response));
    if (previous && previous.lease_until > Date.now()) return c.json({ error: 'message_processing' }, 409);
    await repo.leaseMediaSurfaceDelivery(wsId, user.id, deliveryId, Date.now() + 15 * 60_000, new Date().toISOString());
  }

  // Attached file text rides along as clearly-delimited blocks.
  let text = parsed.data.text;
  for (const f of parsed.data.files ?? []) {
    text += `\n\n[attached file: ${f.name}]\n${f.text}`;
  }

  const thread = await repo.getAgentThread(surface, team_id, thread_key);
  const history = await repo.listAgentMessages(surface, team_id, thread_key, 30);
  await repo.appendAgentMessage({ surface, team_id, thread_key, role: 'user', body: text, workspace_id: wsId });

  try {
    const result = await withMediaProvenance(sources,()=>withLlmContext(
      { workspace_id: wsId, user_id: user.id, caller: 'api.surface_agent' },
      async () =>
        runSurfaceAgent({
          tools: surfaceTools,
          ctx: {
            ws: wsId,
            home_ws: wsId,
            user_id: user.id,
            source_ip: clientIp(c),
            user_agent: `surface:${surface}`,
          },
          history,
          user_message: text,
          pending_action: thread?.pending_action ?? null,
          folder_name: (await repo.getWorkspace(wsId))?.name,
          user_label: user.display_name ?? user.email,
          assistant_nickname: assistantNickname ?? undefined,
          subfolders: (await repo
            .listSubgraphs(wsId, { activeOnly: true }))
            .map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
          systemPrompt: SURFACE_AGENT_PROMPT,
          promptTask: 'surface-agent',
          promptVersion: SURFACE_AGENT_PROMPT_VERSION,
        }),
    ));
    // A held ingest is a server-owned conversation state, not merely advice
    // for the model. Persist its id for the next turn and force the router's
    // question into the response on every surface. This keeps Slack and
    // WhatsApp identical even when a model fails to verbalize the tool result.
    const heldReceipt = result.receipts.find(
      (r) => r.ok && r.tool === 'ingest_document' && r.result.pending_approval && r.result.pending_route_id,
    );
    const heldRoute = heldReceipt?.result.pending_route as { ask_user?: string } | undefined;
    const pendingRouteId = heldReceipt?.result.pending_route_id as string | undefined;
    const newPendingAction = pendingRouteId
      ? {
          tool: 'resolve_pending_route',
          args: { id: pendingRouteId },
          summary:
            heldRoute?.ask_user ??
            'I could not determine where this belongs. Should I use the proposed destination, choose another folder, or reject it?',
          created_at: new Date().toISOString(),
        }
      : null;
    const resolvedPrevious = result.receipts.some(
      (r) => r.ok && ['approve_route', 'choose_route', 'reject_route'].includes(r.tool),
    );
    // Keep an older hold armed if the model merely chatted instead of acting;
    // otherwise one bad turn would strand the pending document again.
    const pendingAction = newPendingAction ?? (resolvedPrevious ? null : thread?.pending_action ?? null);
    const reply = newPendingAction ? newPendingAction.summary! : result.message;
    await repo.appendAgentMessage({
      surface,
      team_id,
      thread_key,
      role: 'agent',
      body: reply,
      receipts: result.receipts,
      workspace_id: wsId,
    });
    await repo.upsertAgentThread({
      surface,
      team_id,
      thread_key,
      user_id: user.id,
      workspace_id: wsId,
      pending_action: pendingAction,
    });
    await repo.logCustomerAudit(wsId, {
      event: 'surface_agent_used',
      actor_user_id: user.id,
      actor_email: user.email,
      source_ip: clientIp(c),
      user_agent: `surface:${surface}`,
      resource_type: 'agent_thread',
      resource_id: thread_key,
      payload: {
        receipts: result.receipts.length,
      },
    });
    const response = {
      reply,
      assistant_nickname: assistantNickname,
      receipts: result.receipts,
      folder: { id: wsId, name: (await repo.getWorkspace(wsId))?.name ?? wsId },
      // Where this turn's ingests actually landed (from the tool results), so
      // a surface can show the real destination rather than the one asked for.
      filed_to: result.receipts.flatMap((r) =>
        r.ok && Array.isArray((r.result as { filed_to?: unknown })?.filed_to)
          ? ((r.result as { filed_to: Array<{ id: string; name: string }> }).filed_to)
          : [],
      ),
    };
    if (deliveryId) await repo.completeMediaSurfaceDelivery(wsId, user.id, deliveryId, JSON.stringify(response));
    return c.json(response);
  } catch (err) {
    if (deliveryId) await repo.releaseMediaSurfaceDelivery(wsId, user.id, deliveryId);
    if (err instanceof ToolError && err.code === 'not_supported') {
      return c.json(
        { reply: 'The assistant needs the cloud AI provider, which is not configured here.', error: 'not_supported' },
        501,
      );
    }
    log.error('surface.agent_failed', {
      workspace: wsId,
      user: user.id,
      msg: (err as Error).message?.slice(0, 300),
    });
    return c.json({ error: 'agent_failed' }, 503);
  }
});

// Deterministic single-tool execution for the surface's own UI affordances
// (approve/reject buttons, the listen scheduler's ingest). The click/schedule
// IS the confirmation, so there is no interceptor — but only a narrow
// whitelist is reachable this way.
const SURFACE_ACTION_TOOLS = new Set([
  'ingest_document',
  'approve_route',
  'reject_route',
]);

const SlackActionBody = z.object({
  surface: z.literal('slack'),
  team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});
const WhatsappActionBody = z.object({
  surface: z.literal('whatsapp'),
  phone: z.string().min(3),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});
const SurfaceActionBody = z.discriminatedUnion('surface', [SlackActionBody, WhatsappActionBody]);

app.post('/agent/surface/actions', async (c) => {
  if (!process.env.SURFACE_AGENT_SECRET) return c.json({ error: 'surface agent not configured' }, 501);
  const denied = await surfaceDenied(c);
  if (denied) return denied;
  const parsed = SurfaceActionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { surface, tool, args } = parsed.data;
  if (!SURFACE_ACTION_TOOLS.has(tool)) return c.json({ error: 'tool not allowed' }, 400);

  const user =
    surface === 'slack'
      ? await repo.findUserBySlackIdentity(parsed.data.team_id, parsed.data.slack_user_id)
      : await repo.findUserByWhatsappIdentity(parsed.data.phone);
  if (!user) {
    return c.json({ error: 'unmapped', reply: surface === 'slack' ? UNMAPPED_REPLY : UNMAPPED_REPLY_WHATSAPP }, 404);
  }
  const wsId = await surfaceFolderFor(user.id, surface);
  if (!wsId) {
    return c.json(
      { error: 'no_default_folder', reply: surface === 'slack' ? NO_DEFAULT_REPLY : NO_DEFAULT_REPLY_WHATSAPP },
      409,
    );
  }

  const { outcome, ok } = await withLlmContext(
    { workspace_id: wsId, user_id: user.id, caller: 'api.surface_action' },
    () =>
      executeRegistryTool(surfaceTools, tool, args, {
        ws: wsId,
        home_ws: wsId,
        user_id: user.id,
        source_ip: clientIp(c),
        user_agent: `surface:${surface}`,
      }),
  );
  await repo.logCustomerAudit(wsId, {
    event: 'surface_agent_used',
    actor_user_id: user.id,
    actor_email: user.email,
    source_ip: clientIp(c),
    user_agent: `surface:${surface}`,
    resource_type: 'surface_action',
    payload: { tool, ok },
  });
  return c.json({ ok, result: outcome });
});
}
