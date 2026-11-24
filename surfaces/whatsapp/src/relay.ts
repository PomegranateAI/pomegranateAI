/**
 * Relay pipeline — the WhatsApp analog of surfaces/slack/src/relay.ts's
 * relay mode: every inbound message goes straight to the server's surface
 * agent (POST /agent/surface/messages, surface='whatsapp') and the reply
 * comes straight back as a WhatsApp text. No verb grammar — plain language,
 * exactly like the Slack relay. What stays surface-side, deterministically:
 * de-dup on the WasenderAPI message id (webhooks can retry), and the group
 * "addressed" gate below.
 *
 * Groups: a group message only reaches the agent when it explicitly names
 * the bot ("pomegranate do X") — same deterministic address-check Slack's
 * relay uses for a channel it's merely present in (see
 * surfaces/slack/src/relay.ts). Unaddressed group chatter gets NO reply at
 * all (not even a notice) — replying to everything in a group the bot
 * happens to be in would be noisy and unwanted. Once addressed, a group
 * message runs through the EXACT SAME pipeline as a 1:1 message: same
 * identity resolution (by the individual sender's phone — see
 * IncomingMessage.phone/webhook.ts), same thread_key (so a person's
 * conversation stays continuous whether they DM the bot or address it from
 * inside a group), same unmapped/no-default replies. The one thing that's
 * different is `replyTo`, which is already the group's own JID for a group
 * message — so the reply posts back into the group, visible to everyone
 * there. That's a deliberate choice, not an oversight: whatever the
 * requester can see through the agent becomes visible to the whole group
 * once they ask for it there — same as asking someone to read their screen
 * out loud in a meeting. That's on the person asking, not something this
 * surface tries to prevent.
 *
 * Media is downloaded here and read by the shared server data-agent
 * runtime. The group gate below runs BEFORE that download (see it for why).
 */
import type { IncomingMessage } from './types.js';
import type { SurfaceAgentClient } from './surface-client.js';
import type { WasenderClient } from './wasender-client.js';
import { SurfaceError } from './errors.js';
import { logEvent } from './log.js';

const GENERIC_FAILURE = 'Something went wrong — try again.';

/** Same deterministic address-check as Slack's relay.ts. */
const ADDRESS_RE = /@?\bpomegranate\b/i;

/** Bounded FIFO de-dup set — WasenderAPI webhooks can retry a delivery. */
const MAX_SEEN = 2000;

/** Keep audio downloads bounded before sending them to the transcription API. */
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024;

export interface RelayDeps {
  surface: SurfaceAgentClient;
  wasender: WasenderClient;
}

export function createRelayHandler(deps: RelayDeps): (msg: IncomingMessage) => Promise<void> {
  const seen = new Set<string>();

  return async (msg: IncomingMessage): Promise<void> => {
    if (seen.has(msg.id)) {
      logEvent('info', 'whatsapp_message', { phone: msg.phone, outcome: 'duplicate' });
      return;
    }
    seen.add(msg.id);
    if (seen.size > MAX_SEEN) {
      let toDrop = seen.size - MAX_SEEN;
      for (const id of seen) {
        if (toDrop-- <= 0) break;
        seen.delete(id);
      }
    }

    let messageText = msg.text;
    if (msg.isGroup) {
      // Gate on the message's own text/caption, deliberately BEFORE any media
      // download: unaddressed group chatter then costs nothing and leaves no
      // server-side asset behind. The trade-off is that a bare voice note
      // can't address the bot (WhatsApp has no caption on a voice note) — in
      // a group, name it in a text message or an image caption.
      if (!messageText || !ADDRESS_RE.test(messageText)) {
        logEvent('info', 'whatsapp_message', { phone: msg.phone, outcome: 'group_unaddressed' });
        return; // not addressed to the bot — silent, no reply
      }
      // Strip the trigger word so the agent doesn't see a literal
      // "pomegranate" token in what's meant to read as a plain request
      // (mirrors Slack's bot-mention stripping). If that's ALL they said
      // ("pomegranate" alone), fall back to the raw text rather than
      // forwarding an empty string — the server rejects an empty request.
      const stripped = messageText.replace(ADDRESS_RE, ' ').trim();
      messageText = stripped || messageText;
      // msg.phone is guaranteed non-empty here: webhook.ts's parser already
      // drops a group message with no resolvable `participant` phone before
      // it ever becomes an IncomingMessage (same as it always has for a 1:1
      // message with no resolvable sender) — see phoneOf()'s doc comment
      // for what that most often means operationally (the dashboard's
      // "Group Message Received" event isn't enabled).
    }

    const assetIds: string[] = [];
    const files: Array<{ name: string; text: string }> = [];
    const attachment = msg.audio ?? msg.image;
    if (attachment) {
      try {
        const bytes = msg.audio
          ? await deps.wasender.downloadAudio(msg.id, msg.audio)
          : await deps.wasender.downloadImage(msg.id, msg.image!);
        if (!bytes || bytes.length > MAX_AUDIO_SIZE_BYTES) throw new Error('media_download_failed');
        const ext = msg.audio
          ? attachment.mimetype.includes('webm')
            ? 'webm'
            : attachment.mimetype.includes('mpeg')
              ? 'mp3'
              : attachment.mimetype.includes('mp4')
                ? 'm4a'
                : 'ogg'
          : attachment.mimetype.includes('png')
            ? 'png'
            : attachment.mimetype.includes('webp')
              ? 'webp'
              : 'jpg';
        const processed = await deps.surface.readMedia(msg.phone, bytes, `${msg.id}.${ext}`, attachment.mimetype);
        if (processed.unmapped || processed.needs_default) {
          await deps.wasender.sendText(msg.replyTo, processed.reply ?? GENERIC_FAILURE);
          seen.delete(msg.id);
          return;
        }
        if (!processed.asset_id || !processed.text) throw new Error('media_processing_failed');
        assetIds.push(processed.asset_id);
        if (msg.audio && !messageText) messageText = processed.text;
        else files.push({ name: msg.audio ? 'Voice message' : 'Image', text: processed.text });
      } catch {
        seen.delete(msg.id);
        await deps.wasender.sendText(msg.replyTo, 'Could not read your media — please try again.').catch(() => {});
        return;
      }
    }
    if (!messageText && !files.length) return;
    messageText ??= 'Read the attached image.';

    const t0 = Date.now();
    let outcome = 'error';
    try {
      // One continuous thread per contact — WhatsApp has no channels/threads
      // the way Slack does, so the phone number itself is the thread key,
      // whether this message arrived by DM or (addressed) from a group.
      const result = await deps.surface.sendMessage({
        phone: msg.phone,
        thread_key: msg.phone,
        text: messageText,
        message_id: msg.id,
        ...(msg.isGroup ? { is_group: true } : {}),
        ...(assetIds.length ? { asset_ids: assetIds, files } : {}),
      });

      // Footer with the folder the agent ran in and — when something was
      // filed this turn — the subfolder(s) it actually landed in (the server
      // derives these from the tool results, not from what was asked for).
      let reply = result.reply ?? GENERIC_FAILURE;
      if (result.assistant_nickname) reply = `${result.assistant_nickname}: ${reply}`;
      if (result.folder) {
        const folderName = result.folder.name || result.folder.id;
        const subs = [...new Set((result.filed_to ?? []).map((s) => s.name || s.id))];
        reply += subs.length
          ? `\n\n[📁 Filed in: ${folderName} › ${subs.join(', ')}]`
          : `\n\n[📁 Directory: ${folderName}]`;
      }

      await deps.wasender.sendText(msg.replyTo, reply);
      outcome = result.unmapped ? 'unmapped' : result.needs_default ? 'needs_default' : 'ok';
    } catch (err) {
      seen.delete(msg.id);
      const fallback = err instanceof SurfaceError ? err.userMessage : GENERIC_FAILURE;
      outcome = err instanceof SurfaceError ? 'mapped_error' : 'error';
      if (!(err instanceof SurfaceError)) {
        logEvent('error', 'whatsapp_relay_error', { phone: msg.phone, reason: (err as Error).message });
      }
      await deps.wasender.sendText(msg.replyTo, fallback).catch((sendErr) => {
        logEvent('error', 'whatsapp_reply_failed', {
          phone: msg.phone,
          reason: (sendErr as Error).message,
        });
      });
    } finally {
      logEvent('info', 'whatsapp_message', { phone: msg.phone, outcome, ms: Date.now() - t0 });
    }
  };
}
