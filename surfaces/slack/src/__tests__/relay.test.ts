import { describe, it, expect } from 'vitest';
import { createRelayMentionHandler, matchListenVerb } from '../relay.js';
import { SurfaceAgentClient } from '../surface-client.js';
import { SubscriptionStore } from '../subscriptions.js';
import { UpstreamError } from '../errors.js';
import type { MentionContext, SlackFileRef, SurfaceMessageResult } from '../types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fake relay client recording message payloads. */
function fakeSurface(result: Partial<SurfaceMessageResult> = {}, fail = false) {
  const calls: Array<{ apiBaseUrl: string; payload: unknown }> = [];
  const surface = {
    async sendMessage(apiBaseUrl: string, payload: unknown): Promise<SurfaceMessageResult> {
      calls.push({ apiBaseUrl, payload });
      if (fail) throw new UpstreamError('Something went wrong reaching Pomegranate — try again.', 'HTTP 503');
      return { reply: 'The timeline is Q3.', ...result };
    },
    async invokeAction() {
      throw new Error('not used here');
    },
  } as unknown as SurfaceAgentClient;
  return { surface, calls };
}

interface FakeCtx extends MentionContext {
  reacts: string[];
  posts: string[];
  updates: string[];
}

function makeCtx(opts: { text: string; files?: SlackFileRef[]; fileText?: string; eventId?: string }): FakeCtx {
  const reacts: string[] = [];
  const posts: string[] = [];
  const updates: string[] = [];
  return {
    text: opts.text,
    files: opts.files ?? [],
    requesterUserId: 'U_SAM',
    teamId: 'T1',
    channelId: 'C_REL',
    threadKey: 'C_REL:42.1',
    eventId: opts.eventId ?? 'E1',
    reacts,
    posts,
    updates,
    async react(e: string) {
      reacts.push(e);
    },
    async reply(t: string) {
      posts.push(t);
    },
    async replyEditable(t: string) {
      posts.push(t);
      return async (nt: string) => {
        updates.push(nt);
      };
    },
    async fetchFileText() {
      return opts.fileText ?? '';
    },
  };
}

function deps(surface: SurfaceAgentClient, subscriptions?: SubscriptionStore) {
  return {
    surface,
    apiBaseUrlFor: () => 'https://app.example',
    botUserId: 'U_BOT',
    subscriptions,
  };
}

describe('relay mention handler', () => {
  it('sends natural language to the agent and posts its reply', async () => {
    const { surface, calls } = fakeSurface();
    const handle = createRelayMentionHandler(deps(surface));
    const ctx = makeCtx({ text: '<@U_BOT> what is the timeline for feature x?' });
    await handle(ctx);

    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.posts).toEqual(['The timeline is Q3.']);
    expect(ctx.updates).toEqual([]);
    expect(calls).toHaveLength(1);
    const payload = calls[0]!.payload as Record<string, unknown>;
    expect(payload.team_id).toBe('T1');
    expect(payload.slack_user_id).toBe('U_SAM');
    expect(payload.thread_key).toBe('C_REL:42.1');
    // Bot mention stripped from what the agent reads.
    expect(payload.text).toBe('what is the timeline for feature x?');
  });

  it('de-dups Slack retries on the event id', async () => {
    const { surface, calls } = fakeSurface();
    const handle = createRelayMentionHandler(deps(surface));
    await handle(makeCtx({ text: 'hi there', eventId: 'SAME' }));
    await handle(makeCtx({ text: 'hi there', eventId: 'SAME' }));
    expect(calls).toHaveLength(1);
  });

  it('handles listen/stop-listening locally — the agent is never called', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-subs-'));
    const store = new SubscriptionStore(join(dir, 'subs.json'));
    const { surface, calls } = fakeSurface();
    const handle = createRelayMentionHandler(deps(surface, store));

    await handle(makeCtx({ text: '<@U_BOT> listen every 12h', eventId: 'L1' }));
    expect(store.get('T1', 'C_REL', 'U_SAM')).toBeTruthy();
    await handle(makeCtx({ text: '<@U_BOT> stop listening', eventId: 'L2' }));
    expect(store.get('T1', 'C_REL', 'U_SAM')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('ships attached .md file text alongside the message', async () => {
    const { surface, calls } = fakeSurface();
    const handle = createRelayMentionHandler(deps(surface));
    const ctx = makeCtx({
      text: '<@U_BOT> ingest this',
      files: [{ name: 'roadmap.md', url_private: 'https://x' }],
      fileText: '# Roadmap\nQ3: feature x',
    });
    await handle(ctx);
    const payload = calls[0]!.payload as Record<string, unknown>;
    expect(payload.files).toEqual([{ name: 'roadmap.md', text: '# Roadmap\nQ3: feature x' }]);
  });

  it('an unsupported file gets the friendly payload error, agent untouched', async () => {
    const { surface, calls } = fakeSurface();
    const handle = createRelayMentionHandler(deps(surface));
    const ctx = makeCtx({
      text: '<@U_BOT> ingest this',
      files: [{ name: 'deck.pdf', url_private: 'https://x' }],
    });
    await handle(ctx);
    expect(calls).toHaveLength(0);
    expect(ctx.posts.join(' ')).toContain("can't read");
  });

  it('an upstream failure posts the friendly error', async () => {
    const { surface } = fakeSurface({}, true);
    const handle = createRelayMentionHandler(deps(surface));
    const ctx = makeCtx({ text: '<@U_BOT> hello' });
    await handle(ctx);
    expect(ctx.posts[0]).toContain('Something went wrong');
    expect(ctx.updates).toEqual([]);
  });
});

describe('matchListenVerb', () => {
  it('recognizes the three listen verbs and nothing else', () => {
    expect(matchListenVerb('<@U_B> listen every 30m', 'U_B')?.verb).toBe('listen');
    expect(matchListenVerb('pomegranate stop listening', 'U_B')?.verb).toBe('stoplisten');
    expect(matchListenVerb('@pomegranate listening?', 'U_B')?.verb).toBe('listening');
    expect(matchListenVerb('what are we listening to on spotify', 'U_B')?.verb).toBe('listening');
    expect(matchListenVerb('what is the plan for q3', 'U_B')).toBeNull();
    expect(matchListenVerb('review this from @x', 'U_B')).toBeNull();
  });

  it('passes the interval remainder through', () => {
    expect(matchListenVerb('listen every 12h', undefined)?.remainder).toBe('every 12h');
  });
});
