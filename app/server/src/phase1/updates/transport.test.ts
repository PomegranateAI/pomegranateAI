/**
 * SlackTransport (spec §7 / U3). Posts via chat.postMessage over HTTPS with a
 * bot token; a Slack user id opens a DM first, a channel id/name posts directly.
 * Exercised with a fake fetch — no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { SlackTransport, slackTokenFromEnv } from './transport.js';

function fakeFetch(handlers: Record<string, unknown>) {
  const calls: Array<{ method: string; body: any }> = [];
  const impl = vi.fn(async (url: string, init: any) => {
    const method = url.split('/api/')[1]!;
    calls.push({ method, body: JSON.parse(init.body) });
    const json = handlers[method] ?? { ok: true };
    return { ok: true, json: async () => json } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('SlackTransport', () => {
  it('opens a DM for a user id, then posts Block Kit with a link button', async () => {
    const { impl, calls } = fakeFetch({
      'conversations.open': { ok: true, channel: { id: 'D999' } },
      'chat.postMessage': { ok: true },
    });
    const t = new SlackTransport('xoxb-test', impl);
    await t.send({ to: 'U123', title: 'Launch moved', body: 'Acme moved its launch.', link: 'https://x/updates/upd_1' });

    expect(calls[0]!.method).toBe('conversations.open');
    expect(calls[0]!.body.users).toBe('U123');
    const post = calls[1]!;
    expect(post.method).toBe('chat.postMessage');
    expect(post.body.channel).toBe('D999'); // the opened DM
    // header + section + actions(button with the link)
    const types = post.body.blocks.map((b: any) => b.type);
    expect(types).toContain('header');
    expect(types).toContain('section');
    const actions = post.body.blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements[0].url).toBe('https://x/updates/upd_1');
    expect(post.body.text).toContain('Launch moved'); // notification fallback
  });

  it('posts straight to a channel id without opening a DM', async () => {
    const { impl, calls } = fakeFetch({ 'chat.postMessage': { ok: true } });
    const t = new SlackTransport('xoxb-test', impl);
    await t.send({ to: 'C42', title: 'T', body: 'B' });
    expect(calls.map((c) => c.method)).toEqual(['chat.postMessage']);
    expect(calls[0]!.body.channel).toBe('C42');
  });

  it('throws when Slack returns an API error', async () => {
    const { impl } = fakeFetch({ 'chat.postMessage': { ok: false, error: 'channel_not_found' } });
    const t = new SlackTransport('xoxb-test', impl);
    await expect(t.send({ to: 'C42', title: 'T', body: 'B' })).rejects.toThrow(/channel_not_found/);
  });

  it('reads the bot token from env, preferring the surface SLACK_BOT_TOKEN', () => {
    expect(slackTokenFromEnv({ SLACK_BOT_TOKEN: ' xoxb-surface ' } as any)).toBe('xoxb-surface');
    // SLACK_BOT_TOKEN wins over the pomegranate-namespaced override.
    expect(
      slackTokenFromEnv({ SLACK_BOT_TOKEN: 'xoxb-surface', POMEGRANATE_SLACK_TOKEN: 'xoxb-a' } as any),
    ).toBe('xoxb-surface');
    expect(slackTokenFromEnv({ POMEGRANATE_SLACK_TOKEN: 'xoxb-a' } as any)).toBe('xoxb-a');
    expect(slackTokenFromEnv({ UPDATES_SLACK_TOKEN: 'xoxb-b' } as any)).toBe('xoxb-b');
    expect(slackTokenFromEnv({} as any)).toBeNull();
  });
});
