import { describe, it, expect } from 'vitest';
import { createMentionHandler } from '../handlers.js';
import { parseConfig } from '../config.js';
import { formatReview, formatGetContext, formatIngest } from '../format.js';
import { USAGE_HINT, SubjectNotMapped, EmptyPayload, UpstreamError } from '../errors.js';
import type {
  MentionContext,
  SlackFileRef,
  PomegranateClient,
  CanonHandle,
  RequesterRef,
  ReviewResult,
  QueryResult,
  IngestResult,
  ListCandidatesResult,
  Config,
} from '../types.js';

const BOT = 'BOT';

const config: Config = parseConfig({
  teams: [{ slack_team_id: 'T1', pomegranate_api_url: 'http://localhost:3000' }],
  users: [
    {
      slack_team_id: 'T1',
      slack_user_id: 'U_ALICE',
      pomegranate_user_id: 'u_alice',
      pomegranate_workspace_id: 'ws_alice',
      mcp_token_env: 'TOK_ALICE',
    },
  ],
});

const env = { TOK_ALICE: 'alice-secret' };

// ---- fake MentionContext ----
interface FakeCtxOptions {
  text: string;
  files?: SlackFileRef[];
  requesterUserId?: string;
  teamId?: string;
  eventId?: string;
  fileText?: string;
}

interface FakeCtx extends MentionContext {
  reacts: string[];
  replies: string[];
  replyBlocks: Array<unknown[] | undefined>;
}

function makeCtx(opts: FakeCtxOptions): FakeCtx {
  const reacts: string[] = [];
  const replies: string[] = [];
  const replyBlocks: Array<unknown[] | undefined> = [];
  return {
    text: opts.text,
    files: opts.files ?? [],
    requesterUserId: opts.requesterUserId ?? 'U_ALICE',
    teamId: opts.teamId ?? 'T1',
    channelId: 'C_TEST',
    threadKey: 'C_TEST:1.1',
    eventId: opts.eventId ?? 'E_DEFAULT',
    reacts,
    replies,
    replyBlocks,
    async react(emoji: string) {
      reacts.push(emoji);
    },
    async reply(text: string, blocks?: unknown[]) {
      replies.push(text);
      replyBlocks.push(blocks);
    },
    async replyEditable(text: string) {
      replies.push(text);
      return async (newText: string, blocks?: unknown[]) => {
        replies.push(newText);
        replyBlocks.push(blocks);
      };
    },
    async fetchFileText() {
      return opts.fileText ?? '';
    },
  };
}

// ---- stub PomegranateClient ----
interface ReviewCall {
  canon: CanonHandle;
  req: RequesterRef;
  deliverable: string;
}
interface GetContextCall {
  canon: CanonHandle;
  req: RequesterRef;
  payload: string;
}

interface IngestCall {
  canon: CanonHandle;
  req: RequesterRef;
  source: string;
  opts?: { sourceRef?: string; sourceKind?: string };
}

interface StubClient extends PomegranateClient {
  reviewCalls: ReviewCall[];
  getContextCalls: GetContextCall[];
  ingestCalls: IngestCall[];
  listCalls: number;
}

const CANNED_REVIEW: ReviewResult = {
  id: 'rev_1',
  findings: [
    {
      category: 'positioning',
      flag: 'red',
      node_id: 'n_1',
      quote_from_deliverable: 'cheapest tool on the market',
      summary: 'Contradicts the enterprise positioning.',
    },
  ],
};

const CANNED_QUERY: QueryResult = {
  answer: 'The roadmap is enterprise-first, anchored to SSO.',
  cited_node_ids: ['n_2', 'n_3'],
  has_answer: true,
};

const CANNED_INGEST: IngestResult = { candidates: 3, document_id: 'doc_1' };

const CANNED_PENDING: ListCandidatesResult = {
  status: 'pending',
  total: 1,
  candidates: [
    {
      id: 'c_1',
      flag: 'yellow',
      type: 'decision',
      summary: 'Kill the reseller program',
      source_quote: 'we are killing the reseller program',
      source_ref: 'doc',
      conflicts_with: null,
      reason: null,
      created_at: '2026-06-01T00:00:00Z',
    },
  ],
};

function makeClient(opts: { throwUpstream?: boolean } = {}): StubClient {
  const reviewCalls: ReviewCall[] = [];
  const getContextCalls: GetContextCall[] = [];
  const ingestCalls: IngestCall[] = [];
  const stub: StubClient = {
    reviewCalls,
    getContextCalls,
    ingestCalls,
    listCalls: 0,
    async review(canon, req, deliverable) {
      reviewCalls.push({ canon, req, deliverable });
      if (opts.throwUpstream) {
        throw new UpstreamError(
          'Something went wrong reaching Pomegranate — try again.',
          'simulated upstream failure',
        );
      }
      return CANNED_REVIEW;
    },
    async getContext(canon, req, payload) {
      getContextCalls.push({ canon, req, payload });
      return CANNED_QUERY;
    },
    async ingest(canon, req, source, o) {
      ingestCalls.push({ canon, req, source, opts: o });
      return CANNED_INGEST;
    },
    async listCandidates() {
      stub.listCalls += 1;
      return CANNED_PENDING;
    },
    async approveCandidate() {
      return { ok: true };
    },
    async rejectCandidate() {
      return { ok: true };
    },
  };
  return stub;
}

describe('createMentionHandler', () => {
  it('review happy path', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> review the launch email from <@U_ALICE>' });

    await handle(ctx);

    expect(client.reviewCalls).toHaveLength(1);
    expect(client.reviewCalls[0]!.deliverable).toBe('the launch email');
    expect(client.getContextCalls).toHaveLength(0);
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toBe(formatReview(CANNED_REVIEW, '<@U_ALICE>'));
  });

  it('getcontext happy path', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> GetContext about roadmap from <@U_ALICE>' });

    await handle(ctx);

    expect(client.getContextCalls).toHaveLength(1);
    expect(client.getContextCalls[0]!.payload).toBe('roadmap');
    expect(client.reviewCalls).toHaveLength(0);
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]).toBe(formatGetContext(CANNED_QUERY, '<@U_ALICE>'));
  });

  it('unparseable command replies with USAGE_HINT and never reacts or calls the client', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> hello' });

    await handle(ctx);

    expect(ctx.replies).toEqual([USAGE_HINT]);
    expect(ctx.reacts).toEqual([]);
    expect(client.reviewCalls).toHaveLength(0);
    expect(client.getContextCalls).toHaveLength(0);
  });

  it('unmapped subject replies with SubjectNotMapped message, no react, no client call', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> review x from <@U_GHOST>' });

    await handle(ctx);

    expect(ctx.reacts).toEqual([]);
    expect(client.reviewCalls).toHaveLength(0);
    expect(ctx.replies).toHaveLength(1);
    const expected = new SubjectNotMapped(
      `I don't have <@U_GHOST> mapped to a Pomegranate account.`,
    );
    expect(ctx.replies[0]).toBe(expected.userMessage);
  });

  it('empty payload reacts but replies with EmptyPayload message and never calls the client', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> review from <@U_ALICE>', files: [] });

    await handle(ctx);

    expect(ctx.reacts).toEqual([':eyes:']);
    expect(client.reviewCalls).toHaveLength(0);
    expect(ctx.replies).toHaveLength(1);
    const expected = new EmptyPayload(
      "I didn't find anything to look at — attach a `.txt`/`.md` file or paste the text into your message.",
    );
    expect(ctx.replies[0]).toBe(expected.userMessage);
  });

  it('de-dups on eventId — invoking twice with the same id calls the client once', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> review the launch email from <@U_ALICE>',
      eventId: 'E_DUP',
    });

    await handle(ctx);
    await handle(ctx);

    expect(client.reviewCalls).toHaveLength(1);
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toHaveLength(1);
  });

  it('upstream failure replies with the UpstreamError userMessage', async () => {
    const client = makeClient({ throwUpstream: true });
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> review the launch email from <@U_ALICE>' });

    await handle(ctx);

    expect(client.reviewCalls).toHaveLength(1);
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toEqual([
      'Something went wrong reaching Pomegranate — try again.',
    ]);
  });

  // ---- ingest (self-workspace write path) ----

  it('ingest happy path: no `from` clause needed, requester is the subject', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> ingest we are killing the reseller program',
      requesterUserId: 'U_ALICE',
    });

    await handle(ctx);

    expect(client.ingestCalls).toHaveLength(1);
    expect(client.ingestCalls[0]!.source).toBe('we are killing the reseller program');
    expect(client.ingestCalls[0]!.canon.workspaceId).toBe('ws_alice');
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toEqual([formatIngest(CANNED_INGEST)]);
  });

  it('ingest with a file: file text wins, source_ref carries the filename', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> ingest',
      files: [{ name: 'plan.md', url_private: 'https://x' }],
      fileText: '# Plan\nkill the reseller program',
    });

    await handle(ctx);

    expect(client.ingestCalls).toHaveLength(1);
    expect(client.ingestCalls[0]!.source).toContain('kill the reseller program');
    expect(client.ingestCalls[0]!.opts?.sourceRef).toBe('slack-upload:plan.md');
    expect(ctx.replies).toEqual([formatIngest(CANNED_INGEST, 'plan.md')]);
  });

  it('ingest of prose containing `from <@x>` goes to the requester\'s own workspace, mention intact', async () => {
    // Regression: a `from <@x>` buried in ingest text must NOT be read as a
    // foreign-workspace routing clause. It stays in the payload and the source
    // lands in the requester's OWN workspace.
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> ingest we both learn from the calls and <@U_OTHER> owns governance',
      requesterUserId: 'U_ALICE',
    });

    await handle(ctx);

    expect(client.ingestCalls).toHaveLength(1);
    expect(client.ingestCalls[0]!.canon.workspaceId).toBe('ws_alice');
    expect(client.ingestCalls[0]!.source).toContain('learn from the calls');
    expect(client.ingestCalls[0]!.source).toContain('<@U_OTHER>');
  });

  it('ingest from an unmapped requester gets the not-mapped message', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> ingest some text',
      requesterUserId: 'U_GHOST',
    });

    await handle(ctx);

    expect(client.ingestCalls).toHaveLength(0);
    expect(ctx.replies[0]).toContain("don't have <@U_GHOST> mapped");
  });

  // ---- pending (self-workspace curation path) ----

  it('pending happy path: lists candidates with Block Kit buttons, no payload needed', async () => {
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({ text: '<@BOT> pending', requesterUserId: 'U_ALICE' });

    await handle(ctx);

    expect(client.listCalls).toBe(1);
    expect(ctx.reacts).toEqual([':eyes:']);
    expect(ctx.replies).toHaveLength(1);
    const blocks = ctx.replyBlocks[0]!;
    expect(blocks).toBeTruthy();
    const actionBlocks = (blocks as Array<{ type: string }>).filter(
      (b) => b.type === 'actions',
    );
    expect(actionBlocks).toHaveLength(1);
  });

  it('pending ignores a `from <@x>` clause and lists the requester\'s own queue', async () => {
    // pending is self-only: `from <@x>` never routes, so a mapped requester
    // still sees THEIR queue rather than being rejected.
    const client = makeClient();
    const handle = createMentionHandler({ config, client, botUserId: BOT, env });
    const ctx = makeCtx({
      text: '<@BOT> pending from <@U_OTHER>',
      requesterUserId: 'U_ALICE',
    });

    await handle(ctx);

    expect(client.listCalls).toBe(1);
    expect(ctx.replies).toHaveLength(1);
  });
});
