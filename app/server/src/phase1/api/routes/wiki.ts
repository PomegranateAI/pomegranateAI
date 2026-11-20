// Routes: wiki.
// Split from routes.ts buildApp(). Statement text is unchanged;
// shared helpers come from createRouteCore() in ./core.ts.

import { z } from 'zod';
import * as path from 'node:path';
import { log } from '../../../lib/log.js';
import { withLlmContext } from '../../../lib/llm-context.js';
import {
  planWikiStructure,
  materializeWikiPlan,
  reconcileWikiPlan,
  computePlanSignature,
  buildWikiDigest,
} from '../../wiki/plan.js';
import { fillPage } from '../../wiki/fill.js';
import type { Hono } from 'hono';
import type { AppVars } from '../routes.js';
import type { RouteCore } from './core.js';
import type { WikiTreeNode } from './types.js';

export function registerWiki(app: Hono<{ Variables: AppVars }>, core: RouteCore): void {
const {
  repo,
  authn,
  workspaceGate,
  resolveSubgraph,
  profileFor,
  FILES_DIR,
  viewerFor,
} = core;

/**
 * Page audience (spec §9), enforced on every read and write: a 'team' page is
 * everyone's; a 'private'/'only_me' page is its owner's alone. A restricted page
 * with no owner is visible to nobody but workspace admins (it can't be
 * attributed). Local single-user mode (viewer undefined) sees everything.
 */
function wikiPageVisible(page: { visibility?: string | null; owner_user_id?: string | null }, viewer: string | undefined, role?: string): boolean {
  if (!viewer) return true;
  if (!page.visibility || page.visibility === 'team') return true;
  if (page.owner_user_id) return page.owner_user_id === viewer;
  return role === 'workspace_admin';
}

/** getWikiPage, but undefined when the caller may not see the page. */
async function visibleWikiPage(c: { get(k: 'user_id'): string; get(k: 'role'): string }, ws: string, id: string) {
  const page = await repo.getWikiPage(ws, id);
  if (!page || !wikiPageVisible(page, viewerFor(c), c.get('role'))) return undefined;
  return page;
}
/** Assemble the flat wiki_pages rows into a nested category→page→child tree. */
async function buildWikiTree(workspace_id: string, subgraph_id: string, viewer?: string, role?: string): Promise<WikiTreeNode[]> {
  // Pages the caller may not see are left out (with them, their place in the tree).
  const pages = (await repo.listWikiPages(workspace_id, subgraph_id)).filter((p) => wikiPageVisible(p, viewer, role));
  const byId = new Map<string, WikiTreeNode>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  const roots: WikiTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }
  const sortRec = (arr: WikiTreeNode[]) => {
    arr.sort((a, b) => a.sort_order - b.sort_order);
    for (const n of arr) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Next sort_order among a parent's current children (append to the end). */
async function nextWikiSortOrder(workspace_id: string, subgraph_id: string, parent_id: string | null): Promise<number> {
  const siblings = (await repo
    .listWikiPages(workspace_id, subgraph_id))
    .filter((p) => (p.parent_id ?? null) === parent_id);
  return siblings.reduce((max, p) => Math.max(max, p.sort_order), -1) + 1;
}

/** True when `candidateAncestorId` is `id` itself or a descendant of `id` — a
 *  reparent guard so the tree can never form a cycle. */
async function isWikiDescendant(
  workspace_id: string,
  subgraph_id: string,
  id: string,
  candidateAncestorId: string,
): Promise<boolean> {
  const pages = await repo.listWikiPages(workspace_id, subgraph_id);
  const parentOf = new Map(pages.map((p) => [p.id, p.parent_id]));
  let cur: string | null | undefined = candidateAncestorId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

// ---------- wiki (spec-wiki.md / wiki-milestones.md M1) ----------
//
// A wiki is a generated, editable read-projection of the canon, one per
// (workspace, subgraph). M1 = structure only: a plan pass proposes categories
// + pages + per-page sections; the tree is then user-editable (add / rename /
// move / reorder / remove). Body fill is M2, so pages render their planned
// `sections` as placeholders until then. Behind the `wiki` flag on the client.

// Build (or rebuild) the wiki structure from the profile + sources + graph.
app.post('/workspaces/:ws/wiki/plan', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const profile = await profileFor(ws, sg.id);
  const profile_id = await repo.getWorkspaceProfileId(ws, sg.id) ?? profile.id;
  try {
    const { plan, digest, via } = await withLlmContext(
      { caller: 'api.wiki_plan', context: { total_nodes: 0 } },
      () => planWikiStructure(repo, ws, sg.id, profile),
    );
    const counts = await materializeWikiPlan(repo, ws, sg.id, profile_id, plan, computePlanSignature(digest));

    let filled = 0;
    let blocks = 0;
    const pages = (await repo.listWikiPages(ws, sg.id)).filter((p) => p.kind === 'page');
    for (const page of pages) {
      try {
        const r = await withLlmContext({ caller: 'api.wiki_plan_fill', context: { page: page.id } }, () =>
          fillPage(repo, ws, sg.id, page, { filesDir: FILES_DIR }),
        );
        if (r.blocks > 0) filled++;
        blocks += r.blocks;
      } catch (err) {
        log.warn('wiki.plan_fill_failed', { workspace: ws, page: page.id, msg: (err as Error).message?.slice(0, 200) });
      }
    }

    await repo.setWikiWatermark(ws, sg.id, await repo.latestGraphChangeAt(ws, sg.id));
    log.info('wiki.plan_built', { workspace: ws, subgraph: sg.id, via, ...counts, filled, blocks });
    return c.json({ ok: true, via, ...counts, filled, blocks, tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')) });
  } catch (err) {
    log.warn('wiki.plan_failed', { workspace: ws, msg: (err as Error).message?.slice(0, 200) });
    return c.json({ error: 'plan_failed' }, 500);
  }
});

// The wiki tree (categories → pages → children). Empty `wiki: null` when never
// built. `stale` (spec §11) is true when the canon changed since the wiki's
// content_watermark, or the choke point flagged it — the client shows a Refresh
// affordance.
app.get('/workspaces/:ws/wiki', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const wiki = await repo.getWiki(ws, sg.id) ?? null;
  const latest = await repo.latestGraphChangeAt(ws, sg.id);
  const stale = wiki
    ? wiki.status === 'stale' || (!!wiki.content_watermark && latest > wiki.content_watermark) || !wiki.content_watermark
    : false;
  return c.json({ wiki, stale, latest_change: latest, tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')) });
});

// One page: its metadata, planned sections, and any filled blocks (M2+).
app.get('/workspaces/:ws/wiki/pages/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const page = await visibleWikiPage(c, ws, c.req.param('id'));
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  return c.json({ page, blocks: await repo.listWikiBlocks(ws, page.id) });
});

// Add a category or page (manual structure control).
app.post('/workspaces/:ws/wiki/pages', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      kind: z.enum(['category', 'page']).default('page'),
      title: z.string().min(1),
      parent_id: z.string().nullish(),
      sort_order: z.number().optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { kind, title, parent_id, sort_order } = parsed.data;
  if (parent_id) {
    const parent = await visibleWikiPage(c, ws, parent_id);
    if (!parent || parent.status !== 'active') return c.json({ error: 'unknown parent' }, 400);
  }
  const order = sort_order ?? await nextWikiSortOrder(ws, sg.id, parent_id ?? null);
  const { id } = await repo.insertWikiPage(ws, sg.id, {
    kind,
    title,
    parent_id: parent_id ?? null,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'page',
    sections: kind === 'page' ? [] : undefined,
    sort_order: order,
    owner_user_id: c.get('user_id'),
  });
  return c.json({ ok: true, id, tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')) });
});

// Edit a page: rename, move (reparent), reorder, or retitle a section set.
app.patch('/workspaces/:ws/wiki/pages/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const id = c.req.param('id');
  const page = await visibleWikiPage(c, ws, id);
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      title: z.string().min(1).optional(),
      parent_id: z.string().nullable().optional(),
      sort_order: z.number().optional(),
      sections: z.array(z.object({ key: z.string().optional(), heading: z.string(), intent: z.string().optional() })).optional(),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  // Guard against reparenting onto itself or a descendant (would orphan a cycle).
  if (parsed.data.parent_id) {
    if (parsed.data.parent_id === id) return c.json({ error: 'cannot parent to self' }, 400);
    const parent = await visibleWikiPage(c, ws, parsed.data.parent_id);
    if (!parent || parent.status !== 'active') return c.json({ error: 'unknown parent' }, 400);
    if (await isWikiDescendant(ws, sg.id, id, parsed.data.parent_id)) {
      return c.json({ error: 'cannot parent to a descendant' }, 400);
    }
  }
  await repo.updateWikiPage(ws, id, parsed.data);
  return c.json({ ok: true, tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')) });
});

// Remove a page/category and its subtree (archived, not hard-deleted).
app.delete('/workspaces/:ws/wiki/pages/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const id = c.req.param('id');
  const page = await visibleWikiPage(c, ws, id);
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  const archived = await repo.archiveWikiPageSubtree(ws, sg.id, id);
  return c.json({ ok: true, archived, tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')) });
});

// Fill one page's sections with cited prose from documents + graph (M2).
app.post('/workspaces/:ws/wiki/pages/:id/fill', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const page = await visibleWikiPage(c, ws, c.req.param('id'));
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  try {
    const result = await withLlmContext({ caller: 'api.wiki_fill', context: { page: page.id } }, () =>
      fillPage(repo, ws, sg.id, page, { filesDir: FILES_DIR }),
    );
    return c.json({ ok: true, ...result, blocks_list: await repo.listWikiBlocks(ws, page.id) });
  } catch (err) {
    log.warn('wiki.fill_failed', { workspace: ws, page: page.id, msg: (err as Error).message?.slice(0, 200) });
    return c.json({ error: 'fill_failed' }, 500);
  }
});

// Refresh the whole wiki (M2 / spec §11.4). Serialized to keep model usage tame.
//
// Refresh is NOT just "re-fill what's there". The structure is planned, and the
// planner is what anchors a page to its source documents — so a refresh that
// only re-filled would (a) never give a newly-ingested document a page, and
// (b) leave pages planned before the document-reproduction pass (or by the
// deterministic fallbackPlan, which anchors nothing) permanently on the
// node path, filling thin or empty. So: when the corpus has drifted away from
// the plan signature, re-plan and RECONCILE it into the existing tree — adding
// what's new and re-homing pages onto their sources, without churning the ids,
// order, or user edits a rebuild would discard. Then fill.
app.post('/workspaces/:ws/wiki/fill', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const sg = await resolveSubgraph(c, ws);
  if (!sg) return c.json({ error: 'unknown folder' }, 400);
  const profile = await profileFor(ws, sg.id);
  const profile_id = await repo.getWorkspaceProfileId(ws, sg.id) ?? profile.id;

  // Replan gate: the digest signature is cheap (no LLM) — only a real drift in
  // the profile / document set / census pays for a plan call.
  let replanned: { added_categories: number; added_pages: number; rehomed_pages: number } | null = null;
  const wiki = await repo.getWiki(ws, sg.id);
  const signature = computePlanSignature(await buildWikiDigest(repo, ws, sg.id, profile));
  if (wiki && signature !== wiki.plan_signature) {
    try {
      const { plan } = await withLlmContext({ caller: 'api.wiki_refresh_plan', context: { total_nodes: 0 } }, () =>
        planWikiStructure(repo, ws, sg.id, profile, 'api.wiki_refresh_plan'),
      );
      replanned = await reconcileWikiPlan(repo, ws, sg.id, profile_id, plan, signature);
      log.info('wiki.refresh_replanned', { workspace: ws, subgraph: sg.id, ...replanned });
    } catch (err) {
      // A failed replan must not sink the refresh — fill what's already planned.
      log.warn('wiki.refresh_replan_failed', { workspace: ws, msg: (err as Error).message?.slice(0, 200) });
    }
  }

  const pages = (await repo.listWikiPages(ws, sg.id)).filter((p) => p.kind === 'page');
  let filled = 0;
  let blocks = 0;
  for (const page of pages) {
    try {
      const r = await withLlmContext({ caller: 'api.wiki_fill_all', context: { page: page.id } }, () =>
        fillPage(repo, ws, sg.id, page, { filesDir: FILES_DIR }),
      );
      // 'empty' means the page resolved to nothing and kept whatever it already
      // had — it was not refreshed, so it must not be counted as one.
      if (r.blocks > 0 && r.via !== 'empty') filled++;
      blocks += r.blocks;
    } catch (err) {
      log.warn('wiki.fill_failed', { workspace: ws, page: page.id, msg: (err as Error).message?.slice(0, 200) });
    }
  }
  // A full fill re-syncs the wiki to the current graph → advance the watermark
  // and clear the stale flag (spec §11.4).
  await repo.setWikiWatermark(ws, sg.id, await repo.latestGraphChangeAt(ws, sg.id));
  return c.json({
    ok: true,
    pages: pages.length,
    filled,
    blocks,
    added_pages: replanned?.added_pages ?? 0,
    tree: await buildWikiTree(ws, sg.id, viewerFor(c), c.get('role')),
  });
});

// Accept or reject an inferred/proposed block (spec §7). Reject is remembered so
// a later refill does not re-propose the same citation set.
app.post('/workspaces/:ws/wiki/blocks/:id/:action', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const id = c.req.param('id');
  const action = c.req.param('action');
  if (action !== 'accept' && action !== 'reject') return c.json({ error: 'unknown action' }, 400);
  const block = await repo.getWikiBlock(ws, id);
  if (!block || !await visibleWikiPage(c, ws, block.page_id)) return c.json({ error: 'not found' }, 404);
  await repo.setWikiBlockReview(ws, id, action === 'accept' ? 'accepted' : 'rejected');
  return c.json({ ok: true, blocks_list: await repo.listWikiBlocks(ws, block.page_id) });
});

// ---- wiki editing + sharing (M5) ----

// Add a block to a page (a user-authored paragraph, list, or image).
app.post('/workspaces/:ws/wiki/pages/:id/blocks', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const page = await visibleWikiPage(c, ws, c.req.param('id'));
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      type: z.enum(['paragraph', 'list', 'image']).default('paragraph'),
      content: z.object({ section_key: z.string().optional(), text: z.string().optional(), items: z.array(z.string()).optional(), url: z.string().optional(), alt: z.string().optional() }),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const { id } = await repo.insertWikiBlock(ws, page.id, {
    sort_order: await repo.nextWikiBlockOrder(ws, page.id),
    type: parsed.data.type,
    content: parsed.data.content,
    provenance: 'user', // user-authored → never "inferred"
    review_state: 'accepted',
  });
  // A hand-authored block is a human edit → protect it from refill.
  await repo.updateWikiBlockContent(ws, id, parsed.data.content, { markEdited: true });
  return c.json({ ok: true, id, blocks_list: await repo.listWikiBlocks(ws, page.id) });
});

// Edit a block's content (human edit → protected from regeneration).
app.patch('/workspaces/:ws/wiki/blocks/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const id = c.req.param('id');
  const block = await repo.getWikiBlock(ws, id);
  if (!block || !await visibleWikiPage(c, ws, block.page_id)) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({ content: z.object({ section_key: z.string().optional(), text: z.string().optional(), items: z.array(z.string()).optional(), url: z.string().optional(), alt: z.string().optional() }) })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  await repo.updateWikiBlockContent(ws, id, parsed.data.content, { markEdited: true });
  return c.json({ ok: true, blocks_list: await repo.listWikiBlocks(ws, block.page_id) });
});

// Replace a page's editable body in one shot (the unified rich-text editor
// saves the whole document, not one block at a time). Reconciles by id so
// existing blocks keep their citations/provenance/review; new nodes become
// user-authored blocks; removed blocks are deleted (inferred → remembered as
// rejected). Pending-review blocks are untouched (they live in the review strip).
app.put('/workspaces/:ws/wiki/pages/:id/body', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const page = await visibleWikiPage(c, ws, c.req.param('id'));
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z
    .object({
      blocks: z.array(
        z.object({
          id: z.string().optional(),
          type: z.string().default('paragraph'),
          content: z.object({
            section_key: z.string().optional(),
            text: z.string().optional(),
            items: z.array(z.string()).optional(),
            url: z.string().optional(),
            alt: z.string().optional(),
          }),
        }),
      ),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  await repo.replaceWikiPageBody(ws, page.id, parsed.data.blocks);
  return c.json({ ok: true, blocks_list: await repo.listWikiBlocks(ws, page.id) });
});

// Delete a block.
app.delete('/workspaces/:ws/wiki/blocks/:id', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const id = c.req.param('id');
  const block = await repo.getWikiBlock(ws, id);
  if (!block || !await visibleWikiPage(c, ws, block.page_id)) return c.json({ error: 'not found' }, 404);
  await repo.deleteWikiBlock(ws, id);
  return c.json({ ok: true, blocks_list: await repo.listWikiBlocks(ws, block.page_id) });
});

// Set a page's audience (spec §9). Enforces the no-widening invariant: a page
// may not be made MORE OPEN than the most-restrictive node it draws on.
const AUDIENCE_OPENNESS: Record<string, number> = { only_me: 0, private: 1, team: 2 };
app.patch('/workspaces/:ws/wiki/pages/:id/visibility', authn, workspaceGate, async (c) => {
  const ws = c.get('workspace_id');
  const page = await visibleWikiPage(c, ws, c.req.param('id'));
  if (!page || page.status !== 'active') return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ visibility: z.enum(['team', 'private', 'only_me']) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);
  const want = parsed.data.visibility;
  // Only the page's owner (or a workspace admin) changes who can see it. An
  // ownerless page is claimed by whoever first restricts it, so the
  // restriction has someone it applies to.
  const caller = c.get('user_id');
  if (page.owner_user_id && page.owner_user_id !== caller && c.get('role') !== 'workspace_admin') {
    return c.json({ error: 'forbidden', detail: "only the page's owner or an admin can change its audience" }, 403);
  }

  // Constituent nodes = the page's cited nodes ∪ its origin-document nodes.
  const citedIds = new Set<string>();
  for (const b of await repo.listWikiBlocks(ws, page.id)) for (const id of b.cited_node_ids) citedIds.add(id);
  for (const docId of page.source_doc_ids ?? []) {
    for (const id of await repo.listNodeIdsByDocument(ws, docId)) citedIds.add(id);
    for (const id of await repo.listNodeIdsByDocumentEvidence(ws, docId)) citedIds.add(id);
  }
  const vis = await repo.getNodeVisibilities(ws, [...citedIds]);
  let floor = 2; // team
  let floorNode: string | undefined;
  for (const [id, v] of vis) {
    const o = AUDIENCE_OPENNESS[v] ?? 2;
    if (o < floor) { floor = o; floorNode = id; }
  }
  if ((AUDIENCE_OPENNESS[want] ?? 2) > floor) {
    return c.json(
      { error: 'would_widen', detail: `cannot set '${want}' — it is wider than node ${floorNode} (${Object.keys(AUDIENCE_OPENNESS).find((k) => AUDIENCE_OPENNESS[k] === floor)}). Widen the node first.` },
      422,
    );
  }
  await repo.updateWikiPage(ws, page.id, {
    visibility: want,
    ...(!page.owner_user_id && want !== 'team' ? { owner_user_id: caller } : {}),
  });
  return c.json({ ok: true, visibility: want });
});
}
