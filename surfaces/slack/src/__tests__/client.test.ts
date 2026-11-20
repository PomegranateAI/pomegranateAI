import { describe, it, expect } from 'vitest';
import { HttpPomegranateClient, getContextQuestion } from '../client.js';
import { UpstreamError } from '../errors.js';
import type { CanonHandle, RequesterRef } from '../types.js';

const canon: CanonHandle = {
  apiBaseUrl: 'http://test',
  token: 'TOK',
  workspaceId: 'ws',
  subjectUserId: 'u_subj',
};

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * Build a fake `fetch` that records the last call and returns a configurable
 * Response. We construct a plain object with `ok`/`status`/`json`/`text` rather
 * than the global `Response` so we can hand back arbitrary parsed JSON without
 * round-tripping through a real body.
 */
function makeFakeFetch(opts: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
}) {
  const record: { last: RecordedCall | null } = { last: null };
  const fetchImpl = (async (url: any, init: any) => {
    record.last = {
      url: String(url),
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => opts.json,
      text: async () => opts.text ?? '',
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, record };
}

describe('HttpPomegranateClient.review', () => {
  it('posts to review_deliverable with bearer, content, kind, and on_behalf_of', async () => {
    const reviewResult = {
      id: 'rev_1',
      findings: [
        {
          category: 'decisions',
          flag: 'green',
          node_id: 'n1',
          quote_from_deliverable: 'q',
          summary: 's',
        },
      ],
    };
    const { fetchImpl, record } = makeFakeFetch({ json: reviewResult });
    const client = new HttpPomegranateClient(fetchImpl);
    const req: RequesterRef = { pomegranateUserId: 'u_req' };

    const out = await client.review(canon, req, 'the deliverable text', 'prd');

    expect(record.last!.url).toMatch(/\/mcp\/tools\/review_deliverable$/);
    expect(record.last!.method).toBe('POST');
    expect(record.last!.headers.Authorization).toBe('Bearer TOK');
    expect(record.last!.headers['Content-Type']).toBe('application/json');
    expect(record.last!.body.content).toBe('the deliverable text');
    expect(record.last!.body.kind).toBe('prd');
    expect(record.last!.body.on_behalf_of).toBe('u_req');

    expect(out).toEqual(reviewResult);
  });

  it('omits on_behalf_of when pomegranateUserId is null', async () => {
    const { fetchImpl, record } = makeFakeFetch({
      json: { id: 'rev_2', findings: [] },
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const req: RequesterRef = { pomegranateUserId: null };

    await client.review(canon, req, 'd');

    expect('on_behalf_of' in record.last!.body).toBe(false);
    // defaults kind to 'other'
    expect(record.last!.body.kind).toBe('other');
  });

  it('throws UpstreamError on non-ok status', async () => {
    const { fetchImpl } = makeFakeFetch({
      ok: false,
      status: 500,
      text: 'boom',
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const req: RequesterRef = { pomegranateUserId: 'u_req' };

    await expect(client.review(canon, req, 'd')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });
});

describe('HttpPomegranateClient.getContext', () => {
  it('posts to query_context with the derived question and scope all', async () => {
    const queryResult = {
      answer: 'the answer',
      cited_node_ids: ['n1', 'n2'],
      has_answer: true,
    };
    const { fetchImpl, record } = makeFakeFetch({ json: queryResult });
    const client = new HttpPomegranateClient(fetchImpl);
    const req: RequesterRef = { pomegranateUserId: 'u_req' };

    const payload = 'some material to contextualize';
    const out = await client.getContext(canon, req, payload);

    expect(record.last!.url).toMatch(/\/mcp\/tools\/query_context$/);
    expect(record.last!.method).toBe('POST');
    expect(record.last!.headers.Authorization).toBe('Bearer TOK');
    expect(record.last!.body.scope).toBe('all');
    expect(record.last!.body.question).toContain(payload);
    expect(record.last!.body.question).toContain(
      'Which parts of this vault are relevant',
    );
    expect(record.last!.body.question).toBe(getContextQuestion(payload));
    expect(record.last!.body.on_behalf_of).toBe('u_req');

    expect(out).toEqual(queryResult);
  });

  it('throws UpstreamError on non-ok status', async () => {
    const { fetchImpl } = makeFakeFetch({
      ok: false,
      status: 500,
      text: 'boom',
    });
    const client = new HttpPomegranateClient(fetchImpl);
    const req: RequesterRef = { pomegranateUserId: null };

    await expect(
      client.getContext(canon, req, 'p'),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
