import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, getUserId, type AssistantConnection, type DirectoryGovernance } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// Directory protection (server: phase1/governance.ts) — admins mark a
// directory sensitive (two-step required to open it; AI-assistant connections
// off unless allowed) or make AI agents read-only in it. Everyone else sees
// the current settings.
const FLAGS: Array<{ key: keyof DirectoryGovernance; label: string; help: string }> = [
  {
    key: 'sensitive',
    label: 'Sensitive directory',
    help: 'Members need two-step sign-in (password + emailed link) to open it. Turn on two-step for yourself first.',
  },
  {
    key: 'assistants_allowed',
    label: 'Allow AI assistants (Claude, ChatGPT) here',
    help: 'Only matters for a sensitive directory: without it, assistant connections cannot read or write here.',
  },
  {
    key: 'agents_read_only',
    label: 'AI agents are read-only',
    help: 'For directories that receive outside content: agents can read and answer, never add or change.',
  },
];

export function DirectoryProtectionCard({ wsId }: { wsId: string }) {
  const [flags, setFlags] = useState<DirectoryGovernance | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getGovernance(wsId).then(setFlags).catch(() => setFlags(null));
    const me = getUserId();
    api
      .listMembers(wsId)
      .then((r) => setIsAdmin(r.members.some((m) => m.user_id === me && m.role === 'workspace_admin')))
      .catch(() => setIsAdmin(false));
  }, [wsId]);

  async function toggle(key: keyof DirectoryGovernance) {
    if (!flags) return;
    const next = { ...flags, [key]: !flags[key] };
    setBusy(true);
    try {
      setFlags(await api.setGovernance(wsId, next));
      toast.success('Directory protection saved');
    } catch (err: any) {
      toast.error('Could not save', {
        description: /two-step/.test(err.message)
          ? 'Turn on two-step sign-in (Setup → General) before marking a directory sensitive.'
          : err.message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Directory protection</CardTitle>
        <CardDescription>
          For student-sensitive directories and folders that receive outside content. Every change is recorded in the
          audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {flags === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          FLAGS.map((f) => (
            <label key={f.key} className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={flags[f.key]}
                disabled={!isAdmin || busy}
                onChange={() => toggle(f.key)}
              />
              <span>
                <span className="block text-sm font-medium">{f.label}</span>
                <span className="block text-xs text-muted-foreground">{f.help}</span>
              </span>
            </label>
          ))
        )}
        {!isAdmin && <p className="text-xs text-muted-foreground">Only a directory admin can change these.</p>}
      </CardContent>
    </Card>
  );
}

// Assistant connections — every Claude / ChatGPT connection (OAuth) that
// reaches this directory. Admins see and revoke everyone's; members their own.
export function AssistantConnectionsCard({ wsId }: { wsId: string }) {
  const [rows, setRows] = useState<AssistantConnection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    api
      .listAssistantConnections(wsId)
      .then((r) => setRows(r.connections))
      .catch(() => setRows([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  async function revoke(c: AssistantConnection) {
    setBusy(c.id);
    try {
      await api.revokeAssistantConnection(wsId, c.id);
      toast.success('Connection revoked', { description: `${c.client_name} · ${c.email}` });
      await load();
    } catch (err: any) {
      toast.error('Could not revoke', { description: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Assistant connections</CardTitle>
        <CardDescription>
          Claude and ChatGPT connections that can reach this directory. Revoking one ends its access at once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assistant is connected to this directory.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {c.client_name} <span className="font-normal text-muted-foreground">· {c.email}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Connected {c.created_at.slice(0, 10)}
                    {c.last_used_at ? ` · last token ${c.last_used_at.slice(0, 10)}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded-lg border px-3 py-1.5 text-sm text-muted-foreground hover:text-destructive"
                  disabled={busy === c.id}
                  onClick={() => revoke(c)}
                >
                  {busy === c.id ? '…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
