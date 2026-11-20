import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStorage } from '../../lib/storage.js';
import { captureSession, ContentSession } from './capture-session.js';

describe('captureSession', () => {
  let tmpDir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-capture-test-'));
    storage = new FileStorage({ rootDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const validPayload = {
    kind: 'content-strategy-session',
    schema_version: 1,
    captured_at: '2026-05-19T10:00:00.000Z',
    topic: 'LinkedIn launch post anchoring the content-strategy thesis',
    artifacts: [
      { surface: 'linkedin-post', label: 'v1', text: 'first draft body...' },
      { surface: 'linkedin-post', label: 'v2', text: 'second draft body...' },
    ],
    feedback: [
      { on: 'v1', kind: 'style', note: 'remove AI-tell phrasings like Not X, Y' },
      { on: 'v2', kind: 'banned', note: 'his calendar stopped agreeing with him is the wrong tone' },
    ],
  };

  it('writes a valid ContentSession to .pomegranate/interactions/', async () => {
    const { filename, id, session } = await captureSession(validPayload, { storage });
    expect(filename.endsWith(`${id}.json`)).toBe(true);
    expect(filename.startsWith(storage.interactionsDir)).toBe(true);
    expect(session.artifacts).toHaveLength(2);
    expect(session.feedback).toHaveLength(2);

    const round = JSON.parse(await fs.readFile(filename, 'utf8'));
    expect(round.kind).toBe('content-strategy-session');
    expect(round.artifacts[1].text).toBe('second draft body...');
    expect(round.feedback[1].note).toContain('calendar stopped agreeing');
  });

  it('respects a caller-supplied id', async () => {
    const { filename, id } = await captureSession(validPayload, { storage, id: 'content-test-123' });
    expect(id).toBe('content-test-123');
    expect(filename.endsWith('content-test-123.json')).toBe(true);
  });

  it('rejects a payload missing topic', async () => {
    const bad = { ...validPayload, topic: '' };
    await expect(captureSession(bad, { storage })).rejects.toThrow(/topic/);
  });

  it('rejects a payload with zero artifacts', async () => {
    const bad = { ...validPayload, artifacts: [] };
    await expect(captureSession(bad, { storage })).rejects.toThrow(/artifacts/);
  });

  it('rejects a wrong kind', async () => {
    const bad = { ...validPayload, kind: 'not-a-session' };
    await expect(captureSession(bad, { storage })).rejects.toThrow();
  });

  it('written file is picked up as an interaction by ContentSession schema', async () => {
    const { filename } = await captureSession(validPayload, { storage });
    const round = JSON.parse(await fs.readFile(filename, 'utf8'));
    const reparse = ContentSession.safeParse(round);
    expect(reparse.success).toBe(true);
  });
});
