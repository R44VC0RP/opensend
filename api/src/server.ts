import { serve } from '@hono/node-server';
import { app } from './app.js';
import { nodeRuntime } from './adapters/node.js';
import { ApiError, log } from './core.js';

try {
  const { runtime, close } = nodeRuntime(process.env);
  const server = serve({ fetch: request => app.fetch(request, runtime), port: Number(process.env.PORT ?? 8787), hostname: process.env.HOST ?? '0.0.0.0' }, info => {
    log('info', { code: 'API_READY', port: info.port, liveSesEnabled: runtime.config.liveEnabled });
  });
  server.on('error', error => {
    log('error', { code: 'LISTEN_FAILED', message: 'Unable to bind the API port. Check PORT and HOST.', errorType: error.name });
    void close().then(() => { process.exitCode = 1; });
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return; stopping = true;
    server.close(() => { void close().then(() => process.exit(0)); });
  });
} catch (error) {
  log('error', { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED', message: error instanceof ApiError ? error.message : 'API startup failed; check deployment configuration.' });
  process.exitCode = 1;
}
