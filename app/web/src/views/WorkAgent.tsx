import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  History,
  Layers,
  ListTodo,
  PenLine,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { api } from '../api.js';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Work agents (spec-work-agents.md) act on YOUR OWN context only — the material
// in this folder — to produce a finished piece of work. This one component
// renders all four; they differ only in their top input control and copy. No
// teammate picker, no cross-folder scope: that's what makes them "work" agents
// and not "collaboration" agents.
export type WorkAgentKind = 'draft' | 'synthesize' | 'catchup' | 'followup';

type AgentConfig = {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  blurb: string;
  verb: string; // button label, e.g. "Draft it"
  busyVerb: string;
};

const CONFIG: Record<WorkAgentKind, AgentConfig> = {
  draft: {
    icon: <PenLine className="size-3.5" />,
    eyebrow: 'Draft',
    title: 'Draft',
    blurb:
      'A first draft, built from your own notes and past writing — not a blank page. Say what you need and Pomegranate writes it in your material, ready for you to edit.',
    verb: 'Draft it',
    busyVerb: 'Drafting…',
  },
  synthesize: {
    icon: <Layers className="size-3.5" />,
    eyebrow: 'Synthesize',
    title: 'Synthesize',
    blurb:
      'Pull everything you know about one thing into a single, coherent doc. Pomegranate gathers your scattered notes on the topic, merges the overlap, and orders it.',
    verb: 'Synthesize',
    busyVerb: 'Synthesizing…',
  },
  catchup: {
    icon: <History className="size-3.5" />,
    eyebrow: 'Catch-up',
    title: 'Catch-up',
    blurb:
      'Been away? See where you left off and what has moved — a short, skimmable recap of your own recent material, newest and most important first.',
    verb: 'Catch me up',
    busyVerb: 'Catching up…',
  },
  followup: {
    icon: <ListTodo className="size-3.5" />,
    eyebrow: 'Follow-up',
    title: 'Follow-up',
    blurb:
      'The open loops you left behind: commitments you made, things you owe people, decisions left dangling — pulled from your own notes into an actionable checklist.',
    verb: 'Find my follow-ups',
    busyVerb: 'Scanning…',
  },
};

const SINCE_OPTIONS: Array<{ label: string; days: number }> = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 2 weeks', days: 14 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

type Result = {
  title: string;
  output: string;
  cited_node_ids: string[];
  empty?: boolean;
  error?: string;
};

export function WorkAgent({ wsId, agent }: { wsId: string; agent: WorkAgentKind }) {
  const cfg = CONFIG[agent];
  // Draft: a document type + a brief. Synthesize: a topic. Follow-up: an
  // optional focus. Catch-up: a time window + optional focus.
  const [docType, setDocType] = useState('');
  const [input, setInput] = useState('');
  const [sinceDays, setSinceDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const [nodes, setNodes] = useState<any[]>([]);
  const [openNode, setOpenNode] = useState<any | null>(null);

  // Reset per-agent local state when the sidebar switches between work agents
  // (the component instance is reused across page keys).
  useEffect(() => {
    setDocType('');
    setInput('');
    setResult(null);
    setCopied(false);
  }, [agent]);

  useEffect(() => {
    api
      .listGraph(wsId, { includeArchived: true })
      .then((r) => setNodes(r.nodes))
      .catch(() => {});
  }, [wsId]);

  const inputRequired = agent === 'draft' || agent === 'synthesize';
  const canRun = !busy && (!inputRequired || input.trim().length > 0);

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setResult(null);
    setCopied(false);
    try {
      const body: { input?: string; docType?: string; since?: string } = {};
      if (input.trim()) body.input = input.trim();
      if (agent === 'draft' && docType.trim()) body.docType = docType.trim();
      if (agent === 'catchup') {
        body.since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
      }
      const r = await api.runWorkAgent(wsId, agent, body);
      setResult(r);
      if (r.error) {
        toast.error('That didn’t go through', {
          description: 'The writing step failed — try again in a moment.',
        });
      }
    } catch (e: any) {
      toast.error('Could not run', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function copyOut() {
    if (!result?.output) return;
    try {
      await navigator.clipboard.writeText(result.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  }

  function download() {
    if (!result?.output) return;
    const name =
      (result.title || `${cfg.eyebrow}`).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') ||
      cfg.eyebrow;
    const blob = new Blob([result.output], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openCitation(id: string) {
    const n = nodes.find((x) => x.id === id);
    setOpenNode(n ?? { id, _missing: true });
  }

  const citations = useMemo(() => result?.cited_node_ids ?? [], [result]);

  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow mb-1 flex items-center gap-1.5">
          {cfg.icon} {cfg.eyebrow}
        </div>
        <h1 className="font-serif text-3xl">{cfg.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{cfg.blurb}</p>
      </div>

      <Card className="shadow-soft">
        <CardContent className="space-y-4 pt-6">
          {agent === 'draft' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                What kind of document?
              </label>
              <Input
                type="text"
                placeholder="e.g. exec update, one-pager, PRD, post…"
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
              />
            </div>
          )}

          {agent === 'catchup' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                How far back?
              </label>
              <div className="flex flex-wrap gap-2">
                {SINCE_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      sinceDays === o.days
                        ? 'border-pome-red bg-pome-red/10 text-ink'
                        : 'bg-card text-muted-foreground hover:border-pome-red hover:text-ink'
                    }`}
                    onClick={() => setSinceDays(o.days)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {agent === 'draft'
                ? 'What should it cover? (a sentence or a few bullets)'
                : agent === 'synthesize'
                  ? 'On what topic?'
                  : agent === 'catchup'
                    ? 'Narrow it to a focus? (optional)'
                    : 'Narrow it to a focus? (optional)'}
            </label>
            <textarea
              className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
              placeholder={
                agent === 'draft'
                  ? 'What the draft needs to say…'
                  : agent === 'synthesize'
                    ? 'e.g. onboarding drop-off, our roadmap thinking…'
                    : agent === 'catchup'
                      ? 'e.g. the launch, anything about the roadmap…'
                      : 'e.g. the launch, anything I owe Alice…'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run();
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <button className="pome-btn" disabled={!canRun} onClick={run}>
              {busy ? cfg.busyVerb : cfg.verb}
            </button>
            {inputRequired && (
              <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
            )}
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card className="shadow-soft">
          <CardContent className="space-y-4 pt-6">
            {result.empty ? (
              <p className="text-sm text-muted-foreground">
                There’s nothing in this folder yet to work from. Add a few sources or notes first,
                then come back — work agents build from your own material.
              </p>
            ) : result.error ? (
              <p className="text-sm text-destructive">
                The writing step didn’t complete. Try again in a moment.
              </p>
            ) : result.output ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  {result.title && <h2 className="font-serif text-xl">{result.title}</h2>}
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      className="pome-btn-ghost inline-flex items-center gap-1.5 text-xs"
                      onClick={copyOut}
                    >
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      className="pome-btn-ghost inline-flex items-center gap-1.5 text-xs"
                      onClick={download}
                    >
                      <Download className="size-3.5" /> .md
                    </button>
                  </div>
                </div>
                {/* The artifact is Markdown (prompts/work-agent.md asks for it,
                    and Copy/.md hand back the raw source), so render it as
                    formatted prose rather than showing the syntax. md-prose
                    adjusts wiki-prose's pre-wrap, which is for TipTap-authored
                    text (see index.css). */}
                {/* remark-gfm because the agents genuinely emit GitHub-flavoured
                    Markdown — Follow-up's checklists are `- [ ]` task lists, which
                    CommonMark renders as a literal "[ ]". Also covers tables and
                    strikethrough. */}
                <div className="wiki-prose md-prose text-sm leading-relaxed">
                  <Markdown remarkPlugins={[remarkGfm]}>{result.output}</Markdown>
                </div>
                {citations.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Built from:</span>
                    {citations.map((id) => (
                      <button
                        key={id}
                        className="rounded border border-pome-red/30 bg-card px-1.5 py-0.5 font-mono text-pome-red transition-colors hover:bg-pome-red/10"
                        onClick={() => openCitation(id)}
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing came back — try again.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!openNode} onOpenChange={(o) => !o && setOpenNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{openNode?.id}</DialogTitle>
            <DialogDescription>
              {openNode?._missing
                ? 'This item is not in the current snapshot.'
                : `${openNode?.type ?? 'item'}${openNode?.status ? ` · ${openNode.status}` : ''}`}
            </DialogDescription>
          </DialogHeader>
          {openNode && !openNode._missing && (
            <div className="space-y-2 text-sm">
              {(openNode.title || openNode.summary) && (
                <p className="font-medium">{openNode.title ?? openNode.summary}</p>
              )}
              {openNode.body && <p className="text-muted-foreground">{openNode.body}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
