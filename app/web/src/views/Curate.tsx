import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import type { PendingRoute, Subgraph } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * Folder-routing decisions the ingest router held for review: it wants to
 * create a new folder, or picked an existing one with nothing to go on (no
 * description, no content yet). Under Light, ingestion otherwise auto-applies
 * (spec-pomegranate-light-removals.md §1) — this is the one remaining "needs
 * your attention" surface, so it renders nothing at all when the queue is
 * empty rather than an empty-state card. Embedded at the top of the Sources
 * page instead of living on its own nav item.
 */
export function PendingRoutesBanner({
  wsId,
  subgraphs,
  refreshSignal = 0,
}: {
  wsId: string;
  subgraphs: Subgraph[];
  /** Bump this (e.g. from a sibling "an ingest just finished" counter) to
   *  refetch without waiting for an approve/choose/reject round-trip — a
   *  newly-held document otherwise only shows up here after a manual reload. */
  refreshSignal?: number;
}) {
  const [items, setItems] = useState<PendingRoute[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listPendingRoutes(wsId)
      .then((pr) => {
        if (!cancelled) setItems(pr.pending_routes);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wsId, refresh, refreshSignal]);

  const resolved = useCallback(() => setRefresh((n) => n + 1), []);

  if (items === null) {
    return (
      <Card className="space-y-2 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </Card>
    );
  }
  if (items.length === 0) return null;

  return (
    <Card className="shadow-soft border-pome-red/30">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Folder decisions need review</CardTitle>
        <CardDescription>
          {items.length} document{items.length === 1 ? '' : 's'} routed nowhere yet — the router either
          wants to create a new folder, or picked one it had nothing to go on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {items.map((item) => (
            <PendingRouteRow key={item.id} wsId={wsId} item={item} subgraphs={subgraphs} onResolved={resolved} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PendingRouteRow({
  wsId,
  item,
  subgraphs,
  onResolved,
}: {
  wsId: string;
  item: PendingRoute;
  subgraphs: Subgraph[];
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosenId, setChosenId] = useState<string>('');
  const nameById = new Map(subgraphs.map((s) => [s.id, s.name]));

  async function approve() {
    setBusy(true);
    try {
      const r = await api.approveRoute(wsId, item.id);
      toast.success('Folder decision approved', {
        description: item.proposed_new_folder ? `Created "${item.proposed_new_folder.name}".` : undefined,
      });
      void r;
      onResolved();
    } catch (e: any) {
      toast.error('Could not approve', { description: e?.message ?? '' });
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    if (!chosenId) return;
    setBusy(true);
    try {
      await api.chooseRoute(wsId, item.id, [chosenId]);
      toast.success(`Filed into ${nameById.get(chosenId) ?? chosenId}`);
      onResolved();
    } catch (e: any) {
      toast.error('Could not file it there', { description: e?.message ?? '' });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await api.rejectRoute(wsId, item.id);
      toast.success('Left unfiled');
      onResolved();
    } catch (e: any) {
      toast.error('Could not reject', { description: e?.message ?? '' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        {item.proposed_new_folder ? (
          <Badge className="border-transparent bg-pome-red/10 font-mono text-[0.65rem] text-pome-red">
            new folder: {item.proposed_new_folder.name}
          </Badge>
        ) : (
          item.low_confidence_targets.map((id) => (
            <Badge key={id} variant="outline" className="font-mono text-[0.65rem] text-muted-foreground">
              unsure about #{nameById.get(id) ?? id}
            </Badge>
          ))
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {item.proposed_new_folder?.description || item.reason}
      </p>
      {item.can_resolve === false ? (
        <p className="mt-2 text-sm italic text-muted-foreground">
          Waiting for {item.ingested_by_email || 'the uploader'} to decide.
        </p>
      ) : (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={approve} disabled={busy} className="pome-btn">
          {item.proposed_new_folder ? 'Create & file' : 'Approve'}
        </Button>
        {choosing ? (
          <>
            <Select value={chosenId} onValueChange={setChosenId} disabled={busy}>
              <SelectTrigger className="h-8 w-[220px]">
                <SelectValue placeholder="Pick a folder…" />
              </SelectTrigger>
              <SelectContent>
                {subgraphs.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={choose} disabled={busy || !chosenId}>
              File it there
            </Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setChoosing(true)} disabled={busy}>
            Choose folder…
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={reject} disabled={busy} className="text-muted-foreground">
          Leave unfiled
        </Button>
      </div>
      )}
    </li>
  );
}
