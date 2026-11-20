/**
 * The DATA the ingest router (`routeDocument`) weighs — not the LLM call
 * itself. Two folders built from the same template used to arrive at the
 * router with the SAME long extraction charter repeated verbatim, wasting
 * tokens on text that never discriminates between them. The router now gets
 * a short `type` (which template) plus name/owner-description/content-digest
 * — the fields that actually differ folder to folder. These tests lock the
 * catalog shape (which is pure) without paying for the API.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentRouteCatalog, type RouteFolder } from './anthropic.js';

describe('buildDocumentRouteCatalog', () => {
  it('emits id/name/type, never the template charter', () => {
    const folders: RouteFolder[] = [
      { id: 'default', name: 'Work to-dos', type: 'To-do list' },
      { id: 'sg_x', name: 'Groceries', type: 'To-do list' },
    ];
    const catalog = buildDocumentRouteCatalog(folders);
    expect(catalog).toContain('- id: default\n  name: Work to-dos\n  type: To-do list');
    expect(catalog).toContain('- id: sg_x\n  name: Groceries\n  type: To-do list');
  });

  it('includes the owner description when set, skipping the "miscellaneous" DB default', () => {
    const folders: RouteFolder[] = [
      { id: 'a', name: 'A', type: 'To-do list', ownerDescription: 'Personal errands only' },
      { id: 'b', name: 'B', type: 'To-do list', ownerDescription: 'miscellaneous' },
      { id: 'c', name: 'C', type: 'To-do list' },
    ];
    const catalog = buildDocumentRouteCatalog(folders);
    expect(catalog).toContain('owner_says: Personal errands only');
    const lines = catalog.split('\n');
    expect(lines.some((l) => l.includes('owner_says: miscellaneous'))).toBe(false);
  });

  it('reports an empty folder plainly rather than omitting it', () => {
    const catalog = buildDocumentRouteCatalog([{ id: 'a', name: 'A', type: 'To-do list' }]);
    expect(catalog).toContain('currently_holds: (empty folder — nothing filed yet)');
  });

  it('includes the content digest when the folder has one', () => {
    const catalog = buildDocumentRouteCatalog([
      { id: 'a', name: 'A', type: 'To-do list', contentDigest: 'Mostly household chores.' },
    ]);
    expect(catalog).toContain('currently_holds: Mostly household chores.');
  });
});
