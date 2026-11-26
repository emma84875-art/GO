// Entry point. Reads the environment, validates it and starts the search service.
// Run with: node apps/search/src/main.ts (Node 22.6+ runs TypeScript directly).

import { ConfigError, loadConfig } from './config.ts';
import { createSearchServer } from './app.ts';
import { logEvent } from './logger.ts';

function start(): void {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // Only the message is logged. ConfigError messages name a variable and never its value.
    const message = error instanceof ConfigError ? error.message : 'Configuration could not be read';
    logEvent({ event: 'config_error' });
    process.stderr.write(`go-search: ${message}\n`);
    process.exit(1);
  }

  const server = createSearchServer(config);
  server.listen(config.port, () => {
    logEvent({
      event: 'started',
      port: config.port,
      supplier: config.supplier.kind,
      credentialsConfigured: config.supplier.kind === 'duffel' && config.supplier.accessToken !== undefined,
    });
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    // A stuck connection must not hold the process open during a Render restart.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
