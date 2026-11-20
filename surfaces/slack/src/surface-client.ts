/**
 * [shared] HTTP client for the app's surface-agent relay endpoints
 * (`/agent/surface/messages`, `/agent/surface/actions`).
 *
 * This replaces the per-tool HttpPomegranateClient + per-user token keyring:
 * the surface authenticates with ONE shared secret (X-Surface-Secret) and
 * asserts the Slack identity of the sender; the SERVER resolves that identity
 * to a Pomegranate user + default folder and enforces all authorization.
 */
import type { SurfaceMessageResult, SurfaceActionResult, SlackFileRef } from './types.js';
import { UpstreamError } from './errors.js';

const UPSTREAM_USER_MESSAGE = 'Something went wrong reaching Pomegranate — try again.';

export interface SurfaceMessagePayload {
  team_id: string;
  slack_user_id: string;
  channel_id?: string;
  thread_key: string;
  text: string;
  files?: Array<{ name: string; text: string }>;
}

export interface SurfaceActionPayload {
  team_id: string;
  slack_user_id: string;
  tool: string;
  args: Record<string, unknown>;
}

export class SurfaceAgentClient {
  constructor(
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendMessage(apiBaseUrl: string, payload: SurfaceMessagePayload): Promise<SurfaceMessageResult> {
    return (await this.post(`${apiBaseUrl}/agent/surface/messages`, {
      surface: 'slack',
      ...payload,
    })) as SurfaceMessageResult;
  }

  async invokeAction(apiBaseUrl: string, payload: SurfaceActionPayload): Promise<SurfaceActionResult> {
    return (await this.post(`${apiBaseUrl}/agent/surface/actions`, {
      surface: 'slack',
      ...payload,
    })) as SurfaceActionResult;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Surface-Secret': this.secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // 4xx bodies carry structured info the caller renders (unmapped, no
    // default folder, not-allowed tool); only network-ish failures throw.
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
        `Pomegranate ${url} returned HTTP ${res.status}: ${snippet}`,
      );
    }
    return json;
  }
}

/** File payloads for the relay: name + already-fetched text. */
export function toFilePayloads(files: Array<{ ref: SlackFileRef; text: string }>): Array<{ name: string; text: string }> {
  return files.map((f) => ({ name: f.ref.name, text: f.text }));
}
