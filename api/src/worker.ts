import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { app } from './app.js';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { queueCrmSync } from './audience-sync.js';
import { drain } from './dispatch.js';
import { cleanup } from './maintenance.js';
import { admissionDenied, ApiError, digest, log } from './core.js';
import type { Runtime } from './core.js';

async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, background = false): Promise<T> {
  const config = loadConfig({ ...env });
  // A request-local lazy pool opens no connection for health, OpenAPI or missing-auth responses.
  const client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: background ? Math.min(config.workerConcurrency ?? 8, 8) : 2 });
  try {
    return await work({ db: drizzle(client), storage: r2Storage(env.ATTACHMENTS), config, wake: async () => { await env.WAKE_QUEUE.send({ kind: 'wake' }); } });
  } finally { await client.end(); }
}
export default {
  async fetch(request, env) {
    try {
      const admissionStarted = performance.now();
      const address = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';
      const peer = await digest(address);
      const gate = await env.ADMISSION.limit({ key: `opensend:default:${peer}` });
      if (!gate.success) return admissionDenied();
      const admissionMs = performance.now() - admissionStarted;
      const headers = new Headers(request.headers);
      headers.set('x-opensend-client-ip', address);
      const runtimeStarted = performance.now();
      const response = await withRuntime(env, async runtime => app.fetch(new Request(request, { headers }), runtime));
      const runtimeMs = performance.now() - runtimeStarted;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      responseHeaders.set('server-timing', [...(innerTiming ? [innerTiming] : []), `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const code = error instanceof ApiError ? error.code : 'RUNTIME_UNAVAILABLE';
      log('error', { requestId, code, message: error instanceof ApiError ? error.message : 'Unable to initialize Worker database/runtime.' });
      return Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
    }
  },
  async queue(batch, env) {
    await withRuntime(env, async runtime => {
      const counts = await Promise.all(Array.from({length:runtime.config.workerConcurrency ?? 8},()=>drain(runtime)));
      if (counts.some(count=>count > 0)) await runtime.wake?.();
    }, true);
    batch.ackAll();
  },
  async scheduled(controller, env) {
    await withRuntime(env, async runtime => {
      await queueCrmSync(runtime);
      if (controller.cron === '7 * * * *') await cleanup(runtime);
      const counts = await Promise.all(Array.from({length:runtime.config.workerConcurrency ?? 8},()=>drain(runtime)));
      if (counts.some(count=>count > 0)) await runtime.wake?.();
    }, true);
  },
} satisfies ExportedHandler<Env>;
