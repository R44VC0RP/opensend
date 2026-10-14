import { sql, type SQL } from 'drizzle-orm';
import type { Runtime } from './core.js';
import { log } from './core.js';
import { enqueue } from './jobs.js';
import type { Mode } from './core.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
// Hourly cron invocations may run up to 15 minutes; stop starting new batches after this and continue next hour.
const RETENTION_BUDGET_MS = 4 * 60_000;

/**
 * Retention runs one table at a time in bounded batches, each its own transaction. It used to be one transaction
 * of unbounded deletes: a single statement over the 60 s limit (e.g. the 2M consent events of a bulk import all
 * crossing 30 days in the same hour) rolled back the whole run every hour, so nothing was ever retired again.
 */
export async function cleanup(runtime: Runtime, budgetMs = RETENTION_BUDGET_MS) {
  const workspace = runtime.config.workspaceId, deadline = Date.now() + budgetMs, deleted: Record<string, number> = {};
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
  await drain('api_request_budgets', batch(sql`api_request_budgets`, sql`workspace_id = ${workspace} AND window_start < now() - interval '1 day'`));
  await drain('agent_tokens', batch(sql`agent_tokens`, sql`workspace_id = ${workspace} AND expires_at < ${cutoff}`));
  await drain('audience_operation_plans', batch(sql`audience_operation_plans`, sql`workspace_id = ${workspace} AND expires_at < now() - interval '1 day'`));
  await drain('sending_email_events', batch(sql`sending_email_events`, sql`workspace_id = ${workspace} AND created_at < ${cutoff}`));
  // An email and its attachment links leave in the same statement, so no link can outlive its email.
  await drain('sending_emails', () => sql`WITH gone AS (
      DELETE FROM sending_emails WHERE ctid IN (SELECT ctid FROM sending_emails WHERE workspace_id = ${workspace} AND created_at < ${cutoff} AND status NOT IN ('queued','attempting') LIMIT ${RETENTION_BATCH})
      RETURNING id, workspace_id, environment
    ), links AS (
      DELETE FROM sending_attachment_links l USING gone e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id AND l.environment = e.environment
    ) SELECT count(*)::int AS n FROM gone`);
  // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a current review
  // or unfinished delivery, including a failed expansion with an outstanding reservation.
  await drain('sending_review_recipients', () => sql`WITH expired AS (
      SELECT r.review_id, r.ordinal FROM sending_review_recipients r
      JOIN sending_campaign_reviews v ON v.id = r.review_id
      WHERE v.workspace_id = ${workspace} AND v.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id AND c.environment = v.environment
          AND (c.updated_at >= ${cutoff} OR c.status IN ('scheduled','sending') OR c.preparing_review_id = v.id OR (c.status = 'reviewed' AND c.review_id = v.id)))
      LIMIT ${RETENTION_BATCH}
    ), gone AS (DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal RETURNING 1)
    SELECT count(*)::int AS n FROM gone`);
  await runtime.db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
    WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id AND l.environment = v.environment
      AND v.workspace_id = ${workspace} AND v.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id AND c.environment = v.environment
        AND (c.status IN ('scheduled','sending') OR c.preparing_review_id = v.id OR (c.status = 'reviewed' AND c.review_id = v.id)))`);
  await drain('operation_delivery_attempts', batch(sql`operation_delivery_attempts`, sql`workspace_id = ${workspace} AND created_at < ${cutoff}`));
  await drain('operation_deliveries', batch(sql`operation_deliveries`, sql`workspace_id = ${workspace} AND created_at < ${cutoff} AND status NOT IN ('pending','paused')`));
  await drain('operation_events', batch(sql`operation_events`, sql`workspace_id = ${workspace} AND created_at < ${cutoff}`));
  await drain('operation_sns_receipts', batch(sql`operation_sns_receipts`, sql`workspace_id = ${workspace} AND created_at < ${cutoff}`));
  await drain('jobs', batch(sql`jobs`, sql`workspace_id = ${workspace} AND status IN ('completed','failed') AND type <> 'maintenance.deleteAttachment' AND created_at < ${cutoff}`));
  // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
  await runtime.db.transaction(async tx => {
    const unused = await tx.execute<{ id: string; storage_key: string; environment: Mode; source_template_asset_id: string | null }>(sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.workspace_id = ${workspace}
        AND a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.attachment_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.id, a.storage_key, a.environment, a.source_template_asset_id`);
    for (const object of unused.rows) if (!object.source_template_asset_id) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: workspace, environment: object.environment, payload: { key: object.storage_key } });
    const unusedTemplateAssets = await tx.execute<{ storage_key: string }>(sql`WITH old AS (
      SELECT a.id FROM template_assets a WHERE a.workspace_id = ${workspace} AND a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key`);
    for (const object of unusedTemplateAssets.rows) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: workspace, environment: 'live', payload: { key: object.storage_key } });
  });
  await drain('jobs_attachment_deletes', batch(sql`jobs`, sql`workspace_id = ${workspace} AND status = 'completed' AND type = 'maintenance.deleteAttachment' AND created_at < ${cutoff}`));
  const complete = Date.now() < deadline;
  log('info', { code: complete ? 'RETENTION_COMPLETED' : 'RETENTION_PARTIAL', workspaceId: workspace, deleted });
}
