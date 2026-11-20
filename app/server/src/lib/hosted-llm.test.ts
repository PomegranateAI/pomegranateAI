import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HostedStructuredLLM } from './hosted-llm.js';
import { configureLlmProvider } from './llm-provider.js';
import { setStructuredLLM, usingLocalLLM } from './anthropic.js';

const HOSTED_ENV = {
  POMEGRANATE_HOSTED_BASE_URL: 'https://api.example.test/v1',
  POMEGRANATE_HOSTED_API_KEY: 'k-test',
  POMEGRANATE_HOSTED_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
};

// Provider selection lives in llm-provider.ts (`configureLlmProvider`), called
// once at boot. `usingLocalLLM()` reports whether the structured-LLM override
// was installed — i.e. whether the hosted backend is the active one.
describe('llm provider selection', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    setStructuredLLM(null);
    delete process.env.POMEGRANATE_LLM_PROVIDER;
    for (const k of Object.keys(HOSTED_ENV)) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
    setStructuredLLM(null);
  });

  it('defaults to the Together endpoint when POMEGRANATE_LLM_PROVIDER is unset', () => {
    Object.assign(process.env, HOSTED_ENV);
    expect(configureLlmProvider()).toBe(`together:${HOSTED_ENV.POMEGRANATE_HOSTED_MODEL}`);
    expect(usingLocalLLM()).toBe(true);
  });

  it('accepts Together explicitly', () => {
    process.env.POMEGRANATE_LLM_PROVIDER = 'together';
    Object.assign(process.env, HOSTED_ENV);
    expect(configureLlmProvider()).toBe(`together:${HOSTED_ENV.POMEGRANATE_HOSTED_MODEL}`);
  });

  it('installs the hosted provider when POMEGRANATE_LLM_PROVIDER=hosted', () => {
    process.env.POMEGRANATE_LLM_PROVIDER = 'hosted';
    Object.assign(process.env, HOSTED_ENV);
    expect(configureLlmProvider()).toBe(`hosted:${HOSTED_ENV.POMEGRANATE_HOSTED_MODEL}`);
    expect(usingLocalLLM()).toBe(true);
  });

  it('rejects unknown provider names instead of silently using hosted inference', () => {
    process.env.POMEGRANATE_LLM_PROVIDER = 'typo';
    expect(() => configureLlmProvider()).toThrow(/Unsupported POMEGRANATE_LLM_PROVIDER: typo/);
  });

  it('opts back into Anthropic tool-use with POMEGRANATE_LLM_PROVIDER=anthropic', () => {
    process.env.POMEGRANATE_LLM_PROVIDER = 'anthropic';
    expect(configureLlmProvider()).toBe('anthropic');
    expect(usingLocalLLM()).toBe(false); // no override installed
  });

  it('fails loud when the hosted backend is active but not configured', () => {
    // Boot must throw rather than silently fall back to a different model.
    expect(() => configureLlmProvider()).toThrow(/POMEGRANATE_HOSTED_BASE_URL/);
  });
});

describe('HostedStructuredLLM.callStructured', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends json_schema, strips null enums, and parses the object out', async () => {
    let sentBody: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        sentBody = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '{"relevant":true}' } }] }),
        } as any;
      }),
    );

    const llm = new HostedStructuredLLM({ ...toOpts(), schemaMode: 'json_schema' });
    const out = await llm.callStructured({
      model: 'm',
      system: 'sys',
      user: 'usr',
      toolName: 'emit',
      toolDescription: 'd',
      // `enum` with a null must be sanitized away for hosted schema engines.
      schema: { type: 'object', properties: { flag: { enum: ['a', null] } } },
      task: 'triage',
    });

    expect(out).toEqual({ relevant: true });
    expect(sentBody.response_format.type).toBe('json_schema');
    expect(sentBody.response_format.json_schema.schema.properties.flag.enum).toEqual(['a']);
  });

  it('strips <think> blocks and code fences from the reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '<think>reasoning…</think>\n```json\n{"ok":1}\n```' } }],
        }),
      })) as any,
    );
    const llm = new HostedStructuredLLM(toOpts());
    const out = await llm.callStructured({
      model: 'm', system: 's', user: 'u', toolName: 't', toolDescription: 'd',
      schema: { type: 'object' }, task: 'capture',
    });
    expect(out).toEqual({ ok: 1 });
  });
});

describe('HostedStructuredLLM circuit breaker', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const call = (llm: HostedStructuredLLM) =>
    llm.callStructured({
      model: 'm', system: 's', user: 'u', toolName: 't', toolDescription: 'd',
      schema: { type: 'object' }, task: 'triage',
    });

  it('opens after N consecutive failures, then fails fast without hitting the network', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down' }) as any);
    vi.stubGlobal('fetch', fetchMock);
    // 1 attempt per call, breaker opens on the 2nd consecutive failure.
    process.env.POMEGRANATE_HOSTED_RETRIES = '0';
    process.env.POMEGRANATE_HOSTED_BREAKER_THRESHOLD = '2';
    process.env.POMEGRANATE_HOSTED_BREAKER_COOLDOWN_MS = '60000';
    const llm = new HostedStructuredLLM(toOpts());

    await expect(call(llm)).rejects.toThrow(/503/);
    await expect(call(llm)).rejects.toThrow(/503/); // hits the threshold → opens
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Open: the next call must fail instantly, before touching fetch.
    await expect(call(llm)).rejects.toThrow(/circuit open/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // unchanged — no network hit
  });

  it('a single success closes the breaker and clears the failure streak', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? ({ ok: false, status: 503, text: async () => 'x' } as any)
        : ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }] }) } as any);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.POMEGRANATE_HOSTED_RETRIES = '0';
    process.env.POMEGRANATE_HOSTED_BREAKER_THRESHOLD = '2';
    const llm = new HostedStructuredLLM(toOpts());

    await expect(call(llm)).rejects.toThrow(/503/); // streak = 1
    await expect(call(llm)).resolves.toEqual({ ok: 1 }); // success resets the streak
    // Streak cleared, so one more failure does NOT open the breaker (still hits fetch).
    n = 0;
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, text: async () => 'x' }) as any);
    await expect(call(llm)).rejects.toThrow(/503/);
    await expect(call(llm)).rejects.toThrow(/503/); // reaches fetch, not "circuit open"
  });

  it('does not retry client errors or open the breaker for them', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad request' }) as any);
    vi.stubGlobal('fetch', fetchMock);
    process.env.POMEGRANATE_HOSTED_RETRIES = '2';
    process.env.POMEGRANATE_HOSTED_BREAKER_THRESHOLD = '2';
    const llm = new HostedStructuredLLM(toOpts());
    for (let i = 0; i < 3; i++) await expect(call(llm)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function toOpts() {
  return {
    baseUrl: HOSTED_ENV.POMEGRANATE_HOSTED_BASE_URL,
    apiKey: HOSTED_ENV.POMEGRANATE_HOSTED_API_KEY,
    model: HOSTED_ENV.POMEGRANATE_HOSTED_MODEL,
  };
}
