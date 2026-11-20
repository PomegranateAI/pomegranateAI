/**
 * Adapt a Bolt `app_mention` event into our Slack-decoupled `MentionContext`.
 *
 * This module is the ONLY place that knows the shape of the raw Slack event and
 * the Slack Web API surface we use (reactions.add, chat.postMessage, file GET).
 * `buildMentionContext` is pure-ish: every external dependency (the Web API and
 * `fetch`) is injected, so it can be unit-tested without a live Slack.
 */
import type { MentionContext, SlackFileRef, ActionContext } from './types.js';
import { FileFetchError } from './errors.js';

/** The subset of a Bolt `app_mention` event payload we consume. */
export interface SlackEventEnvelope {
  text: string;
  user: string;
  team?: string;
  files?: Array<{
    name: string;
    mimetype?: string;
    url_private?: string;
    size?: number;
  }>;
  ts: string;
  thread_ts?: string;
  channel: string;
}

/** The subset of the Slack Web API client the context needs. */
export interface SlackApi {
  reactions: {
    add(args: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<unknown>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
      /** Requires Slack's chat:write.customize scope. */
      username?: string;
    }): Promise<unknown>;
    update?(args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }): Promise<unknown>;
  };
}

/** Strip leading/trailing `:` from a Slack emoji shortcode (`:eyes:` → `eyes`). */
function stripColons(emoji: string): string {
  return emoji.replace(/^:+/, '').replace(/:+$/, '');
}

export function buildMentionContext(args: {
  event: SlackEventEnvelope;
  teamId: string;
  eventId: string;
  api: SlackApi;
  botToken: string;
  fetchImpl?: typeof fetch;
}): MentionContext {
  const { event, teamId, eventId, api, botToken } = args;
  const fetchImpl = args.fetchImpl ?? fetch;

  const files: SlackFileRef[] = (event.files ?? []).map((f) => ({
    name: f.name,
    mimetype: f.mimetype,
    url_private: f.url_private,
    size: f.size,
  }));

  return {
    text: event.text,
    files,
    requesterUserId: event.user,
    teamId,
    channelId: event.channel,
    // Stable thread identity: channel:thread_root_ts for channel threads,
    // or channel:channel for DMs so follow-ups in the same IM share state.
    threadKey: `${event.channel}:${event.channel.startsWith('D') ? event.channel : event.thread_ts ?? event.ts}`,
    eventId,

    async react(emoji: string): Promise<void> {
      await api.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: stripColons(emoji),
      });
    },

    async reply(text: string, blocks?: unknown[], username?: string): Promise<void> {
      await api.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text,
        ...(blocks ? { blocks } : {}),
        ...(username ? { username } : {}),
      });
    },

    async replyEditable(text: string) {
      const posted = (await api.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
        text,
      })) as { ts?: string };
      const ts = posted?.ts;
      return async (newText: string, blocks?: unknown[]) => {
        // Fall back to a fresh threaded reply when update isn't possible
        // (no ts returned, or the API surface lacks chat.update).
        if (!ts || !api.chat.update) {
          await api.chat.postMessage({
            channel: event.channel,
            thread_ts: event.thread_ts ?? event.ts,
            text: newText,
            ...(blocks ? { blocks } : {}),
          });
          return;
        }
        await api.chat.update({
          channel: event.channel,
          ts,
          text: newText,
          ...(blocks ? { blocks } : {}),
        });
      };
    },

    async fetchFileText(file: SlackFileRef): Promise<string> {
      if (!file.url_private) return '';
      const res = await fetchImpl(file.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) {
        throw new FileFetchError(
          "I couldn't read that file from Slack — try pasting the text into your message instead.",
          `url_private fetch failed: HTTP ${res.status} for ${file.name}`,
        );
      }
      const contentType = res.headers?.get?.('content-type') ?? '';
      const text = await res.text();
      // When the app lacks the `files:read` scope (or the token can't reach the
      // file), Slack returns its HTML sign-in / app-shell page WITH A 200 — not
      // the file bytes. Reject that so its markup is never reviewed as the
      // deliverable. Primary signal is the content-type; body-sniffing is a
      // fallback used ONLY when no content-type is present, so a legit text
      // file that happens to contain HTML isn't misclassified.
      const isHtmlType = /text\/html/i.test(contentType);
      const looksHtml = /^\uFEFF?\s*<(?:!doctype|html)\b/i.test(text);
      if (isHtmlType || (!contentType && looksHtml)) {
        throw new FileFetchError(
          "I couldn't read that file — I'm probably missing the `files:read` permission. " +
            'Ask an admin to add it, or paste the text into your message instead.',
          `url_private returned HTML (content-type=${contentType || 'n/a'}) for ${file.name} — likely missing files:read scope`,
        );
      }
      return text;
    },
  };
}

// ---------- block-action (button click) adaptation ----------

/** The subset of a Bolt `block_actions` body we consume. */
export interface SlackActionEnvelope {
  team?: { id: string };
  user: { id: string; team_id?: string };
  channel?: { id: string };
  message?: { ts: string; thread_ts?: string; text?: string; blocks?: unknown[] };
  actions: Array<{ action_id: string; value?: string }>;
}

/**
 * Adapt a Bolt `block_actions` payload into our Slack-decoupled
 * {@link ActionContext}. Returns null when the payload is missing the pieces
 * we need (no candidate value, unknown action, or no source message).
 */
export function buildActionContext(args: {
  body: SlackActionEnvelope;
  api: SlackApi;
}): ActionContext | null {
  const { body, api } = args;
  const action = body.actions?.[0];
  if (!action?.value) return null;
  const kind =
    action.action_id === 'cand_approve'
      ? ('approve' as const)
      : action.action_id === 'cand_reject'
        ? ('reject' as const)
        : null;
  if (!kind) return null;
  const teamId = body.team?.id ?? body.user.team_id;
  const channel = body.channel?.id;
  const message = body.message;
  if (!teamId || !channel || !message) return null;

  return {
    teamId,
    actorUserId: body.user.id,
    candidateId: action.value,
    action: kind,

    async reply(text: string): Promise<void> {
      await api.chat.postMessage({
        channel,
        thread_ts: message.thread_ts ?? message.ts,
        text,
      });
    },

    async updateMessageBlocks(
      mutate: (blocks: unknown[]) => unknown[],
    ): Promise<void> {
      if (!api.chat.update) return;
      const next = mutate(message.blocks ?? []);
      await api.chat.update({
        channel,
        ts: message.ts,
        text: message.text ?? 'Pending changes',
        blocks: next,
      });
    },
  };
}
