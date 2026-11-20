import { useEffect, useState } from 'react';
import { BellRing, MessageCircleQuestion, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api.js';
import type { ContextProfile } from '../api.js';
import { fetchWorkspaceProfile } from '../profiles.js';
import { RunInClaude } from '../components/RunInClaude.js';
import { ASK_RECIPES } from '../lib/mcp-recipes.js';
import { FolderTargetPicker, type TargetRef } from '../components/FolderTargetPicker.js';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// A single folder's answer to the asked question.
type FolderAnswer = {
  folderName: string;
  answer: string;
  cited_node_ids: string[];
  has_answer: boolean;
  error?: string;
};

// Ask the team — put a plain-language question to your own folder or a
// teammate's, and get back the same cited answer their connected AI tools
// would hear. No scope to pick: the graph routes the question itself.
export function Ask({ wsId }: { wsId: string }) {
  const [profile, setProfile] = useState<ContextProfile | null>(null);
  const [question, setQuestion] = useState('');
  // Whose folder to ask: your own (includeSelf) plus any added teammate/folder.
  const [includeSelf, setIncludeSelf] = useState(true);
  const [targetRefs, setTargetRefs] = useState<TargetRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<FolderAnswer[] | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [nodes, setNodes] = useState<any[]>([]);
  const [openNode, setOpenNode] = useState<any | null>(null);

  useEffect(() => {
    fetchWorkspaceProfile(wsId).then(setProfile);
    api.listGraph(wsId, { includeArchived: true }).then((r) => setNodes(r.nodes)).catch(() => {});
  }, [wsId]);

  const addRef = (ref: string, label?: string) =>
    setTargetRefs((prev) =>
      prev.some((t) => t.ref === ref) ? prev : [...prev, { ref, label: label ?? ref }],
    );
  const removeRef = (ref: string) => setTargetRefs((prev) => prev.filter((t) => t.ref !== ref));

  const seedQuestions = profile?.seed_questions ?? [];

  async function ask(raw: string) {
    const q = raw.trim();
    if (!q) return;
    const refs = [...(includeSelf ? [wsId] : []), ...targetRefs.map((t) => t.ref)];
    if (refs.length === 0) {
      toast.error('Pick who to ask', { description: 'Choose your directory or a teammate above.' });
      return;
    }
    setBusy(true);
    setAnswers(null);
    try {
      // Own-folder-only is the fast path (no cross-folder resolution needed).
      // Otherwise resolve each ref to a folder we're a member of, then ask each.
      let targets: Array<{ workspace_id: string; name: string }>;
      let unresolved: Array<{ ref: string; detail: string }> = [];
      if (includeSelf && targetRefs.length === 0) {
        targets = [{ workspace_id: wsId, name: 'Your directory' }];
      } else {
        const { resolved, errors } = await api.alignResolve(wsId, refs);
        targets = resolved.map((r) => ({ workspace_id: r.workspace_id, name: r.name }));
        unresolved = errors;
      }
      const answered = await Promise.all(
        targets.map(async (t): Promise<FolderAnswer> => {
          try {
            const r = await api.query(t.workspace_id, q, 'all');
            return { folderName: t.name, ...r };
          } catch (e: any) {
            return {
              folderName: t.name,
              answer: '',
              cited_node_ids: [],
              has_answer: false,
              error: e.message,
            };
          }
        }),
      );
      const errRows: FolderAnswer[] = unresolved.map((e) => ({
        folderName: e.ref,
        answer: '',
        cited_node_ids: [],
        has_answer: false,
        error: e.detail,
      }));
      setAnswers([...answered, ...errRows]);
      setQuestion(q);
    } catch (e: any) {
      toast.error('Question failed', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  // Turn the current question into a recurring, cited update — a weekly email
  // on this topic, scoped to the same folders. Managed under Updates.
  async function subscribeUpdate() {
    const topic = question.trim();
    if (!topic) return;
    const refs = [...(includeSelf ? [wsId] : []), ...targetRefs.map((t) => t.ref)];
    const scopeChanged = targetRefs.length > 0 || !includeSelf;
    setSubscribing(true);
    try {
      await api.createUpdate(wsId, {
        topic,
        cadence_ms: 7 * 24 * 60 * 60 * 1000,
        medium: 'email',
        ...(scopeChanged ? { target_refs: refs } : {}),
      });
      toast.success('Weekly updates on this question — manage them under Updates.');
    } catch (e: any) {
      toast.error('Could not subscribe', { description: e.message });
    } finally {
      setSubscribing(false);
    }
  }

  function openCitation(id: string) {
    const n = nodes.find((x) => x.id === id);
    setOpenNode(n ?? { id, _missing: true });
  }

  const multi = (answers?.length ?? 0) > 1;

  return (
    <div className="space-y-6">
      <div>
        <div className="eyebrow mb-1 flex items-center gap-1.5">
          <MessageCircleQuestion className="size-3.5" /> Ask
        </div>
        <h1 className="font-serif text-3xl">Ask the team</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          A plain-language question in, a cited answer out — pulled from what a teammate has
          already written down. Ask your own directory, or ask theirs, without booking a meeting or
          sending a ping.
        </p>
      </div>

      <Card className="shadow-soft">
        <CardContent className="space-y-4 pt-6">
          <FolderTargetPicker
            wsId={wsId}
            includeSelf={includeSelf}
            targetRefs={targetRefs}
            onToggleSelf={() => setIncludeSelf((v) => !v)}
            onAdd={addRef}
            onRemove={removeRef}
            label="Ask"
            icon={<UserRound className="size-3.5" />}
            selfLabel="Your folder"
            helper={
              <>
                Ask your own directory, another you belong to, or a teammate&rsquo;s directory (you must
                be a member). Each directory answers on its own.
              </>
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="text"
              placeholder="What's the latest on a product, a project, a decision…"
              className="min-w-48 flex-1"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && question.trim()) ask(question);
              }}
            />
            <button className="pome-btn" disabled={busy || !question.trim()} onClick={() => ask(question)}>
              {busy ? 'Asking…' : 'Get answer'}
            </button>
            <button
              className="pome-btn-ghost inline-flex items-center gap-1.5"
              disabled={subscribing || !question.trim()}
              onClick={subscribeUpdate}
              title="Get a recurring, cited update on this question's topic"
            >
              <BellRing className="size-4" />
              {subscribing ? 'Subscribing…' : 'Get updates'}
            </button>
          </div>

          {seedQuestions.length > 0 && !answers && (
            <div className="flex flex-wrap gap-2">
              {seedQuestions.map((q) => (
                <button
                  key={q}
                  className="rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-pome-red hover:text-ink disabled:opacity-50"
                  onClick={() => ask(q)}
                  disabled={busy}
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {answers && (
            <div className="space-y-3">
              {answers.map((a, i) => (
                <div key={i} className="answer-box rounded-lg border bg-muted/40 p-4">
                  {multi && (
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <UserRound className="size-3.5" /> {a.folderName}
                    </div>
                  )}
                  {a.error ? (
                    <p className="text-sm text-destructive">{a.error}</p>
                  ) : a.has_answer ? (
                    <>
                      <div className="answer-text whitespace-pre-wrap text-sm">{a.answer}</div>
                      {a.cited_node_ids.length > 0 && (
                        <div className="cite-list mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground">Cites:</span>
                          {a.cited_node_ids.map((id) => (
                            <button
                              key={id}
                              className="cite rounded border border-pome-red/30 bg-card px-1.5 py-0.5 font-mono text-pome-red transition-colors hover:bg-pome-red/10"
                              onClick={() => openCitation(id)}
                            >
                              {id}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This directory doesn&rsquo;t have an answer for that. Pomegranate says &ldquo;I
                      don&rsquo;t know&rdquo; rather than guess.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RunInClaude useCase="this question" recipes={ASK_RECIPES} />

      <Dialog open={!!openNode} onOpenChange={(o) => !o && setOpenNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{openNode?.id}</DialogTitle>
            <DialogDescription>
              {openNode?._missing
                ? 'This node is not in the current graph snapshot.'
                : `${openNode?.type ?? 'node'}${openNode?.status ? ` · ${openNode.status}` : ''}`}
            </DialogDescription>
          </DialogHeader>
          {openNode && !openNode._missing && (
            <div className="space-y-2 text-sm">
              {(openNode.title || openNode.summary) && (
                <p className="font-medium">{openNode.title ?? openNode.summary}</p>
              )}
              {openNode.body && <p className="text-muted-foreground">{openNode.body}</p>}
              {openNode.source && (
                <p className="font-mono text-xs text-muted-foreground">source: {openNode.source}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
