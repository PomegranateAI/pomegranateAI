/**
 * Parse a WasenderAPI webhook POST body into a normalized IncomingMessage.
 *
 * WasenderAPI's own docs are inconsistent about exact field casing across
 * webhook events (`messages.received` sends one message object at
 * `data.messages`; `messages.upsert` sends an array at the same path), so
 * this is deliberately defensive: it tries every documented field path
 * rather than assuming one exact shape, and returns `null` (not a throw) for
 * anything it can't make sense of — a shape we don't recognize should never
 * crash the webhook receiver, just get dropped with a log line.
 */
import type { IncomingMessage } from './types.js';
import { normalizePhoneDigits } from './phone.js';
import { logEvent } from './log.js';

interface RawKey {
  id?: unknown;
  fromMe?: unknown;
  remoteJid?: unknown;
  senderPn?: unknown;
  cleanedSenderPn?: unknown;
  // Group messages only (WasenderAPI's `messages-group.received` event —
  // must be enabled separately from `messages.received` in the dashboard):
  // `participant` identifies the individual group MEMBER who sent the
  // message, as distinct from `remoteJid` (the group's own JID). Without
  // this event enabled, a group message carries none of these, and
  // phoneOf() has nothing to resolve a sender from — see its doc comment.
  participant?: unknown;
  participantPn?: unknown;
  cleanedParticipantPn?: unknown;
}

interface RawAudio {
  mimetype?: unknown;
  url?: unknown;
  mediaKey?: unknown;
  fileSha256?: unknown;
  fileLength?: unknown;
}

interface RawMessage {
  key?: RawKey;
  messageBody?: unknown;
  message?: {
    conversation?: unknown;
    audioMessage?: RawAudio;
    imageMessage?: RawAudio & { caption?: string };
  };
}

function textOf(m: RawMessage): string | null {
  if (m.message?.imageMessage?.caption?.trim()) return m.message.imageMessage.caption;
  if (typeof m.messageBody === 'string' && m.messageBody.trim()) return m.messageBody;
  if (typeof m.message?.conversation === 'string' && m.message.conversation.trim()) {
    return m.message.conversation;
  }
  return null;
}

/**
 * Extract audio URL from message if it contains an audio message.
 * Returns the URL and mimetype if audio is present, null otherwise.
 */
function audioOf(m: RawMessage): IncomingMessage['audio'] {
  const audio = m.message?.audioMessage;
  if (!audio) return null;

  const url = typeof audio.url === 'string' && audio.url.trim() ? audio.url.trim() : null;
  const mediaKey = typeof audio.mediaKey === 'string' && audio.mediaKey.trim() ? audio.mediaKey.trim() : null;
  const mimetype = typeof audio.mimetype === 'string' && audio.mimetype.trim() ? audio.mimetype.trim() : 'audio/ogg';

  // The webhook URL points at encrypted WhatsApp media. Both values are
  // required by WasenderAPI's /decrypt-media endpoint.
  if (!url || !mediaKey) return null;

  return {
    url,
    mimetype,
    mediaKey,
    ...(typeof audio.fileSha256 === 'string' ? { fileSha256: audio.fileSha256 } : {}),
    ...(typeof audio.fileLength === 'string' || typeof audio.fileLength === 'number'
      ? { fileLength: audio.fileLength }
      : {}),
  };
}

/**
 * The message's actual SENDER, as a phone number — deliberately never falls
 * back to `remoteJid` for a group (that's the GROUP's own id, not a person;
 * doing that was a real production bug, see IncomingMessage.replyTo's doc
 * comment for the sibling bug this shares a root cause with). For a group
 * message this only resolves when WasenderAPI's `messages-group.received`
 * event is enabled (it carries `participant`/`participantPn`); on the
 * generic `messages.received`/`messages.upsert` events a group message
 * carries no per-sender field at all, so this returns null and the message
 * gets dropped — nothing useful to do without knowing who's asking.
 */
function phoneOf(key: RawKey, isGroup: boolean): string | null {
  const candidates = isGroup
    ? [key.cleanedParticipantPn, key.participantPn]
    : [key.cleanedSenderPn, key.senderPn, key.remoteJid];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const digits = normalizePhoneDigits(c);
      if (digits) return digits;
    }
  }
  return null;
}

/**
 * The exact `to` value for the reply, matching what each chat type needs:
 * an individual chat replies to `+<phone>`; a group replies to the group's
 * own JID verbatim (`<id>@g.us`) — WasenderAPI rejects a `+`-prefixed group
 * id as "not a valid WhatsApp JID". `remoteJid` is a group's own JID when
 * `isGroup`, so it's used as-is rather than digit-stripped like `phone`.
 */
function replyTargetOf(key: RawKey, isGroup: boolean, phone: string): string | null {
  if (isGroup) {
    return typeof key.remoteJid === 'string' && key.remoteJid ? key.remoteJid : null;
  }
  return `+${phone}`;
}

/** One raw message → normalized IncomingMessage, or null to drop it. */
function normalizeOne(m: RawMessage): IncomingMessage | null {
  const key = m.key ?? {};
  if (key.fromMe === true) return null; // our own outgoing message, echoed back

  const text = textOf(m);
  const audio = audioOf(m);
  const image = m.message?.imageMessage ? audioOf({ ...m, message: { audioMessage: m.message.imageMessage } }) : null;
  if (image && !m.message?.imageMessage?.mimetype) image.mimetype = 'image/jpeg';

  // Must have either text or media
  if (!text && !audio && !image) return null;

  const isGroup = typeof key.remoteJid === 'string' && key.remoteJid.includes('@g.us');
  const phone = phoneOf(key, isGroup);
  if (!phone) {
    if (isGroup) {
      // Most likely cause: WasenderAPI's "Group Message Received" event
      // isn't enabled in the dashboard, so this arrived on the generic
      // event with no participant field — see phoneOf()'s doc comment.
      logEvent('warn', 'whatsapp_message', { outcome: 'group_sender_unresolved' });
    }
    return null;
  }

  const id = typeof key.id === 'string' && key.id ? key.id : `${phone}:${text || 'audio'}`.slice(0, 128);
  const replyTo = replyTargetOf(key, isGroup, phone);
  if (!replyTo) return null; // group message with no usable remoteJid — nothing to reply to

  return { id, phone, text: text ?? null, audio: audio ?? null, ...(image ? { image } : {}), isGroup, replyTo };
}

/**
 * Parse a webhook body into every message it carries. Handles both a single
 * message object (`messages.received`) and an array (`messages.upsert`).
 * Returns [] for shapes with nothing usable — never throws on bad input.
 */
export function parseWebhookMessages(body: unknown): IncomingMessage[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { messages?: unknown }).messages;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: IncomingMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    try {
      const msg = normalizeOne(item as RawMessage);
      if (msg) out.push(msg);
    } catch (err) {
      logEvent('warn', 'webhook_parse_skip', { reason: (err as Error).message });
    }
  }
  return out;
}
