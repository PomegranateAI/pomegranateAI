import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStructuredLLM } from '../../lib/anthropic.js';
import { readMedia, processorConfig } from './read-media.js';
import { validateMedia } from './validate-media.js';
import { ReaderConfig, type Asset } from './media-types.js';
import { S3AssetStore, LocalAssetStore } from './asset-store.js';
import type { S3Client } from '@aws-sdk/client-s3';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0woAAAAASUVORK5CYII=',
  'base64',
);
const asset: Asset = {
  id: 'a',
  workspace_id: 'w',
  object_key: 'w/a',
  backend: 'local',
  original_name: 'image.png',
  mime: 'image/png',
  bytes: png.length,
  sha256: 'hash',
  owner_user_id: 'u',
  visibility: 'private',
  created_at: '',
};
afterEach(() => {
  setStructuredLLM(null);
  vi.unstubAllEnvs();
});

describe('media providers and validation', () => {
  it('passes image bytes through the structured provider and keeps OCR distinct', async () => {
    const call = vi.fn(async () => ({ ocr: 'Budget: 42', description: 'A handwritten note.' }));
    setStructuredLLM({ name: 'test', supportsImages: true, callStructured: call });
    const result = await readMedia(asset, png, processorConfig(asset.mime, ReaderConfig.parse({})));
    expect(call.mock.calls[0]?.[0]).toMatchObject({ images: [{ mime: 'image/png', data: png.toString('base64') }] });
    expect(result.ocr).toBe('Budget: 42');
    expect(result.description).toBe('A handwritten note.');
    expect(result.text).toContain('Visible text:\nBudget: 42');
  });
  it('refuses providers that would silently ignore images', async () => {
    const call = vi.fn();
    setStructuredLLM({ callStructured: call });
    await expect(readMedia(asset, png, processorConfig(asset.mime, ReaderConfig.parse({})))).rejects.toThrow(
      'vision_provider',
    );
    expect(call).not.toHaveBeenCalled();
  });
  it('rejects oversized image metadata and malformed audio before provider calls', async () => {
    await expect(validateMedia(png, 'image/png')).resolves.toBeUndefined();
    const huge = Buffer.from(png);
    huge.writeUInt32BE(20000, 16);
    await expect(validateMedia(huge, 'image/png')).rejects.toThrow('image_too_large');
    await expect(validateMedia(Buffer.from('RIFFbad'), 'audio/wav')).rejects.toThrow();
  });
  it('resolves the audio language per user, over the deployment default, over English', () => {
    vi.stubEnv('POMEGRANATE_STT_PROVIDER', 'openai');
    vi.stubEnv('POMEGRANATE_STT_LANGUAGE', '');
    expect(processorConfig('audio/ogg', ReaderConfig.parse({})).language).toBe('en');
    vi.stubEnv('POMEGRANATE_STT_LANGUAGE', 'fr');
    expect(processorConfig('audio/ogg', ReaderConfig.parse({})).language).toBe('fr');
    expect(processorConfig('audio/ogg', ReaderConfig.parse({ language: 'ar-TN' })).language).toBe('ar-TN');
  });
  it('treats a different audio language as a different extraction identity', () => {
    expect(processorConfig('audio/wav', ReaderConfig.parse({ language: 'ar' }))).not.toEqual(
      processorConfig('audio/wav', ReaderConfig.parse({ language: 'en' })),
    );
  });
  it('does not change extraction identity when only the output mode changes', () => {
    expect(processorConfig('audio/wav', ReaderConfig.parse({ output: 'log' }))).toEqual(
      processorConfig('audio/wav', ReaderConfig.parse({ output: 'capture' })),
    );
  });
  it('uses private S3 object operations and preserves bytes', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => png } })
      .mockResolvedValueOnce({});
    const store = new S3AssetStore({ send } as unknown as S3Client, 'media');
    await store.put('w/a', png, 'image/png');
    expect(await store.read('w/a')).toEqual(png);
    await store.delete('w/a');
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: 'media', Key: 'w/a', Body: png, ContentType: 'image/png' });
    expect(send.mock.calls[2]![0].input).toEqual({ Bucket: 'media', Key: 'w/a' });
  });
  it('rejects local object keys outside the storage root', async () => {
    const store = new LocalAssetStore('/tmp/media-test');
    await expect(store.put('../escape', png)).rejects.toThrow('invalid_asset_key');
  });
});
