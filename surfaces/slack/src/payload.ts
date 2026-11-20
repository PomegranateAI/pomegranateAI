/**
 * Resolve a Slack mention into reviewable text.
 *
 * Precedence (v0): attached FILE → inline TEXT.
 *
 * NOTE: Link/URL fetching is DEFERRED in v0. If the remainder contains a URL
 * but no file is attached, we simply treat the remainder as inline text rather
 * than fetching the linked document. Fetching linked docs is a fast-follow.
 */
import type { MentionContext, Payload } from './types.js';
import { EmptyPayload, UnsupportedFile } from './errors.js';

export const SUPPORTED_EXTS = ['.txt', '.md'] as const;

/** Lowercased extension including the leading dot, or '' if the name has none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  // No dot, or a leading dot (dotfile with no real extension) → no extension.
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

export async function resolvePayload(
  ctx: MentionContext,
  remainder: string,
): Promise<Payload> {
  // 1. A file wins over inline text.
  if (ctx.files.length > 0) {
    const file = ctx.files[0]!;
    const ext = extensionOf(file.name);
    if ((SUPPORTED_EXTS as readonly string[]).includes(ext)) {
      const text = await ctx.fetchFileText(file);
      return { kind: 'file', name: file.name, text };
    }
    // pdf/docx support is a fast-follow via the app's extract endpoint.
    throw new UnsupportedFile(
      `I can't read \`${file.name}\` yet. I currently support \`.txt\` and \`.md\` files — paste the text or attach one of those instead.`,
      `unsupported file extension: ${ext || '(none)'}`,
    );
  }

  // 2. Fall back to inline text.
  const trimmed = remainder.trim();
  if (trimmed.length > 0) {
    return { kind: 'text', text: trimmed };
  }

  // 3. Nothing usable.
  throw new EmptyPayload(
    "I didn't find anything to look at — attach a `.txt`/`.md` file or paste the text into your message.",
  );
}
