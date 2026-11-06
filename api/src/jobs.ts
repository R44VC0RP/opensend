import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApiError, id, log } from './core.js';
import type { ClaimedWebhook, DbExecutor, JobHandler, Runtime } from './core.js';
import { jobs } from './db/core.js';
import { resolveRegionRuntime } from './ses-region-state.js';
export const MAX_ATTEMPTS = 6;
// Wake messages drain the installation, not a tenant. Reuse the existing singleton reservation on upgrade.
export const WAKE_SCHEDULE_KEY = 'default';

// Keep regional settings and clients invocation-local. Concurrent lanes for one owner share the lookup,
// but never mutate the Node runner's installation config or reuse a different owner's settings.
export function workspaceRuntimes(runtime: Runtime) {
  const runtimes = new Map<string, Promise<Runtime>>();
  return (workspaceId: string) => {
    let resolved = runtimes.get(workspaceId);
    if (!resolved) {
      resolved = resolveRegionRuntime({ ...runtime, config: { ...runtime.config, workspaceId } }, { workspaceId });
      runtimes.set(workspaceId, resolved);
    }
    return resolved;
  };
}

// Counts enqueue() calls made while serving one request, so the response path wakes the queue only for new work.
const enqueued = new AsyncLocalStorage<{ count: number }>();
export async function countEnqueued(work: () => Promise<void>) {
  const scope = { count: 0 };
  await enqueued.run(scope, work);
  return scope.count;
}
export async function enqueue(db: DbExecutor, input: { type: string; workspaceId: string; payload: Record<string, unknown>; availableAt?: string }) {
  const jobId = id('job');
  await db.insert(jobs).values({ id: jobId, ...input });
  const scope = enqueued.getStore();
  if (scope) scope.count++;
  return jobId;
}
// Thrown by a handler that is polling (not failing): the runner returns the same row to pending at
// availableAt without consuming an attempt, instead of inserting a new job row per poll.
export class JobDeferred extends Error {
  constructor(readonly availableAt: string, readonly payload?: Record<string, unknown>) { super('Job deferred.'); }
}

export const retryDatabaseFailures = (handler: JobHandler): JobHandler => async (runtime, payload, job) => {
  try { await handler(runtime, payload, job); } catch (error) {
    if (error instanceof ApiError || error instanceof JobDeferred) throw error;
    throw new ApiError(503, 'OPERATION_TEMPORARILY_UNAVAILABLE', 'The background operation could not complete; it will be retried.', undefined, true);
  }
};

// Postgres is the durable queue. CF Queue messages only wake it; cron/polling recovers missed wakeups.
export function jobConcurrency(value: unknown, maximum = 8) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, maximum) : 2;
}
// Input comes only from the actual claimed rows, never a caller-supplied endpoint. Hold the
// endpoint lock until paused deliveries are parked, so a concurrent resume sees and requeues them.
export const webhookClaimCtes = sql`hook_inputs AS MATERIALIZED (
  SELECT j.id AS job_id,d.workspace_id,d.id AS delivery_id,d.generation,d.webhook_id,d.event_id,d.payload,d.synthetic,w.url,w.encrypted_secret,w.encrypted_headers,w.paused
  FROM claimed j JOIN operation_deliveries d ON d.workspace_id=j.workspace_id AND d.id=j.payload->>'deliveryId'
    AND to_jsonb(d.generation)=j.payload->'generation' AND d.status<>'delivered'
  LEFT JOIN LATERAL (SELECT url,encrypted_secret,encrypted_headers,paused FROM operation_webhooks WHERE workspace_id=d.workspace_id AND id=d.webhook_id FOR SHARE) w ON true
  WHERE j.type='operation.webhook'
), parked AS (UPDATE operation_deliveries d SET status=CASE WHEN h.url IS NULL THEN 'failed' ELSE 'paused' END,
  last_error=CASE WHEN h.url IS NULL THEN 'ENDPOINT_DELETED' ELSE 'ENDPOINT_PAUSED' END,updated_at=now()
  FROM hook_inputs h WHERE d.id=h.delivery_id AND d.workspace_id=h.workspace_id AND d.generation=h.generation AND (h.url IS NULL OR (h.paused AND NOT h.synthetic)))`;
const hookJoin = sql`LEFT JOIN hook_inputs h ON h.job_id=j.id AND h.url IS NOT NULL AND (NOT h.paused OR h.synthetic)`;
export const claimedWithWebhooks = sql`SELECT j.*,to_jsonb(h) AS webhook FROM claimed j ${hookJoin}`;
export async function processJobs(runtime: Runtime, handlers: Record<string, JobHandler>, limit = 1, concurrency = 1, maxDurationMs = 20000) {
  const started = Date.now(); let processed = 0, claims = 0, claimRequests = 0, activeJobs = 0, peakActiveJobs = 0;
  const effectiveConcurrency = jobConcurrency(concurrency);
  const laneJobs = Array<number>(effectiveConcurrency).fill(0);
  const freeLanes = new Set(laneJobs.map((_, index) => index));
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let activeFeedback = 0;
  // Hold each class preference for four claims so it cannot line up with alternating feedback reservations.
  const rotation = Math.floor(Math.random() * 8);
  const budgetMs = Math.min(20000, Math.max(1, maxDurationMs));
  const maximumClaims = Math.min(Math.max(1, limit), 100);
  const regionalRuntime = workspaceRuntimes(runtime);
  type Claimed = { id: string; workspace_id: string; type: string; payload: Record<string, unknown>; attempts: number; webhook: ClaimedWebhook | null };
  const handle = async (job: Claimed, index: number, claimMs: number, claimBatchSize: number) => {
    const jobStarted = Date.now();
    processed++; laneJobs[index]!++;
    peakActiveJobs = Math.max(peakActiveJobs, ++activeJobs);
    // A job row that is requeued under the same id (campaign runs) carries a fresh payload.run token; fencing on it keeps
    // a worker that still holds the retired run from completing or requeueing the row the new run now owns.
    const fence = and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempts), eq(jobs.status, 'running'), typeof job.payload.run === 'string' ? sql`${jobs.payload}->>'run' = ${job.payload.run}` : undefined);
    const context = { jobId: job.id, operation: job.type, attempt: job.attempts, workspaceId: job.workspace_id, requestId: typeof job.payload.requestId === 'string' ? job.payload.requestId : undefined };
    let records: SQL | undefined, settling = false;
    const settle = (update: SQLWrapper) => {
      settling = true;
      return runtime.db.execute(records ? sql`WITH settled AS (${update.getSQL()} RETURNING id), ${records} SELECT 1` : update.getSQL());
    };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new ApiError(500, 'JOB_HANDLER_MISSING', 'No handler is registered for this job type.');
      const ownerRuntime = job.type.startsWith('campaign.') || job.type.startsWith('ses.') || job.type === 'mailbox.reconcile' || job.type === 'operation.ses'
        ? await regionalRuntime(job.workspace_id) : { ...runtime, config: { ...runtime.config, workspaceId: job.workspace_id } };
      await handler(ownerRuntime, job.payload, { id: job.id, attempts: job.attempts, workspaceId: job.workspace_id,
        webhook: job.webhook, recordWithSettlement: ctes => { records = ctes; } });
      await settle(runtime.db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: null }).where(fence));
      log('info', { ...context, code: 'JOB_COMPLETED', claimMs, claimBatchSize, jobMs: Date.now() - jobStarted });
    } catch (error) {
      if (settling) throw error; // Outcome and job settle atomically. Let the durable lease recover a failed commit.
      if (error instanceof JobDeferred) {
        // The claim incremented attempts; undo it so intentional polling never reaches MAX_ATTEMPTS.
        await runtime.db.update(jobs).set({ status: 'pending', attempts: sql`${jobs.attempts} - 1`, leaseUntil: null, lastError: null, availableAt: error.availableAt, ...(error.payload ? { payload: error.payload } : {}) }).where(fence);
        log('info', { ...context, code: 'JOB_DEFERRED', availableAt: error.availableAt, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted });
        return;
      }
      const code = error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR';
      // Domain failure-state persistence must eventually commit; stopping at the
      // ordinary attempt ceiling would strand a campaign in pending forever.
      const retry = error instanceof ApiError && error.retryable && (job.attempts < MAX_ATTEMPTS || error.code === 'JOB_FINALIZATION_FAILED');
      await settle(runtime.db.update(jobs).set({ status: retry ? 'pending' : 'failed', leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + Math.min(3600000, 15000 * 4 ** (job.attempts - 1))).toISOString() }).where(fence));
      log('error', { ...context, code, retryable: retry, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted, message: error instanceof ApiError ? error.message : 'Unexpected background failure; inspect stack frames.', stack: error instanceof ApiError ? undefined : error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined });
    } finally {
      activeJobs--;
    }
  };
  try {
    while (!failures.length && claims < maximumClaims && Date.now() - started < budgetMs) {
      if (!freeLanes.size) {
        await Promise.race(active);
        continue;
      }
      const claimBatchSize = Math.min(freeLanes.size, maximumClaims - claims);
      const activeAtClaim = active.size;
      const claimStarted = Date.now();
      const claimed = await runtime.db.execute<Claimed>(sql`WITH feedback AS (
        SELECT j.id FROM jobs j WHERE ${effectiveConcurrency > 1 && activeFeedback === 0}
          AND j.type IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery')
          AND ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
        ORDER BY j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ), regular AS (
        SELECT j.id FROM jobs j WHERE ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
          AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.id = j.id)
        ORDER BY CASE WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery','operation.publish','operation.publishBatch') THEN 1 ELSE 0 END,
          CASE WHEN ${Math.floor((rotation + claimRequests) / 4) % 2}::int = CASE WHEN starts_with(j.type, 'campaign.') THEN 1 ELSE 0 END THEN 0 ELSE 1 END,
          CASE WHEN starts_with(j.type, 'campaign.') THEN 1 WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery') THEN 2 WHEN j.type IN ('operation.publish','operation.publishBatch') THEN 3 ELSE 4 END,
          j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT (${claimBatchSize} - (SELECT count(*) FROM feedback))
      ), due AS (
        SELECT id FROM feedback UNION ALL SELECT id FROM regular
      ), claimed AS (UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, lease_until = now() + interval '3 minutes'
        FROM due WHERE jobs.id = due.id RETURNING jobs.*), ${webhookClaimCtes} ${claimedWithWebhooks}`);
      claimRequests++;
      const claimMs = Date.now() - claimStarted;
      if (!claimed.rows.length) {
        // A finishing handler can enqueue more work after the claim's snapshot.
        if (active.size < activeAtClaim) continue;
        if (!active.size) break;
        await Promise.race(active);
        continue;
      }
      claims += claimed.rows.length;
      for (const job of claimed.rows) {
        const index = freeLanes.values().next().value!;
        freeLanes.delete(index);
        const feedback = job.type === 'operation.ses' || job.type === 'operation.simulatedFeedback' || job.type === 'operation.simulatedFeedbackRecovery';
        if (feedback) activeFeedback++;
        const task = handle(job, index, claimMs, claimed.rows.length).catch(error => {
          // Observe failures immediately, but keep the database alive for siblings.
          if (!failures.length) failures.push(error);
        }).finally(() => {
          active.delete(task);
          freeLanes.add(index);
          if (feedback) activeFeedback--;
        });
        active.add(task);
      }
    }
  } finally {
    // The time budget stops new claims, not already leased work or persistence.
    await Promise.all(active);
    log('info', { code: 'JOB_DRAIN', processed, claims, claimRequests, concurrency: effectiveConcurrency, peakActiveJobs, laneJobs, budgetMs, durationMs: Date.now() - started });
  }
  if (failures.length) throw failures[0];
  return processed;
}
// Keep short quota deferrals moving without spinning wakeups or waiting for the next minute's cron.
export async function nextWakeDelay(runtime: Runtime) {
  const result = await runtime.db.execute<{ delay: number | null }>(sql`SELECT CASE WHEN due IS NULL THEN NULL ELSE greatest(0, ceil(extract(epoch FROM due - now())))::int END AS delay
    FROM (SELECT min(CASE WHEN status = 'running' THEN lease_until ELSE available_at END) AS due
      FROM jobs WHERE status IN ('pending','running')) upcoming`);
  const delay = result.rows[0]?.delay;
  return delay !== null && delay !== undefined && delay <= 60 ? delay : null;
}
// Reserve the next delayed wake: only the caller that moves next_wake_at earlier (or past an expired reservation)
// may schedule it. Without this every queue invocation scheduled its own follow-up, so each wake burst and each
// completed job added a chain that never merged, and the duplicates crowded out the wakes that mattered.
export async function reserveNextWake(runtime: Runtime, delaySeconds: number): Promise<boolean> {
  const reserved = await runtime.db.execute(sql`INSERT INTO job_schedule (workspace_id, next_wake_at)
    VALUES (${WAKE_SCHEDULE_KEY}, clock_timestamp() + (${delaySeconds} * interval '1 second'))
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at = excluded.next_wake_at
    WHERE job_schedule.next_wake_at IS NULL OR job_schedule.next_wake_at <= clock_timestamp()
      OR job_schedule.next_wake_at > excluded.next_wake_at + interval '1 second'
    RETURNING 1`);
  return reserved.rows.length > 0;
}
// Drain, then make sure exactly one continuation covers the next due job. A queue invocation may wait in place for a
// job due within keepAliveMs (paced campaigns release every 10-20 s) instead of relying on a delayed message; if it
// is interrupted, its reservation expires and the next drain or the minute cron schedules again.
export async function followDueJobs(runtime: Runtime, drain: () => Promise<unknown>, sendWake: (delaySeconds: number) => Promise<unknown>, keepAliveMs = 0): Promise<'idle' | 'covered' | 'scheduled'> {
  const deadline = Date.now() + keepAliveMs;
  for (;;) {
    await drain();
    const delaySeconds = await nextWakeDelay(runtime);
    if (delaySeconds === null) return 'idle';
    if (!await reserveNextWake(runtime, delaySeconds)) return 'covered';
    const waitMs = Math.max(1000, delaySeconds * 1000) + 150;
    if (Date.now() + waitMs + 2000 <= deadline) { await new Promise(resolve => setTimeout(resolve, waitMs)); continue; }
    await sendWake(delaySeconds);
    return 'scheduled';
  }
}
