import { MediaReaders } from '../components/MediaReaders';
import { MfaCard } from '../components/MfaSetup.js';
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Layers, Plus, Archive, Users, ArrowRight, ArrowLeft, Link2, Trash2, Mail, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  setSession,
  type Subgraph,
  type Me,
  type UserIdentity,
  type UserDefault,
  type DefaultSurface,
  type ContextProfile,
} from '../api.js';

import { cn } from '@/lib/utils';
import { fetchProfileCatalog } from '../profiles.js';
// MCP connection URLs point at the origin the app is served from.
const mcpPublicOrigin = (): string => window.location.origin;
import { Admin } from './Admin.js';
import { WorkspaceMembers } from '../components/WorkspaceMembers.js';
import { DirectoryProtectionCard, AssistantConnectionsCard } from '../components/DirectoryAccess.js';
import { SystemAdmin } from '../components/SystemAdmin.js';
import { SubfolderSettingsDialog } from '../components/SubfolderSettingsDialog.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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

// Setup — workspace configuration: connect the team's AI tools and the
// admin surface (audit log + delete). Unbuilt features (Slack capture,
// curation delegation) deliberately have no placeholder cards here — a
// page that mints credentials shouldn't advertise vaporware.
export function Setup({
  wsId,
  onDeleted,
  onOpenTeam,
}: {
  wsId: string;
  onDeleted: () => void;
  onOpenTeam?: () => void;
}) {
  const [assistantOauthOnly, setAssistantOauthOnly] = useState<boolean | null>(null);
  useEffect(() => {
    api.assistantConfig().then((config) => setAssistantOauthOnly(config.oauth_only)).catch(() => setAssistantOauthOnly(null));
  }, []);
  return (
    <Tabs defaultValue="general">
      <TabsList className="mb-6">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="integrations">Integrations</TabsTrigger>
        <TabsTrigger value="team">Team &amp; access</TabsTrigger>
        <TabsTrigger value="agents">Agents &amp; templates</TabsTrigger>
      </TabsList>

      {/* General — who you are, this workspace's own identity and structure,
          and (folded in from Advanced) the rare/higher-stakes actions: audit
          log and workspace deletion. */}
      <TabsContent value="general" className="space-y-6">
        <ProfileCard />
        <PasswordCard />
        <MfaCard />

        <FolderIdCard wsId={wsId} />
        <SubgraphsCard wsId={wsId} />

        <Admin wsId={wsId} onDeleted={onDeleted} />
      </TabsContent>

      {/* Integrations — everywhere this workspace's context reaches outside
          itself: the default folder for surfaces with no explicit target,
          connected apps, claude.ai connectors, and the raw MCP connection
          token. */}
      <TabsContent value="integrations" className="space-y-6">
        <DefaultFolderCard wsId={wsId} />
        <ConnectedAppsCard />

        <OAuthConnectCard />
        <AssistantConnectionsCard wsId={wsId} />
        {assistantOauthOnly === false && <ConnectorsCard wsId={wsId} />}

        {assistantOauthOnly === false && (
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle className="font-serif text-2xl italic">Connection token</CardTitle>
            <CardDescription>
              For Claude Desktop, Claude Code, Cursor and other MCP clients: once connected, they
              see the directory's current decisions, goals and banned phrases automatically when
              they draft.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <McpTokenCard wsId={wsId} />
          </CardContent>
        </Card>
        )}
      </TabsContent>

      {/* Team & access — who's in this workspace and the team directory. */}
      <TabsContent value="team" className="space-y-6">
        <WorkspaceMembers wsId={wsId} onLeft={onDeleted} />
        <DirectoryProtectionCard wsId={wsId} />
        <SystemAdmin />

        {onOpenTeam && <TeamDirectoryCard onOpenTeam={onOpenTeam} />}
      </TabsContent>

      {/* Agents & templates — media readers and the template catalog that
          governs data agents. */}
      <TabsContent value="agents" className="space-y-6">
        <MediaReaders wsId={wsId} target="whatsapp" />
        <TemplatesCard wsId={wsId} />
      </TabsContent>
    </Tabs>
  );
}

/** The data-agent template catalog: the 12 standard templates plus this
 *  workspace's own custom ones. */
function TemplatesCard({ wsId }: { wsId: string }) {
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Templates</CardTitle>
        <CardDescription>
          All 12 standard templates, plus this workspace's own custom ones. Editing a standard
          template forks a new custom copy — the built-in stays untouched.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataAgentTemplatesList wsId={wsId} />
      </CardContent>
    </Card>
  );
}

// The full template catalog (spec §4.2): all 12 standard templates plus
// this workspace's own custom ones — the SAME catalog/editor a subfolder's
// strip opens, reached independently here for building the library on its
// own terms. Standard rows get Edit (forks a new custom template on save,
// per the server's fork-not-overwrite rule) but no Delete — a standard
// template has no row of its own to remove. Folded into EnterpriseAgentsCard
// above (Setup §"integrate templates in the same section") rather than its
// own Card — it's meaningless with Data agents off, so it lives right under
// the toggle that turns it on.
function DataAgentTemplatesList({ wsId }: { wsId: string }) {
  const [templates, setTemplates] = useState<
    Array<{ id: string; name: string; standard: boolean; profile: ContextProfile; active_subfolders: number }> | null
  >(null);
  const [editing, setEditing] = useState<{ template: ContextProfile | null; name: string } | 'new' | null>(null);
  const [delBusyId, setDelBusyId] = useState<string | null>(null);

  const load = () => api.listDataAgentTemplates(wsId).then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  async function remove(id: string, name: string) {
    setDelBusyId(id);
    try {
      await api.deleteDataAgentTemplate(wsId, id);
      toast.success('Template deleted', { description: name });
      await load();
    } catch (e: any) {
      toast.error('Could not delete', { description: e.message });
    } finally {
      setDelBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {templates === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No templates yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2.5 first:pt-0">
              <span className="font-medium text-ink">{t.name}</span>
              {t.standard && (
                <span className="rounded-full border border-muted-foreground/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  standard
                </span>
              )}
              <span className="font-mono text-xs text-muted-foreground">{t.profile.kinds.length} kind{t.profile.kinds.length === 1 ? '' : 's'}</span>
              <span className="text-xs text-muted-foreground">
                used by {t.active_subfolders} folder{t.active_subfolders === 1 ? '' : 's'}
              </span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() => setEditing({ template: t.profile, name: t.name })}
                  title={t.standard ? 'Editing a standard template forks a new custom copy' : 'Edit'}
                >
                  Edit
                </button>
                {!t.standard && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <button
                        type="button"
                        disabled={delBusyId === t.id || t.active_subfolders > 0}
                        title={t.active_subfolders > 0 ? `Attached to ${t.active_subfolders} folder(s) — detach first` : 'Delete'}
                        className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete "{t.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => remove(t.id, t.name)}
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setEditing('new')}
        className="flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-solid hover:bg-muted"
      >
        <Plus className="size-3.5" /> New template
      </button>
      {editing !== null && (
        <TemplateEditorPage
          wsId={wsId}
          template={editing === 'new' ? null : editing.template}
          name={editing === 'new' ? '' : editing.name}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// Draft shapes for the editor's own state — looser than the server's
// ContextProfile types (e.g. enum `values` as one comma-separated string
// while typing) so the inputs stay simple controlled fields; `save()` below
// converts each into the real request shape.
type DraftAttr = { key: string; label: string; type: 'string' | 'date' | 'enum' | 'object'; values: string; description: string; required: boolean };
// `pluralEdited` is UI-only state, never sent to the server (see cleanKinds
// in save() below, which builds the request object field-by-field rather
// than spreading a DraftKind) — it tracks whether the user has directly
// edited the plural label, so the auto-derive-from-label default knows when
// to stop overwriting it.
type DraftKind = { key: string; label: string; label_plural: string; pluralEdited: boolean; description: string; color: number; attrs: DraftAttr[] };
type DraftEdge = { key: string; label: string; description: string; src_kinds: string[] | 'any'; dst_kinds: string[] | 'any'; directed: boolean };
type DraftSourceType = { key: string; label: string; description: string; extraction_guidance: string };

// api.ts's call() stringifies a failed response's raw JSON body into
// Error.message ("400 Bad Request: {...}") so a save failure used to surface
// that whole blob verbatim in a toast. This unwraps it back into the
// server's own per-field errors/warnings (validateProfileSemantics, see
// profiles/validate.ts) so the editor can show what actually needs fixing.
function parseApiError(e: unknown): { message: string; errors?: string[]; warnings?: string[] } {
  const message = e instanceof Error ? e.message : String(e);
  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) return { message };
  try {
    const body = JSON.parse(message.slice(jsonStart));
    if (Array.isArray(body.errors)) return { message: body.error ?? message, errors: body.errors, warnings: body.warnings };
  } catch {
    /* not JSON — fall through to the raw message */
  }
  return { message };
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'kind';
}

// An editor over Tier A (spec §5.1: job description, cardinality, entry
// kinds with typed attrs, and relationships) plus a collapsed Advanced
// section for Tier B (document registers, seed questions — sub-kinds and
// categories are still not exposed, left for a later pass). Tier C (review
// kinds/query scopes/feedback dimensions/flag semantics) is still never
// shown — the server derives them, spec §5.2. Saving an existing template
// edits it in place; "Save as new template" forks a copy.
//
// A full-screen page (Report.tsx's `fixed inset-0` overlay mechanism) rather
// than a modal — this form grew too long for a dialog once attrs/edges/
// source-types/seed-questions joined it — styled with Setup's own card
// language (Card/CardHeader/CardTitle font-serif italic, pome-btn) rather
// than Report's shadcn-Button chrome, since this page is reached from and
// returns to Setup, not the Library.
function TemplateEditorPage({
  wsId,
  template,
  name: initialName,
  onClose,
  onSaved,
}: {
  wsId: string;
  template: ContextProfile | null;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(template?.description ?? '');
  const [shape, setShape] = useState<'items' | 'slots' | 'log'>((template?.shape as 'items' | 'slots' | 'log') ?? 'items');
  const [kinds, setKinds] = useState<DraftKind[]>(
    template?.kinds.map((k) => ({
      key: k.key,
      label: k.label,
      label_plural: k.label_plural,
      // A kind loaded from a saved template already has a real (or at least
      // deliberate) plural — never let a later label edit silently overwrite
      // it. Only a brand-new kind (below) starts in auto-derive mode.
      pluralEdited: true,
      description: k.description,
      color: k.color as number,
      attrs: (k.attrs ?? []).map((a) => ({
        key: a.key,
        label: a.label,
        type: a.type,
        values: (a.values ?? []).join(', '),
        description: a.description ?? '',
        required: !!a.required,
      })),
    })) ?? [{ key: '', label: '', label_plural: '', pluralEdited: false, description: '', color: 1, attrs: [] }],
  );
  const [edgesEmpty, setEdgesEmpty] = useState(
    !!template?.edges_deliberately_empty && (template?.edge_kinds?.length ?? 0) === 0,
  );
  const [edges, setEdges] = useState<DraftEdge[]>(
    (template?.edge_kinds ?? []).map((e) => ({
      key: e.key,
      label: e.label,
      description: e.description,
      src_kinds: e.src_kinds === 'any' ? 'any' : [...e.src_kinds],
      dst_kinds: e.dst_kinds === 'any' ? 'any' : [...e.dst_kinds],
      directed: e.directed ?? true,
    })),
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sourceTypes, setSourceTypes] = useState<DraftSourceType[]>(
    (template?.source_types ?? []).map((s) => ({ key: s.key, label: s.label, description: s.description, extraction_guidance: s.extraction_guidance })),
  );
  const [seedQuestions, setSeedQuestions] = useState<string[]>(template?.seed_questions ?? []);
  const [busy, setBusy] = useState(false);

  function updateKind(i: number, patch: Partial<DraftKind>) {
    setKinds((prev) => prev.map((k, idx) => (idx === i ? { ...k, ...patch } : k)));
  }

  const activeKinds = kinds.filter((k) => k.label.trim());
  // Client-side mirror of validateProfileSemantics' hard requirements — a
  // kind with a label but no description (or no plural label) used to reach
  // the server as a bare 400 with nothing in the editor pointing at which
  // field was missing. Surfaced inline instead, below.
  const kindErrors = activeKinds.filter((k) => !k.description.trim() || !k.label_plural.trim());
  const canSave = !busy && !!name.trim() && !!description.trim() && activeKinds.length > 0 && kindErrors.length === 0;

  async function save(asNew: boolean) {
    if (!canSave) return;
    setBusy(true);
    try {
      const cleanKinds = activeKinds.map((k) => ({
        key: k.key.trim() || slugify(k.label),
        label: k.label.trim(),
        label_plural: k.label_plural.trim() || `${k.label.trim()}s`,
        description: k.description.trim(),
        color: k.color,
        attrs: k.attrs
          .filter((a) => a.label.trim())
          .map((a) => ({
            key: a.key.trim() || slugify(a.label),
            label: a.label.trim(),
            type: a.type,
            values: a.type === 'enum' ? a.values.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
            description: a.description.trim() || undefined,
            required: a.required || undefined,
          })),
      }));
      const cleanEdges = edgesEmpty
        ? []
        : edges
            .filter((e) => e.label.trim())
            .map((e) => ({
              key: e.key.trim() || slugify(e.label),
              label: e.label.trim(),
              description: e.description.trim(),
              src_kinds: e.src_kinds,
              dst_kinds: e.dst_kinds,
              directed: e.directed,
            }));
      const cleanSourceTypes = sourceTypes
        .filter((s) => s.label.trim())
        .map((s) => ({
          key: s.key.trim() || slugify(s.label),
          label: s.label.trim(),
          description: s.description.trim(),
          extraction_guidance: s.extraction_guidance.trim(),
        }));
      const profile = {
        id: template?.id ?? slugify(name),
        name: name.trim(),
        description: description.trim(),
        shape,
        kinds: cleanKinds,
        edge_kinds: cleanEdges,
        edges_deliberately_empty: edgesEmpty,
        source_types: cleanSourceTypes,
        seed_questions: seedQuestions.map((q) => q.trim()).filter(Boolean),
      };
      const r = await api.saveDataAgentTemplate(wsId, {
        id: asNew ? undefined : template?.id,
        name: name.trim(),
        profile: profile as unknown as ContextProfile,
        forked_from: asNew ? template?.id : undefined,
      });
      toast.success(asNew ? 'Template created' : 'Template saved', {
        description: r.warnings.length > 0 ? r.warnings.join(' · ') : undefined,
      });
      onSaved();
    } catch (e) {
      const parsed = parseApiError(e);
      toast.error('Could not save template', {
        description: parsed.errors ? parsed.errors.join(' · ') : parsed.message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-background">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <button type="button" onClick={onClose} className="pome-btn-ghost inline-flex items-center gap-1.5">
            <ArrowLeft className="size-4" /> Back to Setup
          </button>
          <span className="flex-1" />
          {template && (
            <button
              type="button"
              disabled={busy || !name.trim() || kindErrors.length > 0}
              onClick={() => save(true)}
              className="pome-btn-ghost disabled:opacity-40"
            >
              Save as new template
            </button>
          )}
          <button type="button" disabled={!canSave} onClick={() => save(false)} className="pome-btn-primary disabled:opacity-40">
            {busy ? 'Saving…' : template ? 'Save' : 'Save template'}
          </button>
        </div>

        <div className="eyebrow mb-1">Data agent template</div>
        <h1 className="font-serif text-3xl italic">{template ? 'Edit template' : 'New template'}</h1>
        <p className="mt-1.5 mb-8 text-sm text-muted-foreground">
          {template
            ? 'Save edits this template in place, or fork a new one that starts from it.'
            : 'Job description, cardinality, entry kinds, and relationships. Review rubric and query scopes fill in automatically.'}
        </p>

        <div className="space-y-6">
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="font-serif text-2xl italic">Basics</CardTitle>
              <CardDescription>What this template is for, and how many nodes each entry kind holds.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <label className="eyebrow" htmlFor="tpl-name">Name</label>
                <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bug Tracker" />
              </div>

              <div className="space-y-1">
                <label className="eyebrow" htmlFor="tpl-desc">One job, one paragraph</label>
                <textarea
                  id="tpl-desc"
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What belongs here, and what explicitly doesn't."
                />
              </div>

              <div className="space-y-1">
                <span className="eyebrow">Cardinality</span>
                <div className="flex gap-2">
                  {(['items', 'slots', 'log'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setShape(s)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs',
                        shape === s ? 'border-transparent bg-pome-red text-white' : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {s === 'items' ? 'Many, standalone' : s === 'slots' ? 'Fixed, replaceable' : 'Dated log'}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="font-serif text-2xl italic">Entry kinds</CardTitle>
              <CardDescription>What gets extracted — one section per kind, plus its optional typed attributes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {kinds.map((k, i) => (
                <div key={i} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5, 6].map((c) => (
                        <button
                          key={c}
                          type="button"
                          aria-label={`Color ${c}`}
                          onClick={() => updateKind(i, { color: c })}
                          className={cn('size-4 rounded-full border', k.color === c && 'ring-2 ring-offset-1 ring-pome-red')}
                          style={{ background: `var(--kind-${c})` }}
                        />
                      ))}
                    </div>
                    <Input
                      value={k.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        // Keeps deriving the plural live from the label — not just
                        // once from its first character — until the user edits the
                        // Plural field directly (pluralEdited flips true there).
                        updateKind(i, { label, ...(k.pluralEdited ? {} : { label_plural: label ? `${label}s` : '' }) });
                      }}
                      placeholder="Label, e.g. Bug"
                      className="h-8 flex-1"
                    />
                    <Input
                      value={k.label_plural}
                      onChange={(e) => updateKind(i, { label_plural: e.target.value, pluralEdited: true })}
                      placeholder="Plural, e.g. Bugs"
                      className="h-8 w-32 shrink-0"
                    />
                    {kinds.length > 1 && (
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setKinds((prev) => prev.filter((_, idx) => idx !== i))}>
                        Remove
                      </button>
                    )}
                  </div>
                  {k.label.trim() && !k.label_plural.trim() && (
                    <p className="text-xs text-destructive">A plural label is required too — it's used in section headers and query scopes.</p>
                  )}
                  <textarea
                    className={cn(
                      'w-full rounded-md border bg-background p-2 text-xs',
                      k.label.trim() && !k.description.trim() && 'border-destructive',
                    )}
                    rows={2}
                    value={k.description}
                    onChange={(e) => updateKind(i, { description: e.target.value })}
                    placeholder="What belongs in this kind, with an example of what doesn't."
                  />
                  {k.label.trim() && !k.description.trim() && (
                    <p className="text-xs text-destructive">
                      A description is required — it's the capture prompt's guidance for this kind.
                    </p>
                  )}
                  <AttrsEditor attrs={k.attrs} onChange={(attrs) => updateKind(i, { attrs })} />
                </div>
              ))}
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setKinds((prev) => [...prev, { key: '', label: '', label_plural: '', pluralEdited: false, description: '', color: (prev.length % 6) + 1, attrs: [] }])}
              >
                <Plus className="size-3.5" /> Add entry kind
              </button>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="font-serif text-2xl italic">Relationships</CardTitle>
                <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={edgesEmpty} onCheckedChange={setEdgesEmpty} aria-label="These entry kinds don't relate to each other" />
                  These kinds don't relate to each other
                </label>
              </div>
              <CardDescription>How entry kinds connect to each other — which kinds can sit at each end.</CardDescription>
            </CardHeader>
            {!edgesEmpty && (
              <CardContent>
                <EdgesEditor
                  edges={edges}
                  onChange={setEdges}
                  kindOptions={activeKinds.map((k) => ({ key: k.key.trim() || slugify(k.label), label: k.label }))}
                />
              </CardContent>
            )}
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <button
                type="button"
                className="flex items-center gap-2 text-left"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <CardTitle className="font-serif text-2xl italic">
                  {advancedOpen ? '▾' : '▸'} Advanced
                </CardTitle>
              </button>
              <CardDescription>Document registers and seed questions — optional, opened only if needed.</CardDescription>
            </CardHeader>
            {advancedOpen && (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <span className="eyebrow">Document registers</span>
                  <p className="text-xs text-muted-foreground">
                    The kinds of source document this template expects — capture gets per-type care rules.
                  </p>
                  <SourceTypesEditor sourceTypes={sourceTypes} onChange={setSourceTypes} />
                </div>
                <div className="space-y-2">
                  <span className="eyebrow">Seed questions</span>
                  <p className="text-xs text-muted-foreground">
                    Questions this folder should be able to answer once populated — doubles as acceptance criteria.
                  </p>
                  <SeedQuestionsEditor questions={seedQuestions} onChange={setSeedQuestions} />
                </div>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// Per-kind typed attributes (spec §5.1, `AttrDef`) — optional, so an empty
// list is a legitimate choice. `values` is edited as one comma-separated
// field rather than its own repeatable list; only meaningful for `enum`.
function AttrsEditor({ attrs, onChange }: { attrs: DraftAttr[]; onChange: (attrs: DraftAttr[]) => void }) {
  function update(i: number, patch: Partial<DraftAttr>) {
    onChange(attrs.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  return (
    <div className="space-y-2 border-t pt-3">
      <span className="eyebrow">Attributes (optional)</span>
      {attrs.map((a, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
          <Input
            value={a.label}
            onChange={(e) => update(i, { label: e.target.value })}
            placeholder="Attribute, e.g. Priority"
            className="h-8 min-w-36 flex-1"
          />
          <Select value={a.type} onValueChange={(v) => update(i, { type: v as DraftAttr['type'] })}>
            <SelectTrigger className="h-8 w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="string">Text</SelectItem>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="enum">Enum</SelectItem>
              <SelectItem value="object">Object</SelectItem>
            </SelectContent>
          </Select>
          {a.type === 'enum' && (
            <Input
              value={a.values}
              onChange={(e) => update(i, { values: e.target.value })}
              placeholder="values, comma-separated"
              className="h-8 min-w-40 flex-1"
            />
          )}
          <label className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
            <Switch checked={a.required} onCheckedChange={(v) => update(i, { required: v })} aria-label="Required" />
            Required
          </label>
          <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(attrs.filter((_, idx) => idx !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onChange([...attrs, { key: '', label: '', type: 'string', values: '', description: '', required: false }])}
      >
        <Plus className="size-3.5" /> Add attribute
      </button>
    </div>
  );
}

// Which declared entry kinds may sit at one end of a relationship — 'any'
// opts out of the constraint (EdgeKindDef.src_kinds/dst_kinds). Rendered as
// the same pill-chip toggle language Cardinality uses above, rather than
// checkboxes, so a selected kind reads the same way a selected shape does.
function KindMultiSelect({
  value,
  onChange,
  options,
}: {
  value: string[] | 'any';
  onChange: (v: string[] | 'any') => void;
  options: Array<{ key: string; label: string }>;
}) {
  const isAny = value === 'any';
  function toggle(key: string) {
    if (isAny) return;
    const set = new Set(value);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    onChange([...set]);
  }
  const pill = (selected: boolean) =>
    cn(
      'rounded-full border px-2.5 py-1 text-xs',
      selected ? 'border-transparent bg-pome-red text-white' : 'text-muted-foreground hover:bg-muted',
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => onChange(isAny ? [] : 'any')} className={pill(isAny)}>
        Any
      </button>
      {!isAny &&
        options.map((o) => (
          <button key={o.key} type="button" onClick={() => toggle(o.key)} className={pill(value.includes(o.key))}>
            {o.label || o.key}
          </button>
        ))}
    </div>
  );
}

// Relationships between entry kinds (spec §5.1, `EdgeKindDef`) — Tier A,
// shown unconditionally alongside kinds rather than tucked into Advanced,
// since a template's whole point can hinge on how its kinds relate.
function EdgesEditor({
  edges,
  onChange,
  kindOptions,
}: {
  edges: DraftEdge[];
  onChange: (edges: DraftEdge[]) => void;
  kindOptions: Array<{ key: string; label: string }>;
}) {
  function update(i: number, patch: Partial<DraftEdge>) {
    onChange(edges.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  return (
    <div className="space-y-3">
      {edges.map((e, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Input value={e.label} onChange={(ev) => update(i, { label: ev.target.value })} placeholder="Relationship, e.g. Blocks" className="h-8 flex-1" />
            <label className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
              <Switch checked={e.directed} onCheckedChange={(v) => update(i, { directed: v })} aria-label="Directed" />
              Directed
            </label>
            <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(edges.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <textarea
            value={e.description}
            onChange={(ev) => update(i, { description: ev.target.value })}
            placeholder="When does this relationship apply?"
            className="w-full rounded-md border bg-background p-2 text-sm"
            rows={1}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <span className="eyebrow">From</span>
              <KindMultiSelect value={e.src_kinds} onChange={(v) => update(i, { src_kinds: v })} options={kindOptions} />
            </div>
            <div className="space-y-1">
              <span className="eyebrow">To</span>
              <KindMultiSelect value={e.dst_kinds} onChange={(v) => update(i, { dst_kinds: v })} options={kindOptions} />
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onChange([...edges, { key: '', label: '', description: '', src_kinds: 'any', dst_kinds: 'any', directed: true }])}
      >
        <Plus className="size-3.5" /> Add relationship
      </button>
    </div>
  );
}

// Document registers (spec §5.1, `SourceTypeDef`) — Tier B, tucked into
// Advanced. Only name/description/extraction_guidance are exposed; the
// triage-only fields (commit_unit, currency, authority_kinds, group_floor)
// stay server-derived defaults, matching the essentials-only bar this editor
// holds everywhere else.
function SourceTypesEditor({ sourceTypes, onChange }: { sourceTypes: DraftSourceType[]; onChange: (s: DraftSourceType[]) => void }) {
  function update(i: number, patch: Partial<DraftSourceType>) {
    onChange(sourceTypes.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  return (
    <div className="space-y-3">
      {sourceTypes.map((s, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Input
              value={s.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Document type, e.g. Customer interview"
              className="h-8 flex-1"
            />
            <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(sourceTypes.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
          <textarea
            value={s.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="What this looks like (the router classifies documents against it)."
            className="w-full rounded-md border bg-background p-2 text-sm"
            rows={1}
          />
          <textarea
            value={s.extraction_guidance}
            onChange={(e) => update(i, { extraction_guidance: e.target.value })}
            placeholder="Special care rules for capture on this document type (optional)."
            className="w-full rounded-md border bg-background p-2 text-sm"
            rows={2}
          />
        </div>
      ))}
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => onChange([...sourceTypes, { key: '', label: '', description: '', extraction_guidance: '' }])}
      >
        <Plus className="size-3.5" /> Add document register
      </button>
    </div>
  );
}

// Seed questions (spec §5.1) — Tier B, tucked into Advanced.
function SeedQuestionsEditor({ questions, onChange }: { questions: string[]; onChange: (q: string[]) => void }) {
  return (
    <div className="space-y-2">
      {questions.map((q, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => onChange(questions.map((x, idx) => (idx === i ? e.target.value : x)))}
            placeholder="e.g. What did we decide about the roadmap?"
            className="h-8 flex-1"
          />
          <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => onChange(questions.filter((_, idx) => idx !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange([...questions, ''])}>
        <Plus className="size-3.5" /> Add seed question
      </button>
    </div>
  );
}

// Folder id — the workspace's stable identifier. Shown first in Settings so it
// is easy to find and copy (formerly the lead card inside Admin).
function FolderIdCard({ wsId }: { wsId: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(wsId);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Directory id</CardTitle>
        <CardDescription>The unique identifier for this directory.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <code className="font-mono text-sm">{wsId}</code>
          <button
            onClick={copy}
            aria-label="Copy directory id"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted"
          >
            {copied ? <Check className="size-4 text-flag-green" /> : <Copy className="size-4" />}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// Profile — how teammates and surfaces refer to you: a display name ("Alice
// Martin") and linked Slack / WhatsApp identities. Both feed the server-side
// resolver that lets "review this against Alice's folder" work from any
// surface. Identities are linked by a code the person sends to the bot FROM
// that Slack account or phone (proof they control it), never by typing an id.
function ProfileCard() {
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<Me | null> => {
    try {
      const m = await api.getMe();
      setMe(m);
      return m;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    refresh().then((m) => setName(m?.display_name ?? ''));
  }, [refresh]);

  async function save() {
    setBusy(true);
    try {
      if ((me?.display_name ?? '') !== name.trim()) {
        await api.patchMe(name.trim() || null);
      }
      await refresh();
      toast.success('Profile saved');
    } catch (err) {
      toast.error('Could not save profile', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Your profile</CardTitle>
        <CardDescription>
          How teammates refer to you across surfaces. With a display name and a linked identity,
          "ask {name.trim() || 'your'} directory" works from Slack, WhatsApp, claude.ai, and Claude
          Code by name, email, or @handle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1 sm:max-w-sm">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Display name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alice Martin"
            />
          </div>
          <button className="pome-btn" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <IdentityLinkPanel kind="slack" me={me} onChanged={refresh} />
          <IdentityLinkPanel kind="whatsapp" me={me} onChanged={refresh} />
        </div>
      </CardContent>
    </Card>
  );
}

const IDENTITY_COPY = {
  slack: {
    name: 'Slack',
    title: 'Connect Slack',
    instruction: 'DM this code to the Pomegranate bot in Slack',
    from: 'from the Slack account you want to link.',
  },
  whatsapp: {
    name: 'WhatsApp',
    title: 'Connect WhatsApp',
    instruction: 'Send this code to the Pomegranate WhatsApp number',
    from: 'from the phone you want to link.',
  },
} as const;

function identityLabel(i: UserIdentity): string {
  if (i.kind === 'whatsapp') return `+${i.external_id}`;
  return i.handle ? `@${i.handle} (${i.external_id})` : i.external_id;
}

const LINK_POLL_MS = 3000;

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One surface's identity: shows what's linked (with Unlink), or mints a link
// code, shows it large with a copy button and an expiry countdown, and polls
// /me every 3s until the identity appears or the code expires.
function IdentityLinkPanel({
  kind,
  me,
  onChanged,
}: {
  kind: 'slack' | 'whatsapp';
  me: Me | null;
  onChanged: () => Promise<Me | null>;
}) {
  const copy = IDENTITY_COPY[kind];
  const linked = me?.identities.filter((i) => i.kind === kind) ?? [];
  const [pending, setPending] = useState<{ code: string; expiresAt: number; knownIds: string[] } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [justLinked, setJustLinked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  // While a code is live: tick the countdown and poll for the new identity.
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (Date.now() >= pending.expiresAt) {
        clearInterval(poll);
        return;
      }
      const m = await onChanged();
      if (stopped || !m) return;
      if (m.identities.some((i) => i.kind === kind && !pending.knownIds.includes(i.id))) {
        setPending(null);
        setJustLinked(true);
        toast.success(`${copy.name} linked`);
      }
    }, LINK_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [pending, kind, onChanged, copy.name]);

  async function getCode() {
    setBusy(true);
    setJustLinked(false);
    try {
      const r = await api.createIdentityLinkCode(kind);
      setPending({ code: r.code, expiresAt: Date.parse(r.expires_at), knownIds: linked.map((i) => i.id) });
      setNow(Date.now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast.error('Could not get a link code', {
        description: msg.startsWith('429') ? 'Too many codes requested. Try again later.' : msg || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!pending) return;
    await navigator.clipboard.writeText(pending.code);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  }

  async function unlink() {
    setBusy(true);
    try {
      await api.unlinkIdentity(kind);
      setJustLinked(false);
      await onChanged();
      toast.success(`${copy.name} unlinked`);
    } catch (err) {
      toast.error('Could not unlink', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }

  const remaining = pending ? pending.expiresAt - now : 0;
  const live = !!pending && remaining > 0;

  return (
    <div className="space-y-2 rounded-md border bg-card p-3">
      <div className="text-xs font-medium text-muted-foreground">{copy.title}</div>
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Check className="size-4 text-flag-green" />
          <span>{justLinked ? 'Linked ✓' : 'Linked'}</span>
          <code className="font-mono text-xs text-muted-foreground">{linked.map(identityLabel).join(', ')}</code>
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={unlink}
          >
            Unlink
          </button>
        </div>
      )}
      {live ? (
        <div className="space-y-2">
          <p className="text-sm">
            {copy.instruction} {copy.from}
          </p>
          <div className="flex items-center gap-2">
            <code className="select-all font-mono text-2xl font-semibold tracking-widest">{pending.code}</code>
            <button
              onClick={copyCode}
              aria-label="Copy link code"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted"
            >
              {copied ? <Check className="size-4 text-flag-green" /> : <Copy className="size-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Expires in {formatCountdown(remaining)}. Waiting for your message… Don't share this code.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pending && <p className="text-xs text-muted-foreground">That code expired. Get a new one.</p>}
          <button className="pome-btn inline-flex items-center gap-1.5" disabled={busy} onClick={getCode}>
            <Link2 className="size-4" />
            {linked.length > 0 ? 'Link another' : 'Get a link code'}
          </button>
        </div>
      )}
    </div>
  );
}

// Password — a second, independent way to sign in alongside the magic link
// (the magic link keeps working either way). Today an admin sets the first
// password out-of-band; this card is where it gets rotated afterwards, so a
// password an admin handed out doesn't have to stay the permanent one.
export function PasswordCard({ onSaved }: { onSaved?: () => void } = {}) {
  const [me, setMe] = useState<Me | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getMe()
      .then(setMe)
      .catch(() => {});
  }, []);

  async function save() {
    if (next !== confirm) {
      toast.error('Passwords don’t match');
      return;
    }
    setBusy(true);
    // Read before saving: afterwards the account always has a password.
    const hadPassword = !!me?.has_password;
    try {
      await api.setPassword(next, hadPassword ? current : undefined);
      setCurrent('');
      setNext('');
      setConfirm('');
      const updated = await api.getMe();
      setMe(updated);
      toast.success(hadPassword ? 'Password updated' : 'Password set');
      onSaved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : undefined;
      const friendly = msg?.includes('invalid_current_password')
        ? 'Current password is incorrect'
        : msg?.includes('at least 12 characters')
          ? 'Password must be at least 12 characters'
          : (msg?.match(/"error":"([^"]+)"/)?.[1] ?? msg);
      toast.error('Could not update password', { description: friendly });
    } finally {
      setBusy(false);
    }
  }

  async function signOutEverywhere() {
    setBusy(true);
    try {
      await api.logoutAll();
    } catch {
      /* this session is signed out locally below either way */
    }
    setSession(null);
    window.location.reload();
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Password</CardTitle>
        <CardDescription>
          {me?.has_password
            ? 'Change the password used by the "Use a password instead" sign-in option. The magic link always keeps working too.'
            : 'No password set yet — sign-in still works via magic link. Set one here for a second way in.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {me?.has_password && (
            <div>
              <label htmlFor="setup-pw-current" className="mb-1 block text-xs font-medium text-muted-foreground">
                Current password
              </label>
              <Input
                id="setup-pw-current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          )}
          <div>
            <label htmlFor="setup-pw-new" className="mb-1 block text-xs font-medium text-muted-foreground">
              New password
            </label>
            <Input id="setup-pw-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div>
            <label htmlFor="setup-pw-confirm" className="mb-1 block text-xs font-medium text-muted-foreground">
              Confirm new password
            </label>
            <Input
              id="setup-pw-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
        <button
          className="pome-btn"
          disabled={busy || !next || !confirm || (!!me?.has_password && !current)}
          onClick={save}
        >
          {busy ? 'Saving…' : me?.has_password ? 'Update password' : 'Set password'}
        </button>
        <div className="border-t pt-3">
          <p className="mb-2 text-sm text-muted-foreground">
            Signed in on a computer you no longer use? Sign out everywhere, including here. Changing your password
            also signs out your other devices.
          </p>
          <button className="pome-btn" disabled={busy} onClick={signOutEverywhere}>
            Sign out of all devices
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

// Default folder — where surfaces land when you (or a teammate referencing
// you) don't name a folder. A pointer, not a grant: teammates still need
// membership here to read anything.
const SURFACE_LABELS: Array<{ key: DefaultSurface; label: string }> = [
  { key: 'all', label: 'All surfaces' },
  { key: 'slack', label: 'Slack' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'mcp', label: 'MCP (claude.ai, Claude Code)' },
];

function DefaultFolderCard({ wsId }: { wsId: string }) {
  const [defaults, setDefaults] = useState<UserDefault[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const me = await api.getMe();
      setDefaults(me.defaults);
      const ws = await api.listWorkspaces();
      setNames(Object.fromEntries(ws.workspaces.map((w) => [w.id, w.name])));
    } catch {
      /* signed-out or offline — card stays inert */
    }
  }
  useEffect(() => {
    void refresh();
  }, [wsId]);

  async function toggle(surface: DefaultSurface) {
    const current = defaults.find((d) => d.surface === surface);
    setBusy(surface);
    try {
      if (current?.workspace_id === wsId) {
        await api.deleteDefault(surface);
        toast.success(`Default cleared for ${SURFACE_LABELS.find((s) => s.key === surface)!.label}`);
      } else {
        await api.putDefault(surface, wsId);
        toast.success(`This directory is now your default for ${SURFACE_LABELS.find((s) => s.key === surface)!.label}`);
      }
      await refresh();
    } catch (err) {
      toast.error('Could not update default directory', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Default directory</CardTitle>
        <CardDescription>
          Make this directory the one surfaces open when no directory is named — for you, and for
          teammates who reference you by name. Teammates still need to be members here to see
          anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {SURFACE_LABELS.map(({ key, label }) => {
          const current = defaults.find((d) => d.surface === key);
          const isThis = current?.workspace_id === wsId;
          const elsewhere = current && !isThis ? (names[current.workspace_id] ?? current.workspace_id) : null;
          return (
            <div key={key} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {isThis
                    ? 'This directory is the default'
                    : elsewhere
                      ? `Currently: ${elsewhere}`
                      : 'No default set'}
                </div>
              </div>
              <button
                className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm ${
                  isThis
                    ? 'border-pome-red bg-pome-red/5 font-semibold'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
                disabled={busy === key}
                onClick={() => toggle(key)}
              >
                {busy === key ? '…' : isThis ? 'Clear default' : 'Make default'}
              </button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// Connected apps — per-user credentials for the live connectors behind the
// "From your apps" Sources tab. Gmail only for now: a Google app password over
// IMAP, verified with a real login on save and stored encrypted server-side.
// The password is write-only — after saving, the server reports just the
// connected address, never the secret.
function ConnectedAppsCard() {
  const [connected, setConnected] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const r = await api.getGmailConnection();
      setConnected(r.configured ? r.address : null);
      if (r.configured && r.address) setAddress(r.address);
    } catch {
      /* signed-out or offline — card stays inert */
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function connect() {
    if (!address.trim() || !password.trim()) {
      toast.error('Enter your Gmail address and an app password');
      return;
    }
    setBusy(true);
    try {
      const r = await api.putGmailConnection(address.trim(), password);
      setConnected(r.address);
      setPassword('');
      toast.success('Gmail connected', { description: `Pulls in Sources now read ${r.address}.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Could not connect Gmail', {
        description: msg.includes('gmail_auth_failed')
          ? 'Google rejected that address or app password. App passwords need 2-Step Verification and are 16 characters.'
          : msg.includes('credentials_key_missing')
            ? 'This server is not configured to store credentials — ask your admin to set POMEGRANATE_CREDENTIALS_KEY.'
            : msg,
      });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.deleteGmailConnection();
      setConnected(null);
      setPassword('');
      toast.success('Gmail disconnected', { description: 'The stored app password was deleted.' });
    } catch (err) {
      toast.error('Could not disconnect', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
          <Mail className="size-5" /> Connected apps
        </CardTitle>
        <CardDescription>
          Connect your Gmail so "From your apps" in Sources can pull real emails — with your own
          credentials, for your account only. Create an app password at{' '}
          <a
            className="underline underline-offset-2"
            href="https://myaccount.google.com/apppasswords"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/apppasswords
          </a>{' '}
          (requires 2-Step Verification). It is verified with a real sign-in when you save, stored
          encrypted, and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {connected && (
          <p className="text-sm">
            <Check className="mr-1 inline size-4 text-flag-green" />
            Connected as <span className="font-medium">{connected}</span>
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Gmail address
            </label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="you@gmail.com"
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              App password
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={connected ? '•••••••• (saved — enter to replace)' : 'xxxx xxxx xxxx xxxx'}
              className="font-mono"
              autoComplete="off"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="pome-btn" disabled={busy || !password.trim()} onClick={connect}>
            {busy ? 'Verifying…' : connected ? 'Reconnect' : 'Connect Gmail'}
          </button>
          {connected && (
            <button
              className="rounded-lg border px-3 py-1.5 text-sm text-muted-foreground hover:text-flag-red"
              disabled={busy}
              onClick={disconnect}
            >
              Disconnect
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Entry point to the (nav-hidden) team-workspaces page: everyone on your email
// domain and the workspaces + MCP endpoints they own.
function TeamDirectoryCard({ onOpenTeam }: { onOpenTeam: () => void }) {
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
          <Users className="size-5" /> Explore directories
        </CardTitle>
        <CardDescription>
          See everyone who shares your company email domain, the directories each of them belongs to,
          each directory's type, and the MCP endpoint that serves it. Search by name to find a
          teammate's directory to connect to. A personal email provider (gmail.com, outlook.com, …)
          is not a company, so there it lists only your own directories.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <button className="pome-btn inline-flex items-center gap-1.5" onClick={onOpenTeam}>
          Explore team directories <ArrowRight className="size-4" />
        </button>
      </CardContent>
    </Card>
  );
}

// claude.ai connectors — one-click capability URLs for claude.ai (which can't
// send bearer headers). Creating one is a self-serve DB row now, not a manual
// reverse-proxy change; the only step left to the user is pasting the URL into
// claude.ai → Settings → Connectors. The secret URL is shown once at creation.
type Connector = { id: string; label: string | null; created_at: string; last_used_at: string | null };

function OAuthConnectCard() {
  const endpoint = `${mcpPublicOrigin()}/mcp/server`;
  async function copyEndpoint() {
    await navigator.clipboard.writeText(endpoint);
    toast.success('OAuth MCP endpoint copied');
  }
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Connect securely with OAuth</CardTitle>
        <CardDescription>
          Recommended for Claude and ChatGPT. Add this server URL in the client, then sign in to
          Pomegranate and choose which folders it may access. Existing connector links and tokens
          below continue to work.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{endpoint}</code>
          <button type="button" onClick={copyEndpoint} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-muted">
            <Copy className="size-4" /> Copy
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Claude: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps → Create.
          The client discovers Pomegranate's OAuth configuration automatically.
        </p>
      </CardContent>
    </Card>
  );
}

function ConnectorsCard({ wsId }: { wsId: string }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const r = await api.listConnectors(wsId);
      setConnectors(r.connectors);
    } catch {
      // Non-admins get 403 here; the card simply shows nothing to manage.
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  async function create() {
    setBusy(true);
    try {
      const r = await api.createConnector(wsId, label.trim() || undefined);
      // `path` is app-relative; the full capability URL is the hosted app
      // origin + path.
      setFreshUrl(`${mcpPublicOrigin()}${r.path}`);
      setLabel('');
      toast.success('Connector created', { description: 'Copy the URL now — it is shown only once.' });
      void load();
    } catch (e: any) {
      toast.error('Could not create connector', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api.revokeConnector(wsId, id);
      toast.success('Connector revoked');
      void load();
    } catch (e: any) {
      toast.error('Could not revoke', { description: e.message });
    }
  }

  async function copyUrl() {
    if (!freshUrl) return;
    await navigator.clipboard.writeText(freshUrl);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
          <Link2 className="size-5" /> Claude.ai connector
        </CardTitle>
        <CardDescription>
          Create a one-click connector URL for claude.ai. Paste it into claude.ai → Settings →
          Connectors and your directory's vault is available there — no token to configure. The URL
          is the credential, so it's shown only once; revoke any time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded-md border bg-card px-3 py-2 text-sm"
              placeholder="Label (optional) — e.g. Marketing team"
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button
              className="pome-btn inline-flex items-center gap-1.5"
              onClick={create}
              disabled={busy}
            >
              <Plus className="size-4" /> {busy ? 'Creating…' : 'Create connector'}
            </button>
          </div>

          {freshUrl && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
              <p className="text-xs text-muted-foreground">
                Paste this URL into claude.ai → Settings → Connectors → Add custom connector. It
                won't be shown again.
              </p>
              <div className="flex items-start gap-2">
                <pre className="token flex-1 overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs">
                  {freshUrl}
                </pre>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={copyUrl}
                        aria-label="Copy connector URL"
                        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border bg-card transition-colors hover:bg-muted"
                      >
                        {copied ? <Check className="size-4 text-flag-green" /> : <Copy className="size-4" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{copied ? 'Copied' : 'Copy URL'}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          )}

          {connectors.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {connectors.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{c.label || 'Untitled connector'}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(c.created_at).toLocaleDateString()}
                      {c.last_used_at
                        ? ` · last used ${new Date(c.last_used_at).toLocaleDateString()}`
                        : ' · never used'}
                    </p>
                  </div>
                  <button
                    onClick={() => revoke(c.id)}
                    aria-label="Revoke connector"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-flag-red"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Exported so ConnectExtension.tsx (the minimal /?returnTo=connect page for
// the Chrome extension's one-click connect) can reuse it standalone, without
// pulling in the rest of Setup.
export function McpTokenCard({ wsId, centerButton = false }: { wsId: string; centerButton?: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function issue() {
    setBusy(true);
    try {
      const r = await api.issueMcpToken(wsId);
      setToken(r.token);
      toast.success('Connection token issued', { description: 'Expires in 90 days. Revoke any time.' });
    } catch (e: any) {
      toast.error('Could not issue token', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-4">
      <button
        className={cn('pome-btn', centerButton && 'mx-auto block')}
        onClick={issue}
        disabled={busy}
      >
        {busy ? 'Issuing…' : token ? 'Issue another token' : 'Issue connection token'}
      </button>
      {token && (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-4">
          <p className="text-xs text-muted-foreground">
            Paste this into the AI tool's MCP configuration. The token expires in 90 days and you
            can revoke it any time.
          </p>
          <div className="flex items-start gap-2">
            <pre className="token flex-1 overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs">
              {token}
            </pre>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={copy}
                    aria-label="Copy token"
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border bg-card transition-colors hover:bg-muted"
                  >
                    {copied ? <Check className="size-4 text-flag-green" /> : <Copy className="size-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{copied ? 'Copied' : 'Copy token'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      )}
    </div>
  );
}

// Subgraphs — the workspace's context profiles. Each subgraph is an
// independent graph bound to one profile; documents route into the ones they
// are about. Add a profile to wear another hat; archive to retire one (its
// nodes are kept, just hidden).
function SubgraphsCard({ wsId }: { wsId: string }) {
  const [subgraphs, setSubgraphs] = useState<Subgraph[] | null>(null);
  // There is only one built-in template, resolved once so `add` never
  // hardcodes its id — so adding a subfolder is just naming it.
  const [profileId, setProfileId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  // Two-step delete (mirrors Admin.tsx's folder-delete confirm): the dialog
  // confirms intent, an "armed" second button confirms the irreversible purge.
  // Tracked per-subfolder id so only the row the user opened gets armed.
  const [armedId, setArmedId] = useState<string | null>(null);
  const [delBusyId, setDelBusyId] = useState<string | null>(null);
  // Settings dialog (description / content summary / routable) — holds the
  // row it was opened from, not just an id, so the dialog has data to show
  // before any refetch.
  const [editing, setEditing] = useState<Subgraph | null>(null);

  const load = () => api.listSubgraphs(wsId).then((r) => setSubgraphs(r.subgraphs)).catch(() => setSubgraphs([]));
  useEffect(() => {
    load();
    fetchProfileCatalog().then((ps) => setProfileId((cur) => cur ?? ps[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  async function add() {
    if (!profileId) return;
    setBusy(true);
    try {
      await api.createSubgraph(wsId, { profile_id: profileId, name: newName.trim() || undefined });
      toast.success('Folder added', { description: newName.trim() || undefined });
      setNewName('');
      await load();
    } catch (e: any) {
      toast.error('Could not add folder', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string, name: string) {
    setBusy(true);
    try {
      await api.archiveSubgraph(wsId, id);
      toast.success('Folder archived', { description: `${name} — its nodes are retained` });
      await load();
    } catch (e: any) {
      toast.error('Could not archive', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    setDelBusyId(id);
    try {
      await api.deleteSubgraph(wsId, id);
      toast.success('Folder deleted', { description: `${name} and all its nodes are gone` });
      await load();
    } catch (e: any) {
      toast.error('Could not delete', { description: e.message });
    } finally {
      setDelBusyId(null);
      setArmedId(null);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
          <Layers className="size-5" /> Folders
        </CardTitle>
        <CardDescription>
          Each folder organizes part of your vault using one profile. When you ingest a document,
          it routes into the folders it's about; you can pin routing by writing
          {' '}<code className="font-mono text-xs">#slug</code> in the text. Ask &amp; Review span every
          relevant folder automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {subgraphs === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {subgraphs.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                <span className="font-medium text-ink">{s.name}</span>
                <code className="font-mono text-xs text-pome-red">#{s.slug}</code>
                <span className="font-mono text-[11px] text-muted-foreground">{s.profile_id}</span>
                {!s.routable && (
                  <span
                    className="rounded-full border border-muted-foreground/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
                    title="Only reachable via an explicit #slug pin or a direct pick — the router won't file here on its own"
                  >
                    not routable
                  </span>
                )}
                <span className="ml-auto font-mono text-xs text-muted-foreground">{s.node_count} nodes</span>
                <button
                  type="button"
                  onClick={() => setEditing(s)}
                  aria-label={`Edit ${s.name} settings`}
                  className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Description, content summary, and routing eligibility"
                >
                  <Settings2 className="size-3.5" />
                </button>
                <>
                  {s.id !== 'default' && (
                    <button
                      type="button"
                      onClick={() => archive(s.id, s.name)}
                      disabled={busy}
                      aria-label={`Archive ${s.name}`}
                      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                      title="Archive (keeps nodes, hides the folder)"
                    >
                      <Archive className="size-3.5" />
                    </button>
                  )}
                    <AlertDialog onOpenChange={(o) => !o && setArmedId(null)}>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`Delete ${s.name}`}
                          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                          title="Delete permanently (removes the folder and all its nodes)"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete "{s.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {s.id === 'default'
                              ? 'Its folder data will be moved into another active folder before the default folder is removed.'
                              : <>This permanently removes the <code className="font-mono">#{s.slug}</code> folder and every node, candidate, edge, and wiki page it contains ({s.node_count} nodes).</>}{' '}
                            Shared documents themselves are untouched — other folders they're routed into
                            keep their copy. This cannot be undone. Confirm twice to proceed.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={delBusyId === s.id}>Cancel</AlertDialogCancel>
                          {armedId === s.id ? (
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              disabled={delBusyId === s.id}
                              onClick={(e) => {
                                e.preventDefault();
                                remove(s.id, s.name);
                              }}
                            >
                              {delBusyId === s.id ? 'Deleting…' : 'Confirm delete'}
                            </AlertDialogAction>
                          ) : (
                            <button
                              className="pome-btn-ghost"
                              onClick={(e) => {
                                e.preventDefault();
                                setArmedId(s.id);
                              }}
                            >
                              I understand — continue
                            </button>
                          )}
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                </>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 border-t pt-4">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Folder name (optional)"
            className="h-9 flex-1"
            aria-label="New folder name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
          <button className="pome-btn inline-flex items-center gap-1.5" onClick={add} disabled={busy || !profileId}>
            <Plus className="size-4" /> Add folder
          </button>
        </div>
      </CardContent>
      <SubfolderSettingsDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        wsId={wsId}
        subgraph={editing}
        onSaved={load}
      />
    </Card>
  );
}
