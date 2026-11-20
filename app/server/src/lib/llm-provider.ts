/**
 * Structured-LLM provider selection for the cloud bootstrap.
 *
 * The default is a Together AI OpenAI-compatible endpoint. Installing the override
 * reroutes every structured call and flips the engine's `usingLocalLLM()` gate
 * so the curation agent takes its non-tool-use loop. Opt back into Anthropic
 * tool-use with POMEGRANATE_LLM_PROVIDER=anthropic.
 *
 *   POMEGRANATE_LLM_PROVIDER=together    (default) — Together AI endpoint
 *   POMEGRANATE_LLM_PROVIDER=hosted      — other OpenAI-compatible endpoints
 *                                          (HostedStructuredLLM; see hosted-llm.ts
 *                                          for POMEGRANATE_HOSTED_* config)
 *   POMEGRANATE_LLM_PROVIDER=anthropic   — Anthropic tool-use
 *
 * With either hosted provider, boot HARD-FAILS if POMEGRANATE_HOSTED_* isn't
 * configured (the HostedStructuredLLM constructor throws) — deliberate, so a
 * misconfigured deploy never silently falls back to a different model.
 *
 * Call once at boot, before serving requests.
 */
import { setStructuredLLM } from './anthropic.js';
import { HostedStructuredLLM } from './hosted-llm.js';
import { log } from './log.js';

/**
 * Install the structured-LLM provider from env. Returns the active provider's
 * label ('anthropic', 'together:<model>', or 'hosted:<model>') for boot logging.
 * Throws if the selected endpoint isn't configured —
 * failing loudly at boot beats silently falling back to Anthropic.
 */
export function configureLlmProvider(): string {
  const provider = (process.env.POMEGRANATE_LLM_PROVIDER ?? 'together').toLowerCase();
  if (provider === 'anthropic') {
    // Opt-out: Anthropic tool-use. Ensure no stale override is installed (e.g. in tests).
    setStructuredLLM(null);
    log.info('llm.provider', { provider: 'anthropic' });
    return 'anthropic';
  }
  if (provider !== 'together' && provider !== 'hosted') {
    throw new Error(`Unsupported POMEGRANATE_LLM_PROVIDER: ${provider}`);
  }
  // OpenAI-compatible endpoint. We run Qwen without
  // reasoning, so suppress the <think> trace unless explicitly re-enabled.
  process.env.POMEGRANATE_LLM_THINKING ??= '0';
  const llm = new HostedStructuredLLM();
  setStructuredLLM(llm);
  const label = `${provider}:${process.env.POMEGRANATE_HOSTED_MODEL}`;
  log.info('llm.provider', { provider: label });
  return label;
}
