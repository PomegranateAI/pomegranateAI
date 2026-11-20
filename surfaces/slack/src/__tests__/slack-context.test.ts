import { describe, it, expect } from 'vitest';
import { buildMentionContext } from '../slack-context.js';
import type { SlackApi, SlackEventEnvelope } from '../slack-context.js';
import { FileFetchError } from '../errors.js';

/** Build a fake `fetch` that returns one canned response. */
function fetchReturning(resp: {
  ok?: boolean;
  status?: number;
  contentType?: string;
  body?: string;
}): typeof fetch {
  return (async () => ({
    ok: resp.ok ?? true,
    status: resp.status ?? 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? resp.contentType ?? '' : null) },
    text: async () => resp.body ?? '',
  })) as unknown as typeof fetch;
}

interface ReactionCall {
  channel: string;
  timestamp: string;
  name: string;
}
interface PostMessageCall {
  channel: string;
  thread_ts?: string;
  text: string;
  username?: string;
}

/** A fake Slack Web API that records the args it was called with. */
function makeFakeApi() {
  const reactions: ReactionCall[] = [];
  const messages: PostMessageCall[] = [];
  const api: SlackApi = {
    reactions: {
      async add(args) {
        reactions.push(args);
        return {};
      },
    },
    chat: {
      async postMessage(args) {
        messages.push(args);
        return {};
      },
    },
  };
  return { api, reactions, messages };
}

const baseEvent: SlackEventEnvelope = {
  text: '<@U_BOT> review from <@U_ALICE>',
  user: 'U_REQ',
  team: 'T_TEAM',
  files: [
    { name: 'prd.md', mimetype: 'text/markdown', url_private: 'https://files/prd', size: 1234 },
    { name: 'notes.txt', size: 56 },
  ],
  ts: '1700000000.000100',
  thread_ts: '1700000000.000050',
  channel: 'C_CHAN',
};

describe('buildMentionContext', () => {
  it('maps the scalar fields onto the MentionContext', () => {
    const { api } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    expect(ctx.text).toBe('<@U_BOT> review from <@U_ALICE>');
    expect(ctx.requesterUserId).toBe('U_REQ');
    expect(ctx.teamId).toBe('T_TEAM');
    expect(ctx.eventId).toBe('Ev123');
  });

  it('maps files (name + size) into SlackFileRefs', () => {
    const { api } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    expect(ctx.files).toHaveLength(2);
    expect(ctx.files[0]?.name).toBe('prd.md');
    expect(ctx.files[0]?.size).toBe(1234);
    expect(ctx.files[1]?.name).toBe('notes.txt');
    expect(ctx.files[1]?.size).toBe(56);
  });

  it('defaults files to an empty array when absent', () => {
    const { api } = makeFakeApi();
    const { files: _files, ...rest } = baseEvent;
    const ctx = buildMentionContext({
      event: rest,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });
    expect(ctx.files).toEqual([]);
  });

  it('react() strips colons and uses the event channel + ts', async () => {
    const { api, reactions } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    await ctx.react(':eyes:');
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toEqual({
      channel: 'C_CHAN',
      timestamp: '1700000000.000100',
      name: 'eyes',
    });
  });

  it('reply() posts to the thread_ts when present', async () => {
    const { api, messages } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    await ctx.reply('hi');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      channel: 'C_CHAN',
      thread_ts: '1700000000.000050',
      text: 'hi',
    });
  });

  it('reply() falls back to event.ts when thread_ts is absent', async () => {
    const { api, messages } = makeFakeApi();
    const { thread_ts: _t, ...rest } = baseEvent;
    const ctx = buildMentionContext({
      event: rest,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    await ctx.reply('hi');
    expect(messages[0]?.thread_ts).toBe('1700000000.000100');
  });

  it('reply() can show the user-chosen bot name', async () => {
    const { api, messages } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    await ctx.reply('Ready.', undefined, 'Mango');
    expect(messages[0]?.username).toBe('Mango');
  });

  it('threadKey uses the DM channel id for DMs without thread_ts', () => {
    const { api } = makeFakeApi();
    const dmEvent: SlackEventEnvelope = {
      ...baseEvent,
      channel: 'D_TEST',
      thread_ts: undefined,
    };
    const ctx = buildMentionContext({
      event: dmEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    expect(ctx.threadKey).toBe('D_TEST:D_TEST');
  });

  it('threadKey uses the DM channel id for DMs even when thread_ts is present', () => {
    const { api } = makeFakeApi();
    const dmEvent: SlackEventEnvelope = {
      ...baseEvent,
      channel: 'D_TEST',
      thread_ts: '1700000000.000200',
    };
    const ctx = buildMentionContext({
      event: dmEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });

    expect(ctx.threadKey).toBe('D_TEST:D_TEST');
  });

  it('fetchFileText() GETs url_private with a bearer auth header', async () => {
    const { api } = makeFakeApi();
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth = headers['Authorization'];
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/markdown' },
        text: async () => 'file body',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
      fetchImpl: fakeFetch,
    });

    const text = await ctx.fetchFileText({ name: 'prd.md', url_private: 'https://files/prd' });
    expect(text).toBe('file body');
    expect(capturedUrl).toBe('https://files/prd');
    expect(capturedAuth).toBe('Bearer xoxb-test');
  });

  it('fetchFileText() returns empty string when there is no url_private', async () => {
    const { api } = makeFakeApi();
    const ctx = buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
    });
    expect(await ctx.fetchFileText({ name: 'inline.txt' })).toBe('');
  });

  const ctxWith = (fetchImpl: typeof fetch) => {
    const { api } = makeFakeApi();
    return buildMentionContext({
      event: baseEvent,
      teamId: 'T_TEAM',
      eventId: 'Ev123',
      api,
      botToken: 'xoxb-test',
      fetchImpl,
    });
  };

  it('fetchFileText() throws FileFetchError on a non-OK response', async () => {
    const ctx = ctxWith(fetchReturning({ ok: false, status: 403, contentType: 'text/html', body: '' }));
    await expect(
      ctx.fetchFileText({ name: 'prd.md', url_private: 'https://files/prd' }),
    ).rejects.toThrowError(FileFetchError);
  });

  it('fetchFileText() rejects a Slack HTML page masquerading as the file (missing files:read)', async () => {
    // The exact failure mode we hit in production: 200 OK, but the body is
    // Slack's sign-in/app-shell HTML, not the file.
    const ctx = ctxWith(
      fetchReturning({
        ok: true,
        contentType: 'text/html; charset=utf-8',
        body: '<!DOCTYPE html><html><head><script>/* slack-edge.com */</script></head></html>',
      }),
    );
    await expect(
      ctx.fetchFileText({ name: 'prd.md', url_private: 'https://files/prd' }),
    ).rejects.toThrowError(FileFetchError);
  });

  it('fetchFileText() body-sniffs HTML when no content-type is present', async () => {
    const ctx = ctxWith(fetchReturning({ ok: true, contentType: '', body: '  <html><body>nope</body></html>' }));
    await expect(
      ctx.fetchFileText({ name: 'prd.md', url_private: 'https://files/prd' }),
    ).rejects.toThrowError(FileFetchError);
  });

  it('fetchFileText() accepts a real text file whose body merely mentions <html>', async () => {
    // A legit markdown file with a proper content-type is NOT rejected even if
    // its content references HTML — body-sniffing only applies when no
    // content-type is present.
    const ctx = ctxWith(
      fetchReturning({ ok: true, contentType: 'text/markdown', body: 'Use the <html> tag like this.' }),
    );
    expect(
      await ctx.fetchFileText({ name: 'prd.md', url_private: 'https://files/prd' }),
    ).toBe('Use the <html> tag like this.');
  });
});
