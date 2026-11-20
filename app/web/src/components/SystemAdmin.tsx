import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api, getUserId, type AdminUser } from '../api.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

/** Same shape as the server's generateTemporaryPassword (lib/passwords.ts):
 *  four groups of four from an alphabet without look-alikes. Pre-filled so
 *  the admin never has to invent one; they can edit it or draw a new one. */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function generateTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => TEMP_ALPHABET[b % TEMP_ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** The server's reason, in words — not "400 Bad Request: {…}". */
function adminError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = raw.match(/"error":"([^"]+)"/)?.[1];
  if (code === 'invalid_email') return 'Enter a full email address, like name@school.org.';
  if (code === 'user already exists') return 'There is already an account with this email.';
  if (code === 'admin only') return 'Only system administrators can do this.';
  if (code) return code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ') + '.';
  return raw;
}

/** What the admin needs after creating or resetting an account: whether the
 *  email went, and the password itself in case it has to be passed on by hand. */
type Outcome = { email: string; password: string; emailed: boolean; invited: boolean; reset: boolean };

function PasswordField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex min-w-56 flex-1 gap-1">
      <Input
        aria-label={label}
        type="text"
        required
        minLength={12}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pome-btn-ghost shrink-0"
        title="Generate a new password"
        aria-label="Generate a new password"
        onClick={() => onChange(generateTemporaryPassword())}
      >
        <RefreshCw className="size-3.5" />
      </button>
    </div>
  );
}

function InviteCheckbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-pome-red" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function SystemAdmin() {
  const [enabled, setEnabled] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(generateTemporaryPassword);
  const [sendInvite, setSendInvite] = useState(true);
  const [resetInvite, setResetInvite] = useState(true);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<AdminUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const [owned, setOwned] = useState<Array<{ id: string; name: string; member_count: number }>>([]);
  const [confirmation, setConfirmation] = useState('');

  async function load() {
    const r = await api.listAdminUsers();
    setUsers(r.users);
  }
  useEffect(() => {
    api.getMe().then((me) => {
      if (me.is_admin) {
        setEnabled(true);
        return load();
      }
    }).catch(() => {});
  }, []);
  if (!enabled) return null;

  async function create() {
    setBusy(true);
    try {
      const r = await api.createAdminUser(email.trim(), password, sendInvite);
      setOutcome({ email: r.user.email, password: r.temporary_password, emailed: r.emailed, invited: sendInvite, reset: false });
      setEmail(''); setPassword(generateTemporaryPassword());
      await load();
      toast.success(r.emailed ? 'User created and invitation emailed' : 'User created');
    } catch (e) { toast.error('Could not create user', { description: adminError(e) }); }
    finally { setBusy(false); }
  }
  async function changePassword() {
    if (!reset) return;
    setBusy(true);
    try {
      const r = await api.resetAdminUserPassword(reset.id, resetPassword, resetInvite);
      setOutcome({ email: reset.email, password: r.temporary_password, emailed: r.emailed, invited: resetInvite, reset: true });
      setReset(null); setResetPassword('');
      await load();
      toast.success(r.emailed ? 'Password changed and emailed; existing sessions ended' : 'Password changed; existing sessions ended');
    } catch (e) { toast.error('Could not change password', { description: adminError(e) }); }
    finally { setBusy(false); }
  }
  async function showDelete(user: AdminUser) {
    try {
      const r = await api.adminUserDeletion(user.id);
      setOwned(r.owned_workspaces);
      setDeleting(user);
      setConfirmation('');
    } catch (e) { toast.error('Could not inspect user data', { description: adminError(e) }); }
  }
  async function remove() {
    if (!deleting || confirmation.toLowerCase() !== deleting.email.toLowerCase()) return;
    setBusy(true);
    try {
      await api.deleteAdminUser(deleting.id, confirmation);
      setDeleting(null); setConfirmation(''); setOwned([]);
      await load();
      toast.success('User and owned directory data deleted');
    } catch (e) { toast.error('Could not delete user', { description: adminError(e) }); }
    finally { setBusy(false); }
  }

  return <Card className="shadow-soft">
    <CardHeader>
      <CardTitle className="font-serif text-2xl italic">User administration</CardTitle>
      <CardDescription>Create accounts and invite people by email, reset temporary passwords, and remove users and their owned directories. Only system admins created with the user management script can use this section.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-6">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="flex flex-wrap gap-2">
          <Input aria-label="New user email" type="email" required pattern="[^@\s]+@[^@\s]+\.[^@\s]+" title="A full email address, like name@school.org" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" />
          <PasswordField label="Temporary password" value={password} onChange={setPassword} />
          <button className="pome-btn" disabled={busy}>{sendInvite ? 'Create and invite' : 'Create user'}</button>
        </div>
        <InviteCheckbox checked={sendInvite} onChange={setSendInvite} label="Email an invitation with the sign-in address and temporary password" />
      </form>
      <p className="text-xs text-muted-foreground">A temporary password is generated for you; edit it or draw a new one. New users must choose their own password at first sign-in.</p>
      {outcome && <div role="status" className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
        <p>
          {outcome.reset ? 'New temporary password for ' : 'Account created for '}<strong>{outcome.email}</strong>.{' '}
          {outcome.emailed
            ? 'The invitation email is on its way.'
            : outcome.invited
              ? 'The email could not be sent — give them this password another way.'
              : 'No email was sent — give them this password yourself.'}
        </p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-card px-2 py-1 font-mono">{outcome.password}</code>
          <button
            type="button"
            className="pome-btn-ghost"
            onClick={async () => {
              try { await navigator.clipboard.writeText(outcome.password); toast.success('Password copied'); }
              catch { toast.error('Could not copy — select it and copy it manually'); }
            }}
          >
            <Copy className="size-3.5" /> Copy
          </button>
          <button type="button" className="pome-btn-ghost" onClick={() => setOutcome(null)}>Dismiss</button>
        </div>
      </div>}
      <div className="divide-y rounded-md border">
        {users.map((user) => <div key={user.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="min-w-48 flex-1 font-medium">{user.email}</span>
          <span className="text-xs text-muted-foreground">{user.is_admin ? 'System admin · ' : ''}{user.workspace_count} directories</span>
          <button type="button" className="pome-btn-ghost" onClick={() => { setReset(user); setResetPassword(generateTemporaryPassword()); setResetInvite(true); setDeleting(null); }}>Change password</button>
          {user.id !== getUserId() && <button type="button" className="pome-btn-ghost text-destructive" onClick={() => void showDelete(user)}>Delete…</button>}
        </div>)}
      </div>
      {reset && <form className="space-y-3 rounded-md border p-4" onSubmit={(e) => { e.preventDefault(); void changePassword(); }}>
        <strong>Change password for {reset.email}</strong>
        <PasswordField label="New temporary password" value={resetPassword} onChange={setResetPassword} />
        <InviteCheckbox checked={resetInvite} onChange={setResetInvite} label="Email the new temporary password to them" />
        <div className="flex gap-2"><button className="pome-btn" disabled={busy}>Save and end sessions</button><button type="button" className="pome-btn-ghost" onClick={() => setReset(null)}>Cancel</button></div>
      </form>}
      {deleting && <div className="space-y-3 rounded-md border border-destructive/40 p-4 text-sm">
        <strong className="text-destructive">Delete {deleting.email} and owned directory data?</strong>
        <p>This permanently removes this account, sessions, credentials, and the following owned directories with their documents and other data. Shared directories this person only joined keep their content.</p>
        {owned.length > 0 ? <ul className="list-disc pl-5">{owned.map((ws) => <li key={ws.id}>{ws.name} ({ws.member_count} members)</li>)}</ul> : <p>No owned directories.</p>}
        <label className="block">Type {deleting.email} to confirm</label>
        <Input aria-label="Confirm email to delete" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        <div className="flex gap-2"><button type="button" className="pome-btn" disabled={busy || confirmation.toLowerCase() !== deleting.email.toLowerCase()} onClick={() => void remove()}>Delete user and data</button><button type="button" className="pome-btn-ghost" onClick={() => setDeleting(null)}>Cancel</button></div>
      </div>}
    </CardContent>
  </Card>;
}
