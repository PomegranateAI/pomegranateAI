/**
 * Wire the Bolt app: load config, build the outbound client, register the
 * `app_mention` handler. The Slack <-> MentionContext adaptation lives in
 * `slack-context.ts`; the business logic lives in `handlers.ts` (owned by a
 * teammate). This module is the only place that touches `@slack/bolt`.
 */
import { App } from '@slack/bolt';
import { loadConfigFromFile, assertTokensPresent, assertSurfaceSecret } from './config.js';
import { parseMention } from './parse.js';
import { HttpPomegranateClient } from './client.js';
import { createMentionHandler } from './handlers.js';
import { createRelayMentionHandler, matchListenVerb } from './relay.js';
import { SurfaceAgentClient } from './surface-client.js';
import { createActionHandler } from './actions.js';
import { SubscriptionStore } from './subscriptions.js';
import { createListenScheduler, type ChannelHistoryApi } from './scheduler.js';
import { resolveTeam } from './resolve.js';
import { buildMentionContext, buildActionContext } from './slack-context.js';
import type {
  SlackApi,
  SlackEventEnvelope,
  SlackActionEnvelope,
} from './slack-context.js';

export async function createSlackApp(): Promise<App> {
  const config = loadConfigFromFile(
    process.env.POMEGRANATE_SLACK_CONFIG ?? './config/mapping.json',
  );

  // Mode: 'relay' (default when the surface secret is present) forwards every
  // message to the server's LLM surface agent — no verb grammar, no per-user
  // token keyring. 'legacy' keeps the regex verbs + keyring for one deploy
  // cycle as the rollback path (SLACK_AGENT_MODE=legacy).
  const mode =
    process.env.SLACK_AGENT_MODE ??
    (process.env.SURFACE_AGENT_SECRET ? 'relay' : 'legacy');
  const relay = mode === 'relay';
  if (relay) assertSurfaceSecret();
  else assertTokensPresent(config);

  const client = new HttpPomegranateClient();
  const surface = relay ? new SurfaceAgentClient(process.env.SURFACE_AGENT_SECRET!) : undefined;

  // Dev/CI escape hatch: boot and listen WITHOUT a live Slack app. With this
  // set, Bolt skips its startup token verification so the HTTP receiver comes
  // up against placeholder credentials (it cannot actually serve real Slack
  // traffic — it's for local smoke + wiring checks). Unset in production.
  const tokenVerificationEnabled =
    process.env.SLACK_SKIP_TOKEN_VERIFICATION !== '1';

  const app =
    process.env.SLACK_MODE === 'socket'
      ? new App({
          socketMode: true,
          appToken: process.env.SLACK_APP_TOKEN,
          token: process.env.SLACK_BOT_TOKEN,
          tokenVerificationEnabled,
        })
      : new App({
          token: process.env.SLACK_BOT_TOKEN,
          signingSecret: process.env.SLACK_SIGNING_SECRET,
          tokenVerificationEnabled,
        });

  // Resolve the bot's own user id once so handlers can strip its mention.
  // Best-effort: botUserId is optional (the parser still works without it, it
  // just won't strip a literal self-mention token), so a transient auth.test
  // failure must not stop the bot from booting and listening.
  let botUserId: string | undefined;
  try {
    const auth = await app.client.auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  } catch (err) {
    console.warn(
      `[warn] auth.test failed — booting without a known bot user id (${(err as Error).message}).`,
    );
  }

  // Channel-listening state lives on a mounted volume so subscriptions
  // survive restarts/redeploys.
  const subscriptions = new SubscriptionStore(
    process.env.POMEGRANATE_SLACK_STATE ?? './data/subscriptions.json',
  );

  const handle = relay
    ? createRelayMentionHandler({
        surface: surface!,
        apiBaseUrlFor: (teamId) => resolveTeam(config, teamId).pomegranate_api_url,
        botUserId,
        subscriptions,
      })
    : createMentionHandler({ config, client, botUserId, subscriptions });
  const handleAction = createActionHandler({ config, client, surface });

  // The interval scheduler shares Bolt's WebClient for history reads and
  // in-channel announcements. Tick = 60s; due subscriptions run serialized.
  const scheduler = createListenScheduler({
    store: subscriptions,
    config,
    client,
    surface,
    api: app.client as unknown as ChannelHistoryApi,
    botUserId,
  });
  scheduler.start();

  app.event('app_mention', async ({ event, body, client }) => {
    // Bolt's event/body typings are deliberately loose; cast at this boundary.
    const e = event as unknown as SlackEventEnvelope;
    const ctx = buildMentionContext({
      event: e,
      teamId: (body as { team_id: string }).team_id,
      // channel:ts (not Slack's event_id) so the same source message arriving
      // via BOTH app_mention and message.im dedups to one handling.
      eventId: `${e.channel}:${e.ts}`,
      api: client as unknown as SlackApi,
      botToken: process.env.SLACK_BOT_TOKEN!,
    });
    await handle(ctx);
  });

  // DMs to the app. Slack does NOT fire app_mention inside IMs — DM traffic
  // arrives as `message` events with channel_type=im (requires the app's
  // Event Subscriptions to include `message.im`). In a DM the mention is
  // optional: every human message is treated as a command.
  app.event('message', async ({ event, body, client }) => {
    const e = event as unknown as SlackEventEnvelope & {
      channel_type?: string;
      bot_id?: string;
      subtype?: string;
    };
    if (e.channel_type !== 'im') return;
    // Never react to our own replies (loop!) or to system subtypes; file
    // shares keep their text and are real commands ("ingest" + attachment).
    if (e.bot_id || !e.user) return;
    if (e.subtype && e.subtype !== 'file_share') return;
    const teamId = (body as { team_id: string }).team_id;
    // Drop-box mode: when this DM has an active `listen` subscription, only
    // messages ADDRESSED to the bot reach the handler; everything else is
    // content for the next batch ingest — stay silent.
    if (subscriptions.get(teamId, e.channel, e.user)) {
      const text = e.text ?? '';
      if (relay) {
        // Deterministic address check: a bot mention, the word "pomegranate",
        // or a listen verb counts as talking TO the bot.
        const addressed =
          (botUserId && text.includes(`<@${botUserId}`)) ||
          /@?\bpomegranate\b/i.test(text) ||
          matchListenVerb(text, botUserId) !== null;
        if (!addressed) return;
      } else {
        // Legacy: a message that is NOT a parseable command is drop-box content.
        try {
          parseMention(text, botUserId);
        } catch {
          return;
        }
      }
    }
    const ctx = buildMentionContext({
      event: e,
      teamId,
      eventId: `${e.channel}:${e.ts}`,
      api: client as unknown as SlackApi,
      botToken: process.env.SLACK_BOT_TOKEN!,
    });
    await handle(ctx);
  });

  // Candidate approve/reject buttons (posted by the `pending` verb).
  // Acknowledge within Slack's 3s window FIRST, then do the real work.
  app.action(/^cand_(approve|reject)$/, async ({ ack, body, client }) => {
    await ack();
    const ctx = buildActionContext({
      body: body as unknown as SlackActionEnvelope,
      api: client as unknown as SlackApi,
    });
    if (ctx) await handleAction(ctx);
  });

  return app;
}
