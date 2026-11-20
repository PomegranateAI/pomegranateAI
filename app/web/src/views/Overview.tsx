import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileText } from 'lucide-react';
import { api } from '../api.js';
import type {
  ContextProfile,
  ContextUsageEntry,
  DocumentRecord,
  MyContextUsageEntry,
  Subgraph,
  UsageAnalysis,
} from '../api.js';
import { BUILTIN_PROFILES, fetchWorkspaceProfile, kindColorVar } from '../profiles.js';
import { fmtWhen } from '../lib/format.js';
import { FlagChip } from '../components/FlagChip.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';

// Overview — the dashboard. Three zones, one per job:
//   1. Is it working?      — KPI strip, the owner's usage narrative, the
//                            context described (with what's new in it), and
//                            who's drawing on it. Aggregates and prose only —
//                            record lists live in their canonical views.
//   2. Needs you           — one ranked action queue: pending candidates,
//                            the lag report, the empty-library nudge. Each
//                            item is one line + one CTA into Curate/Sources.
//   3. Make it more useful — data-driven growth prompts: questions the
//                            context couldn't answer (count + scope, never
//                            the words), staleness, uncovered kinds, and
//                            connecting more of the team's tools.

export type NavTarget = 'sources' | 'library' | 'ask' | 'review' | 'setup';

type Candidate = {
  id: string;
  flag: 'red' | 'yellow' | 'green';
  proposed_node: any;
  source_quote: string;
  conflicts_with?: string;
  reason?: string;
};
type McpQuery = {
  created_at: string;
  scope: string;
  has_answer: boolean;
  cited: number;
  latency_ms: number | null;
};
type ReviewRow = {
  id: string;
  caller: string;
  kind: string;
  red: number;
  yellow: number;
  green: number;
  created_at: string;
};
type GNode = {
  id: string;
  type: string;
  status: 'active' | 'archived';
  created_at: string;
  title?: string;
  summary?: string;
  body?: string;
  document_id?: string | null;
};

function nodeSummary(n: GNode): string {
  return n.title ?? n.summary ?? n.body ?? n.id;
}

// Past this many days without an ingest the context is presumed lagging.
const STALE_AFTER_DAYS = 14;

export function Overview({
  wsId,
  onNavigate,
  subgraphs = [],
}: {
  wsId: string;
  onNavigate: (target: NavTarget) => void;
  subgraphs?: Subgraph[];
}) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ContextProfile | null>(null);
  // LLM synthesis of what the library actually contains. Fetched separately
  // from the main batch: a cache miss costs an LLM call, and the dashboard
  // shouldn't block on it. null → fall back to the static profile description.
  const [overview, setOverview] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [day1, setDay1] = useState<any | null>(null);
  const [nodes, setNodes] = useState<GNode[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [queries, setQueries] = useState<McpQuery[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [usage, setUsage] = useState<ContextUsageEntry[]>([]);
  const [myUsage, setMyUsage] = useState<MyContextUsageEntry[]>([]);
  // Owner-only LLM narratives of how this context is being used — one for
  // the team's use, one for the owner's own. null when the viewer isn't the
  // owner (403), the data is too thin, or synthesis failed.
  const [usageAnalysis, setUsageAnalysis] = useState<UsageAnalysis | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [p, cand, audits, graph, docs, mcp, revs, use, mine] = await Promise.all([
        fetchWorkspaceProfile(wsId),
        api.listCandidates(wsId, 'pending').catch(() => ({ candidates: [] })),
        api.listDay1Audits(wsId).catch(() => ({ reports: [] })),
        api.listGraph(wsId, { includeArchived: true }).catch(() => ({ nodes: [] })),
        api.listDocuments(wsId).catch(() => ({ documents: [] })),
        api.listMcpQueries(wsId).catch(() => ({ queries: [] })),
        api.listReviews(wsId).catch(() => ({ reviews: [] })),
        api.listContextUsage(wsId).catch(() => ({ usage: [] })),
        api.myContextUsage().catch(() => ({ usage: [] })),
      ]);
      let day1Detail: any | null = null;
      const first = audits.reports[0];
      if (first) {
        day1Detail = await api.getDay1Audit(wsId, first.id).catch(() => null);
      }
      if (cancelled) return;
      setProfile(p);
      setCandidates(cand.candidates as Candidate[]);
      setDay1(day1Detail);
      setNodes(graph.nodes as GNode[]);
      setDocuments(docs.documents as DocumentRecord[]);
      setQueries(mcp.queries as McpQuery[]);
      setReviews(revs.reviews as ReviewRow[]);
      setUsage(use.usage);
      setMyUsage(mine.usage);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  useEffect(() => {
    let cancelled = false;
    setUsageAnalysis(null);
    // Separate from the main batch: a cache miss costs an LLM call and the
    // dashboard shouldn't block on it; a 403 just means "not the owner".
    api
      .getUsageAnalysis(wsId)
      .then((r) => {
        if (!cancelled) setUsageAnalysis(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    setOverviewLoading(true);
    api
      .getLibraryOverview(wsId)
      .then((r) => {
        if (!cancelled) setOverview(r.summary);
      })
      .catch(() => {
        // server hasn't shipped /overview yet, or synthesis failed — the
        // card falls back to the static profile description.
      })
      .finally(() => {
        if (!cancelled) setOverviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wsId]);

  const flagTotals = useMemo(() => {
    const t = { red: 0, yellow: 0, green: 0 };
    for (const c of candidates) t[c.flag]++;
    return t;
  }, [candidates]);

  const activeNodes = useMemo(() => nodes.filter((n) => n.status === 'active'), [nodes]);
  const archivedCount = nodes.length - activeNodes.length;
  // Nodes are subgraph-local (this folder only); documents are shared
  // workspace-wide. Sum every folder's active-node count (from the subgraph
  // list, already computed server-side) for the workspace-level KPI, so it's
  // scoped the same way as the "sources" KPI next to it instead of silently
  // reporting just the currently-open folder. Falls back to this folder's
  // count if the subgraph list hasn't loaded yet.
  const totalActiveNodes = useMemo(
    () => (subgraphs.length > 0 ? subgraphs.reduce((sum, s) => sum + (s.node_count ?? 0), 0) : activeNodes.length),
    [subgraphs, activeNodes.length],
  );
  // How many of the workspace's shared documents actually landed a node in
  // THIS folder — the honest denominator for "built on N sources" below,
  // as opposed to the workspace-wide total shown in the KPI strip.
  const sourcesInThisFolder = useMemo(
    () => new Set(activeNodes.map((n) => n.document_id).filter((id): id is string => !!id)).size,
    [activeNodes],
  );

  // The profiles this context spans. With subgraphs it's every subgraph's
  // profile (the multi-profile partition); otherwise just the workspace's own.
  const profileNames = useMemo(() => {
    const byId = new Map(BUILTIN_PROFILES.map((p) => [p.id, p.name]));
    const names: string[] = [];
    const seen = new Set<string>();
    const push = (n?: string | null) => {
      if (n && !seen.has(n)) {
        seen.add(n);
        names.push(n);
      }
    };
    if (subgraphs.length > 0) {
      for (const s of subgraphs) push(byId.get(s.profile_id) ?? s.name);
    } else {
      push(profile?.name);
    }
    return names;
  }, [subgraphs, profile]);

  const byKind = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of activeNodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return (profile?.kinds ?? [])
      .map((k) => ({ kind: k, count: counts.get(k.key) ?? 0 }))
      .filter((e) => e.count > 0);
  }, [activeNodes, profile]);

  const uncoveredKinds = useMemo(() => {
    const present = new Set(activeNodes.map((n) => n.type));
    return (profile?.kinds ?? []).filter((k) => !present.has(k.key));
  }, [activeNodes, profile]);

  const lastIngest = useMemo(() => {
    let latest: string | null = null;
    for (const d of documents) {
      if (!latest || d.created_at > latest) latest = d.created_at;
    }
    return latest;
  }, [documents]);

  const answerRate = useMemo(() => {
    if (queries.length === 0) return null;
    return Math.round((queries.filter((q) => q.has_answer).length / queries.length) * 100);
  }, [queries]);
  const kindByKey = useMemo(
    () => new Map((profile?.kinds ?? []).map((k) => [k.key, k])),
    [profile],
  );

  const distinctPeople = useMemo(
    () => new Set(usage.map((u) => u.actor_email ?? u.actor_user_id)).size,
    [usage],
  );

  const kpiRequests = queries.length;
  const kpiAnswerRate = answerRate;
  const kpiPeople = distinctPeople;

  // What's new in the context: newest nodes and newest source documents,
  // merged into one short chronological list inside the context card.
  const fresh = useMemo(() => {
    const items: Array<{
      key: string;
      sort: string;
      label: string;
      tag: string;
      color: string | null; // node kind color; null → document row
    }> = [
      ...activeNodes.map((n) => {
        const kind = kindByKey.get(n.type);
        return {
          key: `n-${n.id}`,
          sort: n.created_at,
          label: nodeSummary(n),
          tag: kind?.label ?? n.type,
          color: kind ? kindColorVar(kind.color) : 'var(--border)',
        };
      }),
      ...documents.map((d) => ({
        key: `d-${d.id}`,
        sort: d.created_at,
        label: d.source_ref,
        tag: d.version >= 2 ? `source · v${d.version}` : 'source',
        color: null,
      })),
    ];
    return items.sort((a, b) => b.sort.localeCompare(a.sort)).slice(0, 4);
  }, [activeNodes, documents, kindByKey]);

  const unanswered = useMemo(() => queries.filter((q) => !q.has_answer), [queries]);
  const unansweredByScope = useMemo(() => {
    const counts = new Map<string, number>();
    for (const q of unanswered) counts.set(q.scope, (counts.get(q.scope) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [unanswered]);

  const staleDays = useMemo(() => {
    if (!lastIngest) return null;
    const ms = Date.now() - new Date(lastIngest).getTime();
    return Math.floor(ms / 86_400_000);
  }, [lastIngest]);

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // ── Zone 2: the action queue — one ranked list, one CTA per item ─────────
  const queue: Array<{ key: string; body: React.ReactNode; cta: string; go: () => void }> = [];
  if (candidates.length > 0) {
    queue.push({
      key: 'candidates',
      body: (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>
            <strong>
              {candidates.length} pending candidate{candidates.length === 1 ? '' : 's'}
            </strong>{' '}
            <span className="text-muted-foreground">waiting to be curated into the folders.</span>
          </span>
          {flagTotals.red > 0 && <FlagChip flag="red" count={flagTotals.red} />}
          {flagTotals.yellow > 0 && <FlagChip flag="yellow" count={flagTotals.yellow} />}
          {flagTotals.green > 0 && <FlagChip flag="green" count={flagTotals.green} />}
        </span>
      ),
      cta: 'Open Sources',
      go: () => onNavigate('sources'),
    });
  }
  if (day1) {
    queue.push({
      key: 'day1',
      body: (
        <span>
          <strong>Strategy lag report ready.</strong>{' '}
          <span className="text-muted-foreground">
            {day1.totals.red} red, {day1.totals.yellow} yellow across {day1.deliverables_reviewed}{' '}
            recent {day1.deliverables_reviewed === 1 ? 'item' : 'items'}.
          </span>
        </span>
      ),
      cta: 'Open lag report',
      go: () => onNavigate('sources'),
    });
  }
  if (documents.length === 0 && activeNodes.length === 0) {
    queue.push({
      key: 'first-source',
      body: (
        <span>
          <strong>The folders are empty.</strong>{' '}
          <span className="text-muted-foreground">
            Add your first source — a strategy doc, meeting notes, anything — to start building
            the vault.
          </span>
        </span>
      ),
      cta: 'Add a source',
      go: () => onNavigate('sources'),
    });
  }

  // ── Zone 3: growth prompts — at most three, in priority order ────────────
  const growth: Array<{ key: string; title: string; body: React.ReactNode; cta: string; go: () => void }> = [];
  if (activeNodes.length > 0 && queries.length === 0) {
    growth.push({
      key: 'connect',
      title: 'Connect a tool',
      body: (
        <>
          No AI tool has queried the vault yet. Issue a connection token so your team's
          ChatGPT, Cursor, and Claude start drafting against it.
        </>
      ),
      cta: 'Connect a tool',
      go: () => onNavigate('setup'),
    });
  }
  if (unanswered.length > 0) {
    growth.push({
      key: 'gaps',
      title: 'Cover the gaps',
      body: (
        <>
          The vault replied "I don't know" to{' '}
          <strong>
            {unanswered.length} recent request{unanswered.length === 1 ? '' : 's'}
          </strong>{' '}
          ({unansweredByScope.map(([s, n]) => `${s} ×${n}`).join(' · ')}). Feed it sources that
          cover those areas.
        </>
      ),
      cta: 'Add a source',
      go: () => onNavigate('sources'),
    });
  }
  if (staleDays != null && staleDays >= STALE_AFTER_DAYS) {
    growth.push({
      key: 'stale',
      title: 'The vault is going stale',
      body: (
        <>
          Nothing has been ingested in <strong>{staleDays} days</strong>. Decisions made since
          then aren't in the folders — drafts validated against them may be lagging reality.
        </>
      ),
      cta: 'Add a source',
      go: () => onNavigate('sources'),
    });
  }
  if (activeNodes.length > 0 && uncoveredKinds.length > 0) {
    const named = uncoveredKinds.slice(0, 2).map((k) => k.label_plural.toLowerCase());
    growth.push({
      key: 'coverage',
      title: 'Blind spots',
      body: (
        <>
          No <strong>{named.join(' or ')}</strong> captured yet
          {uncoveredKinds.length > 2 ? ` (and ${uncoveredKinds.length - 2} more kinds)` : ''} —
          the vault can't answer questions it has never been told about.
        </>
      ),
      cta: 'Add a source',
      go: () => onNavigate('sources'),
    });
  }
  if (queries.length > 0 && distinctPeople <= 1) {
    growth.push({
      key: 'invite',
      title: 'Bring in the team',
      body: (
        <>
          Only {distinctPeople === 0 ? 'no one' : 'one person'} is drawing on this vault so
          far. Each teammate whose AI tools connect gets the same grounded answers — issue them
          a token.
        </>
      ),
      cta: 'Connect another tool',
      go: () => onNavigate('setup'),
    });
  }
  const growthShown = growth.slice(0, 3);

  return (
    <div className="space-y-6">
      {/* ── Zone 1: is it working? ───────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="eyebrow">Is it working?</h2>

        <Card className="p-4 shadow-soft">
          <div className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6">
            <Kpi label="requests" value={String(kpiRequests)} onClick={() => onNavigate('ask')} />
            <Kpi
              label="answered"
              value={kpiAnswerRate == null ? '—' : `${kpiAnswerRate}%`}
              warn={kpiAnswerRate != null && kpiAnswerRate < 50}
              onClick={() => onNavigate('ask')}
            />
            <Kpi label={reviews.length === 1 ? 'review' : 'reviews'} value={String(reviews.length)} onClick={() => onNavigate('review')} />
            <Kpi label={kpiPeople === 1 ? 'person' : 'people'} value={String(kpiPeople)} onClick={() => onNavigate('setup')} />
            <Kpi
              label={documents.length === 1 ? 'source' : 'sources'}
              value={String(documents.length)}
              onClick={() => onNavigate('sources')}
              title="Every source document added to this directory, across all folders — documents are shared directory-wide, not scoped to one folder."
            />
            <Kpi
              label={totalActiveNodes === 1 ? 'node' : 'nodes'}
              value={String(totalActiveNodes)}
              onClick={() => onNavigate('library')}
              title="Active nodes across every folder in this directory (archived nodes aren't counted). The Folders view shows only the folder you last had open."
            />
          </div>
        </Card>

        {/* The owner's reading: two synthesized passages — the team's use and
            the owner's own — set like a letter, not a stat block. */}
        {(usageAnalysis?.team.summary || usageAnalysis?.self.summary) && (
          <Card className="shadow-soft">
            <CardContent className="px-6 py-7 sm:px-12 sm:py-9">
              <h3 className="font-serif text-2xl italic">What your vault has been doing</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Synthesized from the last 30 days of requests — themes and topics, never anyone's
                words.
              </p>
              {/* Two columns of reading on wide screens — a spread, not a sidebar. */}
              <div className="mt-6 grid gap-8 sm:grid-cols-2 sm:gap-12">
                {usageAnalysis?.team.summary && (
                  <NarrativePassage label="For your team" text={usageAnalysis.team.summary} />
                )}
                {usageAnalysis?.self.summary && (
                  <NarrativePassage label="For yourself" text={usageAnalysis.self.summary} />
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* The context, described — what it holds and what's new in it. */}
          <Card className="flex flex-col shadow-soft">
            <CardHeader>
              <CardTitle className="font-serif text-2xl italic">The vault</CardTitle>
              {profile && (
                <CardDescription>
                  <span className="eyebrow">
                    {profileNames.join(' · ')}{' '}
                    {profileNames.length === 1 ? 'profile' : 'profiles'}
                  </span>
                  {activeNodes.length === 0 ? (
                    // Empty workspace: don't show the static profile blurb —
                    // point the user at connecting their tools instead.
                    <ContextDescription text="Connect your tools to your folder." />
                  ) : overviewLoading ? (
                    <span className="mt-2 block space-y-1.5">
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="h-3.5 w-4/5" />
                    </span>
                  ) : (
                    // The library's own summary when synthesis has one;
                    // the static profile blurb otherwise.
                    <ContextDescription text={overview ?? profile.description} />
                  )}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              {activeNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The folders are empty. Add a source to start filling them.
                </p>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="font-serif text-4xl">{activeNodes.length}</span>
                    <span className="text-sm text-muted-foreground">
                      active node{activeNodes.length === 1 ? '' : 's'} in this folder
                      {archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
                      {sourcesInThisFolder > 0
                        ? ` · built on ${sourcesInThisFolder} source${sourcesInThisFolder === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {byKind.map(({ kind, count }) => (
                      <div key={kind.key} className="flex items-center gap-2 text-sm" title={kind.description}>
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: kindColorVar(kind.color) }}
                          aria-hidden
                        />
                        <span>{kind.label_plural}</span>
                        <span className="ml-auto font-mono text-xs text-muted-foreground">{count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* What's new — the latest nodes and sources, a few lines only.
                  The full lists live in Library and Sources. */}
              {fresh.length > 0 && (
                <div className="border-t pt-3">
                  <div className="eyebrow">New in the vault</div>
                  <ul className="mt-1.5 flex flex-col divide-y">
                    {fresh.map((f) => (
                      <li key={f.key} className="flex items-center gap-2 py-1.5 text-xs">
                        {f.color ? (
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: f.color }}
                            aria-hidden
                          />
                        ) : (
                          <FileText className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="min-w-0 truncate font-medium">{f.label}</span>
                        <span className="ml-auto shrink-0 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                          {f.tag}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {new Date(f.sort).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-auto flex flex-wrap gap-3 border-t pt-3">
                <button className="pome-btn-ghost" onClick={() => onNavigate('library')}>
                  Browse the folders
                  <ArrowRight className="size-3.5" />
                </button>
                <button className="pome-btn-ghost" onClick={() => onNavigate('sources')}>
                  {documents.length > 0 ? 'Manage sources' : 'Add a source'}
                  <ArrowRight className="size-3.5" />
                </button>
              </div>
            </CardContent>
          </Card>

          {/* Who's drawing on it — adoption proof. Attributed: who + request
              shape, never the text. CTA grows the circle, not the audit. */}
          <Card className="flex flex-col shadow-soft">
            <CardHeader>
              <CardTitle className="font-serif text-2xl italic">
                Who's drawing on this vault
              </CardTitle>
              <CardDescription>
                {usage.length === 0
                  ? 'No one has drawn on this vault yet.'
                  : `${usage.length} recent request${usage.length === 1 ? '' : 's'} by ${distinctPeople} ${
                      distinctPeople === 1 ? 'person' : 'people'
                    }. Requests show who and what kind — never the words.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-3">
              {usage.length > 0 && (
                <ul className="flex flex-col divide-y">
                  {usage.slice(0, 5).map((u, i) => (
                    <li key={i} className="flex items-center gap-2 py-1.5 text-xs">
                      <span className="min-w-0 truncate font-medium">
                        {u.actor_email ?? 'unknown'}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {usageVerb(u)}
                        {u.scope && u.scope !== 'all' ? ` · ${u.scope}` : ''}
                        {u.deliverable_kind ? ` · ${u.deliverable_kind.replace(/_/g, ' ')}` : ''}
                      </span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {fmtWhen(u.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-auto border-t pt-3">
                <button className="pome-btn-ghost" onClick={() => onNavigate('setup')}>
                  Connect another tool
                  <ArrowRight className="size-3.5" />
                </button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Zone 2: needs you ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="eyebrow">Needs you</h2>
        {queue.length === 0 ? (
          <Card className="p-5">
            <p className="text-sm">
              <strong className="font-serif text-lg italic">All caught up.</strong>{' '}
              <span className="text-muted-foreground">
                No pending candidates and nothing flagged. The folders and the recent input match.
              </span>
            </p>
          </Card>
        ) : (
          <Card className="divide-y border-pome-red/30 bg-pome-red/5 shadow-soft">
            {queue.map((item) => (
              <div
                key={item.key}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="text-sm">{item.body}</div>
                <button className="pome-btn" onClick={item.go}>
                  {item.cta}
                </button>
              </div>
            ))}
          </Card>
        )}
      </section>

      {/* ── Zone 3: make it more useful ──────────────────────────────────── */}
      {growthShown.length > 0 && (
        <section className="space-y-3">
          <h2 className="eyebrow">Make it more useful</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {growthShown.map((g) => (
              <Card key={g.key} className="flex flex-col gap-2 p-4 shadow-soft">
                <h3 className="font-serif text-lg italic">{g.title}</h3>
                <p className="text-xs text-muted-foreground">{g.body}</p>
                <div className="mt-auto pt-2">
                  <button className="pome-btn-ghost" onClick={g.go}>
                    {g.cta}
                    <ArrowRight className="size-3.5" />
                  </button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── Footer: the mirror — contexts I've been drawing on ──────────── */}
      {myUsage.length > 0 && <MyContextsLine entries={myUsage} />}
    </div>
  );
}

// One KPI cell: a number that is also a door into the canonical view.
function Kpi({
  label,
  value,
  warn,
  onClick,
  title,
}: {
  label: string;
  value: string;
  warn?: boolean;
  onClick: () => void;
  /** Native tooltip — use this to disclose a KPI's scope (workspace-wide vs.
   *  this folder only) when two KPIs in the same strip are counted at
   *  different levels and would otherwise read as a broken pair. */
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group flex flex-col items-start rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60"
    >
      <span className={`font-serif text-2xl ${warn ? 'text-flag-red' : ''}`}>{value}</span>
      <span className="text-[0.7rem] uppercase tracking-wider text-muted-foreground group-hover:text-ink">
        {label}
      </span>
    </button>
  );
}

// One synthesized usage passage, set as reading matter: an eyebrow label,
// then serif prose with a drop cap — deliberately closer to a printed
// paragraph than to dashboard chrome.
function NarrativePassage({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-pome-red">
        {label}
      </div>
      <p className="mt-2 font-serif text-base leading-relaxed text-pretty first-letter:float-left first-letter:mr-2 first-letter:text-[2.6rem] first-letter:leading-[0.85] first-letter:text-pome-red">
        {text}
      </p>
    </div>
  );
}

// Human verb for an attributed usage row — what the request DID, since the
// design deliberately never shows what it said.
function usageVerb(u: ContextUsageEntry): string {
  switch (u.tool) {
    case 'query':
      return u.has_answer === false ? 'asked (no answer)' : 'asked';
    case 'context_pack':
      return 'read the vault';
    case 'review':
      return 'validated a draft';
    case 'recent_changes':
      return 'checked changes';
    default:
      return u.tool;
  }
}

// The requester-side mirror, demoted to a single expandable line: this
// dashboard is about this workspace's context; my own consumption elsewhere
// is a footnote.
function MyContextsLine({ entries }: { entries: MyContextUsageEntry[] }) {
  const [open, setOpen] = useState(false);
  const wsCount = new Set(entries.map((e) => e.workspace_id)).size;
  const latest = entries[0];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          You've drawn on {wsCount} vault{wsCount === 1 ? '' : 's'} recently
          {latest ? ` — last: ${latest.workspace_name}, ${fmtWhen(latest.created_at)}` : ''}.
        </span>
        <CollapsibleTrigger className="text-pome-red hover:underline">
          {open ? 'Hide' : 'Show'}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col divide-y rounded-lg border bg-card px-3">
          {entries.slice(0, 5).map((u, i) => (
            <li key={i} className="flex items-center gap-2 py-1.5 text-xs">
              <span className="min-w-0 truncate font-medium">{u.workspace_name}</span>
              {!u.own_context && (
                <span className="min-w-0 shrink truncate text-muted-foreground">
                  ({u.owner_email})
                </span>
              )}
              <span className="shrink-0 text-muted-foreground">
                {usageVerb(u)}
                {u.deliverable_kind ? ` · ${u.deliverable_kind.replace(/_/g, ' ')}` : ''}
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {fmtWhen(u.created_at)}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Context description — clamped to 3 lines, expandable ───────────────────────
// Shows the LLM library overview (or the static profile description fallback).

// Past this length the clamp is likely cutting text off, so offer the toggle.
const DESCRIPTION_CLAMP_CHARS = 200;

function ContextDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  if (text.length <= DESCRIPTION_CLAMP_CHARS) {
    return <span className="mt-1 block">{text}</span>;
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {!open && <span className="mt-1 line-clamp-3 block">{text}</span>}
      <CollapsibleContent>
        <span className="mt-1 block">{text}</span>
      </CollapsibleContent>
      <CollapsibleTrigger className="mt-1 text-xs text-pome-red hover:underline">
        {open ? 'Show less' : 'Show more'}
      </CollapsibleTrigger>
    </Collapsible>
  );
}
