import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INPUT_TOKENS,
  batchByTokens,
  estimateTokens,
  truncateToTokens,
  OpenAIEmbedder,
} from './embeddings.js';

afterEach(() => vi.unstubAllGlobals());

describe('embedding request shaping', () => {
  it('counts dense scripts closer to one token per character than Latin text', () => {
    // The direction matters more than the exact number: an estimate below the
    // true count is what gets a request rejected.
    expect(estimateTokens('a'.repeat(400))).toBe(200);
    expect(estimateTokens('مرحبا'.repeat(80))).toBeGreaterThan(estimateTokens('hello'.repeat(80)));
  });

  it('leaves texts under the cap untouched', () => {
    const short = 'a short node body';
    expect(truncateToTokens(short)).toBe(short);
  });

  it('cuts an oversized body down to the cap, keeping the head', () => {
    const body = 'The decision was to ship on Friday. ' + 'x'.repeat(4_000_000);
    const cut = truncateToTokens(body);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
    expect(cut.startsWith('The decision was to ship on Friday.')).toBe(true);
    expect(cut.length).toBeLessThan(body.length);
  });

  it('caps an Arabic body by tokens, not by character count', () => {
    const arabic = 'مرحبا بيك في بومقرانات '.repeat(5000);
    expect(estimateTokens(truncateToTokens(arabic))).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  it('splits inputs into requests that each stay under the ceiling', () => {
    const texts = Array.from({ length: 46 }, () => 'a'.repeat(4 * MAX_INPUT_TOKENS));
    const batches = batchByTokens(texts);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(250_000);
    }
    expect(batches.flat()).toHaveLength(46);
  });

  it('keeps everything in one request when it already fits', () => {
    expect(batchByTokens(['one', 'two', 'three'])).toEqual([['one', 'two', 'three']]);
  });
});

  it('is pessimistic enough for base64, the worst real content seen', () => {
    // The 628k-character node that wedged the backfill was a page capture full
    // of base64 data URIs, which tokenize near 2 characters per token.
    const base64ish = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'.repeat(2000);
    const cut = truncateToTokens(base64ish);
    expect(cut.length / 2).toBeLessThanOrEqual(8192);
  });

describe('OpenAI embedder', () => {
  const vector = (n: number) => Array.from({ length: 4 }, () => n);

  it('embeds the 46-oversized-node case as several requests, in order, none rejected', async () => {
    const seen: number[][] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      seen.push(input.map((t) => estimateTokens(t)));
      return {
        ok: true,
        json: async () => ({
          data: input.map((_, index) => ({ embedding: vector(seen.length), index })),
          model: 'text-embedding-3-small',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    // Reproduces prod: 46 nodes averaging ~54k characters, one of them 628k.
    const nodes = Array.from({ length: 46 }, (_, i) => 'x'.repeat(i === 0 ? 628_274 : 53_676));
    const out = await new OpenAIEmbedder('key').embed(nodes);

    expect(out).toHaveLength(46);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const batch of seen) {
      expect(batch.every((t) => t <= MAX_INPUT_TOKENS)).toBe(true);
      expect(batch.reduce((sum, t) => sum + t, 0)).toBeLessThanOrEqual(250_000);
    }
  });

  it('still issues a single request for an ordinary batch', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      return {
        ok: true,
        json: async () => ({
          data: input.map((_, index) => ({ embedding: vector(index), index })),
          model: 'text-embedding-3-small',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await new OpenAIEmbedder('key').embed(['a node', 'another node']);
    expect(out).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('adaptive cap', () => {
  it('halves the cap and retries when the provider still rejects an input as too long', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: "Invalid 'input[0]': maximum input length is 8192 tokens." } }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: input.map((_, index) => ({ embedding: [1, 2, 3, 4], index })),
          model: 'text-embedding-3-small',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await new OpenAIEmbedder('key').embed(['x'.repeat(200_000)]);
    expect(out).toHaveLength(1);
    expect(calls).toBe(2);
    const retried = JSON.parse(fetchMock.mock.calls[1]![1].body).input[0] as string;
    const first = JSON.parse(fetchMock.mock.calls[0]![1].body).input[0] as string;
    expect(retried.length).toBeLessThan(first.length);
  });

  it('does not retry an error that is not about input length', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new OpenAIEmbedder('key').embed(['a node'])).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
