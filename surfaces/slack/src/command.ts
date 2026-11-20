/**
 * The verb -> action dispatch map (DESIGN §5).
 *
 * Adding a new capability means adding one entry here; the orchestration
 * pipeline in `handlers.ts` is verb-agnostic and dispatches through this map.
 * Imports only from [shared] modules.
 */
import type {
  Verb,
  Audience,
  CanonHandle,
  RequesterRef,
  Payload,
  PomegranateClient,
  Reply,
} from './types.js';
import {
  formatReview,
  formatGetContext,
  formatIngest,
  formatPending,
} from './format.js';
import {
  SubscriptionStore,
  parseIntervalSpec,
  formatInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} from './subscriptions.js';

export interface VerbHandlerArgs {
  canon: CanonHandle;
  req: RequesterRef;
  payload: Payload;
  client: PomegranateClient;
  subjectLabel: string;
  /** Where the mention happened — listen verbs subscribe this channel. */
  teamId: string;
  channelId: string;
  /** Slack user id of the requester (= subject for self-only verbs). */
  requesterUserId: string;
  /** Audience chosen via `ingest as <…>`; applied to what the ingest integrates. */
  audience?: Audience;
  /** Listening state; absent when the surface runs without a data volume. */
  subscriptions?: SubscriptionStore;
}

/** Runs one verb's outbound call + formatting, returning the Slack reply. */
export type VerbHandler = (args: VerbHandlerArgs) => Promise<Reply>;

/**
 * Verbs that operate on the requester's OWN workspace (write/curate paths).
 * The pipeline enforces subject === requester for these before dispatch.
 */
export const SELF_ONLY_VERBS: ReadonlySet<Verb> = new Set([
  'ingest',
  'pending',
  'listen',
  'stoplisten',
  'listening',
]);

/**
 * Verbs that need no file/inline payload. Their handler still receives the
 * parsed remainder as `payload.text` (listen reads its interval spec there).
 */
export const NO_PAYLOAD_VERBS: ReadonlySet<Verb> = new Set([
  'pending',
  'listen',
  'stoplisten',
  'listening',
]);

/** How many pending candidates one `pending` reply shows buttons for. */
export const PENDING_LIMIT = 10;

export const VERB_HANDLERS: Record<Verb, VerbHandler> = {
  review: async ({ canon, req, payload, client, subjectLabel }) => {
    const r = await client.review(canon, req, payload.text);
    return { text: formatReview(r, subjectLabel) };
  },
  getcontext: async ({ canon, req, payload, client, subjectLabel }) => {
    const r = await client.getContext(canon, req, payload.text);
    return { text: formatGetContext(r, subjectLabel) };
  },
  ingest: async ({ canon, req, payload, client, audience }) => {
    const sourceRef =
      payload.kind === 'file' ? `slack-upload:${payload.name}` : undefined;
    const r = await client.ingest(canon, req, payload.text, { sourceRef, audience });
    return {
      text: formatIngest(r, payload.kind === 'file' ? payload.name : undefined, audience),
    };
  },
  pending: async ({ canon, req, client }) => {
    const r = await client.listCandidates(canon, req, { limit: PENDING_LIMIT });
    return formatPending(r);
  },
  listen: async ({ payload, teamId, channelId, requesterUserId, subscriptions }) => {
    if (!subscriptions) {
      return { text: 'Channel listening is not enabled on this deployment.' };
    }
    const intervalMs = parseIntervalSpec(payload.text);
    if (intervalMs === null) {
      return {
        text:
          "I couldn't read that interval. Try `listen every 12h`, `listen every 30m`, or just `listen` " +
          `(default 24h; min ${formatInterval(MIN_INTERVAL_MS)}, max ${formatInterval(MAX_INTERVAL_MS)}).`,
      };
    }
    const now = new Date();
    const { created } = subscriptions.upsert({
      teamId,
      channelId,
      slackUserId: requesterUserId,
      intervalMs,
      nowTs: `${Math.floor(now.getTime() / 1000)}.000000`,
      now,
    });
    const every = formatInterval(intervalMs);
    return {
      text: created
        ? `:ear: Listening to <#${channelId}> — every ${every} I'll batch the new messages here into your workspace as proposed changes (nothing enters your graph without approval). Say \`stop listening\` here to stop.`
        : `:ear: Updated — I now check <#${channelId}> every ${every} for your workspace.`,
    };
  },
  stoplisten: async ({ teamId, channelId, requesterUserId, subscriptions }) => {
    if (!subscriptions) {
      return { text: 'Channel listening is not enabled on this deployment.' };
    }
    const removed = subscriptions.remove(teamId, channelId, requesterUserId);
    return {
      text: removed
        ? `Stopped listening to <#${channelId}> for your workspace.`
        : `I wasn't listening to <#${channelId}> for your workspace.`,
    };
  },
  listening: async ({ teamId, requesterUserId, subscriptions }) => {
    if (!subscriptions) {
      return { text: 'Channel listening is not enabled on this deployment.' };
    }
    const subs = subscriptions.list(teamId, requesterUserId);
    if (subs.length === 0) {
      return {
        text: "I'm not listening to any channels for your workspace. Say `listen` in a channel to start.",
      };
    }
    const lines = subs.map(
      (s) =>
        `• <#${s.channel_id}> — every ${formatInterval(s.interval_ms)}, next pass ${new Date(s.next_run_at).toUTCString()}`,
    );
    return { text: `Listening for your workspace:\n${lines.join('\n')}` };
  },
};
