import { ApiError, log, type Runtime, type JobHandler } from './core.js';
import { processJobs } from './jobs.js';
import { jobHandlers } from './sending.js';
import { operationJobs } from './operations.js';
import { resolveRegionRuntime, sesRegionJobs } from './ses-regions.js';
import { initialGate, runDispatcher, type GateState } from './dispatcher.js';
const deleteAttachment: JobHandler = async (runtime, payload) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  try { await runtime.storage.delete(payload.key); }
  catch { throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true); }
};
/** Background jobs only (campaign orchestration, feedback recovery, webhooks, maintenance). Cloudflare's queue consumer uses this; mail is dispatched by Durable Objects. */
export async function drainJobs(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000) { return processJobs(await resolveRegionRuntime(runtime), { ...jobHandlers, ...operationJobs, ...sesRegionJobs, 'maintenance.deleteAttachment': deleteAttachment }, limit, concurrency, maxDurationMs); }
/** Jobs plus due mail for every environment/region, in this process. Node runners and tests use this. */
export async function drain(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000, gates = new Map<string, GateState>()) {
  const resolved = await resolveRegionRuntime(runtime);
  let processed = await processJobs(resolved, { ...jobHandlers, ...operationJobs, ...sesRegionJobs, 'maintenance.deleteAttachment': deleteAttachment }, limit, concurrency, maxDurationMs);
  for (const region of resolved.config.regions) {
    for (const environment of ['live', 'test'] as const) {
      if (environment === 'live' && !resolved.config.liveEnabled) continue;
      const key = `${environment}:${region}`;
      const gate = gates.get(key) ?? initialGate(); gates.set(key, gate);
      try { processed += (await runDispatcher(resolved, { environment, region, gate, lanes: 1, until: Date.now() + Math.max(1, maxDurationMs) })).claimed; }
      catch (error) {
        // An unprovisioned live region must not block other regions or the job loop.
        log('warn', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', environment, region, message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying next cycle.' });
      }
    }
  }
  return processed;
}
