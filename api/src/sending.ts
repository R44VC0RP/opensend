import { cachedDashboardRead } from './dashboard-cache.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNull, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { apiKeys } from './db/core.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { GetEmailTemplateCommand, TestRenderEmailTemplateCommand, type Attachment } from '@aws-sdk/client-sesv2';
import { actor, ApiError, chargeRenderBudget, digest, errors, getSes, isSimulatedSes, id, IdParams, json, log, notFound, PageQuery, page, redactCapabilityData, redactCapabilityText, region, response, security, senderDomainAllowed, timed, type Actor, type App, type Ctx, type DbExecutor, type JobHandler, type Runtime, type Storage } from './core.js';
import { JobDeferred, MAX_ATTEMPTS } from './jobs.js';
import { AudienceSpec, countCampaignAudience, snapshotCampaignAudience } from './audience.js';
import { getMcpGrantActor } from './mcp-auth.js';
import { assertTenantReady, CAMPAIGN_ACTIVE, CAMPAIGN_RUNNING, CAMPAIGN_STATES, campaignEditable, campaignReserved, campaignResumable, cancelCampaign, failCampaign, holdCampaign, launchCampaign, noteHealthChecked, pauseCampaign, queueCampaignRun, recordExpanded, recordPrepared, resumeCampaign, retireCampaignRun, reviseCampaign, runningState, setCampaignPacing, startSending, wakeCampaignRun, type CampaignState, type TenantState } from './states.js';
import { checkRoute, regionalSending, senderRoutes, sendingConnections, unverifiedSender, verifiedClaim, type SenderRoute, type SendingBinding } from './domain-claims.js';
import { assertLiveRegionReady, assertRegionEnabled, credentialFingerprint, discoveryTarget, regionPattern } from './ses-region-state.js';
import { forDelivery, type ReadyConnection } from './provider-credentials.js';
import { assertHostedAllowance, hostedAllowance, hostedCost, type HostedAllowance } from './hosted-sending.js';
import { createUnsubscribeLink, unsubscribeUrl } from './operations.js';
import { mailboxAddresses, mailboxKeys } from './db/mailbox.js';
import { finishMailboxArchive,trackedAttachments,queueTrackedMailboxSend } from './mailbox-send.js';
import { CustomHeaders } from './custom-headers.js';
import { attachmentLinks, attachments, campaignReviews, campaigns, emailEvents, emails, sendingIdempotency, type CampaignDraft, type EmailSnapshot, type EmailStatus, type ReviewedRecipient } from './db/sending.js';
import { BlockContentError, CAMPAIGN_CONTENT_GUIDE, renderBlockHtml, renderBlockText, validateBlockHtml } from './campaign-blocks.js';
import { instantiateTemplate } from './templates.js';
import { AttachmentMetadata, AttachmentUpload, decodeBase64, MAX_ATTACHMENT_BASE64, MAX_ATTACHMENT_BYTES, validateAttachment, type AttachmentMetadataInput } from './outbound-content.js';

const MAX_ATTACHMENTS = MAX_ATTACHMENT_BYTES;
const MAX_ENCODED_MESSAGE = 16 * 1024 * 1024;
const MAX_BODY = 512 * 1024;
// Outstanding (queued or attempting) mail per workspace is capped by the account's SES 24-hour quota, which
// the dispatcher keeps synced in the limits tables: a day of backlog is plenty, the floor keeps sandbox and
// brand-new accounts usable, and the ceiling bounds queue bloat. Shared-pool workspaces never inherit the
// pool's quota: they use the floor unless an operator sets a cap. BYO and self-hosted use their own account's.
const SENDING_LIMITS = { pendingFloor: 10000, pendingCeiling: 200000, storedAttachmentBytes: 1024 * 1024 * 1024, expandedCampaignBytes: 128 * 1024 * 1024 } as const;
const limitsTable = (runtime: Pick<Runtime, 'config'>) => sql.identifier(runtime.config.multiTenant ? 'regional_workspace_limits' : 'sending_region_limits');
const pendingCap = (quota: number | string | null, hosted: HostedAllowance | null) => hosted?.pendingCapOverride ?? Math.min(SENDING_LIMITS.pendingCeiling, Math.max(SENDING_LIMITS.pendingFloor, Math.floor(Number(quota) || 0)));
// Preparation is bounded by bytes (4 MiB) and time (10 s) per job; a large row limit keeps small
// campaigns to one scheduler hop instead of one per thousand recipients.
const CAMPAIGN_PREPARE_ROWS = 20000;
const CAMPAIGN_EXPAND_ROWS = 2000;
const CAMPAIGN_CHUNK_BYTES = 4 * 1024 * 1024;
// Estimated final content validated per preparation job. Snapshots are transient here (only their
// digests are kept), so the ten-second bound is the real guard; this keeps a 10k static campaign to one hop.
const CAMPAIGN_PREPARE_BYTES = 64 * 1024 * 1024;
// Materialized-but-unsent rows per campaign / per workspace: about ten seconds of the regional
// send rate, so expansion (a scheduler job with its own latency) never starves the dispatcher.
const CAMPAIGN_BUFFER = 400;
const DAY_MS = 24 * 3600_000;
// Automatic pause: AWS reviews accounts at 5% bounces and 0.1% complaints, so pause well before either,
// once enough mail has been accepted for the rate to be meaningful.
const AUTO_PAUSE = { bounceRate: 0.02, bounceMinimum: 1000, complaintRate: 0.0008, complaintMinimum: 5000, intervalMs: 30 * 60_000 };
// Campaigns stop releasing recipients while SES's remaining 24-hour quota is within this reserve, which
// stays available for transactional mail. The quota itself is read from SES, never configured.
export const sesDailyReserve = (max24: number, percent: number) => Math.ceil(max24 * percent / 100);
export const QUOTA_REFRESH_MS = 60_000;
// A rate-shared campaign aims to release about every five to ten seconds. Each release covers the time actually
// elapsed since the previous one, because a real cycle (queue wake, claim, job) takes 13-20 s in production;
// it never banks more than 20 seconds while waiting, so a pause, hold or stall cannot be caught up at full rate.
const RELEASE_INTERVAL_MS = 5000, RELEASE_BURST_MS = 20000;
const campaignBuffer = (rate: number) => Math.min(20000, Math.max(CAMPAIGN_BUFFER, Math.ceil(rate * 10)));
const workspaceBuffer = (rate: number) => Math.min(50000, Math.max(1000, Math.ceil(rate * 20)));
// Recheck a full buffer or in-flight campaign once its backlog should have drained at the cached
// regional rate; rechecking sooner only repeats the same work. Unknown rates use a fixed interval.
const drainDelayMs = (backlog: number, rate: number, floor = 1000) => rate > 0 ? Math.max(floor, Math.min(15000, Math.ceil(1000 * backlog / rate))) : 5000;
// Called only inside admission transactions, before campaign/attachment locks.
// A workspace row lock serializes admission without Hyperdrive-unsupported
// advisory locks. Reuse the scheduler row without changing its rotation counter.
export function lockAdmission(db: DbExecutor, a: Pick<Actor,'workspaceId'>, claim?: SQL) {
  // ON CONFLICT locks the existing tuple even when its UPDATE predicate is false. No dead tuple per send.
  const lock = sql`INSERT INTO job_schedule (workspace_id) SELECT ${a.workspaceId}::text ${claim ? sql`FROM claim` : sql``}
    ON CONFLICT (workspace_id) DO UPDATE SET turn = job_schedule.turn WHERE false`;
  return db.execute(claim ? sql`WITH claim AS (${claim}), locked AS (${lock}) SELECT 1 FROM claim` : lock);
}
const pendingCounts = (runtime: Pick<Runtime, 'config'>, a: Actor, cost: number, marketing = 0, incoming = 1, marketingRows = 0) => sql`SELECT projected, ${hostedAllowance(runtime.config, a.workspaceId, cost, marketing)} AS hosted,
  (SELECT max(l.max_24_hour_send) FROM ${limitsTable(runtime)} l WHERE l.workspace_id = ${a.workspaceId}
    ${runtime.config.multiTenant ? sql`AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.workspace_id = l.workspace_id AND pc.kind = 'byo')` : sql``}) AS quota
  FROM direct_pending_load(${a.workspaceId},${incoming},${marketingRows})`;
function assertPending(counts: { projected: number; quota: number | string | null; hosted: HostedAllowance | null }) {
  const cap = pendingCap(counts.quota, counts.hosted);
  if (counts.projected > cap) throw new ApiError(429, 'PENDING_EMAIL_LIMIT_EXCEEDED', `This submission exceeds the outstanding email limit of ${cap} for this workspace. Wait for queued mail to dispatch before retrying.`, undefined, true);
}
async function checkPending(runtime: Runtime, db: DbExecutor, a: Actor, cost: number) {
  await lockAdmission(db, a);
  const charge = isSimulatedSes(runtime) ? 0 : cost;
  const { rows: [counts] } = await db.execute<{ projected: number; quota: number | null; hosted: HostedAllowance | null }>(pendingCounts(runtime, a, charge));
  assertHostedAllowance(counts!.hosted, charge);
  assertPending(counts!);
}
const Address = z.string().email().max(254).regex(/^[\x21-\x7e]+$/, 'Use ASCII email addresses (punycode domains are supported).');
const Subject = z.string().min(1).max(998).refine(v => !/[\r\n]/.test(v), 'Subject cannot contain line breaks.');
const FromName = z.string().max(200).refine(v => !/[\x00-\x1f\x7f]/.test(v), 'Sender name cannot contain control characters.');
const PreviewText = z.string().max(200).describe('Optional preheader text. Inserted as escaped hidden text into each outgoing HTML snapshot; draft HTML is unchanged. When set, supply HTML without its own duplicate preheader.');
const Scalar = z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]);
const Data = z.record(z.string().max(120), Scalar).default({});
const StoredTemplateData = z.record(z.string(), z.unknown()).default({}).refine(value => {
  try { return JSON.stringify(value).length <= 262144; } catch { return false; }
}, 'Template data must be JSON serializable and at most 262,144 serialized characters.').describe('JSON substitution data, including nested objects and arrays, is passed unchanged to SES. SES stored templates do not automatically escape HTML: callers must escape untrusted values for their HTML context. Maximum serialized JSON length: 262,144 characters.');
const Region = z.string().min(1).max(40);
const AttachmentIds = z.array(z.string().min(1).max(120)).max(20).default([]);
const ContentFields = { subject: Subject.optional(), html: z.string().min(1).max(MAX_BODY).optional(), text: z.string().min(1).max(MAX_BODY).optional() };
const SendInput = z.object({
  from: Address, fromName: FromName.optional(), to: z.union([Address, z.array(Address).min(1).max(50)]), cc: z.array(Address).max(49).default([]), bcc: z.array(Address).max(49).default([]), replyTo: z.array(Address).max(10).default([]),
  region: Region.optional().describe('Defaults to the installation’s persisted default region when omitted.'), kind: z.enum(['transactional', 'marketing']).default('transactional'), ...ContentFields,
  template: z.object({ name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), data: StoredTemplateData }).strict().describe('Uses native SES stored-template rendering and snapshots its rendered MIME. SES does not automatically escape HTML; callers must escape untrusted HTML-context values. Simulated deployments do not render AWS templates.').optional(),
  attachments: AttachmentIds, tracking: z.boolean().optional(), headers: CustomHeaders.optional(),
  screen: z.boolean().optional().describe('Ask the installation’s content classifier (Jev) whether this message is unsolicited advertising smuggled into a transactional template, e.g. an ad placed in a user-supplied name. Screened messages that look like spam are rejected before delivery with error code CONTENT_REJECTED_SPAM and a reject event; nothing reaches the provider. Transactional messages only; ignored for marketing and when SES is simulated. Skipped (and logged) when the installation has no classifier configured.'),
}).strict().superRefine((v, ctx) => {
  if (v.template ? (v.subject !== undefined || v.html !== undefined || v.text !== undefined) : (!v.subject || (!v.html && !v.text))) ctx.addIssue({ code: 'custom', message: 'Provide subject and html/text, or template, but not both.' });
  if ((Array.isArray(v.to) ? v.to.length : 1) + v.cc.length + v.bcc.length > 50) ctx.addIssue({ code: 'custom', message: 'At most 50 recipients across to/cc/bcc.' });
  if (v.kind === 'marketing' && ((Array.isArray(v.to) ? v.to.length : 1) !== 1 || v.cc.length || v.bcc.length)) ctx.addIssue({ code: 'custom', message: 'Marketing messages require exactly one To recipient and no Cc/Bcc.' });
  if (v.template && (v.attachments.length || v.kind === 'marketing')) ctx.addIssue({ code: 'custom', message: 'Stored templates currently support transactional messages without attachments only.' });
}).openapi('BatchSendEmailItem');
const ReplyAddressId = z.string().min(1).max(120).optional();
const SingleSendInput = SendInput.safeExtend({ replyAddressId: ReplyAddressId.describe('Track a conversation through this receivable address. Use explicit subject and text/html. Requires unrestricted manage permission; From and Reply-To must belong to the address.'), replyMailboxId: ReplyAddressId.openapi({ deprecated: true, description: 'Legacy spelling of replyAddressId.' }) }).refine(v => !(v.replyAddressId && v.replyMailboxId), { path: ['replyAddressId'], message: 'Supply only one reply address ID.' }).openapi('SendEmailInput');
const BatchInput = z.object({ emails: z.array(SendInput).min(1).max(100) }).strict().openapi('SendEmailBatchInput');
const Status = z.enum(['queued', 'attempting', 'accepted', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'delayed', 'suppressed', 'canceled', 'acceptance_unknown', 'simulated']);
const Email = z.object({ id: z.string(), region: z.string(), campaignId: z.string().nullable(), from: z.string(), fromName: z.string().nullable(), kind: z.enum(['transactional', 'marketing']), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), status: Status, providerId: z.string().nullable(), simulated: z.boolean(), attemptStartedAt: z.string().nullable(), errorCode: z.string().nullable(), scheduledAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('Email');
const Receipt = z.object({ id: z.string(), status: z.literal('queued'), simulated: z.boolean() }).openapi('EmailQueued');
const SingleReceipt = z.object({ ...Receipt.shape, inboundMessageId: z.string().optional(), mailboxMessageId: z.string().optional().openapi({ deprecated: true, description: 'Legacy alias for inboundMessageId.' }), threadId: z.string().optional() }).describe('For tracked sends, id is the transactional receipt, inboundMessageId identifies the stored message, and threadId identifies its conversation.').openapi('SingleEmailQueued');
const BatchReceipt = z.object({ data: z.array(Receipt) }).openapi('EmailBatchQueued');
const Event = z.object({ id: z.string(), emailId: z.string(), type: z.string(), providerId: z.string().nullable(), simulated: z.boolean(), createdAt: z.string(), data: z.record(z.string(), z.unknown()) }).openapi('EmailEvent');
const EmailContent = z.object({ subject: z.string(), html: z.string().nullable(), text: z.string().nullable(), raw: z.string().nullable(), attachments: z.array(z.string()), render: z.enum(['direct', 'ses', 'simulated']), templateName: z.string().nullable(), simulated: z.boolean() }).openapi('EmailContent');
const AttachmentInfo = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable(), createdAt: z.string() }).openapi('Attachment');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) }).openapi('DeletedSendingResource');
const DraftAudience = AudienceSpec.partial({ listId: true }).default({});
const BlockHtml = z.string().max(MAX_BODY).describe('Block HTML: h1-h3, p, ul/ol, blockquote, pre>code, hr, img, buttons, columns and styled sections with inline formatting. A constrained email-safe style attribute supports color, typography, spacing, borders, radius and dimensions; arbitrary CSS remains rejected. No wrappers, tables, class or id. Call getContentGuide in MCP or GET /v1/campaign-content-guide for the full vocabulary and examples.');
const CampaignDraftFields = { name: z.string().trim().min(1).max(200), from: z.union([Address, z.literal('')]).default(''), fromName: FromName.optional(), previewText: PreviewText.optional(), replyTo: z.array(Address).max(10).default([]), region: Region, regionPinned:z.boolean().optional().describe('Regional MX only. False follows the From domain; the displayed region is a hint. A supplied region on create or a changed region on edit pins it. To unpin, pass false and omit region.'), subject: z.union([Subject, z.literal('')]).default(''), attachments: AttachmentIds, tracking: z.boolean().default(true), audience: DraftAudience, defaults: Data };
const CAMPAIGN_INPUT_NOTES = 'Drafts may omit sender, subject, content and audience until review or send. Content is block HTML (see html); the same form is what the dashboard composer reads and writes, so people and agents edit one document. Simple {{name}} personalization works in text and quoted href/alt attributes; values are HTML-escaped and rendered URLs are validated. Durable campaign preparation is bounded and runs in background jobs.';
const CampaignInput = z.object({ ...CampaignDraftFields, html: BlockHtml.optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraftInput');
// Stored drafts predating block HTML remain readable; they are revalidated when saved or reviewed.
const CampaignDraftView = z.object({ ...CampaignDraftFields, html: z.string().optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraft');
const CampaignCreate = z.object({ ...CampaignInput.shape, region: Region.optional().describe('Defaults to the installation region. With regional MX delivery, omitting region follows the From domain.'), tracking: z.boolean().optional(), templateId: z.string().regex(/^tpl_[0-9a-f]{32}$/).optional().describe('Copies the active published revision of this global campaign template into a new independent campaign draft.') }).strict().openapi('CreateCampaignInput');
const CampaignReady = CampaignInput.extend({ from: Address, subject: Subject, audience: AudienceSpec }).refine(v => !!v.html?.trim(), { message: 'Provide html before reviewing.', path: ['html'] });
const CampaignStateValue = z.enum(CAMPAIGN_STATES).describe('draft: editable. preparing: the audience is frozen and every message is being validated in the background. scheduled: validated and waiting for scheduledAt. sending: recipients are being released into the dispatch queue. paused: releasing stopped by the user or the health check; queued mail still dispatches. done: every recipient was released and dispatched. failed: preparation or releasing failed (delivery.error); edit or launch again. canceled: terminal.');
const emptyCounts = () => ({ total: 0, byStatus: Object.fromEntries(Status.options.map(status => [status, 0])) as Record<EmailStatus, number> });
const CampaignCounts = z.object({ total: z.number().int().nonnegative(), byStatus: z.record(Status, z.number().int().nonnegative()) }).describe('Counts of immutable campaign email records grouped by their current status, not cumulative provider events or delivery rates. Drafts with no queued emails have zero counts.');
const Failure = z.object({ code: z.string(), message: z.string() });
const Delivery = z.object({ total: z.number().int().describe('Fixed recipient count frozen at send or schedule.'), prepared: z.number().int().describe('Recipients whose message was validated.'), expanded: z.number().int().describe('Recipients materialized as immutable email records.'), canceled: z.number().int().describe('Recipients canceled before materialization. Materialized cancellations remain in counts.byStatus.canceled.'), error: Failure.nullable().describe('Why the campaign failed or was canceled by the system.'),
  pacing: z.object({ perDay: z.number().int().nullable().describe('Maximum recipients released per rolling 24-hour window; null means no daily cap.'), autoPause: z.boolean().describe('Pause automatically when bounce or complaint rates exceed safe thresholds.'), rateShare: z.number().describe('Maximum fraction of the SES per-second send rate this campaign uses; 1 is the full rate.'), windowStartedAt: z.string().nullable(), windowExpanded: z.number().int().describe('Recipients released in the current 24-hour window.'), nextWindowAt: z.string().nullable().describe('When the next 24-hour window opens, when a daily cap is set.') }),
  pausedAt: z.string().nullable(), pauseReason: Failure.nullable(),
  waiting: z.object({ reason: z.enum(['pacing_window', 'ses_daily_quota', 'hosted_daily_quota']), until: z.string() }).nullable().describe('Why releasing recipients is currently held, and the best estimate of until when.') }).describe('The current launch: null until the campaign is sent or scheduled, and cleared by a new revision.').openapi('CampaignDelivery');
function deliveryView(row: typeof campaigns.$inferSelect) {
  if (!row.reviewId) return null;
  const next = row.pacePerDay !== null && row.windowStartedAt ? new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString() : null;
  return Delivery.parse({ total: row.total, prepared: row.prepared, expanded: row.expanded, canceled: row.canceled, error: row.error ?? null,
    pacing: { perDay: row.pacePerDay, autoPause: row.autoPause, rateShare: row.rateShare ?? 1, windowStartedAt: row.windowStartedAt, windowExpanded: row.windowExpanded, nextWindowAt: next },
    pausedAt: row.pausedAt, pauseReason: row.pauseReason ?? null, waiting: row.waitingReason && row.waitingUntil ? { reason: row.waitingReason, until: row.waitingUntil } : null });
}
const Campaign = z.object({ id: z.string(), url: z.string().url().describe('Dashboard URL for opening this campaign. Drafts open in the editor; launched campaigns open in review.'), revision: z.number().int(), draft: CampaignDraftView, sourceTemplateId: z.string().nullable(), sourceTemplateRevision: z.number().int().nullable(), state: CampaignStateValue, scheduledAt: z.string().nullable(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), counts: CampaignCounts, delivery: Delivery.nullable() }).openapi('Campaign');
const CampaignRate = z.object({ value: z.number().nonnegative().nullable().describe('Fraction, not percent. Both counts exclude simulated emails. Null when the denominator is zero or engagement tracking is disabled. Not clamped: delayed feedback can temporarily make outcomes exceed the denominator.'), numerator: z.number().int().nonnegative(), denominator: z.number().int().nonnegative() });
const CampaignStats = z.object({
  id: z.string(), name: z.string(), state: CampaignStateValue, tracking: z.boolean(), counts: CampaignCounts, delivery: Delivery.nullable(),
  totals: z.object({ accepted: z.number().int(), delivered: z.number().int(), bounced: z.number().int(), complained: z.number().int(), opened: z.number().int(), clicked: z.number().int(), failed: z.number().int(), deliveryDelayed: z.number().int(), simulated: z.number().int() }).describe('Lifetime distinct email counts from current state and stored events; outcomes overlap. Accepted excludes simulated mail; other outcomes include simulated events for simulated mail. Opens and clicks include bots and privacy proxies. Failed means rejected or rendering failed; suppressed, canceled and uncertain mail remain in counts.byStatus.'),
  rates: z.object({ delivery: CampaignRate.describe('Delivered / accepted. Receiving-server acceptance, not inbox placement.'), bounce: CampaignRate.describe('Bounced / accepted.'), complaint: CampaignRate.describe('Complained / accepted.'), open: CampaignRate.describe('Unique opened emails / delivered.'), click: CampaignRate.describe('Unique clicked emails / delivered, not click-to-open rate.') }),
}).describe('Lifetime campaign statistics, with no date cutoff or pagination. Done means dispatch finished, not delivery finished. Feedback is asynchronous; missing engagement does not prove nobody read or clicked. Simulated outcomes are never evidence of real delivery.').openapi('CampaignStats');
const CampaignState = Campaign.pick({ id: true, revision: true, updatedAt: true, state: true, scheduledAt: true, archivedAt: true }).describe('Compact state for draft sync polling. Compare all fields, not only revision: archival and delivery state can change without a new draft revision. Fetch the full campaign when state changes. No draft content or delivery counts.').openapi('CampaignState');
const CampaignDraftSummary = CampaignDraftView.pick({ name: true, region: true, from: true, fromName: true, subject: true, previewText: true }).extend({ audience: AudienceSpec.pick({ listId: true, segmentId: true }).partial({ listId: true }).default({}) }).strict().openapi('CampaignDraftSummary');
const CampaignSummary = Campaign.omit({ draft: true }).extend({ draft: CampaignDraftSummary }).describe('Campaign list metadata only. Fetch GET /v1/campaigns/{id} for the complete draft before editing or sending. Content, defaults, attachments and audience exclusions are intentionally omitted.').openapi('CampaignSummary');
const EmailQuery = PageQuery.extend({ campaignId: z.string().max(120).optional(), status: Status.optional(), region: Region.optional(), kind: z.enum(['transactional', 'marketing']).optional(), search: z.string().trim().min(1).max(200).optional().describe('Literal case-insensitive substring of sender, To/Cc/Bcc, subject or email/campaign/provider ID.'), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'from must precede to.').describe('Newest created emails first, with an opaque cursor bound to the filters. Date range is createdAt >= from and < to. Search is literal and case-insensitive across sender address, To/Cc/Bcc recipients, subject and email/campaign/provider IDs. Use status, region, kind and creation-date filters for those fields; error codes, simulation state and timestamps are not free-text fields.').openapi('ListEmailsQuery');
const CampaignQuery = PageQuery.extend({ region: Region.optional(), state: CampaignStateValue.optional(), archived: z.enum(['true', 'false']).default('false').describe('False lists active campaigns; true lists archived campaigns only.'), search: z.string().trim().min(1).max(200).optional() }).describe('Newest created campaigns first, excluding archived campaigns by default, with an opaque cursor bound to the filters. Search is literal, case-insensitive name, subject or ID text.').openapi('ListCampaignsQuery');
const AudienceCounts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int() }).describe('Live counts for the saved audience: matched contacts, those eligible for marketing, and the suppressed or unsubscribed remainder. Read-only; sending freezes its own snapshot and rechecks consent at dispatch.').openapi('CampaignAudienceCounts');

const CampaignUpdate = z.object({ revision: z.number().int().positive(), draft: z.object({ ...CampaignInput.shape, region: Region.optional().describe('Omit to keep the current region selection. An unpinned regional MX draft follows its From domain.') }).strict() }).strict().openapi('CampaignUpdateInput');
const CampaignArchive = z.object({ archived: z.boolean() }).strict().openapi('CampaignArchiveInput');
const CampaignContentGuide = z.object({ format: z.literal('markdown'), markdown: z.string() }).openapi('CampaignContentGuide');
const CampaignPreview = z.object({ html: z.string().describe('Complete rendered email document; empty when the draft has no content.'), text: z.string() }).openapi('CampaignPreview');
const CampaignPreviewImage = z.object({ data: z.string().describe('Canonical base64 PNG screenshot.'), mimeType: z.literal('image/png') }).openapi('CampaignPreviewImage');
const Pacing = z.object({ perDay: z.number().int().min(100).max(10000000).nullable().optional().describe('Release at most this many recipients per rolling 24-hour window. Omit or null for no daily cap. Delivery always also respects the SES 24-hour quota.'), autoPause: z.boolean().default(true).describe('Pause automatically if the bounce rate exceeds 2% (after 1,000 accepted) or the complaint rate exceeds 0.08% (after 5,000 accepted).'),
  rateShare: z.number().min(0.05).max(1).optional().describe('Maximum fraction of the SES per-second send rate this campaign may use; the rest stays free for transactional mail and other campaigns. Defaults to 0.5 for paced campaigns; campaigns sent without pacing use the full rate.') }).strict().openapi('CampaignPacing');
const CampaignSend = z.object({ revision: z.number().int().positive(), pacing: Pacing.optional() }).strict().openapi('CampaignSendInput');
const CampaignSchedule = z.object({ ...CampaignSend.shape, scheduledAt: z.string().datetime({ offset: true }) }).strict().openapi('CampaignScheduleInput');
const CampaignQueued = z.object({ id: z.string(), state: z.literal('preparing'), queued: z.number().int(), scheduledAt: z.string().nullable(), simulated: z.boolean() }).openapi('CampaignQueued');
const CampaignCanceled = z.object({ id: z.string(), state: z.literal('canceled'), canceled: z.number().int(), inFlight: z.number().int() }).openapi('CampaignCanceled');
const TestCampaign = z.object({ to: Address, data: Data }).strict().openapi('CampaignTestInput');
export type SendRequest = z.infer<typeof SendInput>;
const now = () => new Date().toISOString();
// Metadata routes must not materialize HTML, raw MIME or template data from the immutable snapshot.
const emailColumns = {
  id: emails.id, region: emails.region, campaignId: emails.campaignId,
  from: emails.from, fromName: sql<string | null>`${emails.snapshot}->>'fromName'`, kind: sql<'transactional' | 'marketing'>`${emails.snapshot}->>'kind'`,
  to: emails.to, cc: emails.cc, bcc: emails.bcc, subject: emails.subject, status: emails.status,
  providerId: emails.providerId, simulated: emails.simulated, attemptStartedAt: emails.attemptStartedAt,
  errorCode: emails.errorCode, scheduledAt: emails.scheduledAt, createdAt: emails.createdAt, updatedAt: emails.updatedAt,
};
function emailView(row: z.input<typeof Email>) { return Email.parse(row); }
// Draft sync polling reads only state columns, without materializing drafts or aggregating email counts.
const campaignStateColumns = {
  id: campaigns.id, revision: campaigns.revision, updatedAt: campaigns.updatedAt,
  state: campaigns.state, scheduledAt: campaigns.scheduledAt, archivedAt: campaigns.archivedAt,
};
// Project the bounded list draft in PostgreSQL, before driver JSON parsing or application allocation.
const { draft: _draft, ...campaignRowColumns } = getTableColumns(campaigns);
const campaignSummaryColumns = {
  ...campaignRowColumns,
  draft: sql<z.infer<typeof CampaignDraftSummary>>`jsonb_strip_nulls(jsonb_build_object(
    'name', ${campaigns.draft}->'name', 'region', ${campaigns.draft}->'region', 'from', ${campaigns.draft}->'from',
    'fromName', ${campaigns.draft}->'fromName', 'subject', ${campaigns.draft}->'subject', 'previewText', ${campaigns.draft}->'previewText',
    'audience', jsonb_build_object('listId', ${campaigns.draft}->'audience'->'listId', 'segmentId', ${campaigns.draft}->'audience'->'segmentId')
  ))`,
};
function campaignUrl(runtime: Runtime, row: { id: string; state: CampaignState; expanded: number }) {
  const url = new URL(`/campaigns/${encodeURIComponent(row.id)}/${campaignEditable(row) ? 'edit' : 'review'}`, runtime.config.publicUrl);
  return url.href;
}
type CampaignRow = Omit<typeof campaigns.$inferSelect, 'draft'> & { draft: unknown };
async function campaignViews<T extends CampaignRow>(runtime: Runtime, a: Actor, rows: T[], listOrigin?: string) {
  if (!rows.length) return [];
  const load = async () => runtime.db.select({ campaignId: emails.campaignId, status: emails.status, count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), inArray(emails.campaignId, rows.map(row => row.id)))).groupBy(emails.campaignId, emails.status);
  // Only dashboard lists may reuse counts. Detail, mutations and machine credentials stay exact.
  const grouped = listOrigin && a.credential === 'dashboard'
    ? (await cachedDashboardRead(listOrigin,JSON.stringify(['campaign-counts',a.workspaceId,rows.map(r=>[r.id,r.updatedAt])]),load)).value : await load();
  return rows.map(row => {
    const counts = emptyCounts();
    for (const item of grouped) if (item.campaignId === row.id) { counts.byStatus[item.status] = Number(item.count); counts.total += Number(item.count); }
    return { ...row, url: campaignUrl(runtime, row), counts, delivery: deliveryView(row as typeof campaigns.$inferSelect) };
  });
}
async function pageBinding(a: Actor, resource: string, query: Record<string, unknown>) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  // This fixed field is part of the hash in already-issued email and campaign cursors.
  return (await digest(canonical({ workspaceId: a.workspaceId, environment: 'live', resource, filters }))).slice(0, 24);
}
function readCursor(value: string | undefined, binding: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const tuple = z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(120), z.literal(binding)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: tuple[0], id: tuple[1] };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters.', 'cursor'); }
}
function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url') : null;
}
function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
export const scope = (table: { workspaceId: AnyPgColumn }, a: Pick<Actor, 'workspaceId'>) => eq(table.workspaceId, a.workspaceId);
export const mailWhere = (a: Pick<Actor, 'workspaceId'>, emailId: string) => and(scope(emails, a), eq(emails.id, emailId));
export const campaignWhere = (a: Actor, campaignId: string) => and(scope(campaigns, a), eq(campaigns.id, campaignId));
function keySender(a: Actor, from: string) {
  const domain = from.split('@')[1]!.toLowerCase();
  if (!senderDomainAllowed(a.domains, domain)) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'This API key cannot send from this domain or its parent domain.', 'from');
}
function verifiedSender(a: Actor, from: string, verified: boolean) {
  keySender(a, from);
  if (!verified) throw unverifiedSender();
}
// Reuse the existing region-lock round trip for non-batch admission (including mailbox replies).
async function sendingRegion(runtime: Runtime, db: DbExecutor, a: Actor, from: string, requested?: string):Promise<{region:string;binding?:SendingBinding}> {
  if (!runtime.config.multiTenant) {
    const selected = await assertRegionEnabled(db, a.workspaceId, requested);
    keySender(a, from); return {region:selected};
  }
  if (regionalSending(runtime)) {
    keySender(a,from);
    const host=from.split('@')[1]!.toLowerCase();
    const row=(await db.execute<SenderRoute>(sql`SELECT r.* FROM ses_installation_settings s CROSS JOIN LATERAL regional_sender(s.workspace_id,${host},${isSimulatedSes(runtime)}) r WHERE s.workspace_id=${a.workspaceId} FOR SHARE OF s`)).rows[0];
    const route=checkRoute(runtime,row,requested);
    a.dispatchAccount={aws_account_id:route.connection!.aws_account_id,kind:route.connection!.kind};
    return {region:route.region,binding:route.binding};
  }
  const selected = sql`coalesce(${requested ?? null}, s.default_region)`;
  const state = (await db.execute<{ region: string; enabled_regions: string[]; verified: boolean; aws_account_id: string | null; kind: ReadyConnection['kind']; tenant_state: TenantState; pause_reason: string | null }>(sql`SELECT ${selected} AS region, s.enabled_regions, pc.aws_account_id, pc.kind, pc.tenant_state, pc.pause_reason,
    ${verifiedClaim(sql`s.workspace_id`, selected, sql`${from.split('@')[1]!.toLowerCase()}::text`)} AS verified
    FROM ses_installation_settings s LEFT JOIN ${sendingConnections(runtime)} pc ON pc.workspace_id=s.workspace_id AND pc.region=${selected}
    WHERE s.workspace_id=${a.workspaceId} FOR SHARE OF s`)).rows[0];
  if (!state) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
  if (!state.enabled_regions.includes(state.region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested SES region is not enabled.', 'region');
  verifiedSender(a, from, state.verified);
  if (!state.aws_account_id) throw new ApiError(409, 'CONNECTION_REQUIRED', 'Set up a sending connection for this workspace and region.');
  if (state.pause_reason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', state.pause_reason);
  assertTenantReady(state, isSimulatedSes(runtime));
  a.dispatchAccount = { aws_account_id: state.aws_account_id, kind: state.kind };
  return {region:state.region};
}
function draftSender(runtime: Runtime, a: Actor, draft: CampaignDraft) {
  if (!regionalSending(runtime)) region(runtime, draft.region);
  if (draft.from) keySender(a, draft.from);
}
async function draftRegion(runtime:Runtime,db:DbExecutor,a:Actor,input:{from:string;region?:string;regionPinned?:boolean},previous?:CampaignDraft) {
  if (!regionalSending(runtime)) return {region:await assertRegionEnabled(db,a.workspaceId,input.region ?? previous?.region),regionPinned:previous?.regionPinned};
  // A whole-draft PATCH often echoes the displayed region. Preserve its provenance, not
  // just its value. Pre-rollout drafts with a sender or a nondefault selection retain it.
  const fallback=runtime.config.regions[0]!;
  const changed=previous!==undefined && input.region!==undefined && input.region!==previous.region;
  const inherited=previous ? previous.regionPinned ?? (!!previous.from || previous.region!==fallback) : input.region!==undefined;
  const pinned=changed || (input.regionPinned ?? inherited);
  if (pinned) {
    const selected=input.region ?? previous?.region ?? fallback;
    if (!regionPattern.test(selected)) throw new ApiError(422,'INVALID_REGION','Use a valid AWS region.','region');
    return {region:selected,regionPinned:true};
  }
  // Draft hints are not send authorization: a pending or disabled closest claim still wins,
  // and an unbound claim shadows its parent. No proof, pool readiness or tenant hold check.
  const host=input.from.split('@')[1]?.toLowerCase();
  const hint=host && (await db.execute<{region:string|null}>(sql`SELECT b.region FROM domain_claims dc LEFT JOIN domain_sending_bindings b USING(workspace_id,name,connection_id)
    WHERE dc.workspace_id=${a.workspaceId} AND right('.'||${host},length(dc.name)+1)='.'||dc.name ORDER BY length(dc.name) DESC LIMIT 1`)).rows[0]?.region;
  return {region:hint || fallback,regionPinned:false};
}
const campaignSendRegion=(runtime:Runtime,draft:CampaignDraft)=>regionalSending(runtime) && draft.regionPinned===false ? undefined : draft.region;
function readyCampaign(draft: CampaignDraft) {
  const parsed = CampaignReady.safeParse(draft);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))];
    throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', `Complete these campaign fields before review: ${fields.join(', ')}.`, fields.join(', '));
  }
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
// Documents the optional header read by idempotent() in the OpenAPI reference and SDK types. The
// length/pattern constraints are OpenAPI metadata only, so idempotent() still validates the key and
// keeps returning INVALID_IDEMPOTENCY_KEY rather than a generic validation error.
export const IdempotencyHeaders = z.object({
  'Idempotency-Key': z.string().optional().openapi({
    minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]+$', example: 'order-4821-receipt',
    description: 'Optional. Makes retries safe. Repeating a request with the same key and the same body returns the original result without performing the write again; a concurrent duplicate waits for the first request and returns its result. Reusing a key with a different body returns 409 IDEMPOTENCY_CONFLICT. Keys are scoped to the API key and request path, and are retained indefinitely. Without a key, every request is processed, so a retried send can deliver twice.',
  }),
});
export async function idempotent<T extends Record<string, unknown>>(c: Ctx, a: Actor, body: unknown, work: (db: DbExecutor) => Promise<T>, admissionReceipt?: T,prepareOutside?:()=>Promise<void>): Promise<T> {
  const key = c.req.header('Idempotency-Key');
  if (key === undefined) { await prepareOutside?.();return c.env.db.transaction(async db => { if (admissionReceipt) await lockAdmission(db, a); return work(db); }); }
  if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
  const requestHash = await digest(canonical(body));
  const where = and(scope(sendingIdempotency, a), eq(sendingIdempotency.actorKeyId, a.keyId), eq(sendingIdempotency.path, c.req.path), eq(sendingIdempotency.requestKey, key));
  if(prepareOutside){
    const [existing]=await c.env.db.select().from(sendingIdempotency).where(where);
    if(existing){if(existing.requestHash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','This idempotency key was already used with a different request.');if(existing.result)return existing.result as T;}
    await prepareOutside(); // The unique insert below still arbitrates concurrent first attempts.
  }
  return c.env.db.transaction(async db => {
    const identity = { workspaceId: a.workspaceId, actorKeyId: a.keyId, path: c.req.path, requestKey: key };
    const claim = db.insert(sendingIdempotency).values({ ...identity, requestHash, result: admissionReceipt }).onConflictDoNothing().returning({ claimed: sql`1` });
    // Direct receipts contain only preallocated IDs. Claim the final result and lock admission only for the winner.
    const inserted = admissionReceipt ? (await lockAdmission(db, a, claim.getSQL())).rows : await claim;
    if (!inserted.length) {
      const [previous] = await db.select().from(sendingIdempotency).where(where);
      if (!previous || previous.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.');
      // The unique insert waits for the other transaction; its result commits atomically with the row.
      if (!previous.result) throw new ApiError(500, 'IDEMPOTENCY_RESULT_MISSING', 'The stored idempotency result is unavailable.');
      return previous.result as T;
    }
    const result = await work(db);
    if (!admissionReceipt) await db.update(sendingIdempotency).set({ result }).where(where);
    return result;
  });
}
async function findEmail(db: DbExecutor, a: Actor, emailId: string) {
  const [row] = await db.select().from(emails).where(mailWhere(a, emailId));
  if (!row) notFound('Email');
  return row;
}
async function visibleEmailContent(runtime: Runtime,a: Actor,row: typeof emails.$inferSelect) {
  // Sent campaign emails store a stub; queued ones have no body yet (html/text null, as before).
  const s = row.snapshot.deferredCampaign && row.snapshot.unsubscribeUrl ? await sentCampaignContent(runtime, a, row) : row.snapshot;
  const manage = a.permissions.includes('manage');
  // App-owned capabilities only, not a general sanitizer for transactional bearer links.
  // Raw MIME can hide tokens inside encodings/folding; only managers receive that opaque content.
  const visible = (value: string | undefined) => value === undefined ? null : manage ? value : redactCapabilityText(value);
  return EmailContent.parse({ subject: visible(s.subject), html: visible(s.html), text: visible(s.text), raw: manage ? s.raw ?? null : null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated });
}
function visibleEmailEvent(a: Actor, row: z.input<typeof Event>) {
  return Event.parse({ ...row, data: a.permissions.includes('manage') ? row.data : redactCapabilityData(row.data) });
}
async function findCampaign(db: DbExecutor, a: Actor, campaignId: string, lock: boolean | 'share' = false) {
  const query = db.select().from(campaigns).where(campaignWhere(a, campaignId));
  const [row] = await (lock ? query.for(lock === 'share' ? 'share' : 'update') : query);
  if (!row) notFound('Campaign');
  return row;
}
type AttachmentSize = Pick<typeof attachments.$inferSelect, 'id' | 'size' | 'contentId'>;
function distinctAttachmentIds(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new ApiError(422, 'DUPLICATE_ATTACHMENT', 'An attachment can appear only once per message.');
  return ids;
}
function validateAttachmentRows(ids: string[], rows: AttachmentSize[]) {
  if (rows.length !== ids.length) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'One or more attachments were not found in this workspace.');
  if (rows.reduce((n, row) => n + row.size, 0) > MAX_ATTACHMENTS) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Combined attachments may not exceed 8 MiB of decoded data.');
  const cid = rows.flatMap(r => r.contentId ? [r.contentId] : []);
  if (new Set(cid).size !== cid.length) throw new ApiError(422, 'DUPLICATE_CONTENT_ID', 'Inline content IDs must be unique.');
}
export async function attachmentRows(db: DbExecutor, a: Actor, ids: string[], lock = false) {
  if (!ids.length) return [];
  const query = db.select().from(attachments).where(and(scope(attachments, a), inArray(attachments.id, distinctAttachmentIds(ids)))).orderBy(asc(attachments.id));
  const rows = await (lock ? query.for('update') : query);
  validateAttachmentRows(ids, rows);
  return rows;
}
async function linkAttachments(db: DbExecutor, a: Actor, ids: string[], ownerType: 'email' | 'campaign' | 'review', ownerId: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  // A campaign may reuse metadata already ownership-checked and locked in this same transaction.
  if (!lockedAttachments) await attachmentRows(db, a, ids, true);
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType, ownerId }))).onConflictDoNothing();
}
function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
export function formattedSender(from: string, fromName?: string, foldMime = false): string {
  // Domain authorization always uses the bare address; formatting happens only at the MIME/SES boundary.
  Address.parse(from);
  if (!fromName) return from;
  FromName.parse(fromName);
  if (/^[\x20-\x7e]+$/.test(fromName)) return `"${fromName.replace(/["\\]/g, '\\$&')}" <${from}>`;
  // RFC 2047 encoded words, each below 75 characters and never splitting a UTF-8 code point.
  const words: string[] = []; let chunk = '';
  for (const character of fromName) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  const separator = foldMime ? '\r\n ' : ' ';
  return `${words.join(separator)}${separator}<${from}>`;
}
// SES Simple puts CID images beside the body in multipart/mixed. Build only
// the inline-image case ourselves so each image is related to its HTML part.
export function inlineMessage(snapshot: EmailSnapshot, parts: Attachment[]): Uint8Array {
  const crlf = '\r\n';
  const base64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join(crlf) ?? '';
  const encodedWords = (value: string) => {
    const words: string[] = []; let chunk = '';
    for (const character of value) {
      if (Buffer.byteLength(chunk + character) > 45) { words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`); chunk = ''; }
      chunk += character;
    }
    if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
    return words.join(`${crlf} `);
  };
  const quotedPrintable = (value: string) => {
    const lines: string[] = []; let line = '';
    const flush = (soft: boolean) => { lines.push(soft ? `${line}=` : line.replace(/[ \t]$/, c => c === ' ' ? '=20' : '=09')); line = ''; };
    for (const byte of Buffer.from(value.replace(/\r\n|\r|\n/g, '\n'), 'utf8')) {
      if (byte === 0x0a) { flush(false); continue; }
      const token = byte === 0x3d || (byte < 0x20 && byte !== 0x09) || byte > 0x7e ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
      if (line.length + token.length > 73) flush(true);
      line += token;
    }
    flush(false);
    return lines.join(crlf);
  };
  const textPart = (type: 'plain' | 'html', body: string) => `Content-Type: text/${type}; charset=UTF-8${crlf}Content-Transfer-Encoding: quoted-printable${crlf}${crlf}${quotedPrintable(body)}`;
  const multipart = (type: 'related' | 'alternative' | 'mixed', children: string[]) => {
    const boundary = `opensend_${crypto.randomUUID()}`;
    return `Content-Type: multipart/${type}; boundary="${boundary}"${type === 'related' ? '; type="text/html"' : ''}${crlf}${crlf}` +
      children.map(child => `--${boundary}${crlf}${child}${crlf}`).join('') + `--${boundary}--${crlf}`;
  };
  const filePart = (part: Attachment) => {
    if (!part.RawContent || !part.FileName || !part.ContentType || /[\r\n]/.test(part.ContentType) || (part.ContentId && !/^[a-zA-Z0-9_.@-]+$/.test(part.ContentId))) throw new ApiError(422, 'INVALID_MIME_ATTACHMENT', 'Attachment metadata cannot be encoded safely.');
    // RFC 2231 continuations preserve Unicode/quotes and keep filename lines short.
    const filename = [...Buffer.from(part.FileName)].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('').match(/.{1,60}/g)!;
    const disposition = part.ContentDisposition === 'INLINE' ? 'inline' : 'attachment';
    const parameters = filename.map((value, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ''}${value}`).join(`;${crlf}`);
    return `Content-Type: ${part.ContentType}${crlf}Content-Transfer-Encoding: base64${crlf}Content-Disposition: ${disposition};${crlf}${parameters}${crlf}` +
      (part.ContentId ? `Content-ID: <${part.ContentId}>${crlf}` : '') + `${crlf}${base64(part.RawContent)}`;
  };
  const inline = parts.filter(part => part.ContentDisposition === 'INLINE');
  const files = parts.filter(part => part.ContentDisposition !== 'INLINE');
  let body = multipart('related', [textPart('html', snapshot.html!), ...inline.map(filePart)]);
  if (snapshot.text !== undefined) body = multipart('alternative', [textPart('plain', snapshot.text), body]);
  if (files.length) body = multipart('mixed', [body, ...files.map(filePart)]);
  // Bcc stays only in the SES envelope, never the MIME headers.
  const headers = [
    `From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`,
    `To: ${snapshot.to.join(`,${crlf} `)}`,
    ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(`,${crlf} `)}`] : []),
    ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(`,${crlf} `)}`] : []),
    `Subject: ${/^[\x20-\x7e]{1,900}$/.test(snapshot.subject) && !snapshot.subject.includes('=?') ? snapshot.subject : encodedWords(snapshot.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...snapshot.headers.map(header => {
      if (!/^[A-Za-z0-9-]+$/.test(header.Name) || /[\r\n]/.test(header.Value)) throw new ApiError(422, 'INVALID_MIME_HEADER', 'Message headers cannot contain line breaks.');
      return `${header.Name}: ${header.Value}`;
    }),
  ];
  // Body/attachment lines are bounded by their encoders. Check only message
  // headers rather than splitting a potentially multi-megabyte MIME body.
  if (headers.some(header => header.split(crlf).some(line => Buffer.byteLength(line) > 998))) throw new ApiError(422, 'MIME_LINE_TOO_LONG', 'An encoded message header exceeds the SMTP line limit.');
  const bytes = Buffer.from([...headers, body].join(crlf), 'utf8');
  if (bytes.length > MAX_ENCODED_MESSAGE) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', 'Encoded MIME exceeds the 16 MiB message limit.');
  return bytes;
}
function withPreheader(html: string | undefined, previewText?: string): string | undefined {
  if (!html || !previewText) return html;
  const stack: DefaultTreeAdapterMap['node'][] = [parse(html, { sourceCodeLocationInfo: true })];
  let bodyOffset = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node && node.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      if (node.tagName === 'body') bodyOffset = node.sourceCodeLocation?.startTag?.endOffset ?? 0;
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  const preheader = `<div data-opensend-preview="true" data-skip-in-text="true" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escaped(previewText)}</div>`;
  return html.slice(0, bodyOffset) + preheader + html.slice(bodyOffset);
}
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'longdesc', 'data', 'codebase', 'profile', 'manifest', 'xlink:href']);
const TEXT_ATTRIBUTES = new Set(['title', 'alt', 'aria-label', 'aria-description']);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript', 'plaintext']);
function validateUrl(value: string) {
  // The HTML parser has already decoded all character references (not just a regex subset).
  const normalized = value.replace(/[\x00-\x20\x7f]/g, '');
  let url: URL;
  try { url = new URL(normalized, 'https://template.invalid/'); } catch { throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML contains an invalid URL.'); }
  if (!['http:', 'https:', 'mailto:', 'tel:', 'cid:'].includes(url.protocol)) throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML URLs must use HTTP(S), mailto, tel, CID, or relative references.');
}
function inspectHtml(source: string, template = false) {
  const safe: { start: number; end: number }[] = [];
  const stack: { node: DefaultTreeAdapterMap['node']; unsafe: boolean }[] = [{ node: parse(source, { sourceCodeLocationInfo: true }), unsafe: false }];
  while (stack.length) {
    const { node, unsafe } = stack.pop()!;
    const element = 'tagName' in node ? node : undefined;
    const blocked = unsafe || !!element && (RAW_TEXT_ELEMENTS.has(element.tagName) || element.namespaceURI !== 'http://www.w3.org/1999/xhtml');
    if (node.nodeName === '#text' && !blocked && node.sourceCodeLocation) {
      const { startOffset: start, endOffset: end } = node.sourceCodeLocation;
      // HTML error recovery can coalesce text across ignored markup. Never trust such a
      // broad location as a text-only range; literal less-than signs should use &lt;.
      if (!source.slice(start, end).includes('<')) safe.push({ start, end });
    }
    if (element) {
      for (const attr of element.attrs) {
        const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
        // Template structure is checked before rendering; validate complete URLs only after substitution.
        if (!template && URL_ATTRIBUTES.has(name)) validateUrl(attr.value);
        if (!template && ['srcset', 'imagesrcset', 'ping', 'archive'].includes(name)) {
          const urls = name.endsWith('srcset') ? attr.value.split(',').map(part => part.trim().split(/\s+/)[0]!) : attr.value.trim().split(/\s+/);
          for (const url of urls) if (url) validateUrl(url);
        }
        if (template && !blocked && (URL_ATTRIBUTES.has(name) || TEXT_ATTRIBUTES.has(name))) {
          const location = element.sourceCodeLocation?.attrs?.[name];
          if (!location) continue;
          const original = source.slice(location.startOffset, location.endOffset);
          // Parser offsets identify the attribute; this only checks its lexical quoting, never parses HTML.
          const quoted = original.match(/^[^\s=]+\s*=\s*(["'])/);
          if (quoted && original.endsWith(quoted[1]!)) safe.push({ start: location.startOffset + quoted[0].length, end: location.endOffset - 1 });
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) stack.push({ node: child, unsafe: blocked });
    if (element && 'content' in element) stack.push({ node: (element as DefaultTreeAdapterMap['template']).content, unsafe: blocked });
  }
  safe.sort((a, b) => a.start - b.start); let rangeIndex = 0;
  if (template) for (const match of source.matchAll(/{{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*}}/g)) {
    while (safe[rangeIndex] && safe[rangeIndex]!.end <= match.index) rangeIndex++;
    const range = safe[rangeIndex];
    if (!range || match.index < range.start || match.index + match[0].length > range.end) throw new ApiError(422, 'UNSAFE_TEMPLATE_CONTEXT', 'Campaign placeholders require HTML text nodes or quoted URL/title/alt/aria-label/aria-description attributes. Unquoted attributes, tag names, comments, script/style, event handlers and foreign markup are unsupported.');
  }
}
function validateInterpolationTemplate(source: string | undefined, html: boolean) {
  if (!source) return;
  const unsupported = source.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, '');
  // Nested CSS blocks legitimately end in }}. Only an unmatched opening delimiter begins unsupported template syntax.
  if (unsupported.includes('{{')) throw new ApiError(422, 'UNSUPPORTED_TEMPLATE_SYNTAX', 'Campaigns support simple {{name}} substitutions, not helpers, HTML fragments, or Liquid syntax.');
  if (html) inspectHtml(source, true);
}
function interpolate(source: string | undefined, values: Record<string, unknown>, html: boolean, templateValidated = false): string | undefined {
  if (!source) return source;
  if (!templateValidated) validateInterpolationTemplate(source, html);
  let result = ''; let offset = 0;
  for (const match of source.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)) {
    const key = match[1]!;
    if (!Object.hasOwn(values, key) || values[key] === undefined || values[key] === null) throw new ApiError(422, 'MISSING_TEMPLATE_VARIABLE', `A value is required for ${key}.`, key);
    const value = html ? escaped(String(values[key])) : String(values[key]);
    const prefix = source.slice(offset, match.index);
    if (result.length + prefix.length + value.length > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
    result += prefix + value; offset = match.index + match[0].length;
  }
  if (result.length + source.length - offset > MAX_BODY) throw new ApiError(413, 'RENDERED_CONTENT_TOO_LARGE', 'A personalized body part exceeds 512 KiB characters. Reduce the content or repeated substitutions.');
  return result + source.slice(offset);
}
function validateHtmlUrls(html: string | undefined) {
  if (html) inspectHtml(html);
}
export function sizeCheck(snapshot: EmailSnapshot, rows: { size: number }[]) {
  const bytes = new TextEncoder().encode((snapshot.raw ?? '') + (snapshot.html ?? '') + (snapshot.text ?? '') + snapshot.subject).length;
  // Conservatively reserve base64/MIME expansion, line folding and headers. This is an application cap, not SES's 40 MB maximum.
  const encoded = Math.ceil(bytes * 1.4) + rows.reduce((sum, r) => sum + Math.ceil(r.size / 3) * 4 * 1.04 + 2048, 0) + 16384;
  if (encoded > MAX_ENCODED_MESSAGE) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', 'Estimated encoded MIME exceeds the initial 16 MiB message limit.');
}
// The renderer owns the MIME content, not the envelope or custom headers. A
// substituted Subject can contain physical header lines, including obsolete From : forms.
function renderedMimeHeaders(block:string) {
  const headers:string[]=[],seen=new Set<string>();
  for (const field of block.split(/\r\n(?![ \t])/)) {
    const allowed=/^(subject|mime-version|content-[a-z0-9-]+):/i.exec(field);
    if (!allowed) continue; // Drop the entire untrusted field, continuations included.
    const name=allowed[1]!.toLowerCase(),unfolded=field.replace(/\r\n[ \t]+/g,' ');
    if (seen.has(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded)) throw new ApiError(422,'INVALID_RENDERED_MIME','SES rendered an ambiguous or invalid MIME header.');
    seen.add(name);
    // Preserve legal folding only when unfolding would exceed the SMTP line limit.
    if (field.split('\r\n').some(line=>Buffer.byteLength(line)>998)) throw new ApiError(422,'INVALID_RENDERED_MIME','A rendered MIME header line exceeds the SMTP limit.');
    headers.push(Buffer.byteLength(unfolded)>998?field:unfolded);
  }
  return headers;
}
function marketingFooter(snapshot: EmailSnapshot, url: string) {
  if (snapshot.html) {
    const footer = `<p style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#595959;margin:24px 0 0"><a href="${escaped(url)}" style="color:#595959;text-decoration:underline">Unsubscribe</a></p>`;
    const close = snapshot.html.search(/<\/td>\s*<\/tr>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i);
    snapshot.html = close >= 0 ? snapshot.html.slice(0, close) + footer + snapshot.html.slice(close) : snapshot.html + footer;
  }
  snapshot.text = (snapshot.text ?? '') + `\n\nUnsubscribe: ${url}`;
  // Keep caller headers; the unsubscribe pair is always OpenSend's own.
  snapshot.headers = [...snapshot.headers.filter(header => !/^list-unsubscribe/i.test(header.Name)), { Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
}
async function prepare(runtime: Runtime, db: DbExecutor, a: Actor, request: SendRequest, preview = false, lockedAttachments?: AttachmentSize[], sharedValidated = false, htmlValidated = false, preparedUnsubscribeUrl?: string, connection?: ReadyConnection): Promise<EmailSnapshot> {
  const route = sharedValidated ? {region:request.region!} : runtime.config.multiTenant ? await sendingRegion(runtime,db,a,request.from,request.region) : {region:await assertRegionEnabled(db,a.workspaceId,request.region)};
  const input = { ...request, region:route.region };
  if (!sharedValidated) {
    if (!isSimulatedSes(runtime) && !runtime.config.multiTenant) await assertLiveRegionReady(runtime, db, input.region, input.kind, false, a.workspaceId);
    if (!runtime.config.multiTenant) keySender(a, input.from);
  }
  const snapshot: EmailSnapshot = { from: input.from, ...(input.fromName !== undefined ? { fromName: input.fromName } : {}), to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo, region: input.region, kind: input.kind, subject: input.subject ?? '', html: input.html, text: input.text, attachments: input.attachments, tracking: input.tracking ?? input.kind === 'marketing', headers: (input.headers ?? []).map(header => ({ Name: header.name, Value: header.value })), ...(input.screen && input.kind === 'transactional' ? { screen: true } : {}) };
  const rows = lockedAttachments ?? await attachmentRows(db, a, input.attachments, true);
  if (route.binding) snapshot.binding=route.binding;
  if (!htmlValidated) validateHtmlUrls(snapshot.html);
  if (input.template) {
    if (runtime.config.multiTenant && connection?.kind !== 'byo') throw new ApiError(422, 'SHARED_STORED_TEMPLATE_UNSUPPORTED', 'AWS-stored templates require a bring-your-own AWS connection. Use explicit content on shared sending.', 'template');
    // Preserve native SES semantics in both HTML and plaintext; callers own context-specific escaping.
    const templateData = JSON.stringify(input.template.data);
    if (templateData.length > 262144) throw new ApiError(413, 'TEMPLATE_DATA_TOO_LARGE', 'Serialized template data exceeds 262,144 characters.');
    if (isSimulatedSes(runtime)) {
      throw new ApiError(422, 'SIMULATED_TEMPLATE_UNSUPPORTED', 'Simulated sending supports explicit content and campaigns, not AWS-stored templates.');
    } else {
      const ses = getSes(runtime, input.region, forDelivery(connection,{purpose:'template',name:input.template.name}));
      const before = await ses.send(new GetEmailTemplateCommand({ TemplateName: input.template.name }));
      const rendered = await ses.send(new TestRenderEmailTemplateCommand({ TemplateName: input.template.name, TemplateData: templateData }));
      const after = await ses.send(new GetEmailTemplateCommand({ TemplateName: input.template.name }));
      if (canonical(before.TemplateContent) !== canonical(after.TemplateContent)) throw new ApiError(409, 'TEMPLATE_CHANGED', 'The stored template changed during rendering; retry the request.');
      if (!rendered.RenderedTemplate) throw new ApiError(422, 'TEMPLATE_RENDER_EMPTY', 'SES did not return rendered MIME content.');
      snapshot.subject = before.TemplateContent?.Subject ?? '';
      snapshot.template = { ...input.template, source: before.TemplateContent ?? {}, render: 'ses' };
      // Keep SES's complete rendered MIME rather than treating advanced stored-template syntax as an inline template.
      const normalized = rendered.RenderedTemplate.replace(/\r?\n/g, '\r\n');
      const split = normalized.indexOf('\r\n\r\n');
      if (split < 0) throw new ApiError(422, 'INVALID_RENDERED_MIME', 'SES rendered content has no MIME header/body separator.');
      const headers = renderedMimeHeaders(normalized.slice(0,split));
      snapshot.raw = [`From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`, `To: ${snapshot.to.join(', ')}`, ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(', ')}`] : []), ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(', ')}`] : []), ...headers, ...snapshot.headers.map(header => `${header.Name}: ${header.Value}`)].join('\r\n') + normalized.slice(split);
    }
  }
  if (input.kind === 'marketing' && !preview) {
    const url = preparedUnsubscribeUrl ?? await unsubscribeUrl(runtime, a.workspaceId, snapshot.to[0]!, db);
    marketingFooter(snapshot, url);
  }
  sizeCheck(snapshot, rows);
  return snapshot;
}
async function queueEmail(runtime: Runtime, db: DbExecutor, a: Actor, snapshot: EmailSnapshot, campaignId?: string, availableAt?: string, requestId?: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  const emailId = id('email');
  await db.insert(emails).values({ id: emailId, workspaceId: a.workspaceId, actorKeyId: a.keyId, region: snapshot.region, campaignId: campaignId ?? null, from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, snapshot, simulated: isSimulatedSes(runtime), scheduledAt: availableAt ?? null });
  await linkAttachments(db, a, snapshot.attachments, 'email', emailId, lockedAttachments);
  // The row itself is the dispatch queue entry; the request's response path nudges that region's dispatcher.
  void requestId;
  noteDispatch(a, snapshot);
  return { id: emailId, status: 'queued' as const, simulated: isSimulatedSes(runtime) };
}
function noteDispatch(a: Actor, { region, kind }: EmailSnapshot) {
  const targets = a.dispatchTargets ??= new Map();
  const target = targets.get(region) ?? { count: 0, priority: false };
  target.count++; target.priority ||= kind === 'transactional'; targets.set(region, target);
}
type AdmissionState = { projected: number; quota: number | null; hosted: HostedAllowance | null; default_region: string | null; enabled_regions: string[]; verified: string[]; routes?: Record<string,SenderRoute>; assets: AttachmentSize[] | null; connection: (Pick<ReadyConnection,'aws_account_id'|'kind'> & { region: string; tenant_state: TenantState }) | null };
function checkCapacity(state: AdmissionState, cost: number, marketing: number) {
  assertHostedAllowance(state.hosted, cost, marketing);
  assertPending(state);
  if (state.default_region === null) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
}
function checkSender(runtime: Runtime, a: Actor, state: AdmissionState, mail: SendRequest) {
  if (regionalSending(runtime)) {
    keySender(a,mail.from);
    const route=checkRoute(runtime,state.routes?.[mail.from.split('@')[1]!.toLowerCase()],mail.region);
    a.dispatchAccount={aws_account_id:route.connection!.aws_account_id,kind:route.connection!.kind};
    return route.region;
  }
  const region = mail.region ?? state.default_region!;
  if (!state.enabled_regions.includes(region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested SES region is not enabled.', 'region');
  if (runtime.config.multiTenant) {
    verifiedSender(a, mail.from, state.verified.includes(`${mail.from.split('@')[1]!.toLowerCase()}:${region}`));
    if (state.connection?.region !== region) throw new ApiError(409, 'CONNECTION_REQUIRED', 'Set up a sending connection for this workspace and region.');
    assertTenantReady(state.connection, isSimulatedSes(runtime));
  }
  return region;
}
async function admitEmails(c: Ctx, a: Actor, input: SendRequest | { emails: SendRequest[] }) {
  const batch = 'emails' in input, mails = batch ? input.emails : [input];
  const data = mails.map(() => ({ id: id('email'), status: 'queued' as const, simulated: isSimulatedSes(c.env) }));
  const receipt = batch ? { data } : data[0]!;
  const mx = c.env.config.multiTenant, simulated = isSimulatedSes(c.env);
  const regional=regionalSending(c.env), hosts=mails.map(m=>m.from.split('@')[1]!.toLowerCase());
  let cost = 0, marketing = 0;
  if (mx && !simulated) for (const mail of mails) {
    const n = hostedCost(mail.to, mail.cc, mail.bcc); cost += n; if (mail.kind === 'marketing') marketing += n;
  }
  const assetIds = [...new Set(mails.flatMap(mail => mail.attachments))];
  if (mx && mails.every(m => !m.template) && !assetIds.some(id => id.includes('\0'))) {
    // Explicit bodies can be prepared before the workspace lock. Only the default region needs
    // substitution under the lock. The transaction rechecks sizes against locked attachment metadata.
    const key = c.req.header('Idempotency-Key');
    if (key !== undefined && (key.length > 200 || !/^[\x21-\x7e]+$/.test(key))) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
    const hash = key === undefined ? null : await digest(canonical(input));
    const rows: { id: string; snapshot: EmailSnapshot; hash?: string; email?: string }[] = []; let prepError: unknown;
    for (const [i,mail] of mails.entries()) {
      try {
        const link = mail.kind === 'marketing' ? await createUnsubscribeLink(c.env, a.workspaceId, Array.isArray(mail.to) ? mail.to[0]! : mail.to) : undefined;
        const snapshot = await prepare(c.env, c.env.db, a, { ...mail, region: mail.region ?? '' }, false, [], true, false, link?.url);
        rows.push({ id: data[i]!.id, snapshot, hash: link?.record.tokenHash, email: link?.record.email });
      } catch (error) { prepError = error; break; }
    }
    const {firstWeek,secondWeek,mature} = c.env.config.hostedSendCaps;
    return c.env.db.transaction(async db => {
      // One statement after BEGIN. No row or idempotency receipt becomes visible until the
      // ordinary API policy checks below succeed and COMMIT; errors roll back the whole batch.
      const {rows:[result]} = await db.execute<{inserted: number; state: AdmissionState | {previous: typeof receipt | null; hash: string}}>(sql`WITH ${regional ? sql`base` : sql`state`} AS MATERIALIZED (
        SELECT direct_admission_state(${a.workspaceId},${a.keyId},${c.req.path},${key ?? null},${hash},${JSON.stringify(receipt)}::jsonb,
          ${JSON.stringify(mails.map(m=>({host:m.from.split('@')[1]!.toLowerCase(), region:m.region,kind:m.kind})))}::jsonb,${JSON.stringify(assetIds)}::jsonb,${simulated},${cost},${marketing},${firstWeek},${secondWeek},${mature},${c.env.config.dispatch.dailyHeadroomPercent}) AS s
      ) ${regional ? sql`,state AS MATERIALIZED (SELECT CASE WHEN s ? 'previous' THEN s ELSE s||jsonb_build_object('routes',${senderRoutes(c.env,a.workspaceId,hosts)},'quota',(SELECT max(l.max_24_hour_send) FROM regional_workspace_limits l JOIN provider_connections pc USING(workspace_id) WHERE l.workspace_id=${a.workspaceId} AND pc.kind='byo')) END AS s FROM base)` : sql``}, submitted AS (
        SELECT m.id,m.hash,m.email,${regional ? sql`m.snapshot||jsonb_build_object('region',coalesce(route->>'region',''),'binding',route->'binding')` : sql`jsonb_set(m.snapshot,'{region}',to_jsonb(coalesce(nullif(m.snapshot->>'region',''),s->>'default_region')))`} snapshot
        FROM state,jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) m(id text,hash text,email text,snapshot jsonb) ${regional ? sql`CROSS JOIN LATERAL (SELECT s->'routes'->lower(split_part(m.snapshot->>'from','@',2)) AS route) r` : sql``} WHERE s->>'default_region' IS NOT NULL
          AND (s->>'projected')::int <= coalesce((s#>>'{hosted,pendingCapOverride}')::int,
            least(${SENDING_LIMITS.pendingCeiling}, greatest(${SENDING_LIMITS.pendingFloor}, floor((s->>'quota')::numeric))))
          AND s#>>'{hosted,pauseReason}' IS NULL AND (s#>>'{hosted,cap}' IS NULL OR ${cost}::int=0 OR (
            (s#>>'{hosted,used}')::bigint + ${cost} <= (s#>>'{hosted,cap}')::int AND (${marketing}::int=0 OR
            (s#>>'{hosted,used}')::bigint + ${marketing} <= (s#>>'{hosted,marketingCap}')::int)))
      ), ${assetIds.length ? sql`links AS (INSERT INTO sending_attachment_links(workspace_id,attachment_id,owner_type,owner_id)
        SELECT ${a.workspaceId},asset.id,'email',m.id FROM submitted m,state,jsonb_to_recordset(coalesce(nullif(s->'assets','null'::jsonb),'[]')) asset(id text)
        WHERE (m.snapshot->'attachments') ? asset.id),` : sql``}
      tokens AS (INSERT INTO operation_unsubscribe_tokens(workspace_id,token_hash,email) SELECT ${a.workspaceId},hash,email FROM submitted WHERE hash IS NOT NULL),
      inserted AS (INSERT INTO sending_emails(id,workspace_id,actor_key_id,region,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated)
        SELECT id,${a.workspaceId},${a.keyId},snapshot->>'region',snapshot->>'from',snapshot->'to',snapshot->'cc',snapshot->'bcc',snapshot->>'subject',snapshot,${simulated} FROM submitted RETURNING 1)
      SELECT s AS state,(SELECT count(*)::int FROM inserted) AS inserted FROM state`);
      const state = result!.state;
      if ('previous' in state) {
        if (state.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.');
        if (!state.previous) throw new ApiError(500, 'IDEMPOTENCY_RESULT_MISSING', 'The stored idempotency result is unavailable.');
        return state.previous;
      }
      checkCapacity(state, cost, marketing);
      const locked = new Map(state.assets?.map(row => [row.id,row]));
      let bytes = 0;
      for (const [i,mail] of mails.entries()) {
        const region = checkSender(c.env, a, state, mail), row = rows[i];
        const attached = distinctAttachmentIds(mail.attachments).flatMap(id => locked.get(id) ?? []);
        validateAttachmentRows(mail.attachments, attached);
        if (!row) throw prepError;
        if (attached.length) sizeCheck(row.snapshot,attached);
        row.snapshot.region = region;
        if (batch && (bytes += Buffer.byteLength(JSON.stringify(row.snapshot))) > SENDING_LIMITS.expandedCampaignBytes) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Expanded batch content exceeds the ${SENDING_LIMITS.expandedCampaignBytes / 1024 / 1024} MiB limit. Submit smaller batches.`);
      }
      if (result!.inserted !== mails.length) throw new Error('Incomplete direct admission');
      if (!regional && state.connection) a.dispatchAccount = { aws_account_id: state.connection.aws_account_id, kind: state.connection.kind };
      for (const row of rows) noteDispatch(a, row.snapshot);
      return receipt;
    });
  }
  return idempotent(c, a, input, async db => {
    const attachmentIds = assetIds.filter(id => !id.includes('\0'));
    // A new READ COMMITTED statement after the workspace lock sees the previous sender's committed rows.
    // Lock settings against disablement; read only readiness (not discovery reports) and lock each asset once.
    const ready = !mx && !isSimulatedSes(c.env) ? sql`ARRAY(SELECT wanted.region || ':' || wanted.kind FROM (
      SELECT DISTINCT coalesce(m.region, settings.default_region) AS region, m.kind FROM settings,
        jsonb_to_recordset(${JSON.stringify(mails.filter(m => m.region === undefined || regionPattern.test(m.region)).map(({ region, kind }) => ({ region, kind })))}::jsonb) m(region text, kind text)
    ) wanted JOIN ses_region_discovery d ON d.workspace_id = ${a.workspaceId} AND d.region = wanted.region
      WHERE d.credentials_fingerprint = ${await credentialFingerprint(c.env.config)} AND d.public_url = ${discoveryTarget(c.env.config)}
        AND d.report->'provisioned' = 'true'::jsonb AND d.report#>'{account,sendingEnabled}' = 'true'::jsonb
        AND d.report#>'{account,id}' = coalesce(to_jsonb(d.trusted_account_id), 'null'::jsonb)
        AND d.report#>'{resources,topic,arn}' = coalesce(to_jsonb(d.trusted_topic_arn), 'null'::jsonb)
        AND d.report->'resources'->wanted.kind->'sendingEnabled' = 'true'::jsonb)` : sql`ARRAY[]::text[]`;
    const assets = attachmentIds.length ? sql`(SELECT jsonb_agg(asset) FROM (
      SELECT id, size, content_id AS "contentId" FROM sending_attachments
      WHERE workspace_id = (SELECT workspace_id FROM settings) AND ${inArray(attachments.id, attachmentIds)}
      ORDER BY id FOR UPDATE) asset)` : sql`NULL`;
    const verified = mx && !regional ? sql`ARRAY(SELECT m.host || ':' || coalesce(m.region, settings.default_region)
      FROM jsonb_to_recordset(${JSON.stringify(mails.map(m => ({ host: m.from.split('@')[1]!.toLowerCase(), region: m.region })))}::jsonb) m(host text,region text)
      WHERE ${verifiedClaim(sql`settings.workspace_id`, sql`coalesce(m.region, settings.default_region)`, sql`m.host`)})` : sql`ARRAY[]::text[]`;
    const state = (await db.execute<AdmissionState & {ready:string[];connection:SenderRoute['connection']}>(sql`
      WITH settings AS (SELECT workspace_id, default_region, enabled_regions FROM ses_installation_settings WHERE workspace_id = ${a.workspaceId} FOR SHARE)
      SELECT counts.*, settings.default_region, settings.enabled_regions, ${ready} AS ready, ${assets} AS assets, ${verified} AS verified, ${mx && !regional ? sql`to_jsonb(pc)` : sql`NULL`} AS connection ${regional ? sql`,${senderRoutes(c.env,a.workspaceId,hosts)} AS routes` : sql``}
      FROM (${pendingCounts(c.env, a, cost, marketing, mails.length, mails.filter(m => m.kind === 'marketing').length)}) counts LEFT JOIN settings ON true ${mx && !regional ? sql`LEFT JOIN ${sendingConnections(c.env)} pc ON pc.workspace_id=settings.workspace_id AND pc.region=coalesce(${mails[0]!.region ?? null},settings.default_region)` : sql``}`)).rows[0]!;
    checkCapacity(state, cost, marketing);
    const runtime = { ...c.env, config: { ...c.env.config, workspaceId: a.workspaceId, regions: state.enabled_regions } };
    const locked = new Map(state.assets?.map(row => [row.id, row]));
    const rows = []; let expandedBytes = 0;
    for (const [i, mail] of mails.entries()) {
      const region = checkSender(c.env, a, state, mail);
      if (!mx && !isSimulatedSes(c.env) && !state.ready.includes(`${region}:${mail.kind}`)) throw new ApiError(409, 'SES_SETUP_REQUIRED', 'Run discovery and complete provisioning for this region before live sending.', 'region');
      if (!mx) keySender(a, mail.from);
      const ids = distinctAttachmentIds(mail.attachments);
      // PostgreSQL cannot bind NUL as text. Defer that invalid lookup to its own message, after domain/duplicate checks.
      const attached = ids.some(id => id.includes('\0')) ? await attachmentRows(db, a, ids, true) : ids.flatMap(id => locked.get(id) ?? []);
      validateAttachmentRows(mail.attachments, attached);
      const link = mail.kind === 'marketing' ? await createUnsubscribeLink(c.env, a.workspaceId, Array.isArray(mail.to) ? mail.to[0]! : mail.to) : undefined;
      const route=state.routes?.[hosts[i]!];
      const snapshot = await prepare(runtime, db, a, { ...mail, region }, false, attached, true, false, link?.url, route?.connection ?? state.connection ?? undefined);
      if (route) snapshot.binding=route.binding;
      if (batch) {
        expandedBytes += Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
        if (expandedBytes > SENDING_LIMITS.expandedCampaignBytes) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Expanded batch content exceeds the ${SENDING_LIMITS.expandedCampaignBytes / 1024 / 1024} MiB limit. Submit smaller batches.`);
      }
      rows.push({ id: data[i]!.id, snapshot, hash: link?.record.tokenHash, email: link?.record.email });
    }
    await db.execute(sql`WITH submitted AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) m(id text, snapshot jsonb, hash text, email text)),
      links AS (INSERT INTO sending_attachment_links (workspace_id, attachment_id, owner_type, owner_id)
        SELECT ${a.workspaceId}, attachment_id, 'email', id FROM submitted, jsonb_array_elements_text(snapshot->'attachments') attachment_id),
      tokens AS (INSERT INTO operation_unsubscribe_tokens (workspace_id, token_hash, email)
        SELECT ${a.workspaceId}, hash, email FROM submitted WHERE hash IS NOT NULL)
      INSERT INTO sending_emails (id, workspace_id, actor_key_id, region, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated)
        SELECT id, ${a.workspaceId}, ${a.keyId}, snapshot->>'region', snapshot->>'from', snapshot->'to', snapshot->'cc', snapshot->'bcc',
          snapshot->>'subject', snapshot, ${isSimulatedSes(runtime)} FROM submitted`);
    if (state.connection) a.dispatchAccount = { aws_account_id: state.connection.aws_account_id, kind: state.connection.kind };
    for (const row of rows) noteDispatch(a, row.snapshot);
    return receipt;
  }, receipt);
}
async function saveAttachment(c: Ctx, a: Actor, metadata: AttachmentMetadataInput, bytes: Uint8Array) {
  const input = validateAttachment(metadata, bytes);
  const checksum = await bytesDigest(bytes);
  return idempotent(c, a, { ...input, size: bytes.length, checksum }, async db => AttachmentInfo.parse(await storeValidatedAttachment(c.env, db, a, input, bytes, checksum)));
}
async function storeValidatedAttachment(runtime: Runtime, db: DbExecutor, a: Actor, input: ReturnType<typeof validateAttachment>, bytes: Uint8Array, checksum: string) {
  await lockAdmission(db, a);
  const [usage] = await db.select({ bytes: sql<string>`coalesce(sum(${attachments.size}), 0)` }).from(attachments).where(scope(attachments, a));
  if (Number(usage!.bytes) + bytes.length > SENDING_LIMITS.storedAttachmentBytes) throw new ApiError(413, 'STORED_ATTACHMENT_LIMIT_EXCEEDED', `Stored attachments exceed the ${SENDING_LIMITS.storedAttachmentBytes / 1024 / 1024} MiB limit. Delete unused attachments before uploading more.`);
  const attachmentId = id('attachment'); const storageKey = `${a.workspaceId}/attachments/${attachmentId}`;
  await runtime.storage.put(storageKey, bytes, input.contentType);
  try {
    const [row] = await db.insert(attachments).values({ id: attachmentId, workspaceId: a.workspaceId, ...input, size: bytes.length, contentId: input.contentId ?? null, storageKey, checksum }).returning();
    return row!;
  } catch (error) { await runtime.storage.delete(storageKey).catch(() => undefined); throw error; }
}
/** Reserve quota before uploading. No database connection is held during object storage I/O.
 * Unused uploads (including a concurrent idempotency loser) use ordinary attachment retention. */
export async function storeAttachmentBytes(runtime: Runtime, a: Pick<Actor,'workspaceId'>, metadata: { filename: string; contentType: string; disposition?: 'attachment' | 'inline'; contentId?: string }, bytes: Uint8Array) {
  const parsed = AttachmentMetadata.safeParse({ filename: metadata.filename, contentType: metadata.contentType, disposition: metadata.disposition ?? 'attachment', ...(metadata.contentId ? { contentId: metadata.contentId } : {}) });
  if (!parsed.success) throw new ApiError(422, 'ATTACHMENT_METADATA_INVALID', `Attachment ${metadata.filename} has an invalid name, type or content ID.`);
  const input=validateAttachment(parsed.data,bytes),checksum=await bytesDigest(bytes),attachmentId=id('attachment'),storageKey=`${a.workspaceId}/attachments/${attachmentId}`;
  const row=await runtime.db.transaction(async tx=>{
    await lockAdmission(tx,a);
    const [usage]=await tx.select({bytes:sql<string>`coalesce(sum(${attachments.size}),0)`}).from(attachments).where(eq(attachments.workspaceId,a.workspaceId));
    if(Number(usage!.bytes)+bytes.length>SENDING_LIMITS.storedAttachmentBytes) throw new ApiError(413,'STORED_ATTACHMENT_LIMIT_EXCEEDED','Stored attachment quota exceeded.');
    const [saved]=await tx.insert(attachments).values({id:attachmentId,...input,workspaceId:a.workspaceId,storageKey,checksum,size:bytes.length}).returning();return saved!;
  });
  try {await runtime.storage.put(storageKey,bytes,input.contentType);} catch(e){await runtime.db.delete(attachments).where(eq(attachments.id,row.id));throw e;}return row;
}
export type MailboxSendRequest = { from: string; fromName?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; region?: string; subject: string; html?: string; text?: string; attachments: string[]; tracking?: boolean; screen?: boolean; headers: { Name: string; Value: string }[] };
/** Queues one transactional email through the normal pipeline (admission, region readiness, suppression, dispatch) with extra MIME headers. */
export async function queueMailboxEmail(runtime: Runtime, db: DbExecutor, a: Actor, request: MailboxSendRequest) {
  const parsed = SendInput.safeParse({ from: request.from, ...(request.fromName ? { fromName: request.fromName } : {}), to: request.to, cc: request.cc, bcc: request.bcc, replyTo: request.replyTo, region: request.region, kind: 'transactional', subject: request.subject, ...(request.html ? { html: request.html } : {}), ...(request.text ? { text: request.text } : {}), attachments: request.attachments, tracking: request.tracking ?? false, screen: request.screen });
  if (!parsed.success) throw new ApiError(422, 'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Message fields are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
  for (const header of request.headers) if (!/^[!-9;-~]{1,126}$/.test(header.Name) || !/^[ -~]{1,995}$/.test(header.Value) || header.Name.length + header.Value.length > 996) throw new ApiError(422, 'INVALID_MIME_HEADER', `Header ${header.Name} is not a valid single-line ASCII header.`);
  await checkPending(runtime, db, a, hostedCost(request.to, request.cc, request.bcc));
  const snapshot = await prepare(runtime, db, a, parsed.data);
  snapshot.headers = [...snapshot.headers, ...request.headers];
  const receipt = await queueEmail(runtime, db, a, snapshot);
  return { emailId: receipt.id, snapshot };
}
function editable(row: typeof campaigns.$inferSelect, revision?: number) {
  if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before editing, reviewing or sending it.');
  if (revision !== undefined && row.revision !== revision) throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign has changed; fetch it and review again.');
  if (!campaignEditable(row)) throw new ApiError(409, 'CAMPAIGN_LOCKED', row.state === 'failed' ? 'This campaign already released recipients; resume or cancel it instead of changing it.' : 'Only drafts and failed campaigns that released nothing may be changed.');
}
/** Rejects campaign html outside the block vocabulary with the offending tag or attribute named. */
function assertBlockContent(html: string | undefined, complete = false) {
  if (!html) return;
  try { validateBlockHtml(html, { complete }); } catch (error) {
    if (error instanceof BlockContentError) throw new ApiError(422, 'CAMPAIGN_CONTENT_INVALID', error.message, 'html');
    throw error;
  }
}
/** Block HTML becomes the styled email plus a plain-text alternative. Legacy drafts fail here with the block error until re-saved. */
function renderCampaignContent(runtime: Runtime, draft: Pick<CampaignDraft, 'html' | 'subject'>, complete = true): { html: string | undefined; text: string | undefined } {
  if (!draft.html?.trim()) return { html: undefined, text: undefined };
  assertBlockContent(draft.html, complete);
  return { html: renderBlockHtml(draft.html, { fontBase: `${runtime.config.publicUrl}/fonts/`, title: draft.subject }), text: renderBlockText(draft.html) || undefined };
}
async function campaignMessage(runtime: Runtime, db: DbExecutor, a: Actor, draft: CampaignDraft, contact: ReviewedRecipient, test = false, preview = false, lockedAttachments?: (typeof attachments.$inferSelect)[], prepared?: { html?: string; text?: string }, templateValidated = false, htmlValidated = false) {
  try {
    const values = { ...draft.defaults, ...Object.fromEntries(Object.entries(contact.properties).filter(([, value]) => value !== null && value !== undefined)), email: contact.email, ...(contact.name ? { name: contact.name } : {}) };
    const rendered = prepared ?? renderCampaignContent(runtime, draft);
    const parsed = SendInput.safeParse({ from: draft.from, fromName: draft.fromName, to: contact.email, replyTo: draft.replyTo, region: test ? campaignSendRegion(runtime,draft) : draft.region, kind: test ? 'transactional' : 'marketing', subject: interpolate(draft.subject, values, false, templateValidated), html: withPreheader(interpolate(rendered.html, values, true, templateValidated), draft.previewText), text: interpolate(rendered.text, values, false, templateValidated), attachments: draft.attachments, tracking: test ? false : draft.tracking });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))].join(', ');
      throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Recipient or rendered message is invalid (${fields}).`);
    }
    const snapshot = await prepare(runtime, db, a, parsed.data, preview, lockedAttachments, prepared !== undefined, htmlValidated);
    if (draft.previewText !== undefined) snapshot.previewText = draft.previewText;
    return snapshot;
  } catch (error) {
    // Add only a contact identifier to known local validation failures; never rewrite database/provider errors.
    if (error instanceof ApiError && ['CAMPAIGN_RECIPIENT_INVALID', 'MISSING_TEMPLATE_VARIABLE', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'UNSAFE_TEMPLATE_CONTEXT', 'UNSAFE_HTML_URL', 'ENCODED_MESSAGE_TOO_LARGE', 'RENDERED_CONTENT_TOO_LARGE'].includes(error.code)) throw new ApiError(error.status, error.code, `Contact ${contact.id}: ${error.message}`, 'contactId', error.retryable);
    throw error;
  }
}

export function registerSending(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/send', operationId: 'sendEmail', tags: ['Emails'], security, request: { headers: IdempotencyHeaders, body: json(SingleSendInput) }, responses: { 202: response(SingleReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const replyAddressId = input.replyAddressId ?? input.replyMailboxId;
    if (replyAddressId) {
      if (a.domains.length || !a.permissions.includes('manage')) throw new ApiError(403, 'MAILBOX_ACCESS_REQUIRED', 'Use unrestricted manage permission, or start a thread with a scoped inbound key.');
      let files:Awaited<ReturnType<typeof trackedAttachments>>=[];
      const result = await idempotent(c, a, input, tx => queueTrackedMailboxSend(c.env, tx, a, replyAddressId, input, input.replyAddressId ? 'replyAddressId' : 'replyMailboxId',files),undefined,input.attachments.length ? async()=>{files=await trackedAttachments(c.env,a,replyAddressId,input);} : undefined);
      if(input.attachments.length)await finishMailboxArchive(c.env,a.workspaceId,result.mailboxMessageId);
      return c.json(SingleReceipt.parse({ ...result, inboundMessageId: result.mailboxMessageId }), 202);
    }
    const result = await admitEmails(c, a, input);
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/batch', operationId: 'sendEmailBatch', tags: ['Emails'], security, request: { headers: IdempotencyHeaders, body: json(BatchInput) }, responses: { 202: response(BatchReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (input.emails.reduce((n, e) => n + (e.html?.length ?? 0) + (e.text?.length ?? 0), 0) > 2 * 1024 * 1024) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', 'Combined batch body content may not exceed 2 MiB.');
    const result = await admitEmails(c, a, input);
    return c.json(BatchReceipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails', operationId: 'listEmails', tags: ['Emails'], security, request: { query: EmailQuery }, responses: { 200: response(page(Email)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), binding = await pageBinding(a, 'emails', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    const rows = await c.env.db.select(emailColumns).from(emails).where(and(scope(emails, a),
      cursor ? sql`(${emails.createdAt}, ${emails.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.campaignId ? eq(emails.campaignId, q.campaignId) : undefined, q.status ? eq(emails.status, q.status) : undefined,
      q.region ? eq(emails.region, q.region) : undefined, q.kind ? sql`${emails.snapshot}->>'kind' = ${q.kind}` : undefined,
      q.from ? gte(emails.createdAt, q.from) : undefined, q.to ? lt(emails.createdAt, q.to) : undefined,
      search ? sql`sending_log_text(${emails.id},${emails.campaignId},${emails.providerId},${emails.from},${emails.subject},${emails.to} || ${emails.cc} || ${emails.bcc}) ILIKE ${search}` : undefined,
    )).orderBy(desc(emails.createdAt), desc(emails.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(emailView), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}', operationId: 'getEmail', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => {
    const [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(emailView(row ?? notFound('Email')), 200);
  });
  app.openapi(createRoute({ method:'get', path:'/v1/emails/{id}/detail', operationId:'getEmailDetail', tags:['Emails'], security,
    description:'One log detail: metadata, visible HTML/text, attachment IDs, the first 100 events and active contact for a single To address. Uses the same content and event redaction as their individual endpoints; no raw MIME. Continue events with listEmailEvents.',
    request:{params:IdParams},responses:{200:response(z.object({email:Email,content:EmailContent.pick({html:true,text:true,attachments:true}),events:page(Event),contact:z.object({id:z.string(),suppressed:z.boolean()}).nullable()}).openapi('EmailDetail')),...errors} }),async c=>{
    const a=actor(c), emailId=c.req.valid('param').id;
    // Single-table select fields render columns unqualified, which would bind to the subquery's own
    // table (events matching their own id; contacts matching any workspace). Name the outer row.
    const [detail]=await c.env.db.select({mail:emails,
      contact:sql<{id:string;suppressed:boolean}|null>`(SELECT jsonb_build_object('id',c.id,'suppressed',c.suppressed) FROM audience_contacts c
        WHERE c.workspace_id=sending_emails.workspace_id AND c.deleted_at IS NULL AND jsonb_array_length(sending_emails.to_addresses)=1 AND c.email=lower(sending_emails.to_addresses->>0))`,
      timeline:sql<z.input<typeof Event>[]>`(SELECT coalesce(jsonb_agg(t ORDER BY t.id),'[]') FROM (
        SELECT id,email_id AS "emailId",type,provider_id AS "providerId",simulated,created_at::text AS "createdAt",data FROM sending_email_events
        WHERE workspace_id=sending_emails.workspace_id AND email_id=sending_emails.id ORDER BY id LIMIT 101) t)`
    }).from(emails).where(mailWhere(a,emailId)).limit(1);
    if(!detail) return notFound('Email');
    const {mail,contact,timeline}=detail, {html,text,attachments}=await visibleEmailContent(c.env,a,mail);
    const email=emailView({...mail,subject:a.permissions.includes('manage') ? mail.subject : redactCapabilityText(mail.subject),fromName:mail.snapshot.fromName ?? null,kind:mail.snapshot.kind});
    return c.json({email,content:{html,text,attachments},contact,events:{data:timeline.slice(0,100).map(r=>visibleEmailEvent(a,r)),nextCursor:timeline.length>100 ? timeline[99]!.id : null}},200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/content', operationId: 'getEmailContent', description: 'Manage keys receive full snapshots. Other readers receive app unsubscribe tokens redacted from subject/HTML/text and raw MIME withheld (null), since MIME encodings can conceal capabilities. Other transactional bearer links are not sanitized; grant content-read access only to trusted integrations.', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(EmailContent), ...errors } }), async c => {
    const a = actor(c); const row = await findEmail(c.env.db, a, c.req.valid('param').id);
    return c.json(await visibleEmailContent(c.env,a,row),200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/events', operationId: 'listEmailEvents', tags: ['Emails'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Event)), ...errors } }), async c => {
    const a = actor(c); const emailId = c.req.valid('param').id; await findEmail(c.env.db, a, emailId); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(emailEvents).where(and(scope(emailEvents, a), eq(emailEvents.emailId, emailId), q.cursor ? gt(emailEvents.id, q.cursor) : undefined)).orderBy(asc(emailEvents.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => visibleEmailEvent(a,r)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/attachments', operationId: 'uploadAttachment', tags: ['Attachments'], security, request: { headers: IdempotencyHeaders, body: json(AttachmentUpload) }, responses: { 201: response(AttachmentInfo), ...errors } }), async c => {
    const a = actor(c, 'send'); const { content, ...metadata } = c.req.valid('json');
    const bytes = decodeBase64(content);
    const result = await saveAttachment(c, a, metadata, bytes);
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.post('/v1/attachments/upload', async c => {
    const a = actor(c, 'send');
    const encodedFilename = c.req.header('x-opensend-filename');
    let filename = '';
    try { filename = encodedFilename ? decodeURIComponent(encodedFilename) : ''; } catch { throw new ApiError(422, 'ATTACHMENT_FILENAME_INVALID', 'X-OpenSend-Filename must be URI-encoded UTF-8.'); }
    const contentLength = Number(c.req.header('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENTS) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments must be at most 8 MiB.');
    const parsed = AttachmentMetadata.safeParse({ filename, contentType: c.req.header('content-type') ?? 'application/octet-stream', disposition: c.req.header('x-opensend-disposition') ?? 'attachment', contentId: c.req.header('x-opensend-content-id') });
    if (!parsed.success) throw new ApiError(422, 'ATTACHMENT_METADATA_INVALID', 'Attachment headers are invalid.', parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean).join(', '));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await saveAttachment(c, a, parsed.data, bytes);
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}', operationId: 'getAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo), ...errors } }), async c => {
    const [row] = await attachmentRows(c.env.db, actor(c), [c.req.valid('param').id]); return c.json(AttachmentInfo.parse(row), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}/content', operationId: 'getAttachmentContent', description: 'Returns the private attachment as canonical base64 JSON, scoped like its metadata. At most 8 MiB decoded; never a public object URL or executable inline response.', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo.extend({ content: z.string().max(MAX_ATTACHMENT_BASE64) }).openapi('AttachmentContent')), ...errors } }), async c => {
    const [row] = await attachmentRows(c.env.db, actor(c), [c.req.valid('param').id]);
    const asset = await c.env.storage.get(row!.storageKey);
    if (!asset || asset.body.length !== row!.size || asset.body.length > MAX_ATTACHMENTS || await bytesDigest(asset.body) !== row!.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json({ ...AttachmentInfo.parse(row), content: Buffer.from(asset.body).toString('base64') }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/attachments/{id}', operationId: 'deleteAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const attachmentId = c.req.valid('param').id;
    await c.env.db.transaction(async db => {
      const [row] = await attachmentRows(db, a, [attachmentId], true);
      const links = await db.select().from(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.attachmentId, attachmentId))).limit(1);
      if (links.length) throw new ApiError(409, 'ATTACHMENT_IN_USE', 'Remove this attachment from all drafts first; queued and retained emails keep their immutable attachment references.');
      if (!row!.sourceTemplateAssetId) await c.env.storage.delete(row!.storageKey);
      await db.delete(attachments).where(and(scope(attachments, a), eq(attachments.id, attachmentId)));
    }); return c.json({ id: attachmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns', operationId: 'createCampaign', description: 'Create a campaign draft; only a name is required. templateId copies an active published global template, including its content and assets, into this workspace. With regional MX delivery, drafts can be edited before sender setup is complete; the sender and region are checked when sending a test or launching. Returns a dashboard URL so an agent and user can continue editing together.', tags: ['Campaigns'], security, request: { headers: IdempotencyHeaders, body: json(CampaignCreate) }, responses: { 201: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    assertBlockContent(input.html);
    const result = await idempotent(c, a, input, async db => {
      const campaignId = id('campaign'); const source = input.templateId ? await instantiateTemplate(c.env, db, a, input.templateId) : null;
      const draft = { name: input.name, from: input.from, ...(input.fromName ?? source?.draft.fromName ? { fromName: input.fromName ?? source?.draft.fromName } : {}), ...(input.previewText ?? source?.draft.previewText ? { previewText: input.previewText ?? source?.draft.previewText } : {}), replyTo: input.replyTo.length ? input.replyTo : source?.draft.replyTo ?? [], ...await draftRegion(c.env,db,a,input), subject: input.subject || source?.draft.subject || '', attachments: [...new Set([...(source?.draft.attachments ?? []), ...input.attachments])], tracking: input.tracking ?? source?.draft.tracking ?? true, audience: input.audience, defaults: { ...(source?.draft.defaults ?? {}), ...input.defaults }, ...(input.html ?? source?.draft.html ? { html: input.html ?? source?.draft.html } : {}) };
      draftSender(c.env, a, draft);
      await linkAttachments(db, a, draft.attachments, 'campaign', campaignId);
      const [row] = await db.insert(campaigns).values({ id: campaignId, workspaceId: a.workspaceId, draft, sourceTemplateId: source?.templateId ?? null, sourceTemplateRevision: source?.templateRevision ?? null }).returning();
      return { ...row!, counts: emptyCounts() };
    });
    return c.json(Campaign.parse({ ...result, archivedAt: result.archivedAt ?? null, url: campaignUrl(c.env, result), delivery: null }), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns', operationId: 'listCampaigns', description: 'Returns bounded campaign metadata summaries. Fetch an individual campaign for its full editable draft; list drafts omit bodies, defaults, attachments and audience exclusions. Dashboard list counts may be cached for up to 60 seconds; API credentials and campaign detail remain exact.', tags: ['Campaigns'], security, request: { query: CampaignQuery }, responses: { 200: response(page(CampaignSummary)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), binding = await pageBinding(a, 'campaigns', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    const rows = await timed(c, 'campaign-list-db', () => c.env.db.select(campaignSummaryColumns).from(campaigns).where(and(scope(campaigns, a),
      q.archived === 'true' ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt),
      cursor ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.region ? sql`${campaigns.draft}->>'region' = ${q.region}` : undefined, q.state ? eq(campaigns.state, q.state) : undefined,
      search ? sql`(${campaigns.id} ILIKE ${search} OR ${campaigns.draft}->>'name' ILIKE ${search} OR ${campaigns.draft}->>'subject' ILIKE ${search})` : undefined,
    )).orderBy(desc(campaigns.createdAt), desc(campaigns.id)).limit(q.limit + 1));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, rows.slice(0, q.limit),new URL(c.req.url).origin));
    return c.json({ data: views.map(row => CampaignSummary.parse(row)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}', operationId: 'getCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c), row = await timed(c, 'campaign-db', () => findCampaign(c.env.db, a, c.req.valid('param').id));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, [row]));
    return c.json(Campaign.parse(views[0]!), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/stats', operationId: 'getCampaignStats', description: 'Lifetime campaign delivery and unique open/click statistics, progress, tracking setting and rates with numeric numerators/denominators. Counts distinct emails across all stored feedback, not event occurrences. Delivery/bounce/complaint rates use accepted emails; open/click rates use delivered emails. Both rate counts exclude simulated emails. Rates are fractions, null for zero denominators; engagement rates are also null with tracking disabled. Delivered means receiving-server acceptance, not inbox placement. Engagement includes bots/privacy proxies. Done means dispatch finished; asynchronous feedback can still change totals.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignStats), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    const distinct = (condition: SQL) => sql<number>`count(DISTINCT ${emails.id}) FILTER (WHERE ${condition})::int`;
    const outcome = (status: EmailStatus, type: string) => distinct(sql`${emails.status} = ${status} OR ${emailEvents.type} = ${type}`);
    // Aggregate in the database, using the campaign and per-email event indexes. Grouping by
    // current status keeps progress and lifetime outcomes in the same snapshot without loading mail bodies.
    const grouped = await c.env.db.select({
      status: emails.status, simulated: emails.simulated, count: sql<number>`count(DISTINCT ${emails.id})::int`,
      accepted: distinct(sql`NOT ${emails.simulated} AND ${emails.status} <> 'suppressed' AND (${emails.providerId} IS NOT NULL OR ${emails.status} IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR ${emailEvents.type} IN ('send', 'delivery', 'bounce', 'complaint', 'delivery_delay'))`),
      delivered: outcome('delivered', 'delivery'), bounced: outcome('bounced', 'bounce'), complained: outcome('complained', 'complaint'),
      opened: distinct(sql`${emailEvents.type} = 'open'`), clicked: distinct(sql`${emailEvents.type} = 'click'`),
      failed: distinct(sql`${emails.status} IN ('rejected', 'rendering_failed') OR ${emailEvents.type} IN ('reject', 'rendering_failure')`),
      deliveryDelayed: outcome('delayed', 'delivery_delay'),
    }).from(emails).leftJoin(emailEvents, and(scope(emailEvents, a), eq(emails.id, emailEvents.emailId))).where(and(scope(emails, a), eq(emails.campaignId, row.id))).groupBy(emails.status, emails.simulated);
    const real = { accepted: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0 };
    const counts = emptyCounts(), totals = { ...real, simulated: 0 };
    for (const item of grouped) {
      counts.byStatus[item.status] += item.count; counts.total += item.count;
      if (item.simulated) totals.simulated += item.count;
      for (const key of Object.keys(real) as (keyof typeof real)[]) {
        totals[key] += item[key];
        if (!item.simulated) real[key] += item[key];
      }
    }
    const rate = (numerator: number, denominator: number, enabled = true) => ({ numerator, denominator, value: denominator && enabled ? numerator / denominator : null });
    return c.json(CampaignStats.parse({ id: row.id, name: row.draft.name, state: row.state, tracking: row.draft.tracking, counts, delivery: deliveryView(row), totals,
      rates: { delivery: rate(real.delivered, real.accepted), bounce: rate(real.bounced, real.accepted), complaint: rate(real.complained, real.accepted), open: rate(real.opened, real.delivered, row.draft.tracking), click: rate(real.clicked, real.delivered, row.draft.tracking) },
    }), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaign-content-guide', operationId: 'getCampaignContentGuide', description: 'The complete campaign and template content vocabulary, personalization syntax, restrictions and examples as Markdown. Read it once before writing or editing html.', tags: ['Campaigns'], security, responses: { 200: response(CampaignContentGuide), ...errors } }), async c => {
    actor(c);
    return c.json({ format: 'markdown' as const, markdown: CAMPAIGN_CONTENT_GUIDE }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview', operationId: 'previewCampaign', description: 'Renders the saved draft’s block HTML as the styled email and its plain-text alternative, without personalization or the unsubscribe footer. Placeholders remain visible as {{name}}.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignPreview), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    const rendered = renderCampaignContent(c.env, row.draft, false);
    return c.json({ html: rendered.html ?? '', text: rendered.text ?? '' }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/audience', operationId: 'previewCampaignAudience', description: 'Counts the saved audience right now: matched contacts and how many are eligible, suppressed or unsubscribed. Read-only and never frozen; send or schedule takes its own snapshot and consent is rechecked at dispatch.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(AudienceCounts), ...errors } }), async c => {
    const a = actor(c), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    const audience = AudienceSpec.safeParse(row.draft.audience);
    if (!audience.success) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Choose an audience list before counting recipients.', 'audience.listId');
    return c.json(AudienceCounts.parse(await countCampaignAudience(c.env.db, a, audience.data)), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview-image', operationId: 'renderCampaignPreviewImage', description: 'Renders the saved campaign draft as a full-page, 720 px wide PNG for visual review. Inline CID images are embedded; remote HTTPS images are loaded by the isolated renderer.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignPreviewImage), ...errors } }), async c => {
    const a = actor(c, 'send'), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    if (!c.env.renderHtmlImage) throw new ApiError(503, 'PREVIEW_RENDERING_UNAVAILABLE', 'Visual campaign preview rendering is not configured.', undefined, true);
    await chargeRenderBudget(c, a.workspaceId);
    const rendered = renderCampaignContent(c.env, row.draft, false);
    let html = rendered.html ?? '';
    const inline = (await attachmentRows(c.env.db, a, row.draft.attachments)).filter(item => item.disposition === 'inline' && item.contentId);
    for (const item of inline) {
      const asset = await c.env.storage.get(item.storageKey);
      if (!asset || asset.body.length !== item.size || await bytesDigest(asset.body) !== item.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An inline campaign image is missing or changed.', undefined, true);
      html = html.replaceAll(`cid:${item.contentId}`, `data:${item.contentType};base64,${Buffer.from(asset.body).toString('base64')}`);
    }
    try {
      const image = await c.env.renderHtmlImage(html);
      return c.json(CampaignPreviewImage.parse({ ...image, data: Buffer.from(image.data).toString('base64') }), 200);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'PREVIEW_RENDERING_FAILED', 'The visual campaign preview could not be rendered. Try again.', undefined, true);
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/state', operationId: 'getCampaignState', description: 'Compact authenticated state for draft sync polling; fetch the full campaign with getCampaign when state changes. Compare all returned fields, not only revision: archive and delivery changes need not increment the draft revision. Omits draft content and delivery counts.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignState), ...errors } }), async c => {
    const [row] = await c.env.db.select(campaignStateColumns).from(campaigns).where(campaignWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(CampaignState.parse(row ?? notFound('Campaign')), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}', operationId: 'updateCampaign', description: 'Replace the whole draft at the current revision. Read the campaign first: html is block HTML that people may have edited in the dashboard composer, so send the complete updated html rather than a fragment. Rejected content names the unsupported tag or attribute. A failed campaign becomes a draft again.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignUpdate) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    assertBlockContent(input.draft.html);
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      const draft = {...input.draft,...await draftRegion(c.env,db,a,input.draft,current.draft)};
      draftSender(c.env, a, draft);
      draftSender(c.env, a, current.draft); editable(current, input.revision);
      await attachmentRows(db, a, input.draft.attachments, true);
      await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId)));
      await linkAttachments(db, a, input.draft.attachments, 'campaign', campaignId);
      const revised = await db.execute<typeof campaigns.$inferSelect>(reviseCampaign(campaignRef(a, campaignId), sql`,draft=${JSON.stringify(draft)}::jsonb,revision=${current.revision + 1}`));
      if (!revised.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being saved; fetch it and try again.');
      return (await findCampaign(db, a, campaignId))!;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}/archive', operationId: 'setCampaignArchived', description: 'Archive a campaign to hide it from default lists, or restore it. Preserves its content, revision, delivery state and history. Preparing, scheduled, sending or paused campaigns must finish or be canceled before archiving. Archived campaigns cannot be edited, tested or sent until restored.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignArchive) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'), campaignId = c.req.valid('param').id, input = c.req.valid('json');
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      draftSender(c.env, a, current.draft);
      if (a.role === 'member' && !campaignEditable(current)) throw new ApiError(403, 'PERMISSION_DENIED', 'Members can archive only campaign drafts.');
      if (input.archived && ((CAMPAIGN_ACTIVE as readonly string[]).includes(current.state) || campaignResumable(current))) throw new ApiError(409, 'CAMPAIGN_ACTIVE', 'Cancel or finish sending this campaign before archiving it.');
      if (Boolean(current.archivedAt) === input.archived) return current;
      const [updated] = await db.update(campaigns).set({ archivedAt: input.archived ? now() : null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning();
      return updated!;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/campaigns/{id}', operationId: 'deleteCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, current.draft); editable(current); await db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews r WHERE l.owner_type = 'review' AND l.owner_id = r.id AND l.workspace_id = r.workspace_id AND r.workspace_id = ${a.workspaceId} AND r.campaign_id = ${campaignId}`); await db.delete(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.campaignId, campaignId))); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await db.delete(campaigns).where(campaignWhere(a, campaignId)); });
    return c.json({ id: campaignId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/test', operationId: 'testCampaign', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(TestCampaign) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => { const row = await findCampaign(db, a, campaignId, true); if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before sending a test.'); await checkPending(c.env, db, a, hostedCost(input.to)); const snapshot = await campaignMessage(c.env, db, a, row.draft, { id: 'test-recipient', email: input.to, properties: input.data }, true); return queueEmail(c.env, db, a, snapshot, undefined, undefined, c.get('requestId')); });
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/send', operationId: 'sendCampaign', description: 'Accept the current revision for durable background delivery: the audience is frozen now, every message is validated in the background, then recipients are released into the dispatch queue. The 202 count is accepted recipient intents, not SES acceptance or delivery; poll the campaign for its state.', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSend) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const result = await idempotent(c, a, input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/schedule', operationId: 'scheduleCampaign', description: 'Accept the current revision for durable scheduled delivery. The audience is frozen and validated now; no recipient is materialized or sent before scheduledAt. The 202 count is accepted recipient intents.', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders, body: json(CampaignSchedule) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c, a, input, db => launch(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/cancel', operationId: 'cancelCampaign', description: 'Stop a preparing, scheduled, sending, paused or failed campaign: unreleased recipients are never materialized and queued mail is canceled; mail already attempting or accepted is reported as inFlight.', tags: ['Campaigns'], security, request: { params: IdParams, headers: IdempotencyHeaders }, responses: { 200: response(CampaignCanceled), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, {}, async db => {
      const row = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, row.draft);
      if (row.state === 'done') throw new ApiError(409, 'CAMPAIGN_ALREADY_DISPATCHED', 'This campaign has already finished dispatching.');
      if (row.state === 'draft') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a campaign that was sent or scheduled can be canceled.');
      return cancelCampaignWork(db, a, row);
    });
    return c.json(CampaignCanceled.parse(result), 200);
  });
  // Paced delivery controls. Pausing stops releasing new recipients; mail already queued (a few seconds of
  // the send rate) still dispatches. Resume continues from the same frozen position.
  const control = async (c: Ctx, change: (db: DbExecutor, a: Actor, campaign: typeof campaigns.$inferSelect) => Promise<void>) => {
    const a = actor(c, 'send'), campaignId = c.req.param('id')!;
    await c.env.db.transaction(async db => {
      const campaign = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, campaign.draft);
      if (!(CAMPAIGN_ACTIVE as readonly string[]).includes(campaign.state) && !campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Only a preparing, scheduled, sending or paused campaign can be paused, resumed or paced.');
      await change(db, a, campaign);
    });
    const row = await findCampaign(c.env.db, a, campaignId);
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  };
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pause', operationId: 'pauseCampaign', description: 'Stop releasing new recipients. Queued mail (a few seconds of the send rate) still dispatches. Resume continues from the same position; cancel still works while paused.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (campaign.state === 'paused') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'This campaign is already paused.');
    if (campaign.state === 'failed') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'This campaign failed; resume or cancel it.');
    if (campaign.expanded >= campaign.total) throw new ApiError(409, 'CAMPAIGN_NOT_PAUSABLE', 'Only a campaign that is still releasing recipients can be paused.');
    const ref = { workspaceId: a.workspaceId, id: campaign.id };
    await db.execute(pauseCampaign(ref, { code: 'PAUSED_BY_USER', message: 'Paused from the dashboard or API.' }));
    await db.execute(retireCampaignRun(ref, 'CAMPAIGN_PAUSED'));
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/resume', operationId: 'resumeCampaign', description: 'Continue releasing recipients from where a paused campaign stopped, or where a campaign that failed after releasing some recipients stopped (it continues on the same frozen snapshot, never a new one). After an automatic pause, the next health check runs 30 minutes later.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({}).strict()) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (!campaignResumable(campaign)) throw new ApiError(409, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign, or one that failed after releasing recipients, can be resumed.');
    const ref = { workspaceId: a.workspaceId, id: campaign.id }, next = runningState(campaign);
    await db.execute(resumeCampaign(ref, next));
    await db.execute(queueCampaignRun(ref, campaign.requestId ? { requestId: campaign.requestId } : {}, next === 'scheduled' ? campaign.scheduledAt : null));
    a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1);
  }));
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/pacing', operationId: 'setCampaignPacing', description: 'Change the daily cap or automatic pause of a scheduled or sending campaign, for example to raise 50,000 to 100,000 per day. Takes effect on the next release.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(z.object({ perDay: Pacing.shape.perDay.unwrap(), autoPause: z.boolean().optional().describe('Omit to keep the current setting.'), rateShare: z.number().min(0.05).max(1).optional().describe('Omit to keep the current setting.') }).strict().openapi('CampaignPacingUpdate')) }, responses: { 200: response(Campaign), ...errors } }), async c => control(c, async (db, a, campaign) => {
    if (campaign.expanded >= campaign.total) throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'This campaign has finished releasing recipients.');
    if (campaign.state === 'failed') throw new ApiError(409, 'CAMPAIGN_NOT_SENDING', 'Resume this campaign before changing its pacing.');
    const input = c.req.valid('json'), ref = { workspaceId: a.workspaceId, id: campaign.id };
    await db.execute(setCampaignPacing(ref, { pacePerDay: input.perDay ?? null, autoPause: input.autoPause ?? campaign.autoPause, rateShare: input.rateShare ?? campaign.rateShare }));
    // A release waiting for the next window or quota rechecks now under the new settings.
    if (campaign.state === 'sending') { await db.execute(wakeCampaignRun(ref)); a.wakeJobs = Math.max(a.wakeJobs ?? 0, 1); }
  }));
}

const campaignRef = (a: Pick<Actor, 'workspaceId'>, campaignId: string) => ({ workspaceId: a.workspaceId, id: campaignId });
async function checkCampaignCapacity(db: DbExecutor, a: Actor, incoming: number) {
  await lockAdmission(db, a);
  // Unreleased intents of every active or resumable campaign plus its email rows still in the dispatch queue, each counted
  // exactly once. A failed launch that released nothing holds no reservation (it is edited or launched again from scratch). Direct mail keeps its own admission limit.
  const result = await db.execute<{ total: string; key: string }>(sql`
    WITH outstanding AS (
      SELECT c.actor_key_id, c.total - c.expanded + (SELECT count(*) FROM sending_emails e WHERE e.workspace_id = c.workspace_id AND e.campaign_id = c.id AND e.status IN ('queued','attempting')) AS n
      FROM sending_campaigns c WHERE c.workspace_id = ${a.workspaceId} AND ${campaignReserved()}
    ) SELECT coalesce(sum(n), 0) AS total, coalesce(sum(n) FILTER (WHERE actor_key_id = ${a.keyId}), 0) AS key FROM outstanding`);
  const row = result.rows[0]!;
  if (Number(row.total) + incoming > 4000000 || Number(row.key) + incoming > 2000000) throw new ApiError(429, 'CAMPAIGN_PENDING_LIMIT_EXCEEDED', 'Campaigns may reserve 2,000,000 outstanding recipients per sender key and 4,000,000 per workspace. Wait for dispatch or cancel an active campaign.', undefined, true);
}
async function cancelCampaignWork(db: DbExecutor, a: Actor, row: typeof campaigns.$inferSelect, errorCode?: string) {
  const ref = campaignRef(a, row.id);
  const moved = await db.execute(cancelCampaign(ref, errorCode ? { code: errorCode, message: 'The sending origin is no longer authorized.' } : null));
  const unexpanded = moved.rows.length ? row.total - row.expanded : 0;
  if (moved.rows.length) await db.execute(retireCampaignRun(ref, 'CAMPAIGN_CANCELED'));
  const changed = await db.execute<{ count: number }>(sql`WITH canceled AS (
    UPDATE sending_emails SET status = 'canceled', updated_at = now(), error_code = coalesce(${errorCode ?? null}::text, error_code)
    WHERE workspace_id = ${a.workspaceId} AND campaign_id = ${row.id} AND status = 'queued' RETURNING 1
  ) SELECT count(*)::int AS count FROM canceled`);
  const [inFlight] = await db.select({ count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, row.id), inArray(emails.status, ['attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown'])));
  return { id: row.id, state: 'canceled' as const, canceled: changed.rows[0]!.count + unexpanded, inFlight: inFlight!.count };
}
async function recipientChunk(db: DbExecutor, reviewId: string, cursor: number, limit = CAMPAIGN_PREPARE_ROWS) {
  const result = await db.execute<{ ordinal: number; recipient: ReviewedRecipient; content_hash: string | null; subject: string | null; snapshot_bytes: number | null }>(sql`
    WITH batch AS (
      SELECT ordinal, recipient, content_hash, subject, snapshot_bytes, recipient_bytes FROM sending_review_recipients
      WHERE review_id = ${reviewId} AND ordinal > ${cursor} ORDER BY ordinal LIMIT ${limit}
    ), sized AS (
      SELECT *, sum(recipient_bytes + coalesce(octet_length(subject), 0) + 64) OVER (ORDER BY ordinal) AS bytes FROM batch
    ) SELECT ordinal, recipient, content_hash, subject, snapshot_bytes FROM sized
      WHERE bytes <= ${CAMPAIGN_CHUNK_BYTES} OR ordinal = ${cursor + 1} ORDER BY ordinal`);
  return result.rows;
}
function backgroundFailure(error: unknown) {
  const code = error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED';
  return { code, message: `Campaign work could not finish (${code}). Correct the cause and send again, or cancel the campaign.` };
}
// Send and schedule: freeze the audience and content now, reserve the recipients, and hand the one run job the rest.
async function launch(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, input: { revision: number; scheduledAt?: string; pacing?: z.infer<typeof Pacing> }, requestId?: string) {
  // A campaign launch is one job that must start now; ask the response path for an uncoalesced scheduler wake.
  a.wakeJobs = Math.max(a.wakeJobs ?? 0, 12);
  if (input.scheduledAt && (Date.parse(input.scheduledAt) <= Date.now() || Date.parse(input.scheduledAt) > Date.now() + 365 * 86400000)) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.');
  // Campaign mail is never dispatched for a member origin (approvedOriginUser); refuse here instead of canceling later.
  if (a.role === 'member') throw new ApiError(403, 'PERMISSION_DENIED', 'Only workspace owners and admins can send campaigns.');
  const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision);
  const draft = readyCampaign(row.draft); const route=await sendingRegion(runtime, db, a, draft.from, campaignSendRegion(runtime,row.draft));
  if (!isSimulatedSes(runtime) && !runtime.config.multiTenant) await assertLiveRegionReady(runtime, db, draft.region, 'marketing', false, a.workspaceId);
  const rendered = renderCampaignContent(runtime, draft);
  const reviewId = id('review');
  const reviewed=route.binding ? {...row.draft,region:route.region,binding:route.binding} : row.draft;
  const contentHash = await digest(canonical({ version: 2, draft: reviewed, rendered }));
  await db.insert(campaignReviews).values({ id: reviewId, rendererVersion: CAMPAIGN_RENDERER_VERSION, workspaceId: a.workspaceId, campaignId, revision: row.revision, draft: reviewed, contentHash, rendered });
  const propertyKeys = [...new Set([draft.subject, rendered.html ?? '', rendered.text ?? ''].flatMap(value => [...value.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)].map(match => match[1]!)))];
  const counts = await snapshotCampaignAudience(db, a, draft.audience, reviewId, propertyKeys);
  await checkCampaignCapacity(db, a, counts.eligible);
  const lockedAttachments = await attachmentRows(db, a, draft.attachments, true);
  await linkAttachments(db, a, draft.attachments, 'review', reviewId, lockedAttachments);
  const ref = campaignRef(a, campaignId);
  const moved = await db.execute(launchCampaign(ref, { reviewId, resolvedRegion:route.region!==row.draft.region ? route.region : undefined, actorKeyId: a.keyId, simulated: isSimulatedSes(runtime), total: counts.eligible, requestId: requestId ?? null, scheduledAt: input.scheduledAt ?? null,
    pacePerDay: input.pacing?.perDay ?? null, autoPause: input.pacing?.autoPause ?? true, rateShare: input.pacing ? input.pacing.rateShare ?? 0.5 : null }));
  if (!moved.rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed while it was being sent; fetch it and try again.');
  await db.execute(queueCampaignRun(ref, requestId ? { requestId } : {}));
  return { id: campaignId, state: 'preparing' as const, queued: counts.eligible, scheduledAt: input.scheduledAt ?? null, simulated: isSimulatedSes(runtime) };
}
async function bytesDigest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join(''); }
// Reuse fully verified bytes across invocations sharing the same bucket binding.
// Pending reads remain local to each Storage wrapper/invocation: Workers cannot
// await I/O owned by a different request. Both paths retain bounded byte storage.
const attachmentCaches = new WeakMap<object, { bytes: number; entries: Map<string, Uint8Array> }>();
const attachmentLoads = new WeakMap<Storage, Map<string, Promise<Uint8Array>>>();
export async function verifiedAttachment(runtime: Runtime, row: typeof attachments.$inferSelect) {
  const scope = runtime.storage.cacheScope ?? runtime.storage;
  let cache = attachmentCaches.get(scope);
  if (!cache) { cache = { bytes: 0, entries: new Map() }; attachmentCaches.set(scope, cache); }
  const key = `${row.storageKey}:${row.checksum}:${row.size}`;
  const cached = cache.entries.get(key);
  if (cached) { cache.entries.delete(key); cache.entries.set(key, cached); return cached; }
  let pending = attachmentLoads.get(runtime.storage);
  if (!pending) { pending = new Map(); attachmentLoads.set(runtime.storage, pending); }
  const existing = pending.get(key);
  if (existing) return existing;
  const load = (async () => {
    const asset = await runtime.storage.get(row.storageKey);
    if (!asset || asset.body.length !== row.size || await bytesDigest(asset.body) !== row.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true);
    const already = cache!.entries.get(key);
    if (already) return already;
    const limit = 32 * 1024 * 1024;
    while (cache!.bytes + asset.body.length > limit && cache!.entries.size) {
      const oldest = cache!.entries.entries().next().value as [string, Uint8Array];
      cache!.entries.delete(oldest[0]); cache!.bytes -= oldest[1].length;
    }
    if (asset.body.length <= limit) { cache!.entries.set(key, asset.body); cache!.bytes += asset.body.length; }
    return asset.body;
  })();
  pending.set(key, load);
  try { return await load; } finally { if (pending.get(key) === load) pending.delete(key); }
}

// validation_suppressed is an SES Bounce with bounceSubType EmailValidationSuppressed: SES Auto Validation dropped the
// recipient before sending, so it is not a delivery bounce (AWS excludes it from Reputation.BounceRate). The email becomes
// suppressed rather than bounced, and its public email.bounced event carries no bounced outcome (migration 034).
export const statusForEvent: Record<string, EmailStatus> = { send: 'sent', delivery: 'delivered', bounce: 'bounced', validation_suppressed: 'suppressed', complaint: 'complained', reject: 'rejected', rendering_failure: 'rendering_failed', delivery_delay: 'delayed', accepted: 'accepted', suppressed: 'suppressed', acceptance_unknown: 'acceptance_unknown', simulated: 'simulated' };
// Publish email.sent from the SendEmail response; a later SES Send is status feedback only.
export const publicEventType: Record<string, string> = { accepted: 'email.sent', delivery: 'email.delivered', bounce: 'email.bounced', validation_suppressed: 'email.bounced', complaint: 'email.complained', reject: 'email.rejected', rendering_failure: 'email.rendering_failed', delivery_delay: 'email.delivery_delayed', open: 'email.opened', click: 'email.clicked' };
export const rank: Record<EmailStatus, number> = { queued: 0, attempting: 1, acceptance_unknown: 2, accepted: 3, sent: 4, delayed: 4, delivered: 5, bounced: 6, complained: 7, rejected: 6, rendering_failed: 6, suppressed: 6, canceled: 6, simulated: 6 };
type EmailEventInput = { workspaceId: string; type: string; providerId?: string; errorCode?: string; data?: Record<string, unknown>; recipientHashes?: string[]; externalId?: string; createdAt?: string; receipt?: { topicArn: string; messageId: string } };
type IncomingReceipt = { topicArn: string; messageId: string; region: string; payload: Record<string, unknown>; recoveryType?: 'operation.ses' | 'operation.simulatedFeedbackRecovery' };
export async function recordEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const { event, runnable } = await persistEmailEvent(runtime, input);
  if (runnable) try { await runtime.wake?.(runnable,'webhook'); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Webhook jobs remain durable.' }); }
  return event;
}
// Only authenticated ingress and the guarded test-only callback handler use this.
export async function ingestRoutineSesEvent(runtime: Runtime, input: RoutineIngress) {
  const result = (await ingestRoutineSesEvents(runtime, [input]))[0]!;
  if (!result.error && input.type !== 'receipt') log('info', { code: 'SES_FEEDBACK_INGESTED', workspaceId: result.workspaceId,
    kind: input.type === 'send' ? 'Send' : 'Delivery', outcome: result.event ? 'processed' : result.runnable > 0 ? 'deferred' : 'duplicate', runnable: result.runnable });
  return result;
}
export type RoutineIngress = Omit<EmailEventInput, 'workspaceId'> & { workspaceId?: string; providerId: string; taggedEmailId?: string; ingress: IncomingReceipt;
  effects?: { reported: (string | null)[] | null; suppress: string | null; observe: string | null; receiptTime: boolean } };
/** The opensend_email_id tag the dispatcher stamps on every SES message (only meaningful after SNS signature verification). */
export function taggedEmailId(message: unknown): string | undefined {
  const tag = (message as { mail?: { tags?: Record<string, unknown> } } | undefined)?.mail?.tags?.opensend_email_id;
  const value = Array.isArray(tag) ? tag[0] : undefined;
  return typeof value === 'string' && /^email_[a-z0-9]{8,64}$/.test(value) ? value : undefined;
}
// One statement persists verified callbacks and their side effects. Only subscriptions and
// non-routine callbacks deliberately deferred by HTTP ingress merely open their receipt.
// Early callbacks with a known owner keep a recovery job; unresolved owners return an error for redelivery.
export async function ingestRoutineSesEvents(runtime: Runtime, inputs: RoutineIngress[]) {
  if (!inputs.length) return [];
  const mx = runtime.config.multiTenant;
  const effects = inputs.some(input => input.effects);
  const topicMatch = mx ? sql`AND (x.simulated OR (e.feedback_topic_arn=x.topic_arn AND EXISTS(SELECT FROM provider_feedback_history h WHERE h.topic_arn=x.topic_arn AND h.region=x.region AND h.aws_account_id=split_part(x.topic_arn,':',5))))` : sql``;
  const rows = inputs.map((input, index) => ({
    ordinal: index, job_workspace: input.workspaceId, simulated: input.ingress.topicArn === `urn:opensend:simulated-ses:${input.ingress.region}`, topic_arn: input.ingress.topicArn, message_id: input.ingress.messageId, region: input.ingress.region, provider_id: input.providerId,
    type: input.type, next_status: statusForEvent[input.type]!, next_rank: rank[statusForEvent[input.type]!], public_type: publicEventType[input.type] ?? null,
    external_id: input.externalId ?? null, data: input.data ?? {}, effects: input.effects, created_at: input.createdAt ?? now(),
    event_id: id('event'), recovery_job_id: id('job'), recovery_type: input.ingress.recoveryType, payload: input.ingress.payload, tagged_email_id: input.taggedEmailId ?? null,
  }));
  const result = await runtime.db.execute<{ ordinal: number; workspaceId: string | null; error: string | null; event: typeof emailEvents.$inferSelect | null; runnable: number }>(sql`WITH raw AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(ordinal int, job_workspace text, simulated boolean, topic_arn text, message_id text, region text, provider_id text,
        type text, next_status text, next_rank int, public_type text, external_id text, data jsonb, effects jsonb, created_at timestamptz, event_id text, recovery_job_id text, recovery_type text, payload jsonb, tagged_email_id text)
    ), candidates AS (
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.provider_id = x.provider_id
      WHERE x.tagged_email_id IS NULL AND e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
      UNION ALL
      SELECT x.ordinal, e.id FROM raw x JOIN sending_emails e ON e.id = x.tagged_email_id
      WHERE e.region = x.region AND e.simulated = x.simulated ${topicMatch}
        AND (x.job_workspace IS NULL OR e.workspace_id = x.job_workspace)
    ), locked AS MATERIALIZED (
      SELECT x.ordinal, e.id, e.workspace_id, e.simulated, e.status, e.provider_id ${effects ? sql`, e.to_addresses,e.cc_addresses,e.bcc_addresses` : sql``} FROM raw x
      JOIN (SELECT ordinal, min(id) AS id FROM candidates GROUP BY ordinal HAVING count(*) = 1) c USING (ordinal)
      JOIN sending_emails e ON e.id = c.id
      WHERE e.provider_id = x.provider_id OR (e.id = x.tagged_email_id AND e.provider_id IS NULL AND e.status IN ('attempting','acceptance_unknown'))
      ORDER BY e.id FOR UPDATE OF e
    ) ${mx ? sql`` : sql`, accounts AS (
      -- Same single-account binding as resolveRegionRuntime: only the installation's own registered topics count.
      SELECT s.workspace_id, CASE WHEN count(DISTINCT r.trusted_account_id) = 1 THEN min(r.trusted_account_id) END AS account
      FROM (SELECT DISTINCT workspace_id FROM locked WHERE NOT simulated) l JOIN ses_installation_settings s USING (workspace_id)
      LEFT JOIN ses_region_discovery r ON r.workspace_id = s.workspace_id AND r.trusted_account_id ~ '^[0-9]{12}$'
        AND r.trusted_topic_arn = 'arn:aws:sns:' || r.region || ':' || r.trusted_account_id || ':opensend-' || left(encode(sha256(convert_to(s.installation_id, 'UTF8')), 'hex'), 20) || '-feedback'
      GROUP BY s.workspace_id
    )`}, input AS (
      SELECT x.*, coalesce(l.workspace_id, x.job_workspace) AS workspace_id, l.status, ${effects ? sql`l.to_addresses,l.cc_addresses,l.bcc_addresses,` : sql``}
        coalesce(x.recovery_type, CASE WHEN x.type = 'receipt' AND l.status = 'attempting' AND l.provider_id IS NULL THEN 'operation.ses' END) AS job_type,
        CASE WHEN x.type <> 'receipt' AND (l.provider_id IS NOT NULL OR l.status = 'acceptance_unknown') THEN l.id END AS email_id,
        CASE WHEN l.id IS NULL AND x.job_workspace IS NULL THEN 'SES_EMAIL_NOT_FOUND'
             ${mx ? sql`WHEN NOT x.simulated AND (l.id IS NULL OR to_jsonb(split_part(x.topic_arn,':',5)) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}') THEN 'SES_ACCOUNT_MISMATCH'` : sql`
             WHEN NOT x.simulated AND a.workspace_id IS NULL THEN 'REGION_SETTINGS_NOT_INITIALIZED'
             WHEN a.account IS NOT NULL AND to_jsonb(a.account) IS DISTINCT FROM x.payload #> '{message,mail,sendingAccountId}' THEN 'SES_ACCOUNT_MISMATCH'`} END AS error
      FROM raw x LEFT JOIN locked l USING (ordinal) ${mx ? sql`` : sql`LEFT JOIN accounts a ON a.workspace_id = l.workspace_id AND NOT x.simulated`}
    ), distinct_receipts AS (
      SELECT DISTINCT ON (topic_arn,message_id) * FROM input WHERE error IS NULL ORDER BY topic_arn,message_id,ordinal
    ), incoming AS (
      INSERT INTO operation_sns_receipts AS receipt(topic_arn, message_id, workspace_id, processed_at)
       SELECT x.topic_arn, x.message_id, x.workspace_id, CASE WHEN x.email_id IS NOT NULL THEN clock_timestamp() END
       FROM distinct_receipts x ON CONFLICT (topic_arn,message_id) DO UPDATE SET processed_at=excluded.processed_at
       WHERE receipt.processed_at IS NULL AND excluded.processed_at IS NOT NULL AND receipt.workspace_id=excluded.workspace_id
       RETURNING topic_arn, message_id, workspace_id, created_at
    ), recovery AS (
      INSERT INTO jobs(id, workspace_id, type, payload, available_at)
       SELECT DISTINCT ON (topic_arn, message_id) x.recovery_job_id, x.workspace_id, x.job_type, x.payload,
         clock_timestamp() + CASE WHEN x.type = 'receipt' AND x.status <> 'attempting' THEN interval '0 seconds' ELSE interval '15 seconds' END
       FROM distinct_receipts x JOIN incoming i USING (topic_arn, message_id, workspace_id)
      WHERE x.error IS NULL AND x.email_id IS NULL AND x.job_type IS NOT NULL RETURNING id
    ), matched AS (
      SELECT x.*, CASE WHEN x.effects->>'receiptTime'='true' THEN i.created_at ELSE x.created_at END AS event_time
      FROM distinct_receipts x JOIN incoming i USING (topic_arn,message_id,workspace_id) WHERE x.email_id IS NOT NULL
    ) ${effects ? sql`, recipients AS MATERIALIZED (
      SELECT DISTINCT x.event_id,lower(address) AS address FROM matched x,
        jsonb_array_elements_text(x.to_addresses || x.cc_addresses || x.bcc_addresses) AS address
      WHERE x.effects->'reported' ? lower(address) OR (x.effects->>'observe' IS NOT NULL AND jsonb_array_length(x.to_addresses)=1 AND x.cc_addresses='[]' AND x.bcc_addresses='[]')
    )` : sql``}, inserted AS (
      INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at,recipient_hashes)
       SELECT x.event_id, x.workspace_id, x.email_id, x.type, x.provider_id, x.external_id,
         x.data || jsonb_build_object('emailId', x.email_id, 'providerId', x.provider_id), x.simulated, x.event_time,
         ${mx && effects ? sql`CASE WHEN x.type IN ('bounce','complaint') AND jsonb_typeof(x.effects->'reported')='array'
           AND EXISTS(SELECT FROM provider_feedback_history WHERE topic_arn=x.topic_arn AND kind='shared') THEN ARRAY(
           SELECT encode(sha256(convert_to(x.email_id,'UTF8') || decode('00','hex') || convert_to(r.address,'UTF8')),'hex')
           FROM recipients r WHERE r.event_id=x.event_id AND r.address NOT LIKE '%@simulator.amazonses.com' ORDER BY r.address) END` : sql`NULL`}
       FROM matched x ORDER BY x.ordinal
      ON CONFLICT DO NOTHING RETURNING *
    ) ${effects ? sql`, contact_events AS (
      SELECT x.workspace_id,r.address,x.ordinal,x.event_time,x.effects->>'suppress' AS reason,x.effects->>'observe' AS observe,
        min(x.ordinal) FILTER (WHERE x.effects->>'suppress' IS NOT NULL) OVER (PARTITION BY x.workspace_id,r.address) AS first_suppression
      FROM matched x JOIN inserted ins ON ins.id=x.event_id JOIN recipients r USING(event_id)
    ), contact_changes AS (
      -- One write per address. A missing contact starts existing at its first suppression;
      -- an earlier open must not create it or retroactively contribute engagement.
      INSERT INTO audience_contacts AS c(id,workspace_id,email,suppressed,suppression_reason,last_open_at,last_click_at,open_observed_since,click_observed_since,observed_since)
      SELECT 'con_'||replace(gen_random_uuid()::text,'-',''),v.workspace_id,v.address,bool_or(reason IS NOT NULL),
        (array_agg(reason ORDER BY ordinal DESC) FILTER (WHERE reason IS NOT NULL))[1],
        max(event_time) FILTER (WHERE observe='open'),max(event_time) FILTER (WHERE observe='click'),
        min(event_time) FILTER (WHERE observe='open'),min(event_time) FILTER (WHERE observe='click'),min(event_time) FILTER (WHERE observe IS NOT NULL)
      FROM contact_events v LEFT JOIN audience_contacts c ON c.workspace_id=v.workspace_id AND c.email=v.address
      WHERE (reason IS NOT NULL OR observe IS NOT NULL) AND (c.id IS NOT NULL OR ordinal>=first_suppression)
      GROUP BY v.workspace_id,v.address ORDER BY v.workspace_id,v.address ON CONFLICT ON CONSTRAINT audience_contacts_email_scope DO UPDATE SET
        suppressed=c.suppressed OR excluded.suppressed,suppression_reason=coalesce(excluded.suppression_reason,c.suppression_reason),
        last_open_at=greatest(c.last_open_at,excluded.last_open_at),last_click_at=greatest(c.last_click_at,excluded.last_click_at),
        open_observed_since=least(c.open_observed_since,excluded.open_observed_since),click_observed_since=least(c.click_observed_since,excluded.click_observed_since),
        observed_since=least(c.observed_since,excluded.observed_since),updated_at=now()
    )` : sql``}, ranked AS (
      SELECT x.*,max(x.next_rank) OVER(PARTITION BY x.email_id ORDER BY x.ordinal) AS running_rank FROM matched x JOIN inserted ins ON ins.id=x.event_id
      WHERE x.next_rank IS NOT NULL
    ), winner AS (
      SELECT DISTINCT ON (email_id) *,bool_or(type='validation_suppressed' AND next_rank>=greatest(running_rank,(${JSON.stringify(rank)}::jsonb->>status)::int)) OVER(PARTITION BY email_id) AS validation
      FROM ranked ORDER BY email_id,next_rank DESC,ordinal DESC
    ), updated AS (
      UPDATE sending_emails e SET status = w.next_status, provider_id = coalesce(w.provider_id, e.provider_id), error_code=CASE WHEN w.validation THEN 'EMAIL_VALIDATION_SUPPRESSED' ELSE e.error_code END, updated_at = clock_timestamp()
       FROM winner w WHERE e.id = w.email_id AND e.workspace_id = w.workspace_id AND w.next_rank >= (${JSON.stringify(rank)}::jsonb ->> w.status)::int
    ), published AS (
      INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
      SELECT ins.id, ins.workspace_id, x.public_type, x.region, ins.created_at,
         x.data || jsonb_build_object('simulated', x.simulated, 'providerId', x.provider_id, 'emailId', x.email_id)
      FROM inserted ins JOIN input x ON x.event_id = ins.id WHERE x.public_type IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
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
    ) SELECT x.ordinal, x.workspace_id AS "workspaceId", coalesce(x.error,CASE WHEN x.effects IS NOT NULL AND x.email_id IS NULL THEN 'SES_EMAIL_NOT_FOUND' END) AS error,
      (SELECT row_to_json(e) FROM (SELECT ins.id, ins.workspace_id AS "workspaceId", ins.email_id AS "emailId", ins.type,
        ins.provider_id AS "providerId", ins.external_id AS "externalId", ins.data, ins.simulated, ins.created_at::text AS "createdAt" FROM inserted ins WHERE ins.id = x.event_id) e) AS event,
      ((SELECT count(*) FROM webhook_jobs) + (SELECT count(*) FROM recovery r WHERE r.id = x.recovery_job_id))::int AS runnable
    FROM input x ORDER BY x.ordinal`);
  return result.rows;
}
async function persistEmailEvent(runtime: Runtime, input: EmailEventInput & { emailId: string }) {
  const next = statusForEvent[input.type];
  const publicType = publicEventType[input.type];
  // One transaction inside PostgreSQL instead of BEGIN/read/insert/update/enqueue/COMMIT over the
  // network. The locked row determines monotonic status; only a newly inserted event may change it
  // or publish a callback. Simulated acceptance also queues its Send/Delivery callback vehicles here
  // unless the runtime provides a feedback sink (Cloudflare pushes them to the feedback queue).
  const simulatedJobs = isSimulatedSes(runtime) && input.type === 'accepted' && !!input.providerId?.startsWith('sim_') && !runtime.feedback;
  const result = await runtime.db.execute<{ event: typeof emailEvents.$inferSelect | null; runnable: number; region: string }>(sql`WITH mail AS MATERIALIZED (
    SELECT id, status, region, simulated FROM sending_emails WHERE workspace_id = ${input.workspaceId}
      AND id = ${input.emailId} FOR UPDATE
  ), inserted AS (
    INSERT INTO sending_email_events(id, workspace_id, email_id, type, provider_id, external_id, data, simulated, created_at, recipient_hashes)
    SELECT ${id('event')}, ${input.workspaceId}, mail.id, ${input.type}, ${input.providerId ?? null},
      ${input.externalId ?? null}, ${JSON.stringify(input.data ?? {})}::jsonb, mail.simulated, ${input.createdAt ?? now()}::timestamptz, ${sql.param(input.recipientHashes ?? null)}::text[]
    FROM mail ON CONFLICT DO NOTHING RETURNING *
  ), updated AS (
    UPDATE sending_emails e SET status = ${next ?? null}, provider_id = coalesce(${input.providerId || null}::text, e.provider_id), error_code = coalesce(${input.errorCode ?? null}::text, e.error_code), updated_at = clock_timestamp()
    FROM mail, inserted WHERE e.id = mail.id AND e.workspace_id = ${input.workspaceId}
      AND ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int
  ), published AS (
    INSERT INTO operation_events(id, workspace_id, type, region, created_at, data)
    SELECT inserted.id, inserted.workspace_id, ${publicType ?? null}::text, mail.region, inserted.created_at,
      ${JSON.stringify({ ...(input.data ?? {}), ...(input.providerId ? { providerId: input.providerId } : {}) })}::jsonb || jsonb_build_object('emailId',mail.id,'simulated',mail.simulated)
    FROM inserted, mail WHERE ${publicType ?? null}::text IS NOT NULL ON CONFLICT DO NOTHING RETURNING *
  ), deliveries AS (
    INSERT INTO operation_deliveries(id, workspace_id, webhook_id, event_id, payload)
    SELECT 'whd_' || replace(gen_random_uuid()::text, '-', ''), p.workspace_id, w.id, p.id,
      jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'type',p.type,'region',p.region,'createdAt',p.created_at,'data',p.data)
    FROM published p JOIN operation_webhooks w ON w.workspace_id=p.workspace_id
    WHERE NOT w.paused AND w.event_types ? p.type AND (w.regions IS NULL OR p.region IS NULL OR w.regions ? p.region)
    ON CONFLICT DO NOTHING RETURNING id, workspace_id
  ), webhook_jobs AS (
    INSERT INTO jobs(id, workspace_id, type, payload)
    SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), workspace_id, 'operation.webhook', jsonb_build_object('deliveryId', id, 'generation', 0) FROM deliveries RETURNING id
  ), simulated_callbacks AS (
    SELECT 'urn:opensend:simulated-ses:' || mail.region AS topic_arn, mail.id || ':' || kind AS message_id, inserted.workspace_id,
      inserted.created_at + CASE WHEN kind='Delivery' THEN ${runtime.config.simulatedSes.deliveryDelayMs}::int ELSE 0 END * interval '1 millisecond' AS created_at
    FROM inserted, mail, unnest(ARRAY['Send','Delivery']) kind
    WHERE ${simulatedJobs}::boolean
  ), simulated_jobs AS (
    INSERT INTO jobs(id, workspace_id, type, available_at, payload)
    SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), r.workspace_id, 'operation.simulatedFeedback', r.created_at,
      jsonb_build_object('topicArn',r.topic_arn,'messageId',r.message_id,'region',mail.region,
        'message', jsonb_build_object('eventType',split_part(r.message_id,':',2),'mail',jsonb_build_object('messageId',${input.providerId ?? null}::text),
          lower(split_part(r.message_id,':',2)),jsonb_build_object('timestamp',r.created_at)))
    FROM simulated_callbacks r, mail
  ), receipt_processed AS (
    UPDATE operation_sns_receipts SET processed_at = clock_timestamp()
    WHERE workspace_id = ${input.workspaceId}
      AND topic_arn = ${input.receipt?.topicArn ?? null} AND message_id = ${input.receipt?.messageId ?? null} AND EXISTS (SELECT 1 FROM mail)
  ) SELECT (SELECT row_to_json(e) FROM (SELECT id, workspace_id AS "workspaceId", email_id AS "emailId", type,
    provider_id AS "providerId", external_id AS "externalId", data, simulated, created_at::text AS "createdAt" FROM inserted) e) AS event,
    (SELECT count(*) FROM webhook_jobs)::int AS runnable, (SELECT region FROM mail) AS region`);
  const row = result.rows[0]!;
  if (isSimulatedSes(runtime) && input.type === 'accepted' && input.providerId?.startsWith('sim_') && runtime.feedback && row.event) await queueSimulatedFeedback(runtime, [{ emailId: input.emailId, region: row.region, providerId: input.providerId, createdAt: row.event.createdAt }]);
  return row;
}
// Simulated acceptance produces the same Send/Delivery callbacks a live SNS subscription would,
// pushed through the runtime's feedback sink to exercise the live ingestion path.
export async function queueSimulatedFeedback(runtime: Runtime, accepted: { emailId: string; region: string; providerId: string; createdAt: string }[]) {
  if (!runtime.feedback || !accepted.length) return;
  const delay = runtime.config.simulatedSes.deliveryDelayMs;
  const items = accepted.flatMap(item => (['Send', 'Delivery'] as const).map(kind => {
    const at = new Date(Date.parse(item.createdAt) + (kind === 'Delivery' ? delay : 0)).toISOString();
    return { region: item.region, topicArn: `urn:opensend:simulated-ses:${item.region}`, messageId: `${item.emailId}:${kind}`,
      message: { eventType: kind, mail: { messageId: item.providerId }, [kind.toLowerCase()]: { timestamp: at } } };
  }));
  await runtime.feedback.enqueue(items);
}
// Shared by campaign workers and the dispatch claim. A queued origin cannot bootstrap membership.
export function approvedOriginUser(runtime: Runtime, workspaceId: SQL, userId: SQL, direct = sql`false`) {
  const c = runtime.config;
  return sql`SELECT 1 FROM workspace_members m JOIN auth_user u ON u.id = m.user_id
    JOIN auth_account g ON g.user_id = u.id AND g.provider_id = 'google' AND g.account_id <> ''
    WHERE ${Boolean(c.googleClientId && c.googleClientSecret && c.authSecret)}::boolean AND m.workspace_id = ${workspaceId} AND m.user_id = ${userId}
      AND (m.role IN ('owner', 'admin') ${c.multiTenant ? sql`OR (m.role = 'member' AND ${direct})` : sql``}) AND u.email_verified AND u.email <> ''
      ${c.multiTenant ? sql`` : sql`AND (${JSON.stringify(c.allowedEmails)}::jsonb ? lower(u.email) OR (u.google_hosted_domain <> '' AND ${JSON.stringify(c.allowedDomains)}::jsonb ? lower(u.google_hosted_domain)))`}
    LIMIT 1 FOR SHARE OF m, u, g`;
}
export async function originAllowed(runtime: Runtime, db: DbExecutor, mail: { workspaceId: string; actorKeyId: string; campaignId?: string | null; snapshot: Pick<EmailSnapshot, 'from'> }) {
  // Session-origin jobs retain the Google principal, not a browser session or bootstrap credential.
  // Queued work may re-check membership but must never create or restore it.
  if (mail.actorKeyId.startsWith('user_')) {
    return (await db.execute(approvedOriginUser(runtime, sql`${mail.workspaceId}`, sql`${mail.actorKeyId.slice(5)}`, sql`${!mail.campaignId}::boolean`))).rows.length > 0;
  }
  if (mail.actorKeyId.startsWith('mbk_')) {
    // Mailbox keys may send only as an address of a mailbox they are scoped to.
    const [key] = await db.select().from(mailboxKeys).where(and(eq(mailboxKeys.id, mail.actorKeyId), eq(mailboxKeys.workspaceId, mail.workspaceId))).for('share');
    if (!key || key.revokedAt || !key.permissions.includes('send')) return false;
    const [owner] = await db.select({ mailboxId: mailboxAddresses.mailboxId }).from(mailboxAddresses).where(and(eq(mailboxAddresses.workspaceId, mail.workspaceId), eq(mailboxAddresses.address, mail.snapshot.from.toLowerCase())));
    return !!owner && (!key.mailboxIds || key.mailboxIds.includes(owner.mailboxId));
  }
  if (mail.actorKeyId.startsWith('mcp_')) {
    const grant = await getMcpGrantActor(runtime, mail.actorKeyId, db);
    return !!grant && (!mail.campaignId || grant.role !== 'member') && grant.workspaceId === mail.workspaceId &&
      (grant.permissions.includes('manage') || grant.permissions.includes('send')) &&
      senderDomainAllowed(grant.domains, mail.snapshot.from.split('@')[1]!);
  }
  // Removed bootstrap origins fail closed; only durable API keys are accepted below.
  const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, mail.actorKeyId), eq(apiKeys.workspaceId, mail.workspaceId))).for('share');
  // Shared readers allow parallel sends but conflict with revocation/permission updates through the durable attempt claim,
  // never through SES I/O. Once attempting, revocation cannot recall an in-flight provider call.
  return !!key && !key.revokedAt && (key.permissions.includes('manage') || key.permissions.includes('send')) && senderDomainAllowed(key.domains, mail.snapshot.from.split('@')[1]!);
}
export function checkedDispatchAttachments(ids: string[], rows: (typeof attachments.$inferSelect)[]) {
  validateAttachmentRows(distinctAttachmentIds(ids), rows);
  return rows;
}
export async function materializeCampaignEmail(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, review: { draft: CampaignDraft; rendered: { html?: string; text?: string }; contentHash: string | null; recipient: ReviewedRecipient } | null, prefetched?: (typeof attachments.$inferSelect)[]) {
  // Review/recipient data and attachment metadata are immutable; retained email
  // links prevent attachment deletion. No transaction is needed to render them.
  // The winning claim persists its snapshot and token atomically; losing workers
  // discard their render without writing a different snapshot over the winner.
  const rows = prefetched ? checkedDispatchAttachments(mail.snapshot.attachments, prefetched) : await attachmentRows(runtime.db, a, mail.snapshot.attachments);
  if (!review?.rendered || !review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The reviewed recipient is unavailable.');
  const snapshot = await campaignMessage(runtime, runtime.db, a, review.draft, review.recipient, false, true, rows, review.rendered, true, !review.rendered.html?.includes('{{'));
  if (await digest(canonical(snapshot)) !== review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_CHANGED', 'The renderer no longer reproduces the reviewed message. No provider attempt was made.');
  // A retried row (throttled requeue) reuses the link it was first rendered with, so every attempt sends the same message.
  const reused = mail.snapshot.unsubscribeUrl;
  const unsubscribe = reused
    ? { url: reused, record: { tokenHash: await digest(reused.slice(reused.lastIndexOf('/') + 1)), workspaceId: a.workspaceId, email: snapshot.to[0]!.trim().toLowerCase() } }
    : await createUnsubscribeLink(runtime, a.workspaceId, snapshot.to[0]!);
  marketingFooter(snapshot, unsubscribe.url);
  sizeCheck(snapshot, rows);
  // Persist only the compact stub plus the unsubscribe URL: the body is reproducible from the frozen review and
  // recipient (verified by contentHash), so storing ~2-3 KB of rendered HTML per recipient bought nothing.
  const stored: EmailSnapshot = { ...mail.snapshot, unsubscribeUrl: unsubscribe.url };
  return { mail: { ...mail, snapshot }, rows, unsubscribe: unsubscribe.record, stored };
}
// Bump when interpolation, preheader or footer output changes, and keep the previous renderer for older reviews.
export const CAMPAIGN_RENDERER_VERSION = 1;
// Rebuilds a sent campaign email from its frozen review, recipient values and stored unsubscribe URL, and refuses to
// show anything that does not match the hash of what was reviewed and sent.
type SentReview = { draft: CampaignDraft; rendered: { html?: string; text?: string } | null; renderer_version: number; recipient: ReviewedRecipient; content_hash: string | null };
export async function sentCampaignContent(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect): Promise<EmailSnapshot> {
  if (!mail.reviewId || mail.reviewOrdinal === null || !mail.snapshot.unsubscribeUrl) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  const found = await runtime.db.execute<SentReview>(sql`
    SELECT v.draft, v.rendered, v.renderer_version, r.recipient, r.content_hash
    FROM sending_campaign_reviews v JOIN sending_review_recipients r ON r.review_id = v.id AND r.ordinal = ${mail.reviewOrdinal}
    WHERE v.id = ${mail.reviewId} AND v.campaign_id = ${mail.campaignId} AND v.workspace_id = ${a.workspaceId}`);
  return rebuildCampaignEmail(runtime, a, mail.snapshot, found.rows[0], await attachmentRows(runtime.db, a, mail.snapshot.attachments));
}
// Pure: no writes, no provider calls. Also used to verify stored bodies before they are dropped.
export async function rebuildCampaignEmail(runtime: Runtime, a: Actor, stub: EmailSnapshot, review: SentReview | undefined, rows: (typeof attachments.$inferSelect)[]): Promise<EmailSnapshot> {
  if (!review?.rendered || !review.content_hash) throw new ApiError(410, 'EMAIL_CONTENT_EXPIRED', 'The campaign review this email was rendered from has been retired.');
  if (review.renderer_version !== CAMPAIGN_RENDERER_VERSION) throw new ApiError(409, 'CAMPAIGN_RENDERER_CHANGED', `This email was rendered by campaign renderer v${review.renderer_version}; this release only reproduces v${CAMPAIGN_RENDERER_VERSION}.`);
  if (!stub.unsubscribeUrl) throw new ApiError(409, 'EMAIL_CONTENT_UNAVAILABLE', 'This campaign email has no stored content to rebuild.');
  const snapshot = await campaignMessage(runtime, runtime.db, a, review.draft, review.recipient, false, true, rows, review.rendered, true, !review.rendered.html?.includes('{{'));
  if (await digest(canonical(snapshot)) !== review.content_hash) throw new ApiError(409, 'CAMPAIGN_CONTENT_UNREPRODUCIBLE', 'The renderer no longer reproduces the message that was sent.');
  marketingFooter(snapshot, stub.unsubscribeUrl);
  return snapshot;
}
// Accepted means provider acceptance evidence; bounce and complaint rates are over accepted mail. Suppressed mail
// (ineligible at claim time, or dropped by SES Auto Validation before sending) is neither accepted nor bounced.
async function campaignHealth(db: DbExecutor, a: Actor, campaignId: string): Promise<{ code: string; message: string } | null> {
  const [row] = (await db.execute<{ accepted: number; bounced: number; complained: number }>(sql`SELECT
    count(*) FILTER (WHERE status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed')))::int AS accepted,
    count(*) FILTER (WHERE status = 'bounced')::int AS bounced, count(*) FILTER (WHERE status = 'complained')::int AS complained
    FROM sending_emails WHERE workspace_id = ${a.workspaceId} AND campaign_id = ${campaignId}`)).rows;
  const percent = (part: number, whole: number) => `${(100 * part / whole).toFixed(2)}%`;
  if (row!.accepted >= AUTO_PAUSE.bounceMinimum && row!.bounced / row!.accepted > AUTO_PAUSE.bounceRate)
    return { code: 'BOUNCE_RATE_HIGH', message: `Paused automatically: ${percent(row!.bounced, row!.accepted)} of ${row!.accepted} accepted emails bounced (limit ${AUTO_PAUSE.bounceRate * 100}%). Review the audience before resuming.` };
  if (row!.accepted >= AUTO_PAUSE.complaintMinimum && row!.complained / row!.accepted > AUTO_PAUSE.complaintRate)
    return { code: 'COMPLAINT_RATE_HIGH', message: `Paused automatically: ${percent(row!.complained, row!.accepted)} of ${row!.accepted} accepted emails were marked as spam (limit ${AUTO_PAUSE.complaintRate * 100}%). Review the audience before resuming.` };
  return null;
}
// The campaign row with its frozen snapshot and the cached regional limits: one read per step of the run job.
type RunAccount = NonNullable<Actor['dispatchAccount']> & { pauseReason: string | null; generation:number };
type RunRow = typeof campaigns.$inferSelect & { reviewDraft: CampaignDraft | null; reviewRendered: { html?: string; text?: string } | null; rate: number; max24: number; sent24: number; quotaCheckedAt: string | null; dbNow: string; account: RunAccount | null };
async function readRun(runtime: Runtime, a: Actor, campaignId: string): Promise<RunRow | undefined> {
  const limits = limitsTable(runtime), region = sql`${campaignReviews.draft}->>'region'`;
  const [row] = await runtime.db.select({ ...getTableColumns(campaigns), reviewDraft: campaignReviews.draft, reviewRendered: campaignReviews.rendered,
    account: runtime.config.multiTenant ? sql<RunAccount>`(SELECT jsonb_build_object('aws_account_id', aws_account_id, 'kind', kind, 'pauseReason', pause_reason,'generation',generation) FROM ${sendingConnections(runtime)} WHERE workspace_id=${a.workspaceId} AND region=${region})` : sql<null>`NULL`,
    rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    max24: sql<number>`coalesce((SELECT max_24_hour_send FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    sent24: sql<number>`coalesce((SELECT sent_last_24_hours FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region}),0)`,
    quotaCheckedAt: sql<string | null>`(SELECT checked_at::text FROM ${limits} WHERE workspace_id=${a.workspaceId} AND region=${region})`,
    dbNow: sql<string>`clock_timestamp()::text`,
  }).from(campaigns).leftJoin(campaignReviews, eq(campaignReviews.id, campaigns.reviewId)).where(campaignWhere(a, campaignId));
  return row;
}
const staleReview = () => new ApiError(409,'SENDER_BINDING_CHANGED','The reviewed sending binding is no longer ready.');
async function assertReviewBinding(runtime:Runtime,db:DbExecutor,a:Actor,draft:CampaignDraft) {
  if (!(await db.execute(sql`SELECT 1 FROM regional_sender(${a.workspaceId},${draft.from.split('@')[1]!.toLowerCase()},${isSimulatedSes(runtime)}) r
    WHERE r.verified AND r.region=${draft.region} AND r.connection IS NOT NULL AND r.binding=${JSON.stringify(draft.binding)}::jsonb
      AND (${isSimulatedSes(runtime)} OR r.connection->>'kind'<>'shared' OR r.connection->>'tenant_state'='ready')`)).rowCount) throw staleReview();
}
// preparing: validate the next chunk of frozen recipients (every substitution, URL and MIME size) and keep only each
// message's digest; when the whole list is validated the campaign moves to its schedule or straight to sending.
async function prepareStep(runtime: Runtime, a: Actor, row: RunRow, jobId: string) {
  const ref = campaignRef(a, row.id), review = { draft: row.reviewDraft!, rendered: row.reviewRendered! };
  await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'preparing' || campaign.reviewId !== row.reviewId) return;
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: review.draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return; }
    if (review.draft.binding) await assertReviewBinding(runtime,db,a,review.draft);
    else await assertRegionEnabled(db, a.workspaceId, review.draft.region);
    if (!isSimulatedSes(runtime) && !runtime.config.multiTenant) await assertLiveRegionReady(runtime, db, review.draft.region, 'marketing', true, a.workspaceId);
    const lockedAttachments = await attachmentRows(db, a, review.draft.attachments, true);
    const recipients = await recipientChunk(db, campaign.reviewId!, campaign.prepared);
    if (!recipients.length) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
    validateInterpolationTemplate(review.draft.subject, false);
    validateInterpolationTemplate(review.rendered.html, true);
    validateInterpolationTemplate(review.rendered.text, false);
    const htmlStatic = !review.rendered.html?.includes('{{');
    if (htmlStatic) validateHtmlUrls(review.rendered.html);
    const messageStatic = ![review.draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));
    let cursor = campaign.prepared, bytes = 0;
    const started = Date.now(), prepared: { ordinal: number; hash: string; subject: string; bytes: number }[] = [];
    let staticSnapshot: EmailSnapshot | undefined;
    for (const recipient of recipients) {
      if (recipient.ordinal !== cursor + 1 || recipient.content_hash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
      // The immutable rendered base is shared by all recipients; the full message audit is saved at dispatch.
      if (messageStatic && !Address.safeParse(recipient.recipient.email).success) throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Contact ${recipient.recipient.id}: Recipient or rendered message is invalid (to).`, 'contactId');
      if (messageStatic && !staticSnapshot) staticSnapshot = await campaignMessage(runtime, db, a, review.draft, recipient.recipient, false, true, lockedAttachments, review.rendered, true, true);
      const snapshot = staticSnapshot
        ? { ...staticSnapshot, to: [recipient.recipient.email], headers: [...staticSnapshot.headers] }
        : await campaignMessage(runtime, db, a, review.draft, recipient.recipient, false, true, lockedAttachments, review.rendered, true, htmlStatic);
      const contentHash = await digest(canonical(snapshot));
      marketingFooter(snapshot, `${runtime.config.publicUrl.replace(/\/$/, '')}/unsubscribe/u_${'0'.repeat(64)}`);
      sizeCheck(snapshot, lockedAttachments);
      const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      if (prepared.length && bytes + size > CAMPAIGN_PREPARE_BYTES) break;
      prepared.push({ ordinal: recipient.ordinal, hash: contentHash, subject: snapshot.subject, bytes: size }); bytes += size; cursor = recipient.ordinal;
      if (Date.now() - started >= 10000) break;
    }
    log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId, campaignId: campaign.id, cursor: campaign.prepared, rows: prepared.length, messageStatic, durationMs: Date.now() - started });
    await db.execute(sql`UPDATE sending_review_recipients r SET content_hash = p.hash, subject = p.subject, snapshot_bytes = p.bytes
      FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) AS p(ordinal integer, hash text, subject text, bytes integer)
      WHERE r.review_id = ${campaign.reviewId} AND r.ordinal = p.ordinal AND r.content_hash IS NULL`);
    await db.execute(recordPrepared(ref, cursor, runningState({ prepared: cursor, total: campaign.total, scheduledAt: campaign.scheduledAt })));
  });
}
// sending: release the next recipients into the dispatch queue within the buffer, pacing, rate share and SES quota.
// Returns 'again' when another release can start at once, 'done' when this run has nothing more to do, and waits in
// place (JobDeferred on the same job row) otherwise.
async function releaseStep(runtime: Runtime, a: Actor, row: RunRow, payload: Record<string, unknown>): Promise<'again' | 'done'> {
  const ref = campaignRef(a, row.id), nowMs = Date.now();
  // Every recipient is released: the dispatcher marks the campaign done when its last row leaves the queue.
  if (row.expanded >= row.total) return 'done';
  // Do not turn a retired generation into a pacing/quota wait, or refresh its provider quota.
  if (row.reviewDraft?.binding && row.account?.generation!==row.reviewDraft.binding.generation) throw staleReview();
  // Poll a full buffer with one bounded count, before the locks and origin checks; the transaction rechecks capacity under the admission lock.
  const limits = { campaign: campaignBuffer(row.rate), total: workspaceBuffer(row.rate) };
  const [buffered] = (await runtime.db.execute<{ total: number; campaign: number }>(sql`SELECT
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id IS NOT NULL AND status IN ('queued','attempting') LIMIT ${limits.total}) e) AS total,
    (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id=${a.workspaceId} AND campaign_id=${row.id} AND status IN ('queued','attempting') LIMIT ${limits.campaign}) c) AS campaign`)).rows;
  // Record why releasing is held (shown on the campaign), then wait in place.
  const hold = async (reason: 'pacing_window' | 'ses_daily_quota', until: string): Promise<never> => {
    await runtime.db.execute(holdCampaign(ref, reason, until));
    throw new JobDeferred(until, payload);
  };
  // A stale/nonexistent sample is not an unlimited allowance. When a known quota (or a
  // previously held campaign) needs a new sample, use the dispatcher's elected cache refresher.
  // This works with an empty queue and does not release a probe/buffer of speculative emails.
  const dbNow = Date.parse(row.dbNow);
  let max = Number(row.max24), sent = Number(row.sent24), refreshAt = Date.parse(row.quotaCheckedAt ?? '') + QUOTA_REFRESH_MS;
  // A brand-new region has no previous allowance to preserve. Keep its normal cold-start
  // buffer and Hosted admission checks; the first dispatch populates its quota cache.
  if ((row.quotaCheckedAt !== null || max > 0 || row.waitingReason === 'ses_daily_quota') && !(refreshAt > dbNow)) {
    const { campaignQuota } = await import('./dispatcher.js');
    const q = await campaignQuota(runtime, a, row.reviewDraft!.region, row.account?.aws_account_id).catch(() => null);
    if (!q) return hold('ses_daily_quota', new Date(dbNow + QUOTA_REFRESH_MS).toISOString());
    max = q.max24HourSend; sent = q.sentLast24Hours; refreshAt = q.checkedAt + QUOTA_REFRESH_MS;
  }
  const sesCapacity = max > 0 ? max - sent - sesDailyReserve(max, runtime.config.dispatch.dailyHeadroomPercent) : max === 0 && row.waitingReason === 'ses_daily_quota' ? 0 : Infinity;
  const quotaUntil = new Date(Math.max(dbNow + 1000, Number.isFinite(refreshAt) ? refreshAt : dbNow + QUOTA_REFRESH_MS)).toISOString();
  if (sesCapacity <= buffered!.total) return hold('ses_daily_quota', quotaUntil);
  if (buffered!.campaign >= limits.campaign || buffered!.total >= limits.total) {
    const backlog = Math.max(buffered!.campaign - limits.campaign / 2, buffered!.total - limits.total / 2);
    throw new JobDeferred(new Date(nowMs + drainDelayMs(backlog, row.rate)).toISOString(), payload);
  }
  const rolling = row.pacePerDay !== null && !!row.windowStartedAt && nowMs - Date.parse(row.windowStartedAt) >= DAY_MS;
  // Automatic pause: checked at most every 30 minutes while releasing, so always before a new daily window
  // opens; a resume restarts the 30 minutes so a deliberate resume is not immediately re-paused.
  if (row.autoPause && (!row.healthCheckedAt || nowMs - Date.parse(row.healthCheckedAt) >= AUTO_PAUSE.intervalMs)) {
    const unhealthy = await campaignHealth(runtime.db, a, row.id);
    if (unhealthy) {
      const paused = await runtime.db.execute(pauseCampaign(ref, unhealthy));
      if (paused.rows.length) log('warn', { code: 'CAMPAIGN_AUTO_PAUSED', campaignId: row.id, reason: unhealthy.code });
      return 'done';
    }
    await runtime.db.execute(noteHealthChecked(ref));
  }
  // Daily pacing: at most pacePerDay recipients per rolling 24-hour window.
  if (row.pacePerDay !== null && row.windowStartedAt && !rolling && row.windowExpanded >= row.pacePerDay) await hold('pacing_window', new Date(Date.parse(row.windowStartedAt) + DAY_MS).toISOString());
  // SES 24-hour quota (cached from GetAccount about every minute): keep a reserve for transactional mail.
  let rateAllowance = Number.POSITIVE_INFINITY, shareRate = 0;
  // Rate share: release at most rateShare of the regional send rate, measured from the previous release.
  if (row.rateShare !== null && row.rateShare < 1 && Number(row.rate) > 0) {
    shareRate = row.rateShare * Number(row.rate);
    const last = typeof payload.releasedAt === 'string' ? Date.parse(payload.releasedAt) : nowMs - RELEASE_INTERVAL_MS;
    rateAllowance = Math.floor(shareRate * Math.min(Math.max(0, nowMs - last), RELEASE_BURST_MS) / 1000);
    if (rateAllowance < 1) throw new JobDeferred(new Date(last + Math.ceil(1000 / shareRate)).toISOString(), payload);
  }
  const draft = row.reviewDraft!, limits_ = limitsTable(runtime);
  const released = await runtime.db.transaction(async db => {
    const campaign = await findCampaign(db, a, row.id, true);
    if (campaign.state !== 'sending' || campaign.reviewId !== row.reviewId || campaign.expanded >= campaign.total) return null;
    await lockAdmission(db, a);
    const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, campaignId: campaign.id, snapshot: { from: draft.from } });
    if (!authorized) { await cancelCampaignWork(db, a, campaign, 'ORIGIN_KEY_REVOKED'); return null; }
    if (draft.binding) await assertReviewBinding(runtime,db,a,draft); // Fence the actual insert against disable/reclaim after the precheck.
    const [buffer] = await db.select({ total: sql<number>`count(*)::int`, campaign: sql<number>`count(*) FILTER (WHERE ${emails.campaignId} = ${campaign.id})::int`,
      hosted: hostedAllowance(runtime.config, a.workspaceId, campaign.simulated ? 0 : 1),
      rate: sql<number>`coalesce((SELECT max_send_rate FROM ${limits_} WHERE workspace_id=${a.workspaceId} AND region=${draft.region}),0)`,
    }).from(emails).where(and(scope(emails, a), isNotNull(emails.campaignId), inArray(emails.status, ['queued', 'attempting'])));
    // A capped campaign opens a new 24-hour window when the previous one has elapsed (or on its first release).
    const windowStart = campaign.pacePerDay !== null && (!campaign.windowStartedAt || Date.now() - Date.parse(campaign.windowStartedAt) >= DAY_MS) ? now() : campaign.windowStartedAt;
    const windowUsed = windowStart === campaign.windowStartedAt ? campaign.windowExpanded : 0;
    const paceLeft = campaign.pacePerDay === null ? Number.POSITIVE_INFINITY : campaign.pacePerDay - windowUsed;
    if (paceLeft <= 0) throw new JobDeferred(new Date(Date.parse(windowStart!) + DAY_MS).toISOString(), payload);
    const sesAllowance = sesCapacity - buffer!.total;
    if (sesAllowance <= 0) return 'quota';
    const capacity = Math.min(CAMPAIGN_EXPAND_ROWS, campaignBuffer(buffer!.rate) - buffer!.campaign, workspaceBuffer(buffer!.rate) - buffer!.total, paceLeft, sesAllowance, rateAllowance);
    if (capacity <= 0) {
      // Lost a race with another release after the bounded precheck: wait for the buffer to drain (the rollback releases only locks).
      const backlog = Math.max(buffer!.campaign - campaignBuffer(buffer!.rate) / 2, buffer!.total - workspaceBuffer(buffer!.rate) / 2);
      throw new JobDeferred(new Date(Date.now() + drainDelayMs(backlog, buffer!.rate)).toISOString(), payload);
    }
    assertHostedAllowance(buffer!.hosted, 0);
    let recipients = await recipientChunk(db, campaign.reviewId!, campaign.expanded, capacity);
    if (!recipients.length || recipients.some((recipient, index) => !recipient.content_hash || recipient.subject === null || recipient.ordinal !== campaign.expanded + index + 1)) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The prepared audience is incomplete.');
    const allowance = buffer!.hosted;
    let hostedUntil: string | null = null;
    if (allowance && !campaign.simulated) {
      let left = allowance.marketingCap - allowance.used;
      const blocked = recipients.findIndex(r => hostedCost(r.recipient.email) > 0 && --left < 0);
      if (blocked >= 0) {
        hostedUntil = allowance.nextChangeAt;
        if (blocked === 0) {
          await db.execute(holdCampaign(ref, 'hosted_daily_quota', hostedUntil));
          return {count:0, completed:false, hostedUntil};
        }
        recipients = recipients.slice(0, blocked); // Commit the affordable prefix and its wait together.
      }
    }
    const prepared = recipients.map(recipient => ({ id: id('email'), ordinal: recipient.ordinal, snapshot: {
      from: draft.from, ...(draft.fromName !== undefined ? { fromName: draft.fromName } : {}), to: [recipient.recipient.email], cc: [], bcc: [], replyTo: draft.replyTo ?? [], region: draft.region,
      kind: 'marketing' as const, subject: recipient.subject!, attachments: draft.attachments, tracking: draft.tracking, headers: [], deferredCampaign: true, ...(draft.binding ? {binding:draft.binding} : {}),
    } satisfies EmailSnapshot }));
    await db.insert(emails).values(prepared.map(({ id: emailId, ordinal, snapshot }) => ({ id: emailId, workspaceId: a.workspaceId, actorKeyId: a.keyId, region: snapshot.region, campaignId: campaign.id, reviewId: campaign.reviewId, reviewOrdinal: ordinal, from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, snapshot, simulated: campaign.simulated, scheduledAt: campaign.scheduledAt })));
    const links = prepared.flatMap(({ id: emailId, snapshot }) => snapshot.attachments.map(attachmentId => ({ workspaceId: a.workspaceId, attachmentId, ownerType: 'email' as const, ownerId: emailId })));
    if (links.length) await db.insert(attachmentLinks).values(links);
    const expanded = recipients[recipients.length - 1]!.ordinal;
    await db.execute(recordExpanded(ref, expanded, windowStart, windowUsed + prepared.length, hostedUntil));
    log('info', { code: 'CAMPAIGN_RELEASED', campaignId: campaign.id, released: prepared.length, expanded, total: campaign.total, capacity, buffered: buffer!.campaign, workspaceBuffered: buffer!.total, rate: buffer!.rate });
    return { count: prepared.length, completed: expanded === campaign.total, hostedUntil };
  });
  if (!released) return 'done';
  if (released === 'quota') return hold('ses_daily_quota', quotaUntil);
  // Released rows are claimed directly by the region dispatcher.
  if (released.count) try { await runtime.dispatch?.(draft.region, row.account?.aws_account_id, released.count, row.account?.kind); } catch { log('warn', { code: 'DISPATCH_WAKE_FAILED', campaignId: row.id, message: 'Released mail is durable; the dispatcher polls and the scheduler pings it.' }); }
  // Usually the oldest bucket expires first. Also notice an earlier refund or operator raise.
  if (released.hostedUntil) throw new JobDeferred(new Date(Math.min(Date.parse(released.hostedUntil),dbNow+QUOTA_REFRESH_MS)).toISOString(),payload);
  if (released.completed) return 'done';
  if (sesCapacity <= buffered!.total + released.count) return hold('ses_daily_quota', quotaUntil);
  // A rate-shared continuation runs once this release has been paid for at the campaign's share.
  if (shareRate) throw new JobDeferred(new Date(Date.now() + Math.max(1000, Math.ceil(1000 * released.count / shareRate))).toISOString(), { ...payload, releasedAt: now() });
  return 'again';
}
// One job per campaign (jobs.id = campaign.run:<id>): it reads the row, acts for its state and loops while the next
// step can start at once (prepare chunks, prepare -> sending, buffer refills); it waits in place for the schedule,
// the dispatch buffer, pacing or quota, and stops as soon as the state is one it does not run (paused, done,
// failed, canceled). A definitive error or the last retry leaves `failed`, never a campaign sending forever.
const RUN_BUDGET_MS = 12000;
const runCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'A campaign run needs its campaign.');
  const campaignId = payload.campaignId, a: Actor = { workspaceId: job.workspaceId, keyId: 'worker', permissions: ['manage'], domains: [] };
  const ref = campaignRef(a, campaignId), started = Date.now();
  try {
    for (;;) {
      const row = await readRun(runtime, a, campaignId);
      if (!row || !(CAMPAIGN_RUNNING as readonly string[]).includes(row.state)) return;
      if (row.account?.pauseReason && row.expanded < row.total) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', row.account.pauseReason);
      if (row.simulated !== isSimulatedSes(runtime)) throw new ApiError(409, 'SES_MODE_CHANGED', 'The campaign was launched with a different SES configuration. No more recipients were queued.');
      if (!row.reviewDraft || !row.reviewRendered) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen message source is missing.');
      a.keyId = row.actorKeyId ?? a.keyId;
      if (row.state === 'preparing') await prepareStep(runtime, a, row, job.id);
      else if (row.state === 'scheduled') {
        if (row.scheduledAt && Date.parse(row.scheduledAt) > Date.now()) throw new JobDeferred(row.scheduledAt, payload);
        await runtime.db.execute(startSending(ref));
      } else if (await releaseStep(runtime, a, row, payload) === 'done') return;
      if (Date.now() - started >= RUN_BUDGET_MS) throw new JobDeferred(now(), payload);
    }
  } catch (error) {
    if (error instanceof JobDeferred) throw error;
    if (error instanceof ApiError && error.code === 'HOSTED_SENDING_PAUSED') {
      await runtime.db.execute(pauseCampaign(ref, { code: error.code, message: error.message }));
      return;
    }
    const retry = !(error instanceof ApiError) || error.retryable;
    if (retry && job.attempts < MAX_ATTEMPTS) throw new ApiError(503, error instanceof ApiError ? error.code : 'CAMPAIGN_RUN_FAILED', 'The campaign run will retry from its durable cursors.', undefined, true);
    try {
      const failed = await runtime.db.execute(failCampaign(ref, backgroundFailure(error)));
      if (failed.rows.length) log('error', { code: 'CAMPAIGN_FAILED', campaignId, jobId: job.id, cause: error instanceof ApiError ? error.code : 'CAMPAIGN_DEPENDENCY_FAILED' });
    } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign failure state will retry until it is durable.', undefined, true); }
  }
};
// Pre-migration email.dispatch job rows complete as no-ops: sending_emails.status drives the dispatcher (src/dispatcher.ts).
const retiredDispatchJob: JobHandler = async () => {};
// Job rows of the previous release's prepare/expand/finish chain continue as runs of the same campaign.
export const jobHandlers: Record<string, JobHandler> = { 'email.dispatch': retiredDispatchJob, 'campaign.run': runCampaign, 'campaign.prepare': runCampaign, 'campaign.expand': runCampaign, 'campaign.finish': runCampaign };
