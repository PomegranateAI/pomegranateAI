// Two-step sign-in: password, then a link emailed to the account. The Setup
// card turns it on and off; the full-screen gate is shown when the
// deployment's MFA_REQUIRED policy covers a user who has no password yet.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api.js';
import { PasswordCard } from '../views/Setup.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

type MfaStatus = Awaited<ReturnType<typeof api.getMfa>>;

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('invalid_current_password')) return 'That password isn’t right.';
  if (msg.includes('password_required')) return 'Set a password first: two-step sign-in starts with it.';
  if (msg.includes('required_by_policy')) return 'Your organisation requires two-step sign-in, so it can’t be turned off.';
  return msg;
}

/** Setup → Two-step sign-in. */
export function MfaCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api
      .getMfa()
      .then(setStatus)
      .catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);

  async function enable() {
    setBusy(true);
    try {
      await api.mfaEnable();
      toast.success('Two-step sign-in turned on');
      await refresh();
    } catch (e) {
      toast.error('Could not turn it on', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await api.mfaDisable(password);
      setPassword('');
      toast.success('Two-step sign-in turned off');
      await refresh();
    } catch (e) {
      toast.error('Could not turn it off', { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;
  const on = status.enabled || status.required;
  return (
    <Card className="shadow-soft">
      <CardHeader>
        <CardTitle className="font-serif text-2xl italic">Two-step sign-in</CardTitle>
        <CardDescription>
          {on
            ? 'On. After your password, we email you a link to finish signing in. A sign-in link alone isn’t enough.'
            : 'Off. Add an emailed link after your password, so a stolen password isn’t enough on its own.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.required ? (
          <p className="text-sm text-muted-foreground">Your organisation requires it.</p>
        ) : status.enabled ? (
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              placeholder="Current password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="max-w-60"
            />
            <button className="pome-btn" disabled={busy || !password} onClick={disable}>
              Turn off
            </button>
          </div>
        ) : (
          <>
            {/* Read once on mount, so it can lag a password just set above;
                the server checks again on Turn on. */}
            {!status.has_password && (
              <p className="text-sm text-muted-foreground">It starts with your password: set one above first.</p>
            )}
            <button className="pome-btn" disabled={busy} onClick={enable}>
              {busy ? 'Turning on…' : 'Turn on two-step sign-in'}
            </button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Full-screen gate: the organisation requires two-step sign-in and this
 *  account has no password yet. Setting one completes enrolment. */
export function MfaEnrollScreen({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  return (
    <div className="bg-page flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-2xl space-y-3">
        <p className="text-sm text-muted-foreground">
          Your organisation requires two-step sign-in: your password, then a link we email you. Choose a password to
          continue.
        </p>
        <PasswordCard onSaved={onDone} />
        <button className="text-sm text-muted-foreground underline" onClick={onLogout}>
          Log out
        </button>
      </div>
    </div>
  );
}
