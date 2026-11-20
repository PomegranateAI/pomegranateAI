import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, FileText, Image as ImageIcon, Loader2, Mic, Search, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import type { ContextProfile, MediaJob, MediaReaderBinding } from '../api.js';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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

/**
 * The subfolder's data agents — ONE panel for both stages, where there used
 * to be two unrelated surfaces stacked on top of each other (an "Audio &
 * image data agents" <details> and a separate emerald "data agent attached"
 * strip). They were never two features: they are two stages of the same
 * pipeline, and a folder is meant to run several at once —
 *
 *   media (audio/image → text)  →  text  →  capture (text → entries)
 *
 * so they belong in one list, multi-select, with the ordering stated rather
 * than left to be inferred from two boxes' vertical position.
 *
 * Multi-select is per STAGE, and that asymmetry is the backend's, not a UI
 * choice: media readers live in `data_agent_media_bindings`, keyed by
 * capability, so audio and image coexist freely (and coexist with a capture
 * agent). The capture stage is one binding per subfolder — `subfolder_data_
 * agents`' primary key enforces it structurally (spec-data-agents §6) —
 * because a capture template IS the folder's taxonomy, and two taxonomies
 * over one document is a product question nobody has answered. So: readers
 * toggle independently; picking a capture template swaps the current one.
 */

type ActiveDataAgent = {
  template_id: string;
  template: ContextProfile;
  cadence: 'once' | 'per_document' | 'scheduled';
  cadence_ms: number | null;
};
export type TemplateCatalogEntry = {
  id: string;
  name: string;
  standard: boolean;
  profile: ContextProfile;
  active_subfolders: number;
};

const READERS = [
  {
    capability: 'audio' as const,
    label: 'Transcribe audio',
    blurb: 'Voice notes and audio files become text before anything else reads them.',
    Icon: Mic,
  },
  {
    capability: 'image' as const,
    label: 'Read images',
    blurb: 'Pulls the visible text out of an image and describes what it shows.',
    Icon: ImageIcon,
  },
];

export function DataAgentsPanel({
  wsId,
  subgraphId,
  onChanged,
  reportStatus,
  hasReport,
  onOpenReport,
}: {
  wsId: string;
  subgraphId: string;
  reportStatus: string;
  hasReport: boolean;
  onOpenReport: () => void;
  /** A backfill run rewrites the subfolder's whole node set; Library has no
   *  way to know that on its own, so this is what tells it to refetch. */
  onChanged?: () => void;
}) {
  // Closed by default — the panel is a setting, not the folder's content.
  const [open, setOpen] = useState(false);
  const [reportSelected, setReportSelected] = useState(false);

  // ---- media stage ----
  const [bindings, setBindings] = useState<MediaReaderBinding[]>([]);
  const [canManageReaders, setCanManageReaders] = useState(false);
  const [readerBusy, setReaderBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<MediaJob[]>([]);

  // ---- capture stage ----
  const [active, setActive] = useState<ActiveDataAgent | null | undefined>(undefined); // undefined = loading
  const [pickerOpen, setPickerOpen] = useState(false);
  const [catalog, setCatalog] = useState<TemplateCatalogEntry[] | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .mediaReaders(wsId, subgraphId)
      .then((r) => {
        if (!live) return;
        setBindings(r.bindings);
        setCanManageReaders(r.can_manage);
      })
      .catch(() => {
        if (live) setError('Could not load media readers.');
      });
    return () => {
      live = false;
    };
  }, [wsId, subgraphId]);

  const anyReaderOn = bindings.some((b) => !!b.enabled);
  useEffect(() => {
    // Only poll while there's a reader that could actually produce a job.
    if (!anyReaderOn) return;
    let live = true;
    const refresh = () =>
      api
        .mediaJobs(wsId)
        .then((r) => {
          if (live) setJobs(r.jobs.filter((j) => j.subgraph_id === subgraphId));
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [wsId, subgraphId, anyReaderOn]);

  const loadActive = useCallback(() => {
    api
      .getActiveDataAgent(wsId, subgraphId)
      .then((r) => setActive(r.active))
      .catch(() => setActive(null));
  }, [wsId, subgraphId]);
  useEffect(() => {
    setActive(undefined);
    loadActive();
  }, [loadActive]);

  async function saveReader(
    capability: 'audio' | 'image',
    enabled: boolean,
    config: MediaReaderBinding['config'],
  ) {
    setReaderBusy(true);
    setError('');
    try {
      await api.setMediaReader(wsId, subgraphId, capability, { enabled, config });
      const r = await api.mediaReaders(wsId, subgraphId);
      setBindings(r.bindings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReaderBusy(false);
    }
  }

  async function retry(id: string) {
    setReaderBusy(true);
    setError('');
    try {
      await api.retryMediaJob(wsId, id);
      const r = await api.mediaJobs(wsId);
      setJobs(r.jobs.filter((j) => j.subgraph_id === subgraphId));
    } catch {
      setError('Processing failed. Your original is retained; you can retry again.');
    } finally {
      setReaderBusy(false);
    }
  }

  const openPicker = () => {
    setPickerOpen(true);
    if (!catalog) {
      api
        .listDataAgentTemplates(wsId)
        .then((r) => setCatalog(r.templates))
        .catch(() => setCatalog([]));
    }
  };

  async function attach(templateId: string, run: 'new_only' | 'backfill') {
    setCaptureBusy(true);
    try {
      // 'once' and 'scheduled' cadences never had a runner behind them —
      // 'per_document' is the only cadence that has ever done anything.
      const r = await api.attachDataAgent(wsId, subgraphId, {
        template_id: templateId,
        cadence: 'per_document',
        run,
      });
      if (r.backfill) {
        toast.success('Capture agent attached and run', {
          description: `${r.backfill.documents} document${r.backfill.documents === 1 ? '' : 's'} re-processed, ${r.backfill.archived} prior ${r.backfill.archived === 1 ? 'entry' : 'entries'} archived.`,
        });
      } else {
        toast.success('Capture agent attached', {
          description: 'It will catch every new document from here.',
        });
      }
      setPickerOpen(false);
      loadActive();
      onChanged?.();
    } catch (e: any) {
      toast.error('Could not attach', { description: e.message });
    } finally {
      setCaptureBusy(false);
    }
  }

  async function detach() {
    setCaptureBusy(true);
    try {
      await api.detachDataAgent(wsId, subgraphId);
      toast.success('Capture agent detached', {
        description: 'Future documents become plain notes again.',
      });
      loadActive();
      onChanged?.();
    } catch (e: any) {
      toast.error('Could not detach', { description: e.message });
    } finally {
      setCaptureBusy(false);
    }
  }

  const attachedCount = bindings.filter((b) => !!b.enabled).length + (active ? 1 : 0);
  const readersDisabled = !canManageReaders || readerBusy;

  return (
    <div className="rounded-lg border bg-card shadow-soft">
      {/* Collapsed to its title (same disclosure move as Get started's Chrome
       *  row): in the Library the notes are the job, and this panel is a
       *  setting you touch once and then leave alone — open it stacked and
       *  it pushes the folder's actual content below the fold. The count
       *  stays on the closed row, so "is anything running here?" is still
       *  answerable without a click; everything else waits for one. */}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          <Sparkles className="size-4 shrink-0 text-pome-red" aria-hidden />
          <span className="text-sm font-medium">Data agents</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {attachedCount === 0 ? 'none attached' : `${attachedCount} attached`}
          </span>
          <ChevronDown
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
        {open && (
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={captureBusy} onClick={openPicker}>
            {active ? 'Change capture agent' : 'Attach an agent'}
          </Button>
        </div>
        )}
      </div>

      {open && (
        <>
      <div className="divide-y border-t">
        {READERS.map(({ capability, label, blurb, Icon }) => {
          const binding = bindings.find((b) => b.capability === capability);
          const enabled = !!binding?.enabled;
          const config = binding?.config ?? { output: 'capture' as const };
          return (
            <AgentRow
              key={capability}
              active={enabled}
              icon={<Icon className="size-4" />}
              title={label}
              stage="reads media"
              blurb={blurb}
              control={
                <Switch
                  checked={enabled}
                  disabled={readersDisabled}
                  aria-label={label}
                  onCheckedChange={(next) => void saveReader(capability, next, config)}
                />
              }
            >
              {enabled && (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Result</span>
                    <select
                      aria-label={`${capability} output`}
                      className="rounded border bg-background p-1 text-xs"
                      disabled={readersDisabled}
                      value={config.output}
                      onChange={(e) =>
                        void saveReader(capability, enabled, {
                          ...config,
                          output: e.target.value as 'capture' | 'log',
                        })
                      }
                    >
                      <option value="capture">Hand to the capture agent</option>
                      <option value="log">Log the extracted text</option>
                    </select>
                  </label>
                  {capability === 'audio' && (
                    <label className="flex items-center gap-1.5">
                      <span className="text-muted-foreground">Language</span>
                      <input
                        key={config.language ?? ''}
                        aria-label="Audio language"
                        className="w-24 rounded border bg-background p-1"
                        placeholder="English"
                        defaultValue={config.language ?? ''}
                        disabled={readersDisabled}
                        onBlur={(e) => {
                          const language = e.target.value.trim() || undefined;
                          if (language !== config.language)
                            void saveReader(capability, enabled, { ...config, language });
                        }}
                      />
                    </label>
                  )}
                </div>
              )}
            </AgentRow>
          );
        })}

        <AgentRow
          active={reportSelected}
          icon={<FileText className="size-4" />}
          title="Generate Report"
          stage="on demand"
          blurb="Creates a report from this subfolder’s knowledge."
          control={
            <Switch
              checked={reportSelected}
              aria-label="Generate Report"
              onCheckedChange={setReportSelected}
            />
          }
        >
          {reportSelected && (
            <div className="mt-2 flex items-center gap-3">
              <Button size="sm" variant="outline" onClick={onOpenReport}>
                {hasReport ? 'Open report' : 'Create report'}
              </Button>
              <span className="text-xs text-muted-foreground">{reportStatus}</span>
            </div>
          )}
        </AgentRow>

        {active !== undefined && (
          <AgentRow
            active={!!active}
            icon={<span aria-hidden>◆</span>}
            title={active ? active.template.name : 'No capture agent'}
            stage="structures entries"
            blurb={
              active
                ? active.template.kinds.map((k) => k.label_plural).join(' · ')
                : 'Every document becomes a plain note.'
            }
            control={
              active ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
                    onClick={openPicker}
                  >
                    Change
                  </button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button
                        type="button"
                        disabled={captureBusy}
                        className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-40"
                      >
                        Detach
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Detach "{active.template.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Every entry it's already created stays, unchanged. Future documents in this
                          folder become plain notes again.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={detach}>Detach</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs font-medium text-pome-red hover:underline"
                  onClick={openPicker}
                >
                  Attach one
                </button>
              )
            }
          />
        )}

      </div>

      <div className="space-y-1 border-t px-3.5 py-2.5 text-xs text-muted-foreground">
        <p>
          <>
            Attached agents run in order:{' '}
            <span className="font-medium">media → text → capture</span>. Readers combine freely;
            the capture agent is one at a time.
          </>
        </p>
        <p>Original files stay private to whoever uploaded them until shared from a node.</p>
      </div>

      {jobs.length > 0 && (
        <div className="border-t px-3.5 py-2.5">
          <p className="eyebrow">Your recent media</p>
          {jobs.slice(0, 10).map((job) => (
            <div key={job.id} className="mt-1 flex items-center gap-2 text-xs">
              <span className="truncate">{job.name}</span>
              <span className="text-muted-foreground">
                {job.status === 'succeeded'
                  ? 'Filed'
                  : job.status === 'failed'
                    ? 'Needs retry'
                    : 'Processing'}
              </span>
              {job.status === 'failed' && (
                <button className="underline" disabled={readerBusy} onClick={() => void retry(job.id)}>
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="border-t px-3.5 py-2 text-xs text-red-600">
          {error}
        </p>
      )}
        </>
      )}

      <TemplatePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        catalog={catalog}
        busy={captureBusy}
        onAttach={attach}
      />
    </div>
  );
}

/** One agent in the list — same shape whichever stage it belongs to, so the
 *  panel reads as one roster instead of two settings groups in a trenchcoat.
 *  Attached rows carry a left accent rather than a solid fill: with several
 *  of them on at once, three saturated bars stop reading as a mode. */
function AgentRow({
  active,
  icon,
  title,
  stage,
  blurb,
  control,
  children,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  stage: string;
  blurb: string;
  control: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn('px-3.5 py-2.5', active && 'border-l-2 border-l-emerald-600 bg-emerald-600/5')}>
      <div className="flex flex-wrap items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border',
            active ? 'border-emerald-600/30 text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground',
          )}
          aria-hidden
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-sm', active ? 'font-semibold' : 'text-muted-foreground')}>{title}</span>
            <span className="rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {stage}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{blurb}</p>
          {children}
        </div>
        <div className="ml-auto flex shrink-0 items-center">{control}</div>
      </div>
    </div>
  );
}

/**
 * A searchable, scrollable, one-per-row picker over the capture-template
 * catalog (spec §4.2's "Browse all templates").
 *
 * Two steps, not click-to-commit: picking a row only selects it (matching
 * the platform's own dialog convention — Setup's template editor, e.g. —
 * of an explicit confirm action, not an instant side effect from a single
 * click). The footer then asks how to run it: on new documents only
 * (default — nothing here changes) or immediately on everything already
 * in this subfolder, which also archives what's currently active.
 */
function TemplatePickerDialog({
  open,
  onOpenChange,
  catalog,
  busy,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: TemplateCatalogEntry[] | null;
  busy: boolean;
  onAttach: (templateId: string, run: 'new_only' | 'backfill') => void;
}) {
  const [q, setQ] = useState('');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [run, setRun] = useState<'new_only' | 'backfill'>('new_only');
  useEffect(() => {
    if (open) {
      setQ('');
      setPickedId(null);
      setRun('new_only');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = catalog ?? [];
    if (!query) return list;
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(query) ||
        t.profile.kinds.some(
          (k) => k.label.toLowerCase().includes(query) || k.label_plural.toLowerCase().includes(query),
        ),
    );
  }, [catalog, q]);
  const picked = (catalog ?? []).find((t) => t.id === pickedId) ?? null;

  // While the backfill pipeline is actually running (real capture calls
  // against every document already in the subfolder), the dialog switches to
  // a dedicated transient state and can't be dismissed: closing it wouldn't
  // stop the request, only hide that it's still in flight.
  const running = busy && run === 'backfill';

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className="flex max-h-[85vh] w-[95vw] max-w-lg flex-col overflow-hidden p-0"
        onInteractOutside={(e) => busy && e.preventDefault()}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
      >
        {running ? (
          <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
            <Loader2 className="size-7 animate-spin text-pome-red" />
            <p className="text-sm font-medium">Running {picked?.name ?? 'the agent'} on this folder…</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Re-processing every document already here and archiving what's currently active. This
              can take a while — don't close this window.
            </p>
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-5 py-4">
              <DialogTitle>Choose a capture agent</DialogTitle>
              <DialogDescription>
                Standard templates, plus any this workspace has made. One at a time — this replaces
                whatever capture agent is attached now. Media readers stay as they are.
              </DialogDescription>
            </DialogHeader>
            <div className="border-b px-5 py-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  className="pl-8"
                  placeholder="Search templates…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {catalog === null ? (
                <p className="p-3 text-sm text-muted-foreground">Loading…</p>
              ) : filtered.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {q.trim() ? `No templates match "${q.trim()}".` : 'No templates yet.'}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {filtered.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      disabled={busy}
                      onClick={() => setPickedId(t.id)}
                      aria-pressed={pickedId === t.id}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-lg border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50',
                        pickedId === t.id ? 'border-pome-red bg-pome-red/5' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        {t.standard && (
                          <span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                            standard
                          </span>
                        )}
                        {t.active_subfolders > 0 && (
                          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                            used by {t.active_subfolders}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t.profile.kinds.map((k) => k.label_plural).join(' · ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3 border-t bg-muted/30 px-5 py-4">
              <div className="space-y-1">
                <span className="eyebrow">Run on</span>
                <div className="flex gap-2">
                  {(['new_only', 'backfill'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRun(r)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs',
                        run === r
                          ? 'border-transparent bg-pome-red text-white'
                          : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {r === 'new_only' ? 'New documents only' : 'All documents, right now'}
                    </button>
                  ))}
                </div>
                {run === 'backfill' && (
                  <p className="pt-0.5 text-xs text-muted-foreground">
                    Re-runs on every document already in this folder and archives whatever is
                    currently active here — the new entries replace it, they don't sit alongside it.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy || !picked} onClick={() => picked && onAttach(picked.id, run)}>
                  {busy
                    ? run === 'backfill'
                      ? 'Running…'
                      : 'Attaching…'
                    : run === 'backfill'
                      ? 'Attach and run now'
                      : 'Attach'}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
