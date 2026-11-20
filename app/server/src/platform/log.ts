// logging + audit.
//
// log.*  — operational events. One JSON object per line on stdout:
//          {"ts","level","event", ...fields}. Container Apps ships stdout to
//          Log Analytics; there is no file sink on Azure.
// audit  — security events for SOC 2 (CC6/CC7). A fixed event list, written
//          both to the log stream and to the audit table, retained 1 year.
//
// Customer text is never a field: no node titles or bodies, document text,
// prompts, questions or message bodies. Ids, counts, durations and enum
// values only. T2 plants canary strings and fails if one reaches a log.
//
// Implementation: A8 (it replaces lib/log.ts's key=value format; the call
// shape `log.info(event, fields)` is unchanged so call sites keep working).

export type LogFields = Record<string, string | number | boolean | null | undefined | string[]>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const AUDIT_EVENTS = [
  'sign_in',
  'sign_out',
  'export',
  'workspace.delete',
  'member.add',
  'member.remove',
  'connector.create',
  'connector.revoke',
  'token.create',
  'token.revoke',
  'key.unwrap_failed',
  'admin.action',
  'settings.change',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditRecord {
  /** null for events outside a workspace (sign_in, admin.action on a user). */
  workspaceId: string | null;
  /** null for system actors (jobs, scripts run by ops — those use admin.action with a target). */
  actorUserId: string | null;
  /** What was acted on: an id, never a name or text. e.g. "user:u_123", "connector:c_9", "workspace:ws_x". */
  target: string;
  outcome: 'success' | 'failure' | 'denied';
  /** Optional ids/enums only, same rule as LogFields. */
  detail?: LogFields;
}

export type AuditFn = (event: AuditEvent, record: AuditRecord) => Promise<void>;

/** Format one log line (the JSON shape every implementation emits). */
export function formatLogLine(level: keyof Logger, event: string, fields?: LogFields): string {
  return JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields ?? {}) });
}

/** Captures lines in memory; for tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: keyof Logger) => (event: string, fields?: LogFields) => {
    lines.push(formatLogLine(level, event, fields));
  };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
