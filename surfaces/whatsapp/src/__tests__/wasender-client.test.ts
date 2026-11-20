import { describe, expect, it, vi } from 'vitest';
import { WasenderClient } from '../wasender-client.js';
import { SendFailedError } from '../errors.js';

describe('WasenderClient.sendText', () => {
  it('POSTs to /send-message with a bearer token, "to" passed through verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const client = new WasenderClient('https://www.wasenderapi.com/api', 'tok123', fetchImpl as unknown as typeof fetch);
    await client.sendText('+14155550100', 'hello');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.wasenderapi.com/api/send-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok123' }),
        body: JSON.stringify({ to: '+14155550100', text: 'hello' }),
      }),
    );
  });

  it('does not reformat a group JID — passes it through unchanged', async () => {
    // Regression: sendText used to force `+<digits>` on every `to`, which
    // WasenderAPI rejects (422) for a group JID — burned in production
    // 2026-09-10. The caller (webhook.ts's replyTargetOf) now decides the
    // shape; this client must never reformat it.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    const client = new WasenderClient('https://www.wasenderapi.com/api', 'tok123', fetchImpl as unknown as typeof fetch);
    await client.sendText('120363412508870098@g.us', 'hello group');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.wasenderapi.com/api/send-message',
      expect.objectContaining({
        body: JSON.stringify({ to: '120363412508870098@g.us', text: 'hello group' }),
      }),
    );
  });

  it('throws SendFailedError on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));
    const client = new WasenderClient('https://www.wasenderapi.com/api', 'tok123', fetchImpl as unknown as typeof fetch);
    await expect(client.sendText('14155550100', 'hello')).rejects.toBeInstanceOf(SendFailedError);
  });
});

describe('WasenderClient.downloadAudio', () => {
  it('asks Wasender to decrypt WhatsApp media before downloading it', async () => {
    const audioBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicUrl: 'https://media.example/decrypted.ogg' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(audioBytes, { status: 200 }));
    const client = new WasenderClient('https://www.wasenderapi.com/api', 'tok123', fetchImpl as unknown as typeof fetch);

    const result = await client.downloadAudio('message-1', {
      url: 'https://mmg.whatsapp.net/encrypted',
      mimetype: 'audio/ogg; codecs=opus',
      mediaKey: 'base64-media-key',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1,
      'https://www.wasenderapi.com/api/decrypt-media',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok123' }),
        body: JSON.stringify({
          data: {
            messages: {
              key: { id: 'message-1' },
              message: {
                audioMessage: {
                  url: 'https://mmg.whatsapp.net/encrypted',
                  mimetype: 'audio/ogg; codecs=opus',
                  mediaKey: 'base64-media-key',
                },
              },
            },
          },
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://media.example/decrypted.ogg');
    expect(result).toEqual(Buffer.from(audioBytes));
  });
});
