/**
 * Canonical form for a WhatsApp phone number: digits only, no leading `+`,
 * spaces, dashes, or JID suffix (`@s.whatsapp.net` / `@lid`/`@g.us`).
 *
 * Deliberately duplicated (not imported) from
 * app/server/src/phase1/db/repo.ts's `normalizePhoneDigits` — this surface
 * is its own toolchain (see CLAUDE.md: "not wired into a single build"), so
 * the two copies must simply agree on the algorithm, which is a one-liner.
 * The server does the exact same normalization before comparing, so a
 * number this surface sends and a number a user links in Setup resolve to
 * the same identity either way.
 */
export function normalizePhoneDigits(raw: string): string {
  return raw.split('@')[0]!.replace(/\D/g, '');
}
