import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { productProfile } from './mock-product-profile.js';
import { materializeWikiPlan } from './plan.js';
import { fillPage } from './fill.js';
import { setStructuredLLM } from '../../lib/anthropic.js';
import { sealedNodeData, sealedEvidenceQuote } from '../../__test_utils__/sealed-fixtures.js';

// The wiki page as a living reproduction of its source document: each block is a
// section of the source, kept current by correction nodes from other documents.

let db: Database.Database;
let repo: Repo;
let ws: string;
let filesDir: string;
const ts = '2026-01-01T00:00:00Z';

async function addNode(id: string, type: string, title: string, docId: string | null, attrs?: Record<string, unknown>) {
  const data = await sealedNodeData(repo, ws, id, { id, type, title, body: `${title} body`, status: 'active', created_at: ts, updated_at: ts, attrs: { product: 'Pomegranate', ...attrs } });
  repo.db
    .prepare(
      `INSERT INTO graph_nodes (id, workspace_id, subgraph_id, type, status, data, document_id, visibility, created_at, updated_at)
       VALUES (?, ?, 'default', ?, 'active', ?, ?, 'team', ?, ?)`,
    )
    .run(id, ws, type, data, docId, ts, ts);
}
function addDoc(id: string, ref: string) {
  repo.db.prepare(`INSERT INTO documents (id, workspace_id, source_ref, source_kind, sha256, version, source_type, created_at, last_ingested_at) VALUES (?, ?, ?, 'doc', ?, 1, 'prd_or_spec', ?, ?)`).run(id, ws, ref, id, ts, ts);
}
async function addEvidence(nodeId: string, docId: string) {
  const quote = await sealedEvidenceQuote(repo, ws, nodeId, docId, `quote for ${nodeId}`);
  repo.db.prepare(`INSERT INTO node_evidence (workspace_id, node_id, document_id, quote, captured_at) VALUES (?, ?, ?, ?, ?)`).run(ws, nodeId, docId, quote, ts);
}
async function writeDocText(docId: string, version: number, text: string) {
  const dir = path.join(filesDir, ws, 'docs');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${docId}-v${version}.txt`), text, 'utf8');
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  ws = (await repo.createWorkspace({ name: 'T', owner_email: 't@t.com' })).id;
  await repo.setWorkspaceProfile(ws, 'product', productProfile, 'default');
  filesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pom-wiki-'));
});
afterEach(async () => {
  setStructuredLLM(null);
  await fs.rm(filesDir, { recursive: true, force: true });
});

describe('fillPage — document reproduction path', () => {
  it('reproduces the source section-by-section and marks corrections pending', async () => {
    addDoc('d1', 'roadmap.md');
    // Origin-document nodes (the spine).
    await addNode('n_intro', 'goal', 'Intro', 'd1');
    await addEvidence('n_intro', 'd1');
    await addNode('n_h2', 'goal', 'Horizon 2', 'd1');
    await addEvidence('n_h2', 'd1');
    // A correction from ANOTHER document (not d1): a later decision amending H2.
    addDoc('d2', 'decision.md');
    await addNode('n_fix', 'decision', 'H2 reprioritized', 'd2');

    await writeDocText('d1', 1, '# Introduction\n\nThe roadmap opens.\n\n# Horizon 2\n\nOriginal H2 plan.');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Roadmap', anchor: { scope_value: 'Pomegranate' }, source_doc_ids: ['d1'], sections: [{ heading: 'Placeholder' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Roadmap')!;

    // Stub the LLM as the reproduction pass: reproduce Introduction unchanged,
    // rewrite Horizon 2 with the correction node cited.
    setStructuredLLM({
      name: 'stub',
      async callStructured() {
        return {
          blocks: [
            { section_key: 'Introduction', type: 'paragraph', text: 'The roadmap opens.', cited_node_ids: [], changed: false },
            { section_key: 'Horizon 2', type: 'paragraph', text: 'H2 was reprioritized.', cited_node_ids: ['n_fix'], changed: true },
          ],
        };
      },
    });

    const r = await fillPage(repo, ws, 'default', page, { filesDir });
    expect(r.via).toBe('document');
    expect(r.blocks).toBe(2);

    const blocks = await repo.listWikiBlocks(ws, page.id);
    const intro = blocks.find((b) => (b.content as any).section_key === 'Introduction')!;
    const h2 = blocks.find((b) => (b.content as any).section_key === 'Horizon 2')!;
    // Reproduced section: accepted, no citation.
    expect(intro.provenance).toBe('in_document');
    expect(intro.review_state).toBe('accepted');
    // Corrected section: inferred + pending, cites the correction.
    expect(h2.provenance).toBe('inferred');
    expect(h2.review_state).toBe('pending');
    expect(h2.cited_node_ids).toContain('n_fix');

    // The page's structure now mirrors the source document's headings.
    const updated = (await repo.getWikiPage(ws, page.id))!;
    expect((updated.sections ?? []).map((s) => s.heading)).toEqual(['Introduction', 'Horizon 2']);
  });

  it("does not read a source document routed only to another subfolder", async () => {
    // The page is in 'default' and (e.g. from an older build) lists two source
    // docs: one that belongs here, one shared into 'default's sibling 'sg2'. Fill
    // must reproduce only the here-doc — the other's text must never reach the
    // model, or its content leaks into this subfolder's wiki.
    await repo.setWorkspaceProfile(ws, 'product', productProfile, 'sg2');
    addDoc('d_here', 'here.md');
    addDoc('d_other', 'other.md');
    await repo.routeDocument(ws, 'd_here', 'default', { routed_by: 'pinned' });
    await repo.routeDocument(ws, 'd_other', 'sg2', { routed_by: 'pinned' });
    await addNode('n_here', 'goal', 'Here goal', 'd_here');
    await addEvidence('n_here', 'd_here');
    await writeDocText('d_here', 1, '# Here\n\nText that belongs to default.');
    await writeDocText('d_other', 1, '# Other\n\nSECRET text from sg2.');

    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Roadmap', anchor: { scope_value: 'Pomegranate' }, source_doc_ids: ['d_here', 'd_other'], sections: [{ heading: 'Placeholder' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Roadmap')!;

    let seenUser = '';
    setStructuredLLM({
      name: 'stub',
      async callStructured(opts) {
        seenUser = opts.user;
        return { blocks: [{ section_key: 'Here', type: 'paragraph', text: 'ok', cited_node_ids: [], changed: false }] };
      },
    });

    await fillPage(repo, ws, 'default', page, { filesDir });
    expect(seenUser).toContain('Text that belongs to default.');
    expect(seenUser).not.toContain('SECRET text from sg2.');
  });

  it('falls back to node synthesis when the source text is missing on disk', async () => {
    addDoc('d1', 'roadmap.md'); // no text file written
    await addNode('n1', 'product', 'P', 'd1');
    await addEvidence('n1', 'd1');
    await materializeWikiPlan(repo, ws, 'default', 'product', {
      categories: [{ title: 'Products', pages: [{ title: 'Roadmap', anchor: { scope_value: 'Pomegranate' }, source_doc_ids: ['d1'], sections: [{ heading: 'Definition' }] }] }],
    });
    const page = (await repo.listWikiPages(ws, 'default')).find((p) => p.title === 'Roadmap')!;
    // No LLM override + no key → deterministic fallback, never the document path.
    const r = await fillPage(repo, ws, 'default', page, { filesDir });
    expect(r.via).toBe('fallback');
    expect(r.blocks).toBeGreaterThan(0);
  });
});
