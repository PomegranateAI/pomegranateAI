import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BellRing,
  Check,
  ChevronsUpDown,
  History,
  Layers,
  LayoutDashboard,
  LibraryBig,
  ListTodo,
  Megaphone,
  LogOut,
  Menu,
  MessageCircleQuestion,
  Pencil,
  PenLine,
  Plus,
  ScanEye,
  ScrollText,
  Settings,
  Store,
  UploadCloud,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  getSession,
  SESSION_EXPIRED_EVENT,
  getSubgraphId,
  getWorkspaceId,
  setSession,
  setSubgraphId,
  setUserId,
  setWorkspaceId,
  type Subgraph,
} from './api.js';
import { Login } from './views/Login.js';
import { MfaEnrollScreen } from './components/MfaSetup.js';
import { Onboarding } from './views/Onboarding.js';
import { Overview } from './views/Overview.js';
import { Graph } from './views/Graph.js';
import { Sources } from './views/Sources.js';
import { Automations } from './views/Automations.js';
import { Ask } from './views/Ask.js';
import { WorkAgent } from './views/WorkAgent.js';
import { Alignment } from './views/Alignment.js';
import { Usage } from './views/Usage.js';
import { Setup, PasswordCard } from './views/Setup.js';
import { TeamWorkspaces } from './views/TeamWorkspaces.js';
import { Updates } from './views/Updates.js';
import { AppCatalog } from './components/AppCatalog.js';
import { cn } from '@/lib/utils';
import { SubfolderDialog } from './components/SubfolderDialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// One flat page per concern, grouped in the sidebar by the job you're doing:
//   Overview            — dashboard: actions, status, usage, validation
//   Collab agents       — Get updates / Get feedback (each hideable; "Add collab agent" opens this group's catalog).
//   Work agents         — Draft / Synthesize / Catch-up / Follow-up: act on YOUR OWN context, not the team's (same hideable pattern, but its own separate "Add work agent" catalog).
//   Library             — Subfolders (each opens the Library's node list)
//   Manage Data         — Sources / Automations (feed & maintain the graph;
//                         folder-decision review is a section embedded on Sources; Automations
//                         is its own tab — redesign of the old Rules card)
//   Folder              — Usage / Setup (connections, delegation, admin)
// 'team' is reachable only from Setup ("Explore team workspaces") — it is
// intentionally absent from NAV_GROUPS so it never shows in the sidebar/tab bar.
export type Page = 'overview' | 'sources' | 'automations' | 'library' | 'usage' | 'wiki' | 'ask' | 'review' | 'updates' | 'setup' | 'team' | 'draft' | 'synthesize' | 'catchup' | 'followup' | 'broadcast';

// Work agents (spec-work-agents.md) act on YOUR OWN context only — the opposite
// axis to the collaboration agents, which reach into the team/other folders.
const WORK_AGENT_KEYS = new Set<Page>(['draft', 'synthesize', 'catchup', 'followup', 'broadcast']);

// The work agents rendered by the shared WorkAgent view — i.e. every one of them
// except Give updates, which is the Updates view in 'give' mode.
const WORK_AGENT_VIEW_KEYS = new Set<Page>(['draft', 'synthesize', 'catchup', 'followup']);


const PAGE_LABELS: Record<Page, string> = {
  overview: 'Overview',
  sources: 'Add sources',
  automations: 'Automations',
  library: 'Folders',
  usage: 'Usage',
  wiki: 'Wiki',
  ask: 'Ask the team',
  review: 'Get feedback',
  updates: 'Get updates',
  setup: 'Setup',
  team: 'Team directories',
  draft: 'Draft',
  synthesize: 'Synthesize',
  catchup: 'Catch-up',
  followup: 'Follow-up',
  broadcast: 'Give updates',
};

// One-line pitches for the agent catalogs. Keyed by the hideable agent pages
// (Collab agents + Work agents); other pages don't appear in the catalog.
const APP_DESCRIPTIONS: Partial<Record<Page, string>> = {
  ask: 'Ask anything about your team’s work and get a clear answer, with links to where it came from.',
  updates: 'Follow the topics you care about and get a short, sourced recap whenever something changes — so you don’t have to keep checking.',
  review: 'Paste a draft and see where it fits — or clashes with — what your team already decided, before it ships.',
  draft: 'Get a first draft built from your own notes and past writing, instead of starting at a blank page.',
  synthesize: 'Pull everything you know about one topic into a single, coherent doc.',
  catchup: 'Coming back after time away? See where you left off and what has moved.',
  followup: 'Find the open loops you left behind — what you promised, and who you owe.',
  broadcast: 'Keep your teammates posted on your own work automatically — no more writing status reports.',
};

// Tighter labels for the mobile tab bar, where each destination is an
// equal-width column and the full "Ask & Review" would wrap or truncate.
const MOBILE_PAGE_LABELS: Record<Page, string> = {
  overview: 'Overview',
  sources: 'Sources',
  library: 'Folders',
  usage: 'Usage',
  wiki: 'Wiki',
  ask: 'Ask',
  review: 'Feedback',
  updates: 'Updates',
  automations: 'Auto',
  setup: 'Setup',
  team: 'Team',
  draft: 'Draft',
  synthesize: 'Synth',
  catchup: 'Catch-up',
  followup: 'Follow-up',
  broadcast: 'Give',
};

const NAV_GROUPS: Array<{
  label: string | null;
  items: Array<{ key: Page; icon: React.ReactNode }>;
  // Agent groups: each item can be hidden via a cross and the group carries its
  // own "Add …" button, opening a catalog scoped to that group.
  apps?: boolean;
  // Subfolders: the group renders the workspace's subgraphs as a dynamic,
  // renameable list (with an "Add subfolder" button) in place of a static
  // "Library" entry — each subfolder opens the Library scoped to it.
  subfolders?: boolean;
}> = [
  {
    label: null,
    items: [
      { key: 'overview', icon: <LayoutDashboard className="size-4" /> },
      // Ask sits OUTSIDE the agent groups: asking your folder a question and
      // getting a cited answer is the core capability, not an agent you add.
      { key: 'ask', icon: <MessageCircleQuestion className="size-4" /> },
    ],
  },
  {
    label: 'Collab agents',
    apps: true,
    items: [
      { key: 'updates', icon: <BellRing className="size-4" /> },
      { key: 'review', icon: <ScanEye className="size-4" /> },
    ],
  },
  {
    // Work agents (spec-work-agents.md): act on YOUR OWN context only — draft
    // from your notes, synthesize your fragments, catch up on your recent
    // material, surface your open loops. The inward counterpart to the Collab
    // agents above, and hideable/catalog-driven the same way (`apps`).
    label: 'Work agents',
    apps: true,
    items: [
      { key: 'draft', icon: <PenLine className="size-4" /> },
      { key: 'synthesize', icon: <Layers className="size-4" /> },
      { key: 'catchup', icon: <History className="size-4" /> },
      { key: 'followup', icon: <ListTodo className="size-4" /> },
      { key: 'broadcast', icon: <Megaphone className="size-4" /> },
    ],
  },
  {
    label: 'Folders',
    // The subfolder list stands in for a static "Library" entry — each
    // subfolder opens the Library's node list scoped to it.
    subfolders: true,
    items: [],
  },
  {
    label: 'Manage Data',
    items: [
      { key: 'sources', icon: <UploadCloud className="size-4" /> },
      { key: 'automations', icon: <ScrollText className="size-4" /> },
    ],
  },
  {
    label: 'Directory',
    items: [
      { key: 'usage', icon: <Activity className="size-4" /> },
      { key: 'setup', icon: <Settings className="size-4" /> },
    ],
  },
];

// The nav's "Add …" affordance names the kind of agent its group holds, so the
// sidebar and the catalog it opens speak the same language.
const GROUP_ADD_LABELS: Record<string, string> = {
  'Collab agents': 'Add collab agent',
  'Work agents': 'Add work agent',
};
const addAgentLabel = (group: string | null) =>
  (group && GROUP_ADD_LABELS[group]) || 'Add agent';

// Every sidebar-hideable agent key, derived from the catalog-driven groups
// (Collab agents + Work agents) so it can't drift from the nav. The server keeps
// the matching allow-list (HIDEABLE_APP_IDS in api/routes.ts).
const HIDEABLE_APP_KEYS = new Set<Page>(
  NAV_GROUPS.filter((g) => g.apps).flatMap((g) => g.items.map((i) => i.key)),
);

// ── Mobile bottom bar ────────────────────────────────────────────────────────
// The bar gives every tab an equal-width column, so it only works for a handful
// of them: the nav now carries ~19 destinations (Collab agents + Work agents +
// subfolders + data + folder), which at phone width is ~19px per column — less
// than the icon itself. So the bar shows these few, and everything else lives
// behind "More". Order is the mobile job-to-be-done: see status, ask, read,
// clear the queue. Any of these a user has hidden is simply dropped.
const PRIMARY_MOBILE_TABS: Page[] = ['overview', 'ask', 'library', 'sources'];

// This SPA has no URL-based routing (page is plain useState, wsId persists
// via storage instead of the URL) — so an OAuth connect redirect (see
// Sources.tsx's ConnectAppPanel) can't just "come back to where it was" the
// way a router-backed app would. It instead carries `?returnTo=sources&app=
// <toolkit>` on its callback URL, read once on mount.
//
// This read is deliberately PURE (no history.replaceState here) — it feeds a
// useState lazy initializer, and React 18 StrictMode double-invokes those in
// dev to catch impure ones. An earlier version stripped the URL inside this
// function itself: the first invocation stripped it and returned the right
// route, but StrictMode's second invocation then read the now-stripped URL
// and returned {page: null}, which is the result that actually got kept —
// so the redirect silently landed on Overview instead of Sources. The actual
// URL-stripping side effect now lives in a separate one-time useEffect below.
function initialAppRouteFromUrl(): { page: Page | null; appId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get('returnTo');
  const appId = params.get('app');
  // 'setup' deep-links into the full Setup page.
  const page = returnTo === 'sources' ? 'sources' : returnTo === 'setup' ? 'setup' : null;
  return { page, appId };
}

export function App() {
  const [session, setSess] = useState(() => getSession());
  // MFA_REQUIRED policy, account not enrolled: the server only lets this
  // session reach the enrolment endpoints, so show the enrolment screen.
  // Likewise when the account signed in with an administrator-set password:
  // only the change-password endpoint is open until it's replaced.
  const [mfaGate, setMfaGate] = useState<'ok' | 'enroll' | 'password'>('ok');
  useEffect(() => {
    if (!session) return;
    Promise.all([api.getMe(), api.getMfa()])
      .then(([me, m]) => setMfaGate(me.password_must_change ? 'password' : m.required && !m.has_password ? 'enroll' : 'ok'))
      .catch(() => setMfaGate('ok'));
  }, [session]);
  const [wsId, setWs] = useState(getWorkspaceId());
  const [initialRoute] = useState(initialAppRouteFromUrl);
  const [page, setPage] = useState<Page>(initialRoute.page ?? 'overview');
  // Strip ?returnTo=/&app= once, after the route has been read into state —
  // see initialAppRouteFromUrl's comment for why this can't live there.
  useEffect(() => {
    if (initialRoute.page) window.history.replaceState(null, '', window.location.pathname);
  }, [initialRoute.page]);
  const [pending, setPending] = useState(0);
  // Updates awaiting my approval (review-mode) — drives the "Get updates" badge.
  const [pendingUpdates, setPendingUpdates] = useState(0);
  // Mobile: the overflow ("More") sheet holding every non-primary destination.
  const [moreOpen, setMoreOpen] = useState(false);

  // Per-item nav badge count: pending routing decisions on Sources (surfaced
  // there as the folder-decisions banner), pending-approval updates on Get
  // updates. Shared by the sidebar and the mobile bar so the two can never
  // disagree about what's waiting.
  const badgeFor = useCallback(
    (key: Page): number => (key === 'sources' ? pending : key === 'updates' ? pendingUpdates : 0),
    [pending, pendingUpdates],
  );
  const [visibleApps, setVisibleApps] = useState<Set<Page>>(new Set());
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name: string; can_manage?: boolean }>
  >([]);
  const visibleNavGroups = NAV_GROUPS;
  // Which nav group's agent catalog is open (its label), or null. Collab agents
  // and Work agents each get their own modal — they answer different questions.
  const [catalogGroup, setCatalogGroup] = useState<string | null>(null);
  const [subgraphs, setSubgraphs] = useState<Subgraph[]>([]);
  const [sgId, setSgId] = useState<string | null>(getSubgraphId());
  // Pre-narrows the Library list to one document's nodes when arriving via the
  // "View in Library" toast action after an ingest — see openLibraryForDocument.
  const [libraryDocFilter, setLibraryDocFilter] = useState<{ documentId: string; title?: string } | null>(null);
  // Subfolder (subgraph) management in the sidebar: the "New subfolder" dialog,
  // and the inline rename of an existing one.
  const [subfolderDialogOpen, setSubfolderDialogOpen] = useState(false);
  const [renamingSub, setRenamingSub] = useState<string | null>(null);
  const [renameSubName, setRenameSubName] = useState('');
  useEffect(() => {
    if (!session) return;
    api.listWorkspaces().then((r) => {
      setWorkspaces(r.workspaces);
      // A provisioned account's sign-in link lands in a fresh browser with no
      // folder selected — with exactly one, open it rather than the picker.
      if (!getWorkspaceId() && r.workspaces.length === 1) {
        setWorkspaceId(r.workspaces[0]!.id);
        setWs(r.workspaces[0]!.id);
      }
    });
  }, [session]);

  // Load the workspace's subgraphs (subfolders). Rendered as the sidebar's
  // subfolder list; reloaded after create/rename.
  const reloadSubgraphs = useCallback(() => {
    if (!session || !wsId) {
      setSubgraphs([]);
      return;
    }
    api.listSubgraphs(wsId).then((r) => setSubgraphs(r.subgraphs)).catch(() => setSubgraphs([]));
  }, [session, wsId]);

  useEffect(() => {
    reloadSubgraphs();
  }, [reloadSubgraphs]);

  useEffect(() => {
    if (!session || !wsId) {
      setVisibleApps(new Set());
      return;
    }
    let cancelled = false;
    api
      .listVisibleApps(wsId)
      .then((r) => {
        if (!cancelled) setVisibleApps(new Set(r.visible_apps as Page[]));
      })
      .catch(() => {
        if (!cancelled) setVisibleApps(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [session, wsId]);

  useEffect(() => {
    if (HIDEABLE_APP_KEYS.has(page) && !visibleApps.has(page)) {
      setPage('overview');
    }
  }, [page, visibleApps]);

  // Per-view document title (the favicon carries the brand; the title carries
  // the place).
  useEffect(() => {
    document.title = `${PAGE_LABELS[page]} · Pomegranate`;
  }, [page]);

  // Pending-route count for the Curate badge. Refreshed on navigation and
  // every 30s so routing decisions made elsewhere (Slack, MCP) are reflected.
  useEffect(() => {
    if (!session || !wsId) return;
    let stop = false;
    const load = () =>
      api
        .listPendingRoutes(wsId)
        .then((r) => {
          if (!stop) setPending(r.pending_routes.length);
        })
        .catch(() => {});
    load();
    const handle = window.setInterval(load, 30_000);
    return () => {
      stop = true;
      window.clearInterval(handle);
    };
  }, [session, wsId, page]);

  // Pending-approval count for the "Get updates" badge. Refreshed on navigation
  // and every 30s so approvals done elsewhere (or new review-mode runs) reflect.
  const refreshPendingUpdates = useCallback(() => {
    if (!session || !wsId) return;
    api
      .pendingUpdatesCount(wsId)
      .then((r) => setPendingUpdates(r.count))
      .catch(() => {});
  }, [session, wsId]);
  useEffect(() => {
    if (!session || !wsId) return;
    refreshPendingUpdates();
    const handle = window.setInterval(refreshPendingUpdates, 30_000);
    return () => window.clearInterval(handle);
  }, [session, wsId, page, refreshPendingUpdates]);

  // A session the server no longer accepts (expired / revoked): api.ts has
  // already dropped the token; clear the rest of the signed-in state so the
  // login screen renders instead of a home page where every call 401s.
  useEffect(() => {
    const onExpired = () => {
      setUserId(null);
      setSess(null);
      setWorkspaceId(null);
      setWs(null);
      setSgId(null);
      toast.info('Your session has expired. Please sign in again.');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (session && mfaGate === 'password') {
    return (
      <>
        <div className="bg-page flex min-h-screen items-center justify-center px-6">
          <div className="w-full max-w-2xl space-y-3">
            <p className="text-sm text-muted-foreground">
              Your password was set by an administrator. Choose your own to continue.
            </p>
            <PasswordCard
              onSaved={() =>
                api
                  .getMfa()
                  .then((m) => setMfaGate(m.required && !m.has_password ? 'enroll' : 'ok'))
                  .catch(() => setMfaGate('ok'))
              }
            />
          </div>
        </div>
        <Toaster />
      </>
    );
  }

  if (session && mfaGate === 'enroll') {
    return (
      <>
        <MfaEnrollScreen
          onDone={() => setMfaGate('ok')}
          onLogout={() => {
            void api.logout();
            setSession(null);
            setSess(null);
          }}
        />
        <Toaster />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <Login
          onLogin={(s) => {
            setSession(s);
            setSess(s);
          }}
        />
        <Toaster />
      </>
    );
  }

  if (!wsId) {
    return (
      <>
        <Onboarding
          workspaces={workspaces}
          onSelect={(id) => {
            setWorkspaceId(id);
            setWs(id);
          }}
          onCreated={(id, name) => {
            setWorkspaces([...workspaces, { id, name }]);
            setWorkspaceId(id);
            setWs(id);
          }}
        />
        <Toaster />
      </>
    );
  }

  const wsName = workspaces.find((w) => w.id === wsId)?.name ?? '';

  const switchWorkspace = () => {
    setWorkspaceId(null);
    setWs(null);
    setSgId(null);
  };

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    setWs(id);
    setSgId(null);
  };

  // Select the active subgraph. null = the 'default' subgraph.
  const selectSubgraph = (id: string | null) => {
    setSubgraphId(id);
    setSgId(id);
  };

  // Open a subfolder: pin its subgraph and jump to the Library scoped to it.
  const openSubfolder = (id: string) => {
    selectSubgraph(id === 'default' ? null : id);
    setPage('library');
  };

  // Same, but from an ingest result: pin the subfolder the document landed
  // in and, when given a document id, pre-narrow the Library list to just
  // its nodes — the "View in Library" toast action after a successful
  // ingest. subgraphId is null for a router-decided multi-item pull with no
  // single destination to point at.
  const openLibraryForDocument = (subgraphId: string | null, documentId?: string, title?: string) => {
    selectSubgraph(subgraphId === 'default' ? null : subgraphId);
    setLibraryDocFilter(documentId ? { documentId, title } : null);
    setPage('library');
  };

  // Create a subfolder (subgraph) bound to a profile, then open it.
  const createSubfolder = async (profileId: string, name: string, description?: string) => {
    if (!wsId) return;
    try {
      const r = await api.createSubgraph(wsId, { profile_id: profileId, name, description });
      reloadSubgraphs();
      openSubfolder(r.subgraph_id);
      toast.success('Folder created', { description: r.name });
    } catch (e: any) {
      toast.error('Could not create folder', {
        description: /403|forbidden/i.test(e?.message ?? '')
          ? 'Only directory admins can add folders.'
          : e?.message,
      });
    }
  };

  // Commit an inline rename of a subfolder. Guarded so a blur firing right after
  // Enter (both call this) doesn't double-submit.
  const commitRenameSub = async (id: string) => {
    if (renamingSub !== id) return;
    const name = renameSubName.trim();
    const current = subgraphs.find((s) => s.id === id)?.name;
    setRenamingSub(null);
    if (!wsId || !name || name === current) return;
    try {
      await api.renameSubgraph(wsId, id, name);
      reloadSubgraphs();
    } catch (e: any) {
      toast.error('Could not rename folder', {
        description: /403|forbidden/i.test(e?.message ?? '')
          ? 'Only directory admins can rename folders.'
          : e?.message,
      });
    }
  };

  const startRenameSub = (id: string, currentName: string) => {
    setRenamingSub(id);
    setRenameSubName(currentName);
  };

  const logout = () => {
    void api.logout();
    setSession(null);
    setUserId(null);
    setSess(null);
    setWorkspaceId(null);
    setWs(null);
    setSgId(null);
  };

  // Hide a Collab-agents item from the nav. If it's the one on screen, fall back
  // to the Overview so we're never showing a page whose nav entry is gone.
  const hideNavItem = async (key: Page) => {
    if (!wsId) return;
    try {
      await api.hideApp(wsId, key);
      setVisibleApps((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (page === key) setPage('overview');
    } catch (e: any) {
      toast.error('Could not hide app', { description: e?.message });
    }
  };

  // Un-hide an agent — the inverse of the nav cross, driven from the group's
  // catalog.
  const showNavItem = async (key: Page) => {
    if (!wsId) return;
    try {
      await api.showApp(wsId, key);
      setVisibleApps((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    } catch (e: any) {
      toast.error('Could not add app', { description: e?.message });
    }
  };

  // Each agent group's "+" opens the catalog scoped to that group.
  const openAppCatalog = (group: string) => setCatalogGroup(group);

  // The catalog-driven groups (Collab agents + Work agents) are the source of
  // truth for what the catalogs offer. Each app carries its group label so the
  // catalog can serve one group at a time — the two answer different questions
  // ("what do we know?" vs "help me get my stuff done") and never share a modal.
  const catalogApps = NAV_GROUPS.filter((g) => g.apps).flatMap((g) =>
    g.items.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: PAGE_LABELS[item.key],
      description: APP_DESCRIPTIONS[item.key] ?? '',
      added: visibleApps.has(item.key),
      group: g.label ?? '',
    })),
  );

  const activeSgId = sgId ?? 'default';
  // Remount the active view when the workspace OR subgraph changes so views
  // re-fetch through the (now subgraph-scoped) API headers.
  const viewKey = `${wsId}:${activeSgId}`;
  // The sidebar never collapses to an icon rail now (the Wiki lives inside the
  // Library as a tab rather than as its own full-width page). Kept as a flag so
  // the shared nav rendering stays untouched.
  const navCollapsed = false;

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-cream/75 backdrop-blur supports-[backdrop-filter]:bg-cream/75">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <span className="flex items-center gap-2" aria-label="Pomegranate">
            <img src="/pomegranate-icon.svg" alt="" className="size-6 rounded-md" />
            <span className="font-mono text-base leading-none">
              <span className="text-foreground">[pome]</span>
              <span className="text-gradient-pome font-semibold">granate</span>
            </span>
          </span>
          {wsName && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="eyebrow">{wsName}</span>
                <ChevronsUpDown className="size-3.5 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-52">
                <DropdownMenuLabel className="eyebrow">Directories</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {workspaces.map((w) => (
                  <DropdownMenuItem
                    key={w.id}
                    onSelect={() => selectWorkspace(w.id)}
                    className={w.id === wsId ? 'font-semibold' : ''}
                  >
                    {w.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={switchWorkspace} aria-label="Switch directory">
                  <Plus className="size-4" />
                  Switch directory
                </DropdownMenuItem>
                {/* The sidebar's log-out lives in `max-sm:hidden`, so the
                    account menu carries it for small screens. */}
                <DropdownMenuItem onSelect={logout} aria-label="Log out" className="sm:hidden">
                  <LogOut className="size-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Subfolders used to live here as a header dropdown; they now render
              in the sidebar as a first-class list (see the "Library"
              group below). */}
        </div>
      </header>

      <div className="mx-auto flex max-w-[1240px] items-start gap-8 px-6 py-6">
        <nav
          className={`side-nav sticky top-[61px] shrink-0 space-y-5 pt-1 max-sm:hidden ${
            navCollapsed ? 'w-12' : 'w-40'
          }`}
          aria-label="Primary"
        >
          {visibleNavGroups.map((g, gi) => {
            const items = g.items.filter((it) => !g.apps || visibleApps.has(it.key));
            // A hideable group that's been fully hidden keeps only its "Add …"
            // affordance; other empty groups drop out entirely.
            if (items.length === 0 && !g.apps && !g.subfolders) return null;
            return (
              <div key={g.label ?? gi} className="space-y-1">
                {g.label && !navCollapsed && (
                  <div className="flex items-center justify-between px-2.5 pb-0.5">
                    <div className="eyebrow">{g.label}</div>
                    {(g.apps || g.subfolders) && (
                      <button
                        type="button"
                        title={g.subfolders ? 'Add folder' : addAgentLabel(g.label)}
                        aria-label={g.subfolders ? 'Add folder' : addAgentLabel(g.label)}
                        className="-mr-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() =>
                          g.subfolders ? setSubfolderDialogOpen(true) : openAppCatalog(g.label ?? '')
                        }
                      >
                        <Plus className="size-3.5" />
                      </button>
                    )}
                  </div>
                )}
                {/* Subfolder list — the dynamic replacement for the old static
                    "Library" entry. Each row opens the Library scoped to its
                    subgraph; the pencil renames it; "Add subfolder" creates one. */}
                {g.subfolders && (
                  <div className="space-y-1">
                    {subgraphs.map((s) => {
                      const active = page === 'library' && activeSgId === s.id;
                      if (renamingSub === s.id) {
                        return (
                          <input
                            key={s.id}
                            autoFocus
                            value={renameSubName}
                            onChange={(e) => setRenameSubName(e.target.value)}
                            onBlur={() => void commitRenameSub(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRenameSub(s.id);
                              else if (e.key === 'Escape') setRenamingSub(null);
                            }}
                            className="w-full rounded-md border border-pome-red/40 bg-card px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Rename ${s.name}`}
                          />
                        );
                      }
                      return (
                        <div key={s.id} className="group/nav relative">
                          <button
                            type="button"
                            title={s.name}
                            className={`nav-item nav-subfolder flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 pr-7 text-left text-sm transition-colors ${
                              active
                                ? 'bg-foreground font-medium text-cream'
                                : 'text-foreground hover:bg-muted'
                            }`}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => openSubfolder(s.id)}
                          >
                            <span className={`shrink-0 ${active ? 'text-cream' : 'text-muted-foreground'}`}>
                              <LibraryBig className="size-4" />
                            </span>
                            <span className="truncate">{s.name}</span>
                          </button>
                          <button
                            type="button"
                            title={`Rename ${s.name}`}
                            aria-label={`Rename ${s.name}`}
                            className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/nav:opacity-100 ${
                              active ? 'text-cream/70 hover:text-cream' : 'text-muted-foreground hover:text-foreground'
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              startRenameSub(s.id, s.name);
                            }}
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={() => setSubfolderDialogOpen(true)}
                    >
                      <Plus className="size-3.5" />
                      Add folder
                    </button>
                  </div>
                )}
                {items.map((item) => {
                  const active = page === item.key;
                  return (
                    <div key={item.key} className="group/nav relative">
                      <button
                        type="button"
                        title={navCollapsed ? PAGE_LABELS[item.key] : undefined}
                        className={`nav-item flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm transition-colors ${
                          navCollapsed ? 'justify-center px-0' : 'px-2.5'
                        } ${
                          active
                            ? 'bg-foreground font-medium text-cream'
                            : 'text-foreground hover:bg-muted'
                        }`}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setPage(item.key)}
                      >
                        {(() => {
                          const badge = badgeFor(item.key);
                          return (
                            <>
                              <span
                                className={`relative ${active ? 'text-cream' : 'text-muted-foreground'}`}
                              >
                                {item.icon}
                                {navCollapsed && badge > 0 && (
                                  <span
                                    className="absolute -right-1.5 -top-1 size-2 rounded-full bg-pome-red"
                                    aria-label={`${badge} pending`}
                                  />
                                )}
                              </span>
                              {!navCollapsed && PAGE_LABELS[item.key]}
                              {!navCollapsed && badge > 0 && (
                                <span
                                  className={`ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                                    active ? 'bg-cream text-foreground' : 'bg-pome-red text-primary-foreground'
                                  }`}
                                  aria-label={`${badge} pending`}
                                >
                                  {badge}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </button>
                      {/* Hide a Collab-agent from the nav. Sits on top of the row's
                          right edge, revealed on hover. Not shown on the collapsed
                          icon rail where there's no room. */}
                      {g.apps && !navCollapsed && (
                        <button
                          type="button"
                          title={`Hide ${PAGE_LABELS[item.key]}`}
                          aria-label={`Hide ${PAGE_LABELS[item.key]}`}
                          className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/nav:opacity-100 ${
                            active ? 'text-cream/70 hover:text-cream' : 'text-muted-foreground hover:text-foreground'
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            hideNavItem(item.key);
                          }}
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {g.apps && !navCollapsed && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => openAppCatalog(g.label ?? '')}
                  >
                    <Plus className="size-3.5" />
                    {addAgentLabel(g.label)}
                  </button>
                )}
                {g.apps && navCollapsed && (
                  <button
                    type="button"
                    title={addAgentLabel(g.label)}
                    aria-label={addAgentLabel(g.label)}
                    className="nav-item flex w-full items-center justify-center rounded-md px-0 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => openAppCatalog(g.label ?? '')}
                  >
                    <Store className="size-4" />
                  </button>
                )}
              </div>
            );
          })}

          <div className="border-t pt-3">
            <button
              type="button"
              title={navCollapsed ? 'Log out' : undefined}
              className={`nav-logout flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
                navCollapsed ? 'justify-center px-0' : 'px-2.5'
              }`}
              onClick={logout}
            >
              <LogOut className="size-4" />
              {!navCollapsed && 'Log out'}
            </button>
          </div>
        </nav>

        {/* Small screens: the sidebar becomes a fixed bottom tab bar. Only the
            primary destinations get a column — the rest live behind "More", so
            each tab keeps a tappable width no matter how many apps are enabled.
            The bar reserves room for the iOS home indicator. */}
        {(() => {
          // Every destination the sidebar would show, flattened. The subfolders
          // group has no room for its list on mobile, so it contributes a single
          // "Library" tab (opening whichever subfolder is currently pinned).
          const allItems = visibleNavGroups.flatMap((g) =>
            g.subfolders
              ? [{ key: 'library' as Page, icon: <LibraryBig className="size-4" /> }, ...g.items]
              : g.items,
          ).filter((item) => !HIDEABLE_APP_KEYS.has(item.key) || visibleApps.has(item.key));

          const primary = PRIMARY_MOBILE_TABS.map((k) => allItems.find((i) => i.key === k)).filter(
            (i): i is { key: Page; icon: React.ReactNode } => !!i,
          );
          const primaryKeys = new Set(primary.map((i) => i.key));
          const overflow = allItems.filter((i) => !primaryKeys.has(i.key));
          // Anything waiting behind "More" still has to be visible from the bar.
          const overflowBadge = overflow.reduce((sum, i) => sum + badgeFor(i.key), 0);
          const overflowActive = overflow.some((i) => i.key === page);

          const tab = (
            key: string,
            icon: React.ReactNode,
            label: string,
            active: boolean,
            badge: number,
            onClick: () => void,
            extraProps: Record<string, unknown> = {},
          ) => (
            <button
              key={key}
              type="button"
              className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[10px] font-medium leading-none transition-colors ${
                active ? 'text-pome-red' : 'text-muted-foreground'
              }`}
              onClick={onClick}
              {...extraProps}
            >
              <span className="relative">
                {icon}
                {badge > 0 && (
                  <span
                    className="absolute -right-2 -top-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-pome-red px-1 py-0.5 font-mono text-[9px] leading-none text-primary-foreground"
                    aria-label={`${badge} pending`}
                  >
                    {badge}
                  </span>
                )}
              </span>
              <span className="max-w-full truncate">{label}</span>
            </button>
          );

          return (
            <nav
              className="side-nav-mobile fixed inset-x-0 bottom-0 z-40 flex border-t bg-cream/90 pb-[env(safe-area-inset-bottom)] shadow-soft backdrop-blur sm:hidden"
              aria-label="Primary"
            >
              {primary.map((item) =>
                tab(
                  item.key,
                  item.icon,
                  MOBILE_PAGE_LABELS[item.key],
                  page === item.key,
                  badgeFor(item.key),
                  () => setPage(item.key),
                  { 'aria-current': page === item.key ? 'page' : undefined },
                ),
              )}
              {/* Always shown: even with no overflow destinations, "More" holds
                  the subfolder switcher and log-out. */}
              {tab(
                '__more',
                <Menu className="size-4" />,
                'More',
                overflowActive,
                overflowBadge,
                () => setMoreOpen(true),
                { 'aria-haspopup': 'dialog', 'aria-expanded': moreOpen },
              )}
            </nav>
          );
        })()}

        {/* Mobile "More": the full grouped nav, mirroring the sidebar's sections. */}
        <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
          <DialogContent className="max-h-[80vh] overflow-y-auto sm:hidden">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl italic">Go to</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {visibleNavGroups.map((g, gi) => {
                // Subfolders get the full switcher + "Add subfolder" here, since
                // this is the only mobile surface with room for the dynamic list
                // (the bottom bar only has space for one static "Library" tab).
                if (g.subfolders) {
                  return (
                    <div key={g.label ?? `g${gi}`} className="space-y-1">
                      {g.label && <div className="eyebrow">{g.label}</div>}
                      {subgraphs.map((s) => {
                        const active = page === 'library' && activeSgId === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                              active ? 'bg-foreground font-medium text-cream' : 'hover:bg-muted'
                            }`}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => {
                              openSubfolder(s.id);
                              setMoreOpen(false);
                            }}
                          >
                            <span className={active ? 'text-cream' : 'text-muted-foreground'}>
                              <LibraryBig className="size-4" />
                            </span>
                            <span className="truncate">{s.name}</span>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() => {
                          setSubfolderDialogOpen(true);
                          setMoreOpen(false);
                        }}
                      >
                        <Plus className="size-4" />
                        Add folder
                      </button>
                    </div>
                  );
                }
                const items = g.items
                  .filter((item) => !HIDEABLE_APP_KEYS.has(item.key) || visibleApps.has(item.key))
                  .filter((item) => !PRIMARY_MOBILE_TABS.includes(item.key));
                if (items.length === 0) return null;
                return (
                  <div key={g.label ?? `g${gi}`} className="space-y-1">
                    {g.label && <div className="eyebrow">{g.label}</div>}
                    {items.map((item) => {
                      const active = page === item.key;
                      const badge = badgeFor(item.key);
                      return (
                        <button
                          key={item.key}
                          type="button"
                          className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                            active ? 'bg-foreground font-medium text-cream' : 'hover:bg-muted'
                          }`}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => {
                            setPage(item.key);
                            setMoreOpen(false);
                          }}
                        >
                          <span className={active ? 'text-cream' : 'text-muted-foreground'}>
                            {item.icon}
                          </span>
                          {PAGE_LABELS[item.key]}
                          {badge > 0 && (
                            <span
                              className={`ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                                active ? 'bg-cream text-foreground' : 'bg-pome-red text-primary-foreground'
                              }`}
                              aria-label={`${badge} pending`}
                            >
                              {badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {/* The sidebar (and its log-out) is `max-sm:hidden`, so this sheet
                  is where mobile users look for it. */}
              <div className="border-t pt-3">
                <button
                  type="button"
                  className="nav-logout-mobile flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => {
                    setMoreOpen(false);
                    logout();
                  }}
                >
                  <LogOut className="size-4" />
                  Log out
                </button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <main className="min-w-0 flex-1 max-sm:pb-20" key={viewKey}>
          {page === 'overview' && <Overview wsId={wsId} onNavigate={setPage} subgraphs={subgraphs} />}
          {/* Sources embeds folder-decision review (pending_routes — see
              spec-pomegranate-light-removals.md §1/§5) as a conditional banner.
              Automations is now its own tab (redesign of the old embedded
              Rules card) — see Automations.tsx. */}
          {page === 'sources' && (
            <Sources
              wsId={wsId}
              subgraphs={subgraphs}
              initialAppId={initialRoute.appId}
              onNavigate={setPage}
              onViewDocument={openLibraryForDocument}
            />
          )}
          {page === 'automations' && <Automations wsId={wsId} />}
          {/* The Library's node list, scoped to the pinned subfolder. */}
          {page === 'library' && (
            <Graph
              wsId={wsId}
              subgraphs={subgraphs}
              subgraphId={activeSgId}
              initialDocumentFilter={libraryDocFilter}
              onFolderUpdated={reloadSubgraphs}
              onFolderRemoved={() => {
                reloadSubgraphs();
                setSubgraphId(null);
                setSgId(null);
                setPage('overview');
              }}
            />
          )}
          {page === 'usage' && <Usage wsId={wsId} />}
          {page === 'ask' && <Ask wsId={wsId} />}
          {/* Work agents (spec-work-agents.md) — own-context only. Four of them
              produce a piece of work and share the WorkAgent view; Give updates
              broadcasts your own work on a schedule, so it rides the Updates
              view (same watches, same scheduler) in 'give' mode. */}
          {WORK_AGENT_VIEW_KEYS.has(page) && (
            <WorkAgent wsId={wsId} agent={page as 'draft' | 'synthesize' | 'catchup' | 'followup'} />
          )}
          {page === 'broadcast' && (
            <Updates wsId={wsId} mode="give" onPendingMutate={refreshPendingUpdates} />
          )}
          {page === 'review' && <Alignment wsId={wsId} />}
          {page === 'updates' && <Updates wsId={wsId} onPendingMutate={refreshPendingUpdates} />}
          {page === 'setup' && (
            <Setup
              wsId={wsId}
              onDeleted={switchWorkspace}
              onOpenTeam={() => setPage('team')}
            />
          )}
          {page === 'team' && <TeamWorkspaces onBack={() => setPage('setup')} />}
        </main>
      </div>

      <AppCatalog
        group={catalogGroup}
        onOpenChange={(o) => !o && setCatalogGroup(null)}
        apps={catalogApps}
        onAdd={(key) => {
          setCatalogGroup(null);
          // Open it only once it's visible: the hidden-page guard above would
          // otherwise bounce straight back to the Overview.
          void showNavItem(key as Page).then(() => setPage(key as Page));
        }}
      />
      <SubfolderDialog
        open={subfolderDialogOpen}
        onOpenChange={setSubfolderDialogOpen}
        onCreate={createSubfolder}
      />
      <Toaster />
    </>
  );
}
