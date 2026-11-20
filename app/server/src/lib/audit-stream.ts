// Audit forwarding for the customer's monitoring (on-prem).
//
// With POMEGRANATE_AUDIT_STREAM_PATH set (docker-compose sets
// /data/audit.jsonl on-prem), every customer-audit event — and the internal
// key.unwrap_failed alarm — is also appended to that file as one JSON line.
// The customer's log shipper (rsyslog imfile, Filebeat, Fluent Bit…) tails it;
// deploy/rsyslog-pomegranate.conf is a ready template. The file is rotated by
// deploy/logrotate-pomegranate.
//
// Only the audit vocabulary travels: ids, events, actors, counts. Never
// content — the customer audit log is content-free by design.

import { appendFile } from 'node:fs/promises';
import { log } from './log.js';

export interface AuditStreamRecord {
  stream: 'customer' | 'internal';
  workspace_id: string;
  event: string;
  actor_user_id?: string | null;
  actor_email?: string | null;
  source_ip?: string | null;
  user_agent?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  payload?: Record<string, unknown> | null;
}

let warned = false;

/** Append one audit record to the stream file, if configured. Never throws. */
export async function forwardAudit(record: AuditStreamRecord): Promise<void> {
  const path = process.env.POMEGRANATE_AUDIT_STREAM_PATH;
  if (!path) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), app: 'pomegranate', ...record }) + '\n';
  try {
    await appendFile(path, line, { encoding: 'utf8', mode: 0o640 });
  } catch (err) {
    if (!warned) {
      warned = true;
      log.warn('audit_stream.write_failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' });
    }
  }
}
