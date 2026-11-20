import { useState } from 'react';
import { Check, Circle, Eye, EyeOff, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Choosing a new password: one field with show/hide, the rules ticked off as
 * they are met, a strength bar, and a confirm field that says whether it
 * matches. Shared by Setup → Password, the forced change after an
 * administrator-set password, and the forgotten-password screen.
 *
 * The rules mirror the server's passwordPolicyError (lib/passwords.ts) closely
 * enough that "all ticked" almost always means "accepted"; the server stays
 * the authority and its message is shown when it refuses.
 */

const EASY_FRAGMENTS = ['password', 'passw0rd', 'qwerty', 'welcome', 'letmein', 'iloveyou', 'admin', 'changeme', '123456', 'pomegranate'];

export type PasswordRule = { key: string; label: string; met: boolean };

export function passwordRules(pw: string, email?: string): PasswordRule[] {
  const lower = pw.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  const local = email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return [
    { key: 'length', label: 'At least 12 characters', met: pw.length >= 12 },
    {
      key: 'guess',
      label: 'Not a common word or pattern',
      met: pw.length > 0 && new Set(lower).size >= 4 && !EASY_FRAGMENTS.some((f) => squashed.includes(f)),
    },
    {
      key: 'name',
      label: 'Doesn’t contain your email name',
      met: pw.length > 0 && !(local.length >= 4 && squashed.includes(local)),
    },
  ];
}

/** 0 = nothing typed, 1 weak, 2 fair, 3 good, 4 strong. */
export function passwordStrength(pw: string, email?: string): number {
  if (!pw) return 0;
  if (!passwordRules(pw, email).every((r) => r.met)) return 1;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let score = 2;
  if (pw.length >= 16 || classes >= 3) score++;
  if (pw.length >= 20 || (pw.length >= 16 && classes >= 3)) score++;
  return Math.min(score, 4);
}

export function newPasswordReady(pw: string, confirm: string, email?: string): boolean {
  return passwordRules(pw, email).every((r) => r.met) && pw === confirm;
}

const STRENGTH_LABEL = ['', 'Too weak', 'Fair', 'Good', 'Strong'];
const STRENGTH_COLOR = ['bg-muted', 'bg-destructive', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];

function SecretInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus,
  onEnter,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.();
        }}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

/** A current-password field with the same show/hide affordance. */
export function CurrentPasswordField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <SecretInput id={id} value={value} onChange={onChange} autoComplete="current-password" />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function NewPasswordFields({
  idPrefix,
  email,
  value,
  onChange,
  confirm,
  onConfirmChange,
  autoFocus,
  onSubmit,
}: {
  idPrefix: string;
  /** The account's email — the rules refuse a password containing its name. */
  email?: string;
  value: string;
  onChange: (v: string) => void;
  confirm: string;
  onConfirmChange: (v: string) => void;
  autoFocus?: boolean;
  /** Enter in the confirm field. */
  onSubmit?: () => void;
}) {
  const rules = passwordRules(value, email);
  const strength = passwordStrength(value, email);
  const matches = confirm.length > 0 && confirm === value;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-new`}>New password</Label>
        <SecretInput id={`${idPrefix}-new`} value={value} onChange={onChange} autoComplete="new-password" autoFocus={autoFocus} />
        <div className="flex items-center gap-2 pt-1" aria-live="polite">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn('h-1.5 flex-1 rounded-full transition-colors', i <= strength ? STRENGTH_COLOR[strength] : 'bg-muted')}
              />
            ))}
          </div>
          <span className="w-16 text-right text-xs text-muted-foreground">{STRENGTH_LABEL[strength]}</span>
        </div>
        <ul className="space-y-1 pt-1">
          {rules.map((r) => (
            <li
              key={r.key}
              className={cn('flex items-center gap-2 text-xs', r.met ? 'text-emerald-700' : 'text-muted-foreground')}
            >
              {r.met ? <Check className="size-3.5" /> : <Circle className="size-3" />}
              {r.label}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Tip: a few unrelated words make a password that is long and easy to remember.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-confirm`}>Type it again</Label>
        <SecretInput
          id={`${idPrefix}-confirm`}
          value={confirm}
          onChange={onConfirmChange}
          autoComplete="new-password"
          onEnter={onSubmit}
        />
        {confirm.length > 0 && (
          <p className={cn('flex items-center gap-1.5 text-xs', matches ? 'text-emerald-700' : 'text-destructive')}>
            {matches ? <Check className="size-3.5" /> : <X className="size-3.5" />}
            {matches ? 'Passwords match' : 'Doesn’t match yet'}
          </p>
        )}
      </div>
    </div>
  );
}

/** "400 Bad Request: {"error":"…"}" → the server's reason, in words. */
export function passwordErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const code = raw.match(/"error":"([^"]+)"/)?.[1];
  if (code === 'invalid_current_password') return 'Your current password isn’t right.';
  if (code === 'expired') return 'This link has expired or was already used. Ask for a new one.';
  if (code) return code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ') + '.';
  return raw;
}
