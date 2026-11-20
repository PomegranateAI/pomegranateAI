import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, ScrollText, FlaskConical, Play, Check } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Automation, type AutomationRun, type RuleTestCandidate, type AutomationTestResult } from '../api.js';
import { AUDIENCE_TIERS, AUDIENCE_SHORT, type Audience } from '../audience.js';
import { AppsIngest, APPS, AppIcon } from './Sources.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TestMode = 'source' | 'use' | 'ingestion';

// Derived from the model's classification (target/phase); decides which
// preview surface the rule gets. Mirrors the server's ruleTestMode.
function testModeOf(automation: Automation): TestMode {
  if (automation.target === 'source' || automation.target === 'both') return 'source';
  if (automation.phases.includes('use')) return 'use';
  return 'ingestion';
}

// Plain-language, read-only summary of the model-inferred behaviour.
function describeAutomation(automation: Automation): string {
  const action =
    automation.target === 'source'
      ? 'scrubs the stored document'
      : automation.target === 'both'
        ? 'scrubs the stored document and the extracted notes'
        : 'shapes or redacts the extracted notes';
  const when =
    automation.phases.includes('store') && automation.phases.includes('use')
      ? 'when storing and sharing'
      : automation.phases.includes('use')
        ? 'when sharing'
        : 'when storing';
  return `Pomegranate ${action}, ${when}.`;
}

// A compact multi-select popover for "Apply this automation for" (the three
// tiers, all selected by default).
function ScopeMultiSelect({
  value,
  onChange,
  disabled,
}: {
  value: Audience[];
  onChange: (v: Audience[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (a: Audience) =>
    onChange(value.includes(a) ? value.filter((x) => x !== a) : [...value, a]);
  const label =
    value.length === AUDIENCE_TIERS.length
      ? 'everyone'
      : value.length === 0
        ? 'no one'
        : AUDIENCE_TIERS.filter((t) => value.includes(t.key))
            .map((t) => AUDIENCE_SHORT[t.key])
            .join(', ');
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 disabled:opacity-50"
      >
        {label} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-50 mt-1 w-60 rounded-lg border border-border bg-popover p-1 shadow-xl">
            {AUDIENCE_TIERS.map((t) => {
              const on = value.includes(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => toggle(t.key)}
                >
                  <span
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                    }`}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <span>
                    <span className="font-medium">{t.label}</span>
                    <span className="block text-xs text-muted-foreground">{t.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </span>
  );
}

// Content rules: today's shape/use-phase rules, re-homed onto the unified
// automations table (kind='shape').
function ContentRulesTab({ wsId }: { wsId: string }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [testOpen, setTestOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { automations: rs, can_edit } = await api.listAutomations(wsId, 'shape');
      setAutomations(rs);
      setCanEdit(can_edit);
    } catch (err) {
      toast.error(`Couldn't load automations: ${(err as Error).message}`);
      setAutomations([]);
    }
  }, [wsId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const persist = useCallback(
    async (automation: Automation) => {
      mark(automation.id, true);
      try {
        const { automation: saved } = await api.saveAutomation(wsId, {
          id: automation.id,
          instructions: automation.instructions ?? '',
          scopes: automation.scopes,
          enabled: automation.enabled,
          sort_order: automation.sort_order,
        });
        setAutomations((prev) => (prev ?? []).map((a) => (a.id === saved.id ? saved : a)));
      } catch (err) {
        toast.error(`Couldn't save: ${(err as Error).message}`);
        void load();
      } finally {
        mark(automation.id, false);
      }
    },
    [wsId, load],
  );

  const update = useCallback(
    (id: string, patch: Partial<Automation>) => {
      setAutomations((prev) => {
        const next = (prev ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a));
        const target = next.find((a) => a.id === id);
        if (target) void persist(target);
        return next;
      });
    },
    [persist],
  );

  const addAutomation = useCallback(async () => {
    try {
      // New automations apply for everyone by default.
      const { automation } = await api.saveAutomation(wsId, {
        instructions: '',
        scopes: ['only_me', 'private', 'team'],
        sort_order: automations?.length ?? 0,
      });
      setAutomations((prev) => [...(prev ?? []), automation]);
    } catch (err) {
      toast.error(`Couldn't add automation: ${(err as Error).message}`);
    }
  }, [wsId, automations]);

  const removeAutomation = useCallback(
    async (id: string) => {
      setAutomations((prev) => (prev ?? []).filter((a) => a.id !== id));
      try {
        await api.deleteAutomation(wsId, id);
      } catch (err) {
        toast.error(`Couldn't delete: ${(err as Error).message}`);
        void load();
      }
    },
    [wsId, load],
  );

  const activeCount = (automations ?? []).filter((a) => a.enabled).length;
  const countLabel =
    automations === null
      ? 'Loading…'
      : automations.length === 0
        ? 'No content rules yet'
        : `${activeCount} active rule${activeCount === 1 ? '' : 's'} of ${automations.length}`;

  return (
    <div className="space-y-6">
      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="text-lg">Content rules</CardTitle>
          <CardDescription>{countLabel}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Write plain-language rules for what gets hidden, redacted, or filtered out of your
            documents — and choose who each rule applies to. Pomegranate works out the rest — when
            the rule applies and what it touches.
            {!canEdit && ' Only the workspace owner can edit rules.'}
          </p>
          {canEdit && (
            <Button onClick={() => void addAutomation()} variant="outline" size="sm">
              <Plus className="size-4" /> Add rule
            </Button>
          )}
        </CardContent>
      </Card>

      {automations === null ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : automations.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">No content rules yet — add one below.</p>
      ) : (
        <div className="space-y-4">
          {automations.map((automation) => (
            <Card key={automation.id} className="shadow-soft">
              <CardContent className="space-y-3 pt-6">
                <div className="flex items-start gap-3">
                  <ScrollText className="size-5 mt-1 text-muted-foreground shrink-0" />
                  <Textarea
                    className="flex-1"
                    placeholder="Describe the rule, e.g. “Remove PII from customer call transcripts”"
                    defaultValue={automation.instructions ?? ''}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      if (e.target.value !== automation.instructions)
                        update(automation.id, { instructions: e.target.value });
                    }}
                  />
                  {busy.has(automation.id) && (
                    <Loader2 className="size-4 mt-1 animate-spin text-muted-foreground" />
                  )}
                </div>

                {!automation.instructions?.trim() && (
                  <p className="pl-8 text-xs text-muted-foreground">
                    Describe your rule above, then use Preview to see it before turning it on.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pl-8">
                  <div className="flex items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Apply this rule for
                    </span>
                    <ScopeMultiSelect
                      value={automation.scopes as Audience[]}
                      disabled={!canEdit}
                      onChange={(v) => update(automation.id, { scopes: v })}
                    />
                  </div>
                  {automation.instructions?.trim() && (
                    <span className="text-xs text-muted-foreground italic">{describeAutomation(automation)}</span>
                  )}
                </div>

                {canEdit && (
                  <div className="flex items-center justify-between pl-8 pt-1">
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={automation.enabled}
                          onCheckedChange={(v) => update(automation.id, { enabled: v })}
                          aria-label="Rule enabled"
                        />
                        <span className="text-muted-foreground">
                          {automation.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </label>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => setTestOpen((cur) => (cur === automation.id ? null : automation.id))}
                      >
                        <FlaskConical className="size-4" /> Preview
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void removeAutomation(automation.id)}
                    >
                      <Trash2 className="size-4" /> Remove
                    </Button>
                  </div>
                )}

                {testOpen === automation.id && (
                  <AutomationRunPanel
                    wsId={wsId}
                    automation={automation}
                    onEnable={() => update(automation.id, { enabled: true })}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// The Automations tab (redesign of the old Rules card): Content rules (today's
// shape/use-phase rules) and Scheduled pulls (recurring app-connector
// automations, manual-run only so far — see automations/scheduler.ts, Stage 4)
// as two tabs of one page, promoted to its own "Manage Data" nav entry.
export function Automations({ wsId }: { wsId: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl italic">Automations</h1>
        <p className="text-sm text-muted-foreground">
          Set standing rules for your content, and pull from your connected apps automatically.
        </p>
      </div>
      <Tabs defaultValue="content-rules">
        <TabsList className="mb-4">
          <TabsTrigger value="content-rules">Content rules</TabsTrigger>
          <TabsTrigger value="scheduled-pulls">Scheduled pulls</TabsTrigger>
        </TabsList>
        <TabsContent value="content-rules">
          <ContentRulesTab wsId={wsId} />
        </TabsContent>
        <TabsContent value="scheduled-pulls">
          <ScheduledPullsTab wsId={wsId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ScheduledPullsTab({ wsId }: { wsId: string }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const { automations: rs } = await api.listAutomations(wsId, 'apps_pull');
      setAutomations(rs);
    } catch (err) {
      toast.error(`Couldn't load scheduled pulls: ${(err as Error).message}`);
      setAutomations([]);
    }
  }, [wsId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="text-lg">Scheduled pulls</CardTitle>
          <CardDescription>
            {automations === null
              ? 'Loading…'
              : `${automations.length} pull${automations.length === 1 ? '' : 's'} from your apps`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Connect an app once, then check it automatically on a schedule you choose.
          </p>
          <Button onClick={() => setShowAdd((v) => !v)} variant="outline" size="sm">
            <Plus className="size-4" /> {showAdd ? 'Cancel' : 'Add a scheduled pull'}
          </Button>
          {showAdd && (
            <div className="rounded-lg border bg-muted/20 p-3">
              <AppsIngest
                wsId={wsId}
                mode="schedule"
                onAutomationSaved={() => {
                  setShowAdd(false);
                  void load();
                }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {automations === null ? (
        <Skeleton className="h-32 w-full" />
      ) : automations.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">No scheduled pulls yet — connect an app below.</p>
      ) : (
        <div className="space-y-4">
          {automations.map((automation) => (
            <IngestionAutomationCard key={automation.id} wsId={wsId} automation={automation} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

const CADENCE_LABELS: Record<number, string> = {
  [6 * 60 * 60 * 1000]: 'every 6 hours',
  [12 * 60 * 60 * 1000]: 'every 12 hours',
  [24 * 60 * 60 * 1000]: 'daily',
  [3 * 24 * 60 * 60 * 1000]: 'every 3 days',
  [7 * 24 * 60 * 60 * 1000]: 'weekly',
};

function IngestionAutomationCard({
  wsId,
  automation,
  onChange,
}: {
  wsId: string;
  automation: Automation;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);
  const appDef = APPS.find((a) => a.id === automation.connector);
  const query = (automation.criteria as { query?: string } | null)?.query ?? '';

  const toggleEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.patchAppsPullAutomation(wsId, automation.id, { enabled });
      onChange();
    } catch (err) {
      toast.error(`Couldn't update: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const { run } = await api.runAutomationNow(wsId, automation.id);
      toast[run.outcome === 'error' ? 'error' : 'success'](
        run.summary ?? (run.outcome === 'empty' ? 'Nothing matched this run.' : 'Run complete'),
      );
      if (showRuns) void loadRuns();
    } catch (err) {
      toast.error(`Run failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.deleteAutomation(wsId, automation.id);
      onChange();
    } catch (err) {
      toast.error(`Couldn't delete: ${(err as Error).message}`);
    }
  };

  const loadRuns = useCallback(async () => {
    try {
      const { runs: rs } = await api.listAutomationRuns(wsId, automation.id);
      setRuns(rs);
    } catch (err) {
      toast.error(`Couldn't load run history: ${(err as Error).message}`);
      setRuns([]);
    }
  }, [wsId, automation.id]);

  return (
    <Card className="shadow-soft">
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {appDef && <AppIcon id={appDef.id} color={appDef.color} />}
            <div>
              <div className="text-sm font-medium">{appDef?.name ?? automation.connector}</div>
              <div className="text-xs text-muted-foreground">
                “{query}”{automation.cadence_ms ? ` — checked ${CADENCE_LABELS[automation.cadence_ms] ?? 'periodically'}` : ''}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => void remove()}>
            <Trash2 className="size-4" /> Remove
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 pl-1">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={automation.enabled} onCheckedChange={(v) => void toggleEnabled(v)} disabled={busy} aria-label="Automation enabled" />
            <span className="text-muted-foreground">{automation.enabled ? 'Enabled' : 'Paused'}</span>
          </label>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void runNow()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Pull now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setShowRuns((v) => !v);
              if (!runs) void loadRuns();
            }}
          >
            <FlaskConical className="size-4" /> History
          </Button>
          {automation.last_run_at && (
            <span className="text-xs text-muted-foreground">
              Last run {new Date(automation.last_run_at).toLocaleString()}
            </span>
          )}
        </div>
        <p className="pl-1 text-xs text-muted-foreground">Pulls and adds matching documents immediately.</p>

        {showRuns && (
          <div className="ml-1 rounded-lg border bg-muted/30 p-3">
            {runs === null ? (
              <Skeleton className="h-16 w-full" />
            ) : runs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No runs yet.</p>
            ) : (
              <ul className="space-y-2">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="flex items-center gap-2">
                      <span
                        className={`size-2 rounded-full ${
                          r.outcome === 'ok' ? 'bg-emerald-500' : r.outcome === 'empty' ? 'bg-muted-foreground/50' : 'bg-red-500'
                        }`}
                      />
                      <span className="text-foreground">{r.summary ?? r.error ?? r.outcome}</span>
                    </span>
                    <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// The Preview loop (§5.5, replacing Test): the surface depends on what the
// rule does — an ingestion rule shows a with/without candidate diff; a source
// rule shows the scrubbed document; a use-phase rule shows the Ask answer
// with vs without. Fully ephemeral — nothing is saved.
function AutomationRunPanel({
  wsId,
  automation,
  onEnable,
}: {
  wsId: string;
  automation: Automation;
  onEnable: () => void;
}) {
  const mode = testModeOf(automation);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AutomationTestResult | null>(null);

  const run = async () => {
    if (!input.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const body = mode === 'use' ? { question: input } : { text: input };
      setResult(await api.testAutomation(wsId, automation.id, body));
    } catch (err) {
      toast.error(`Run failed: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const placeholder =
    mode === 'use'
      ? 'Ask a question your team’s AI might ask…'
      : mode === 'source'
        ? 'Paste a document to see it after this rule scrubs it…'
        : 'Paste a sample transcript, doc, or note to test the rule against…';

  const blurb =
    mode === 'use'
      ? 'Ask a question — see the answer your team’s AI gives with and without this rule. Nothing is saved.'
      : mode === 'source'
        ? 'Paste a document — see it after this rule removes what it should. Nothing is saved.'
        : 'Paste a document — see exactly which documents/items this rule would generate, with and without it. Nothing is saved.';

  return (
    <div className="mt-2 ml-8 rounded-lg border bg-muted/30 p-4 space-y-3">
      <p className="text-xs text-muted-foreground">{blurb}</p>
      <Textarea
        rows={mode === 'use' ? 2 : 5}
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void run()} disabled={running || !input.trim()}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {mode === 'use' ? 'Ask' : 'Preview'}
        </Button>
        {running && <span className="text-xs text-muted-foreground">Working…</span>}
      </div>

      {result && <RunResult result={result} onEnable={onEnable} />}
    </div>
  );
}

function RunResult({ result, onEnable }: { result: AutomationTestResult; onEnable: () => void }) {
  const commit = (
    <Button
      size="sm"
      className="mt-1"
      onClick={() => {
        onEnable();
        toast.success('Rule enabled');
      }}
    >
      Looks right — enable rule
    </Button>
  );

  if (result.mode === 'ingestion') {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <CandidateColumn title="Without the rule" candidates={result.without_rule} />
          <CandidateColumn title="With the rule" candidates={result.with_rule} highlight />
        </div>
        {commit}
      </div>
    );
  }

  if (result.mode === 'source') {
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium">
          Document after processing{' '}
          {!result.changed && <span className="font-normal text-muted-foreground">(no changes)</span>}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs">
          {result.processed}
        </pre>
        {commit}
      </div>
    );
  }

  // use
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <AnswerColumn title="Without the rule" answer={result.without_rule_answer} />
        <AnswerColumn title="With the rule" answer={result.with_rule_answer} highlight />
      </div>
      {commit}
    </div>
  );
}

function AnswerColumn({
  title,
  answer,
  highlight,
}: {
  title: string;
  answer: { answer: string; has_answer: boolean };
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? 'border-primary/40' : ''}`}>
      <div className="mb-1 text-xs font-medium">{title}</div>
      <div className="text-sm whitespace-pre-wrap">
        {answer.has_answer ? (
          answer.answer
        ) : (
          <span className="text-muted-foreground italic">No answer from the vault.</span>
        )}
      </div>
    </div>
  );
}

function CandidateColumn({
  title,
  candidates,
  highlight,
}: {
  title: string;
  candidates: RuleTestCandidate[];
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-md border p-2 ${highlight ? 'border-primary/40' : ''}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">
          {candidates.length} item{candidates.length === 1 ? '' : 's'}
        </span>
      </div>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-1 py-2">No candidates extracted.</p>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => (
            <CandidateCard key={c.id} candidate={c} />
          ))}
        </div>
      )}
    </div>
  );
}

const FLAG_COLOR: Record<string, string> = {
  red: 'bg-red-500',
  yellow: 'bg-amber-500',
  green: 'bg-emerald-500',
};

function CandidateCard({ candidate }: { candidate: RuleTestCandidate }) {
  const pn = candidate.proposed_node ?? {};
  const summary = String(pn.summary ?? pn.title ?? pn.body ?? '(no summary)');
  const kind = String(pn.kind ?? pn.type ?? '');
  return (
    <div className="rounded border bg-background p-2 text-xs space-y-1">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${FLAG_COLOR[candidate.flag] ?? 'bg-muted'}`} />
        {kind && <span className="uppercase tracking-wide text-[10px] text-muted-foreground">{kind}</span>}
      </div>
      <div className="text-foreground">{summary}</div>
      {candidate.source_quote && (
        <blockquote className="border-l-2 pl-2 text-muted-foreground italic">{candidate.source_quote}</blockquote>
      )}
    </div>
  );
}
