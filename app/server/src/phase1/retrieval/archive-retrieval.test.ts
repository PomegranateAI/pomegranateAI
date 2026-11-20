// Deleting a node in the Library archives it (status='archived'). This test
// proves the user-visible guarantee behind that: once archived, the node's
// information is no longer RETRIEVED — it disappears from the same
// buildContextPack path that powers the get_context / query_context MCP tools
// (and list_recent_changes), all of which read repo.listNodesWithEmbeddings
// with activeOnly:true. We exercise the REAL Repo (whose active-only filter is
// the thing under test) end-to-end through buildContextPack.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { buildContextPack } from './pack.js';
import { foundingProfile } from '../../lib/profiles/__fixtures__/founding.js';
import { StubEmbedder, embeddingTextForNode, embeddingToBlob } from '../../lib/embeddings.js';
import type { Node } from '../../lib/schemas.js';

let db: Database.Database;
let repo: Repo;
const embedder = new StubEmbedder();
const ts = '2026-01-01T00:00:00Z';

// A distinctive, greppable fact so we can assert on its presence/absence in the
// rendered pack markdown rather than only on node ids.
const SECRET = 'Launch date is locked at the ninth of September';
const node: Node = {
  id: 'dec-mobile-floor',
  type: 'decision',
  created_at: ts,
  updated_at: ts,
  status: 'active',
  summary: 'Launch date',
  body: SECRET,
  decided_on: '2026-01-01',
  category: 'scope',
} as Node;

async function retrieve(): Promise<{ ids: string[]; markdown: string }> {
  const pack = await buildContextPack({
    repo,
    workspace_id: ws,
    profile: foundingProfile,
    scope: 'all',
    question: 'what is the launch date',
    embedder,
  });
  return { ids: pack.nodes.map((n) => n.id), markdown: pack.markdown };
}

let ws: string;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'Retrieval', owner_email: 'owner@example.com' })).id;
  // Store the node WITH an embedding, exactly as the write path does, so it is
  // eligible for embedding-ranked retrieval.
  const [vec] = await embedder.embed([embeddingTextForNode(node as any)]);
  await repo.upsertNode(ws, node, undefined, embeddingToBlob(vec!));
});

describe('deleting (archiving) a node removes it from retrieval', () => {
  it('is retrieved before deletion, and NOT retrieved after', async () => {
    // Before: the node and its content are in the retrieved context.
    const before = await retrieve();
    expect(before.ids).toContain(node.id);
    expect(before.markdown).toContain(SECRET);

    // Delete it — this is exactly what the Library ✕ button does
    // (DELETE /workspaces/:ws/graph/:id → repo.archiveNode).
    await repo.archiveNode(ws, node.id);

    // After: the node and its information are gone from retrieval.
    const after = await retrieve();
    expect(after.ids).not.toContain(node.id);
    expect(after.markdown).not.toContain(SECRET);
  });

  it('is a soft delete — the row is retained (archived), just filtered out of the active graph', async () => {
    await repo.archiveNode(ws, node.id);
    // Not in the active graph (what every retrieval path reads)...
    expect((await repo.listNodes(ws, { activeOnly: true })).map((n) => n.id)).not.toContain(node.id);
    // ...but still present when archived rows are included (recoverable / auditable).
    const row = await repo.getNode(ws, node.id);
    expect(row?.status).toBe('archived');
  });
});
