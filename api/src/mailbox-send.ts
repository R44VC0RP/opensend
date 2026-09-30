import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ApiError, digest, id, log, type Actor, type DbExecutor, type Runtime } from './core.js';
import { attachments as sendingAttachments } from './db/sending.js';
import { mailAttachments, mailboxAddresses, mailboxDomains, mailboxes, mailboxMessages, mailboxRegions, mailMessages, mailThreads, type MailAddress, type SendLimits } from './db/mailbox.js';
import { recordEvents, type MailboxEventInput, type MailboxEventType } from './mailbox-events.js';
import { ATTACHMENT_PREFIX, mailboxS3 } from './mailbox-setup.js';
import { attachToMailboxes, htmlToPlain, normalizeSubject, rememberMessageIds, snippetOf, type Scope } from './mailbox-store.js';
import { queueMailboxEmail, storeAttachmentBytes } from './sending.js';

export const DEFAULT_SEND_LIMITS: SendLimits = { perHour: 100, perDay: 1000, perRecipientPerHour: 20, perThreadPer10Minutes: 10 };
export const sendLimitsFor = (mailbox: typeof mailboxes.$inferSelect): SendLimits => ({ ...DEFAULT_SEND_LIMITS, ...mailbox.sendLimits });
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Local parts that never read replies (RFC 3834 recommends not auto-replying to these).
export const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)(?:[+._-].*)?@/i;

export type AttachmentInput = { content: string; filename: string; contentType?: string; disposition?: 'attachment' | 'inline'; contentId?: string } | { id: string };
type ResolvedAttachment = { filename: string; contentType: string; disposition: 'attachment' | 'inline'; contentId: string | null; bytes: Uint8Array; sendingAttachmentId?: string };
type MailboxRow = typeof mailboxes.$inferSelect;
type MessageRow = typeof mailMessages.$inferSelect;

/** SES replaces Message-ID with <providerId@email.amazonses.com> (us-east-1) or <providerId@region.amazonses.com>. */
export const sesMessageId = (providerId: string, region: string) => `${providerId}@${region === 'us-east-1' ? 'email' : region}.amazonses.com`;

/** Resolves attachment inputs to bytes before any transaction: inline base64, received attachments (matt_) or uploaded sending attachments. */
export async function resolveAttachments(runtime: Runtime, mailbox: MailboxRow, items: AttachmentInput[]): Promise<ResolvedAttachment[]> {
  const out: ResolvedAttachment[] = [];
  for (const item of items) {
    if ('content' in item) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(item.content) || item.content.length % 4) throw new ApiError(422, 'ATTACHMENT_CONTENT_INVALID', `Attachment ${item.filename} must be standard padded base64.`, 'attachments');
      out.push({ filename: item.filename, contentType: item.contentType ?? 'application/octet-stream', disposition: item.disposition ?? 'attachment', contentId: item.contentId ?? null, bytes: new Uint8Array(Buffer.from(item.content, 'base64')) });
    } else if (item.id.startsWith('matt_')) {
      const [file] = await runtime.db.select({ file: mailAttachments, region: mailMessages.region }).from(mailAttachments).innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
        .innerJoin(mailboxMessages, and(eq(mailboxMessages.messageId, mailAttachments.messageId), eq(mailboxMessages.mailboxId, mailbox.id))).where(eq(mailAttachments.id, item.id));
      if (!file?.region) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', `Attachment ${item.id} was not found in this mailbox.`, 'attachments');
      const s3 = mailboxS3(runtime, file.region);
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: file.file.bucket, Key: file.file.storageKey }));
        out.push({ filename: file.file.filename, contentType: file.file.contentType, disposition: file.file.disposition, contentId: file.file.contentId, bytes: await object.Body!.transformToByteArray() });
      } catch { throw new ApiError(503, 'ATTACHMENT_UNAVAILABLE', `Attachment ${item.id} could not be read from storage.`, 'attachments', true); }
      finally { s3.destroy(); }
    } else {
      const [row] = await runtime.db.select().from(sendingAttachments).where(and(eq(sendingAttachments.workspaceId, mailbox.workspaceId), eq(sendingAttachments.environment, 'live'), eq(sendingAttachments.id, item.id)));
      if (!row) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', `Attachment ${item.id} was not found.`, 'attachments');
      const stored = await runtime.storage.get(row.storageKey);
      if (!stored) throw new ApiError(503, 'ATTACHMENT_UNAVAILABLE', `Attachment ${item.id} could not be read from storage.`, 'attachments', true);
      out.push({ filename: row.filename, contentType: row.contentType, disposition: row.disposition as 'attachment' | 'inline', contentId: row.contentId, bytes: stored.body, sendingAttachmentId: row.id });
    }
  }
  if (out.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments may not exceed 8 MiB combined.', 'attachments');
  return out;
}

/** References stays one header line of at most 995 characters: keep the first ID and as many recent IDs as fit (RFC 5322 §3.6.4). */
export function referencesHeader(ids: string[]) {
  const unique = [...new Set(ids)].map(value => `<${value}>`);
  if (unique.join(' ').length <= 995) return unique.join(' ');
  const [first, ...rest] = unique; const kept: string[] = [];
  for (const value of rest.reverse()) { if ([first, value, ...kept].join(' ').length > 995) break; kept.unshift(value); }
  return [first, ...kept].join(' ');
}

export type OutgoingMessage = {
  mailbox: MailboxRow; actor: Actor; scope: Scope; from: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[];
  subject: string; text?: string; html?: string; attachments: ResolvedAttachment[];
  threadId?: string; inReplyTo: string | null; references: string[]; autoSubmitted?: 'auto-generated' | 'auto-replied'; headers: { name: string; value: string }[];
};

/** Enforces per-mailbox limits and loop guards. Serialized per mailbox by the caller's advisory lock. */
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
  const own = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, message.mailbox.id), inArray(mailboxAddresses.address, recipients)));
  if (own.length) throw new ApiError(422, 'SELF_SEND', `A mailbox cannot send to its own address (${own[0]!.address}).`, 'to');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_send:${message.mailbox.id}`}))`);
  await enforceLimits(tx, message);
  const [domain] = await tx.select().from(mailboxDomains).where(eq(mailboxDomains.id, message.mailbox.domainId));
  const [region] = domain ? await tx.select().from(mailboxRegions).where(and(eq(mailboxRegions.workspaceId, message.scope.workspaceId), eq(mailboxRegions.region, domain.region))) : [];
  if (!domain || !region?.bucket) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_READY', 'The mailbox domain has no receiving setup; enable it again.');
  const messageRowId = id('msg');
  const sendingIds: string[] = [];
  const files: (typeof mailAttachments.$inferInsert)[] = [];
  const s3 = mailboxS3(runtime, domain.region);
  try {
    for (const [index, file] of message.attachments.entries()) {
      const sendingId = file.sendingAttachmentId ?? (await storeAttachmentBytes(runtime, tx, message.actor, { filename: file.filename, contentType: file.contentType, disposition: file.disposition, ...(file.contentId ? { contentId: file.contentId } : {}) }, file.bytes)).id;
      sendingIds.push(sendingId);
      // Keep a permanent copy beside received mail so the conversation record outlives sending retention.
      const attachmentId = `matt_${(await digest(`${messageRowId}:${index}`)).slice(0, 32)}`;
      const key = `${ATTACHMENT_PREFIX}${messageRowId}/${attachmentId}`;
      await s3.send(new PutObjectCommand({ Bucket: region.bucket, Key: key, Body: file.bytes, ContentType: file.contentType }));
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
      files.push({ id: attachmentId, ...message.scope, messageId: messageRowId, filename: file.filename, contentType: file.contentType, sizeBytes: file.bytes.byteLength, contentId: file.contentId, disposition: file.disposition, sha256: sha, bucket: region.bucket, storageKey: key });
    }
  } finally { s3.destroy(); }
  const headers = [
    ...(message.inReplyTo ? [{ Name: 'In-Reply-To', Value: `<${message.inReplyTo}>` }] : []),
    ...(message.references.length ? [{ Name: 'References', Value: referencesHeader(message.references) }] : []),
    ...(message.autoSubmitted ? [{ Name: 'Auto-Submitted', Value: message.autoSubmitted }] : []),
    ...message.headers.map(header => ({ Name: header.name, Value: header.value })),
  ];
  const { emailId } = await queueMailboxEmail(runtime, tx, message.actor, { from: message.from, fromName: message.mailbox.displayName ?? undefined, to: message.to, cc: message.cc, bcc: message.bcc, replyTo: message.replyTo, region: domain.region, subject: message.subject, html: message.html, text: message.text, attachments: sendingIds, headers });
  const now = new Date().toISOString();
  let threadId = message.threadId;
  if (!threadId) { threadId = id('thr'); await tx.insert(mailThreads).values({ id: threadId, ...message.scope, subject: normalizeSubject(message.subject).slice(0, 998), messageCount: 0, lastMessageAt: now }); }
  await tx.update(mailThreads).set({ messageCount: sql`${mailThreads.messageCount} + 1`, lastMessageAt: sql`greatest(${mailThreads.lastMessageAt}, ${now}::timestamptz)` }).where(eq(mailThreads.id, threadId));
  const address = (value: string): MailAddress => ({ name: null, address: value });
  const [row] = await tx.insert(mailMessages).values({
    id: messageRowId, ...message.scope, direction: 'outbound', threadId, region: domain.region, domainId: domain.id, sendingEmailId: emailId, senderMailboxId: message.mailbox.id,
    inReplyTo: message.inReplyTo, references: message.references, subject: message.subject, fromAddress: message.from, fromName: message.mailbox.displayName,
    to: message.to.map(address), cc: message.cc.map(address), bcc: message.bcc.map(address), replyTo: message.replyTo.map(address), envelopeFrom: message.from, envelopeTo: recipients,
    sentAt: now, receivedAt: now, text: message.text ?? (message.html ? htmlToPlain(message.html) : null), html: message.html ?? null, snippet: snippetOf(message.text, message.html),
    headers: headers.map(header => ({ name: header.Name, value: header.Value })), attachmentCount: files.length, status: 'queued', automated: !!message.autoSubmitted,
  }).returning();
  if (files.length) await tx.insert(mailAttachments).values(files);
  await attachToMailboxes(tx, message.scope, row!, [message.mailbox.id]);
  const queued = await recordEvents(tx, message.scope.workspaceId, message.scope.environment, [{ type: 'message.queued', mailboxId: message.mailbox.id, threadId, messageId: row!.id, data: { to: message.to, subject: message.subject, emailId } }]);
  return { message: row!, runnable: queued };
}

/** Reply recipients: Reply-To (or From) of an inbound message; the original recipients of an outbound one. */
export function replyRecipients(original: MessageRow, ownAddresses: string[], replyAll: boolean) {
  const mine = new Set(ownAddresses);
  const list = (values: MailAddress[]) => values.map(value => value.address.toLowerCase()).filter(value => !mine.has(value));
  const to = original.direction === 'outbound' ? list(original.to) : list(original.replyTo.length ? original.replyTo : [{ name: original.fromName, address: original.fromAddress }]);
  const cc = replyAll ? [...new Set([...(original.direction === 'outbound' ? [] : list(original.to)), ...list(original.cc)])].filter(value => !to.includes(value)) : [];
  return { to: [...new Set(to)], cc };
}
export function assertReplyable(original: MessageRow, to: string[], allowAutomated: boolean) {
  if (allowAutomated) return;
  if (original.direction === 'inbound' && original.automated) throw new ApiError(409, 'REPLY_TO_AUTOMATED', 'The original message is automated (auto-reply, bounce or bulk mail). Replying risks a mail loop; set allowAutomated=true to send anyway.');
  const blocked = to.find(address => NO_REPLY.test(address));
  if (blocked) throw new ApiError(409, 'REPLY_TO_NO_REPLY', `${blocked} does not accept replies. Set allowAutomated=true to send anyway.`, 'to');
}
export const replySubject = (subject: string, prefix: 'Re' | 'Fwd') => `${prefix}: ${normalizeSubject(subject) || '(no subject)'}`.slice(0, 998);

/** Forward body: optional note, a header summary and the original content. */
export function forwardBody(original: MessageRow, note: { text?: string; html?: string }) {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const who = (value: MailAddress) => value.name ? `${value.name} <${value.address}>` : value.address;
  const lines = [`From: ${who({ name: original.fromName, address: original.fromAddress })}`, `Date: ${new Date(original.sentAt ?? original.receivedAt).toUTCString()}`, `Subject: ${original.subject}`, `To: ${original.to.map(who).join(', ')}`, ...(original.cc.length ? [`Cc: ${original.cc.map(who).join(', ')}`] : [])];
  const originalText = original.text ?? (original.html ? htmlToPlain(original.html) : '');
  const text = `${note.text ?? (note.html ? htmlToPlain(note.html) : '')}\n\n---------- Forwarded message ---------\n${lines.join('\n')}\n\n${originalText}`.trim();
  const html = original.html || note.html ? `${note.html ?? (note.text ? `<p>${escape(note.text).replace(/\n/g, '<br>')}</p>` : '')}<br><div>---------- Forwarded message ---------<br>${lines.map(escape).join('<br>')}</div><br>${original.html ? safeForwardHtml(original.html) : `<pre>${escape(originalText)}</pre>`}` : undefined;
  return { text, html };
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

const FINAL = new Set(['delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'suppressed', 'canceled']);
const eventFor: Record<string, MailboxEventType | undefined> = { accepted: 'message.sent', sent: 'message.sent', delivered: 'message.delivered', bounced: 'message.bounced', complained: 'message.complained', delayed: 'message.delayed', rejected: 'message.failed', rendering_failed: 'message.failed', suppressed: 'message.failed', canceled: 'message.failed' };
const stage = (status: string) => ({ queued: 0, attempting: 0, acceptance_unknown: 0, accepted: 1, sent: 1, delayed: 1, delivered: 2 } as Record<string, number>)[status] ?? 2;

/** Copies delivery status and the SES Message-ID from the sending pipeline onto outbound mailbox messages and emits events. Every minute. */
export async function syncOutboundMessages(runtime: Runtime, limit = 500) {
  const rows = await runtime.db.execute<{ id: string; status: string; thread_id: string; sender_mailbox_id: string | null; message_id: string | null; email_status: string; provider_id: string | null; error_code: string | null; region: string; subject: string }>(sql`
    SELECT m.id, m.status, m.thread_id, m.sender_mailbox_id, m.message_id, e.status AS email_status, e.provider_id, e.error_code, e.region, m.subject
    FROM mail_messages m JOIN sending_emails e ON e.id = m.sending_email_id AND e.workspace_id = m.workspace_id AND e.environment = m.environment
    WHERE m.workspace_id = ${runtime.config.workspaceId} AND m.direction = 'outbound' AND m.status IN ('queued', 'attempting', 'accepted', 'sent', 'delayed', 'acceptance_unknown')
      AND (e.status <> m.status OR (e.provider_id IS NOT NULL AND m.message_id IS NULL))
    ORDER BY m.created_at LIMIT ${limit}`);
  let queued = 0;
  for (const row of rows.rows) {
    queued += await runtime.db.transaction(async tx => {
      const [locked] = await tx.select().from(mailMessages).where(eq(mailMessages.id, row.id)).for('update');
      if (!locked || FINAL.has(locked.status)) return 0;
      const scope: Scope = { workspaceId: locked.workspaceId, environment: locked.environment };
      const messageId = locked.messageId ?? (row.provider_id ? sesMessageId(row.provider_id, row.region) : null);
      await tx.update(mailMessages).set({ status: row.email_status, errorCode: row.error_code, messageId, sesMessageId: locked.sesMessageId ?? row.provider_id, updatedAt: new Date().toISOString() }).where(eq(mailMessages.id, locked.id));
      if (messageId && !locked.messageId) await rememberMessageIds(tx, scope, locked.id, locked.threadId, [messageId]);
      const events: MailboxEventInput[] = [];
      const type = eventFor[row.email_status];
      if (locked.senderMailboxId && type && row.email_status !== locked.status) {
        // A jump straight from queued to a final outcome still reports that the message was sent.
        if (stage(locked.status) < 1 && stage(row.email_status) >= 2 && type !== 'message.failed') events.push({ type: 'message.sent', mailboxId: locked.senderMailboxId, threadId: locked.threadId, messageId: locked.id, data: { subject: locked.subject } });
        events.push({ type, mailboxId: locked.senderMailboxId, threadId: locked.threadId, messageId: locked.id, data: { subject: locked.subject, status: row.email_status, ...(row.error_code ? { errorCode: row.error_code } : {}) } });
      }
      return recordEvents(tx, scope.workspaceId, scope.environment, events);
    });
  }
  if (rows.rows.length) log('info', { code: 'MAILBOX_OUTBOUND_SYNCED', count: rows.rows.length });
  if (queued) try { await runtime.wake?.(queued); } catch { /* Webhook jobs are durable. */ }
  return rows.rows.length;
}

/** Latest message in a thread the mailbox can reply to: newest inbound, else newest of any direction. */
export async function latestReplyTarget(db: DbExecutor, mailboxId: string, threadId: string) {
  const rows = await db.select({ row: mailMessages }).from(mailboxMessages).innerJoin(mailMessages, eq(mailMessages.id, mailboxMessages.messageId)).where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.threadId, threadId))).orderBy(desc(mailboxMessages.receivedAt)).limit(50);
  return rows.find(item => item.row.direction === 'inbound')?.row ?? rows[0]?.row;
}
