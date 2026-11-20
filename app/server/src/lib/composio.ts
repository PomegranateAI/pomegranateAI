// Composio client seam — the boundary between our code and the hosted
// Composio API (https://composio.dev), which custodies OAuth tokens for
// third-party apps (GitHub, Slack, Notion, ...) on our behalf so we never
// register our own OAuth client or store live tokens ourselves.
//
// Gated on COMPOSIO_API_KEY exactly like credentialsKeyConfigured() gates the
// encrypted-secret store — without a key, every caller degrades to "not
// configured" rather than erroring.

import { Composio } from '@composio/core';

export function composioConfigured(): boolean {
  return !!process.env.COMPOSIO_API_KEY;
}

let client: Composio | null = null;

/** Lazy singleton — one client per process, matching the SDK's own guidance. */
export function getComposioClient(): Composio {
  if (!composioConfigured()) throw new Error('composio_not_configured');
  if (!client) client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  return client;
}

// Test-only: let unit tests inject a fake client instead of constructing a
// real Composio SDK instance (which would require a live API key). Never
// used outside test files.
export function __setComposioClientForTests(fake: Composio | null): void {
  client = fake;
}
