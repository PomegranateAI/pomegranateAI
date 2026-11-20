import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PROFILES,
  DEFAULT_PROFILE_ID,
  listBuiltinProfiles,
  getBuiltinProfile,
  validateBuiltinProfiles,
  notesTemplate,
} from './index.js';
import { ContextProfile } from '../schemas.js';

// Pomegranate Light (2026-07-17/18) collapsed the twelve open-ended context
// profiles down to a single `notes` template — see index.ts's own docstring.
// "Nothing legacy is kept resolvable": a workspace/subgraph whose stored
// snapshot names a retired id keeps that frozen JSON until re-pointed at
// `notes`, but the live catalog only ever resolves `notes`.
describe('built-in context profiles', () => {
  it('every built-in profile parses against the ContextProfile schema', () => {
    expect(() => validateBuiltinProfiles()).not.toThrow();
    for (const p of listBuiltinProfiles()) {
      expect(() => ContextProfile.parse(p)).not.toThrow();
    }
  });

  it('notes is the only builtin and the system default', () => {
    expect(DEFAULT_PROFILE_ID).toBe('notes');
    expect(getBuiltinProfile('notes')).toBe(notesTemplate);
    expect(BUILTIN_PROFILES).toEqual({ notes: notesTemplate });
  });

  it('legacy profile ids no longer resolve', () => {
    for (const id of ['founding', 'default', 'marketing', 'product', 'program', 'designer', 'brand_voice', 'marketing_compliance', 'personal', 'nope']) {
      expect(getBuiltinProfile(id), `${id} should not resolve`).toBeUndefined();
    }
  });

  it('catalog lists exactly notes', () => {
    expect(listBuiltinProfiles().map((p) => p.id)).toEqual(['notes']);
  });

  it('notes is log-shaped with a single kind and no edges (one document -> one note)', () => {
    expect(notesTemplate.shape).toBe('log');
    expect(notesTemplate.kinds.map((k) => k.key)).toEqual(['note']);
    expect(notesTemplate.edges_deliberately_empty).toBe(true);
    expect(notesTemplate.edge_kinds ?? []).toEqual([]);
  });

  it('notes declares source types with per-channel extraction guidance', () => {
    const types = notesTemplate.source_types ?? [];
    expect(types.length).toBeGreaterThan(0);
    // Unique keys.
    expect(new Set(types.map((s) => s.key)).size).toBe(types.length);
    // Channel fallbacks are unambiguous: at most one type per channel.
    const channels = types.flatMap((s) => s.source_kinds ?? []);
    expect(new Set(channels).size, 'notes maps one channel to several source types').toBe(channels.length);
  });
});
