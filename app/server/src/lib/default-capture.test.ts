/**
 * Tests for the `notes` template's `log` shape — the successor to the
 * pre-Light `default` (whole-doc) profile (same cardinality: one document ->
 * one node). Node COUNT used to be left to the unified capture LLM call
 * obeying capture.md's shape-rule wording, which a live incident (#141) showed
 * a smaller hosted model doesn't reliably do — the same document could yield
 * zero nodes, one, or one-per-checklist-item. `log`-shape capture is now
 * deterministic: the classify-whole-doc call picks only a title, and the
 * candidate itself (type, body = raw source, cardinality = 1) is built in
 * code, never proposed by the model.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { runCapture, setStructuredLLM, shouldGlean, type StructuredLLMOverride } from './anthropic.js';
import { notesTemplate, validateBuiltinProfiles, getBuiltinProfile, DEFAULT_PROFILE_ID } from './profiles/index.js';
import { foundingProfile } from './profiles/__fixtures__/founding.js';

/** Stub structured LLM that answers the unified capture task only. */
function stubCapture(candidates: unknown[]): StructuredLLMOverride {
  return {
    name: 'stub',
    async callStructured(opts) {
      if (opts.task === 'capture') return { candidates };
      throw new Error(`unexpected task in notes-capture test: ${opts.task}`);
    },
  };
}

afterEach(() => setStructuredLLM(null));

describe('notes template registration + shape', () => {
  it('is the system default and a registered builtin, log-shaped', () => {
    expect(DEFAULT_PROFILE_ID).toBe('notes');
    expect(getBuiltinProfile('notes')).toBe(notesTemplate);
    expect(notesTemplate.shape).toBe('log');
  });

  it('declares one kind and no edge taxonomy (edges are a no-op for it)', () => {
    expect(notesTemplate.kinds).toHaveLength(1);
    expect(notesTemplate.kinds[0]!.key).toBe('note');
    expect(notesTemplate.edge_kinds).toEqual([]);
    expect(notesTemplate.edges_deliberately_empty).toBe(true);
  });

  it('passes builtin semantic validation (notes is allowed its opt-out warnings)', () => {
    expect(() => validateBuiltinProfiles()).not.toThrow();
  });
});

describe('log shape: deterministic whole-doc capture', () => {
  it('shouldGlean is always false for a log-shaped profile, even with glean enabled', () => {
    const prior = process.env.POMEGRANATE_CAPTURE_GLEAN;
    process.env.POMEGRANATE_CAPTURE_GLEAN = '1';
    try {
      expect(shouldGlean(1, undefined, notesTemplate)).toBe(false);
      // Contrast: an items-shaped profile (founding) does glean when enabled.
      expect(shouldGlean(1, undefined, foundingProfile)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.POMEGRANATE_CAPTURE_GLEAN;
      else process.env.POMEGRANATE_CAPTURE_GLEAN = prior;
    }
  });

  /** Stub that only answers the whole-doc title/category label call. */
  function stubLabel(title: string, category = ''): StructuredLLMOverride {
    return {
      name: 'stub',
      async callStructured(opts) {
        if (opts.task === 'classify-whole-doc') return { title, category };
        throw new Error(`unexpected task in notes-capture test: ${opts.task}`);
      },
    };
  }

  it('builds exactly one note from the raw source, labelled by the classify call', async () => {
    setStructuredLLM(stubLabel('Competitor landscape', 'market'));
    const out = await runCapture({
      graph: [],
      sourceKind: 'doc',
      source: 'OpenAI, Anthropic and Together.ai are our competitors.',
      profile: notesTemplate,
      sourceRef: 'source:doc',
    });
    expect(out).toHaveLength(1);
    const node = out[0]!.proposed_node as Record<string, unknown>;
    expect(node.type).toBe('note');
    expect(node.title).toBe('Competitor landscape');
    expect(node.body).toBe('OpenAI, Anthropic and Together.ai are our competitors.');
  });

  it('never asks the model to decide node count or kind — the "capture" task is never called for log shape', async () => {
    setStructuredLLM(stubCapture([{ id: 'c1', proposed_node: {}, flag: 'green', source_quote: '', source_ref: '', confidence: 1 }]));
    // stubCapture only answers 'capture'; if runWholeDocCapture called that
    // task it would get this candidate back. Instead it must call
    // 'classify-whole-doc', which this stub doesn't answer, so the label call
    // fails open and the node still gets built (see next test).
    const out = await runCapture({
      graph: [],
      sourceKind: 'doc',
      source: 'Some content.',
      profile: notesTemplate,
      sourceRef: 'source:doc',
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.proposed_node as Record<string, unknown>).type).toBe('note');
  });

  it('falls back to the source ref when the label call fails, without losing the node', async () => {
    setStructuredLLM({
      name: 'stub',
      async callStructured() {
        throw new Error('label call down');
      },
    });
    const out = await runCapture({
      graph: [],
      sourceKind: 'doc',
      source: 'Some content.',
      profile: notesTemplate,
      sourceRef: 'source:doc',
    });
    expect(out).toHaveLength(1);
    expect((out[0]!.proposed_node as Record<string, unknown>).title).toBe('source:doc');
  });

  it('yields no candidate for a blank document (nothing to label)', async () => {
    setStructuredLLM(stubLabel('should not be called'));
    const out = await runCapture({
      graph: [],
      sourceKind: 'doc',
      source: '   ',
      profile: notesTemplate,
      sourceRef: 'source:doc',
    });
    expect(out).toHaveLength(0);
  });
});
