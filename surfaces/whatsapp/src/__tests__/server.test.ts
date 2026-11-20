import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createWhatsappServer } from '../server.js';
import type { IncomingMessage } from '../types.js';

const SECRET = 'test-webhook-secret';

function listen(onMessage: (msg: IncomingMessage) => Promise<void> = vi.fn().mockResolvedValue(undefined)) {
  const server = createWhatsappServer({ webhookSecret: SECRET, onMessage });
  return new Promise<{ url: string; close: () => Promise<void>; onMessage: typeof onMessage }>((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        onMessage,
      });
    });
  });
}

const RECEIVED_BODY = {
  event: 'messages.received',
  data: {
    messages: {
      key: { id: 'm1', fromMe: false, remoteJid: '14155550100@s.whatsapp.net' },
      messageBody: 'hi',
    },
  },
};

describe('createWhatsappServer', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it('answers /healthz without auth', async () => {
    const { url, close } = await listen();
    cleanup = close;
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects a webhook POST with a missing or wrong signature', async () => {
    const { url, close } = await listen();
    cleanup = close;
    const noHeader = await fetch(`${url}/webhook`, { method: 'POST', body: '{}' });
    expect(noHeader.status).toBe(401);
    const wrongHeader = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: { 'x-webhook-signature': 'nope' },
      body: '{}',
    });
    expect(wrongHeader.status).toBe(401);
  });

  it('accepts a correctly signed webhook, answers 200 immediately, and dispatches the parsed message', async () => {
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const { url, close } = await listen(onMessage);
    cleanup = close;
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: { 'x-webhook-signature': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(RECEIVED_BODY),
    });
    expect(res.status).toBe(200);
    // dispatch happens after the response is sent — give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', phone: '14155550100', text: 'hi' }),
    );
  });

  it('returns 400 on invalid JSON', async () => {
    const { url, close } = await listen();
    cleanup = close;
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: { 'x-webhook-signature': SECRET },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('404s everything else', async () => {
    const { url, close } = await listen();
    cleanup = close;
    const res = await fetch(`${url}/anything`);
    expect(res.status).toBe(404);
  });
});

describe('webhook abuse limits', () => {
  it('rate-limits an IP before checking the secret', async () => {
    const server = createWhatsappServer({
      webhookSecret: SECRET,
      onMessage: vi.fn().mockResolvedValue(undefined),
      rateLimit: { capacity: 3, refillMs: 60_000 },
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-signature': 'wrong' },
          body: '{}',
        });
        statuses.push(r.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('refuses a body over the size cap with 413', async () => {
    const { url, close, onMessage } = await listen();
    try {
      const big = JSON.stringify({ ...RECEIVED_BODY, pad: 'x'.repeat(2 * 1024 * 1024 + 10) });
      const r = await fetch(`${url}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': SECRET },
        body: big,
      }).catch(() => null);
      // The server answers 413 and closes; some clients see the reset instead.
      if (r) expect(r.status).toBe(413);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
