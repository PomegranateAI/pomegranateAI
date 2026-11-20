import { describe, it, expect } from 'vitest';
import { renderKindFieldSpecs } from './prompt-render.js';
import { notesTemplate } from './profiles/notes.js';
import type { ContextProfile } from './schemas.js';

// Separate file (not prompt-render.test.ts) because that file's fixtures
// (founding/marketing/product/personal profiles) predate the Pomegranate
// Light pivot and no longer exist on disk — pre-existing breakage, not
// something this change should paper over.
describe('kind.body_spec override (log-shape body contract)', () => {
  // A `log`-shape kind batches everything a document reports into ONE node.
  // The generic field-spec fallback says "1-3 sentences" — right for an
  // items/slots kind restating one claim, but a direct contradiction for a
  // kind meant to hold a whole document's content (this exact fallback
  // measurably collapsed a real to-do document down to a fraction of its
  // items on 2026-07-17, before `body_spec` existed as an override).
  it('notes kind renders its own body spec, not the generic sentence-count text', () => {
    const s = renderKindFieldSpecs(notesTemplate);
    for (const kind of notesTemplate.kinds) {
      const start = s.indexOf(`${kind.key}:`);
      const nextStart = s.indexOf('\n\n', start);
      const block = s.slice(start, nextStart === -1 ? undefined : nextStart);
      expect(block, `${kind.key} must not fall back to the generic body spec`).not.toContain(
        '1-3 sentences, canonical form per Step 4',
      );
      expect(block, `${kind.key} must state that it preserves all information`).toContain(
        'preserving all information',
      );
    }
  });

  it('is OPT-IN: a kind without body_spec keeps the generic fallback byte-identical', () => {
    // Synthetic fixture, not a builtin — the current catalog (`notes`) always
    // sets body_spec, so the opt-in path is exercised directly against the
    // renderer rather than against a template that no longer omits it.
    const fixture: ContextProfile = {
      ...notesTemplate,
      kinds: [{ ...notesTemplate.kinds[0], body_spec: undefined }],
    };
    const s = renderKindFieldSpecs(fixture);
    expect(s).toContain('body (string, 1-3 sentences, canonical form per Step 4)');
  });
});
