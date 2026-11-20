import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { renderEnvExample } from './env-example.js';

describe('.env.example', () => {
  it('matches ENV_SCHEMA (run `npm run env:example` after adding a variable)', () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env.example');
    expect(readFileSync(file, 'utf8')).toBe(renderEnvExample());
  });
});
