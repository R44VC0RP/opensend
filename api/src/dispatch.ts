import { sql } from 'drizzle-orm';
import { ApiError, log, type Runtime, type JobHandler, type Mode } from './core.js';
import { processJobs } from './jobs.js';
import { jobHandlers } from './sending.js';
import { operationJobs } from './operations.js';
import { sesRegionJobs } from './ses-regions.js';
import { initialGate, runDispatcher, type GateState } from './dispatcher.js';
import { reputationAlertJobs } from './reputation-alerts.js';
import { mailboxSetupJobs } from './mailbox-setup.js';
import { mailboxIngestJobs } from './mailbox-ingest.js';
import { mailboxEventJobs } from './mailbox-events.js';
import { tenantJob } from './provider-connections.js';
const mailboxJobs = { ...mailboxSetupJobs, ...mailboxIngestJobs, ...mailboxEventJobs };
const deleteAttachment: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  if (!payload.key.startsWith(`${job.workspaceId}/${job.environment}/attachments/`) && !payload.key.startsWith(`${job.workspaceId}/templates/assets/`)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion key is outside the job scope.');
  try { await runtime.storage.delete(payload.key); }
  catch { throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true); }
};
/** Background jobs only (campaign orchestration, feedback recovery, webhooks, maintenance). Cloudflare's queue consumer uses this; mail is dispatched by Durable Objects. */
export async function drainJobs(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000) { return processJobs(runtime, { ...jobHandlers, ...operationJobs, ...sesRegionJobs, ...reputationAlertJobs, ...mailboxJobs, 'tenant.provision': tenantJob, 'maintenance.deleteAttachment': deleteAttachment }, limit, concurrency, maxDurationMs); }
type Partition = { region: string; environment: Mode; accountId?: string };
export async function dispatchPartitions(runtime: Runtime): Promise<Partition[]> {
  if (runtime.config.multiTenant) return (await runtime.db.execute<Partition>(sql`
    SELECT DISTINCT c.aws_account_id AS "accountId", c.region, c.environment FROM (
      SELECT workspace_id,region,aws_account_id,'live' AS environment FROM provider_sending_connections UNION ALL
      SELECT workspace_id,region,aws_account_id,'test' FROM provider_test_connections) c
    WHERE EXISTS (SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.region=c.region AND e.environment=c.environment AND e.status IN ('queued','attempting'))`)).rows;
  const regions = await runtime.db.execute<{ region: string }>(sql`SELECT DISTINCT jsonb_array_elements_text(enabled_regions) AS region FROM ses_installation_settings`);
  return regions.rows.flatMap(({ region }) => (['live','test'] as const).map(environment => ({ region, environment })));
}
/** Jobs plus due mail for every environment/region, in this process. Node runners and tests use this. */
export async function drain(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000, gates = new Map<string, GateState>()) {
  let processed = await drainJobs(runtime, limit, concurrency, maxDurationMs);
  const dispatch = async ({ accountId, region, environment }: Partition) => {
    if (environment === 'live' && !runtime.config.liveEnabled) return 0;
    const key = `${environment}:${accountId ? `${accountId}:` : ''}${region}`;
    const gate = gates.get(key) ?? initialGate(); gates.set(key, gate);
    try { return (await runDispatcher(runtime, { environment, accountId, region, gate, lanes: 1, until: Date.now() + Math.max(1, maxDurationMs) })).claimed; }
    catch (error) {
      log('warn', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', environment, accountId, region, message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying next cycle.' });
      return 0;
    }
  };
  const partitions = await dispatchPartitions(runtime);
  const width = runtime.config.multiTenant ? Math.max(2, concurrency) : 1;
  for (let i = 0; i < partitions.length; i += width) {
    const counts = await Promise.all(partitions.slice(i, i + width).map(dispatch));
    processed += counts.reduce((sum, count) => sum + count, 0);
  }
  return processed;
}
