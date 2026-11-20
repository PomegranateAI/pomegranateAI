import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Substitute the production Anthropic provider with the deterministic test
// stub so this test exercises the pipeline without hitting the paid API.
vi.mock('../lib/synthesis.js', async () => {
  const real = await vi.importActual<typeof import('../lib/synthesis.js')>('../lib/synthesis.js');
  const stub = await import('../__test_utils__/synth-stub.js');
  return { ...real, getProvider: () => stub.TestSynthStub };
});

import { FileStorage } from '../lib/storage.js';
import { review } from './review.js';
import type { Node } from '../lib/schemas.js';

let tmp: string;
let storage: FileStorage;

const ts = '2026-01-01T00:00:00Z';

const seedGraph: Node[] = [
  {
    id: 'pos-killed-allinone',
    type: 'positioning',
    created_at: ts,
    updated_at: ts,
    status: 'active',
    body: 'We are not the all-in-one revenue platform',
    kind: 'killed_messaging',
  },
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

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-review-'));
  storage = new FileStorage({ rootDir: tmp });
  await storage.init();
  for (const n of seedGraph) await storage.writeNode(n);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('review hook', () => {
  it('skips a pure refactor interaction → appends to skipped.log', async () => {
    const r = await review(
      {
        prompt: 'refactor this CRUD endpoint to use the new ORM',
        response: 'Here is the refactored code with Prisma...',
      },
      { storage },
    );
    expect(r.reviewed).toBe(false);
    const skipped = await fs.readFile(storage.skippedLogPath, 'utf8');
    expect(skipped.length).toBeGreaterThan(0);
  }, 60_000);

  it('reviews a strategic draft → writes review file with findings', async () => {
    const r = await review(
      {
        prompt: 'draft a campaign brief for the mid-market launch',
        response:
          'Our all-in-one revenue platform unlocks synergy across teams. The new v1 mobile app creates momentum.',
      },
      { storage, kind: 'campaign' },
    );
    expect(r.reviewed).toBe(true);
    expect(r.reviewPath).toBeDefined();
    const reviewMd = await fs.readFile(r.reviewPath!, 'utf8');
    expect(reviewMd).toMatch(/red|yellow/);
    // Index updated
    const idx = await fs.readFile(storage.indexPath, 'utf8');
    expect(idx.length).toBeGreaterThan(0);
  }, 90_000);

  it('drops <red> finding that lacks a real node citation (integrity gate)', async () => {
    const r = await review(
      {
        prompt: 'draft the exec update',
        response:
          'Q2 update: we are doubling down on enterprise, killing self-serve, and shipping the new platform.',
      },
      { storage, forceRelevant: true, kind: 'exec_update' },
    );
    expect(r.reviewed).toBe(true);
    const reviewMd = await fs.readFile(r.reviewPath!, 'utf8');
    // Every <red> in the file must include a → `id` arrow (cite). Parse loosely.
    const lines = reviewMd.split('\n');
    for (const line of lines) {
      if (line.includes('<red>')) {
        // Look for the citation arrow on the same line or the next non-empty line.
        expect(line.includes('→') || /`[a-z0-9-]+`/.test(line)).toBe(true);
      }
    }
  }, 90_000);
});
