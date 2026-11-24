import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// E2E config — boots a fresh API server on :3000 (Anthropic provider, isolated
// SQLite + files dir) and the Vite dev server on :5173 (which proxies /api to
// :3000). Each spec gets a clean DB because PLAYWRIGHT_DATA_DIR is unique per
// run. ANTHROPIC_API_KEY is inherited from the calling shell (Playwright
// merges webServer.env onto process.env).
const DATA_DIR = path.join(
  '/tmp',
  `pom-pw-${process.env.PLAYWRIGHT_RUN_ID ?? Date.now()}`,
);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `npx tsx src/phase1/api/server.ts`,
      cwd: path.resolve(__dirname, '../server'),
      url: 'http://localhost:3000/healthz',
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        POMEGRANATE_DB_PATH: path.join(DATA_DIR, 'p.db'),
        POMEGRANATE_FILES_DIR: path.join(DATA_DIR, 'files'),
        PORT: '3000',
        SIGNUP_MODE: 'open',
        POMEGRANATE_DEV_INLINE_CODES: '1',
        POMEGRANATE_LLM_PROVIDER: 'anthropic',
        // Every spec signs in from the same IP (localhost), a few seconds
        // apart: the default auth limit (burst 20, one back per 3s) is sized
        // for real users and 429s a full run. The limiter has its own unit
        // tests (auth-hardening.test.ts).
        POMEGRANATE_AUTH_RL_CAPACITY: '500',
      },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
