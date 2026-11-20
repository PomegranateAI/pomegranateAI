import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStorage } from '../../lib/storage.js';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { migrate } from './import.js';

let tmp: string;
let phase0: string;
let dbPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-mig-'));
  phase0 = path.join(tmp, '.pomegranate');
  dbPath = path.join(tmp, 'p.db');
  const storage = new FileStorage({ rootDir: phase0 });
  await storage.init();
  await storage.writeNode({
    id: 'goal-q2',
    type: 'goal',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    title: 'Q2 north star',
    body: 'Mid-market ARR',
    priority: 'north_star',
    period: 'Q2 2026',
  });
  await storage.writeNode({
    id: 'pos-killed-allinone',
    type: 'positioning',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    body: 'We are not the all-in-one platform',
    kind: 'killed_messaging',
  });
  await storage.writeNode({
    id: 'dec-mobile',
    type: 'decision',
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-15T00:00:00Z',
    status: 'active',
    summary: 'Kill the v1 mobile app',
    body: 'Effective 2026-04-15.',
    decided_on: '2026-04-15',
    category: 'scope',
  });
  // Archived: should not be imported
  await storage.writeNode({
    id: 'old-decision',
    type: 'decision',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    status: 'archived',
    summary: 'Outdated',
    body: 'Old.',
    decided_on: '2025-01-01',
    category: 'other',
  });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('migration', () => {
  it('imports a phase 0 directory into a fresh phase 1 workspace', async () => {
    const r = await migrate({
      src: phase0,
      workspace_name: 'Imported',
      owner_email: 'owner@x.com',
      db_path: dbPath,
    });
    expect(r.workspace_id).toMatch(/^ws_/);
    expect(r.nodes_imported).toBe(3); // archived excluded by FileStorage.readGraph
    const db = openDb(dbPath);
    const repo = new Repo(db);
    const nodes = await repo.listNodes(r.workspace_id, { activeOnly: true });
    expect(nodes.map((n) => n.id).sort()).toEqual(['dec-mobile', 'goal-q2', 'pos-killed-allinone']);
    db.close();
  });
});
