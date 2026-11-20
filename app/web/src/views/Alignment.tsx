import { useEffect, useRef, useState } from 'react';
import {
  UploadCloud,
  Link2,
  FileText,
  Loader2,
  AlertTriangle,
  ScanEye,
  CheckCircle2,
  FolderOpen,
  UserRound,
  Plus,
  ChevronDown,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { DOCUMENT_ACCEPT, DOCUMENT_HINT, uploadKind } from '@/lib/upload-formats';
import { api, type TeamUser } from '../api.js';
import { FlagChip } from '../components/FlagChip.js';
import { RunInClaude } from '../components/RunInClaude.js';
import { FolderTargetPicker, type TargetRef } from '../components/FolderTargetPicker.js';
import { ALIGNMENT_RECIPES } from '../lib/mcp-recipes.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

// The Alignment experience: check an OUTSIDE deliverable (a doc, deck, PDF, or
// a link to one) against the canon of one or more folders — surfacing where it
// contradicts, drifts from, or misses what the rest of the team has decided.
// Extraction happens server-side (no ingest); each selected folder is checked
// with the existing review pipeline and its findings are reframed here as
// inconsistencies / misalignment / aligned.

type Finding = {
  flag: 'red' | 'yellow' | 'green';
  summary: string;
  node_id?: string;
  quote_from_deliverable?: string;
  category?: string;
};

type FolderResult = {
  folderId: string;
  folderName: string;
  findings: Finding[];
  error?: string;
};

// red = it contradicts a decision; yellow = it drifts / a possible blindspot;
// green = it lines up with the canon.
const FLAG_SECTION: Record<Finding['flag'], { label: string; icon: React.ReactNode }> = {
  red: { label: 'Inconsistencies', icon: <AlertTriangle className="size-3.5" /> },
  yellow: { label: 'Possible blindspots', icon: <ScanEye className="size-3.5" /> },
  green: { label: 'Aligned', icon: <CheckCircle2 className="size-3.5" /> },
};
const FLAG_ORDER: Finding['flag'][] = ['red', 'yellow', 'green'];

export function Alignment({ wsId }: { wsId: string }) {
  const [mode, setMode] = useState<'upload' | 'link' | 'text'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // "Check against" targets — same shape as the Updates picker: the current
  // folder (includeSelf) plus added folder/teammate/free-typed references.
  const [includeSelf, setIncludeSelf] = useState(true);
  const [targetRefs, setTargetRefs] = useState<TargetRef[]>([]);

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<FolderResult[] | null>(null);

  // Re-anchor to the folder we're now viewing.
  useEffect(() => {
    setIncludeSelf(true);
    setTargetRefs([]);
    setResults(null);
  }, [wsId]);

  const addRef = (ref: string, label?: string) => {
    const r = ref.trim();
    if (!r) return;
    setTargetRefs((prev) => (prev.some((t) => t.ref === r) ? prev : [...prev, { ref: r, label: label ?? r }]));
  };
  const removeRef = (ref: string) => setTargetRefs((prev) => prev.filter((t) => t.ref !== ref));

  const hasInput =
    (mode === 'upload' && file) || (mode === 'link' && url.trim()) || (mode === 'text' && text.trim());
  const hasTarget = includeSelf || targetRefs.length > 0;

  async function run() {
    if (!hasInput || !hasTarget) return;
    setRunning(true);
    setResults(null);
    try {
      // 1) Resolve the deliverable to text once.
      let deliverable = text;
      if (mode === 'upload' && file) {
        const r = await api.alignExtractFile(wsId, file);
        deliverable = r.text;
      } else if (mode === 'link') {
        const r = await api.alignExtractUrl(wsId, url.trim());
        deliverable = r.text;
      }
      if (!deliverable.trim()) {
        toast.error('Nothing to check', { description: 'Could not read any text from that.' });
        return;
      }

      // 2) Resolve the "check against" refs to member folders (server-side,
      //    membership-enforced — same resolver the Updates picker uses).
      const refs = [...(includeSelf ? [wsId] : []), ...targetRefs.map((t) => t.ref)];
      const { resolved, errors } = await api.alignResolve(wsId, refs);

      // 3) Check the deliverable against each resolved folder's canon.
      const reviewed = await Promise.all(
        resolved.map(async (f): Promise<FolderResult> => {
          try {
            const r = await api.submitReview(f.workspace_id, deliverable);
            return { folderId: f.workspace_id, folderName: f.name, findings: r.findings as Finding[] };
          } catch (e: any) {
            return { folderId: f.workspace_id, folderName: f.name, findings: [], error: e.message };
          }
        }),
      );
      // Surface unresolved refs (no access / not found) alongside the results.
      const unresolved: FolderResult[] = errors.map((e) => ({
        folderId: e.ref,
        folderName: e.ref,
        findings: [],
        error: e.detail,
      }));
      setResults([...reviewed, ...unresolved]);

      const flagged = reviewed.reduce((n, r) => n + r.findings.filter((f) => f.flag !== 'green').length, 0);
      toast.success('Alignment check complete', {
        description: flagged === 0 ? 'No inconsistencies found.' : `${flagged} thing${flagged === 1 ? '' : 's'} to look at.`,
      });
    } catch (e: any) {
      toast.error('Check failed', { description: e.message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="eyebrow mb-1 flex items-center gap-1.5">
          <ScanEye className="size-3.5" /> Alignment
        </div>
        <h1 className="font-serif text-3xl">Check your work against the team</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Drop in a document, deck, or PDF — or a link to one — and pick the directories to check it
          against. Pomegranate reads it against everyone else’s decisions and flags where it’s
          inconsistent, drifting out of alignment, or missing a blindspot the team already saw.
        </p>
      </div>

      <RunInClaude useCase="this alignment check" recipes={ALIGNMENT_RECIPES} />

      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="font-serif text-2xl italic">What are you checking?</CardTitle>
          <CardDescription>Upload a file, paste a link, or drop in text.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
            <TabsList>
              <TabsTrigger value="upload">
                <UploadCloud className="size-4" /> Upload
              </TabsTrigger>
              <TabsTrigger value="link">
                <Link2 className="size-4" /> Link
              </TabsTrigger>
              <TabsTrigger value="text">
                <FileText className="size-4" /> Text
              </TabsTrigger>
            </TabsList>

            <TabsContent value="upload" className="pt-3">
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f && uploadKind(f.name) !== 'document') {
                    toast.error('Unsupported file type', { description: `Upload a document: ${DOCUMENT_HINT}` });
                  } else if (f) setFile(f);
                }}
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  dragging ? 'border-pome-red bg-pome-red/5' : 'border-border bg-muted/30 hover:bg-muted/50'
                }`}
              >
                <UploadCloud className="size-7 text-muted-foreground" />
                {file ? (
                  <span className="text-sm font-medium">{file.name}</span>
                ) : (
                  <span className="text-sm font-medium">Drop a document, deck, or PDF — or click to browse</span>
                )}
                <span className="font-mono text-xs text-muted-foreground">{DOCUMENT_HINT} · 25 MB max</span>
                <input
                  ref={inputRef}
                  type="file"
                  className="sr-only"
                  accept={DOCUMENT_ACCEPT}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) setFile(f);
                  }}
                />
              </label>
            </TabsContent>

            <TabsContent value="link" className="pt-3">
              <Input
                type="url"
                placeholder="https://… link to a doc, deck, or page"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Public links work best — anything behind a login can’t be read.
              </p>
            </TabsContent>

            <TabsContent value="text" className="pt-3">
              <Textarea
                className="min-h-40"
                placeholder="Paste the draft, section, or notes to check…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </TabsContent>
          </Tabs>

          <FolderTargetPicker
            wsId={wsId}
            includeSelf={includeSelf}
            targetRefs={targetRefs}
            onToggleSelf={() => setIncludeSelf((v) => !v)}
            onAdd={addRef}
            onRemove={removeRef}
            label="Check against"
            icon={<FolderOpen className="size-3.5" />}
            helper={
              <>
                Check against other directories you belong to, or a teammate&rsquo;s directory (you must be
                a member). Each directory reports its own findings.
              </>
            }
          />

          <Button disabled={!hasInput || !hasTarget || running} onClick={run}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <ScanEye className="size-4" />}
            {running ? 'Checking alignment…' : 'Check alignment'}
          </Button>
        </CardContent>
      </Card>

      {results?.map((r) => (
        <FolderFindings key={r.folderId} result={r} showFolder={results.length > 1} />
      ))}
    </div>
  );
}

function FolderFindings({ result, showFolder }: { result: FolderResult; showFolder: boolean }) {
  const bySection = FLAG_ORDER.map((flag) => ({
    flag,
    ...FLAG_SECTION[flag],
    items: result.findings.filter((f) => f.flag === flag),
  })).filter((s) => s.items.length > 0);

  const flagged = result.findings.filter((f) => f.flag !== 'green').length;

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="font-serif text-xl italic">
            {showFolder ? result.folderName : 'Findings'}
          </CardTitle>
          {!result.error && (
            <div className="flex gap-1.5">
              {(['red', 'yellow', 'green'] as const).map((flag) => {
                const n = result.findings.filter((f) => f.flag === flag).length;
                return n > 0 ? <FlagChip key={flag} flag={flag} count={n} /> : null;
              })}
            </div>
          )}
        </div>
        {!result.error && (
          <CardDescription>
            {result.findings.length === 0
              ? 'No overlapping vault — nothing to compare against here.'
              : flagged === 0
                ? 'Everything lines up with this directory’s vault.'
                : `${flagged} spot${flagged === 1 ? '' : 's'} where your work and this directory differ.`}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {result.error ? (
          <p className="text-sm text-destructive">Couldn’t check this directory: {result.error}</p>
        ) : (
          bySection.map((s) => (
            <div key={s.flag} className="space-y-2">
              <p className="eyebrow flex items-center gap-1.5">
                {s.icon} {s.label} ({s.items.length})
              </p>
              {s.items.map((f, i) => (
                <div key={i} className="rounded-lg border bg-card p-3 shadow-soft">
                  <div className="flex flex-wrap items-center gap-2">
                    <FlagChip flag={f.flag} />
                    <span className="font-medium">{f.summary}</span>
                    {f.node_id && <code className="cite font-mono text-xs text-pome-red">→ {f.node_id}</code>}
                  </div>
                  {f.quote_from_deliverable && (
                    <p className="mt-2 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
                      "{f.quote_from_deliverable}"
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
