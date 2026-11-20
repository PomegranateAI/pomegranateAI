import { z } from 'zod';
import { ImageReading } from '../../lib/schemas.js';
import { structuredCall, loadPromptBody, promptMeta } from '../../lib/anthropic.js';
import { writeLlmCall } from '../../lib/llm-log.js';
import { getLlmContext } from '../../lib/llm-context.js';
import { transcribeAudio, type TranscriptionProvider } from './transcribe.js';
import { DEFAULT_STT_LANGUAGE, type Asset, type ReaderConfig, type MediaResult } from './media-types.js';

/** Blank is not a choice: an empty binding field or env var means "unset". */
const set = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/** Only non-secret provider configuration enters a run's immutable identity. */
export function processorConfig(mime: string, config: ReaderConfig) {
  if (mime.startsWith('image/'))
    return {
      language: config.language,
      provider: 'vision',
      model:
        process.env.POMEGRANATE_LLM_PROVIDER === 'anthropic'
          ? 'claude-sonnet-4-5-20250929'
          : (process.env.POMEGRANATE_HOSTED_MODEL ?? 'claude-sonnet-4-5-20250929'),
      version: 1,
    };
  const provider = process.env.POMEGRANATE_STT_PROVIDER ?? 'deepgram';
  if (!['openai', 'deepgram', 'munsit'].includes(provider)) throw new Error('invalid_stt_provider');
  return {
    provider,
    model:
      process.env.POMEGRANATE_STT_MODEL ??
      (provider === 'openai' ? 'whisper-1' : provider === 'deepgram' ? 'nova-3' : 'munsit'),
    language: set(config.language) ?? set(process.env.POMEGRANATE_STT_LANGUAGE) ?? DEFAULT_STT_LANGUAGE,
    version: 1,
  };
}

export async function readMedia(
  asset: Asset,
  bytes: Buffer,
  config: ReturnType<typeof processorConfig>,
): Promise<MediaResult> {
  const start = Date.now();
  const context = getLlmContext();
  try {
    let result: MediaResult;
    if (asset.mime.startsWith('image/')) {
      const response = await structuredCall({
        model: config.model,
        system: loadPromptBody('read-image'),
        user: 'Read the attached image.',
        images: [{ mime: asset.mime, data: bytes.toString('base64') }],
        toolName: 'read_image',
        toolDescription: 'Visible text and visual description',
        schema: z.toJSONSchema(ImageReading, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
        task: 'read-image',
        maxTokens: 8192,
      });
      const reading = ImageReading.parse(response.output);
      result = {
        ...reading,
        text: [
          reading.ocr && `Visible text:\n${reading.ocr}`,
          reading.description && `Image description:\n${reading.description}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        provider: config.provider,
        model: config.model,
      };
    } else {
      const provider = config.provider as TranscriptionProvider;
      const apiKey =
        process.env[
          provider === 'openai' ? 'OPENAI_API_KEY' : provider === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'MUNSIT_API_KEY'
        ];
      if (!apiKey) throw new Error('transcription_not_configured');
      const text = await transcribeAudio(bytes, asset.original_name, {
        provider,
        apiKey,
        model: config.model,
        language: config.language,
        contentType: asset.mime,
      });
      if (!text) throw new Error('transcription_failed');
      result = { text, provider, model: config.model };
    }
    if (!result.text.trim()) throw new Error('no_text_extracted');
    writeLlmCall({
      ...context,
      task: 'read-media',
      model: config.model,
      prompt_version: asset.mime.startsWith('image/') ? promptMeta('read-image').version : 1,
      input: { asset_id: asset.id, bytes: asset.bytes, mime: asset.mime },
      output: { chars: result.text.length },
      latency_ms: Date.now() - start,
    });
    return result;
  } catch (error) {
    writeLlmCall({
      ...context,
      task: 'read-media',
      model: config.model,
      input: { asset_id: asset.id, bytes: asset.bytes },
      output: null,
      error: 'media_read_failed',
      latency_ms: Date.now() - start,
    });
    throw error;
  }
}
