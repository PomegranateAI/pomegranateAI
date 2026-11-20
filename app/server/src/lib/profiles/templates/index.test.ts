import { describe, it, expect } from 'vitest';
import { validateProfileSemantics } from '../validate.js';
import { listStandardDataAgentTemplates } from './index.js';

describe('standard data-agent templates (spec-data-agents-and-subfolder-wiki.md §5.5)', () => {
  it('every revived template passes at the built-in bar — zero errors AND zero warnings', () => {
    for (const t of listStandardDataAgentTemplates()) {
      const { errors, warnings } = validateProfileSemantics(t);
      expect(errors, `${t.id} errors: ${errors.join(' | ')}`).toEqual([]);
      expect(warnings, `${t.id} warnings: ${warnings.join(' | ')}`).toEqual([]);
    }
  });

  it('covers all three cardinalities', () => {
    const shapes = listStandardDataAgentTemplates().map((t) => t.shape);
    expect(shapes).toContain('log');
    expect(shapes).toContain('slots');
    expect(shapes).toContain('items');
  });

  it('has all twelve of the pre-collapse catalog, including brand_voice (see index.ts)', () => {
    expect(listStandardDataAgentTemplates()).toHaveLength(12);
    expect(listStandardDataAgentTemplates().map((t) => t.id)).toContain('brand_voice');
  });
});
