import { describe, expect, it, vi } from 'vitest';
import { SurfaceAgentClient } from '../surface-client.js';
import { UpstreamError } from '../errors.js';

describe('SurfaceAgentClient.sendMessage', () => {
  it('POSTs surface=whatsapp with the shared secret header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ reply: 'hi there' }), { status: 200 }));
    const client = new SurfaceAgentClient('https://pomegranate.example.com', 'shared-secret', fetchImpl as unknown as typeof fetch);
    const result = await client.sendMessage({ phone: '14155550100', thread_key: '14155550100', text: 'hello' });
    expect(result).toEqual({ reply: 'hi there' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://pomegranate.example.com/agent/surface/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Surface-Secret': 'shared-secret' }),
        body: JSON.stringify({
          surface: 'whatsapp',
          phone: '14155550100',
          thread_key: '14155550100',
          text: 'hello',
        }),
      }),
    );
  });

  it('returns a structured 4xx body instead of throwing (e.g. unmapped)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ reply: 'unmapped', unmapped: true }), { status: 404 }));
    const client = new SurfaceAgentClient('https://pomegranate.example.com', 'secret', fetchImpl as unknown as typeof fetch);
    const result = await client.sendMessage({ phone: '1', thread_key: '1', text: 'hi' });
    expect(result).toEqual({ reply: 'unmapped', unmapped: true });
  });

  it('throws UpstreamError on a 5xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const client = new SurfaceAgentClient('https://pomegranate.example.com', 'secret', fetchImpl as unknown as typeof fetch);
    await expect(client.sendMessage({ phone: '1', thread_key: '1', text: 'hi' })).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});
