// Chunker unit tests (spec-source-rag-hybrid-answering.md §2.2). The chunker is
// a pure function; these pin the invariants retrieval depends on: offsets index
// the original text, windows overlap, and sentence boundaries aren't cut.
import { describe, it, expect } from 'vitest';
import { chunkText } from './source-rag.js';

describe('chunkText', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  \t ')).toEqual([]);
  });

  it('returns a single chunk when the text fits under the window', () => {
    const text = 'A short document. Nothing more to see here.';
    const chunks = chunkText(text, { chars: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.char_start).toBe(0);
  });

  it('char offsets index back into the ORIGINAL text', () => {
    const sentence = 'The launch date is the ninth of September. ';
    const text = sentence.repeat(40); // ~2000 chars → multiple chunks
    const chunks = chunkText(text, { chars: 500, overlapPct: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      // The stored text is a trimmed slice of the original window; the original
      // slice must contain it.
      const original = text.slice(ch.char_start, ch.char_end);
      expect(original).toContain(ch.text.slice(0, 20));
      expect(ch.char_end).toBeGreaterThan(ch.char_start);
    }
  });

  it('consecutive windows overlap (a boundary-straddling fact survives)', () => {
    const text = 'Sentence number ' + Array.from({ length: 60 }, (_, i) => `item ${i}.`).join(' ');
    const chunks = chunkText(text, { chars: 400, overlapPct: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      // Next window starts before the previous window ended → overlap.
      expect(chunks[i]!.char_start).toBeLessThan(chunks[i - 1]!.char_end);
    }
  });

  it('snaps window ends to sentence boundaries rather than mid-word', () => {
    const text = Array.from({ length: 30 }, (_, i) => `This is complete sentence ${i}.`).join(' ');
    const chunks = chunkText(text, { chars: 300, overlapPct: 10 });
    // Every non-final chunk should end at sentence punctuation (after trim).
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.text.trim().endsWith('.')).toBe(true);
    }
  });

  it('always terminates and covers the whole text', () => {
    const text = 'x'.repeat(5000); // no boundaries at all → forced hard cuts
    const chunks = chunkText(text, { chars: 500, overlapPct: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    // Last chunk reaches the end.
    expect(chunks[chunks.length - 1]!.char_end).toBe(text.length);
  });
});
