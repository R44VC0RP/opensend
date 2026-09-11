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
export async function processJobs(runtime: Runtime, handlers: Record<string, JobHandler>, limit = 1, concurrency = 1) {
  const started = Date.now(); let processed = 0, claims = 0;
  const effectiveConcurrency = jobConcurrency(concurrency);
  // Each bounded worker claims only its next job, then immediately starts it. Never pre-lease a waiting batch.
  const run = async (_: unknown, index: number) => {
  // One lane prefers feedback, FIFO across both types within each environment; fallback uses the same claim slot.
  const feedbackFirst = effectiveConcurrency > 1 && index === 0;
  while (claims < Math.min(Math.max(1, limit), 100) && Date.now() - started < 20000) {
    claims++;
    const claimStarted = Date.now();
    const claimed = await runtime.db.execute<{
      id: string; workspace_id: string; environment: Mode; type: string; payload: Record<string, unknown>; attempts: number;
    }>(sql`WITH rotation AS (
      INSERT INTO job_schedule(workspace_id, turn)
        SELECT ${runtime.config.workspaceId}, 1 WHERE EXISTS (
          SELECT 1 FROM jobs WHERE workspace_id = ${runtime.config.workspaceId}
            AND ((status = 'pending' AND available_at <= now()) OR (status = 'running' AND lease_until < now()))
        )
      ON CONFLICT (workspace_id) DO UPDATE SET turn = (job_schedule.turn + 1) % 16 RETURNING turn
    ), due AS (
      SELECT j.id FROM jobs j CROSS JOIN rotation r WHERE j.workspace_id = ${runtime.config.workspaceId}
        AND ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
      ORDER BY CASE WHEN ${feedbackFirst} AND j.type IN ('operation.ses','operation.publish') THEN 0 ELSE 1 END,
        CASE WHEN j.environment = CASE WHEN r.turn % 4 = 0 THEN 'test' ELSE 'live' END THEN 0 ELSE 1 END,
        CASE WHEN (r.turn / 4) = CASE WHEN j.type IN ('operation.ses','operation.publish') THEN 0
          WHEN j.type = 'email.dispatch' AND j.payload->>'campaignId' IS NULL THEN 1
          WHEN j.type IN ('campaign.prepare','campaign.expand','campaign.finish') THEN 2 WHEN j.type = 'email.dispatch' THEN 3 ELSE 0 END THEN 0 ELSE 1 END,
        CASE WHEN j.type = 'campaign.finish' THEN 0 WHEN j.type = 'email.dispatch' THEN 1
          WHEN j.type IN ('campaign.prepare','campaign.expand') THEN 2 WHEN j.type IN ('operation.ses','operation.publish') THEN 3 ELSE 4 END,
        j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
    ) UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, lease_until = now() + interval '3 minutes'
      FROM due WHERE jobs.id = due.id RETURNING jobs.*`);
    const claimMs = Date.now() - claimStarted;
    const job = claimed.rows[0];
    if (!job) break;
    const jobStarted = Date.now();
    processed++;
    const fence = and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempts), eq(jobs.status, 'running'));
    const context = { jobId: job.id, operation: job.type, attempt: job.attempts, workspaceId: job.workspace_id, environment: job.environment, requestId: typeof job.payload.requestId === 'string' ? job.payload.requestId : undefined };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new ApiError(500, 'JOB_HANDLER_MISSING', 'No handler is registered for this job type.');
      await handler(runtime, job.payload, { id: job.id, attempts: job.attempts, workspaceId: job.workspace_id, environment: job.environment });
      await runtime.db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: null }).where(fence);
      log('info', { ...context, code: 'JOB_COMPLETED', claimMs, jobMs: Date.now() - jobStarted });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR';
      // Domain failure-state persistence must eventually commit; stopping at the
      // ordinary attempt ceiling would strand a campaign in pending forever.
      const retry = error instanceof ApiError && error.retryable && (job.attempts < MAX_ATTEMPTS || error.code === 'JOB_FINALIZATION_FAILED');
      await runtime.db.update(jobs).set({ status: retry ? 'pending' : 'failed', leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + Math.min(3600000, 15000 * 4 ** (job.attempts - 1))).toISOString() }).where(fence);
      log('error', { ...context, code, retryable: retry, claimMs, jobMs: Date.now() - jobStarted, message: error instanceof ApiError ? error.message : 'Unexpected background failure; inspect stack frames.', stack: error instanceof ApiError ? undefined : error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined });
    }
  }
  };
  const workers = Array.from({ length: effectiveConcurrency }, run);
  try {
    await Promise.all(workers);
    return processed;
  } finally {
    await Promise.allSettled(workers);
    log('info', { code: 'JOB_DRAIN', workspaceId: runtime.config.workspaceId, processed, claims, concurrency: effectiveConcurrency, durationMs: Date.now() - started });
  }
}
// Keep short quota deferrals moving without spinning wakeups or waiting for the next minute's cron.
export async function nextWakeDelay(runtime: Runtime) {
  const result = await runtime.db.execute<{ delay: number | null }>(sql`SELECT CASE WHEN due IS NULL THEN NULL ELSE greatest(0, ceil(extract(epoch FROM due - now())))::int END AS delay
    FROM (SELECT min(CASE WHEN status = 'running' THEN lease_until ELSE available_at END) AS due
      FROM jobs WHERE workspace_id = ${runtime.config.workspaceId} AND status IN ('pending','running')) upcoming`);
  const delay = result.rows[0]?.delay;
  return delay !== null && delay !== undefined && delay <= 60 ? delay : null;
}
