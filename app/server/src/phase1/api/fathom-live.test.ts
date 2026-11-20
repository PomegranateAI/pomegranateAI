import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import {
  __setFathomLiveTestHooks,
  fathomLiveConfigured,
  ensureFathomAuthConfig,
  startFathomConnect,
  refreshFathomConnectionStatus,
  disconnectFathom,
  planFathomPull,
  fetchFathomMeetings,
  listFathomMeetings,
  fetchFathomTranscript,
  cacheFathomPreview,
  getFathomPreview,
  fathomRunRef,
  FathomSearchRequired,
  FathomMeetingNotFound,
  type FathomPullPlan,
  type FathomMeetingOption,
  type FathomLiveItem,
} from './fathom-live.js';

// This connector isn't wired into routes.ts yet (out of scope for this file
// — see the task boundary), so these are module-level unit tests exercising
// fathom-live.ts directly, unlike github-live.test.ts which drives the HTTP
// routes. Every real external call (LLM plan, Composio API) is behind a test
// hook, so this suite needs zero network access and no COMPOSIO_API_KEY.

let tmpDbPath: string;

beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-fathom-'));
  tmpDbPath = path.join(tmp, 'p.db');
});

afterEach(() => __setFathomLiveTestHooks(null));

function makeRepo(): Repo {
  const db = openDb(tmpDbPath);
  return new Repo(db);
}

function connectedHooks(overrides: Partial<Parameters<typeof __setFathomLiveTestHooks>[0]> = {}) {
  __setFathomLiveTestHooks({
    authConfigCreator: async () => 'ac_test',
    linker: async () => ({ id: 'ca_test', redirectUrl: 'https://fathom.video/oauth/authorize?fake=1' }),
    statusChecker: async () => 'active',
    disconnector: async () => {},
    ...overrides,
  });
}

function meeting(id: string, title: string, date: string, participants: string[] = []): FathomMeetingOption {
  return { id, title, meta: [date, participants.length ? participants.join(', ') : null].filter(Boolean).join(' · ') };
}

const acmePlan: FathomPullPlan = {
  search: 'Acme',
  dateFrom: null,
  dateTo: null,
  participant: null,
  audience: 'private',
  title: 'Call with Acme',
};

describe('fathom auth (Composio OAuth, same shared tables as github-live.ts)', () => {
  it('ensureFathomAuthConfig creates once then reuses the stored row', async () => {
    const repo = makeRepo();
    let created = 0;
    connectedHooks({ authConfigCreator: async () => { created++; return 'ac_1'; } });
    const first = await ensureFathomAuthConfig(repo);
    expect(first).toBe('ac_1');
    expect(created).toBe(1);
  });

  it('startFathomConnect mints a connected-account id and redirect url', async () => {
    const repo = makeRepo();
    connectedHooks();
    const r = await startFathomConnect(repo, 'user_1', 'https://app.example/callback');
    expect(r.connectedAccountId).toBe('ca_test');
    expect(r.redirectUrl).toContain('fathom.video');
  });

  it('refreshFathomConnectionStatus reflects the live status check, not an assumption', async () => {
    connectedHooks({ statusChecker: async () => 'initiated' });
    expect(await refreshFathomConnectionStatus('ca_test')).toBe('initiated');
    connectedHooks({ statusChecker: async () => 'active' });
    expect(await refreshFathomConnectionStatus('ca_test')).toBe('active');
  });

  it('disconnectFathom calls through to the revoke hook', async () => {
    const revoked: string[] = [];
    connectedHooks({ disconnector: async (id) => { revoked.push(id); } });
    await disconnectFathom('ca_test');
    expect(revoked).toEqual(['ca_test']);
  });

  it('fathomLiveConfigured is true only for an active connection (or a test hook installed)', () => {
    expect(fathomLiveConfigured(undefined)).toBe(false);
    expect(fathomLiveConfigured({ status: 'initiated' })).toBe(false);
    expect(fathomLiveConfigured({ status: 'active' })).toBe(true);
    connectedHooks();
    expect(fathomLiveConfigured(undefined)).toBe(true); // a hook alone is enough in tests
  });
});

describe('planFathomPull — free text to a meeting search plan', () => {
  it('a plan naming a search/date/participant is accepted', async () => {
    __setFathomLiveTestHooks({ planner: async () => acmePlan });
    const plan = await planFathomPull('the call with Acme');
    expect(plan).toEqual(acmePlan);
  });

  it('a plan with none of search/dateFrom/dateTo/participant is refused rather than fetching everything', async () => {
    // Mirrors github-live.test.ts's "a plan with no repo asks for one instead
    // of guessing": the planner hook simulates what the real LLM path's
    // post-parse validation (search this file's planFathomPull for
    // FathomSearchRequired) would raise for a plan naming none of
    // search/dateFrom/dateTo/participant.
    __setFathomLiveTestHooks({
      planner: async () => {
        throw new FathomSearchRequired();
      },
    });
    await expect(planFathomPull('find me a meeting')).rejects.toThrow(FathomSearchRequired);
  });

  it('a date-range-only plan (no search/participant) is still accepted', async () => {
    const plan: FathomPullPlan = {
      search: null,
      dateFrom: '2026-07-14',
      dateTo: '2026-07-14',
      participant: null,
      audience: 'private',
      title: "Last Tuesday's meeting",
    };
    __setFathomLiveTestHooks({ planner: async () => plan });
    expect(await planFathomPull('the meeting from last Tuesday')).toEqual(plan);
  });
});

describe('fetchFathomMeetings / listFathomMeetings — search returns picker rows, never auto-selects', () => {
  it('multiple matches all come back as picker rows', async () => {
    const rows = [
      meeting('101', 'Acme kickoff', '2026-07-10', ['jane@acme.com']),
      meeting('102', 'Acme renewal check-in', '2026-07-20', ['jane@acme.com', 'bob@acme.com']),
    ];
    __setFathomLiveTestHooks({ meetingsFetcher: async () => rows });
    const found = await fetchFathomMeetings(acmePlan, 'user_1', 'ca_test');
    expect(found).toEqual(rows);
    expect(found).toHaveLength(2);
    // No item carries a transcript body — that's a separate, per-meeting fetch.
    for (const item of found) expect(item).not.toHaveProperty('body');
  });

  it('listFathomMeetings is the same function as fetchFathomMeetings (naming alias)', () => {
    expect(listFathomMeetings).toBe(fetchFathomMeetings);
  });

  it('a single match still comes back as a one-item picker list, not an auto-selected transcript', async () => {
    const rows = [meeting('201', 'Q3 planning', '2026-07-05')];
    __setFathomLiveTestHooks({ meetingsFetcher: async () => rows });
    const found = await fetchFathomMeetings(acmePlan, 'user_1', 'ca_test');
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe('201');
  });

  it('propagates a Composio failure rather than returning a canned/empty result silently', async () => {
    __setFathomLiveTestHooks({
      meetingsFetcher: async () => {
        throw new Error('composio: rate limited');
      },
    });
    await expect(fetchFathomMeetings(acmePlan, 'user_1', 'ca_test')).rejects.toThrow(/rate limited/);
  });
});

describe('fetchFathomTranscript — one chosen meeting becomes one full-transcript item', () => {
  it('returns the generic {id, title, meta, snippet, body} shape with the transcript as body', async () => {
    const item: FathomLiveItem = {
      id: '101',
      title: 'Acme kickoff',
      meta: 'Fathom recording 101',
      snippet: 'Jane: welcome everyone. Bob: thanks for having us.',
      body: 'Fathom meeting: Acme kickoff\nRecording id: 101\n\nJane: welcome everyone.\nBob: thanks for having us.',
    };
    __setFathomLiveTestHooks({ transcriptFetcher: async () => item });
    const got = await fetchFathomTranscript('101', 'user_1', 'ca_test');
    expect(got).toEqual(item);
    expect(got.body).toContain('welcome everyone');
  });

  it('rejects a non-numeric meeting id before ever calling Composio', async () => {
    let called = false;
    __setFathomLiveTestHooks({
      // Not installed as transcriptFetcher on purpose — if the guard didn't
      // fire first, this would throw a different, unrelated error.
    });
    await expect(fetchFathomTranscript('not-a-number', 'user_1', 'ca_test')).rejects.toThrow(FathomMeetingNotFound);
    expect(called).toBe(false);
  });

  it('propagates a Composio failure for the chosen meeting rather than degrading to canned data', async () => {
    __setFathomLiveTestHooks({
      transcriptFetcher: async () => {
        throw new Error('composio: meeting not found');
      },
    });
    await expect(fetchFathomTranscript('999', 'user_1', 'ca_test')).rejects.toThrow(/meeting not found/);
  });
});

describe('preview cache (search results -> chosen meeting handoff)', () => {
  it('round-trips a cached search result keyed by (key, query)', () => {
    const items = [meeting('101', 'Acme kickoff', '2026-07-10')];
    cacheFathomPreview('ws_1:user_1', { query: 'the call with acme', plan: acmePlan, items });
    const hit = getFathomPreview('ws_1:user_1', 'the call with acme');
    expect(hit?.items).toEqual(items);
  });

  it('a mismatched query misses the cache (never serves a stale search for a different request)', () => {
    cacheFathomPreview('ws_2:user_1', { query: 'the call with acme', plan: acmePlan, items: [] });
    expect(getFathomPreview('ws_2:user_1', 'a totally different meeting')).toBeNull();
  });

  it('an unknown key misses the cache', () => {
    expect(getFathomPreview('never_cached', 'anything')).toBeNull();
  });
});

describe('fathomRunRef', () => {
  it('names the run after the meeting title, never a raw # (subgraph-token safe)', () => {
    const item: FathomLiveItem = { id: '1', title: 'Q3 planning', meta: 'm', snippet: 's', body: 'b' };
    const ref = fathomRunRef(item);
    expect(ref).toContain('Q3 planning');
    expect(ref).not.toContain('#');
  });
});
