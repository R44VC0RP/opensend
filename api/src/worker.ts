import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { app } from './app.js';
import { loadConfig } from './config.js';
import { r2Storage } from './adapters/storage.js';
import { dispatchPartitions, drainJobs } from './dispatch.js';
import { followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY } from './jobs.js';
import { cleanup } from './maintenance.js';
import { checkReputationAlerts } from './reputation-alerts.js';
import { reconcileSharedConnections } from './provider-connections.js';
import { mailboxHourly } from './mailbox-ingest.js';
import { syncOutboundMessages } from './mailbox-send.js';
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

// A provider group fits on one shard. Spread small sends across the pool without waking idle siblings.
let nextShard: number | undefined;
async function wakeDispatchers(env: Env, region: string, accountId?: string, emails?: number, kind?: 'shared' | 'byo') {
  const count = kind === 'byo' ? 1 : shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  nextShard ??= Math.floor(Math.random() * 0x100000000);
  const indexes = emails !== undefined && emails <= 6 ? [nextShard++ % count] : Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(index => {
    const identity = { accountId, region, shard: { index, count } };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(region)}&shard=${index}&count=${count}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}`);
  }));
}

// Optional Worker variable, default two active jobs; six matches the platform's
// simultaneous outbound-connection ceiling while the shared SES gate limits rate.
const workerConcurrency = (env: Env) => jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
const queueName = (env: Env, key: 'FEEDBACK_QUEUE_NAME' | 'WORK_QUEUE_NAME', fallback: string) => {
  const value: unknown = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : fallback;
};
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, max = 1, ctx?: ExecutionContext): Promise<T> {
  const config = loadConfig({ ...env });
  // A request-local lazy pool opens no connection for health, OpenAPI or missing-auth responses.
  const client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max });
  const nudges: ((runtime: Runtime) => Promise<void>)[] = [];
  try {
    const db = drizzle(client);
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, deferNudge: ctx ? pending => { nudges.push(pending); } : undefined, wake: async (readyJobs = 1) => {
      // A bounded burst advertises newly committed work to Queues autoscaling.
      // These are hints, not email jobs; Postgres still owns every claim.
      const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / workerConcurrency(env))));
      if (count === 1) {
        // Compute conflict expiry under its row lock, not from an earlier EXCLUDED timestamp.
        const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
          VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + interval '1 second')
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
              WHERE workspace_id = ${WAKE_SCHEDULE_KEY} AND wake_not_before = ${fence}::timestamptz`);
          } catch { /* Preserve the original send error; the window also expires on its own. */ }
          throw error;
        }
      } else {
        await env.WAKE_QUEUE.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
      }
      log('info', { code: 'QUEUE_WAKE', readyJobs, messages: count });
    }, dispatch: (...args) => wakeDispatchers(env, ...args), feedback: feedbackSink(env.FEEDBACK_QUEUE), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally {
    await client.end();
    // A dispatch-only nudge opens no connection. A queue reservation uses its own lazy connection.
    if (ctx && nudges.length) ctx.waitUntil(withRuntime(env, async runtime => { for (const nudge of nudges) await nudge(runtime); }));
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.method === 'GET' || request.method === 'HEAD') { url.protocol = 'https:'; return secureResponse(Response.redirect(url.toString(), 301)); }
      return secureResponse(Response.json({ error: { code: 'HTTPS_REQUIRED', message: 'Use HTTPS.', retryable: false } }, { status: 403, headers: { 'cache-control': 'no-store' } }));
    }
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
      }, 1, ctx);
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
    // Queue names differ per installation (wrangler config); an unrecognized queue is retried, never acknowledged as a wake.
    if (batch.queue === queueName(env, 'FEEDBACK_QUEUE_NAME', 'opensend-feedback')) {
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const outcomes = await ingestFeedbackBatch(runtime, messages.map(message => message.body));
        for (const [index, message] of messages.entries()) outcomes[index]?.ok ? message.ack() : message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
        log('info', { code: 'FEEDBACK_BATCH', size: messages.length, failed: outcomes.filter(outcome => !outcome.ok).length });
      });
      return;
    }
    if (batch.queue !== queueName(env, 'WORK_QUEUE_NAME', 'opensend-work')) {
      log('error', { code: 'UNKNOWN_QUEUE', queue: batch.queue });
      batch.retryAll();
      return;
    }
    await withRuntime(env, async runtime => {
      const concurrency = workerConcurrency(env);
      // Orchestration only (mail is dispatched by Durable Objects): a longer budget lets a campaign's
      // prepare → expand → finish chain run inside one invocation instead of one queue hop per step.
      // Wait in place up to 45 s for a job due soon (paced campaign releases), and schedule at most one follow-up.
      const outcome = await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }), 45000);
      log('info', { code: 'QUEUE_FOLLOW', outcome });
    }, workerConcurrency(env));
    batch.ackAll();
  },
  async scheduled(controller, env) {
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') {
        await cleanup(runtime);
        // Alerts are best-effort and must not stop the minute recovery work below.
        try { await checkReputationAlerts(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'REPUTATION_ALERT_CHECK_FAILED' }); }
        await mailboxHourly(await resolveRegionRuntime(runtime));
      }
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      // Mailbox outbound status and Message-IDs follow the sending pipeline; best-effort.
      if (controller.cron !== '* * * * *') return;
      try { await syncOutboundMessages(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
      await Promise.allSettled((await dispatchPartitions(runtime, true)).map(({ region, accountId, kind }) => wakeDispatchers(env, region, accountId, undefined, kind)));
      const concurrency = workerConcurrency(env);
      // Minute cron: recover orchestration jobs whose wake was coalesced or lost.
      await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }));
      await reconcileSharedConnections(runtime);
    }, workerConcurrency(env));
  },
} satisfies ExportedHandler<Env>;
