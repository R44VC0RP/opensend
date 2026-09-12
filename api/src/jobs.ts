import { and, eq, sql } from 'drizzle-orm';
import { ApiError, id, log } from './core.js';
import type { DbExecutor, JobHandler, Mode, Runtime } from './core.js';
import { jobs } from './db/core.js';
export const MAX_ATTEMPTS = 6;

export async function enqueue(db: DbExecutor, input: { type: string; workspaceId: string; environment: Mode; payload: Record<string, unknown>; availableAt?: string }) {
  const jobId = id('job');
  await db.insert(jobs).values({ id: jobId, ...input });
  return jobId;
}

// Postgres is the durable queue. CF Queue messages only wake it; cron/polling recovers missed wakeups.
export function jobConcurrency(value: unknown, maximum = 8) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, maximum) : 2;
}
export async function processJobs(runtime: Runtime, handlers: Record<string, JobHandler>, limit = 1, concurrency = 1, maxDurationMs = 20000) {
  const started = Date.now(); let processed = 0, claims = 0, claimRequests = 0, activeJobs = 0, peakActiveJobs = 0, activeSends = 0, peakActiveSends = 0;
  const effectiveConcurrency = jobConcurrency(concurrency);
  const laneJobs = Array<number>(effectiveConcurrency).fill(0);
  const freeLanes = new Set(laneJobs.map((_, index) => index));
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let activeFeedback = 0;
  // Spread short drains across the 16-turn cycle without a shared scheduler-row lock.
  // Live/test and job-class fairness is approximate across invocations, not serialized.
  const rotation = Math.floor(Math.random() * 16);
  const budgetMs = Math.min(20000, Math.max(1, maxDurationMs));
  const maximumClaims = Math.min(Math.max(1, limit), 100);
  const handle = async (job: { id: string; workspace_id: string; environment: Mode; type: string; payload: Record<string, unknown>; attempts: number }, index: number, claimMs: number, claimBatchSize: number) => {
    const jobStarted = Date.now();
    processed++; laneJobs[index]!++;
    peakActiveJobs = Math.max(peakActiveJobs, ++activeJobs);
    if (job.type === 'email.dispatch') peakActiveSends = Math.max(peakActiveSends, ++activeSends);
    const fence = and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempts), eq(jobs.status, 'running'));
    const context = { jobId: job.id, operation: job.type, attempt: job.attempts, workspaceId: job.workspace_id, environment: job.environment, requestId: typeof job.payload.requestId === 'string' ? job.payload.requestId : undefined };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new ApiError(500, 'JOB_HANDLER_MISSING', 'No handler is registered for this job type.');
      await handler(runtime, job.payload, { id: job.id, attempts: job.attempts, workspaceId: job.workspace_id, environment: job.environment });
      await runtime.db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: null }).where(fence);
      log('info', { ...context, code: 'JOB_COMPLETED', claimMs, claimBatchSize, jobMs: Date.now() - jobStarted });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR';
      // Domain failure-state persistence must eventually commit; stopping at the
      // ordinary attempt ceiling would strand a campaign in pending forever.
      const retry = error instanceof ApiError && error.retryable && (job.attempts < MAX_ATTEMPTS || error.code === 'JOB_FINALIZATION_FAILED');
      await runtime.db.update(jobs).set({ status: retry ? 'pending' : 'failed', leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + Math.min(3600000, 15000 * 4 ** (job.attempts - 1))).toISOString() }).where(fence);
      log('error', { ...context, code, retryable: retry, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted, message: error instanceof ApiError ? error.message : 'Unexpected background failure; inspect stack frames.', stack: error instanceof ApiError ? undefined : error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined });
    } finally {
      activeJobs--;
      if (job.type === 'email.dispatch') activeSends--;
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
      const claimed = await runtime.db.execute<{
        id: string; workspace_id: string; environment: Mode; type: string; payload: Record<string, unknown>; attempts: number;
      }>(sql`WITH rotation AS (
        SELECT ${(rotation + claimRequests) % 16}::int AS turn
      ), feedback AS (
        SELECT j.id FROM jobs j CROSS JOIN rotation r WHERE ${effectiveConcurrency > 1 && activeFeedback === 0}
          AND j.workspace_id = ${runtime.config.workspaceId} AND j.type IN ('operation.ses','operation.simulatedFeedback')
          AND ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
        ORDER BY CASE WHEN j.environment = CASE WHEN r.turn % 4 = 0 THEN 'test' ELSE 'live' END THEN 0 ELSE 1 END,
          j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ), regular AS (
        SELECT j.id FROM jobs j CROSS JOIN rotation r WHERE j.workspace_id = ${runtime.config.workspaceId}
          AND ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
          AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.id = j.id)
        ORDER BY CASE WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.publish','operation.publishBatch') THEN 1 ELSE 0 END,
          CASE WHEN j.environment = CASE WHEN r.turn % 4 = 0 THEN 'test' ELSE 'live' END THEN 0 ELSE 1 END,
          CASE WHEN (r.turn / 4) = CASE WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.publish') THEN 0
            WHEN j.type = 'email.dispatch' AND j.payload->>'campaignId' IS NULL THEN 1
            WHEN j.type IN ('campaign.prepare','campaign.expand','campaign.finish') THEN 2 WHEN j.type = 'email.dispatch' THEN 3 ELSE 0 END THEN 0 ELSE 1 END,
          CASE WHEN j.type = 'campaign.finish' THEN 0 WHEN j.type = 'email.dispatch' THEN 1
            WHEN j.type IN ('campaign.prepare','campaign.expand') THEN 2 WHEN j.type IN ('operation.ses','operation.simulatedFeedback') THEN 3 WHEN j.type IN ('operation.publish','operation.publishBatch') THEN 4 ELSE 5 END,
          j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT (${claimBatchSize} - (SELECT count(*) FROM feedback))
      ), due AS (
        SELECT id FROM feedback UNION ALL SELECT id FROM regular
      ) UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, lease_until = now() + interval '3 minutes'
        FROM due WHERE jobs.id = due.id RETURNING jobs.*`);
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
        const feedback = job.type === 'operation.ses' || job.type === 'operation.simulatedFeedback';
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
    log('info', { code: 'JOB_DRAIN', workspaceId: runtime.config.workspaceId, processed, claims, claimRequests, concurrency: effectiveConcurrency, peakActiveJobs, peakActiveSends, laneJobs, budgetMs, durationMs: Date.now() - started });
  }
  if (failures.length) throw failures[0];
  return processed;
}
// Keep short quota deferrals moving without spinning wakeups or waiting for the next minute's cron.
export async function nextWakeDelay(runtime: Runtime) {
  const result = await runtime.db.execute<{ delay: number | null }>(sql`SELECT CASE WHEN due IS NULL THEN NULL ELSE greatest(0, ceil(extract(epoch FROM due - now())))::int END AS delay
    FROM (SELECT min(CASE WHEN status = 'running' THEN lease_until ELSE available_at END) AS due
      FROM jobs WHERE workspace_id = ${runtime.config.workspaceId} AND status IN ('pending','running')) upcoming`);
  const delay = result.rows[0]?.delay;
  return delay !== null && delay !== undefined && delay <= 60 ? delay : null;
}
