/**
 * Bootstrap the Pomegranate WhatsApp bot. Top-level await is fine under ESM.
 */
import 'dotenv/config';
import { loadConfig } from './config.js';
import { WasenderClient } from './wasender-client.js';
import { SurfaceAgentClient } from './surface-client.js';
import { createRelayHandler } from './relay.js';
import { createWhatsappServer } from './server.js';
import { SurfaceError } from './errors.js';
import { logEvent } from './log.js';

try {
  const config = loadConfig();

  const wasender = new WasenderClient(config.wasenderApiBaseUrl, config.wasenderApiToken);
  const surface = new SurfaceAgentClient(config.pomegranateApiUrl, config.surfaceAgentSecret);
  const onMessage = createRelayHandler({ surface, wasender });

  const server = createWhatsappServer({ webhookSecret: config.wasenderWebhookSecret, onMessage });
  server.listen(config.port, () => {
    logEvent('info', 'whatsapp_boot', {
      port: config.port,
      mediaProcessing: 'server',
    });
    console.log(`⚡ Pomegranate WhatsApp bot running on :${config.port} (POST /webhook)`);
    console.log('   Media processing uses Pomegranate data agents');
  });
} catch (err) {
  if (err instanceof SurfaceError) {
    console.error(`\n[boot failed] ${err.userMessage}\n  detail: ${err.message}\n`);
  } else {
    console.error('\n[boot failed]', err, '\n');
  }
  process.exit(1);
}
