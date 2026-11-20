/**
 * Wiki view (spec-wiki.md / wiki-milestones.md M1).
 *
 * A read/edit surface for the wiki: a single lateral page-tree (categories →
 * pages → children) plus a reading pane. M1 renders STRUCTURE — pages show
 * their planned `sections` as "awaiting fill" placeholders; body prose is M2.
 * The tree is fully editable here: add / rename / move / reorder / remove
 * categories and pages. An article opens in a full-screen focus reader.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeHtml } from '../lib/safe-html.js';
import {
  BellRing,
  BookText,
  Check,
  ChevronRight,
  Ellipsis,
  Expand,
  Loader2,
  Minimize2,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api.js';
import type { WikiTreeNode, WikiPageRecord, WikiBlockRecord, WikiSection } from '../api.js';
import { AudienceSelect } from '../components/AudienceSelect.js';
import { WikiEditor, type WikiBodyBlock, type WikiEditorHandle } from '../components/WikiEditor.js';
import type { Audience } from '../audience.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function flatten(tree: WikiTreeNode[]): WikiTreeNode[] {
  const out: WikiTreeNode[] = [];
  const walk = (n: WikiTreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return out;
}

export function Wiki({ wsId }: { wsId: string }) {
  // Structure is always editable here; the read-only `mirrored` mode is kept
  // only as an optional prop for embedding hosts.
  const mirrored = false;

  const [tree, setTree] = useState<WikiTreeNode[] | null>(null);
  const [hasWiki, setHasWiki] = useState(false);
  const [building, setBuilding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [contentVersion, setContentVersion] = useState(0);
  const [addingUnder, setAddingUnder] = useState<string | 'root' | null>(null);
  const [addTitle, setAddTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  // Incremental fill progress: pages are filled one at a time so each article
  // appears as soon as it is ready. `fillTotal > 0` means a fill run is active;
  // `fillActive` is the page currently generating; `fillDone` are the finished
  // ones. These drive the progress banner and the per-page status in the tree.
  const [fillTotal, setFillTotal] = useState(0);
  const [fillActive, setFillActive] = useState<string | null>(null);
  const [fillDone, setFillDone] = useState<Set<string>>(new Set());

  // Current selection, readable from inside the async fill loop without making it
  // a dependency (so navigating away mid-fill still refreshes the right page).
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const load = useCallback(async () => {
    const r = await api.getWiki(wsId);
    setTree(r.tree);
    setHasWiki(r.wiki != null);
    setStale(r.stale);
    setSelectedId((cur) => cur ?? flatten(r.tree).find((n) => n.kind === 'page')?.id ?? null);
  }, [wsId]);

  // Fill a list of pages sequentially, revealing each the moment it lands: the
  // tree marks it done, and if the reader is on that page its content refetches.
  const fillPagesIncrementally = useCallback(
    async (ids: string[]): Promise<number> => {
      setFillDone(new Set());
      setFillTotal(ids.length);
      let filled = 0;
      try {
        for (const id of ids) {
          setFillActive(id);
          try {
            const res = await api.fillWikiPage(wsId, id);
            if (res.blocks > 0) filled++;
          } catch {
            // A single page failing to fill must not abort the rest.
          }
          setFillActive(null);
          setFillDone((prev) => new Set(prev).add(id));
          // If the reader is looking at the page that just filled, remount it so
          // the fresh content shows immediately; other pages update on next open.
          if (selectedIdRef.current === id) setContentVersion((v) => v + 1);
        }
      } finally {
        setFillActive(null);
        setFillTotal(0);
        await load(); // final sync of tree + stale flag
      }
      return filled;
    },
    [wsId, load],
  );

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const r = await api.fillWiki(wsId);
      await load();
      setContentVersion((v) => v + 1); // force open page to refetch its blocks
      // A refresh replans when new sources landed, so it can grow the tree.
      const added = r.added_pages > 0 ? `, added ${r.added_pages} new ${r.added_pages === 1 ? 'page' : 'pages'}` : '';
      toast.success(`Refreshed ${r.filled} of ${r.pages} pages${added}`);
    } catch (e) {
      toast.error(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    setTree(null);
    setSelectedId(null);
    setFocus(false);
    load().catch((e) => toast.error(`Could not load wiki: ${e.message}`));
  }, [wsId, load]);

  const build = async () => {
    setBuilding(true);
    try {
      const r = await api.buildWiki(wsId);
      // Show the structure immediately, then fill pages one by one — sections are
      // generated right away and each article appears as soon as it is ready, so
      // the reader can start on the first page while the rest are still building.
      setTree(r.tree);
      setHasWiki(true);
      const pageIds = flatten(r.tree).filter((n) => n.kind === 'page').map((n) => n.id);
      setSelectedId(pageIds[0] ?? null);
      toast.success(`Structure built (${r.pages} pages)${r.via === 'fallback' ? ' — offline structure' : ''} — generating content…`);
      const filled = await fillPagesIncrementally(pageIds);
      toast.success(`Wiki ready — filled ${filled} of ${pageIds.length} pages`);
    } catch (e) {
      toast.error(`Build failed: ${(e as Error).message}`);
    } finally {
      setBuilding(false);
    }
  };

  // Per-page fill status for the tree: the page in flight, ones already done,
  // ones still queued, or null when no fill run is active.
  const fillStatus = useCallback(
    (id: string): 'active' | 'pending' | 'done' | null => {
      if (fillTotal === 0) return null;
      if (fillActive === id) return 'active';
      return fillDone.has(id) ? 'done' : 'pending';
    },
    [fillTotal, fillActive, fillDone],
  );

  const pages = useMemo(() => (tree ? flatten(tree) : []), [tree]);
  const selected = pages.find((p) => p.id === selectedId) ?? null;

  const addPage = async (parentId: string | null, kind: 'category' | 'page') => {
    const title = addTitle.trim();
    if (!title) return;
    try {
      const r = await api.addWikiPage(wsId, { kind, title, parent_id: parentId });
      setTree(r.tree);
      setAddingUnder(null);
      setAddTitle('');
      if (kind === 'page') setSelectedId(r.id);
    } catch (e) {
      toast.error(`Could not add: ${(e as Error).message}`);
    }
  };

  const rename = async (id: string) => {
    const title = renameTitle.trim();
    if (!title) return setRenamingId(null);
    try {
      const r = await api.updateWikiPage(wsId, id, { title });
      setTree(r.tree);
    } catch (e) {
      toast.error(`Rename failed: ${(e as Error).message}`);
    } finally {
      setRenamingId(null);
    }
  };

  const move = async (id: string, parentId: string | null) => {
    try {
      const r = await api.updateWikiPage(wsId, id, { parent_id: parentId });
      setTree(r.tree);
    } catch (e) {
      toast.error(`Move failed: ${(e as Error).message}`);
    }
  };

  const remove = async (id: string) => {
    try {
      const r = await api.removeWikiPage(wsId, id);
      setTree(r.tree);
      if (selectedId === id) setSelectedId(flatten(r.tree).find((n) => n.kind === 'page')?.id ?? null);
    } catch (e) {
      toast.error(`Remove failed: ${(e as Error).message}`);
    }
  };

  // Category targets a page can be moved under (all categories + top-level).
  const moveTargets = useMemo(
    () => pages.filter((p) => p.kind === 'category'),
    [pages],
  );

  if (tree === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!hasWiki || pages.length === 0) {
    // A mirrored folder's wiki is built on the team server, so there is nothing
    // to build here — say where it comes from instead of offering a button that
    // would generate a divergent local one.
    if (mirrored) {
      return (
        <div className="mx-auto max-w-xl rounded-xl border border-dashed p-10 text-center shadow-soft">
          <div className="eyebrow mb-2">No wiki yet</div>
          <h2 className="font-serif text-2xl italic">This folder's wiki lives on the team server</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            Build it in the web app and it will appear here — the same pages, the same content — the
            next time this directory syncs.
          </p>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-dashed p-10 text-center shadow-soft">
        <div className="eyebrow mb-2">Nothing built yet</div>
        <h2 className="font-serif text-2xl italic">Build your wiki from this folder</h2>
        <p className="mx-auto mt-2 mb-5 max-w-sm text-sm text-muted-foreground">
          We read this folder's profile and sources, propose categories and pages (one per product,
          sections per aspect), and fill each page with cited content — all in one step. You reshape
          from there.
        </p>
        <Button onClick={build} disabled={building}>
          {building ? 'Building…' : 'Build wiki'}
        </Button>
      </div>
    );
  }

  return (
    <div className={focus ? 'fixed inset-0 z-50 overflow-auto bg-background' : 'space-y-4'}>
      {!focus && fillTotal > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-pome-red/40 bg-pome-red/5 px-4 py-2.5 text-sm">
          <Loader2 className="size-4 animate-spin text-pome-red" />
          <span className="flex-1">
            Generating content — <span className="tabular-nums">{fillDone.size}</span> of{' '}
            <span className="tabular-nums">{fillTotal}</span> pages ready. You can read the finished ones now.
          </span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-pome-red transition-all duration-300"
              style={{ width: `${Math.round((fillDone.size / fillTotal) * 100)}%` }}
            />
          </div>
        </div>
      )}
      {!focus && stale && (
        <div className="flex items-center gap-3 rounded-lg border border-pome-red/40 bg-pome-red/5 px-4 py-2.5 text-sm">
          <RefreshCw className="size-4 text-pome-red" />
          <span className="flex-1">
            The vault changed since this wiki was built — some pages may be out of date.
            {mirrored && ' Refresh it in the web app; the update reaches this directory on the next sync.'}
          </span>
          {!mirrored && (
            <Button size="sm" onClick={refreshAll} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh content'}
            </Button>
          )}
        </div>
      )}
      <div className={focus ? 'mx-auto max-w-3xl px-6 py-10' : 'grid gap-4 sm:grid-cols-[260px_minmax(0,1fr)]'}>
        {/* page tree — the single lateral nav (hidden in focus mode) */}
        {!focus && (
          <aside className="rounded-xl border p-0 shadow-soft">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="flex items-center gap-2 font-serif text-lg italic">
                <BookText className="size-4 text-muted-foreground" /> Wiki
                {mirrored && (
                  <span
                    className="font-mono text-[10px] not-italic uppercase tracking-wider text-muted-foreground"
                    title="This wiki is built on the team server and synced here — the same pages everyone else reads. Edit it in the web app."
                  >
                    synced
                  </span>
                )}
              </span>
              {/* Structure controls are the cloud's job for a mirrored folder. */}
              {!mirrored && (
                <div className="flex items-center gap-1">
                  <button
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Add category"
                    onClick={() => {
                      setAddingUnder('root');
                      setAddTitle('');
                    }}
                  >
                    <Plus className="size-4" />
                  </button>
                  <button
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Rebuild structure from profile + sources"
                    onClick={build}
                  >
                    <RefreshCw className={`size-4 ${building ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-[70vh] overflow-auto p-2">
              {tree.map((cat) => (
                <TreeCategory
                  key={cat.id}
                  node={cat}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  renamingId={renamingId}
                  renameTitle={renameTitle}
                  setRenameTitle={setRenameTitle}
                  onRenameStart={(id, title) => {
                    setRenamingId(id);
                    setRenameTitle(title);
                  }}
                  onRenameCommit={rename}
                  onRemove={remove}
                  onMove={move}
                  moveTargets={moveTargets}
                  addingUnder={addingUnder}
                  addTitle={addTitle}
                  setAddTitle={setAddTitle}
                  onAddStart={setAddingUnder}
                  onAddCommit={addPage}
                  fillStatus={fillStatus}
                  mirrored={mirrored}
                />
              ))}

              {!mirrored && addingUnder === 'root' && (
                <InlineAdd
                  value={addTitle}
                  onChange={setAddTitle}
                  placeholder="New category…"
                  onCommit={() => addPage(null, 'category')}
                  onCancel={() => setAddingUnder(null)}
                />
              )}
              {!mirrored && addingUnder !== 'root' && (
                <button
                  className="mt-2 flex w-full items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground hover:border-pome-red hover:text-foreground"
                  onClick={() => {
                    setAddingUnder('root');
                    setAddTitle('');
                  }}
                >
                  <Plus className="size-3.5" /> New category
                </button>
              )}
            </div>
          </aside>
        )}

        {/* reading pane */}
        <section className={focus ? '' : 'min-w-0'}>
          {selected ? (
            <PageView
              key={`${selected.id}:${contentVersion}`}
              page={selected}
              wsId={wsId}
              focus={focus}
              onToggleFocus={() => setFocus((f) => !f)}
              breadcrumb={breadcrumbFor(pages, selected)}
              generating={fillStatus(selected.id) === 'active' || fillStatus(selected.id) === 'pending'}
              mirrored={mirrored}
            />
          ) : (
            <div className="rounded-xl border p-8 text-center shadow-soft">
              <h2 className="font-serif text-2xl italic text-muted-foreground">Pick a page to read.</h2>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function breadcrumbFor(pages: WikiTreeNode[], page: WikiPageRecord): string {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const parts: string[] = [];
  let cur: WikiPageRecord | undefined = page;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    parts.unshift(cur.title);
    seen.add(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(' / ');
}

function TreeCategory(props: {
  node: WikiTreeNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renamingId: string | null;
  renameTitle: string;
  setRenameTitle: (s: string) => void;
  onRenameStart: (id: string, title: string) => void;
  onRenameCommit: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  moveTargets: WikiTreeNode[];
  addingUnder: string | 'root' | null;
  addTitle: string;
  setAddTitle: (s: string) => void;
  onAddStart: (id: string) => void;
  onAddCommit: (parentId: string | null, kind: 'category' | 'page') => void;
  fillStatus: (id: string) => 'active' | 'pending' | 'done' | null;
  /** Read-only mode for embedding hosts that mirror a wiki from elsewhere. */
  mirrored?: boolean;
}) {
  const { node, ...rest } = props;
  return (
    <div className="mb-3">
      <div className="group flex items-center gap-1 px-1 py-1">
        {props.renamingId === node.id ? (
          <InlineRename
            value={props.renameTitle}
            onChange={props.setRenameTitle}
            onCommit={() => props.onRenameCommit(node.id)}
          />
        ) : (
          <span className="flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {node.title}
          </span>
        )}
        {!props.mirrored && (
          <>
            <button
              className="p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              title="Add page"
              onClick={() => {
                props.onAddStart(node.id);
                props.setAddTitle('');
              }}
            >
              <Plus className="size-3.5" />
            </button>
            <RowMenu
              onRename={() => props.onRenameStart(node.id, node.title)}
              onRemove={() => props.onRemove(node.id)}
              moveTargets={props.moveTargets.filter((t) => t.id !== node.id)}
              onMove={(pid) => props.onMove(node.id, pid)}
              allowTopLevel={false}
            />
          </>
        )}
      </div>

      {node.children.map((child) => (
        <TreePage key={child.id} {...rest} node={child} depth={0} />
      ))}

      {props.addingUnder === node.id && (
        <InlineAdd
          value={props.addTitle}
          onChange={props.setAddTitle}
          placeholder="New page…"
          onCommit={() => props.onAddCommit(node.id, 'page')}
          onCancel={() => props.onAddStart('')}
        />
      )}
    </div>
  );
}

function TreePage(props: {
  node: WikiTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renamingId: string | null;
  renameTitle: string;
  setRenameTitle: (s: string) => void;
  onRenameStart: (id: string, title: string) => void;
  onRenameCommit: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, parentId: string | null) => void;
  moveTargets: WikiTreeNode[];
  addingUnder: string | 'root' | null;
  addTitle: string;
  setAddTitle: (s: string) => void;
  onAddStart: (id: string) => void;
  onAddCommit: (parentId: string | null, kind: 'category' | 'page') => void;
  fillStatus: (id: string) => 'active' | 'pending' | 'done' | null;
  /** Read-only mode for embedding hosts that mirror a wiki from elsewhere. */
  mirrored?: boolean;
}) {
  const { node, depth, ...rest } = props;
  const active = props.selectedId === node.id;
  const fs = node.kind === 'page' ? props.fillStatus(node.id) : null;
  return (
    <>
      <div
        className={`group flex items-center gap-1 rounded-md border-l-2 pr-1 ${
          active ? 'border-pome-red bg-accent/60' : 'border-transparent hover:bg-accent/40'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {props.renamingId === node.id ? (
          <InlineRename
            value={props.renameTitle}
            onChange={props.setRenameTitle}
            onCommit={() => props.onRenameCommit(node.id)}
          />
        ) : (
          <button
            className={`flex-1 truncate py-1.5 text-left text-sm ${fs === 'pending' ? 'text-muted-foreground' : ''}`}
            onClick={() => props.onSelect(node.id)}
          >
            {node.title}
          </button>
        )}
        {fs === 'active' && (
          <span title="Generating…" className="shrink-0">
            <Loader2 className="size-3 animate-spin text-pome-red" />
          </span>
        )}
        {fs === 'done' && (
          <span title="Ready" className="shrink-0">
            <Check className="size-3 text-emerald-600" />
          </span>
        )}
        {fs === 'pending' && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" title="Queued" />}
        {!props.mirrored && (
          <>
            <button
              className="p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              title="Add sub-page"
              onClick={() => {
                props.onAddStart(node.id);
                props.setAddTitle('');
              }}
            >
              <Plus className="size-3.5" />
            </button>
            <RowMenu
              onRename={() => props.onRenameStart(node.id, node.title)}
              onRemove={() => props.onRemove(node.id)}
              moveTargets={props.moveTargets.filter((t) => t.id !== node.id)}
              onMove={(pid) => props.onMove(node.id, pid)}
              allowTopLevel={false}
            />
          </>
        )}
      </div>
      {node.children.map((child) => (
        <TreePage key={child.id} {...rest} node={child} depth={depth + 1} />
      ))}
      {props.addingUnder === node.id && (
        <div style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
          <InlineAdd
            value={props.addTitle}
            onChange={props.setAddTitle}
            placeholder="New sub-page…"
            onCommit={() => props.onAddCommit(node.id, 'page')}
            onCancel={() => props.onAddStart('')}
          />
        </div>
      )}
    </>
  );
}

function RowMenu(props: {
  onRename: () => void;
  onRemove: () => void;
  onMove: (parentId: string | null) => void;
  moveTargets: WikiTreeNode[];
  allowTopLevel: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
        title="More"
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuItem onClick={props.onRename}>Rename</DropdownMenuItem>
        {(props.moveTargets.length > 0 || props.allowTopLevel) && (
          <>
            <DropdownMenuSeparator />
            {props.allowTopLevel && (
              <DropdownMenuItem onClick={() => props.onMove(null)}>Move to top level</DropdownMenuItem>
            )}
            {props.moveTargets.map((t) => (
              <DropdownMenuItem key={t.id} onClick={() => props.onMove(t.id)}>
                Move to “{t.title}”
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-pome-red focus:text-pome-red" onClick={props.onRemove}>
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InlineAdd(props: {
  value: string;
  onChange: (s: string) => void;
  placeholder: string;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="my-1 px-1">
      <Input
        autoFocus
        value={props.value}
        placeholder={props.placeholder}
        className="h-7 text-sm"
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onCommit();
          if (e.key === 'Escape') props.onCancel();
        }}
        onBlur={props.onCancel}
      />
    </div>
  );
}

function InlineRename(props: { value: string; onChange: (s: string) => void; onCommit: () => void }) {
  return (
    <Input
      autoFocus
      value={props.value}
      className="h-7 flex-1 text-sm"
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') props.onCommit();
      }}
      onBlur={props.onCommit}
    />
  );
}

function PageView(props: {
  page: WikiPageRecord;
  wsId: string;
  focus: boolean;
  onToggleFocus: () => void;
  breadcrumb: string;
  generating?: boolean;
  /** Read-only mode for embedding hosts that mirror a wiki from elsewhere. */
  mirrored?: boolean;
}) {
  const { page } = props;
  const [blocks, setBlocks] = useState<WikiBlockRecord[] | null>(null);
  const [filling, setFilling] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  // Turn this article into a recurring update: a weekly, cited digest of graph
  // changes on this page's topic, delivered by email. Manage it under Updates.
  const subscribeUpdate = async () => {
    setSubscribing(true);
    try {
      await api.createUpdate(props.wsId, {
        topic: page.title,
        cadence_ms: 7 * 24 * 60 * 60 * 1000,
        medium: 'email',
      });
      toast.success(`Weekly updates on “${page.title}” — manage them under Updates.`);
    } catch (e) {
      toast.error(`Could not subscribe: ${(e as Error).message}`);
    } finally {
      setSubscribing(false);
    }
  };
  // Remount key for the editor: bumped only on load / fill / accept — NOT on
  // every autosave, so typing never loses the cursor.
  const [bodyReload, setBodyReload] = useState(0);
  // Sections live in state, not straight off the prop: a document-reproduction
  // fill reshapes the page's sections to mirror the source document's headings,
  // so we seed from the prop and then keep them in sync with the server.
  const [sections, setSections] = useState<WikiSection[]>(page.sections ?? []);

  useEffect(() => {
    setBlocks(null);
    setSections(page.sections ?? []);
    api
      .getWikiPage(props.wsId, page.id)
      .then((r) => {
        setBlocks(r.blocks);
        setSections(r.page?.sections ?? page.sections ?? []);
        setBodyReload((v) => v + 1);
      })
      .catch(() => {
        setBlocks([]);
        setBodyReload((v) => v + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.wsId, page.id]);

  // The editable document = every non-pending, non-rejected block. Pending
  // (AI-suggested) blocks live in a separate review strip, not the editor.
  const editableBlocks = useMemo(
    () => (blocks ?? []).filter((b) => b.review_state === 'accepted' || b.provenance === 'user'),
    [blocks],
  );
  const pendingBlocks = useMemo(() => (blocks ?? []).filter((b) => b.review_state === 'pending'), [blocks]);
  const editorRef = useRef<WikiEditorHandle | null>(null);

  const review = async (id: string, action: 'accept' | 'reject') => {
    try {
      // Persist the editor's pending edits BEFORE accepting: accept promotes a
      // pending block into the document and remounts the editor, and the old
      // editor's unmount flush would otherwise save stale content that omits the
      // just-accepted block → the server would wrongly reject it. Flushing first
      // (while the block is still pending, hence untouched) closes that race.
      if (action === 'accept') await editorRef.current?.flush();
      const r = await api.reviewWikiBlock(props.wsId, id, action);
      setBlocks(r.blocks_list);
      // An accepted suggestion joins the document → remount the editor so it shows.
      if (action === 'accept') setBodyReload((v) => v + 1);
    } catch (e) {
      toast.error(`Could not ${action}: ${(e as Error).message}`);
    }
  };

  const saveBody = async (body: WikiBodyBlock[]): Promise<WikiBlockRecord[]> => {
    const r = await api.saveWikiBody(props.wsId, page.id, body);
    setBlocks(r.blocks_list); // keeps pending strip + counts in sync; editor stays mounted
    return r.blocks_list;
  };

  const [visibility, setVisibility] = useState<Audience>(page.visibility);
  const changeAudience = async (a: Audience) => {
    const prev = visibility;
    setVisibility(a);
    try {
      await api.setWikiPageVisibility(props.wsId, page.id, a);
    } catch (e) {
      setVisibility(prev);
      const msg = (e as Error).message;
      toast.error(msg.includes('would_widen') ? 'Cannot widen past a restricted source node — widen the node first.' : `Could not change audience: ${msg}`);
    }
  };

  const fill = async () => {
    setFilling(true);
    try {
      const r = await api.fillWikiPage(props.wsId, page.id);
      setBlocks(r.blocks_list);
      setBodyReload((v) => v + 1); // reload the editor with the freshly filled body
      // A document fill may have reshaped the sections to the source's headings —
      // refetch so the seed headings stay aligned.
      api
        .getWikiPage(props.wsId, page.id)
        .then((p) => {
          setSections(p.page?.sections ?? sections);
          setBodyReload((v) => v + 1);
        })
        .catch(() => {});
      toast.success(r.blocks > 0 ? `Filled ${r.blocks} block${r.blocks === 1 ? '' : 's'}` : 'No related nodes to fill from yet');
    } catch (e) {
      toast.error(`Fill failed: ${(e as Error).message}`);
    } finally {
      setFilling(false);
    }
  };

  const hasContent = editableBlocks.length > 0;
  // With no body yet, seed the editor with the planned section headings so the
  // page opens with structure to type under (these persist only if edited).
  const seed: WikiBlockRecord[] =
    editableBlocks.length > 0
      ? editableBlocks
      : sections.map((s, i) => ({
          // Stable, page-unique id so the editor's save-signature is
          // deterministic. A blank id makes collect() mint a fresh random id on
          // every pass → spurious autosaves and, worse, an Accept-triggered
          // remount can flush stale content that wrongly rejects the just-
          // accepted block. Must be page-scoped: a bare wb_seed_${i} would
          // collide across pages (PK is (workspace_id,id)) and fail the INSERT.
          id: `wb_seed_${page.id}_${i}`,
          type: 'heading',
          content: { text: `<h2>${escHtml(s.heading)}</h2>` },
          cited_node_ids: [],
          provenance: 'user',
          review_state: 'accepted',
        }));

  return (
    <div className="rounded-xl border p-6 shadow-soft sm:p-8">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex-1 truncate font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {props.breadcrumb}
        </span>
        {page.kind === 'page' && !props.mirrored && (
          <Button variant="outline" size="sm" onClick={fill} disabled={filling} className="gap-1.5">
            <Sparkles className="size-4" />
            {filling ? 'Filling…' : hasContent ? 'Refill' : 'Fill sections'}
          </Button>
        )}
        {page.kind === 'page' && (
          <Button
            variant="outline"
            size="sm"
            onClick={subscribeUpdate}
            disabled={subscribing}
            className="gap-1.5"
            title="Get a recurring, cited update on this article's topic"
          >
            <BellRing className="size-4" />
            {subscribing ? 'Subscribing…' : 'Get updates'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={props.onToggleFocus} className="gap-1.5">
          {props.focus ? <Minimize2 className="size-4" /> : <Expand className="size-4" />}
          {props.focus ? 'Exit full screen' : 'Full screen'}
        </Button>
      </div>

      <h1 className="font-serif text-3xl">{page.title}</h1>

      <div className="mt-3 mb-6 flex flex-wrap items-center gap-2">
        {page.kind === 'page' && !props.mirrored && <AudienceSelect value={visibility} onChange={changeAudience} />}
        {page.source_doc_ids.map((d) => (
          <span key={d} className="rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            ◧ {d}
          </span>
        ))}
      </div>

      {props.generating && page.kind === 'page' && !hasContent && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-pome-red/30 bg-pome-red/5 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin text-pome-red" />
          Generating this article… its content will appear here in a moment.
        </div>
      )}

      {blocks === null ? (
        <Skeleton className="h-24 w-full" />
      ) : page.kind === 'category' ? (
        <p className="text-sm text-muted-foreground">A category — open a page inside it.</p>
      ) : (
        <>
          {/* Mirrored: the cloud owns this text. Editing it here would be
              overwritten by the next sync, so the page reads rather than edits. */}
          <WikiEditor
            ref={editorRef}
            key={`${page.id}:${bodyReload}`}
            blocks={seed}
            onSave={saveBody}
            editable={!props.mirrored}
          />

          {pendingBlocks.length > 0 && (
            <div className="mt-6 rounded-lg border border-[oklch(0.5_0.16_300)]/40 bg-[oklch(0.5_0.16_300)]/5 p-4">
              <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-[oklch(0.5_0.16_300)]">
                <Sparkles className="size-3.5" /> {pendingBlocks.length} suggested addition{pendingBlocks.length === 1 ? '' : 's'}
              </div>
              <div className="space-y-2">
                {pendingBlocks.map((b) => (
                  <div key={b.id} className="flex items-start gap-3 rounded-md border bg-card px-3 py-2">
                    <div className="min-w-0 flex-1 text-sm">
                      {b.type === 'image' && b.content.url ? (
                        <img src={b.content.url} alt={b.content.alt ?? ''} className="max-h-48 rounded border" />
                      ) : b.type === 'list' && b.content.items ? (
                        <ul className="list-disc pl-5">{b.content.items.map((it, i) => <li key={i}>{it}</li>)}</ul>
                      ) : (
                        <div className="wiki-prose" dangerouslySetInnerHTML={{ __html: pendingHtml(b) }} />
                      )}
                      {b.cited_node_ids.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {b.cited_node_ids.map((id) => (
                            <span key={id} className="rounded border border-pome-red/30 px-1 font-mono text-[10px] text-pome-red">
                              {id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Accept/reject is a decision about the team's wiki — it
                        belongs where the wiki is authored. Locally it would be
                        undone by the next sync, so a mirror only shows them. */}
                    {!props.mirrored && (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button className="rounded-md bg-primary px-2 py-0.5 font-mono text-[11px] text-primary-foreground hover:brightness-110" onClick={() => review(b.id, 'accept')}>
                          Accept
                        </button>
                        <button className="rounded-md border border-input px-2 py-0.5 font-mono text-[11px] hover:bg-muted" onClick={() => review(b.id, 'reject')}>
                          Reject
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {page.kind === 'page' && !hasContent && pendingBlocks.length === 0 && sections.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">
              Empty page — start typing above, or use “Fill sections” to build from the related nodes.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Read-only HTML for a pending suggestion card (plain text is wrapped so
// newlines survive; already-rich text is shown as authored).
function pendingHtml(b: WikiBlockRecord): string {
  const t = b.content.text ?? '';
  if (/<[a-z][\s\S]*>/i.test(t)) return safeHtml(t);
  return `<p>${escHtml(t).replace(/\n/g, '<br>')}</p>`;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
