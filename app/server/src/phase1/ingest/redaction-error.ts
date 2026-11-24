// Source-redaction failure. A workspace store rule says the source text must
// be scrubbed before it is persisted; when the scrub cannot run, the ingest
// stops here rather than store the original (fail closed). The REST layer maps
// this to 422, the MCP ingest_document tool to a ToolError with the same code.
// POMEGRANATE_REDACT_FAIL_OPEN=1 restores the old store-the-original behaviour.

export type RedactionUnavailableReason = 'unavailable' | 'too_long' | 'failed';

const DETAIL: Record<RedactionUnavailableReason, string> = {
  unavailable:
    'This directory has a rule that redacts source text before it is stored, but no redaction model is configured, so nothing was ingested.',
  too_long:
    'This directory has a rule that redacts source text before it is stored, and this document is too long to redact in one pass, so nothing was ingested. Split it into smaller parts and try again.',
  failed:
    'This directory has a rule that redacts source text before it is stored, but redaction failed, so nothing was ingested. Try again in a moment.',
};

export class RedactionUnavailableError extends Error {
  readonly code = 'redaction_unavailable' as const;
  readonly detail: string;
  constructor(readonly reason: RedactionUnavailableReason) {
    super(`redaction_unavailable: ${reason}`);
    this.name = 'RedactionUnavailableError';
    this.detail = DETAIL[reason];
  }
  body(): { error: 'redaction_unavailable'; reason: RedactionUnavailableReason; detail: string } {
    return { error: this.code, reason: this.reason, detail: this.detail };
  }
}

export function redactFailOpen(): boolean {
  return process.env.POMEGRANATE_REDACT_FAIL_OPEN === '1';
}
