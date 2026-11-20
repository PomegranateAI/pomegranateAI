// Full export of a directory in open formats (exit plan).
//
//   docker compose exec -T app node dist/phase1/admin/export.js <workspace_id>|--all /data/exports/<date>
//
// For each directory, writes <out>/<name>_<id>/:
//   README.md            what each file is
//   manifest.json        directory, folders, members (email + role), counts, export time
//   nodes.json           every note in every folder — current and superseded — decrypted
//   edges.json           links between notes
//   documents.json       every ingested source: name, kind, version, summary, dates
//   markdown/<folder>/<note-id>.md   one Markdown file per note, with front matter
//   files/               every stored file (originals, extracted text, media), decrypted
//
// Runs with the server's own key configuration, so sealed content comes out
// as plaintext: treat the output as the most sensitive copy of the data
// (encrypted disk, delete after hand-over). Each export is recorded in the
// directory's audit log (`workspace_exported`).

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { readWorkspaceFile } from '../files/sealed-files.js';
import { log } from '../../lib/log.js';

const USAGE = 'usage: export.js <workspace_id>|--all <out_dir>';

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'directory';
}

function yamlValue(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function noteMarkdown(n: Record<string, unknown>, folder: string): string {
  const front: Record<string, unknown> = {
    id: n.id,
    folder,
    type: n.type,
    status: n.status,
    created_at: n.created_at,
    updated_at: n.updated_at,
    source: n.source,
    ...(n.attrs ? { attrs: n.attrs } : {}),
  };
  const lines = ['---', ...Object.entries(front).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${yamlValue(v)}`), '---', ''];
  if (typeof n.title === 'string' && n.title) lines.push(`# ${n.title}`, '');
  lines.push(String(n.body ?? ''), '');
  return lines.join('\n');
}

async function copyFiles(repo: Repo, ws: string, filesDir: string, outDir: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.endsWith('.tmp')) {
        const rel = path.relative(path.join(filesDir, ws), p);
        const dest = path.join(outDir, 'files', rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await readWorkspaceFile(repo.crypto, ws, filesDir, p));
        count++;
      }
    }
  };
  await walk(path.join(filesDir, ws));
  return count;
}

/** Export one directory into `outRoot`; returns the directory written and its counts. */
export async function exportWorkspace(repo: Repo, ws: string, outRoot: string, filesDir: string) {
  const w = await repo.getWorkspace(ws);
  if (!w) throw new Error(`no such directory: ${ws}`);
  const dir = path.join(outRoot, `${safeName(w.name)}_${ws}`);
  await fs.mkdir(dir, { recursive: true });

  const subgraphs = await repo.listSubgraphs(ws);
  const nodes: Array<Record<string, unknown>> = [];
  const edges: unknown[] = [];
  for (const sg of subgraphs) {
    for (const n of await repo.listNodes(ws, { activeOnly: false }, sg.id)) {
      const node: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>), folder_id: sg.id };
      nodes.push(node);
      const md = path.join(dir, 'markdown', safeName(sg.slug || sg.id), `${safeName(String(node.id))}.md`);
      await fs.mkdir(path.dirname(md), { recursive: true });
      await fs.writeFile(md, noteMarkdown(node, sg.name));
    }
    for (const e of await repo.listEdges(ws, { includeArchived: true }, sg.id)) edges.push({ ...(e as object), folder_id: sg.id });
  }
  const documents = await repo.listDocuments(ws);
  const members = await repo.listWorkspaceMembers(ws);
  const files = await copyFiles(repo, ws, filesDir, dir);
  const counts = { folders: subgraphs.length, notes: nodes.length, edges: edges.length, documents: documents.length, files };

  const manifest = {
    format: 'pomegranate-export/1',
    exported_at: new Date().toISOString(),
    directory: { id: w.id, name: w.name, owner_email: w.owner_email, created_at: w.created_at },
    folders: subgraphs.map((s) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, status: s.status, created_at: s.created_at })),
    members: members.map((m) => ({ email: m.email, role: m.read_only ? 'viewer' : m.role, display_name: m.display_name })),
    counts,
  };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(dir, 'nodes.json'), JSON.stringify(nodes, null, 2));
  await fs.writeFile(path.join(dir, 'edges.json'), JSON.stringify(edges, null, 2));
  await fs.writeFile(path.join(dir, 'documents.json'), JSON.stringify(documents, null, 2));
  await fs.writeFile(
    path.join(dir, 'README.md'),
    [
      `# Export of "${w.name}"`,
      '',
      `Exported ${manifest.exported_at}. Format \`pomegranate-export/1\`.`,
      '',
      '- `manifest.json`: the directory, its folders, members and counts.',
      '- `nodes.json`: every note (current and superseded), with its folder id.',
      '- `edges.json`: links between notes.',
      '- `documents.json`: every ingested source and its summary.',
      '- `markdown/<folder>/<note-id>.md`: one readable file per note.',
      '- `files/`: every stored file — uploaded originals (`sources/`), extracted text (`docs/`), media (`assets/`).',
      '',
      'This copy is decrypted. Keep it on an encrypted disk and delete it after hand-over.',
      '',
    ].join('\n'),
  );
  await repo.logCustomerAudit(ws, {
    event: 'workspace_exported',
    resource_type: 'workspace',
    resource_id: ws,
    payload: { ...counts, via: 'admin_export' },
  });
  log.info('admin.workspace_exported', { workspace: ws, ...counts });
  return { dir, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [target, out] = process.argv.slice(2);
  if (!target || !out) {
    console.error(USAGE);
    process.exit(2);
  }
  const repo = new Repo(openDb(process.env.POMEGRANATE_DB_PATH ?? './data/pomegranate.db'));
  const filesDir = process.env.POMEGRANATE_FILES_DIR ?? './data/files';
  (async () => {
    const ids = target === '--all'
      ? ((await repo.sql.query<any>(`SELECT id FROM workspaces ORDER BY created_at`)) as Array<{ id: string }>).map((r) => r.id)
      : [target];
    for (const ws of ids) {
      const { dir, counts } = await exportWorkspace(repo, ws, out, filesDir);
      console.log(`${ws}: ${counts.notes} notes, ${counts.documents} documents, ${counts.files} files → ${dir}`);
    }
  })().then(
    () => process.exit(0),
    (err) => {
      console.error(`export: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
