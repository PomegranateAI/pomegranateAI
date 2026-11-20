import { describe, it, expect, vi } from 'vitest';
import { resendConfigFromEnv, sendMagicLinkViaResend } from './resend.js';

describe('resendConfigFromEnv', () => {
  it('returns null when RESEND_API_KEY is unset or blank (dev/SMTP fallback)', () => {
    expect(resendConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resendConfigFromEnv({ RESEND_API_KEY: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('requires MAIL_FROM alongside the key (no default sender)', () => {
    expect(resendConfigFromEnv({ RESEND_API_KEY: 're_test_123' } as NodeJS.ProcessEnv)).toBeNull();
    const custom = resendConfigFromEnv({
      RESEND_API_KEY: 're_test_123',
      MAIL_FROM: 'Acme <hi@acme.test>',
    } as NodeJS.ProcessEnv);
    expect(custom?.from).toBe('Acme <hi@acme.test>');
  });
});

describe('sendMagicLinkViaResend', () => {
  const config = { apiKey: 're_test_123', from: 'Pomegranate <noreply@example.com>' };

  it('POSTs the magic-link message to the Resend API with auth header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    await sendMagicLinkViaResend({
      config,
      to: 'user@example.com',
      code: 'CODE123',
      origin: 'https://app.example.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_123');
    const body = JSON.parse(init.body);
    expect(body.to).toBe('user@example.com');
    expect(body.from).toBe(config.from);
    expect(body.subject).toBe('Your Pomegranate sign-in link');
    expect(body.text).toContain('CODE123');
    expect(body.text).toContain('https://app.example.com/?code=CODE123');
  });

  it('rejects on a non-2xx response with status + detail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('invalid api key', { status: 401 }));
    await expect(
      sendMagicLinkViaResend({
        config,
        to: 'user@example.com',
        code: 'CODE123',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Resend 401: invalid api key/);
  });
});
