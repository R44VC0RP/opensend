import { and, eq, gt, inArray, isNotNull, max, sql, type SQL } from 'drizzle-orm';
import { ApiError, log, type DbExecutor, type JobHandler, type Mode, type Runtime } from './core.js';
import { mailboxEvents, mailboxWebhookDeliveries, mailboxWebhooks } from './db/mailbox.js';
import { MAX_ATTEMPTS } from './jobs.js';
import { decrypt, hmac, webhookUrl } from './operations.js';

const sharedEventTypes = ['message.received', 'message.stored', 'message.queued', 'message.sent', 'message.delivered', 'message.delayed', 'message.bounced', 'message.complained', 'message.failed', 'message.updated', 'thread.updated'] as const;
export const mailboxEventTypes = [...sharedEventTypes, 'mailbox.created', 'mailbox.deleted'] as const;
export const inboundEventTypes = [...sharedEventTypes, 'address.created', 'address.deleted'] as const;
export type MailboxEventType = typeof mailboxEventTypes[number];
// The log keeps its original vocabulary. Only these two lifecycle types have API aliases.
export const storedEventType = (type: string) => type === 'address.created' ? 'mailbox.created' : type === 'address.deleted' ? 'mailbox.deleted' : type;
export const inboundEventType = (type: MailboxEventType): typeof inboundEventTypes[number] => type === 'mailbox.created' ? 'address.created' : type === 'mailbox.deleted' ? 'address.deleted' : type;
export function configuredEventType(eventTypes: string[], type: string) {
  const stored = storedEventType(type);
  return eventTypes.find(requested => storedEventType(requested) === stored);
}
export type MailboxEventInput = { type: MailboxEventType; mailboxId: string | null; threadId?: string | null; messageId?: string | null; data?: Record<string, unknown> };
export type MailboxEvent = { id: string; cursor: string; type: MailboxEventType; createdAt: string; mailboxId: string | null; threadId: string | null; messageId: string | null; data: Record<string, unknown> };

export const eventView = (row: typeof mailboxEvents.$inferSelect): MailboxEvent => ({ id: `mev_${row.seq}`, cursor: String(row.seq), type: row.type as MailboxEventType, createdAt: new Date(row.createdAt).toISOString(), mailboxId: row.mailboxId, threadId: row.threadId, messageId: row.messageId, data: row.data });
export const webhookSecretBinding = (workspaceId: string, environment: Mode, webhookId: string) => `${workspaceId}:${environment}:mailbox:${webhookId}`;

// Snapshot the address from the event itself, never from current routing or subscription state.
function webhookPayload(event: Record<string, unknown>) {
  return !('addressId' in event) && (typeof event.mailboxId === 'string' || event.mailboxId === null) ? { ...event, addressId: event.mailboxId } : event;
}
function subscribedWireType(endpoint: typeof mailboxWebhooks.$inferSelect, type: unknown, mailboxId: unknown) {
  if (typeof type !== 'string' || (endpoint.mailboxIds !== null && (type === 'message.stored' || typeof mailboxId !== 'string' || !endpoint.mailboxIds.includes(mailboxId)))) return undefined;
  return configuredEventType(endpoint.eventTypes, type);
}

// Both ingest and outbound sync append the same immutable event and webhook snapshots. Take the
// workspace lanes in a consistent order before allocating sequence numbers, so cursors never skip a commit.
export function mailboxEventCtes(source:SQL) {
  return sql`items AS MATERIALIZED (${source}), lanes AS (
    INSERT INTO mailbox_write_lanes(workspace_id,lane) SELECT DISTINCT workspace_id,'events' FROM items ORDER BY workspace_id
    ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane RETURNING workspace_id
  ), events AS (INSERT INTO mailbox_events(workspace_id,environment,type,mailbox_id,thread_id,message_id,data)
    SELECT workspace_id,environment,type,mailbox_id,thread_id,message_id,data FROM items JOIN lanes USING(workspace_id) ORDER BY workspace_id,ord RETURNING *
  ), deliveries AS (INSERT INTO mailbox_webhook_deliveries(id,workspace_id,environment,webhook_id,event_seq,payload)
    SELECT 'mwd_'||gen_random_uuid(),e.workspace_id,e.environment,h.id,e.seq,jsonb_build_object('id','mev_'||e.seq,'cursor',e.seq::text,'type',wire.type,'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'mailboxId',e.mailbox_id,'addressId',e.mailbox_id,'threadId',e.thread_id,'messageId',e.message_id,'data',e.data)
    FROM events e JOIN mailbox_webhooks h ON h.workspace_id=e.workspace_id AND h.environment=e.environment AND NOT h.paused
      AND (h.mailbox_ids IS NULL OR (e.type<>'message.stored' AND h.mailbox_ids ? e.mailbox_id))
    CROSS JOIN LATERAL (SELECT type FROM jsonb_array_elements_text(h.event_types) WITH ORDINALITY t(type,n)
      WHERE type=e.type OR (e.type IN ('mailbox.created','mailbox.deleted') AND type=replace(e.type,'mailbox.','address.')) ORDER BY n LIMIT 1) wire RETURNING id,workspace_id,environment
  ), queued AS (INSERT INTO jobs(id,type,workspace_id,environment,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.webhook',workspace_id,environment,jsonb_build_object('deliveryId',id) FROM deliveries RETURNING 1)`;
}

export async function recordEvents(tx: DbExecutor, workspaceId: string, environment: Mode, items: MailboxEventInput[]): Promise<number> {
  if (!items.length) return 0;
  const source=sql`SELECT ${workspaceId}::text AS workspace_id,${environment}::text AS environment,j->>'type' AS type,j->>'mailboxId' AS mailbox_id,j->>'threadId' AS thread_id,j->>'messageId' AS message_id,coalesce(j->'data','{}') AS data,ord FROM jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY t(j,ord)`;
  return (await tx.execute<{n:number}>(sql`WITH ${mailboxEventCtes(source)} SELECT count(*)::int AS n FROM queued`)).rows[0]!.n;
}

type EventScope = { mailboxIds: string[] | null; includeStored: boolean };
function visibleEvents(workspaceId: string, environment: Mode, { mailboxIds, includeStored }: EventScope) {
  // All mailboxes is not workspace access: mailbox keys cannot see null-mailbox events.
  return and(eq(mailboxEvents.workspaceId, workspaceId), eq(mailboxEvents.environment, environment),
    mailboxIds !== null ? inArray(mailboxEvents.mailboxId, mailboxIds) : includeStored ? undefined : isNotNull(mailboxEvents.mailboxId));
}
export async function readEvents(db: DbExecutor, workspaceId: string, environment: Mode, input: EventScope & { after: number; types?: string[]; limit: number }) {
  return db.select().from(mailboxEvents).where(and(visibleEvents(workspaceId, environment, input), gt(mailboxEvents.seq, input.after),
    input.types?.length ? inArray(mailboxEvents.type, input.types.map(storedEventType)) : undefined)).orderBy(mailboxEvents.seq).limit(input.limit);
}
export async function latestCursor(db: DbExecutor, workspaceId: string, environment: Mode, scope: EventScope) {
  const [result] = await db.select({ seq: max(mailboxEvents.seq) }).from(mailboxEvents).where(visibleEvents(workspaceId, environment, scope));
  return result?.seq ?? 0;
}

const webhookJob: JobHandler = async (runtime, payload, job) => {
  const [delivery] = await runtime.db.select().from(mailboxWebhookDeliveries).where(and(eq(mailboxWebhookDeliveries.workspaceId, job.workspaceId), eq(mailboxWebhookDeliveries.environment, job.environment), eq(mailboxWebhookDeliveries.id, String(payload.deliveryId))));
  if (!delivery || delivery.status === 'delivered') return;
  const [endpoint] = await runtime.db.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, job.workspaceId), eq(mailboxWebhooks.environment, job.environment), eq(mailboxWebhooks.id, delivery.webhookId)));
  const where = eq(mailboxWebhookDeliveries.id, delivery.id);
  if (!endpoint) { await runtime.db.update(mailboxWebhookDeliveries).set({ status: 'failed', lastError: 'ENDPOINT_DELETED', updatedAt: new Date().toISOString() }).where(where); return; }
  // The subscription may have narrowed since this delivery was queued.
  if (!subscribedWireType(endpoint, delivery.payload.type, delivery.payload.mailboxId)) {
    await runtime.db.update(mailboxWebhookDeliveries).set({ status: 'failed', lastError: 'SUBSCRIPTION_CHANGED', updatedAt: new Date().toISOString() }).where(where); return;
  }
  let statusCode: number | null = null, error: string | null = null, retryable = true;
  try {
    const url = webhookUrl(runtime, endpoint.url);
    const secret = await decrypt(runtime, endpoint.encryptedSecret, webhookSecretBinding(job.workspaceId, job.environment, endpoint.id));
    // Pending pre-upgrade snapshots only have mailboxId. Add the alias on the wire without rewriting history.
    const body = JSON.stringify(webhookPayload(delivery.payload)), timestamp = String(Math.floor(Date.now() / 1000)), eventId = String(delivery.payload.id);
    const signature = await hmac(secret, `${eventId}.${timestamp}.${body}`);
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Id': eventId, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': 'OpenSend-Mailbox-Webhooks/1.0' }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    statusCode = result.status; await result.body?.cancel(); if (!result.ok) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < MAX_ATTEMPTS;
  await runtime.db.update(mailboxWebhookDeliveries).set({ attemptCount: sql`${mailboxWebhookDeliveries.attemptCount} + 1`, status: !error ? 'delivered' : retry ? 'pending' : 'failed', lastStatusCode: statusCode, lastError: error, updatedAt: new Date().toISOString() }).where(where);
  if (error) throw new ApiError(503, error, 'Mailbox webhook delivery failed; it will be retried.', undefined, retry);
};

export async function pruneMailboxEvents(runtime: Runtime) {
  await runtime.db.execute(sql`WITH expired AS (DELETE FROM mailbox_events WHERE created_at < now() - interval '30 days')
    DELETE FROM mailbox_webhook_deliveries WHERE created_at < now() - interval '30 days' AND status <> 'pending'`);
  log('info', { code: 'MAILBOX_EVENTS_PRUNED' });
}

export const mailboxEventJobs: Record<string, JobHandler> = { 'mailbox.webhook': webhookJob };
