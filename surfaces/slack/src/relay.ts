/**
 * Relay pipeline (SLACK_AGENT_MODE=relay): the surface forwards each mention
 * or DM to the server's surface agent — an LLM over the same MCP tool catalog
 * every other surface uses — and renders the reply. No verb grammar: people
 * write plain language ("what's the timeline for feature x?", "ingest this",
 * "accept the roadmap source from FolderB").
 *
 * What stays surface-side, deterministically:
 *  - dedup on the event id (Slack retries),
 *  - the `listen` / `stop listening` / `listening` channel-subscription verbs
 *    (the interval scheduler needs Slack channel-history APIs the server
 *    doesn't have),
 *  - file download + text extraction (Slack-authenticated URLs),
 *  - the placeholder → chat.update reply pattern.
 */
import type { MentionContext, Payload, Reply } from './types.js';
import { VERB_HANDLERS } from './command.js';
import { SubscriptionStore } from './subscriptions.js';
import { SurfaceAgentClient } from './surface-client.js';
import { resolvePayload } from './payload.js';
import { SurfaceError, UpstreamError } from './errors.js';
import { logEvent } from './log.js';

export interface RelayDeps {
  surface: SurfaceAgentClient;
  /** team id → Pomegranate API base URL (from mapping.json `teams`). */
  apiBaseUrlFor: (teamId: string) => string;
  botUserId?: string;
  subscriptions?: SubscriptionStore;
}

/** The listen verbs stay a tiny deterministic grammar (surface-owned state). */
export type ListenVerb = 'listen' | 'stoplisten' | 'listening';
export function matchListenVerb(text: string, botUserId?: string): { verb: ListenVerb; remainder: string } | null {
  let working = text;
  if (botUserId) {
    working = working.replace(new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`, 'g'), ' ');
  }
  working = working.replace(/@?\bpomegranate\b/gi, ' ');
  const stop = /\b(?:stop|quit)\s+listening\b|\bunlisten\b/i.exec(working);
  if (stop) return { verb: 'stoplisten', remainder: '' };
  // Order matters: "listening" contains "listen".
  const status = /\blistening\b/i.exec(working);
  if (status) return { verb: 'listening', remainder: '' };
  const listen = /\blisten\b/i.exec(working);
  if (listen) return { verb: 'listen', remainder: working.slice(listen.index + listen[0].length).trim() };
  return null;
}

export function createRelayMentionHandler(deps: RelayDeps): (ctx: MentionContext) => Promise<void> {
  const seenEventIds = new Set<string>();

  return async (ctx: MentionContext): Promise<void> => {
    const t0 = Date.now();
    if (seenEventIds.has(ctx.eventId)) {
      logEvent('info', 'relay_mention', { team_id: ctx.teamId, requester: ctx.requesterUserId, outcome: 'duplicate' });
      return;
    }
    seenEventIds.add(ctx.eventId);

    let outcome = 'error';
    let errName: string | undefined;
    let kind = 'agent';
    try {
      // 1. Listen verbs short-circuit to the local subscription store.
      const listen = matchListenVerb(ctx.text, deps.botUserId);
      if (listen) {
        kind = listen.verb;
        const payload: Payload = { kind: 'text', text: listen.remainder };
        const reply: Reply = await VERB_HANDLERS[listen.verb]({
          // The listen handlers use none of the canon/client fields — they
          // operate purely on the local subscription store.
          canon: undefined as never,
          req: undefined as never,
          client: undefined as never,
          subjectLabel: `<@${ctx.requesterUserId}>`,
          payload,
          teamId: ctx.teamId,
          channelId: ctx.channelId,
          requesterUserId: ctx.requesterUserId,
          subscriptions: deps.subscriptions,
        });
        await ctx.reply(reply.text, reply.blocks);
        outcome = 'ok';
        return;
      }

      // 2. Everything else goes to the agent. Ack + placeholder first.
      try {
        await ctx.react(':eyes:');
      } catch (e) {
        logEvent('warn', 'reaction_failed', { team_id: ctx.teamId, reason: (e as Error).message });
      }

      // Strip the bot's own mention from what the agent reads.
      let text = ctx.text;
      if (deps.botUserId) {
        text = text.replace(new RegExp(`<@${deps.botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^>]*)?>`, 'g'), ' ').trim();
      }

      // Attached files: fetch text surface-side (Slack-authed URLs). The
      // same .txt/.md constraint as before; resolvePayload throws the same
      // friendly errors on unsupported/empty input.
      const files: Array<{ name: string; text: string }> = [];
      if (ctx.files.length > 0) {
        const payload = await resolvePayload(ctx, text);
        if (payload.kind === 'file') files.push({ name: payload.name, text: payload.text });
      }
      if (!text && files.length === 0) {
        await ctx.reply('Tell me what you need — ask about your folders, or attach a `.txt`/`.md` file to feed it.');
        outcome = 'empty';
        return;
      }

      try {
        const result = await deps.surface.sendMessage(deps.apiBaseUrlFor(ctx.teamId), {
          team_id: ctx.teamId,
          slack_user_id: ctx.requesterUserId,
          channel_id: ctx.channelId,
          thread_key: ctx.threadKey,
          text: text || '(see attached file)',
          ...(files.length > 0 ? { files } : {}),
        });
        await ctx.reply(
          result.reply ?? 'Something went wrong — try again.',
          undefined,
          result.assistant_nickname ?? undefined,
        );
        outcome = result.unmapped ? 'unmapped' : result.needs_default ? 'needs_default' : 'ok';
      } catch (err) {
        const msg =
          err instanceof UpstreamError ? err.userMessage : 'Something went wrong — try again.';
        await ctx.reply(msg).catch(() => {});
        throw err;
      }
    } catch (err) {
      if (err instanceof SurfaceError) {
        errName = err.name;
        outcome = err instanceof UpstreamError ? 'upstream_error' : 'mapped_error';
        // Payload errors (unsupported file, empty) carry their own user text.
        if (!(err instanceof UpstreamError)) await ctx.reply(err.userMessage).catch(() => {});
      } else {
        errName = (err as Error)?.name ?? 'Error';
        console.error('[slack-surface] relay error:', err);
        await ctx.reply('Something went wrong — try again.').catch(() => {});
      }
    } finally {
      logEvent('info', 'relay_mention', {
        team_id: ctx.teamId,
        requester: ctx.requesterUserId,
        kind,
        outcome,
        err: errName,
        ms: Date.now() - t0,
      });
    }
  };
}
