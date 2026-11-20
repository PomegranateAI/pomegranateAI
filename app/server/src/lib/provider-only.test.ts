import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { setStructuredLLM, structuredCall } from './anthropic.js';

// With POMEGRANATE_PROVIDER_ONLY=1 a preferAnthropic task (wiki,
// reports) goes to the customer's chosen provider even when an Anthropic key
// is present — no silent hop to a provider (and region) they didn't pick.
const saved = { key: process.env.ANTHROPIC_API_KEY, only: process.env.POMEGRANATE_PROVIDER_ONLY };
afterEach(() => {
  setStructuredLLM(null);
  for (const [k, v] of [['ANTHROPIC_API_KEY', saved.key], ['POMEGRANATE_PROVIDER_ONLY', saved.only]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('provider-only routing', () => {
  it('keeps preferAnthropic tasks on the chosen provider', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-used';
    process.env.POMEGRANATE_PROVIDER_ONLY = '1';
    const calls: string[] = [];
    setStructuredLLM({
      name: 'mistral-test',
      async callStructured(o: any) {
        calls.push(o.toolName);
        return { ok: true };
      },
    } as any);
    const r = await structuredCall({
      model: 'm',
      system: 's',
      user: 'u',
      toolName: 'emit',
      toolDescription: 'd',
      schema: z.object({ ok: z.boolean() }),
      task: 'wiki-plan',
      preferAnthropic: true,
    } as any);
    expect(calls).toEqual(['emit']);
    expect(r.output).toEqual({ ok: true });
  });
});
