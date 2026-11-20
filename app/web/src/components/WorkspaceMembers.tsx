import { useEffect, useMemo, useState } from 'react';
import { LogOut, UserPlus, X, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, getUserId, type WorkspaceMember } from '../api.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';

// Viewer = a member with view-and-ask access only (server: governance.ts).
const ROLE_OPTIONS = ['member', 'viewer', 'leader', 'workspace_admin'];
const ROLE_LABELS: Record<string, string> = {
  member: 'Member',
  viewer: 'Viewer (view & ask)',
  leader: 'Leader',
  workspace_admin: 'Admin',
};
const roleOf = (m: WorkspaceMember) => (m.read_only ? 'viewer' : m.role);

// WorkspaceMembers — the "share this workspace" surface. Lists who's in the
// workspace and (for admins) lets you add teammates by email or remove them.
// Used both in Settings (Setup) and in Onboarding's final step. `chrome`
// controls whether it renders its own Card shell (Settings) or bare content
// that slots into an existing card (Onboarding).
export function WorkspaceMembers({
  wsId,
  chrome = true,
  onLeft,
}: {
  wsId: string;
  chrome?: boolean;
  /** Called after you leave this directory, so the app can move you elsewhere. */
  onLeft?: () => void;
}) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  // Teammates on the caller's email domain (from the cross-workspace team
  // directory) — surfaced as one-click "add" chips so an admin doesn't have to
  // retype an address they already share a domain with.
  const [domain, setDomain] = useState<string | null>(null);
  const [domainEmails, setDomainEmails] = useState<string[]>([]);
  const selfId = getUserId();

  const load = () =>
    api
      .listMembers(wsId)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  useEffect(() => {
    load();
    // The team directory isn't workspace-scoped; load it once for the add-by-
    // domain shortcut. Non-fatal if it fails (e.g. no shared domain).
    api
      .teamDirectory()
      .then((d) => {
        setDomain(d.domain);
        setDomainEmails(d.users.map((u) => u.email));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  const isAdmin = members?.some((m) => m.user_id === selfId && m.role === 'workspace_admin') ?? false;

  // Domain teammates not already in this folder — the candidates worth offering.
  const addableDomainEmails = useMemo(() => {
    const present = new Set((members ?? []).map((m) => m.email.toLowerCase()));
    return domainEmails.filter((e) => !present.has(e.toLowerCase()));
  }, [domainEmails, members]);

  async function addTeammate(rawEmail: string, memberRole: string) {
    const e = rawEmail.trim().toLowerCase();
    if (!e) return;
    setBusy(true);
    try {
      await api.addMember(wsId, e, memberRole);
      toast.success('Teammate added', { description: `${e} · ${memberRole}` });
      await load();
    } catch (err: any) {
      const msg = /409/.test(err.message) ? 'They are already a member' : err.message;
      toast.error('Could not add teammate', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!email.trim()) return;
    await addTeammate(email, role);
    setEmail('');
  }

  async function changeRole(m: WorkspaceMember, next: string) {
    setBusy(true);
    try {
      await api.setMemberRole(wsId, m.user_id, next);
      toast.success('Access changed', { description: `${m.email} · ${ROLE_LABELS[next] ?? next}` });
      await load();
    } catch (err: any) {
      const msg = /400/.test(err.message) ? 'The directory owner stays an admin' : err.message;
      toast.error('Could not change access', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  async function leave(m: WorkspaceMember) {
    if (!window.confirm("Leave this directory? You'll lose access until an admin adds you back.")) return;
    setBusy(true);
    try {
      await api.removeMember(wsId, m.user_id);
      toast.success('You left the directory');
      onLeft?.();
    } catch (err: any) {
      toast.error('Could not leave', { description: err.message });
      setBusy(false);
    }
  }

  async function remove(m: WorkspaceMember) {
    if (!window.confirm(`Remove ${m.email} from this directory?`)) return;
    setBusy(true);
    try {
      await api.removeMember(wsId, m.user_id);
      toast.success('Teammate removed', { description: m.email });
      await load();
    } catch (err: any) {
      const msg = /400/.test(err.message) ? "The directory owner can't be removed" : err.message;
      toast.error('Could not remove', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  const inner = (
    <div className="space-y-4">
      {members === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 py-2.5 first:pt-0">
              <span className="font-medium text-ink">
                {m.display_name ? (
                  <>
                    {m.display_name}{' '}
                    <span className="font-normal text-muted-foreground">({m.email})</span>
                  </>
                ) : (
                  m.email
                )}
              </span>
              {m.user_id === selfId && (
                <Badge variant="secondary" className="text-[11px]">
                  You
                </Badge>
              )}
              {isAdmin && m.user_id !== selfId ? (
                <select
                  value={roleOf(m)}
                  onChange={(e) => changeRole(m, e.target.value)}
                  disabled={busy}
                  className="ml-auto h-7 rounded-md border bg-card px-1.5 text-xs"
                  aria-label={`Access for ${m.email}`}
                >
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o} value={o}>
                      {ROLE_LABELS[o]}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge variant="outline" className="ml-auto font-mono text-[11px]">
                  {ROLE_LABELS[roleOf(m)] ?? roleOf(m)}
                </Badge>
              )}
              {m.user_id === selfId && !m.is_owner && (
                <button
                  type="button"
                  onClick={() => leave(m)}
                  disabled={busy}
                  title="Remove your own access to this directory"
                  className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40"
                >
                  <LogOut className="size-3.5" /> Leave
                </button>
              )}
              {isAdmin && m.user_id !== selfId && !m.is_owner && (
                <button
                  type="button"
                  onClick={() => remove(m)}
                  disabled={busy}
                  aria-label={`Remove ${m.email}`}
                  title="Remove from directory"
                  className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-40"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder="teammate@yourcompany.com"
            className="flex-1"
            aria-label="Teammate email"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-9 rounded-md border bg-card px-2 text-sm"
            aria-label="Role"
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {ROLE_LABELS[o]}
              </option>
            ))}
          </select>
          <button
            className="pome-btn inline-flex items-center justify-center gap-1.5"
            onClick={add}
            disabled={busy || !email.trim()}
          >
            <UserPlus className="size-4" /> Add
          </button>
        </div>
      )}

      {isAdmin && addableDomainEmails.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Add someone from your{domain ? ` @${domain}` : ''} team as a member:
          </p>
          <div className="flex flex-wrap gap-2">
            {addableDomainEmails.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => addTeammate(e, 'member')}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-ink transition-colors hover:bg-muted disabled:opacity-40"
              >
                <UserPlus className="size-3.5" /> {e}
              </button>
            ))}
          </div>
        </div>
      )}
      {members !== null && !isAdmin && (
        <p className="border-t pt-4 text-xs text-muted-foreground">
          Only a directory admin can add or remove teammates. You can leave this directory yourself
          with Leave next to your name.
        </p>
      )}
    </div>
  );

  if (!chrome) return inner;

  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
          <Users className="size-5" /> Directory Members
        </CardTitle>
        <CardDescription>
          Share this directory with teammates. Members can read and contribute to the graph; admins
          can also manage connections, members, and settings. You can invite people before their
          first sign-in — their access is waiting when they log in with that email.
        </CardDescription>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}
