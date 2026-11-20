/**
 * Mock Slack ingest — exercises the same downstream pipeline as a real
 * Slack OAuth integration would, but without a Slack API key.
 *
 * Implements the PRD's enterprise-acceptance safeguards in code:
 *  - Pre-ingest preview before a channel is activated for capture.
 *  - Channel deny-list with sensitive defaults.
 *  - Auto-scan off by default; admin enablement required.
 *  - Redaction at ingest (email, phone, account-id, dollar amounts).
 */
import type { Repo } from '../db/repo.js';
import type { SynthesisProvider } from '../../lib/synthesis.js';
import { nanoid } from 'nanoid';

// PRD: "channels matching *leadership*, *exec*, *board*, *legal*, *hr*, *comp*"
// Match the substring — Slack channel names that contain these tokens count.
export const SENSITIVE_CHANNEL_PATTERNS = [
  /leadership/i,
  /exec/i,
  /board/i,
  /legal/i,
  /\bhr[-_]?/i,
  /comp[-_]?/i,
];

export function isChannelDenied(channel: string): boolean {
  return SENSITIVE_CHANNEL_PATTERNS.some((re) => re.test(channel));
}

export function redact(text: string): { text: string; redactions: number } {
  let count = 0;
  let out = text;
  // Email
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
    count++;
    return '[REDACTED_EMAIL]';
  });
  // Phone (loose)
  out = out.replace(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, () => {
    count++;
    return '[REDACTED_PHONE]';
  });
  // Dollar amounts > $1
  out = out.replace(/\$\s?\d[\d,]*(?:\.\d+)?(?:k|m|b)?/gi, () => {
    count++;
    return '[REDACTED_AMOUNT]';
  });
  // Account-id-ish (acct_, cust_, customer-, contract-)
  out = out.replace(/\b(?:acct|cust|customer|contract)[_-]\w+/gi, () => {
    count++;
    return '[REDACTED_ACCOUNT_ID]';
  });
  return { text: out, redactions: count };
}

export interface SlackMessage {
  channel: string;
  user: string;
  text: string;
  ts: string;
  reaction?: string; // e.g. "pomegranate"
}

export interface PreviewResult {
  channel: string;
  allowed: boolean;
  /** Messages inside the enforced 7-day window. */
  messages_in_window: number;
  /** Messages the caller supplied that fell OUTSIDE the enforced window. */
  rejected_outside_window: number;
  redacted: number;
  /** The 7-day floor used by this preview (ISO). */
  window_start: string;
  window_end: string;
  sample: Array<{ ts: string; text_redacted: string }>;
}

/**
 * PRD § Data handling: "the last 7 days of messages from that channel that
 * would have been ingested." 7d is enforced server-side — callers don't get
 * to widen the window.
 */
export const PREVIEW_WINDOW_DAYS = 7;

/**
 * Slack ts values can be either ISO strings or Slack's float seconds
 * (`1715640000.000000`). Normalize to epoch ms; ignore unparseable rows.
 */
function tsToMs(ts: string): number | null {
  // ISO
  const isoMs = Date.parse(ts);
  if (!Number.isNaN(isoMs)) return isoMs;
  // Slack float seconds
  const f = parseFloat(ts);
  if (!Number.isNaN(f) && f > 1_000_000) return Math.floor(f * 1000);
  return null;
}

export interface IngestEventOptions {
  workspace_id: string;
  message: SlackMessage;
  mode: 'reaction' | 'auto_scan';
  capturePhrase?: string; // default "pomegranate"
  /** When mode='auto_scan' and the channel has auto_scan=0, ingest is rejected. */
  bypassChannelState?: boolean;
}

export class SlackMock {
  constructor(
    private readonly repo: Repo,
    private readonly synth: SynthesisProvider,
  ) {}

  // ---------- channel management ----------

  preview(opts: {
    workspace_id: string;
    channel: string;
    window: SlackMessage[];
    /** Optional reference "now" for tests; defaults to actual now. */
    now?: Date;
  }): PreviewResult {
    const denied = isChannelDenied(opts.channel);
    const end = opts.now ?? new Date();
    const start = new Date(end.getTime() - PREVIEW_WINDOW_DAYS * 24 * 3600 * 1000);

    let rejected = 0;
    const inWindow: SlackMessage[] = [];
    for (const m of opts.window) {
      const ms = tsToMs(m.ts);
      if (ms === null || ms < start.getTime() || ms > end.getTime()) {
        rejected++;
        continue;
      }
      inWindow.push(m);
    }

    const sample = inWindow.slice(0, 10).map((m) => {
      const r = redact(m.text);
      return { ts: m.ts, text_redacted: r.text };
    });
    const totalRedactions = inWindow.reduce((s, m) => s + redact(m.text).redactions, 0);
    return {
      channel: opts.channel,
      allowed: !denied,
      messages_in_window: inWindow.length,
      rejected_outside_window: rejected,
      redacted: totalRedactions,
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      sample,
    };
  }

  async activateChannel(opts: {
    workspace_id: string;
    channel: string;
    auto_scan?: boolean;
    admin_confirmed: boolean;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!opts.admin_confirmed) return { ok: false, reason: 'admin_confirmation_required' };
    if (isChannelDenied(opts.channel)) return { ok: false, reason: 'denied_by_default' };
    const now = new Date().toISOString();
    await this.repo.watchSlackChannel(opts.workspace_id, opts.channel, opts.auto_scan ? 1 : 0, now);
    await this.repo.logAudit(opts.workspace_id, {
      event: 'slack.channel.activated',
      resource_type: 'slack_channel',
      resource_id: opts.channel,
      payload: { auto_scan: !!opts.auto_scan },
    });
    await this.repo.logCustomerAudit(opts.workspace_id, {
      event: 'slack_channel_watched',
      resource_type: 'slack_channel',
      resource_id: opts.channel,
      payload: { auto_scan: !!opts.auto_scan },
    });
    return { ok: true };
  }

  async deactivateChannel(opts: { workspace_id: string; channel: string }): Promise<{ ok: boolean }> {
    const res = await this.repo.unwatchSlackChannel(opts.workspace_id, opts.channel);
    if (res.changes === 0) return { ok: false };
    await this.repo.logCustomerAudit(opts.workspace_id, {
      event: 'slack_channel_unwatched',
      resource_type: 'slack_channel',
      resource_id: opts.channel,
    });
    return { ok: true };
  }

  // ---------- event ingestion ----------

  async ingestEvent(opts: IngestEventOptions): Promise<{
    ingested: boolean;
    candidates: number;
    reason?: string;
    redactions?: number;
  }> {
    const ch = await this.repo.getSlackChannelWatch(opts.workspace_id, opts.message.channel) as
      | { watching: number; auto_scan: number }
      | undefined;
    if (!opts.bypassChannelState) {
      if (!ch || !ch.watching) return { ingested: false, candidates: 0, reason: 'channel_not_watched' };
      if (opts.mode === 'auto_scan' && !ch.auto_scan) {
        return { ingested: false, candidates: 0, reason: 'auto_scan_not_enabled' };
      }
    }
    if (isChannelDenied(opts.message.channel)) {
      return { ingested: false, candidates: 0, reason: 'channel_denied_by_default' };
    }
    // Reaction-mode requires the right reaction
    if (opts.mode === 'reaction') {
      const phrase = opts.capturePhrase ?? 'pomegranate';
      if (opts.message.reaction !== phrase) {
        return { ingested: false, candidates: 0, reason: 'wrong_reaction' };
      }
    }
    const { text: redactedText, redactions } = redact(opts.message.text);
    const graph = await this.repo.listNodes(opts.workspace_id, { activeOnly: true });
    // Capture under the workspace's REAL profile (undefined falls back to
    // founding inside capture) — without it, non-founding workspaces got
    // founding-profile kinds that insertCandidate now rejects.
    const profile = await this.repo.getWorkspaceProfile(opts.workspace_id);
    const candidates = await this.synth.capture({
      graph,
      sourceKind: 'slack',
      source: redactedText,
      // Spread, not `profile: profile` — an explicit `profile: undefined` key
      // would clobber a caching provider's own default on spread-merge.
      ...(profile ? { profile } : {}),
    });
    for (const cand of candidates) {
      try {
        await this.repo.insertCandidate(opts.workspace_id, {
          ...cand,
          id: cand.id || `c_${nanoid(10)}`,
          source_ref: `slack:${opts.message.channel}@${opts.message.ts}`,
        });
      } catch (err) {
        // One foreign-kind candidate must not abort the message's ingest.
        if (!(err as Error).message.startsWith('invalid_kind')) throw err;
      }
    }
    await this.repo.logAudit(opts.workspace_id, {
      actor: opts.message.user,
      event: 'slack.event.ingested',
      payload: {
        channel: opts.message.channel,
        ts: opts.message.ts,
        mode: opts.mode,
        candidates: candidates.length,
        redactions,
      },
    });
    await this.repo.logCustomerAudit(opts.workspace_id, {
      event: 'source_ingested',
      resource_type: 'slack_message',
      resource_id: `${opts.message.channel}@${opts.message.ts}`,
      payload: {
        kind: 'slack',
        mode: opts.mode,
        candidates: candidates.length,
        redactions,
      },
    });
    return { ingested: true, candidates: candidates.length, redactions };
  }
}
