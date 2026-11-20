import { describe, it, expect } from 'vitest';
import { FLAG_DEFAULTS, FlagError, parseFlags } from './flags.js';
import { CryptoError, passthroughCrypto } from './crypto.js';
import { BlobKeyError, blobKey, memoryBlobStore } from './blob.js';
import { JOB_KINDS, memoryJobQueue } from './jobs.js';
import { SEAL_MAP } from './seal-map.js';
import { ENV_SCHEMA, secretEnvNames } from './config.js';
import { AUDIT_EVENTS, memoryLogger } from './log.js';

describe('C9 flags', () => {
  it('defaults to the single-server setup', () => {
    expect(parseFlags({})).toEqual(FLAG_DEFAULTS);
  });

  it('parses every value and dedupes surfaces', () => {
    expect(
      parseFlags({
        POMEGRANATE_DB_DRIVER: 'pg',
        POMEGRANATE_BLOB_DRIVER: 'azure',
        POMEGRANATE_KEY_PROVIDER: 'azurekv',
        POMEGRANATE_JOB_QUEUE: 'pg',
        POMEGRANATE_SEAL: '1',
        SURFACES: 'slack, whatsapp,slack',
        MCP_CAPABILITY_URLS: '0',
      }),
    ).toEqual({
      dbDriver: 'pg',
      blobDriver: 'azure',
      keyProvider: 'azurekv',
      jobQueue: 'pg',
      seal: true,
      surfaces: ['slack', 'whatsapp'],
      mcpCapabilityUrls: false,
    });
  });

  it('fails on a typo instead of falling back', () => {
    expect(() => parseFlags({ POMEGRANATE_DB_DRIVER: 'postgres' })).toThrow(FlagError);
    expect(() => parseFlags({ POMEGRANATE_SEAL: 'true' })).toThrow(FlagError);
    expect(() => parseFlags({ SURFACES: 'teams' })).toThrow(FlagError);
  });
});

describe('C3 pass-through crypto (SEAL=0)', () => {
  const c = passthroughCrypto();
  it('is the identity on write and read', async () => {
    expect(c.sealing).toBe(false);
    expect(await c.seal('ws_a', 'source_chunks.text', 'r1', 'hello')).toBe('hello');
    expect(await c.open('ws_a', 'source_chunks.text', 'r1', 'hello')).toBe('hello');
    const b = Buffer.from([1, 2, 3]);
    expect(await c.openBytes('ws_a', 'k', await c.sealBytes('ws_a', 'k', b))).toEqual(b);
  });

  it('refuses to return ciphertext as text', async () => {
    await expect(c.open('ws_a', 'source_chunks.text', 'r1', 'v1:1:abc:def')).rejects.toBeInstanceOf(CryptoError);
    await expect(c.openBytes('ws_a', 'k', Buffer.from('PGE1xxxx'))).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('C4 seal map', () => {
  it('keys are table.column and json-fields entries name their fields', () => {
    for (const [col, e] of Object.entries(SEAL_MAP)) {
      expect(col).toMatch(/^[a-z_]+\.[a-z_]+$/);
      if (e.kind === 'json-fields') expect(e.fields?.length).toBeGreaterThan(0);
      // decision B: titles stay plaintext
      expect(e.fields ?? []).not.toContain('title');
    }
  });
});

describe('C5 blob store', () => {
  it('round-trips and lists within a workspace', async () => {
    const s = memoryBlobStore();
    await s.put('ws_a', blobKey('ws_a', 'sources', 's1.pdf'), Buffer.from('x'));
    await s.put('ws_a', blobKey('ws_a', 'media', 'm1'), Buffer.from('yy'));
    expect((await s.get('ws_a', 'ws_a/sources/s1.pdf'))?.toString()).toBe('x');
    expect((await s.list('ws_a', 'sources/')).map((o) => o.key)).toEqual(['ws_a/sources/s1.pdf']);
    expect(await s.deleteWorkspace('ws_a')).toBe(2);
  });

  it('rejects cross-workspace keys', async () => {
    const s = memoryBlobStore();
    await expect(s.get('ws_a', 'ws_b/sources/s1')).rejects.toBeInstanceOf(BlobKeyError);
    await expect(s.get('ws_a', 'ws_a/../ws_b/x')).rejects.toBeInstanceOf(BlobKeyError);
    expect(() => blobKey('ws_a', 'sources', '../x')).toThrow(BlobKeyError);
  });
});

describe('C6 job queue', () => {
  it('runs a registered job, retries on failure, and dedupes while queued', async () => {
    const q = memoryJobQueue();
    let calls = 0;
    q.registerJob('embed.node', async (_p, ctx) => {
      calls++;
      if (ctx.attempt === 1) throw new Error('transient');
    });
    const id = await q.enqueue('embed.node', { nodeId: 'n1' }, { workspaceId: 'ws_a', dedupeKey: 'n1' });
    expect(id).not.toBeNull();
    expect(await q.enqueue('embed.node', { nodeId: 'n1' }, { workspaceId: 'ws_a', dedupeKey: 'n1' })).toBeNull();
    await q.idle();
    expect(calls).toBe(2);
    expect(() => q.registerJob('embed.node', async () => {})).toThrow();
  });

  it('job kinds are unique', () => {
    expect(new Set(JOB_KINDS).size).toBe(JOB_KINDS.length);
  });
});

describe('C7 env schema', () => {
  it('names are unique and every C9 flag is listed', () => {
    const names = ENV_SCHEMA.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of ['POMEGRANATE_DB_DRIVER', 'POMEGRANATE_BLOB_DRIVER', 'POMEGRANATE_KEY_PROVIDER', 'POMEGRANATE_JOB_QUEUE', 'POMEGRANATE_SEAL', 'SURFACES', 'MCP_CAPABILITY_URLS']) {
      expect(names).toContain(f);
    }
    expect(secretEnvNames()).toContain('ANTHROPIC_API_KEY');
  });
});

describe('C8 logging + C10 runtime', () => {
  it('emits one JSON object per line', () => {
    const l = memoryLogger();
    l.info('api.boot', { port: 3000 });
    expect(JSON.parse(l.lines[0]!)).toMatchObject({ level: 'info', event: 'api.boot', port: 3000 });
    expect(AUDIT_EVENTS).toContain('key.unwrap_failed');
  });
});
