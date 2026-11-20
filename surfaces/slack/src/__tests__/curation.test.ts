/**
 * Tests for the Phase-1 curation surface: ingest/pending parsing, the
 * curation client methods (incl. 404/409 outcome mapping), pending Block Kit
 * formatting, and the button-click action pipeline.
 */
import { describe, it, expect } from 'vitest';
import { parseMention } from '../parse.js';
import { HttpPomegranateClient } from '../client.js';
import {
  formatIngest,
  formatPending,
  resolveCandidateInBlocks,
  candidateActionsBlockId,
  candidateSectionBlockId,
} from '../format.js';
import { createActionHandler } from '../actions.js';
import { buildActionContext } from '../slack-context.js';
import { parseConfig } from '../config.js';
import { BadCommand } from '../errors.js';
import type {
  ActionContext,
  CanonHandle,
  CandidateSummary,
  Config,
  ListCandidatesResult,
  PomegranateClient,
  ResolveOutcome,
} from '../types.js';

// ---------- parse ----------

describe('parseMention — ingest/pending grammar', () => {
  it('ingest without a from clause: subject is null, remainder is the payload', () => {
    const cmd = parseMention('<@BOT> ingest we decided to go upmarket', 'BOT');
    expect(cmd.verb).toBe('ingest');
    expect(cmd.subjectUserId).toBeNull();
    expect(cmd.remainder).toBe('we decided to go upmarket');
  });

  it('self-only verbs never route on `from @x`: it stays in the payload', () => {
    // ingest/pending/listen target the requester's OWN workspace, so a
    // `from <@U>` is content, not a routing clause — the subject is always null
    // and the mention is preserved verbatim in the remainder.
    const cmd = parseMention('<@BOT> ingest notes from <@U_ME>', 'BOT');
    expect(cmd.verb).toBe('ingest');
    expect(cmd.subjectUserId).toBeNull();
    expect(cmd.remainder).toBe('notes from <@U_ME>');
  });

  it('ingest of prose containing `from … @mention` is not misread as routing', () => {
    // Regression: "we both learn from the calls … @Alice" must ingest into
    // the requester's workspace, not be rejected as a foreign-workspace target.
    const cmd = parseMention(
      '<@BOT> ingest we both learn from the calls and <@U_ALICE> owns governance',
      'BOT',
    );
    expect(cmd.verb).toBe('ingest');
    expect(cmd.subjectUserId).toBeNull();
    expect(cmd.remainder).toContain('learn from the calls');
    expect(cmd.remainder).toContain('<@U_ALICE>');
  });

  it('a bare `from` with no mention inside ingest text is payload, not a clause', () => {
    const cmd = parseMention('<@BOT> ingest learnings from the offsite', 'BOT');
    expect(cmd.verb).toBe('ingest');
    expect(cmd.subjectUserId).toBeNull();
    expect(cmd.remainder).toBe('learnings from the offsite');
  });

  it('pending needs no payload and no from clause', () => {
    const cmd = parseMention('<@BOT> pending', 'BOT');
    expect(cmd.verb).toBe('pending');
    expect(cmd.subjectUserId).toBeNull();
    expect(cmd.remainder).toBe('');
  });

  it('`candidates` is an alias for pending', () => {
    expect(parseMention('<@BOT> candidates', 'BOT').verb).toBe('pending');
  });

  it('earliest verb keyword wins: ingest payload mentioning a review still ingests', () => {
    const cmd = parseMention(
      '<@BOT> ingest the board asked us to review the roadmap next quarter',
      'BOT',
    );
    expect(cmd.verb).toBe('ingest');
    expect(cmd.remainder).toContain('review the roadmap');
  });

  it('review still requires a from clause', () => {
    expect(() => parseMention('<@BOT> review some text', 'BOT')).toThrow(BadCommand);
  });

  it('DM style: commands parse without any bot mention', () => {
    expect(parseMention('pending', 'BOT').verb).toBe('pending');
    const ing = parseMention('ingest we moved the launch to October', 'BOT');
    expect(ing.verb).toBe('ingest');
    expect(ing.remainder).toBe('we moved the launch to October');
    expect(parseMention('listen every 12h', 'BOT').verb).toBe('listen');
  });
});

// ---------- client ----------

const canon: CanonHandle = {
  apiBaseUrl: 'http://test',
  token: 'TOK',
  workspaceId: 'ws',
  subjectUserId: 'u_subj',
};

function makeFakeFetch(opts: { status?: number; json?: unknown }) {
  const record: { last: { url: string; body: any; headers: any } | null } = { last: null };
  const status = opts.status ?? 200;
  const fetchImpl = (async (url: any, init: any) => {
    record.last = {
      url: String(url),
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => opts.json,
      text: async () => JSON.stringify(opts.json ?? ''),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, record };
}

describe('HttpPomegranateClient — curation methods', () => {
  it('ingest posts source/kind/ref to ingest_document', async () => {
    const { fetchImpl, record } = makeFakeFetch({
      json: { candidates: 2, document_id: 'doc_1' },
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const r = await client.ingest(canon, { pomegranateUserId: 'u_me' }, 'text', {
      sourceRef: 'slack-upload:plan.md',
    });
    expect(record.last!.url).toBe('http://test/mcp/tools/ingest_document');
    expect(record.last!.headers.Authorization).toBe('Bearer TOK');
    expect(record.last!.body).toMatchObject({
      source: 'text',
      source_kind: 'doc',
      source_ref: 'slack-upload:plan.md',
      on_behalf_of: 'u_me',
    });
    expect(r).toEqual({ candidates: 2, document_id: 'doc_1' });
  });

  it('listCandidates posts status pending with the limit', async () => {
    const { fetchImpl, record } = makeFakeFetch({
      json: { status: 'pending', total: 0, candidates: [] },
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const r = await client.listCandidates(canon, { pomegranateUserId: null }, { limit: 10 });
    expect(record.last!.url).toBe('http://test/mcp/tools/list_candidates');
    expect(record.last!.body).toMatchObject({ status: 'pending', limit: 10 });
    expect(r.total).toBe(0);
  });

  it('approveCandidate maps 200 → ok with node summary', async () => {
    const { fetchImpl, record } = makeFakeFetch({
      json: { ok: true, node_id: 'n_1', summary: 'Kill reseller program' },
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const r = await client.approveCandidate(canon, 'c_1');
    expect(record.last!.url).toBe('http://test/mcp/tools/approve_candidate');
    expect(record.last!.body).toEqual({ id: 'c_1' });
    expect(r).toEqual({ ok: true, node_id: 'n_1', summary: 'Kill reseller program' });
  });

  it('rejectCandidate maps 409 → already_resolved with upstream status', async () => {
    const { fetchImpl } = makeFakeFetch({
      status: 409,
      json: { error: 'already_resolved', status: 'approved' },
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const r = await client.rejectCandidate(canon, 'c_1');
    expect(r).toEqual({ ok: false, reason: 'already_resolved', status: 'approved' });
  });

  it('approveCandidate maps 404 → not_found', async () => {
    const { fetchImpl } = makeFakeFetch({ status: 404, json: { error: 'not_found' } });
    const client = new HttpPomegranateClient(fetchImpl);
    const r = await client.approveCandidate(canon, 'c_missing');
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ---------- format ----------

const CAND: CandidateSummary = {
  id: 'c_1',
  flag: 'red',
  type: 'decision',
  summary: 'Kill the reseller program',
  source_quote: 'we are killing the reseller program effective today',
  source_ref: 'doc',
  conflicts_with: 'dec-reseller-2025',
  reason: 'conflicts',
  created_at: '2026-06-01T00:00:00Z',
};

describe('formatPending / resolveCandidateInBlocks', () => {
  it('empty queue: friendly text, no blocks', () => {
    const r = formatPending({ status: 'pending', total: 0, candidates: [] });
    expect(r.text).toContain('Nothing pending');
    expect(r.blocks).toBeUndefined();
  });

  it('renders one section + one actions block per candidate, with ids wired', () => {
    const r = formatPending({ status: 'pending', total: 1, candidates: [CAND] });
    const blocks = r.blocks as Array<any>;
    const section = blocks.find((b) => b.block_id === candidateSectionBlockId('c_1'));
    const actions = blocks.find((b) => b.block_id === candidateActionsBlockId('c_1'));
    expect(section.text.text).toContain('Kill the reseller program');
    expect(section.text.text).toContain('conflicts with');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual([
      'cand_approve',
      'cand_reject',
    ]);
    expect(actions.elements[0].value).toBe('c_1');
  });

  it('notes the overflow when total > shown', () => {
    const r = formatPending({ status: 'pending', total: 12, candidates: [CAND] });
    expect(r.text).toContain('12');
    const blocks = r.blocks as Array<any>;
    expect(JSON.stringify(blocks.at(-1))).toContain('11 more');
  });

  it('resolveCandidateInBlocks drops the actions block and appends the line', () => {
    const r = formatPending({ status: 'pending', total: 1, candidates: [CAND] });
    const next = resolveCandidateInBlocks(
      r.blocks as unknown[],
      'c_1',
      ':white_check_mark: Approved',
    ) as Array<any>;
    expect(next.find((b) => b.block_id === candidateActionsBlockId('c_1'))).toBeUndefined();
    const section = next.find((b) => b.block_id === candidateSectionBlockId('c_1'));
    expect(section.text.text).toContain(':white_check_mark: Approved');
    // other blocks untouched
    expect(next.length).toBe((r.blocks as unknown[]).length - 1);
  });
});

describe('formatIngest', () => {
  it('reports the pending count and the filename when present', () => {
    expect(formatIngest({ candidates: 3, document_id: 'd' }, 'plan.md')).toContain('*plan.md*');
    expect(formatIngest({ candidates: 3, document_id: 'd' })).toContain('3 proposed change');
    expect(formatIngest({ candidates: 0, document_id: 'd' })).toContain('already covered');
  });
});

// ---------- action pipeline ----------

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
const env = { TOK_ALICE: 'secret' };

interface FakeActionCtx extends ActionContext {
  replies: string[];
  updates: number;
  lastBlocks: unknown[] | null;
}

function makeActionCtx(opts: {
  actorUserId?: string;
  candidateId?: string;
  action?: 'approve' | 'reject';
  blocks?: unknown[];
}): FakeActionCtx {
  const replies: string[] = [];
  const sourceBlocks =
    opts.blocks ??
    (formatPending({ status: 'pending', total: 1, candidates: [CAND] }).blocks as unknown[]);
  const ctx: FakeActionCtx = {
    teamId: 'T1',
    actorUserId: opts.actorUserId ?? 'U_ALICE',
    candidateId: opts.candidateId ?? 'c_1',
    action: opts.action ?? 'approve',
    replies,
    updates: 0,
    lastBlocks: null,
    async reply(text: string) {
      replies.push(text);
    },
    async updateMessageBlocks(mutate) {
      ctx.updates += 1;
      ctx.lastBlocks = mutate(sourceBlocks);
    },
  };
  return ctx;
}

function makeResolveClient(outcome: ResolveOutcome): PomegranateClient & {
  approveIds: string[];
  rejectIds: string[];
} {
  const approveIds: string[] = [];
  const rejectIds: string[] = [];
  return {
    approveIds,
    rejectIds,
    async review() {
      throw new Error('unused');
    },
    async getContext() {
      throw new Error('unused');
    },
    async ingest() {
      throw new Error('unused');
    },
    async listCandidates(): Promise<ListCandidatesResult> {
      throw new Error('unused');
    },
    async approveCandidate(_c, id) {
      approveIds.push(id);
      return outcome;
    },
    async rejectCandidate(_c, id) {
      rejectIds.push(id);
      return outcome;
    },
  };
}

describe('createActionHandler', () => {
  it('approve: resolves via the clicker\'s own canon and rewrites the message', async () => {
    const client = makeResolveClient({ ok: true, node_id: 'n_1' });
    const handle = createActionHandler({ config, client, env });
    const ctx = makeActionCtx({ action: 'approve' });

    await handle(ctx);

    expect(client.approveIds).toEqual(['c_1']);
    expect(ctx.updates).toBe(1);
    const json = JSON.stringify(ctx.lastBlocks);
    expect(json).toContain('Approved');
    expect(json).toContain('U_ALICE');
    expect(json).not.toContain(candidateActionsBlockId('c_1'));
    expect(ctx.replies).toEqual([]);
  });

  it('reject: same shape, rejected line', async () => {
    const client = makeResolveClient({ ok: true });
    const handle = createActionHandler({ config, client, env });
    const ctx = makeActionCtx({ action: 'reject' });

    await handle(ctx);

    expect(client.rejectIds).toEqual(['c_1']);
    expect(JSON.stringify(ctx.lastBlocks)).toContain('Rejected');
  });

  it('already_resolved: informational rewrite, no error reply', async () => {
    const client = makeResolveClient({
      ok: false,
      reason: 'already_resolved',
      status: 'approved',
    });
    const handle = createActionHandler({ config, client, env });
    const ctx = makeActionCtx({});

    await handle(ctx);

    expect(JSON.stringify(ctx.lastBlocks)).toContain('Already approved');
    expect(ctx.replies).toEqual([]);
  });

  it('not_found: replies with a refresh hint', async () => {
    const client = makeResolveClient({ ok: false, reason: 'not_found' });
    const handle = createActionHandler({ config, client, env });
    const ctx = makeActionCtx({});

    await handle(ctx);

    expect(ctx.replies[0]).toContain('pending');
  });

  it('unmapped clicker: replies with the not-mapped message, never calls upstream', async () => {
    const client = makeResolveClient({ ok: true });
    const handle = createActionHandler({ config, client, env });
    const ctx = makeActionCtx({ actorUserId: 'U_GHOST' });

    await handle(ctx);

    expect(client.approveIds).toEqual([]);
    expect(ctx.replies).toHaveLength(1);
  });
});

// ---------- Bolt action adaptation ----------

describe('buildActionContext', () => {
  const api = {
    reactions: { add: async () => ({}) },
    chat: {
      postMessage: async () => ({}),
      update: async () => ({}),
    },
  };

  it('builds a context from a well-formed block_actions body', () => {
    const ctx = buildActionContext({
      body: {
        team: { id: 'T1' },
        user: { id: 'U_ALICE' },
        channel: { id: 'C1' },
        message: { ts: '1.0', blocks: [] },
        actions: [{ action_id: 'cand_approve', value: 'c_1' }],
      },
      api,
    });
    expect(ctx).toMatchObject({
      teamId: 'T1',
      actorUserId: 'U_ALICE',
      candidateId: 'c_1',
      action: 'approve',
    });
  });

  it('returns null for unknown action ids or missing values', () => {
    expect(
      buildActionContext({
        body: {
          team: { id: 'T1' },
          user: { id: 'U' },
          channel: { id: 'C' },
          message: { ts: '1.0' },
          actions: [{ action_id: 'something_else', value: 'c_1' }],
        },
        api,
      }),
    ).toBeNull();
    expect(
      buildActionContext({
        body: {
          team: { id: 'T1' },
          user: { id: 'U' },
          channel: { id: 'C' },
          message: { ts: '1.0' },
          actions: [{ action_id: 'cand_approve' }],
        },
        api,
      }),
    ).toBeNull();
  });
});
