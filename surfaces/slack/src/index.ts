/**
 * Bootstrap the Pomegranate Slack bot. Top-level await is fine under ESM.
 */
import 'dotenv/config';
import { createSlackApp } from './app.js';
import { SurfaceError } from './errors.js';

try {
  const app = await createSlackApp();
  const port = Number(process.env.PORT ?? 3001);
  if (process.env.SLACK_MODE === 'socket') {
    await app.start();
  } else {
    await app.start(port);
  }
  const where =
    process.env.SLACK_MODE === 'socket' ? 'socket mode' : `http mode on :${port}`;
  console.log(`⚡ Pomegranate Slack bot running (${where})`);
} catch (err) {
  if (err instanceof SurfaceError) {
    // Friendly operator-facing boot failures (bad/missing config, missing tokens).
    console.error(`\n[boot failed] ${err.userMessage}\n  detail: ${err.message}\n`);
  } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    const path = (err as NodeJS.ErrnoException).path ?? 'config/mapping.json';
    console.error(
      `\n[boot failed] Mapping file not found: ${path}\n` +
        '  Copy config/mapping.example.json to config/mapping.json (or set ' +
        'POMEGRANATE_SLACK_CONFIG) and fill in your team + users.\n',
    );
  } else {
    console.error('\n[boot failed]', err, '\n');
  }
  process.exit(1);
}
