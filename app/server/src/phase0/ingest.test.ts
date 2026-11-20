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
import { ingest } from './ingest.js';

let tmp: string;
let docs: string;
let storage: FileStorage;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-ingest-'));
  docs = path.join(tmp, 'docs');
  await fs.mkdir(docs);
  storage = new FileStorage({ rootDir: path.join(tmp, '.pomegranate') });
  await storage.init();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('ingest CLI', () => {
  it('produces candidates from a strategy doc and writes backlog + state', async () => {
    await fs.writeFile(
      path.join(docs, 'strategy.md'),
      `# Q3 2026 strategy

Our north star is mid-market ARR. We decided 2026-05-01 to retire the v1 mobile
app. We are positioned as the strategy-graph layer Claude consults. The phrase
"all-in-one" is banned.
`,
    );

    const result = await ingest({
      storage,
      sources: [docs],
      verbose: false,
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.candidates.length).toBeGreaterThan(0);

    // Backlog written
    const backlog = await fs.readFile(storage.backlogPath, 'utf8');
    expect(backlog.length).toBeGreaterThan(0);
    expect(backlog).toMatch(/<(red|yellow|green)>/);

    // State has the hash
    const state = await storage.readState();
    expect(state.hashes).toBeDefined();

    // Second run is incremental: same content, zero processed
    const result2 = await ingest({
      storage,
      sources: [docs],
    });
    expect(result2.filesProcessed).toBe(0);
    expect(result2.filesSkipped).toBe(1);

    // Force re-run processes again
    const result3 = await ingest({
      storage,
      sources: [docs],
      force: true,
    });
    expect(result3.filesProcessed).toBe(1);
  }, 120_000);
});
