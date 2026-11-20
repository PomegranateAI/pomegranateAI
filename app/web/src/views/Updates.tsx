import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  Plus,
  Pause,
  Play,
  Trash2,
  Mail,
  Hash,
  Eye,
  MousePointerClick,
  Loader2,
  X,
  FolderOpen,
  UserRound,
  ChevronDown,
  Sparkles,
  Check,
  Send,
  ShieldCheck,
  Zap,
  Megaphone,
  Users,
  Bookmark,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type UpdateSubscription,
  type UpdateDelivery,
  type UpdateMedium,
  type UpdateApprovalMode,
  type UpdateKind,
  type RecipientList,
  type TeamUser,
} from '../api.js';
import { RunInClaude } from '../components/RunInClaude.js';
import { FolderTargetPicker, type TargetRef } from '../components/FolderTargetPicker.js';
import { UPDATES_RECIPES } from '../lib/mcp-recipes.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// Cadence presets. Minimum is one hour (mirrors the server's MIN_CADENCE guard);
// max is monthly (server clamps to 31d). The value is the interval in ms.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const TWO_WEEKS = 14 * DAY;
const MONTH = 30 * DAY;
const CADENCE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: 'Every hour', ms: HOUR },
  { label: 'Every 6 hours', ms: 6 * HOUR },
  { label: 'Every 12 hours', ms: 12 * HOUR },
  { label: 'Daily', ms: DAY },
  { label: 'Weekly', ms: WEEK },
  { label: 'Every 2 weeks', ms: TWO_WEEKS },
  { label: 'Monthly', ms: MONTH },
];
const DEFAULT_CADENCE = WEEK;

function cadenceLabel(ms: number): string {
  return CADENCE_OPTIONS.find((o) => o.ms === ms)?.label ?? `Every ${Math.round(ms / HOUR)}h`;
}

// ── Per-profile default watches ──────────────────────────────────────────────
// A curated set of recommended updates, keyed by the active subgraph's
// profile_id. They ship DISABLED — nothing is created until the user turns one
// on (which mints a real, active subscription scoped to the current folder).
interface UpdatePreset {
  label: string;
  topic: string;
  cadence_ms: number;
  medium: UpdateMedium;
  approval_mode?: UpdateApprovalMode;
}

const PROFILE_LABELS: Record<string, string> = {
  founding: 'Founding team',
  product: 'Product',
  marketing: 'Marketing',
  marketing_compliance: 'Marketing compliance',
  designer: 'Design',
  program: 'Program',
};

const DEFAULT_UPDATE_PRESETS: Record<string, UpdatePreset[]> = {
  product: [
    {
      label: 'Share shipped features to Slack',
      topic: 'Newly shipped features, releases, and product changes',
      cadence_ms: TWO_WEEKS,
      medium: 'slack',
    },
    {
      label: 'Monthly competitive report',
      topic: 'Competitor moves and updated competitive analysis',
      cadence_ms: MONTH,
      medium: 'slack',
    },
  ],
  marketing: [
    {
      label: 'Share launched campaigns to Slack',
      topic: 'New marketing campaigns and published content',
      cadence_ms: TWO_WEEKS,
      medium: 'slack',
    },
    {
      label: 'Monthly messaging & positioning digest',
      topic: 'Brand messaging, positioning, and voice updates',
      cadence_ms: MONTH,
      medium: 'email',
    },
  ],
  designer: [
    {
      label: 'Design decisions digest',
      topic: 'Design decisions, patterns, and visual-language updates',
      cadence_ms: TWO_WEEKS,
      medium: 'slack',
    },
  ],
};

// Fallback for profiles without a bespoke set (founding, program, …).
const GENERIC_UPDATE_PRESETS: UpdatePreset[] = [
  {
    label: 'Weekly decisions digest',
    topic: 'Key decisions and strategy changes in this directory',
    cadence_ms: WEEK,
    medium: 'email',
  },
  {
    label: 'Monthly vault changes',
    topic: 'New sources and major changes to the vault',
    cadence_ms: MONTH,
    medium: 'email',
  },
];

function presetsForProfile(profileId: string | null): UpdatePreset[] {
  if (profileId && DEFAULT_UPDATE_PRESETS[profileId]) return DEFAULT_UPDATE_PRESETS[profileId];
  return GENERIC_UPDATE_PRESETS;
}

// Recommended broadcasts for the 'give' agent. Same shape, but the topic is
// about the OWNER's work — that's what the agent reports on.
const GIVE_UPDATE_PRESETS: UpdatePreset[] = [
  {
    label: 'Weekly “what I shipped”',
    topic: 'What I shipped, finished, or moved forward in my own work',
    cadence_ms: WEEK,
    medium: 'email',
    approval_mode: 'review',
  },
  {
    label: 'Decisions I made',
    topic: 'Decisions I made and the reasoning behind them',
    cadence_ms: TWO_WEEKS,
    medium: 'email',
    approval_mode: 'review',
  },
];

// ── The two agents ───────────────────────────────────────────────────────────
// 'get' is the collab agent (Get updates): I follow a topic across the team's
// folders and the update comes to me. 'give' is the work agent (Give updates):
// I report on MY OWN workspace (every folder in it) and broadcast it to
// teammates. Identical machinery — same watches, same scheduler, same
// deliveries — so this one component renders both. They differ only in copy,
// in who the update goes to (one address vs. a saved list), and in scope: a
// 'give' watch is pinned to the caller's workspace server-side (never a
// teammate's), which is what makes it a work agent and not a collab one —
// there's no folder picker because the caller never chooses one.
interface ModeConfig {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  blurb: string;
  newLabel: string;
  formTitle: string;
  emptyWatches: string;
  emptyDeliveries: string;
  recommendedBlurb: string;
}

const MODE: Record<UpdateKind, ModeConfig> = {
  get: {
    icon: <BellRing className="size-3.5" />,
    eyebrow: 'Updates',
    title: 'Stay posted on what moves',
    blurb:
      'Describe a topic; we watch this directory and send a synthesized, cited update on your cadence.',
    newLabel: 'New update',
    formTitle: 'update',
    emptyWatches: 'No watches yet. Create one to start receiving updates.',
    emptyDeliveries:
      'Nothing delivered yet. Updates appear here once a watch runs and finds a topical change.',
    recommendedBlurb: "Suggested watches for this directory. They're off until you enable them.",
  },
  give: {
    icon: <Megaphone className="size-3.5" />,
    eyebrow: 'Give updates',
    title: 'Keep your team posted on your work',
    blurb:
      'Describe what to report on; we watch your own directory and send your teammates a synthesized, cited update on your cadence — so you never write a status report again.',
    newLabel: 'New broadcast',
    formTitle: 'broadcast',
    emptyWatches: 'No broadcasts yet. Create one to start keeping your team posted.',
    emptyDeliveries:
      'Nothing sent yet. Your updates appear here once a broadcast runs and finds something to report.',
    recommendedBlurb: "Suggested broadcasts about your work. They're off until you enable them.",
  },
};

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  const day = 86_400_000;
  if (abs < day) {
    const h = Math.round(abs / HOUR);
    const rel = h <= 1 ? 'about an hour' : `${h}h`;
    return diff >= 0 ? `in ${rel}` : `${rel} ago`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function windowLabel(from: string | null, to: string): string {
  const f = from ? new Date(from) : null;
  const t = new Date(to);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return f ? `${fmt(f)} → ${fmt(t)}` : `through ${fmt(t)}`;
}

interface FormState {
  topic: string;
  cadence_ms: number;
  medium: UpdateMedium;
  destination: string;
  approval_mode: UpdateApprovalMode;
  // Watch scope ('get' only): this folder (default) plus any teammate/folder
  // references. A 'give' watch always spans the whole workspace server-side.
  includeSelf: boolean;
  targetRefs: TargetRef[];
  // Broadcast recipients ('give' only) — the addresses this update is sent to.
  recipients: string[];
}

const EMPTY_FORM: FormState = {
  topic: '',
  cadence_ms: DEFAULT_CADENCE,
  medium: 'email',
  destination: '',
  approval_mode: 'autonomous',
  includeSelf: true,
  targetRefs: [],
  recipients: [],
};

/** Recipients ride `destination` as a comma-separated list. */
const splitRecipients = (destination: string | null): string[] =>
  (destination ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Updates({
  wsId,
  mode = 'get',
  onPendingMutate,
}: {
  wsId: string;
  // Which agent this view is: 'get' (collab — updates come to me) or 'give'
  // (work — I broadcast updates about my own folder to teammates).
  mode?: UpdateKind;
  // Called after an action that changes the pending-approval count so the shell
  // can refresh its nav badge (create in review mode, approve, discard).
  onPendingMutate?: () => void;
}) {
  const isGive = mode === 'give';
  const copy = MODE[mode];
  const [subs, setSubs] = useState<UpdateSubscription[] | null>(null);
  const [deliveries, setDeliveries] = useState<UpdateDelivery[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // formFor: 'new' opens the create form; a sub id opens an edit form; null closed.
  const [formFor, setFormFor] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState<UpdateDelivery | null>(null);
  // profile_id of the active subgraph — drives the recommended-watches catalog.
  const [profileId, setProfileId] = useState<string | null>(null);
  // Saved recipient lists ('give' only) — reusable audiences.
  const [lists, setLists] = useState<RecipientList[]>([]);
  // The pending "save this list as…" name, or null when not naming one.
  const [listName, setListName] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ subscriptions }, { deliveries: d }] = await Promise.all([
        api.listUpdates(wsId, mode),
        api.listUpdateDeliveries(wsId),
      ]);
      setSubs(subscriptions);
      // Deliveries come back across every watch I own, so keep only the ones
      // belonging to THIS agent's watches — a broadcast I sent my team has no
      // business showing up in my own topic feed, or vice versa.
      const mine = new Set(subscriptions.map((s) => s.id));
      setDeliveries(d.filter((x) => mine.has(x.subscription_id)));
    } catch (err) {
      toast.error(`Couldn't load updates: ${(err as Error).message}`);
      setSubs([]);
      setDeliveries([]);
    }
  }, [wsId, mode]);

  const loadLists = useCallback(async () => {
    if (!isGive) return;
    try {
      setLists((await api.listRecipientLists(wsId)).lists);
    } catch {
      setLists([]); // saved lists are a convenience — never block the form
    }
  }, [wsId, isGive]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    void load();
  }, [load]);

  // The active subgraph's profile drives the recommended-watches catalog. (The
  // folder/teammate options for the picker are loaded inside FolderTargetPicker.)
  useEffect(() => {
    api
      .getProfile(wsId)
      .then((r) => setProfileId(r.profile_id))
      .catch(() => setProfileId(null));
  }, [wsId]);

  const addRef = (ref: string, label?: string) => {
    const r = ref.trim();
    if (!r) return;
    setForm((f) =>
      f.targetRefs.some((t) => t.ref === r) ? f : { ...f, targetRefs: [...f.targetRefs, { ref: r, label: label ?? r }] },
    );
  };
  const removeRef = (ref: string) =>
    setForm((f) => ({ ...f, targetRefs: f.targetRefs.filter((t) => t.ref !== ref) }));

  // Recipients are added one address at a time, or many at once — pasting a
  // comma/space/newline-separated block splits into chips rather than making
  // one unusable address.
  const addRecipients = (raw: string) => {
    const parts = raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const bad = parts.filter((p) => !EMAIL_RE.test(p));
    if (bad.length > 0) {
      toast.error(`Not an email address: ${bad.join(', ')}`);
      return;
    }
    setForm((f) => ({ ...f, recipients: [...new Set([...f.recipients, ...parts])] }));
  };
  const removeRecipient = (addr: string) =>
    setForm((f) => ({ ...f, recipients: f.recipients.filter((r) => r !== addr) }));

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const openNew = () => {
    // A broadcast goes out to teammates under your name, so it defaults to
    // holding for your approval — you see what they'll see before it sends.
    setForm({ ...EMPTY_FORM, approval_mode: isGive ? 'review' : 'autonomous' });
    setListName(null);
    setFormFor('new');
  };
  const openEdit = (s: UpdateSubscription) => {
    // Targets are stored as resolved (workspace, subgraph) pairs, not the
    // references they came from, so editing starts with the scope untouched:
    // only if the user changes it do we re-resolve and replace.
    setForm({
      topic: s.topic,
      cadence_ms: s.cadence_ms,
      medium: s.medium,
      destination: isGive ? '' : (s.destination ?? ''),
      approval_mode: s.approval_mode,
      includeSelf: true,
      targetRefs: [],
      recipients: isGive ? splitRecipients(s.destination) : [],
    });
    setListName(null);
    setFormFor(s.id);
  };

  const submitForm = async () => {
    if (!form.topic.trim()) {
      toast.error(isGive ? 'Say what to report on.' : 'Give the watch a topic.');
      return;
    }
    if (isGive && form.recipients.length === 0) {
      toast.error('Add at least one teammate to send this to.');
      return;
    }
    if (!isGive && !form.includeSelf && form.targetRefs.length === 0) {
      toast.error('Pick at least one directory or teammate to watch.');
      return;
    }
    setSaving(true);
    try {
      // Only send target_refs when the scope differs from the plain default
      // (this folder). Refs = this folder (as its id) + any added references.
      // A 'give' watch never sends them: it's pinned to this folder server-side.
      const refs = [...(form.includeSelf ? [wsId] : []), ...form.targetRefs.map((t) => t.ref)];
      const scopeChanged = !isGive && (form.targetRefs.length > 0 || !form.includeSelf);
      const body = {
        topic: form.topic.trim(),
        cadence_ms: form.cadence_ms,
        medium: form.medium,
        approval_mode: form.approval_mode,
        ...(isGive
          ? { kind: 'give' as const, recipients: form.recipients }
          : { destination: form.destination.trim() || null }),
        ...(scopeChanged ? { target_refs: refs } : {}),
      };
      if (formFor === 'new') {
        await api.createUpdate(wsId, body);
        toast.success(
          form.approval_mode === 'review'
            ? `${isGive ? 'Broadcast' : 'Watch'} created — your first update is ready for your approval.`
            : `${isGive ? 'Broadcast' : 'Watch'} created — your first update is on its way.`,
        );
      } else if (formFor) {
        await api.editUpdate(wsId, formFor, body);
        toast.success(isGive ? 'Broadcast updated.' : 'Watch updated.');
      }
      setFormFor(null);
      await load();
      onPendingMutate?.(); // a review-mode create may add a pending item
    } catch (err) {
      toast.error(`Couldn't save: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  // Save the form's current recipients as a reusable, named list.
  const saveList = async () => {
    const name = (listName ?? '').trim();
    if (!name) {
      toast.error('Name the list.');
      return;
    }
    if (form.recipients.length === 0) {
      toast.error('Add recipients before saving the list.');
      return;
    }
    try {
      await api.saveRecipientList(wsId, { name, recipients: form.recipients });
      toast.success(
        lists.some((l) => l.name === name) ? `Updated “${name}”.` : `Saved “${name}”.`,
      );
      setListName(null);
      await loadLists();
    } catch (err) {
      toast.error(`Couldn't save the list: ${(err as Error).message}`);
    }
  };

  const removeList = async (l: RecipientList) => {
    if (!window.confirm(`Delete the saved list “${l.name}”? Broadcasts using it keep their recipients.`))
      return;
    try {
      await api.deleteRecipientList(wsId, l.id);
      await loadLists();
    } catch (err) {
      toast.error(`Couldn't delete: ${(err as Error).message}`);
    }
  };

  const toggle = async (s: UpdateSubscription) => {
    mark(s.id, true);
    try {
      if (s.status === 'active') await api.pauseUpdate(wsId, s.id);
      else await api.resumeUpdate(wsId, s.id);
      await load();
    } catch (err) {
      toast.error(`Couldn't ${s.status === 'active' ? 'pause' : 'resume'}: ${(err as Error).message}`);
    } finally {
      mark(s.id, false);
    }
  };

  const remove = async (s: UpdateSubscription) => {
    if (!window.confirm(`Remove the watch “${s.topic}”? Past updates are kept.`)) return;
    mark(s.id, true);
    try {
      await api.removeUpdate(wsId, s.id);
      toast.success('Watch removed.');
      await load();
    } catch (err) {
      toast.error(`Couldn't remove: ${(err as Error).message}`);
      mark(s.id, false);
    }
  };

  // Turn a recommended preset on: mint a real, active watch on the current
  // folder. (Presets ship off; this is the explicit enable.)
  const enablePreset = async (p: UpdatePreset) => {
    // A broadcast can't be minted from a preset alone — it has nowhere to go
    // until you say who it's for. So open the form prefilled instead.
    if (isGive) {
      setForm({
        ...EMPTY_FORM,
        topic: p.topic,
        cadence_ms: p.cadence_ms,
        medium: p.medium,
        approval_mode: p.approval_mode ?? 'review',
      });
      setListName(null);
      setFormFor('new');
      return;
    }
    mark(p.topic, true);
    try {
      await api.createUpdate(wsId, {
        topic: p.topic,
        cadence_ms: p.cadence_ms,
        medium: p.medium,
        approval_mode: p.approval_mode ?? 'autonomous',
      });
      toast.success('Watch enabled.');
      await load();
    } catch (err) {
      toast.error(`Couldn't enable: ${(err as Error).message}`);
    } finally {
      mark(p.topic, false);
    }
  };

  const openDelivery = async (d: UpdateDelivery) => {
    setReading(d); // optimistic
    try {
      const { delivery } = await api.openUpdateDelivery(wsId, d.id); // marks viewed
      setReading(delivery);
      setDeliveries((prev) => prev?.map((x) => (x.id === delivery.id ? delivery : x)) ?? prev);
    } catch {
      /* reading the optimistic copy is fine */
    }
  };

  // Approve a pending update → send it now over its medium.
  const approveDelivery = async (d: UpdateDelivery) => {
    mark(d.id, true);
    try {
      await api.sendUpdateDelivery(wsId, d.id);
      toast.success('Update sent.');
      if (reading?.id === d.id) setReading(null);
      await load();
      onPendingMutate?.();
    } catch (err) {
      toast.error(`Couldn't send: ${(err as Error).message}`);
    } finally {
      mark(d.id, false);
    }
  };

  // Discard a pending update → never sent.
  const discardDelivery = async (d: UpdateDelivery) => {
    if (!window.confirm(`Discard this pending update? It won't be sent.`)) return;
    mark(d.id, true);
    try {
      await api.discardUpdateDelivery(wsId, d.id);
      toast.success('Update discarded.');
      if (reading?.id === d.id) setReading(null);
      await load();
      onPendingMutate?.();
    } catch (err) {
      toast.error(`Couldn't discard: ${(err as Error).message}`);
    } finally {
      mark(d.id, false);
    }
  };

  // Split deliveries by lifecycle: pending (awaiting my approval) vs sent (past
  // updates). Discarded rows are hidden.
  const pending = (deliveries ?? []).filter((d) => d.status === 'pending');
  const sent = (deliveries ?? []).filter((d) => d.status === 'sent');

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-1 flex items-center gap-1.5">
            {copy.icon} {copy.eyebrow}
          </div>
          <h1 className="font-serif text-3xl">{copy.title}</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{copy.blurb}</p>
        </div>
        <Button onClick={openNew} className="shrink-0">
          <Plus className="size-4" /> {copy.newLabel}
        </Button>
      </div>

      {!isGive && <RunInClaude useCase="these updates" recipes={UPDATES_RECIPES} />}

      {/* Create / edit form */}
      {formFor && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-xl italic">
              {formFor === 'new' ? `New ${copy.formTitle}` : `Edit ${copy.formTitle}`}
            </CardTitle>
            <CardDescription>
              {isGive
                ? 'Say what to report on and who it goes to — the rest has sensible defaults.'
                : 'Type a topic — the rest has sensible defaults.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                {isGive ? 'Report on' : 'Topic'} <span className="text-pome-red">*</span>
              </label>
              <Textarea
                autoFocus
                rows={2}
                value={form.topic}
                placeholder={
                  isGive
                    ? 'what I shipped this week'
                    : 'keep me posted on competitor launches'
                }
                onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))}
              />
              {isGive && (
                <p className="text-xs text-muted-foreground">
                  Reported from across your workspace — your team sees your work, not theirs.
                </p>
              )}
            </div>

            {isGive ? (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">
                  Send to <span className="text-pome-red">*</span>
                </label>
                <RecipientsEditor
                  recipients={form.recipients}
                  lists={lists}
                  listName={listName}
                  onAdd={addRecipients}
                  onRemove={removeRecipient}
                  onUseList={(l) =>
                    setForm((f) => ({
                      ...f,
                      recipients: [...new Set([...f.recipients, ...l.recipients])],
                    }))
                  }
                  onDeleteList={removeList}
                  onStartSaveList={() => setListName('')}
                  onListNameChange={setListName}
                  onSaveList={saveList}
                  onCancelSaveList={() => setListName(null)}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Watching</label>
                <FolderTargetPicker
                  wsId={wsId}
                  includeSelf={form.includeSelf}
                  targetRefs={form.targetRefs}
                  onToggleSelf={() => setForm((f) => ({ ...f, includeSelf: !f.includeSelf }))}
                  onAdd={addRef}
                  onRemove={removeRef}
                  helper={
                    <>
                      Watch other directories you belong to, or a teammate&rsquo;s directory (you must be a
                      member).
                      {formFor !== 'new' && ' Changing this replaces the watch’s current directories.'}
                    </>
                  }
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium">Sending</label>
              <Select
                value={form.approval_mode}
                onValueChange={(v) => setForm((f) => ({ ...f, approval_mode: v as UpdateApprovalMode }))}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="autonomous">
                    <span className="inline-flex items-center gap-2">
                      <Zap className="size-3.5" /> Send autonomously
                    </span>
                  </SelectItem>
                  <SelectItem value="review">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="size-3.5" /> Ask me to approve first
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {form.approval_mode === 'review'
                  ? isGive
                    ? 'Each update waits for your approval — you see exactly what your team will get before it sends.'
                    : 'Each update waits for your approval — you’re notified here and on your channel before it sends.'
                  : isGive
                    ? 'Each update goes straight to your recipients as soon as it’s ready, without you seeing it first.'
                    : 'Each update is sent as soon as it’s ready, no approval needed.'}
              </p>
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">Cadence</label>
                <Select
                  value={String(form.cadence_ms)}
                  onValueChange={(v) => setForm((f) => ({ ...f, cadence_ms: Number(v) }))}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CADENCE_OPTIONS.map((o) => (
                      <SelectItem key={o.ms} value={String(o.ms)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* A broadcast is addressed by the recipient list above, so it
                  has no medium/destination row: it always goes out by email. */}
              {!isGive && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Send via</label>
                    <Select
                      value={form.medium}
                      onValueChange={(v) => setForm((f) => ({ ...f, medium: v as UpdateMedium }))}
                    >
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="slack">Slack</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-56 flex-1 space-y-1.5">
                    <label className="text-xs font-medium">To</label>
                    <Input
                      value={form.destination}
                      placeholder={
                        form.medium === 'slack'
                          ? 'your Slack DM (default) · or #channel'
                          : 'your account email (default)'
                      }
                      onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
                    />
                    {form.medium === 'slack' && (
                      <p className="text-xs text-muted-foreground">Requires a linked Slack account.</p>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFormFor(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={submitForm} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {formFor === 'new' ? (isGive ? 'Create broadcast' : 'Create watch') : 'Save'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommended for this profile — disabled by default */}
      {(() => {
        const presets = isGive ? GIVE_UPDATE_PRESETS : presetsForProfile(profileId);
        const enabledTopics = new Set((subs ?? []).map((s) => s.topic));
        // The 'give' presets are about your own work, not the folder's subject
        // matter, so they don't vary by profile and carry no profile label.
        const profileName = isGive ? null : (profileId && PROFILE_LABELS[profileId]) || null;
        if (presets.length === 0) return null;
        return (
          <section className="space-y-3">
            <div className="eyebrow flex items-center gap-1.5">
              <Sparkles className="size-3.5" /> Recommended{profileName ? ` for ${profileName}` : ''}
            </div>
            <p className="-mt-1 text-sm text-muted-foreground">{copy.recommendedBlurb}</p>
            <Card>
              <CardContent className="divide-y p-0">
                {presets.map((p) => {
                  const on = enabledTopics.has(p.topic);
                  const b = busy.has(p.topic);
                  return (
                    <div key={p.topic} className="flex items-start gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{p.label}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="truncate">{p.topic}</span>
                          <Badge variant="secondary" className="font-normal">
                            {cadenceLabel(p.cadence_ms)}
                          </Badge>
                          <span className="inline-flex items-center gap-1">
                            {p.medium === 'slack' ? <Hash className="size-3" /> : <Mail className="size-3" />}
                            {p.medium === 'slack' ? 'Slack' : 'email'}
                          </span>
                        </div>
                      </div>
                      {on ? (
                        <Badge className="shrink-0 gap-1 bg-flag-green/15 text-flag-green" variant="outline">
                          <Check className="size-3" /> Enabled
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => enablePreset(p)}
                          disabled={b}
                        >
                          {b && <Loader2 className="size-4 animate-spin" />}
                          {/* A broadcast still needs recipients before it can
                              exist, so its preset opens the form. */}
                          {isGive ? 'Set up' : 'Enable'}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </section>
        );
      })()}

      {/* Your watches */}
      <section className="space-y-3">
        <div className="eyebrow">{isGive ? 'Your broadcasts' : 'Your watches'}</div>
        {subs === null ? (
          <Skeleton className="h-24 w-full" />
        ) : subs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.emptyWatches}</p>
        ) : (
          <Card>
            <CardContent className="divide-y p-0">
              {subs.map((s) => {
                const b = busy.has(s.id);
                return (
                  <div key={s.id} className="flex items-start gap-3 p-4">
                    <span
                      className={`mt-1.5 size-2.5 shrink-0 rounded-full ${
                        s.status === 'active' ? 'bg-flag-green' : 'bg-muted-foreground/50'
                      }`}
                      title={s.status}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{s.topic}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <Badge variant="secondary" className="font-normal">
                          {cadenceLabel(s.cadence_ms)}
                        </Badge>
                        {/* A broadcast lists how many people it reaches (the
                            addresses themselves are on the edit form); a watch
                            names the single channel it lands on. */}
                        {isGive ? (
                          <span
                            className="inline-flex items-center gap-1"
                            title={splitRecipients(s.destination).join(', ')}
                          >
                            <Users className="size-3" />
                            {splitRecipients(s.destination).length} recipient
                            {splitRecipients(s.destination).length === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            {s.medium === 'slack' ? <Hash className="size-3" /> : <Mail className="size-3" />}
                            {s.destination ?? (s.medium === 'slack' ? 'Slack DM' : 'email')}
                          </span>
                        )}
                        <span
                          className="inline-flex items-center gap-1"
                          title={
                            s.approval_mode === 'review'
                              ? 'Updates wait for your approval before sending'
                              : 'Updates are sent automatically'
                          }
                        >
                          {s.approval_mode === 'review' ? (
                            <>
                              <ShieldCheck className="size-3" /> needs approval
                            </>
                          ) : (
                            <>
                              <Zap className="size-3" /> autonomous
                            </>
                          )}
                        </span>
                        {s.targets.length > 1 && <span>{s.targets.length} directories</span>}
                        {s.status === 'active' ? (
                          <span>next {when(s.next_run_at)}</span>
                        ) : (
                          <span>paused</span>
                        )}
                        {s.last_run_at && <span>last run {when(s.last_run_at)}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(s)} disabled={b}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => toggle(s)} disabled={b}>
                        {s.status === 'active' ? <Pause className="size-4" /> : <Play className="size-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(s)}
                        disabled={b}
                        className="text-muted-foreground hover:text-pome-red"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </section>

      {/* Pending your approval (review-mode updates held for you to send) */}
      {pending.length > 0 && (
        <section className="space-y-3">
          <div className="eyebrow flex items-center gap-1.5 text-pome-red">
            <ShieldCheck className="size-3.5" /> Pending your approval
          </div>
          <p className="-mt-1 text-sm text-muted-foreground">
            {isGive
              ? 'These updates are ready but won’t go out to your team until you approve them.'
              : 'These updates are ready but won’t send until you approve them.'}
          </p>
          <div className="space-y-3">
            {pending.map((d) => {
              const b = busy.has(d.id);
              return (
                <Card key={d.id} className="border-pome-red/30 bg-pome-red/[0.03]">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-medium">{d.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {windowLabel(d.window_from, d.window_to)}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                        {d.medium === 'slack' ? <Hash className="size-3.5" /> : <Mail className="size-3.5" />}
                        {d.medium}
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-3 max-w-prose text-sm text-muted-foreground">{d.body}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {d.cited_node_ids.slice(0, 4).map((id) => (
                        <span
                          key={id}
                          className="rounded border border-pome-red/25 bg-pome-red/5 px-1.5 py-0.5 font-mono text-[11px] text-pome-red"
                        >
                          {id}
                        </span>
                      ))}
                      <Button variant="ghost" size="sm" className="h-auto p-0 text-pome-red" onClick={() => openDelivery(d)}>
                        Read full →
                      </Button>
                      <div className="ml-auto flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => discardDelivery(d)} disabled={b}>
                          Discard
                        </Button>
                        <Button size="sm" onClick={() => approveDelivery(d)} disabled={b}>
                          {b ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                          Send now
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {/* Delivered updates */}
      <section className="space-y-3">
        <div className="eyebrow">{isGive ? 'Updates you’ve sent' : 'Delivered updates'}</div>
        {deliveries === null ? (
          <Skeleton className="h-24 w-full" />
        ) : sent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.emptyDeliveries}</p>
        ) : (
          <div className="space-y-3">
            {sent.map((d) => (
              <Card key={d.id} className="transition-colors hover:border-foreground/20">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{d.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {windowLabel(d.window_from, d.window_to)}
                    </span>
                    <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1" title="views">
                        <Eye className="size-3.5" /> {d.view_count}
                      </span>
                      <span className="inline-flex items-center gap-1" title="clicks">
                        <MousePointerClick className="size-3.5" /> {d.click_count}
                      </span>
                      <span>{d.medium}</span>
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 max-w-prose text-sm text-muted-foreground">{d.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {d.cited_node_ids.slice(0, 4).map((id) => (
                      <span
                        key={id}
                        className="rounded border border-pome-red/25 bg-pome-red/5 px-1.5 py-0.5 font-mono text-[11px] text-pome-red"
                      >
                        {id}
                      </span>
                    ))}
                    <span className="text-xs text-muted-foreground">
                      {d.change_count} change{d.change_count === 1 ? '' : 's'}
                    </span>
                    <Button
                      variant="link"
                      size="sm"
                      className="ml-auto h-auto p-0 text-pome-red"
                      onClick={() => openDelivery(d)}
                    >
                      Open →
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Read a delivered update (marks it viewed) */}
      <Dialog open={!!reading} onOpenChange={(o) => !o && setReading(null)}>
        <DialogContent className="max-w-2xl">
          {reading && (
            <>
              <DialogHeader>
                <DialogTitle className="font-serif text-2xl italic">{reading.title}</DialogTitle>
                <DialogDescription className="font-mono text-xs">
                  {windowLabel(reading.window_from, reading.window_to)} · {reading.change_count} change
                  {reading.change_count === 1 ? '' : 's'}
                </DialogDescription>
              </DialogHeader>
              <div className="max-h-[55vh] space-y-4 overflow-y-auto">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{reading.body}</p>
                {reading.cited_node_ids.length > 0 && (
                  <div>
                    <div className="eyebrow mb-1.5">Cited nodes</div>
                    <div className="flex flex-wrap gap-1.5">
                      {reading.cited_node_ids.map((id) => (
                        <span
                          key={id}
                          className="rounded border border-pome-red/25 bg-pome-red/5 px-1.5 py-0.5 font-mono text-[11px] text-pome-red"
                        >
                          {id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {reading.status === 'pending' && (
                <div className="flex items-center justify-end gap-2 border-t pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => discardDelivery(reading)}
                    disabled={busy.has(reading.id)}
                  >
                    Discard
                  </Button>
                  <Button size="sm" onClick={() => approveDelivery(reading)} disabled={busy.has(reading.id)}>
                    {busy.has(reading.id) ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    Send now
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// The 'give' agent's audience picker: who this broadcast goes to. The
// counterpart to FolderTargetPicker on the 'get' side — same chips-and-dropdown
// shape, but the chips are people, not folders. Recipients are controlled by the
// parent; the team directory and the free-type draft are owned here.
function RecipientsEditor({
  recipients,
  lists,
  listName,
  onAdd,
  onRemove,
  onUseList,
  onDeleteList,
  onStartSaveList,
  onListNameChange,
  onSaveList,
  onCancelSaveList,
}: {
  recipients: string[];
  lists: RecipientList[];
  /** The in-progress "save as" name, or null when not naming a list. */
  listName: string | null;
  onAdd: (raw: string) => void;
  onRemove: (addr: string) => void;
  onUseList: (l: RecipientList) => void;
  onDeleteList: (l: RecipientList) => void;
  onStartSaveList: () => void;
  onListNameChange: (name: string) => void;
  onSaveList: () => void;
  onCancelSaveList: () => void;
}) {
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    api
      .teamDirectory()
      .then((t) => setTeam(t.users.filter((u) => u.user_id !== t.me.user_id)))
      .catch(() => setTeam([])); // directory is a shortcut — typing still works
  }, []);

  const add = (raw: string) => {
    onAdd(raw);
    setDraft('');
  };

  // A saved list is "in use" once every address in it is already a recipient.
  const listApplied = useMemo(() => {
    const set = new Set(recipients);
    return (l: RecipientList) => l.recipients.every((r) => set.has(r));
  }, [recipients]);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {recipients.map((addr) => (
          <span
            key={addr}
            className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
          >
            {addr}
            <button type="button" onClick={() => onRemove(addr)} aria-label={`Remove ${addr}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <Plus className="size-3" /> Add teammate <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
            {lists.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[11px]">Saved lists</DropdownMenuLabel>
                {lists.map((l) => (
                  <DropdownMenuItem
                    key={l.id}
                    disabled={listApplied(l)}
                    onSelect={() => onUseList(l)}
                    className="justify-between"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Users className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{l.name}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {l.recipients.length}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Delete list ${l.name}`}
                      className="shrink-0 text-muted-foreground hover:text-pome-red"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onDeleteList(l);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            {team.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[11px]">Teammates</DropdownMenuLabel>
                {team
                  .filter((u) => !recipients.includes(u.email))
                  .map((u) => (
                    <DropdownMenuItem key={u.user_id} onSelect={() => add(u.email)}>
                      <UserRound className="size-3.5 text-muted-foreground" />{' '}
                      {u.display_name ?? u.email}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
              </>
            )}
            <div className="px-2 py-1.5">
              <div className="mb-1 text-[11px] text-muted-foreground">Or an email address</div>
              <div className="flex gap-1">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add(draft);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="name@company.com"
                  className="h-7 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  onClick={() => add(draft)}
                >
                  Add
                </Button>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Save the current recipients as a reusable list. */}
      {listName === null ? (
        <p className="text-xs text-muted-foreground">
          They get the update by email.{' '}
          {recipients.length > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-pome-red hover:underline"
              onClick={onStartSaveList}
            >
              <Bookmark className="size-3" /> Save these {recipients.length} as a list
            </button>
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            autoFocus
            value={listName}
            onChange={(e) => onListNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onSaveList();
              }
              if (e.key === 'Escape') onCancelSaveList();
            }}
            placeholder="Name this list, e.g. “Design team”"
            className="h-7 w-56 text-xs"
          />
          <Button type="button" size="sm" variant="secondary" className="h-7" onClick={onSaveList}>
            Save list
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancelSaveList}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
