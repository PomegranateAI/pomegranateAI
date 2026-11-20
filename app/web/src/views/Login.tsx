import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, MfaRequiredError } from '../api.js';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NewPasswordFields, newPasswordReady, passwordErrorMessage } from '../components/NewPasswordFields.js';

const SSO_ERRORS: Record<string, string> = {
  no_account: 'There’s no Pomegranate account for this sign-in yet. Ask a directory admin to invite you.',
  domain_not_allowed: 'That account’s domain can’t sign in here. Use your organization account.',
  account_disabled: 'This account is disabled. Contact your administrator.',
  provider_denied: 'Sign-in was cancelled at the identity provider.',
  provider_unreachable: 'The identity provider can’t be reached right now. Try again shortly.',
  expired: 'Single sign-on took too long. Try again.',
};

// Closed signup: the server answers no_account (with CONTACT_EMAIL, when the
// operator set one) for emails that have no account yet.
function noAccountMessage(raw: string): string {
  const contact = /"contact":"([^"]+)"/.exec(raw)?.[1];
  return contact
    ? `There’s no account for this email yet. Ask ${contact} for an invitation.`
    : 'There’s no account for this email yet. Ask your administrator for an invitation.';
}

export function Login({ onLogin }: { onLogin: (session: string) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  // 'email' → 'code' is the magic-link flow (unchanged). 'password' is the
  // independent password path — same account, same session mechanism, just
  // a different way in. Toggled by the link at the bottom of each stage.
  const [stage, setStage] = useState<'email' | 'code' | 'password' | 'mfa' | 'forgot' | 'forgot_sent' | 'reset'>('email');
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [devResetToken, setDevResetToken] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const [newPwConfirm, setNewPwConfirm] = useState('');
  // Account has two-step sign-in: the password was right and a link to finish
  // is in their inbox. In dev (no mailer) the server hands its token back.
  const [mfaDevToken, setMfaDevToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Single sign-on: when required, the email/password forms are hidden behind
  // an "administrator sign-in" link (break-glass accounts only).
  const [sso, setSso] = useState<{ enabled: boolean; required: boolean; label: string } | null>(null);
  const [showLocal, setShowLocal] = useState(false);

  useEffect(() => {
    api.ssoConfig().then(setSso).catch(() => setSso(null));
    const params = new URLSearchParams(window.location.search);
    const handoff = params.get('sso');
    const ssoError = params.get('sso_error');
    if (!handoff && !ssoError) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (ssoError) {
      setErr(SSO_ERRORS[ssoError] ?? 'Single sign-on did not complete. Try again.');
      return;
    }
    setBusy(true);
    api
      .ssoExchange(handoff!)
      .then((r) => onLogin(r.session))
      .catch((e: any) => {
        if (askForMfa(e)) return;
        setErr('Single sign-on timed out. Try again.');
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The magic-link email points at `${origin}/?code=<code>` (see
  // mail/smtp.ts's magicLinkContent) rather than a dedicated verify route, so
  // clicking it just loads this same login screen with the code sitting
  // inert in the URL. Auto-exchange it once on mount so the link actually
  // signs the user in instead of requiring them to copy the code by hand.
  // The second-step link (`/?mfa=<token>`, mail/smtp.ts mfaLinkContent) lands
  // here the same way and finishes the sign-in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // A forgotten-password link: check it before asking for a new password.
    const resetLink = params.get('reset');
    if (resetLink) {
      window.history.replaceState(null, '', window.location.pathname);
      void openReset(resetLink);
      return;
    }
    const mfaLink = params.get('mfa');
    if (mfaLink) {
      window.history.replaceState(null, '', window.location.pathname);
      void verifyMfa(mfaLink);
      return;
    }
    const linkCode = params.get('code');
    if (!linkCode) return;
    window.history.replaceState(null, '', window.location.pathname);
    setCode(linkCode);
    setStage('code');
    setBusy(true);
    api
      .exchange(linkCode)
      .then((r) => onLogin(r.session))
      .catch((e: any) => {
        if (needsPassword(e)) return;
        setErr(e.message);
        toast.error('Sign-in failed', { description: e.message });
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendLink() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.requestMagic(email);
      setCode(r.dev_code ?? '');
      setStage('code');
      toast.success('Magic link sent', {
        description: r.dev_code ? 'Dev mode: the code is pre-filled below.' : 'Check your email for the sign-in code.',
      });
    } catch (e: any) {
      // Closed signup: the server answers no_account for unprovisioned emails.
      const msg = String(e.message ?? '').includes('no_account')
        ? noAccountMessage(e.message)
        : e.message;
      setErr(msg);
      toast.error('Could not send link', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  async function openReset(token: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.checkPasswordReset(token);
      if (!r.valid) {
        setErr('This reset link has expired or was already used. Ask for a new one below.');
        setStage('forgot');
        return;
      }
      setResetToken(token);
      setNewPw('');
      setNewPwConfirm('');
      setStage('reset');
    } catch {
      setErr('Could not check the reset link. Try again.');
      setStage('forgot');
    } finally {
      setBusy(false);
    }
  }

  async function requestReset() {
    if (!email || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.forgotPassword(email);
      setDevResetToken(r.dev_reset_token ?? null);
      setStage('forgot_sent');
    } catch (e: any) {
      setErr(String(e?.message ?? '').includes('invalid_email') ? 'Enter your full work email address.' : 'Could not send the link. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveNewPassword() {
    if (!resetToken || busy || !newPasswordReady(newPw, newPwConfirm)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.resetPassword(resetToken, newPw);
      setResetToken(null);
      setNewPw('');
      setNewPwConfirm('');
      setPassword('');
      setStage('password');
      toast.success('Password changed', { description: 'Sign in with your new password.' });
    } catch (e) {
      const msg = passwordErrorMessage(e);
      setErr(msg);
      if (msg.startsWith('This link has expired')) {
        setResetToken(null);
        setStage('forgot');
      }
    } finally {
      setBusy(false);
    }
  }

  /** Password was right; switch to "check your email". True when it did. */
  function askForMfa(e: unknown): boolean {
    if (!(e instanceof MfaRequiredError)) return false;
    setMfaDevToken(e.devToken);
    setErr(null);
    setStage('mfa');
    return true;
  }

  /** A magic link alone can't sign in an account with two-step sign-in: it
   *  starts with the password. True when that's what the server said. */
  function needsPassword(e: unknown): boolean {
    if (!String((e as any)?.message ?? '').includes('password_required')) return false;
    setErr('Your account uses two-step sign-in. Enter your password, then open the link we email you.');
    setStage('password');
    return true;
  }

  async function verifyMfa(token: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.verifyMfa(token);
      onLogin(r.session);
    } catch {
      setErr('This sign-in link has expired or was already used. Sign in with your password again.');
      setMfaDevToken(null);
      setStage('password');
    } finally {
      setBusy(false);
    }
  }

  async function exchange() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.exchange(code);
      onLogin(r.session);
    } catch (e: any) {
      if (needsPassword(e)) return;
      setErr(e.message);
      toast.error('Sign-in failed', { description: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function signInWithPassword() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.loginPassword(email, password);
      onLogin(r.session);
    } catch (e: any) {
      if (askForMfa(e)) return;
      // Deliberately generic on the server (no account-existence oracle) —
      // keep the client message equally generic.
      const msg = 'Wrong email or password.';
      setErr(msg);
      toast.error('Sign-in failed', { description: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-page flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-md shadow-pop">
        <CardHeader className="space-y-2 pb-2 text-center">
          <img
            src="/pomegranate-icon.svg"
            alt=""
            className="mx-auto mb-1 size-12 rounded-xl shadow-soft"
          />
          <p className="eyebrow">secure magic link</p>
          <h2 className="font-mono text-3xl leading-tight">
            <span className="sr-only">Pomegranate</span>
            <span aria-hidden="true">
              <span className="text-foreground">[pome]</span>
              <span className="text-gradient-pome font-semibold">granate</span>
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Sign in with a magic link sent to your email.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {sso?.enabled && (stage === 'email' || stage === 'password') && (
            <>
              <a className="pome-btn flex w-full items-center justify-center" href={api.ssoStartUrl()}>
                Sign in with {sso.label}
              </a>
              {sso.required && !showLocal && (
                <button
                  type="button"
                  className="w-full text-center text-xs text-muted-foreground underline"
                  onClick={() => setShowLocal(true)}
                >
                  Administrator sign-in
                </button>
              )}
              {(!sso.required || showLocal) && (
                <p className="text-center text-xs text-muted-foreground">or</p>
              )}
            </>
          )}
          {stage === 'email' && (!sso?.required || showLocal) && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="login-email">Work email</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && email) sendLink();
                  }}
                />
              </div>
              <button className="pome-btn w-full" disabled={busy || !email} onClick={sendLink}>
                {busy ? 'Sending…' : 'Send link'}
              </button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => {
                  setErr(null);
                  setStage('password');
                }}
              >
                Use a password instead
              </button>
            </>
          )}
          {stage === 'password' && (!sso?.required || showLocal) && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="login-email-pw">Work email</Label>
                <Input
                  id="login-email-pw"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && email && password) signInWithPassword();
                  }}
                />
              </div>
              <button
                className="pome-btn w-full"
                disabled={busy || !email || !password}
                onClick={signInWithPassword}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => { setErr(null); setStage('forgot'); }}
              >
                Forgot your password?
              </button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => {
                  setErr(null);
                  setStage('email');
                }}
              >
                Use a magic link instead
              </button>
            </>
          )}
          {stage === 'code' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="login-code">Sign-in code</Label>
                <Input
                  id="login-code"
                  type="text"
                  className="font-mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && code) exchange();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  In production this arrives via email. Paste it to sign in.
                </p>
              </div>
              <button className="pome-btn w-full" disabled={busy || !code} onClick={exchange}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          )}
          {stage === 'forgot' && (
            <>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Reset your password</p>
                <p className="text-sm text-muted-foreground">
                  Enter your work email. We’ll send you a link to choose a new password.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="forgot-email">Work email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void requestReset();
                  }}
                />
              </div>
              <button className="pome-btn w-full" disabled={busy || !email} onClick={() => void requestReset()}>
                {busy ? 'Sending…' : 'Email me a reset link'}
              </button>
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => {
                  setErr(null);
                  setStage('password');
                }}
              >
                Back to sign in
              </button>
            </>
          )}
          {stage === 'forgot_sent' && (
            <>
              <div className="space-y-1.5" data-testid="reset-check-email">
                <p className="text-sm font-medium">Check your email</p>
                <p className="text-sm text-muted-foreground">
                  If there’s an account for {email}, we’ve sent it a link to choose a new password. The link works once,
                  for 30 minutes.
                </p>
              </div>
              {devResetToken && (
                <button className="pome-btn w-full" disabled={busy} onClick={() => void openReset(devResetToken)}>
                  Open link (dev mode)
                </button>
              )}
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => {
                  setErr(null);
                  setDevResetToken(null);
                  setStage('password');
                }}
              >
                Back to sign in
              </button>
            </>
          )}
          {stage === 'reset' && (
            <>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Choose a new password</p>
                <p className="text-sm text-muted-foreground">
                  After saving, sign in with it. Your other devices are signed out.
                </p>
              </div>
              <NewPasswordFields
                idPrefix="reset-pw"
                value={newPw}
                onChange={setNewPw}
                confirm={newPwConfirm}
                onConfirmChange={setNewPwConfirm}
                autoFocus
                onSubmit={() => void saveNewPassword()}
              />
              <button
                className="pome-btn w-full"
                disabled={busy || !newPasswordReady(newPw, newPwConfirm)}
                onClick={() => void saveNewPassword()}
              >
                {busy ? 'Saving…' : 'Save new password'}
              </button>
            </>
          )}
          {stage === 'mfa' && (
            <>
              <div className="space-y-1.5" data-testid="mfa-check-email">
                <p className="text-sm font-medium">Check your email</p>
                <p className="text-sm text-muted-foreground">
                  We sent a sign-in link to {email}. Open it to finish signing in. It works once, for 10 minutes.
                </p>
              </div>
              {mfaDevToken && (
                <button className="pome-btn w-full" disabled={busy} onClick={() => verifyMfa(mfaDevToken)}>
                  {busy ? 'Signing in…' : 'Open link (dev mode)'}
                </button>
              )}
              <button
                type="button"
                className="w-full text-center text-xs text-muted-foreground underline"
                onClick={() => {
                  setErr(null);
                  setMfaDevToken(null);
                  setStage('password');
                }}
              >
                Start again
              </button>
            </>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <p className="border-t pt-4 text-center text-xs text-muted-foreground">
            Having trouble accessing your account? Contact your IT team.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
