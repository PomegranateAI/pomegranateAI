/**
 * Outbound WasenderAPI calls (https://wasenderapi.com/api-docs). Sending a
 * text message is `POST {baseUrl}/send-message` with
 * `Authorization: Bearer <session token>`. See README.md for how the base
 * URL / token map onto a Wasender dashboard.
 */
import { SendFailedError } from './errors.js';
import { logEvent } from './log.js';
import type { IncomingMessage } from './types.js';

export class WasenderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * `to` must already be in whichever shape WasenderAPI expects for the
   * target: `+<digits>` E.164 for an individual, or the raw group JID
   * (`<id>@g.us`) for a group — see IncomingMessage.replyTo, which is the
   * only place that decides the shape. Passed through verbatim here on
   * purpose: this client has no way to tell an individual number from a
   * group id apart once they're both just digits, and guessing wrong here
   * is exactly the 422 ("not a valid WhatsApp JID") bug this replaced.
   */
  async sendText(to: string, text: string): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/send-message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 500);
      } catch {
        /* body unreadable */
      }
      logEvent('error', 'wasender_send_failed', { status: res.status, body: snippet });
      throw new SendFailedError(
        'Could not send the WhatsApp reply — try again.',
        `WasenderAPI send-message returned HTTP ${res.status}: ${snippet}`,
      );
    }
  }

  /** Decrypt inbound WhatsApp audio through Wasender, then download it. */
  async downloadAudio(messageId: string, audio: NonNullable<IncomingMessage['audio']>): Promise<Buffer | null> {
    return this.downloadMedia(messageId, audio, 'audioMessage');
  }

  async downloadImage(messageId: string, image: NonNullable<IncomingMessage['audio']>): Promise<Buffer | null> {
    return this.downloadMedia(messageId, image, 'imageMessage');
  }

  private async downloadMedia(
    messageId: string,
    audio: NonNullable<IncomingMessage['audio']>,
    kind: string,
  ): Promise<Buffer | null> {
    try {
      const decryptRes = await this.fetchImpl(`${this.baseUrl}/decrypt-media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            messages: {
              key: { id: messageId },
              message: { [kind]: audio },
            },
          },
        }),
      });
      if (!decryptRes.ok) {
        logEvent('warn', 'wasender_audio_decrypt_failed', { status: decryptRes.status });
        return null;
      }

      const decrypted = (await decryptRes.json()) as { publicUrl?: unknown };
      if (typeof decrypted.publicUrl !== 'string' || !decrypted.publicUrl) {
        logEvent('warn', 'wasender_audio_decrypt_failed', { reason: 'missing publicUrl' });
        return null;
      }

      const res = await this.fetchImpl(decrypted.publicUrl);
      if (!res.ok) {
        logEvent('warn', 'wasender_audio_download_failed', {
          status: res.status,
        });
        return null;
      }

      if (!res.body) return null;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 25 * 1024 * 1024) {
            await reader.cancel();
            return null;
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    } catch (err) {
      logEvent('error', 'wasender_audio_download_error', {
        reason: (err as Error).message,
      });
      return null;
    }
  }
}
