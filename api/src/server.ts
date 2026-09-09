import { serve } from '@hono/node-server';
import { app } from './app.js';
import { nodeRuntime } from './adapters/node.js';
import { admissionDenied, ApiError, log } from './core.js';

try {
  const { runtime, close } = nodeRuntime(process.env);
  // Coarse per-process admission guard; trusted proxy/WAF controls remain necessary for distributed abuse.
  const peers = new Map<string, number>(); let minute = Math.floor(Date.now() / 60000);
  const server = serve({ fetch: (request, connection) => {
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) { peers.clear(); minute = current; }
    const address = connection.incoming.socket.remoteAddress ?? 'unknown';
    const key = peers.has(address) || peers.size < 1024 ? address : 'overflow';
    const count = (peers.get(key) ?? 0) + 1; peers.set(key, count);
    if (count > 6000) return admissionDenied();
    return app.fetch(request, runtime);
  }, port: Number(process.env.PORT ?? 8787), hostname: process.env.HOST ?? '0.0.0.0' }, info => {
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
