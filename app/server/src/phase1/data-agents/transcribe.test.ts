import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudio } from './transcribe.js';

afterEach(() => vi.unstubAllGlobals());

describe('transcribeAudio provider seam', () => {
  it('uses Deepgram Nova-3 with Tunisian Arabic', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'مرحبا بيك' }] }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
        provider: 'deepgram',
        apiKey: 'secret',
        language: 'ar-TN',
        contentType: 'audio/ogg; codecs=opus',
      }),
    ).resolves.toBe('مرحبا بيك');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('model=nova-3');
    expect(url).toContain('language=ar-TN');
    expect(init.headers.Authorization).toBe('Token secret');
  });

  it('keeps OpenAI Whisper available for Arabic', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'مرحبا' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
        provider: 'openai',
        apiKey: 'secret',
        language: 'ar',
        contentType: 'audio/ogg',
      }),
    ).resolves.toBe('مرحبا');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.body.get('model')).toBe('whisper-1');
    expect(init.body.get('language')).toBe('ar');
  });

  it('falls back to English when no language is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'hello there' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
        provider: 'openai',
        apiKey: 'secret',
        contentType: 'audio/ogg',
      }),
    ).resolves.toBe('hello there');
    expect(fetchMock.mock.calls[0][1].body.get('language')).toBe('en');
  });

  it('falls back to English on Deepgram too, rather than a hardcoded multi', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'hello there' }] }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
      provider: 'deepgram',
      apiKey: 'secret',
      contentType: 'audio/ogg',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('language=en');
  });

  it('uses Munsit Arabic transcription', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transcription: 'اجتماع الفريق' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
        provider: 'munsit',
        apiKey: 'secret',
        contentType: 'audio/ogg',
      }),
    ).resolves.toBe('اجتماع الفريق');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.munsit.com/api/v1/audio/transcribe');
    expect(init.headers['x-api-key']).toBe('secret');
    expect(init.body.get('model')).toBe('munsit');
  });

  it('returns null when a provider rejects the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }));
    await expect(
      transcribeAudio(Buffer.from('audio'), 'voice.ogg', {
        provider: 'munsit',
        apiKey: 'bad',
      }),
    ).resolves.toBeNull();
  });
});
