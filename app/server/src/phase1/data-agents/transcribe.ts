/** Shared data-agent audio transcription provider seam. */
import { log } from '../../lib/log.js';
import { DEFAULT_STT_LANGUAGE } from './media-types.js';
const logEvent = (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) =>
  log[level](event, fields);

export type TranscriptionProvider = 'openai' | 'deepgram' | 'munsit';

export interface TranscribeOptions {
  provider: TranscriptionProvider;
  apiKey: string;
  model?: string;
  language?: string;
  contentType?: string;
}

interface DeepgramResponse {
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
}

interface MunsitResponse {
  data?: { transcription?: string };
}

async function transcribeOpenAI(audioBuffer: Buffer, filename: string, options: TranscribeOptions): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', options.model ?? 'whisper-1');
  form.append('language', options.language ?? DEFAULT_STT_LANGUAGE);
  return fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: form,
  });
}

async function transcribeDeepgram(audioBuffer: Buffer, options: TranscribeOptions): Promise<Response> {
  const query = new URLSearchParams({
    model: options.model ?? 'nova-3',
    language: options.language ?? DEFAULT_STT_LANGUAGE,
    smart_format: 'true',
  });
  return fetch(`https://api.deepgram.com/v1/listen?${query}`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      Authorization: `Token ${options.apiKey}`,
      'Content-Type': options.contentType ?? 'audio/ogg',
    },
    body: audioBuffer,
  });
}

async function transcribeMunsit(audioBuffer: Buffer, filename: string, options: TranscribeOptions): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: options.contentType }), filename);
  form.append('model', options.model ?? 'munsit');
  form.append('return_timestamps', 'false');
  return fetch('https://api.munsit.com/api/v1/audio/transcribe', {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'x-api-key': options.apiKey },
    body: form,
  });
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string,
  options: TranscribeOptions,
): Promise<string | null> {
  const provider = options.provider;
  try {
    const res =
      provider === 'openai'
        ? await transcribeOpenAI(audioBuffer, filename, options)
        : provider === 'deepgram'
          ? await transcribeDeepgram(audioBuffer, options)
          : await transcribeMunsit(audioBuffer, filename, options);

    if (!res.ok) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 500);
      } catch {
        /* body unreadable */
      }
      logEvent('warn', 'stt_transcribe_failed', { provider, status: res.status, bodyLength: snippet.length });
      return null;
    }

    const result = (await res.json()) as { text?: string } | DeepgramResponse | MunsitResponse;
    const text =
      provider === 'openai'
        ? (result as { text?: string }).text
        : provider === 'deepgram'
          ? (result as DeepgramResponse).results?.channels?.[0]?.alternatives?.[0]?.transcript
          : (result as MunsitResponse).data?.transcription;
    const transcript = text?.trim() || null;
    if (transcript) logEvent('info', 'stt_transcribe_success', { provider, textLength: transcript.length });
    return transcript;
  } catch (err) {
    logEvent('error', 'stt_transcribe_error', { provider, reason: (err as Error).message });
    return null;
  }
}
