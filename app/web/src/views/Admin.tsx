import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { AiDirectoryAccess } from '../components/AiDirectoryAccess.js';
import { Pager, useCursorPages } from '../components/Pager.js';
import { fmtDate } from '../lib/format.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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

type AuditEntry = {
  id: number;
  event: string;
  actor_user_id: string | null;
  actor_email: string | null;
  source_ip: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
};

// Event → badge variant. Destructive events stand out in red; mutations are
// the brand accent; everything else stays neutral.
function eventVariant(event: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (event.includes('delete') || event.includes('purge') || event.includes('reject') || event.includes('failed'))
    return 'destructive';
  if (event.includes('mutated') || event.includes('issued') || event.includes('submitted')) return 'default';
  if (event.includes('sign_in') || event.includes('export') || event.includes('accessed'))
    return 'secondary';
  return 'outline';
}

const AUDIT_PAGE_SIZE = 25;

export function Admin({ wsId, onDeleted }: { wsId: string; onDeleted: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const pages = useCursorPages();
  const { reset } = pages;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Two-step delete: the AlertDialog confirms intent, then a second armed
  // button inside it confirms the irreversible action.
  const [armed, setArmed] = useState(false);
  const [delBusy, setDelBusy] = useState(false);

  // Only the newest request may set state, so a slow earlier page can't
  // overwrite the one the admin just clicked to.
  const reqSeq = useRef(0);
  async function reload() {
    const seq = ++reqSeq.current;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.listCustomerAudit(wsId, { limit: AUDIT_PAGE_SIZE, before: pages.before });
      if (seq !== reqSeq.current) return;
      setEntries(r.entries);
      setTotal(r.total);
    } catch (e: any) {
      if (seq === reqSeq.current) setErr(e.message);
    } finally {
      if (seq === reqSeq.current) setBusy(false);
    }
  }
  useEffect(reset, [wsId, reset]);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, pages.before]);

  async function downloadCsv() {
    const r = await fetch(`/api/workspaces/${wsId}/customer-audit?format=csv`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('pmg_session') ?? ''}` },
    });
    if (!r.ok) {
      toast.error('Export failed', { description: `${r.status}: ${await r.text()}` });
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `customer-audit-${wsId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Audit log exported');
  }

  async function doDelete() {
    setDelBusy(true);
    try {
      await api.deleteWorkspace(wsId);
      toast.success('Directory deleted');
      onDeleted();
    } catch (e: any) {
      toast.error('Delete failed', { description: e.message });
    } finally {
      setDelBusy(false);
      setArmed(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="shadow-soft">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="font-serif text-2xl italic">Audit log</CardTitle>
            <CardDescription>
              Customer-visible events: sign-ins, graph changes, source uploads, deliverable
              submissions, vault accesses (who + request shape, never the words), MCP token
              issuance + use, audit exports. Feeds your SIEM if you want it.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <button onClick={downloadCsv} className="pome-btn-ghost">
              Export CSV
            </button>
            <button onClick={() => (pages.page > 0 ? pages.reset() : reload())} disabled={busy} className="pome-btn-ghost">
              {busy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {err && <p className="mb-3 text-sm text-destructive">{err}</p>}
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Source IP</TableHead>
                  <TableHead>Resource</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground">{fmtDate(e.created_at)}</TableCell>
                    <TableCell>
                      <Badge variant={eventVariant(e.event)} className="font-mono text-[11px]">
                        {e.event}
                      </Badge>
                    </TableCell>
                    <TableCell>{e.actor_email ?? e.actor_user_id ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{e.source_ip ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {e.resource_type ? `${e.resource_type}:${e.resource_id ?? ''}` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pager
            page={pages.page}
            pageSize={AUDIT_PAGE_SIZE}
            shown={entries.length}
            total={total}
            onPrev={pages.prev}
            onNext={() => pages.next(entries[entries.length - 1].id)}
          />
        </CardContent>
      </Card>

      <AiDirectoryAccess wsId={wsId} />

      <Card className="border-destructive/40 shadow-soft">
        <CardHeader>
          <CardTitle className="font-serif text-2xl italic text-destructive">Delete folder</CardTitle>
          <CardDescription>
            Removes every graph node, candidate, review, source, MCP token, audit row, and uploaded
            file for this directory. The deletion itself is audited just before it runs; afterwards
            there is no remaining surface to read it from. You will be signed out of the directory.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertDialog onOpenChange={(o) => !o && setArmed(false)}>
            <AlertDialogTrigger asChild>
              <button className="pome-btn-ghost">Delete folder…</button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this folder?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently purges all data for <code className="font-mono">{wsId}</code>.
                  This cannot be undone. Confirm twice to proceed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={delBusy}>Cancel</AlertDialogCancel>
                {armed ? (
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={delBusy}
                    onClick={(e) => {
                      e.preventDefault();
                      doDelete();
                    }}
                  >
                    {delBusy ? 'Deleting…' : 'Confirm delete'}
                  </AlertDialogAction>
                ) : (
                  <button
                    className="pome-btn-ghost"
                    onClick={(e) => {
                      e.preventDefault();
                      setArmed(true);
                    }}
                  >
                    I understand — continue
                  </button>
                )}
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  );
}
