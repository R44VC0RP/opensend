import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { ApiError, digest, errors, getSes, id, json, log, randomSecret, response, type Actor, type App, type Ctx, type MailboxAccess, type Runtime } from './core.js';
import { authenticate } from './auth.js';
import { domains } from './db/operations.js';
import { mailAttachments, mailboxAddresses, mailboxDomains, mailboxes, mailboxKeys, mailboxMessages, mailboxThreads, mailboxWebhookDeliveries, mailboxWebhooks, mailMessages, mailUnrouted, type MailboxPermission } from './db/mailbox.js';
import { expectedMx, checkMx, mxBlocksEnable } from './mailbox-dns.js';
import { eventView, latestCursor, mailboxEventTypes, readEvents, recordEvents, webhookSecretBinding } from './mailbox-events.js';
import { mailboxS3, queueReconcile } from './mailbox-setup.js';
import { attachToMailboxes, createMailbox, htmlToPlain, replyText, ruleMatches, validateRule, ADDRESS, type Scope } from './mailbox-store.js';
import { encrypt, webhookSecret, webhookUrl } from './operations.js';
import { idempotent, storeAttachmentBytes } from './sending.js';
import { assertReplyable, DEFAULT_SEND_LIMITS, forwardBody, safeForwardHtml, latestReplyTarget, replyRecipients, replySubject, resolveAttachments, sendFromMailbox, sendLimitsFor, type OutgoingMessage } from './mailbox-send.js';
import { resolveRegionRuntime } from './ses-region-state.js';

const BASE = '/mailbox/v1';
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
const LIVE = 'live' as const;
const TAG = { domains: 'Mailbox domains', mailboxes: 'Mailboxes', threads: 'Mailbox threads', messages: 'Mailbox messages', events: 'Mailbox events', keys: 'Mailbox keys', webhooks: 'Mailbox webhooks' };

// ---------- access ----------
function access(c: Ctx, permission?: MailboxPermission): MailboxAccess {
  const value = c.get('mailboxAccess');
  if (!value) throw new ApiError(401, 'AUTH_REQUIRED', 'Supply a mailbox key or an OpenSend API key.');
  if (permission && !value.admin && !value.permissions.includes(permission)) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
function admin(c: Ctx) { const value = access(c); if (!value.admin) throw new ApiError(403, 'ADMIN_REQUIRED', 'This operation requires an unrestricted live OpenSend key with manage permission.'); return value; }
const scopeOf = (value: MailboxAccess): Scope => ({ workspaceId: value.workspaceId, environment: LIVE });
async function mailboxFor(c: Ctx, mailboxId: string, permission: MailboxPermission = 'read') {
  const value = access(c, permission);
  if (value.mailboxIds && !value.mailboxIds.includes(mailboxId)) throw new ApiError(404, 'NOT_FOUND', 'Mailbox was not found.');
  const [row] = await c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), eq(mailboxes.environment, LIVE), eq(mailboxes.id, mailboxId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Mailbox was not found.');
  return { access: value, mailbox: row, scope: scopeOf(value) };
}

async function mailboxAuth(c: Ctx, next: () => Promise<void>) {
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (token?.startsWith('os_mbx_')) {
    if (!/^os_mbx_[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The mailbox key is invalid or has been revoked.');
    const [key] = await c.env.db.select().from(mailboxKeys).where(and(eq(mailboxKeys.hash, await digest(token)), eq(mailboxKeys.workspaceId, c.env.config.workspaceId), isNull(mailboxKeys.revokedAt))).limit(1);
    if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The mailbox key is invalid or has been revoked.');
    const budget = await c.env.db.execute<{ used: number }>(sql`INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used) VALUES (${key.workspaceId}, ${key.id}, date_trunc('minute', now()), 1)
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, 1201) ELSE 1 END, window_start = excluded.window_start RETURNING used`);
    if (budget.rows[0]!.used > 1200) { c.header('Retry-After', '60'); throw new ApiError(429, 'REQUEST_RATE_LIMITED', 'This key exceeded its 1200-request minute budget. Retry after the window resets.', undefined, true); }
    await c.env.db.update(mailboxKeys).set({ lastUsedAt: new Date().toISOString() }).where(and(eq(mailboxKeys.id, key.id), or(isNull(mailboxKeys.lastUsedAt), sql`${mailboxKeys.lastUsedAt} < now() - interval '1 minute'`)));
    c.set('mailboxAccess', { keyId: key.id, workspaceId: key.workspaceId, environment: LIVE, admin: false, mailboxIds: key.mailboxIds, permissions: key.permissions });
    c.env = await resolveRegionRuntime(c.env);
    return next();
  }
  return authenticate(c, async () => {
    const actor = c.get('actor');
    if (actor.credential !== 'dashboard' && actor.environment !== 'live') throw new ApiError(403, 'MAILBOX_LIVE_ONLY', 'Mailboxes receive real mail; use a live key.');
    if (actor.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Mailbox access requires a key without domain restrictions, or a mailbox key.');
    const manage = actor.permissions.includes('manage');
    const permissions: MailboxPermission[] = manage ? ['read', 'send', 'modify'] : actor.permissions.filter((p): p is 'read' | 'send' => p === 'read' || p === 'send');
    c.set('mailboxAccess', { keyId: actor.keyId, workspaceId: actor.workspaceId, environment: LIVE, admin: manage, mailboxIds: null, permissions });
    c.env = await resolveRegionRuntime(c.env);
    await next();
  });
}

// ---------- helpers ----------
const iso = (value: string | null | undefined) => value ? new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString() : null;
const exact = (value: string) => value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
function encodeCursor(values: (string | number)[]) { return Buffer.from(JSON.stringify(values)).toString('base64url'); }
function decodeCursor(value: string | undefined): [string, string] | null {
  if (!value) return null;
  try { const parsed = z.tuple([z.string().min(1).max(64), z.string().min(1).max(120)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); return parsed; }
  catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the cursor returned by the previous page.', 'cursor'); }
}
const labelName = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9][a-z0-9 _.:/-]*$/, 'Labels use letters, numbers, spaces and _ . : / -');

// ---------- schemas ----------
const Address = z.object({ name: z.string().nullable(), address: z.string() }).openapi('MailboxAddress');
const MxRecord = z.object({ type: z.literal('MX'), name: z.string(), value: z.string(), priority: z.number() });
const MxReportSchema = z.object({ state: z.enum(['active', 'missing', 'conflict', 'mixed', 'wrong_region', 'null_mx', 'cname', 'error']), expected: MxRecord, records: z.array(z.object({ priority: z.number(), host: z.string(), provider: z.string().nullable() })), providers: z.array(z.string()), message: z.string(), checkedAt: z.string() }).openapi('MailboxMxReport');
const DomainSchema = z.object({
  id: z.string().describe('OpenSend domain ID.'), name: z.string(), region: z.string(),
  status: z.enum(['off', 'provisioning', 'waiting_for_mx', 'active', 'disabling', 'disabled', 'failed']),
  catchAll: z.enum(['create_mailbox', 'store']).describe('What happens to mail for an address with no mailbox: create_mailbox makes one automatically; store keeps it as unrouted.'),
  dns: z.array(MxRecord).describe('Records to publish for receiving.'), mx: MxReportSchema.nullable(), lastError: z.string().nullable(),
  enabledAt: z.string().nullable(), checkedAt: z.string().nullable(), mailboxCount: z.number().int(),
  subdomains: z.object({ enabled: z.boolean().describe('Whether the receipt rule also matches every subdomain.'), count: z.number().int().describe('Receiving subdomains.'), dns: z.array(MxRecord).describe('The wildcard MX record subdomains need, published once.') }),
}).openapi('MailboxDomain');
const SubdomainSchema = z.object({
  id: z.string().describe('Subdomain ID (mdom_…).'), name: z.string().describe('Full host, e.g. acme.example.com.'), parentDomainId: z.string().describe('OpenSend domain ID of the parent.'), parentName: z.string(),
  status: z.enum(['active', 'disabled']), catchAll: z.enum(['create_mailbox', 'store']), metadata: z.record(z.string(), z.unknown()),
  dns: z.array(MxRecord).describe('The parent’s wildcard MX record, which receives this subdomain.'), mx: MxReportSchema.nullable(), mailboxCount: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
}).openapi('MailboxSubdomain');
const MailboxSchema = z.object({
  id: z.string(), address: z.string(), displayName: z.string().nullable(), domain: z.string(), aliases: z.array(z.string()), rules: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()), origin: z.enum(['api', 'auto']), createdAt: z.string(), updatedAt: z.string(),
  stats: z.object({ threads: z.number().int(), unreadThreads: z.number().int(), lastMessageAt: z.string().nullable() }),
  sendLimits: z.object({ perHour: z.number().int(), perDay: z.number().int(), perRecipientPerHour: z.number().int(), perThreadPer10Minutes: z.number().int() }).describe('Outbound limits that guard against runaway agents and reply loops.'),
}).openapi('Mailbox');
const ThreadSchema = z.object({
  id: z.string(), mailboxId: z.string(), subject: z.string(), snippet: z.string(), participants: z.array(Address), messageCount: z.number().int(), unreadCount: z.number().int(),
  lastMessageAt: z.string(), lastInboundAt: z.string().nullable(), archived: z.boolean(), starred: z.boolean(), spam: z.boolean(), trashed: z.boolean(), labels: z.array(z.string()),
}).openapi('MailboxThread');
const AttachmentSchema = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), contentId: z.string().nullable(), disposition: z.enum(['attachment', 'inline']) }).openapi('MailboxAttachment');
const MessageSummary = z.object({
  id: z.string(), threadId: z.string(), mailboxId: z.string(), direction: z.enum(['inbound', 'outbound']),
  status: z.string().describe('received for inbound mail. Outbound: queued, attempting, sent, delivered, delayed, bounced, complained, rejected, suppressed or canceled.'), errorCode: z.string().nullable().describe('Why an outbound message failed.'),
  read: z.boolean(), labels: z.array(z.string()).describe('Message labels (tags) in this mailbox.'),
  from: Address, to: z.array(Address), cc: z.array(Address), subject: z.string(), snippet: z.string(), sentAt: z.string().nullable(), receivedAt: z.string(),
  attachmentCount: z.number().int(), spam: z.boolean(), automated: z.boolean(),
}).openapi('MailboxMessageSummary');
const MessageSchema = MessageSummary.extend({
  bcc: z.array(Address), replyTo: z.array(Address), messageId: z.string().nullable(), inReplyTo: z.string().nullable(), references: z.array(z.string()),
  text: z.string().describe('Plain text body; derived from HTML when the message has no text part.'), replyText: z.string().describe('Text without quoted history.'),
  html: z.string().nullable(), bodyTruncated: z.boolean(), headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  attachments: z.array(AttachmentSchema), verdicts: z.object({ spf: z.string().optional(), dkim: z.string().optional(), dmarc: z.string().optional(), spam: z.string().optional(), virus: z.string().optional() }),
}).openapi('MailboxMessage');
const EventSchema = z.object({ id: z.string(), cursor: z.string(), type: z.enum(mailboxEventTypes), createdAt: z.string(), mailboxId: z.string().nullable(), threadId: z.string().nullable(), messageId: z.string().nullable(), data: z.record(z.string(), z.unknown()) }).openapi('MailboxEvent');
const KeySchema = z.object({ id: z.string(), name: z.string(), prefix: z.string(), mailboxIds: z.array(z.string()).nullable(), permissions: z.array(z.enum(['read', 'send', 'modify'])), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('MailboxKey');
const WebhookSchema = z.object({ id: z.string(), url: z.string(), description: z.string(), eventTypes: z.array(z.enum(mailboxEventTypes)), mailboxIds: z.array(z.string()).nullable(), paused: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).openapi('MailboxWebhook');
const DeliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), status: z.enum(['pending', 'delivered', 'failed']), attemptCount: z.number().int(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('MailboxWebhookDelivery');
const pageOf = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const MailboxParams = z.object({ mailboxId: z.string().min(1).max(120) });
const ThreadParams = MailboxParams.extend({ threadId: z.string().min(1).max(120) });
const MessageParams = MailboxParams.extend({ messageId: z.string().min(1).max(120) });
const IdParam = z.object({ id: z.string().min(1).max(120) });
const Ok = z.object({ ok: z.literal(true) }).openapi('MailboxOk');

// ---------- views ----------
async function domainViews(runtime: Runtime, rows: (typeof domains.$inferSelect)[]) {
  if (!rows.length) return [];
  const inbound = await runtime.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, runtime.config.workspaceId), eq(mailboxDomains.environment, LIVE), isNull(mailboxDomains.parentId), inArray(mailboxDomains.domainId, rows.map(row => row.id))));
  const counts = inbound.length ? await runtime.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, inbound.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  const children = inbound.length ? await runtime.db.select({ parentId: mailboxDomains.parentId, count: sql<number>`count(*)::int` }).from(mailboxDomains).where(and(inArray(mailboxDomains.parentId, inbound.map(row => row.id)), eq(mailboxDomains.status, 'active'))).groupBy(mailboxDomains.parentId) : [];
  return rows.map(row => {
    const state = inbound.find(item => item.domainId === row.id);
    return { id: row.id, name: row.name, region: row.region, status: state?.status ?? 'off' as const, catchAll: state?.catchAll ?? 'create_mailbox' as const, dns: [expectedMx(row.name, row.region)], mx: state?.mx ?? null, lastError: state?.lastError ?? null,
      enabledAt: iso(state?.enabledAt), checkedAt: iso(state?.checkedAt), mailboxCount: counts.find(item => item.domainId === state?.id)?.count ?? 0,
      subdomains: { enabled: state?.acceptSubdomains ?? false, count: children.find(item => item.parentId === state?.id)?.count ?? 0, dns: [expectedMx(`*.${row.name}`, row.region)] } };
  });
}
async function operationDomain(c: Ctx, domainId: string) {
  const [row] = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, c.env.config.workspaceId), eq(domains.environment, LIVE), eq(domains.id, domainId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Domain was not found.');
  return row;
}
async function subdomainViews(runtime: Runtime, parent: typeof mailboxDomains.$inferSelect, rows: (typeof mailboxDomains.$inferSelect)[]) {
  const counts = rows.length ? await runtime.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, rows.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  return rows.map(row => ({ id: row.id, name: row.name, parentDomainId: parent.domainId, parentName: parent.name, status: row.status === 'active' ? 'active' as const : 'disabled' as const, catchAll: row.catchAll, metadata: row.metadata,
    dns: [expectedMx(`*.${parent.name}`, parent.region)], mx: row.mx ?? null, mailboxCount: counts.find(item => item.domainId === row.id)?.count ?? 0, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! }));
}
/** The receiving top-level row for an OpenSend domain, which subdomains hang off. */
async function receivingParent(c: Ctx, domainId: string) {
  const row = await operationDomain(c, domainId);
  const [parent] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, c.env.config.workspaceId), eq(mailboxDomains.environment, LIVE), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId)));
  if (!parent || !['provisioning', 'waiting_for_mx', 'active'].includes(parent.status)) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Enable receiving for ${row.name} before adding subdomains.`);
  return parent;
}
async function subdomainRow(c: Ctx, parent: typeof mailboxDomains.$inferSelect, subdomainId: string) {
  const [row] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), eq(mailboxDomains.id, subdomainId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Subdomain was not found.');
  return row;
}
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const Metadata = z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 4096, 'Metadata must be at most 4 KB.');
async function mailboxViews(runtime: Runtime, rows: (typeof mailboxes.$inferSelect)[]) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const [addresses, stats, domainRows] = await Promise.all([
    runtime.db.select().from(mailboxAddresses).where(inArray(mailboxAddresses.mailboxId, ids)),
    runtime.db.select({ mailboxId: mailboxThreads.mailboxId, threads: sql<number>`count(*)::int`, unread: sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)::int`, last: sql<string | null>`max(${mailboxThreads.lastMessageAt})::text` })
      .from(mailboxThreads).where(and(inArray(mailboxThreads.mailboxId, ids), isNull(mailboxThreads.trashedAt))).groupBy(mailboxThreads.mailboxId),
    runtime.db.select({ id: mailboxDomains.id, name: mailboxDomains.name }).from(mailboxDomains).where(inArray(mailboxDomains.id, [...new Set(rows.map(row => row.domainId))])),
  ]);
  return rows.map(row => {
    const stat = stats.find(item => item.mailboxId === row.id);
    return { id: row.id, address: row.address, displayName: row.displayName, domain: domainRows.find(item => item.id === row.domainId)?.name ?? row.address.split('@')[1]!,
      aliases: addresses.filter(item => item.mailboxId === row.id && item.kind === 'alias').map(item => item.address).sort(), rules: row.rules, metadata: row.metadata, origin: row.origin,
      createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!, stats: { threads: stat?.threads ?? 0, unreadThreads: stat?.unread ?? 0, lastMessageAt: iso(stat?.last) }, sendLimits: sendLimitsFor(row) };
  });
}
const threadView = (row: typeof mailboxThreads.$inferSelect) => ({ id: row.threadId, mailboxId: row.mailboxId, subject: row.subject, snippet: row.snippet, participants: row.participants, messageCount: row.messageCount, unreadCount: row.unreadCount,
  lastMessageAt: iso(row.lastMessageAt)!, lastInboundAt: iso(row.lastInboundAt), archived: row.archived, starred: row.starred, spam: row.spam, trashed: !!row.trashedAt, labels: row.labels });
type MessageRow = typeof mailMessages.$inferSelect;
const summaryView = (row: MessageRow, mailboxId: string, read: boolean, labels: string[] = []) => ({ id: row.id, threadId: row.threadId, mailboxId, direction: row.direction, status: row.status, errorCode: row.errorCode, read, labels,
  from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: row.cc, subject: row.subject, snippet: row.snippet, sentAt: iso(row.sentAt), receivedAt: iso(row.receivedAt)!,
  attachmentCount: row.attachmentCount, spam: row.spam, automated: row.automated });
async function fullViews(runtime: Runtime, rows: { row: MessageRow; read: boolean; labels?: string[] }[], mailboxId: string, options: { html: boolean; headers: boolean }, db: Pick<Runtime['db'], 'select'> = runtime.db) {
  const files = rows.length ? await db.select().from(mailAttachments).where(inArray(mailAttachments.messageId, rows.map(item => item.row.id))).orderBy(asc(mailAttachments.id)) : [];
  return rows.map(({ row, read, labels }) => {
    const text = row.text ?? (row.html ? htmlToPlain(row.html) : '');
    return { ...summaryView(row, mailboxId, read, labels), bcc: row.bcc, replyTo: row.replyTo, messageId: row.messageId, inReplyTo: row.inReplyTo, references: row.references,
      text, replyText: replyText(text), html: options.html ? row.html : null, bodyTruncated: row.bodyTruncated, ...(options.headers ? { headers: row.headers } : {}),
      attachments: files.filter(file => file.messageId === row.id).map(file => ({ id: file.id, filename: file.filename, contentType: file.contentType, size: file.sizeBytes, contentId: file.contentId, disposition: file.disposition })), verdicts: row.verdicts };
  });
}
const keyView = (row: typeof mailboxKeys.$inferSelect) => ({ id: row.id, name: row.name, prefix: row.prefix, mailboxIds: row.mailboxIds, permissions: row.permissions, createdAt: iso(row.createdAt)!, lastUsedAt: iso(row.lastUsedAt), revokedAt: iso(row.revokedAt) });
const webhookView = (row: typeof mailboxWebhooks.$inferSelect) => ({ id: row.id, url: row.url, description: row.description, eventTypes: row.eventTypes as (typeof mailboxEventTypes[number])[], mailboxIds: row.mailboxIds, paused: row.paused, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });
async function signedUrl(runtime: Runtime, region: string, bucket: string, key: string, filename?: string) {
  const s3 = mailboxS3(runtime, region);
  try {
    const disposition = filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined;
    return { url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn: 300 }), expiresAt: new Date(Date.now() + 300_000).toISOString() };
  } finally { s3.destroy(); }
}
async function refreshThread(tx: Runtime['db'] | Parameters<Parameters<Runtime['db']['transaction']>[0]>[0], mailboxId: string, threadId: string) {
  await tx.execute(sql`UPDATE mailbox_threads SET unread_count = (SELECT count(*) FROM mailbox_messages WHERE mailbox_id = ${mailboxId} AND thread_id = ${threadId} AND NOT read AND direction = 'inbound') WHERE mailbox_id = ${mailboxId} AND thread_id = ${threadId}`);
}

const ThreadPatch = z.object({
  read: z.boolean().optional(), archived: z.boolean().optional(), starred: z.boolean().optional(), trashed: z.boolean().optional(), spam: z.boolean().optional(),
  addLabels: z.array(labelName).max(20).optional(), removeLabels: z.array(labelName).max(20).optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), 'Change at least one field.').openapi('UpdateMailboxThread');
type ThreadPatchInput = z.infer<typeof ThreadPatch>;
async function patchThreads(c: Ctx, mailboxId: string, threadIds: string[], patch: ThreadPatchInput) {
  const { scope } = await mailboxFor(c, mailboxId, 'modify');
  const runnable = await c.env.db.transaction(async tx => {
    const rows = await tx.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), inArray(mailboxThreads.threadId, threadIds))).for('update');
    if (rows.length !== new Set(threadIds).size) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found in this mailbox.');
    for (const row of rows) {
      if (patch.read === true) await tx.update(mailboxMessages).set({ read: true }).where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.threadId, row.threadId), eq(mailboxMessages.read, false)));
      if (patch.read === false) {
        const [latest] = await tx.select({ id: mailboxMessages.messageId }).from(mailboxMessages).where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.threadId, row.threadId), eq(mailboxMessages.direction, 'inbound'))).orderBy(desc(mailboxMessages.receivedAt)).limit(1);
        if (latest) await tx.update(mailboxMessages).set({ read: false }).where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.messageId, latest.id)));
      }
      const labels = [...new Set([...row.labels.filter(label => !patch.removeLabels?.includes(label)), ...(patch.addLabels ?? [])])].slice(0, 50);
      await tx.update(mailboxThreads).set({
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.starred !== undefined ? { starred: patch.starred } : {}), ...(patch.spam !== undefined ? { spam: patch.spam } : {}),
        ...(patch.trashed !== undefined ? { trashedAt: patch.trashed ? (row.trashedAt ?? new Date().toISOString()) : null } : {}), labels,
      }).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, row.threadId)));
      if (patch.read !== undefined) await refreshThread(tx, mailboxId, row.threadId);
    }
    return recordEvents(tx, scope.workspaceId, scope.environment, rows.map(row => ({ type: 'thread.updated', mailboxId, threadId: row.threadId, data: { changes: patch } })));
  });
  if (runnable) try { await c.env.wake?.(runnable); } catch { /* Webhook jobs are durable. */ }
  const updated = await c.env.db.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), inArray(mailboxThreads.threadId, threadIds)));
  return updated.map(threadView);
}

const MessagePatch = z.object({ read: z.boolean().optional(), addLabels: z.array(labelName).max(20).optional(), removeLabels: z.array(labelName).max(20).optional() })
  .strict().refine(value => Object.values(value).some(item => item !== undefined), 'Change at least one field.').openapi('UpdateMailboxMessage');
async function patchMessages(c: Ctx, mailboxId: string, messageIds: string[], patch: z.infer<typeof MessagePatch>) {
  const { scope } = await mailboxFor(c, mailboxId, 'modify');
  const runnable = await c.env.db.transaction(async tx => {
    const rows = await tx.select().from(mailboxMessages).where(and(eq(mailboxMessages.mailboxId, mailboxId), inArray(mailboxMessages.messageId, messageIds))).for('update');
    if (rows.length !== messageIds.length) throw new ApiError(404, 'NOT_FOUND', 'Message was not found in this mailbox.');
    for (const row of rows) {
      const labels = [...new Set([...row.labels.filter(label => !patch.removeLabels?.includes(label)), ...(patch.addLabels ?? [])])].slice(0, 50);
      await tx.update(mailboxMessages).set({ labels, ...(patch.read !== undefined ? { read: patch.read } : {}) }).where(and(eq(mailboxMessages.mailboxId, mailboxId), eq(mailboxMessages.messageId, row.messageId)));
    }
    if (patch.read !== undefined) for (const threadId of new Set(rows.map(row => row.threadId))) await refreshThread(tx, mailboxId, threadId);
    return recordEvents(tx, scope.workspaceId, scope.environment, rows.map(row => ({ type: 'message.updated' as const, mailboxId, threadId: row.threadId, messageId: row.messageId, data: { changes: patch } })));
  });
  if (runnable) try { await c.env.wake?.(runnable); } catch { /* Webhook jobs are durable. */ }
  const updated = await c.env.db.select({ row: mailMessages, read: mailboxMessages.read, labels: mailboxMessages.labels }).from(mailboxMessages).innerJoin(mailMessages, eq(mailMessages.id, mailboxMessages.messageId)).where(and(eq(mailboxMessages.mailboxId, mailboxId), inArray(mailboxMessages.messageId, messageIds)));
  return updated.map(item => summaryView(item.row, mailboxId, item.read, item.labels));
}

/** Links earlier stored mail for newly claimed addresses and rules to a mailbox. */
async function claimUnrouted(tx: Parameters<Parameters<Runtime['db']['transaction']>[0]>[0], scope: Scope, mailbox: typeof mailboxes.$inferSelect, addresses: string[], rules: string[]) {
  const domain = mailbox.address.split('@')[1]!;
  const rows = await tx.select().from(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), eq(mailUnrouted.environment, scope.environment), or(inArray(mailUnrouted.address, addresses), rules.length ? sql`${mailUnrouted.address} LIKE ${`%@${domain}`} OR ${mailUnrouted.address} LIKE ${`%.${domain}`}` : sql`false`))).limit(2000);
  const claimed = rows.filter(row => addresses.includes(row.address) || rules.some(rule => ruleMatches(rule, row.address)) || addresses.some(address => { const [local, host] = row.address.split('@'); return local?.includes('+') && `${local.split('+')[0]}@${host}` === address; }));
  if (!claimed.length) return 0;
  const messageIds = [...new Set(claimed.map(row => row.messageId))];
  const messages = await tx.select().from(mailMessages).where(inArray(mailMessages.id, messageIds)).orderBy(asc(mailMessages.receivedAt));
  for (const message of messages) await attachToMailboxes(tx, scope, message, [mailbox.id]);
  for (const row of claimed) await tx.delete(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), eq(mailUnrouted.environment, scope.environment), eq(mailUnrouted.address, row.address), eq(mailUnrouted.messageId, row.messageId)));
  return messages.length;
}

export function registerMailbox(app: App) {
  app.use(`${BASE}/*`, mailboxAuth);
  const route = <T extends Parameters<typeof createRoute>[0]>(config: T) => createRoute({ ...config, path: `${BASE}${config.path}`, security } as T);

  // ---------- domains ----------
  app.openapi(route({ method: 'get', path: '/domains', operationId: 'mailboxListDomains', tags: [TAG.domains], summary: 'List domains and their receiving status', responses: { 200: response(z.object({ data: z.array(DomainSchema) }).openapi('MailboxDomainList')), ...errors } }), async c => {
    admin(c);
    const rows = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, c.env.config.workspaceId), eq(domains.environment, LIVE), inArray(domains.region, c.env.config.regions))).orderBy(asc(domains.name));
    return c.json({ data: await domainViews(c.env, rows) }, 200);
  });
  app.openapi(route({ method: 'get', path: '/domains/{id}', operationId: 'mailboxGetDomain', tags: [TAG.domains], request: { params: IdParam }, responses: { 200: response(DomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    return c.json((await domainViews(c.env, [row]))[0]!, 200);
  });
  app.openapi(route({ method: 'post', path: '/domains/{id}/check', operationId: 'mailboxCheckDomain', tags: [TAG.domains], summary: 'Check MX records now', description: 'Reads public DNS and reports who currently receives mail for the domain. Updates the receiving status when inbound is enabled. Never changes DNS or AWS.', request: { params: IdParam }, responses: { 200: response(DomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    const mx = await checkMx(row.name, row.region);
    await c.env.db.update(mailboxDomains).set({ mx, checkedAt: mx.checkedAt, updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.workspaceId, c.env.config.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId)));
    if (mx.state !== 'error') await c.env.db.update(mailboxDomains).set({ status: mx.state === 'active' ? 'active' : 'waiting_for_mx' }).where(and(eq(mailboxDomains.workspaceId, c.env.config.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['waiting_for_mx', 'active'])));
    const [view] = await domainViews(c.env, [row]);
    return c.json({ ...view!, mx }, 200);
  });
  app.openapi(route({ method: 'post', path: '/domains/{id}/enable', operationId: 'mailboxEnableDomain', tags: [TAG.domains], summary: 'Enable receiving for a verified domain',
    description: 'Checks that the domain is verified in SES and that its MX records will not take mail from another provider, then queues setup: an OpenSend S3 bucket, SNS topic and a catch-all SES receipt rule for the domain. Publish the returned MX record to start receiving. Use force=true to take over a domain whose mail another provider receives today.',
    request: { params: IdParam, body: json(z.object({ catchAll: z.enum(['create_mailbox', 'store']).optional(), force: z.boolean().default(false) }).strict().openapi('EnableMailboxDomain')) }, responses: { 202: response(DomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id); const input = c.req.valid('json');
    if (!c.env.config.regions.includes(row.region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'Enable the domain’s SES region first.');
    const identity = await getSes(c.env, row.region).send(new GetEmailIdentityCommand({ EmailIdentity: row.name })).catch(() => { throw new ApiError(503, 'SES_UNAVAILABLE', 'Could not read the domain’s SES verification status.', undefined, true); });
    if (identity.VerificationStatus !== 'SUCCESS') throw new ApiError(409, 'DOMAIN_NOT_VERIFIED', 'Verify the domain in SES before enabling mailboxes.');
    const mx = await checkMx(row.name, row.region);
    if (mxBlocksEnable(mx) && !input.force) throw new ApiError(409, 'MX_CONFLICT', `${mx.message} Retry with force=true to continue anyway.`);
    await c.env.db.transaction(async tx => {
      const [current] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.environment, LIVE), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId))).for('update');
      const now = new Date().toISOString();
      if (!current) await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: value.workspaceId, environment: LIVE, domainId: row.id, name: row.name, region: row.region, status: 'provisioning', catchAll: input.catchAll ?? 'create_mailbox', mx, checkedAt: mx.checkedAt });
      else await tx.update(mailboxDomains).set({ ...(['disabled', 'disabling', 'failed'].includes(current.status) ? { status: 'provisioning' as const, lastError: null } : {}), ...(input.catchAll ? { catchAll: input.catchAll } : {}), mx, checkedAt: mx.checkedAt, updatedAt: now }).where(eq(mailboxDomains.id, current.id));
      await queueReconcile(tx, value.workspaceId, row.region);
    });
    log('info', { code: 'MAILBOX_DOMAIN_ENABLE_QUEUED', region: row.region, mx: mx.state });
    return c.json((await domainViews(c.env, [row]))[0]!, 202);
  });
  app.openapi(route({ method: 'post', path: '/domains/{id}/disable', operationId: 'mailboxDisableDomain', tags: [TAG.domains], summary: 'Stop receiving for a domain', description: 'Removes the domain from the OpenSend receipt rule. Mailboxes and stored messages are kept.', request: { params: IdParam }, responses: { 202: response(DomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    await c.env.db.transaction(async tx => {
      const updated = await tx.update(mailboxDomains).set({ status: 'disabling', updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['provisioning', 'waiting_for_mx', 'active', 'failed']))).returning({ id: mailboxDomains.id });
      if (updated.length) await queueReconcile(tx, value.workspaceId, row.region);
    });
    return c.json((await domainViews(c.env, [row]))[0]!, 202);
  });
  app.openapi(route({ method: 'patch', path: '/domains/{id}', operationId: 'mailboxUpdateDomain', tags: [TAG.domains], request: { params: IdParam, body: json(z.object({ catchAll: z.enum(['create_mailbox', 'store']) }).strict().openapi('UpdateMailboxDomain')) }, responses: { 200: response(DomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    const updated = await c.env.db.update(mailboxDomains).set({ catchAll: c.req.valid('json').catchAll, updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId))).returning({ id: mailboxDomains.id });
    if (!updated.length) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', 'Enable receiving for this domain first.');
    return c.json((await domainViews(c.env, [row]))[0]!, 200);
  });

  // ---------- subdomains ----------
  const SubParams = z.object({ id: z.string().min(1).max(120), subdomainId: z.string().min(1).max(120) });
  app.openapi(route({ method: 'get', path: '/domains/{id}/subdomains', operationId: 'mailboxListSubdomains', tags: [TAG.domains], summary: 'List receiving subdomains',
    request: { params: IdParam, query: z.object({ status: z.enum(['active', 'disabled', 'all']).default('active'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(SubdomainSchema, 'MailboxSubdomainPage')), ...errors } }), async c => {
    admin(c); const parent = await receivingParent(c, c.req.valid('param').id); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), q.status === 'all' ? undefined : q.status === 'active' ? eq(mailboxDomains.status, 'active') : sql`${mailboxDomains.status} <> 'active'`, q.cursor ? sql`${mailboxDomains.name} > ${q.cursor}` : undefined)).orderBy(asc(mailboxDomains.name)).limit(q.limit + 1);
    return c.json({ data: await subdomainViews(c.env, parent, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.name : null }, 200);
  });
  app.openapi(route({ method: 'post', path: '/domains/{id}/subdomains', operationId: 'mailboxCreateSubdomain', tags: [TAG.domains], summary: 'Add a receiving subdomain',
    description: 'Starts receiving mail for name.example.com under a receiving example.com, with no DNS change or SES verification per subdomain. The first subdomain adds the wildcard recipient (.example.com) to the receipt rule; publish the returned *.example.com MX record once. Mailboxes can then be created on the subdomain. Re-adding a removed subdomain restores it.',
    request: { params: IdParam, body: json(z.object({ name: z.string().trim().toLowerCase().max(253).describe('A label (acme) or the full host (acme.example.com).'), catchAll: z.enum(['create_mailbox', 'store']).default('store').describe('Mail for an address with no mailbox: store keeps it as unrouted (default); create_mailbox makes one.'), metadata: Metadata.default({}) }).strict().openapi('CreateMailboxSubdomain')) },
    responses: { 201: response(SubdomainSchema), ...errors } }), async c => {
    const value = admin(c); const parent = await receivingParent(c, c.req.valid('param').id); const input = c.req.valid('json');
    const label = input.name.endsWith(`.${parent.name}`) ? input.name.slice(0, -(parent.name.length + 1)) : input.name;
    if (!LABEL.test(label)) throw new ApiError(422, 'INVALID_SUBDOMAIN', `Use one DNS label of letters, digits and hyphens, e.g. acme for acme.${parent.name}.`, 'name');
    const name = `${label}.${parent.name}`;
    const mx = await checkMx(name, parent.region);
    const row = await c.env.db.transaction(async tx => {
      // One lock per parent keeps accept_subdomains consistent with its active subdomains.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_subdomains:${parent.id}`}))`);
      const [fresh] = await tx.select({ acceptSubdomains: mailboxDomains.acceptSubdomains }).from(mailboxDomains).where(eq(mailboxDomains.id, parent.id));
      const [existing] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.environment, LIVE), eq(mailboxDomains.name, name)));
      if (existing && (existing.parentId !== parent.id || existing.status === 'active')) throw new ApiError(409, 'SUBDOMAIN_EXISTS', `${name} already receives mail.`, 'name');
      const now = new Date().toISOString();
      const [saved] = existing
        ? await tx.update(mailboxDomains).set({ status: 'active', catchAll: input.catchAll, metadata: input.metadata, mx, checkedAt: mx.checkedAt, lastError: null, enabledAt: now, updatedAt: now }).where(eq(mailboxDomains.id, existing.id)).returning()
        : await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: value.workspaceId, environment: LIVE, domainId: parent.domainId, parentId: parent.id, name, region: parent.region, status: 'active', catchAll: input.catchAll, metadata: input.metadata, mx, checkedAt: mx.checkedAt, enabledAt: now }).returning();
      if (!fresh?.acceptSubdomains) {
        await tx.update(mailboxDomains).set({ acceptSubdomains: true, updatedAt: now }).where(eq(mailboxDomains.id, parent.id));
        await queueReconcile(tx, value.workspaceId, parent.region);
      }
      return saved!;
    });
    log('info', { code: 'MAILBOX_SUBDOMAIN_ADDED', region: parent.region, mx: mx.state });
    return c.json((await subdomainViews(c.env, { ...parent, acceptSubdomains: true }, [row]))[0]!, 201);
  });
  app.openapi(route({ method: 'get', path: '/domains/{id}/subdomains/{subdomainId}', operationId: 'mailboxGetSubdomain', tags: [TAG.domains], request: { params: SubParams }, responses: { 200: response(SubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id);
    return c.json((await subdomainViews(c.env, parent, [await subdomainRow(c, parent, params.subdomainId)]))[0]!, 200);
  });
  app.openapi(route({ method: 'patch', path: '/domains/{id}/subdomains/{subdomainId}', operationId: 'mailboxUpdateSubdomain', tags: [TAG.domains],
    request: { params: SubParams, body: json(z.object({ catchAll: z.enum(['create_mailbox', 'store']).optional(), metadata: Metadata.optional() }).strict().openapi('UpdateMailboxSubdomain')) }, responses: { 200: response(SubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id); const input = c.req.valid('json');
    const current = await subdomainRow(c, parent, params.subdomainId);
    const [row] = await c.env.db.update(mailboxDomains).set({ ...(input.catchAll ? { catchAll: input.catchAll } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, current.id)).returning();
    return c.json((await subdomainViews(c.env, parent, [row!]))[0]!, 200);
  });
  app.openapi(route({ method: 'delete', path: '/domains/{id}/subdomains/{subdomainId}', operationId: 'mailboxRemoveSubdomain', tags: [TAG.domains], summary: 'Stop receiving for a subdomain',
    description: 'New mail to the subdomain is dropped. Its mailboxes and stored messages are kept, and adding the subdomain again restores it. Removing the last subdomain takes the wildcard recipient out of the receipt rule.', request: { params: SubParams }, responses: { 200: response(SubdomainSchema), ...errors } }), async c => {
    const value = admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id);
    const current = await subdomainRow(c, parent, params.subdomainId);
    const row = await c.env.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_subdomains:${parent.id}`}))`);
      const [fresh] = await tx.select({ acceptSubdomains: mailboxDomains.acceptSubdomains }).from(mailboxDomains).where(eq(mailboxDomains.id, parent.id));
      const now = new Date().toISOString();
      const [saved] = await tx.update(mailboxDomains).set({ status: 'disabled', updatedAt: now }).where(eq(mailboxDomains.id, current.id)).returning();
      const [left] = await tx.select({ count: sql<number>`count(*)::int` }).from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), eq(mailboxDomains.status, 'active')));
      if (!left?.count && fresh?.acceptSubdomains) {
        await tx.update(mailboxDomains).set({ acceptSubdomains: false, updatedAt: now }).where(eq(mailboxDomains.id, parent.id));
        await queueReconcile(tx, value.workspaceId, parent.region);
      }
      return saved!;
    });
    return c.json((await subdomainViews(c.env, parent, [row]))[0]!, 200);
  });

  // ---------- mailboxes ----------
  const MailboxInput = z.object({
    address: z.string().trim().toLowerCase().max(254).regex(ADDRESS, 'Use a valid email address.'), displayName: z.string().trim().max(200).nullable().optional(),
    aliases: z.array(z.string().trim().toLowerCase().max(254).regex(ADDRESS)).max(50).default([]), rules: z.array(z.string().max(254)).max(20).default([]).describe('Wildcard address patterns, e.g. support+*@acme.com or *@help.acme.com.'),
    metadata: z.record(z.string(), z.unknown()).default({}).refine(value => JSON.stringify(value).length <= 16384, 'Metadata must be at most 16 KB.'),
    sendLimits: z.object({ perHour: z.number().int().min(0).max(10000), perDay: z.number().int().min(0).max(100000), perRecipientPerHour: z.number().int().min(0).max(1000), perThreadPer10Minutes: z.number().int().min(0).max(1000) }).partial().strict().optional()
      .describe(`Override outbound limits. Defaults: ${Object.entries(DEFAULT_SEND_LIMITS).map(([key, value]) => `${key} ${value}`).join(', ')}. 0 blocks sending.`),
  }).strict().openapi('CreateMailbox');
  app.openapi(route({ method: 'get', path: '/mailboxes', operationId: 'mailboxList', tags: [TAG.mailboxes], summary: 'List mailboxes', description: 'Mailbox keys see only the mailboxes they are scoped to.',
    request: { query: z.object({ domain: z.string().max(253).optional(), origin: z.enum(['api', 'auto']).optional(), q: z.string().max(200).optional(), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(MailboxSchema, 'MailboxPage')), ...errors } }), async c => {
    const value = access(c, 'read'); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), eq(mailboxes.environment, LIVE), value.mailboxIds ? inArray(mailboxes.id, value.mailboxIds.length ? value.mailboxIds : ['']) : undefined,
      q.domain ? sql`split_part(${mailboxes.address}, '@', 2) = ${q.domain.toLowerCase()}` : undefined, q.origin ? eq(mailboxes.origin, q.origin) : undefined,
      q.q ? or(sql`${mailboxes.address} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`, sql`${mailboxes.displayName} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`) : undefined,
      q.cursor ? lt(mailboxes.id, q.cursor) : undefined)).orderBy(desc(mailboxes.id)).limit(q.limit + 1);
    return c.json({ data: await mailboxViews(c.env, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes', operationId: 'mailboxCreate', tags: [TAG.mailboxes], summary: 'Create a mailbox', description: 'The address must be on a domain with receiving enabled. Mail already stored for the address, its aliases or rules is linked to the new mailbox.', request: { body: json(MailboxInput) }, responses: { 201: response(MailboxSchema), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json'); const scope = scopeOf(value);
    const host = input.address.split('@')[1]!;
    const [domain] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.environment, LIVE), eq(mailboxDomains.name, host)));
    if (!domain || ['disabled', 'disabling'].includes(domain.status)) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Enable receiving for ${host} before creating mailboxes on it.`, 'address');
    const { row, runnable } = await c.env.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mailbox_address:${value.workspaceId}:${input.address}`}))`);
      const created = await createMailbox(tx, scope, { domainId: domain.id, domainName: domain.name, address: input.address, displayName: input.displayName ?? null, aliases: input.aliases, rules: input.rules, metadata: input.metadata, origin: 'api', sendLimits: input.sendLimits });
      await claimUnrouted(tx, scope, created, [created.address, ...input.aliases], created.rules);
      return { row: created, runnable: await recordEvents(tx, scope.workspaceId, scope.environment, [{ type: 'mailbox.created', mailboxId: created.id, data: { origin: 'api', address: created.address } }]) };
    });
    if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
    return c.json((await mailboxViews(c.env, [row]))[0]!, 201);
  });
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}', operationId: 'mailboxGet', tags: [TAG.mailboxes], request: { params: MailboxParams }, responses: { 200: response(MailboxSchema), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').mailboxId);
    return c.json((await mailboxViews(c.env, [mailbox]))[0]!, 200);
  });
  app.openapi(route({ method: 'patch', path: '/mailboxes/{mailboxId}', operationId: 'mailboxUpdate', tags: [TAG.mailboxes], description: 'aliases and rules replace the current lists. The primary address cannot change.',
    request: { params: MailboxParams, body: json(MailboxInput.omit({ address: true }).partial().strict().openapi('UpdateMailbox')) }, responses: { 200: response(MailboxSchema), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').mailboxId); const input = c.req.valid('json');
    const domain = mailbox.address.split('@')[1]!;
    await c.env.db.transaction(async tx => {
      const rules = input.rules ? [...new Set(input.rules.map(rule => validateRule(rule, domain)))] : undefined;
      const [updated] = await tx.update(mailboxes).set({ ...(input.displayName !== undefined ? { displayName: input.displayName } : {}), ...(rules ? { rules } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.sendLimits ? { sendLimits: { ...mailbox.sendLimits, ...input.sendLimits } } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxes.id, mailbox.id)).returning();
      let added: string[] = [];
      if (input.aliases) {
        const aliases = [...new Set(input.aliases)].filter(alias => alias !== mailbox.address);
        for (const alias of aliases) if (!alias.endsWith(`@${domain}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Aliases must end in @${domain}.`, 'aliases');
        const current = await tx.select().from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), eq(mailboxAddresses.kind, 'alias')));
        const removed = current.filter(row => !aliases.includes(row.address)).map(row => row.address);
        added = aliases.filter(alias => !current.some(row => row.address === alias));
        if (removed.length) await tx.delete(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), inArray(mailboxAddresses.address, removed)));
        if (added.length) {
          const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), eq(mailboxAddresses.environment, scope.environment), inArray(mailboxAddresses.address, added)));
          if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'aliases');
          await tx.insert(mailboxAddresses).values(added.map(address => ({ ...scope, address, mailboxId: mailbox.id, kind: 'alias' as const })));
        }
      }
      if (added.length || rules?.length) await claimUnrouted(tx, scope, updated!, added, rules ?? []);
    });
    const [row] = await c.env.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    return c.json((await mailboxViews(c.env, [row!]))[0]!, 200);
  });
  app.openapi(route({ method: 'delete', path: '/mailboxes/{mailboxId}', operationId: 'mailboxDelete', tags: [TAG.mailboxes], description: 'Deletes the mailbox, its addresses and its per-mailbox state. Stored messages are kept; future mail to its addresses follows the domain catch-all setting.', request: { params: MailboxParams }, responses: { 200: response(Ok), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').mailboxId);
    const runnable = await c.env.db.transaction(async tx => {
      await tx.delete(mailboxThreads).where(eq(mailboxThreads.mailboxId, mailbox.id));
      await tx.delete(mailboxes).where(eq(mailboxes.id, mailbox.id));
      return recordEvents(tx, scope.workspaceId, scope.environment, [{ type: 'mailbox.deleted', mailboxId: mailbox.id, data: { address: mailbox.address } }]);
    });
    if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
    return c.json({ ok: true as const }, 200);
  });

  // ---------- threads ----------
  const views = { inbox: 'Not archived, trashed or spam', archive: 'Archived', starred: 'Starred', trash: 'Trashed', spam: 'Spam', all: 'Everything except trash' };
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/threads', operationId: 'mailboxListThreads', tags: [TAG.threads], summary: 'List conversations', description: `Newest activity first. view: ${Object.entries(views).map(([k, v]) => `${k} (${v})`).join(', ')}. q runs a full-text search over subject, sender and body.`,
    request: { params: MailboxParams, query: z.object({ view: z.enum(['inbox', 'archive', 'starred', 'trash', 'spam', 'all']).default('inbox'), unread: z.enum(['true', 'false']).optional(), label: labelName.optional(), q: z.string().trim().min(1).max(200).optional(), cursor: z.string().max(300).optional(), limit: Limit }) },
    responses: { 200: response(pageOf(ThreadSchema, 'MailboxThreadPage')), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').mailboxId); const q = c.req.valid('query');
    const t = mailboxThreads, cursor = decodeCursor(q.cursor);
    const filters: (SQL | undefined)[] = [eq(t.mailboxId, mailbox.id),
      q.view === 'trash' ? isNotNull(t.trashedAt) : isNull(t.trashedAt),
      q.view === 'inbox' ? and(eq(t.archived, false), eq(t.spam, false)) : q.view === 'archive' ? eq(t.archived, true) : q.view === 'starred' ? eq(t.starred, true) : q.view === 'spam' ? eq(t.spam, true) : undefined,
      q.unread === 'true' ? sql`${t.unreadCount} > 0` : q.unread === 'false' ? eq(t.unreadCount, 0) : undefined,
      q.label ? sql`${t.labels} @> ARRAY[${q.label}]::text[]` : undefined,
      q.q ? sql`EXISTS (SELECT 1 FROM mailbox_messages mm JOIN mail_messages m ON m.id = mm.message_id WHERE mm.mailbox_id = ${t.mailboxId} AND mm.thread_id = ${t.threadId} AND m.search @@ websearch_to_tsquery('simple', ${q.q}))` : undefined,
      cursor ? sql`(${t.lastMessageAt}, ${t.threadId}) < (${cursor[0]}::timestamptz, ${cursor[1]})` : undefined];
    const rows = await c.env.db.select().from(t).where(and(...filters)).orderBy(desc(t.lastMessageAt), desc(t.threadId)).limit(q.limit + 1);
    const last = rows[q.limit - 1];
    return c.json({ data: rows.slice(0, q.limit).map(threadView), nextCursor: rows.length > q.limit && last ? encodeCursor([exact(last.lastMessageAt), last.threadId]) : null }, 200);
  });
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/threads/{threadId}', operationId: 'mailboxGetThread', tags: [TAG.threads], summary: 'Read a conversation', description: 'Messages this mailbox can see, oldest first, with plain text and reply text. Set includeHtml=true for HTML bodies.',
    request: { params: ThreadParams, query: z.object({ includeHtml: z.enum(['true', 'false']).default('false') }) }, responses: { 200: response(ThreadSchema.extend({ messages: z.array(MessageSchema) }).openapi('MailboxThreadDetail')), ...errors } }), async c => {
    const p = c.req.valid('param'); const { mailbox } = await mailboxFor(c, p.mailboxId);
    const [thread] = await c.env.db.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailbox.id), eq(mailboxThreads.threadId, p.threadId)));
    if (!thread) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found in this mailbox.');
    const rows = await c.env.db.select({ row: mailMessages, read: mailboxMessages.read, labels: mailboxMessages.labels }).from(mailboxMessages).innerJoin(mailMessages, eq(mailMessages.id, mailboxMessages.messageId)).where(and(eq(mailboxMessages.mailboxId, mailbox.id), eq(mailboxMessages.threadId, p.threadId))).orderBy(asc(mailboxMessages.receivedAt)).limit(200);
    return c.json({ ...threadView(thread), messages: await fullViews(c.env, rows, mailbox.id, { html: c.req.valid('query').includeHtml === 'true', headers: false }) }, 200);
  });
  app.openapi(route({ method: 'patch', path: '/mailboxes/{mailboxId}/threads/{threadId}', operationId: 'mailboxUpdateThread', tags: [TAG.threads], summary: 'Mark read/unread, archive, star, trash, spam or label', description: 'read=false marks the latest inbound message unread.', request: { params: ThreadParams, body: json(ThreadPatch) }, responses: { 200: response(ThreadSchema), ...errors } }), async c => {
    const p = c.req.valid('param');
    return c.json((await patchThreads(c, p.mailboxId, [p.threadId], c.req.valid('json')))[0]!, 200);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/threads/batch', operationId: 'mailboxUpdateThreads', tags: [TAG.threads], summary: 'Update up to 100 conversations at once', request: { params: MailboxParams, body: json(z.object({ threadIds: z.array(z.string().min(1).max(120)).min(1).max(100), changes: ThreadPatch }).strict().openapi('UpdateMailboxThreads')) }, responses: { 200: response(z.object({ data: z.array(ThreadSchema) }).openapi('MailboxThreadList')), ...errors } }), async c => {
    const body = c.req.valid('json');
    return c.json({ data: await patchThreads(c, c.req.valid('param').mailboxId, [...new Set(body.threadIds)], body.changes) }, 200);
  });
  app.openapi(route({ method: 'delete', path: '/mailboxes/{mailboxId}/threads/{threadId}', operationId: 'mailboxDeleteThread', tags: [TAG.threads], description: 'Removes the conversation from this mailbox permanently. Other mailboxes and the stored messages are unaffected. Use trashed=true for a recoverable delete.', request: { params: ThreadParams }, responses: { 200: response(Ok), ...errors } }), async c => {
    const p = c.req.valid('param'); await mailboxFor(c, p.mailboxId, 'modify');
    await c.env.db.transaction(async tx => {
      await tx.delete(mailboxMessages).where(and(eq(mailboxMessages.mailboxId, p.mailboxId), eq(mailboxMessages.threadId, p.threadId)));
      const deleted = await tx.delete(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, p.mailboxId), eq(mailboxThreads.threadId, p.threadId))).returning({ id: mailboxThreads.threadId });
      if (!deleted.length) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found in this mailbox.');
    });
    return c.json({ ok: true as const }, 200);
  });

  // ---------- messages ----------
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/messages', operationId: 'mailboxListMessages', tags: [TAG.messages], summary: 'List messages', description: 'Newest first, without bodies.',
    request: { params: MailboxParams, query: z.object({ direction: z.enum(['inbound', 'outbound']).optional(), unread: z.enum(['true', 'false']).optional(), label: labelName.optional(), threadId: z.string().max(120).optional(), q: z.string().trim().min(1).max(200).optional(), since: z.string().datetime({ offset: true }).optional(), until: z.string().datetime({ offset: true }).optional(), cursor: z.string().max(300).optional(), limit: Limit }) },
    responses: { 200: response(pageOf(MessageSummary, 'MailboxMessagePage')), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').mailboxId); const q = c.req.valid('query'); const mm = mailboxMessages, cursor = decodeCursor(q.cursor);
    const rows = await c.env.db.select({ row: mailMessages, read: mm.read, labels: mm.labels, receivedAt: mm.receivedAt }).from(mm).innerJoin(mailMessages, eq(mailMessages.id, mm.messageId)).where(and(eq(mm.mailboxId, mailbox.id),
      q.direction ? eq(mm.direction, q.direction) : undefined, q.unread === 'true' ? eq(mm.read, false) : q.unread === 'false' ? eq(mm.read, true) : undefined, q.threadId ? eq(mm.threadId, q.threadId) : undefined, q.label ? sql`${mm.labels} @> ARRAY[${q.label}]::text[]` : undefined,
      q.q ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.q})` : undefined, q.since ? sql`${mm.receivedAt} >= ${q.since}::timestamptz` : undefined, q.until ? sql`${mm.receivedAt} < ${q.until}::timestamptz` : undefined,
      cursor ? sql`(${mm.receivedAt}, ${mm.messageId}) < (${cursor[0]}::timestamptz, ${cursor[1]})` : undefined)).orderBy(desc(mm.receivedAt), desc(mm.messageId)).limit(q.limit + 1);
    const last = rows[q.limit - 1];
    return c.json({ data: rows.slice(0, q.limit).map(item => summaryView(item.row, mailbox.id, item.read, item.labels)), nextCursor: rows.length > q.limit && last ? encodeCursor([exact(last.receivedAt), last.row.id]) : null }, 200);
  });
  const messageFor = async (c: Ctx, mailboxId: string, messageId: string, permission: MailboxPermission = 'read') => {
    const { mailbox, scope } = await mailboxFor(c, mailboxId, permission);
    const [item] = await c.env.db.select({ row: mailMessages, read: mailboxMessages.read, labels: mailboxMessages.labels }).from(mailboxMessages).innerJoin(mailMessages, eq(mailMessages.id, mailboxMessages.messageId)).where(and(eq(mailboxMessages.mailboxId, mailbox.id), eq(mailboxMessages.messageId, messageId)));
    if (!item) throw new ApiError(404, 'NOT_FOUND', 'Message was not found in this mailbox.');
    return { mailbox, scope, ...item };
  };
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/messages/{messageId}', operationId: 'mailboxGetMessage', tags: [TAG.messages], summary: 'Read a message', description: 'Full message with HTML, headers and attachment metadata. Reading does not mark it read; PATCH read=true does.', request: { params: MessageParams }, responses: { 200: response(MessageSchema), ...errors } }), async c => {
    const p = c.req.valid('param'); const item = await messageFor(c, p.mailboxId, p.messageId);
    return c.json((await fullViews(c.env, [item], item.mailbox.id, { html: true, headers: true }))[0]!, 200);
  });
  app.openapi(route({ method: 'patch', path: '/mailboxes/{mailboxId}/messages/{messageId}', operationId: 'mailboxUpdateMessage', tags: [TAG.messages], summary: 'Mark a message read/unread or change its labels', request: { params: MessageParams, body: json(MessagePatch) }, responses: { 200: response(MessageSummary), ...errors } }), async c => {
    const p = c.req.valid('param');
    return c.json((await patchMessages(c, p.mailboxId, [p.messageId], c.req.valid('json')))[0]!, 200);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/messages/batch', operationId: 'mailboxUpdateMessages', tags: [TAG.messages], summary: 'Update up to 100 messages at once', request: { params: MailboxParams, body: json(z.object({ messageIds: z.array(z.string().min(1).max(120)).min(1).max(100), changes: MessagePatch }).strict().openapi('UpdateMailboxMessages')) }, responses: { 200: response(z.object({ data: z.array(MessageSummary) }).openapi('MailboxMessageList')), ...errors } }), async c => {
    const body = c.req.valid('json');
    return c.json({ data: await patchMessages(c, c.req.valid('param').mailboxId, [...new Set(body.messageIds)], body.changes) }, 200);
  });
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/labels', operationId: 'mailboxListLabels', tags: [TAG.messages], summary: 'List labels in use', description: 'Every label on this mailbox’s threads or messages, with counts. Labels are created by applying them.', request: { params: MailboxParams }, responses: { 200: response(z.object({ data: z.array(z.object({ name: z.string(), threads: z.number().int(), messages: z.number().int(), unreadMessages: z.number().int() })) }).openapi('MailboxLabelList')), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').mailboxId);
    const result = await c.env.db.execute<{ name: string; threads: number; messages: number; unread: number }>(sql`WITH t AS (SELECT unnest(labels) AS name, count(*)::int AS threads FROM mailbox_threads WHERE mailbox_id = ${mailbox.id} AND trashed_at IS NULL GROUP BY 1),
      m AS (SELECT unnest(labels) AS name, count(*)::int AS messages, count(*) FILTER (WHERE NOT read)::int AS unread FROM mailbox_messages WHERE mailbox_id = ${mailbox.id} GROUP BY 1)
      SELECT coalesce(t.name, m.name) AS name, coalesce(t.threads, 0) AS threads, coalesce(m.messages, 0) AS messages, coalesce(m.unread, 0) AS unread FROM t FULL JOIN m ON m.name = t.name ORDER BY 1 LIMIT 500`);
    return c.json({ data: result.rows.map(row => ({ name: row.name, threads: row.threads, messages: row.messages, unreadMessages: row.unread })) }, 200);
  });
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/messages/{messageId}/raw', operationId: 'mailboxGetRawMessage', tags: [TAG.messages], summary: 'Download the original MIME', description: 'Returns a short-lived S3 link to the original .eml. Raw messages are kept for 90 days.', request: { params: MessageParams }, responses: { 200: response(z.object({ url: z.string(), expiresAt: z.string() }).openapi('MailboxDownload')), ...errors } }), async c => {
    const p = c.req.valid('param'); const item = await messageFor(c, p.mailboxId, p.messageId);
    if (!item.row.rawBucket || !item.row.rawKey || !item.row.region) throw new ApiError(404, 'RAW_NOT_AVAILABLE', 'This message has no stored original.');
    return c.json(await signedUrl(c.env, item.row.region, item.row.rawBucket, item.row.rawKey, `${item.row.id}.eml`), 200);
  });
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/attachments/{attachmentId}', operationId: 'mailboxGetAttachment', tags: [TAG.messages], summary: 'Download an attachment', description: 'Attachment metadata with a short-lived S3 download link.', request: { params: MailboxParams.extend({ attachmentId: z.string().min(1).max(120) }) }, responses: { 200: response(AttachmentSchema.extend({ messageId: z.string(), url: z.string(), expiresAt: z.string() }).openapi('MailboxAttachmentDownload')), ...errors } }), async c => {
    const p = c.req.valid('param'); const { mailbox } = await mailboxFor(c, p.mailboxId);
    const [file] = await c.env.db.select({ file: mailAttachments, region: mailMessages.region }).from(mailAttachments).innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId)).innerJoin(mailboxMessages, and(eq(mailboxMessages.messageId, mailAttachments.messageId), eq(mailboxMessages.mailboxId, mailbox.id))).where(eq(mailAttachments.id, p.attachmentId));
    if (!file?.region) throw new ApiError(404, 'NOT_FOUND', 'Attachment was not found in this mailbox.');
    const link = await signedUrl(c.env, file.region, file.file.bucket, file.file.storageKey, file.file.filename);
    return c.json({ id: file.file.id, messageId: file.file.messageId, filename: file.file.filename, contentType: file.file.contentType, size: file.file.sizeBytes, contentId: file.file.contentId, disposition: file.file.disposition, ...link }, 200);
  });

  // ---------- sending ----------
  const Address = z.string().trim().toLowerCase().max(254).regex(ADDRESS, 'Use a valid email address.');
  const Recipients = z.array(Address).max(50);
  const AttachmentItem = z.union([
    z.object({ filename: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/), content: z.string().min(4).max(11_200_000).describe('Standard padded base64.'), contentType: z.string().max(100).optional(), disposition: z.enum(['attachment', 'inline']).optional(), contentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.@-]+$/).optional() }).strict(),
    z.object({ id: z.string().min(1).max(120).describe('A received attachment in this mailbox (matt_…) or an upload from POST /mailboxes/{mailboxId}/attachments (attachment_…).') }).strict(),
  ]).openapi('MailboxAttachmentInput');
  const Compose = {
    from: Address.optional().describe('Send as the primary address (default) or one of the mailbox aliases.'),
    text: z.string().min(1).max(524288).optional(), html: z.string().min(1).max(524288).optional(),
    attachments: z.array(AttachmentItem).max(20).default([]).describe('Up to 20 files, 8 MiB combined. Types: PDF, text, CSV, JSON, images, ICS and Office documents.'),
    replyTo: Recipients.max(10).default([]),
    headers: z.array(z.object({ name: z.string().regex(/^X-[A-Za-z0-9-]{1,120}$/, 'Custom headers must start with X-.'), value: z.string().min(1).max(900).regex(/^[ -~]+$/, 'Header values must be printable ASCII.') })).max(10).default([]),
    autoSubmitted: z.enum(['auto-generated', 'auto-replied']).optional().describe('Adds an RFC 3834 Auto-Submitted header so other automated systems do not reply to this message.'),
  };
  const needsBody = (value: { text?: string; html?: string }) => !!value.text || !!value.html;
  const SendBody = z.object({ ...Compose, to: Recipients.min(1), cc: Recipients.default([]), bcc: Recipients.default([]), subject: z.string().trim().min(1).max(998).refine(value => !/[\r\n]/.test(value), 'Subject cannot contain line breaks.') })
    .strict().refine(needsBody, 'Provide text or html.').openapi('MailboxSendInput');
  const ReplyBody = z.object({ ...Compose,
    replyAll: z.boolean().default(false).describe('Also copy everyone else on the original message.'),
    to: Recipients.optional().describe('Override the computed recipients.'), cc: Recipients.optional(), bcc: Recipients.default([]),
    subject: z.string().trim().min(1).max(998).optional().describe('Defaults to "Re: <original subject>".'),
    quote: z.boolean().default(false).describe('Append the original message as quoted text.'),
    allowAutomated: z.boolean().default(false).describe('Reply even when the original is automated or the recipient is a no-reply address.'),
  }).strict().refine(needsBody, 'Provide text or html.').openapi('MailboxReplyInput');
  const ForwardBody = z.object({ ...Compose, to: Recipients.min(1), cc: Recipients.default([]), bcc: Recipients.default([]),
    subject: z.string().trim().min(1).max(998).optional().describe('Defaults to "Fwd: <original subject>".'),
    includeAttachments: z.boolean().default(true).describe('Attach the original attachments (8 MiB combined).'),
  }).strict().openapi('MailboxForwardInput');
  const Sent = MessageSchema.describe('The stored outbound message. status starts as queued; follow message.sent and message.delivered events or re-read it.');
  function sendActor(c: Ctx, access: MailboxAccess): Actor {
    const actor = c.get('actor');
    if (access.keyId.startsWith('mbk_') || !actor) return { keyId: access.keyId, workspaceId: access.workspaceId, environment: LIVE, permissions: ['send'], domains: [], credential: 'apiKey' };
    return { ...actor, environment: LIVE };
  }
  async function senderAddress(c: Ctx, mailbox: typeof mailboxes.$inferSelect, from?: string) {
    if (!from || from === mailbox.address) return mailbox.address;
    const [alias] = await c.env.db.select().from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), eq(mailboxAddresses.address, from)));
    if (!alias) throw new ApiError(422, 'FROM_NOT_ALLOWED', 'Send from the mailbox address or one of its aliases.', 'from');
    return from;
  }
  async function dispatch(c: Ctx, mailbox: typeof mailboxes.$inferSelect, scope: Scope, access: MailboxAccess, body: unknown, build: () => Promise<Omit<OutgoingMessage, 'mailbox' | 'actor' | 'scope'>>) {
    const actor = sendActor(c, access);
    const outgoing = await build();
    const result = await idempotent(c, actor, body, async tx => {
      const { message, runnable } = await sendFromMailbox(c.env, tx, { ...outgoing, mailbox, actor, scope });
      const view = (await fullViews(c.env, [{ row: message, read: true, labels: [] }], mailbox.id, { html: true, headers: true }, tx))[0]!;
      return { ...view, runnable };
    });
    const { runnable, ...view } = result as typeof result & { runnable: number };
    for (const target of actor.dispatchTargets ?? []) { const [environment, region] = target.split(':') as ['live', string]; try { await c.env.dispatch?.(environment, region); } catch { /* The dispatcher polls queued mail. */ } }
    actor.dispatchTargets?.clear();
    if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
    return view;
  }
  const quoted = (original: MessageRow) => {
    const who = original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress;
    const intro = `On ${new Date(original.sentAt ?? original.receivedAt).toUTCString()}, ${who} wrote:`;
    const text = original.text ?? (original.html ? htmlToPlain(original.html) : '');
    return { text: `\n\n${intro}\n${text.split('\n').map(line => `> ${line}`).join('\n')}`, html: `<br><br><div>${intro.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original.html ? safeForwardHtml(original.html) : `<pre>${text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</pre>`}</blockquote>` };
  };
  async function reply(c: Ctx, mailboxId: string, target: (mailbox: typeof mailboxes.$inferSelect) => Promise<MessageRow | undefined>) {
    const { mailbox, scope, access: value } = await mailboxFor(c, mailboxId, 'send'); const body = c.req.valid('json' as never) as z.infer<typeof ReplyBody>;
    const original = await target(mailbox);
    if (!original) throw new ApiError(404, 'NOT_FOUND', 'There is no message to reply to in this conversation.');
    const own = (await c.env.db.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(eq(mailboxAddresses.mailboxId, mailbox.id))).map(row => row.address);
    const computed = replyRecipients(original, own, body.replyAll);
    const to = body.to ?? computed.to, cc = body.cc ?? computed.cc;
    assertReplyable(original, to, body.allowAutomated);
    const quote = body.quote ? quoted(original) : null;
    return dispatch(c, mailbox, scope, value, { ...body, target: original.id }, async () => ({
      from: await senderAddress(c, mailbox, body.from), to, cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject ?? replySubject(original.subject, 'Re'),
      text: body.text ? body.text + (quote?.text ?? '') : undefined, html: body.html ? body.html + (quote?.html ?? '') : undefined,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments), threadId: original.threadId,
      inReplyTo: original.messageId, references: [...original.references, ...(original.messageId ? [original.messageId] : [])], autoSubmitted: body.autoSubmitted, headers: body.headers,
    }));
  }
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/attachments', operationId: 'mailboxUploadAttachment', tags: [TAG.messages], summary: 'Upload an attachment to send later', description: 'Stores a file (base64, 8 MiB) and returns an attachment_… ID for the attachments field of send, reply and forward. Unused uploads are deleted after 30 days.',
    request: { params: MailboxParams, body: json(z.object({ filename: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/), content: z.string().min(4).max(11_200_000), contentType: z.string().max(100).default('application/octet-stream'), disposition: z.enum(['attachment', 'inline']).default('attachment'), contentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.@-]+$/).optional() }).strict().openapi('MailboxAttachmentUpload')) },
    responses: { 201: response(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable() }).openapi('MailboxUploadedAttachment')), ...errors } }), async c => {
    const { access: value } = await mailboxFor(c, c.req.valid('param').mailboxId, 'send'); const input = c.req.valid('json');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.content) || input.content.length % 4) throw new ApiError(422, 'ATTACHMENT_CONTENT_INVALID', 'content must be standard padded base64.', 'content');
    const actor = sendActor(c, value);
    const row = await c.env.db.transaction(tx => storeAttachmentBytes(c.env, tx, actor, { filename: input.filename, contentType: input.contentType, disposition: input.disposition, ...(input.contentId ? { contentId: input.contentId } : {}) }, new Uint8Array(Buffer.from(input.content, 'base64'))));
    return c.json({ id: row.id, filename: row.filename, contentType: row.contentType, size: row.size, disposition: row.disposition as 'attachment' | 'inline', contentId: row.contentId }, 201);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/messages', operationId: 'mailboxSendMessage', tags: [TAG.messages], summary: 'Send a new message', description: 'Starts a new conversation. Sent through OpenSend’s transactional pipeline (suppression, SES configuration set, delivery tracking) with open/click tracking off. Supports the Idempotency-Key header. Per-mailbox limits apply (see sendLimits).',
    request: { params: MailboxParams, body: json(SendBody) }, responses: { 202: response(Sent), ...errors } }), async c => {
    const { mailbox, scope, access: value } = await mailboxFor(c, c.req.valid('param').mailboxId, 'send'); const body = c.req.valid('json');
    const view = await dispatch(c, mailbox, scope, value, body, async () => ({ from: await senderAddress(c, mailbox, body.from), to: body.to, cc: body.cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject, text: body.text, html: body.html,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments), inReplyTo: null, references: [], autoSubmitted: body.autoSubmitted, headers: body.headers }));
    return c.json(view, 202);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/messages/{messageId}/reply', operationId: 'mailboxReplyToMessage', tags: [TAG.messages], summary: 'Reply to a message',
    description: 'Replies in the same conversation with In-Reply-To and References set. Replies go to Reply-To (or From) of an inbound message, or to the original recipients of your own sent message. Automated originals (auto-replies, bounces, bulk) and no-reply recipients are refused unless allowAutomated=true. Supports Idempotency-Key.',
    request: { params: MessageParams, body: json(ReplyBody) }, responses: { 202: response(Sent), ...errors } }), async c => {
    const p = c.req.valid('param');
    return c.json(await reply(c, p.mailboxId, async mailbox => (await c.env.db.select({ row: mailMessages }).from(mailboxMessages).innerJoin(mailMessages, eq(mailMessages.id, mailboxMessages.messageId)).where(and(eq(mailboxMessages.mailboxId, mailbox.id), eq(mailboxMessages.messageId, p.messageId))))[0]?.row), 202);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/threads/{threadId}/reply', operationId: 'mailboxReplyToThread', tags: [TAG.threads], summary: 'Reply to a conversation', description: 'Replies to the newest inbound message in the conversation (or the newest message if none is inbound). Same options as replying to a message.',
    request: { params: ThreadParams, body: json(ReplyBody) }, responses: { 202: response(Sent), ...errors } }), async c => {
    const p = c.req.valid('param');
    return c.json(await reply(c, p.mailboxId, mailbox => latestReplyTarget(c.env.db, mailbox.id, p.threadId)), 202);
  });
  app.openapi(route({ method: 'post', path: '/mailboxes/{mailboxId}/messages/{messageId}/forward', operationId: 'mailboxForwardMessage', tags: [TAG.messages], summary: 'Forward a message', description: 'Sends the original message with its headers summarized under an optional note, in the same conversation. Original attachments are included by default. Supports Idempotency-Key.',
    request: { params: MessageParams, body: json(ForwardBody) }, responses: { 202: response(Sent), ...errors } }), async c => {
    const p = c.req.valid('param'); const item = await messageFor(c, p.mailboxId, p.messageId, 'send'); const body = c.req.valid('json');
    const content = forwardBody(item.row, { text: body.text, html: body.html });
    const originals = body.includeAttachments ? (await c.env.db.select({ id: mailAttachments.id }).from(mailAttachments).where(eq(mailAttachments.messageId, item.row.id))).map(row => ({ id: row.id })) : [];
    const view = await dispatch(c, item.mailbox, item.scope, access(c, 'send'), { ...body, target: item.row.id }, async () => ({
      from: await senderAddress(c, item.mailbox, body.from), to: body.to, cc: body.cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject ?? replySubject(item.row.subject, 'Fwd'), text: content.text, html: content.html,
      attachments: await resolveAttachments(c.env, item.mailbox, [...originals, ...body.attachments]), threadId: item.row.threadId, inReplyTo: null,
      references: [...item.row.references, ...(item.row.messageId ? [item.row.messageId] : [])], autoSubmitted: body.autoSubmitted, headers: body.headers,
    }));
    return c.json(view, 202);
  });

  // ---------- events ----------
  const EventQuery = z.object({ after: z.string().regex(/^\d{1,19}$/).optional().describe('Cursor from a previous response. Omit to start at the current end of the log.'), wait: z.coerce.number().int().min(0).max(30).default(0).describe('Seconds to wait for new events when none are ready (long-poll).'), types: z.string().max(400).optional().describe('Comma-separated event types.'), limit: Limit });
  const EventPage = z.object({ data: z.array(EventSchema), cursor: z.string().describe('Pass as after on the next call.') }).openapi('MailboxEventPage');
  async function poll(c: Ctx, mailboxIds: string[] | null, q: z.infer<typeof EventQuery>) {
    const value = access(c, 'read');
    const types = q.types?.split(',').map(type => type.trim()).filter(Boolean);
    if (types?.some(type => !(mailboxEventTypes as readonly string[]).includes(type))) throw new ApiError(422, 'INVALID_EVENT_TYPE', `Event types: ${mailboxEventTypes.join(', ')}.`, 'types');
    let after = q.after !== undefined ? Number(q.after) : await latestCursor(c.env.db, value.workspaceId, LIVE);
    const deadline = Date.now() + q.wait * 1000;
    for (;;) {
      const rows = await readEvents(c.env.db, value.workspaceId, LIVE, { after, mailboxIds, types, limit: q.limit });
      if (rows.length) return { data: rows.map(eventView), cursor: String(rows.at(-1)!.seq) };
      if (Date.now() >= deadline) return { data: [], cursor: String(after) };
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
      after = Math.max(after, 0);
    }
  }
  app.openapi(route({ method: 'get', path: '/mailboxes/{mailboxId}/events', operationId: 'mailboxListEvents', tags: [TAG.events], summary: 'Wait for new mail and changes', description: 'Ordered, gap-free event log for one mailbox. Use wait (up to 30 seconds) to long-poll instead of receiving webhooks. Events are kept for 30 days.', request: { params: MailboxParams, query: EventQuery }, responses: { 200: response(EventPage), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').mailboxId);
    return c.json(await poll(c, [mailbox.id], c.req.valid('query')), 200);
  });
  app.openapi(route({ method: 'get', path: '/events', operationId: 'mailboxListAllEvents', tags: [TAG.events], summary: 'Events across every mailbox this key can read', request: { query: EventQuery.extend({ mailboxIds: z.string().max(4000).optional().describe('Comma-separated mailbox IDs to include.') }) }, responses: { 200: response(EventPage), ...errors } }), async c => {
    const value = access(c, 'read'); const q = c.req.valid('query');
    const requested = q.mailboxIds?.split(',').map(item => item.trim()).filter(Boolean) ?? null;
    const mailboxIds = value.mailboxIds ? (requested ? requested.filter(item => value.mailboxIds!.includes(item)) : value.mailboxIds) : requested;
    return c.json(await poll(c, mailboxIds, q), 200);
  });

  // ---------- keys ----------
  const Permissions = z.array(z.enum(['read', 'send', 'modify'])).min(1).max(3);
  app.openapi(route({ method: 'post', path: '/keys', operationId: 'mailboxCreateKey', tags: [TAG.keys], summary: 'Create a key for an agent', description: 'Scope the key to specific mailboxes, or omit mailboxIds for every mailbox. read lists and reads mail, send sends and replies, modify changes read/archive/label state. The secret is returned once.',
    request: { body: json(z.object({ name: z.string().trim().min(1).max(100), mailboxIds: z.array(z.string().min(1).max(120)).min(1).max(500).optional(), permissions: Permissions.default(['read', 'send', 'modify']) }).strict().openapi('CreateMailboxKey')) }, responses: { 201: response(KeySchema.extend({ secret: z.string() }).openapi('MailboxKeySecret')), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json');
    if (!['apiKey', 'dashboard'].includes(c.get('actor')?.credential ?? '')) throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Create mailbox keys with a live API key or the dashboard.');
    const mailboxIds = input.mailboxIds ? [...new Set(input.mailboxIds)] : null;
    if (mailboxIds) {
      const found = await c.env.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), eq(mailboxes.environment, LIVE), inArray(mailboxes.id, mailboxIds)));
      if (found.length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every mailboxIds entry must be an existing mailbox.', 'mailboxIds');
    }
    const secret = randomSecret('os_mbx_');
    const [row] = await c.env.db.insert(mailboxKeys).values({ id: id('mbk'), workspaceId: value.workspaceId, environment: LIVE, name: input.name, hash: await digest(secret), prefix: secret.slice(0, 14), mailboxIds, permissions: [...new Set(input.permissions)] }).returning();
    c.header('Cache-Control', 'no-store');
    return c.json({ ...keyView(row!), secret }, 201);
  });
  app.openapi(route({ method: 'get', path: '/keys', operationId: 'mailboxListKeys', tags: [TAG.keys], request: { query: z.object({ includeRevoked: z.enum(['true', 'false']).default('false'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(KeySchema, 'MailboxKeyPage')), ...errors } }), async c => {
    const value = admin(c); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxKeys).where(and(eq(mailboxKeys.workspaceId, value.workspaceId), q.includeRevoked === 'false' ? isNull(mailboxKeys.revokedAt) : undefined, q.cursor ? lt(mailboxKeys.id, q.cursor) : undefined)).orderBy(desc(mailboxKeys.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(route({ method: 'post', path: '/keys/{id}/revoke', operationId: 'mailboxRevokeKey', tags: [TAG.keys], request: { params: IdParam }, responses: { 200: response(KeySchema), ...errors } }), async c => {
    const value = admin(c);
    const [row] = await c.env.db.update(mailboxKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(mailboxKeys.workspaceId, value.workspaceId), eq(mailboxKeys.id, c.req.valid('param').id), isNull(mailboxKeys.revokedAt))).returning();
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Key was not found or is already revoked.');
    return c.json(keyView(row), 200);
  });

  // ---------- webhooks ----------
  const WebhookInput = z.object({ url: z.string().url().max(2048), description: z.string().max(500).default(''), eventTypes: z.array(z.enum(mailboxEventTypes)).min(1).max(mailboxEventTypes.length).default(['message.received']), mailboxIds: z.array(z.string().min(1).max(120)).min(1).max(500).nullable().default(null).describe('Only events for these mailboxes; null for all.'), paused: z.boolean().default(false) }).strict();
  const getWebhook = async (c: Ctx, webhookId: string) => {
    const value = admin(c);
    const [row] = await c.env.db.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, value.workspaceId), eq(mailboxWebhooks.environment, LIVE), eq(mailboxWebhooks.id, webhookId)));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Webhook was not found.');
    return { value, row };
  };
  app.openapi(route({ method: 'post', path: '/webhooks', operationId: 'mailboxCreateWebhook', tags: [TAG.webhooks], summary: 'Subscribe to mailbox events', description: 'Deliveries are signed with Standard Webhooks headers (Webhook-Id, Webhook-Timestamp, Webhook-Signature) and retried with backoff. The endpoint host must be in the deployment webhook allowlist. The signing secret is returned once.', request: { body: json(WebhookInput.openapi('CreateMailboxWebhook')) }, responses: { 201: response(WebhookSchema.extend({ secret: z.string() }).openapi('MailboxWebhookSecret')), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json'); const webhookId = id('mwh'); const secret = webhookSecret();
    const [row] = await c.env.db.insert(mailboxWebhooks).values({ id: webhookId, workspaceId: value.workspaceId, environment: LIVE, url: webhookUrl(c.env, input.url), description: input.description, eventTypes: [...new Set(input.eventTypes)], mailboxIds: input.mailboxIds, paused: input.paused, encryptedSecret: await encrypt(c.env, secret, webhookSecretBinding(value.workspaceId, LIVE, webhookId)) }).returning();
    c.header('Cache-Control', 'no-store');
    return c.json({ ...webhookView(row!), secret }, 201);
  });
  app.openapi(route({ method: 'get', path: '/webhooks', operationId: 'mailboxListWebhooks', tags: [TAG.webhooks], responses: { 200: response(z.object({ data: z.array(WebhookSchema) }).openapi('MailboxWebhookList')), ...errors } }), async c => {
    const value = admin(c);
    const rows = await c.env.db.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, value.workspaceId), eq(mailboxWebhooks.environment, LIVE))).orderBy(desc(mailboxWebhooks.id)).limit(100);
    return c.json({ data: rows.map(webhookView) }, 200);
  });
  app.openapi(route({ method: 'get', path: '/webhooks/{id}', operationId: 'mailboxGetWebhook', tags: [TAG.webhooks], request: { params: IdParam }, responses: { 200: response(WebhookSchema), ...errors } }), async c => c.json(webhookView((await getWebhook(c, c.req.valid('param').id)).row), 200));
  app.openapi(route({ method: 'patch', path: '/webhooks/{id}', operationId: 'mailboxUpdateWebhook', tags: [TAG.webhooks], request: { params: IdParam, body: json(WebhookInput.partial().strict().openapi('UpdateMailboxWebhook')) }, responses: { 200: response(WebhookSchema), ...errors } }), async c => {
    const { row } = await getWebhook(c, c.req.valid('param').id); const input = c.req.valid('json');
    const [updated] = await c.env.db.update(mailboxWebhooks).set({ ...input, ...(input.url ? { url: webhookUrl(c.env, input.url) } : {}), ...(input.eventTypes ? { eventTypes: [...new Set(input.eventTypes)] } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxWebhooks.id, row.id)).returning();
    return c.json(webhookView(updated!), 200);
  });
  app.openapi(route({ method: 'delete', path: '/webhooks/{id}', operationId: 'mailboxDeleteWebhook', tags: [TAG.webhooks], request: { params: IdParam }, responses: { 200: response(Ok), ...errors } }), async c => {
    const { row } = await getWebhook(c, c.req.valid('param').id);
    await c.env.db.delete(mailboxWebhooks).where(eq(mailboxWebhooks.id, row.id));
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(route({ method: 'post', path: '/webhooks/{id}/rotate-secret', operationId: 'mailboxRotateWebhookSecret', tags: [TAG.webhooks], request: { params: IdParam }, responses: { 200: response(z.object({ secret: z.string() }).openapi('MailboxWebhookRotatedSecret')), ...errors } }), async c => {
    const { value, row } = await getWebhook(c, c.req.valid('param').id); const secret = webhookSecret();
    await c.env.db.update(mailboxWebhooks).set({ encryptedSecret: await encrypt(c.env, secret, webhookSecretBinding(value.workspaceId, LIVE, row.id)), updatedAt: new Date().toISOString() }).where(eq(mailboxWebhooks.id, row.id));
    c.header('Cache-Control', 'no-store');
    return c.json({ secret }, 200);
  });
  app.openapi(route({ method: 'get', path: '/webhooks/{id}/deliveries', operationId: 'mailboxListWebhookDeliveries', tags: [TAG.webhooks], request: { params: IdParam, query: z.object({ cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(DeliverySchema, 'MailboxWebhookDeliveryPage')), ...errors } }), async c => {
    const { row } = await getWebhook(c, c.req.valid('param').id); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxWebhookDeliveries).where(and(eq(mailboxWebhookDeliveries.webhookId, row.id), q.cursor ? lt(mailboxWebhookDeliveries.id, q.cursor) : undefined)).orderBy(desc(mailboxWebhookDeliveries.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(item => ({ id: item.id, webhookId: item.webhookId, eventId: String(item.payload.id), status: item.status, attemptCount: item.attemptCount, lastStatusCode: item.lastStatusCode, lastError: item.lastError, createdAt: iso(item.createdAt)!, updatedAt: iso(item.updatedAt)! })), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });

  // ---------- all stored messages (admin; powers dashboard logs) ----------
  const StoredSummary = MessageSummary.omit({ mailboxId: true, read: true, labels: true }).extend({
    region: z.string().nullable(), envelopeTo: z.array(z.string()).describe('Recipients SES accepted this message for.'),
    mailboxes: z.array(z.object({ id: z.string(), address: z.string() })), unrouted: z.array(z.string()).describe('Recipients that matched no mailbox.'),
  }).openapi('StoredMessageSummary');
  async function storedSummaries(runtime: Runtime, rows: MessageRow[]) {
    if (!rows.length) return [];
    const ids = rows.map(row => row.id);
    const [links, unrouted] = await Promise.all([
      runtime.db.select({ messageId: mailboxMessages.messageId, id: mailboxes.id, address: mailboxes.address }).from(mailboxMessages).innerJoin(mailboxes, eq(mailboxes.id, mailboxMessages.mailboxId)).where(inArray(mailboxMessages.messageId, ids)),
      runtime.db.select({ messageId: mailUnrouted.messageId, address: mailUnrouted.address }).from(mailUnrouted).where(inArray(mailUnrouted.messageId, ids)),
    ]);
    return rows.map(row => { const { mailboxId: _m, read: _r, labels: _l, ...summary } = summaryView(row, '', false); return { ...summary, region: row.region, envelopeTo: row.envelopeTo,
      mailboxes: links.filter(link => link.messageId === row.id).map(({ id, address }) => ({ id, address })), unrouted: unrouted.filter(item => item.messageId === row.id).map(item => item.address) }; });
  }
  app.openapi(route({ method: 'get', path: '/messages', operationId: 'mailboxListStoredMessages', tags: [TAG.messages], summary: 'List every stored message', description: 'All received (or sent) messages across every mailbox, including unrouted mail. Newest first, without bodies.',
    request: { query: z.object({ direction: z.enum(['inbound', 'outbound']).default('inbound'), region: z.string().max(40).optional(), mailboxId: z.string().max(120).optional(), q: z.string().trim().min(1).max(200).optional(), cursor: z.string().max(300).optional(), limit: Limit }) },
    responses: { 200: response(pageOf(StoredSummary, 'StoredMessagePage')), ...errors } }), async c => {
    const value = admin(c); const q = c.req.valid('query'); const cursor = decodeCursor(q.cursor); const m = mailMessages;
    const rows = await c.env.db.select().from(m).where(and(eq(m.workspaceId, value.workspaceId), eq(m.environment, LIVE), eq(m.direction, q.direction), q.region ? eq(m.region, q.region) : undefined,
      q.mailboxId ? sql`EXISTS (SELECT 1 FROM mailbox_messages mm WHERE mm.message_id = ${m.id} AND mm.mailbox_id = ${q.mailboxId})` : undefined,
      q.q ? sql`mail_messages.search @@ websearch_to_tsquery('simple', ${q.q})` : undefined,
      cursor ? sql`(${m.receivedAt}, ${m.id}) < (${cursor[0]}::timestamptz, ${cursor[1]})` : undefined)).orderBy(desc(m.receivedAt), desc(m.id)).limit(q.limit + 1);
    const last = rows[q.limit - 1];
    return c.json({ data: await storedSummaries(c.env, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit && last ? encodeCursor([exact(last.receivedAt), last.id]) : null }, 200);
  });
  app.openapi(route({ method: 'get', path: '/messages/{id}', operationId: 'mailboxGetStoredMessage', tags: [TAG.messages], summary: 'Read any stored message', description: 'Full message with headers, the mailboxes it belongs to, and short-lived download links for attachments and the original MIME.',
    request: { params: IdParam }, responses: { 200: response(MessageSchema.omit({ mailboxId: true, read: true, labels: true }).extend({
      region: z.string().nullable(), envelopeTo: z.array(z.string()), sesMessageId: z.string().nullable(), sizeBytes: z.number().int().nullable(),
      mailboxes: z.array(z.object({ id: z.string(), address: z.string() })), unrouted: z.array(z.string()),
      attachments: z.array(AttachmentSchema.extend({ url: z.string().nullable() })), rawUrl: z.string().nullable(), linksExpireAt: z.string(),
    }).openapi('StoredMessage')), ...errors } }), async c => {
    const value = admin(c);
    const [row] = await c.env.db.select().from(mailMessages).where(and(eq(mailMessages.workspaceId, value.workspaceId), eq(mailMessages.environment, LIVE), eq(mailMessages.id, c.req.valid('param').id)));
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Message was not found.');
    const [[full], [summary], files] = await Promise.all([fullViews(c.env, [{ row, read: false }], '', { html: true, headers: true }), storedSummaries(c.env, [row]), c.env.db.select().from(mailAttachments).where(eq(mailAttachments.messageId, row.id)).orderBy(asc(mailAttachments.id))]);
    const link = async (bucket: string | null, key: string | null, filename?: string) => bucket && key && row.region ? (await signedUrl(c.env, row.region, bucket, key, filename)).url : null;
    const { mailboxId: _m, read: _r, labels: _l, ...message } = full!;
    return c.json({ ...message, region: row.region, envelopeTo: row.envelopeTo, sesMessageId: row.sesMessageId, sizeBytes: row.sizeBytes, mailboxes: summary!.mailboxes, unrouted: summary!.unrouted,
      attachments: await Promise.all(files.map(async file => ({ id: file.id, filename: file.filename, contentType: file.contentType, size: file.sizeBytes, contentId: file.contentId, disposition: file.disposition, url: await link(file.bucket, file.storageKey, file.filename) }))),
      rawUrl: await link(row.rawBucket, row.rawKey, `${row.id}.eml`), linksExpireAt: new Date(Date.now() + 300_000).toISOString() }, 200);
  });

  // ---------- unrouted ----------
  app.openapi(route({ method: 'get', path: '/unrouted', operationId: 'mailboxListUnrouted', tags: [TAG.messages], summary: 'Stored mail that matched no mailbox', description: 'Mail for addresses on a domain whose catch-all is set to store. Creating a mailbox for the address claims it.',
    request: { query: z.object({ address: z.string().trim().toLowerCase().max(254).optional(), cursor: z.string().max(300).optional(), limit: Limit }) }, responses: { 200: response(pageOf(MessageSummary.omit({ mailboxId: true, read: true, labels: true }).extend({ address: z.string() }).openapi('MailboxUnroutedMessage'), 'MailboxUnroutedPage')), ...errors } }), async c => {
    const value = admin(c); const q = c.req.valid('query'); const cursor = decodeCursor(q.cursor);
    const rows = await c.env.db.select({ row: mailMessages, address: mailUnrouted.address }).from(mailUnrouted).innerJoin(mailMessages, eq(mailMessages.id, mailUnrouted.messageId)).where(and(eq(mailUnrouted.workspaceId, value.workspaceId), eq(mailUnrouted.environment, LIVE),
      q.address ? eq(mailUnrouted.address, q.address) : undefined, cursor ? sql`(${mailMessages.receivedAt}, ${mailMessages.id}) < (${cursor[0]}::timestamptz, ${cursor[1]})` : undefined)).orderBy(desc(mailMessages.receivedAt), desc(mailMessages.id)).limit(q.limit + 1);
    const last = rows[q.limit - 1];
    return c.json({ data: rows.slice(0, q.limit).map(item => { const { mailboxId: _m, read: _r, labels: _l, ...summary } = summaryView(item.row, '', false); return { ...summary, address: item.address }; }), nextCursor: rows.length > q.limit && last ? encodeCursor([exact(last.row.receivedAt), last.row.id]) : null }, 200);
  });
}

