import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { MissingToken } from '../errors.js';

const FULL_ENV = {
  WASENDER_API_TOKEN: 'tok',
  WASENDER_WEBHOOK_SECRET: 'whsec',
  POMEGRANATE_API_URL: 'https://pomegranate.example.com/',
  SURFACE_AGENT_SECRET: 'sfsec',
  DEEPGRAM_API_KEY: 'dgsec',
};

describe('loadConfig', () => {
  it('parses a fully-populated env', () => {
    const cfg = loadConfig(FULL_ENV);
    expect(cfg.wasenderApiToken).toBe('tok');
    expect(cfg.wasenderWebhookSecret).toBe('whsec');
    // trailing slash stripped so callers can safely template `${base}/path`
    expect(cfg.pomegranateApiUrl).toBe('https://pomegranate.example.com');
    expect(cfg.surfaceAgentSecret).toBe('sfsec');
    expect(cfg.wasenderApiBaseUrl).toBe('https://www.wasenderapi.com/api');
    expect(cfg.port).toBe(3002);
  });

  it('does not require transcription credentials on the surface', () => {
    expect(loadConfig({...FULL_ENV,POMEGRANATE_STT_PROVIDER:'munsit'})).not.toHaveProperty('transcription');
  });

  it('respects PORT and WASENDER_API_BASE_URL overrides', () => {
    const cfg = loadConfig({ ...FULL_ENV, PORT: '4000', WASENDER_API_BASE_URL: 'https://api.example.com/' });
    expect(cfg.port).toBe(4000);
    expect(cfg.wasenderApiBaseUrl).toBe('https://api.example.com');
  });

  it('throws MissingToken listing every missing required var', () => {
    expect(() => loadConfig({})).toThrow(MissingToken);
    try {
      loadConfig({ WASENDER_API_TOKEN: 'tok' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingToken);
      expect((err as Error).message).toContain('WASENDER_WEBHOOK_SECRET');
      expect((err as Error).message).toContain('POMEGRANATE_API_URL');
      expect((err as Error).message).toContain('SURFACE_AGENT_SECRET');
    }
  });
});
