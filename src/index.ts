import { log } from './util/logger.js';
import { startServer } from './server.js';

/**
 * Service entrypoint.
 *
 * Phase 2: starts the Fastify webhook ingress.
 * Phase 4 will also start the scheduler/worker loop here.
 */
async function main() {
  log.info('monday-automation-service starting.');
  await startServer();
}

main().catch((err) => {
  log.error('Fatal error during startup', err);
  process.exitCode = 1;
});
