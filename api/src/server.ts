import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';
import { nodeRuntime } from './adapters/node.js';
import { admissionDenied, ApiError, log, publicFailureBucket, publicFailureDenied } from './core.js';

try {
  const { runtime, close } = nodeRuntime(process.env);
  const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
  const assets = serveStatic({ root: publicRoot });
  const dashboard = serveStatic({ path: `${publicRoot}index.html` });
  app.use('*', async (c, next) => {
    // API failures must remain JSON, never an apparently successful SPA response.
    if (!['GET', 'HEAD'].includes(c.req.method) || /^\/(?:v1|api|mcp|\.well-known|unsubscribe)(?:\/|$)/.test(c.req.path) || ['/health', '/openapi.json'].includes(c.req.path)) return next();
    return assets(c, async () => {
      const response = await dashboard(c, next);
      if (response) c.res = response;
    });
  });
  // Coarse per-process admission guard; trusted proxy/WAF controls remain necessary for distributed abuse.
  const peers = new Map<string, number>(); const publicFailures = new Map<string, number>(); let minute = Math.floor(Date.now() / 60000);
  const server = serve({ fetch: async (request, connection) => {
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) { peers.clear(); publicFailures.clear(); minute = current; }
    const address = connection.incoming.socket.remoteAddress ?? 'unknown';
    const key = peers.has(address) || peers.size < 1024 ? address : 'overflow';
    const count = (peers.get(key) ?? 0) + 1; peers.set(key, count);
    if (count > 6000) return admissionDenied();
    const headers = new Headers(request.headers);
    headers.set('x-opensend-client-ip', address);
    const response = await app.fetch(new Request(request, { headers }), runtime);
    const bucket = publicFailureBucket(new URL(request.url).pathname, response.status);
    if (bucket) {
      const failureKey = `${bucket}:${key}`;
      const failures = (publicFailures.get(failureKey) ?? 0) + 1;
      publicFailures.set(failureKey, failures);
      if (failures > 40) return publicFailureDenied();
    }
    return response;
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
