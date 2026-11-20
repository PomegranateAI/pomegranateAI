import { describe, it, expect } from 'vitest';
import { chunkMarkdown } from './anthropic.js';

describe('chunkMarkdown', () => {
  it('returns a single chunk when the doc is under the cap', () => {
    const doc = '# Short doc\n\nA paragraph of text.';
    const chunks = chunkMarkdown(doc, 8000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(doc);
  });

  it('splits a long doc on # boundaries', () => {
    // Build a doc with 4 sections of 3000 chars each → 12K total, cap 5000.
    const section = (title: string) => `## ${title}\n\n` + 'body '.repeat(595);
    const doc = ['# Top', section('A'), section('B'), section('C'), section('D')].join('\n\n');
    const chunks = chunkMarkdown(doc, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should exceed the cap.
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5000);
    // Every chunk starts with a header (or is a preamble fragment).
    for (const c of chunks) expect(/^(#{1,3}\s|[A-Za-z])/.test(c.trim())).toBe(true);
    // Aggregated content covers all four section bodies.
    const joined = chunks.join('\n');
    for (const tag of ['## A', '## B', '## C', '## D']) {
      expect(joined.includes(tag)).toBe(true);
    }
  });

  it('packs consecutive small sections into one chunk when they fit', () => {
    const tiny = (n: string) => `## ${n}\n\nshort body for ${n}.\n`;
    const doc = '# Top\n\n' + ['A', 'B', 'C', 'D', 'E'].map(tiny).join('');
    const chunks = chunkMarkdown(doc, 5000);
    // Whole thing fits → 1 chunk
    expect(chunks).toHaveLength(1);
  });

  it('falls back to sliding-window with overlap when there are no headers', () => {
    const doc = ('paragraph.\n\n'.repeat(800)).trim(); // ~9600 chars, no headers
    const chunks = chunkMarkdown(doc, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    // Overlap means consecutive chunks share their boundary text.
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.slice(-50);
      const currHead = chunks[i]!.slice(0, 200);
      expect(currHead.includes(prevTail.trim().slice(-10))).toBe(true);
    }
  });

  it('splits a single oversize section internally', () => {
    // One header, one giant body (no ## subheaders to bound on).
    const doc = '# One Giant Section\n\n' + 'sentence. '.repeat(2000); // ~20K
    const chunks = chunkMarkdown(doc, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5000);
  });
});
