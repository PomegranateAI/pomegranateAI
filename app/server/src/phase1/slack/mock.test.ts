import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { SlackMock, isChannelDenied, redact } from './mock.js';
import { TestSynthStub as HeuristicProvider } from '../../__test_utils__/synth-stub.js';

let db: Database.Database;
let repo: Repo;
let mock: SlackMock;
let wsId: string;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
  wsId = ws.id;
  mock = new SlackMock(repo, HeuristicProvider);
});

describe('channel deny list', () => {
  it('denies leadership/exec/board/legal/hr/comp', () => {
    for (const ch of ['leadership', 'execs', 'board-talk', 'legal-stuff', 'hr-private', 'comp-2026']) {
      expect(isChannelDenied(ch)).toBe(true);
    }
  });
  it('allows ordinary channels', () => {
    for (const ch of ['strategy', 'product', 'marketing', 'sales']) {
      expect(isChannelDenied(ch)).toBe(false);
    }
  });
});

describe('redaction', () => {
  it('redacts emails, phones, and dollar amounts', () => {
    const t = `Email sarah@acme.com or call 415-555-1212 about the $1.2M contract acct_12345`;
    const { text, redactions } = redact(t);
    expect(redactions).toBeGreaterThanOrEqual(4);
    expect(text).toMatch(/REDACTED_EMAIL/);
    expect(text).toMatch(/REDACTED_PHONE/);
    expect(text).toMatch(/REDACTED_AMOUNT/);
    expect(text).toMatch(/REDACTED_ACCOUNT_ID/);
  });
});

describe('channel activation', () => {
  it('requires admin confirmation', async () => {
    const r = await mock.activateChannel({ workspace_id: wsId, channel: 'strategy', admin_confirmed: false });
    expect(r.ok).toBe(false);
  });
  it('denies sensitive channels even with admin confirmation', async () => {
    const r = await mock.activateChannel({ workspace_id: wsId, channel: 'leadership', admin_confirmed: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('denied_by_default');
  });
  it('activates allowed channels with admin confirmation', async () => {
    const r = await mock.activateChannel({ workspace_id: wsId, channel: 'strategy', admin_confirmed: true });
    expect(r.ok).toBe(true);
  });
});

describe('event ingestion', () => {
  it('rejects events on non-watched channels', async () => {
    const r = await mock.ingestEvent({
      workspace_id: wsId,
      message: { channel: 'random', user: 'U1', text: 'kill the v1 mobile app', ts: '1' },
      mode: 'reaction',
    });
    expect(r.ingested).toBe(false);
    expect(r.reason).toBe('channel_not_watched');
  });

  it('rejects auto_scan when channel has auto_scan=0', async () => {
    await mock.activateChannel({ workspace_id: wsId, channel: 'strategy', admin_confirmed: true });
    const r = await mock.ingestEvent({
      workspace_id: wsId,
      message: { channel: 'strategy', user: 'U1', text: 'kill the v1 mobile app', ts: '1' },
      mode: 'auto_scan',
    });
    expect(r.ingested).toBe(false);
    expect(r.reason).toBe('auto_scan_not_enabled');
  });

  it('ingests reaction-tagged messages and produces candidates', async () => {
    await mock.activateChannel({ workspace_id: wsId, channel: 'strategy', admin_confirmed: true });
    const r = await mock.ingestEvent({
      workspace_id: wsId,
      message: {
        channel: 'strategy',
        user: 'U1',
        text: 'We are killing the v1 mobile app next week; it cost us $40k last quarter.',
        ts: '1',
        reaction: 'pomegranate',
      },
      mode: 'reaction',
    });
    expect(r.ingested).toBe(true);
    expect(r.candidates).toBeGreaterThan(0);
    expect(r.redactions).toBeGreaterThan(0); // $40k redacted

    const inbox = await repo.listCandidates(wsId, { status: 'pending' });
    expect(inbox.length).toBeGreaterThan(0);
  });

  it('audits each ingestion', async () => {
    await mock.activateChannel({ workspace_id: wsId, channel: 'strategy', admin_confirmed: true });
    await mock.ingestEvent({
      workspace_id: wsId,
      message: { channel: 'strategy', user: 'U1', text: 'kill the v1 mobile app', ts: '1', reaction: 'pomegranate' },
      mode: 'reaction',
    });
    const events = (await repo.listAudit(wsId)).map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['slack.channel.activated', 'slack.event.ingested']));
  });
});

describe('pre-ingest preview', () => {
  const NOW = new Date('2026-05-17T12:00:00Z');
  const oneHourAgo = new Date(NOW.getTime() - 3600_000).toISOString();
  const sixDaysAgo = new Date(NOW.getTime() - 6 * 24 * 3600_000).toISOString();
  const eightDaysAgo = new Date(NOW.getTime() - 8 * 24 * 3600_000).toISOString();
  const fourteenDaysAgo = new Date(NOW.getTime() - 14 * 24 * 3600_000).toISOString();

  it('returns a redacted sample of the past-7-day window', () => {
    const window = [
      { channel: 'strategy', user: 'U1', text: 'email me at x@y.com', ts: oneHourAgo },
      { channel: 'strategy', user: 'U2', text: 'we should kill the v1 mobile app, it costs $40k a year to run', ts: sixDaysAgo },
    ];
    const p = mock.preview({ workspace_id: wsId, channel: 'strategy', window, now: NOW });
    expect(p.allowed).toBe(true);
    expect(p.messages_in_window).toBe(2);
    expect(p.rejected_outside_window).toBe(0);
    expect(p.redacted).toBeGreaterThanOrEqual(2);
    expect(p.sample[0]!.text_redacted).toMatch(/REDACTED_EMAIL/);
  });

  it('marks sensitive channels as not allowed in preview', () => {
    const p = mock.preview({
      workspace_id: wsId,
      channel: 'leadership',
      window: [{ channel: 'leadership', user: 'U1', text: 'x', ts: oneHourAgo }],
      now: NOW,
    });
    expect(p.allowed).toBe(false);
  });

  it('enforces the 7-day window: drops anything older', () => {
    const window = [
      { channel: 'strategy', user: 'U1', text: 'inside window 1', ts: oneHourAgo },
      { channel: 'strategy', user: 'U2', text: 'inside window 2', ts: sixDaysAgo },
      { channel: 'strategy', user: 'U3', text: 'outside window — 8 days', ts: eightDaysAgo },
      { channel: 'strategy', user: 'U4', text: 'outside window — 14 days', ts: fourteenDaysAgo },
    ];
    const p = mock.preview({ workspace_id: wsId, channel: 'strategy', window, now: NOW });
    expect(p.messages_in_window).toBe(2);
    expect(p.rejected_outside_window).toBe(2);
    // None of the rejected messages may appear in the sample.
    for (const s of p.sample) {
      expect(s.text_redacted).not.toMatch(/outside window/);
    }
    // The window dates are returned for verification by the caller (UI / SIEM).
    expect(p.window_end).toBe(NOW.toISOString());
    expect(new Date(p.window_start).getTime()).toBe(
      NOW.getTime() - 7 * 24 * 3600_000,
    );
  });

  it('rejects unparseable ts values as outside-window', () => {
    const window = [
      { channel: 'strategy', user: 'U1', text: 'good', ts: oneHourAgo },
      { channel: 'strategy', user: 'U2', text: 'garbage ts', ts: 'not-a-date' },
      { channel: 'strategy', user: 'U3', text: 'epoch placeholder', ts: '1' },
    ];
    const p = mock.preview({ workspace_id: wsId, channel: 'strategy', window, now: NOW });
    expect(p.messages_in_window).toBe(1);
    expect(p.rejected_outside_window).toBe(2);
  });

  it('accepts Slack-native float ts (seconds since epoch)', () => {
    const slackTs = (NOW.getTime() / 1000 - 1800).toFixed(6); // 30 min ago
    const window = [{ channel: 'strategy', user: 'U1', text: 'native slack ts', ts: slackTs }];
    const p = mock.preview({ workspace_id: wsId, channel: 'strategy', window, now: NOW });
    expect(p.messages_in_window).toBe(1);
    expect(p.rejected_outside_window).toBe(0);
  });
});
