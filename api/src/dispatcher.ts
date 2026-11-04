import { getTableColumns, sql } from 'drizzle-orm';
import { GetAccountCommand, SendEmailCommand, type Attachment, type SESv2Client, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { ApiError, getSes, isSimulatedSes, id, log, type Actor, type DbExecutor, type Runtime } from './core.js';
import { attachments, emails, type EmailSnapshot, type EmailStatus, type CampaignDraft, type ReviewedRecipient } from './db/sending.js';
import { approvedOriginUser, checkedDispatchAttachments, finishEmailCampaign, formattedSender, inlineMessage, materializeCampaignEmail, originAllowed, publicEventType, queueSimulatedFeedback, rank, sizeCheck, statusForEvent, verifiedAttachment } from './sending.js';
import { sendingConnections, verifiedClaim } from './domain-claims.js';
import { ensureTenant } from './provider-connections.js';
import { credentialFingerprint, discoveryTarget } from './ses-region-state.js';
import { POOL_INSTALLATION, setupResources } from './ses-setup.js';
import type { ReadyConnection } from './provider-credentials.js';
import { simulatedSes } from './adapters/simulated-ses.js';
import { screenSnapshot } from './screen.js';

// The dispatcher is a long-lived loop, hosted by a Durable Object on Cloudflare and by the
// runner process on Node. PostgreSQL remains the only source of truth: a row is sent at most
// once because the batched claim flips it queued → attempting under its dispatch_version.
// Provider pacing lives in process memory (one shard owns one share of the regional quota),
// so the hot path costs three database statements per batch rather than ten per email.

export type Mail = typeof emails.$inferSelect;
type Review = { draft: CampaignDraft; rendered: { html?: string; text?: string }; status: string | null; contentHash: string | null; recipient: ReviewedRecipient };
type Owner = { runtime: Runtime; a: Actor; ses: SESv2Client; tenantName?: string; feedbackTopic?: string };
type Leased = { mail: Mail; review: Review | null; owner: Owner | null };
type Prepared = Leased & { owner: Owner; snapshot: EmailSnapshot; content: SendEmailCommandInput['Content']; unsubscribe?: { tokenHash: string; email: string }; stored?: EmailSnapshot };
type Outcome = { mail: Mail; type: 'accepted' | 'reject' | 'acceptance_unknown' | 'provider_throttled'; providerId?: string; errorCode?: string; data: Record<string, unknown>; requeueAt?: string };

export interface QuotaSnapshot { maxSendRate: number; max24HourSend: number; sentLast24Hours: number; checkedAt: number }
// Serializable pacing state so a Durable Object survives eviction without bursting.
export interface GateState { nextAllowedAt: number; quota: QuotaSnapshot | null; sentSinceRefresh: number; brakeUntil?: number }
export const initialGate = (): GateState => ({ nextAllowedAt: 0, quota: null, sentSinceRefresh: 0 });
export type Pacing = { rateFactor: number; targetRate?: number; live: boolean };
const BRAKE_MS = 10000;

export interface DispatcherOptions {
  region: string; accountId?: string;
  /** Emails claimed per database round trip. */
  batchSize?: number;
  /** Provider requests in flight per loop; Workers allow six connections awaiting headers. */
  sendConcurrency?: number;
  /** Independent claim→send→record pipelines sharing the gate; keeps the provider busy while a batch is being recorded. */
  lanes?: number;
  /** This shard's share of the regional quota: 1/count. */
  shard?: { index: number; count: number };
  gate?: GateState;
  onGate?: (state: GateState) => void | Promise<void>;
  /** Stop claiming new batches after this epoch millisecond; in-flight batches always finish. */
  until?: number;
  /** Refresh quota from the provider at most this often. */
  quotaRefreshMs?: number;
}
export interface DispatcherReport { claimed: number; sent: number; deferred: number; skipped: number; batches: number; idle: boolean; durationMs: number; timings: Record<string, number>; statements: number }

// Timestamps are cast to text so raw rows match Drizzle's string-mode timestamp columns.
const mailColumns = Object.entries(getTableColumns(emails)).map(([key, column]) => sql`leased.${sql.identifier(column.name)}${column.columnType.startsWith('PgTimestamp') ? sql`::text` : sql``} AS ${sql.identifier(key)}`);
let rankJsonCache: string | undefined;
const rankJson = () => rankJsonCache ??= JSON.stringify(rank);

function semaphore(limit: number) {
  let active = 0; const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await work(); } finally { active--; waiting.shift()?.(); }
  };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function providerClient(runtime: Runtime, region: string, connection?: ReadyConnection): SESv2Client {
  return isSimulatedSes(runtime) ? simulatedSes(runtime, region) : getSes(runtime, region, connection);
}
async function fetchQuota(ses: SESv2Client): Promise<QuotaSnapshot> {
  const account = await ses.send(new GetAccountCommand({})), quota = account.SendQuota;
  if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.MaxSendRate <= 0 || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
  return { maxSendRate: quota.MaxSendRate, max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours, checkedAt: Date.now() };
}
// Self-hosted workspace cache.
async function ensureQuota(runtime: Runtime, a: Actor, region: string, gate: GateState, ses: SESv2Client, refreshMs: number) {
  if (gate.quota && Date.now() - gate.quota.checkedAt <= refreshMs) return false;
  const cached = await runtime.db.execute<{ max_send_rate: number; max_24_hour_send: number; sent_last_24_hours: number; checked_at: string }>(sql`
    SELECT max_send_rate, max_24_hour_send, sent_last_24_hours, checked_at::text FROM sending_region_limits
    WHERE workspace_id = ${a.workspaceId} AND region = ${region} AND checked_at > clock_timestamp() - (${refreshMs}::int * interval '1 millisecond')`);
  const row = cached.rows[0];
  if (row && Number(row.max_send_rate) > 0) {
    // A cached row without a daily figure (0) means unknown, not exhausted; SES enforces the real cap.
    gate.quota = { maxSendRate: Number(row.max_send_rate), max24HourSend: Number(row.max_24_hour_send) || -1, sentLast24Hours: Number(row.sent_last_24_hours) || 0, checkedAt: Date.parse(row.checked_at) };
    gate.sentSinceRefresh = 0;
    return true;
  }
  const quota = await fetchQuota(ses);
  await runtime.db.execute(sql`INSERT INTO sending_region_limits (workspace_id, region, max_send_rate, max_24_hour_send, sent_last_24_hours, reserved, checked_at)
    VALUES (${a.workspaceId}, ${region}, ${quota.maxSendRate}, ${quota.max24HourSend}, ${quota.sentLast24Hours}, 0, clock_timestamp())
    ON CONFLICT ON CONSTRAINT sending_region_limits_pkey DO UPDATE SET max_send_rate = excluded.max_send_rate, max_24_hour_send = excluded.max_24_hour_send,
      sent_last_24_hours = excluded.sent_last_24_hours, reserved = 0, next_allowed_at = NULL, checked_at = excluded.checked_at
    WHERE sending_region_limits.checked_at IS NULL OR sending_region_limits.checked_at <= clock_timestamp() - (${refreshMs}::int * interval '1 millisecond')`);
  gate.quota = quota; gate.sentSinceRefresh = 0;
  return true;
}

// Elect the refresher BEFORE GetAccount, across all DOs/lanes for this account. A failed or
// interrupted fetch keeps its fence until the next cache period; no DB lock is held over AWS I/O.
async function ensureAccountQuota(owner: Owner, account: string, region: string, gate: GateState, refreshMs: number) {
  const { runtime, ses } = owner;
  const key = sql`aws_account_id=${account} AND region=${region}`;
  const period = sql`(${Math.max(1000, refreshMs)}::int * interval '1 millisecond')`;
  type Row = { fence: string | null; checked: string; rate: number; max: number; sent: number };
  const cached = sql`SELECT NULL::text AS fence, checked_at::text AS checked, max_send_rate AS rate, max_24_hour_send AS max, sent_last_24_hours AS sent
    FROM provider_account_limits WHERE ${key} AND checked_at > clock_timestamp()-${period}`;
  const result = await runtime.db.execute<Row>(sql`WITH elected AS (
    INSERT INTO provider_account_limits(aws_account_id,region,refresh_after) VALUES (${account},${region},clock_timestamp()+${period})
    ON CONFLICT ON CONSTRAINT provider_account_limits_pkey DO UPDATE SET refresh_after=clock_timestamp()+${period} WHERE provider_account_limits.refresh_after <= clock_timestamp()
    RETURNING refresh_after::text AS fence)
    SELECT fence,NULL::text AS checked,NULL::float8 AS rate,NULL::float8 AS max,NULL::float8 AS sent FROM elected UNION ALL ${cached} LIMIT 1`);
  let row = result.rows[0];
  if (row?.fence) {
    const q = await fetchQuota(ses);
    const saved = await runtime.db.execute(sql`UPDATE provider_account_limits SET checked_at=clock_timestamp(), refresh_after=clock_timestamp()+${period},
      max_send_rate=${q.maxSendRate},max_24_hour_send=${q.max24HourSend},sent_last_24_hours=${q.sentLast24Hours} WHERE ${key} AND refresh_after=${row.fence}::timestamptz`);
    if (!saved.rowCount) return false;
    gate.quota = q;
  } else {
    // A concurrent shard won a cold refresh. Give its single control-plane request time to publish.
    for (const delay of [100, 400, 1000]) {
      if (row) break;
      await sleep(delay); row = (await runtime.db.execute<Row>(cached)).rows[0];
    }
    if (!row) return false;
    gate.quota = { maxSendRate: row.rate, max24HourSend: row.max, sentLast24Hours: row.sent, checkedAt: Date.parse(row.checked) };
  }
  gate.sentSinceRefresh = 0;
  return true;
}

/**
 * Target recipients per second for this shard. The provider quota is the base; DISPATCH_RATE_FACTOR
 * (or an absolute live DISPATCH_TARGET_RATE) aims above or below it, and a recent throttled response
 * brakes back to the raw quota so an aggressive target cannot spiral into retries.
 */
export function shardRate(gate: GateState, shard?: { index: number; count: number }, pacing?: Pacing) {
  const quota = gate.quota?.maxSendRate ?? 0;
  const braked = (gate.brakeUntil ?? 0) > Date.now();
  let target = quota;
  if (pacing && !braked) target = pacing.live && pacing.targetRate ? pacing.targetRate : quota * pacing.rateFactor;
  return shard && shard.count > 1 ? Math.max(0.01, target / shard.count) : target;
}
/** Reserves `recipients` slots and returns how long the caller must wait before sending them. Slots are spaced evenly at the target rate. */
export function reserve(gate: GateState, recipients: number, shard?: { index: number; count: number }, pacing?: Pacing): number {
  const rate = shardRate(gate, shard, pacing);
  if (rate <= 0) return 1000;
  const start = Math.max(Date.now(), gate.nextAllowedAt);
  gate.nextAllowedAt = start + Math.ceil(1000 * recipients / rate);
  gate.sentSinceRefresh += recipients;
  return Math.max(0, start - Date.now());
}
/** A throttled provider response: fall back to the raw quota for a while and yield the slots we ran ahead by. */
export function brake(gate: GateState) {
  gate.brakeUntil = Date.now() + BRAKE_MS;
  gate.nextAllowedAt = Math.max(gate.nextAllowedAt, Date.now() + 1000);
}
function dailyRemaining(gate: GateState) {
  const quota = gate.quota;
  if (!quota || quota.max24HourSend < 0) return Number.POSITIVE_INFINITY;
  return quota.max24HourSend - quota.sentLast24Hours - gate.sentSinceRefresh;
}

// One statement leases the oldest due mail for this region and returns it with its frozen review inputs.
type DeferredStream = { workspace_id: string; stream: EmailSnapshot['kind'] };
async function leaseDue(runtime: Runtime, region: string, limit: number, deferred: DeferredStream[], accountId?: string): Promise<Leased[]> {
  const queued = sql`region = ${region} AND status = 'queued'`;
  const available = sql`(scheduled_at IS NULL OR scheduled_at <= clock_timestamp()) AND (lease_until IS NULL OR lease_until < clock_timestamp())`;
  const priority = sql`ORDER BY (campaign_id IS NULL) DESC, created_at, id`;
  const dueForOwner = sql`FROM sending_emails e WHERE ${queued} AND e.workspace_id = o.workspace_id AND ${available}
    ${deferred.length ? sql`AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(deferred)}::jsonb) d(workspace_id text, stream text)
      WHERE d.workspace_id = e.workspace_id AND d.stream = e.snapshot->>'kind')` : sql``}`;
  // Seek to the next distinct owner rather than scanning a large campaign to discover its neighbors.
  // Interleaving the bounded owner queues by turn gives every active owner a slot before any gets two.
  const mx = runtime.config.multiTenant;
  const ownersSql = mx ? sql`SELECT workspace_id FROM ${sendingConnections(runtime)} WHERE region=${region} AND aws_account_id=${accountId}` : sql`
      (SELECT workspace_id FROM sending_emails WHERE ${queued} ORDER BY workspace_id LIMIT 1)
      UNION ALL SELECT n.workspace_id FROM owners o CROSS JOIN LATERAL (
        SELECT workspace_id FROM sending_emails WHERE ${queued} AND workspace_id > o.workspace_id ORDER BY workspace_id LIMIT 1
      ) n`;
  const result = await runtime.db.execute<Record<string, unknown>>(sql`WITH RECURSIVE owners(workspace_id) AS (${ownersSql}), candidates AS (
      SELECT o.workspace_id, row_number() OVER (ORDER BY q.turn, q.direct DESC, q.created_at, q.id) AS place FROM owners o CROSS JOIN LATERAL (
        SELECT id, (campaign_id IS NULL) AS direct, created_at, row_number() OVER (${priority}) AS turn
        ${dueForOwner} ${priority} LIMIT ${limit}
      ) q
    ), shares AS MATERIALIZED (
      SELECT workspace_id, count(*) AS candidates, greatest(1, count(*) FILTER (WHERE place <= ${limit})) AS slots
      FROM candidates GROUP BY workspace_id ORDER BY min(place)
    ), allocated AS MATERIALIZED (
      -- Allocate slots, not IDs: a competing shard can hold this owner's entire first page.
      -- Lock the next available rows in index order; later owners can fill slots skipped under contention.
      SELECT o.workspace_id, e.id FROM shares o CROSS JOIN LATERAL (
        SELECT id ${dueForOwner} ${priority} LIMIT o.slots FOR UPDATE SKIP LOCKED
      ) e LIMIT ${limit}
    ), due AS (
      -- Consume the fair allocation first. A full lease skips the fallback; a short one only
      -- revisits owners with candidates beyond their share. Our own locks are not SKIPped.
      SELECT workspace_id, id FROM allocated UNION ALL
      SELECT o.workspace_id, e.id FROM shares o CROSS JOIN LATERAL (
        SELECT id ${dueForOwner} AND e.id NOT IN (SELECT id FROM allocated)
        ${priority} LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) e WHERE o.candidates > o.slots LIMIT ${limit}
    ), leased AS (
      UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes' FROM due WHERE e.workspace_id = due.workspace_id AND e.id = due.id RETURNING e.*
    ), settings AS MATERIALIZED (
      SELECT p.*, s.installation_id, s.default_region, s.enabled_regions, ${mx ? sql`to_jsonb(pc)` : sql`NULL`} AS connection, ${mx || isSimulatedSes(runtime) ? sql`true` : sql`(
        d.report->'provisioned' = 'true'::jsonb AND d.report #> '{account,sendingEnabled}' = 'true'::jsonb
        AND d.credentials_fingerprint = ${await credentialFingerprint(runtime.config)} AND d.public_url = ${discoveryTarget(runtime.config)}
        AND d.trusted_account_id = d.report #>> '{account,id}' AND d.trusted_topic_arn = d.report #>> '{resources,topic,arn}'
        AND d.report->'resources'->p.stream->'sendingEnabled' = 'true'::jsonb)`} AS ready
      FROM (SELECT DISTINCT workspace_id, snapshot->>'kind' AS stream FROM leased) p
      LEFT JOIN ses_installation_settings s USING (workspace_id)
      ${mx ? sql`JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id=p.workspace_id AND pc.region=${region} AND pc.aws_account_id=${accountId}` : !isSimulatedSes(runtime) ? sql`LEFT JOIN ses_region_discovery d ON d.workspace_id = p.workspace_id AND d.region = ${region}` : sql``}
    ) SELECT ${sql.join(mailColumns, sql`, `)}, s.installation_id, s.default_region, s.enabled_regions, s.ready, s.connection,
      r.draft AS review_draft, r.rendered AS review_rendered, r.status AS review_status, rr.content_hash AS review_content_hash, rr.recipient AS review_recipient
    FROM leased
    JOIN settings s ON s.workspace_id = leased.workspace_id AND s.stream = leased.snapshot->>'kind'
    LEFT JOIN sending_campaign_reviews r ON r.id = leased.review_id AND r.campaign_id = leased.campaign_id AND r.workspace_id = leased.workspace_id
    LEFT JOIN sending_review_recipients rr ON rr.review_id = leased.review_id AND rr.ordinal = leased.review_ordinal
    ORDER BY (leased.campaign_id IS NULL) DESC, leased.created_at, leased.id`);
  const owners = new Map<string, Owner>();
  const unready = new Set<string>(), checked = new Set<string>();
  if (mx && !isSimulatedSes(runtime)) for (const {connection,workspaceId} of result.rows) {
    const pc=connection as ReadyConnection & {tenant_provisioned:boolean};
    if (pc.kind==='shared' && !pc.tenant_provisioned && !checked.has(pc.id)) {
      checked.add(pc.id);
      try { await ensureTenant(runtime,String(workspaceId),pc.id); }
      catch (error) { unready.add(pc.id); log('warn',{operation:'dispatch-tenant-setup',workspaceId,code:error instanceof ApiError ? error.code : 'TENANT_SETUP_FAILED'}); }
    }
  }
  return result.rows.map(row => {
    const { review_draft, review_rendered, review_status, review_content_hash, review_recipient, installation_id, default_region, enabled_regions, ready:regionReady, connection, ...fields } = row;
    const ready=regionReady && !unready.has((connection as ReadyConnection | null)?.id ?? '');
    const mail = fields as Mail, { workspaceId } = mail;
    if (installation_id == null) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
    let owner = owners.get(workspaceId);
    if (!ready) {
      const stream = mail.snapshot.kind;
      if (!deferred.some(d => d.workspace_id === workspaceId && d.stream === stream)) {
        deferred.push({ workspace_id: workspaceId, stream });
        log('warn', { code: 'SES_SETUP_REQUIRED', workspaceId, region, stream });
      }
    } else if (!owner) {
      const pc = connection as (ReadyConnection & { feedback_topic_arn: string }) | undefined;
      const { transactional, marketing } = setupResources(pc?.kind === 'shared' ? POOL_INSTALLATION : pc?.id ?? installation_id as string);
      const scoped = { ...runtime, config: { ...runtime.config, workspaceId, regions: [default_region as string, ...(enabled_regions as string[]).filter(r => r !== default_region)], configurationSets: { transactional, marketing } } };
      owner = { runtime: scoped, a: { workspaceId, keyId: 'worker', domains: [], permissions: ['manage'] }, ses: providerClient(scoped, region, pc), tenantName: pc?.kind === 'shared' ? `opensend-${workspaceId}` : undefined, feedbackTopic: pc?.feedback_topic_arn };
      owners.set(workspaceId, owner);
    }
    return { mail, owner: ready ? owner! : null, review: review_draft && review_rendered && review_recipient ? { draft: review_draft as CampaignDraft, rendered: review_rendered as Review['rendered'], status: review_status as string | null, contentHash: review_content_hash as string | null, recipient: review_recipient as ReviewedRecipient } : null };
  });
}

// A screen rejection carries its verdict into the reject event.
class ScreenRejected extends ApiError {
  constructor(public screen: { spam: number; model: string; threshold: number }) { super(422, 'CONTENT_REJECTED_SPAM', 'The content classifier judged this message to be unsolicited advertising.'); }
}
let screenSkipLoggedAt = 0;
// Opt-in Jev screen for live transactional mail. It fails open: a classifier outage must never stop transactional mail.
async function screenMail(runtime: Runtime, mail: Mail, s: EmailSnapshot) {
  const settings = runtime.config.screen;
  if (!settings) {
    if (Date.now() - screenSkipLoggedAt >= 60000) { screenSkipLoggedAt = Date.now(); log('warn', { code: 'CONTENT_SCREEN_SKIPPED', emailId: mail.id, message: 'screen requested but TYPESAFE_API_KEY is not configured' }); }
    return;
  }
  let result: Awaited<ReturnType<typeof screenSnapshot>>;
  try { result = await screenSnapshot(runtime, s); }
  catch (error) {
    log('warn', { code: 'CONTENT_SCREEN_UNAVAILABLE', emailId: mail.id, message: error instanceof ApiError ? error.message : 'The content classifier failed; sending unscreened.' });
    return;
  }
  if (!result || result.spam < settings.threshold) return;
  if (settings.mode === 'reject') throw new ScreenRejected({ spam: result.spam, model: result.model, threshold: settings.threshold });
  log('warn', { code: 'CONTENT_SPAM_SUSPECTED', emailId: mail.id, spam: result.spam, model: result.model });
}

type AttachmentRow = typeof attachments.$inferSelect;
function batchAttachments(runtime: Runtime, batch: Leased[]) {
  const wanted = batch.flatMap(({ mail }) => mail.snapshot.attachments.map(id => ({ workspace_id: mail.workspaceId, id })));
  let rows: Promise<AttachmentRow[]> | undefined;
  return async (mail: Mail) => {
    if (!mail.snapshot.attachments.length) return [];
    rows ??= runtime.db.select().from(attachments).where(sql`(${attachments.workspaceId}, ${attachments.id}) IN (SELECT workspace_id, id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) AS x(workspace_id text, id text))`).orderBy(attachments.id).execute();
    return (await rows).filter(row => row.workspaceId === mail.workspaceId && mail.snapshot.attachments.includes(row.id));
  };
}
async function prepareMail(leased: Leased & { owner: Owner }, loadAttachments: (mail: Mail) => Promise<AttachmentRow[]>): Promise<Prepared> {
  const { runtime, a } = leased.owner;
  let mail = leased.mail;
  if (mail.simulated && !isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'This message was queued for simulated delivery. Submit it again to send through SES.');
  let rows: AttachmentRow[] | undefined;
  let unsubscribe: Prepared['unsubscribe'];
  let stored: Prepared['stored'];
  if (mail.snapshot.deferredCampaign) {
    const materialized = await materializeCampaignEmail(runtime, a, mail, leased.review, await loadAttachments(mail));
    mail = materialized.mail; rows = materialized.rows; unsubscribe = materialized.unsubscribe; stored = materialized.stored;
  }
  const s = mail.snapshot;
  if(leased.owner.tenantName && s.raw) throw new ApiError(422,'SHARED_RAW_UNSUPPORTED','Hosted sending requires structured SES content.');
  if (s.screen && !isSimulatedSes(runtime) && s.kind === 'transactional') await screenMail(runtime, mail, s);
  const parts: Attachment[] = [];
  rows ??= checkedDispatchAttachments(s.attachments, await loadAttachments(mail));
  for (const row of rows) { const body = await verifiedAttachment(runtime, row); parts.push({ FileName: row.filename, RawContent: body, ContentType: row.contentType, ContentDisposition: row.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(row.contentId ? { ContentId: row.contentId } : {}) }); }
  sizeCheck(s, rows);
  const content: SendEmailCommandInput['Content'] = s.raw
    ? { Raw: { Data: new TextEncoder().encode(s.raw) } }
    : !leased.owner.tenantName && s.html && parts.some(part => part.ContentDisposition === 'INLINE')
      ? { Raw: { Data: inlineMessage(s, parts) } }
      : { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } };
  return { ...leased, mail, snapshot: s, content, unsubscribe, stored };
}

// Preflight failures (storage, rendering, hash mismatch) cannot have sent email: reject the row.
async function rejectPreflight(runtime: Runtime, a: Actor, mail: Mail, error: unknown) {
  const code = error instanceof ApiError ? error.code : 'DISPATCH_PREFLIGHT_FAILED';
  const retryable = error instanceof ApiError ? error.retryable : true;
  if (retryable) {
    // Transient dependency failure: release the lease with a short backoff and let the loop retry.
    await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = NULL, scheduled_at = greatest(coalesce(scheduled_at, clock_timestamp()), clock_timestamp() + interval '15 seconds'), error_code = ${code}, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion}`);
    log('warn', { code, emailId: mail.id, message: 'Dispatch preflight failed; retrying after a short delay.' });
    return;
  }
  await runtime.db.execute(sql`WITH rejected AS (
      UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
      WHERE workspace_id = ${mail.workspaceId} AND id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} RETURNING id
    ) INSERT INTO sending_email_events(id, workspace_id, email_id, type, external_id, simulated, data)
    SELECT ${id('event')}, ${a.workspaceId}, id, 'reject', ${`preflight-failed:${mail.id}`}, ${isSimulatedSes(runtime)}::boolean, ${JSON.stringify({ code, providerCalled: false, ...(error instanceof ScreenRejected ? { screen: error.screen } : {}) })}::jsonb FROM rejected ON CONFLICT DO NOTHING`);
  // Screen rejections are an expected policy outcome, not a dispatcher fault.
  if (error instanceof ScreenRejected) log('warn', { code, emailId: mail.id, spam: error.screen.spam, model: error.screen.model });
  else log('error', { code, emailId: mail.id, message: error instanceof ApiError ? error.message : 'Unexpected dispatch preflight failure.' });
  await finishEmailCampaign(runtime, a, mail);
}

// OAuth grant decoding, original scopes and client/resource policy stay in the MCP verifier.
// All other origins are checked under the claim's locks, including permission/domain changes.
const mcpOrigin = (item: Prepared) => `${item.mail.workspaceId}\u0000${item.mail.actorKeyId}\u0000${!!item.mail.campaignId}\u0000${item.snapshot.from.split('@')[1]!.toLowerCase()}`;
async function originDecisions(prepared: Prepared[], db: DbExecutor) {
  const grants = new Map<string, boolean>();
  for (const item of prepared) if (item.mail.actorKeyId.startsWith('mcp_') && !grants.has(mcpOrigin(item))) {
    const runtime = item.owner.runtime;
    grants.set(mcpOrigin(item), await originAllowed(runtime, db, { ...item.mail, snapshot: item.snapshot }));
  }
  return grants;
}

// One statement elects every row in the group: key revocation under FOR SHARE, consent locks, campaign
// cancellation, unsubscribe tokens and attempt events. Rows flip queued → attempting here, so the group
// is kept to the provider in-flight width: a platform reset can only strand what was actually mid-call.
async function claimGroup(runtime: Runtime, prepared: Prepared[], origins: Map<string, boolean>, db: DbExecutor = runtime.db): Promise<Map<string, EmailStatus>> {
  const input = prepared.map(item => ({
    id: item.mail.id, workspace_id: item.mail.workspaceId, dispatch_version: item.mail.dispatchVersion, campaign_id: item.mail.campaignId,
    actor_key_id: item.mail.actorKeyId, sender: item.snapshot.from.toLowerCase(), mcp_allowed: item.mail.actorKeyId.startsWith('mcp_') && origins.get(mcpOrigin(item)) === true,
    feedback_topic: item.owner.feedbackTopic, destinations: [...item.snapshot.to, ...item.snapshot.cc, ...item.snapshot.bcc].map(email => email.toLowerCase()),
    marketing: item.snapshot.kind === 'marketing', snapshot: item.unsubscribe ? item.stored ?? null : null,
    token_hash: item.unsubscribe?.tokenHash ?? null, token_email: item.unsubscribe?.email ?? null,
    event_id: id('event'), external_id: `attempt-start:${item.mail.id}:${item.mail.dispatchVersion}`, attempt: item.mail.dispatchVersion + 1,
  }));
  const claimed = await db.execute<{ id: string; status: EmailStatus }>(sql`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(id text, workspace_id text, dispatch_version int, campaign_id text, actor_key_id text, sender text, mcp_allowed boolean, feedback_topic text, destinations jsonb, marketing boolean, snapshot jsonb, token_hash text, token_email text, event_id text, external_id text, attempt int)
    ), key_state AS MATERIALIZED (
      SELECT id, workspace_id, permissions, domains FROM api_keys WHERE revoked_at IS NULL
        AND (workspace_id, id) IN (SELECT workspace_id, actor_key_id FROM input) FOR SHARE
    ), campaign_state AS MATERIALIZED (
      SELECT id, workspace_id, status FROM sending_campaigns WHERE (workspace_id, id) IN (SELECT workspace_id, campaign_id FROM input WHERE campaign_id IS NOT NULL) FOR SHARE
    ), dest AS (
      SELECT x.id AS email_id, x.workspace_id, d.value AS email FROM input x, jsonb_array_elements_text(x.destinations) d
    ), consent AS MATERIALIZED (
      SELECT workspace_id, email, suppressed, deleted_at, marketing_consent FROM audience_contacts
      WHERE (workspace_id, email) IN (SELECT workspace_id, email FROM dest)
      ORDER BY id FOR UPDATE
    ), eligibility AS MATERIALIZED (
      SELECT x.id,
        CASE WHEN starts_with(x.actor_key_id, 'mcp_') THEN x.mcp_allowed
          WHEN starts_with(x.actor_key_id, 'user_') THEN EXISTS (${approvedOriginUser(runtime, sql`x.workspace_id`, sql`substr(x.actor_key_id, 6)`, sql`x.campaign_id IS NULL`)})
          WHEN starts_with(x.actor_key_id, 'mbk_') THEN EXISTS (
            SELECT 1 FROM mailbox_keys k JOIN mailbox_addresses b ON b.workspace_id = k.workspace_id AND b.address = x.sender
            WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id AND k.revoked_at IS NULL AND k.permissions ? 'send'
              AND (k.mailbox_ids IS NULL OR k.mailbox_ids ? b.mailbox_id) FOR SHARE OF k, b)
          ELSE EXISTS (SELECT 1 FROM key_state k WHERE k.workspace_id = x.workspace_id AND k.id = x.actor_key_id
            AND (k.permissions ? 'manage' OR k.permissions ? 'send') AND (k.domains = '[]'::jsonb OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(k.domains) d WHERE split_part(x.sender, '@', 2) = lower(d.value)
                OR right(split_part(x.sender, '@', 2), length(d.value) + 1) = '.' || lower(d.value)))) END
          ${runtime.config.multiTenant ? sql`AND ${verifiedClaim(sql`x.workspace_id`, sql`${prepared[0]!.mail.region}`, sql`split_part(x.sender, '@', 2)`,runtime)}` : sql``} AS origin_ok,
        (x.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_state c WHERE c.workspace_id = x.workspace_id AND c.id = x.campaign_id AND c.status <> 'canceled')) AS campaign_allowed,
        NOT EXISTS (SELECT 1 FROM dest d LEFT JOIN consent c USING (workspace_id, email)
          WHERE d.email_id = x.id AND (c.suppressed IS TRUE OR (x.marketing AND (c.email IS NULL OR c.deleted_at IS NOT NULL OR c.marketing_consent <> 'subscribed')))) AS recipient_allowed
      FROM input x
    ), claimed AS (
      UPDATE sending_emails e SET simulated = ${isSimulatedSes(runtime)},
        status = CASE WHEN NOT el.origin_ok OR NOT el.campaign_allowed THEN 'canceled' WHEN el.recipient_allowed THEN 'attempting' ELSE 'suppressed' END,
        attempt_started_at = CASE WHEN el.origin_ok AND el.campaign_allowed AND el.recipient_allowed THEN clock_timestamp() ELSE e.attempt_started_at END,
        error_code = CASE WHEN NOT el.origin_ok THEN 'ORIGIN_KEY_REVOKED' WHEN NOT el.campaign_allowed THEN 'CAMPAIGN_CANCELED' WHEN el.recipient_allowed THEN e.error_code ELSE 'RECIPIENT_INELIGIBLE' END,
        ${runtime.config.multiTenant && !isSimulatedSes(runtime) ? sql`feedback_topic_arn=x.feedback_topic,` : sql``} snapshot = coalesce(x.snapshot, e.snapshot), lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN eligibility el ON el.id = x.id
      WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.status = 'queued' AND e.dispatch_version = x.dispatch_version
      RETURNING e.id, e.workspace_id, e.status
    ), token AS (
      INSERT INTO operation_unsubscribe_tokens(token_hash, workspace_id, email)
      SELECT x.token_hash, c.workspace_id, x.token_email FROM claimed c JOIN input x ON x.id = c.id WHERE x.token_hash IS NOT NULL AND c.status = 'attempting'
      ON CONFLICT DO NOTHING
    ), attempt AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, external_id, simulated, data)
      SELECT x.event_id, c.workspace_id, c.id, 'dispatch_attempt', x.external_id, ${isSimulatedSes(runtime)}::boolean,
        jsonb_build_object('attempt', x.attempt, 'providerCallPlanned', true, 'providerCallSimulated', ${isSimulatedSes(runtime)}::boolean)
      FROM claimed c JOIN input x ON x.id = c.id WHERE c.status = 'attempting' ON CONFLICT DO NOTHING
    ), suppressed AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, external_id, simulated)
      SELECT x.event_id, c.workspace_id, c.id, 'suppressed', 'suppressed:' || c.id, ${isSimulatedSes(runtime)}::boolean
      FROM claimed c JOIN input x ON x.id = c.id WHERE c.status = 'suppressed' ON CONFLICT DO NOTHING
    ) SELECT id, status FROM claimed`);
  return new Map(claimed.rows.map(row => [row.id, row.status]));
}

// Scheduled campaigns become "sending" on their first claim; a plain UPDATE avoids the shared-lock
// upgrade that concurrent shards would otherwise deadlock on.
async function activateCampaigns(runtime: Runtime, campaigns: { workspace_id: string; id: string }[]) {
  await runtime.db.execute(sql`UPDATE sending_campaigns SET status = 'sending', updated_at = clock_timestamp()
    WHERE status = 'scheduled' AND (workspace_id, id) IN
      (SELECT workspace_id, id FROM jsonb_to_recordset(${JSON.stringify(campaigns)}::jsonb) x(workspace_id text, id text))`);
}

function redactDenial(runtime: Runtime, failure: { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } }) {
  const denial = failure.name === 'AccessDeniedException' && typeof failure.message === 'string' ? failure.message.slice(0, 8192) : '';
  const deniedAction = denial.match(/not authorized to perform(?::\s*|\s+['"])([a-z0-9-]+:[A-Za-z0-9]+)\b/)?.[1];
  const deniedResource = denial.match(/on resource:\s*(arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9_+=,.@/*:-]{1,512}|\*)(?=\s|$)/)?.[1]?.replace(/[A-Za-z0-9_+=,.%-]+@/g, '[redacted]@');
  const awsRequestId = typeof failure.$metadata?.requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(failure.$metadata.requestId) ? failure.$metadata.requestId : undefined;
  const denialMessage = [runtime.config.aws?.accessKeyId, runtime.config.aws?.secretAccessKey, runtime.config.aws?.sessionToken]
    .reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted credential]') : text, denial)
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g, '[redacted email]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted access key]')
    .replace(/\b(?:Bearer\s+\S+|(?:token|secret|password|credential|signature|authorization)\s*[:=]\s*\S+)/gi, '[redacted credential]')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
  return { denial, diagnostics: { ...(awsRequestId ? { awsRequestId } : {}), ...(deniedAction ? { deniedAction } : {}), ...(deniedResource ? { deniedResource } : {}), ...(denialMessage ? { denialMessage } : {}) } };
}

async function sendOne(runtime: Runtime, a: Actor, ses: SESv2Client, item: Prepared): Promise<Outcome> {
  const s = item.snapshot, mail = item.mail;
  const request: SendEmailCommandInput = { FromEmailAddress: formattedSender(s.from, s.fromName), Destination: { ToAddresses: s.to, CcAddresses: s.cc, BccAddresses: s.bcc }, ReplyToAddresses: s.replyTo,
    ConfigurationSetName: runtime.config.configurationSets[s.kind], EmailTags: [{ Name: 'opensend_email_id', Value: mail.id }, { Name: 'opensend_workspace_id', Value: a.workspaceId }],
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED', ClickTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED' } },
    ...(item.owner.tenantName ? { TenantName: item.owner.tenantName } : {}), Content: item.content,
  };
  try {
    const result = await ses.send(new SendEmailCommand(request));
    if (!result.MessageId) return { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_MESSAGE_ID_MISSING' } };
    return { mail, type: 'accepted', providerId: result.MessageId, data: {} };
  } catch (error) {
    const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    const status = failure.$metadata?.httpStatusCode;
    const { denial, diagnostics } = redactDenial(runtime, failure);
    if (denial) log('error', { code: 'SES_ACCESS_DENIED', emailId: mail.id, region: s.region, ...diagnostics });
    const providerRetries = mail.errorCode === 'SES_THROTTLED' ? Math.max(0, mail.dispatchVersion) : 0;
    const definitive = status !== undefined && status >= 400 && status < 500;
    const pause = /\b(?:paused|disabled|suspended)\b/i;
    if (definitive && item.owner.tenantName && /\btenant\b/i.test(failure.message ?? '') && (failure.name === 'SendingPausedException' || pause.test(failure.message ?? ''))) {
      return { mail, type: 'reject', errorCode: 'SES_TENANT_SENDING_PAUSED', data: { code: 'SES_TENANT_SENDING_PAUSED', retryable: false } };
    }
    if (status === 429 && providerRetries < 5) {
      return { mail, type: 'provider_throttled', errorCode: 'SES_THROTTLED', data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 }, requeueAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** providerRetries)).toISOString() };
    }
    return definitive
      ? { mail, type: 'reject', errorCode: failure.name ?? 'SES_REJECTED', data: { code: failure.name ?? 'SES_REJECTED', retryable: false, ...diagnostics } }
      : { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_ACCEPTANCE_UNKNOWN', retryable: false, ...diagnostics } };
  }
}

// One statement records every provider outcome in the batch: attempt-result events, monotonic
// status, public events, webhook deliveries, throttled requeues and (test) simulated feedback.
async function recordOutcomes(runtime: Runtime, outcomes: Outcome[]) {
  if (!outcomes.length) return;
  const simulated = isSimulatedSes(runtime);
  const input = outcomes.map(o => ({
    email_id: o.mail.id, workspace_id: o.mail.workspaceId, dispatch_version: o.mail.dispatchVersion, type: o.type, provider_id: o.providerId ?? null,
    event_id: id('event'), external_id: `attempt-result:${o.mail.id}:${o.mail.dispatchVersion}`, data: o.data, error_code: o.errorCode ?? null,
    next_status: o.type === 'provider_throttled' ? 'queued' : statusForEvent[o.type] ?? null,
    next_rank: o.type === 'provider_throttled' ? 0 : rank[statusForEvent[o.type]!], public_type: publicEventType[o.type] ?? null,
    requeue_at: o.requeueAt ?? null,
  }));
  const result = await runtime.db.execute<{ webhooks: number }>(sql`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(email_id text, workspace_id text, dispatch_version int, type text, provider_id text, event_id text, external_id text, data jsonb, error_code text, next_status text, next_rank int, public_type text, requeue_at timestamptz)
    ), mail AS MATERIALIZED (
      SELECT e.id, e.workspace_id, e.status, e.region, e.dispatch_version FROM sending_emails e JOIN input x ON e.workspace_id = x.workspace_id AND e.id = x.email_id
      ORDER BY e.id FOR UPDATE
    ), inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at)
      SELECT x.event_id, m.workspace_id, m.id, x.type, x.provider_id, x.external_id, x.data, ${simulated}::boolean, clock_timestamp()
      FROM input x JOIN mail m ON m.id = x.email_id ON CONFLICT DO NOTHING RETURNING *
    ), updated AS (
      UPDATE sending_emails e SET
        status = x.next_status, provider_id = coalesce(x.provider_id, e.provider_id), error_code = coalesce(x.error_code, e.error_code),
        dispatch_version = CASE WHEN x.type = 'provider_throttled' THEN e.dispatch_version + 1 ELSE e.dispatch_version END,
        scheduled_at = CASE WHEN x.type = 'provider_throttled' THEN x.requeue_at ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN x.type = 'provider_throttled' THEN NULL ELSE e.attempt_started_at END,
        lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN inserted i ON i.email_id = x.email_id JOIN mail m ON m.id = x.email_id
      WHERE e.workspace_id = x.workspace_id AND e.id = x.email_id AND e.dispatch_version = x.dispatch_version
        AND ((x.type = 'provider_throttled' AND m.status = 'attempting') OR (x.type <> 'provider_throttled' AND x.next_rank >= (${rankJson()}::jsonb ->> m.status)::int))
      RETURNING e.id
    ), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT i.id, i.workspace_id, x.public_type, m.region, i.created_at,
        x.data || jsonb_build_object('emailId', m.id, 'simulated', ${simulated}::boolean) || CASE WHEN x.provider_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('providerId', x.provider_id) END
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), deliveries AS (
      INSERT INTO operation_deliveries(id, workspace_id, webhook_id, event_id, payload)
      SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), p.workspace_id, w.id, p.id,
        jsonb_build_object('id', p.id, 'workspaceId', p.workspace_id, 'type', p.type, 'region', p.region, 'createdAt', p.created_at, 'data', p.data)
      FROM published p JOIN operation_webhooks w ON w.workspace_id = p.workspace_id
      WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
      ON CONFLICT DO NOTHING RETURNING id, workspace_id
    ), webhook_jobs AS (
      INSERT INTO jobs(id, workspace_id, type, payload)
      SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), workspace_id, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
    ), simulated_callbacks AS (
      SELECT 'urn:opensend:simulated-ses:' || m.region AS topic_arn, m.id || ':' || kind AS message_id, i.workspace_id, m.region, x.provider_id,
        i.created_at + CASE WHEN kind = 'Delivery' THEN ${runtime.config.simulatedSes.deliveryDelayMs}::int ELSE 0 END * interval '1 millisecond' AS created_at, kind
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id, unnest(ARRAY['Send','Delivery']) kind
      WHERE ${simulated && !runtime.feedback}::boolean AND x.type = 'accepted' AND x.provider_id LIKE 'sim\\_%'
    ), simulated_jobs AS (
      INSERT INTO jobs(id, workspace_id, type, available_at, payload)
      SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), r.workspace_id, 'operation.simulatedFeedback', r.created_at,
        jsonb_build_object('topicArn', r.topic_arn, 'messageId', r.message_id, 'region', r.region,
          'message', jsonb_build_object('eventType', r.kind, 'mail', jsonb_build_object('messageId', r.provider_id), lower(r.kind), jsonb_build_object('timestamp', r.created_at)))
      FROM simulated_callbacks r RETURNING id
    ) SELECT (SELECT count(*) FROM inserted)::int AS events, (SELECT count(*) FROM updated)::int AS updated, (SELECT count(*) FROM webhook_jobs)::int AS webhooks, (SELECT count(*) FROM simulated_jobs)::int AS simulated`);
  const readyJobs = result.rows[0]!.webhooks;
  if (readyJobs > 0) try { await runtime.wake?.(readyJobs); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  // With a feedback sink, simulated Send/Delivery callbacks travel the same queue live SNS feedback does.
  if (simulated && runtime.feedback) {
    const recorded = new Date().toISOString();
    await queueSimulatedFeedback(runtime, outcomes.filter(o => o.type === 'accepted' && o.providerId?.startsWith('sim_')).map(o => ({ emailId: o.mail.id, region: o.mail.region, providerId: o.providerId!, createdAt: recorded })));
  }
}

type Lane = { deferred: DeferredStream[]; gate: GateState; refresh?: Promise<boolean>; pacing: Pacing; options: Required<Pick<DispatcherOptions, 'batchSize' | 'sendConcurrency' | 'quotaRefreshMs'>> & DispatcherOptions; activated: Set<string>; limitSends: <T>(work: () => Promise<T>) => Promise<T>; counters: DispatcherReport; phase: <T>(name: string, work: () => Promise<T>) => Promise<T> };
function chunk<T>(items: T[], size: number): T[][] { const out: T[][] = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; }

// Quota exhausted for the day: give the leases back untouched and stop this run.
async function releaseLeases(runtime: Runtime, mails: Mail[]) {
  await runtime.db.execute(sql`UPDATE sending_emails e SET lease_until = NULL FROM jsonb_to_recordset(${JSON.stringify(mails.map(m => ({ workspace_id: m.workspaceId, id: m.id, version: m.dispatchVersion })))}::jsonb) x(workspace_id text, id text, version int)
    WHERE e.workspace_id = x.workspace_id AND e.id = x.id AND e.dispatch_version = x.version AND e.status = 'queued'`);
}

// One batch: lease up to batchSize rows and prepare them (CPU), then for each group of sendConcurrency
// rows: one claim statement, paced provider calls, one record statement. Recording overlaps the next
// group's claim and sends; failures surface at the end of the batch.
async function dispatchBatch(base: Runtime, lane: Lane, leased: Leased[]): Promise<{ processed: number; blocked: boolean }> {
  const { gate, options, counters, phase } = lane;
  if (!leased.length) return { processed: 0, blocked: false };

  const ready = leased.filter((item): item is Leased & { owner: Owner } => item.owner !== null);
  counters.claimed += leased.length;
  counters.deferred += leased.length - ready.length;
  // Only unready owner/stream pairs keep their leases as backoff. The gate still paces the region.
  if (!ready.length) return { processed: leased.length, blocked: false };
  const first = ready[0]!.owner;
  // An absolute rate override is an operator setting for their account, not a BYO customer's quota.
  if (options.accountId && !first.tenantName) lane.pacing.targetRate = undefined;
  // Quota is loaded lazily so idle regions never touch the provider control plane.
  if (options.accountId) {
    if (!gate.quota || Date.now() - gate.quota.checkedAt > options.quotaRefreshMs) {
      lane.refresh ??= phase('quota', () => ensureAccountQuota(first, options.accountId!, options.region, gate, options.quotaRefreshMs)).finally(() => { lane.refresh = undefined; });
      if (!await lane.refresh) { await releaseLeases(base, ready.map(item => item.mail)); return { processed: 0, blocked: true }; }
    }
  } else if (await phase('quota', () => ensureQuota(first.runtime, first.a, options.region, gate, first.ses, options.quotaRefreshMs))) await options.onGate?.(gate);
  if (dailyRemaining(gate) <= 0) {
    await releaseLeases(base, ready.map(item => item.mail));
    counters.claimed -= ready.length;
    log('warn', { code: 'SES_DAILY_QUOTA_EXHAUSTED', region: options.region });
    return { processed: 0, blocked: true };
  }
  const prepared: Prepared[] = [];
  const loadAttachments = batchAttachments(base, ready);
  await phase('prepare', () => Promise.all(ready.map(async item => {
    try { prepared.push(await prepareMail(item, loadAttachments)); }
    catch (error) { counters.skipped++; await rejectPreflight(item.owner.runtime, item.owner.a, item.mail, error); }
  })));
  if (!prepared.length) return { processed: leased.length, blocked: false };
  const campaigns = new Map<string, string>();
  for (const { mail } of prepared) if (mail.campaignId && mail.scheduledAt && !lane.activated.has(mail.campaignId)) campaigns.set(mail.campaignId, mail.workspaceId);
  if (campaigns.size) {
    await phase('activate', () => activateCampaigns(base, [...campaigns].map(([id, workspace_id]) => ({ id, workspace_id }))));
    for (const id of campaigns.keys()) lane.activated.add(id);
  }
  const origins = base.config.multiTenant ? new Map<string, boolean>() : await originDecisions(prepared, base.db);
  const pendingRecords: Promise<void>[] = [];
  for (const group of chunk(prepared, options.sendConcurrency)) {
    // Hold MX grant/membership SHARE locks through the durable attempt, never during SES I/O.
    // Direct dashboard/API-key batches still need just the single claim statement.
    const statuses = await phase('claim', () => base.config.multiTenant && group.some(item => item.mail.actorKeyId.startsWith('mcp_'))
      ? base.db.transaction(async tx => claimGroup(base, group, await originDecisions(group, tx), tx))
      : claimGroup(base, group, origins));
    const attempting = group.filter(item => statuses.get(item.mail.id) === 'attempting');
    const lost = group.filter(item => !statuses.has(item.mail.id));
    counters.skipped += group.length - attempting.length;
    for (const item of group) if (statuses.get(item.mail.id) === 'canceled' || statuses.get(item.mail.id) === 'suppressed') await finishEmailCampaign(item.owner.runtime, item.owner.a, { ...item.mail, status: statuses.get(item.mail.id)! });
    if (lost.length) log('warn', { code: 'DISPATCH_CLAIM_LOST', count: lost.length, message: 'Rows changed between lease and claim; they will be reconsidered on the next pass.' });
    if (!attempting.length) continue;
    // Each message takes its own evenly spaced slot, so the provider sees a steady stream at the target
    // rate rather than one burst per group; a throttled response brakes every lane on this shard.
    const outcomes = await phase('send', () => Promise.all(attempting.map(item => lane.limitSends(async () => {
      const wait = reserve(gate, item.snapshot.to.length + item.snapshot.cc.length + item.snapshot.bcc.length, options.shard, lane.pacing);
      if (wait > 0) { const paced = Date.now(); await sleep(wait); counters.timings.pace = (counters.timings.pace ?? 0) + Date.now() - paced; }
      const outcome = await sendOne(item.owner.runtime, item.owner.a, item.owner.ses, item);
      if (outcome.type === 'provider_throttled') brake(gate);
      return outcome;
    }))));
    pendingRecords.push(phase('record', () => recordOutcomes(base, outcomes)).then(async () => {
      for (const [i, outcome] of outcomes.entries()) {
        if (outcome.type === 'accepted') counters.sent++; else if (outcome.type === 'provider_throttled') counters.deferred++; else counters.skipped++;
        if (!outcome.mail.reviewId) await finishEmailCampaign(attempting[i]!.owner.runtime, attempting[i]!.owner.a, { ...outcome.mail, status: statusForEvent[outcome.type] ?? outcome.mail.status });
      }
    }));
  }
  await Promise.all(pendingRecords);
  return { processed: leased.length, blocked: false };
}

/**
 * Drains due mail for one account/region until the queue is empty or `until` passes.
 * Safe to run concurrently in several processes/shards: leases and claims are row-level.
 */
export async function runDispatcher(runtime: Runtime, options: DispatcherOptions): Promise<DispatcherReport> {
  if (runtime.config.multiTenant && !/^\d{12}$/.test(options.accountId ?? '')) throw new ApiError(500, 'DISPATCH_ACCOUNT_REQUIRED', 'An MX dispatcher must be scoped to an AWS account.');
  const started = Date.now();
  const gate = options.gate ?? initialGate();
  const counters: DispatcherReport = { claimed: 0, sent: 0, deferred: 0, skipped: 0, batches: 0, idle: true, durationMs: 0, timings: {}, statements: 0 };
  const phase = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    try { return await work(); } finally { counters.timings[name] = (counters.timings[name] ?? 0) + Date.now() - startedAt; if (name !== 'send' && name !== 'pace' && name !== 'prepare') counters.statements++; }
  };
  const pacing: Pacing = { rateFactor: runtime.config.dispatch.rateFactor, targetRate: runtime.config.dispatch.targetRate, live: !isSimulatedSes(runtime) };
  const lane: Lane = { deferred: [], gate, pacing, activated: new Set(), limitSends: semaphore(options.sendConcurrency ?? 6), counters, phase, options: { ...options, batchSize: options.batchSize ?? 24, sendConcurrency: options.sendConcurrency ?? 6, quotaRefreshMs: options.quotaRefreshMs ?? 60000 } };
  const lease = () => phase('lease', () => leaseDue(runtime, options.region, lane.options.batchSize, lane.deferred, options.accountId));
  const first = await lease();
  const lanes = first.length === lane.options.batchSize ? Math.max(1, options.lanes ?? 2) : 1;
  let blocked = false;
  const results = await Promise.allSettled(Array.from({ length: lanes }, async (_, i) => {
    let batch = i === 0 ? first : await lease();
    for (;;) {
      const { processed, blocked: exhausted } = await dispatchBatch(runtime, lane, batch);
      counters.batches++;
      if (exhausted) blocked = true;
      if (processed) await options.onGate?.(gate);
      if (blocked || batch.length < lane.options.batchSize) return;
      if (options.until !== undefined && Date.now() >= options.until) { counters.idle = false; return; }
      batch = await lease();
    }
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  if (blocked) counters.idle = true;
  counters.durationMs = Date.now() - started;
  // Idle polls are silent; runs that moved mail (or hit the budget) are the throughput record.
  if (counters.claimed || !counters.idle) log('info', { code: 'DISPATCH_RUN', accountId: options.accountId, region: options.region, shard: options.shard?.index ?? 0, ...counters, quota: gate.quota?.maxSendRate ?? null, rate: shardRate(gate, options.shard, pacing), braked: (gate.brakeUntil ?? 0) > Date.now() });
  return counters;
}

/** Test/runner helper: drain everything due for one account/region with no time limit. */
export async function dispatchDue(runtime: Runtime, region: string, overrides: Partial<DispatcherOptions> = {}) {
  return runDispatcher(runtime, { region, lanes: 1, ...overrides });
}
