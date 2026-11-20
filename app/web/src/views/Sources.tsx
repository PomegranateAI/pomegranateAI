import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ScrollText, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api.js';
import type { AppSourceItem, DocumentRecord, Subgraph } from '../api.js';
import { MediaAttachments } from '../components/NodeMedia';
import { AUDIENCE_LABEL, type Audience } from '../audience.js';
import { AudienceSelect } from '../components/AudienceSelect.js';
import { PendingRoutesBanner } from './Curate.js';
import { MediaReaderAlert } from '../components/MediaReaderAlert.js';
import {
  ALL_ACCEPT,
  DOCUMENT_HINT,
  missingMediaReader,
  readerErrorFrom,
  uploadKind,
  type MissingReader,
} from '@/lib/upload-formats';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function Sources({
  wsId,
  subgraphs = [],
  initialAppId = null,
  onNavigate,
  onViewDocument,
}: {
  wsId: string;
  /** Workspace's active subfolders, for the destination picker. */
  subgraphs?: Subgraph[];
  /** Re-select this app on the "From your apps" tab — used when an OAuth connect redirect returns here. */
  initialAppId?: string | null;
  /** Navigate to the Automations tab — see the link below (redesign of the old embedded Rules card). */
  onNavigate?: (target: 'automations') => void;
  /** Jump to the Library, scoped to a subfolder and (optionally) pre-filtered
   *  to one document's nodes — wired to the "View in Library" toast action
   *  after a successful ingest. Omit documentId to just open the subfolder. */
  onViewDocument?: (subgraphId: string | null, documentId?: string, title?: string) => void;
}) {
  const [docRefresh, setDocRefresh] = useState(0);
  // Bumped alongside docRefresh so the pending-routes banner above refetches
  // the moment an ingest completes, instead of only on its own
  // approve/choose/reject round-trip (which otherwise left a newly-held
  // document invisible until a manual page reload).
  const [pendingRoutesRefresh, setPendingRoutesRefresh] = useState(0);
  const onIngested = useCallback(() => {
    setDocRefresh((n) => n + 1);
    setPendingRoutesRefresh((n) => n + 1);
  }, []);
  return (
    <div className="space-y-6">
      {/* Only renders when the router held a folder decision for review —
          otherwise Curate has nothing to show, so it's absent rather than an
          empty-state card. */}
      <PendingRoutesBanner wsId={wsId} subgraphs={subgraphs} refreshSignal={pendingRoutesRefresh} />

      <AddSourceWidget
        wsId={wsId}
        subgraphs={subgraphs}
        onIngested={onIngested}
        initialAppId={initialAppId}
        onViewDocument={onViewDocument}
      />

      {/* Automations now has its own tab (redesign of the old embedded Rules
          card) — this is just a pointer to it, not the primary action here. */}
      <Card className="shadow-soft">
        <CardContent className="flex items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <ScrollText className="size-5 text-muted-foreground shrink-0" />
            <div>
              <div className="text-sm font-medium">Automations</div>
              <div className="text-xs text-muted-foreground">
                Shape, redact, and auto-approve rules for how sources are ingested and shared.
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate?.('automations')}>
            Manage automations
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="font-serif text-2xl italic">Documents</CardTitle>
          <CardDescription>
            Every ingested source is registered with an auto-extracted summary and stakeholders.
            Re-uploading a changed file bumps its version — multi-source nodes downstream become
            stronger vault.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentsList key={wsId} wsId={wsId} refresh={docRefresh} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The "Add to the library" widget on its own — no documents list. Reused
 * standalone (e.g. in a modal launched from within a subfolder, preselecting
 * that subfolder as the destination) and embedded in the full Sources page.
 */
export function AddSourceWidget({
  wsId,
  subgraphs = [],
  defaultSubgraphId = null,
  onIngested,
  bare = false,
  initialAppId = null,
  onViewDocument,
}: {
  wsId: string;
  /** Workspace's active subfolders, for the destination picker. */
  subgraphs?: Subgraph[];
  /** Preselected destination — e.g. the subfolder the user opened this from. */
  defaultSubgraphId?: string | null;
  onIngested?: () => void;
  /** Skip the Card chrome (title/description) — for embedding inside another dialog/card. */
  bare?: boolean;
  /** Re-select this app on the "From your apps" tab — used when an OAuth connect redirect returns here. */
  initialAppId?: string | null;
  /** Jump to the Library, scoped to a subfolder and (optionally) pre-filtered to one document's nodes. */
  onViewDocument?: (subgraphId: string | null, documentId?: string, title?: string) => void;
}) {
  const [destSubgraphId, setDestSubgraphId] = useState<string | null>(defaultSubgraphId);
  const [instructions, setInstructions] = useState('');

  const body = (
    <Tabs defaultValue="apps">
      <TabsList className="mb-4">
        <TabsTrigger value="apps">From your apps</TabsTrigger>
        <TabsTrigger value="upload">Upload file</TabsTrigger>
        <TabsTrigger value="paste">Paste or write</TabsTrigger>
      </TabsList>
      <TabsContent value="apps">
        <InstructionsField value={instructions} onChange={setInstructions} />
        <DestinationPicker
          subgraphs={subgraphs}
          value={destSubgraphId}
          onChange={setDestSubgraphId}
          disabled={instructions.trim().length > 0}
        />
        <AppsIngest
          wsId={wsId}
          onIngested={onIngested}
          subgraphId={destSubgraphId ?? undefined}
          initialAppId={initialAppId}
          instructions={instructions}
          onViewDocument={onViewDocument}
        />
      </TabsContent>
      <TabsContent value="upload">
        <InstructionsField value={instructions} onChange={setInstructions} />
        <DestinationPicker
          subgraphs={subgraphs}
          value={destSubgraphId}
          onChange={setDestSubgraphId}
          disabled={instructions.trim().length > 0}
        />
        <FileUploader
          wsId={wsId}
          onIngested={onIngested}
          subgraphId={destSubgraphId ?? undefined}
          subgraphs={subgraphs}
          instructions={instructions}
          onViewDocument={onViewDocument}
        />
      </TabsContent>
      <TabsContent value="paste">
        <InstructionsField value={instructions} onChange={setInstructions} />
        <DestinationPicker
          subgraphs={subgraphs}
          value={destSubgraphId}
          onChange={setDestSubgraphId}
          disabled={instructions.trim().length > 0}
        />
        <PasteIngest
          wsId={wsId}
          onIngested={onIngested}
          subgraphId={destSubgraphId ?? undefined}
          instructions={instructions}
          onViewDocument={onViewDocument}
        />
      </TabsContent>
    </Tabs>
  );

  if (bare) return body;

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Add to folders</CardTitle>
        <CardDescription>
          Pull straight from a connected app — or drop a file, paste and write directly. Synthesis
          runs and candidate updates queue up in Curate; the document is registered with its
          summary and stakeholders.
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

// Destination picker — "Automated" (default) reads the document and routes
// it; picking a specific folder skips routing entirely (no router LLM call,
// no relevance check) and files straight into that subfolder.
const ROUTER_VALUE = '__router__';

function DestinationPicker({
  subgraphs,
  value,
  onChange,
  disabled,
}: {
  subgraphs: Subgraph[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  if (subgraphs.length === 0) return null;
  if (disabled) {
    return (
      <div className="mb-4 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
        The agent decides the destination when instructions are given — it can also create a
        new folder.
      </div>
    );
  }
  const direct = value !== null;
  return (
    <div className="mb-4 space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value ?? ROUTER_VALUE}
          onValueChange={(v) => onChange(v === ROUTER_VALUE ? null : v)}
        >
          <SelectTrigger className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ROUTER_VALUE}>
              Automated <span className="text-muted-foreground">(default)</span>
            </SelectItem>
            <SelectSeparator />
            {subgraphs.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {direct
            ? 'Always lands here — no relevance check, even a wrong fit.'
            : 'The router reads the document and decides which folder(s) it belongs in.'}
        </span>
      </div>
    </div>
  );
}

// Optional free-text steer for what to do with this source — e.g. "pull out
// the people mentioned into a People folder, create it if it doesn't exist."
// When non-empty, an agent (not the plain router) decides how to shape the
// document and where it goes, instead of the DestinationPicker above.
function InstructionsField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-3 space-y-1.5">
      <Label htmlFor="add-source-instructions">Instructions (optional)</Label>
      <Textarea
        id="add-source-instructions"
        placeholder={
          "e.g. “pull out the people mentioned into a People folder, create it if it doesn't exist”"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[60px] text-sm"
      />
    </div>
  );
}

function FileUploader({
  wsId,
  onIngested,
  subgraphId,
  subgraphs = [],
  instructions,
  onViewDocument,
}: {
  wsId: string;
  onIngested?: () => void;
  subgraphId?: string;
  subgraphs?: Subgraph[];
  instructions?: string;
  onViewDocument?: (subgraphId: string | null, documentId?: string, title?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [missingReader, setMissingReader] = useState<MissingReader | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function ingest(file: File) {
    const kind = uploadKind(file.name);
    if (!kind) {
      const msg = `${file.name}: this file type can’t be read. Upload a document (${DOCUMENT_HINT}), an audio file, or an image.`;
      setErr(msg);
      toast.error('Unsupported file type', { description: msg });
      return;
    }
    setBusy(true);
    setErr(null);
    setLast(null);
    const trimmed = instructions?.trim();
    const mediaFile = kind !== 'document';
    // Media always lands in the chosen folder (the agent route is text-only),
    // so that folder's data agents must be able to read it.
    const folder = trimmed && !mediaFile ? undefined : subgraphId;
    try {
      const needsReader = await missingMediaReader(wsId, file, folder);
      if (needsReader) {
        setMissingReader(needsReader);
        return;
      }
      const r = await api.ingestFile(wsId, file, folder, trimmed || undefined);
      // A document held for a folder decision has no extracted nodes yet —
      // say so plainly instead of a misleading "0 candidates queued", and
      // point at the review banner above rather than a dead-end library link.
      const msg = r.pending_approval
        ? `${file.name} needs a folder decision — review it above.`
        : r.agent
          ? (r.message ?? 'Done.')
          : ['audio', 'image'].includes(r.kind)
            ? `${file.name}: ${r.candidates > 0 ? 'text added to Folders' : 'extracted text stored; no entries created'}.`
            : `${file.name}: ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} queued in Curate.`;
      setLast(msg);
      toast.success('Source ingested', {
        description: msg,
        action:
          !r.pending_approval && r.document_id
            ? {
                label: 'View in Folders',
                onClick: () => onViewDocument?.(r.subgraph?.id ?? null, r.document_id, file.name),
              }
            : undefined,
      });
      onIngested?.();
    } catch (ex: any) {
      const needsReader = readerErrorFrom(ex, file, folder);
      if (needsReader) {
        setMissingReader(needsReader);
        return;
      }
      setErr(ex.message);
      toast.error('Upload failed', { description: ex.message });
    } finally {
      setBusy(false);
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await ingest(file);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await ingest(file);
  }

  return (
    <div className="space-y-2">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? 'border-pome-red bg-pome-red/5' : 'border-border bg-muted/30 hover:bg-muted/50'
        } ${busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        <UploadCloud className="size-7 text-muted-foreground" />
        <span className="text-sm font-medium">Drop a file or click to browse</span>
        <span className="font-mono text-xs text-muted-foreground">Documents, audio & images · 25 MB max</span>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={onPick}
          disabled={busy}
          accept={ALL_ACCEPT}
        />
      </label>
      <MediaReaderAlert
        missing={missingReader}
        folderName={subgraphs.find((sg) => sg.id === missingReader?.folderId)?.name}
        onClose={() => setMissingReader(null)}
      />
      {busy && <p className="muted small text-sm text-muted-foreground">Synthesizing…</p>}
      {last && <p className="muted small text-sm text-muted-foreground">{last}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

function PasteIngest({
  wsId,
  onIngested,
  subgraphId,
  instructions,
  onViewDocument,
}: {
  wsId: string;
  onIngested?: () => void;
  subgraphId?: string;
  instructions?: string;
  onViewDocument?: (subgraphId: string | null, documentId?: string, title?: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    setLast(null);
    try {
      const ref = `pasted-${new Date().toISOString().slice(0, 10)}`;
      const trimmed = instructions?.trim();
      const r = await api.ingest(wsId, text, 'doc', ref, trimmed ? undefined : subgraphId, trimmed || undefined);
      const msg = r.pending_approval
        ? `${ref} needs a folder decision — review it above.`
        : r.agent
          ? (r.message ?? 'Done.')
          : `${ref}: ${r.candidates} candidate${r.candidates === 1 ? '' : 's'} queued in Curate.`;
      setLast(msg);
      toast.success('Source ingested', {
        description: msg,
        action:
          !r.pending_approval && r.document_id
            ? {
                label: 'View in Folders',
                onClick: () => onViewDocument?.(r.subgraph?.id ?? null, r.document_id, ref),
              }
            : undefined,
      });
      setText('');
      onIngested?.();
    } catch (ex: any) {
      toast.error('Ingest failed', { description: ex.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="paste-text">Content</Label>
        <Textarea
          id="paste-text"
          placeholder="Paste a doc, meeting notes, a Slack thread — or write directly. Everything strategic gets extracted; the rest is ignored."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          className="min-h-[180px] font-mono text-sm"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={busy || !text.trim()} className="pome-btn">
          {busy ? 'Synthesizing…' : 'Add to folders'}
        </Button>
        <span className="font-mono text-xs text-muted-foreground">
          {text.length > 0 ? `${text.length.toLocaleString()} chars` : ''}
        </span>
      </div>
      {last && <p className="text-sm text-muted-foreground">{last}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "From your apps" — Composio-backed connectors. Each user connects their own
// account inline here (ConnectAppPanel); preview plans the request and fetches
// with that account, and pull ingests the selection through the shared
// pipeline. Until the app is connected the server answers app_not_connected.
// ---------------------------------------------------------------------------

export type AppIconId = 'gmail' | 'gdrive' | 'slack' | 'notion' | 'github' | 'jira' | 'microsoft_teams' | 'fathom';

export type AppDef = {
  id: AppIconId;
  name: string;
  color: string;
  unit: string;
  placeholder: string;
  examples: string[];
  // OAuth apps (authKind: 'oauth') connect via Composio, inline right here in
  // Add Sources (see ConnectAppPanel below).
  implemented: boolean;
  /** Composio-backed OAuth apps connect inline here instead of in Settings. */
  authKind?: 'oauth';
};

export const APPS: AppDef[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    color: '#C5221F',
    unit: 'email',
    placeholder: 'add emails from my manager this week',
    examples: [
      'emails from my manager this week',
      'invoices from last quarter',
      'threads mentioning the roadmap since May',
    ],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'gdrive',
    name: 'Drive',
    color: '#1A7340',
    unit: 'file',
    placeholder: 'the Q3 roadmap doc',
    examples: ['the Q3 roadmap doc', 'the deck shared by alice last week'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'slack',
    name: 'Slack',
    color: '#4A154B',
    unit: 'message',
    placeholder: 'recent messages in #pome-product-update',
    examples: ['recent messages in #pome-product-update', 'messages mentioning "roadmap" in #general'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'notion',
    name: 'Notion',
    color: '#37352F',
    unit: 'page',
    placeholder: 'the onboarding doc',
    examples: ['the onboarding doc', 'the Q3 roadmap page'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'github',
    name: 'GitHub',
    color: '#1F2328',
    unit: 'PR',
    placeholder: 'recent PRs on your-org/your-repo',
    examples: ['recent PRs on your-org/your-repo', 'PRs from zelta on your-org/your-repo'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'jira',
    name: 'Jira',
    color: '#1868DB',
    unit: 'issue',
    placeholder: 'issues in the POM project closed this sprint',
    examples: ['issues in the POM project closed this sprint', 'the whole POM project', 'the Sharing board'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'microsoft_teams',
    name: 'Teams',
    color: '#6264A7',
    unit: 'message',
    placeholder: 'recent messages in the Product team, General channel',
    examples: ['recent messages in the Product team, General channel', 'messages about the launch in my group chat'],
    implemented: true,
    authKind: 'oauth',
  },
  {
    id: 'fathom',
    name: 'Fathom',
    color: '#6C5CE7',
    unit: 'meeting',
    placeholder: 'the call with Northwind from last week',
    examples: ['the call with Northwind from last week', 'the Q3 planning meeting'],
    implemented: true,
    authKind: 'oauth',
  },
];

// Brand marks (path data from simple-icons, CC0) — rendered on a white tile so
// dark logos (GitHub, Notion) stay legible regardless of the app's own theme.
const APP_ICON_PATHS: Record<AppIconId, string> = {
  gmail:
    'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  gdrive:
    'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
  slack:
    'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  notion:
    'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  // Neutral placeholder mark (plain circle) — no verified simple-icons path
  // data for these three on hand; distinguished by each tile's own `color`
  // rather than risking a fabricated/incorrect brand glyph.
  microsoft_teams: 'M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24z',
  fathom: 'M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24z',
};

export function AppIcon({ id, color }: { id: AppIconId; color: string }) {
  return (
    <span className="grid size-6 flex-none place-items-center rounded-md bg-white ring-1 ring-inset ring-black/10">
      <svg viewBox="0 0 24 24" width="14" height="14" fill={color} aria-hidden="true">
        <path d={APP_ICON_PATHS[id]} />
      </svg>
    </span>
  );
}

// Which query pulled a document in, keyed by document id. Client-side only
// (localStorage) — deliberately no schema change; the chip is
// best-effort provenance for the person who pulled, on the machine they used.
type AppPullOrigin = { app: string; query: string };

function loadAppPulls(wsId: string): Record<string, AppPullOrigin> {
  try {
    return JSON.parse(localStorage.getItem(`pome.appPulls.${wsId}`) ?? '{}');
  } catch {
    return {};
  }
}

function recordAppPulls(wsId: string, entries: Record<string, AppPullOrigin>) {
  try {
    localStorage.setItem(
      `pome.appPulls.${wsId}`,
      JSON.stringify({ ...loadAppPulls(wsId), ...entries }),
    );
  } catch {
    // Quota/privacy-mode failures just lose the provenance chip — never the pull.
  }
}

// Connect/disconnect an OAuth-backed app (Composio) inline, right here in Add
// Sources — this is the whole point of moving the workflow out of Settings.
// Never trusts the OAuth redirect completing as proof by itself: after a
// redirect back (App.tsx strips `?returnTo=sources&app=<toolkit>` and
// re-selects this tile), a live refresh call against Composio is what
// actually flips the status — see justReturned below, which fires that live
// check automatically instead of leaving it to a manual "Check status" click.
function ConnectAppPanel({
  app,
  justReturned,
  onStatusChange,
}: {
  app: AppDef;
  /** True on the mount right after this app's OAuth redirect lands back here
   *  (app.id matched the ?app= the redirect carried) — triggers an immediate
   *  live status check instead of waiting for the user to click it. */
  justReturned: boolean;
  /** Bubbles the latest known status up so the parent's tile badges + query section can react. */
  onStatusChange: (status: string | null) => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getAppConnection(app.id);
      setStatus(r.status);
      onStatusChange(r.status);
    } catch {
      /* signed-out or offline — panel stays showing Connect */
    }
    // onStatusChange is a fresh closure each render in the parent; only re-run
    // this effect when the app itself changes, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id]);

  const checkNow = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      setChecking(true);
      try {
        const r = await api.refreshAppConnection(app.id);
        setStatus(r.status);
        onStatusChange(r.status);
        if (r.configured) toast.success(`${app.name} connected`);
        else if (!opts.silent && r.status === 'initiated') toast.info('Still connecting — try "Check status" again in a moment');
      } catch (err) {
        if (!opts.silent) toast.error(`Could not check ${app.name} status`, { description: err instanceof Error ? err.message : undefined });
      } finally {
        setChecking(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [app.id],
  );

  useEffect(() => {
    if (justReturned) {
      // The OAuth redirect landed back here for this tile — the connection
      // is very likely already active on Composio's side, so check live
      // instead of showing stale "connecting" state from before the redirect.
      void checkNow({ silent: true });
    } else {
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, justReturned]);

  async function connect() {
    setBusy(true);
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}?returnTo=sources&app=${app.id}`;
      const r = await api.connectApp(app.id, callbackUrl);
      if (r.redirect_url) {
        window.location.href = r.redirect_url;
        return; // page is navigating away
      }
      toast.error(`${app.name} did not return a connect link`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not start ${app.name} connect`, {
        description: msg.includes('composio_not_configured')
          ? 'This server is not configured for Composio — ask your admin to set COMPOSIO_API_KEY.'
          : msg,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4 text-center">
      <p className="text-sm text-muted-foreground">
        Connect {app.name} to pull real content here — via Composio, a hosted OAuth broker. You
        sign in on {app.name}'s real consent screen; we only ever receive a connection reference,
        never a token.
      </p>
      {status === 'initiated' && (
        <p className="text-sm text-muted-foreground">
          {checking ? `Verifying ${app.name} connection…` : `Connecting — finish the ${app.name} sign-in, then check status.`}
        </p>
      )}
      <div className="flex items-center justify-center gap-2">
        <Button onClick={connect} disabled={busy} className="pome-btn">
          {busy ? 'Working…' : `Connect ${app.name}`}
        </Button>
        {status === 'initiated' && (
          <Button variant="outline" onClick={() => checkNow()} disabled={checking}>
            {checking ? 'Checking…' : 'Check status'}
          </Button>
        )}
      </div>
    </div>
  );
}

// Cadence options offered when saving an apps_pull automation (Stage 3: the
// value is stored but nothing schedules off it yet — see automations/scheduler.ts, Stage 4).
const CADENCE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: 'Every 6 hours', ms: 6 * 60 * 60 * 1000 },
  { label: 'Every 12 hours', ms: 12 * 60 * 60 * 1000 },
  { label: 'Daily', ms: 24 * 60 * 60 * 1000 },
  { label: 'Every 3 days', ms: 3 * 24 * 60 * 60 * 1000 },
  { label: 'Weekly', ms: 7 * 24 * 60 * 60 * 1000 },
];

export function AppsIngest({
  wsId,
  onIngested,
  subgraphId,
  initialAppId,
  instructions,
  mode = 'once',
  onAutomationSaved,
  onViewDocument,
}: {
  wsId: string;
  onIngested?: () => void;
  subgraphId?: string;
  /** Re-select this app on mount — used when the OAuth connect redirect returns here (see App.tsx). */
  initialAppId?: string | null;
  instructions?: string;
  /**
   * 'once' (default) = today's Add Source behavior: preview, check items,
   * "Add N as documents" pulls them immediately. 'schedule' = the same
   * picker/preview, but the primary action saves an apps_pull automation
   * (connector + criteria) instead of pulling right now — used by the
   * Automations tab's Ingestion creation flow.
   */
  mode?: 'once' | 'schedule';
  onAutomationSaved?: () => void;
  onViewDocument?: (subgraphId: string | null, documentId?: string, title?: string) => void;
}) {
  const [app, setApp] = useState<AppDef>(() => APPS.find((a) => a.id === initialAppId) ?? APPS[0]);
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<'idle' | 'searching' | 'pulling'>('idle');
  const [preview, setPreview] = useState<{ query: string; unit: string; items: AppSourceItem[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // GitHub only: pull files from a branch instead of PRs. A separate mode
  // (not just a query hint) because it bypasses the LLM planner entirely once
  // repo/branch/path are given structurally — see github-live.ts.
  const [filesMode, setFilesMode] = useState(false);
  const [ghRepo, setGhRepo] = useState('');
  const [ghBranch, setGhBranch] = useState('');
  const [ghPath, setGhPath] = useState('');
  const [ghBranches, setGhBranches] = useState<Array<{ name: string; protected: boolean }>>([]);
  const [ghBranchesLoading, setGhBranchesLoading] = useState(false);
  // Slack only: DMs/group DMs have no natural freehand name (see
  // slack-live.ts's resolveSlackConversation), so a picker is the only way to
  // reach them — channels can still be typed in the query field as before.
  const [slackChannel, setSlackChannel] = useState('');
  const [slackConversations, setSlackConversations] = useState<Array<{ id: string; type: string; name: string }>>([]);
  const [slackConvLoading, setSlackConvLoading] = useState(false);
  // Connection status per app id — an app shows "connected" only when its
  // keys/passwords are present server-side; everything else is disconnected.
  // Absent until the status call returns, so we default to disconnected.
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  // schedule mode only — which cadence to save the automation with.
  const [cadenceMs, setCadenceMs] = useState<number>(CADENCE_OPTIONS[2].ms);

  const refreshConnected = useCallback(() => {
    api
      .appsStatus(wsId)
      .then((r) => setConnected(Object.fromEntries(r.apps.map((a) => [a.id, a.connected]))))
      .catch(() => {
        // Status is best-effort — a failed fetch just leaves every app
        // showing "disconnected", which is the correct default anyway.
      });
  }, [wsId]);

  useEffect(() => {
    refreshConnected();
  }, [refreshConnected]);

  const slackConnected = connected['slack'];
  useEffect(() => {
    if (app.id !== 'slack' || !slackConnected) return;
    setSlackConvLoading(true);
    api
      .listAppPickerItems('slack')
      .then((r) => setSlackConversations(r.items as Array<{ id: string; type: string; name: string }>))
      .catch(() => setSlackConversations([]))
      .finally(() => setSlackConvLoading(false));
  }, [app.id, slackConnected]);

  function selectApp(next: AppDef) {
    setApp(next);
    setQuery('');
    setPreview(null);
    setFilesMode(false);
    setGhRepo('');
    setGhBranch('');
    setGhPath('');
    setGhBranches([]);
    setSlackChannel('');
  }

  async function loadGhBranches() {
    const repo = ghRepo.trim();
    if (!repo) return;
    setGhBranchesLoading(true);
    try {
      const r = await api.listGithubBranches(repo);
      setGhBranches(r.branches);
      if (r.branches.length && !r.branches.some((b) => b.name === ghBranch)) {
        setGhBranch(r.branches[0].name);
      }
    } catch (ex: any) {
      toast.error('Could not list branches', { description: ex.message });
    } finally {
      setGhBranchesLoading(false);
    }
  }

  function currentGithubFiles() {
    if (app.id !== 'github' || !filesMode) return undefined;
    return {
      repo: ghRepo.trim() || undefined,
      branch: ghBranch.trim() || undefined,
      path: ghPath.trim() || undefined,
    };
  }

  function currentSlackChannel() {
    if (app.id !== 'slack') return undefined;
    return slackChannel.trim() || undefined;
  }

  async function runPreview(q0?: string) {
    const q = (q0 ?? query).trim();
    const githubFiles = currentGithubFiles();
    const slackChannelVal = currentSlackChannel();
    if ((!q && !githubFiles?.repo && !slackChannelVal) || phase !== 'idle') return;
    setPhase('searching');
    setPreview(null);
    try {
      const r = await api.appsPreview(wsId, app.id, q, githubFiles, slackChannelVal);
      setPreview({ query: q, unit: r.unit, items: r.items });
      setChecked(new Set(r.items.map((i) => i.id)));
    } catch (ex: any) {
      toast.error('Preview failed', { description: ex.message });
    } finally {
      setPhase('idle');
    }
  }

  async function pull() {
    if (!preview || checked.size === 0 || phase !== 'idle') return;
    setPhase('pulling');
    try {
      const r = await api.appsPull(
        wsId,
        app.id,
        preview.query,
        [...checked],
        subgraphId,
        instructions?.trim() || undefined,
        currentGithubFiles(),
        currentSlackChannel(),
      );
      recordAppPulls(
        wsId,
        Object.fromEntries(
          r.results.map((x) => [x.document_id, { app: app.name.toLowerCase(), query: preview.query }]),
        ),
      );
      const n = r.results.length;
      // An agent (instructions given) can decide not to ingest at all —
      // r.message explains why instead of a candidate count.
      toast.success(n > 0 ? 'Sources ingested' : (r.message ?? 'Done.'), {
        description:
          n > 0
            ? `${n} ${preview.unit}${n === 1 ? '' : 's'} added from ${app.name} — ${r.total_candidates} candidate${r.total_candidates === 1 ? '' : 's'} queued in Curate.`
            : undefined,
        // Only offered when a specific folder was picked (not "Automated") —
        // the router can fan a multi-item pull across several subfolders, so
        // there's no single destination to link to when it decided.
        action:
          n > 0 && subgraphId
            ? { label: 'View in Folders', onClick: () => onViewDocument?.(subgraphId) }
            : undefined,
      });
      setPreview(null);
      setQuery('');
      onIngested?.();
    } catch (ex: any) {
      toast.error('Pull failed', { description: ex.message });
    } finally {
      setPhase('idle');
    }
  }

  // schedule mode: save the current query/criteria as a recurring apps_pull
  // automation instead of pulling right now. Every run re-matches the SAME
  // criteria fresh — there's no per-item checkbox selection to persist across
  // runs, so this doesn't gate on `checked` the way pull() does.
  async function saveAsAutomation() {
    if (!preview || phase !== 'idle') return;
    setPhase('pulling');
    try {
      const githubFiles = currentGithubFiles();
      const slackChannelVal = currentSlackChannel();
      await api.saveAppsPullAutomation(wsId, {
        connector: app.id,
        criteria: {
          query: preview.query,
          ...(githubFiles ? { github: { ...githubFiles, mode: filesMode ? 'files' : 'prs' } } : {}),
          ...(slackChannelVal ? { slack: { channel: slackChannelVal } } : {}),
        },
        subgraph_id: subgraphId,
        run_instructions: instructions?.trim() || undefined,
        cadence_ms: cadenceMs,
      });
      toast.success('Automation saved', {
        description: `${app.name} will be checked on this cadence — manage it from Automations.`,
      });
      setPreview(null);
      setQuery('');
      onAutomationSaved?.();
    } catch (ex: any) {
      toast.error('Could not save automation', { description: ex.message });
    } finally {
      setPhase('idle');
    }
  }

  const selected = preview ? preview.items.filter((i) => checked.has(i.id)).length : 0;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>App</Label>
        <div className="flex flex-wrap gap-2">
          {APPS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => selectApp(a)}
              aria-pressed={a.id === app.id}
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 pl-2 text-left transition-colors ${
                a.id === app.id
                  ? 'border-pome-red bg-pome-red/5'
                  : 'border-input hover:border-pome-red/40'
              }`}
            >
              <AppIcon id={a.id} color={a.color} />
              <span>
                <span className="block text-sm font-medium leading-tight">{a.name}</span>
                {!a.implemented ? (
                  <span className="flex items-center gap-1 font-mono text-[0.58rem] uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    <span className="size-1 rounded-full bg-amber-500" />
                    coming soon
                  </span>
                ) : connected[a.id] ? (
                  <span className="flex items-center gap-1 font-mono text-[0.58rem] uppercase tracking-wide text-flag-green">
                    <span className="size-1 rounded-full bg-flag-green" />
                    connected
                  </span>
                ) : (
                  <span className="flex items-center gap-1 font-mono text-[0.58rem] uppercase tracking-wide text-muted-foreground">
                    <span className="size-1 rounded-full bg-muted-foreground/60" />
                    disconnected
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        {app.authKind === 'oauth' && connected[app.id] && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-flag-red hover:underline"
            onClick={async () => {
              try {
                await api.disconnectApp(app.id);
                toast.success(`${app.name} disconnected`);
                refreshConnected();
              } catch (err) {
                toast.error('Could not disconnect', { description: err instanceof Error ? err.message : undefined });
              }
            }}
          >
            Disconnect {app.name}
          </button>
        )}
      </div>

      {app.authKind === 'oauth' && !connected[app.id] ? (
        <ConnectAppPanel
          app={app}
          justReturned={app.id === initialAppId}
          onStatusChange={(status) => status === 'active' && refreshConnected()}
        />
      ) : (
      <div className="space-y-1.5">
        {app.id === 'github' && (
          <div className="flex items-center gap-1.5 pb-1">
            {(['prs', 'files'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setFilesMode(m === 'files');
                  setPreview(null);
                }}
                disabled={phase !== 'idle'}
                className={`rounded-full border px-2.5 py-0.5 font-mono text-[0.7rem] transition-colors ${
                  (m === 'files') === filesMode
                    ? 'border-pome-red bg-pome-red/10 text-pome-red'
                    : 'border-input text-muted-foreground hover:border-pome-red/40'
                }`}
              >
                {m === 'prs' ? 'Pull requests' : 'Files from a branch'}
              </button>
            ))}
          </div>
        )}

        {filesMode && (
          <div className="grid grid-cols-1 gap-2 rounded-md border bg-muted/20 p-2.5 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="gh-repo" className="text-[0.65rem] text-muted-foreground">
                Repo (owner/name)
              </Label>
              <Input
                id="gh-repo"
                className="font-mono text-sm"
                placeholder="your-org/your-repo"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                onBlur={loadGhBranches}
                disabled={phase !== 'idle'}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gh-branch" className="text-[0.65rem] text-muted-foreground">
                Branch
              </Label>
              <select
                id="gh-branch"
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 font-mono text-sm"
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                disabled={phase !== 'idle' || ghBranchesLoading}
              >
                <option value="">{ghBranchesLoading ? 'Loading…' : 'default'}</option>
                {ghBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                    {b.protected ? ' 🔒' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="gh-path" className="text-[0.65rem] text-muted-foreground">
                Path (optional)
              </Label>
              <Input
                id="gh-path"
                className="font-mono text-sm"
                placeholder="src/"
                value={ghPath}
                onChange={(e) => setGhPath(e.target.value)}
                disabled={phase !== 'idle'}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        {app.id === 'slack' && (
          <div className="space-y-1">
            <Label htmlFor="slack-conv" className="text-[0.65rem] text-muted-foreground">
              Pick a conversation (needed for DMs — channels can also be typed below)
            </Label>
            <select
              id="slack-conv"
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 font-mono text-sm"
              value={slackChannel}
              onChange={(e) => setSlackChannel(e.target.value)}
              disabled={phase !== 'idle' || slackConvLoading}
            >
              <option value="">{slackConvLoading ? 'Loading…' : "— type a channel name below instead —"}</option>
              {(['channel', 'im', 'mpim'] as const).map((t) => {
                const group = slackConversations.filter((c) => c.type === t);
                if (group.length === 0) return null;
                const label = t === 'channel' ? 'Channels' : t === 'im' ? 'Direct messages' : 'Group DMs';
                return (
                  <optgroup key={t} label={label}>
                    {group.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
        )}

        <Label htmlFor="apps-query">
          {filesMode ? 'Optional topic filter' : slackChannel ? 'Optional topic filter' : 'What to pull'}
        </Label>
        <div className="flex gap-2">
          <Input
            id="apps-query"
            className="flex-1 font-mono text-sm"
            placeholder={
              filesMode
                ? 'e.g. files about authentication'
                : slackChannel
                  ? 'e.g. messages about the customer call'
                  : app.placeholder
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runPreview();
            }}
            disabled={phase !== 'idle'}
            autoComplete="off"
          />
          <Button
            variant="outline"
            onClick={() => runPreview()}
            disabled={phase !== 'idle' || (!query.trim() && !(filesMode && ghRepo.trim()) && !slackChannel.trim())}
          >
            {phase === 'searching' ? `Searching ${app.name}…` : 'Preview matches'}
          </Button>
        </div>
        {!filesMode && !slackChannel && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[0.7rem] text-muted-foreground">try</span>
            {app.examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setQuery(ex);
                  runPreview(ex);
                }}
                disabled={phase !== 'idle'}
                className="rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground transition-colors hover:border-pome-red/40 hover:bg-pome-red/5 hover:text-pome-red"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>
      )}

      {preview && (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
            <span className="font-mono text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {preview.items.length} {preview.unit}
                {preview.items.length === 1 ? '' : 's'}
              </span>{' '}
              match “{preview.query}” in {app.name}
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[0.65rem] text-muted-foreground">
              <input
                type="checkbox"
                className="accent-pome-red"
                checked={selected === preview.items.length}
                onChange={(e) =>
                  setChecked(e.target.checked ? new Set(preview.items.map((i) => i.id)) : new Set())
                }
              />
              select all
            </label>
          </div>
          <ul className="max-h-72 divide-y overflow-y-auto">
            {preview.items.map((item) => (
              <li key={item.id}>
                <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-pome-red/5">
                  <input
                    type="checkbox"
                    className="mt-1 accent-pome-red"
                    checked={checked.has(item.id)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      setChecked(next);
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.title}</span>
                    <span className="block font-mono text-[0.65rem] text-muted-foreground">{item.meta}</span>
                    <span className="block truncate text-sm text-muted-foreground">{item.snippet}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3 border-t px-3 py-2.5">
            {mode === 'schedule' ? (
              <>
                <select
                  className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-xs"
                  value={cadenceMs}
                  onChange={(e) => setCadenceMs(Number(e.target.value))}
                  disabled={phase !== 'idle'}
                >
                  {CADENCE_OPTIONS.map((o) => (
                    <option key={o.ms} value={o.ms}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Button onClick={saveAsAutomation} disabled={phase !== 'idle'} className="pome-btn">
                  {phase === 'pulling' ? 'Saving…' : 'Save as automation'}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Re-checked on this cadence — every match is ingested each run, not just what's checked here.
                </span>
              </>
            ) : (
              <>
                <Button onClick={pull} disabled={phase !== 'idle' || selected === 0} className="pome-btn">
                  {phase === 'pulling'
                    ? 'Synthesizing…'
                    : `Add ${selected} as document${selected === 1 ? '' : 's'}`}
                </Button>
                <span className="text-xs text-muted-foreground">
                  Each match becomes its own source — candidates queue in Curate as usual.
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const DOCUMENTS_PAGE_SIZE = 10;

function DocumentsList({ wsId, refresh }: { wsId: string; refresh: number }) {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<string | null>(null);
  // Only show per-document routing chips when the workspace has >1 subgraph;
  // single-profile workspaces don't need the noise.
  const [multiSubgraph, setMultiSubgraph] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPage(1);
    // silent: a background poll — never clobber a shown list with an error
    // spinner if the refetch blips.
    async function load(silent = false) {
      try {
        if (!silent) setErr(null);
        const [r, sg] = await Promise.all([
          api.listDocuments(wsId),
          api.listSubgraphs(wsId).catch(() => ({ subgraphs: [] })),
        ]);
        if (!cancelled) {
          setDocs(r.documents);
          setPage((current) => Math.min(current, Math.max(1, Math.ceil(r.documents.length / DOCUMENTS_PAGE_SIZE))));
          setMultiSubgraph(sg.subgraphs.length > 1);
        }
      } catch (e: any) {
        if (!cancelled && !silent) setErr(e?.message ?? 'Failed to load documents');
      }
    }
    load();
    // Poll while visible so a source added out-of-band (a different subgraph,
    // MCP, or accepted in Curate) surfaces here without a remount — mirrors the
    // Curate inbox's own refresh.
    const handle = window.setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [wsId, refresh]);

  if (err) {
    return <p className="text-sm text-destructive">{err}</p>;
  }
  if (docs === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (docs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No documents yet — upload a file or paste text above.
      </p>
    );
  }
  // Best-effort "pulled from" provenance for app-pulled documents; stored
  // client-side by AppsIngest (no server schema).
  const pullOrigins = loadAppPulls(wsId);
  const pageCount = Math.ceil(docs.length / DOCUMENTS_PAGE_SIZE);
  const pageStart = (page - 1) * DOCUMENTS_PAGE_SIZE;
  return (
    <div className="space-y-4">
      <ul className="doc-list flex flex-col divide-y">
        {docs.slice(pageStart, pageStart + DOCUMENTS_PAGE_SIZE).map((d) => (
          <DocumentRow
            key={d.id}
            wsId={wsId}
            doc={d}
            showRouting={multiSubgraph}
            pullOrigin={pullOrigins[d.id]}
          />
        ))}
      </ul>
      {pageCount > 1 && (
        <nav aria-label="Documents pagination" className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            Showing {pageStart + 1}–{Math.min(pageStart + DOCUMENTS_PAGE_SIZE, docs.length)} of {docs.length} documents
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((current) => current - 1)}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {page} of {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page === pageCount} onClick={() => setPage((current) => current + 1)}>
              Next
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}

/** Extraction outcome across every subgraph: what the pipeline did with this
 * source. Pending items dominate (that's the action item); otherwise show what
 * made it into the graph. Absent counts (older server) render nothing. */
export function ProcessingStatus({ counts }: { counts?: DocumentRecord['candidates'] }) {
  if (!counts) return null;
  if (counts.pending > 0) {
    return (
      <Badge className="border-transparent bg-amber-500/15 font-mono text-[0.65rem] text-amber-700 dark:text-amber-400">
        {counts.pending} to review
      </Badge>
    );
  }
  if (counts.approved > 0) {
    return (
      <Badge className="border-transparent bg-emerald-500/15 font-mono text-[0.65rem] text-emerald-700 dark:text-emerald-400">
        {counts.approved} integrated
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-mono text-[0.65rem] text-muted-foreground">
      {counts.rejected > 0 ? 'nothing accepted' : 'nothing extracted'}
    </Badge>
  );
}

// Cloud per-source audience control. "Share the whole source" fans the chosen
// audience out over every node extracted from the document (the backend loops
// the nodes and sets each one's visibility). Set-only: it applies a new
// audience rather than reading the current per-node mix, so the pill reflects
// the last choice made here, not a live aggregate.
function SourceAudience({ wsId, docId }: { wsId: string; docId: string }) {
  // Set-only: fans the chosen audience over every node of the source, so the
  // pill reflects the last choice here, not a live per-node aggregate. Starts
  // at 'team' (the node default).
  const [cur, setCur] = useState<Audience>('team');
  const [busy, setBusy] = useState(false);

  async function apply(aud: Audience) {
    setBusy(true);
    try {
      const r = await api.setSourceVisibility(wsId, docId, aud);
      setCur(aud);
      toast.success(
        `${AUDIENCE_LABEL[aud]} — ${r.changed} node${r.changed === 1 ? '' : 's'} updated`,
        r.skipped ? { description: `${r.skipped} node${r.skipped === 1 ? '' : 's'} skipped (not yours to change)` } : undefined,
      );
    } catch (e: any) {
      toast.error('Could not change sharing', { description: e?.message ?? '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span onClick={(e) => e.stopPropagation()}>
      <AudienceSelect value={cur} onChange={apply} disabled={busy} align="right" />
    </span>
  );
}

/**
 * A narrow, vertical list of compact document chips — one line per
 * document, source ref only, full detail (version, kind) in the tooltip.
 * This is the pre-simplification Library "Documents" column style
 * (`RelationshipMap`'s left-hand list, `w-44 shrink-0 space-y-1.5`, one
 * `h-8` chip per doc — dropped along with the rest of Map view in #327b214
 * "remove Map and Wiki tabs from Library"), revived here for the
 * data-agent Sources section (§4.1) and the Report (§4.3) instead of the
 * full-width `DocumentRow` below, which is built for the standalone
 * Sources page's much wider single-column list and reads as a crowded,
 * badge-heavy row when dropped into Library's narrower context.
 *
 * Deliberately carries NO processing-status badge: §4.1 is explicit that a
 * document with several extracted entries and one with none must look
 * IDENTICAL here — "both are just 'the document'" — the difference shows up
 * in the category sections above, not in this list.
 */
export function SourceChipList({ documents }: { documents: DocumentRecord[] }) {
  if (documents.length === 0) {
    return <p className="text-xs text-muted-foreground">No documents yet.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {documents.map((d) => (
        <div
          key={d.id}
          className="graph-map-doc flex h-8 items-center rounded-md border bg-muted/50 px-2.5"
          title={`${d.source_ref} · v${d.version}${d.source_kind ? ` · ${d.source_kind}` : ''}`}
        >
          <code className="truncate font-mono text-xs">{d.source_ref}</code>
        </div>
      ))}
    </div>
  );
}

// Exported so other Library-shaped surfaces still reach for the full row
// when they want every affordance (routing, tracking, download, audience) —
// SourceChipList above is the deliberately thinner alternative.
export function DocumentRow({
  wsId,
  doc,
  showRouting,
  pullOrigin,
}: {
  wsId: string;
  doc: DocumentRecord;
  showRouting: boolean;
  pullOrigin?: AppPullOrigin;
}) {
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [routing, setRouting] = useState<Array<{ subgraph_id: string; slug: string; name: string }> | null>(null);
  const hasSummary = !!doc.summary && doc.summary.trim().length > 0;

  // Which subgraph(s) this shared document was extracted into.
  useEffect(() => {
    if (!showRouting) return;
    let cancelled = false;
    api
      .getDocumentRouting(wsId, doc.id)
      .then((r) => {
        if (!cancelled) setRouting(r.routing);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wsId, doc.id, showRouting]);
  // downloadable === undefined (older server response) → optimistic; a
  // click 404s into the error toast at worst.
  const canDownload = doc.downloadable !== false;

  async function download() {
    setDownloading(true);
    try {
      const blob = await api.downloadDocumentText(wsId, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(doc.source_ref.split('/').pop() ?? doc.id).replace(/\.[a-z0-9]{1,5}$/i, '')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error('Download failed', { description: e?.message ?? '' });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="doc-row py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <code className="doc-ref font-mono text-sm">{doc.source_ref}</code>
        <Badge variant="secondary" className="font-mono text-[0.65rem] uppercase tracking-wider">
          {doc.source_kind}
        </Badge>
        <Badge
          variant={doc.version >= 2 ? 'default' : 'outline'}
          className={
            doc.version >= 2
              ? 'border-transparent bg-pome-red text-primary-foreground font-mono text-[0.65rem]'
              : 'font-mono text-[0.65rem] text-muted-foreground'
          }
          title={doc.version >= 2 ? 'Re-ingested after a content change' : undefined}
        >
          v{doc.version}
        </Badge>
        <ProcessingStatus counts={doc.candidates} />
        <SourceAudience wsId={wsId} docId={doc.id} />
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={
            doc.last_ingested_at && doc.last_ingested_at !== doc.created_at
              ? `First added ${new Date(doc.created_at).toLocaleString()} · last ingested ${new Date(doc.last_ingested_at).toLocaleString()}`
              : undefined
          }
        >
          {new Date(doc.last_ingested_at ?? doc.created_at).toLocaleDateString()}
        </span>
        <button
          type="button"
          onClick={download}
          disabled={downloading || !canDownload}
          title={canDownload ? 'Download as text file' : 'Raw text was not stored for this document'}
          aria-label={`Download ${doc.source_ref} as text file`}
          className="doc-download inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      </div>
      {pullOrigin && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[0.7rem] text-muted-foreground">pulled from</span>
          <span
            className="doc-chip inline-flex items-center rounded-full border border-pome-red/40 bg-pome-red/5 px-2 py-0.5 font-mono text-[0.7rem] text-pome-red"
            title={`Pulled by the query “${pullOrigin.query}”`}
          >
            {pullOrigin.app} · {pullOrigin.query.length > 40 ? `${pullOrigin.query.slice(0, 39)}…` : pullOrigin.query}
          </span>
        </div>
      )}
      {showRouting && routing && routing.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[0.7rem] text-muted-foreground">routed to</span>
          {routing.map((r) => (
            <span
              key={r.subgraph_id}
              className="doc-chip inline-flex items-center rounded-full border border-pome-red/40 bg-pome-red/5 px-2 py-0.5 font-mono text-[0.7rem] text-pome-red"
              title={`#${r.slug}`}
            >
              {r.name}
            </span>
          ))}
        </div>
      )}
      {doc.stakeholders.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {doc.stakeholders.map((s) => (
            <span
              key={s}
              className="doc-chip inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-[0.7rem] text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {hasSummary && (
        <Collapsible open={open} onOpenChange={setOpen}>
          {!open && (
            <p className="doc-summary mt-1.5 line-clamp-2 text-sm text-muted-foreground">
              {doc.summary}
            </p>
          )}
          <CollapsibleContent>
            <p className="doc-summary mt-1.5 text-sm text-muted-foreground">{doc.summary}</p>
          </CollapsibleContent>
          <CollapsibleTrigger className="mt-1 text-xs text-pome-red hover:underline">
            {open ? 'Show less' : 'Show more'}
          </CollapsibleTrigger>
        </Collapsible>
      )}
      {/* The media this source came from, with the transcript/OCR the data
          agent read out of it — a WhatsApp voice note is otherwise a row whose
          audio is unreachable and whose text is invisible. */}
      <MediaAttachments wsId={wsId} documentId={doc.id} />
    </li>
  );
}
