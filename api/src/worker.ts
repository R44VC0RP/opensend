import type { Config, FeedbackItem, Runtime } from './core.js';
import { DispatcherShard, dispatcherName, shardCount } from './dispatcher-do.js';
export { DispatcherShard };

// Keep top-level evaluation empty so cold-started isolates answer /health without
// loading OpenAPI/Zod schemas, Better Auth, MCP, Drizzle, pg or AWS SDK clients.
const FAST_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function fastSecure(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(FAST_SECURITY_HEADERS)) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function initHttpDeps() {
  return Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('drizzle-orm/sql'),
    import('./app.js'), import('./config.js'), import('./adapters/storage.js'),
    import('./jobs.js'), import('./core.js'),
    import('./adapters/browser-rendering.js'), import('./adapters/public-image.js'), import('./adapters/feedback-queue.js'),
  ]).then(([{ Pool }, { drizzle }, { sql }, { app }, { CONFIG_KEYS, loadConfig }, { r2Storage }, { followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY }, core, { browserImageRenderer }, { publicImageImporter }, { feedbackSink, settleFeedbackMessage }]) => ({
    Pool, drizzle, sql, app, CONFIG_KEYS, loadConfig, r2Storage, followDueJobs, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink, settleFeedbackMessage,
  }));
}
let httpDepsPromise: ReturnType<typeof initHttpDeps> | undefined;
function loadHttpDeps() {
  return httpDepsPromise ??= initHttpDeps().catch(error => { httpDepsPromise = undefined; throw error; });
}

// A provider group fits on one shard. Spread small sends across the pool without waking idle siblings.
let nextShard: number | undefined;
async function wakeDispatchers(env: Env, region: string, accountId?: string, emails?: number, kind?: 'shared' | 'byo', priority = false) {
  const count = kind === 'byo' ? 1 : shardCount('DISPATCH_SHARDS' in env ? env.DISPATCH_SHARDS : undefined);
  nextShard ??= Math.floor(Math.random() * 0x100000000);
  const indexes = emails !== undefined && emails <= 6 ? [nextShard++ % count] : Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(index => {
    const identity = { accountId, region, shard: { index, count } };
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName(dispatcherName(identity)), { locationHint: 'enam' });
    return stub.fetch(`https://dispatcher/wake?region=${encodeURIComponent(region)}&shard=${index}&count=${count}${accountId ? `&account=${encodeURIComponent(accountId)}` : ''}${priority ? '&priority=1' : ''}`);
  }));
}

let cachedConfig: { key: string; config: Config } | undefined;
function configFor(env: Env, keys: readonly string[], loadConfig: (input: Record<string, unknown>) => Config): Config {
  const input: Record<string, unknown> = {};
  const record = env as unknown as Record<string, unknown>;
  for (const name of keys) if (name in record) input[name] = record[name];
  const key = JSON.stringify(input);
  if (cachedConfig?.key === key) return { ...cachedConfig.config };
  const config = loadConfig(input);
  cachedConfig = { key, config };
  return { ...config };
}

const queueName = (env: Env, key: 'FEEDBACK_QUEUE_NAME' | 'WORK_QUEUE_NAME', fallback: string) => {
  const value: unknown = (env as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : fallback;
};
async function withRuntime<T>(env: Env, work: (runtime: Runtime) => Promise<T>, max = 1, ctx?: ExecutionContext): Promise<T> {
  const { Pool, drizzle, sql, CONFIG_KEYS, loadConfig, r2Storage, jobConcurrency, WAKE_SCHEDULE_KEY, core, browserImageRenderer, publicImageImporter, feedbackSink } = await loadHttpDeps();
  // Optional Worker variable, default two active jobs; six matches the platform's
  // simultaneous outbound-connection ceiling while the shared SES gate limits rate.
  const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
  const config = configFor(env, CONFIG_KEYS, loadConfig);
  // Defer Hyperdrive/Pool creation until a handler actually touches db: missing-auth,
  // validation and cached responses never allocate a pool or touch Hyperdrive.
  let client: InstanceType<typeof Pool> | undefined;
  let instance: Runtime['db'] | undefined;
  const getDb = () => {
    if (!instance) {
      client = new Pool({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 10000, max });
      client.on('error', () => { /* An idle reset surfaces on the next query; teardown ignores it. */ });
      instance = drizzle(client);
    }
    return instance;
  };
  const db = new Proxy({} as Runtime['db'], {
    get(_target, prop) {
      const target = getDb();
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const nudges: ((runtime: Runtime) => Promise<void>)[] = [];
  try {
    return await work({ db, storage: r2Storage(env.ATTACHMENTS), config, deferNudge: ctx ? pending => { nudges.push(pending); } : undefined, wake: async (readyJobs = 1) => {
      // A bounded burst advertises newly committed work to Queues autoscaling.
      // These are hints, not email jobs; Postgres still owns every claim.
      const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / concurrency)));
      if (count === 1) {
        // Compute conflict expiry under its row lock, not from an earlier EXCLUDED timestamp.
        const reserved = await db.execute<{ wake_not_before: string }>(sql`INSERT INTO job_schedule(workspace_id, wake_not_before)
          VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + interval '1 second')
          ON CONFLICT (workspace_id) DO UPDATE SET wake_not_before = clock_timestamp() + interval '1 second'
          WHERE job_schedule.wake_not_before IS NULL OR job_schedule.wake_not_before <= clock_timestamp()
          RETURNING wake_not_before::text`);
        const fence = reserved.rows[0]?.wake_not_before;
        if (!fence) {
          core.log('info', { code: 'QUEUE_WAKE_COALESCED', readyJobs });
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
      core.log('info', { code: 'QUEUE_WAKE', readyJobs, messages: count });
    }, dispatch: (...args) => wakeDispatchers(env, ...args), feedback: feedbackSink(env.FEEDBACK_QUEUE), renderHtmlImage: browserImageRenderer(env.BROWSER), importPublicImage: publicImageImporter() });
  } finally {
    if (client) {
      if (ctx) ctx.waitUntil(client.end().catch(() => {}));
      else await client.end();
    }
    // A dispatch-only nudge opens no connection. A queue reservation uses its own lazy connection.
    if (ctx && nudges.length) ctx.waitUntil(withRuntime(env, async runtime => { for (const nudge of nudges) await nudge(runtime); }));
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (request.method === 'GET' || request.method === 'HEAD') { url.protocol = 'https:'; return fastSecure(Response.redirect(url.toString(), 301)); }
      return fastSecure(Response.json({ error: { code: 'HTTPS_REQUIRED', message: 'Use HTTPS.', retryable: false } }, { status: 403, headers: { 'cache-control': 'no-store' } }));
    }
    if (url.pathname === '/health' && (request.method === 'GET' || request.method === 'HEAD') && !request.headers.has('X-OpenSend-Environment')) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const multiTenant = ('MULTI_TENANT' in env ? env.MULTI_TENANT : undefined) === 'true';
      const body = request.method === 'HEAD' ? null : JSON.stringify({ status: 'ok', service: 'opensend', multiTenant });
      return fastSecure(new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store', 'x-request-id': requestId, 'server-timing': 'runtime;dur=0.0' } }));
    }
    const staticDoc = (request.method === 'GET' || request.method === 'HEAD') && (['/openapi.json', '/docs.md', '/llms.txt'].includes(url.pathname) || url.pathname.startsWith('/docs/operations/'));
    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    if (assets && (request.method === 'GET' || request.method === 'HEAD') && !staticDoc && !/^\/(?:v1|api|mcp|\.well-known|unsubscribe)(?:\/|$)/.test(url.pathname) && url.pathname !== '/health') {
      return fastSecure(await assets.fetch(request));
    }
    let deps: Awaited<ReturnType<typeof loadHttpDeps>> | undefined;
    try {
      deps = await loadHttpDeps();
      const { app, core } = deps;
      const admissionStarted = performance.now();
      const address = request.headers.get('CF-Connecting-IP') ?? '127.0.0.1';
      const peer = await core.digest(address);
      // SNS publishes from a small IP pool at the full send rate; its requests are authenticated by
      // signature verification in the handler, so the per-address admission gate does not apply.
      const feedbackIngress = url.pathname === '/v1/events/ses' && request.method === 'POST';
      const gate = feedbackIngress ? { success: true } : await env.ADMISSION.limit({ key: `opensend:default:${peer}` });
      if (!gate.success) return core.admissionDenied();
      const admissionMs = performance.now() - admissionStarted;
      const headers = new Headers(request.headers);
      headers.set('x-opensend-client-ip', address);
      const runtimeStarted = performance.now();
      const response = staticDoc
        ? await app.fetch(new Request(request, { headers }), {} as Runtime)
        : await withRuntime(env, async runtime => {
          const result = await app.fetch(new Request(request, { headers }), runtime);
          const failureBucket = core.publicFailureBucket(url.pathname, result.status, request.headers);
          return failureBucket && !await core.publicFailureAllowed(runtime, failureBucket, peer) ? core.publicFailureDenied() : result;
        }, 1, ctx);
      const runtimeMs = performance.now() - runtimeStarted;
      const responseHeaders = new Headers(response.headers);
      const innerTiming = responseHeaders.get('server-timing');
      responseHeaders.set('server-timing', [...(innerTiming ? [innerTiming] : []), `admission;dur=${admissionMs.toFixed(1)}`, `runtime;dur=${runtimeMs.toFixed(1)}`].join(', '));
      core.log('info', { requestId: responseHeaders.get('x-request-id'), operation: 'worker-runtime', status: response.status, admissionMs: Number(admissionMs.toFixed(1)), runtimeMs: Number(runtimeMs.toFixed(1)) });
      return core.secureResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders }));
    }
    catch (error) {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      const known = deps && error instanceof deps.core.ApiError ? error : null;
      const code = known ? known.code : 'RUNTIME_UNAVAILABLE';
      console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), requestId, code, message: known ? known.message : 'Unable to initialize Worker database/runtime.' }));
      return fastSecure(Response.json({ error: { code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } }, { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } }));
    }
  },
  // Queue/scheduled continuations bypass coalescing to preserve active worker chains and future due times.
  async queue(batch, env) {
    const { jobConcurrency, followDueJobs, core, settleFeedbackMessage } = await loadHttpDeps();
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    // Queue names differ per installation (wrangler config); an unrecognized queue is retried, never acknowledged as a wake.
    if (batch.queue === queueName(env, 'FEEDBACK_QUEUE_NAME', 'opensend-feedback')) {
      const { ingestFeedbackBatch } = await import('./operations.js');
      // Each message is one verified callback; acknowledge and retry individually so one bad
      // payload never blocks a batch of routine deliveries.
      await withRuntime(env, async runtime => {
        const messages = batch.messages as readonly Message<FeedbackItem>[];
        const outcomes = await ingestFeedbackBatch(runtime, messages.map(message => message.body));
        for (const [index, message] of messages.entries()) settleFeedbackMessage(message, outcomes[index]);
        core.log('info', { code: 'FEEDBACK_BATCH', size: messages.length, failed: outcomes.filter(outcome => !outcome.ok).length });
      });
      return;
    }
    if (batch.queue !== queueName(env, 'WORK_QUEUE_NAME', 'opensend-work')) {
      core.log('error', { code: 'UNKNOWN_QUEUE', queue: batch.queue });
      batch.retryAll();
      return;
    }
    const { drainJobs } = await import('./dispatch.js');
    await withRuntime(env, async runtime => {
      // Orchestration only (mail is dispatched by Durable Objects): a longer budget lets a campaign's
      // prepare → expand → finish chain run inside one invocation instead of one queue hop per step.
      // Wait in place up to 45 s for a job due soon (paced campaign releases), and schedule at most one follow-up.
      const outcome = await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }), 45000);
      core.log('info', { code: 'QUEUE_FOLLOW', outcome });
    }, concurrency);
    batch.ackAll();
  },
  async scheduled(controller, env) {
    const [{ jobConcurrency, followDueJobs, core }, { dispatchPartitions, drainJobs }, { reconcileSharedConnections }, { syncOutboundMessages }] = await Promise.all([
      loadHttpDeps(), import('./dispatch.js'), import('./provider-connections.js'), import('./mailbox-send.js'),
    ]);
    const concurrency = jobConcurrency('JOB_CONCURRENCY' in env ? env.JOB_CONCURRENCY : undefined, 6);
    await withRuntime(env, async runtime => {
      if (controller.cron === '7 * * * *') {
        const [{ cleanup }, { checkReputationAlerts }, { mailboxHourly }, { resolveRegionRuntime }] = await Promise.all([
          import('./maintenance.js'), import('./reputation-alerts.js'), import('./mailbox-ingest.js'), import('./ses-region-state.js'),
        ]);
        await cleanup(runtime);
        // Alerts are best-effort and must not stop the minute recovery work below.
        try { await checkReputationAlerts(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'REPUTATION_ALERT_CHECK_FAILED' }); }
        await mailboxHourly(await resolveRegionRuntime(runtime));
      }
      // Minute ping: recovers dispatchers that missed a nudge and expired-lease or interrupted rows.
      // Mailbox outbound status and Message-IDs follow the sending pipeline; best-effort.
      if (controller.cron !== '* * * * *') return;
      try { await syncOutboundMessages(runtime); } catch (error) { core.log('warn', { code: error instanceof core.ApiError ? error.code : 'MAILBOX_OUTBOUND_SYNC_FAILED' }); }
      await Promise.allSettled((await dispatchPartitions(runtime, true)).map(({ region, accountId, kind }) => wakeDispatchers(env, region, accountId, undefined, kind)));
      // Minute cron: recover orchestration jobs whose wake was coalesced or lost.
      await followDueJobs(runtime, () => drainJobs(runtime, 100, concurrency, 10000), delaySeconds => env.WAKE_QUEUE.send({ kind: 'wake' }, { delaySeconds }));
      await reconcileSharedConnections(runtime);
    }, concurrency);
  },
} satisfies ExportedHandler<Env>;
