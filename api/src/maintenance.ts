import { sql } from 'drizzle-orm';
import type { Runtime } from './core.js';
import { log } from './core.js';
import { enqueue } from './jobs.js';
import type { Mode } from './core.js';

export async function cleanup(runtime: Runtime) {
  const workspace = runtime.config.workspaceId;
  await runtime.db.transaction(async tx => {
    // Never erase contacts, consent, suppression, drafts, idempotency keys or active scheduled work.
    await tx.execute(sql`DELETE FROM api_request_budgets WHERE workspace_id = ${workspace} AND window_start < now() - interval '1 day'`);
    await tx.execute(sql`DELETE FROM agent_tokens WHERE workspace_id = ${workspace} AND expires_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM audience_operation_plans WHERE workspace_id = ${workspace} AND expires_at < now() - interval '1 day'`);
    await tx.execute(sql`DELETE FROM sending_email_events WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM sending_attachment_links l USING sending_emails e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id AND l.environment = e.environment AND e.workspace_id = ${workspace} AND e.created_at < now() - interval '30 days' AND e.status NOT IN ('queued','attempting')`);
    await tx.execute(sql`DELETE FROM sending_emails WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days' AND status NOT IN ('queued','attempting')`);
    // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a current review
    // or unfinished delivery, including a failed expansion with an outstanding reservation.
    await tx.execute(sql`WITH expired AS (
      SELECT r.review_id, r.ordinal FROM sending_review_recipients r
      JOIN sending_campaign_reviews v ON v.id = r.review_id
      WHERE v.workspace_id = ${workspace} AND v.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id AND c.environment = v.environment
          AND (c.updated_at >= now() - interval '30 days' OR c.status IN ('scheduled','sending') OR c.preparing_review_id = v.id OR (c.status = 'reviewed' AND c.review_id = v.id)))
      LIMIT 10000
    ) DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal`);
    await tx.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
      WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id AND l.environment = v.environment
        AND v.workspace_id = ${workspace} AND v.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id AND c.environment = v.environment
          AND (c.status IN ('scheduled','sending') OR c.preparing_review_id = v.id OR (c.status = 'reviewed' AND c.review_id = v.id)))`);
    await tx.execute(sql`DELETE FROM operation_delivery_attempts WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM operation_deliveries WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days' AND status NOT IN ('pending','paused')`);
    await tx.execute(sql`DELETE FROM operation_events WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM operation_sns_receipts WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM jobs WHERE workspace_id = ${workspace} AND status IN ('completed','failed') AND type <> 'maintenance.deleteAttachment' AND created_at < now() - interval '30 days'`);
    // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
    const unused = await tx.execute<{ id: string; storage_key: string; environment: Mode; source_template_asset_id: string | null }>(sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.workspace_id = ${workspace}
        AND a.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.attachment_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.id, a.storage_key, a.environment, a.source_template_asset_id`);
    for (const object of unused.rows) if (!object.source_template_asset_id) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: workspace, environment: object.environment, payload: { key: object.storage_key } });
    const unusedTemplateAssets = await tx.execute<{ storage_key: string }>(sql`WITH old AS (
      SELECT a.id FROM template_assets a WHERE a.workspace_id = ${workspace} AND a.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key`);
    for (const object of unusedTemplateAssets.rows) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: workspace, environment: 'live', payload: { key: object.storage_key } });
    await tx.execute(sql`DELETE FROM jobs WHERE workspace_id = ${workspace} AND status = 'completed' AND type = 'maintenance.deleteAttachment' AND created_at < now() - interval '30 days'`);
  });
  log('info', { code: 'RETENTION_COMPLETED', workspaceId: workspace });
}
