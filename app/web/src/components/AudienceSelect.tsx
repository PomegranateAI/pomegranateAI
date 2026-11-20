import { useState } from 'react';
import { AUDIENCE_TIERS, AUDIENCE_SHORT, type Audience } from '../audience.js';

/**
 * The one sharing control, used identically in Sources, Curate, and Library. A
 * pill showing the current tier that opens a popover of the three tiers. Purely
 * presentational — the caller supplies `onChange`. No 'local', no 'share with
 * specific people'.
 */
export function AudienceSelect({
  value,
  onChange,
  disabled,
  align = 'left',
  className,
}: {
  value: Audience;
  onChange: (audience: Audience) => void;
  disabled?: boolean;
  /** Which edge the popover anchors to. */
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const restrictive = value !== 'team';
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title="Choose who can access this"
        className={`rounded-full border px-2 py-0.5 font-mono text-[0.6rem] transition-colors disabled:opacity-50 ${
          restrictive ? 'border-pome-red/40 bg-pome-red/5 text-pome-red' : 'text-muted-foreground hover:bg-accent/50'
        }`}
      >
        {AUDIENCE_SHORT[value]} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-xl ${
              align === 'right' ? 'right-0' : 'left-0'
            }`}
          >
            {AUDIENCE_TIERS.map((tier) => (
              <button
                key={tier.key}
                type="button"
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  if (tier.key !== value) onChange(tier.key);
                }}
              >
                <div className="font-medium">
                  {tier.label}
                  {tier.key === value ? ' ✓' : ''}
                </div>
                <div className="text-xs text-muted-foreground">{tier.hint}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
