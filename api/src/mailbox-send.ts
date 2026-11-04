import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { ApiError, isSimulatedSes, digest, id, log, type Actor, type DbExecutor, type Runtime } from './core.js';
import { attachmentLinks, attachments as sendingAttachments, emails } from './db/sending.js';
import { domains } from './db/operations.js';
import { unverifiedSender, verifiedClaim } from './domain-claims.js';
import { mailAttachments, mailboxAddresses, mailboxDomains, mailboxes, mailboxMessages, mailMessages, mailThreads, type MailAddress, type SendLimits } from './db/mailbox.js';
import { recordEvents, mailboxEventCtes } from './mailbox-events.js';
import { assertMailboxKey,readableMailboxKey,workspacePrefix, mailboxS3 } from './mailbox-setup.js';
import { attachToMailboxes, htmlToPlain, messageIdList, normalizeSubject, sesMessageId, snippetOf, type Scope } from './mailbox-store.js';
import { queueMailboxEmail, storeAttachmentBytes, verifiedAttachment, type SendRequest } from './sending.js';

export const DEFAULT_SEND_LIMITS: SendLimits = { perHour: 100, perDay: 1000, perRecipientPerHour: 20, perThreadPer10Minutes: 10 };
export const sendLimitsFor = (mailbox: typeof mailboxes.$inferSelect): SendLimits => ({ ...DEFAULT_SEND_LIMITS, ...mailbox.sendLimits });
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Local parts that never read replies (RFC 3834 recommends not auto-replying to these).
export const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)(?:[+._-].*)?@/i;

export type AttachmentInput = { content: string; filename: string; contentType?: string; disposition?: 'attachment' | 'inline'; contentId?: string } | { id: string };
type ResolvedAttachment = typeof sendingAttachments.$inferSelect;
const ownsUpload = (wid: string, file: ResolvedAttachment) => file.sourceTemplateAssetId
  ? file.storageKey === `${wid}/templates/assets/${file.sourceTemplateAssetId}`
  : file.storageKey === `${wid}/attachments/${file.id}` || file.storageKey === `${wid}/live/attachments/${file.id}`;
type MailboxRow = typeof mailboxes.$inferSelect;
type MessageRow = typeof mailMessages.$inferSelect;

/** Resolve to immutable sending uploads before admission, never inside a message transaction. */
export async function resolveAttachments(runtime:Runtime, mailbox:MailboxRow, items:AttachmentInput[],from:string):Promise<ResolvedAttachment[]> {
  const scope={workspaceId:mailbox.workspaceId}, out:ResolvedAttachment[]=[];
  if(items.length && runtime.config.multiTenant && !(await runtime.db.execute(sql`SELECT 1 FROM mailbox_domains d WHERE d.id=${mailbox.domainId} AND d.workspace_id=${scope.workspaceId} AND ${verifiedClaim(sql`d.workspace_id`,sql`d.region`,sql`${from.split('@')[1]!.toLowerCase()}::text`,runtime)}`)).rowCount)throw unverifiedSender();
  for(const item of items){
    if ('content' in item){
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.content) || item.content.length%4) throw new ApiError(422,'ATTACHMENT_CONTENT_INVALID','Use standard padded base64.','attachments');
      out.push(await storeAttachmentBytes(runtime,scope,{filename:item.filename,contentType:item.contentType??'application/octet-stream',contentId:item.contentId,disposition:item.disposition},Buffer.from(item.content,'base64')));
    } else if(item.id.startsWith('matt_')){
      const [file]=await runtime.db.select({file:mailAttachments,region:mailMessages.region}).from(mailAttachments).innerJoin(mailMessages,eq(mailMessages.id,mailAttachments.messageId))
        .innerJoin(mailboxMessages,and(eq(mailboxMessages.messageId,mailAttachments.messageId),eq(mailboxMessages.mailboxId,mailbox.id))).where(and(eq(mailAttachments.workspaceId,scope.workspaceId),eq(mailAttachments.id,item.id)));
      if(!file?.region) throw new ApiError(404,'ATTACHMENT_NOT_FOUND','The attachment was not found in this mailbox.','attachments');
      const s3=await mailboxS3(runtime,scope.workspaceId,file.region,file.file.bucket);
      let bytes:Uint8Array;
      try {
        if(file.file.sourceId) await archiveMailboxFiles(runtime,scope.workspaceId,file.file.messageId,s3);
        const key=await readableMailboxKey(runtime,scope.workspaceId,file.region,file.file.bucket,file.file.storageKey,'att',runtime.db,s3);
        const object=await s3.send(new GetObjectCommand({Bucket:file.file.bucket,Key:key}));bytes=await object.Body!.transformToByteArray();
      } catch (e) {if(e instanceof ApiError) throw e; throw new ApiError(503,'ATTACHMENT_UNAVAILABLE','The attachment could not be read.','attachments',true);} finally{s3.destroy();}
      out.push(await storeAttachmentBytes(runtime,scope,{filename:file.file.filename,contentType:file.file.contentType,disposition:file.file.disposition,contentId:file.file.contentId??undefined},bytes));
    } else {
      const [source]=await runtime.db.select().from(sendingAttachments).where(and(eq(sendingAttachments.workspaceId,scope.workspaceId),eq(sendingAttachments.id,item.id)));
      if(!source || !ownsUpload(scope.workspaceId,source))throw new ApiError(404,'ATTACHMENT_NOT_FOUND','The upload was not found.','attachments');
      out.push(source);
    }
    if(out.reduce((sum,file)=>sum+file.size,0)>MAX_TOTAL_ATTACHMENT_BYTES)throw new ApiError(413,'ATTACHMENT_LIMIT_EXCEEDED','Attachments may not exceed 8 MiB combined.','attachments');
  }
  return out;
}

/** Post-commit archival. If the request dies, the upload remains pinned and a download can finish the exact same copy. */
export async function archiveMailboxFiles(runtime:Runtime,wid:string,messageId:string,client?:S3Client){
  const rows=await runtime.db.select({file:mailAttachments,source:sendingAttachments,region:mailMessages.region}).from(mailAttachments)
    .innerJoin(mailMessages,and(eq(mailMessages.id,mailAttachments.messageId),eq(mailMessages.workspaceId,wid)))
    .innerJoin(sendingAttachments,and(eq(sendingAttachments.id,mailAttachments.sourceId),eq(sendingAttachments.workspaceId,wid)))
    .where(and(eq(mailAttachments.workspaceId,wid),eq(mailAttachments.messageId,messageId)));
  if(!rows.length)return;
  const {region,file:first}=rows[0]!;
  if(!region || rows.some(r=>r.file.bucket!==first.bucket))throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Inconsistent storage binding.');
  const s3=client??await mailboxS3(runtime,wid,region,first.bucket);
  try {for(const {file,source} of rows){
    assertMailboxKey(wid,file.storageKey,'att');
    if(!ownsUpload(wid,source) || source.checksum!==file.sha256)throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Invalid archive source.');
    const bytes=await verifiedAttachment(runtime,source);
    await s3.send(new PutObjectCommand({Bucket:file.bucket,Key:file.storageKey,ContentType:file.contentType,Body:bytes}));
  }} finally{if(!client)s3.destroy();}
  await runtime.db.execute(sql`WITH copied AS (UPDATE mail_attachments SET source_attachment_id=NULL WHERE workspace_id=${wid} AND message_id=${messageId} AND source_attachment_id IS NOT NULL RETURNING id)
    DELETE FROM sending_attachment_links l USING copied c WHERE l.workspace_id=${wid} AND l.owner_type='mailbox' AND l.owner_id=c.id`);
}
export async function finishMailboxArchive(runtime:Runtime,wid:string,messageId:string){
  try{await archiveMailboxFiles(runtime,wid,messageId);}catch{log('warn',{code:'MAILBOX_ARCHIVE_DEFERRED',messageId});}
}

const wireId = (v: string, header: string) => /^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(v) && v.length + 2 + header.length <= 996;

/** RFC 5322 §3.6.4: inherit References, or the parent's single In-Reply-To when References is absent. */
export function replyReferences(original: MessageRow, parentId: string | null) {
  const raw = original.headers.filter(h => h.name.toLowerCase() === 'in-reply-to').map(h => h.value).join(' ');
  const previous = raw ? messageIdList(raw) : original.inReplyTo ? [original.inReplyTo] : [];
  const ancestors = original.references.length ? original.references : previous.length === 1 ? previous : [];
  return [...ancestors.filter(id => id !== parentId && wireId(id, 'References')), ...(parentId ? [parentId] : [])];
}

/** Preserve the immediate parent first, then the root and newest ancestors that fit on the SES header line. */
export function referencesHeader(ids: string[]) {
  const max = 996 - 'References'.length;
  const unique = [...new Set(ids.filter(id => wireId(id, 'References')))].map(value => `<${value}>`);
  if (unique.join(' ').length <= max) return unique.join(' ');
  const root = unique[0]!, kept = [unique.at(-1)!];
  if (root.length + 1 + kept[0]!.length > max) return kept[0]!;
  let length = root.length + 1 + kept[0]!.length;
  for (const ancestor of unique.slice(1, -1).reverse()) if (length + 1 + ancestor.length <= max) { kept.unshift(ancestor); length += 1 + ancestor.length; }
  return [root, ...kept].join(' ');
}

export type OutgoingMessage = {
  mailbox: MailboxRow; actor: Actor; scope: Scope; from: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[];
  subject: string; text?: string; html?: string; attachments: ResolvedAttachment[];
  fromName?: string; region?: string; tracking?: boolean; screen?: boolean;
  threadId?: string; inReplyTo: string | null; references: string[]; autoSubmitted?: 'auto-generated' | 'auto-replied'; headers: { name: string; value: string }[];
};

/** Enforces per-mailbox limits and loop guards. Caller holds the mailbox row lock. */
async function enforceLimits(tx: DbExecutor, message: OutgoingMessage) {
  const limits = sendLimitsFor(message.mailbox);
  const counts = await tx.execute<{ hour: number; day: number }>(sql`SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour, count(*)::int AS day
    FROM mail_messages WHERE sender_mailbox_id = ${message.mailbox.id} AND direction = 'outbound' AND created_at > now() - interval '1 day'`);
  const { hour, day } = counts.rows[0]!;
  if (hour >= limits.perHour) throw new ApiError(429, 'MAILBOX_SEND_LIMIT', `This mailbox reached its limit of ${limits.perHour} messages per hour.`, undefined, true);
  if (day >= limits.perDay) throw new ApiError(429, 'MAILBOX_SEND_LIMIT', `This mailbox reached its limit of ${limits.perDay} messages per day.`, undefined, true);
  const recipients = [...message.to, ...message.cc, ...message.bcc];
  const recent = await tx.select({ to: mailMessages.to, cc: mailMessages.cc, bcc: mailMessages.bcc }).from(mailMessages).where(and(eq(mailMessages.senderMailboxId, message.mailbox.id), eq(mailMessages.direction, 'outbound'), gte(mailMessages.createdAt, sql`now() - interval '1 hour'`))).limit(limits.perHour);
  for (const recipient of recipients) {
    const sent = recent.filter(row => [...row.to, ...row.cc, ...row.bcc].some(item => item.address === recipient)).length;
    if (sent >= limits.perRecipientPerHour) throw new ApiError(429, 'RECIPIENT_SEND_LIMIT', `This mailbox already sent ${sent} messages to ${recipient} in the last hour. This guards against reply loops.`, undefined, true);
  }
  if (message.threadId) {
    const [thread] = await tx.select({ count: sql<number>`count(*)::int` }).from(mailMessages).where(and(eq(mailMessages.threadId, message.threadId), eq(mailMessages.senderMailboxId, message.mailbox.id), gte(mailMessages.createdAt, sql`now() - interval '10 minutes'`)));
    if (thread!.count >= limits.perThreadPer10Minutes) throw new ApiError(429, 'THREAD_LOOP_SUSPECTED', `This mailbox sent ${thread!.count} messages in this conversation in the last 10 minutes. Wait before replying again.`, undefined, true);
  }
}

/** Queues an email from a mailbox through the sending pipeline and stores it in the conversation. Runs inside the caller's transaction. */
export async function sendFromMailbox(runtime: Runtime, tx: DbExecutor, message: OutgoingMessage) {
  const recipients = [...message.to, ...message.cc, ...message.bcc];
  if (!recipients.length) throw new ApiError(422, 'RECIPIENT_REQUIRED', 'Add at least one recipient.', 'to');
  if (recipients.length > 50) throw new ApiError(422, 'TOO_MANY_RECIPIENTS', 'At most 50 recipients across to, cc and bcc.', 'to');
  const own = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, message.mailbox.id), inArray(mailboxAddresses.address, recipients.map(address => address.toLowerCase()))));
  if (own.length) throw new ApiError(422, 'SELF_SEND', `A mailbox cannot send to its own address (${own[0]!.address}).`, 'to');
  const [current] = await tx.select().from(mailboxes).where(eq(mailboxes.id, message.mailbox.id)).for('no key update');
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Mailbox was not found.');
  message = { ...message, mailbox: current };
  if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) throw new ApiError(409, 'MAILBOX_EXPIRED', 'This temporary mailbox is no longer accepting new sends.');
  await enforceLimits(tx, message);
  const bucket=runtime.config.multiTenant ? sql`(SELECT CASE c.kind WHEN 'shared' THEN p.inbound_bucket ELSE r.bucket END FROM provider_connections c
      LEFT JOIN provider_pool_regions p ON p.region=c.region AND p.aws_account_id=c.aws_account_id
      LEFT JOIN mailbox_regions r ON r.region=c.region AND r.workspace_id=c.workspace_id AND r.account_id=c.aws_account_id
      WHERE c.workspace_id=d.workspace_id AND c.region=d.region AND c.status='ready')` : sql`(SELECT r.bucket FROM mailbox_regions r WHERE r.region=d.region AND r.workspace_id=d.workspace_id)`;
  const domain=(await tx.execute<{id:string;region:string;bucket:string|null;verified:boolean}>(sql`SELECT d.id,d.region,${bucket} AS bucket,${runtime.config.multiTenant ? verifiedClaim(sql`d.workspace_id`,sql`d.region`,sql`${message.from.split('@')[1]!.toLowerCase()}::text`,runtime) : sql`true`} AS verified
    FROM mailbox_domains d WHERE d.id=${message.mailbox.domainId} AND d.workspace_id=${message.scope.workspaceId}`)).rows[0];
  if (domain && !domain.verified) throw unverifiedSender(); // Before any attachment is written outside PostgreSQL.
  if (!domain?.bucket) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_READY', 'The mailbox domain has no receiving setup; enable it again.');
  if (message.region && domain.region !== message.region) throw new ApiError(422, 'MAILBOX_REGION_MISMATCH', 'Tracked mail must use the mailbox region.', 'region');
  const messageRowId = id('msg');
  const sendingIds=message.attachments.map(f=>f.id);
  const files=await Promise.all(message.attachments.map(async(file,index)=>{
    const attachmentId=`matt_${(await digest(`${messageRowId}:${index}`)).slice(0,32)}`;
    return {id:attachmentId,...message.scope,messageId:messageRowId,filename:file.filename,contentType:file.contentType,sizeBytes:file.size,contentId:file.contentId,disposition:file.disposition as 'inline'|'attachment',sha256:file.checksum,sourceId:file.id,bucket:domain.bucket!,storageKey:`${workspacePrefix(message.scope.workspaceId,'att')}${messageRowId}/${attachmentId}`};
  }));
  const references = referencesHeader(message.references);
  const headers = [
    ...(message.inReplyTo ? [{ Name: 'In-Reply-To', Value: `<${message.inReplyTo}>` }] : []),
    ...(references ? [{ Name: 'References', Value: references }] : []),
    ...(message.autoSubmitted ? [{ Name: 'Auto-Submitted', Value: message.autoSubmitted }] : []),
    ...message.headers.map(header => ({ Name: header.name, Value: header.value })),
  ];
  const fromName = message.fromName ?? message.mailbox.displayName;
  const { emailId } = await queueMailboxEmail(runtime, tx, message.actor, { from: message.from, fromName: fromName ?? undefined, to: message.to, cc: message.cc, bcc: message.bcc, replyTo: message.replyTo, region: domain.region, subject: message.subject, html: message.html, text: message.text, attachments: sendingIds, headers, tracking: message.tracking, screen: message.screen });
  const now = new Date().toISOString();
  let threadId = message.threadId;
  if (!threadId) { threadId = id('thr'); await tx.insert(mailThreads).values({ id: threadId, ...message.scope, subject: normalizeSubject(message.subject).slice(0, 998), messageCount: 0, lastMessageAt: now }); }
  await tx.update(mailThreads).set({ messageCount: sql`${mailThreads.messageCount} + 1`, lastMessageAt: sql`greatest(${mailThreads.lastMessageAt}, ${now}::timestamptz)` }).where(eq(mailThreads.id, threadId));
  const address = (value: string): MailAddress => ({ name: null, address: value });
  const [row] = await tx.insert(mailMessages).values({
    id: messageRowId, ...message.scope, direction: 'outbound', threadId, region: domain.region, domainId: domain.id, sendingEmailId: emailId, senderMailboxId: message.mailbox.id,
    inReplyTo: message.inReplyTo, references: message.references, subject: message.subject, fromAddress: message.from, fromName,
    to: message.to.map(address), cc: message.cc.map(address), bcc: message.bcc.map(address), replyTo: message.replyTo.map(address), envelopeFrom: message.from, envelopeTo: recipients,
    sentAt: now, receivedAt: now, text: message.text ?? (message.html ? htmlToPlain(message.html) : null), html: message.html ?? null, snippet: snippetOf(message.text, message.html),
    headers: headers.map(header => ({ name: header.Name, value: header.Value })), attachmentCount: files.length, status: 'queued', automated: !!message.autoSubmitted,
  }).returning();
  if(files.length){
    await tx.insert(mailAttachments).values(files);
    await tx.insert(attachmentLinks).values(files.map(f=>({...message.scope,attachmentId:f.sourceId,ownerType:'mailbox' as const,ownerId:f.id})));
  }
  await attachToMailboxes(tx, message.scope, row!, [message.mailbox.id]);
  const queued = await recordEvents(tx, message.scope.workspaceId, [{ type: 'message.queued', mailboxId: message.mailbox.id, threadId, messageId: row!.id, data: { to: message.to, subject: message.subject, emailId } }]);
  return { message: row!, runnable: queued };
}

/** Any From on a domain (or parent domain) registered in the sending region. SES enforces the final verification. */
export async function assertRegisteredSender(db: DbExecutor, scope: Scope, region: string, from: string, field = 'from') {
  const host = from.split('@')[1]!.toLowerCase();
  const names = host.split('.').map((_, index, parts) => parts.slice(index).join('.')).filter(name => name.includes('.'));
  const [registered] = await db.select({ name: domains.name }).from(domains).where(and(eq(domains.workspaceId, scope.workspaceId), eq(domains.region, region), inArray(domains.name, names))).limit(1);
  if (!registered) throw new ApiError(422, 'SENDER_DOMAIN_NOT_REGISTERED', `Add ${host} or a parent domain to OpenSend in ${region} before sending from it.`, field);
}

/** Explicit bridge only: an ordinary send from the same address must not become readable by a mailbox key. */
export async function trackedAttachments(runtime:Runtime,actor:Actor,mailboxId:string,input:SendRequest){
  const [mailbox]=await runtime.db.select().from(mailboxes).where(and(eq(mailboxes.id,mailboxId),eq(mailboxes.workspaceId,actor.workspaceId)));
  if(!mailbox)throw new ApiError(404,'NOT_FOUND','Receivable address was not found.');
  return resolveAttachments(runtime,mailbox,input.attachments.map(id=>({id})),input.from);
}
export async function queueTrackedMailboxSend(runtime: Runtime, tx: DbExecutor, actor: Actor, mailboxId: string, input: SendRequest, field: 'replyAddressId' | 'replyMailboxId',files:ResolvedAttachment[]) {
  if (input.kind !== 'transactional' || input.template || !input.subject) throw new ApiError(422, 'MAILBOX_CONTENT_UNSUPPORTED', 'Use an explicit transactional subject and body for tracked sends.', field);
  const scope = { workspaceId: actor.workspaceId };
  const [target] = await tx.select({ mailbox: mailboxes, receiving: mailboxDomains.status, region: mailboxDomains.region }).from(mailboxes).innerJoin(mailboxDomains, eq(mailboxDomains.id, mailboxes.domainId)).where(and(eq(mailboxes.workspaceId, scope.workspaceId), eq(mailboxes.id, mailboxId))).for('share', { of: mailboxDomains });
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Receivable address was not found.');
  if (target.receiving !== 'active') throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_READY', 'The receiving domain must be active before starting a tracked conversation.', field);
  const { mailbox } = target;
  const owned = new Set((await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(eq(mailboxAddresses.mailboxId, mailbox.id))).map(row => row.address));
  // Reply-To must route back into this address so the conversation keeps tracking. From can be any registered sender.
  if (input.replyTo.some(address => !owned.has(address.toLowerCase()))) throw new ApiError(422, 'MAILBOX_ADDRESS_MISMATCH', 'Reply-To must belong to the selected receivable address.', field);
  // Hosted admission checks every From (including mailbox-owned addresses) against verified claims.
  if (!runtime.config.multiTenant && !owned.has(input.from.toLowerCase())) await assertRegisteredSender(tx, scope, target.region, input.from, 'from');
  const { message, runnable } = await sendFromMailbox(runtime, tx, {
    mailbox, actor, scope, from: input.from.toLowerCase(), fromName: input.fromName, to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo,
    region: input.region, tracking: input.tracking, screen: input.screen, subject: input.subject, text: input.text, html: input.html,
    attachments: files, inReplyTo: null, references: [], headers: [],
  });
  if (runnable) actor.wakeJobs = Math.max(actor.wakeJobs ?? 0, runnable);
  return { id: message.sendingEmailId!, status: 'queued' as const, simulated: isSimulatedSes(runtime), mailboxMessageId: message.id, threadId: message.threadId };
}

/** Reply recipients: Reply-To (or From) of an inbound message; the original recipients of an outbound one. */
export function replyRecipients(original: MessageRow, ownAddresses: string[], replyAll: boolean) {
  const mine = new Set(ownAddresses);
  const list = (values: MailAddress[]) => values.map(value => value.address.toLowerCase()).filter(value => !mine.has(value));
  const to = original.direction === 'outbound' ? list(original.to) : list(original.replyTo.length ? original.replyTo : [{ name: original.fromName, address: original.fromAddress }]);
  const cc = replyAll ? [...new Set([...(original.direction === 'outbound' ? [] : list(original.to)), ...list(original.cc)])].filter(value => !to.includes(value)) : [];
  return { to: [...new Set(to)], cc: cc.filter(address => !to.includes(address)) };
}
export function assertReplyable(original: MessageRow, to: string[], allowAutomated: boolean) {
  if (allowAutomated) return;
  if (original.direction === 'inbound' && original.automated) throw new ApiError(409, 'REPLY_TO_AUTOMATED', 'The original message is automated (auto-reply, bounce or bulk mail). Replying risks a mail loop; set allowAutomated=true to send anyway.');
  const blocked = to.find(address => NO_REPLY.test(address));
  if (blocked) throw new ApiError(409, 'REPLY_TO_NO_REPLY', `${blocked} does not accept replies. Set allowAutomated=true to send anyway.`, 'to');
}
export const replySubject = (subject: string) => `Re: ${normalizeSubject(subject) || '(no subject)'}`.slice(0, 998);

/** Mailbox sync can lag provider acceptance. Never put an OpenSend ID on the wire or silently send an unthreaded follow-up. */
export async function replyParentId(db: DbExecutor, original: MessageRow) {
  if (original.messageId && wireId(original.messageId, 'In-Reply-To')) return original.messageId;
  // Inbound mail is allowed to omit Message-ID; never invent one that the recipient cannot match.
  if (original.direction !== 'outbound') return null;
  if (original.sendingEmailId) {
    const [sent] = await db.select({ providerId: emails.providerId, region: emails.region }).from(emails).where(and(eq(emails.id, original.sendingEmailId), eq(emails.workspaceId, original.workspaceId)));
    if (sent?.providerId) return sesMessageId(sent.providerId, sent.region);
  }
  throw new ApiError(409, 'REPLY_TARGET_NOT_ACCEPTED', 'The original outbound email has no provider Message-ID. Wait for acceptance or reply to an earlier received message.');
}

// Received HTML can contain URL schemes the sending pipeline rejects (data:, javascript:). Neutralize them instead of failing the forward.
export function safeForwardHtml(html: string) {
  return html.replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '')
    .replace(/\s(href|src|background|action|poster|cite|longdesc|data|formaction)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, (match, name: string, _quoted, doubleValue?: string, singleValue?: string) => {
      const value = (doubleValue ?? singleValue ?? match.split('=').slice(1).join('=')).trim().replace(/^["']|["']$/g, '');
      return /^(?:https?:|mailto:|tel:|cid:|#|\/)/i.test(value.replace(/[\x00-\x20]/g, '')) ? match : ` ${name}="#"`;
    })
    .replace(/\s(srcset|imagesrcset|ping|archive)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** Copies delivery status and the SES Message-ID from the sending pipeline onto outbound mailbox messages and emits events. Every minute. */
export async function syncOutboundMessages(runtime: Runtime, limit = 500) {
  const result=await runtime.db.execute<{n:number;queued:number}>(sql`WITH batch AS MATERIALIZED (
    SELECT m.id,m.status AS previous,e.status,e.provider_id,e.error_code,e.region FROM mail_messages m JOIN sending_emails e ON e.id=m.sending_email_id AND e.workspace_id=m.workspace_id
    WHERE m.direction='outbound' AND m.status IN ('queued','attempting','accepted','sent','delayed','acceptance_unknown') AND (e.status<>m.status OR (e.provider_id IS NOT NULL AND m.message_id IS NULL)) ORDER BY m.created_at,m.id LIMIT ${limit} FOR UPDATE OF m SKIP LOCKED
  ), changed AS (UPDATE mail_messages m SET status=b.status,error_code=b.error_code,message_id=coalesce(m.message_id,b.provider_id||'@'||CASE b.region WHEN 'us-east-1' THEN 'email' ELSE b.region END||'.amazonses.com'),ses_message_id=coalesce(m.ses_message_id,b.provider_id),updated_at=now() FROM batch b WHERE m.id=b.id RETURNING m.*,b.previous
  ), ids AS (INSERT INTO mail_message_ids(workspace_id,message_id,mail_message_id,thread_id) SELECT workspace_id,message_id,id,thread_id FROM changed WHERE message_id IS NOT NULL ON CONFLICT DO NOTHING
  ), updates AS (SELECT c.*,e.type,e.ord FROM changed c CROSS JOIN LATERAL (VALUES
    (CASE WHEN previous IN ('queued','attempting','acceptance_unknown') AND status IN ('delivered','bounced','complained') THEN 'message.sent' END,1),
    (CASE WHEN status IN ('accepted','sent') THEN 'message.sent' WHEN status IN ('delivered','bounced','complained','delayed') THEN 'message.'||status WHEN status IN ('rejected','rendering_failed','suppressed','canceled') THEN 'message.failed' END,2)) e(type,ord)
    WHERE c.sender_mailbox_id IS NOT NULL AND c.status<>c.previous AND e.type IS NOT NULL
  ), ${mailboxEventCtes(sql`SELECT workspace_id,type,sender_mailbox_id AS mailbox_id,thread_id,id AS message_id,row_number() OVER(ORDER BY id,ord) AS ord,jsonb_strip_nulls(jsonb_build_object('subject',subject,'status',CASE WHEN ord=2 THEN status END,'errorCode',CASE WHEN ord=2 THEN error_code END)) AS data FROM updates`)}
  SELECT (SELECT count(*)::int FROM changed) AS n,(SELECT count(*)::int FROM queued) AS queued`);
  const {n,queued}=result.rows[0]!;
  if (queued) try { await runtime.wake?.(queued); } catch { /* Webhook jobs are durable. */ }
  return n;
}
