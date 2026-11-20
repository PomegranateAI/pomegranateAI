/**
 * [surfaces/slack/src/surface-client.ts pattern] HTTP client for the app's
 * surface-agent relay endpoint (`/agent/surface/messages`). The surface
 * authenticates with ONE shared secret (X-Surface-Secret) and asserts the
 * WhatsApp identity of the sender (a phone number); the SERVER resolves that
 * to a Pomegranate user + default folder and enforces all authorization —
 * same trust model as the Slack relay, see app/server routes.ts
 * SurfaceMsgBody / surfaceSecretOk.
 */
import type { SurfaceMessageResult } from './types.js';
import { UpstreamError } from './errors.js';

const UPSTREAM_USER_MESSAGE = 'Something went wrong reaching Pomegranate — try again.';

export interface SurfaceMessagePayload {
  phone: string;
  thread_key: string;
  text: string;
  message_id?: string;
  asset_ids?: string[];
  files?: Array<{ name: string; text: string }>;
}

export class SurfaceAgentClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async readMedia(
    phone: string,
    bytes: Buffer,
    name: string,
    mime: string,
  ): Promise<SurfaceMessageResult & { asset_id?: string; text?: string }> {
    const form = new FormData();
    form.append('phone', phone);
    form.append('file', new Blob([bytes], { type: mime }), name);
    const response = await this.fetchImpl(`${this.apiBaseUrl}/agent/surface/media`, {
      method: 'POST',
      headers: { 'X-Surface-Secret': this.secret },
      body: form,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new UpstreamError('Could not read your media — please try again.');
    return result;
  }

  async sendMessage(payload: SurfaceMessagePayload): Promise<SurfaceMessageResult> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}/agent/surface/messages`, {
      method: 'POST',
      headers: {
        'X-Surface-Secret': this.secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ surface: 'whatsapp', ...payload }),
    });
    // 4xx bodies carry structured info the caller renders (unmapped, no
    // default folder); only network-ish/5xx failures throw.
    const json = await res.json().catch(() => null);
    if (json === null || res.status >= 500) {
      let snippet = '';
      try {
        snippet = JSON.stringify(json ?? (await res.text())).slice(0, 500);
      } catch {
        /* body unreadable */
      }
      throw new UpstreamError(
        UPSTREAM_USER_MESSAGE,
        `Pomegranate /agent/surface/messages returned HTTP ${res.status}: ${snippet}`,
      );
    }
    return json as SurfaceMessageResult;
  }
}
