import { describe, it, expect } from 'vitest';
import { overviewDigest } from './anthropic.js';
import type { Node } from './schemas.js';

const ts = '2026-01-01T00:00:00Z';
const node = (extra: Record<string, unknown>) =>
  ({ id: 'n', type: 'note', created_at: ts, updated_at: ts, status: 'active', ...extra }) as unknown as Node;

describe('overviewDigest', () => {
  it('sends the document summary, never the full body', () => {
    const body = 'FULL DOCUMENT TEXT '.repeat(500);
    const out = overviewDigest([
      node({ title: 'BLS course', body, attrs: { context: 'Online BLS course prepping students for hands-on testing.' } }),
    ]);
    expect(out).toBe('- [note] BLS course: Online BLS course prepping students for hands-on testing.');
    expect(out).not.toContain('FULL DOCUMENT TEXT');
  });

  it("falls back to the node's own summary, then a short body excerpt", () => {
    const out = overviewDigest([
      node({ type: 'decision', summary: 'Cap homework at 30 minutes', body: 'long rationale' }),
      node({ body: 'x'.repeat(1000) }),
    ]).split('\n');
    expect(out[0]).toBe('- [decision] Cap homework at 30 minutes');
    expect(out[1].length).toBeLessThan(300);
    expect(out[1].endsWith('…')).toBe(true);
  });

  it('sends a line shared by several nodes from one document once', () => {
    const ctx = { context: 'Q3 board memo on the roadmap.' };
    const out = overviewDigest([node({ body: 'a', attrs: ctx }), node({ body: 'b', attrs: ctx })]);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('stays small for a large whole-doc folder', () => {
    const graph = Array.from({ length: 1000 }, (_, i) =>
      node({ title: `Doc ${i}`, body: 'y'.repeat(5000), attrs: { context: `Summary of document ${i}, about a hundred characters long on average.` } }),
    );
    expect(overviewDigest(graph).length).toBeLessThan(1000 * 120);
  });
});
