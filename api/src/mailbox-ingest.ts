import { copyWorkspaceRaw } from './mailbox-mime.js';
import { storeIncoming } from './mailbox-ingest-store.js';
import PostalMime, { type Address, type Email } from 'postal-mime';
import { and, eq, sql } from 'drizzle-orm';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { ApiError, digest, log, type JobHandler, type Runtime } from './core.js';
import { JobDeferred, MAX_ATTEMPTS } from './jobs.js';
import { mailAttachments, mailReceipts, type MailAddress, type MailHeader, type Verdicts } from './db/mailbox.js';
import { pruneMailboxEvents } from './mailbox-events.js';
import { mailboxS3, STAGING_PREFIX, workspacePrefix, refreshMailboxDns, storageBinding } from './mailbox-setup.js';
import { messageIdList, normalizeMessageId, snippetOf, type Scope } from './mailbox-store.js';
import { claimReceives, connectionReady, poolReceives } from './states.js';

const PARSE_LIMIT = 6 * 1024 * 1024; // Larger or line-heavy messages keep headers and raw MIME only (Worker memory).
const PARSE_LINE_LIMIT = 30_000;
const BODY_LIMIT = 1_000_000;
const MAX_ATTACHMENTS = 100; // More parts would exhaust the Worker subrequest budget; the message is stored without them.
const HEADER_LIMIT = 64 * 1024;

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
  const action = message.receipt?.action;
  const sesMessageId = message.mail?.messageId;
  const legacy=!runtime.config.multiTenant && action?.objectKey===`raw/${sesMessageId}`;
  if (!action?.bucketName || action.type !== 'S3' || action.topicArn !== input.topicArn || (!legacy && action.objectKey!==STAGING_PREFIX+sesMessageId) || typeof sesMessageId !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/.test(sesMessageId)) {
    throw new ApiError(403, 'MAILBOX_NOTIFICATION_UNTRUSTED', 'The inbound notification does not match this installation’s receiving resources.');
  }
  const recipients=[...new Set((message.receipt?.recipients ?? []).filter((s):s is string=>typeof s==='string' && /^[^@\s]+@[^@\s]+$/.test(s)).map(s=>s.toLowerCase()))];
  // Never persist the original SNS payload. It includes mail.destination, full envelope and SES trace headers.
  const {timestamp,spamVerdict,virusVerdict,spfVerdict,dkimVerdict,dmarcVerdict}=message.receipt!;
  const common=message.mail?.commonHeaders;
  const metadata={mail:{source:message.mail?.source,timestamp:message.mail?.timestamp,commonHeaders:{from:common?.from,subject:common?.subject,messageId:common?.messageId}},receipt:{timestamp,spamVerdict,virusVerdict,spfVerdict,dkimVerdict,dmarcVerdict},legacy};
  const account=input.topicArn.split(':')[4],hosted=runtime.config.multiTenant;
  // A delayed/replayed signed notification must not transfer yesterday's mail to a new domain owner.
  const receivedAt=timestamp ?? message.mail?.timestamp;
  if (hosted && (!receivedAt || !Number.isFinite(Date.parse(receivedAt)))) throw new ApiError(400,'SES_INVALID_EVENT','The receiving timestamp is missing or invalid.');
  const at=receivedAt && Number.isFinite(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : null;
  const binding=hosted ? sql`SELECT NULL::text AS wid,'shared' AS kind FROM provider_pool_regions p WHERE aws_account_id=${account} AND region=${input.region} AND inbound_topic_arn=${input.topicArn} AND inbound_bucket=${action.bucketName} AND ${poolReceives()}
    UNION ALL SELECT c.workspace_id,'byo' FROM provider_connections c JOIN mailbox_regions r ON r.workspace_id=c.workspace_id AND r.region=c.region AND r.account_id=c.aws_account_id
    WHERE c.kind='byo' AND ${connectionReady(sql`c`)} AND c.region=${input.region} AND c.aws_account_id=${account} AND r.topic_arn=${input.topicArn} AND r.bucket=${action.bucketName}` : sql`SELECT workspace_id AS wid,'self' AS kind FROM mailbox_regions WHERE region=${input.region} AND topic_arn=${input.topicArn} AND bucket=${action.bucketName}`;
  const result=await runtime.db.execute<{trusted:boolean;n:number}>(sql`WITH binding AS (${binding}), env AS (
    SELECT addr,split_part(addr,'@',2) AS host FROM jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb) e(addr)
  ), matched AS (
    SELECT m.workspace_id AS wid,e.addr FROM env e JOIN mailbox_domains m ON ${hosted?sql`m.receiving_host`:sql`m.name`}=e.host AND m.region=${input.region}
    JOIN binding b ON b.wid=m.workspace_id OR b.kind='shared' WHERE ${hosted ? sql`EXISTS (
      SELECT 1 FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id AND dc.receiving_host=e.host AND ${claimReceives()}
      JOIN provider_connections c ON c.id=dc.connection_id AND c.workspace_id=dc.workspace_id AND c.kind=b.kind AND c.region=d.region AND ${connectionReady(sql`c`)} AND c.aws_account_id=${account}
      WHERE d.id=m.domain_id AND d.workspace_id=m.workspace_id AND d.region=m.region AND d.created_at<=${at}::timestamptz)` : sql`m.status IN ('provisioning','waiting_for_mx','active') AND (m.parent_id IS NULL OR EXISTS (SELECT 1 FROM mailbox_domains parent WHERE parent.id=m.parent_id AND parent.workspace_id=m.workspace_id AND parent.status IN ('provisioning','waiting_for_mx','active')))`}
  ), receipts AS (INSERT INTO mail_receipts(workspace_id,ses_message_id,region,bucket,object_key,recipients,notification)
    SELECT wid,${sesMessageId},${input.region},${action.bucketName},'workspaces/'||wid||'/raw/'||${sesMessageId}||'.eml',jsonb_agg(addr ORDER BY addr),${JSON.stringify(metadata)}::jsonb FROM matched GROUP BY wid ON CONFLICT DO NOTHING RETURNING workspace_id
  ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.ingest',workspace_id,jsonb_build_object('sesMessageId',${sesMessageId}::text) FROM receipts RETURNING 1)
  SELECT EXISTS(SELECT 1 FROM binding) AS trusted,(SELECT count(*)::int FROM queued) AS n`);
  if (!result.rows[0]?.trusted) throw new ApiError(403,'MAILBOX_NOTIFICATION_UNTRUSTED','Unknown receiving account, topic or bucket.');
  return result.rows[0].n;
}

const flatten = (list: Address[] | Address | undefined): MailAddress[] => (Array.isArray(list) ? list : list ? [list] : []).flatMap(item => item.group ? item.group : [item])
  .filter(item => typeof item.address === 'string' && item.address.includes('@')).map(item => ({ name: item.name?.trim() || null, address: item.address!.trim().toLowerCase() }));
const verdict = (value: { status?: string } | undefined) => typeof value?.status === 'string' ? value.status : undefined;
const cap = (value: string | undefined | null) => value && value.length > BODY_LIMIT ? { value: value.slice(0, BODY_LIMIT), truncated: true } : { value: value ?? null, truncated: false };
function headersOf(email: Email | null): MailHeader[] {
  const out: MailHeader[] = []; let size = 0;
  for (const header of email?.headers ?? []) { if (header.key==='bcc' || header.key==='resent-bcc') continue; size += header.originalKey.length + header.value.length; if (size > HEADER_LIMIT || out.length >= 200) break; out.push({ name: header.originalKey, value: header.value }); }
  return out;
}
function automated(email: Email | null, from: string) {
  const header = (name: string) => email?.headers.find(item => item.key === name)?.value.toLowerCase() ?? '';
  const auto = header('auto-submitted');
  return (auto !== '' && auto !== 'no') || /^(?:bulk|junk|list|auto_reply)$/.test(header('precedence')) || !!header('x-autoreply') || !!header('x-autorespond')
    || /^(?:mailer-daemon|postmaster)@/.test(from) || /multipart\/report/.test(header('content-type'));
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
function withinLineLimit(raw: Uint8Array) {
  let lines = raw.byteLength > 0 && raw[raw.byteLength - 1] !== 10 ? 1 : 0;
  for (let i = 0; i < raw.byteLength; i++) if (raw[i] === 10 && ++lines > PARSE_LINE_LIMIT) return false;
  return lines <= PARSE_LINE_LIMIT;
}

const ingestJob: JobHandler = async (runtime, payload, job) => {
  const scope: Scope = { workspaceId: job.workspaceId };
  const sesMessageId = String(payload.sesMessageId ?? '');
  const [read] = await runtime.db.select({receipt:mailReceipts,binding:runtime.config.multiTenant ? storageBinding(scope.workspaceId,sql`mail_receipts.region`,sql`mail_receipts.bucket`) : sql<null>`NULL`}).from(mailReceipts).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId)));
  const receipt=read?.receipt;
  if (!receipt || receipt.status !== 'pending') return;
  const notification = receipt.notification as ReceivedNotification;
  const s3 = await mailboxS3(runtime,scope.workspaceId,receipt.region,receipt.bucket,runtime.db,read!.binding);
  const sourceKey=(!runtime.config.multiTenant && (receipt.notification.legacy || receipt.objectKey.startsWith('raw/'))?'raw/':STAGING_PREFIX)+sesMessageId;
  const rawKey=workspacePrefix(scope.workspaceId,'raw')+sesMessageId+'.eml';
  let raw: Uint8Array;
  try {
    raw=await copyWorkspaceRaw(s3,receipt.region,receipt.bucket,sourceKey,rawKey,receipt.recipients,'raw');
  } catch (error) {
    s3.destroy();
    const terminal = error instanceof ApiError && error.code === 'RAW_MESSAGE_TOO_LARGE' ? error.code :
      error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound') ? 'RAW_MESSAGE_MISSING' : null;
    if (terminal) {
      await runtime.db.update(mailReceipts).set({ status: 'failed', error: terminal, processedAt: new Date().toISOString() }).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId), eq(mailReceipts.status, 'pending')));
      return;
    }
    throw new ApiError(503, 'MAILBOX_RAW_UNAVAILABLE', 'The stored message could not be read from S3; retrying.', undefined, true);
  }
  let email: Email | null = null, status = 'received';
  if (raw.byteLength <= PARSE_LIMIT && withinLineLimit(raw)) {
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
  const sesTimestamp = [notification.receipt?.timestamp, notification.mail?.timestamp].find(value => value && Number.isFinite(Date.parse(value)));
  const receivedAt = sesTimestamp ? new Date(sesTimestamp).toISOString() : receipt.createdAt;
  const sentAt = email?.date && Number.isFinite(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;

  // Attachments are uploaded before the database commit with deterministic keys, so retries overwrite rather than duplicate.
  const attachments: (typeof mailAttachments.$inferInsert)[] = [];
  const skipAttachments = (email?.attachments.length ?? 0) > MAX_ATTACHMENTS;
  if (skipAttachments) log('warn', { code: 'MAILBOX_ATTACHMENTS_SKIPPED', count: email!.attachments.length, limit: MAX_ATTACHMENTS });
  let uploadFailed = false;
  try {
    for (const [index, part] of (skipAttachments ? [] : email?.attachments ?? []).entries()) {
      const bytes = part.content instanceof ArrayBuffer ? part.content : typeof part.content === 'string' ? new TextEncoder().encode(part.content).buffer as ArrayBuffer : (part.content.buffer as ArrayBuffer).slice(part.content.byteOffset, part.content.byteOffset + part.content.byteLength);
      const attachmentId = `matt_${(await digest(`${messageRowId}:${index}`)).slice(0, 32)}`;
      const key = `${workspacePrefix(scope.workspaceId,'att')}${messageRowId}/${attachmentId}`;
      const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(part.mimeType) ? part.mimeType : 'application/octet-stream';
      await s3.send(new PutObjectCommand({ Bucket: receipt.bucket, Key: key, Body: new Uint8Array(bytes), ContentType: contentType }));
      attachments.push({ id: attachmentId, ...scope, messageId: messageRowId, filename: (part.filename ?? `attachment-${index + 1}`).slice(0, 255), contentType, sizeBytes: bytes.byteLength, contentId: normalizeMessageId(part.contentId), disposition: part.disposition === 'inline' || part.related ? 'inline' as const : 'attachment' as const, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), bucket: receipt.bucket, storageKey: key });
    }
  } catch { uploadFailed = true; }
  finally { s3.destroy(); }
  if (uploadFailed) {
    // On the last attempt the receipt is marked failed so hourly recovery stops re-queuing it.
    if (job.attempts >= MAX_ATTEMPTS) { await runtime.db.update(mailReceipts).set({ status: 'failed', error: 'ATTACHMENT_UPLOAD_FAILED', processedAt: new Date().toISOString() }).where(and(eq(mailReceipts.workspaceId, scope.workspaceId), eq(mailReceipts.sesMessageId, sesMessageId))); log('error', { code: 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', final: true }); return; }
    throw new ApiError(503, 'MAILBOX_ATTACHMENT_UPLOAD_FAILED', 'An attachment could not be stored in S3; retrying.', undefined, true);
  }

  const runnable = await runtime.db.transaction(async tx => {
    await tx.execute(sql`INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(${scope.workspaceId},'ingest'),(${scope.workspaceId},'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false`);
    return storeIncoming(tx,{
        id: messageRowId, ...scope, direction: 'inbound', region: receipt.region, sesMessageId, messageId, inReplyTo, references, subject,
         fromAddress: from.address, fromName: from.name, to: flatten(email?.to), cc: flatten(email?.cc), bcc: [], replyTo: flatten(email?.replyTo),
        envelopeFrom: notification.mail?.source?.toLowerCase() ?? null, envelopeTo: receipt.recipients, sentAt, receivedAt,
        text: text.value, html: html.value, bodyTruncated: text.truncated || html.truncated || status === 'unparsed' || skipAttachments, snippet: snippetOf(text.value, html.value),
        headers: headersOf(email), attachmentCount: attachments.length, sizeBytes: raw.byteLength, rawBucket: receipt.bucket, rawKey,
        verdicts, spam, automated: automated(email, from.address), status,
      },attachments);
  });
  log('info', { code: 'MAILBOX_MESSAGE_INGESTED', status, bytes: raw.byteLength, attachments: attachments.length });
  if (runnable > 0) try { await runtime.wake?.(runnable); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox webhook jobs remain durable.' }); }
};

/** Re-queues receipts whose ingest job was lost (for example after a failed attempt ceiling). Hourly. */
export async function recoverMailReceipts(runtime: Runtime) {
  await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.ingest',r.workspace_id,jsonb_build_object('sesMessageId',r.ses_message_id) FROM mail_receipts r WHERE r.status='pending' AND r.created_at < now() - interval '30 minutes'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = r.workspace_id AND j.type = 'mailbox.ingest' AND j.status IN ('pending','running') AND j.payload->>'sesMessageId' = r.ses_message_id) LIMIT 100`);
}

/** Hourly mailbox upkeep: MX status, lost-receipt recovery and event retention. Each step is best-effort. */
export async function mailboxHourly(runtime: Runtime) {
  for (const [code, work] of [['MAILBOX_DNS_REFRESH_FAILED', refreshMailboxDns], ['MAILBOX_RECEIPT_RECOVERY_FAILED', recoverMailReceipts], ['MAILBOX_EVENT_PRUNE_FAILED', pruneMailboxEvents]] as const) {
    try { await work(runtime); } catch (error) { log('warn', { code: error instanceof ApiError ? error.code : code }); }
  }
}

// One MIME working set per isolate, even across overlapping queue drains. Never share request I/O:
// another job stays in Postgres and JobDeferred returns its attempt rather than waiting in memory.
let ingestActive = false;
export const mailboxIngestJobs: Record<string, JobHandler> = { 'mailbox.ingest': async (runtime, payload, job) => {
  if (ingestActive) throw new JobDeferred(new Date(Date.now() + 2_000).toISOString());
  ingestActive = true;
  try { await ingestJob(runtime, payload, job); } finally { ingestActive = false; }
} };
