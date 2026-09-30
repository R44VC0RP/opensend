import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { ApiError, id, log, type DbExecutor, type JobHandler, type Mode, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { mailboxEvents, mailboxWebhookDeliveries, mailboxWebhooks } from './db/mailbox.js';
import { MAX_ATTEMPTS } from './jobs.js';
import { decrypt, hmac, webhookUrl } from './operations.js';

export const mailboxEventTypes = ['message.received', 'message.queued', 'message.sent', 'message.delivered', 'message.delayed', 'message.bounced', 'message.complained', 'message.failed', 'message.updated', 'thread.updated', 'mailbox.created', 'mailbox.deleted'] as const;
export type MailboxEventType = typeof mailboxEventTypes[number];
export type MailboxEventInput = { type: MailboxEventType; mailboxId: string | null; threadId?: string | null; messageId?: string | null; data?: Record<string, unknown> };
export type MailboxEvent = { id: string; cursor: string; type: MailboxEventType; createdAt: string; mailboxId: string | null; threadId: string | null; messageId: string | null; data: Record<string, unknown> };

export const eventView = (row: typeof mailboxEvents.$inferSelect): MailboxEvent => ({ id: `mev_${row.seq}`, cursor: String(row.seq), type: row.type as MailboxEventType, createdAt: new Date(row.createdAt).toISOString(), mailboxId: row.mailboxId, threadId: row.threadId, messageId: row.messageId, data: row.data });
export const webhookSecretBinding = (workspaceId: string, environment: Mode, webhookId: string) => `${workspaceId}:${environment}:mailbox:${webhookId}`;

/**
 * Appends events and queues matching webhook deliveries in the caller's transaction. Writers take one
 * workspace advisory lock first, so sequence numbers commit in order and cursors never skip a row.
 * Call this last in a transaction to keep the lock short. Returns the number of queued jobs.
 */
export async function recordEvents(tx: DbExecutor, workspaceId: string, environment: Mode, items: MailboxEventInput[]): Promise<number> {
  if (!items.length) return 0;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_events:${workspaceId}`}))`);
  const rows = await tx.insert(mailboxEvents).values(items.map(item => ({ workspaceId, environment, type: item.type, mailboxId: item.mailboxId, threadId: item.threadId ?? null, messageId: item.messageId ?? null, data: item.data ?? {} }))).returning();
  const endpoints = await tx.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, workspaceId), eq(mailboxWebhooks.environment, environment), eq(mailboxWebhooks.paused, false)));
  let queued = 0;
  for (const row of rows) for (const endpoint of endpoints) {
    if (!endpoint.eventTypes.includes(row.type) || (endpoint.mailboxIds && (!row.mailboxId || !endpoint.mailboxIds.includes(row.mailboxId)))) continue;
    const deliveryId = id('mwd');
    await tx.insert(mailboxWebhookDeliveries).values({ id: deliveryId, workspaceId, environment, webhookId: endpoint.id, eventSeq: row.seq, payload: eventView(row) }).onConflictDoNothing();
    await tx.insert(jobs).values({ id: id('job'), type: 'mailbox.webhook', workspaceId, environment, payload: { deliveryId } });
    queued++;
  }
  return queued;
}

/** Events after a cursor, optionally limited to mailboxes (null = all). */
export async function readEvents(db: DbExecutor, workspaceId: string, environment: Mode, input: { after: number; mailboxIds: string[] | null; types?: string[]; limit: number }) {
  if (input.mailboxIds && !input.mailboxIds.length) return [];
  return db.select().from(mailboxEvents).where(and(eq(mailboxEvents.workspaceId, workspaceId), eq(mailboxEvents.environment, environment), gt(mailboxEvents.seq, input.after),
    input.mailboxIds ? inArray(mailboxEvents.mailboxId, input.mailboxIds) : undefined, input.types?.length ? inArray(mailboxEvents.type, input.types) : undefined)).orderBy(mailboxEvents.seq).limit(input.limit);
}
export async function latestCursor(db: DbExecutor, workspaceId: string, environment: Mode) {
  const result = await db.execute<{ seq: string | null }>(sql`SELECT max(seq)::text AS seq FROM mailbox_events WHERE workspace_id = ${workspaceId} AND environment = ${environment}`);
  return Number(result.rows[0]?.seq ?? 0);
}

const webhookJob: JobHandler = async (runtime, payload, job) => {
  const [delivery] = await runtime.db.select().from(mailboxWebhookDeliveries).where(and(eq(mailboxWebhookDeliveries.workspaceId, job.workspaceId), eq(mailboxWebhookDeliveries.id, String(payload.deliveryId))));
  if (!delivery || delivery.status === 'delivered') return;
  const [endpoint] = await runtime.db.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, job.workspaceId), eq(mailboxWebhooks.id, delivery.webhookId)));
  const where = eq(mailboxWebhookDeliveries.id, delivery.id);
  if (!endpoint) { await runtime.db.update(mailboxWebhookDeliveries).set({ status: 'failed', lastError: 'ENDPOINT_DELETED', updatedAt: new Date().toISOString() }).where(where); return; }
  let statusCode: number | null = null, error: string | null = null, retryable = true;
  try {
    const url = webhookUrl(runtime, endpoint.url);
    const secret = await decrypt(runtime, endpoint.encryptedSecret, webhookSecretBinding(job.workspaceId, job.environment, endpoint.id));
    const body = JSON.stringify(delivery.payload), timestamp = String(Math.floor(Date.now() / 1000)), eventId = String(delivery.payload.id);
    const signature = await hmac(secret, `${eventId}.${timestamp}.${body}`);
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Id': eventId, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': 'OpenSend-Mailbox-Webhooks/1.0' }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    statusCode = result.status; await result.body?.cancel(); if (!result.ok) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < MAX_ATTEMPTS;
  await runtime.db.update(mailboxWebhookDeliveries).set({ attemptCount: sql`${mailboxWebhookDeliveries.attemptCount} + 1`, status: !error ? 'delivered' : retry ? 'pending' : 'failed', lastStatusCode: statusCode, lastError: error, updatedAt: new Date().toISOString() }).where(where);
  if (error) throw new ApiError(503, error, 'Mailbox webhook delivery failed; it will be retried.', undefined, retry);
};

export async function pruneMailboxEvents(runtime: Runtime) {
  await runtime.db.execute(sql`DELETE FROM mailbox_events WHERE workspace_id = ${runtime.config.workspaceId} AND created_at < now() - interval '30 days'`);
  await runtime.db.execute(sql`DELETE FROM mailbox_webhook_deliveries WHERE workspace_id = ${runtime.config.workspaceId} AND created_at < now() - interval '30 days' AND status <> 'pending'`);
  log('info', { code: 'MAILBOX_EVENTS_PRUNED' });
}

export const mailboxEventJobs: Record<string, JobHandler> = { 'mailbox.webhook': webhookJob };
