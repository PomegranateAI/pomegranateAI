import { imageSize } from 'image-size';
import { parseBuffer } from 'music-metadata';
import { MediaError } from './media-service.js';

/** Inspect metadata before invoking a paid provider or decoding large images. */
export async function validateMedia(bytes: Buffer, mime: string): Promise<void> {
  try {
    if (mime.startsWith('image/')) {
      const size = imageSize(bytes);
      if (!size.width || !size.height) throw new MediaError('invalid_image');
      if (size.width * size.height > 40_000_000 || size.width > 16_000 || size.height > 16_000) {
        throw new MediaError('image_too_large', 413);
      }
      return;
    }
    const metadata = await parseBuffer(bytes, { mimeType: mime }, { duration: true, skipCovers: true });
    if (metadata.format.hasVideo) throw new MediaError('video_not_supported');
    const duration = metadata.format.duration;
    if (!duration || !Number.isFinite(duration)) throw new MediaError('invalid_audio');
    if (duration > 60 * 60) throw new MediaError('audio_too_long', 413);
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError('invalid_media');
  }
}
