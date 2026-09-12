import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, gte, inArray, like, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { CreateEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, PutEmailIdentityMailFromAttributesCommand, type GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { X509Certificate, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { actor, ApiError, digest, errors, getSes, id, IdParams, json, notFound, PageQuery, randomSecret, redactCapabilityData, region, response, security, senderDomainAllowed, log, type App, type Actor, type Ctx, type Config, type Database, type DbExecutor, type JobHandler, type Mode, type Permission, type Runtime } from './core.js';
import { enqueue, MAX_ATTEMPTS } from './jobs.js';
import { jobs } from './db/core.js';
import { recordUnsubscribe } from './audience.js';
import { contacts } from './db/audience.js';
import { emails } from './db/sending.js';
import { sesRegions } from './db/ses-regions.js';
import { recordEmailEvent } from './sending.js';
import { deliveryAttempts, deliveries, domains, events, eventTypes, snsReceipts, unsubscribeTokens, webhooks, workspaceSettings, type PublishedEvent, type EventType } from './db/operations.js';
export type { PublishedEvent } from './db/operations.js';

const now = () => new Date().toISOString();
const scoped = (table: { workspaceId: AnyPgColumn; environment: AnyPgColumn }, a: Pick<Actor, 'workspaceId' | 'environment'>) => and(eq(table.workspaceId, a.workspaceId), eq(table.environment, a.environment));
const eventSchema = z.object({ id: z.string(), type: z.enum(eventTypes), createdAt: z.string(), workspaceId: z.string(), environment: z.enum(['live', 'test']), region: z.string().nullable(), data: z.record(z.string(), z.unknown()) }).openapi('Event');
const webhookSchema = z.object({ id: z.string(), url: z.string(), description: z.string(), eventTypes: z.array(z.enum(eventTypes)), regions: z.array(z.string()).nullable(), paused: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).openapi('Webhook');
const webhookInput = z.object({ url: z.string().url().max(2048), description: z.string().max(500).default(''), eventTypes: z.array(z.enum(eventTypes)).min(1).max(10).default(['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed']), regions: z.array(z.string()).min(1).max(40).nullable().optional(), paused: z.boolean().default(false) }).openapi('CreateWebhook');
const webhookPatch = webhookInput.partial().extend({ description: z.string().max(500).optional(), eventTypes: z.array(z.enum(eventTypes)).min(1).max(10).optional(), paused: z.boolean().optional() }).openapi('UpdateWebhook');
const secretSchema = z.object({ secret: z.string() }).openapi('WebhookSecret');
const deliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), payload: eventSchema, synthetic: z.boolean(), status: z.enum(['pending', 'delivered', 'failed', 'paused']), attemptCount: z.number(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('WebhookDelivery');
const attemptSchema = z.object({ id: z.string(), deliveryId: z.string(), statusCode: z.number().nullable(), error: z.string().nullable(), durationMs: z.number(), createdAt: z.string() }).openapi('WebhookAttempt');
const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const domainSchema = z.object({ id: z.string(), name: z.string(), region: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), ready: z.boolean(), mailFromDomain: z.string().nullable(), mailFromStatus: z.string().nullable(), dnsStatus: z.enum(['available', 'unavailable']), dnsUnavailableReason: z.string().nullable(), dns: z.array(z.object({ name: z.string(), type: z.enum(['CNAME', 'TXT', 'MX']), value: z.string(), priority: z.number().optional() })) }).openapi('DomainReadiness');
const accountSchema = z.object({ region: z.string(), productionAccess: z.boolean(), sendingEnabled: z.boolean(), enforcementStatus: z.string(), quota: z.object({ max24HourSend: z.number(), maxSendRate: z.number(), sentLast24Hours: z.number() }) }).openapi('SesAccount');
const settingsSchema = z.object({ name: z.string(), environment: z.enum(['live', 'test']) }).openapi('WorkspaceSettings');
const queuedSchema = z.object({ id: z.string(), status: z.literal('pending') }).openapi('QueuedWebhookDelivery');
const deletedSchema = z.object({ deleted: z.boolean() }).openapi('WebhookDeleted');
const regionQuery = z.object({ region: z.string().optional() }).openapi('RegionQuery');
const listSchema = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
function external(a: Actor) { if (a.environment !== 'live') throw new ApiError(403, 'TEST_EXTERNAL_OPERATION', 'Test keys cannot access or modify live SES resources.'); }
function workspaceActor(c: Ctx, permission: Permission = 'read') { const a = actor(c, permission); if (a.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Workspace-wide operations require a key without domain restrictions.'); return a; }
function allowedDomain(a: Actor, name: string) { if (!senderDomainAllowed(a.domains, name)) throw new ApiError(403, 'DOMAIN_NOT_ALLOWED', 'The API key is not authorized for this domain or its parent domain.'); }
async function sesCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof ApiError) throw error;
    const provider = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const name = provider?.name ?? '', status = provider?.$metadata?.httpStatusCode;
    if (status === 403 || /AccessDenied|Unauthorized|InvalidClientTokenId|UnrecognizedClient|ExpiredToken/.test(name)) throw new ApiError(403, 'SES_ACCESS_DENIED', 'AWS denied the SES operation. Check deployment credentials and IAM permissions.');
    if (status === 429 || /TooManyRequests|Throttl|LimitExceeded/.test(name)) throw new ApiError(429, 'SES_RATE_LIMITED', 'The SES control-plane quota was exceeded. Retry after a short delay.', undefined, true);
    if (status === 404 || name === 'NotFoundException') throw new ApiError(404, 'SES_IDENTITY_NOT_FOUND', 'The requested identity does not exist in this SES region.');
    if (status === 409 || name === 'AlreadyExistsException') throw new ApiError(409, 'SES_IDENTITY_EXISTS', 'The identity already exists in this SES region.');
    if (status === 400 || name === 'BadRequestException') throw new ApiError(422, 'SES_INVALID_REQUEST', 'SES rejected the operation. Check the identity, region, and account configuration.');
    throw new ApiError(503, 'SES_UNAVAILABLE', 'SES could not complete the operation. Check service availability and deployment connectivity.', undefined, true);
  }
}
function metadata(row: typeof webhooks.$inferSelect) { const { encryptedSecret: _, workspaceId: _w, environment: _e, ...value } = row; return value; }

// Only administrator-controlled public DNS names belong in this exact-match allowlist.
// It is the trust boundary against DNS rebinding: untrusted tenants cannot add hosts.
function webhookUrl(runtime: Runtime, value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'A public HTTPS webhook URL is required.', 'url'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal|invalid|test|home|lan|arpa)$/.test(host) || host.endsWith('.')) throw new ApiError(422, 'INVALID_WEBHOOK_URL', 'Webhook endpoints must use public HTTPS DNS names without credentials, fragments or custom ports.', 'url');
  if (!runtime.config.webhookAllowedHosts.map(h => h.toLowerCase()).includes(host)) throw new ApiError(422, 'WEBHOOK_HOST_NOT_ALLOWED', 'The endpoint hostname must be in the deployment administrator’s trusted webhook allowlist.', 'url');
  return url.toString();
}
async function encryptionKey(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'A 32-byte hexadecimal encryption key is required.');
  const bytes = unhex(value);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 16), key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], h => parseInt(h, 16));
async function encrypt(runtime: Pick<Runtime, 'config'>, secret: string, binding: string) {
  const current = await encryptionKey(runtime.config.encryptionKey), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, current.key, new TextEncoder().encode(secret));
  return `v1.${current.id}.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
async function decrypt(runtime: Pick<Runtime, 'config'>, ciphertext: string, binding: string) {
  const parts = ciphertext.split('.'), versioned = parts.length === 4 && parts[0] === 'v1';
  const [iv, value] = versioned ? parts.slice(2) : parts;
  const rotationRequired = () => new ApiError(503, 'KEY_ROTATION_REQUIRED', 'The webhook secret cannot be decrypted with configured keys. Restore its encryption key or rotate the webhook secret.');
  if ((!versioned && parts.length !== 2) || !/^[a-f0-9]{24}$/i.test(iv ?? '') || !/^(?:[a-f0-9]{2}){16,}$/i.test(value ?? '')) throw rotationRequired();
  const keys = [await encryptionKey(runtime.config.encryptionKey)];
  if (runtime.config.previousEncryptionKey) keys.push(await encryptionKey(runtime.config.previousEncryptionKey));
  for (const candidate of keys) {
    if (versioned && candidate.id !== parts[1]) continue;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv!), additionalData: new TextEncoder().encode(binding) }, candidate.key, unhex(value!))); } catch { /* Legacy envelopes may belong to the previous key. */ }
  }
  throw rotationRequired();
}
function webhookSecret() { return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`; }
async function hmac(secret: string, value: string) { const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64'); if (!secret.startsWith('whsec_') || bytes.length !== 32) throw new ApiError(503, 'WEBHOOK_SECRET_ROTATION_REQUIRED', 'Rotate this endpoint secret to enable Standard Webhooks signatures.'); const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))).toString('base64'); }
const secretBinding = (a: Pick<Actor, 'workspaceId' | 'environment'>, webhookId: string) => `${a.workspaceId}:${a.environment}:${webhookId}`;

// Installer-only, resumable rewrapping; no webhook signing secret is rotated or returned.
// Decryption failure aborts, leaving earlier successful updates safe to skip on rerun.
export async function reencryptWebhookSecrets(db: Database, config: Config): Promise<{ scanned: number; reencrypted: number; skipped: number; conflicted: number }> {
  const runtime = { config }, current = await encryptionKey(config.encryptionKey);
  const counts = { scanned: 0, reencrypted: 0, skipped: 0, conflicted: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.select({ id: webhooks.id, workspaceId: webhooks.workspaceId, environment: webhooks.environment, encryptedSecret: webhooks.encryptedSecret }).from(webhooks).where(and(eq(webhooks.workspaceId, config.workspaceId), inArray(webhooks.environment, ['live', 'test']), cursor ? lt(webhooks.id, cursor) : undefined)).orderBy(desc(webhooks.id)).limit(100);
    if (!rows.length) return counts;
    for (const row of rows) {
      counts.scanned++;
      const parts = row.encryptedSecret.split('.');
      if (parts.length === 4 && parts[0] === 'v1' && parts[1] === current.id && /^[a-f0-9]{24}$/i.test(parts[2]!) && /^(?:[a-f0-9]{2}){16,}$/i.test(parts[3]!)) { counts.skipped++; continue; }
      const binding = secretBinding(row, row.id);
      const encryptedSecret = await encrypt(runtime, await decrypt(runtime, row.encryptedSecret, binding), binding);
      // Concurrent deletion or secret rotation must never be overwritten by this scan.
      const updated = await db.update(webhooks).set({ encryptedSecret, updatedAt: now() }).where(and(eq(webhooks.id, row.id), scoped(webhooks, row), eq(webhooks.encryptedSecret, row.encryptedSecret))).returning({ id: webhooks.id });
      if (updated.length) counts.reencrypted++; else counts.conflicted++;
    }
    cursor = rows[rows.length - 1]!.id;
    if (rows.length < 100) return counts;
  }
}

function visibleDelivery(row: typeof deliveries.$inferSelect, a: Actor) {
  return a.permissions.includes('manage') ? row : { ...row, payload: { ...row.payload, data: redactCapabilityData(row.payload.data) } };
}

export async function publishEvent(runtime: Runtime, event: PublishedEvent, wake = true): Promise<void> {
  if (!eventTypes.includes(event.type)) throw new ApiError(422, 'INVALID_EVENT_TYPE', 'Unknown webhook event type.');
  const readyJobs = await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(event).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return 0;
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, event), eq(webhooks.paused, false)));
    let count = 0;
    for (const endpoint of endpoints) {
      if (!endpoint.eventTypes.includes(event.type) || (endpoint.regions && event.region !== null && !endpoint.regions.includes(event.region))) continue;
      // Simulated emails must never enter a live-configured endpoint, even if a caller supplied a wrong mode.
      if (event.environment === 'live' && event.data.simulated === true) continue;
      const deliveryId = id('whd');
      await tx.insert(deliveries).values({ id: deliveryId, workspaceId: event.workspaceId, environment: event.environment, webhookId: endpoint.id, eventId: event.id, payload: event });
      await enqueue(tx, { type: 'operation.webhook', workspaceId: event.workspaceId, environment: event.environment, payload: { deliveryId, generation: 0 } });
      count++;
    }
    return count;
  });
  if (wake && readyJobs > 0) try { await runtime.wake?.(readyJobs); } catch { log('warn', { eventId: event.id, code: 'QUEUE_WAKE_FAILED', message: 'The event is committed; the scheduler will recover pending deliveries.' }); }
}

export async function createUnsubscribeLink(runtime: Runtime, workspaceId: string, environment: Mode, email: string) {
  const token = randomSecret('u_');
  return { url: `${runtime.config.publicUrl.replace(/\/$/, '')}/unsubscribe/${token}`, record: { tokenHash: await digest(token), workspaceId, environment, email: email.trim().toLowerCase() } };
}
export async function unsubscribeUrl(runtime: Runtime, workspaceId: string, environment: Mode, email: string, db: DbExecutor = runtime.db): Promise<string> {
  const link = await createUnsubscribeLink(runtime, workspaceId, environment, email);
  await db.insert(unsubscribeTokens).values(link.record);
  return link.url;
}
async function domainReadiness(runtime: Runtime, row: typeof domains.$inferSelect, identity?: GetEmailIdentityCommandOutput) {
  const value = identity ?? await sesCall(() => getSes(runtime, row.region).send(new GetEmailIdentityCommand({ EmailIdentity: row.name })));
  const dkim = value.DkimAttributes, suffix = dkim?.SigningHostedZone;
  const dns: z.infer<typeof domainSchema>['dns'] = [];
  let dnsUnavailableReason: string | null = null;
  if (dkim?.SigningAttributesOrigin === 'EXTERNAL') dnsUnavailableReason = 'Bring-your-own DKIM records must be obtained from the identity owner.';
  else if (!suffix || !/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\.?$/.test(suffix) || !dkim?.Tokens?.length) dnsUnavailableReason = 'SES did not return an authoritative DKIM signing zone and tokens; DNS records are unavailable.';
  else dns.push(...dkim.Tokens.map(token => ({ name: `${token}._domainkey.${row.name}`, type: 'CNAME' as const, value: `${token}.${suffix}` })));
  const mailFrom = value.MailFromAttributes;
  if (mailFrom?.MailFromDomain) {
    if (/^(?:us-(?:east|west)|af-south|ap-(?:east|south|northeast|southeast)|ca-(?:central|west)|eu-(?:central|north|south|west)|il-central|me-(?:south|central)|mx-central|sa-east)-\d+$/.test(row.region)) {
      dns.push({ name: mailFrom.MailFromDomain, type: 'MX', value: `feedback-smtp.${row.region}.amazonses.com`, priority: 10 });
      dns.push({ name: mailFrom.MailFromDomain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' });
    } else dnsUnavailableReason = 'MAIL FROM DNS instructions are supported only for commercial AWS regions.';
  }
  return { id: row.id, name: row.name, region: row.region, verificationStatus: value.VerificationStatus ?? 'NOT_STARTED', verified: value.VerifiedForSendingStatus === true, dkimStatus: value.DkimAttributes?.Status ?? 'NOT_STARTED', ready: value.VerifiedForSendingStatus === true && value.DkimAttributes?.Status === 'SUCCESS' && value.DkimAttributes.SigningEnabled === true && (!mailFrom?.MailFromDomain || mailFrom.MailFromDomainStatus === 'SUCCESS'), mailFromDomain: mailFrom?.MailFromDomain ?? null, mailFromStatus: mailFrom?.MailFromDomainStatus ?? null, dnsStatus: dnsUnavailableReason ? 'unavailable' as const : 'available' as const, dnsUnavailableReason, dns };
}
async function account(runtime: Runtime, selectedRegion: string) { const a = await sesCall(() => getSes(runtime, selectedRegion).send(new GetAccountCommand({}))); return { region: selectedRegion, productionAccess: a.ProductionAccessEnabled === true, sendingEnabled: a.SendingEnabled === true, enforcementStatus: a.EnforcementStatus ?? 'UNKNOWN', quota: { max24HourSend: a.SendQuota?.Max24HourSend ?? 0, maxSendRate: a.SendQuota?.MaxSendRate ?? 0, sentLast24Hours: a.SendQuota?.SentLast24Hours ?? 0 } }; }
async function getWebhook(runtime: Runtime, a: Actor, webhookId: string) { const [row] = await runtime.db.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))); return row ?? notFound('Webhook'); }

export function registerOperations(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/workspace', operationId: 'getWorkspaceSettings', tags: ['Settings'], security, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c); const [row] = await c.env.db.select().from(workspaceSettings).where(scoped(workspaceSettings, a));
    return c.json({ name: row?.name ?? 'OpenSend', environment: a.environment }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/settings/workspace', operationId: 'updateWorkspaceSettings', tags: ['Settings'], security, request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).openapi('UpdateWorkspaceSettings')) }, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), { name } = c.req.valid('json');
    await c.env.db.insert(workspaceSettings).values({ workspaceId: a.workspaceId, environment: a.environment, name }).onConflictDoUpdate({ target: [workspaceSettings.workspaceId, workspaceSettings.environment], set: { name, updatedAt: now() } });
    return c.json({ name, environment: a.environment }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/ses', operationId: 'getSesSettings', tags: ['Settings'], security, request: { query: regionQuery }, responses: { 200: response(accountSchema), ...errors } }), async c => { const a = workspaceActor(c); external(a); return c.json(await account(c.env, c.req.valid('query').region ?? c.env.config.regions[0]!), 200); });
  app.openapi(createRoute({ method: 'get', path: '/v1/domains', operationId: 'listDomains', description: 'Refreshes at most 10 identities, sequentially with one second between SES reads. Use refresh=false for cached sender selection without AWS calls. Default page size is 5; use individual domain detail for a single live refresh. Concurrent refresh clients may still encounter account-level throttling.', tags: ['Domains'], security, request: { query: PageQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(5), region: z.string().optional(), refresh: z.enum(['true', 'false']).default('true') }).openapi('ListDomainsQuery') }, responses: { 200: response(listSchema(domainSchema, 'DomainPage')), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'); external(a); getSes(c.env, q.region ?? c.env.config.regions[0]!);
    const allowed = a.domains.length ? or(...a.domains.map(parent => or(eq(domains.name, parent), like(domains.name, `%.${parent}`)))) : undefined;
    const rows = await c.env.db.select().from(domains).where(and(scoped(domains, a), allowed, q.region ? eq(domains.region, region(c.env, q.region)) : inArray(domains.region, c.env.config.regions), q.cursor ? lt(domains.id, q.cursor) : undefined)).orderBy(desc(domains.id)).limit(q.limit + 1);
    if (q.refresh === 'false') {
      const reports = await c.env.db.select({ region: sesRegions.region, report: sesRegions.report }).from(sesRegions).where(eq(sesRegions.workspaceId, a.workspaceId));
      const data = rows.slice(0, q.limit).map(row => {
        const cached = reports.find(report => report.region === row.region)?.report?.domains.find(domain => domain.name === row.name);
        const ready = cached?.verificationStatus === 'SUCCESS' && cached.sendingEnabled === true;
        return { id: row.id, name: row.name, region: row.region, verificationStatus: cached?.verificationStatus ?? 'NOT_STARTED', verified: cached?.sendingEnabled === true, dkimStatus: ready ? 'SUCCESS' : 'NOT_STARTED', ready, mailFromDomain: null, mailFromStatus: null, dnsStatus: 'unavailable' as const, dnsUnavailableReason: 'Open the domain to refresh DNS details.', dns: [] };
      });
      return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
    }
    const data: z.infer<typeof domainSchema>[] = [];
    for (const row of rows.slice(0, q.limit)) { if (data.length) await new Promise(resolve => setTimeout(resolve, 1000)); data.push(await domainReadiness(c.env, row)); }
    return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains', operationId: 'createDomain', tags: ['Domains'], security, request: { body: json(z.object({ name: domainName, region: z.string() }).openapi('CreateDomain')) }, responses: { 201: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, 'manage'); external(a); const body = c.req.valid('json'); allowedDomain(a, body.name);
    const client = getSes(c.env, body.region); let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity = await sesCall(() => client.send(new GetEmailIdentityCommand({ EmailIdentity: body.name }))); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SES_IDENTITY_NOT_FOUND') throw error;
      try { await sesCall(() => client.send(new CreateEmailIdentityCommand({ EmailIdentity: body.name, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } }))); }
      catch (createError) { if (!(createError instanceof ApiError) || createError.code !== 'SES_IDENTITY_EXISTS') throw createError; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // Existing SES identities are adopted without changing verification or DKIM configuration.
    const [row] = await c.env.db.insert(domains).values({ id: id('dom'), workspaceId: a.workspaceId, environment: a.environment, ...body }).onConflictDoUpdate({ target: [domains.workspaceId, domains.environment, domains.name, domains.region], set: { updatedAt: now() } }).returning();
    return c.json(await domainReadiness(c.env, row!, identity), 201);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains/{id}/mail-from', operationId: 'configureDomainMailFrom', tags: ['Domains'], security, description: 'Configure a custom SES MAIL FROM subdomain with fallback to the default amazonses.com MAIL FROM value while DNS is unavailable.', request: { params: IdParams, body: json(z.object({ mailFromDomain: domainName }).strict().openapi('ConfigureDomainMailFrom')) }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, 'manage'); external(a); const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id)));
    if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    const { mailFromDomain } = c.req.valid('json');
    if (mailFromDomain === row.name || !mailFromDomain.endsWith(`.${row.name}`)) throw new ApiError(422, 'MAIL_FROM_DOMAIN_INVALID', `Use a subdomain of ${row.name}.`, 'mailFromDomain');
    await sesCall(() => getSes(c.env, row.region).send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: row.name, MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' })));
    return c.json(await domainReadiness(c.env, row), 200);
  });
  for (const verifyRoute of [false, true]) app.openapi(createRoute({ method: verifyRoute ? 'post' : 'get', path: verifyRoute ? '/v1/domains/{id}/verify' : '/v1/domains/{id}', operationId: verifyRoute ? 'verifyDomain' : 'getDomain', tags: ['Domains'], security, request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, verifyRoute ? 'manage' : 'read'); external(a); const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id))); if (!row) return notFound('Domain'); allowedDomain(a, row.name); return c.json(await domainReadiness(c.env, row), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks', operationId: 'listWebhooks', tags: ['Webhooks'], security, request: { query: PageQuery }, responses: { 200: response(listSchema(webhookSchema, 'WebhookPage')), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'); const rows = await c.env.db.select().from(webhooks).where(and(scoped(webhooks, a), q.cursor ? lt(webhooks.id, q.cursor) : undefined)).orderBy(desc(webhooks.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(metadata), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks', operationId: 'createWebhook', tags: ['Webhooks'], security, request: { body: json(webhookInput) }, responses: { 201: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), body = c.req.valid('json'), webhookId = id('wh'); const url = webhookUrl(c.env, body.url); body.regions?.forEach(r => region(c.env, r));
    const [row] = await c.env.db.insert(webhooks).values({ ...body, id: webhookId, workspaceId: a.workspaceId, environment: a.environment, url, regions: body.regions ?? null, encryptedSecret: await encrypt(c.env, webhookSecret(), secretBinding(a, webhookId)) }).returning();
    return c.json(metadata(row!), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}', operationId: 'getWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(webhookSchema), ...errors } }), async c => c.json(metadata(await getWebhook(c.env, workspaceActor(c), c.req.valid('param').id)), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/webhooks/{id}', operationId: 'updateWebhook', tags: ['Webhooks'], security, request: { params: IdParams, body: json(webhookPatch) }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), current = await getWebhook(c.env, a, c.req.valid('param').id), body = c.req.valid('json'); if (body.url) body.url = webhookUrl(c.env, body.url); body.regions?.forEach(r => region(c.env, r));
    const row = await c.env.db.transaction(async tx => {
      const [locked] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).for('update'); if (!locked) return notFound('Webhook');
      const [updated] = await tx.update(webhooks).set({ ...body, updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).returning();
      if (locked.paused && body.paused === false) {
        const paused = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, current.id), eq(deliveries.status, 'paused'))).for('update');
        for (const delivery of paused) {
          const generation = delivery.generation + 1;
          await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(and(scoped(deliveries, a), eq(deliveries.id, delivery.id)));
          await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, environment: a.environment, payload: { deliveryId: delivery.id, generation } });
        }
      }
      return updated!;
    }); return c.json(metadata(row), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/webhooks/{id}', operationId: 'deleteWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(deletedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), row = await getWebhook(c.env, a, c.req.valid('param').id); await c.env.db.delete(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, row.id))); return c.json({ deleted: true }, 200);
  });
  for (const rotate of [false, true]) app.openapi(createRoute({ method: rotate ? 'post' : 'get', path: rotate ? '/v1/webhooks/{id}/rotate-secret' : '/v1/webhooks/{id}/secret', operationId: rotate ? 'rotateWebhookSecret' : 'revealWebhookSecret', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(secretSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), row = await getWebhook(c.env, a, c.req.valid('param').id), binding = secretBinding(a, row.id); c.header('Cache-Control', 'no-store');
    const secret = rotate ? webhookSecret() : await decrypt(c.env, row.encryptedSecret, binding);
    if (rotate) await c.env.db.update(webhooks).set({ encryptedSecret: await encrypt(c.env, secret, binding), updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, row.id)));
    return c.json({ secret }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/test', operationId: 'testWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), endpoint = await getWebhook(c.env, a, c.req.valid('param').id); webhookUrl(c.env, endpoint.url);
    const deliveryId = id('whd'), event: PublishedEvent = { id: id('evt_test'), type: 'email.delivered', createdAt: now(), workspaceId: a.workspaceId, environment: a.environment, region: null, data: { synthetic: true, test: true, message: 'Explicit webhook endpoint test. No email was sent.' } };
    await c.env.db.transaction(async tx => { await tx.insert(deliveries).values({ id: deliveryId, workspaceId: a.workspaceId, environment: a.environment, webhookId: endpoint.id, eventId: event.id, payload: event, synthetic: true }); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, environment: a.environment, payload: { deliveryId, generation: 0 } }); });
    return c.json({ id: deliveryId, status: 'pending' as const }, 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tags: ['Webhooks'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(listSchema(deliverySchema, 'WebhookDeliveryPage')), ...errors } }), async c => {
    const a = workspaceActor(c), endpoint = await getWebhook(c.env, a, c.req.valid('param').id), q = c.req.valid('query'); const rows = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, endpoint.id), q.cursor ? lt(deliveries.id, q.cursor) : undefined)).orderBy(desc(deliveries.id)).limit(q.limit + 1); return c.json({ data: rows.slice(0, q.limit).map(row => visibleDelivery(row, a)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  const deliveryParams = z.object({ id: z.string(), deliveryId: z.string() }).openapi('WebhookDeliveryParams');
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries/{deliveryId}', operationId: 'getWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 200: response(deliverySchema.extend({ attempts: z.array(attemptSchema) }).openapi('WebhookDeliveryDetail')), ...errors } }), async c => {
    const a = workspaceActor(c), p = c.req.valid('param'); const [row] = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))); if (!row) return notFound('Delivery'); const attempts = await c.env.db.select().from(deliveryAttempts).where(and(scoped(deliveryAttempts, a), eq(deliveryAttempts.deliveryId, row.id))).orderBy(asc(deliveryAttempts.createdAt)); return c.json({ ...visibleDelivery(row, a), attempts }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', operationId: 'retryWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), p = c.req.valid('param'); await getWebhook(c.env, a, p.id);
    await c.env.db.transaction(async tx => {
      const [row] = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))).for('update'); if (!row) return notFound('Delivery');
      if (row.status === 'pending') throw new ApiError(409, 'DELIVERY_PENDING', 'This delivery already has a pending attempt.');
      const generation = row.generation + 1; await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(eq(deliveries.id, row.id)); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, environment: a.environment, payload: { deliveryId: row.id, generation } });
    });
    return c.json({ id: p.deliveryId, status: 'pending' as const }, 202);
  });
  registerPublicEvents(app);
  registerMetrics(app);
}

const snsSchema = z.object({ Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']), MessageId: z.string().min(1).max(200), TopicArn: z.string().min(1).max(300), Message: z.string().max(262144), Timestamp: z.string().datetime(), SignatureVersion: z.enum(['1', '2']), Signature: z.string().min(1).max(4096), SigningCertURL: z.string().url().max(2048), Subject: z.string().max(1000).optional(), SubscribeURL: z.string().url().max(4096).optional(), Token: z.string().max(4096).optional() }).openapi('SnsSignedEnvelope');
type SnsEnvelope = z.infer<typeof snsSchema>;
function snsHost(runtime: Runtime, envelope: SnsEnvelope) {
  if (!runtime.config.snsTopicArns.includes(envelope.TopicArn)) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'The SNS topic is not configured for this deployment.');
  const match = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]+$/.exec(envelope.TopicArn);
  if (!match) throw new ApiError(403, 'SNS_TOPIC_NOT_ALLOWED', 'Only registered standard AWS regional SNS topics are supported.');
  return { host: `sns.${match[1]}.amazonaws.com`, region: match[1]! };
}
function trustedSnsUrl(value: string, host: string, certificate: boolean) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash || (certificate ? !/^\/SimpleNotificationService-[a-zA-Z0-9_-]+\.pem$/.test(url.pathname) || Boolean(url.search) : url.pathname !== '/')) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS certificate or subscription URL is not trusted.');
  return url;
}
// Cache only completed, public certificate values; never share an in-flight fetch between Worker requests.
const snsCertificates = new Map<string, { cert: X509Certificate; expiresAt: number }>();
async function verifySns(runtime: Runtime, envelope: SnsEnvelope) {
  const trusted = snsHost(runtime, envelope);
  const url = trustedSnsUrl(envelope.SigningCertURL, trusted.host, true);
  const signature = Buffer.from(envelope.Signature, 'base64');
  if (signature.length < 256 || signature.length > 1024 || signature.toString('base64') !== envelope.Signature) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature encoding or length is invalid.');
  const fields = envelope.Type === 'Notification' ? ['Message', 'MessageId', ...(envelope.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const values = envelope as Record<string, unknown>;
  if (fields.some(field => typeof values[field] !== 'string')) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Required signed SNS fields are missing.');
  const cached = snsCertificates.get(url.href);
  let cert = cached && cached.expiresAt > Date.now() ? cached.cert : undefined;
  if (!cert) {
    // Certificate bytes come only from the allowlisted AWS HTTPS origin, protected by TLS PKI.
    // Workers require manual redirects; every non-2xx response below fails closed.
    let res: Response;
    try { res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); } catch (error) { log('warn', { code: 'SNS_CERTIFICATE_FETCH_FAILED', errorType: error instanceof Error ? error.name : 'Unknown', stack: error instanceof Error ? error.stack?.split('\n').slice(1, 7).join('\n') : undefined }); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true); }
    if (!res.ok) { log('warn', { code: 'SNS_CERTIFICATE_FETCH_FAILED', status: res.status }); await res.body?.cancel(); throw new ApiError(503, 'SNS_CERTIFICATE_UNAVAILABLE', 'The SNS signing certificate could not be retrieved.', undefined, true); }
    const pem = await res.text(); if (pem.length > 16384) throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.');
    try { cert = new X509Certificate(pem); } catch { throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is invalid.'); }
  }
  if (Date.now() < Date.parse(cert.validFrom) || Date.now() > Date.parse(cert.validTo) || cert.publicKey.asymmetricKeyType !== 'rsa') throw new ApiError(403, 'SNS_INVALID_CERTIFICATE', 'The SNS signing certificate is expired or invalid.');
  if (!cached || cached.expiresAt <= Date.now()) {
    if (snsCertificates.size >= 8) snsCertificates.delete(snsCertificates.keys().next().value!);
    snsCertificates.set(url.href, { cert, expiresAt: Math.min(Date.now() + 300000, Date.parse(cert.validTo)) });
  }
  const canonical = fields.map(field => `${field}\n${values[field]}\n`).join('');
  if (!verify(envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1', Buffer.from(canonical), cert.publicKey, signature)) throw new ApiError(403, 'SNS_INVALID_SIGNATURE', 'SNS signature verification failed.');
  return trusted;
}
function verifySesAccount(runtime: Runtime, message: unknown) {
  const accountId = (message as { mail?: { sendingAccountId?: unknown } } | null)?.mail?.sendingAccountId;
  // SNS topics can receive cross-account SES events; only an explicit SES account binding is authoritative.
  if (runtime.config.awsAccountId && accountId !== runtime.config.awsAccountId) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'The SES sending account is missing or does not match this deployment.');
}
function registerPublicEvents(app: App) {
  app.use('/v1/events/ses', async (c, next) => {
    // SNS sends JSON envelopes as text/plain. Normalize only the media type before
    // OpenAPI's required JSON validator; preserve the signed envelope bytes.
    if (c.req.method === 'POST' && c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain') {
      const headers = new Headers(c.req.raw.headers);
      headers.set('content-type', 'application/json');
      c.req.raw = new Request(c.req.raw, { headers });
    }
    await next();
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/events/ses', operationId: 'receiveSesSnsEvent', tags: ['Events'], security: [], request: { body: { required: true, content: { 'application/json': { schema: snsSchema }, 'text/plain': { schema: z.string().openapi('SnsPlainTextEnvelope') } } } }, responses: { 202: response(z.object({ accepted: z.boolean() }).openapi('SnsAccepted')), ...errors } }), async c => {
    let raw: unknown; try { raw = JSON.parse(await c.req.text()); } catch { throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected an SNS JSON envelope.'); }
    const parsed = snsSchema.safeParse(raw); if (!parsed.success) throw new ApiError(400, 'SNS_INVALID_ENVELOPE', 'Expected a complete signed SNS envelope.');
    const envelope = parsed.data; const trusted = await verifySns(c.env, envelope);
    if (envelope.Type !== 'Notification') {
      if (envelope.Type === 'SubscriptionConfirmation') {
        const url = trustedSnsUrl(envelope.SubscribeURL!, trusted.host, false);
        if (url.searchParams.get('Action') !== 'ConfirmSubscription' || url.searchParams.get('TopicArn') !== envelope.TopicArn || url.searchParams.get('Token') !== envelope.Token || [...url.searchParams.keys()].some(k => !['Action', 'TopicArn', 'Token'].includes(k))) throw new ApiError(403, 'SNS_UNTRUSTED_URL', 'SNS confirmation URL fields do not match the signed envelope.');
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); await res.body?.cancel(); if (!res.ok) throw new ApiError(503, 'SNS_CONFIRMATION_FAILED', 'SNS subscription confirmation failed.', undefined, true);
      }
      // An authenticated UnsubscribeConfirmation is acknowledged, never automatically resubscribed.
      return c.json({ accepted: true }, 202);
    }
    let message: unknown; try { message = JSON.parse(envelope.Message); } catch { throw new ApiError(400, 'SES_INVALID_EVENT', 'SNS Message must contain a SES JSON event.'); }
    verifySesAccount(c.env, message);
    await c.env.db.transaction(async tx => {
      const inserted = await tx.insert(snsReceipts).values({ topicArn: envelope.TopicArn, messageId: envelope.MessageId, workspaceId: c.env.config.workspaceId, environment: 'live' }).onConflictDoNothing().returning(); if (!inserted.length) return;
      await enqueue(tx, { type: 'operation.ses', workspaceId: c.env.config.workspaceId, environment: 'live', payload: { message, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region } });
    });
    return c.json({ accepted: true }, 202);
  });
  // Hono matches HEAD as GET; intercept the original method before the mutating GET route.
  app.use('/unsubscribe/:token', async (c, next) => {
    if (c.req.method === 'HEAD') { c.header('Allow', 'GET, POST'); c.header('Cache-Control', 'no-store'); throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST to unsubscribe.'); }
    await next();
  });
  const tokenParams = z.object({ token: z.string().regex(/^u_[a-f0-9]{64}$/) }).openapi('UnsubscribeToken');
  for (const method of ['get', 'post'] as const) app.openapi(createRoute({ method, path: '/unsubscribe/{token}', operationId: method === 'get' ? 'unsubscribeByLink' : 'unsubscribeOneClick', tags: ['Consent'], security: [], request: { params: tokenParams }, responses: { 200: { description: 'Marketing consent is now unsubscribed.', content: { 'text/html': { schema: z.string().openapi('UnsubscribeConfirmationHtml') } } }, ...errors } }), async c => {
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const [token] = await c.env.db.select().from(unsubscribeTokens).where(eq(unsubscribeTokens.tokenHash, await digest(c.req.valid('param').token))); if (!token) return notFound('Unsubscribe link');
    // The audience helper commits consent, audit, and the subscription event outbox atomically.
    await recordUnsubscribe(c.env, token.workspaceId, token.environment, token.email, method === 'get' ? 'footer-get' : 'rfc8058-post');
    return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title><style>@font-face{font-family:Inter;src:url("/fonts/inter-variable.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}body,body *{letter-spacing:-0.01em}</style><body style="font-family:Inter,Arial,sans-serif;letter-spacing:-0.01em;margin:48px;line-height:1.5"><main><h1 style="font-size:24px">You’re unsubscribed</h1><p>You will no longer receive marketing emails from this workspace.</p></main></body></html>', 200);
  });
}

function registerMetrics(app: App) {
  const query = z.object({ region: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), stream: z.enum(['transactional', 'marketing']).optional(), granularity: z.enum(['day', 'hour']).default('day') }).openapi('MetricsQuery');
  const bucket = z.object({ date: z.string(), count: z.number(), sent: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number() });
  const schema = z.object({ basis: z.literal('created-cohort'), from: z.string(), to: z.string(), region: z.string().nullable(), stream: z.string().nullable(), totals: z.object({ emails: z.number(), accepted: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number(), opened: z.number(), clicked: z.number(), failed: z.number(), deliveryDelayed: z.number(), simulated: z.number() }), daily: z.array(bucket), hourly: z.array(bucket).optional() }).openapi('Metrics');
  app.openapi(createRoute({ method: 'get', path: '/v1/metrics', operationId: 'getMetrics', description: 'Operational created-cohort metrics, not invoicing or provider reputation. Selects emails created in [from,to), scoped by email region and stream. Outcomes use current email state and all recorded events, including events after to; this is not a historical state snapshot. Each outcome counts distinct emails, so replays do not inflate counts and outcomes may overlap. Accepted (bucket sent) means evidence of provider acceptance, not merely queued/created. Daily UTC creation buckets contain count=created emails. Granularity defaults to day; granularity=hour additionally returns hourly UTC creation buckets with canonical ISO dates such as 2026-09-12T01:00:00.000Z, while preserving daily buckets and totals. Absent buckets mean zero created emails and zero outcomes; no moving averages are applied. Engagement is observed, not verified human activity.', tags: ['Metrics'], security, request: { query }, responses: { 200: response(schema), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'), end = q.to ?? now(), start = q.from ?? new Date(Date.parse(end) - 30 * 86400000).toISOString(); if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new ApiError(422, 'INVALID_DATE_RANGE', 'Metrics require an increasing range of at most 366 days.'); if (q.region) region(c.env, q.region);
    const filter = and(scoped(emails, a), gte(emails.createdAt, start), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined, q.stream ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
    const distinct = (condition: SQL) => sql<number>`count(DISTINCT ${emails.id}) FILTER (WHERE ${condition})::int`;
    const outcome = (status: string, type: EventType) => distinct(sql`${emails.status} = ${status} OR ${events.type} = ${type}`);
    const date = q.granularity === 'hour' ? sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"')` : sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    // ROLLUP computes the total and at most 367 daily or 8785 hourly aggregates in one snapshot.
    // The scoped left join retains queued emails and limits all events to this cohort.
    const rows = await c.env.db.select({ date, emails: sql<number>`count(DISTINCT ${emails.id})::int`, accepted: distinct(sql`NOT ${emails.simulated} AND (${emails.providerId} IS NOT NULL OR ${emails.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${events.type} IN ('email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.delivery_delayed'))`), delivered: outcome('delivered', 'email.delivered'), bounced: outcome('bounced', 'email.bounced'), complained: outcome('complained', 'email.complained'), opened: distinct(sql`${events.type} = 'email.opened'`), clicked: distinct(sql`${events.type} = 'email.clicked'`), failed: distinct(sql`${emails.status} IN ('rejected', 'rendering_failed') OR ${events.type} IN ('email.rejected', 'email.rendering_failed')`), deliveryDelayed: outcome('delayed', 'email.delivery_delayed'), simulated: distinct(sql`${emails.simulated}`) }).from(emails).leftJoin(events, and(eq(emails.id, sql`${events.data}->>'emailId'`), eq(emails.workspaceId, events.workspaceId), eq(emails.environment, events.environment), scoped(events, a))).where(filter).groupBy(sql`ROLLUP (${date})`).orderBy(date);
    const { date: _date, ...totals } = rows.find(row => row.date === null)!;
    const buckets = rows.filter(row => row.date !== null).map(row => ({ date: row.date!, count: row.emails, sent: row.accepted, delivered: row.delivered, bounced: row.bounced, complained: row.complained }));
    let daily = buckets;
    if (q.granularity === 'hour') {
      const days = new Map<string, z.infer<typeof bucket>>();
      // Every email belongs to one creation hour, so its outcome counts remain additive by day.
      for (const row of buckets) {
        const date = row.date.slice(0, 10), day = days.get(date);
        if (day) for (const key of ['count', 'sent', 'delivered', 'bounced', 'complained'] as const) day[key] += row[key];
        else days.set(date, { ...row, date });
      }
      daily = [...days.values()];
    }
    return c.json({ basis: 'created-cohort' as const, from: start, to: end, region: q.region ?? null, stream: q.stream ?? null, totals, daily, ...(q.granularity === 'hour' ? { hourly: buckets } : {}) }, 200);
  });
}

const webhookJob: JobHandler = async (runtime, payload, job) => {
  const [delivery] = await runtime.db.select().from(deliveries).where(and(scoped(deliveries, job), eq(deliveries.id, String(payload.deliveryId))));
  if (!delivery || delivery.generation !== payload.generation || delivery.status === 'delivered') return;
  const [endpoint] = await runtime.db.select().from(webhooks).where(and(scoped(webhooks, job), eq(webhooks.id, delivery.webhookId)));
  const where = and(scoped(deliveries, job), eq(deliveries.id, delivery.id), eq(deliveries.generation, delivery.generation));
  if (!endpoint) { await runtime.db.update(deliveries).set({ status: 'failed', lastError: 'ENDPOINT_DELETED', updatedAt: now() }).where(where); return; }
  if (endpoint.paused && !delivery.synthetic) {
    const stopped = await runtime.db.transaction(async tx => {
      const [locked] = await tx.select().from(webhooks).where(and(scoped(webhooks, job), eq(webhooks.id, endpoint.id))).for('update');
      if (locked && !locked.paused) return false;
      await tx.update(deliveries).set({ status: locked ? 'paused' : 'failed', lastError: locked ? 'ENDPOINT_PAUSED' : 'ENDPOINT_DELETED', updatedAt: now() }).where(where); return true;
    }); if (stopped) return;
  }
  const start = Date.now(); let statusCode: number | null = null, error: string | null = null, retryable = true;
  try {
    if (delivery.payload.environment !== job.environment || (job.environment === 'live' && !delivery.synthetic && delivery.payload.data.simulated === true)) throw new ApiError(403, 'WEBHOOK_ENVIRONMENT_MISMATCH', 'Test events cannot be delivered to live endpoints.');
    const url = webhookUrl(runtime, endpoint.url), secret = await decrypt(runtime, endpoint.encryptedSecret, secretBinding(job, endpoint.id));
    const body = JSON.stringify(delivery.payload), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmac(secret, `${delivery.eventId}.${timestamp}.${body}`);
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Id': delivery.eventId, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': 'OpenSend-Webhooks/1.0', ...(delivery.synthetic ? { 'OpenSend-Test': 'true' } : {}) }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    statusCode = result.status; await result.body?.cancel(); if (!result.ok) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < MAX_ATTEMPTS;
  await runtime.db.transaction(async tx => {
    await tx.insert(deliveryAttempts).values({ id: id('wha'), workspaceId: job.workspaceId, environment: job.environment, deliveryId: delivery.id, statusCode, error, durationMs: Date.now() - start });
    await tx.update(deliveries).set({ attemptCount: sql`${deliveries.attemptCount} + 1`, status: !error ? 'delivered' : retry ? 'pending' : 'failed', lastStatusCode: statusCode, lastError: error, updatedAt: now() }).where(where);
  });
  if (error) throw new ApiError(503, error, 'Webhook delivery failed; inspect the stored delivery attempts.', undefined, retry);
};

const processSesReceipt: JobHandler = async (runtime, payload, job) => {
  const receiptWhere = and(scoped(snsReceipts, job), eq(snsReceipts.topicArn, String(payload.topicArn)), eq(snsReceipts.messageId, String(payload.messageId)));
  const [receipt] = await runtime.db.select().from(snsReceipts).where(receiptWhere); if (!receipt || receipt.processedAt) return;
  const data = payload.message as Record<string, any>; const providerId = data?.mail?.messageId;
  if (typeof providerId !== 'string') throw new ApiError(422, 'SES_INVALID_EVENT', 'SES event lacks a mail.messageId.');
  const [email] = await runtime.db.select().from(emails).where(and(scoped(emails, job), eq(emails.region, String(payload.region)), eq(emails.providerId, providerId)));
  if (!email) throw new ApiError(409, 'SES_EMAIL_NOT_FOUND', 'The SES message is not yet associated with a local email.', undefined, true);
  if (email.simulated !== (job.environment === 'test')) throw new ApiError(403, 'SES_ENVIRONMENT_MISMATCH', 'Feedback and email simulation modes must match.');
  const kind = String(data.eventType ?? data.notificationType).replace('Rendering Failure', 'RenderingFailure');
  if (kind === 'Subscription') {
    const preferences = data.subscription?.newTopicPreferences;
    // SES topic defaults are not evidence of app-wide opt-in; never reverse local opt-outs from them.
    if (preferences?.unsubscribeAll === true && email.to.length === 1 && !email.cc.length && !email.bcc.length) {
      await recordUnsubscribe(runtime, job.workspaceId, job.environment, email.to[0]!, 'ses-subscription');
    } else {
      await publishEvent(runtime, { id: `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`, type: 'contact.subscription_changed', createdAt: receipt.createdAt, workspaceId: job.workspaceId, environment: job.environment, region: email.region, data: { emailId: email.id, source: 'ses', preferences: preferences ?? null, appliedToWorkspaceConsent: false } });
    }
    await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere); return;
  }
  const mapping: Record<string, { type: EventType; rawType: string }> = { Send: { type: 'email.sent', rawType: 'send' }, Delivery: { type: 'email.delivered', rawType: 'delivery' }, Bounce: { type: 'email.bounced', rawType: 'bounce' }, Complaint: { type: 'email.complained', rawType: 'complaint' }, DeliveryDelay: { type: 'email.delivery_delayed', rawType: 'delivery_delay' }, Reject: { type: 'email.rejected', rawType: 'reject' }, RenderingFailure: { type: 'email.rendering_failed', rawType: 'rendering_failure' }, Open: { type: 'email.opened', rawType: 'open' }, Click: { type: 'email.clicked', rawType: 'click' } };
  const mapped = mapping[kind]; if (!mapped) throw new ApiError(422, 'SES_UNSUPPORTED_EVENT', 'Unsupported SES event type.');
  const eventDetail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const eventTime = typeof eventDetail.timestamp === 'string' && Number.isFinite(Date.parse(eventDetail.timestamp)) ? new Date(eventDetail.timestamp).toISOString() : receipt.createdAt;
  const eventId = `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`;
  const normalized: PublishedEvent = { id: eventId, workspaceId: job.workspaceId, environment: job.environment, region: email.region, type: mapped.type, createdAt: eventTime, data: { emailId: email.id, providerId, ...(kind === 'Open' || kind === 'Click' ? { isBotEvent: eventDetail.isBotEvent ?? 'Unknown' } : {}), ...((kind === 'Bounce') ? { bounceType: eventDetail.bounceType ?? 'Unknown', bounceSubType: eventDetail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof eventDetail.link === 'string' ? { link: eventDetail.link } : {}) } };
  await recordEmailEvent(runtime, { workspaceId: job.workspaceId, environment: job.environment, emailId: email.id, providerId, type: mapped.rawType, externalId: `${payload.topicArn}:${payload.messageId}`, data: normalized.data, createdAt: eventTime });
  const candidates = kind === 'Bounce' ? (data.bounce?.bouncedRecipients ?? []).map((r: any) => r.emailAddress) : kind === 'Complaint' ? (data.complaint?.complainedRecipients ?? []).map((r: any) => r.emailAddress) : (email.to.length === 1 && !email.cc.length && !email.bcc.length ? email.to : []);
  const recipients = candidates.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.toLowerCase()).filter((value: string) => [...email.to, ...email.cc, ...email.bcc].map(v => v.toLowerCase()).includes(value));
  const suppress = kind === 'Complaint' || (kind === 'Bounce' && eventDetail.bounceType === 'Permanent');
  const observeEngagement = (kind === 'Open' || kind === 'Click') && normalized.data.isBotEvent !== true && normalized.data.isBotEvent !== 'Likely';
  if (recipients.length && (suppress || observeEngagement)) await runtime.db.transaction(async tx => {
    for (const address of recipients) {
      const contactWhere = and(scoped(contacts, job), eq(contacts.email, address));
      if (suppress) {
        const suppressionReason = kind === 'Complaint' ? 'complaint' : eventDetail.bounceSubType === 'EmailValidationSuppressed' ? 'email_validation' : 'hard_bounce';
        await tx.insert(contacts).values({ id: id('con'), workspaceId: job.workspaceId, environment: job.environment, email: address, suppressed: true, suppressionReason }).onConflictDoUpdate({ target: [contacts.workspaceId, contacts.environment, contacts.email], set: { suppressed: true, suppressionReason, updatedAt: now() } });
      } else if (observeEngagement) {
        const column = kind === 'Open' ? contacts.lastOpenAt : contacts.lastClickAt;
        const observed = kind === 'Open' ? contacts.openObservedSince : contacts.clickObservedSince;
        await tx.update(contacts).set({ [kind === 'Open' ? 'lastOpenAt' : 'lastClickAt']: sql`greatest(${column}, ${eventTime}::timestamptz)`, [kind === 'Open' ? 'openObservedSince' : 'clickObservedSince']: sql`least(coalesce(${observed}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, observedSince: sql`least(coalesce(${contacts.observedSince}, ${eventTime}::timestamptz), ${eventTime}::timestamptz)`, updatedAt: now() }).where(contactWhere);
      }
    }
  });
  await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere);
};
const sesJob: JobHandler = async (runtime, payload, job) => {
  if (job.environment !== 'live') throw new ApiError(403, 'SES_ENVIRONMENT_MISMATCH', 'SES events must be live.');
  verifySesAccount(runtime, payload.message);
  await processSesReceipt(runtime, payload, job);
};
const simulatedFeedbackJob: JobHandler = async (runtime, payload, job) => {
  const message = payload.message as { mail?: { messageId?: unknown } } | undefined;
  if (job.environment !== 'test' || !runtime.config.simulatedSes ||
    payload.topicArn !== `urn:opensend:simulated-ses:${payload.region}` ||
    typeof message?.mail?.messageId !== 'string' || !message.mail.messageId.startsWith('sim_')) {
    throw new ApiError(403, 'SIMULATED_FEEDBACK_FORBIDDEN', 'Synthetic feedback requires opted-in test mode and a synthetic provider identity.');
  }
  await processSesReceipt(runtime, payload, job);
};
const publishJob: JobHandler = async (runtime, payload, job) => {
  const parsed = eventSchema.safeParse(payload.event);
  if (!parsed.success || parsed.data.workspaceId !== job.workspaceId || parsed.data.environment !== job.environment) throw new ApiError(422, 'INVALID_EVENT_JOB', 'The queued event is invalid or has mismatched scope.');
  await publishEvent(runtime, parsed.data as PublishedEvent);
};
const publishBatchJob: JobHandler = async (runtime, payload, job) => {
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) throw new ApiError(422, 'INVALID_EVENT_BATCH', 'Event batches must contain between one and 100 events.');
  const batch: PublishedEvent[] = [];
  for (const value of payload.events) {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId !== job.workspaceId || parsed.data.environment !== job.environment) throw new ApiError(422, 'INVALID_EVENT_JOB', 'A queued batch event is invalid or has mismatched scope.');
    batch.push(parsed.data as PublishedEvent);
  }
  const unique = batch.filter((event, index) => batch.findIndex(candidate => candidate.id === event.id) === index);
  await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(unique).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return;
    const accepted = new Set(inserted.map(row => row.id));
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, unique[0]!), eq(webhooks.paused, false)));
    const queued = unique.filter(event => accepted.has(event.id)).flatMap(event => endpoints.filter(endpoint =>
      endpoint.eventTypes.includes(event.type) && (!endpoint.regions || event.region === null || endpoint.regions.includes(event.region)) &&
      !(event.environment === 'live' && event.data.simulated === true)
    ).map(endpoint => ({ event, endpoint, deliveryId: id('whd') })));
    if (!queued.length) return;
    for (let offset = 0; offset < queued.length; offset += 1000) {
      const group = queued.slice(offset, offset + 1000);
      await tx.insert(deliveries).values(group.map(({ event, endpoint, deliveryId }) => ({ id: deliveryId, workspaceId: event.workspaceId, environment: event.environment, webhookId: endpoint.id, eventId: event.id, payload: event })));
      await tx.insert(jobs).values(group.map(({ event, deliveryId }) => ({ id: id('job'), type: 'operation.webhook', workspaceId: event.workspaceId, environment: event.environment, payload: { deliveryId, generation: 0 } })));
    }
  });
};
const retryDatabaseFailures = (handler: JobHandler): JobHandler => async (runtime, payload, job) => {
  try { await handler(runtime, payload, job); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'OPERATION_TEMPORARILY_UNAVAILABLE', 'The background operation could not complete; it will be retried.', undefined, true);
  }
};
export const operationJobs: Record<string, JobHandler> = { 'operation.webhook': retryDatabaseFailures(webhookJob), 'operation.ses': retryDatabaseFailures(sesJob), 'operation.simulatedFeedback': retryDatabaseFailures(simulatedFeedbackJob), 'operation.publish': retryDatabaseFailures(publishJob), 'operation.publishBatch': retryDatabaseFailures(publishBatchJob) };
