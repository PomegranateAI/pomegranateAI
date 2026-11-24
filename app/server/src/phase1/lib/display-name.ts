// Display names (directories, folders) end up in email subjects and other
// single-line contexts, so they may not carry control characters: a CR/LF in a
// workspace name would otherwise reach an email header.
import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

/** z.string().min(1) that rejects control characters (\x00-\x1f, \x7f). */
export const displayName = () =>
  z
    .string()
    .min(1)
    .refine((v) => !hasControlChars(v), { message: 'name must not contain control characters' });
