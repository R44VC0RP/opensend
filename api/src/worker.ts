import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { app } from './app.js';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { drain } from './dispatch.js';
import { jobConcurrency, nextWakeDelay } from './jobs.js';
import { cleanup } from './maintenance.js';
import { admissionDenied, ApiError, digest, log, publicFailureAllowed, publicFailureBucket, publicFailureDenied, secureResponse } from './core.js';
import type { Runtime } from './core.js';
import { browserImageRenderer } from './adapters/browser-rendering.js';
import { publicImageImporter } from './adapters/public-image.js';

// Optional Worker variable, default two active jobs; a four-job cap leaves room for control-plane requests.
const workerConcurrency = (env: Env) => jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 4);
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>): Promise<T> {
  const config = loadConfig({ ...env });
  // A request-local lazy pool opens no connection for health, OpenAPI or missing-auth responses.
  const client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: workerConcurrency(env) });
  try {
    return await work({ db: drizzle(client), storage: r2Storage(env.ATTACHMENTS), config, wake: async (readyJobs = 1) => {
      // A bounded burst advertises newly committed work to Queues autoscaling.
      // These are hints, not email jobs; Postgres still owns every claim.
      const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / workerConcurrency(env))));
      await env.WAKE_QUEUE.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
      log('info', { code: 'QUEUE_WAKE', readyJobs, messages: count });
    }, renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
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
      const response = await withRuntime(env, async runtime => {
        const result = await app.fetch(new Request(request, { headers }), runtime);
        const failureBucket = publicFailureBucket(new URL(request.url).pathname, result.status);
        return failureBucket && !await publicFailureAllowed(runtime, failureBucket, peer) ? publicFailureDenied() : result;
      });
      const runtimeMs = performance.now() - runtimeStarted;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      responseHeaders.set('server-timing', [...(innerTiming ? [innerTiming] : []), `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      return secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders }));
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const code = error instanceof ApiError ? error.code : 'RUNTIME_UNAVAILABLE';
      log('error', { requestId, code, message: error instanceof ApiError ? error.message : 'Unable to initialize Worker database/runtime.' });
      return secureResponse(Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }));
    }
  },
  async queue(batch, env) {
    await withRuntime(env, async runtime => {
      const concurrency = workerConcurrency(env);
      // Return frequently so Queues can reassess concurrency. Already claimed
      // jobs finish normally; the budget never interrupts a provider attempt.
      await drain(runtime, 100, concurrency, 2000);
      const delaySeconds = await nextWakeDelay(runtime);
      if (delaySeconds !== null) await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds });
    });
    batch.ackAll();
  },
  async scheduled(controller, env) {
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') await cleanup(runtime);
      const concurrency = workerConcurrency(env);
      // Return frequently so Queues can reassess concurrency. Already claimed
      // jobs finish normally; the budget never interrupts a provider attempt.
      await drain(runtime, 100, concurrency, 2000);
      const delaySeconds = await nextWakeDelay(runtime);
      if (delaySeconds !== null) await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds });
    });
  },
} satisfies ExportedHandler<Env>;
