import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStorage } from './storage.js';
import type { Node } from './schemas.js';

let tmp: string;
let storage: FileStorage;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-storage-'));
  storage = new FileStorage({ rootDir: tmp });
  await storage.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('FileStorage round-trip', () => {
  it('round-trips a goal node', async () => {
    const node: Node = {
      id: 'goal-q2-northstar',
      type: 'goal',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      status: 'active',
      title: 'Q2 north star: mid-market ARR',
      body: 'Land 10 mid-market design partners by EOQ2.',
      priority: 'north_star',
      period: 'Q2 2026',
    };
    const filename = await storage.writeNode(node);
    const back = await storage.readNode(filename);
    expect(back).toEqual(node);
  });

  it('round-trips a positioning node', async () => {
    const node: Node = {
      id: 'positioning-killed-allinone',
      type: 'positioning',
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      status: 'active',
      body: 'We are not the all-in-one revenue platform.',
      kind: 'killed_messaging',
    };
    const filename = await storage.writeNode(node);
    const back = await storage.readNode(filename);
    expect(back).toEqual(node);
  });

  it('round-trips a decision node', async () => {
    const node: Node = {
      id: 'decision-mobile-2026-04-30',
      type: 'decision',
      created_at: '2026-04-30T00:00:00Z',
      updated_at: '2026-04-30T00:00:00Z',
      status: 'active',
      summary: 'Retired the v1 mobile app',
      body: 'Leadership decided to drop the v2 beta in favor of a staged rollout for enterprise.',
      decided_on: '2026-04-30',
      decided_by: 'CRO',
      category: 'scope',
    };
    const filename = await storage.writeNode(node);
    const back = await storage.readNode(filename);
    expect(back).toEqual(node);
  });

  it('readGraph returns only active nodes', async () => {
    await storage.writeNode({
      id: 'a',
      type: 'positioning',
      created_at: 'x',
      updated_at: 'x',
      status: 'active',
      body: 'foo',
      kind: 'stance',
    });
    await storage.writeNode({
      id: 'b',
      type: 'positioning',
      created_at: 'x',
      updated_at: 'x',
      status: 'archived',
      body: 'bar',
      kind: 'stance',
    });
    const graph = await storage.readGraph();
    expect(graph).toHaveLength(1);
    expect(graph[0]!.id).toBe('a');
  });

  it('state.json round-trips', async () => {
    await storage.writeState({ lastRun: 'now', hashes: { a: 'b' } });
    const back = await storage.readState();
    expect(back.lastRun).toBe('now');
    expect((back.hashes as any).b).toBeUndefined();
    expect((back.hashes as any).a).toBe('b');
  });

  it('appendSkipped writes one line per call', async () => {
    await storage.appendSkipped('one');
    await storage.appendSkipped('two');
    const raw = await fs.readFile(storage.skippedLogPath, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toEqual(['one', 'two']);
  });
});
