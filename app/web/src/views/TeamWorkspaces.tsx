import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Copy, Lock, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, type TeamDirectory, type TeamWorkspace } from '../api.js';
import { fmtDate } from '../lib/format.js';
import { RunInClaude } from '../components/RunInClaude.js';
import { TEAM_FOLDER_RECIPES } from '../lib/mcp-recipes.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// TeamWorkspaces — everyone who shares your email domain, and the workspaces
// each of them belongs to. Per workspace: its context-profile type(s), its
// plan, your teammate's role, and whether you can reach it. Deliberately not in
// the nav — reached only from Setup ("Explore team folders").

// Only a COMPANY domain groups people. On a public mailbox provider
// (gmail.com, outlook.com, …) the server sends back just you — `domain_kind`
// is 'personal' — because two strangers who both signed up with a gmail
// address are not colleagues. The page says so rather than looking like an
// empty org; folders still arrive the other way, by invite from their owner.

// There is no per-folder connector to mint here. A connection is bound to YOU,
// not to one folder: every tool takes a `folder` argument, so the single
// connector created in your own Setup already reaches every folder you're a
// member of. What this page is for is the other half — finding folders you are
// NOT in yet and asking their owner for access.

// Turn "ada.lovelace@acme.com" into "ada.lovelace" for a friendlier heading.
function nameFromEmail(email: string): string {
  return email.split('@')[0] ?? email;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        toast.success('Copied to clipboard');
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={label}
      title={label}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border bg-card transition-colors hover:bg-muted"
    >
      {copied ? <Check className="size-3.5 text-flag-green" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function TeamWorkspaces({ onBack }: { onBack: () => void }) {
  const [dir, setDir] = useState<TeamDirectory | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    setBusy(true);
    setErr(null);
    api
      .teamDirectory()
      .then(setDir)
      .catch((e: any) => setErr(e.message))
      .finally(() => setBusy(false));
  }, []);

  // Search matches people by email / name (the local part). Empty query shows
  // everyone. Case-insensitive substring.
  const filtered = useMemo(() => {
    if (!dir) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return dir.users;
    return dir.users.filter(
      (u) =>
        u.email.toLowerCase().includes(needle) ||
        (u.display_name ?? '').toLowerCase().includes(needle) ||
        (u.slack?.handle ?? '').toLowerCase().includes(needle),
    );
  }, [dir, q]);

  const personalDomain = dir?.domain_kind === 'personal';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="pome-btn-ghost inline-flex items-center gap-1.5">
          <ArrowLeft className="size-4" /> Back to Setup
        </button>
      </div>

      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-serif text-2xl italic">
            <Users className="size-5" /> Team directories
          </CardTitle>
          <CardDescription>
            {personalDomain ? (
              <>
                {dir?.domain ? (
                  <>
                    <code className="font-mono text-pome-red">@{dir.domain}</code> is a personal
                    email provider, not a company,
                  </>
                ) : (
                  <>Your email address is not on a company domain,</>
                )}{' '}
                so it doesn't make a team: people who happen to share it can't see each other's
                directories. Only your own directories are listed below. To work with someone, ask them to
                add you to their directory (Setup → Members) — your own connection then reaches it by
                name.
              </>
            ) : (
              <>
                Everyone on your email domain
                {dir?.domain ? (
                  <>
                    {' '}
                    <code className="font-mono text-pome-red">@{dir.domain}</code>
                  </>
                ) : null}{' '}
                and the directories they belong to, with each directory's folders. Your own
                connection already reaches every directory you're a member of — name the directory and
                your assistant lands in it. For the rest, ask the owner for access.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people by name or email…"
            className="max-w-sm"
            aria-label="Search people"
          />
          <RunInClaude useCase="explore team folders" recipes={TEAM_FOLDER_RECIPES} />
        </CardContent>
      </Card>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {busy && !dir && <p className="text-sm text-muted-foreground">Loading…</p>}
      {dir && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {q
            ? 'No people match that search.'
            : personalDomain
              ? "You don't have a directory yet — create one from Setup."
              : 'No one else on your domain yet.'}
        </p>
      )}

      {filtered.map((u) => {
        const isMe = dir?.me.user_id === u.user_id;
        return (
          <Card key={u.user_id} className="shadow-soft">
            <CardHeader className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 font-serif text-xl italic">
                {u.display_name || nameFromEmail(u.email)}
                {isMe && (
                  <Badge variant="secondary" className="not-italic">
                    You
                  </Badge>
                )}
                {u.slack?.handle && (
                  <Badge variant="outline" className="font-mono text-[11px] not-italic">
                    @{u.slack.handle}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                <span className="font-mono text-xs">{u.email}</span> · joined {fmtDate(u.created_at)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {u.workspaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">No directories.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Directory</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Your access</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.workspaces.map((w) => (
                      <TableRow key={w.id}>
                        <TableCell>
                          <div className="flex items-center gap-1.5 font-medium text-ink">
                            {w.name}
                            {u.default_folder?.workspace_id === w.id && (
                              <Badge variant="secondary" className="text-[11px]">
                                Default
                              </Badge>
                            )}
                          </div>
                          <div className="font-mono text-[11px] text-muted-foreground">{w.id}</div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {w.profiles.map((p) => (
                              <Badge
                                key={p.subgraph_id}
                                variant={p.status === 'active' ? 'default' : 'outline'}
                                className="font-normal"
                                title={`${p.profile_id} · #${p.slug}`}
                              >
                                {p.name}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{w.role}</TableCell>
                        <TableCell>
                          <WorkspaceAccessCell w={w} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// One workspace's access cell. If you're a member (viewer_role set), there is
// nothing to set up: the connector from your own Setup reaches this folder —
// you just name it, so the cell hands you the reference to name. If you're not
// a member, you get a "Request access" button that emails the workspace owner.
function WorkspaceAccessCell({ w }: { w: TeamWorkspace }) {
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  async function request() {
    setBusy(true);
    try {
      const r = await api.requestAccess(w.id);
      setRequested(true);
      toast.success('Access requested', {
        description: r.sent
          ? `We emailed ${w.owner_email}.`
          : `Owner is ${w.owner_email} (no mail provider configured in dev).`,
      });
    } catch (e: any) {
      const msg = /409/.test(e.message) ? 'You already have access' : e.message;
      toast.error('Could not request access', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  // Not a member → request access.
  if (!w.viewer_role) {
    return (
      <div className="flex items-center gap-2">
        <Lock className="size-3.5 text-muted-foreground" />
        <button onClick={request} disabled={busy || requested} className="pome-btn-ghost text-xs">
          {requested ? 'Access requested' : busy ? 'Requesting…' : 'Request access'}
        </button>
      </div>
    );
  }

  // Member → already reachable from the connection you have. The useful thing
  // to hand over is the reference to name (the folder id, which is what every
  // surface accepts as `folder`), not another credential.
  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary" className="text-[11px]">
        Shared with you
      </Badge>
      <span className="text-xs text-muted-foreground">
        reachable from your connection — name it:
      </span>
      <code className="font-mono text-[11px] text-pome-red">{w.id}</code>
      <CopyButton text={w.id} label="Copy directory reference" />
    </div>
  );
}
