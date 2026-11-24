// Unit tests for the Google Drive Composio connector module. routes.ts is NOT
// wired up for the 'googledrive' toolkit yet (a separate pass wires every new
// connector into routes.ts/Sources.tsx in one go — see the task notes in this
// branch), so — unlike github-live.test.ts / github-files.test.ts, which
// exercise the HTTP routes — these tests call drive-live.ts's exported
// functions directly. Every real external call (LLM planner, Composio API) is
// injected via __setDriveLiveTestHooks, so this suite needs zero network and
// passes with no COMPOSIO_API_KEY set.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { __setComposioClientForTests } from '../../lib/composio.js';
import { ResponseTooLargeError, type SafeFetchResult } from '../../lib/safe-fetch.js';
import {
  __setDriveLiveTestHooks,
  driveLiveConfigured,
  ensureDriveAuthConfig,
  startDriveConnect,
  refreshDriveConnectionStatus,
  disconnectDrive,
  planDrivePull,
  searchDriveFiles,
  fetchDriveItems,
  fetchDriveFileContent,
  cacheDrivePreview,
  getDrivePreview,
  renderDriveDocument,
  driveRunRef,
  DriveQueryRequired,
  DriveAgentUnavailable,
  DriveContentUnavailable,
  DriveUnsupportedContentType,
  type DriveLiveItem,
  type DrivePullPlan,
  type DriveSearchResult,
} from './drive-live.js';

let repo: Repo;
// hasStructuredLLM() (src/lib/anthropic.ts) lights up whenever
// ANTHROPIC_API_KEY is set in the environment — which it may well be in a
// developer's own shell (unrelated to this test's key requirement) even
// though CI never sets one. Left alone, the "no LLM configured" test below
// would make a REAL network call to Anthropic and fail on whatever that key
// actually is. Neutralize it for the duration of this suite so behavior is
// deterministic and no live call is ever attempted, matching this file's
// "zero real network calls" requirement.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-drive-'));
  const db = openDb(path.join(tmp, 'p.db'));
  repo = new Repo(db);
});

afterAll(() => {
  if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

afterEach(() => __setDriveLiveTestHooks(null));

function fakeFile(id: string, title: string, mimeType: string, body: string): DriveLiveItem {
  return {
    id,
    title,
    meta: `owner@test.dev · 2026-07-2${id.length % 9} · ${mimeType}`,
    snippet: '',
    body,
  };
}

describe('drive live connector configuration', () => {
  it('is not configured with no hooks and no active connection', () => {
    expect(driveLiveConfigured(undefined)).toBe(false);
    expect(driveLiveConfigured({ status: 'initiated' })).toBe(false);
  });
  it('is configured once a connection is active, or hooks are injected for tests', () => {
    expect(driveLiveConfigured({ status: 'active' })).toBe(true);
    __setDriveLiveTestHooks({});
    expect(driveLiveConfigured(undefined)).toBe(true);
  });
});

describe('drive connection lifecycle (auth config / connect / status / disconnect)', () => {
  it('get-or-creates ONE shared auth config for the googledrive toolkit', async () => {
    let creates = 0;
    __setDriveLiveTestHooks({ authConfigCreator: async () => { creates++; return 'ac_drive_test'; } });
    const first = await ensureDriveAuthConfig(repo);
    expect(first).toBe('ac_drive_test');
    expect(creates).toBe(1);
  });

  it('startDriveConnect mints a redirect link via the linker hook', async () => {
    __setDriveLiveTestHooks({
      authConfigCreator: async () => 'ac_drive_test',
      linker: async (userId, authConfigId, callbackUrl) => {
        expect(userId).toBe('user_1');
        expect(authConfigId).toBe('ac_drive_test');
        expect(callbackUrl).toBe('https://app.test/callback');
        return { id: 'ca_drive_test', redirectUrl: 'https://accounts.google.com/o/oauth2/auth?fake=1' };
      },
    });
    const r = await startDriveConnect(repo, 'user_1', 'https://app.test/callback');
    expect(r).toEqual({ connectedAccountId: 'ca_drive_test', redirectUrl: 'https://accounts.google.com/o/oauth2/auth?fake=1' });
  });

  it('refresh reports live status, never trusting a completed redirect alone', async () => {
    __setDriveLiveTestHooks({ statusChecker: async (id) => (id === 'ca_ok' ? 'active' : 'initiated') });
    expect(await refreshDriveConnectionStatus('ca_ok')).toBe('active');
    expect(await refreshDriveConnectionStatus('ca_pending')).toBe('initiated');
  });

  it('disconnect revokes via the disconnector hook', async () => {
    const revoked: string[] = [];
    __setDriveLiveTestHooks({ disconnector: async (id) => { revoked.push(id); } });
    await disconnectDrive('ca_drive_test');
    expect(revoked).toEqual(['ca_drive_test']);
  });
});

describe('drive pull planning', () => {
  it('plans a search from a free-text query', async () => {
    const plan: DrivePullPlan = {
      searchQuery: 'Q3 roadmap',
      owner: null,
      modifiedAfter: null,
      audience: 'private',
      title: 'Q3 roadmap doc',
    };
    __setDriveLiveTestHooks({ planner: async (q) => { expect(q).toBe('the Q3 roadmap doc'); return plan; } });
    const result = await planDrivePull('the Q3 roadmap doc');
    expect(result).toEqual(plan);
  });

  it('a plan with neither search text nor owner asks for something to search on', async () => {
    __setDriveLiveTestHooks({
      planner: async () => {
        throw new DriveQueryRequired();
      },
    });
    await expect(planDrivePull('pull my document')).rejects.toThrow(/what should I search for/);
  });

  it('without an LLM configured, planning fails closed rather than guessing', async () => {
    // No planner hook and no structured LLM configured in this test env.
    await expect(planDrivePull('the roadmap doc')).rejects.toThrow(DriveAgentUnavailable);
  });
});

describe('drive search (picker list, metadata only)', () => {
  const plan: DrivePullPlan = {
    searchQuery: 'roadmap',
    owner: null,
    modifiedAfter: null,
    audience: 'private',
    title: 'Roadmap docs',
  };

  it('returns multiple matches as picker items with empty bodies (no eager content fetch)', async () => {
    const searchResult: DriveSearchResult = {
      items: [
        fakeFile('f1', 'Q3 Roadmap', 'application/vnd.google-apps.document', ''),
        fakeFile('f2', 'Q3 Roadmap (copy)', 'application/vnd.google-apps.document', ''),
      ],
      mimeTypesById: new Map([
        ['f1', 'application/vnd.google-apps.document'],
        ['f2', 'application/vnd.google-apps.document'],
      ]),
    };
    __setDriveLiveTestHooks({ searcher: async (p, userId, ca) => { expect(p).toEqual(plan); expect(userId).toBe('user_1'); expect(ca).toBe('ca_1'); return searchResult; } });
    const result = await searchDriveFiles(plan, 'user_1', 'ca_1');
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.body).toBe('');
    }
    expect(result.mimeTypesById.get('f1')).toBe('application/vnd.google-apps.document');
  });

  it('a single match still comes back as a one-item picker list (caller decides whether to auto-pull it)', async () => {
    const searchResult: DriveSearchResult = {
      items: [fakeFile('f1', 'Unique Doc', 'application/pdf', '')],
      mimeTypesById: new Map([['f1', 'application/pdf']]),
    };
    __setDriveLiveTestHooks({ searcher: async () => searchResult });
    const result = await searchDriveFiles(plan, 'user_1', 'ca_1');
    expect(result.items).toHaveLength(1);
  });

  it('no matches comes back as an empty picker list, not an error', async () => {
    __setDriveLiveTestHooks({ searcher: async () => ({ items: [], mimeTypesById: new Map() }) });
    const result = await searchDriveFiles(plan, 'user_1', 'ca_1');
    expect(result.items).toEqual([]);
  });

  it('maps live search failures to a thrown error rather than falling back to canned data', async () => {
    __setDriveLiveTestHooks({
      searcher: async () => {
        throw new Error('composio: rate limited');
      },
    });
    await expect(searchDriveFiles(plan, 'user_1', 'ca_1')).rejects.toThrow(/rate limited/);
  });
});

describe('drive content fetch (lazy, per user-picked item)', () => {
  it('fetchDriveItems fetches content ONLY for the picked ids, not the whole search result', async () => {
    const items = [
      fakeFile('f1', 'Picked Doc', 'application/vnd.google-apps.document', ''),
      fakeFile('f2', 'Not Picked Doc', 'application/vnd.google-apps.document', ''),
    ];
    const mimeTypesById = new Map([
      ['f1', 'application/vnd.google-apps.document'],
      ['f2', 'application/vnd.google-apps.document'],
    ]);
    const fetched: string[] = [];
    __setDriveLiveTestHooks({
      contentFetcher: async (fileId, mimeType) => {
        fetched.push(fileId);
        expect(mimeType).toBe('application/vnd.google-apps.document');
        return 'The Q3 roadmap says ship the widget by August.';
      },
    });
    const out = await fetchDriveItems(items, ['f1'], mimeTypesById, 'user_1', 'ca_1');
    expect(fetched).toEqual(['f1']); // f2 never fetched — it wasn't picked
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('f1');
    expect(out[0]!.body).toContain('Picked Doc');
    expect(out[0]!.body).toContain('The Q3 roadmap says ship the widget by August.');
    expect(out[0]!.snippet).toContain('The Q3 roadmap says');
  });

  it('each pulled document is standalone — pulling 2 ids yields 2 independent items (no aggregate mode)', async () => {
    const items = [
      fakeFile('f1', 'Doc One', 'application/pdf', ''),
      fakeFile('f2', 'Doc Two', 'application/pdf', ''),
    ];
    const mimeTypesById = new Map([['f1', 'application/pdf'], ['f2', 'application/pdf']]);
    __setDriveLiveTestHooks({ contentFetcher: async (fileId) => `content of ${fileId}` });
    const out = await fetchDriveItems(items, ['f1', 'f2'], mimeTypesById, 'user_1', 'ca_1');
    expect(out).toHaveLength(2);
    expect(new Set(out.map((i) => i.id)).size).toBe(2);
  });

  it('long content is truncated to the body char cap', async () => {
    const items = [fakeFile('f1', 'Huge Doc', 'text/plain', '')];
    const mimeTypesById = new Map([['f1', 'text/plain']]);
    const huge = 'x'.repeat(5000);
    __setDriveLiveTestHooks({ contentFetcher: async () => huge });
    const out = await fetchDriveItems(items, ['f1'], mimeTypesById, 'user_1', 'ca_1');
    expect(out[0]!.body).toContain('…[truncated]');
    expect(out[0]!.body.length).toBeLessThan(huge.length);
  });

  it('a Workspace doc requests a text export mime type; a native file requests none', async () => {
    const calls: Array<{ fileId: string; mimeType: string | undefined }> = [];
    __setDriveLiveTestHooks({
      contentFetcher: async (fileId, mimeType) => {
        calls.push({ fileId, mimeType });
        return 'body';
      },
    });
    await fetchDriveFileContent('doc1', 'application/vnd.google-apps.document', 'user_1', 'ca_1');
    await fetchDriveFileContent('pdf1', 'application/pdf', 'user_1', 'ca_1');
    expect(calls).toEqual([
      { fileId: 'doc1', mimeType: 'application/vnd.google-apps.document' },
      { fileId: 'pdf1', mimeType: 'application/pdf' },
    ]);
  });

  it('without hooks or a COMPOSIO_API_KEY, a content fetch fails closed rather than silently no-opping', async () => {
    // No contentFetcher hook + no COMPOSIO_API_KEY -> getComposioClient()
    // throws before ever reaching the response-parsing code, which is
    // exactly the fail-closed behavior we want: no key means no live call is
    // attempted (this test suite never sets COMPOSIO_API_KEY, matching the
    // "tests run with zero network / no key" requirement).
    const saved = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
    try {
      await expect(fetchDriveFileContent('f1', 'application/pdf', 'user_1', 'ca_1')).rejects.toThrow();
    } finally {
      if (saved !== undefined) process.env.COMPOSIO_API_KEY = saved;
    }
  });
});

describe('drive content extraction (real Composio response shape)', () => {
  // These tests exercise fetchDriveFileContent's non-hooked path (a fake
  // Composio client + a mocked global fetch), unlike the suite above which
  // bypasses parsing entirely via contentFetcher. Shape confirmed live
  // 2026-07-29 against a real connected account: GOOGLEDRIVE_DOWNLOAD_FILE
  // never inlines content — it returns
  // `downloaded_file_content: { mimetype, name, s3url }`, a presigned URL
  // that must be fetched separately.
  const savedComposioKey = process.env.COMPOSIO_API_KEY;

  beforeAll(() => {
    process.env.COMPOSIO_API_KEY = 'test-composio-key';
  });

  afterAll(() => {
    if (savedComposioKey !== undefined) process.env.COMPOSIO_API_KEY = savedComposioKey;
    else delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    __setComposioClientForTests(null);
    vi.unstubAllGlobals();
  });

  const okDownload = (text: string): SafeFetchResult => ({
    status: 200,
    contentType: 'text/plain',
    body: Buffer.from(text, 'utf8'),
    url: 'https://r2.example/presigned',
  });

  it('fetches and returns the body from downloaded_file_content.s3url', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: {
        id: 'f1',
        name: 'JBTD Doc',
        mimeType: 'application/vnd.google-apps.document',
        export_applied: true,
        downloaded_file_content: { mimetype: 'text/plain', name: 'JBTD Doc', s3url: 'https://r2.example/presigned' },
      },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const fetchMock = vi.fn().mockResolvedValue(okDownload('the actual document body'));
    __setDriveLiveTestHooks({ downloadFetcher: fetchMock });

    const text = await fetchDriveFileContent('f1', 'application/vnd.google-apps.document', 'user_1', 'ca_1');

    expect(text).toBe('the actual document body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://r2.example/presigned');
    // The download goes through safeFetch with a size cap and a timeout.
    expect(opts.maxBytes).toBe(25 * 1024 * 1024);
    expect(opts.timeoutMs).toBeGreaterThan(0);
  });

  it('uses the real safeFetch by default, which refuses a presigned URL pointing at a private address', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: { downloaded_file_content: { mimetype: 'text/plain', name: 'x', s3url: 'http://169.254.169.254/latest/meta-data/' } },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchDriveFileContent('f1', 'text/plain', 'user_1', 'ca_1')).rejects.toThrow(DriveContentUnavailable);
    expect(fetchSpy).not.toHaveBeenCalled(); // raw fetch is no longer used
  });

  it('maps an oversized download to DriveContentUnavailable', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: { downloaded_file_content: { mimetype: 'text/plain', name: 'x', s3url: 'https://r2.example/huge' } },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    __setDriveLiveTestHooks({ downloadFetcher: vi.fn().mockRejectedValue(new ResponseTooLargeError(25 * 1024 * 1024)) });

    await expect(fetchDriveFileContent('f1', 'text/plain', 'user_1', 'ca_1')).rejects.toThrow(DriveContentUnavailable);
  });

  it('rejects a binary mime type (video) without fetching the s3url', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: {
        id: 'f1',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        downloaded_file_content: { mimetype: 'video/mp4', name: 'clip.mp4', s3url: 'https://r2.example/presigned' },
      },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    const fetchMock = vi.fn();
    __setDriveLiveTestHooks({ downloadFetcher: fetchMock });

    await expect(fetchDriveFileContent('f1', 'video/mp4', 'user_1', 'ca_1')).rejects.toThrow(DriveUnsupportedContentType);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects other known-binary mime types (zip, pdf, image)', async () => {
    for (const mimetype of ['application/zip', 'application/pdf', 'image/png']) {
      const execute = vi.fn().mockResolvedValue({
        successful: true,
        error: null,
        data: { downloaded_file_content: { mimetype, name: 'x', s3url: 'https://r2.example/presigned' } },
      });
      __setComposioClientForTests({ tools: { execute } } as any);
      const fetchMock = vi.fn();
      __setDriveLiveTestHooks({ downloadFetcher: fetchMock });

      await expect(fetchDriveFileContent('f1', mimetype, 'user_1', 'ca_1')).rejects.toThrow(DriveUnsupportedContentType);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('throws DriveContentUnavailable if the presigned URL itself fails', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: { downloaded_file_content: { mimetype: 'text/plain', name: 'x', s3url: 'https://r2.example/expired' } },
    });
    __setComposioClientForTests({ tools: { execute } } as any);
    __setDriveLiveTestHooks({ downloadFetcher: vi.fn().mockResolvedValue({ ...okDownload('expired'), status: 403 }) });

    await expect(fetchDriveFileContent('f1', 'text/plain', 'user_1', 'ca_1')).rejects.toThrow(DriveContentUnavailable);
  });

  it('still throws DriveContentUnavailable on a genuinely unrecognized shape', async () => {
    const execute = vi.fn().mockResolvedValue({ successful: true, error: null, data: { unexpected: 'shape' } });
    __setComposioClientForTests({ tools: { execute } } as any);

    await expect(fetchDriveFileContent('f1', 'text/plain', 'user_1', 'ca_1')).rejects.toThrow(/unrecognized response shape/);
  });

  it('falls back to an inline base64 `data.content` field if one is ever present', async () => {
    const execute = vi.fn().mockResolvedValue({
      successful: true,
      error: null,
      data: { content: Buffer.from('inline body').toString('base64') },
    });
    __setComposioClientForTests({ tools: { execute } } as any);

    const text = await fetchDriveFileContent('f1', 'text/plain', 'user_1', 'ca_1');
    expect(text).toBe('inline body');
  });
});

describe('preview -> pull handoff cache', () => {
  it('round-trips a cached preview by key + query', () => {
    const plan: DrivePullPlan = { searchQuery: 'roadmap', owner: null, modifiedAfter: null, audience: 'private', title: 'Roadmap' };
    const items = [fakeFile('f1', 'Roadmap', 'application/pdf', '')];
    cacheDrivePreview('key1', { query: 'the roadmap', plan, items, mimeTypesById: new Map([['f1', 'application/pdf']]) });
    const hit = getDrivePreview('key1', 'the roadmap');
    expect(hit?.plan).toEqual(plan);
    expect(hit?.items).toEqual(items);
  });

  it('a mismatched query is treated as a cache miss (stale preview, new question)', () => {
    const plan: DrivePullPlan = { searchQuery: 'roadmap', owner: null, modifiedAfter: null, audience: 'private', title: 'Roadmap' };
    cacheDrivePreview('key2', { query: 'the roadmap', plan, items: [], mimeTypesById: new Map() });
    expect(getDrivePreview('key2', 'a totally different query')).toBeNull();
  });

  it('an unknown key is a cache miss', () => {
    expect(getDrivePreview('never-cached', 'anything')).toBeNull();
  });
});

describe('error classes', () => {
  it('DriveContentUnavailable names the file id and cause', () => {
    const err = new DriveContentUnavailable('f1', 'unrecognized shape');
    expect(err.message).toContain('f1');
    expect(err.message).toContain('unrecognized shape');
  });
});

describe('rendering', () => {
  it('renderDriveDocument returns the item body verbatim, with no # tokens (would be parsed as a subgraph pin)', () => {
    const item = fakeFile('f1', 'Doc', 'application/pdf', 'Some body text with no hashes.');
    expect(renderDriveDocument(item)).toBe('Some body text with no hashes.');
    expect(renderDriveDocument(item)).not.toContain('#');
  });

  it('driveRunRef embeds the document title', () => {
    const item = fakeFile('f1', 'Q3 Roadmap', 'application/pdf', 'body');
    expect(driveRunRef(item)).toContain('Q3 Roadmap');
    expect(driveRunRef(item)).toMatch(/^drive: /);
  });
});
