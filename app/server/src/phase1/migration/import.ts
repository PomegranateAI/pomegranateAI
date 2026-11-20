/**
 * Phase 0 → Phase 1 migration tool.
 *
 *   tsx src/phase1/migration/import.ts --src=<phase0-dir> --workspace=<name> --email=<owner>
 *
 * Reads a `.pomegranate/` directory produced by the Phase 0 skills:
 *   - graph/*.md       → graph_nodes
 *   - backlog.md       → ignored (Phase 1 candidates are produced by ingest API)
 *   - reviews/*.md     → ignored (Phase 0 reviews don't carry persistent ids)
 *   - interactions/    → ignored (interaction capture in Phase 1 is via Slack/MCP)
 *
 * Creates the workspace if it doesn't exist and inserts every active graph node.
 */
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { openDb } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { FileStorage } from '../../lib/storage.js';

export interface MigrateOptions {
  src: string;
  workspace_name: string;
  owner_email: string;
  db_path?: string;
}

export interface MigrateResult {
  workspace_id: string;
  nodes_imported: number;
}

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const dbPath = opts.db_path ?? process.env.POMEGRANATE_DB_PATH ?? './data/pomegranate.db';
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const repo = new Repo(db);
  const ws = await repo.createWorkspace({ name: opts.workspace_name, owner_email: opts.owner_email });
  const owner = await repo.findOrCreateUser(opts.owner_email);

  const storage = new FileStorage({ rootDir: opts.src });
  const nodes = await storage.readGraph();
  for (const n of nodes) {
    await repo.upsertNode(ws.id, n, owner.id);
  }
  await repo.logAudit(ws.id, {
    actor: owner.id,
    event: 'workspace.migrated_from_phase0',
    resource_type: 'workspace',
    resource_id: ws.id,
    payload: { source: opts.src, nodes: nodes.length },
  });
  db.close();
  return { workspace_id: ws.id, nodes_imported: nodes.length };
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('import.ts') ||
  process.argv[1]?.endsWith('import.js');

if (isMain) {
  function arg(name: string): string | undefined {
    const a = process.argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=')[1] : undefined;
  }
  const src = arg('src');
  const workspace_name = arg('workspace') ?? 'Imported workspace';
  const owner_email = arg('email') ?? 'owner@example.com';
  if (!src) {
    console.error('usage: tsx import.ts --src=<phase0-dir> [--workspace=<name>] [--email=<owner>]');
    process.exit(1);
  }
  migrate({ src, workspace_name, owner_email })
    .then((r) => console.log(`Imported workspace=${r.workspace_id} nodes=${r.nodes_imported}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
