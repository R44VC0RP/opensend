import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readableMailboxKey, mailboxS3 } from './mailbox-setup.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { ApiError, errors, json, page, response, security, type Actor, type App, type Ctx, type DbExecutor, type MailboxAccess, type Runtime } from './core.js';
import { mailboxMessages as links, mailboxThreads, mailAttachments, mailMessages as messages } from './db/mailbox.js';
import { htmlToPlain, replyText } from './mailbox-store.js';
import { archiveMailboxFiles, sendFromMailbox, finishMailboxArchive, type OutgoingMessage } from './mailbox-send.js';
import { IdempotencyHeaders, idempotent } from './sending.js';

const base = '/v1/inbound/threads';
const tags = ['Inbound threads'];
const Id = z.string().min(1).max(120);
export const InboundAddressId = Id.describe('Opaque inbound address ID (mbx_…).');
const ThreadParams = z.object({ threadId: Id });
const Address = z.object({ name: z.string().nullable(), address: z.string() });
export const AddressState = z.object({addressId:Id, unreadCount:z.number().int(), archived:z.boolean(), starred:z.boolean(), trashed:z.boolean(), spam:z.boolean(), labels:z.array(z.string())}).openapi('InboundThreadAddressState');
const Thread = z.object({
  id: z.string(), subject: z.string(), snippet: z.string(), lastMessageAt: z.string(),
  addressIds: z.array(z.string()), messageCount: z.number().int().describe('Distinct messages visible within the requested address scope.'),
}).openapi('InboundThread');
const Message = z.object({
  id: z.string(), threadId: z.string(), addressIds: z.array(z.string()), direction: z.enum(['inbound', 'outbound']), status: z.string(),
  from: Address, to: z.array(Address), cc: z.array(Address), replyTo: z.array(Address), subject: z.string(), snippet: z.string(),
  text: z.string(), replyText: z.string(), receivedAt: z.string(), bodyTruncated: z.boolean(), attachmentCount: z.number().int(), read:z.boolean(), errorCode:z.string().nullable(),
  emailId: z.string().nullable(), messageId: z.string().nullable().describe('RFC Message-ID, not the OpenSend message ID (id).'),
  inReplyTo: z.string().nullable(), references: z.array(z.string()),
}).openapi('InboundMessage');
const Cursor = z.string().min(1).max(300).optional().describe('Opaque cursor from the preceding page, with the same filters.');
const AddressFilter = z.object({ addressId: InboundAddressId.optional() }).strict();
const PageQuery = AddressFilter.extend({ cursor: Cursor, limit: z.coerce.number().int().min(1).max(100).default(25) });
const View = z.enum(['all', 'inbox', 'archive', 'starred', 'trash', 'spam']);
const ListQuery = PageQuery.extend({ view: View.default('all'), q: z.string().trim().min(1).max(200).optional() });

// Preserve Postgres microseconds in the cursor even though the public timestamps use milliseconds.
const preciseTime = (column: SQLWrapper) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const timestamp = (value: string) => new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString();
const cursorPair = z.tuple([z.iso.datetime(), Id]);
function decodeCursor(value?: string) {
  if (!value) return null;
  try { return cursorPair.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the cursor returned by the previous page.', 'cursor'); }
}
const encodeCursor = (time: string, id: string) => Buffer.from(JSON.stringify([time, id])).toString('base64url');

type Filter = { addressId?: string; threadId?: string; messageId?: string };
function visibleLinks(value: MailboxAccess, filter: Filter) {
  if (filter.addressId && value.mailboxIds && !value.mailboxIds.includes(filter.addressId)) throw new ApiError(404, 'NOT_FOUND', 'Address was not found.');
  return and(eq(links.workspaceId, value.workspaceId), eq(links.environment, value.environment),
    filter.addressId ? eq(links.mailboxId, filter.addressId) : value.mailboxIds ? inArray(links.mailboxId, value.mailboxIds) : undefined,
    filter.threadId ? eq(links.threadId, filter.threadId) : undefined, filter.messageId ? eq(links.messageId, filter.messageId) : undefined);
}

export function visibleThreadAddresses(value: MailboxAccess, threadId: string, addressId?: string) {
  if (addressId && value.mailboxIds && !value.mailboxIds.includes(addressId)) throw new ApiError(404,'NOT_FOUND','Address was not found.');
  return and(eq(mailboxThreads.threadId,threadId),eq(mailboxThreads.workspaceId,value.workspaceId),eq(mailboxThreads.environment,value.environment),
    addressId ? eq(mailboxThreads.mailboxId,addressId) : value.mailboxIds ? inArray(mailboxThreads.mailboxId,value.mailboxIds) : undefined);
}

async function threadPage(db: DbExecutor, value: MailboxAccess, filter: Filter, options: { view?: z.infer<typeof View>; q?: string; cursor?: string; limit: number }) {
  const after = decodeCursor(options.cursor), view = options.view;
  const t = mailboxThreads;
  const state = view === 'trash' ? sql`${t.trashedAt} IS NOT NULL` : view && view !== 'all' ? sql`${t.trashedAt} IS NULL AND ${
    view === 'inbox' ? sql`NOT ${t.archived} AND NOT ${t.spam}` : view === 'archive' ? t.archived : view === 'spam' ? t.spam : t.starred}` : null;
  // Match search/view at the thread level. An older matching message (or one matching address)
  // must not replace the newest visible snippet, narrow the address list, or reduce the count.
  const visibility = visibleLinks(value, filter); // Also validates an explicit address filter against the grant.
  // Page the per-address summaries first: opening Inbound shouldn't aggregate every message ever received.
  const rows = await db.execute<{ id: string; subject: string; snippet: string; at: string; address_ids: string[]; message_count: number }>(sql`
    WITH threads AS MATERIALIZED (
      SELECT ${t.threadId} AS id, max(${t.lastMessageAt}) AS last_at, array_agg(${t.mailboxId} ORDER BY ${t.mailboxId}) AS address_ids
      FROM ${t} WHERE ${and(eq(t.workspaceId,value.workspaceId),eq(t.environment,value.environment),filter.threadId ? eq(t.threadId,filter.threadId) : undefined,
        filter.addressId ? eq(t.mailboxId,filter.addressId) : value.mailboxIds ? inArray(t.mailboxId,value.mailboxIds) : undefined)}
        ${options.q ? sql`AND ${t.threadId} IN (SELECT ${links.threadId} FROM ${links} JOIN ${messages} ON ${messages.id} = ${links.messageId} WHERE ${visibility} AND mail_messages.search @@ websearch_to_tsquery('simple', ${options.q}))` : sql``}
      GROUP BY ${t.threadId} HAVING true ${after ? sql`AND (max(${t.lastMessageAt}), ${t.threadId}) < (${after[0]}::timestamptz, ${after[1]})` : sql``}
        ${state ? sql`AND bool_or(${state})` : sql``}
      ORDER BY last_at DESC, id DESC LIMIT ${options.limit + 1}
    ) SELECT threads.id, m.subject, m.snippet, ${preciseTime(sql`threads.last_at`)} AS at, threads.address_ids, detail.message_count
      FROM threads CROSS JOIN LATERAL (SELECT count(DISTINCT mm.message_id)::int AS message_count,
        (array_agg(mm.message_id ORDER BY mm.received_at DESC, mm.message_id DESC))[1] AS latest_id
        FROM mailbox_messages mm WHERE mm.thread_id=threads.id AND mm.mailbox_id=ANY(threads.address_ids)) detail
      JOIN mail_messages m ON m.id=detail.latest_id ORDER BY threads.last_at DESC, threads.id DESC`);
  const last = rows.rows[options.limit - 1];
  return { data: rows.rows.slice(0, options.limit).map(row => ({ id: row.id, subject: row.subject, snippet: row.snippet, lastMessageAt: timestamp(row.at), addressIds: row.address_ids, messageCount: row.message_count })),
    nextCursor: rows.rows.length > options.limit && last ? encodeCursor(last.at, last.id) : null };
}

// Group *before* LIMIT: overlapping delivery links are one message, including at page boundaries.
function messageWindow(db: DbExecutor, value: MailboxAccess, filter: Filter, limit: number, cursor?: string) {
  const after = decodeCursor(cursor);
  return db.select({ id: links.messageId, at: links.receivedAt, read: sql<boolean>`bool_and(${links.read})`.as('is_read'), addressIds: sql<string[]>`array_agg(${links.mailboxId} ORDER BY ${links.mailboxId})`.as('address_ids') })
    .from(links).where(and(visibleLinks(value, filter), after ? sql`(${links.receivedAt}, ${links.messageId}) < (${after[0]}::timestamptz, ${after[1]})` : undefined))
    .groupBy(links.receivedAt, links.messageId).orderBy(desc(links.receivedAt), desc(links.messageId)).limit(limit).as('visible');
}
const metadataFields = { id: messages.id, threadId: messages.threadId, direction: messages.direction, status: messages.status,
  subject: messages.subject, snippet: messages.snippet, receivedAt: messages.receivedAt, attachmentCount: messages.attachmentCount };
const messageFields = { ...metadataFields, errorCode: messages.errorCode, fromName: messages.fromName, fromAddress: messages.fromAddress,
  to: messages.to, cc: messages.cc, replyTo: messages.replyTo, text: messages.text, html: messages.html, bodyTruncated: messages.bodyTruncated,
  sendingEmailId: messages.sendingEmailId, messageId: messages.messageId, inReplyTo: messages.inReplyTo, references: messages.references };
function messageView(row: Pick<typeof messages.$inferSelect, keyof typeof messageFields>, addressIds: string[], read = true) {
  const text = row.text ?? (row.html ? htmlToPlain(row.html) : '');
  return { id: row.id, threadId: row.threadId, addressIds, direction: row.direction, status: row.status, read, errorCode:row.errorCode,
    from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: row.cc, replyTo: row.replyTo, subject: row.subject, snippet: row.snippet,
    text, replyText: replyText(text), receivedAt: timestamp(row.receivedAt), bodyTruncated: row.bodyTruncated, attachmentCount: row.attachmentCount,
    emailId: row.sendingEmailId, messageId: row.messageId, inReplyTo: row.inReplyTo, references: row.references };
}
async function messagePage(db: DbExecutor, value: MailboxAccess, filter: Filter, limit: number, cursor?: string) {
  const w = messageWindow(db, value, filter, limit + 1, cursor);
  // The dedicated message read returns the full body. Bound each body on timeline pages so a page fits in a Worker.
  const cap = 8192;
  const rows = await db.select({ row: { ...messageFields, text: sql<string | null>`left(${messages.text}, ${cap})`, html: sql<string | null>`CASE WHEN ${messages.text} IS NULL THEN left(${messages.html}, ${cap}) END`,
    bodyTruncated: sql<boolean>`${messages.bodyTruncated} OR coalesce(length(coalesce(${messages.text}, ${messages.html})) > ${cap},false)` }, addressIds: w.addressIds, read:w.read, at: preciseTime(w.at) })
    .from(w).innerJoin(messages, eq(messages.id, w.id)).orderBy(desc(w.at), desc(w.id));
  const last = rows[limit - 1];
  return { messages: rows.slice(0, limit).reverse().map(item => messageView(item.row, item.addressIds,item.read)), nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.row.id) : null };
}

async function signedUrl(runtime: Runtime,wid:string, kind:'raw'|'att', region: string, bucket: string, key: string, filename?: string,pendingArchive?:string,client?:S3Client) {
  const s3 = client ?? await mailboxS3(runtime,wid,region,bucket);
  try {
    if(pendingArchive)await archiveMailboxFiles(runtime,wid,pendingArchive,s3);
    key=await readableMailboxKey(runtime,wid,region,bucket,key,kind,runtime.db,s3);
    const disposition = filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined;
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: 300 }), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  } finally { if(!client)s3.destroy(); }
}
async function deliveryLinks(runtime: Runtime, row: typeof messages.$inferSelect, files: (typeof mailAttachments.$inferSelect)[]) {
  const bucket = row.rawBucket ?? files[0]?.bucket, region = row.region;
  if (files.some(f => f.bucket !== bucket)) throw new ApiError(404, 'MAILBOX_OBJECT_NOT_FOUND', 'Message objects must use the same workspace storage connection.');
  if (!region || !bucket) return { rawUrl: null, urls: files.map(() => null) };
  const client = await mailboxS3(runtime, row.workspaceId, region, bucket);
  try {
    if (files.some(f => f.sourceId)) await archiveMailboxFiles(runtime, row.workspaceId, row.id, client);
    const link = async (kind:'att'|'raw', key:string, filename:string) => (await signedUrl(runtime, row.workspaceId, kind, region, bucket, key, filename, undefined, client)).url;
    return { rawUrl: row.rawKey ? await link('raw', row.rawKey, `${row.id}.eml`) : null, urls: await Promise.all(files.map(f => link('att', f.storageKey, f.filename))) };
  } finally { client.destroy(); }
}

export function registerInboundThreadReads(app: App, access: (c: Ctx, permission: 'read') => MailboxAccess) {
  app.openapi(createRoute({ method: 'get', path: base, operationId: 'listInboundThreads', tags, security, summary: 'List visible conversations',
    description: 'Newest visible activity first, then descending thread ID. addressId narrows all projected messages and IDs. q searches visible messages; view matches state on any visible address. all (default) includes trash. Pass nextCursor to continue.',
    request: { query: ListQuery }, responses: { 200: response(page(Thread).openapi('InboundThreadPage')), ...errors } }), async c => {
    const q = c.req.valid('query'); return c.json(await threadPage(c.env.db, access(c, 'read'), q, q), 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/{threadId}`, operationId: 'getInboundThread', tags, security, summary: 'Read a visible conversation',
    description: 'Returns the most recent visible messages (default 25, maximum 100), oldest first within the page. Ties use message ID. Pass nextCursor as cursor for the older page. Body previews are capped at 8192 characters; getInboundMessage retrieves stored text and attachment metadata. State and counts are scoped to visible addresses.',
    request: { params: ThreadParams, query: PageQuery }, responses: { 200: response(Thread.extend({ messages: z.array(Message), addressStates:z.array(AddressState), nextCursor: z.string().nullable() }).openapi('InboundThreadDetail')), ...errors } }), async c => {
    const value = access(c, 'read'), q = c.req.valid('query'), filter = { threadId: c.req.valid('param').threadId, addressId: q.addressId };
    const result = await c.env.db.transaction(async db => {
      const [thread] = (await threadPage(db, value, filter, { limit: 1 })).data;
      if (!thread) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found.');
      const t=mailboxThreads;
      const addressStates=await db.select({addressId:t.mailboxId, unreadCount:t.unreadCount, archived:t.archived,starred:t.starred,trashed:sql<boolean>`${t.trashedAt} IS NOT NULL`,spam:t.spam,labels:t.labels}).from(t).where(visibleThreadAddresses(value,filter.threadId,filter.addressId)).orderBy(asc(t.mailboxId));
      return { ...thread, ...await messagePage(db, value, filter, q.limit, q.cursor), addressStates };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    return c.json(result, 200);
  });
  const addressLinks = (v: MailboxAccess, f: Filter) => sql<string[]>`ARRAY(SELECT ${links.mailboxId} FROM ${links} WHERE ${visibleLinks(v, f)} AND ${links.messageId}=${messages.id} ORDER BY ${links.mailboxId})`;
  const accessible = (v: MailboxAccess, f: Filter) => and(eq(messages.workspaceId,v.workspaceId),eq(messages.environment,v.environment),
    v.admin && !f.addressId ? undefined : sql`EXISTS (SELECT 1 FROM ${links} WHERE ${visibleLinks(v,f)} AND ${links.messageId}=${messages.id})`);
  // Received Logs can inspect the entire workspace, including SMTP envelopes and unassigned mail.
  // Never grant this projection to an address key, even a key that can read every address.
  const includeDelivery = z.enum(['true','false']).optional().describe('Include delivery details for workspace logs (dashboard or unrestricted live manage access only).');
  function messageScope(c: Ctx, delivery?: string) {
    const v=access(c,'read');
    if (delivery!=='true') return v;
    const credential=c.get('actor')?.credential;
    if (credential!=='dashboard' && !(credential==='apiKey' && v.admin)) throw new ApiError(403,'ADMIN_REQUIRED','Delivery details require a dashboard session or an unrestricted live manage API key.');
    return {...v,admin:true};
  }
  const deliverySchema = z.object({addresses:z.array(z.object({id:Id,address:z.string()})),envelopeTo:z.array(z.string()),region:z.string().nullable(),spam:z.boolean(),to:z.array(Address)});
  const deliveryAddresses = (v:MailboxAccess,q:Filter) => sql<{id:string;address:string}[]>`coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'address',a.address) ORDER BY a.id)
      FROM mailbox_messages JOIN mailboxes a ON a.id=mailbox_messages.mailbox_id
      WHERE ${visibleLinks(v,q)} AND mailbox_messages.message_id=mail_messages.id), '[]'::jsonb)`;
  const MessageListItem = Message.pick({ id:true, threadId:true, addressIds:true, direction:true, status:true, subject:true, snippet:true, receivedAt:true, attachmentCount:true, from:true }).extend(deliverySchema.partial().shape);
  app.openapi(createRoute({ method:'get', path:'/v1/inbound/messages', operationId:'listInboundMessages', tags, security, summary:'Search received and sent messages', description:'Newest first; default inbound. Unassigned stored mail is visible only to a workspace administrator without an address filter.',
    request:{query:PageQuery.extend({ includeDelivery,region:z.string().max(40).optional(),threadId:Id.optional(),direction:z.enum(['inbound','outbound']).default('inbound'),q:z.string().trim().min(1).max(200).optional() })},responses:{200:response(page(MessageListItem).openapi('InboundMessagePage')),...errors} }), async c=>{
    const q=c.req.valid('query'),v=messageScope(c,q.includeDelivery),after=decodeCursor(q.cursor);
    const rows=await c.env.db.select({ ...metadataFields,...(q.includeDelivery==='true' ? {region:messages.region,spam:messages.spam,to:messages.to,envelopeTo:messages.envelopeTo,addresses:deliveryAddresses(v,q)} : {}),fromAddress:messages.fromAddress,fromName:messages.fromName,addressIds:addressLinks(v,q),at:preciseTime(messages.receivedAt) }).from(messages).where(and(accessible(v,q),eq(messages.direction,q.direction),q.region?eq(messages.region,q.region):undefined,q.threadId?eq(messages.threadId,q.threadId):undefined,
      q.q?sql`mail_messages.search @@ websearch_to_tsquery('simple',${q.q})`:undefined,after?sql`(${messages.receivedAt}, ${messages.id}) < (${after[0]}::timestamptz,${after[1]})`:undefined)).orderBy(desc(messages.receivedAt),desc(messages.id)).limit(q.limit+1);
    const last=rows[q.limit-1];return c.json({data:rows.slice(0,q.limit).map(({at,fromName,fromAddress,...row})=>({...row,receivedAt:timestamp(at),from:{name:fromName,address:fromAddress}})),nextCursor:rows.length>q.limit&&last?encodeCursor(last.at,last.id):null},200);
  });
  const Attachment = z.object({id:Id,filename:z.string(),contentType:z.string(),size:z.number().int(),disposition:z.string(),contentId:z.string().nullable(),url:z.string().nullable().optional()});
  const DeliveryDetail = deliverySchema.omit({to:true}).extend({rawUrl:z.string().nullable(),sentAt:z.string().nullable(),sizeBytes:z.number().int().nullable(),headers:z.array(z.object({name:z.string(),value:z.string()})),verdicts:z.record(z.string(),z.string())}).partial();
  app.openapi(createRoute({ method: 'get', path: '/v1/inbound/messages/{messageId}', operationId: 'getInboundMessage', tags, security, summary: 'Read a visible message',
    request: { params: z.object({ messageId: Id }), query: AddressFilter.extend({includeDelivery,includeHtml:z.enum(['true','false']).default('false')}) }, responses: { 200: response(Message.extend({...DeliveryDetail.shape,html:z.string().nullable(),attachments:z.array(Attachment)}).openapi('InboundMessageDetail')), ...errors } }), async c => {
    const q=c.req.valid('query'),v=messageScope(c,q.includeDelivery),id=c.req.valid('param').messageId;
    if (q.includeDelivery==='true') {
      const [result]=await c.env.db.select({row:messages,addresses:deliveryAddresses(v,q),addressIds:addressLinks(v,q),isRead:sql<boolean>`coalesce((SELECT bool_and(${links.read}) FROM ${links} WHERE ${visibleLinks(v,q)} AND ${links.messageId}=${messages.id}),false)`}).from(messages).where(and(eq(messages.id,id),accessible(v,q)));
      if (!result) throw new ApiError(404,'NOT_FOUND','Message was not found.');
      const {row,addresses,addressIds,isRead}=result;
      const files=await c.env.db.select().from(mailAttachments).where(eq(mailAttachments.messageId,id)).orderBy(asc(mailAttachments.id));
      const {rawUrl,urls}=await deliveryLinks(c.env,row,files);
      return c.json({...messageView(row,addressIds,isRead),addresses,envelopeTo:row.envelopeTo,region:row.region,spam:row.spam,headers:row.headers,verdicts:row.verdicts,sentAt:row.sentAt?timestamp(row.sentAt):null,sizeBytes:row.sizeBytes,rawUrl,html:q.includeHtml==='true'?row.html:null,
        attachments:files.map((f,i)=>({id:f.id,filename:f.filename,contentType:f.contentType,size:f.sizeBytes,disposition:f.disposition,contentId:f.contentId,url:urls[i]!}))},200);
    }
    const [row] = await c.env.db.select({...messageFields,addressIds:addressLinks(v,q),isRead:sql<boolean>`coalesce((SELECT bool_and(${links.read}) FROM ${links} WHERE ${visibleLinks(v,q)} AND ${links.messageId}=${messages.id}),false)`}).from(messages).where(and(eq(messages.id,id),accessible(v,q)));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Message was not found.');
    const attachments=await c.env.db.select({id:mailAttachments.id,filename:mailAttachments.filename,contentType:mailAttachments.contentType,size:mailAttachments.sizeBytes,disposition:mailAttachments.disposition,contentId:mailAttachments.contentId}).from(mailAttachments).where(eq(mailAttachments.messageId,id)).orderBy(asc(mailAttachments.id));
    return c.json({...messageView(row,row.addressIds,row.isRead),html:q.includeHtml==='true'?row.html:null,attachments},200);
  });
  app.openapi(createRoute({method:'get',path:'/v1/inbound/messages/{messageId}/attachments/{attachmentId}',operationId:'getInboundAttachment',tags,security,summary:'Download an attachment from a visible message',
    request:{params:z.object({messageId:Id,attachmentId:Id}),query:AddressFilter},responses:{200:response(z.object({url:z.string(),expiresAt:z.string()}).openapi('InboundAttachmentDownload')),...errors}}),async c=>{
    const v=access(c,'read'),p=c.req.valid('param'),q=c.req.valid('query');
    const [file]=await c.env.db.select({region:messages.region,bucket:mailAttachments.bucket,key:mailAttachments.storageKey,filename:mailAttachments.filename,sourceId:mailAttachments.sourceId}).from(messages).innerJoin(mailAttachments,eq(mailAttachments.messageId,messages.id)).where(and(eq(messages.id,p.messageId),eq(mailAttachments.id,p.attachmentId),accessible(v,q)));
    if (!file?.region) throw new ApiError(404,'NOT_FOUND','Attachment was not found.');
    return c.json(await signedUrl(c.env,v.workspaceId,'att',file.region,file.bucket,file.key,file.filename,file.sourceId?p.messageId:undefined),200);
  });
}

export function createInboundThreadRoute<T extends z.ZodType>(input: T) {
  return createRoute({ method: 'post', path: base, operationId: 'createInboundThread', tags, security, summary: 'Start a conversation from an inbound address',
    request: { headers: IdempotencyHeaders, body: json(input) }, responses: { 202: response(Message, 'Queued, not yet delivered.'), ...errors } });
}
export function replyToInboundThreadRoute<T extends z.ZodType>(input: T) {
  return createRoute({ method: 'post', path: `${base}/{threadId}/reply`, operationId: 'replyToInboundThread', tags, security, summary: 'Reply in a visible conversation',
    description: 'Replies to the newest visible message in either direction, breaking time ties by descending message ID. addressId restricts the target and sending address; provide it when the target is linked to more than one visible address. Set replyToMessageId to select an older visible message in this thread. For reviewed replies, pin both IDs and expectedRecipients. A recipient mismatch or a pending outbound parent without a provider Message-ID returns 409.',
    request: { params: ThreadParams, headers: IdempotencyHeaders, body: json(input) }, responses: { 202: response(Message, 'Queued, not yet delivered.'), ...errors } });
}
export async function inboundReplyTarget(db: DbExecutor, value: MailboxAccess, filter: Filter & { threadId: string }) {
  const w = messageWindow(db, value, filter, 1);
  const [parent] = await db.select({ row: messages, addressIds: w.addressIds }).from(w).innerJoin(messages, eq(messages.id, w.id));
  if (!parent) throw new ApiError(404, 'NOT_FOUND', 'There is no visible reply target in this conversation.');
  if (parent.addressIds.length !== 1) throw new ApiError(409, 'ADDRESS_REQUIRED', 'This message is linked to multiple addresses. Choose the sending address with addressId.', 'addressId');
  return { original: parent.row, addressId: parent.addressIds[0]! };
}

type Recipients = Pick<OutgoingMessage, 'to' | 'cc' | 'bcc'>;
export function assertInboundRecipients(expected: Recipients, resolved: Recipients) {
  const normalized = (list: string[]) => new Set(list.map(address => address.trim().toLowerCase()));
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const reviewed = normalized(expected[field]), actual = normalized(resolved[field]);
    if (reviewed.size !== actual.size || [...actual].some(address => !reviewed.has(address))) {
      throw new ApiError(409, 'INBOUND_RECIPIENTS_CHANGED', 'The reply recipients differ from those reviewed. Review To, Cc and Bcc before sending.', 'expectedRecipients');
    }
  }
}

export async function wakeMailboxSend(c: Ctx, actor: Actor, runnable: number) {
  for (const [region, count] of actor.dispatchTargets ?? []) { try { await c.env.dispatch?.(region, actor.dispatchAccount?.aws_account_id, count, actor.dispatchAccount?.kind); } catch { /* The dispatcher polls queued mail. */ } }
  actor.dispatchTargets?.clear();
  if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
}
export async function queueInboundThreadMessage(c: Ctx, actor: Actor, prepare: (db: DbExecutor) => Promise<Omit<OutgoingMessage, 'actor'>>) {
  let runnable = 0,prepared:Omit<OutgoingMessage,'actor'>|undefined;
  const body=await c.req.json<{attachments?:unknown[]}>();
  // Never resolve the parent, recipients, or attachments on replay. The path already binds the thread.
  const result = await idempotent(c, actor, body, async db => {
    const outgoing = prepared ?? await prepare(db);
    const queued = await sendFromMailbox(c.env, db, { ...outgoing, actor });
    runnable = queued.runnable;
    return messageView(queued.message, [outgoing.mailbox.id]);
  },undefined,body.attachments?.length ? async()=>{prepared=await prepare(c.env.db);} : undefined);
  if(result.attachmentCount) await finishMailboxArchive(c.env,actor.workspaceId,result.id);
  await wakeMailboxSend(c, actor, runnable);
  return result;
}
