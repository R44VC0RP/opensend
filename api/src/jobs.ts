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
export async function processJobs(runtime: Runtime, handlers: Record<string, JobHandler>, limit = 1) {
  const claimed = await runtime.db.execute<{
    id: string; workspace_id: string; environment: Mode; type: string; payload: Record<string, unknown>; attempts: number;
  }>(sql`WITH rotation AS (
    INSERT INTO job_schedule(workspace_id, turn)
      SELECT ${runtime.config.workspaceId}, 1 WHERE EXISTS (
        SELECT 1 FROM jobs WHERE workspace_id = ${runtime.config.workspaceId}
          AND ((status = 'pending' AND available_at <= now()) OR (status = 'running' AND lease_until < now()))
      )
    ON CONFLICT (workspace_id) DO UPDATE SET turn = (job_schedule.turn + 1) % 4 RETURNING turn
  ), due AS (
    SELECT j.id FROM jobs j CROSS JOIN rotation r WHERE j.workspace_id = ${runtime.config.workspaceId}
      AND ((j.status = 'pending' AND j.available_at <= now()) OR (j.status = 'running' AND j.lease_until < now()))
    ORDER BY CASE WHEN j.environment = CASE WHEN r.turn = 0 THEN 'test' ELSE 'live' END THEN 0 ELSE 1 END,
      CASE WHEN j.type = 'operation.ses' THEN 0 WHEN j.type = 'email.dispatch' THEN 1 ELSE 2 END,
      j.available_at, j.id FOR UPDATE OF j SKIP LOCKED LIMIT ${limit}
  ) UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, lease_until = now() + interval '3 minutes'
    FROM due WHERE jobs.id = due.id RETURNING jobs.*`);
  for (const job of claimed.rows) {
    const fence = and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempts), eq(jobs.status, 'running'));
    const context = { jobId: job.id, operation: job.type, attempt: job.attempts, workspaceId: job.workspace_id, environment: job.environment, requestId: typeof job.payload.requestId === 'string' ? job.payload.requestId : undefined };
    try {
      const handler = handlers[job.type];
      if (!handler) throw new ApiError(500, 'JOB_HANDLER_MISSING', 'No handler is registered for this job type.');
      await handler(runtime, job.payload, { id: job.id, attempts: job.attempts, workspaceId: job.workspace_id, environment: job.environment });
      await runtime.db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: null }).where(fence);
      log('info', { ...context, code: 'JOB_COMPLETED' });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR';
      const retry = error instanceof ApiError && error.retryable && job.attempts < MAX_ATTEMPTS;
      await runtime.db.update(jobs).set({ status: retry ? 'pending' : 'failed', leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + Math.min(3600000, 15000 * 4 ** (job.attempts - 1))).toISOString() }).where(fence);
      log('error', { ...context, code, retryable: retry, message: error instanceof ApiError ? error.message : 'Unexpected background failure; inspect stack frames.', stack: error instanceof ApiError ? undefined : error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined });
    }
  }
  return claimed.rows.length;
}
