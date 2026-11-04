import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { CreateEmailIdentityCommand, CreateTenantResourceAssociationCommand, DeleteEmailIdentityCommand, DeleteTenantResourceAssociationCommand, GetAccountCommand, GetEmailIdentityCommand, ListResourceTenantsCommand, PutEmailIdentityMailFromAttributesCommand, type GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { X509Certificate, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { actor, ApiError, assertSesConfigured, isSimulatedSes, digest, errors, getSes, id, IdParams, json, notFound, PageQuery, randomSecret, redactCapabilityData, region, response, security, senderDomainAllowed, log, type App, type Actor, type Ctx, type Config, type Database, type DbExecutor, type JobHandler, type Permission, type Runtime } from './core.js';
import { enqueue, JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { ensureTenant } from './provider-connections.js';
import { jobs } from './db/core.js';
import { recordUnsubscribe } from './audience.js';
import { contacts } from './db/audience.js';
import { workspaces } from './db/workspaces.js';
import { emails } from './db/sending.js';
import { sesRegions } from './db/ses-regions.js';
import { resolveRegionRuntime, withRegionSettings } from './ses-region-state.js';
import { domainName, reserveClaim } from './domain-claims.js';
import { workspaceConnection, type ReadyConnection } from './provider-credentials.js';
import { ingestRoutineSesEvent, ingestRoutineSesEvents, recordEmailEvent, taggedEmailId, type RoutineIngress } from './sending.js';
import type { FeedbackItem } from './core.js';
import { acceptInboundNotification } from './mailbox-ingest.js';
import { queueReconcile } from './mailbox-setup.js';
import { mailboxDomains, type MxReport } from './db/mailbox.js';
import { checkMx,expectedMx } from './mailbox-dns.js';
import { deliveryAttempts, deliveries, domainClaims, domains, events, eventTypes, snsReceipts, unsubscribeTokens, webhooks, workspaceSettings, type PublishedEvent, type EventType } from './db/operations.js';
export type { PublishedEvent } from './db/operations.js';

const now = () => new Date().toISOString();
const scoped = (table: { workspaceId: AnyPgColumn }, a: Pick<Actor, 'workspaceId'>) => eq(table.workspaceId, a.workspaceId);
const eventSchema = z.object({ id: z.string(), type: z.enum(eventTypes), createdAt: z.string(), workspaceId: z.string(), region: z.string().nullable(), data: z.record(z.string(), z.unknown()) }).openapi('Event');
const webhookSchema = z.object({ id: z.string(), url: z.string(), description: z.string(), eventTypes: z.array(z.enum(eventTypes)), regions: z.array(z.string()).nullable(), paused: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).openapi('Webhook');
const webhookInput = z.object({ url: z.string().url().max(2048), description: z.string().max(500).default(''), eventTypes: z.array(z.enum(eventTypes)).min(1).max(10).default(['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed']), regions: z.array(z.string()).min(1).max(40).nullable().optional(), paused: z.boolean().default(false) }).openapi('CreateWebhook');
const webhookPatch = webhookInput.partial().extend({ description: z.string().max(500).optional(), eventTypes: z.array(z.enum(eventTypes)).min(1).max(10).optional(), paused: z.boolean().optional() }).openapi('UpdateWebhook');
const secretSchema = z.object({ secret: z.string() }).openapi('WebhookSecret');
const deliverySchema = z.object({ id: z.string(), webhookId: z.string(), eventId: z.string(), payload: eventSchema, synthetic: z.boolean(), status: z.enum(['pending', 'delivered', 'failed', 'paused']), attemptCount: z.number(), lastStatusCode: z.number().nullable(), lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('WebhookDelivery');
const attemptSchema = z.object({ id: z.string(), deliveryId: z.string(), statusCode: z.number().nullable(), error: z.string().nullable(), durationMs: z.number(), createdAt: z.string() }).openapi('WebhookAttempt');
const dnsState = z.enum(['pending','verified']);
const dnsRecord = z.object({ name:z.string(), type:z.enum(['CNAME','TXT','MX']), value:z.string(), priority:z.number().optional(), purpose:z.enum(['sending','receiving','mail_from']), status:dnsState, note:z.string().optional() });
const domainSchema = z.object({ id: z.string(), name: z.string(), region: z.string(), verificationStatus: z.string(), verified: z.boolean(), dkimStatus: z.string(), ready: z.boolean(), sending:dnsState, receiving:dnsState, mailFromDomain: z.string().nullable(), mailFromStatus: z.string().nullable(), dnsStatus: z.enum(['available', 'unavailable']), dnsUnavailableReason: z.string().nullable(), dns: z.array(dnsRecord) }).openapi('DomainReadiness');
const accountSchema = z.object({ region: z.string(), productionAccess: z.boolean(), sendingEnabled: z.boolean(), enforcementStatus: z.string(), quota: z.object({ max24HourSend: z.number(), maxSendRate: z.number(), sentLast24Hours: z.number() }) }).openapi('SesAccount');
const settingsSchema = z.object({ name: z.string() }).openapi('WorkspaceSettings');
const queuedSchema = z.object({ id: z.string(), status: z.literal('pending') }).openapi('QueuedWebhookDelivery');
const deletedSchema = z.object({ deleted: z.boolean() }).openapi('WebhookDeleted');
const regionQuery = z.object({ region: z.string().optional() }).openapi('RegionQuery');
const listSchema = <T extends z.ZodType>(item: T, name: string) => z.object({ data: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
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
function metadata(row: typeof webhooks.$inferSelect) { const { encryptedSecret: _, workspaceId: _w, ...value } = row; return value; }

// Only administrator-controlled public DNS names belong in this exact-match allowlist.
// It is the trust boundary against DNS rebinding: untrusted tenants cannot add hosts.
export function webhookUrl(runtime: Runtime, value: string) {
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
export async function encrypt(runtime: Pick<Runtime, 'config'>, secret: string, binding: string) {
  const current = await encryptionKey(runtime.config.encryptionKey), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, current.key, new TextEncoder().encode(secret));
  return `v1.${current.id}.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
export async function decrypt(runtime: Pick<Runtime, 'config'>, ciphertext: string, binding: string) {
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
export function webhookSecret() { return `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`; }
export async function hmac(secret: string, value: string) { const bytes = Buffer.from(secret.slice('whsec_'.length), 'base64'); if (!secret.startsWith('whsec_') || bytes.length !== 32) throw new ApiError(503, 'WEBHOOK_SECRET_ROTATION_REQUIRED', 'Rotate this endpoint secret to enable Standard Webhooks signatures.'); const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))).toString('base64'); }
const secretBinding = (a: Pick<Actor, 'workspaceId'>, webhookId: string) => `${a.workspaceId}:live:${webhookId}`;

// Installer-only, resumable rewrapping; no webhook signing secret is rotated or returned.
// Decryption failure aborts, leaving earlier successful updates safe to skip on rerun.
export async function reencryptWebhookSecrets(db: Database, config: Config): Promise<{ scanned: number; reencrypted: number; skipped: number; conflicted: number }> {
  const runtime = { config }, current = await encryptionKey(config.encryptionKey);
  const counts = { scanned: 0, reencrypted: 0, skipped: 0, conflicted: 0 };
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.select({ id: webhooks.id, workspaceId: webhooks.workspaceId, encryptedSecret: webhooks.encryptedSecret }).from(webhooks).where(cursor ? lt(webhooks.id, cursor) : undefined).orderBy(desc(webhooks.id)).limit(100);
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
  return deliverySchema.parse(a.permissions.includes('manage') ? row : { ...row, payload: { ...row.payload, data: redactCapabilityData(row.payload.data) } });
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
      const deliveryId = id('whd');
      await tx.insert(deliveries).values({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event });
      await enqueue(tx, { type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } });
      count++;
    }
    return count;
  });
  if (wake && readyJobs > 0) try { await runtime.wake?.(readyJobs); } catch { log('warn', { eventId: event.id, code: 'QUEUE_WAKE_FAILED', message: 'The event is committed; the scheduler will recover pending deliveries.' }); }
}

export async function createUnsubscribeLink(runtime: Runtime, workspaceId: string, email: string) {
  const token = randomSecret('u_');
  return { url: `${runtime.config.publicUrl.replace(/\/$/, '')}/unsubscribe/${token}`, record: { tokenHash: await digest(token), workspaceId, email: email.trim().toLowerCase() } };
}
export async function unsubscribeUrl(runtime: Runtime, workspaceId: string, email: string, db: DbExecutor = runtime.db): Promise<string> {
  const link = await createUnsubscribeLink(runtime, workspaceId, email);
  await db.insert(unsubscribeTokens).values(link.record);
  return link.url;
}
const claimTag = 'opensend:domain-claim';
type Readiness = z.infer<typeof domainSchema>;
type DomainRef = Pick<Readiness,'id'|'name'|'region'>;
type HostedDomain = DomainRef & { connection: ReadyConnection & { tenant_provisioned: boolean }; token: string; readiness: Readiness | null; receiving_name:string|null; receiving_eligible:boolean; txt_misses:number;mx_misses:number;pool_receiving:boolean; created_at: string };
const unavailableDomain = () => new ApiError(409, 'DOMAIN_UNAVAILABLE', 'This SES identity is unavailable for this domain claim.');
const ownsIdentity = (identity: GetEmailIdentityCommandOutput, token: string) => identity.Tags?.some(t => t.Key===claimTag && t.Value===token);
async function hostedDomain(db: DbExecutor, wid: string, domainId: string, lock=false, recheckDomains?: readonly string[]) {
  const target = sql`SELECT d.id,d.name,d.region,d.created_at,to_jsonb(pc) AS connection,dc.token,dc.readiness,dc.receiving_name,dc.receiving_eligible,dc.txt_misses,dc.mx_misses,
    EXISTS(SELECT 1 FROM provider_pool_regions p WHERE p.region=pc.region AND p.aws_account_id=pc.aws_account_id AND p.inbound_bucket IS NOT NULL) AS pool_receiving
    FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id
    JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND pc.region=d.region AND pc.status='ready'
    WHERE d.workspace_id=${wid} AND d.id=${domainId} ${lock ? sql`FOR UPDATE OF dc` : recheckDomains ? sql`FOR SHARE OF dc` : sql``}`;
  // Authorize the write inside the statement; a restricted key may see a 403 but must never schedule work.
  const allowed = recheckDomains?.length ? sql`WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(recheckDomains)}::jsonb) p(parent)
    WHERE right('.'||name,length(parent)+1)='.'||lower(parent))` : sql``;
  const query = recheckDomains ? sql`WITH target AS (${target}), queued AS (${recheckJob(wid, sql`SELECT id,token FROM target ${allowed}`)}) SELECT * FROM target` : target;
  return (await db.execute<HostedDomain>(query)).rows[0];
}
const dnsUnavailable = () => new ApiError(503,'DOMAIN_DNS_UNAVAILABLE','DNS did not return a definitive answer. Verification will retry.',undefined,true);
async function txtProof(name: string, token: string) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) { await r.body?.cancel();throw dnsUnavailable(); }
    const answer = await r.json() as { Status: number; TC?: boolean; Answer?: { name: string; type: number; data: string }[] };
    if (answer.TC || (answer.Status!==0 && answer.Status!==3)) throw dnsUnavailable();
    return answer.Status === 0 && !!answer.Answer?.some(rr => rr.type === 16 && rr.name.toLowerCase().replace(/\.$/, '') === name && (rr.data === `"${token}"` || rr.data === token));
  } catch { throw dnsUnavailable(); }
}
const state = (verified:boolean) => verified ? 'verified' as const : 'pending' as const;
function readiness(row: DomainRef, value: Partial<GetEmailIdentityCommandOutput>, hosted?: { token:string; shared:boolean; proven:boolean }, mx?:MxReport|null, note?:string): Readiness {
  const dkim = value.DkimAttributes, suffix = dkim?.SigningHostedZone;
  const signed = dkim?.Status === 'SUCCESS' && dkim.SigningEnabled === true;
  const dns: z.infer<typeof domainSchema>['dns'] = [];
  let dnsUnavailableReason: string | null = null;
  if (dkim?.SigningAttributesOrigin === 'EXTERNAL') dnsUnavailableReason = 'Bring-your-own DKIM records must be obtained from the identity owner.';
  else if (!suffix || !/^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,63}\.?$/.test(suffix) || !dkim?.Tokens?.length) dnsUnavailableReason = 'SES did not return an authoritative DKIM signing zone and tokens; DNS records are unavailable.';
  else dns.push(...dkim.Tokens.map(token => ({ name: `${token}._domainkey.${row.name}`, type: 'CNAME' as const, value: `${token}.${suffix}`, purpose:'sending' as const,status:state(signed) })));
  const mailFrom = value.MailFromAttributes;
  if (mailFrom?.MailFromDomain) {
    if (/^(?:us-(?:east|west)|af-south|ap-(?:east|south|northeast|southeast)|ca-(?:central|west)|eu-(?:central|north|south|west)|il-central|me-(?:south|central)|mx-central|sa-east)-\d+$/.test(row.region)) {
      const purpose={purpose:'mail_from' as const,status:state(mailFrom.MailFromDomainStatus==='SUCCESS')};
      dns.push({ name: mailFrom.MailFromDomain, type: 'MX', value: `feedback-smtp.${row.region}.amazonses.com`, priority: 10, ...purpose });
      dns.push({ name: mailFrom.MailFromDomain, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ...purpose });
    } else dnsUnavailableReason = 'MAIL FROM DNS instructions are supported only for commercial AWS regions.';
  }
  let verified = value.VerifiedForSendingStatus === true, verificationStatus = value.VerificationStatus ?? 'NOT_STARTED';
  if (hosted) {
    if (hosted.shared) dns.push({ name:`_opensend.${row.name}`,type:'TXT',value:hosted.token,purpose:'sending',status:state(hosted.proven) });
    verified = verified && signed && hosted.proven && new Set(dkim?.Tokens).size===3 && (!dkim?.SigningAttributesOrigin || dkim.SigningAttributesOrigin==='AWS_SES');
    if (!verified && verificationStatus === 'SUCCESS') verificationStatus = 'PENDING';
  }
  const ready = verified && signed;
  dns.push({...(mx?.expected ?? expectedMx(row.name,row.region)),purpose:'receiving',status:state(mx?.state==='active'),...(note ? {note} : {})});
  return { id: row.id, name: row.name, region: row.region, verificationStatus, verified, dkimStatus: dkim?.Status ?? 'NOT_STARTED', ready, sending:state(ready),receiving:state(mx?.state==='active' && value.VerificationStatus==='SUCCESS' && (hosted?.proven ?? true)), mailFromDomain: mailFrom?.MailFromDomain ?? null, mailFromStatus: mailFrom?.MailFromDomainStatus ?? null, dnsStatus: dnsUnavailableReason ? 'unavailable' as const : 'available' as const, dnsUnavailableReason, dns };
}
async function domainReadiness(runtime: Runtime, row: DomainRef, identity?: GetEmailIdentityCommandOutput) {
  const [stored]=await runtime.db.select({mx:mailboxDomains.mx,status:mailboxDomains.status}).from(mailboxDomains).where(and(eq(mailboxDomains.domainId,row.id),isNull(mailboxDomains.parentId)));
  const report=readiness(row,identity ?? await sesCall(() => getSes(runtime,row.region).send(new GetEmailIdentityCommand({ EmailIdentity:row.name }))),undefined,stored?.mx);
  if (stored?.status!=='active') report.receiving='pending';
  return report;
}
const claimProof = (row: {connection:ReadyConnection;token:string}, proven=false) => ({ token:row.token,shared:row.connection.kind==='shared',proven });
const cachedDomain = (row:HostedDomain) => row.readiness ?? readiness(row,{VerificationStatus:'PENDING'},claimProof(row));
const identityBinding = (row:HostedDomain,wid:string) => ({TenantName:`opensend-${wid}`, ResourceArn:`arn:aws:ses:${row.region}:${row.connection.aws_account_id}:identity/${row.name}`});
const NEGATIVE_CONFIRMATIONS=3;
type ReceivingObservation={mx:MxReport;note?:string};
// The caller holds the claim lock. Only a full identity check can change eligibility; an MX-only
// observation may change routing but can never grant ownership or qualify an unverified SES identity.
async function saveObservation(db:DbExecutor,row:HostedDomain,report:Readiness,wid:string,observation:ReceivingObservation|undefined,eligible:boolean,txtMisses:number) {
  const byo=row.connection.kind==='byo',record=report.dns.find(r=>r.purpose==='receiving')!;
  // Mixed MX is unsuitable for new setup, but it is not evidence that an already-verified record vanished.
  const observed=observation && (observation.mx.state==='active' || (observation.mx.state==='mixed' && observation.mx.expected.name===row.receiving_name)) ? observation.mx.expected.name : null;
  let target=eligible && (byo || row.pool_receiving) ? observed : null;
  const misses=row.receiving_name && eligible && observation && row.receiving_name!==observed ? row.mx_misses+1 : 0;
  const holding=!!misses && misses<NEGATIVE_CONFIRMATIONS;
  if (holding) target=row.receiving_name;
  const prior=row.readiness?.dns.find(r=>r.purpose==='receiving');
  const next=holding && prior ? prior : observation ? {...observation.mx.expected,purpose:'receiving' as const,status:state(observed!==null),...(observation.note?{note:observation.note}:{})} : record;
  if (target && target!==row.receiving_name) {
    // A workspace may claim both example.com and reply.example.com. Never route one address twice.
    const owner=(await db.execute<{name:string}>(sql`SELECT name FROM mailbox_domains WHERE workspace_id=${wid} AND receiving_host=${target} AND name<>${row.name} AND status IN ('active','provisioning') LIMIT 1`)).rows[0];
    if (owner) { target=null;next.note=`${next.name} already receives mail through ${owner.name}.`; }
  }
  report.dns=report.dns.map(r=>r.purpose==='receiving'?next:r);
  report.receiving=state(!!target && (!byo || (target===row.receiving_name && row.readiness?.receiving==='verified')));
  const status=report.receiving==='verified'?'active':target?'provisioning':'waiting_for_mx';
  const mx=holding ? null : observation?.mx;
  await db.execute(sql`WITH claim AS (UPDATE domain_claims SET readiness=${JSON.stringify(report)}::jsonb,verified=${report.verified},ready=${report.ready},
    receiving_name=${target},receiving_eligible=${eligible},txt_misses=${txtMisses},mx_misses=${holding?misses:0} WHERE name=${row.name} AND token=${row.token} AND connection_id=${row.connection.id} RETURNING workspace_id)
    INSERT INTO mailbox_domains AS m(id,workspace_id,domain_id,name,region,receiving_host,status,enabled_at,mx,checked_at)
    SELECT ${id('mdom')},workspace_id,${row.id},${row.name},${row.region},${next.name},${status},CASE WHEN ${!!target} THEN now() END,${mx?JSON.stringify(mx):null}::jsonb,${mx?.checkedAt??null}::timestamptz FROM claim
    ON CONFLICT ON CONSTRAINT mailbox_domains_name DO UPDATE SET domain_id=excluded.domain_id,parent_id=NULL,region=excluded.region,receiving_host=excluded.receiving_host,status=excluded.status,
      enabled_at=CASE WHEN ${!!target && target===row.receiving_name} THEN m.enabled_at ELSE excluded.enabled_at END,
      mx=coalesce(excluded.mx,m.mx),checked_at=coalesce(excluded.checked_at,m.checked_at),updated_at=now()`);
  if (byo && (target!==row.receiving_name || status==='provisioning')) await queueReconcile(db,wid,row.region);
  return holding;
}
async function receivingMx(row:HostedDomain):Promise<ReceivingObservation> {
  const mx=await checkMx(row.name,row.region);
  if (mx.state==='error') throw dnsUnavailable();
  if (mx.state==='mixed' && row.receiving_name===row.name) return {mx,note:mx.message};
  const host=`reply.${row.name}`;
  if (!['conflict','mixed','wrong_region','cname','null_mx'].includes(mx.state) && row.receiving_name!==host) return {mx};
  const reply=await checkMx(host,row.region);
  if (reply.state==='error') throw dnsUnavailable();
  if (reply.state==='mixed' && row.receiving_name===host) return {mx:reply,note:reply.message};
  // A working reply host stays selected even if the root MX subsequently disappears or changes.
  if (mx.state==='active' || mx.state==='missing') return reply.state==='active'?{mx:reply}:{mx};
  const reason=mx.state==='cname'?'is a CNAME':mx.state==='null_mx'?'publishes a null MX':`already routes mail to ${mx.records.map(r=>r.host).filter(h=>h!==mx.expected.value).join(', ')}`;
  return {mx:reply,note:`${row.name} ${reason}. Keep its DNS and publish this MX on ${host} instead.`};
}
async function releaseClaim(db:DbExecutor,wid:string,row:{token:string;id:string}) {
  await db.execute(sql`WITH released AS (DELETE FROM domain_claims WHERE workspace_id=${wid} AND token=${row.token} RETURNING name,token),
    retired AS (UPDATE mailbox_domains SET status='disabled',updated_at=now() WHERE workspace_id=${wid} AND domain_id=${row.id} AND name IN (SELECT name FROM released)),
    canceled AS (DELETE FROM jobs USING released r WHERE jobs.id IN ('domain.verify:'||r.token,'domain.mx:'||r.token) AND jobs.workspace_id=${wid} AND jobs.type IN ('domain.verify','domain.mx') AND jobs.status='pending')
    DELETE FROM operation_domains WHERE workspace_id=${wid} AND id=${row.id} AND name IN (SELECT name FROM released)`);
}
function recheckJob(wid: string, source: SQL, supersede=false) {
  // A recovered creation or MAIL FROM change supersedes even a running poll based on an older SES read.
  return sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.verify:'||r.token,'domain.verify',${wid},
    jsonb_build_object('domainId',r.id,'token',r.token) FROM (${source}) r ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),lease_until=NULL,last_error=NULL,
    payload=excluded.payload,created_at=now() ${supersede ? sql`` : sql`WHERE jobs.status<>'running'`}`;
}
const domainVerify: JobHandler = async (runtime,payload,job) => {
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row || row.token!==payload.token) return; // Deleted, reclaimed or disconnected.
  const start=Number(payload.start ?? Date.now()), poll=Number(payload.poll ?? 0), deadline=start+72*3600_000;
  const expire=()=>runtime.db.execute(sql`UPDATE domain_claims SET readiness=jsonb_set(readiness,'{verificationStatus}','"FAILED"'::jsonb)
    WHERE token=${row.token} AND connection_id=${row.connection.id} AND NOT verified AND readiness IS NOT NULL`);
  const defer=(ms:number, next=poll) => { throw new JobDeferred(new Date(Math.min(deadline,Date.now()+ms)).toISOString(),{...payload,start,poll:next}); };
  const scoped={...runtime,config:{...runtime.config,workspaceId:job.workspaceId,regions:[row.region]}};
  try {
    // Reserve the next GetEmailIdentity across workers, not per workspace or per invocation.
    const lane='domain.verify:'+(row.connection.kind==='shared'?'platform':row.connection.aws_account_id);
    if (!(await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,wake_not_before) VALUES (${lane},clock_timestamp()+interval '1 second') ON CONFLICT(workspace_id)
      DO UPDATE SET wake_not_before=excluded.wake_not_before WHERE job_schedule.wake_not_before<=clock_timestamp() RETURNING 1`)).rowCount) {
      if (Date.now()<deadline) defer(1000+Math.random()*1000); await expire(); return;
    }
    const client=getSes(scoped,row.region,row.connection);
    const identity=await sesCall(()=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
    if (!ownsIdentity(identity,row.token)) throw unavailableDomain();
    const shared=row.connection.kind==='shared';
    const identityVerified=identity.VerificationStatus==='SUCCESS';
    const [positive,observation]=await Promise.all([shared ? txtProof(`_opensend.${row.name}`,row.token) : identityVerified,receivingMx(row)]);
    if (shared && readiness(row,identity,claimProof(row,positive)).ready && !row.connection.tenant_provisioned) await ensureTenant(scoped,job.workspaceId,row.connection.id);
    const complete=await runtime.db.transaction(async db=>{
      // Serialize the association with deletion: a stale verifier cannot bind a replacement identity.
      const current=await hostedDomain(db,job.workspaceId,row.id,true);
      if (!current || current.token!==row.token) return true;
      const wasProven=current.receiving_eligible || current.readiness?.dns.some(r=>r.purpose==='sending' && r.type==='TXT' && r.status==='verified');
      const misses=shared && !positive && wasProven ? current.txt_misses+1 : 0;
      const holdTxt=misses>0 && misses<NEGATIVE_CONFIRMATIONS,proven=positive || holdTxt;
      const report=readiness(row,identity,claimProof(row,proven),observation.mx,observation.note);
      if (current.receiving_name!==row.receiving_name || current.readiness?.mailFromDomain!==row.readiness?.mailFromDomain || (current.readiness?.mailFromStatus==='PENDING' &&
        (row.readiness?.mailFromStatus!=='PENDING' || current.readiness.mailFromDomain!==report.mailFromDomain))) {
        if (Date.now()<deadline) defer(5000);
        return; // The newer configuration has its own poll; never replace it with an expired observation.
      }
      if (shared && report.ready && !current.readiness?.ready) {
        try { await sesCall(()=>client.send(new CreateTenantResourceAssociationCommand(identityBinding(current,job.workspaceId)))); }
        catch (e) { if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') throw e; }
      }
      const holdMx=await saveObservation(db,current,report,job.workspaceId,observation,identityVerified && proven,holdTxt?misses:0);
      return report.ready && report.mailFromStatus!=='PENDING' && !holdTxt && !holdMx;
    });
    if (complete) return; // MX-only upkeep owns receiving changes after sending verifies.
  } catch (e) {
    if (e instanceof ApiError && ['SES_IDENTITY_NOT_FOUND','DOMAIN_UNAVAILABLE'].includes(e.code)) {
      await runtime.db.transaction(async db=>{
        const current=await hostedDomain(db,job.workspaceId,row.id,true);
        if (current?.token===row.token && current.readiness) {
          const old=current.readiness;
          await saveObservation(db,current,{...old,verified:false,ready:false,sending:'pending',receiving:'pending',dkimStatus:'NOT_STARTED',verificationStatus:e.code==='DOMAIN_UNAVAILABLE'?'FAILED':'PENDING',dns:old.dns.map(r=>({...r,status:'pending'}))},job.workspaceId,undefined,false,0);
        }
      });
      if (e.code==='DOMAIN_UNAVAILABLE') return;
    } else if (e instanceof ApiError && e.code==='DOMAIN_DNS_UNAVAILABLE') {
      // Transport failures never count as evidence against a working domain, even past the onboarding deadline.
      throw new JobDeferred(new Date(Date.now()+Math.min(3_600_000,30_000*2**Math.min(poll,7))).toISOString(),{...payload,start,poll:poll+1});
    } else if (!(e instanceof ApiError) || !e.retryable) throw e;
  }
  if (Date.now()<deadline) defer([15000,30000,120000,600000,1800000,3600000][Math.min(poll,5)]!,poll+1);
  await expire();
};
const domainMx:JobHandler=async(runtime,payload,job)=>{
  if (!runtime.config.multiTenant || typeof payload.domainId!=='string') return;
  const row=await hostedDomain(runtime.db,job.workspaceId,payload.domainId);
  if (!row?.readiness || row.token!==payload.token) return;
  const observation=await receivingMx(row);
  await runtime.db.transaction(async db=>{
    const current=await hostedDomain(db,job.workspaceId,row.id,true);
    if (!current?.readiness || current.token!==row.token || current.receiving_name!==row.receiving_name) return;
    await saveObservation(db,current,current.readiness,job.workspaceId,observation,current.receiving_eligible,current.txt_misses);
  });
};
async function account(runtime: Runtime, wid: string, requested?: string) {
  assertSesConfigured(runtime);
  const connection=runtime.config.multiTenant ? await workspaceConnection({...runtime,config:{...runtime.config,workspaceId:wid}},requested) : undefined;
  if (connection?.kind==='shared') throw new ApiError(403,'SHARED_ACCOUNT_PRIVATE','Account-wide SES settings are not available on hosted mail.');
  const selectedRegion=connection?.region ?? requested ?? runtime.config.regions[0]!;
  if (connection) runtime={...runtime,config:{...runtime.config,workspaceId:wid,regions:[connection.region]}};
  const a = await sesCall(() => getSes(runtime, selectedRegion,connection).send(new GetAccountCommand({}))); return { region: selectedRegion, productionAccess: a.ProductionAccessEnabled === true, sendingEnabled: a.SendingEnabled === true, enforcementStatus: a.EnforcementStatus ?? 'UNKNOWN', quota: { max24HourSend: a.SendQuota?.Max24HourSend ?? 0, maxSendRate: a.SendQuota?.MaxSendRate ?? 0, sentLast24Hours: a.SendQuota?.SentLast24Hours ?? 0 } }; }
async function getWebhook(runtime: Runtime, a: Actor, webhookId: string) { const [row] = await runtime.db.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, webhookId))); return row ?? notFound('Webhook'); }

export function registerOperations(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/workspace', operationId: 'getWorkspaceSettings', tags: ['Settings'], security, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c); const [row] = c.env.config.multiTenant
      ? await c.env.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, a.workspaceId))
      : await c.env.db.select().from(workspaceSettings).where(scoped(workspaceSettings, a));
    return c.json({ name: row?.name ?? 'OpenSend' }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/settings/workspace', operationId: 'updateWorkspaceSettings', tags: ['Settings'], security, request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).openapi('UpdateWorkspaceSettings')) }, responses: { 200: response(settingsSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), { name } = c.req.valid('json');
    if (c.env.config.multiTenant) await c.env.db.update(workspaces).set({ name }).where(eq(workspaces.id, a.workspaceId));
    else await c.env.db.execute(sql`INSERT INTO operation_settings(workspace_id,name) VALUES (${a.workspaceId},${name})
      ON CONFLICT ON CONSTRAINT operation_settings_pkey DO UPDATE SET name=excluded.name,updated_at=now()`);
    return c.json({ name }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/settings/ses', operationId: 'getSesSettings', tags: ['Settings'], security, request: { query: regionQuery }, responses: { 200: response(accountSchema), ...errors } }), async c => { const a = workspaceActor(c); return c.json(await account(c.env,a.workspaceId,c.req.valid('query').region), 200); });
  app.openapi(createRoute({ method: 'get', path: '/v1/domains', operationId: 'listDomains', description: 'MX returns persisted DNS records and background verification status without AWS calls. Self-hosted installations refresh up to ten identities unless refresh=false.', tags: ['Domains'], security, request: { query: PageQuery.extend({ limit: z.coerce.number().int().min(1).max(10).default(5), region: z.string().optional(), refresh: z.enum(['true', 'false']).default('true') }).openapi('ListDomainsQuery') }, responses: { 200: response(listSchema(domainSchema, 'DomainPage')), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'); if (!c.env.config.multiTenant) getSes(c.env, q.region ?? c.env.config.regions[0]!);
    const allowed = a.domains.length ? or(...a.domains.map(parent => or(eq(domains.name, parent), like(domains.name, `%.${parent}`)))) : undefined;
    const where = and(scoped(domains, a), allowed, q.region ? eq(domains.region, region(c.env, q.region)) : c.env.config.multiTenant ? undefined : inArray(domains.region, c.env.config.regions), q.cursor ? lt(domains.id, q.cursor) : undefined);
    if (c.env.config.multiTenant) {
      const rows=await c.env.db.select({row:domains,token:domainClaims.token,readiness:domainClaims.readiness,shared:sql<boolean>`pc.kind='shared'`}).from(domains)
        .innerJoin(domainClaims,and(eq(domainClaims.name,domains.name),eq(domainClaims.workspaceId,domains.workspaceId)))
        .innerJoin(sql`provider_connections pc`,sql`pc.id=${domainClaims.connectionId} AND pc.workspace_id=${domains.workspaceId} AND pc.region=${domains.region} AND pc.status='ready'`)
        .where(where).orderBy(desc(domains.id)).limit(q.limit+1);
      return c.json({data:rows.slice(0,q.limit).map(r=>r.readiness ? domainSchema.parse(r.readiness) : readiness(r.row,{VerificationStatus:'PENDING'},{...r,proven:false})),nextCursor:rows.length>q.limit?rows[q.limit-1]!.row.id:null},200);
    }
    const rows = await c.env.db.select({row:domains,mx:mailboxDomains.mx,status:mailboxDomains.status}).from(domains).leftJoin(mailboxDomains,and(eq(mailboxDomains.workspaceId,domains.workspaceId),eq(mailboxDomains.domainId,domains.id),isNull(mailboxDomains.parentId))).where(where).orderBy(desc(domains.id)).limit(q.limit + 1);
    if (q.refresh === 'false') {
      const reports = await c.env.db.select({ region: sesRegions.region, report: sesRegions.report }).from(sesRegions).where(eq(sesRegions.workspaceId, a.workspaceId));
      const data = rows.slice(0, q.limit).map(({row,mx,status}) => {
        const cached = reports.find(report => report.region === row.region)?.report?.domains.find(domain => domain.name === row.name);
        const ready = cached?.verificationStatus === 'SUCCESS' && cached.sendingEnabled === true, verified = cached?.sendingEnabled === true;
        return { ...readiness(row,{},undefined,mx),verificationStatus: cached?.verificationStatus ?? 'NOT_STARTED', verified, dkimStatus: ready ? 'SUCCESS' : 'NOT_STARTED', ready,sending:state(ready),receiving:state(status==='active' && mx?.state==='active' && verified),dnsUnavailableReason: 'Open the domain to refresh DNS details.' };
      });
      return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null }, 200);
    }
    const data: z.infer<typeof domainSchema>[] = [];
    for (const {row,mx,status} of rows.slice(0, q.limit)) {
      if (data.length) await new Promise(resolve => setTimeout(resolve, 1000));
      const identity=await sesCall(()=>getSes(c.env,row.region).send(new GetEmailIdentityCommand({ EmailIdentity:row.name })));
      const report=readiness(row,identity,undefined,mx);if(status!=='active')report.receiving='pending';data.push(report);
    }
    return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.row.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains', operationId: 'createDomain', tags: ['Domains'], security, request: { body: json(z.object({ name: domainName, region: z.string() }).openapi('CreateDomain')) }, responses: { 201: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, 'manage'); const body = c.req.valid('json'); allowedDomain(a, body.name); assertSesConfigured(c.env);
    if (c.env.config.multiTenant) {
      const claim=await reserveClaim(c.env,a.workspaceId,body.name,body.region), row={...body,id:claim.id};
      if (claim.readiness != null) return c.json(domainSchema.parse(claim.readiness),201);
      a.wakeJobs=1;
      const runtime={...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}};
      const client=getSes(runtime,row.region,claim.connection);
      let identity: Partial<GetEmailIdentityCommandOutput>;
      try {
        identity=await sesCall(()=>client.send(new CreateEmailIdentityCommand({EmailIdentity:row.name,DkimSigningAttributes:{NextSigningKeyLength:'RSA_2048_BIT'},Tags:[{Key:claimTag,Value:claim.token}]})));
      } catch(e) {
        if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_EXISTS') {
          if (claim.fresh && e instanceof ApiError && !e.retryable && e.status<500) await releaseClaim(c.env.db,a.workspaceId,claim);
          throw e;
        }
        // A lost response (or racing POST) can leave our exact tagged identity in SES. Never adopt by name.
        const existing=await sesCall(()=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
        if (!ownsIdentity(existing,claim.token)) { await releaseClaim(c.env.db,a.workspaceId,claim); throw unavailableDomain(); }
        identity=existing;
      }
      const report=readiness(row,{...identity,VerificationStatus:'PENDING'},claimProof(claim));
      // Never overwrite a verifier that already recovered a lost/slow Create response.
      const saved=sql`UPDATE domain_claims SET readiness=${JSON.stringify(report)}::jsonb WHERE token=${claim.token} AND name=${row.name} AND readiness IS NULL RETURNING ${row.id}::text AS id,token`;
      await c.env.db.execute(claim.fresh ? saved : sql`WITH recovered AS (${saved}) ${recheckJob(a.workspaceId,sql`SELECT id,token FROM recovered`,true)}`);
      return c.json(report,201);
    }
    const client = getSes(c.env, body.region); let identity: GetEmailIdentityCommandOutput | undefined;
    try { identity = await sesCall(() => client.send(new GetEmailIdentityCommand({ EmailIdentity: body.name }))); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'SES_IDENTITY_NOT_FOUND') throw error;
    }
    if (!identity) {
      try { await sesCall(() => client.send(new CreateEmailIdentityCommand({ EmailIdentity: body.name, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } }))); }
      catch (createError) { if (!(createError instanceof ApiError) || createError.code !== 'SES_IDENTITY_EXISTS') throw createError; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const { rows: [row] } = await c.env.db.execute<DomainRef>(sql`INSERT INTO operation_domains(id,workspace_id,name,region)
      VALUES (${id('dom')},${a.workspaceId},${body.name},${body.region}) ON CONFLICT ON CONSTRAINT operation_domain_scope
      DO UPDATE SET updated_at=now() RETURNING id,name,region`);
    return c.json(await domainReadiness(c.env, row!, identity), 201);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/domains/{id}/mail-from', operationId: 'configureDomainMailFrom', tags: ['Domains'], security, description: 'Configure a custom SES MAIL FROM subdomain with fallback to the default amazonses.com MAIL FROM value while DNS is unavailable.', request: { params: IdParams, body: json(z.object({ mailFromDomain: domainName }).strict().openapi('ConfigureDomainMailFrom')) }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, 'manage'); const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id)));
    if (!row) return notFound('Domain'); allowedDomain(a, row.name);
    const { mailFromDomain } = c.req.valid('json');
    if (mailFromDomain === row.name || !mailFromDomain.endsWith(`.${row.name}`)) throw new ApiError(422, 'MAIL_FROM_DOMAIN_INVALID', `Use a subdomain of ${row.name}.`, 'mailFromDomain');
    if (c.env.config.multiTenant) {
      const report=await c.env.db.transaction(async db=>{
        const current=await hostedDomain(db,a.workspaceId,row.id,true) ?? notFound('Domain');
        const client=getSes({...c.env,config:{...c.env.config,workspaceId:a.workspaceId,regions:[row.region]}},row.region,current.connection);
        const identity=await sesCall(()=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
        if (!ownsIdentity(identity,current.token)) throw unavailableDomain();
        await sesCall(()=>client.send(new PutEmailIdentityMailFromAttributesCommand({EmailIdentity:row.name,MailFromDomain:mailFromDomain,BehaviorOnMxFailure:'USE_DEFAULT_VALUE'})));
        // Changing MAIL FROM does not re-prove ownership, activate sending, or move inbound routing.
        const report=cachedDomain(current);
        report.mailFromDomain=mailFromDomain;report.mailFromStatus='PENDING';
        report.dns=report.dns.filter(r=>r.purpose!=='mail_from').concat(readiness(row,{MailFromAttributes:{MailFromDomain:mailFromDomain,MailFromDomainStatus:'PENDING',BehaviorOnMxFailure:'USE_DEFAULT_VALUE'}}).dns.filter(r=>r.purpose==='mail_from'));
        await db.execute(sql`UPDATE domain_claims SET readiness=${JSON.stringify(report)}::jsonb WHERE token=${current.token} AND connection_id=${current.connection.id}`);
        await db.execute(recheckJob(a.workspaceId,sql`SELECT ${current.id}::text AS id,${current.token}::text AS token`,true)); return report;
      }); a.wakeJobs=1; return c.json(report,200);
    }
    const client = getSes(c.env, row.region);
    await sesCall(() => client.send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: row.name, MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' })));
    return c.json(await domainReadiness(c.env, row), 200);
  });
  for (const verifyRoute of [false, true]) app.openapi(createRoute({ method: verifyRoute ? 'post' : 'get', path: verifyRoute ? '/v1/domains/{id}/verify' : '/v1/domains/{id}', operationId: verifyRoute ? 'verifyDomain' : 'getDomain', description: verifyRoute ? 'On MX, request a background verification and return the current stored status. Read the domain again for updates.' : 'On MX, read the stored DNS records and verification status without an AWS call.', tags: ['Domains'], security, request: { params: IdParams }, responses: { 200: response(domainSchema), ...errors } }), async c => {
    const a = actor(c, verifyRoute ? 'manage' : 'read');
    if (c.env.config.multiTenant) {
      const row=await hostedDomain(c.env.db,a.workspaceId,c.req.valid('param').id,false,verifyRoute?a.domains:undefined) ?? notFound('Domain'); allowedDomain(a,row.name);
      if (verifyRoute) a.wakeJobs=1;
      return c.json(cachedDomain(row),200);
    }
    const [row] = await c.env.db.select().from(domains).where(and(scoped(domains, a), eq(domains.id, c.req.valid('param').id))); if (!row) return notFound('Domain'); allowedDomain(a, row.name); return c.json(await domainReadiness(c.env, row), 200);
  });
  app.openapi(createRoute({method:'delete',path:'/v1/domains/{id}',operationId:'deleteDomain',tags:['Domains'],security,description:'MX only. Delete this claim’s tagged SES identity and release the domain. Does not remove DNS records.',request:{params:IdParams},responses:{200:response(z.object({deleted:z.literal(true)})),...errors}}),async c=>{
    const a=actor(c,'manage'); if (!c.env.config.multiTenant) return notFound('Endpoint');
    await c.env.db.transaction(async db=>{
      const row=await hostedDomain(db,a.workspaceId,c.req.valid('param').id,true) ?? notFound('Domain'); allowedDomain(a,row.name);
      if (!row.readiness && Date.now()-new Date(row.created_at).getTime()<60000) throw new ApiError(409,'DOMAIN_BUSY','Domain creation is in progress.',undefined,true);
      const runtime={...c.env,config:{...c.env.config,regions:[row.region]}},client=getSes(runtime,row.region,row.connection);
      const ignoreMissing=async <T>(fn:()=>Promise<T>)=>{ try {return await sesCall(fn);} catch(e){if (!(e instanceof ApiError) || e.code!=='SES_IDENTITY_NOT_FOUND') throw e;} };
      const identity=await ignoreMissing(()=>client.send(new GetEmailIdentityCommand({EmailIdentity:row.name})));
      if (identity && ownsIdentity(identity,row.token)) {
        // Read actual SES membership, not readiness: DNS can regress, or the association acknowledgement can be lost.
        // Keep the per-claim fence through deletion so a concurrent release/re-claim cannot delete a new owner's identity.
        if (row.connection.kind==='shared' && row.connection.aws_account_id) {
          const binding=identityBinding(row,a.workspaceId); let next: string | undefined;
          do {
            const page=await sesCall(()=>client.send(new ListResourceTenantsCommand({ResourceArn:binding.ResourceArn,NextToken:next})));
            if (page.ResourceTenants?.some(t=>t.TenantName===binding.TenantName)) {
              await ignoreMissing(()=>client.send(new DeleteTenantResourceAssociationCommand(binding))); break;
            }
            next=page.NextToken;
          } while (next);
        }
        await ignoreMissing(()=>client.send(new DeleteEmailIdentityCommand({EmailIdentity:row.name})));
      }
      await releaseClaim(db,a.workspaceId,row);
      if (row.connection.kind==='byo' && row.receiving_name) await queueReconcile(db,a.workspaceId,row.region);
    }); return c.json({deleted:true as const},200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks', operationId: 'listWebhooks', tags: ['Webhooks'], security, request: { query: PageQuery }, responses: { 200: response(listSchema(webhookSchema, 'WebhookPage')), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'); const rows = await c.env.db.select().from(webhooks).where(and(scoped(webhooks, a), q.cursor ? lt(webhooks.id, q.cursor) : undefined)).orderBy(desc(webhooks.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(metadata), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks', operationId: 'createWebhook', tags: ['Webhooks'], security, request: { body: json(webhookInput) }, responses: { 201: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), body = c.req.valid('json'), webhookId = id('wh'); const url = webhookUrl(c.env, body.url);
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const [row] = await c.env.db.insert(webhooks).values({ ...body, id: webhookId, workspaceId: a.workspaceId, url, regions: body.regions ?? null, encryptedSecret: await encrypt(c.env, webhookSecret(), secretBinding(a, webhookId)) }).returning();
    return c.json(metadata(row!), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}', operationId: 'getWebhook', tags: ['Webhooks'], security, request: { params: IdParams }, responses: { 200: response(webhookSchema), ...errors } }), async c => c.json(metadata(await getWebhook(c.env, workspaceActor(c), c.req.valid('param').id)), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/webhooks/{id}', operationId: 'updateWebhook', tags: ['Webhooks'], security, request: { params: IdParams, body: json(webhookPatch) }, responses: { 200: response(webhookSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), current = await getWebhook(c.env, a, c.req.valid('param').id), body = c.req.valid('json'); if (body.url) body.url = webhookUrl(c.env, body.url);
    if (body.regions?.length) { const runtime = await withRegionSettings(c.env, a.workspaceId); body.regions.forEach(r => region(runtime, r)); }
    const row = await c.env.db.transaction(async tx => {
      const [locked] = await tx.select().from(webhooks).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).for('update'); if (!locked) return notFound('Webhook');
      const [updated] = await tx.update(webhooks).set({ ...body, updatedAt: now() }).where(and(scoped(webhooks, a), eq(webhooks.id, current.id))).returning();
      if (locked.paused && body.paused === false) {
        const paused = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, current.id), eq(deliveries.status, 'paused'))).for('update');
        for (const delivery of paused) {
          const generation = delivery.generation + 1;
          await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(and(scoped(deliveries, a), eq(deliveries.id, delivery.id)));
          await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId: delivery.id, generation } });
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
    const deliveryId = id('whd'), event: PublishedEvent = { id: id('evt_test'), type: 'email.delivered', createdAt: now(), workspaceId: a.workspaceId, region: null, data: { synthetic: true, test: true, message: 'Explicit webhook endpoint test. No email was sent.' } };
    await c.env.db.transaction(async tx => { await tx.insert(deliveries).values({ id: deliveryId, workspaceId: a.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event, synthetic: true }); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId, generation: 0 } }); });
    return c.json({ id: deliveryId, status: 'pending' as const }, 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tags: ['Webhooks'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(listSchema(deliverySchema, 'WebhookDeliveryPage')), ...errors } }), async c => {
    const a = workspaceActor(c), endpoint = await getWebhook(c.env, a, c.req.valid('param').id), q = c.req.valid('query'); const rows = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, endpoint.id), q.cursor ? lt(deliveries.id, q.cursor) : undefined)).orderBy(desc(deliveries.id)).limit(q.limit + 1); return c.json({ data: rows.slice(0, q.limit).map(row => visibleDelivery(row, a)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  const deliveryParams = z.object({ id: z.string(), deliveryId: z.string() }).openapi('WebhookDeliveryParams');
  app.openapi(createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries/{deliveryId}', operationId: 'getWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 200: response(deliverySchema.extend({ attempts: z.array(attemptSchema) }).openapi('WebhookDeliveryDetail')), ...errors } }), async c => {
    const a = workspaceActor(c), p = c.req.valid('param'); const [row] = await c.env.db.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))); if (!row) return notFound('Delivery'); const attempts = await c.env.db.select().from(deliveryAttempts).where(and(scoped(deliveryAttempts, a), eq(deliveryAttempts.deliveryId, row.id))).orderBy(asc(deliveryAttempts.createdAt)); return c.json({ ...visibleDelivery(row, a), attempts: attempts.map(row => attemptSchema.parse(row)) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/webhooks/{id}/deliveries/{deliveryId}/retry', operationId: 'retryWebhookDelivery', tags: ['Webhooks'], security, request: { params: deliveryParams }, responses: { 202: response(queuedSchema), ...errors } }), async c => {
    const a = workspaceActor(c, 'manage'), p = c.req.valid('param'); await getWebhook(c.env, a, p.id);
    await c.env.db.transaction(async tx => {
      const [row] = await tx.select().from(deliveries).where(and(scoped(deliveries, a), eq(deliveries.webhookId, p.id), eq(deliveries.id, p.deliveryId))).for('update'); if (!row) return notFound('Delivery');
      if (row.status === 'pending') throw new ApiError(409, 'DELIVERY_PENDING', 'This delivery already has a pending attempt.');
      const generation = row.generation + 1; await tx.update(deliveries).set({ status: 'pending', generation, updatedAt: now() }).where(eq(deliveries.id, row.id)); await enqueue(tx, { type: 'operation.webhook', workspaceId: a.workspaceId, payload: { deliveryId: row.id, generation } });
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
function verifySesAccount(runtime: Runtime, message: unknown, topicArn: string) {
  const accountId = (message as { mail?: { sendingAccountId?: unknown } } | null)?.mail?.sendingAccountId;
  // SNS topics can receive cross-account SES events; only an explicit SES account binding is authoritative.
  const expected = runtime.config.multiTenant ? topicArn.split(':')[4] : runtime.config.awsAccountId;
  if ((runtime.config.multiTenant && !/^\d{12}$/.test(expected ?? '')) || (expected && accountId !== expected)) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'The SES sending account is missing or does not match this topic.');
}
function registerPublicEvents(app: App) {
  type TopicBinding = { region: string; aws_account_id: string; kind: 'byo' | 'shared'; ready: boolean; inbound:boolean };
  const sendingTopics = new Map<string, { binding: TopicBinding; expires: number }>();
  async function sendingTopic(runtime: Runtime, arn: string, confirming: boolean) {
    const cached = sendingTopics.get(arn);
    if (cached && cached.expires > Date.now()) return cached.binding;
    const binding = (await runtime.db.execute<TopicBinding>(sql`
      SELECT region, aws_account_id, kind, status='ready' AS ready,false AS inbound FROM provider_connections WHERE kind='byo' AND feedback_topic_arn=${arn}
      UNION ALL SELECT region, aws_account_id, 'shared', ready,false FROM provider_pool_regions WHERE feedback_topic_arn=${arn}
      UNION ALL SELECT region,aws_account_id,'shared',inbound_bucket IS NOT NULL,true FROM provider_pool_regions WHERE inbound_topic_arn=${arn}
      UNION ALL SELECT r.region,r.account_id,'byo',c.status='ready',true FROM mailbox_regions r JOIN provider_connections c ON c.workspace_id=r.workspace_id AND c.aws_account_id=r.account_id AND c.region=r.region AND c.kind='byo' WHERE r.topic_arn=${arn}`)).rows[0];
    if (!binding || !arn.startsWith(`arn:aws:sns:${binding.region}:${binding.aws_account_id}:`)) return;
    // A pending topic may confirm its subscription but must never prime trust for notifications.
    if (!binding.ready) return confirming ? binding : undefined;
    if (sendingTopics.size >= 1024) sendingTopics.delete(sendingTopics.keys().next().value!);
    sendingTopics.set(arn, { binding, expires: Date.now() + 60_000 });
    return binding;
  }
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
    const envelope = parsed.data;
    // Region settings may come from a 30 s cache: a topic or account provisioned since then is re-checked fresh.
    if (c.env.config.multiTenant) {
      const binding=await sendingTopic(c.env,envelope.TopicArn,envelope.Type==='SubscriptionConfirmation');
      if (!binding) throw new ApiError(403,'SNS_TOPIC_NOT_ALLOWED','This SNS topic is not registered for the account and region.');
      c.env={...c.env,config:{...c.env.config,snsTopicArns:[envelope.TopicArn],inboundTopicArns:binding.inbound?[envelope.TopicArn]:[]}};
    } else if (!c.env.config.snsTopicArns.includes(envelope.TopicArn)) c.env = await resolveRegionRuntime(c.env);
    const trusted = await verifySns(c.env, envelope);
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
    // Mailbox receipt notifications arrive on a separate OpenSend-owned topic and carry no sending account.
    if (c.env.config.inboundTopicArns?.includes(envelope.TopicArn)) {
      const runnable = await acceptInboundNotification(c.env, { topicArn: envelope.TopicArn, region: trusted.region, message });
      if (runnable > 0) try { await c.env.wake?.(runnable); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Mailbox ingestion remains durable.' }); }
      return c.json({ accepted: true }, 202);
    }
    verifySesAccount(c.env, message, envelope.TopicArn);
    const payload = { message, topicArn: envelope.TopicArn, messageId: envelope.MessageId, region: trusted.region };
    const item = { ...payload, message: message as Record<string, unknown> };
    // With a feedback sink (Cloudflare), the verified callback leaves the request path immediately and is
    // ingested in batches by the feedback consumer; nothing here touches the database or the jobs table.
    if (c.env.feedback) {
      await c.env.feedback.enqueue([item]);
      return c.json({ accepted: true }, 202);
    }
    const { error, runnable } = await ingestRoutineSesEvent(c.env, routineInput(item, true));
    if (error === 'SES_ACCOUNT_MISMATCH') throw new ApiError(403, error, 'The SES sending account is missing or does not match this deployment.');
    // SNS retries 5xx, not 4xx. Without a verified owner we cannot store a tenant-scoped recovery job yet.
    if (error) throw new ApiError(503, error, 'The feedback owner is not yet available; retry this notification.', undefined, true);
    if (runnable > 0) try { await c.env.wake?.(runnable); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Feedback recovery and webhook jobs remain durable.' }); }
    return c.json({ accepted: true }, 202);
  });
  // Hono matches HEAD as GET; intercept the original method before the mutating GET route.
  app.use('/unsubscribe/:token', async (c, next) => {
    if (c.req.method === 'HEAD') { c.header('Allow', 'GET, POST'); c.header('Cache-Control', 'no-store'); throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET or POST to unsubscribe.'); }
    await next();
  });
  const tokenParams = z.object({ token: z.string().regex(/^u_[a-f0-9]{64}$/) }).openapi('UnsubscribeToken');
  for (const method of ['get', 'post'] as const) app.openapi(createRoute({ method, path: '/unsubscribe/{token}', operationId: method === 'get' ? 'unsubscribeByLink' : 'unsubscribeOneClick', tags: ['Consent'], security: [], request: { params: tokenParams }, responses: { 200: { description: method === 'get' ? 'Confirmation page; GET never changes consent (link scanners prefetch footer links).' : 'Marketing consent is now unsubscribed (RFC 8058 one-click or the confirmation form).', content: { 'text/html': { schema: z.string().openapi('UnsubscribeConfirmationHtml') } } }, ...errors } }), async c => {
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const [token] = await c.env.db.select().from(unsubscribeTokens).where(eq(unsubscribeTokens.tokenHash, await digest(c.req.valid('param').token))); if (!token) return notFound('Unsubscribe link');
    // Link scanners and mail security gateways fetch every link in a message, so a footer GET only asks for
    // confirmation. Mailbox one-click (RFC 8058, List-Unsubscribe-Post) and the confirmation form are POSTs.
    if (method === 'get') return c.html(unsubscribePage('Unsubscribe from marketing emails?', '<p>You will no longer receive marketing emails from this workspace.</p><form method="post"><input type="hidden" name="confirm" value="footer"><button type="submit" style="font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer">Unsubscribe</button></form>'), 200);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    // The audience helper commits consent, audit, and the subscription event outbox atomically.
    await recordUnsubscribe(c.env, token.workspaceId, token.email, form.confirm === 'footer' ? 'footer-confirm' : 'rfc8058-post');
    return c.html(unsubscribePage('You’re unsubscribed', '<p>You will no longer receive marketing emails from this workspace.</p>'), 200);
  });
}

function unsubscribePage(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>@font-face{font-family:Inter;src:url("/fonts/inter-variable.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}body,body *{letter-spacing:-0.01em}</style><body style="font-family:Inter,Arial,sans-serif;letter-spacing:-0.01em;margin:48px;line-height:1.5"><main><h1 style="font-size:24px">${title}</h1>${body}</main></body></html>`;
}
function registerMetrics(app: App) {
  const query = z.object({ region: z.string().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), stream: z.enum(['transactional', 'marketing']).optional(), granularity: z.enum(['day', 'hour']).default('day') }).openapi('MetricsQuery');
  const bucket = z.object({ date: z.string(), count: z.number(), sent: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number() });
  const schema = z.object({ basis: z.literal('created-cohort'), from: z.string(), to: z.string(), region: z.string().nullable(), stream: z.string().nullable(), totals: z.object({ emails: z.number(), accepted: z.number(), delivered: z.number(), bounced: z.number(), complained: z.number(), opened: z.number(), clicked: z.number(), failed: z.number(), deliveryDelayed: z.number(), simulated: z.number() }), daily: z.array(bucket), hourly: z.array(bucket).optional() }).openapi('Metrics');
  app.openapi(createRoute({ method: 'get', path: '/v1/metrics', operationId: 'getMetrics', description: 'Operational created-cohort metrics, not invoicing or provider reputation. Dashboard sessions may receive results cached for up to 60 seconds; API keys, MCP and agent tokens always get fresh results. Selects emails created in [from,to), scoped by email region and stream. Outcomes use current email state and all recorded events, including events after to; this is not a historical state snapshot. Each outcome counts distinct emails, so replays do not inflate counts and outcomes may overlap. Accepted (bucket sent) means evidence of provider acceptance, not merely queued/created. Daily UTC creation buckets contain count=created emails. Granularity defaults to day; granularity=hour additionally returns hourly UTC creation buckets with canonical ISO dates such as 2026-09-12T01:00:00.000Z, while preserving daily buckets and totals. Absent buckets mean zero created emails and zero outcomes; no moving averages are applied. Engagement is observed, not verified human activity.', tags: ['Metrics'], security, request: { query }, responses: { 200: response(schema), ...errors } }), async c => {
    const a = workspaceActor(c), q = c.req.valid('query'), end = q.to ?? now(), start = q.from ?? new Date(Date.parse(end) - 30 * 86400000).toISOString(); if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new ApiError(422, 'INVALID_DATE_RANGE', 'Metrics require an increasing range of at most 366 days.'); if (q.region) region(c.env, q.region);
    const compute = async () => {
    const filter = and(scoped(emails, a), gte(emails.createdAt, start), lt(emails.createdAt, end), q.region ? eq(emails.region, q.region) : undefined, q.stream ? sql`${emails.snapshot}->>'kind' = ${q.stream}` : undefined);
    const date = q.granularity === 'hour' ? sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"')` : sql<string | null>`to_char(${emails.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    // Outcomes come from the per-email flags kept by the operation_events trigger (migration 031): the same
    // union of public events the old per-query event aggregation produced, without re-reading the events.
    const has = (bit: number) => sql`(${emails.eventOutcomes} & ${bit}) <> 0`;
    const result = await c.env.db.execute<{ date: string; emails: number; accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number; simulated: number }>(sql`
      SELECT ${date} AS "date", count(*)::int AS "emails",
        count(*) FILTER (WHERE NOT ${emails.simulated} AND ${emails.status} <> 'suppressed' AND (${emails.providerId} IS NOT NULL OR ${emails.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${has(OUTCOME.accepted)}))::int AS "accepted",
        count(*) FILTER (WHERE ${emails.status} = 'delivered' OR ${has(OUTCOME.delivered)})::int AS "delivered",
        count(*) FILTER (WHERE ${emails.status} = 'bounced' OR ${has(OUTCOME.bounced)})::int AS "bounced",
        count(*) FILTER (WHERE ${emails.status} = 'complained' OR ${has(OUTCOME.complained)})::int AS "complained",
        count(*) FILTER (WHERE ${has(OUTCOME.opened)})::int AS "opened", count(*) FILTER (WHERE ${has(OUTCOME.clicked)})::int AS "clicked",
        count(*) FILTER (WHERE ${emails.status} IN ('rejected', 'rendering_failed') OR ${has(OUTCOME.failed)})::int AS "failed",
        count(*) FILTER (WHERE ${emails.status} = 'delayed' OR ${has(OUTCOME.delayed)})::int AS "deliveryDelayed",
        count(*) FILTER (WHERE ${emails.simulated})::int AS "simulated"
      FROM ${emails}
      WHERE ${filter}
      GROUP BY 1 ORDER BY 1`);
    // Every email belongs to exactly one creation bucket, so totals are the sum of the buckets (no ROLLUP sort).
    const rows = result.rows;
    const totals = { emails: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0, simulated: 0 };
    for (const row of rows) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += row[key];
    const buckets = rows.map(row => ({ date: row.date!, count: row.emails, sent: row.accepted, delivered: row.delivered, bounced: row.bounced, complained: row.complained }));
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
    return { basis: 'created-cohort' as const, from: start, to: end, region: q.region ?? null, stream: q.stream ?? null, totals, daily, ...(q.granularity === 'hour' ? { hourly: buckets } : {}) };
    };
    // Dashboards poll this aggregate (older builds every 3 s, in every open tab). Dashboard sessions share a
    // 60-second cache per workspace/filters/window; API keys, MCP and agent tokens stay exact.
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    const startMs = Date.parse(start), endMs = Date.parse(end), nowMs = Date.now();
    // "Last N days/hours as of now" windows move every request; bucket them by minute and window length.
    // The Overview's "previous period" ends one window-length ago, so it is relative too: key it by how far back it
    // ends as well, or it never hits the cache.
    const length = endMs - startMs, back = nowMs - endMs;
    const window = Math.abs(back) <= 120_000 || Math.abs(back - length) <= 120_000 ? `rel:${Math.floor(nowMs / 60_000)}:${Math.round(back / 60_000)}:${Math.round(length / 60_000)}` : `abs:${start}:${end}`;
    const body = await cachedMetrics(new URL(c.req.url).origin, [a.workspaceId, q.region ?? '', q.stream ?? '', q.granularity, window].join('|'), compute);
    c.header('x-opensend-metrics-cache', body.hit ? 'hit' : 'miss');
    return c.json(body.value as Awaited<ReturnType<typeof compute>>, 200);
  });
}

// Bits of sending_emails.event_outcomes, set by the operation_events trigger in migration 031.
const OUTCOME = { accepted: 1, delivered: 2, bounced: 4, complained: 8, opened: 16, clicked: 32, failed: 64, delayed: 128 } as const;
const METRICS_CACHE_SECONDS = 60;
const metricsMemory = new Map<string, { expires: number; value: unknown }>();
const metricsInflight = new Map<string, Promise<unknown>>();
// Per-isolate memory first, then the colo-wide Workers Cache API when present (absent on Node).
// Concurrent identical requests in one isolate share a single database query.
async function cachedMetrics(origin: string, key: string, compute: () => Promise<unknown>): Promise<{ value: unknown; hit: boolean }> {
  const now = Date.now(), memory = metricsMemory.get(key);
  if (memory && memory.expires > now) return { value: memory.value, hit: true };
  const pending = metricsInflight.get(key);
  if (pending) return { value: await pending, hit: true };
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const request = new Request(`${origin}/__cache/metrics/${await digest(key)}`);
  const remember = (value: unknown) => {
    if (metricsMemory.size >= 500) metricsMemory.delete(metricsMemory.keys().next().value!);
    metricsMemory.set(key, { expires: Date.now() + METRICS_CACHE_SECONDS * 1000, value });
  };
  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    if (hit) { const value = await hit.json(); remember(value); return { value, hit: true }; }
  }
  const work = compute();
  metricsInflight.set(key, work);
  try {
    const value = await work;
    remember(value);
    if (cache) await cache.put(request, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${METRICS_CACHE_SECONDS}` } })).catch(() => undefined);
    return { value, hit: false };
  } finally { metricsInflight.delete(key); }
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
    const url = webhookUrl(runtime, endpoint.url), secret = await decrypt(runtime, endpoint.encryptedSecret, secretBinding(job, endpoint.id));
    const body = JSON.stringify(eventSchema.parse(delivery.payload)), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmac(secret, `${delivery.eventId}.${timestamp}.${body}`);
    const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Webhook-Id': delivery.eventId, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': `v1,${signature}`, 'User-Agent': 'OpenSend-Webhooks/1.0', ...(delivery.synthetic ? { 'OpenSend-Test': 'true' } : {}) }, body, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    statusCode = result.status; await result.body?.cancel(); if (!result.ok) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < MAX_ATTEMPTS;
  await runtime.db.transaction(async tx => {
    await tx.insert(deliveryAttempts).values({ id: id('wha'), workspaceId: job.workspaceId, deliveryId: delivery.id, statusCode, error, durationMs: Date.now() - start });
    await tx.update(deliveries).set({ attemptCount: sql`${deliveries.attemptCount} + 1`, status: !error ? 'delivered' : retry ? 'pending' : 'failed', lastStatusCode: statusCode, lastError: error, updatedAt: now() }).where(where);
  });
  if (error) throw new ApiError(503, error, 'Webhook delivery failed; inspect the stored delivery attempts.', undefined, retry);
};

function routineInput(item: FeedbackItem, enqueueOther = false): RoutineIngress {
  const data = item.message as Record<string, any>;
  const kind = data?.eventType ?? data?.notificationType;
  const providerId = data?.mail?.messageId;
  const type = kind === 'Send' ? 'send' : kind === 'Delivery' ? 'delivery' : 'receipt';
  const simulated = item.topicArn === `urn:opensend:simulated-ses:${item.region}`;
  if (type === 'receipt' && simulated) throw new ApiError(422, 'SIMULATED_FEEDBACK_UNSUPPORTED', 'The simulator emits Send and Delivery callbacks only.');
  if (typeof providerId !== 'string') throw new ApiError(422, 'SES_INVALID_EVENT', 'SES event lacks a mail.messageId.');
  const timestamp = type !== 'receipt' ? data[type]?.timestamp : undefined;
  const createdAt = typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : now();
  const payload = { message: item.message, topicArn: item.topicArn, messageId: item.messageId, region: item.region };
  return { type, providerId, taggedEmailId: taggedEmailId(item.message), createdAt, externalId: `${item.topicArn}:${item.messageId}`, data: { providerId },
    ingress: { topicArn: item.topicArn, messageId: item.messageId, region: item.region, payload, recoveryType: type === 'receipt' && !enqueueOther ? undefined : simulated ? 'operation.simulatedFeedbackRecovery' : 'operation.ses' } };
}
/**
 * Batch feedback ingestion for the feedback queue consumer. Routine Send/Delivery callbacks are
 * persisted in one statement per batch; everything else (bounce, complaint, engagement,
 * subscription) is processed inline with its receipt. Returns one outcome per input so the caller
 * can acknowledge or retry messages individually. Live items are trusted only after the SNS
 * signature check at ingress; simulated items must carry the simulator's synthetic identity.
 */
export async function ingestFeedbackBatch(runtime: Runtime, items: FeedbackItem[]): Promise<{ ok: boolean; error?: string }[]> {
  const outcomes: { ok: boolean; error?: string }[] = items.map(() => ({ ok: false }));
  const group: { index: number; input: RoutineIngress }[] = [];
  const other: { index: number; item: FeedbackItem; workspaceId: string }[] = [];
  for (const [index, item] of items.entries()) {
    try {
      if (item.topicArn.startsWith('urn:opensend:simulated-ses:')) assertSimulatedFeedback(runtime, item);
      else verifySesAccount(runtime, item.message, item.topicArn);
      group.push({ index, input: routineInput(item) });
    } catch (error) { outcomes[index] = { ok: false, error: error instanceof ApiError ? error.code : 'FEEDBACK_INVALID' }; }
  }
  if (group.length) {
    try {
      const results = await ingestRoutineSesEvents(runtime, group.map(entry => entry.input));
      for (const [position, entry] of group.entries()) {
        const result = results[position]!;
        if (result.error || !result.workspaceId) { outcomes[entry.index] = { ok: false, error: result.error ?? 'SES_EMAIL_NOT_FOUND' }; continue; }
        if (entry.input.type === 'receipt') { other.push({ index: entry.index, item: items[entry.index]!, workspaceId: result.workspaceId }); continue; }
        outcomes[entry.index] = { ok: true };
        log('info', { code: 'SES_FEEDBACK_INGESTED', workspaceId: result.workspaceId, kind: entry.input.type, outcome: result.event ? 'processed' : result.runnable > 0 ? 'deferred' : 'duplicate', runnable: result.runnable });
      }
      // Deferred recoveries and webhook deliveries are jobs; nudge the scheduler once per batch.
      if (results.some(result => result.runnable > 0)) try { await runtime.wake?.(1); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Feedback recovery and webhook jobs remain durable.' }); }
    } catch (error) {
      for (const entry of group) outcomes[entry.index] = { ok: false, error: error instanceof ApiError ? error.code : 'FEEDBACK_PERSIST_FAILED' };
    }
  }
  // The feedback consumer has one connection; finish each non-routine receipt before starting the next.
  for (const { index, item, workspaceId } of other) {
    try {
      await processSesReceipt(runtime, { message: item.message, topicArn: item.topicArn, messageId: item.messageId, region: item.region }, { id: `feedback:${item.topicArn}:${item.messageId}`, attempts: 1, workspaceId });
      outcomes[index] = { ok: true };
    } catch (error) {
      outcomes[index] = { ok: false, error: error instanceof ApiError ? error.code : 'FEEDBACK_PROCESS_FAILED' };
      log(error instanceof ApiError && !error.retryable ? 'warn' : 'error', { code: error instanceof ApiError ? error.code : 'FEEDBACK_PROCESS_FAILED', message: error instanceof ApiError ? error.message : 'Feedback processing failed; the message will be retried.' });
    }
  }
  return outcomes;
}

const processSesReceipt: JobHandler = async (runtime, payload, job) => {
  const receiptWhere = and(scoped(snsReceipts, job), eq(snsReceipts.topicArn, String(payload.topicArn)), eq(snsReceipts.messageId, String(payload.messageId)));
  const data = payload.message as Record<string, any>; const providerId = data?.mail?.messageId;
  if (typeof providerId !== 'string') throw new ApiError(422, 'SES_INVALID_EVENT', 'SES event lacks a mail.messageId.');
  const tagged = taggedEmailId(data);
  const [input] = await runtime.db.select({ receipt: snsReceipts, email: {
    id: emails.id, region: emails.region, to: emails.to, cc: emails.cc, bcc: emails.bcc, simulated: emails.simulated,
  } }).from(snsReceipts).leftJoin(emails, and(scoped(emails, job), eq(emails.region, String(payload.region)), tagged
    // Fallback for a lost provider response: see ingestRoutineSesEvents.
    ? and(eq(emails.id, tagged), or(eq(emails.providerId, providerId), and(isNull(emails.providerId), eq(emails.status, 'acceptance_unknown'))))
    : eq(emails.providerId, providerId))).where(receiptWhere);
  if (!input || input.receipt.processedAt) return;
  const { receipt, email } = input;
  if (!email) throw new ApiError(409, 'SES_EMAIL_NOT_FOUND', 'The SES message is not yet associated with a local email.', undefined, true);
  if (email.simulated !== (payload.topicArn === `urn:opensend:simulated-ses:${payload.region}`)) throw new ApiError(403, 'SES_ENVIRONMENT_MISMATCH', 'Feedback and email simulation modes must match.');
  const kind = String(data.eventType ?? data.notificationType).replace('Rendering Failure', 'RenderingFailure');
  if (kind === 'Subscription') {
    const preferences = data.subscription?.newTopicPreferences;
    // SES topic defaults are not evidence of app-wide opt-in; never reverse local opt-outs from them.
    if (preferences?.unsubscribeAll === true && email.to.length === 1 && !email.cc.length && !email.bcc.length) {
      await recordUnsubscribe(runtime, job.workspaceId, email.to[0]!, 'ses-subscription');
    } else {
      await publishEvent(runtime, { id: `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`, type: 'contact.subscription_changed', createdAt: receipt.createdAt, workspaceId: job.workspaceId, region: email.region, data: { emailId: email.id, source: 'ses', preferences: preferences ?? null, appliedToWorkspaceConsent: false } });
    }
    await runtime.db.update(snsReceipts).set({ processedAt: now() }).where(receiptWhere); return;
  }
  const mapping: Record<string, { type: EventType; rawType: string }> = { Send: { type: 'email.sent', rawType: 'send' }, Delivery: { type: 'email.delivered', rawType: 'delivery' }, Bounce: { type: 'email.bounced', rawType: 'bounce' }, Complaint: { type: 'email.complained', rawType: 'complaint' }, DeliveryDelay: { type: 'email.delivery_delayed', rawType: 'delivery_delay' }, Reject: { type: 'email.rejected', rawType: 'reject' }, RenderingFailure: { type: 'email.rendering_failed', rawType: 'rendering_failure' }, Open: { type: 'email.opened', rawType: 'open' }, Click: { type: 'email.clicked', rawType: 'click' } };
  const mapped = mapping[kind]; if (!mapped) throw new ApiError(422, 'SES_UNSUPPORTED_EVENT', 'Unsupported SES event type.');
  const eventDetail = data[kind === 'RenderingFailure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase()] ?? {};
  const eventTime = typeof eventDetail.timestamp === 'string' && Number.isFinite(Date.parse(eventDetail.timestamp)) ? new Date(eventDetail.timestamp).toISOString() : receipt.createdAt;
  const eventId = `evt_ses_${await digest(`${payload.topicArn}:${payload.messageId}`)}`;
  const normalized: PublishedEvent = { id: eventId, workspaceId: job.workspaceId, region: email.region, type: mapped.type, createdAt: eventTime, data: { emailId: email.id, providerId, ...(kind === 'Open' || kind === 'Click' ? { isBotEvent: eventDetail.isBotEvent ?? 'Unknown' } : {}), ...((kind === 'Bounce') ? { bounceType: eventDetail.bounceType ?? 'Unknown', bounceSubType: eventDetail.bounceSubType ?? 'Unknown' } : {}), ...(kind === 'Click' && typeof eventDetail.link === 'string' ? { link: eventDetail.link } : {}) } };
  // Routine send/delivery events have no later consent or engagement writes.
  // Mark their receipt in the same commit as status, event and webhook fan-out.
  const routine = kind === 'Send' || kind === 'Delivery';
  // SES Auto Validation drops risky recipients before sending and reports each as a Permanent bounce with this subtype.
  // It never left SES, so record it as suppressed (not bounced); the contact is still suppressed below.
  const validationSuppressed = kind === 'Bounce' && eventDetail.bounceSubType === 'EmailValidationSuppressed';
  await recordEmailEvent(runtime, { workspaceId: job.workspaceId, emailId: email.id, providerId, type: validationSuppressed ? 'validation_suppressed' : mapped.rawType,
    ...(validationSuppressed ? { errorCode: 'EMAIL_VALIDATION_SUPPRESSED' } : {}), externalId: `${payload.topicArn}:${payload.messageId}`, data: normalized.data, createdAt: eventTime,
    ...(routine ? { receipt: { topicArn: String(payload.topicArn), messageId: String(payload.messageId) } } : {}),
  });
  if (routine) return;
  const candidates = kind === 'Bounce' ? (data.bounce?.bouncedRecipients ?? []).map((r: any) => r.emailAddress) : kind === 'Complaint' ? (data.complaint?.complainedRecipients ?? []).map((r: any) => r.emailAddress) : (email.to.length === 1 && !email.cc.length && !email.bcc.length ? email.to : []);
  const recipients = candidates.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.toLowerCase()).filter((value: string) => [...email.to, ...email.cc, ...email.bcc].map(v => v.toLowerCase()).includes(value));
  const suppress = kind === 'Complaint' || (kind === 'Bounce' && eventDetail.bounceType === 'Permanent');
  const observeEngagement = (kind === 'Open' || kind === 'Click') && normalized.data.isBotEvent !== true && normalized.data.isBotEvent !== 'Likely';
  if (recipients.length && (suppress || observeEngagement)) await runtime.db.transaction(async tx => {
    for (const address of recipients) {
      const contactWhere = and(scoped(contacts, job), eq(contacts.email, address));
      if (suppress) {
        const suppressionReason = kind === 'Complaint' ? 'complaint' : validationSuppressed ? 'email_validation' : 'hard_bounce';
        await tx.execute(sql`INSERT INTO audience_contacts(id,workspace_id,email,suppressed,suppression_reason)
          VALUES (${id('con')},${job.workspaceId},${address},true,${suppressionReason}) ON CONFLICT ON CONSTRAINT audience_contacts_email_scope
          DO UPDATE SET suppressed=true,suppression_reason=excluded.suppression_reason,updated_at=now()`);
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
  if (String(payload.topicArn).startsWith('urn:opensend:simulated-ses:')) throw new ApiError(403, 'SES_ACCOUNT_MISMATCH', 'Synthetic callbacks are not SNS events.');
  verifySesAccount(runtime, payload.message, String(payload.topicArn));
  await processSesReceipt(runtime, payload, job);
};
function assertSimulatedFeedback(runtime: Runtime, payload: Record<string, unknown>) {
  const message = payload.message as { mail?: { messageId?: unknown } } | undefined;
  if (!isSimulatedSes(runtime) ||
    payload.topicArn !== `urn:opensend:simulated-ses:${payload.region}` ||
    typeof message?.mail?.messageId !== 'string' || !message.mail.messageId.startsWith('sim_')) {
    throw new ApiError(403, 'SIMULATED_FEEDBACK_FORBIDDEN', 'Synthetic feedback requires a simulated deployment and a synthetic provider identity.');
  }
}
const simulatedFeedbackJob: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  const input = routineInput({ topicArn: String(payload.topicArn), messageId: String(payload.messageId), region: String(payload.region), message: payload.message as Record<string, unknown> });
  await ingestRoutineSesEvent(runtime, { ...input, workspaceId: job.workspaceId });
};
const simulatedFeedbackRecovery: JobHandler = async (runtime, payload, job) => {
  assertSimulatedFeedback(runtime, payload);
  await processSesReceipt(runtime, payload, job);
};
const publishJob: JobHandler = async (runtime, payload, job) => {
  const parsed = eventSchema.safeParse(payload.event);
  if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'The queued event is invalid or has mismatched scope.');
  await publishEvent(runtime, parsed.data);
};
const publishBatchJob: JobHandler = async (runtime, payload, job) => {
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 100) throw new ApiError(422, 'INVALID_EVENT_BATCH', 'Event batches must contain between one and 100 events.');
  const batch: PublishedEvent[] = [];
  for (const value of payload.events) {
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId !== job.workspaceId) throw new ApiError(422, 'INVALID_EVENT_JOB', 'A queued batch event is invalid or has mismatched scope.');
    batch.push(parsed.data);
  }
  const unique = batch.filter((event, index) => batch.findIndex(candidate => candidate.id === event.id) === index);
  await runtime.db.transaction(async tx => {
    const inserted = await tx.insert(events).values(unique).onConflictDoNothing().returning({ id: events.id });
    if (!inserted.length) return;
    const accepted = new Set(inserted.map(row => row.id));
    const endpoints = await tx.select().from(webhooks).where(and(scoped(webhooks, unique[0]!), eq(webhooks.paused, false)));
    const queued = unique.filter(event => accepted.has(event.id)).flatMap(event => endpoints.filter(endpoint =>
      endpoint.eventTypes.includes(event.type) && (!endpoint.regions || event.region === null || endpoint.regions.includes(event.region))
    ).map(endpoint => ({ event, endpoint, deliveryId: id('whd') })));
    if (!queued.length) return;
    for (let offset = 0; offset < queued.length; offset += 1000) {
      const group = queued.slice(offset, offset + 1000);
      await tx.insert(deliveries).values(group.map(({ event, endpoint, deliveryId }) => ({ id: deliveryId, workspaceId: event.workspaceId, webhookId: endpoint.id, eventId: event.id, payload: event })));
      await tx.insert(jobs).values(group.map(({ event, deliveryId }) => ({ id: id('job'), type: 'operation.webhook', workspaceId: event.workspaceId, payload: { deliveryId, generation: 0 } })));
    }
  });
};
export const operationJobs: Record<string, JobHandler> = { 'domain.verify': retryDatabaseFailures(domainVerify), 'domain.mx': retryDatabaseFailures(domainMx), 'operation.webhook': retryDatabaseFailures(webhookJob), 'operation.ses': retryDatabaseFailures(sesJob), 'operation.simulatedFeedback': retryDatabaseFailures(simulatedFeedbackJob), 'operation.simulatedFeedbackRecovery': retryDatabaseFailures(simulatedFeedbackRecovery), 'operation.publish': retryDatabaseFailures(publishJob), 'operation.publishBatch': retryDatabaseFailures(publishBatchJob) };
