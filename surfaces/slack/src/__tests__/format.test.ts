import { describe, it, expect } from 'vitest';
import { formatReview, formatGetContext } from '../format.js';
import type { ReviewResult, QueryResult, Finding } from '../types.js';

function finding(partial: Partial<Finding>): Finding {
  return {
    category: 'decisions',
    flag: 'green',
    node_id: null,
    quote_from_deliverable: 'some span',
    summary: 'a summary',
    ...partial,
  };
}

describe('formatReview', () => {
  it('orders red before yellow before green and includes details', () => {
    const result: ReviewResult = {
      id: 'r1',
      findings: [
        finding({
          flag: 'green',
          category: 'brand_voice',
          summary: 'green summary',
          node_id: null,
        }),
        finding({
          flag: 'yellow',
          category: 'goals_priorities',
          summary: 'yellow summary',
          node_id: 'N_YELLOW',
        }),
        finding({
          flag: 'red',
          category: 'positioning',
          summary: 'red positioning summary',
          node_id: 'N_POS',
        }),
        finding({
          flag: 'red',
          category: 'decisions',
          summary: 'red decisions summary',
          node_id: null,
        }),
      ],
    };

    const out = formatReview(result, '<@U_ALICE>');

    const firstRed = out.indexOf(':red_circle:');
    const firstYellow = out.indexOf(':large_yellow_circle:');
    const firstGreen = out.indexOf(':large_green_circle:');

    // Header contains all three emojis, so search after the header line.
    const body = out.slice(out.indexOf('\n\n'));
    const bodyRed = body.indexOf(':red_circle:');
    const bodyYellow = body.indexOf(':large_yellow_circle:');
    const bodyGreen = body.indexOf(':large_green_circle:');
    expect(bodyRed).toBeGreaterThanOrEqual(0);
    expect(bodyRed).toBeLessThan(bodyYellow);
    expect(bodyYellow).toBeLessThan(bodyGreen);

    // sanity: emojis present in full output too
    expect(firstRed).toBeGreaterThanOrEqual(0);
    expect(firstYellow).toBeGreaterThanOrEqual(0);
    expect(firstGreen).toBeGreaterThanOrEqual(0);

    // summaries present
    expect(out).toContain('red positioning summary');
    expect(out).toContain('red decisions summary');
    expect(out).toContain('yellow summary');
    expect(out).toContain('green summary');

    // friendly category labels
    expect(out).toContain('Positioning');
    expect(out).toContain('Decisions');
    expect(out).toContain('Goals & priorities');
    expect(out).toContain('Brand voice');

    // citation hint for a finding with node_id
    expect(out).toContain('(source: N_POS)');

    // header counts: 2 red, 1 yellow, 1 green
    expect(out).toContain(
      "*Review against <@U_ALICE>'s vault* — 2 :red_circle:  1 :large_yellow_circle:  1 :large_green_circle:",
    );

    // subject label in header
    expect(out).toContain('<@U_ALICE>');
  });

  it('returns a friendly aligned message when there are no findings', () => {
    const result: ReviewResult = { id: 'r0', findings: [] };
    const out = formatReview(result, '<@U_ALICE>');
    expect(out.toLowerCase()).toContain('aligned');
    expect(out).toContain('<@U_ALICE>');
  });

  it('caps green findings at 5 and notes the remainder', () => {
    const findings: Finding[] = Array.from({ length: 8 }, (_, i) =>
      finding({
        flag: 'green',
        category: 'brand_voice',
        summary: `green ${i}`,
      }),
    );
    const result: ReviewResult = { id: 'r8', findings };
    const out = formatReview(result, '<@U_ALICE>');
    expect(out).toContain('…and 3 more green');
    expect(out).toContain('green 0');
    expect(out).toContain('green 4');
    expect(out).not.toContain('green 5');
  });
});

describe('formatGetContext', () => {
  it('reports nothing relevant when there is no answer', () => {
    const result: QueryResult = {
      answer: '',
      cited_node_ids: [],
      has_answer: false,
    };
    const out = formatGetContext(result, '<@U_ALICE>');
    expect(out).toContain('Nothing');
    expect(out).toContain('relevant');
    expect(out).toContain('<@U_ALICE>');
  });

  it('returns the answer with a sources line', () => {
    const result: QueryResult = {
      answer: 'X',
      cited_node_ids: ['a', 'b'],
      has_answer: true,
    };
    const out = formatGetContext(result, '<@U_ALICE>');
    expect(out).toContain('X');
    expect(out).toContain('Sources: 2 node(s)');
  });
});
