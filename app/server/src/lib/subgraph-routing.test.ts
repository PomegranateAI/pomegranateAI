import { describe, it, expect } from 'vitest';
import { parseSubgraphTokens } from './subgraph-routing.js';

describe('parseSubgraphTokens', () => {
  it('returns the text unchanged when there are no tokens', () => {
    const input = 'Ship the Q2 launch plan to the team.';
    const { stripped, slugs } = parseSubgraphTokens(input);
    expect(slugs).toEqual([]);
    expect(stripped).toBe(input);
  });

  it('extracts a single token and strips it', () => {
    const { stripped, slugs } = parseSubgraphTokens('Route this #marketing');
    expect(slugs).toEqual(['marketing']);
    expect(stripped).toBe('Route this');
  });

  it('extracts multiple tokens in first-seen order', () => {
    const { stripped, slugs } = parseSubgraphTokens('#product and #marketing notes');
    expect(slugs).toEqual(['product', 'marketing']);
    expect(stripped).toBe('and notes');
  });

  it('de-duplicates repeated tokens', () => {
    const { slugs } = parseSubgraphTokens('#sales pitch then more #sales follow-up');
    expect(slugs).toEqual(['sales']);
  });

  it('matches a token mid-sentence', () => {
    const { stripped, slugs } = parseSubgraphTokens('please file under #growth before end of day');
    expect(slugs).toEqual(['growth']);
    expect(stripped).toBe('please file under before end of day');
  });

  it('matches a leading token', () => {
    const { stripped, slugs } = parseSubgraphTokens('#legal review the contract');
    expect(slugs).toEqual(['legal']);
    expect(stripped).toBe('review the contract');
  });

  it('lowercases slugs', () => {
    const { slugs } = parseSubgraphTokens('tag it #Marketing and #PRODUCT');
    expect(slugs).toEqual(['marketing', 'product']);
  });
});
