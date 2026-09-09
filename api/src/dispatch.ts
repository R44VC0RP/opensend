import { ApiError, type Runtime, type JobHandler } from './core.js';
import { processJobs } from './jobs.js';
import { jobHandlers } from './sending.js';
import { operationJobs } from './operations.js';
const deleteAttachment: JobHandler = async (runtime, payload) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  try { await runtime.storage.delete(payload.key); }
  catch { throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true); }
};
export function drain(runtime: Runtime, limit = 1) { return processJobs(runtime, { ...jobHandlers, ...operationJobs, 'maintenance.deleteAttachment': deleteAttachment }, limit); }
