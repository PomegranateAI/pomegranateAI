import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ContextUsageEntry } from '../api.js';
import { fmtDate } from '../lib/format.js';
import { channelLabel, describeUsage, fmtLatency } from '../lib/usage-describe.js';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pager, useCursorPages } from '../components/Pager.js';

const REQUEST_TRUNCATE_LEN = 80;
const PAGE_SIZE = 25;

// Usage — the companion to Library. Where Library shows what's IN the folder's
// context, this shows how that context gets USED: every question the team's
// connected AI tools and teammates put to it — who did what, in plain English
// (see lib/usage-describe.ts), and what came back.
export function Usage({ wsId }: { wsId: string }) {
  const [shown, setShown] = useState<ContextUsageEntry[]>([]);
  const [totals, setTotals] = useState({ all: 0, unanswered: 0 });
  // 'unanswered' narrows to "I don't know" replies — each one a gap in the
  // context worth filling with a source. Filtered server-side so it pages.
  const [filter, setFilter] = useState<'all' | 'unanswered'>('all');
  const [openRequest, setOpenRequest] = useState<ContextUsageEntry | null>(null);
  const pages = useCursorPages();
  const { reset } = pages;

  useEffect(reset, [wsId, filter, reset]);
  useEffect(() => {
    let live = true; // drop replies that a later filter/page change made stale
    api
      .listContextUsage(wsId, { limit: PAGE_SIZE, before: pages.before, unanswered: filter === 'unanswered' })
      .then((r) => {
        if (!live) return;
        setShown(r.usage);
        setTotals({ all: r.total, unanswered: r.unanswered_total });
      })
      .catch(() => live && setShown([]));
    return () => {
      live = false;
    };
  }, [wsId, filter, pages.before]);

  const unanswered = totals.unanswered;

  return (
    <div className="usage-view space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl italic">How your vault is used</h2>
          <div className="muted max-w-prose text-sm text-muted-foreground">
            Everything your team and their AI tools did with this directory — questions asked,
            searches, notes read, drafts checked — and what came back.
          </div>
        </div>
        {totals.all > 0 && (
          <div className="flex shrink-0 gap-1.5">
            {(
              [
                ['all', `All (${totals.all})`],
                ['unanswered', `Unanswered (${unanswered})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  filter === key
                    ? 'border-pome-red bg-pome-red/10 text-ink'
                    : 'bg-card text-muted-foreground hover:border-pome-red'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {totals.all === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="font-serif text-2xl italic">Nothing&rsquo;s happened here yet.</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Issue an MCP token in Setup and paste it into your team&rsquo;s AI tool. Everything
            it does with this directory shows up here.
          </p>
        </Card>
      ) : shown.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">
            No unanswered questions — the vault covered everything it was asked.
          </p>
        </Card>
      ) : (
        <Card className="shadow-soft">
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What they did</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((q, i) => {
                  const d = describeUsage(q);
                  const truncated = !!d.quote && d.quote.length > REQUEST_TRUNCATE_LEN;
                  return (
                    <TableRow key={q.id ?? i}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(q.created_at)}</TableCell>
                      <TableCell className="text-xs">
                        {q.actor_email ?? 'Unknown'}
                        <div className="text-muted-foreground">via {channelLabel(q.channel)}</div>
                      </TableCell>
                      <TableCell className="max-w-md text-sm">
                        <span className="font-medium">{d.action}</span>
                        {d.quote && (
                          <>
                            {' '}&ldquo;{truncated ? `${d.quote.slice(0, REQUEST_TRUNCATE_LEN)}…` : d.quote}&rdquo;
                            {truncated && (
                              <button
                                type="button"
                                onClick={() => setOpenRequest(q)}
                                className="ml-1.5 text-xs text-pome-red hover:underline"
                              >
                                View full
                              </button>
                            )}
                          </>
                        )}
                        {d.context && <div className="text-xs text-muted-foreground">{d.context}</div>}
                      </TableCell>
                      <TableCell
                        className={`whitespace-nowrap text-xs ${d.outcome === 'No answer' ? 'text-pome-red' : ''}`}
                      >
                        {d.outcome}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                        {fmtLatency(q.latency_ms)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Pager
              page={pages.page}
              pageSize={PAGE_SIZE}
              shown={shown.length}
              total={filter === 'unanswered' ? totals.unanswered : totals.all}
              onPrev={pages.prev}
              onNext={() => pages.next(shown[shown.length - 1].id)}
            />
          </CardContent>
        </Card>
      )}

      <Dialog open={!!openRequest} onOpenChange={(o) => !o && setOpenRequest(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif text-xl italic">
              {openRequest ? describeUsage(openRequest).action : 'Full request'}
            </DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            {openRequest?.actor_email ?? 'Unknown'} &middot; {openRequest ? fmtDate(openRequest.created_at) : ''}
          </div>
          <p className="whitespace-pre-wrap text-sm">{openRequest?.request_text}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
