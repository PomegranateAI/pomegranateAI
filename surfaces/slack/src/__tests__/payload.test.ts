import { describe, it, expect } from 'vitest';
import { resolvePayload, extensionOf, SUPPORTED_EXTS } from '../payload.js';
import { EmptyPayload, UnsupportedFile } from '../errors.js';
import type { MentionContext, SlackFileRef } from '../types.js';

/**
 * Build a fake MentionContext. Only `files` and `fetchFileText` matter to
 * resolvePayload; everything else is a dummy / async no-op stub.
 */
function makeCtx(
  overrides: Partial<MentionContext> & {
    files?: SlackFileRef[];
    fileText?: string;
    onFetch?: (file: SlackFileRef) => void;
  } = {},
): MentionContext {
  const { files = [], fileText = '', onFetch, ...rest } = overrides;
  return {
    text: 'dummy text',
    files,
    requesterUserId: 'U_DUMMY',
    teamId: 'T_DUMMY',
    channelId: 'C_DUMMY',
    threadKey: 'C_DUMMY:1.1',
    eventId: 'E_DUMMY',
    react: async () => {},
    reply: async () => {},
    replyEditable: async () => async () => {},
    fetchFileText: async (file: SlackFileRef) => {
      onFetch?.(file);
      return fileText;
    },
    ...rest,
  };
}

describe('extensionOf', () => {
  it('lowercases the extension and keeps the dot', () => {
    expect(extensionOf('Notes.MD')).toBe('.md');
    expect(extensionOf('a.txt')).toBe('.txt');
  });
  it('returns empty string when there is no extension', () => {
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });
});

describe('SUPPORTED_EXTS', () => {
  it('is .txt and .md', () => {
    expect([...SUPPORTED_EXTS]).toEqual(['.txt', '.md']);
  });
});

describe('resolvePayload', () => {
  it('reads a .txt file: calls fetchFileText and returns a file payload', async () => {
    let fetched = false;
    const ctx = makeCtx({
      files: [{ name: 'brief.txt' }],
      fileText: 'file contents here',
      onFetch: () => {
        fetched = true;
      },
    });
    const payload = await resolvePayload(ctx, '');
    expect(fetched).toBe(true);
    expect(payload).toEqual({
      kind: 'file',
      name: 'brief.txt',
      text: 'file contents here',
    });
  });

  it('accepts an uppercase .MD extension (case-insensitive)', async () => {
    const ctx = makeCtx({
      files: [{ name: 'PLAN.MD' }],
      fileText: 'markdown body',
    });
    const payload = await resolvePayload(ctx, '');
    expect(payload).toEqual({
      kind: 'file',
      name: 'PLAN.MD',
      text: 'markdown body',
    });
  });

  it('throws UnsupportedFile for an unsupported extension', async () => {
    const ctx = makeCtx({ files: [{ name: 'deck.pptx' }] });
    await expect(resolvePayload(ctx, '')).rejects.toBeInstanceOf(
      UnsupportedFile,
    );
  });

  it('prefers the file over remainder text (precedence)', async () => {
    let fetched = false;
    const ctx = makeCtx({
      files: [{ name: 'doc.md' }],
      fileText: 'from the file',
      onFetch: () => {
        fetched = true;
      },
    });
    const payload = await resolvePayload(ctx, 'inline remainder text');
    expect(fetched).toBe(true);
    expect(payload).toEqual({
      kind: 'file',
      name: 'doc.md',
      text: 'from the file',
    });
  });

  it('falls back to inline text when there is no file', async () => {
    const ctx = makeCtx();
    const payload = await resolvePayload(ctx, 'hello world');
    expect(payload).toEqual({ kind: 'text', text: 'hello world' });
  });

  it('throws EmptyPayload when there is no file and only whitespace remainder', async () => {
    const ctx = makeCtx();
    await expect(resolvePayload(ctx, '   ')).rejects.toBeInstanceOf(
      EmptyPayload,
    );
  });
});
