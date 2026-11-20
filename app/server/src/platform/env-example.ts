// Renders .env.example from ENV_SCHEMA so the documented variables can never
// drift from the ones the server reads. Test-only variables are left out.

import { ENV_SCHEMA, type EnvGroup } from './config.js';

const GROUP_TITLES: Record<EnvGroup, string> = {
  runtime: 'Runtime',
  flags: 'Drivers and feature flags',
  llm: 'LLM',
  'hosted-llm': 'Hosted LLM (POMEGRANATE_LLM_PROVIDER=together or hosted)',
  embeddings: 'Embeddings',
  speech: 'Speech-to-text (audio from WhatsApp and uploads)',
  storage: 'Media storage (S3-compatible, optional)',
  logging: 'Logging',
  auth: 'Sign-in and sign-up',
  mail: 'Mail (sign-in links, invites, password resets)',
  surfaces: 'Slack and WhatsApp bots',
  schedulers: 'Schedulers',
  retrieval: 'Retrieval tuning',
  connectors: 'App connectors (Composio)',
  phase0: 'Phase 0 CLI',
  test: 'Test only',
};

// The few values a first local run needs, shown uncommented.
const QUICKSTART: Record<string, string> = {
  PORT: '3000',
  PUBLIC_ORIGIN: 'http://localhost:3000',
  PUBLIC_APP_URL: 'http://localhost:5173',
  POMEGRANATE_LLM_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: '',
};

export function renderEnvExample(): string {
  const lines: string[] = [
    '# Pomegranate server configuration. Copy to .env and fill in what you need.',
    '# Generated from src/platform/config.ts by `npm run env:example` — edit that',
    '# file, not this one.',
    '#',
    '# A first local run needs only the uncommented lines below: an LLM provider',
    '# and its key. Everything else has a working default. Sign-up is closed by',
    '# default: create the first admin with `npm run create-admin -- --email you@example.com`.',
    '',
  ];
  const groups: EnvGroup[] = [];
  for (const v of ENV_SCHEMA) if (v.group !== 'test' && !groups.includes(v.group)) groups.push(v.group);
  for (const g of groups) {
    lines.push(`# ── ${GROUP_TITLES[g]} ${'─'.repeat(Math.max(4, 70 - GROUP_TITLES[g].length))}`);
    for (const v of ENV_SCHEMA.filter((x) => x.group === g)) {
      const bits = [
        v.note,
        v.required === 'yes' ? 'required' : undefined,
        v.secret ? 'secret' : undefined,
        v.default !== undefined && v.default !== '' ? `default: ${v.default}` : undefined,
      ].filter(Boolean);
      if (bits.length) lines.push(`# ${bits.join(' · ')}`);
      if (v.name in QUICKSTART) lines.push(`${v.name}=${QUICKSTART[v.name]}`);
      else lines.push(`# ${v.name}=${v.default ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
