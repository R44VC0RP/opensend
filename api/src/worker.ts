import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { app } from './app.js';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { drainJobs } from './dispatch.js';
import { jobConcurrency, nextWakeDelay } from './jobs.js';
import { cleanup } from './maintenance.js';
import { admissionDenied, ApiError, digest, log, publicFailureAllowed, publicFailureBucket, publicFailureDenied, secureResponse } from './core.js';
import type { Runtime } from './core.js';
import { browserImageRenderer } from './adapters/browser-rendering.js';
import { publicImageImporter } from './adapters/public-image.js';
import { dispatcherName, shardCount } from './dispatcher-do.js';
import { resolveRegionRuntime } from './ses-region-state.js';
import type { FeedbackItem, Mode } from './core.js';
import { ingestFeedbackBatch } from './operations.js';
import { feedbackSink } from './adapters/feedback-queue.js';
export { DispatcherShard } from './dispatcher-do.js';

// Nudges every shard for one environment/region. Objects are created near the database on first use.
async function wakeDispatchers(env: Env, environment: Mode, region: string) {
  const count = shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  await Promise.all(Array.from({ length: count }, (_, index) => {
    const identity = { environment, region, shard: { index, count } };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?environment=${environment}&region=${encodeURIComponent(region)}&shard=${index}&count=${count}`);
  }));
}

// Optional Worker variable, default two active jobs; six matches the platform's
// simultaneous outbound-connection ceiling while the shared SES gate limits rate.
const workerConcurrency = (env: Env) => jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>): Promise<T> {
  const config = loadConfig({ ...env });
  // A request-local lazy pool opens no connection for health, OpenAPI or missing-auth responses.
  const client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max: workerConcurrency(env) });
  try {
    const db = drizzle(client);
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, wake: async (readyJobs = 1) => {
      // A bounded burst advertises newly committed work to Queues autoscaling.
      // These are hints, not email jobs; Postgres still owns every claim.
      const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / workerConcurrency(env))));
      if (count === 1) {
        // Compute conflict expiry under its row lock, not from an earlier EXCLUDED timestamp.
        const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
          VALUES (${config.workspaceId}, clock_timestamp() + interval '1 second')
          ON CONFLICT (workspace_id) DO UPDATE SET wake_not_before = clock_timestamp() + interval '1 second'
          WHERE job_schedule.wake_not_before IS NULL OR job_schedule.wake_not_before <= clock_timestamp()
          RETURNING wake_not_before::text`);
        const fence = reserved.rows[0]?.wake_not_before;
        if (!fence) {
          log('info', { code: 'QUEUE_WAKE_COALESCED', readyJobs });
          return;
        }
        try {
          // Delay past the window so the signal cannot be consumed before later coalesced job commits.
          await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds: 1 });
        } catch (error) {
          // Keep the exact database timestamp: an older failed send must not clear a newer reservation.
          try {
            await db.execute(sql`UPDATE job_schedule SET wake_not_before = NULL
              WHERE workspace_id = ${config.workspaceId} AND wake_not_before = ${fence}::timestamptz`);
          } catch { /* Preserve the original send error; the window also expires on its own. */ }
          throw error;
        }
      } else {
        await env.WAKE_QUEUE.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
      }
      log('info', { code: 'QUEUE_WAKE', readyJobs, messages: count });
    }, dispatch: (environment, region) => wakeDispatchers(env, environment, region), feedback: feedbackSink(env.FEEDBACK_QUEUE), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally { await client.end(); }
}
export default {
  async fetch(request, env) {
    try {
      const admissionStarted = performance.now();
      const address = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';
      const peer = await digest(address);
      // SNS publishes from a small IP pool at the full send rate; its requests are authenticated by
      // signature verification in the handler, so the per-address admission gate does not apply.
      const feedbackIngress = new URL(request.url).pathname === '/v1/events/ses' && request.method === 'POST';
      const gate = feedbackIngress ? { success: true } : await env.ADMISSION.limit({ key: `opensend:default:${peer}` });
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
  // Queue/scheduled continuations bypass coalescing to preserve active worker chains and future due times.
  async queue(batch, env) {
    if (batch.queue === 'opensend-feedback') {
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const outcomes = await ingestFeedbackBatch(await resolveRegionRuntime(runtime), messages.map(message => message.body));
        for (const [index, message] of messages.entries()) outcomes[index]?.ok ? message.ack() : message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
        log('info', { code: 'FEEDBACK_BATCH', size: messages.length, failed: outcomes.filter(outcome => !outcome.ok).length });
      });
      return;
    }
    await withRuntime(env, async runtime => {
      const concurrency = workerConcurrency(env);
      // Return frequently so Queues can reassess concurrency. Already claimed
      // jobs finish normally; the budget never interrupts a provider attempt.
      await drainJobs(runtime, 100, concurrency, 2000);
      const delaySeconds = await nextWakeDelay(runtime);
      if (delaySeconds !== null) await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds });
    });
    batch.ackAll();
  },
  async scheduled(controller, env) {
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') await cleanup(runtime);
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      const resolved = await resolveRegionRuntime(runtime);
      await Promise.allSettled(resolved.config.regions.flatMap(region => (['live', 'test'] as const).map(environment => wakeDispatchers(env, environment, region))));
      const concurrency = workerConcurrency(env);
      // Return frequently so Queues can reassess concurrency. Already claimed
      // jobs finish normally; the budget never interrupts a provider attempt.
      await drainJobs(runtime, 100, concurrency, 2000);
      const delaySeconds = await nextWakeDelay(runtime);
      if (delaySeconds !== null) await env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds });
    });
  },
} satisfies ExportedHandler<Env>;
