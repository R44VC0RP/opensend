import { sql, type SQL } from 'drizzle-orm';
import type { Runtime } from './core.js';
import { log } from './core.js';
import { enqueue } from './jobs.js';
import { campaignActive, pauseHostedSending } from './states.js';
import { hostedMail, realDestinations } from './hosted-sending.js';
import { expireDomainClaims } from './operations.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
// Hourly cron invocations may run up to 15 minutes; stop starting new batches after this and continue next hour.
const RETENTION_BUDGET_MS = 4 * 60_000;

export async function checkHostedHealth(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  // Start from the sparse 24-hour feedback index. Multiple notifications about the same
  // destination count once per outcome; unattributed reports establish at least one, not an extra one.
  const result = await runtime.db.execute(pauseHostedSending(sql`WITH affected AS (
    SELECT pc.id,pc.workspace_id,pc.resumed_at,v.email_id,v.type,greatest(1,count(DISTINCT h.hash)) AS recipients
    FROM sending_email_events v JOIN provider_connections pc USING (workspace_id)
    JOIN sending_emails e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON true
    WHERE NOT v.simulated AND v.type IN ('bounce','complaint') AND v.created_at>now()-interval '24 hours'
      AND v.created_at>greatest(now()-interval '24 hours',pc.resumed_at) AND pc.kind='shared' AND pc.paused_at IS NULL
      AND (v.type='complaint' OR v.data->>'bounceType'='Permanent') AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes)>0)
      AND NOT e.simulated AND e.status<>'suppressed' AND ${hostedMail} AND ${realDestinations}>0
    GROUP BY pc.id,pc.workspace_id,pc.resumed_at,v.email_id,v.type
  ), candidates AS MATERIALIZED (
    SELECT id,workspace_id,resumed_at,sum(CASE WHEN type='bounce' THEN recipients ELSE 0 END) AS bounces,
      sum(CASE WHEN type='complaint' THEN recipients ELSE 0 END) AS complaints FROM affected GROUP BY id,workspace_id,resumed_at
  ), counts AS (
    SELECT c.*,volume.sends FROM candidates c CROSS JOIN LATERAL (
      -- Include yesterday's accepted sends for delayed feedback. Acceptance and its SES Send
      -- callback are one envelope; each real To/Cc/Bcc on it contributed to the SES volume.
      SELECT coalesce(sum(${realDestinations}),0) AS sends FROM (
        SELECT DISTINCT v.email_id FROM sending_email_events v WHERE v.workspace_id=c.workspace_id AND NOT v.simulated
          AND v.type IN ('accepted','send') AND v.created_at>greatest(now()-interval '48 hours',c.resumed_at)
      ) accepted JOIN sending_emails e ON e.id=accepted.email_id AND e.workspace_id=c.workspace_id
      WHERE NOT e.simulated AND e.status<>'suppressed' AND ${hostedMail}
    ) volume)
  SELECT *,CASE WHEN (sends<200 AND bounces>=10) OR (sends>=200 AND bounces>sends*0.03) THEN 'Hosted sending paused: high hard-bounce volume in the last 24 hours.'
    WHEN (sends<200 AND complaints>=2) OR (sends>=200 AND complaints>sends*0.0005) THEN 'Hosted sending paused: high spam-complaint volume in the last 24 hours.' END AS reason FROM counts`));
  for (const row of result.rows) log('warn', { code: 'HOSTED_SENDING_AUTO_PAUSED', workspaceId: row.workspace_id, reason: row.pause_reason, sends: Number(row.sends), bounces: Number(row.bounces), complaints: Number(row.complaints) });
}

/**
 * Retention runs one table at a time in bounded batches, each its own transaction. It used to be one transaction
 * of unbounded deletes: a single statement over the 60 s limit (e.g. the 2M consent events of a bulk import all
 * crossing 30 days in the same hour) rolled back the whole run every hour, so nothing was ever retired again.
 */
export async function cleanup(runtime: Runtime, budgetMs = RETENTION_BUDGET_MS) {
  try { await checkHostedHealth(runtime); } catch { log('error', { code: 'HOSTED_HEALTH_CHECK_FAILED', message: 'Continuing retention; the next hourly check will retry.' }); }
  const deadline = Date.now() + budgetMs, deleted: Record<string, number> = {};
  if (runtime.config.multiTenant) deleted.domain_claims=await expireDomainClaims(runtime,Math.min(deadline,Date.now()+60_000));
  const cutoff = sql`now() - interval '30 days'`;
  // Repeats one bounded statement until it deletes less than a full batch or the budget runs out.
  const drain = async (name: string, statement: () => SQL) => {
    while (Date.now() < deadline) {
      const result = await runtime.db.execute<{ n: number }>(statement());
      const n = Number(result.rows[0]?.n ?? 0);
      deleted[name] = (deleted[name] ?? 0) + n;
      if (n < RETENTION_BATCH) return;
    }
  };
  const batch = (table: SQL, where: SQL) => () => sql`WITH gone AS (DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone`;
  // Never erase contacts, consent, suppression, drafts, idempotency keys or active scheduled work.
  await drain('api_request_budgets', batch(sql`api_request_budgets`, sql`window_start < now() - interval '1 day'`));
  await drain('agent_tokens', batch(sql`agent_tokens`, sql`expires_at < ${cutoff}`));
  await drain('audience_operation_plans', batch(sql`audience_operation_plans`, sql`expires_at < now() - interval '1 day'`));
  await drain('sending_email_events', batch(sql`sending_email_events`, sql`created_at < ${cutoff}`));
  // An email and its attachment links leave in the same statement, so no link can outlive its email.
  await drain('sending_emails', () => sql`WITH gone AS (
      DELETE FROM sending_emails WHERE ctid IN (SELECT ctid FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting') LIMIT ${RETENTION_BATCH})
      RETURNING id, workspace_id
    ), links AS (
      DELETE FROM sending_attachment_links l USING gone e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id
    ) SELECT count(*)::int AS n FROM gone`);
  // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a campaign's current
  // snapshot or one with an outstanding reservation (including a failed launch).
  await drain('sending_review_recipients', () => sql`WITH expired AS (
      SELECT r.review_id, r.ordinal FROM sending_review_recipients r
      JOIN sending_campaign_reviews v ON v.id = r.review_id
      WHERE v.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
          AND (c.updated_at >= ${cutoff} OR ${campaignActive()} OR c.review_id = v.id))
      LIMIT ${RETENTION_BATCH}
    ), gone AS (DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal RETURNING 1)
    SELECT count(*)::int AS n FROM gone`);
  await runtime.db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
    WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id
      AND v.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
        AND (${campaignActive()} OR c.review_id = v.id))`);
  await drain('operation_delivery_attempts', batch(sql`operation_delivery_attempts`, sql`created_at < ${cutoff}`));
  await drain('operation_deliveries', batch(sql`operation_deliveries`, sql`created_at < ${cutoff} AND status NOT IN ('pending','paused')`));
  await drain('operation_events', batch(sql`operation_events`, sql`created_at < ${cutoff}`));
  await drain('operation_sns_receipts', batch(sql`operation_sns_receipts`, sql`created_at < ${cutoff}`));
  await drain('jobs', batch(sql`jobs`, sql`status IN ('completed','failed') AND type <> 'maintenance.deleteAttachment' AND created_at < ${cutoff}`));
  // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
  await runtime.db.transaction(async tx => {
    const unused = await tx.execute<{ id: string; storage_key: string; workspace_id: string; source_template_asset_id: string | null }>(sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.attachment_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.id, a.storage_key, a.workspace_id, a.source_template_asset_id`);
    for (const object of unused.rows) if (!object.source_template_asset_id) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: object.workspace_id, payload: { key: object.storage_key } });
    const unusedTemplateAssets = await tx.execute<{ storage_key: string; workspace_id: string }>(sql`WITH old AS (
      SELECT a.id FROM template_assets a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id`);
    for (const object of unusedTemplateAssets.rows) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: object.workspace_id, payload: { key: object.storage_key } });
  });
  await drain('jobs_attachment_deletes', batch(sql`jobs`, sql`status = 'completed' AND type = 'maintenance.deleteAttachment' AND created_at < ${cutoff}`));
  const complete = Date.now() < deadline;
  log('info', { code: complete ? 'RETENTION_COMPLETED' : 'RETENTION_PARTIAL', deleted });
}
