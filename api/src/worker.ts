import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { app } from './app.js';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { drain } from './dispatch.js';
import { cleanup } from './maintenance.js';
import { ApiError, log } from './core.js';
import type { Runtime } from './core.js';

async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>): Promise<T> {
  const config = loadConfig({ ...env });
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    return await work({ db: drizzle(client), storage: r2Storage(env.ATTACHMENTS), config, wake: async () => { await env.WAKE_QUEUE.send({ kind: 'wake' }); } });
  } finally { await client.end(); }
}
export default {
  async fetch(request, env) {
    try { return await withRuntime(env, async runtime => app.fetch(request, runtime)); }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const code = error instanceof ApiError ? error.code : 'RUNTIME_UNAVAILABLE';
      log('error', { requestId, code, message: error instanceof ApiError ? error.message : 'Unable to initialize Worker database/runtime.' });
      return Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } });
    }
  },
  async queue(batch, env) {
    await withRuntime(env, async runtime => {
      const count = await drain(runtime);
      if (count === 1) await runtime.wake?.();
    });
    batch.ackAll();
  },
  async scheduled(controller, env) {
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') await cleanup(runtime);
      const count = await drain(runtime);
      if (count === 1) await runtime.wake?.();
    });
  },
} satisfies ExportedHandler<Env>;
