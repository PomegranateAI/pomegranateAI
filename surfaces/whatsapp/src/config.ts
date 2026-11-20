/**
 * Load + validate this surface's env config. Unlike surfaces/slack there is
 * no mapping.json: WhatsApp has no "team" concept — one bot phone number
 * (one WasenderAPI session) serves the whole org, and identity resolves
 * entirely server-side (user_identities kind='whatsapp'), so there is
 * nothing left to map surface-side beyond the shared secret + API location.
 *
 * Media processing and provider credentials live on the Pomegranate server.
 */
import { MissingToken } from './errors.js';

export interface WhatsappSurfaceConfig {
  /** WasenderAPI session token (`Authorization: Bearer <token>`). */
  wasenderApiToken: string;
  /** Base URL for WasenderAPI REST calls, e.g. https://www.wasenderapi.com/api */
  wasenderApiBaseUrl: string;
  /** Shared secret WasenderAPI sends back in `X-Webhook-Signature`. */
  wasenderWebhookSecret: string;
  /** The Pomegranate deployment's base URL, e.g. http://localhost:3000 */
  pomegranateApiUrl: string;
  /** Shared secret for the /agent/surface/* relay (must match the server's SURFACE_AGENT_SECRET). */
  surfaceAgentSecret: string;
  port: number;
}

/** Fail fast at boot if any required env var is missing. */
export function loadConfig(env: Record<string, string | undefined> = process.env): WhatsappSurfaceConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? '';
  };

  const wasenderApiToken = need('WASENDER_API_TOKEN');
  const wasenderWebhookSecret = need('WASENDER_WEBHOOK_SECRET');
  const pomegranateApiUrl = need('POMEGRANATE_API_URL');
  const surfaceAgentSecret = need('SURFACE_AGENT_SECRET');

  if (missing.length > 0) {
    throw new MissingToken(
      "Pomegranate WhatsApp bot isn't fully configured yet.",
      `missing env vars: ${missing.join(', ')}`,
    );
  }

  return {
    wasenderApiToken,
    wasenderApiBaseUrl: (env.WASENDER_API_BASE_URL ?? 'https://www.wasenderapi.com/api').replace(/\/$/, ''),
    wasenderWebhookSecret,
    pomegranateApiUrl: pomegranateApiUrl.replace(/\/$/, ''),
    surfaceAgentSecret,
    port: Number(env.PORT ?? 3002),
  };
}
