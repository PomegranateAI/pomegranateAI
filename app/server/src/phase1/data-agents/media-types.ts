import { z } from 'zod';

/**
 * Spoken language assumed for transcription when nobody has said otherwise.
 * Precedence is per-user binding -> POMEGRANATE_STT_LANGUAGE (deployment-wide)
 * -> this. Never hardcode a language in a provider call; resolve it here.
 */
export const DEFAULT_STT_LANGUAGE = 'en';

export const ReaderConfig = z.object({
  /** BCP-47-ish tag ('en', 'ar', 'fr', 'ar-TN'). Per-user; empty means the default. */
  language: z.string().max(32).optional(),
  output: z.enum(['capture', 'log']).default('capture'),
});
export type ReaderConfig = z.infer<typeof ReaderConfig>;
export interface MediaResult {
  text: string;
  ocr?: string;
  description?: string;
  provider: string;
  model: string;
}
export interface Asset {
  workspace_id: string;
  id: string;
  object_key: string;
  backend: string;
  original_name: string;
  mime: string;
  bytes: number;
  sha256: string;
  owner_user_id: string;
  visibility: 'private' | 'team';
  created_at: string;
}
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Validate signatures rather than trusting a filename or client Content-Type. */
export function mediaMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return 'audio/mpeg';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  return null;
}

/** Extensions the media readers take (audio → STT, image → vision). Content is still sniffed by mediaMime(). */
export const MEDIA_EXTS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.mp4', '.wav', '.flac', '.webm', '.png', '.jpg', '.jpeg', '.webp'] as const;

export function isMediaFilename(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i !== -1 && (MEDIA_EXTS as readonly string[]).includes(name.slice(i).toLowerCase());
}
