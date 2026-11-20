/**
 * [copied from surfaces/slack/src/log.ts] Minimal structured logger —
 * `key=value` lines, mirroring the backend's `app/server/src/lib/log.ts`
 * style so both logs read the same way.
 *
 * Values containing whitespace are JSON-quoted; null/undefined fields are
 * dropped. Callers are responsible for never passing message text or
 * secrets — see webhook.ts, which logs ids + metadata only.
 */
export type LogLevel = 'info' | 'warn' | 'error';

function formatVal(v: unknown): string {
  const s = String(v);
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const parts = [new Date().toISOString(), level.toUpperCase(), event];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${formatVal(v)}`);
  }
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
