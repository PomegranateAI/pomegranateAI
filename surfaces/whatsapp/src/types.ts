/** A normalized inbound WhatsApp text message, extracted from whatever shape
 * WasenderAPI's webhook actually sent (see webhook.ts). */
export interface IncomingMessage {
  /** WasenderAPI's message id — used for de-dup (webhooks can retry). */
  id: string;
  /** Sender's phone number, digits-only (see db normalizePhoneDigits parity in app/server). */
  phone: string;
  /** Text content if present, null if audio-only message. */
  text: string | null;
  /** Audio metadata (URL + mimetype) if present, null if text-only message. */
  audio: {
    url: string;
    mimetype: string;
    /** WhatsApp media is encrypted; Wasender needs this key to decrypt it. */
    mediaKey: string;
    fileSha256?: string;
    fileLength?: string | number;
  } | null;
  /** Image metadata uses the same Wasender decryption envelope. */
  image?: IncomingMessage['audio'];
  /** true for a group chat (remoteJid ends in @g.us) — reaches the agent
   * only when the message addresses the bot, see relay.ts's group gate. */
  isGroup: boolean;
  /**
   * The exact value to send back to WasenderAPI's `to` field — already in
   * whichever shape it expects: `+<digits>` E.164 for an individual chat, or
   * the raw group JID (`<id>@g.us`) for a group. NOT the same shape as
   * `phone`: a group JID's digits aren't a phone number, and formatting them
   * with a `+` prefix gets rejected by WasenderAPI (422 "must be a valid
   * WhatsApp JID") — burned in production 2026-09-10.
   */
  replyTo: string;
}

export interface SurfaceMessageResult {
  reply?: string;
  unmapped?: boolean;
  needs_default?: boolean;
  error?: string;
  folder?: { id: string; name?: string };
  /** Subfolders this turn's ingests actually landed in (empty/absent if none). */
  filed_to?: Array<{ id: string; name?: string }>;
  assistant_nickname?: string | null;
}
