/**
 * The one list of file types the upload UI accepts. It mirrors what the
 * server can actually read — keep it in sync with:
 *   - DOC_EXTS / TRANSCRIPT_EXTS in app/server/src/phase1/ingest/extract.ts
 *   - isMediaFilename in app/server/src/phase1/data-agents/media-types.ts
 * app/server/src/phase1/ingest/upload-formats-parity.test.ts fails if they drift.
 */
import { api } from '../api';

/** Extracted to text by the server (documents, office files, transcripts). */
export const DOCUMENT_EXTS = [
  '.txt', '.md', '.html', '.htm', '.pdf',
  '.docx', '.pptx', '.xlsx', '.doc', '.ppt', '.xls',
  '.vtt',
] as const;
/** Need the destination folder's "Transcribe audio" data agent. */
export const AUDIO_EXTS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.mp4', '.wav', '.flac', '.webm'] as const;
/** Need the destination folder's "Read images" data agent. */
export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/** `accept` for inputs that only take text-extractable files. */
export const DOCUMENT_ACCEPT = DOCUMENT_EXTS.join(',');
/** `accept` for inputs that also take audio and images (ingest into a folder). */
export const ALL_ACCEPT = [...DOCUMENT_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS].join(',');

/** Human-readable list for drop-zone hints. */
export const DOCUMENT_HINT = DOCUMENT_EXTS.filter((e) => e !== '.htm').join(' ');

export type UploadKind = 'document' | 'audio' | 'image';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

export function uploadKind(name: string): UploadKind | null {
  const ext = extOf(name);
  if ((DOCUMENT_EXTS as readonly string[]).includes(ext)) return 'document';
  if ((AUDIO_EXTS as readonly string[]).includes(ext)) return 'audio';
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return 'image';
  return null;
}

export interface MissingReader {
  file: string;
  capability: 'audio' | 'image';
  /** Folder the file was headed for; `default` when none was chosen. */
  folderId: string;
}

/**
 * Audio/images are read by the destination folder's media data agent. Returns
 * what's missing when that agent isn't on, or null when the upload can go
 * ahead (documents, or a folder whose reader is enabled).
 *
 * The server enforces the same rule (422 media_reader_required); this check
 * just lets the UI say so before the upload instead of after. If the lookup
 * itself fails we let the upload through and rely on the server's answer.
 */
export async function missingMediaReader(
  wsId: string,
  file: File,
  folderId: string | undefined,
): Promise<MissingReader | null> {
  const kind = uploadKind(file.name);
  if (kind !== 'audio' && kind !== 'image') return null;
  const target = folderId ?? 'default';
  try {
    const { bindings } = await api.mediaReaders(wsId, target);
    const enabled = bindings.some((b) => b.capability === kind && b.enabled);
    return enabled ? null : { file: file.name, capability: kind, folderId: target };
  } catch {
    return null;
  }
}

/** Map the server's 422 back to the same shape, for the race where the reader was switched off mid-upload. */
export function readerErrorFrom(err: unknown, file: File, folderId: string | undefined): MissingReader | null {
  const kind = uploadKind(file.name);
  if ((kind !== 'audio' && kind !== 'image') || !/media_reader_required/.test(String((err as Error)?.message)))
    return null;
  return { file: file.name, capability: kind, folderId: folderId ?? 'default' };
}
