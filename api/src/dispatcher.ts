import { getTableColumns, sql } from 'drizzle-orm';
import { GetAccountCommand, SendEmailCommand, type Attachment, type SESv2Client, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { ApiError, getSes, id, log, type Actor, type Mode, type Runtime } from './core.js';
import { emails, type EmailSnapshot, type EmailStatus, type CampaignDraft, type ReviewedRecipient } from './db/sending.js';
import { attachmentRows, finishEmailCampaign, formattedSender, inlineMessage, materializeCampaignEmail, originAllowed, publicEventType, rank, sizeCheck, statusForEvent, verifiedAttachment } from './sending.js';
import { assertLiveRegionReady } from './ses-region-state.js';
import { simulatedSes } from './adapters/simulated-ses.js';

// The dispatcher is a long-lived loop, hosted by a Durable Object on Cloudflare and by the
// runner process on Node. PostgreSQL remains the only source of truth: a row is sent at most
// once because the batched claim flips it queued → attempting under its dispatch_version.
// Provider pacing lives in process memory (one shard owns one share of the regional quota),
// so the hot path costs three database statements per batch rather than ten per email.

export type Mail = typeof emails.$inferSelect;
type Review = { draft: CampaignDraft; rendered: { html?: string; text?: string }; status: string | null; contentHash: string | null; recipient: ReviewedRecipient };
type Leased = { mail: Mail; review: Review | null };
type Prepared = Leased & { snapshot: EmailSnapshot; content: SendEmailCommandInput['Content']; unsubscribe?: { tokenHash: string; email: string } };
type Outcome = { mail: Mail; type: 'accepted' | 'reject' | 'acceptance_unknown' | 'provider_throttled'; providerId?: string; errorCode?: string; data: Record<string, unknown>; requeueAt?: string };

export interface QuotaSnapshot { maxSendRate: number; max24HourSend: number; sentLast24Hours: number; checkedAt: number }
// Serializable pacing state so a Durable Object survives eviction without bursting.
export interface GateState { nextAllowedAt: number; quota: QuotaSnapshot | null; sentSinceRefresh: number }
export const initialGate = (): GateState => ({ nextAllowedAt: 0, quota: null, sentSinceRefresh: 0 });

export interface DispatcherOptions {
  environment: Mode; region: string;
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
export interface DispatcherReport { claimed: number; sent: number; deferred: number; skipped: number; recovered: number; batches: number; idle: boolean; durationMs: number }

const worker = (runtime: Runtime, environment: Mode): Actor => ({ workspaceId: runtime.config.workspaceId, environment, keyId: 'worker', domains: [], permissions: ['manage'] });
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

export function providerClient(runtime: Runtime, environment: Mode, region: string): SESv2Client {
  return environment === 'live' ? getSes(runtime, region) : simulatedSes(runtime, region);
}
async function fetchQuota(ses: SESv2Client): Promise<QuotaSnapshot> {
  const account = await ses.send(new GetAccountCommand({})), quota = account.SendQuota;
  if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.MaxSendRate <= 0 || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
  return { maxSendRate: quota.MaxSendRate, max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours, checkedAt: Date.now() };
}
// sending_region_limits is the shared one-minute quota cache for every shard, the expander and the
// dashboard. Only the shard that finds it stale calls GetAccount (a 1 TPS control-plane API), and
// the conditional upsert keeps concurrent shards from repeating that call.
async function ensureQuota(runtime: Runtime, a: Actor, region: string, gate: GateState, ses: SESv2Client, refreshMs: number) {
  if (gate.quota && Date.now() - gate.quota.checkedAt <= refreshMs) return false;
  const cached = await runtime.db.execute<{ max_send_rate: number; max_24_hour_send: number; sent_last_24_hours: number; checked_at: string }>(sql`
    SELECT max_send_rate, max_24_hour_send, sent_last_24_hours, checked_at::text FROM sending_region_limits
    WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND region = ${region} AND checked_at > clock_timestamp() - (${refreshMs}::int * interval '1 millisecond')`);
  const row = cached.rows[0];
  if (row && Number(row.max_send_rate) > 0) {
    // A cached row without a daily figure (0) means unknown, not exhausted; SES enforces the real cap.
    gate.quota = { maxSendRate: Number(row.max_send_rate), max24HourSend: Number(row.max_24_hour_send) || -1, sentLast24Hours: Number(row.sent_last_24_hours) || 0, checkedAt: Date.parse(row.checked_at) };
    gate.sentSinceRefresh = 0;
    return true;
  }
  const quota = await fetchQuota(ses);
  await runtime.db.execute(sql`INSERT INTO sending_region_limits (workspace_id, environment, region, max_send_rate, max_24_hour_send, sent_last_24_hours, reserved, checked_at)
    VALUES (${a.workspaceId}, ${a.environment}, ${region}, ${quota.maxSendRate}, ${quota.max24HourSend}, ${quota.sentLast24Hours}, 0, clock_timestamp())
    ON CONFLICT (workspace_id, environment, region) DO UPDATE SET max_send_rate = excluded.max_send_rate, max_24_hour_send = excluded.max_24_hour_send,
      sent_last_24_hours = excluded.sent_last_24_hours, reserved = 0, next_allowed_at = NULL, checked_at = excluded.checked_at
    WHERE sending_region_limits.checked_at IS NULL OR sending_region_limits.checked_at <= clock_timestamp() - (${refreshMs}::int * interval '1 millisecond')`);
  gate.quota = quota; gate.sentSinceRefresh = 0;
  return true;
}

export function shardRate(gate: GateState, shard?: { index: number; count: number }) {
  const rate = gate.quota?.maxSendRate ?? 0;
  return shard && shard.count > 1 ? Math.max(1, rate / shard.count) : rate;
}
/** Reserves `recipients` slots and returns how long the caller must wait before sending them. */
export function reserve(gate: GateState, recipients: number, shard?: { index: number; count: number }): number {
  const rate = shardRate(gate, shard);
  if (rate <= 0) return 1000;
  const start = Math.max(Date.now(), gate.nextAllowedAt);
  gate.nextAllowedAt = start + Math.ceil(1000 * recipients / rate);
  gate.sentSinceRefresh += recipients;
  return Math.max(0, start - Date.now());
}
function dailyRemaining(gate: GateState) {
  const quota = gate.quota;
  if (!quota || quota.max24HourSend < 0) return Number.POSITIVE_INFINITY;
  return quota.max24HourSend - quota.sentLast24Hours - gate.sentSinceRefresh;
}

// One statement leases the oldest due mail for this region and returns it with its frozen review inputs.
async function leaseDue(runtime: Runtime, a: Actor, region: string, limit: number): Promise<Leased[]> {
  const result = await runtime.db.execute<Record<string, unknown>>(sql`WITH due AS (
      SELECT id FROM sending_emails
      WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND region = ${region} AND status = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= clock_timestamp()) AND (lease_until IS NULL OR lease_until < clock_timestamp())
      ORDER BY (campaign_id IS NULL) DESC, created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), leased AS (
      UPDATE sending_emails e SET lease_until = clock_timestamp() + interval '2 minutes' FROM due WHERE e.id = due.id RETURNING e.*
    ) SELECT ${sql.join(mailColumns, sql`, `)}, r.draft AS review_draft, r.rendered AS review_rendered, r.status AS review_status, rr.content_hash AS review_content_hash, rr.recipient AS review_recipient
    FROM leased
    LEFT JOIN sending_campaign_reviews r ON r.id = leased.review_id AND r.campaign_id = leased.campaign_id AND r.workspace_id = ${a.workspaceId} AND r.environment = ${a.environment}
    LEFT JOIN sending_review_recipients rr ON rr.review_id = leased.review_id AND rr.ordinal = leased.review_ordinal
    ORDER BY (leased.campaign_id IS NULL) DESC, leased.created_at, leased.id`);
  return result.rows.map(row => {
    const { review_draft, review_rendered, review_status, review_content_hash, review_recipient, ...mail } = row;
    return { mail: mail as Mail, review: review_draft && review_rendered && review_recipient ? { draft: review_draft as CampaignDraft, rendered: review_rendered as Review['rendered'], status: review_status as string | null, contentHash: review_content_hash as string | null, recipient: review_recipient as ReviewedRecipient } : null };
  });
}

// A lease that expired while attempting means the provider call may have happened. SES has no
// idempotency token, so the row becomes acceptance_unknown and is never automatically resent.
async function recoverInterrupted(runtime: Runtime, a: Actor): Promise<number> {
  const result = await runtime.db.execute<{ count: number }>(sql`WITH stale AS (
      UPDATE sending_emails SET status = 'acceptance_unknown', error_code = 'INTERRUPTED_PROVIDER_ATTEMPT', lease_until = NULL, updated_at = clock_timestamp()
      WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND status = 'attempting' AND attempt_started_at < clock_timestamp() - interval '3 minutes'
      RETURNING id, dispatch_version
    ), events AS (
      INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, external_id, simulated, data)
      SELECT 'event_' || replace(gen_random_uuid()::text, '-', ''), ${a.workspaceId}, ${a.environment}, id, 'acceptance_unknown', 'interrupted:' || id || ':' || dispatch_version, ${a.environment === 'test'}::boolean, '{"code":"INTERRUPTED_PROVIDER_ATTEMPT"}'::jsonb
      FROM stale ON CONFLICT DO NOTHING RETURNING id
    ) SELECT count(*)::int AS count FROM stale`);
  return result.rows[0]?.count ?? 0;
}

async function prepareMail(runtime: Runtime, a: Actor, leased: Leased): Promise<Prepared> {
  let mail = leased.mail;
  let rows: Awaited<ReturnType<typeof attachmentRows>> | undefined;
  let unsubscribe: Prepared['unsubscribe'];
  if (mail.snapshot.deferredCampaign) {
    const materialized = await materializeCampaignEmail(runtime, a, mail, leased.review);
    mail = materialized.mail; rows = materialized.rows; unsubscribe = materialized.unsubscribe;
  }
  const s = mail.snapshot;
  const parts: Attachment[] = [];
  rows ??= await attachmentRows(runtime.db, a, s.attachments);
  for (const row of rows) { const body = await verifiedAttachment(runtime, row); parts.push({ FileName: row.filename, RawContent: body, ContentType: row.contentType, ContentDisposition: row.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(row.contentId ? { ContentId: row.contentId } : {}) }); }
  sizeCheck(s, rows);
  const content: SendEmailCommandInput['Content'] = s.raw
    ? { Raw: { Data: new TextEncoder().encode(s.raw) } }
    : s.html && parts.some(part => part.ContentDisposition === 'INLINE')
      ? { Raw: { Data: inlineMessage(s, parts) } }
      : { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } };
  return { mail, review: leased.review, snapshot: s, content, unsubscribe };
}

// Preflight failures (storage, rendering, hash mismatch) cannot have sent email: reject the row.
async function rejectPreflight(runtime: Runtime, a: Actor, mail: Mail, error: unknown) {
  const code = error instanceof ApiError ? error.code : 'DISPATCH_PREFLIGHT_FAILED';
  const retryable = error instanceof ApiError ? error.retryable : true;
  if (retryable) {
    // Transient dependency failure: release the lease with a short backoff and let the loop retry.
    await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = NULL, scheduled_at = greatest(coalesce(scheduled_at, clock_timestamp()), clock_timestamp() + interval '15 seconds'), error_code = ${code}, updated_at = clock_timestamp()
      WHERE id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion}`);
    log('warn', { code, emailId: mail.id, environment: a.environment, message: 'Dispatch preflight failed; retrying after a short delay.' });
    return;
  }
  await runtime.db.execute(sql`WITH rejected AS (
      UPDATE sending_emails SET status = 'rejected', error_code = ${code}, lease_until = NULL, updated_at = clock_timestamp()
      WHERE id = ${mail.id} AND status = 'queued' AND dispatch_version = ${mail.dispatchVersion} RETURNING id
    ) INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, external_id, simulated, data)
    SELECT ${id('event')}, ${a.workspaceId}, ${a.environment}, id, 'reject', ${`preflight-failed:${mail.id}`}, ${a.environment === 'test'}::boolean, ${JSON.stringify({ code, providerCalled: false })}::jsonb FROM rejected ON CONFLICT DO NOTHING`);
  log('error', { code, emailId: mail.id, environment: a.environment, message: error instanceof ApiError ? error.message : 'Unexpected dispatch preflight failure.' });
  await finishEmailCampaign(runtime, a, mail);
}

// One transaction elects every row in the batch: origin authorization under shared key locks,
// consent locks, campaign cancellation, unsubscribe tokens and attempt events, all in PostgreSQL.
async function claimBatch(runtime: Runtime, a: Actor, prepared: Prepared[]): Promise<Map<string, EmailStatus>> {
  return runtime.db.transaction(async tx => {
    const allowed = new Map<string, boolean>();
    for (const item of prepared) {
      const key = `${item.mail.actorKeyId}\u0000${item.snapshot.from.split('@')[1]!.toLowerCase()}`;
      if (!allowed.has(key)) allowed.set(key, await originAllowed(runtime, tx, { workspaceId: a.workspaceId, environment: a.environment, actorKeyId: item.mail.actorKeyId, snapshot: { from: item.snapshot.from } }));
    }
    const revoked = prepared.filter(item => !allowed.get(`${item.mail.actorKeyId}\u0000${item.snapshot.from.split('@')[1]!.toLowerCase()}`));
    const statuses = new Map<string, EmailStatus>();
    if (revoked.length) {
      const rows = await tx.execute<{ id: string }>(sql`UPDATE sending_emails SET status = 'canceled', error_code = 'ORIGIN_KEY_REVOKED', lease_until = NULL, updated_at = clock_timestamp()
        WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND status = 'queued'
          AND (id, dispatch_version) IN (SELECT x.id, x.v FROM jsonb_to_recordset(${JSON.stringify(revoked.map(item => ({ id: item.mail.id, v: item.mail.dispatchVersion })))}::jsonb) AS x(id text, v int)) RETURNING id`);
      for (const row of rows.rows) statuses.set(row.id, 'canceled');
    }
    const eligible = prepared.filter(item => !revoked.includes(item));
    if (!eligible.length) return statuses;
    const input = eligible.map(item => ({
      id: item.mail.id, dispatch_version: item.mail.dispatchVersion, campaign_id: item.mail.campaignId,
      destinations: [...item.snapshot.to, ...item.snapshot.cc, ...item.snapshot.bcc].map(email => email.toLowerCase()),
      marketing: item.snapshot.kind === 'marketing', snapshot: item.unsubscribe ? item.snapshot : null,
      token_hash: item.unsubscribe?.tokenHash ?? null, token_email: item.unsubscribe?.email ?? null,
      event_id: id('event'), external_id: `attempt-start:${item.mail.id}:${item.mail.dispatchVersion}`, attempt: item.mail.dispatchVersion + 1,
    }));
    const claimed = await tx.execute<{ id: string; status: EmailStatus }>(sql`WITH input AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
          AS x(id text, dispatch_version int, campaign_id text, destinations jsonb, marketing boolean, snapshot jsonb, token_hash text, token_email text, event_id text, external_id text, attempt int)
      ), campaign_state AS MATERIALIZED (
        SELECT id, status FROM sending_campaigns WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment}
          AND id IN (SELECT DISTINCT campaign_id FROM input WHERE campaign_id IS NOT NULL) FOR SHARE
      ), dest AS (
        SELECT x.id AS email_id, d.value AS email FROM input x, jsonb_array_elements_text(x.destinations) d
      ), consent AS MATERIALIZED (
        SELECT email, suppressed, deleted_at, marketing_consent FROM audience_contacts
        WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND email IN (SELECT DISTINCT email FROM dest)
        ORDER BY id FOR UPDATE
      ), eligibility AS (
        SELECT x.id,
          (x.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaign_state c WHERE c.id = x.campaign_id AND c.status <> 'canceled')) AS campaign_allowed,
          NOT EXISTS (SELECT 1 FROM dest d LEFT JOIN consent c USING (email)
            WHERE d.email_id = x.id AND (c.suppressed IS TRUE OR (x.marketing AND (c.email IS NULL OR c.deleted_at IS NOT NULL OR c.marketing_consent <> 'subscribed')))) AS recipient_allowed
        FROM input x
      ), claimed AS (
        UPDATE sending_emails e SET
          status = CASE WHEN NOT el.campaign_allowed THEN 'canceled' WHEN el.recipient_allowed THEN 'attempting' ELSE 'suppressed' END,
          attempt_started_at = CASE WHEN el.campaign_allowed AND el.recipient_allowed THEN clock_timestamp() ELSE e.attempt_started_at END,
          error_code = CASE WHEN NOT el.campaign_allowed THEN 'CAMPAIGN_CANCELED' WHEN el.recipient_allowed THEN e.error_code ELSE 'RECIPIENT_INELIGIBLE' END,
          snapshot = coalesce(x.snapshot, e.snapshot), lease_until = NULL, updated_at = clock_timestamp()
        FROM input x JOIN eligibility el ON el.id = x.id
        WHERE e.workspace_id = ${a.workspaceId} AND e.environment = ${a.environment} AND e.id = x.id AND e.status = 'queued' AND e.dispatch_version = x.dispatch_version
        RETURNING e.id, e.status
      ), token AS (
        INSERT INTO operation_unsubscribe_tokens(token_hash, workspace_id, environment, email)
        SELECT x.token_hash, ${a.workspaceId}, ${a.environment}, x.token_email FROM claimed c JOIN input x ON x.id = c.id WHERE x.token_hash IS NOT NULL
        ON CONFLICT DO NOTHING
      ), attempt AS (
        INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, external_id, simulated, data)
        SELECT x.event_id, ${a.workspaceId}, ${a.environment}, c.id, 'dispatch_attempt', x.external_id, ${a.environment === 'test'}::boolean,
          jsonb_build_object('attempt', x.attempt, 'providerCallPlanned', true, 'providerCallSimulated', ${a.environment === 'test'}::boolean)
        FROM claimed c JOIN input x ON x.id = c.id WHERE c.status = 'attempting' ON CONFLICT DO NOTHING
      ) SELECT id, status FROM claimed`);
    for (const row of claimed.rows) statuses.set(row.id, row.status);
    return statuses;
  });
}

// Scheduled campaigns become "sending" on their first claim; a plain UPDATE avoids the shared-lock
// upgrade that concurrent shards would otherwise deadlock on.
async function activateCampaigns(runtime: Runtime, a: Actor, campaignIds: string[]) {
  if (!campaignIds.length) return;
  await runtime.db.execute(sql`UPDATE sending_campaigns SET status = 'sending', updated_at = clock_timestamp()
    WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND status = 'scheduled' AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(campaignIds)}::jsonb))`);
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
    Content: item.content,
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
    if (status === 429 && providerRetries < 5) {
      return { mail, type: 'provider_throttled', errorCode: 'SES_THROTTLED', data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 }, requeueAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** providerRetries)).toISOString() };
    }
    const definitive = status !== undefined && status >= 400 && status < 500;
    return definitive
      ? { mail, type: 'reject', errorCode: failure.name ?? 'SES_REJECTED', data: { code: failure.name ?? 'SES_REJECTED', retryable: false, ...diagnostics } }
      : { mail, type: 'acceptance_unknown', errorCode: 'SES_ACCEPTANCE_UNKNOWN', data: { code: 'SES_ACCEPTANCE_UNKNOWN', retryable: false, ...diagnostics } };
  }
}

// One statement records every provider outcome in the batch: attempt-result events, monotonic
// status, public events, webhook deliveries, throttled requeues and (test) simulated feedback.
async function recordOutcomes(runtime: Runtime, a: Actor, outcomes: Outcome[]) {
  if (!outcomes.length) return;
  const simulated = a.environment === 'test';
  const input = outcomes.map(o => ({
    email_id: o.mail.id, dispatch_version: o.mail.dispatchVersion, type: o.type, provider_id: o.providerId ?? null,
    event_id: id('event'), external_id: `attempt-result:${o.mail.id}:${o.mail.dispatchVersion}`, data: o.data, error_code: o.errorCode ?? null,
    next_status: o.type === 'provider_throttled' ? 'queued' : statusForEvent[o.type] ?? null,
    next_rank: o.type === 'provider_throttled' ? 0 : rank[statusForEvent[o.type]!], public_type: publicEventType[o.type] ?? null,
    requeue_at: o.requeueAt ?? null,
  }));
  await runtime.db.execute(sql`WITH input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
        AS x(email_id text, dispatch_version int, type text, provider_id text, event_id text, external_id text, data jsonb, error_code text, next_status text, next_rank int, public_type text, requeue_at timestamptz)
    ), mail AS MATERIALIZED (
      SELECT e.id, e.status, e.region, e.dispatch_version FROM sending_emails e JOIN input x ON x.email_id = e.id
      WHERE e.workspace_id = ${a.workspaceId} AND e.environment = ${a.environment} ORDER BY e.id FOR UPDATE
    ), inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, provider_id, external_id, data, simulated, created_at)
      SELECT x.event_id, ${a.workspaceId}, ${a.environment}, m.id, x.type, x.provider_id, x.external_id, x.data, ${simulated}::boolean, clock_timestamp()
      FROM input x JOIN mail m ON m.id = x.email_id ON CONFLICT DO NOTHING RETURNING *
    ), updated AS (
      UPDATE sending_emails e SET
        status = x.next_status, provider_id = coalesce(x.provider_id, e.provider_id), error_code = coalesce(x.error_code, e.error_code),
        dispatch_version = CASE WHEN x.type = 'provider_throttled' THEN e.dispatch_version + 1 ELSE e.dispatch_version END,
        scheduled_at = CASE WHEN x.type = 'provider_throttled' THEN x.requeue_at ELSE e.scheduled_at END,
        attempt_started_at = CASE WHEN x.type = 'provider_throttled' THEN NULL ELSE e.attempt_started_at END,
        lease_until = NULL, updated_at = clock_timestamp()
      FROM input x JOIN inserted i ON i.email_id = x.email_id JOIN mail m ON m.id = x.email_id
      WHERE e.id = x.email_id AND e.dispatch_version = x.dispatch_version
        AND ((x.type = 'provider_throttled' AND m.status = 'attempting') OR (x.type <> 'provider_throttled' AND x.next_rank >= (${rankJson()}::jsonb ->> m.status)::int))
      RETURNING e.id
    ), published AS (
      INSERT INTO operation_events(id, workspace_id, environment, type, region, created_at, data)
      SELECT i.id, i.workspace_id, i.environment, x.public_type, m.region, i.created_at,
        x.data || jsonb_build_object('emailId', m.id, 'simulated', ${simulated}::boolean) || CASE WHEN x.provider_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('providerId', x.provider_id) END
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
    ), deliveries AS (
      INSERT INTO operation_deliveries(id, workspace_id, environment, webhook_id, event_id, payload)
      SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), p.workspace_id, p.environment, w.id, p.id,
        jsonb_build_object('id', p.id, 'workspaceId', p.workspace_id, 'environment', p.environment, 'type', p.type, 'region', p.region, 'createdAt', p.created_at, 'data', p.data)
      FROM published p JOIN operation_webhooks w ON w.workspace_id = p.workspace_id AND w.environment = p.environment
      WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
      ON CONFLICT DO NOTHING RETURNING id, workspace_id, environment
    ), webhook_jobs AS (
      INSERT INTO jobs(id, workspace_id, environment, type, payload)
      SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), workspace_id, environment, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
    ), simulated_callbacks AS (
      SELECT 'urn:opensend:simulated-ses:' || m.region AS topic_arn, m.id || ':' || kind AS message_id, i.workspace_id, m.region, x.provider_id,
        i.created_at + CASE WHEN kind = 'Delivery' THEN ${runtime.config.simulatedSes.deliveryDelayMs}::int ELSE 0 END * interval '1 millisecond' AS created_at, kind
      FROM inserted i JOIN input x ON x.event_id = i.id JOIN mail m ON m.id = i.email_id, unnest(ARRAY['Send','Delivery']) kind
      WHERE ${simulated}::boolean AND x.type = 'accepted' AND x.provider_id LIKE 'sim\\_%'
    ), simulated_jobs AS (
      INSERT INTO jobs(id, workspace_id, environment, type, available_at, payload)
      SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), r.workspace_id, 'test', 'operation.simulatedFeedback', r.created_at,
        jsonb_build_object('topicArn', r.topic_arn, 'messageId', r.message_id, 'region', r.region,
          'message', jsonb_build_object('eventType', r.kind, 'mail', jsonb_build_object('messageId', r.provider_id), lower(r.kind), jsonb_build_object('timestamp', r.created_at)))
      FROM simulated_callbacks r RETURNING id
    ) SELECT (SELECT count(*) FROM inserted)::int AS events, (SELECT count(*) FROM updated)::int AS updated, (SELECT count(*) FROM webhook_jobs)::int AS webhooks, (SELECT count(*) FROM simulated_jobs)::int AS simulated`);
}

// Suppressed claims record their event; canceled rows are already final.
async function recordSuppressed(runtime: Runtime, a: Actor, mails: Mail[]) {
  if (!mails.length) return;
  await runtime.db.execute(sql`INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, external_id, simulated)
    SELECT 'event_' || replace(gen_random_uuid()::text, '-', ''), ${a.workspaceId}, ${a.environment}, x.id, 'suppressed', 'suppressed:' || x.id, ${a.environment === 'test'}::boolean
    FROM jsonb_to_recordset(${JSON.stringify(mails.map(m => ({ id: m.id })))}::jsonb) AS x(id text) ON CONFLICT DO NOTHING`);
}

type Lane = { ses: SESv2Client; gate: GateState; options: Required<Pick<DispatcherOptions, 'batchSize' | 'sendConcurrency' | 'quotaRefreshMs'>> & DispatcherOptions; a: Actor; activated: Set<string>; limitSends: <T>(work: () => Promise<T>) => Promise<T>; counters: DispatcherReport };

// Quota exhausted for the day: give the leases back untouched and stop this run.
async function releaseLeases(runtime: Runtime, a: Actor, mails: Mail[]) {
  if (!mails.length) return;
  await runtime.db.execute(sql`UPDATE sending_emails SET lease_until = NULL WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND status = 'queued'
    AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(mails.map(m => m.id))}::jsonb))`);
}

// One batch: lease → prepare (CPU) → claim (1 tx) → paced provider calls → record (1 statement).
async function dispatchBatch(runtime: Runtime, lane: Lane): Promise<{ processed: number; blocked: boolean }> {
  const { a, ses, gate, options, counters } = lane;
  const leased = await leaseDue(runtime, a, options.region, options.batchSize);
  if (!leased.length) return { processed: 0, blocked: false };
  counters.claimed += leased.length;
  // Quota is loaded lazily so idle regions never touch the provider control plane.
  if (await ensureQuota(runtime, a, options.region, gate, ses, options.quotaRefreshMs)) await options.onGate?.(gate);
  if (dailyRemaining(gate) <= 0) {
    await releaseLeases(runtime, a, leased.map(item => item.mail));
    counters.claimed -= leased.length;
    log('warn', { code: 'SES_DAILY_QUOTA_EXHAUSTED', environment: options.environment, region: options.region });
    return { processed: 0, blocked: true };
  }
  const prepared: Prepared[] = [];
  await Promise.all(leased.map(async item => {
    try { prepared.push(await prepareMail(runtime, a, item)); }
    catch (error) { counters.skipped++; await rejectPreflight(runtime, a, item.mail, error); }
  }));
  if (!prepared.length) return { processed: leased.length, blocked: false };
  const campaignIds = [...new Set(prepared.flatMap(item => item.mail.campaignId && item.mail.scheduledAt && !lane.activated.has(item.mail.campaignId) ? [item.mail.campaignId] : []))];
  if (campaignIds.length) { await activateCampaigns(runtime, a, campaignIds); for (const campaignId of campaignIds) lane.activated.add(campaignId); }
  const statuses = await claimBatch(runtime, a, prepared);
  const attempting = prepared.filter(item => statuses.get(item.mail.id) === 'attempting');
  const suppressed = prepared.filter(item => statuses.get(item.mail.id) === 'suppressed').map(item => item.mail);
  const lost = prepared.filter(item => !statuses.has(item.mail.id));
  counters.skipped += prepared.length - attempting.length;
  await recordSuppressed(runtime, a, suppressed);
  for (const item of prepared) if (statuses.get(item.mail.id) === 'canceled' || statuses.get(item.mail.id) === 'suppressed') await finishEmailCampaign(runtime, a, { ...item.mail, status: statuses.get(item.mail.id)! });
  if (lost.length) log('warn', { code: 'DISPATCH_CLAIM_LOST', count: lost.length, environment: a.environment, message: 'Rows changed between lease and claim; they will be reconsidered on the next pass.' });
  if (!attempting.length) return { processed: leased.length, blocked: false };
  // Pace the whole batch once, then let the provider calls overlap up to the connection budget.
  const wait = reserve(gate, attempting.reduce((n, item) => n + item.snapshot.to.length + item.snapshot.cc.length + item.snapshot.bcc.length, 0), options.shard);
  if (wait > 0) await sleep(wait);
  const outcomes = await Promise.all(attempting.map(item => lane.limitSends(() => sendOne(runtime, a, ses, item))));
  await recordOutcomes(runtime, a, outcomes);
  for (const outcome of outcomes) {
    if (outcome.type === 'accepted') counters.sent++; else if (outcome.type === 'provider_throttled') counters.deferred++; else counters.skipped++;
    if (!outcome.mail.reviewId) await finishEmailCampaign(runtime, a, { ...outcome.mail, status: statusForEvent[outcome.type] ?? outcome.mail.status });
  }
  return { processed: leased.length, blocked: false };
}

/**
 * Drains due mail for one environment/region until the queue is empty or `until` passes.
 * Safe to run concurrently in several processes/shards: leases and claims are row-level.
 */
export async function runDispatcher(runtime: Runtime, options: DispatcherOptions): Promise<DispatcherReport> {
  const started = Date.now();
  const a = worker(runtime, options.environment);
  const gate = options.gate ?? initialGate();
  const counters: DispatcherReport = { claimed: 0, sent: 0, deferred: 0, skipped: 0, recovered: 0, batches: 0, idle: false, durationMs: 0 };
  const ses = providerClient(runtime, options.environment, options.region);
  if (options.environment === 'live') await assertLiveRegionReady(runtime, runtime.db, options.region, 'marketing', true);
  counters.recovered = await recoverInterrupted(runtime, a);
  const lane: Lane = { ses, gate, a, activated: new Set(), limitSends: semaphore(options.sendConcurrency ?? 6), counters, options: { ...options, batchSize: options.batchSize ?? 20, sendConcurrency: options.sendConcurrency ?? 6, quotaRefreshMs: options.quotaRefreshMs ?? 60000 } };
  const lanes = Math.max(1, options.lanes ?? 2);
  let idleLanes = 0, blocked = false;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (!blocked && (options.until === undefined || Date.now() < options.until)) {
      const { processed, blocked: exhausted } = await dispatchBatch(runtime, lane);
      counters.batches++;
      if (exhausted) { blocked = true; break; }
      if (processed) { idleLanes = 0; await options.onGate?.(gate); continue; }
      // Empty lease: this lane is done unless a sibling is still producing (it may unblock more work).
      if (++idleLanes >= lanes) break;
      await sleep(50);
      if (idleLanes >= lanes) break;
    }
  }));
  // Blocked counts as idle: nothing more can be sent until the quota window moves.
  counters.idle = blocked || (counters.batches > 0 && idleLanes >= lanes);
  counters.durationMs = Date.now() - started;
  // Idle polls are silent; runs that moved mail (or hit the budget) are the throughput record.
  if (counters.claimed || counters.recovered || !counters.idle) log('info', { code: 'DISPATCH_RUN', environment: options.environment, region: options.region, shard: options.shard?.index ?? 0, ...counters, rate: shardRate(gate, options.shard) });
  return counters;
}

/** Test/runner helper: drain everything due for one environment/region with no time limit. */
export async function dispatchDue(runtime: Runtime, environment: Mode, region: string, overrides: Partial<DispatcherOptions> = {}) {
  return runDispatcher(runtime, { environment, region, lanes: 1, ...overrides });
}

