import { describe, it, expect, afterEach } from 'vitest';
import { shouldGlean } from './anthropic.js';
import type { CaptureTraceEvent } from './anthropic.js';
import type { ContextProfile } from './schemas.js';

// The glean (completeness) pass is env-gated. These pin the GATE decision — the
// part that decides whether a second pass runs — without touching the LLM.
// Regression target: turning glean on must (a) rescue a genuine zero-yield
// (router said relevant, specialists whiffed — a weak-model miss) yet
// (b) NEVER re-extract a document the router correctly REJECTED (relevant:false,
// which leaves an empty base but pushes no zero_yield trace).

const prev = process.env.POMEGRANATE_CAPTURE_GLEAN;
afterEach(() => {
  if (prev === undefined) delete process.env.POMEGRANATE_CAPTURE_GLEAN;
  else process.env.POMEGRANATE_CAPTURE_GLEAN = prev;
});

const zeroYieldTrace: CaptureTraceEvent[] = [{ stage: 'route' }, { stage: 'zero_yield', groups: ['message'] }];
const rejectedTrace: CaptureTraceEvent[] = [{ stage: 'route', relevant: false }];

describe('shouldGlean', () => {
  it('is off entirely when the flag is unset (byte-identical to no-glean)', () => {
    delete process.env.POMEGRANATE_CAPTURE_GLEAN;
    expect(shouldGlean(0, zeroYieldTrace)).toBe(false);
    expect(shouldGlean(5, zeroYieldTrace)).toBe(false);
  });

  describe('with the flag on', () => {
    it('augments a non-empty first pass', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      expect(shouldGlean(3, undefined)).toBe(true);
    });

    it('rescues a genuine zero-yield (relevant doc, empty specialists)', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      expect(shouldGlean(0, zeroYieldTrace)).toBe(true);
    });

    it('does NOT re-extract a router rejection (empty base, no zero_yield)', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      expect(shouldGlean(0, rejectedTrace)).toBe(false);
    });

    it('skips an empty base with no trace at all (nothing to complete)', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      expect(shouldGlean(0, undefined)).toBe(false);
    });

    it('skips a `log`-shape profile outright, even a genuine zero-yield', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      const logProfile = { shape: 'log' } as ContextProfile;
      expect(shouldGlean(3, undefined, logProfile)).toBe(false);
      expect(shouldGlean(0, zeroYieldTrace, logProfile)).toBe(false);
    });

    it('still runs for a non-log-shape profile', () => {
      process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
      const itemsProfile = { shape: 'items' } as ContextProfile;
      expect(shouldGlean(3, undefined, itemsProfile)).toBe(true);
    });
  });
});
