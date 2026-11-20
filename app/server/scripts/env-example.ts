/**
 * Render app/server/.env.example from ENV_SCHEMA (src/platform/config.ts).
 *
 *   npm run env:example          # rewrite .env.example
 *
 * env-example.test.ts renders the same text and fails when the committed
 * file has drifted from the registry.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { renderEnvExample } from '../src/platform/env-example.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.example');
writeFileSync(out, renderEnvExample());
console.log(`wrote ${out}`);
