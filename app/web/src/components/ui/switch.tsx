import * as React from 'react';

/**
 * Minimal, dependency-free toggle switch matching the app's control styling —
 * used for boolean settings (Track's watch/auto-ingest, a rule's enabled state)
 * instead of prominent filled buttons.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
