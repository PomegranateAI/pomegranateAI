import { DataAgentsPanel } from '../components/DataAgents';
import { NodeMedia } from '../components/NodeMedia';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  History,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api.js';
import type {
  ContextProfile,
  DocumentRecord,
  NodeEvidence,
  NodeKindDef,
  Subgraph,
  WikiBlockRecord,
} from '../api.js';
import { fetchWorkspaceProfile, kindColorVar } from '../profiles.js';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AUDIENCE_LABEL, AUDIENCE_SHORT, AUDIENCE_TIERS, type Audience } from '../audience.js';
import { AudienceSelect } from '../components/AudienceSelect.js';
import { WikiEditor, type WikiBodyBlock } from '../components/WikiEditor.js';
import { safeHtml } from '../lib/safe-html.js';
import { AddSourceWidget, SourceChipList } from './Sources.js';
import { ReportPanel, timeAgo } from './Report.js';

type DocRecord = DocumentRecord;

/** A node's current audience + whether the viewer may change it. */
type NodeAudienceInfo = { audience: Audience; editable: boolean };
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Persisted opt-out for the delete-confirmation dialog ("don't show again").
const SKIP_DELETE_CONFIRM_KEY = 'pmg_skip_delete_confirm';
// Persisted "show source + date under every node" preference (default on).
const SHOW_NODE_META_KEY = 'pmg_show_node_meta';

// The sort control collapsed from a three-segment button group to one trigger,
// so the trigger has to carry the current order itself.
const SORT_LABEL: Record<'alpha' | 'newest' | 'oldest', string> = {
  alpha: 'A\u2013Z',
  newest: 'Newest',
  oldest: 'Oldest',
};
const SORT_ICON: Record<'alpha' | 'newest' | 'oldest', ReactNode> = {
  alpha: <ArrowDownAZ className="size-3.5" />,
  newest: <ArrowDownWideNarrow className="size-3.5" />,
  oldest: <ArrowUpWideNarrow className="size-3.5" />,
};

type GNode = {
  id: string;
  type: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  // Set on an archived node once something superseded it — the successor's id.
  superseded?: string | null;
  source?: string;
  document_id?: string | null;
  evidence?: { sources: number; latest: string } | null;
  // The shape varies by kind; we read these defensively.
  title?: string;
  summary?: string;
  body?: string;
  priority?: string;
  kind?: string; // legacy positioning subkind
  category?: string;
  subkind?: string;
  period?: string;
  decided_on?: string;
  decided_by?: string;
  metric?: { name: string; current?: string; target?: string };
  attrs?: Record<string, unknown>;
  // Sharing (Phase 2), surfaced by GET /graph in the cloud app.
  visibility?: Audience;
  owner_user_id?: string | null;
  can_manage?: boolean;
};

function nodeSummary(n: GNode): string {
  return n.title ?? n.summary ?? n.body ?? n.id;
}

/** "12 Sep" within the current year, "12 Sep 2025" before it. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Where a node's text came from, in one line, for the collapsed row.
 *  Multi-source nodes name their primary document and count the rest, so the
 *  row stays one line whatever the evidence looks like. */
function NodeProvenance({ n, doc }: { n: GNode; doc: DocRecord | null }) {
  const extra = Math.max(0, (n.evidence?.sources ?? 0) - 1);
  const kind = doc?.source_kind ?? n.source ?? null;
  const ref = doc?.source_ref ?? null;
  // Nothing useful to say — don't spend a line saying it.
  if (!kind && !ref && !n.created_at) return null;
  return (
    <div className="gn-provenance mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 font-mono text-[0.65rem] leading-4 text-muted-foreground">
      {kind && <span className="shrink-0 uppercase tracking-wide">{kind}</span>}
      {ref && (
        <>
          {kind && <span aria-hidden>·</span>}
          {/* The only element allowed to shrink — a long filename or subject
              must never push the date off the row. */}
          <span className="truncate" title={ref}>
            {ref}
          </span>
        </>
      )}
      {extra > 0 && (
        <span className="shrink-0 text-flag-green" title={`Corroborated by ${n.evidence?.sources} sources`}>
          +{extra}
        </span>
      )}
      {(kind || ref) && <span aria-hidden>·</span>}
      <span className="shrink-0 whitespace-nowrap" title={new Date(n.created_at).toLocaleString()}>
        added {shortDate(n.created_at)}
      </span>
    </div>
  );
}

// Ranking control for the List view: 'alpha' (the long-standing default) or
// by creation date. Shared by every kind's sub-buckets so the whole page
// re-orders consistently when the user picks a different order.
function compareNodes(a: GNode, b: GNode, sort: 'alpha' | 'newest' | 'oldest'): number {
  if (sort === 'newest') return b.created_at.localeCompare(a.created_at);
  if (sort === 'oldest') return a.created_at.localeCompare(b.created_at);
  return nodeSummary(a).localeCompare(nodeSummary(b), undefined, { sensitivity: 'base' });
}

function nodeBody(n: GNode): string | undefined {
  const body = n.body;
  if (!body) return undefined;
  if (body.trim() === nodeSummary(n).trim()) return undefined;
  return body;
}

// Per-node display state in the List view:
//   'collapsed' — the title row only
//   'preview'   — title + the first ~5 lines of the body (the default)
//   'expanded'  — title + the full, editable body + fields/connections
type NodeDisplay = 'collapsed' | 'preview' | 'expanded';

function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

// Read-only render of a node body. Post-edit bodies are HTML (from the wiki
// editor); older bodies are plain text — which we render with `whitespace-pre-wrap`
// so line breaks in the description survive. `clamp` limits the preview to 5 lines.
function NodeBodyRead({
  body,
  clamp,
  className,
}: {
  body?: string;
  clamp?: boolean;
  className?: string;
}) {
  if (!body) return null;
  const clampCls = clamp ? 'line-clamp-5' : '';
  if (looksLikeHtml(body)) {
    return (
      <div
        className={`gn-prose wiki-prose text-sm text-muted-foreground ${clampCls} ${className ?? ''}`}
        dangerouslySetInnerHTML={{ __html: safeHtml(body) }}
      />
    );
  }
  return (
    <div className={`text-sm whitespace-pre-wrap text-muted-foreground ${clampCls} ${className ?? ''}`}>
      {body}
    </div>
  );
}

// The bucketing key for a node within its kind column. Reads, in order:
// legacy top-level fields (priority/kind/category), then the profile-aware
// data shape (subkind/category/attrs.category). The `attrs.category` fallback
// is what makes the whole-doc "Default" profile group by its inferred category
// (e.g. "competitor", "roadmap") rather than dumping every note in one bucket.
function bucketKey(n: GNode): string {
  return n.priority ?? n.subkind ?? n.kind ?? n.category ?? attrStr(n, 'category') ?? '_';
}

// Build the label lookup for a kind from its buckets/subkinds/categories.
function bucketLabels(k: NodeKindDef): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of k.buckets ?? []) m.set(b.key, b.label);
  for (const s of k.subkinds ?? []) m.set(s.key, s.label);
  for (const c of k.categories ?? []) m.set(c.key, c.label);
  return m;
}

// Defensive attr reader: returns a trimmed string or undefined.
function attrStr(n: GNode, key: string): string | undefined {
  const v = n.attrs?.[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export function Graph({
  wsId,
  subgraphs = [],
  subgraphId = 'default',
  initialDocumentFilter = null,
  onFolderUpdated,
  onFolderRemoved,
}: {
  wsId: string;
  /** Workspace's subfolders — passed through to the "Add source" widget's destination picker. */
  subgraphs?: Subgraph[];
  /** The subfolder currently open, preselected as the "Add source" destination. */
  subgraphId?: string;
  /** Pre-narrow the list to one document's nodes — the "View in Library" toast
   *  action after an ingest lands here instead of the whole subfolder. */
  initialDocumentFilter?: { documentId: string; title?: string } | null;
  onFolderUpdated?: () => void;
  onFolderRemoved?: () => void;
}) {
  const activeFolder = subgraphs.find((s) => s.id === subgraphId) ?? null;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  // Archive/delete are driven from the folder ⋯ menu, so their AlertDialogs are
  // controlled rather than trigger-nested: Radix unmounts a DropdownMenuItem as
  // the menu closes, which would take an AlertDialogTrigger down with it.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);
  const [profile, setProfile] = useState<ContextProfile | null>(null);
  // The active data agent's kinds are NOT part of the subfolder's baseline
  // profile (never touched, by design — spec §3) — merged in separately so
  // Library's category grouping (below) can display its entries. Without
  // this, `bet`/`risk`-typed nodes come back from the API correctly but
  // silently vanish from the list: `kinds` only ever iterated the baseline
  // profile's kinds, so `nodes.filter(n => n.type === kind.key)` matched
  // nothing for every one of them (found via a real ingest — the nodes
  // existed in the DB and the API returned them, but 0 categories rendered).
  const [activeAgentKinds, setActiveAgentKinds] = useState<NodeKindDef[]>([]);
  const [nodes, setNodes] = useState<GNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [docFilter, setDocFilter] = useState(initialDocumentFilter);
  useEffect(() => {
    setDocFilter(initialDocumentFilter);
  }, [initialDocumentFilter?.documentId, initialDocumentFilter?.title]);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [docRefresh, setDocRefresh] = useState(0);
  const [documents, setDocuments] = useState<DocRecord[]>([]);
  const [reportOpen, setReportOpen] = useState(false);
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  // Report freshness for the header's "View report" line (spec §4.3) —
  // undefined = not yet fetched, null = never generated. The panel itself
  // re-fetches on open; this is just the at-a-glance note.
  const [reportMeta, setReportMeta] = useState<{ generated_at: string } | null | undefined>(undefined);
  useEffect(() => {
    setReportMeta(undefined);
    api
      .getReport(wsId, subgraphId)
      .then((r) => setReportMeta(r.report ? { generated_at: r.report.generated_at } : null))
      .catch(() => setReportMeta(null));
  }, [wsId, subgraphId]);
  const subgraphName = subgraphs.find((s) => s.id === subgraphId)?.name ?? subgraphId;
  // List view (flattened, full-width): which category groups are collapsed, the
  // per-node display state (absent = 'preview'), and the node shown full screen.
  const [catCollapsed, setCatCollapsed] = useState<Set<string>>(new Set());
  const [listState, setListState] = useState<Map<string, NodeDisplay>>(new Map());
  const [fullscreenId, setFullscreenId] = useState<string | null>(null);
  // Ranking + supersession-visibility controls for the flattened List view.
  // 'alpha' (title order) is the long-standing default — unchanged unless the
  // user picks a date order. `showSuperseded` is off by default, matching the
  // MCP surface's `include_superseded: false` default: a superseded node
  // stays in the graph but isn't part of what's shown as current.
  const [nodeSort, setNodeSort] = useState<'alpha' | 'newest' | 'oldest'>('alpha');
  const [showSuperseded, setShowSuperseded] = useState(false);
  // Per-node provenance (where it came from, when it landed) under every title.
  // On by default — it's the answer to "is this still true?", which is the
  // question the List view exists to answer. Persisted per browser.
  const [showNodeMeta, setShowNodeMeta] = useState(() => {
    try {
      return localStorage.getItem(SHOW_NODE_META_KEY) !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHOW_NODE_META_KEY, showNodeMeta ? '1' : '0');
    } catch {
      /* private mode / blocked storage — the preference just won't persist */
    }
  }, [showNodeMeta]);
  // Per-node audience (desktop only); empty on cloud.
  // Delete flow: the node awaiting confirmation (null = dialog closed), whether
  // the user has opted out of the confirmation, and the per-open checkbox state.
  const [pendingDelete, setPendingDelete] = useState<GNode | null>(null);
  const [skipConfirm, setSkipConfirm] = useState(
    () => localStorage.getItem(SKIP_DELETE_CONFIRM_KEY) === '1',
  );
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Archive the node server-side, then drop it from local state optimistically
  // (mirrors the setNodeAudienceCloud patch below). Archived nodes are excluded
  // from the active buckets, so removing it from `nodes` is enough.
  const deleteNode = useCallback(
    async (node: GNode) => {
      try {
        await api.archiveNode(wsId, node.id);
        setNodes((prev) => prev.filter((n) => n.id !== node.id));
        toast.success('Node deleted');
      } catch (e: any) {
        toast.error('Could not delete node', { description: e.message });
      }
    },
    [wsId],
  );

  // The X button calls this. If the user has ticked "don't show again", delete
  // straight away; otherwise open the confirmation dialog for this node.
  const requestDelete = useCallback(
    (node: GNode) => {
      if (skipConfirm) {
        void deleteNode(node);
        return;
      }
      setDontAskAgain(false);
      setPendingDelete(node);
    },
    [skipConfirm, deleteNode],
  );

  const confirmDelete = useCallback(async () => {
    const node = pendingDelete;
    if (!node) return;
    if (dontAskAgain) {
      localStorage.setItem(SKIP_DELETE_CONFIRM_KEY, '1');
      setSkipConfirm(true);
    }
    setDeleteBusy(true);
    await deleteNode(node);
    setDeleteBusy(false);
    setPendingDelete(null);
  }, [pendingDelete, dontAskAgain, deleteNode]);

  // Audience IS the node's visibility column. Set it via the workspace API and
  // optimistically patch the node so the pill updates immediately.
  const setNodeAudience = useCallback(
    async (node: GNode, target: Audience) => {
      try {
        await api.setNodeVisibility(wsId, node.id, target);
        setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, visibility: target } : n)));
        toast.success(`Set to ${AUDIENCE_LABEL[target]}`);
      } catch (e: any) {
        toast.error('Could not change privacy', { description: e.message });
      }
    },
    [wsId],
  );

  // Category-level fan-out: set every node of a kind to one audience in a single
  // request; optimistically patch the nodes the caller can manage.
  const setKindAudience = useCallback(
    async (kind: string, target: Audience) => {
      const kindNodes = nodes.filter((n) => n.type === kind);
      if (kindNodes.length === 0) return;
      try {
        const r = await api.setKindVisibility(wsId, kind, target);
        setNodes((prev) =>
          prev.map((n) => (n.type === kind && n.can_manage !== false ? { ...n, visibility: target } : n)),
        );
        toast.success(`Set ${r.changed} to ${AUDIENCE_LABEL[target]}${r.skipped ? ` · ${r.skipped} not owned` : ''}`);
      } catch (e: any) {
        toast.error('Could not change category audience', { description: e.message });
      }
    },
    [wsId, nodes],
  );

  // Subcategory-level fan-out: set every node in ONE category group to an
  // audience. The kind fan-out above spans the whole kind; this scopes to the
  // group's own nodes (only the ones the caller can manage), so the Share
  // control on each subcategory header does what it says.
  const setGroupAudience = useCallback(
    async (groupNodes: GNode[], target: Audience) => {
      const manageable = groupNodes.filter((n) => n.can_manage !== false);
      if (manageable.length === 0) {
        toast.error('None of these are yours to share');
        return;
      }
      try {
        await Promise.all(manageable.map((n) => api.setNodeVisibility(wsId, n.id, target)));
        const ids = new Set(manageable.map((n) => n.id));
        setNodes((prev) => prev.map((n) => (ids.has(n.id) ? { ...n, visibility: target } : n)));
        const skipped = groupNodes.length - manageable.length;
        toast.success(
          `Set ${manageable.length} to ${AUDIENCE_LABEL[target]}${skipped ? ` · ${skipped} not owned` : ''}`,
        );
      } catch (e: any) {
        toast.error('Could not change category audience', { description: e.message });
      }
    },
    [wsId],
  );

  // Persist an edited node body. The wiki editor hands us HTML; we round-trip
  // the WHOLE node through the upsert endpoint (POST /graph) with `body`
  // replaced. We strip the read-only enrichment fields the graph read adds
  // (evidence/visibility/owner/can_manage/document_id) so they don't leak into
  // the stored node JSON — visibility/owner live in dedicated columns the
  // upsert leaves untouched, so sharing is preserved across an edit.
  const saveNodeBody = useCallback(
    async (node: GNode, html: string) => {
      const { evidence, visibility, owner_user_id, can_manage, document_id, ...rest } = node;
      void evidence;
      void visibility;
      void owner_user_id;
      void can_manage;
      void document_id;
      const payload = { ...rest, body: html, updated_at: new Date().toISOString() };
      try {
        await api.saveNode(wsId, payload);
        setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, body: html } : n)));
      } catch (e: any) {
        toast.error('Could not save node', { description: e?.message });
        throw e; // let the editor retry on the next edit
      }
    },
    [wsId],
  );

  // The audience each pill reads — derived from the node's visibility column
  // (from GET /graph); `editable` gates on can_manage (owner/admin only).
  const audienceMap = useMemo<Record<string, { audience: Audience; editable: boolean }>>(() => {
    const m: Record<string, { audience: Audience; editable: boolean }> = {};
    for (const n of nodes) {
      m[n.id] = { audience: n.visibility ?? 'team', editable: n.can_manage !== false };
    }
    return m;
  }, [nodes]);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    let cancelled = false;
    // A source added from the in-view "Add source" dialog (docRefresh > 0) is a
    // silent background refetch — no full-screen loading flash for a change the
    // user just watched happen.
    const silent = docRefresh > 0;
    (async () => {
      try {
        if (!silent) setLoading(true);
        setError(null);
        const [p, r, d, agent] = await Promise.all([
          fetchWorkspaceProfile(wsId),
          api.listGraph(wsId, { includeArchived: true }),
          api.listDocuments(wsId, subgraphId).catch(() => ({ documents: [] })),
          api.getActiveDataAgent(wsId, subgraphId).catch(() => ({ active: null })),
        ]);
        if (!cancelled) {
          setProfile(p);
          setNodes(r.nodes as GNode[]);
          setDocuments(d.documents as DocRecord[]);
          setActiveAgentKinds((agent.active?.template.kinds as NodeKindDef[] | undefined) ?? []);
        }
      } catch (e: any) {
        if (!cancelled && !silent) setError(e?.message ?? 'Failed to load graph');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, subgraphId, docRefresh]);

  const archivedById = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of nodes) if (n.status === 'archived') m.set(n.id, n);
    return m;
  }, [nodes]);

  // An attached data agent REPLACES the baseline's Notes section, it does
  // not supplement it (spec §4.1) — the two states never mix in one
  // subfolder. So: an active agent's kinds ENTIRELY stand in for the
  // baseline profile's kinds here, not a union with them. (Capture already
  // makes this same either/or choice per document — see capturingProfileFor
  // server-side; this is the client-side mirror of that same branch.)
  const kinds = useMemo(() => {
    if (activeAgentKinds.length > 0) return activeAgentKinds;
    return profile?.kinds ?? [];
  }, [profile, activeAgentKinds]);

  const activeNodes = useMemo(() => nodes.filter((n) => n.status === 'active'), [nodes]);

  // `kinds` is the AUTHORITATIVE taxonomy for whichever capture path governs
  // this subfolder right now (no agent → baseline `notes`; agent attached →
  // its kinds) — correct for "what can new documents become," wrong for
  // "what should Library display." A detached agent's entries are never archived (spec
  // §6: detach freezes past content, resumes future notes) — they're still
  // `status: 'active'` rows sitting in the DB with a type like `bet`/`risk`
  // that `kinds` no longer names. Grouping strictly by `kinds` (as `grouped`
  // below used to) silently drops every one of them from Library — found via
  // a real detach: the folder still held its structured entries, the API
  // still returned them, and Library rendered zero categories. `displayKinds`
  // widens the render-only taxonomy with a synthetic fallback entry for any
  // active node type `kinds` doesn't cover, so a node is never hidden just
  // because the folder's current template moved on — it only stops being
  // capturable under that type, which is the actually-correct behavior (spec
  // §1: "with an agent, the note pass doesn't run"; with none, only `notes`
  // does — neither claim is about what's already on the page).
  const displayKinds = useMemo(() => {
    const known = new Set(kinds.map((k) => k.key));
    const orphanTypes = new Set(
      activeNodes.map((n) => n.type).filter((t): t is string => !!t && !known.has(t)),
    );
    if (orphanTypes.size === 0) return kinds;
    const fallback: NodeKindDef[] = [...orphanTypes].map((type) => ({
      key: type,
      label: type.replace(/_/g, ' '),
      label_plural: type.replace(/_/g, ' '),
      description: '',
      color: 6,
    }));
    return [...kinds, ...fallback];
  }, [kinds, activeNodes]);

  const docById = useMemo(() => {
    const m = new Map<string, DocRecord>();
    for (const d of documents) m.set(d.id, d);
    return m;
  }, [documents]);

  // Related-node discovery for a node's "Connections" section:
  //  (b) nodes sharing the same attrs.product value
  //  (c) nodes referenced via attrs.impacts (this→other or other→this)
  function relatedFor(node: GNode): GNode[] {
    const out = new Map<string, GNode>();
    const myProduct = attrStr(node, 'product');
    const myTitle = nodeSummary(node).toLowerCase();
    const myImpacts = (attrStr(node, 'impacts') ?? '').toLowerCase();
    for (const other of activeNodes) {
      if (other.id === node.id) continue;
      // (b) same product
      if (myProduct && attrStr(other, 'product') === myProduct) {
        out.set(other.id, other);
        continue;
      }
      // (c) impacts linkage, either direction
      const otherTitle = nodeSummary(other).toLowerCase();
      const otherImpacts = (attrStr(other, 'impacts') ?? '').toLowerCase();
      const iMentionThem = myImpacts.length > 0 && otherTitle.length > 0 && myImpacts.includes(otherTitle);
      const theyMentionMe =
        otherImpacts.length > 0 && myTitle.length > 0 && otherImpacts.includes(myTitle);
      if (iMentionThem || theyMentionMe) out.set(other.id, other);
    }
    return [...out.values()];
  }

  const registerCardRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el);
    else cardRefs.current.delete(id);
  }, []);

  function scrollAndFlash(el: HTMLElement) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('gn-flash');
    setTimeout(() => el.classList.remove('gn-flash'), 1200);
  }

  function focusNode(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    // Same for the flattened List view's per-node state, and make sure the
    // node's category group isn't collapsed. Close any full-screen overlay so
    // the scrolled-to card is visible.
    setListState((prev) => {
      const next = new Map(prev);
      next.set(id, 'expanded');
      return next;
    });
    setFullscreenId(null);
    // Defer until the expansion has rendered.
    requestAnimationFrame(() => {
      const el = cardRefs.current.get(id);
      if (el) scrollAndFlash(el);
    });
  }

  // Bucket active nodes by kind → sub-bucket, driven by the profile.
  const grouped = useMemo(() => {
    const result: Array<{
      kind: NodeKindDef;
      total: number;
      subs: Array<{ key: string; label: string; nodes: GNode[] }>;
    }> = [];
    for (const kind of displayKinds) {
      // `showSuperseded` widens this from "active only" to "active + archived"
      // — off by default, matching the MCP surface's include_superseded:false
      // default (the current statement on each topic, not its history).
      const kindNodes = nodes.filter(
        (n) => n.type === kind.key && (n.status === 'active' || (showSuperseded && n.status === 'archived')),
      );
      if (kindNodes.length === 0) continue;
      const labels = bucketLabels(kind);
      const buckets = new Map<string, GNode[]>();
      for (const n of kindNodes) {
        const k = bucketKey(n);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(n);
      }
      const subs = [...buckets.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, ns]) => ({
          key,
          label: labels.get(key) ?? (key === '_' ? kind.label_plural : key.replace(/_/g, ' ')),
          nodes: ns.sort((a, b) => compareNodes(a, b, nodeSort)),
        }));
      result.push({ kind, total: kindNodes.length, subs });
    }
    return result;
  }, [nodes, displayKinds, showSuperseded, nodeSort]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q && !docFilter) return grouped;
    return grouped
      .map((t) => ({
        ...t,
        subs: t.subs
          .map((s) => ({
            ...s,
            nodes: s.nodes.filter(
              (n) =>
                (!docFilter || n.document_id === docFilter.documentId) &&
                (!q ||
                  nodeSummary(n).toLowerCase().includes(q) ||
                  n.id.toLowerCase().includes(q) ||
                  (nodeBody(n)?.toLowerCase().includes(q) ?? false)),
            ),
          }))
          .filter((s) => s.nodes.length > 0),
      }))
      .filter((t) => t.subs.length > 0);
  }, [grouped, filter, docFilter]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Flatten the filtered kind→sub-bucket tree into one full-width list of
  // category groups, each its own collapsible section with a scoped Share menu.
  const flatGroups = useMemo(() => {
    const out: Array<{
      groupKey: string;
      kind: NodeKindDef;
      label: string;
      nodes: GNode[];
    }> = [];
    for (const t of filtered) {
      for (const s of t.subs) {
        out.push({
          groupKey: `${t.kind.key}::${s.key}`,
          kind: t.kind,
          label: s.label,
          nodes: s.nodes,
        });
      }
    }
    return out;
  }, [filtered]);

  const displayOf = useCallback(
    (id: string): NodeDisplay => listState.get(id) ?? 'preview',
    [listState],
  );
  const setDisplay = useCallback((id: string, state: NodeDisplay) => {
    setListState((prev) => {
      const next = new Map(prev);
      next.set(id, state);
      return next;
    });
  }, []);
  // The row chevron collapses an open node down to its title, or re-opens a
  // collapsed one back to the 5-line preview.
  const toggleCollapse = useCallback((id: string) => {
    setListState((prev) => {
      const next = new Map(prev);
      next.set(id, (prev.get(id) ?? 'preview') === 'collapsed' ? 'preview' : 'collapsed');
      return next;
    });
  }, []);

  const toggleCategory = useCallback((groupKey: string) => {
    setCatCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  // Expand / collapse every visible node in one action. Expand-all also opens
  // any collapsed category groups so nothing stays hidden.
  const setAllNodes = useCallback(
    (state: NodeDisplay) => {
      setListState(() => {
        const next = new Map<string, NodeDisplay>();
        for (const g of flatGroups) for (const n of g.nodes) next.set(n.id, state);
        return next;
      });
      if (state === 'expanded') setCatCollapsed(new Set());
    },
    [flatGroups],
  );

  // Loading / error / empty are handled inside the content area below (not as
  // early returns) so the tab bar — and the Wiki tab in particular — stays
  // reachable even when the graph itself is still loading or empty.
  // `shownTotal` is the denominator of the filter's "N of M match" — the only
  // count the header still prints. The per-category counts live on each section.
  const shownTotal = grouped.reduce((a, t) => a + t.total, 0);
  const fullscreenNode = fullscreenId ? (nodes.find((n) => n.id === fullscreenId) ?? null) : null;
  const fullscreenKind = fullscreenNode
    ? (displayKinds.find((k) => k.key === fullscreenNode.type) ?? null)
    : null;
  const archivedTotal = archivedById.size;
  const visibleTotal = filtered.reduce(
    (a, t) => a + t.subs.reduce((b, s) => b + s.nodes.length, 0),
    0,
  );

  async function renameFolder() {
    const name = renameValue.trim();
    if (!activeFolder || !name || name === activeFolder.name || folderBusy) return;
    setFolderBusy(true);
    try {
      await api.renameSubgraph(wsId, activeFolder.id, name);
      toast.success('Folder renamed', { description: name });
      setRenameOpen(false);
      onFolderUpdated?.();
    } catch (e: any) {
      toast.error('Could not rename folder', { description: e?.message });
    } finally {
      setFolderBusy(false);
    }
  }

  async function archiveFolder() {
    if (!activeFolder || activeFolder.id === 'default' || folderBusy) return;
    setFolderBusy(true);
    try {
      await api.archiveSubgraph(wsId, activeFolder.id);
      setArchiveOpen(false);
      toast.success('Folder archived', { description: activeFolder.name });
      onFolderRemoved?.();
    } catch (e: any) {
      toast.error('Could not archive folder', { description: e?.message });
    } finally {
      setFolderBusy(false);
    }
  }

  async function deleteFolder() {
    if (!activeFolder || folderBusy) return;
    setFolderBusy(true);
    try {
      await api.deleteSubgraph(wsId, activeFolder.id);
      setDeleteFolderOpen(false);
      toast.success('Folder deleted', { description: activeFolder.name });
      onFolderRemoved?.();
    } catch (e: any) {
      toast.error('Could not delete folder', { description: e?.message });
    } finally {
      setFolderBusy(false);
    }
  }

  return (
    <div className="graph-view space-y-5">
      {/* Folder header — two rows, split by what the controls act on.
          Row 1 is the folder itself: its name, the actions that change the
          folder, and the one action that puts material into it. Row 2 only
          changes how the list below is displayed. Add source is the page's
          primary action and the reason the folder exists, so it is the one
          filled button here and it does not sit in the row of list controls. */}
      <div className="graph-head space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="graph-title font-serif text-2xl italic">{activeFolder?.name ?? 'Folder'}</h2>
          {activeFolder && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={folderBusy}
                  className="inline-flex size-7 shrink-0 translate-y-0.5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  title="Folder actions"
                  aria-label="Folder actions"
                >
                  {folderBusy ? <Loader2 className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuItem
                  onSelect={() => {
                    setRenameValue(activeFolder.name);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="mr-2 size-3.5" />
                  Rename folder
                </DropdownMenuItem>
                {/* Archive is still meaningless for the default folder, but delete
                    is not: its data migrates to another active folder first, and
                    the server refuses when there is no other folder to move to. */}
                {activeFolder.id !== 'default' && (
                  <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                    <Archive className="mr-2 size-3.5" />
                    Archive folder
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setDeleteFolderOpen(true)}
                >
                  <Trash2 className="mr-2 size-3.5" />
                  Delete permanently
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* The only count worth a line: feedback that the filter did something.
              The idle "N nodes · M categories" summary is gone — the categories
              below already carry their own counts, so it restated the page. */}
          {!loading && !error && nodes.length > 0 && (filter || docFilter) && (
            <span className="muted text-sm text-muted-foreground">
              {visibleTotal} of {shownTotal} match
            </span>
          )}
          <Button size="sm" className="ml-auto gap-1.5" onClick={() => setAddSourceOpen(true)}>
            <Plus className="size-3.5" />
            Add source
          </Button>
        </div>

        <div className="graph-toolbar flex flex-wrap items-center gap-2">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              className="graph-filter h-9 pl-8"
              placeholder="Filter the folders…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter graph"
            />
          </div>
          {!loading && !error && nodes.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="graph-sort-menu gap-1.5 font-mono text-xs">
                    {SORT_ICON[nodeSort]}
                    {SORT_LABEL[nodeSort]}
                    <ChevronDown className="size-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel>Order</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={nodeSort}
                    onValueChange={(v) => setNodeSort(v as 'alpha' | 'newest' | 'oldest')}
                  >
                    <DropdownMenuRadioItem value="newest">Newest first</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="alpha">A–Z</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="graph-view-menu relative gap-1.5 font-mono text-xs">
                    <SlidersHorizontal className="size-3.5" />
                    View
                    {/* A dot, not a count: the menu holds state that is otherwise
                        invisible once it's closed, so a non-default view never
                        looks like a default one. */}
                    {(showSuperseded || !showNodeMeta) && (
                      <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-pome-red" aria-hidden />
                    )}
                    <ChevronDown className="size-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {/* The two checkboxes keep the menu open (Radix closes it on
                      select by default): they are settings, and setting both
                      shouldn't cost two trips. The commands below still close. */}
                  <DropdownMenuLabel>Show</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={showNodeMeta}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(v) => setShowNodeMeta(!!v)}
                  >
                    Source &amp; date added
                  </DropdownMenuCheckboxItem>
                  {/* "Superseded" is the engine's word, not the reader's. What a
                      person sees is an older statement that a newer one replaced,
                      still on record — so the UI says "replaced". The API, the MCP
                      `include_superseded` flag and the DB status are untouched. */}
                  {archivedTotal > 0 && (
                    <DropdownMenuCheckboxItem
                      checked={showSuperseded}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(v) => setShowSuperseded(!!v)}
                    >
                      Replaced versions
                    </DropdownMenuCheckboxItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setAllNodes('expanded')}>
                    <ChevronsUpDown className="mr-2 size-3.5" />
                    Expand all
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAllNodes('collapsed')}>
                    <ChevronsDownUp className="mr-2 size-3.5" />
                    Collapse all
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      {/* Folder archive/delete confirmations — controlled, opened from the ⋯ menu.
          Archive is non-default only; delete covers the default folder too, with
          the copy Codex's migration path introduced. */}
      {activeFolder && (
        <>
          {activeFolder.id !== 'default' && (
            <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive “{activeFolder.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The folder will leave the Folders list, but its nodes will be retained.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={archiveFolder}>Archive folder</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <AlertDialog open={deleteFolderOpen} onOpenChange={setDeleteFolderOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{activeFolder.name}” permanently?</AlertDialogTitle>
                <AlertDialogDescription>
                  {activeFolder.id === 'default'
                    ? 'Its folder data will be moved into another active folder before the default folder is removed.'
                    : 'This removes the folder and its nodes, candidates, edges, and wiki pages.'}{' '}
                  Shared documents remain available to other folders. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={deleteFolder}
                >
                  Delete permanently
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
            <DialogDescription>Choose the name shown in the sidebar and at the top of this view.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-label="Folder name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void renameFolder();
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button onClick={() => void renameFolder()} disabled={folderBusy || !renameValue.trim()}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2.5">
        <DataAgentsPanel
          wsId={wsId}
          subgraphId={subgraphId}
          hasReport={!!reportMeta}
          reportStatus={reportMeta === undefined ? 'Loading…' : reportMeta ? `Updated ${timeAgo(reportMeta.generated_at)}` : 'No report yet'}
          onOpenReport={() => setReportOpen(true)}
          onChanged={() => setDocRefresh((n) => n + 1)}
        />
      </div>

      {docFilter && (
        <div className="flex w-fit items-center gap-2 rounded-md border border-pome-red/30 bg-pome-red/5 px-3 py-1.5 text-xs text-muted-foreground">
          Showing only nodes from {docFilter.title ? <strong className="font-medium text-foreground">{docFilter.title}</strong> : 'this document'}
          <button
            type="button"
            onClick={() => setDocFilter(null)}
            className="inline-flex items-center gap-0.5 text-pome-red hover:underline"
          >
            <X className="size-3" />
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <div className="graph-grid grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ))}
        </div>
      ) : error ? (
        <Card className="border-destructive/40 p-6">
          <p className="text-destructive">
            <strong>Failed to load graph.</strong> {error}
          </p>
        </Card>
      ) : nodes.length === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="font-serif text-2xl italic">The folders are empty.</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Approve candidates in Curate or add sources under Sources to start building the graph.
          </p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">No nodes match the filter.</p>
        </Card>
      ) : (
        <div className="graph-list flex flex-col gap-3">
          {flatGroups.map((g) => {
            const spine = kindColorVar(g.kind.color);
            const collapsed = catCollapsed.has(g.groupKey);
            return (
              <section
                key={g.groupKey}
                className={`graph-cat graph-cat-${g.kind.key} overflow-hidden rounded-xl border bg-card shadow-soft`}
                style={{ borderLeft: `3px solid ${spine}` }}
              >
                <header className="graph-cat-head flex items-center gap-2 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => toggleCategory(g.groupKey)}
                    aria-expanded={!collapsed}
                  >
                    <span className="shrink-0 text-muted-foreground" aria-hidden>
                      {collapsed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </span>
                    <span
                      className="graph-cat-dot size-2.5 shrink-0 rounded-full"
                      style={{ background: spine }}
                      aria-hidden
                    />
                    <h3 className="truncate text-sm font-semibold">
                      {g.label.trim().toLowerCase() === g.kind.label_plural.trim().toLowerCase() ? (
                        g.kind.label_plural
                      ) : (
                        <>
                          <span className="text-muted-foreground">{g.kind.label_plural}</span>
                          <span className="mx-1.5 text-muted-foreground/60">·</span>
                          {g.label}
                        </>
                      )}
                    </h3>
                    <span className="ml-1 shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
                      {g.nodes.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <GroupAudienceMenu
                      label={g.label}
                      count={g.nodes.length}
                      onSet={(target) => setGroupAudience(g.nodes, target)}
                    />
                  )}
                </header>
                {!collapsed && (
                  <div className="graph-cat-list flex flex-col gap-2 px-4 pb-4">
                    {g.nodes.map((n) => {
                      const state = displayOf(n.id);
                      const isOpen = state === 'expanded';
                      return (
                        <ListNodeRow
                          key={n.id}
                          n={n}
                          state={state}
                          wsId={wsId}
                          doc={n.document_id ? (docById.get(n.document_id) ?? null) : null}
                          related={isOpen ? relatedFor(n) : []}
                          editable={audienceMap[n.id]?.editable !== false}
                          suppressEditor={fullscreenId === n.id}
                          onToggleCollapse={() => toggleCollapse(n.id)}
                          onSetDisplay={(s) => setDisplay(n.id, s)}
                          onOpenFullscreen={() => setFullscreenId(n.id)}
                          onSaveBody={saveNodeBody}
                          onFocusNode={focusNode}
                          registerRef={registerCardRef}
                          showMeta={showNodeMeta}
                          audience={audienceMap[n.id]}
                          onSetAudience={setNodeAudience}
                          onDelete={requestDelete}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Sources — present ONLY alongside an attached data agent (§4.1): the
          agent's kind sections above replace the baseline Notes section, and
          this is where the folder's documents themselves still show — a
          document that yielded several entries and one that yielded none
          look identical here, on purpose. Rendered as SourceChipList's
          narrow vertical chips (Sources.tsx) — the pre-Map-view-removal
          "Documents" column style — not the full-width DocumentRow, which
          reads as a crowded single line of badges at Library's width. */}
      {!loading && !error && activeAgentKinds.length > 0 && documents.length > 0 && (
        <section className="overflow-hidden rounded-xl border bg-card shadow-soft">
          <header className="flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => setSourcesCollapsed((v) => !v)}
              aria-expanded={!sourcesCollapsed}
            >
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                {sourcesCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </span>
              <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />
              <h3 className="truncate text-sm font-semibold text-muted-foreground">Sources</h3>
              <span className="ml-1 shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
                {documents.length}
              </span>
            </button>
          </header>
          {!sourcesCollapsed && (
            <div className="px-4 pb-3">
              <SourceChipList documents={documents} />
            </div>
          )}
        </section>
      )}

      {reportOpen && (
        <ReportPanel
          wsId={wsId}
          subgraphId={subgraphId}
          subgraphName={subgraphName}
          documents={documents}
          onClose={() => {
            setReportOpen(false);
            // Refresh the header's freshness note in case a report was
            // generated while the panel was open.
            api
              .getReport(wsId, subgraphId)
              .then((r) => setReportMeta(r.report ? { generated_at: r.report.generated_at } : null))
              .catch(() => {});
          }}
        />
      )}

      <Dialog open={addSourceOpen} onOpenChange={setAddSourceOpen}>
        <DialogContent className="max-h-[92vh] w-[95vw] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl italic">Add to folders</DialogTitle>
            <DialogDescription>
              Destination is preset to this folder — pick a different one, or switch to
              Automated to let the router decide.
            </DialogDescription>
          </DialogHeader>
          <AddSourceWidget
            wsId={wsId}
            subgraphs={subgraphs}
            defaultSubgraphId={subgraphId}
            onIngested={() => {
              setDocRefresh((n) => n + 1);
              setAddSourceOpen(false);
            }}
            onViewDocument={(_sg, documentId, title) =>
              setDocFilter(documentId ? { documentId, title } : null)
            }
            bare
          />
        </DialogContent>
      </Dialog>

      <Dialog open={fullscreenNode !== null} onOpenChange={(o) => !o && setFullscreenId(null)}>
        {fullscreenNode && (
          <DialogContent className="flex max-h-[92vh] w-[95vw] max-w-[72rem] flex-col overflow-hidden p-0">
            <DialogHeader className="border-b px-6 py-4">
              <DialogTitle className="font-serif text-2xl italic">
                {nodeSummary(fullscreenNode)}
              </DialogTitle>
              <DialogDescription>
                {fullscreenKind?.label_plural ?? fullscreenNode.type}
                <span className="mx-1.5">·</span>
                <code className="font-mono">{fullscreenNode.id}</code>
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <NodeDetail
                n={fullscreenNode}
                wsId={wsId}
                doc={
                  fullscreenNode.document_id
                    ? (docById.get(fullscreenNode.document_id) ?? null)
                    : null
                }
                related={relatedFor(fullscreenNode)}
                onFocusNode={focusNode}
                bodySlot={
                  <NodeBodyEditor
                    n={fullscreenNode}
                    editable={audienceMap[fullscreenNode.id]?.editable !== false}
                    onSaveBody={saveNodeBody}
                  />
                }
              />
            </div>
          </DialogContent>
        )}
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o && !deleteBusy) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this node?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? (
                <>
                  “<span className="font-medium text-foreground">{nodeSummary(pendingDelete)}</span>”
                  will be removed from the folders.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-pome-red"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
            />
            Don’t show this confirmation again
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleteBusy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


// One node, in either view. Collapsed it is exactly one fixed-height row —
// chevron, truncated summary, supersession marker, evidence pill — and the
// chevron + ellipsis make the collapsed state visible. Expanding reveals the
// full detail in place.
/** Per-node privacy pill — the shared AudienceSelect, or a read-only chip when
 * the node isn't the viewer's to manage. */
function NodePrivacy({
  node,
  audience,
  onSet,
}: {
  node: GNode;
  audience: { audience: Audience; editable: boolean };
  onSet: (node: GNode, target: Audience) => void;
}) {
  const cur = audience.audience;
  if (!audience.editable) {
    return (
      <span
        className="gn-priv ml-auto shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground"
        title="Set by its owner"
      >
        {AUDIENCE_SHORT[cur]}
      </span>
    );
  }
  return (
    <span className="ml-auto shrink-0" onClick={(e) => e.stopPropagation()}>
      <AudienceSelect value={cur} onChange={(target) => onSet(node, target)} align="right" />
    </span>
  );
}

/**
 * Per-category audience toggle in a Library column header. Sets EVERY active
 * node of this kind to one audience in one action, via the kind fan-out.
 */
function KindAudienceMenu({
  kind,
  label,
  count,
  onSet,
}: {
  kind: string;
  label: string;
  count: number;
  onSet: (kind: string, target: Audience) => void;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <span className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="gn-kind-priv rounded-full border px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground transition-colors hover:border-pome-red/40 hover:text-pome-red"
        onClick={() => setOpen((o) => !o)}
        title={`Set the audience for all ${count} ${label.toLowerCase()}`}
        aria-label={`Set audience for all ${label}`}
      >
        Share ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-xl">
            <div className="px-2 py-1 text-[0.6rem] uppercase tracking-wide text-muted-foreground">
              All {label.toLowerCase()}
            </div>
            {AUDIENCE_TIERS.map((tier) => (
              <button
                key={tier.key}
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  onSet(kind, tier.key);
                }}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The Share control on a subcategory header (List view). Same affordance as
 * KindAudienceMenu, but scoped to one category group's own nodes via a plain
 * `onSet(target)`.
 */
function GroupAudienceMenu({
  label,
  count,
  onSet,
}: {
  label: string;
  count: number;
  onSet: (target: Audience) => void;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <span className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="gn-group-priv rounded-full border px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground transition-colors hover:border-pome-red/40 hover:text-pome-red"
        onClick={() => setOpen((o) => !o)}
        title={`Set the audience for all ${count} ${label.toLowerCase()} ${count === 1 ? 'node' : 'nodes'}`}
        aria-label={`Set audience for ${label}`}
      >
        Share ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-xl">
            <div className="truncate px-2 py-1 text-[0.6rem] uppercase tracking-wide text-muted-foreground">
              All {label.toLowerCase()}
            </div>
            {AUDIENCE_TIERS.map((tier) => (
              <button
                key={tier.key}
                type="button"
                className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  onSet(tier.key);
                }}
              >
                {tier.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * The node body as an always-editable wiki surface — the SAME WikiEditor the
 * wiki pages use. Seeds from the node's `body`; each debounced save round-trips
 * the whole body back through `onSaveBody`. `editable=false` renders read-only
 * (still preserving formatting + line returns).
 */
function NodeBodyEditor({
  n,
  editable,
  onSaveBody,
}: {
  n: GNode;
  editable: boolean;
  onSaveBody: (n: GNode, html: string) => Promise<void>;
}) {
  const seed: WikiBlockRecord[] = [
    {
      id: `nb_${n.id}`,
      type: 'paragraph',
      content: { text: n.body ?? '' },
      cited_node_ids: [],
      provenance: 'user',
      review_state: 'accepted',
    },
  ];
  const save = async (blocks: WikiBodyBlock[]): Promise<WikiBlockRecord[]> => {
    const html = blocks.map((b) => b.content.text).join('');
    await onSaveBody(n, html);
    return blocks.map((b, i) => ({
      id: b.id ?? `nb_${n.id}_${i}`,
      type: b.type,
      content: b.content,
      cited_node_ids: [],
      provenance: 'user',
      review_state: 'accepted',
    }));
  };
  return (
    <div className="gn-editor mt-1.5">
      <WikiEditor key={n.id} blocks={seed} onSave={save} editable={editable} />
    </div>
  );
}

/**
 * A node row in the flattened, full-width List view. Three display states:
 *   collapsed — title row only
 *   preview   — title + first 5 lines of the body (the default)
 *   expanded  — title + full editable body + fields / connections
 * Plus a "full screen" affordance that opens the node in a large dialog.
 */
function ListNodeRow({
  n,
  state,
  wsId,
  doc,
  related,
  editable,
  suppressEditor,
  onToggleCollapse,
  onSetDisplay,
  onOpenFullscreen,
  onSaveBody,
  onFocusNode,
  registerRef,
  showMeta,
  audience,
  onSetAudience,
  onDelete,
}: {
  n: GNode;
  state: NodeDisplay;
  wsId: string;
  doc: DocRecord | null;
  related: GNode[];
  editable: boolean;
  suppressEditor: boolean;
  onToggleCollapse: () => void;
  onSetDisplay: (state: NodeDisplay) => void;
  onOpenFullscreen: () => void;
  onSaveBody: (n: GNode, html: string) => Promise<void>;
  onFocusNode: (id: string) => void;
  registerRef: (id: string, el: HTMLElement | null) => void;
  /** Render the source/date line under the title (View › Source & date added). */
  showMeta: boolean;
  audience?: NodeAudienceInfo;
  onSetAudience?: (node: GNode, target: Audience) => void;
  onDelete?: (node: GNode) => void;
}) {
  const collapsed = state === 'collapsed';
  const expanded = state === 'expanded';
  const hasBody = !!nodeBody(n);
  return (
    <article
      ref={(el) => registerRef(n.id, el)}
      className={`gn-card group rounded-lg border px-3 py-2 transition-colors ${
        expanded ? 'open border-pome-red/40 bg-muted/30' : 'bg-card hover:border-pome-red/40'
      }`}
      aria-expanded={expanded}
    >
      <div className="gn-card-row flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className="gn-chevron shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggleCollapse}
          title={collapsed ? 'Show preview' : 'Collapse to title'}
          aria-label={collapsed ? 'Show preview' : 'Collapse to title'}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
        <span
          className={`gn-summary min-w-0 cursor-pointer text-sm font-medium ${collapsed ? 'truncate' : ''}`}
          onClick={() => onSetDisplay(expanded ? 'preview' : 'expanded')}
          title={expanded ? 'Collapse content' : 'Show full content'}
        >
          {nodeSummary(n)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {n.status === 'archived' && (
            <button
              type="button"
              className="gn-superseded inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground transition-colors enabled:hover:border-pome-red/40 enabled:hover:text-pome-red disabled:cursor-default"
              title={
                n.superseded
                  ? 'Replaced by a newer version — click to jump to it. This one stays on record.'
                  : 'Replaced by a newer version. This one stays on record.'
              }
              disabled={!n.superseded}
              onClick={(e) => {
                e.stopPropagation();
                if (n.superseded) onFocusNode(n.superseded);
              }}
            >
              <History className="size-2.5" />
              Replaced
            </button>
          )}
          {n.evidence && n.evidence.sources >= 2 && (
            <span
              className="gn-evidence inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[0.65rem] text-flag-green"
              style={{
                background: 'var(--flag-green-soft)',
                borderColor: 'color-mix(in oklab, var(--flag-green) 25%, transparent)',
              }}
              title={`Corroborated by ${n.evidence.sources} sources`}
            >
              ◈ {n.evidence.sources}
            </span>
          )}
          {audience && onSetAudience && (
            <NodePrivacy node={n} audience={audience} onSet={onSetAudience} />
          )}
          <button
            type="button"
            className="gn-fullscreen rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-pome-red hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
            title="Open full screen"
            aria-label={`Open ${nodeSummary(n)} full screen`}
            onClick={onOpenFullscreen}
          >
            <Maximize2 className="size-3.5" />
          </button>
          {onDelete && (
            <button
              type="button"
              className="gn-delete rounded p-0.5 text-muted-foreground opacity-60 transition-opacity hover:text-pome-red hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
              title="Delete this node"
              aria-label={`Delete ${nodeSummary(n)}`}
              onClick={() => onDelete(n)}
            >
              <X className="size-3.5" />
            </button>
          )}
        </span>
      </div>

      {/* Where it came from and when it landed. Suppressed while expanded, where
          NodeDetail's gn-meta already carries the same facts with the node id
          and a full timestamp. */}
      {showMeta && !expanded && <NodeProvenance n={n} doc={doc} />}

      {/* preview — the first 5 lines, read-only */}
      {state === 'preview' && (
        <div className="gn-preview mt-1.5 pl-5">
          {hasBody && <NodeBodyRead body={nodeBody(n)} clamp />}
          <button
            type="button"
            className="mt-1 font-mono text-[0.65rem] uppercase tracking-wide text-muted-foreground transition-colors hover:text-pome-red"
            onClick={() => onSetDisplay('expanded')}
          >
            {hasBody ? 'Show more ▾' : editable ? 'Add content ▾' : 'Show detail ▾'}
          </button>
        </div>
      )}

      {/* expanded — full editable body + fields + connections */}
      {expanded && (
        <>
          <NodeDetail
            n={n}
            wsId={wsId}
            doc={doc}
            related={related}
            onFocusNode={onFocusNode}
            bodySlot={
              suppressEditor ? (
                <NodeBodyRead className="gn-body mt-1.5" body={nodeBody(n)} />
              ) : (
                <NodeBodyEditor n={n} editable={editable} onSaveBody={onSaveBody} />
              )
            }
          />
          <button
            type="button"
            className="ml-5 mt-2 font-mono text-[0.65rem] uppercase tracking-wide text-muted-foreground transition-colors hover:text-pome-red"
            onClick={() => onSetDisplay('preview')}
          >
            Show less ▴
          </button>
        </>
      )}
    </article>
  );
}

function NodeDetail({
  n,
  wsId,
  doc,
  related,
  onFocusNode,
  bodySlot,
}: {
  n: GNode;
  wsId: string;
  doc: DocRecord | null;
  related: GNode[];
  onFocusNode: (id: string) => void;
  // When provided, replaces the default read-only body render (used to slot in
  // the editable WikiEditor). `undefined` → default read-only body.
  bodySlot?: ReactNode;
}) {
  return (
    <div className="gn-detail mt-2 pl-5" onClick={(e) => e.stopPropagation()}>
      {n.period && (
        <div className="gn-fields text-xs">
          <span className="text-muted-foreground">period · </span>
          {n.period}
        </div>
      )}
      {n.metric && (
        <div className="gn-fields text-xs">
          <span className="text-muted-foreground">metric · </span>
          {n.metric.name}
          {n.metric.target ? ` → ${n.metric.target}` : ''}
          {n.metric.current ? ` (now ${n.metric.current})` : ''}
        </div>
      )}
      {n.decided_on && (
        <div className="gn-fields text-xs">
          <span className="text-muted-foreground">decided · </span>
          {n.decided_on}
          {n.decided_by ? ` by ${n.decided_by}` : ''}
        </div>
      )}
      {bodySlot !== undefined ? bodySlot : <NodeBodyRead className="gn-body mt-1.5" body={nodeBody(n)} />}
      <div className="gn-meta mt-2 text-xs text-muted-foreground">
        <code className="gn-id font-mono">{n.id}</code>
        <span> · created {new Date(n.created_at).toLocaleDateString()}</span>
        {n.source && <span> · source: {n.source}</span>}
      </div>

      <NodeMedia wsId={wsId} nodeId={n.id} />
      <NodeConnections
        n={n}
        wsId={wsId}
        doc={doc}
        related={related}
        onFocusNode={onFocusNode}
      />
    </div>
  );
}

function NodeConnections({
  n,
  wsId,
  doc,
  related,
  onFocusNode,
}: {
  n: GNode;
  wsId: string;
  doc: DocRecord | null;
  related: GNode[];
  onFocusNode: (id: string) => void;
}) {
  const [evidence, setEvidence] = useState<NodeEvidence[] | null>(null);
  const [evLoading, setEvLoading] = useState(false);
  const [evError, setEvError] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);

  // Fetch corroborating evidence when the node is expanded. Only worth a call
  // when the node carries multi-source evidence; single-source nodes have only
  // their origin (rendered separately) so we skip the round-trip.
  const hasEvidence = (n.evidence?.sources ?? 0) >= 2;
  useEffect(() => {
    if (!hasEvidence) {
      setEvidence([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setEvLoading(true);
        setEvError(null);
        const r = await api.getNodeEvidence(wsId, n.id);
        if (!cancelled) setEvidence(r.evidence);
      } catch (e: any) {
        if (!cancelled) setEvError(e?.message ?? 'Failed to load evidence');
      } finally {
        if (!cancelled) setEvLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, n.id, hasEvidence]);

  const hasOrigin = !!doc;
  const hasRelated = related.length > 0;
  if (!hasOrigin && !hasEvidence && !hasRelated) return null;

  return (
    <div className="gn-connections mt-3 border-t pt-3">
      <div className="gn-connections-label eyebrow mb-2">Connections</div>

      {hasOrigin && doc && (
        <div className="gn-origin mb-3">
          <div className="mb-1 text-xs text-muted-foreground">Origin</div>
          <button
            type="button"
            className="gn-doc-chip inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs transition-colors hover:border-pome-red/40"
            onClick={() => setDocOpen(true)}
            title="View document summary"
          >
            <code className="font-mono">{doc.source_ref}</code>
            <span className="text-muted-foreground">v{doc.version}</span>
          </button>
          <Dialog open={docOpen} onOpenChange={setDocOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="font-mono text-base">{doc.source_ref}</DialogTitle>
                <DialogDescription>
                  Version {doc.version} · {doc.source_kind}
                </DialogDescription>
              </DialogHeader>
              {doc.summary && <p className="text-sm text-muted-foreground">{doc.summary}</p>}
              {doc.stakeholders.length > 0 && (
                <div className="mt-2">
                  <div className="eyebrow mb-1.5">Stakeholders</div>
                  <div className="flex flex-wrap gap-1">
                    {doc.stakeholders.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-[0.7rem] text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </DialogContent>
          </Dialog>
        </div>
      )}

      {hasEvidence && (
        <div className="gn-evidence-list mb-3">
          <div className="mb-1 text-xs text-muted-foreground">Corroborated by</div>
          {evLoading && (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {evError && <p className="text-xs text-destructive">{evError}</p>}
          {!evLoading &&
            !evError &&
            (evidence ?? []).map((e, i) => (
              <div key={`${e.document_id || e.source_ref}-${i}`} className="gn-evidence-row py-1.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="font-mono">{e.document?.source_ref ?? e.source_ref ?? '—'}</code>
                  <span>· {new Date(e.captured_at).toLocaleDateString()}</span>
                </div>
                {e.quote && (
                  <p className="quote mt-1 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
                    "{e.quote}"
                  </p>
                )}
              </div>
            ))}
          {!evLoading && !evError && (evidence ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">No corroboration recorded.</p>
          )}
        </div>
      )}

      {hasRelated && (
        <div className="gn-related">
          <div className="mb-1 text-xs text-muted-foreground">Related nodes</div>
          <div className="flex flex-wrap gap-1.5">
            {related.map((r) => (
              <button
                key={r.id}
                type="button"
                className="gn-related-chip inline-flex max-w-[14rem] items-center rounded-full border bg-card px-2 py-0.5 text-[0.7rem] transition-colors hover:border-pome-red/40"
                onClick={() => onFocusNode(r.id)}
                title={r.id}
              >
                <span className="truncate">{nodeSummary(r)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
