import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { GetEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { ApiError, digest, errors, getSes, id, json, log, randomSecret, response, type Actor, type App, type Ctx, type DbExecutor, type MailboxAccess, type Runtime } from './core.js';
import { authenticate, chargeCredential } from './auth.js';
import { domains } from './db/operations.js';
import { claimReceivable, claimSends, connectionReady } from './states.js';
import { mailboxAddresses, mailboxDomains, mailboxes, mailboxKeys, mailboxMessages, mailboxThreads, mailboxWebhookDeliveries, mailboxWebhooks, mailMessages, mailUnrouted, type MailboxPermission } from './db/mailbox.js';
import { expectedMx, checkMx, mxBlocksEnable } from './mailbox-dns.js';
import { eventView, inboundEventTypes, latestCursor, readEvents, recordEvents, webhookSecretBinding } from './mailbox-events.js';
import { queueReconcile,saveMailboxMx } from './mailbox-setup.js';
import { attachToMailboxes, checkTemporaryMailboxRouting, createMailbox, htmlToPlain, lockMailboxLane, ruleMatches, validateRule, ADDRESS, type Scope } from './mailbox-store.js';
import { encrypt, webhookSecret, webhookUrl } from './operations.js';
import { AttachmentContentId, AttachmentContentType, AttachmentDisposition, AttachmentFilename, CustomHeaders, MAX_ATTACHMENT_BASE64 } from './outbound-content.js';
import { assertRegisteredSender, assertReplyable, DEFAULT_SEND_LIMITS, safeForwardHtml, replyParentId, replyRecipients, replyReferences, replySubject, resolveAttachments, sendLimitsFor } from './mailbox-send.js';
import { withRegionSettings } from './ses-region-state.js';
import { AddressState, assertInboundRecipients, createInboundThreadRoute, InboundAddressId, inboundReplyTarget, queueInboundThreadMessage, registerInboundThreadReads, replyToInboundThreadRoute, visibleThreadAddresses } from './inbound-threads.js';

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];

// ---------- access ----------
function access(c: Ctx, permission?: MailboxPermission): MailboxAccess {
  const value = c.get('mailboxAccess');
  if (!value) throw new ApiError(401, 'AUTH_REQUIRED', 'Supply an inbound key or an OpenSend API key.');
  if (permission && !value.admin && !value.permissions.includes(permission)) throw new ApiError(403, 'PERMISSION_DENIED', `This operation requires ${permission} permission.`);
  return value;
}
function admin(c: Ctx) { const value = access(c); if (!value.admin) throw new ApiError(403, 'ADMIN_REQUIRED', 'This operation requires an unrestricted live OpenSend key with manage permission.'); return value; }
const scopeOf = (value: MailboxAccess): Scope => ({ workspaceId: value.workspaceId });
async function mailboxFor(c: Ctx, mailboxId: string, permission: MailboxPermission = 'read', db: DbExecutor = c.env.db) {
  const value = access(c, permission);
  if (value.mailboxIds && !value.mailboxIds.includes(mailboxId)) throw new ApiError(404, 'NOT_FOUND', 'Receiving address was not found.');
  const [row] = await db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), eq(mailboxes.id, mailboxId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Receiving address was not found.');
  return { access: value, mailbox: row, scope: scopeOf(value) };
}

async function mailboxAuth(c: Ctx, next: () => Promise<void>) {
  const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (token?.startsWith('os_mbx_')) {
    if (!/^os_mbx_[0-9a-f]{64}$/.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The mailbox key is invalid or has been revoked.');
    const key = await chargeCredential<{ id: string; workspace_id: string; mailbox_ids: string[] | null; permissions: MailboxPermission[] }>(c, mailboxKeys, sql`
      SELECT id, workspace_id, id AS key_id, mailbox_ids, permissions, ${c.env.config.apiRateLimitPerMinute}::int AS max_requests
      FROM mailbox_keys WHERE hash = ${await digest(token)} AND revoked_at IS NULL`);
    if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The mailbox key is invalid or has been revoked.');
    c.set('mailboxAccess', { keyId: key.id, workspaceId: key.workspace_id, admin: false, mailboxIds: key.mailbox_ids, permissions: key.permissions });
    return next();
  }
  return authenticate(c, async () => {
    const actor = c.get('actor');
    if (actor.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Use an address-scoped inbound key or an unrestricted live manage credential.');
    if (actor.role === 'member' && actor.credential === 'dashboard') {
      c.set('mailboxAccess', { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: false, mailboxIds: null, permissions: ['read', 'send'] });
      return next();
    }
    if (!actor.permissions.includes('manage')) throw new ApiError(403, 'ADMIN_REQUIRED', 'Inbound requires an address-scoped key or an unrestricted live manage credential.');
    c.set('mailboxAccess', { keyId: actor.keyId, workspaceId: actor.workspaceId, admin: true, mailboxIds: null, permissions: ['read', 'send', 'modify'] });
    await next();
  });
}

// ---------- helpers ----------
const iso = (value: string | null | undefined) => value ? new Date(value.includes('T') ? value : value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString() : null;
const labelName = z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9][a-z0-9 _.:/-]*$/, 'Labels use letters, numbers, spaces and _ . : / -');

// ---------- schemas ----------
const MxRecord = z.object({ type: z.literal('MX'), name: z.string(), value: z.string(), priority: z.number() });
const MxReportSchema = z.object({ state: z.enum(['active', 'missing', 'conflict', 'mixed', 'wrong_region', 'null_mx', 'cname', 'error']), expected: MxRecord, records: z.array(z.object({ priority: z.number(), host: z.string(), provider: z.string().nullable() })), providers: z.array(z.string()), message: z.string(), checkedAt: z.string() }).openapi('InboundMxReport');
const InboundCatchAll = z.enum(['create_address', 'store']);
const InboundDomainSchema = z.object({
  id: z.string().describe('OpenSend domain ID.'), name: z.string(), region: z.string(),
  status: z.enum(['off', 'provisioning', 'waiting_for_mx', 'active', 'disabling', 'disabled', 'failed']),
  catchAll: InboundCatchAll.describe('For an unknown recipient, create_address creates a receiving address; store keeps the message as unrouted.'),
  dns: z.array(MxRecord).describe('Records to publish for receiving.'), mx: MxReportSchema.nullable(), lastError: z.string().nullable(),
  enabledAt: z.string().nullable(), checkedAt: z.string().nullable(), addressCount: z.number().int(),
  subdomains: z.object({ enabled: z.boolean().describe('Whether the receipt rule also matches every subdomain.'), count: z.number().int().describe('Receiving subdomains.'), dns: z.array(MxRecord).describe('The wildcard MX record subdomains need, published once.') }),
}).openapi('InboundDomain');
const InboundSubdomainSchema = z.object({
  id: z.string().describe('Subdomain ID (mdom_…).'), name: z.string().describe('Full host, e.g. acme.example.com.'), parentDomainId: z.string().describe('OpenSend domain ID of the parent.'), parentName: z.string(),
  status: z.enum(['active', 'disabled']), catchAll: InboundCatchAll, metadata: z.record(z.string(), z.unknown()),
  dns: z.array(MxRecord).describe('The parent’s wildcard MX record, which receives this subdomain.'), mx: MxReportSchema.nullable(), addressCount: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
}).openapi('InboundSubdomain');
const InboundAddressSchema = z.object({
  id: z.string(), address: z.string(), displayName: z.string().nullable(), domain: z.string(), aliases: z.array(z.string()), rules: z.array(z.string()),
  publicAddress: z.string().nullable().describe('Send-only address used as the default From. Null to send from the receiving address.'),
  metadata: z.record(z.string(), z.unknown()), origin: z.enum(['api', 'auto']), createdAt: z.string(), updatedAt: z.string(),
  expiresAt: z.string().datetime().nullable().describe('UTC lease expiry, or null for a permanent address. After expiry, new delivery and sending stop. History stays readable and the address remains reserved until an admin deletes it.'),
  stats: z.object({ threads: z.number().int(), unreadThreads: z.number().int(), lastMessageAt: z.string().nullable() }),
  sendLimits: z.object({ perHour: z.number().int(), perDay: z.number().int(), perRecipientPerHour: z.number().int(), perThreadPer10Minutes: z.number().int() }).describe('Outbound limits that guard against runaway agents and reply loops.'),
  requireDmarc: z.boolean().describe('When true, received mail without a DMARC pass for its From domain is stored with the unverified label and does not emit message.received.'),
}).openapi('InboundAddress');
const InboundEventSchema = z.object({ id: z.string(), cursor: z.string(), type: z.enum(inboundEventTypes), createdAt: z.string(), threadId: z.string().nullable(), messageId: z.string().nullable(), data: z.record(z.string(), z.unknown()),
  addressId: z.string().nullable().describe('Receiving address ID at the time of the event; null for workspace events.') }).openapi('InboundEvent');
const KeySchema = z.object({ id: z.string(), name: z.string(), prefix: z.string(), addressIds: z.array(z.string()).nullable(), permissions: z.array(z.enum(['read', 'send', 'modify'])), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('InboundKey');
const InboundWebhookSchema = z.object({ id: z.string(), url: z.string(), description: z.string(), eventTypes: z.array(z.enum(inboundEventTypes)), paused: z.boolean(), createdAt: z.string(), updatedAt: z.string(), addressIds: z.array(z.string()).nullable() }).openapi('InboundWebhook');
const DeliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), status: z.enum(['pending', 'delivered', 'failed']), attemptCount: z.number().int(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('InboundWebhookDelivery');
const pageOf = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const IdParam = z.object({ id: z.string().min(1).max(120) });
const Ok = z.object({ ok: z.literal(true) }).openapi('InboundOk');

// ---------- views ----------
async function domainViews(c: Ctx, rows: (typeof domains.$inferSelect)[]) {
  if (!rows.length) return [];
  const inbound = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, access(c).workspaceId), isNull(mailboxDomains.parentId), inArray(mailboxDomains.domainId, rows.map(row => row.id))));
  const counts = inbound.length ? await c.env.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, inbound.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  const children = inbound.length ? await c.env.db.select({ parentId: mailboxDomains.parentId, count: sql<number>`count(*)::int` }).from(mailboxDomains).where(and(inArray(mailboxDomains.parentId, inbound.map(row => row.id)), eq(mailboxDomains.status, 'active'))).groupBy(mailboxDomains.parentId) : [];
  return rows.map(row => {
    const state = inbound.find(item => item.domainId === row.id);
    const host=state?.receivingHost ?? row.name;
    return { id: row.id, name: host, region: row.region, status: state?.status ?? 'off' as const, dns: [expectedMx(host, row.region)], mx: state?.mx ?? null, lastError: state?.lastError ?? null,
      enabledAt: iso(state?.enabledAt), checkedAt: iso(state?.checkedAt), catchAll: state?.catchAll ?? 'create_address' as const, addressCount: counts.find(item => item.domainId === state?.id)?.count ?? 0,
      subdomains: { enabled: state?.acceptSubdomains ?? false, count: children.find(item => item.parentId === state?.id)?.count ?? 0, dns: [expectedMx(`*.${row.name}`, row.region)] } };
  });
}
async function operationDomain(c: Ctx, domainId: string) {
  const [row] = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, access(c).workspaceId), eq(domains.id, domainId)));
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Domain was not found.');
  return row;
}
async function subdomainViews(runtime: Runtime, parent: typeof mailboxDomains.$inferSelect, rows: (typeof mailboxDomains.$inferSelect)[]) {
  const counts = rows.length ? await runtime.db.select({ domainId: mailboxes.domainId, count: sql<number>`count(*)::int` }).from(mailboxes).where(inArray(mailboxes.domainId, rows.map(row => row.id))).groupBy(mailboxes.domainId) : [];
  return rows.map(row => ({ id: row.id, name: row.name, parentDomainId: parent.domainId, parentName: parent.name, status: row.status === 'active' ? 'active' as const : 'disabled' as const, metadata: row.metadata,
    dns: [expectedMx(`*.${parent.name}`, parent.region)], mx: row.mx ?? null, catchAll: row.catchAll, addressCount: counts.find(item => item.domainId === row.id)?.count ?? 0, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! }));
}
/** The receiving top-level row for an OpenSend domain, which subdomains hang off. */
async function receivingParent(c: Ctx, domainId: string) {
  const row = await operationDomain(c, domainId);
  const [parent] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, row.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId)));
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
  const [addresses, stats] = await Promise.all([
    runtime.db.select().from(mailboxAddresses).where(inArray(mailboxAddresses.mailboxId, ids)),
    runtime.db.select({ mailboxId: mailboxThreads.mailboxId, threads: sql<number>`count(*)::int`, unread: sql<number>`count(*) FILTER (WHERE ${mailboxThreads.unreadCount} > 0)::int`, last: sql<string | null>`max(${mailboxThreads.lastMessageAt})::text` })
      .from(mailboxThreads).where(and(inArray(mailboxThreads.mailboxId, ids), isNull(mailboxThreads.trashedAt))).groupBy(mailboxThreads.mailboxId),
  ]);
  return rows.map(row => {
    const stat = stats.find(item => item.mailboxId === row.id);
    return { id: row.id, address: row.address, displayName: row.displayName, domain: row.address.split('@')[1]!,
      publicAddress: addresses.find(item => item.mailboxId === row.id && item.kind === 'public')?.address ?? null,
      aliases: addresses.filter(item => item.mailboxId === row.id && item.kind === 'alias').map(item => item.address).sort(), rules: row.rules, metadata: row.metadata, origin: row.origin,
      createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!, expiresAt: iso(row.expiresAt), stats: { threads: stat?.threads ?? 0, unreadThreads: stat?.unread ?? 0, lastMessageAt: iso(stat?.last) }, sendLimits: sendLimitsFor(row), requireDmarc: row.requireDmarc };
  });
}
type MessageRow = typeof mailMessages.$inferSelect;
const keyView = (row: typeof mailboxKeys.$inferSelect) => ({ id: row.id, name: row.name, prefix: row.prefix, addressIds: row.mailboxIds, permissions: row.permissions, createdAt: iso(row.createdAt)!, lastUsedAt: iso(row.lastUsedAt), revokedAt: iso(row.revokedAt) });
const webhookView = (row: typeof mailboxWebhooks.$inferSelect) => ({ id: row.id, url: row.url, description: row.description, eventTypes: row.eventTypes as (typeof inboundEventTypes[number])[], addressIds: row.mailboxIds, paused: row.paused, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });
async function refreshThread(tx: Runtime['db'] | Parameters<Parameters<Runtime['db']['transaction']>[0]>[0], mailboxId: string, threadId: string) {
  await tx.execute(sql`UPDATE mailbox_threads SET unread_count = (SELECT count(*) FROM mailbox_messages WHERE mailbox_id = ${mailboxId} AND thread_id = ${threadId} AND NOT read AND direction = 'inbound') WHERE mailbox_id = ${mailboxId} AND thread_id = ${threadId}`);
}

const UpdateInboundThread = z.object({
  addressId: InboundAddressId.optional(),
  read: z.boolean().optional(), archived: z.boolean().optional(), starred: z.boolean().optional(), trashed: z.boolean().optional(), spam: z.boolean().optional(),
  addLabels: z.array(labelName).max(20).optional(), removeLabels: z.array(labelName).max(20).optional(),
}).strict().refine(v => Object.entries(v).some(([key,value]) => key !== 'addressId' && value !== undefined), 'Change at least one state field.').openapi('UpdateInboundThread');
type ThreadPatchInput = Omit<z.infer<typeof UpdateInboundThread>, 'addressId'>;
async function patchThread(c: Ctx, mailboxId: string, threadId: string, patch: ThreadPatchInput) {
  const { scope } = await mailboxFor(c, mailboxId, 'modify');
  const runnable = await c.env.db.transaction(async tx => {
    const [row] = await tx.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, threadId))).for('update');
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Thread was not found in this mailbox.');
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
    return recordEvents(tx, scope.workspaceId, [{ type: 'thread.updated', mailboxId, threadId, data: { changes: patch } }]);
  });
  if (runnable) try { await c.env.wake?.(runnable); } catch { /* Webhook jobs are durable. */ }
  const [updated] = await c.env.db.select().from(mailboxThreads).where(and(eq(mailboxThreads.mailboxId, mailboxId), eq(mailboxThreads.threadId, threadId)));
  return AddressState.parse({...updated,addressId:mailboxId,trashed:!!updated?.trashedAt});
}

/** Links earlier stored mail for newly claimed addresses and rules to a mailbox. */
async function claimUnrouted(tx: Parameters<Parameters<Runtime['db']['transaction']>[0]>[0], scope: Scope, mailbox: typeof mailboxes.$inferSelect, addresses: string[], rules: string[]) {
  if (mailbox.expiresAt !== null) return 0; // A new lease starts with an empty mailbox, including on address reuse.
  const domain = mailbox.address.split('@')[1]!;
  // Neither a retained lease nor a send-only address (including plus-tags) grants historical delivery.
  const outsideReservation = sql`NOT EXISTS (SELECT 1 FROM mailbox_addresses a JOIN mailboxes m ON m.id = a.mailbox_id
    WHERE a.workspace_id = ${mailUnrouted.workspaceId} AND (m.expires_at IS NOT NULL OR a.kind = 'public')
    AND a.address IN (${mailUnrouted.address}, regexp_replace(${mailUnrouted.address}, '[+][^@]*@', '@')))`;
  const rows = await tx.select().from(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), outsideReservation, or(inArray(mailUnrouted.address, addresses), rules.length ? sql`${mailUnrouted.address} LIKE ${`%@${domain}`} OR ${mailUnrouted.address} LIKE ${`%.${domain}`}` : sql`false`))).limit(2000);
  const claimed = rows.filter(row => addresses.includes(row.address) || rules.some(rule => ruleMatches(rule, row.address)) || addresses.some(address => { const [local, host] = row.address.split('@'); return local?.includes('+') && `${local.split('+')[0]}@${host}` === address; }));
  if (!claimed.length) return 0;
  const messageIds = [...new Set(claimed.map(row => row.messageId))];
  const messages = await tx.select().from(mailMessages).where(inArray(mailMessages.id, messageIds)).orderBy(asc(mailMessages.receivedAt));
  for (const message of messages) await attachToMailboxes(tx, scope, message, [mailbox.id]);
  for (const row of claimed) await tx.delete(mailUnrouted).where(and(eq(mailUnrouted.workspaceId, scope.workspaceId), eq(mailUnrouted.address, row.address), eq(mailUnrouted.messageId, row.messageId)));
  return messages.length;
}

function registerReceivingDomains(app: App) {
  const base = '/v1/inbound/domains';
  const meta = { security, tags: ['Inbound domains'] };
  // ---------- domains ----------
  app.openapi(createRoute({ ...meta, method: 'get', path: base, operationId: 'listInboundDomains', summary: 'List domains and their receiving status', responses: { 200: response(z.object({ data: z.array(InboundDomainSchema) }).openapi('InboundDomainList')), ...errors } }), async c => {
    const value = admin(c);
    c.env = await withRegionSettings(c.env, value.workspaceId);
    const rows = await c.env.db.select().from(domains).where(and(eq(domains.workspaceId, value.workspaceId), inArray(domains.region, c.env.config.regions))).orderBy(asc(domains.name));
    return c.json({ data: await domainViews(c, rows) }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${base}/{id}`, operationId: 'getInboundDomain', request: { params: IdParam }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    return c.json((await domainViews(c, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/check`, operationId: 'checkInboundDomain', summary: 'Check MX records now', description: 'Reads public DNS and reports who currently receives mail for the domain. Updates the receiving status when inbound is enabled. Never changes DNS or AWS.', request: { params: IdParam }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    if (c.env.config.multiTenant) { const [view]=await domainViews(c,[row]);return c.json({...view!,mx:await checkMx(view!.name,row.region)},200); }
    const mx = await checkMx(row.name, row.region);
    await saveMailboxMx(c.env.db,row.workspaceId,row.id,mx);
    const [view] = await domainViews(c, [row]);
    return c.json({ ...view!, mx }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/enable`, operationId: 'enableInboundDomain', summary: 'Enable receiving for a verified domain',
    description: 'Checks that the domain is verified in SES and that its MX records will not take mail from another provider, then queues setup: an OpenSend S3 bucket, SNS topic and a catch-all SES receipt rule for the domain. Publish the returned MX record to start receiving. Use force=true to take over a domain whose mail another provider receives today.',
    request: { params: IdParam, body: json(z.object({ catchAll: InboundCatchAll.optional(), force: z.boolean().default(false) }).strict().openapi('EnableInboundDomain')) }, responses: { 202: response(InboundDomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id); const input = c.req.valid('json');
    c.env = await withRegionSettings(c.env, value.workspaceId);
    if (c.env.config.multiTenant) return c.json((await domainViews(c,[row]))[0]!,202);
    if (!c.env.config.regions.includes(row.region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'Enable the domain’s SES region first.');
    const identity = await getSes(c.env, row.region).send(new GetEmailIdentityCommand({ EmailIdentity: row.name })).catch(() => { throw new ApiError(503, 'SES_UNAVAILABLE', 'Could not read the domain’s SES verification status.', undefined, true); });
    if (identity.VerificationStatus !== 'SUCCESS') throw new ApiError(409, 'DOMAIN_NOT_VERIFIED', 'Verify the domain in SES before enabling mailboxes.');
    const mx = await checkMx(row.name, row.region);
    if (mx.state === 'error' && !input.force) throw new ApiError(503, 'MX_LOOKUP_FAILED', 'Could not verify the current MX records. Retry before enabling receiving.', undefined, true);
    if (mxBlocksEnable(mx) && !input.force) throw new ApiError(409, 'MX_CONFLICT', `${mx.message} Retry with force=true to continue anyway.`);
    await c.env.db.transaction(async tx => {
      const [current] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId))).for('update');
      const now = new Date().toISOString();
      if (!current) await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: value.workspaceId, domainId: row.id, name: row.name, region: row.region, status: 'provisioning', catchAll: input.catchAll, mx, checkedAt: mx.checkedAt });
      else await tx.update(mailboxDomains).set({ ...(['disabled', 'disabling', 'failed'].includes(current.status) ? { status: 'provisioning' as const, lastError: null } : {}), catchAll: input.catchAll, mx, checkedAt: mx.checkedAt, updatedAt: now }).where(eq(mailboxDomains.id, current.id));
      await queueReconcile(tx, value.workspaceId, row.region);
    });
    log('info', { code: 'MAILBOX_DOMAIN_ENABLE_QUEUED', region: row.region, mx: mx.state });
    return c.json((await domainViews(c, [row]))[0]!, 202);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{id}/disable`, operationId: 'disableInboundDomain', summary: 'Stop receiving for a domain', description: `Removes the domain from the OpenSend receipt rule. Receiving addresses and stored messages are kept.`, request: { params: IdParam }, responses: { 202: response(InboundDomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id);
    if (c.env.config.multiTenant) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Receiving follows verified DNS. Remove the MX record to stop delivery.');
    await c.env.db.transaction(async tx => {
      const updated = await tx.update(mailboxDomains).set({ status: 'disabling', updatedAt: new Date().toISOString() }).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['provisioning', 'waiting_for_mx', 'active', 'failed']))).returning({ id: mailboxDomains.id });
      if (updated.length) await queueReconcile(tx, value.workspaceId, row.region);
    });
    return c.json((await domainViews(c, [row]))[0]!, 202);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${base}/{id}`, operationId: 'updateInboundDomain',
    request: { params: IdParam, body: json(z.object({ catchAll: InboundCatchAll.optional(), acceptSubdomains: z.boolean().optional().describe('Whether the receipt rule also matches every subdomain (.example.com). Turned on by the first subdomain and kept on after that.') }).strict().refine(value => value.catchAll !== undefined || value.acceptSubdomains !== undefined, 'Set catchAll or acceptSubdomains.').openapi('UpdateInboundDomain')) }, responses: { 200: response(InboundDomainSchema), ...errors } }), async c => {
    const value = admin(c); const row = await operationDomain(c, c.req.valid('param').id); const input = c.req.valid('json');
    if (c.env.config.multiTenant && input.acceptSubdomains!==undefined) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Receiving follows the exact verified MX hostname.');
    const updated = await c.env.db.transaction(async tx => {
      const [before] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.domainId, row.id), isNull(mailboxDomains.parentId))).for('update');
      if (!before) return [];
      const saved = await tx.update(mailboxDomains).set({ catchAll: input.catchAll, ...(input.acceptSubdomains !== undefined ? { acceptSubdomains: input.acceptSubdomains } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, before.id)).returning({ id: mailboxDomains.id });
      if (input.acceptSubdomains !== undefined && input.acceptSubdomains !== before.acceptSubdomains) await queueReconcile(tx, value.workspaceId, before.region);
      return saved;
    });
    if (!updated.length) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', 'Enable receiving for this domain first.');
    return c.json((await domainViews(c, [row]))[0]!, 200);
  });

  // ---------- subdomains ----------
  const SubParams = z.object({ id: z.string().min(1).max(120), subdomainId: z.string().min(1).max(120) });
  const subdomains = `${base}/{id}/subdomains`;
  app.openapi(createRoute({ ...meta, method: 'get', path: subdomains, operationId: 'listInboundSubdomains', summary: 'List receiving subdomains',
    request: { params: IdParam, query: z.object({ status: z.enum(['active', 'disabled', 'all']).default('active'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(InboundSubdomainSchema, 'InboundSubdomainPage')), ...errors } }), async c => {
    admin(c); const parent = await receivingParent(c, c.req.valid('param').id); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.parentId, parent.id), q.status === 'all' ? undefined : q.status === 'active' ? eq(mailboxDomains.status, 'active') : sql`${mailboxDomains.status} <> 'active'`, q.cursor ? sql`${mailboxDomains.name} > ${q.cursor}` : undefined)).orderBy(asc(mailboxDomains.name)).limit(q.limit + 1);
    return c.json({ data: await subdomainViews(c.env, parent, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.name : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: subdomains, operationId: 'createInboundSubdomain', summary: 'Add a receiving subdomain',
    description: `Starts receiving mail for name.example.com under a receiving example.com, with no DNS change or SES verification per subdomain. The first subdomain adds the wildcard recipient (.example.com) to the receipt rule, which takes up to a minute; later ones are live immediately. Publish the returned *.example.com MX record once. Receiving addresses can then be created on the subdomain. Re-adding a removed subdomain restores it.`,
    request: { params: IdParam, body: json(z.object({ name: z.string().trim().toLowerCase().max(253).describe('A label (acme) or the full host (acme.example.com).'), catchAll: InboundCatchAll.default('store').describe('For an unknown recipient, store keeps the message as unrouted (default); create_address creates a receiving address.'), metadata: Metadata.default({}) }).strict().openapi('CreateInboundSubdomain')) },
    responses: { 201: response(InboundSubdomainSchema), ...errors } }), async c => {
    const value = admin(c); const parent = await receivingParent(c, c.req.valid('param').id); const input = c.req.valid('json');
    if (c.env.config.multiTenant) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Add the subdomain in Domains and verify its DNS records.');
    const label = input.name.endsWith(`.${parent.name}`) ? input.name.slice(0, -(parent.name.length + 1)) : input.name;
    if (!LABEL.test(label)) throw new ApiError(422, 'INVALID_SUBDOMAIN', `Use one DNS label of letters, digits and hyphens, e.g. acme for acme.${parent.name}.`, 'name');
    const name = `${label}.${parent.name}`;
    const mx = await checkMx(name, parent.region);
    const row = await c.env.db.transaction(async tx => {
      // One lock per parent keeps accept_subdomains consistent with its active subdomains.
      const [fresh] = await tx.select({ acceptSubdomains: mailboxDomains.acceptSubdomains }).from(mailboxDomains).where(eq(mailboxDomains.id, parent.id)).for('no key update');
      const [existing] = await tx.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(mailboxDomains.name, name)));
      if (existing && (existing.parentId !== parent.id || existing.status === 'active')) throw new ApiError(409, 'SUBDOMAIN_EXISTS', `${name} already receives mail.`, 'name');
      const now = new Date().toISOString();
      const [saved] = existing
        ? await tx.update(mailboxDomains).set({ status: 'active', catchAll: input.catchAll, metadata: input.metadata, mx, checkedAt: mx.checkedAt, lastError: null, enabledAt: now, updatedAt: now }).where(eq(mailboxDomains.id, existing.id)).returning()
        : await tx.insert(mailboxDomains).values({ id: id('mdom'), workspaceId: value.workspaceId, domainId: parent.domainId, parentId: parent.id, name, region: parent.region, status: 'active', catchAll: input.catchAll, metadata: input.metadata, mx, checkedAt: mx.checkedAt, enabledAt: now }).returning();
      if (!fresh?.acceptSubdomains) {
        await tx.update(mailboxDomains).set({ acceptSubdomains: true, updatedAt: now }).where(eq(mailboxDomains.id, parent.id));
        await queueReconcile(tx, value.workspaceId, parent.region);
      }
      return saved!;
    });
    log('info', { code: 'MAILBOX_SUBDOMAIN_ADDED', region: parent.region, mx: mx.state });
    return c.json((await subdomainViews(c.env, { ...parent, acceptSubdomains: true }, [row]))[0]!, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${subdomains}/{subdomainId}`, operationId: 'getInboundSubdomain', request: { params: SubParams }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id);
    return c.json((await subdomainViews(c.env, parent, [await subdomainRow(c, parent, params.subdomainId)]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${subdomains}/{subdomainId}`, operationId: 'updateInboundSubdomain',
    request: { params: SubParams, body: json(z.object({ catchAll: InboundCatchAll.optional(), metadata: Metadata.optional() }).strict().openapi('UpdateInboundSubdomain')) }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id); const input = c.req.valid('json');
    const current = await subdomainRow(c, parent, params.subdomainId);
    const [row] = await c.env.db.update(mailboxDomains).set({ catchAll: input.catchAll, ...(input.metadata ? { metadata: input.metadata } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, current.id)).returning();
    return c.json((await subdomainViews(c.env, parent, [row!]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: `${subdomains}/{subdomainId}`, operationId: 'removeInboundSubdomain', summary: 'Stop receiving for a subdomain',
    description: `New mail to the subdomain is dropped at ingest. Its receiving addresses and stored messages are kept, and adding the subdomain again restores it. The parent keeps its wildcard recipient, so adding subdomains later is instant; turn it off with PATCH ${base}/{id} acceptSubdomains=false.`, request: { params: SubParams }, responses: { 200: response(InboundSubdomainSchema), ...errors } }), async c => {
    admin(c); const params = c.req.valid('param'); const parent = await receivingParent(c, params.id);
    if (c.env.config.multiTenant) throw new ApiError(409,'HOSTED_RECEIVING_MANAGED','Receiving follows verified DNS. Remove the MX record to stop delivery.');
    const current = await subdomainRow(c, parent, params.subdomainId);
    const [row] = await c.env.db.update(mailboxDomains).set({ status: 'disabled', updatedAt: new Date().toISOString() }).where(eq(mailboxDomains.id, current.id)).returning();
    return c.json((await subdomainViews(c.env, parent, [row!]))[0]!, 200);
  });
}

const EmailAddressInput = z.string().trim().toLowerCase().max(254).regex(ADDRESS, 'Use a valid email address.');
function registerAddresses(app: App) {
  const collection = '/v1/inbound/addresses', detail = `${collection}/{addressId}`;
  const params = z.object({ addressId: InboundAddressId });
  const meta = { tags: ['Inbound addresses'], security };
  const MailboxInput = z.object({
    address: EmailAddressInput, displayName: z.string().trim().max(200).nullable().optional(),
    publicAddress: EmailAddressInput.optional().describe('Permanent addresses only: immutable default From with the same local part on a strict ancestor domain verified for sending with DKIM in the receiving region. Does not change routing or MX.'),
    ttlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional().describe('Lease duration in seconds, 60–2592000 (30 days). Omit for a permanent address. Temporary addresses accept plus-tags, not aliases, wildcard rules or historical backfill. Expiry is fixed at creation.'),
    aliases: z.array(z.string().trim().toLowerCase().max(254).regex(ADDRESS)).max(50).default([]), rules: z.array(z.string().max(254)).max(20).default([]).describe('Wildcard address patterns, e.g. support+*@acme.com or *@help.acme.com.'),
    metadata: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 16384, 'Metadata must be at most 16 KB.').default({}),
    sendLimits: z.object({ perHour: z.number().int().min(0).max(10000), perDay: z.number().int().min(0).max(100000), perRecipientPerHour: z.number().int().min(0).max(1000), perThreadPer10Minutes: z.number().int().min(0).max(1000) }).partial().strict().optional()
      .describe(`Override outbound limits. Defaults: ${Object.entries(DEFAULT_SEND_LIMITS).map(([key, value]) => `${key} ${value}`).join(', ')}. 0 blocks sending.`),
    requireDmarc: z.boolean().default(false).describe('Hold received mail without a DMARC pass for its From domain: it is stored with the unverified label and does not emit message.received.'),
  }).strict().openapi('CreateInboundAddress');
  app.openapi(createRoute({ ...meta, method: 'get', path: collection, operationId: 'listInboundAddresses', summary: 'List receivable addresses', description: 'An address key sees only addresses it can access.',
    request: { query: z.object({ domain: z.string().max(253).optional(), origin: z.enum(['api', 'auto']).optional(), q: z.string().max(200).optional(), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(InboundAddressSchema, 'InboundAddressPage')), ...errors } }), async c => {
    const value = access(c, 'read'); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), value.mailboxIds ? inArray(mailboxes.id, value.mailboxIds.length ? value.mailboxIds : ['']) : undefined,
      q.domain ? sql`split_part(${mailboxes.address}, '@', 2) = ${q.domain.toLowerCase()}` : undefined, q.origin ? eq(mailboxes.origin, q.origin) : undefined,
      q.q ? or(sql`${mailboxes.address} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`, sql`${mailboxes.displayName} ILIKE ${`%${q.q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`}`) : undefined,
      q.cursor ? lt(mailboxes.id, q.cursor) : undefined)).orderBy(desc(mailboxes.id)).limit(q.limit + 1);
    return c.json({ data: await mailboxViews(c.env, rows.slice(0, q.limit)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: collection, operationId: 'createInboundAddress', summary: 'Create a receivable address', description: 'Admin only. The domain must be verified for this workspace; mail arrives once its receiving MX record is active. Permanent addresses claim earlier unrouted mail for their address or rules; temporary addresses start empty. Expiry stops new delivery and sending without deleting history.', request: { body: json(MailboxInput) }, responses: { 201: response(InboundAddressSchema), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json'); const scope = scopeOf(value);
    const host = input.address.split('@')[1]!;
    // On MX, proven ownership of the claim is enough: routing follows the MX observation later.
    const [domain] = await c.env.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, value.workspaceId), eq(c.env.config.multiTenant?mailboxDomains.receivingHost:mailboxDomains.name,host), c.env.config.multiTenant ? sql`EXISTS (SELECT 1 FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND ${connectionReady()} JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=pc.region WHERE d.id=${mailboxDomains.domainId} AND dc.workspace_id=${value.workspaceId} AND (${claimSends()} OR ${claimReceivable()}))` : undefined));
    if (!domain || (!c.env.config.multiTenant && ['disabled', 'disabling'].includes(domain.status))) throw new ApiError(409, 'MAILBOX_DOMAIN_NOT_ENABLED', `Verify ${host}'s domain in this workspace before creating addresses on it.`, 'address');
    const publicAddress = input.publicAddress;
    if (publicAddress) {
      if (input.ttlSeconds !== undefined) throw new ApiError(422, 'TEMPORARY_MAILBOX_ROUTING', 'Temporary mailboxes cannot have a public sender address.', 'publicAddress');
      const [local, publicHost] = publicAddress.split('@') as [string, string];
      if (local !== input.address.split('@')[0] || !host.endsWith(`.${publicHost}`)) throw new ApiError(422, 'PUBLIC_ADDRESS_MISMATCH', 'Use the same local part on a parent domain of the receiving address.', 'publicAddress');
      if (!c.env.config.multiTenant) {
      c.env = await withRegionSettings(c.env, value.workspaceId);
      const identity = await getSes(c.env, domain.region).send(new GetEmailIdentityCommand({ EmailIdentity: publicHost })).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'NotFoundException') throw new ApiError(409, 'PUBLIC_DOMAIN_NOT_VERIFIED', `Verify the exact SES domain identity ${publicHost} in ${domain.region}.`, 'publicAddress');
        throw new ApiError(503, 'SES_UNAVAILABLE', `Could not read the SES identity for ${publicHost} in ${domain.region}. Check GetEmailIdentity access.`, 'publicAddress', true);
      });
      if (identity.VerifiedForSendingStatus !== true) throw new ApiError(409, 'PUBLIC_DOMAIN_NOT_VERIFIED', `${publicHost} is not verified for sending in ${domain.region}.`, 'publicAddress');
      if (identity.DkimAttributes?.SigningEnabled !== true || identity.DkimAttributes.Status !== 'SUCCESS') throw new ApiError(409, 'PUBLIC_DOMAIN_DKIM_NOT_READY', `Enable and verify DKIM signing for ${publicHost} in ${domain.region}.`, 'publicAddress');
      }
    }
    const { row, runnable } = await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx,scope.workspaceId, 'address');
      if (publicAddress && c.env.config.multiTenant) {
        const host=publicAddress.split('@')[1]!;
        if (!(await tx.execute(sql`SELECT 1 FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
          WHERE dc.workspace_id=${scope.workspaceId} AND dc.name=${host} AND ${claimSends()} AND pc.region=${domain.region} AND ${connectionReady()} FOR SHARE OF dc,pc`)).rowCount) throw new ApiError(409,'PUBLIC_DOMAIN_NOT_VERIFIED','The public sender domain must be verified and ready in this workspace and region.','publicAddress');
      }
      const created = await createMailbox(tx, scope, { domainId: domain.id, domainName: host, address: input.address, displayName: input.displayName ?? null, aliases: input.aliases, rules: input.rules, metadata: input.metadata, origin: 'api', sendLimits: input.sendLimits, requireDmarc: input.requireDmarc, ttlSeconds: input.ttlSeconds });
      if (publicAddress) {
        const [claimed] = await tx.insert(mailboxAddresses).values({ ...scope, address: publicAddress, mailboxId: created.id, kind: 'public' }).onConflictDoNothing().returning({ address: mailboxAddresses.address });
        if (!claimed) throw new ApiError(409, 'ADDRESS_TAKEN', `${publicAddress} already belongs to a mailbox.`, 'publicAddress');
      }
      await claimUnrouted(tx, scope, created, [created.address, ...input.aliases], created.rules);
      return { row: created, runnable: await recordEvents(tx, scope.workspaceId, [{ type: 'address.created', mailboxId: created.id, data: { origin: 'api', address: created.address } }]) };
    });
    if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
    return c.json((await mailboxViews(c.env, [row]))[0]!, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: detail, operationId: 'getInboundAddress', summary: 'Read a receivable address', request: { params }, responses: { 200: response(InboundAddressSchema), ...errors } }), async c => {
    const { mailbox } = await mailboxFor(c, c.req.valid('param').addressId);
    return c.json((await mailboxViews(c.env, [mailbox]))[0]!, 200);
  });
  const fields = MailboxInput.shape;
  const patch = z.object({ displayName: fields.displayName, aliases: fields.aliases.removeDefault().optional(), rules: fields.rules.removeDefault().optional(), metadata: fields.metadata.removeDefault().optional(), sendLimits: fields.sendLimits, requireDmarc: fields.requireDmarc.removeDefault().optional() }).strict().openapi('UpdateInboundAddress');
  app.openapi(createRoute({ ...meta, method: 'patch', path: detail, operationId: 'updateInboundAddress', description: 'Admin only. Only supplied fields change. The address, public sender and expiry are immutable.',
    request: { params, body: json(patch) }, responses: { 200: response(InboundAddressSchema), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').addressId); const input = c.req.valid('json');
    if (mailbox.expiresAt !== null) checkTemporaryMailboxRouting(input);
    const domain = mailbox.address.split('@')[1]!;
    await c.env.db.transaction(async tx => {
      const rules = input.rules ? [...new Set(input.rules.map(rule => validateRule(rule, domain)))] : undefined;
      const [updated] = await tx.update(mailboxes).set({ ...(input.displayName !== undefined ? { displayName: input.displayName } : {}), ...(rules ? { rules } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.sendLimits ? { sendLimits: { ...mailbox.sendLimits, ...input.sendLimits } } : {}), ...(input.requireDmarc !== undefined ? { requireDmarc: input.requireDmarc } : {}), updatedAt: new Date().toISOString() }).where(eq(mailboxes.id, mailbox.id)).returning();
      let added: string[] = [];
      if (input.aliases) {
        const aliases = [...new Set(input.aliases)].filter(alias => alias !== mailbox.address);
        for (const alias of aliases) if (!alias.endsWith(`@${domain}`)) throw new ApiError(422, 'ADDRESS_DOMAIN_MISMATCH', `Aliases must end in @${domain}.`, 'aliases');
        const current = await tx.select().from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), eq(mailboxAddresses.kind, 'alias')));
        const removed = current.filter(row => !aliases.includes(row.address)).map(row => row.address);
        added = aliases.filter(alias => !current.some(row => row.address === alias));
        if (removed.length) await tx.delete(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), inArray(mailboxAddresses.address, removed)));
        if (added.length) {
          const taken = await tx.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, scope.workspaceId), inArray(mailboxAddresses.address, added)));
          if (taken.length) throw new ApiError(409, 'ADDRESS_TAKEN', `${taken[0]!.address} already belongs to a mailbox.`, 'aliases');
          await tx.insert(mailboxAddresses).values(added.map(address => ({ ...scope, address, mailboxId: mailbox.id, kind: 'alias' as const })));
        }
      }
      if (added.length || rules?.length) await claimUnrouted(tx, scope, updated!, added, rules ?? []);
    });
    const [row] = await c.env.db.select().from(mailboxes).where(eq(mailboxes.id, mailbox.id));
    return c.json((await mailboxViews(c.env, [row!]))[0]!, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: detail, operationId: 'deleteInboundAddress', description: 'Admin only. Releases this address and removes its per-address state. Stored messages are kept; future mail follows normal routing.', request: { params }, responses: { 200: response(Ok), ...errors } }), async c => {
    admin(c); const { mailbox, scope } = await mailboxFor(c, c.req.valid('param').addressId);
    const runnable = await c.env.db.transaction(async tx => {
      await tx.delete(mailboxThreads).where(eq(mailboxThreads.mailboxId, mailbox.id));
      await tx.delete(mailboxes).where(eq(mailboxes.id, mailbox.id));
      return recordEvents(tx, scope.workspaceId, [{ type: 'address.deleted', mailboxId: mailbox.id, data: { address: mailbox.address } }]);
    });
    if (runnable) try { await c.env.wake?.(runnable); } catch { /* durable */ }
    return c.json({ ok: true as const }, 200);
  });
}

export function registerMailbox(app: App) {
  app.use('/v1/inbound/*', mailboxAuth);
  // These routes call the same region-checked send admission as /v1/emails/send.
  app.on('POST', ['/v1/inbound/threads', '/v1/inbound/threads/:threadId/reply'], async (c, next) => {
    c.env = await withRegionSettings(c.env, access(c).workspaceId);
    await next();
  });
  registerReceivingDomains(app);
  registerAddresses(app);
  const Address = EmailAddressInput;

  // ---------- sending ----------
  const Recipients = z.array(Address).max(50);
  const AttachmentItem = z.union([
    z.object({ filename: AttachmentFilename, content: z.string().min(4).max(MAX_ATTACHMENT_BASE64).describe('Base64; line breaks are accepted.'), contentType: AttachmentContentType.optional(), disposition: AttachmentDisposition.optional(), contentId: AttachmentContentId.optional() }).strict(),
    z.object({ id: z.string().min(1).max(120).describe('A received attachment in this mailbox (matt_…) or an OpenSend attachment upload (attachment_…).') }).strict(),
  ]).openapi('InboundAttachmentInput');
  const Compose = {
    from: Address.optional().describe('Defaults to the public address if configured, otherwise the primary receiving address. Address keys may use only addresses owned by this mailbox. Administrators may use any address on a domain registered in OpenSend for the receiving region; replies still return to whatever address the recipient answers.'),
    text: z.string().min(1).max(524288).optional(), html: z.string().min(1).max(524288).optional(),
    attachments: z.array(AttachmentItem).max(20).default([]).describe('Up to 20 files, 8 MiB combined. Any type Amazon SES delivers (executables and scripts are refused).'),
    replyTo: Recipients.max(10).default([]),
    headers: CustomHeaders.default([]).describe('Extra headers such as List-Id, Precedence or X-Ticket. Structural and authentication headers (From, To, Date, Message-ID, Content-*, Resent-*, ARC-*, Authentication-Results, DKIM/DomainKey-Signature, Feedback-ID, In-Reply-To, References, Auto-Submitted, X-SES-*) are set by OpenSend or the provider and refused.'),
    autoSubmitted: z.enum(['auto-generated', 'auto-replied']).optional().describe('Adds an RFC 3834 Auto-Submitted header so other automated systems do not reply to this message.'),
  };
  const needsBody = (value: { text?: string; html?: string }) => !!value.text || !!value.html;
  const CreateInbound = z.object({ ...Compose, addressId: InboundAddressId, to: Recipients.min(1), cc: Recipients.default([]), bcc: Recipients.default([]), subject: z.string().trim().min(1).max(998).refine(value => !/[\r\n]/.test(value), 'Subject cannot contain line breaks.') })
    .strict().refine(needsBody, 'Provide text or html.').openapi('CreateInboundThread');
  const ReplyInbound = z.object({ ...Compose, addressId: InboundAddressId.optional(),
    replyToMessageId: z.string().min(1).max(120).optional().describe('OpenSend message ID (msg_…) of a visible message in this thread.'),
    expectedRecipients: z.object({ to: Recipients, cc: Recipients, bcc: Recipients }).strict().optional().describe('Check the final To, Cc and Bcc against these reviewed address sets; never overrides recipients. A mismatch returns 409 INBOUND_RECIPIENTS_CHANGED.'),
    replyAll: z.boolean().default(false).describe('Also copy everyone else on the original message.'),
    to: Recipients.optional().describe('Override the computed recipients.'), cc: Recipients.optional(), bcc: Recipients.default([]),
    subject: z.string().trim().min(1).max(998).optional().describe('Defaults to "Re: <original subject>".'),
    quote: z.boolean().default(false).describe('Append the original message as quoted text.'),
    allowAutomated: z.boolean().default(false).describe('Reply even when the original is automated or the recipient is a no-reply address.'),
  }).strict().refine(needsBody, 'Provide text or html.').openapi('ReplyToInboundThread');
  function sendActor(c: Ctx, access: MailboxAccess): Actor {
    const actor = c.get('actor');
    if (access.keyId.startsWith('mbk_') || !actor) return { keyId: access.keyId, workspaceId: access.workspaceId, permissions: ['send'], domains: [], credential: 'apiKey' };
    return actor;
  }
  async function senderAddress(c: Ctx, mailbox: typeof mailboxes.$inferSelect, from?: string, db: DbExecutor = c.env.db) {
    if (from === mailbox.address) return from;
    const [owned] = await db.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(and(eq(mailboxAddresses.mailboxId, mailbox.id), from ? eq(mailboxAddresses.address, from) : eq(mailboxAddresses.kind, 'public')));
    if (from && !owned) {
      // Scoped keys may only speak as their own addresses; an administrator may use any registered sender.
      if (!access(c).admin) throw new ApiError(403, 'FROM_NOT_ALLOWED', 'Inbound keys can send only from their own addresses. Use administrator access for another sender.', 'from');
      if (!c.env.config.multiTenant) {
        const [domain] = await db.select({ region: mailboxDomains.region }).from(mailboxDomains).where(eq(mailboxDomains.id, mailbox.domainId));
        await assertRegisteredSender(db, scopeOf(access(c)), domain!.region, from);
      }
      return from;
    }
    return owned?.address ?? mailbox.address;
  }
  const quoted = (original: MessageRow) => {
    const who = original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress;
    const intro = `On ${new Date(original.sentAt ?? original.receivedAt).toUTCString()}, ${who} wrote:`;
    const text = original.text ?? (original.html ? htmlToPlain(original.html) : '');
    return { text: `\n\n${intro}\n${text.split('\n').map(line => `> ${line}`).join('\n')}`, html: `<br><br><div>${intro.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${original.html ? safeForwardHtml(original.html) : `<pre>${text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</pre>`}</blockquote>` };
  };
  async function prepareSend(c: Ctx, db: DbExecutor, mailbox: typeof mailboxes.$inferSelect, body: z.infer<typeof CreateInbound>) {
    const from=await senderAddress(c,mailbox,body.from,db);
    return { from, to: body.to, cc: body.cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject, text: body.text, html: body.html,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments,from), inReplyTo: null, references: [], autoSubmitted: body.autoSubmitted, headers: body.headers };
  }
  async function prepareReply(c: Ctx, db: DbExecutor, mailbox: typeof mailboxes.$inferSelect, original: MessageRow, body: z.infer<typeof ReplyInbound>) {
    const from = await senderAddress(c, mailbox, body.from, db);
    // The chosen sender is ours too: never copy it back on a reply-all.
    const own = [...(await db.select({ address: mailboxAddresses.address }).from(mailboxAddresses).where(eq(mailboxAddresses.mailboxId, mailbox.id))).map(row => row.address), from];
    const computed = replyRecipients(original, own, body.replyAll);
    const to = body.to ?? computed.to, cc = body.cc ?? computed.cc;
    if (body.expectedRecipients) assertInboundRecipients(body.expectedRecipients, { to, cc, bcc: body.bcc });
    assertReplyable(original, to, body.allowAutomated);
    const parentId = await replyParentId(db, original);
    const quote = body.quote ? quoted(original) : null;
    return {
      from, to, cc, bcc: body.bcc, replyTo: body.replyTo, subject: body.subject ?? replySubject(original.subject),
      text: body.text ? body.text + (quote?.text ?? '') : undefined, html: body.html ? body.html + (quote?.html ?? '') : undefined,
      attachments: await resolveAttachments(c.env, mailbox, body.attachments,from), threadId: original.threadId,
      inReplyTo: parentId, references: replyReferences(original, parentId), autoSubmitted: body.autoSubmitted, headers: body.headers,
    };
  }
  registerInboundThreadReads(app, access);
  app.openapi(createRoute({method:'patch',path:'/v1/inbound/threads/{threadId}',operationId:'updateInboundThread',tags:['Inbound threads'],security,summary:'Mark a conversation read, star, archive or label it for one address',request:{params:z.object({threadId:z.string().min(1).max(120)}),body:json(UpdateInboundThread)},responses:{200:response(AddressState),...errors}}),async c=>{
    const v=access(c,'modify'),{threadId}=c.req.valid('param'),{addressId,...changes}=c.req.valid('json');
    const options=await c.env.db.select({id:mailboxThreads.mailboxId}).from(mailboxThreads).where(visibleThreadAddresses(v,threadId,addressId)).limit(2);
    if (!options.length) throw new ApiError(404,'NOT_FOUND','Thread was not found.');
    if (options.length!==1) throw new ApiError(409,'ADDRESS_REQUIRED','Choose an address before changing its conversation state.','addressId');
    return c.json(await patchThread(c,options[0]!.id,threadId,changes),200);
  });
  app.openapi(createInboundThreadRoute(CreateInbound), async c => {
    const body = c.req.valid('json'), value = access(c, 'send');
    return c.json(await queueInboundThreadMessage(c, sendActor(c, value), async db => {
      const { mailbox, scope } = await mailboxFor(c, body.addressId, 'send', db);
      return { mailbox, scope, ...await prepareSend(c, db, mailbox, body) };
    }), 202);
  });
  app.openapi(replyToInboundThreadRoute(ReplyInbound), async c => {
    const body = c.req.valid('json'), value = access(c, 'send');
    return c.json(await queueInboundThreadMessage(c, sendActor(c, value), async db => {
      const { original, addressId } = await inboundReplyTarget(db, value, { addressId: body.addressId, threadId: c.req.valid('param').threadId, messageId: body.replyToMessageId });
      const { mailbox, scope } = await mailboxFor(c, addressId, 'send', db);
      return { mailbox, scope, ...await prepareReply(c, db, mailbox, original, body) };
    }), 202);
  });
  // ---------- events ----------
  const EventQuery = z.object({ after: z.string().regex(/^\d{1,19}$/).optional().describe('Cursor from a previous response. Omit to start at the current end of the log.'), wait: z.coerce.number().int().min(0).max(30).default(0).describe('Seconds to wait for new events when none are ready (long-poll).'), types: z.string().max(400).optional().describe('Comma-separated event types.'), limit: Limit });
  const parseEventIds = (filter?: string) => filter?.split(',').map(item => item.trim()).filter(Boolean) ?? null;
  async function poll(c: Ctx, requested: string[] | null, q: z.infer<typeof EventQuery>) {
    const value = access(c, 'read');
    const mailboxIds = value.mailboxIds === null ? requested : requested === null ? value.mailboxIds : requested.filter(item => value.mailboxIds!.includes(item));
    const types = q.types?.split(',').map(type => type.trim()).filter(Boolean);
    if (types?.some(type => !inboundEventTypes.some(allowed => allowed === type))) throw new ApiError(422, 'INVALID_EVENT_TYPE', `Event types: ${inboundEventTypes.join(', ')}.`, 'types');
    const scope = { mailboxIds, includeStored: value.admin && types?.includes('message.stored') === true };
    let after = q.after !== undefined ? Number(q.after) : await latestCursor(c.env.db, value.workspaceId, scope);
    const deadline = Date.now() + q.wait * 1000;
    for (;;) {
      const rows = await readEvents(c.env.db, value.workspaceId, { ...scope, after, types, limit: q.limit });
      if (rows.length) return { data: rows.map(eventView), cursor: String(rows.at(-1)!.seq) };
      if (Date.now() >= deadline) return { data: [], cursor: String(after) };
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
      after = Math.max(after, 0);
    }
  }
  const InboundEventQuery = EventQuery.extend({ addressId: z.string().min(1).max(120).optional().describe('Include only this receiving address.'), addressIds: z.string().max(4000).optional().describe('Comma-separated receiving address IDs. Use instead of addressId.') }).strict().refine(q => q.addressId === undefined || q.addressIds === undefined, { path: ['addressIds'], message: 'Supply addressId or addressIds, not both.' });
  app.openapi(createRoute({ method: 'get', path: '/v1/inbound/events', operationId: 'listInboundEvents', security, tags: ['Inbound events'], summary: 'Poll events for the receiving addresses this key can read', description: 'Use the returned cursor as after to continue polling. Workspace-wide message.stored events require admin access, no address filter, and an explicit message.stored type filter.', request: { query: InboundEventQuery }, responses: { 200: response(z.object({ data: z.array(InboundEventSchema), cursor: z.string().describe('Pass as after on the next call.') }).openapi('InboundEventPage')), ...errors } }), async c => {
    const q = c.req.valid('query');
    return c.json(await poll(c, q.addressId ? [q.addressId] : parseEventIds(q.addressIds), q), 200);
  });

  registerInboundKeys(app);
  registerInboundWebhooks(app);
}

function registerInboundKeys(app: App) {
  const base = '/v1/inbound/keys', tags = ['Inbound keys'];
  const keyFields = { name: z.string().trim().min(1).max(100), permissions: z.array(z.enum(['read', 'send', 'modify'])).min(1).max(3).default(['read', 'send', 'modify']) };
  const ids = z.array(z.string().min(1).max(120)).min(1).max(500).optional();
  const body = z.object({ ...keyFields, addressIds: ids }).strict().openapi('CreateInboundKey');
  app.openapi(createRoute({ method: 'post', path: base, operationId: 'createInboundKey', tags, security, summary: 'Create a key for an agent', description: 'Scope this credential to specific receiving addresses. If the filter is omitted it applies to every address, including future ones. The secret is returned once.',
    request: { body: json(body) }, responses: { 201: response(KeySchema.extend({ secret: z.string() }).openapi('InboundKeySecret')), ...errors } }), async c => {
    const value = admin(c); const input = c.req.valid('json');
    if (!['apiKey', 'dashboard'].includes(c.get('actor')?.credential ?? '')) throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Create inbound keys with a live API key or the dashboard.');
    const mailboxIds = input.addressIds ? [...new Set(input.addressIds)] : null;
    if (mailboxIds) {
      const found = await c.env.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, value.workspaceId), inArray(mailboxes.id, mailboxIds)));
      if (found.length !== mailboxIds.length) throw new ApiError(422, 'MAILBOX_NOT_FOUND', 'Every ID must identify an existing receiving address.', 'addressIds');
    }
    const secret = randomSecret('os_mbx_');
    const [row] = await c.env.db.insert(mailboxKeys).values({ id: id('mbk'), workspaceId: value.workspaceId, name: input.name, hash: await digest(secret), prefix: secret.slice(0, 14), mailboxIds, permissions: [...new Set(input.permissions)] }).returning();
    c.header('Cache-Control', 'no-store');
    return c.json({ ...keyView(row!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: base, operationId: 'listInboundKeys', tags, security, request: { query: z.object({ includeRevoked: z.enum(['true', 'false']).default('false'), cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(KeySchema, 'InboundKeyPage')), ...errors } }), async c => {
    const value = admin(c); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxKeys).where(and(eq(mailboxKeys.workspaceId, value.workspaceId), q.includeRevoked === 'false' ? isNull(mailboxKeys.revokedAt) : undefined, q.cursor ? lt(mailboxKeys.id, q.cursor) : undefined)).orderBy(desc(mailboxKeys.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(keyView), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: `${base}/{id}/revoke`, operationId: 'revokeInboundKey', tags, security, request: { params: IdParam }, responses: { 200: response(KeySchema), ...errors } }), async c => {
    const value = admin(c);
    const [row] = await c.env.db.update(mailboxKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(mailboxKeys.workspaceId, value.workspaceId), eq(mailboxKeys.id, c.req.valid('param').id), isNull(mailboxKeys.revokedAt))).returning();
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Key was not found or is already revoked.');
    return c.json(keyView(row), 200);
  });
}

function registerInboundWebhooks(app: App) {
  const path = '/v1/inbound/webhooks', tags = ['Inbound webhooks'];
  const idFilter = z.array(z.string().min(1).max(120)).min(1).max(500).nullable().describe('Only events for these receiving addresses; null for all.');
  const getWebhook = async (c: Ctx, webhookId: string, tx?: Parameters<Parameters<Runtime['db']['transaction']>[0]>[0]) => {
    const value = admin(c);
    const query = (tx ?? c.env.db).select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, value.workspaceId), eq(mailboxWebhooks.id, webhookId)));
    const [row] = await (tx ? query.for('update') : query);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Webhook was not found.');
    return { value, row };
  };
  const webhookFields = { url: z.string().url().max(2048), description: z.string().max(500), eventTypes: z.array(z.enum(inboundEventTypes)).min(1).max(inboundEventTypes.length), paused: z.boolean() };
  const createFields = { ...webhookFields, description: webhookFields.description.default(''), eventTypes: webhookFields.eventTypes.default(['message.received']), paused: webhookFields.paused.default(false) };
  const create = z.object({ ...createFields, addressIds: idFilter.default(null) }).strict();
  const patch = z.object({ ...webhookFields, addressIds: idFilter }).partial().strict();
  const checkScope = (ids: string[] | null, types: string[]) => {
    if (ids !== null && types.includes('message.stored')) throw new ApiError(422, 'INVALID_EVENT_SCOPE', 'message.stored requires a workspace webhook without an addressIds filter.', 'addressIds');
  };

  app.openapi(createRoute({ method: 'post', path, operationId: 'createInboundWebhook', security, tags, summary: 'Subscribe to inbound events', description: 'Deliveries are signed with Standard Webhooks headers (Webhook-Id, Webhook-Timestamp, Webhook-Signature) and retried with backoff. The endpoint must be a public HTTPS URL. The signing secret is returned once.', request: { body: json(create.openapi('CreateInboundWebhook')) }, responses: { 201: response(InboundWebhookSchema.extend({ secret: z.string() }).openapi('InboundWebhookSecret')), ...errors } }), async c => {
    const value = admin(c), input = c.req.valid('json');
    const mailboxIds = input.addressIds;
    checkScope(mailboxIds, input.eventTypes);
    const webhookId = id('mwh'), secret = webhookSecret();
    const [row] = await c.env.db.insert(mailboxWebhooks).values({ id: webhookId, workspaceId: value.workspaceId, url: webhookUrl(c.env, input.url), description: input.description, eventTypes: [...new Set(input.eventTypes)], mailboxIds, paused: input.paused, encryptedSecret: await encrypt(c.env, secret, webhookSecretBinding(value.workspaceId, webhookId)) }).returning();
    c.header('Cache-Control', 'no-store');
    return c.json({ ...webhookView(row!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path, operationId: 'listInboundWebhooks', security, tags, responses: { 200: response(z.object({ data: z.array(InboundWebhookSchema) }).openapi('InboundWebhookList')), ...errors } }), async c => {
    const value = admin(c);
    const rows = await c.env.db.select().from(mailboxWebhooks).where(eq(mailboxWebhooks.workspaceId, value.workspaceId)).orderBy(desc(mailboxWebhooks.id)).limit(100);
    return c.json({ data: rows.map(webhookView) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${path}/{id}`, operationId: 'getInboundWebhook', security, tags, request: { params: IdParam }, responses: { 200: response(InboundWebhookSchema), ...errors } }), async c => c.json(webhookView((await getWebhook(c, c.req.valid('param').id)).row), 200));
  app.openapi(createRoute({ method: 'patch', path: `${path}/{id}`, operationId: 'updateInboundWebhook', security, tags, request: { params: IdParam, body: json(patch.openapi('UpdateInboundWebhook')) }, responses: { 200: response(InboundWebhookSchema), ...errors } }), async c => {
    const input = c.req.valid('json'), webhookId = c.req.valid('param').id;
    const mailboxIds = input.addressIds;
    const updated = await c.env.db.transaction(async tx => {
      // Serialize partial updates: two independently valid changes must not combine into a scoped message.stored subscription.
      const { row } = await getWebhook(c, webhookId, tx);
      checkScope(mailboxIds === undefined ? row.mailboxIds : mailboxIds, input.eventTypes ?? row.eventTypes);
      const eventTypes = input.eventTypes && [...new Set(input.eventTypes)];
      const [result] = await tx.update(mailboxWebhooks).set({ mailboxIds, description: input.description, paused: input.paused, url: input.url ? webhookUrl(c.env, input.url) : undefined, eventTypes, updatedAt: new Date().toISOString() }).where(eq(mailboxWebhooks.id, webhookId)).returning();
      return result!;
    });
    return c.json(webhookView(updated), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${path}/{id}`, operationId: 'deleteInboundWebhook', security, tags, request: { params: IdParam }, responses: { 200: response(Ok), ...errors } }), async c => {
    const { row } = await getWebhook(c, c.req.valid('param').id);
    await c.env.db.delete(mailboxWebhooks).where(eq(mailboxWebhooks.id, row.id));
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: `${path}/{id}/rotate-secret`, operationId: 'rotateInboundWebhookSecret', security, tags, request: { params: IdParam }, responses: { 200: response(z.object({ secret: z.string() }).openapi('InboundWebhookRotatedSecret')), ...errors } }), async c => {
    const { value, row } = await getWebhook(c, c.req.valid('param').id); const secret = webhookSecret();
    await c.env.db.update(mailboxWebhooks).set({ encryptedSecret: await encrypt(c.env, secret, webhookSecretBinding(value.workspaceId, row.id)), updatedAt: new Date().toISOString() }).where(eq(mailboxWebhooks.id, row.id));
    c.header('Cache-Control', 'no-store');
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${path}/{id}/deliveries`, operationId: 'listInboundWebhookDeliveries', security, tags, request: { params: IdParam, query: z.object({ cursor: z.string().max(200).optional(), limit: Limit }) }, responses: { 200: response(pageOf(DeliverySchema, 'InboundWebhookDeliveryPage')), ...errors } }), async c => {
    const { value, row } = await getWebhook(c, c.req.valid('param').id); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(mailboxWebhookDeliveries).where(and(eq(mailboxWebhookDeliveries.workspaceId, value.workspaceId), eq(mailboxWebhookDeliveries.webhookId, row.id), q.cursor ? lt(mailboxWebhookDeliveries.id, q.cursor) : undefined)).orderBy(desc(mailboxWebhookDeliveries.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(item => ({ id: item.id, webhookId: item.webhookId, eventId: String(item.payload.id), status: item.status, attemptCount: item.attemptCount, lastStatusCode: item.lastStatusCode, lastError: item.lastError, createdAt: iso(item.createdAt)!, updatedAt: iso(item.updatedAt)! })), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
}
