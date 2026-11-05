import { sql } from 'drizzle-orm';
import { ApiError, log, type Runtime, type JobHandler } from './core.js';
import { sendingConnections } from './domain-claims.js';
import { processJobs } from './jobs.js';
import { jobHandlers } from './sending.js';
import { operationJobs } from './operations.js';
import { sesRegionJobs } from './ses-regions.js';
import { initialGate, runDispatcher, type GateState } from './dispatcher.js';
import { reputationAlertJobs } from './reputation-alerts.js';
import { mailboxSetupJobs } from './mailbox-setup.js';
import { mailboxIngestJobs } from './mailbox-ingest.js';
import { mailboxEventJobs } from './mailbox-events.js';
import { byoVerifyJob, tenantJob } from './provider-connections.js';
import { finishCampaigns } from './states.js';
const mailboxJobs = { ...mailboxSetupJobs, ...mailboxIngestJobs, ...mailboxEventJobs };
const deleteAttachment: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  if (!payload.key.startsWith(`${job.workspaceId}/attachments/`) && !payload.key.startsWith(`${job.workspaceId}/live/attachments/`) && !payload.key.startsWith(`${job.workspaceId}/templates/assets/`)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion key is outside the job scope.');
  try { await runtime.storage.delete(payload.key); }
  catch { throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true); }
};
/** Background jobs only (campaign orchestration, feedback recovery, webhooks, maintenance). Cloudflare's queue consumer uses this; mail is dispatched by Durable Objects. */
export async function drainJobs(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000) { return processJobs(runtime, { ...jobHandlers, ...operationJobs, ...sesRegionJobs, ...reputationAlertJobs, ...mailboxJobs, 'byo.verify': byoVerifyJob, 'tenant.provision': tenantJob, 'maintenance.deleteAttachment': deleteAttachment }, limit, concurrency, maxDurationMs); }
type Partition = { region: string; accountId?: string; kind?: 'shared' | 'byo' };
export async function dispatchPartitions(runtime: Runtime, recoverInterrupted = false): Promise<Partition[]> {
  // Recover once per sweep, even if a disconnected account has no queued mail. A stale attempt may
  // already have reached SES: record uncertainty atomically; never put it back on the send queue. The same
  // sweep completes any sending campaign whose last row left the queue without finishing it inline.
  const recovery = recoverInterrupted ? sql`WITH stale AS (
    UPDATE sending_emails SET status='acceptance_unknown', error_code='INTERRUPTED_PROVIDER_ATTEMPT', lease_until=NULL, updated_at=now()
    WHERE status='attempting' AND attempt_started_at < now() - interval '3 minutes' RETURNING id, workspace_id, simulated, dispatch_version
  ), events AS (
    INSERT INTO sending_email_events(id,workspace_id,email_id,type,external_id,simulated,data)
    SELECT 'event_' || replace(gen_random_uuid()::text,'-',''), workspace_id, id, 'acceptance_unknown', 'interrupted:' || id || ':' || dispatch_version,
      simulated, '{"code":"INTERRUPTED_PROVIDER_ATTEMPT"}'::jsonb FROM stale ON CONFLICT DO NOTHING
  ), finished AS (${finishCampaigns(sql`SELECT workspace_id, id AS campaign_id FROM sending_campaigns WHERE state='sending' AND expanded=total`, sql`SELECT id FROM stale`)})` : sql``;
  const due = sql`e.status='queued' AND (e.scheduled_at IS NULL OR e.scheduled_at <= now()) AND (e.lease_until IS NULL OR e.lease_until < now())`;
  const partitions = runtime.config.multiTenant ? sql`
    SELECT DISTINCT c.aws_account_id AS "accountId", c.region, c.kind FROM ${sendingConnections(runtime)} c
    WHERE c.paused_at IS NULL AND EXISTS (SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.region=c.region AND ${due})` : sql`
    SELECT DISTINCT e.region FROM sending_emails e JOIN ses_installation_settings s ON s.workspace_id=e.workspace_id
    WHERE ${due} AND s.enabled_regions ? e.region`;
  return (await runtime.db.execute<Partition>(sql`${recovery} ${partitions}`)).rows;
}
/** Jobs plus due mail for every account/region, in this process. Node runners and tests use this. */
export async function drain(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000, gates = new Map<string, GateState>(), recoverInterrupted = true) {
  let processed = await drainJobs(runtime, limit, concurrency, maxDurationMs);
  const dispatch = async ({ accountId, region }: Partition) => {
    const key = `${accountId ? `${accountId}:` : ''}${region}`;
    const gate = gates.get(key) ?? initialGate(); gates.set(key, gate);
    try { return (await runDispatcher(runtime, { accountId, region, gate, lanes: 1, until: Date.now() + Math.max(1, maxDurationMs) })).claimed; }
    catch (error) {
      log('warn', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', accountId, region, message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying next cycle.' });
      return 0;
    }
  };
  const partitions = await dispatchPartitions(runtime, recoverInterrupted);
  const width = runtime.config.multiTenant ? Math.max(2, concurrency) : 1;
  for (let i = 0; i < partitions.length; i += width) {
    const counts = await Promise.all(partitions.slice(i, i + width).map(dispatch));
    processed += counts.reduce((sum, count) => sum + count, 0);
  }
  return processed;
}
