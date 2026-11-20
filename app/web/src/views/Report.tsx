/**
 * The Report (spec-data-agents-and-subfolder-wiki.md §4.3).
 *
 * A distinct, full-screen entry point off the Library header — NOT a tab,
 * NOT the wiki's page tree. One current-state document per subfolder,
 * regenerated wholesale on request, mirroring the exact same two states
 * Library itself renders (§4.1): no agent → one synthesized Notes section;
 * an agent attached → one section per its kinds, plus a Sources listing at
 * the bottom for whatever a document didn't yield a structured entry for.
 */
import { useEffect, useState } from 'react';
import { BellRing, ChevronLeft, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api.js';
import type { DocumentRecord, ReportRecord } from '../api.js';
import { kindColorVar } from '../profiles.js';
import { SourceChipList } from './Sources.js';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function blockHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function ReportPanel({
  wsId,
  subgraphId,
  subgraphName,
  documents,
  onClose,
}: {
  wsId: string;
  subgraphId: string;
  subgraphName: string;
  /** Already loaded by the Library — passed through so the Sources listing
   *  doesn't re-fetch what the caller already has. */
  documents: DocumentRecord[];
  onClose: () => void;
}) {
  const [report, setReport] = useState<ReportRecord | null | undefined>(undefined); // undefined = loading
  const [stale, setStale] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  const load = () => {
    api
      .getReport(wsId, subgraphId)
      .then((r) => {
        setReport(r.report);
        setStale(r.stale);
      })
      .catch(() => setReport(null));
  };
  useEffect(() => {
    setReport(undefined);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, subgraphId]);

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api.generateReport(wsId, subgraphId);
      setReport(r.report);
      setStale(false);
      toast.success('Report generated');
    } catch (e: any) {
      toast.error('Could not generate the report', { description: e?.message });
    } finally {
      setGenerating(false);
    }
  };

  const subscribeUpdate = async () => {
    setSubscribing(true);
    try {
      await api.createUpdate(wsId, {
        topic: subgraphName,
        cadence_ms: 7 * 24 * 60 * 60 * 1000,
        medium: 'email',
      });
      toast.success(`Weekly updates on "${subgraphName}" — manage them under Updates.`);
    } catch (e: any) {
      toast.error('Could not subscribe', { description: e?.message });
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-background">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onClose}>
            <ChevronLeft className="size-4" />
            Back to folders
          </Button>
          <span className="flex-1" />
          {report && (
            <Button
              variant="outline"
              size="sm"
              onClick={subscribeUpdate}
              disabled={subscribing}
              className="gap-1.5"
              title="Get a recurring, cited update on this folder's report"
            >
              <BellRing className="size-4" />
              {subscribing ? 'Subscribing…' : 'Get updates'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={generate} disabled={generating} className="gap-1.5">
            <Sparkles className="size-4" />
            {generating ? 'Generating…' : report ? 'Regenerate' : 'Generate report'}
          </Button>
        </div>

        <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {subgraphName}
        </div>
        <h1 className="font-serif text-3xl italic">Report</h1>
        <div className="mt-1.5 mb-8 text-sm text-muted-foreground">
          {report === undefined ? (
            'Loading…'
          ) : report ? (
            <>
              Updated {timeAgo(report.generated_at)}
              {stale && (
                <span className="ml-2 inline-flex items-center gap-1 text-pome-red">
                  <RefreshCw className="size-3" /> the folders have changed since — regenerate for the latest
                </span>
              )}
            </>
          ) : (
            'No report yet.'
          )}
        </div>

        {report === undefined && (
          <div className="space-y-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}

        {report === null && (
          <div className="rounded-xl border border-dashed p-10 text-center shadow-soft">
            <div className="eyebrow mb-2">Nothing built yet</div>
            <h2 className="font-serif text-2xl italic">A single, current-state read of this folder</h2>
            <p className="mx-auto mt-2 mb-5 max-w-sm text-sm text-muted-foreground">
              Whatever governs this folder right now — plain notes, or an attached data agent's own kinds
              — synthesized into one document, with citations back to the nodes it drew on.
            </p>
            <Button onClick={generate} disabled={generating}>
              {generating ? 'Generating…' : 'Generate report'}
            </Button>
          </div>
        )}

        {report && (
          <div className="space-y-8">
            {report.content.sections.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing in the folders yet to report on.</p>
            )}
            {report.content.sections.map((section) => (
              <section key={section.kind_key}>
                <h2 className="mb-3 flex items-center gap-2 font-serif text-xl">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: kindColorVar(section.color) }}
                    aria-hidden
                  />
                  {section.label}
                </h2>
                <div className="space-y-5">
                  {section.groups.map((group) => (
                    <div key={group.key}>
                      {group.key !== '_' && (
                        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                          {group.label}
                        </h3>
                      )}
                      {group.blocks.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
                      ) : (
                        <div className="wiki-prose space-y-2 text-sm">
                          {group.blocks.map((b, i) => (
                            <div key={i}>
                              {b.type === 'list' && b.items ? (
                                <ul className="list-disc pl-5">
                                  {b.items.map((it, j) => (
                                    <li key={j}>{it}</li>
                                  ))}
                                </ul>
                              ) : (
                                <p dangerouslySetInnerHTML={{ __html: blockHtml(b.text ?? '') }} />
                              )}
                              {b.cited_node_ids.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {b.cited_node_ids.map((id) => (
                                    <span
                                      key={id}
                                      className="rounded border border-pome-red/30 px-1 font-mono text-[10px] text-pome-red"
                                    >
                                      {id}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {report.content.has_sources && (
              <section>
                <h2 className="mb-3 font-serif text-xl text-muted-foreground">Sources</h2>
                <SourceChipList documents={documents} />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
