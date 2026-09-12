import { ApiError, type Runtime, type JobHandler } from './core.js';
import { processJobs } from './jobs.js';
import { jobHandlers } from './sending.js';
import { operationJobs } from './operations.js';
import { resolveRegionRuntime, sesRegionJobs } from './ses-regions.js';
const deleteAttachment: JobHandler = async (runtime, payload) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  try { await runtime.storage.delete(payload.key); }
  catch { throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true); }
};
export async function drain(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000) { return processJobs(await resolveRegionRuntime(runtime), { ...jobHandlers, ...operationJobs, ...sesRegionJobs, 'maintenance.deleteAttachment': deleteAttachment }, limit, concurrency, maxDurationMs); }
