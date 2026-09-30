import PostalMime, { type Address, type Email } from 'postal-mime';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ApiError, digest, log, type JobHandler, type Mode, type Runtime } from './core.js';
import { enqueue } from './jobs.js';
import { mailAttachments, mailboxDomains, mailboxRegions, mailboxThreads, mailMessageIds, mailMessages, mailReceipts, mailUnrouted, type MailAddress, type MailHeader, type Verdicts } from './db/mailbox.js';
import { pruneMailboxEvents, recordEvents, type MailboxEventInput } from './mailbox-events.js';
import { ATTACHMENT_PREFIX, mailboxS3, RAW_PREFIX, refreshMailboxDns } from './mailbox-setup.js';
import { assignThread, attachToMailboxes, messageIdList, normalizeMessageId, rememberMessageIds, routeRecipients, snippetOf, type Scope } from './mailbox-store.js';

const PARSE_LIMIT = 25 * 1024 * 1024; // Larger messages keep headers and raw MIME only (Worker memory).
const BODY_LIMIT = 1_000_000;
const HEADER_LIMIT = 64 * 1024;
const live: Scope['environment'] = 'live';

type ReceivedNotification = {
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string; source?: string; destination?: string[]; commonHeaders?: { from?: string[]; to?: string[]; subject?: string; messageId?: string; date?: string } };
  receipt?: { timestamp?: string; recipients?: string[]; spamVerdict?: { status?: string }; virusVerdict?: { status?: string }; spfVerdict?: { status?: string }; dkimVerdict?: { status?: string }; dmarcVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string; topicArn?: string } };
};

/**
 * Handles a verified SNS notification from an inbound topic. Stores the receipt and queues ingestion
 * in one transaction; SNS retries anything that fails before commit. Non-receipt notifications are acknowledged.
 */
export async function acceptInboundNotification(runtime: Runtime, input: { topicArn: string; region: string; message: unknown }): Promise<number> {
  const message = input.message as ReceivedNotification;
  if (message?.notificationType !== 'Received') { log('info', { code: 'MAILBOX_NOTIFICATION_IGNORED', type: String(message?.notificationType ?? 'unknown') }); return 0; }
  const [region] = await runtime.db.select().from(mailboxRegions).where(and(eq(mailboxRegions.workspaceId, runtime.config.workspaceId), eq(mailboxRegions.topicArn, input.topicArn)));
  const action = message.receipt?.action;
  const sesMessageId = message.mail?.messageId;
  if (!region?.bucket || action?.type !== 'S3' || action.bucketName !== region.bucket || action.topicArn !== input.topicArn || typeof action.objectKey !== 'string' || !action.objectKey.startsWith(RAW_PREFIX) || typeof sesMessageId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(sesMessageId)) {
    throw new ApiError(403, 'MAILBOX_NOTIFICATION_UNTRUSTED', 'The inbound notification does not match this installation’s receiving resources.');
  }
  const recipients = [...new Set((message.receipt?.recipients ?? []).filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()))].slice(0, 100);
  return runtime.db.transaction(async tx => {
    const [inserted] = await tx.insert(mailReceipts).values({ workspaceId: runtime.config.workspaceId, sesMessageId, environment: live, region: region.region, bucket: region.bucket!, objectKey: action.objectKey!, recipients, notification: message as Record<string, unknown> }).onConflictDoNothing().returning({ id: mailReceipts.sesMessageId });
    if (!inserted) return 0;
    await enqueue(tx, { type: 'mailbox.ingest', workspaceId: runtime.config.workspaceId, environment: live, payload: { sesMessageId } });
    return 1;
  });
}

const flatten = (list: Address[] | Address | undefined): MailAddress[] => (Array.isArray(list) ? list : list ? [list] : []).flatMap(item => item.group ? item.group : [item])
  .filter(item => typeof item.address === 'string' && item.address.includes('@')).map(item => ({ name: item.name?.trim() || null, address: item.address!.trim().toLowerCase() }));
const verdict = (value: { status?: string } | undefined) => typeof value?.status === 'string' ? value.status : undefined;
const cap = (value: string | undefined | null) => value && value.length > BODY_LIMIT ? { value: value.slice(0, BODY_LIMIT), truncated: true } : { value: value ?? null, truncated: false };
function headersOf(email: Email | null): MailHeader[] {
  const out: MailHeader[] = []; let size = 0;
  for (const header of email?.headers ?? []) { size += header.originalKey.length + header.value.length; if (size > HEADER_LIMIT || out.length >= 200) break; out.push({ name: header.originalKey, value: header.value }); }
  return out;
}
function automated(email: Email | null, from: string) {
  const header = (name: string) => email?.headers.find(item => item.key === name)?.value.toLowerCase() ?? '';
  const auto = header('auto-submitted');
  return (auto !== '' && auto !== 'no') || /^(?:bulk|junk|list|auto_reply)$/.test(header('precedence')) || !!header('x-autoreply') || !!header('x-autorespond')
    || /^(?:mailer-daemon|postmaster)@/.test(from) || /multipart\/report/.test(header('content-type'));
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

const ingestJob: JobHandler = async (runtime, payload, job) => {
  const scope: Scope = { workspaceId: job.workspaceId, environment: live as Mode };
  const sesMessageId = String(payload.sesMessageId ?? '');
  const [receipt] = await runtime.db.select().from(mailReceipts).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId)));
  if (!receipt || receipt.status === 'processed') return;
  const notification = receipt.notification as ReceivedNotification;
  // Only store mail addressed to a receiving domain. This skips SES's own setup notification
  // (sent to recipient@example.com when a receipt rule is created) and anything else off-domain.
  const domainNames = [...new Set(receipt.recipients.map(value => value.split('@')[1] ?? '').filter(Boolean))];
  const receiving = domainNames.length ? await runtime.db.select({ name: mailboxDomains.name }).from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, scope.workspaceId), eq(mailboxDomains.environment, scope.environment), inArray(mailboxDomains.name, domainNames))) : [];
  if (!receiving.length) {
    await runtime.db.update(mailReceipts).set({ status: 'processed', error: 'NO_RECEIVING_DOMAIN', processedAt: new Date().toISOString() }).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId)));
    log('info', { code: 'MAILBOX_RECEIPT_SKIPPED', reason: 'NO_RECEIVING_DOMAIN' });
    return;
  }
  const s3 = mailboxS3(runtime, receipt.region);
  let raw: Uint8Array;
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: receipt.bucket, Key: receipt.objectKey }));
    raw = await object.Body!.transformToByteArray();
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      s3.destroy();
      await runtime.db.update(mailReceipts).set({ status: 'failed', error: 'RAW_MESSAGE_MISSING', processedAt: new Date().toISOString() }).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId)));
      return;
    }
    s3.destroy();
    throw new ApiError(503, 'MAILBOX_RAW_UNAVAILABLE', 'The stored message could not be read from S3; retrying.', undefined, true);
  }
  let email: Email | null = null, status = 'received';
  if (raw.byteLength <= PARSE_LIMIT) {
    try { email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' }); } catch { status = 'unparsed'; }
  } else status = 'unparsed';
  const common = notification.mail?.commonHeaders ?? {};
  const messageRowId = `msg_${(await digest(`${scope.workspaceId}:${sesMessageId}`)).slice(0, 32)}`;
  const from = flatten(email?.from)[0] ?? { name: null, address: (common.from?.[0]?.match(/<([^>]+)>/)?.[1] ?? common.from?.[0] ?? notification.mail?.source ?? '').trim().toLowerCase() };
  const verdicts: Verdicts = { spf: verdict(notification.receipt?.spfVerdict), dkim: verdict(notification.receipt?.dkimVerdict), dmarc: verdict(notification.receipt?.dmarcVerdict), spam: verdict(notification.receipt?.spamVerdict), virus: verdict(notification.receipt?.virusVerdict) };
  const spam = verdicts.spam === 'FAIL' || verdicts.virus === 'FAIL';
  const messageId = normalizeMessageId(email?.messageId ?? common.messageId);
  const inReplyTo = normalizeMessageId(email?.inReplyTo);
  const references = messageIdList(email?.references);
  const subject = (email?.subject ?? common.subject ?? '').slice(0, 998);
  const text = cap(email?.text), html = cap(email?.html);
  const receivedAt = notification.receipt?.timestamp && Number.isFinite(Date.parse(notification.receipt.timestamp)) ? new Date(notification.receipt.timestamp).toISOString() : new Date().toISOString();
  const sentAt = email?.date && Number.isFinite(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;

  // Attachments are uploaded before the database commit with deterministic keys, so retries overwrite rather than duplicate.
  const attachments: (typeof mailAttachments.$inferInsert)[] = [];
  try {
    for (const [index, part] of (email?.attachments ?? []).entries()) {
      const bytes = part.content instanceof ArrayBuffer ? part.content : typeof part.content === 'string' ? new TextEncoder().encode(part.content).buffer as ArrayBuffer : (part.content.buffer as ArrayBuffer).slice(part.content.byteOffset, part.content.byteOffset + part.content.byteLength);
      const attachmentId = `matt_${(await digest(`${messageRowId}:${index}`)).slice(0, 32)}`;
      const key = `${ATTACHMENT_PREFIX}${messageRowId}/${attachmentId}`;
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : 'application/octet-stream';
      await s3.send(new PutObjectCommand({ Bucket: receipt.bucket, Key: key, Body: new Uint8Array(bytes), ContentType: contentType }));
      attachments.push({ id: attachmentId, ...scope, messageId: messageRowId, filename: (part.filename ?? `attachment-${index + 1}`).slice(0, 255), contentType, sizeBytes: bytes.byteLength, contentId: normalizeMessageId(part.contentId), disposition: part.disposition === 'inline' || part.related ? 'inline' as const : 'attachment' as const, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), bucket: receipt.bucket, storageKey: key });
    }
  } catch { throw new ApiError(503, 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', 'An attachment could not be stored in S3; retrying.', undefined, true); }
  finally { s3.destroy(); }

  const runnable = await runtime.db.transaction(async tx => {
    const events: MailboxEventInput[] = [];
    const done = () => tx.update(mailReceipts).set({ status: 'processed', error: null, processedAt: new Date().toISOString() }).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId)));
    const [existingRow] = await tx.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.id, messageRowId));
    if (existingRow) { await done(); return 0; }
    // The same message delivered in separate SMTP transactions (for example to two receiving domains)
    // becomes one stored message; the later receipt only adds its recipients.
    let target: typeof mailMessages.$inferSelect | undefined;
    if (messageId) {
      const [known] = await tx.select({ id: mailMessageIds.mailMessageId }).from(mailMessageIds).where(and(eq(mailMessageIds.workspaceId, scope.workspaceId), eq(mailMessageIds.environment, scope.environment), eq(mailMessageIds.messageId, messageId)));
      if (known) {
        const [row] = await tx.select().from(mailMessages).where(eq(mailMessages.id, known.id));
        if (row?.direction === 'inbound' && row.fromAddress === from.address && row.subject === subject) target = row;
      }
    }
    if (!target) {
      const threadId = await assignThread(tx, scope, { inReplyTo, references, subject, at: receivedAt, messageId });
      const [row] = await tx.insert(mailMessages).values({
        id: messageRowId, ...scope, direction: 'inbound', threadId, region: receipt.region, sesMessageId, messageId, inReplyTo, references, subject,
        fromAddress: from.address, fromName: from.name, to: flatten(email?.to), cc: flatten(email?.cc), bcc: flatten(email?.bcc), replyTo: flatten(email?.replyTo),
        envelopeFrom: notification.mail?.source?.toLowerCase() ?? null, envelopeTo: receipt.recipients, sentAt, receivedAt,
        text: text.value, html: html.value, bodyTruncated: text.truncated || html.truncated || status === 'unparsed', snippet: snippetOf(text.value, html.value),
        headers: headersOf(email), attachmentCount: attachments.length, sizeBytes: raw.byteLength, rawBucket: receipt.bucket, rawKey: receipt.objectKey,
        verdicts, spam, automated: automated(email, from.address), status,
      }).returning();
      target = row!;
      if (attachments.length) await tx.insert(mailAttachments).values(attachments).onConflictDoNothing();
      await rememberMessageIds(tx, scope, target.id, threadId, [messageId]);
    }
    const routed = await routeRecipients(tx, scope, receipt.recipients, { allowCreate: !spam });
    let mailboxIds = routed.mailboxIds;
    // Replies addressed elsewhere (for example a forwarded thread) stay with the mailboxes already in the conversation.
    if (!mailboxIds.length) mailboxIds = (await tx.selectDistinct({ id: mailboxThreads.mailboxId }).from(mailboxThreads).where(eq(mailboxThreads.threadId, target.threadId))).map(row => row.id);
    if (routed.unrouted.length) await tx.insert(mailUnrouted).values(routed.unrouted.map(address => ({ ...scope, messageId: target!.id, address }))).onConflictDoNothing();
    const added = await attachToMailboxes(tx, scope, target, mailboxIds);
    for (const mailboxId of routed.created) events.push({ type: 'mailbox.created', mailboxId, data: { origin: 'auto' } });
    for (const mailboxId of added) events.push({ type: 'message.received', mailboxId, threadId: target.threadId, messageId: target.id, data: { from: { name: target.fromName, address: target.fromAddress }, subject: target.subject, snippet: target.snippet, attachmentCount: target.attachmentCount, spam: target.spam, automated: target.automated } });
    await done();
    return recordEvents(tx, scope.workspaceId, scope.environment, events);
  });
  log('info', { code: 'MAILBOX_MESSAGE_INGESTED', status, bytes: raw.byteLength, attachments: attachments.length });
  if (runnable > 0) try { await runtime.wake?.(runnable); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox webhook jobs remain durable.' }); }
};

/** Re-queues receipts whose ingest job was lost (for example after a failed attempt ceiling). Hourly. */
export async function recoverMailReceipts(runtime: Runtime) {
  const stale = await runtime.db.execute<{ ses_message_id: string }>(sql`SELECT r.ses_message_id FROM mail_receipts r WHERE r.workspace_id = ${runtime.config.workspaceId} AND r.status = 'pending' AND r.created_at < now() - interval '30 minutes'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = r.workspace_id AND j.type = 'mailbox.ingest' AND j.status IN ('pending','running') AND j.payload->>'sesMessageId' = r.ses_message_id) LIMIT 100`);
  for (const row of stale.rows) await enqueue(runtime.db, { type: 'mailbox.ingest', workspaceId: runtime.config.workspaceId, environment: live, payload: { sesMessageId: row.ses_message_id } });
  if (stale.rows.length) log('warn', { code: 'MAILBOX_RECEIPTS_REQUEUED', count: stale.rows.length });
}

/** Hourly mailbox upkeep: MX status, lost-receipt recovery and event retention. Each step is best-effort. */
export async function mailboxHourly(runtime: Runtime) {
  for (const [code, work] of [['MAILBOX_DNS_REFRESH_FAILED', refreshMailboxDns], ['MAILBOX_RECEIPT_RECOVERY_FAILED', recoverMailReceipts], ['MAILBOX_EVENT_PRUNE_FAILED', pruneMailboxEvents]] as const) {
    try { await work(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : code }); }
  }
}

export const mailboxIngestJobs: Record<string, JobHandler> = { 'mailbox.ingest': ingestJob };
