import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { CachedSynth } from './cached.js';
import { TestSynthStub as HeuristicProvider } from '../../__test_utils__/synth-stub.js';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';
import type { Node } from '../../lib/schemas.js';

const ts = '2026-01-01T00:00:00Z';
const graph: Node[] = [
  {
    id: 'pos-banned-synergy',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'synergy',
    kind: 'banned_phrase',
  },
];

describe('CachedSynth', () => {
  it('caches feedback results by workspace+graph+request shape', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repo = new Repo(db);
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    let calls = 0;
    const counting = {
      ...HeuristicProvider,
      name: 'counting',
      async feedback(opts: any) {
        calls++;
        return HeuristicProvider.feedback(opts);
      },
    };
    const cached = new CachedSynth(counting as any, repo, ws.id);
    const f1 = await cached.feedback({ graph, deliverable: 'use the synergy here', kind: 'campaign' });
    const f2 = await cached.feedback({ graph, deliverable: 'use the synergy here', kind: 'campaign' });
    expect(f1).toEqual(f2);
    expect(calls).toBe(1);
  });

  it('cache miss on different deliverable', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repo = new Repo(db);
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    let calls = 0;
    const counting = {
      ...HeuristicProvider,
      name: 'counting',
      async feedback(opts: any) {
        calls++;
        return HeuristicProvider.feedback(opts);
      },
    };
    const cached = new CachedSynth(counting as any, repo, ws.id);
    await cached.feedback({ graph, deliverable: 'one', kind: 'campaign' });
    await cached.feedback({ graph, deliverable: 'two', kind: 'campaign' });
    expect(calls).toBe(2);
  });

  it('cross-workspace cache key isolation', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repo = new Repo(db);
    const a = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    const b = await repo.createWorkspace({ name: 'B', owner_email: 'b@b.com' });
    let calls = 0;
    const counting = {
      ...HeuristicProvider,
      name: 'counting',
      async feedback(opts: any) {
        calls++;
        return HeuristicProvider.feedback(opts);
      },
    };
    const cachedA = new CachedSynth(counting as any, repo, a.id);
    const cachedB = new CachedSynth(counting as any, repo, b.id);
    await cachedA.feedback({ graph, deliverable: 'identical', kind: 'campaign' });
    await cachedB.feedback({ graph, deliverable: 'identical', kind: 'campaign' });
    // Same deliverable, same (mock) graph — but different workspaces → both must call through.
    expect(calls).toBe(2);
  });

  it('profile hash partitions the cache (a profile edit invalidates cleanly)', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const repo = new Repo(db);
    const ws = await repo.createWorkspace({ name: 'A', owner_email: 'a@a.com' });
    let calls = 0;
    const counting = {
      ...HeuristicProvider,
      name: 'counting',
      async feedback(opts: any) {
        calls++;
        return HeuristicProvider.feedback(opts);
      },
    };
    // Same workspace + graph + request, but two different profile snapshots →
    // distinct cache keys (spec B5: profile edits invalidate cleanly).
    const cachedV1 = new CachedSynth(counting as any, repo, ws.id, undefined, foundingProfile);
    const edited = { ...foundingProfile, description: foundingProfile.description + ' (edited)' };
    const cachedV2 = new CachedSynth(counting as any, repo, ws.id, undefined, edited);
    await cachedV1.feedback({ graph, deliverable: 'identical', kind: 'campaign' });
    await cachedV2.feedback({ graph, deliverable: 'identical', kind: 'campaign' });
    expect(calls).toBe(2);
    // A second call under the original profile hits the cache (no extra call).
    await cachedV1.feedback({ graph, deliverable: 'identical', kind: 'campaign' });
    expect(calls).toBe(2);
  });
});
