import { api } from './api.js';
import type { ContextProfile } from './api.js';

// Client-side fallback catalog. The server owns the canonical catalog
// (GET /profiles, GET /workspaces/:ws/profile); the views fetch from it at
// runtime and only fall back to this constant when an endpoint 404s.
//
// There is exactly one built-in template — `notes` — mirroring
// app/server/src/lib/profiles/notes.ts. This file used to carry a fallback
// copy of each of the (at various points) nine, then twelve, built-in
// profiles; those are all retired. Keep this fallback's render-relevant
// fields (kinds, colors, seed questions) in sync with the server template by
// hand — there's no build-time link between the two copies.
export const NOTES_PROFILE: ContextProfile = {
  id: 'notes',
  name: 'Notes',
  description:
    'A running record of whatever information arrives — no assumption about what it is about. ' +
    'Each document becomes one note, keeping everything it states, reports, decides, or describes.',
  shape: 'log',
  kinds: [
    {
      key: 'note',
      label: 'Note',
      label_plural: 'Notes',
      description: 'Everything one document states, reports, decides, or describes, as one node.',
      color: 1,
    },
  ],
  feedback_dimensions: [
    { key: 'accuracy', label: 'Accuracy', description: '' },
    { key: 'coverage', label: 'Coverage', description: '' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'states something a note directly contradicts',
    yellow: 'refers to information not found in any note here',
    green: 'consistent with what the notes record (default)',
  },
  seed_questions: [
    'What do we know about X?',
    'What was said or decided about X?',
    'What is the most recent note on X?',
    'What is in this folder?',
  ],
};

export const BUILTIN_PROFILES: ContextProfile[] = [NOTES_PROFILE];

/** Fetch the onboarding catalog, falling back to the built-in if /profiles 404s. */
export async function fetchProfileCatalog(): Promise<ContextProfile[]> {
  try {
    const r = await api.listProfiles();
    if (r.profiles?.length) return r.profiles;
  } catch {
    // server hasn't shipped /profiles yet — use the built-in fallback
  }
  return BUILTIN_PROFILES;
}

/** Resolve a workspace's profile, falling back to the default if the endpoint 404s. */
export async function fetchWorkspaceProfile(wsId: string): Promise<ContextProfile> {
  try {
    const r = await api.getProfile(wsId);
    if (r?.profile?.kinds?.length) return r.profile;
  } catch {
    // server hasn't shipped /workspaces/:ws/profile yet — fall through
  }
  return NOTES_PROFILE;
}

/** The color token (var(--kind-N)) for a kind's color index. */
export function kindColorVar(color: number): string {
  return `var(--kind-${color})`;
}
