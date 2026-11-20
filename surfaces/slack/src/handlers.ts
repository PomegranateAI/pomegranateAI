/**
 * The orchestration pipeline, DECOUPLED from Slack.
 *
 * `createMentionHandler` returns a handler that operates purely on a
 * {@link MentionContext}, so the Slack adapter (`@slack/bolt`) only has to build
 * that context and wire `react`/`reply`/`fetchFileText`. The pipeline itself
 * imports only from [shared] modules.
 */
import type { MentionContext, Config, PomegranateClient, Payload } from './types.js';
import { parseMention } from './parse.js';
import { resolveCanon, resolveRequester } from './resolve.js';
import { resolvePayload } from './payload.js';
import { VERB_HANDLERS, NO_PAYLOAD_VERBS } from './command.js';
import { SubscriptionStore } from './subscriptions.js';
import { SurfaceError, UpstreamError } from './errors.js';
import { logEvent } from './log.js';

export interface HandlerDeps {
  config: Config;
  client: PomegranateClient;
  botUserId?: string;
  /** Channel-listening state; verbs degrade gracefully when absent. */
  subscriptions?: SubscriptionStore;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function createMentionHandler(
  deps: HandlerDeps,
): (ctx: MentionContext) => Promise<void> {
  const env = deps.env ?? process.env;
  const seenEventIds = new Set<string>();

  return async (ctx: MentionContext): Promise<void> => {
    const t0 = Date.now();

    // 1. De-dup on the event id (Slack retries). No-op on a repeat.
    if (seenEventIds.has(ctx.eventId)) {
      logEvent('info', 'mention', {
        team_id: ctx.teamId,
        requester: ctx.requesterUserId,
        outcome: 'duplicate',
      });
      return;
    }
    seenEventIds.add(ctx.eventId);

    // Fields filled in progressively; emitted once in `finally`. Never includes
    // payload text, file contents, or tokens (ENGINEERING §9).
    let verb: string | undefined;
    let subject: string | undefined;
    let payloadKind: string | undefined;
    let outcome = 'error';
    let errName: string | undefined;

    try {
      // 2. Parse the command (before any reaction).
      const cmd = parseMention(ctx.text, deps.botUserId);
      verb = cmd.verb;

      // 2b. Resolve the subject. Self-only verbs (ingest/pending/listen) never
      //     carry a subject — the parser yields null for them — so they always
      //     resolve to the requester's OWN workspace. Only review/getcontext
      //     parse a `from @x` clause and thus a foreign subject.
      const subjectUserId = cmd.subjectUserId ?? ctx.requesterUserId;
      subject = subjectUserId;

      // 3. Resolve identities (before any reaction).
      const canon = resolveCanon(deps.config, ctx.teamId, subjectUserId, env);
      const req = resolveRequester(deps.config, ctx.teamId, ctx.requesterUserId);

      // 4. Acknowledge — only now that the command is valid + subject mapped.
      //    Best-effort: the reaction is a cosmetic ack, so a failure here
      //    (e.g. the app lacks the reactions:write scope) must NOT abort the
      //    actual review. Log and continue.
      try {
        await ctx.react(':eyes:');
      } catch (e) {
        logEvent('warn', 'reaction_failed', {
          team_id: ctx.teamId,
          reason: (e as Error).message,
        });
      }

      // 5. Resolve the payload (file or inline text). No-payload verbs still
      //    get the parsed remainder as text (listen reads its interval there)
      //    but never fail on an empty one.
      const payload: Payload = NO_PAYLOAD_VERBS.has(cmd.verb)
        ? { kind: 'text', text: cmd.remainder }
        : await resolvePayload(ctx, cmd.remainder);
      payloadKind = payload.kind;

      // 6. Dispatch to the verb handler.
      const reply = await VERB_HANDLERS[cmd.verb]({
        canon,
        req,
        payload,
        client: deps.client,
        subjectLabel: '<@' + subjectUserId + '>',
        teamId: ctx.teamId,
        channelId: ctx.channelId,
        requesterUserId: ctx.requesterUserId,
        audience: cmd.audience,
        subscriptions: deps.subscriptions,
      });

      // 7. Reply.
      await ctx.reply(reply.text, reply.blocks);
      outcome = 'ok';
    } catch (err) {
      if (err instanceof SurfaceError) {
        errName = err.name;
        outcome = err instanceof UpstreamError ? 'upstream_error' : 'mapped_error';
        await ctx.reply(err.userMessage).catch(() => {});
      } else {
        errName = (err as Error)?.name ?? 'Error';
        outcome = 'error';
        console.error('[slack-surface] unexpected error:', err);
        await ctx.reply('Something went wrong — try again.').catch(() => {});
      }
    } finally {
      // One structured line per handled mention.
      logEvent('info', 'mention', {
        team_id: ctx.teamId,
        requester: ctx.requesterUserId,
        verb,
        subject,
        payload_kind: payloadKind,
        outcome,
        error: errName,
        latency_ms: Date.now() - t0,
      });
    }
  };
}
