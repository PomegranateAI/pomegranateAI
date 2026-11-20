import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { writeWorkspaceFile } from '../files/sealed-files.js';
import { exportWorkspace } from './export.js';

// A sealed directory exports to plain Markdown + JSON + files.
let dir: string;
const saved = { seal: process.env.POMEGRANATE_SEAL, kek: process.env.POMEGRANATE_LOCAL_KEK };
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pom-export-'));
  process.env.POMEGRANATE_SEAL = '1';
  process.env.POMEGRANATE_LOCAL_KEK = randomBytes(32).toString('base64');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of [['POMEGRANATE_SEAL', saved.seal], ['POMEGRANATE_LOCAL_KEK', saved.kek]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('export', () => {
  it('writes decrypted notes, documents and files, and audits the export', async () => {
    const repo = new Repo(openDb(path.join(dir, 'p.db')));
    expect(repo.crypto.sealing).toBe(true);
    const w = await repo.createWorkspace({ name: 'Science Dept', owner_email: 'head@example.test' });
    await repo.ensureDefaultSubgraph(w.id);
    const now = '2026-10-07T00:00:00Z';
    await repo.insertNode(w.id, { id: 'n-hw', type: 'note', status: 'active', created_at: now, updated_at: now, title: 'Homework', body: 'Capped at 30 minutes' } as any);
    const files = path.join(dir, 'files');
    await writeWorkspaceFile(repo.crypto, w.id, files, path.join(files, w.id, 'docs', 'd1.v1.txt'), 'original text');

    const out = path.join(dir, 'out');
    const { dir: exp, counts } = await exportWorkspace(repo, w.id, out, files);
    expect(counts).toMatchObject({ notes: 1, files: 1 });
    const nodes = JSON.parse(await fs.readFile(path.join(exp, 'nodes.json'), 'utf8'));
    expect(nodes[0].body).toBe('Capped at 30 minutes');
    const md = await fs.readFile(path.join(exp, 'markdown', 'notes', 'n-hw.md'), 'utf8').catch(async () => {
      const [folder] = await fs.readdir(path.join(exp, 'markdown'));
      return fs.readFile(path.join(exp, 'markdown', folder!, 'n-hw.md'), 'utf8');
    });
    expect(md).toContain('# Homework');
    expect(md).toContain('Capped at 30 minutes');
    expect(await fs.readFile(path.join(exp, 'files', 'docs', 'd1.v1.txt'), 'utf8')).toBe('original text');
    const manifest = JSON.parse(await fs.readFile(path.join(exp, 'manifest.json'), 'utf8'));
    expect(manifest.directory.name).toBe('Science Dept');
    expect((await repo.listCustomerAudit(w.id, { event: 'workspace_exported' })).length).toBe(1);
  });
});
