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
    await tx.execute(sql`DELETE FROM sending_email_events WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM sending_attachment_links l USING sending_emails e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id AND l.environment = e.environment AND e.workspace_id = ${workspace} AND e.created_at < now() - interval '30 days' AND e.status NOT IN ('queued','attempting')`);
    await tx.execute(sql`DELETE FROM sending_emails WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days' AND status NOT IN ('queued','attempting')`);
    await tx.execute(sql`DELETE FROM operation_delivery_attempts WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM operation_deliveries WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days' AND status NOT IN ('pending','paused')`);
    await tx.execute(sql`DELETE FROM operation_events WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM operation_sns_receipts WHERE workspace_id = ${workspace} AND created_at < now() - interval '30 days'`);
    await tx.execute(sql`DELETE FROM jobs WHERE workspace_id = ${workspace} AND status IN ('completed','failed') AND type <> 'maintenance.deleteAttachment' AND created_at < now() - interval '30 days'`);
    // Compact campaign totals survive log retention; old recipient snapshots do not.
    await tx.execute(sql`DELETE FROM campaign_recipients r USING campaign_runs c WHERE r.run_id=c.id AND c.workspace_id=${workspace} AND c.updated_at<now()-interval '30 days' AND c.status IN ('completed','canceled') AND NOT EXISTS(SELECT 1 FROM sending_emails e WHERE e.campaign_id=c.campaign_id)`);
    await tx.execute(sql`UPDATE campaign_runs c SET content=NULL,actor='{}'::jsonb WHERE c.workspace_id=${workspace} AND c.updated_at<now()-interval '30 days' AND c.status IN ('completed','canceled') AND c.content IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sending_emails e WHERE e.campaign_id=c.campaign_id)`);
    await tx.execute(sql`DELETE FROM audience_bulk_rows r USING audience_bulk_imports i WHERE r.import_id=i.id AND i.workspace_id=${workspace} AND i.updated_at<now()-interval '30 days' AND i.status='committed'`);
    await tx.execute(sql`DELETE FROM crm_sync_errors WHERE workspace_id=${workspace} AND created_at<now()-interval '30 days'`);
    // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
    const unused = await tx.execute<{ id: string; storage_key: string; environment: Mode }>(sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.workspace_id = ${workspace}
        AND a.created_at < now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.attachment_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.id, a.storage_key, a.environment`);
    for (const object of unused.rows) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: workspace, environment: object.environment, payload: { key: object.storage_key } });
    await tx.execute(sql`DELETE FROM jobs WHERE workspace_id = ${workspace} AND status = 'completed' AND type = 'maintenance.deleteAttachment' AND created_at < now() - interval '30 days'`);
  });
  log('info', { code: 'RETENTION_COMPLETED', workspaceId: workspace });
}
