import { describe, expect, it, vi } from 'vitest';
import { createRelayHandler, type RelayDeps } from '../relay.js';
import { UpstreamError } from '../errors.js';
import type { SurfaceAgentClient } from '../surface-client.js';
import type { WasenderClient } from '../wasender-client.js';
import type { IncomingMessage, SurfaceMessageResult } from '../types.js';

function msg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm1',
    phone: '14155550100',
    text: 'hello',
    audio: null,
    isGroup: false,
    replyTo: '+14155550100',
    ...overrides,
  };
}

function deps(sendMessage: (...args: unknown[]) => Promise<SurfaceMessageResult>) {
  const sendMessageMock = vi.fn(sendMessage);
  const sendText = vi.fn().mockResolvedValue(undefined);
  const relayDeps: RelayDeps = {
    surface: { sendMessage: sendMessageMock } as unknown as SurfaceAgentClient,
    wasender: { sendText } as unknown as WasenderClient,
  };
  return { ...relayDeps, sendMessage: sendMessageMock, sendText };
}

describe('createRelayHandler', () => {
  it('sends audio to server data agents and forwards trusted asset references', async () => {
    const d = deps(async () => ({ reply: 'Done' }));
    const readMedia = vi.fn().mockResolvedValue({ text: 'Remember this', asset_id: 'asset_1' });
    const downloadAudio = vi.fn().mockResolvedValue(Buffer.from('audio'));
    Object.assign(d.surface, { readMedia });
    Object.assign(d.wasender, { downloadAudio });
    await createRelayHandler(d)(
      msg({ text: null, audio: { url: 'https://media.example/file', mimetype: 'audio/ogg', mediaKey: 'key' } }),
    );
    expect(readMedia).toHaveBeenCalledWith('14155550100', Buffer.from('audio'), 'm1.ogg', 'audio/ogg');
    expect(d.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Remember this', asset_ids: ['asset_1'], message_id: 'm1' }),
    );
  });
  it('keeps image captions and supplies the reading as source content', async () => {
    const d = deps(async () => ({ reply: 'Done' }));
    Object.assign(d.surface, {
      readMedia: vi.fn().mockResolvedValue({ text: 'Visible text: invoice', asset_id: 'asset_2' }),
    });
    Object.assign(d.wasender, { downloadImage: vi.fn().mockResolvedValue(Buffer.from('image')) });
    await createRelayHandler(d)(
      msg({
        text: 'File this invoice',
        image: { url: 'https://media.example/file', mimetype: 'image/jpeg', mediaKey: 'key' },
      }),
    );
    expect(d.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'File this invoice',
        asset_ids: ['asset_2'],
        files: [{ name: 'Image', text: 'Visible text: invoice' }],
      }),
    );
  });
  it('allows another delivery after media processing fails', async () => {
    const d = deps(async () => ({ reply: 'Done' }));
    const readMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ text: 'Hello', asset_id: 'asset_1' });
    Object.assign(d.surface, { readMedia });
    Object.assign(d.wasender, { downloadAudio: vi.fn().mockResolvedValue(Buffer.from('audio')) });
    const handle = createRelayHandler(d),
      message = msg({
        text: null,
        audio: { url: 'https://media.example/file', mimetype: 'audio/ogg', mediaKey: 'key' },
      });
    await handle(message);
    await handle(message);
    expect(readMedia).toHaveBeenCalledTimes(2);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('forwards to the surface agent and relays the reply', async () => {
    const d = deps(async () => ({ reply: 'Here you go' }));
    const handle = createRelayHandler(d);
    await handle(msg());
    expect(d.sendMessage).toHaveBeenCalledWith({
      phone: '14155550100',
      thread_key: '14155550100',
      text: 'hello',
      message_id: 'm1',
    });
    expect(d.sendText).toHaveBeenCalledWith('+14155550100', 'Here you go');
  });

  it('de-dups on message id — a second delivery of the same id is a no-op', async () => {
    const d = deps(async () => ({ reply: 'ok' }));
    const handle = createRelayHandler(d);
    await handle(msg());
    await handle(msg());
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('an unaddressed group message is silently ignored — no agent call, no reply at all', async () => {
    const d = deps(async () => ({ reply: 'should not be called' }));
    const handle = createRelayHandler(d);
    await handle(msg({ isGroup: true, text: 'just chatting, no mention of the bot' }));
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it('an addressed group message ("pomegranate ...") reaches the agent with the trigger word stripped', async () => {
    const d = deps(async () => ({ reply: 'done' }));
    const handle = createRelayHandler(d);
    await handle(
      msg({
        isGroup: true,
        phone: '14155550100',
        replyTo: '120363412508870098@g.us',
        text: 'pomegranate what is the roadmap status?',
      }),
    );
    expect(d.sendMessage).toHaveBeenCalledWith({
      phone: '14155550100',
      thread_key: '14155550100',
      text: 'what is the roadmap status?',
      message_id: 'm1',
    });
    // Reply goes back into the GROUP (replyTo), not a DM to the sender.
    expect(d.sendText).toHaveBeenCalledWith('120363412508870098@g.us', 'done');
  });

  it('an addressed group message that is ONLY the trigger word still forwards non-empty text', async () => {
    const d = deps(async () => ({ reply: 'yes?' }));
    const handle = createRelayHandler(d);
    await handle(msg({ isGroup: true, text: 'pomegranate' }));
    expect(d.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/\S/) }),
    );
  });

  it('addressing works with an @-prefix too ("@pomegranate ...")', async () => {
    const d = deps(async () => ({ reply: 'done' }));
    const handle = createRelayHandler(d);
    await handle(msg({ isGroup: true, text: '@pomegranate ingest this' }));
    expect(d.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'ingest this' }));
  });

  it('an addressed group image reaches the agent, caption stripped of the trigger word', async () => {
    const d = deps(async () => ({ reply: 'done' }));
    const readMedia = vi.fn().mockResolvedValue({ text: 'a whiteboard', asset_id: 'asset_2' });
    const downloadImage = vi.fn().mockResolvedValue(Buffer.from('img'));
    Object.assign(d.surface, { readMedia });
    Object.assign(d.wasender, { downloadImage });
    await createRelayHandler(d)(
      msg({
        isGroup: true,
        replyTo: '120363412508870098@g.us',
        text: 'pomegranate file this',
        image: { url: 'https://media.example/i', mimetype: 'image/jpeg', mediaKey: 'key' },
      }),
    );
    expect(d.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'file this', asset_ids: ['asset_2'] }),
    );
    expect(d.sendText).toHaveBeenCalledWith('120363412508870098@g.us', 'done');
  });

  it('an unaddressed group voice note is dropped BEFORE any media download', async () => {
    // The address gate reads the message's own text/caption and runs ahead of
    // the download, so group chatter costs no transcription and stores no
    // asset. A bare voice note has no caption, so it can never be addressed.
    const d = deps(async () => ({ reply: 'should not be called' }));
    const readMedia = vi.fn();
    const downloadAudio = vi.fn();
    Object.assign(d.surface, { readMedia });
    Object.assign(d.wasender, { downloadAudio });
    await createRelayHandler(d)(
      msg({
        isGroup: true,
        text: null,
        replyTo: '120363412508870098@g.us',
        audio: { url: 'https://media.example/a', mimetype: 'audio/ogg', mediaKey: 'key' },
      }),
    );
    expect(downloadAudio).not.toHaveBeenCalled();
    expect(readMedia).not.toHaveBeenCalled();
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it('sends the unmapped reply text as-is when the server reports unmapped', async () => {
    const d = deps(async () => ({ reply: "I don't know who you are yet.", unmapped: true }));
    const handle = createRelayHandler(d);
    await handle(msg());
    expect(d.sendText).toHaveBeenCalledWith('+14155550100', "I don't know who you are yet.");
  });

  it('falls back to the error userMessage when the surface client throws a SurfaceError', async () => {
    const d = deps(async () => {
      throw new UpstreamError('Something went wrong reaching Pomegranate — try again.');
    });
    const handle = createRelayHandler(d);
    await handle(msg());
    expect(d.sendText).toHaveBeenCalledWith('+14155550100', 'Something went wrong reaching Pomegranate — try again.');
  });

  it('falls back to a generic message on a non-SurfaceError throw, and never lets it propagate', async () => {
    const d = deps(async () => {
      throw new Error('boom');
    });
    const handle = createRelayHandler(d);
    await expect(handle(msg())).resolves.toBeUndefined();
    expect(d.sendText).toHaveBeenCalledWith('+14155550100', 'Something went wrong — try again.');
  });

  it('swallows a failure to send the fallback reply itself', async () => {
    const sendText = vi.fn().mockRejectedValue(new Error('wasender down'));
    const relayDeps: RelayDeps = {
      surface: {
        sendMessage: vi.fn(async () => ({ reply: 'ok' }) as SurfaceMessageResult),
      } as unknown as SurfaceAgentClient,
      wasender: { sendText } as unknown as WasenderClient,
    };
    const handle = createRelayHandler(relayDeps);
    await expect(handle(msg())).resolves.toBeUndefined();
  });
});
