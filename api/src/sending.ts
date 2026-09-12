import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { apiKeys, jobs, jobSchedule } from './db/core.js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { GetAccountCommand, GetEmailTemplateCommand, SendEmailCommand, TestRenderEmailTemplateCommand, type Attachment, type SESv2Client, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { actor, ApiError, digest, errors, getSes, id, IdParams, json, log, notFound, PageQuery, page, redactCapabilityData, redactCapabilityText, region, response, security, senderDomainAllowed, timed, type Actor, type App, type Ctx, type DbExecutor, type JobHandler, type Mode, type Runtime, type Storage } from './core.js';
import { enqueue, MAX_ATTEMPTS } from './jobs.js';
import { AudienceSpec, getAudience, snapshotCampaignAudience } from './audience.js';
import { isApprovedUser } from './google-auth.js';
import { getMcpGrantActor } from './mcp-auth.js';
import { assertLiveRegionReady, assertRegionEnabled } from './ses-region-state.js';
import { createUnsubscribeLink, unsubscribeUrl } from './operations.js';
import { attachmentLinks, attachments, campaignExpansions, campaignReviews, campaigns, emailEvents, emails, regionalLimits, reviewRecipients, sendingIdempotency, type CampaignDraft, type EmailSnapshot, type EmailStatus, type ReviewedRecipient } from './db/sending.js';
import { BlockContentError, CAMPAIGN_CONTENT_GUIDE, renderBlockHtml, renderBlockText, validateBlockHtml } from './campaign-blocks.js';
import { instantiateTemplate } from './templates.js';

const MAX_ATTACHMENTS = 8 * 1024 * 1024;
const MAX_ENCODED_MESSAGE = 16 * 1024 * 1024;
const MAX_BODY = 512 * 1024;
const SENDING_LIMITS = {
  test: { pending: 500, keyPending: 100, storedAttachmentBytes: 64 * 1024 * 1024, expandedCampaignBytes: 16 * 1024 * 1024 },
  live: { pending: 10000, keyPending: 2000, storedAttachmentBytes: 1024 * 1024 * 1024, expandedCampaignBytes: 128 * 1024 * 1024 },
} as const;
const CAMPAIGN_CHUNK_ROWS = 200;
const CAMPAIGN_CHUNK_BYTES = 2 * 1024 * 1024;
const CAMPAIGN_PREPARED_BYTES = 64 * 1024 * 1024 * 1024;
const CAMPAIGN_BUFFER = 400;
// Called only inside admission transactions, before campaign/attachment locks.
// A workspace row lock serializes both environments without Hyperdrive-unsupported
// advisory locks. Reuse the scheduler row without changing its rotation counter.
async function lockAdmission(db: DbExecutor, a: Actor) {
  await db.insert(jobSchedule).values({ workspaceId: a.workspaceId }).onConflictDoNothing();
  await db.select({ workspaceId: jobSchedule.workspaceId }).from(jobSchedule).where(eq(jobSchedule.workspaceId, a.workspaceId)).for('update');
}
async function checkPending(db: DbExecutor, a: Actor, incoming: number) {
  await lockAdmission(db, a);
  const limits = SENDING_LIMITS[a.environment];
  const [counts] = await db.select({ total: sql<number>`count(*)::int`, key: sql<number>`count(*) filter (where ${emails.actorKeyId} = ${a.keyId})::int` }).from(emails).where(and(scope(emails, a), isNull(emails.reviewId), inArray(emails.status, ['queued', 'attempting'])));
  if (Number(counts!.total) + incoming > limits.pending || Number(counts!.key) + incoming > limits.keyPending) throw new ApiError(429, 'PENDING_EMAIL_LIMIT_EXCEEDED', `This submission exceeds the ${a.environment} outstanding email limit (${limits.pending} per environment, ${limits.keyPending} per key). Wait for dispatch or cancel queued campaigns before retrying.`, undefined, true);
}
function campaignBytes(a: Actor, total: number, snapshot: EmailSnapshot) {
  // Reserve footer/header space in reviews too, where unsubscribe tokens are not issued.
  const next = total + Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + 2048;
  if (next > SENDING_LIMITS[a.environment].expandedCampaignBytes) throw new ApiError(413, 'EXPANDED_CAMPAIGN_TOO_LARGE', `Expanded campaign content exceeds the ${SENDING_LIMITS[a.environment].expandedCampaignBytes / 1024 / 1024} MiB ${a.environment} limit. Reduce the audience or personalized content.`);
  return next;
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
  template: z.object({ name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), data: StoredTemplateData }).strict().describe('Uses native SES stored-template rendering and snapshots its rendered MIME. SES does not automatically escape HTML; callers must escape untrusted HTML-context values. Test keys do not contact SES or render the template.').optional(),
  attachments: AttachmentIds, tracking: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.template ? (v.subject !== undefined || v.html !== undefined || v.text !== undefined) : (!v.subject || (!v.html && !v.text))) ctx.addIssue({ code: 'custom', message: 'Provide subject and html/text, or template, but not both.' });
  if ((Array.isArray(v.to) ? v.to.length : 1) + v.cc.length + v.bcc.length > 50) ctx.addIssue({ code: 'custom', message: 'At most 50 recipients across to/cc/bcc.' });
  if (v.kind === 'marketing' && ((Array.isArray(v.to) ? v.to.length : 1) !== 1 || v.cc.length || v.bcc.length)) ctx.addIssue({ code: 'custom', message: 'Marketing messages require exactly one To recipient and no Cc/Bcc.' });
  if (v.template && (v.attachments.length || v.kind === 'marketing')) ctx.addIssue({ code: 'custom', message: 'Stored templates currently support transactional messages without attachments only.' });
}).openapi('SendEmailInput');
const BatchInput = z.object({ emails: z.array(SendInput).min(1).max(100) }).strict().openapi('SendEmailBatchInput');
const Status = z.enum(['queued', 'attempting', 'accepted', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'delayed', 'suppressed', 'canceled', 'acceptance_unknown', 'simulated']);
const Email = z.object({ id: z.string(), environment: z.enum(['live', 'test']), region: z.string(), campaignId: z.string().nullable(), from: z.string(), fromName: z.string().nullable(), kind: z.enum(['transactional', 'marketing']), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), status: Status, providerId: z.string().nullable(), simulated: z.boolean(), attemptStartedAt: z.string().nullable(), errorCode: z.string().nullable(), scheduledAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('Email');
const Receipt = z.object({ id: z.string(), status: z.literal('queued'), environment: z.enum(['live', 'test']), simulated: z.boolean() }).openapi('EmailQueued');
const BatchReceipt = z.object({ data: z.array(Receipt) }).openapi('EmailBatchQueued');
const Event = z.object({ id: z.string(), emailId: z.string(), type: z.string(), providerId: z.string().nullable(), simulated: z.boolean(), environment: z.enum(['live', 'test']), createdAt: z.string(), data: z.record(z.string(), z.unknown()) }).openapi('EmailEvent');
const EmailContent = z.object({ subject: z.string(), html: z.string().nullable(), text: z.string().nullable(), raw: z.string().nullable(), attachments: z.array(z.string()), render: z.enum(['direct', 'ses', 'simulated']), templateName: z.string().nullable(), simulated: z.boolean() }).openapi('EmailContent');
const AttachmentInfo = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable(), createdAt: z.string(), environment: z.enum(['live', 'test']) }).openapi('Attachment');
const AttachmentInput = z.object({ filename: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/), contentType: z.string().max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default('application/octet-stream'), content: z.string().min(4).max(Math.ceil(MAX_ATTACHMENTS / 3) * 4).describe('Standard padded base64; no data URLs. Maximum decoded bytes: 8 MiB.'), disposition: z.enum(['attachment', 'inline']).default('attachment'), contentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.@-]+$/).optional() }).strict().refine(v => v.disposition !== 'inline' || !!v.contentId, 'Inline attachments require contentId.').openapi('AttachmentUpload');
const AttachmentMetadata = z.object({ filename: AttachmentInput.shape.filename, contentType: z.string().min(1).max(100), disposition: z.enum(['attachment', 'inline']).default('attachment'), contentId: AttachmentInput.shape.contentId }).strict();
const attachmentTypes: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ics: 'text/calendar',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const starts = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value);
function textAttachment(bytes: Uint8Array) {
  try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (value.includes('\0')) throw new Error(); return value; }
  catch { throw new ApiError(422, 'ATTACHMENT_CONTENT_INVALID', 'Text attachments must contain valid UTF-8 without null bytes.'); }
}
function validateAttachment(metadata: z.infer<typeof AttachmentMetadata>, bytes: Uint8Array) {
  const extension = metadata.filename.split('.').pop()?.toLowerCase();
  const expected = extension ? attachmentTypes[extension] : undefined;
  if (!extension || !expected) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', 'Attachments allow PDF, UTF-8 text, CSV, JSON, raster images, ICS, and modern Office documents.');
  const baseType = metadata.contentType.split(';')[0]!.trim().toLowerCase();
  if (baseType !== 'application/octet-stream' && baseType !== expected) throw new ApiError(422, 'ATTACHMENT_CONTENT_TYPE_MISMATCH', `The declared content type does not match .${extension}.`);
  if (metadata.contentType.includes(';') && expected !== 'text/calendar' && !/^text\/(?:plain|csv);\s*charset=utf-8$/i.test(metadata.contentType)) throw new ApiError(422, 'ATTACHMENT_CONTENT_TYPE_INVALID', 'Only UTF-8 text charset and calendar method parameters are supported.');
  if (expected === 'text/calendar' && !/^text\/calendar(?:;\s*(?:method=(?:REQUEST|PUBLISH|CANCEL)|charset=utf-8))*$/i.test(metadata.contentType)) throw new ApiError(422, 'ATTACHMENT_CONTENT_TYPE_INVALID', 'Calendar content type supports UTF-8 and REQUEST, PUBLISH, or CANCEL methods.');
  const image = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension);
  if (metadata.disposition === 'inline' && (!image || !metadata.contentId)) throw new ApiError(422, 'INLINE_ATTACHMENT_INVALID', 'Only PNG, JPEG, GIF, and WebP images with a content ID may be inline.');
  if (metadata.disposition === 'attachment' && metadata.contentId) throw new ApiError(422, 'ATTACHMENT_CONTENT_ID_INVALID', 'Content IDs are only supported for inline images.');
  let valid = true;
  if (extension === 'png') valid = starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  else if (extension === 'jpg' || extension === 'jpeg') valid = starts(bytes, [0xff, 0xd8, 0xff]);
  else if (extension === 'gif') valid = new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF87a' || new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF89a';
  else if (extension === 'webp') valid = new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  else if (extension === 'pdf') valid = new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  else if (extension === 'txt' || extension === 'csv') textAttachment(bytes);
  else if (extension === 'json') { try { JSON.parse(textAttachment(bytes)); } catch { valid = false; } }
  else if (extension === 'ics') { const text = textAttachment(bytes).replaceAll('\r\n', '\n').trim(); valid = text.startsWith('BEGIN:VCALENDAR\n') && text.endsWith('END:VCALENDAR'); }
  else {
    const content = new TextDecoder('latin1').decode(bytes);
    const marker = extension === 'docx' ? 'word/' : extension === 'xlsx' ? 'xl/' : 'ppt/';
    valid = starts(bytes, [0x50, 0x4b]) && content.includes('[Content_Types].xml') && content.includes(marker);
  }
  if (!valid) throw new ApiError(422, 'ATTACHMENT_CONTENT_INVALID', `The file bytes do not match .${extension}.`);
  return { ...metadata, contentType: baseType === 'application/octet-stream' ? expected : metadata.contentType };
}
const Removed = z.object({ id: z.string(), deleted: z.literal(true) }).openapi('DeletedSendingResource');
const DraftAudience = AudienceSpec.partial({ listId: true }).default({});
const BlockHtml = z.string().max(MAX_BODY).describe('Block HTML: h1-h3, p, ul/ol, blockquote, pre>code, hr, img, buttons, columns and styled sections with inline formatting. A constrained email-safe style attribute supports color, typography, spacing, borders, radius and dimensions; arbitrary CSS remains rejected. No wrappers, tables, class or id. Call getContentGuide in MCP or GET /v1/campaign-content-guide for the full vocabulary and examples.');
const CampaignDraftFields = { name: z.string().trim().min(1).max(200), from: z.union([Address, z.literal('')]).default(''), fromName: FromName.optional(), previewText: PreviewText.optional(), replyTo: z.array(Address).max(10).default([]), region: Region, subject: z.union([Subject, z.literal('')]).default(''), attachments: AttachmentIds, tracking: z.boolean().default(true), audience: DraftAudience, defaults: Data };
const CAMPAIGN_INPUT_NOTES = 'Drafts may omit sender, subject, content and audience until review. Content is block HTML (see html); the same form is what the dashboard composer reads and writes, so people and agents edit one document. Simple {{name}} personalization works in text and quoted href/alt attributes; values are HTML-escaped and rendered URLs are validated. Legacy synchronous reviews retain their 16 MiB test/128 MiB live bounds; durable background campaign preparation is bounded separately.';
const CampaignInput = z.object({ ...CampaignDraftFields, html: BlockHtml.optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraftInput');
// Stored drafts predating block HTML remain readable; they are revalidated when saved or reviewed.
const CampaignDraftView = z.object({ ...CampaignDraftFields, html: z.string().optional() }).strict().describe(CAMPAIGN_INPUT_NOTES).openapi('CampaignDraft');
const CampaignCreate = z.object({ ...CampaignInput.shape, region: Region.optional().describe('Defaults to the installation’s persisted default region when omitted.'), tracking: z.boolean().optional(), templateId: z.string().regex(/^tpl_[0-9a-f]{32}$/).optional().describe('Copies the active published revision of this global campaign template into a new independent campaign draft.') }).strict().openapi('CreateCampaignInput');
const CampaignReady = CampaignInput.extend({ from: Address, subject: Subject, audience: AudienceSpec }).refine(v => !!v.html?.trim(), { message: 'Provide html before reviewing.', path: ['html'] });
const CampaignStatus = z.enum(['draft', 'reviewed', 'scheduled', 'sending', 'completed', 'canceled']);
const emptyCounts = () => ({ total: 0, byStatus: Object.fromEntries(Status.options.map(status => [status, 0])) as Record<EmailStatus, number> });
const CampaignCounts = z.object({ total: z.number().int().nonnegative(), byStatus: z.record(Status, z.number().int().nonnegative()) }).describe('Counts of immutable campaign email records grouped by their current status, not cumulative provider events or delivery rates. Drafts with no queued emails have zero counts.');
const Expansion = z.object({ status: z.enum(['pending', 'expanding', 'completed', 'failed', 'canceled']), total: z.number().int().describe('Fixed reviewed recipient count reserved at send or schedule.'), expanded: z.number().int().describe('Recipients materialized as immutable email records.'), canceled: z.number().int().describe('Recipients canceled before materialization. Materialized cancellations remain in counts.byStatus.canceled.'), error: z.object({ code: z.string(), message: z.string() }).nullable() }).openapi('CampaignExpansion');
const Campaign = z.object({ expansion: Expansion.nullable().optional(), id: z.string(), url: z.string().url().describe('Dashboard URL for opening this campaign in its environment. Drafts open in the editor; noneditable campaigns open in review.'), environment: z.enum(['live', 'test']), revision: z.number().int(), draft: CampaignDraftView, sourceTemplateId: z.string().nullable(), sourceTemplateRevision: z.number().int().nullable(), status: CampaignStatus, reviewId: z.string().nullable(), scheduledAt: z.string().nullable(), archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), counts: CampaignCounts }).openapi('Campaign');
const CampaignState = Campaign.pick({ id: true, environment: true, revision: true, updatedAt: true, status: true, reviewId: true, scheduledAt: true, archivedAt: true }).describe('Compact state for draft sync polling. Compare all fields, not only revision: reviews, archival and delivery status can change without a new draft revision. Fetch the full campaign when state changes. No draft content or delivery counts.').openapi('CampaignState');
const CampaignDraftSummary = CampaignDraftView.pick({ name: true, region: true, from: true, fromName: true, subject: true, previewText: true }).extend({ audience: AudienceSpec.pick({ listId: true, segmentId: true }).partial({ listId: true }).default({}) }).strict().openapi('CampaignDraftSummary');
const CampaignSummary = Campaign.omit({ draft: true }).extend({ draft: CampaignDraftSummary }).describe('Campaign list metadata only. Fetch GET /v1/campaigns/{id} for the complete draft before editing, reviewing or sending. Content, defaults, attachments and audience exclusions are intentionally omitted.').openapi('CampaignSummary');
const EmailQuery = PageQuery.extend({ campaignId: z.string().max(120).optional(), status: Status.optional(), region: Region.optional(), kind: z.enum(['transactional', 'marketing']).optional(), search: z.string().trim().min(1).max(200).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'from must precede to.').describe('Newest created emails first, with an opaque cursor bound to the filters and environment. Date range is createdAt >= from and < to. Search is literal, case-insensitive recipient (To/Cc/Bcc), subject or ID text.').openapi('ListEmailsQuery');
const CampaignQuery = PageQuery.extend({ region: Region.optional(), status: CampaignStatus.optional(), archived: z.enum(['true', 'false']).default('false').describe('False lists active campaigns; true lists archived campaigns only.'), search: z.string().trim().min(1).max(200).optional() }).describe('Newest created campaigns first, excluding archived campaigns by default, with an opaque cursor bound to the filters and environment. Search is literal, case-insensitive name, subject or ID text.').openapi('ListCampaignsQuery');
const AudienceCounts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int() }).openapi('CampaignAudienceCounts');
const Review = AudienceCounts.extend({ id: z.string(), campaignId: z.string(), revision: z.number().int(), contentHash: z.string(), createdAt: z.string() }).openapi('CampaignReview');
const Revision = z.object({ revision: z.number().int().positive() }).strict().openapi('CampaignRevisionInput');
const AsyncReview = z.object({ ...Review.shape, status: z.enum(['pending', 'processing', 'ready', 'failed']), processed: z.number().int().nonnegative(), contentHash: z.union([z.string(), z.null()]), error: z.union([z.object({ code: z.string(), message: z.string() }), z.null()]) }).describe('A durable audience snapshot and bounded preparation. Only ready reviews may be sent. Counts are fixed at creation; live consent is checked again at dispatch.').openapi('CampaignReviewPreparation');
const ReviewParams = IdParams.extend({ reviewId: z.string().min(1).max(120) });

const CampaignUpdate = z.object({ revision: z.number().int().positive(), draft: z.object({ ...CampaignInput.shape, region: Region.optional().describe('Keeps the campaign’s current region when omitted.') }).strict() }).strict().openapi('CampaignUpdateInput');
const CampaignArchive = z.object({ archived: z.boolean() }).strict().openapi('CampaignArchiveInput');
const CampaignContentGuide = z.object({ format: z.literal('markdown'), markdown: z.string() }).openapi('CampaignContentGuide');
const CampaignPreview = z.object({ html: z.string().describe('Complete rendered email document; empty when the draft has no content.'), text: z.string() }).openapi('CampaignPreview');
const CampaignPreviewImage = z.object({ data: z.string().describe('Canonical base64 PNG screenshot.'), mimeType: z.literal('image/png') }).openapi('CampaignPreviewImage');
const CampaignSend = z.object({ reviewId: z.string().min(1).optional().describe('Optional completed review. Omit to snapshot and validate the current revision automatically before delivery.'), revision: z.number().int().positive() }).strict().openapi('CampaignSendInput');
const CampaignSchedule = z.object({ ...CampaignSend.shape, scheduledAt: z.string().datetime({ offset: true }) }).strict().openapi('CampaignScheduleInput');
const CampaignQueued = z.object({ id: z.string(), status: z.enum(['scheduled', 'sending']), queued: z.number().int(), scheduledAt: z.string().nullable(), simulated: z.boolean() }).openapi('CampaignQueued');
const CampaignCanceled = z.object({ id: z.string(), status: z.literal('canceled'), canceled: z.number().int(), inFlight: z.number().int() }).openapi('CampaignCanceled');
const TestCampaign = z.object({ to: Address, data: Data }).strict().openapi('CampaignTestInput');
type SendRequest = z.infer<typeof SendInput>;
const now = () => new Date().toISOString();
// Metadata routes must not materialize HTML, raw MIME or template data from the immutable snapshot.
const emailColumns = {
  id: emails.id, environment: emails.environment, region: emails.region, campaignId: emails.campaignId,
  from: emails.from, fromName: sql<string | null>`${emails.snapshot}->>'fromName'`, kind: sql<'transactional' | 'marketing'>`${emails.snapshot}->>'kind'`,
  to: emails.to, cc: emails.cc, bcc: emails.bcc, subject: emails.subject, status: emails.status,
  providerId: emails.providerId, simulated: emails.simulated, attemptStartedAt: emails.attemptStartedAt,
  errorCode: emails.errorCode, scheduledAt: emails.scheduledAt, createdAt: emails.createdAt, updatedAt: emails.updatedAt,
};
function emailView(row: z.input<typeof Email>) { return Email.parse(row); }
// Draft sync polling reads only state columns, without materializing drafts or aggregating email counts.
const campaignStateColumns = {
  id: campaigns.id, environment: campaigns.environment, revision: campaigns.revision, updatedAt: campaigns.updatedAt,
  status: campaigns.status, reviewId: campaigns.reviewId, scheduledAt: campaigns.scheduledAt, archivedAt: campaigns.archivedAt,
};
// Project the bounded list draft in PostgreSQL, before driver JSON parsing or application allocation.
const campaignSummaryColumns = {
  id: campaigns.id, environment: campaigns.environment, revision: campaigns.revision, status: campaigns.status,
  sourceTemplateId: campaigns.sourceTemplateId, sourceTemplateRevision: campaigns.sourceTemplateRevision,
  reviewId: campaigns.reviewId, scheduledAt: campaigns.scheduledAt, archivedAt: campaigns.archivedAt, createdAt: campaigns.createdAt, updatedAt: campaigns.updatedAt,
  draft: sql<z.infer<typeof CampaignDraftSummary>>`jsonb_strip_nulls(jsonb_build_object(
    'name', ${campaigns.draft}->'name', 'region', ${campaigns.draft}->'region', 'from', ${campaigns.draft}->'from',
    'fromName', ${campaigns.draft}->'fromName', 'subject', ${campaigns.draft}->'subject', 'previewText', ${campaigns.draft}->'previewText',
    'audience', jsonb_build_object('listId', ${campaigns.draft}->'audience'->'listId', 'segmentId', ${campaigns.draft}->'audience'->'segmentId')
  ))`,
};
function campaignUrl(runtime: Runtime, row: { id: string; environment: Mode; status: string; draft: { region: string } }) {
  const view = ['draft', 'reviewed'].includes(row.status) ? 'edit' : 'review';
  const url = new URL(`/campaigns/${encodeURIComponent(row.id)}/${view}`, runtime.config.publicUrl);
  url.searchParams.set('environment', row.environment);
  return url.href;
}
async function campaignViews<T extends { id: string; environment: Mode; status: string; draft: { region: string } }>(runtime: Runtime, a: Actor, rows: T[]) {
  if (!rows.length) return [];
  const grouped = await runtime.db.select({ campaignId: emails.campaignId, status: emails.status, count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), inArray(emails.campaignId, rows.map(row => row.id)))).groupBy(emails.campaignId, emails.status);
  const expansions = await runtime.db.select().from(campaignExpansions).where(and(scope(campaignExpansions, a), inArray(campaignExpansions.campaignId, rows.map(row => row.id))));
  return rows.map(row => {
    const counts = emptyCounts();
    for (const item of grouped) if (item.campaignId === row.id) { counts.byStatus[item.status] = Number(item.count); counts.total += Number(item.count); }
    const expansion = expansions.find(item => item.campaignId === row.id);
    return { ...row, url: campaignUrl(runtime, row), counts, ...(expansion ? { expansion: Expansion.parse(expansion) } : {}) };
  });
}
async function pageBinding(a: Actor, resource: string, query: Record<string, unknown>) {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  return (await digest(canonical({ workspaceId: a.workspaceId, environment: a.environment, resource, filters }))).slice(0, 24);
}
function readCursor(value: string | undefined, binding: string): { at: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const tuple = z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(120), z.literal(binding)]).parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: tuple[0], id: tuple[1] };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'Use the returned cursor with the same filters and environment.', 'cursor'); }
}
function nextCursor(rows: { id: string; createdAt: string }[], limit: number, binding: string) {
  const last = rows[limit - 1];
  return rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'), last.id, binding])).toString('base64url') : null;
}
function literalSearch(value: string) { return `%${value.replace(/[\\%_]/g, character => `\\${character}`)}%`; }
const scope = (table: { workspaceId: AnyPgColumn; environment: AnyPgColumn }, a: Pick<Actor, 'workspaceId' | 'environment'>) => and(eq(table.workspaceId, a.workspaceId), eq(table.environment, a.environment));
const mailWhere = (a: Pick<Actor, 'workspaceId' | 'environment'>, emailId: string) => and(scope(emails, a), eq(emails.id, emailId));
const campaignWhere = (a: Actor, campaignId: string) => and(scope(campaigns, a), eq(campaigns.id, campaignId));
function sender(runtime: Runtime, a: Actor, from: string, selectedRegion: string) {
  region(runtime, selectedRegion);
  const domain = from.split('@')[1]!.toLowerCase();
  if (!senderDomainAllowed(a.domains, domain)) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'This API key cannot send from this domain or its parent domain.', 'from');
}
function draftSender(runtime: Runtime, a: Actor, draft: CampaignDraft) {
  region(runtime, draft.region);
  if (draft.from) sender(runtime, a, draft.from, draft.region);
}
function readyCampaign(draft: CampaignDraft) {
  const parsed = CampaignReady.safeParse(draft);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))];
    throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', `Complete these campaign fields before review: ${fields.join(', ')}.`, fields.join(', '));
  }
  return parsed.data;
}
function campaignAudience(draft: CampaignDraft) {
  const parsed = AudienceSpec.safeParse(draft.audience);
  if (!parsed.success) throw new ApiError(422, 'CAMPAIGN_INCOMPLETE', 'Choose an audience list before previewing or reviewing this campaign.', 'audience.listId');
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
async function idempotent<T extends Record<string, unknown>>(c: Ctx, a: Actor, body: unknown, work: (db: DbExecutor) => Promise<T>): Promise<T> {
  const key = c.req.header('Idempotency-Key');
  if (key === undefined) return c.env.db.transaction(work);
  if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
  const requestHash = await digest(canonical(body));
  return c.env.db.transaction(async db => {
    const identity = { workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, path: c.req.path, requestKey: key };
    const inserted = await db.insert(sendingIdempotency).values({ ...identity, requestHash }).onConflictDoNothing().returning();
    const where = and(scope(sendingIdempotency, a), eq(sendingIdempotency.actorKeyId, a.keyId), eq(sendingIdempotency.path, c.req.path), eq(sendingIdempotency.requestKey, key));
    if (!inserted.length) {
      const [previous] = await db.select().from(sendingIdempotency).where(where);
      if (!previous || previous.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.');
      // The unique insert waits for the other transaction; its result commits atomically with the row.
      if (!previous.result) throw new ApiError(500, 'IDEMPOTENCY_RESULT_MISSING', 'The stored idempotency result is unavailable.');
      return previous.result as T;
    }
    const result = await work(db);
    await db.update(sendingIdempotency).set({ result }).where(where);
    return result;
  });
}
async function findEmail(db: DbExecutor, a: Actor, emailId: string) {
  const [row] = await db.select().from(emails).where(mailWhere(a, emailId));
  if (!row) notFound('Email');
  return row;
}
async function findDispatchEmail(db: DbExecutor, a: Actor, emailId: string) {
  const [row] = await db.select({
    ...getTableColumns(emails),
    reviewDraft: campaignReviews.draft,
    reviewRendered: campaignReviews.rendered,
    reviewStatus: campaignReviews.status,
    reviewContentHash: reviewRecipients.contentHash,
    reviewRecipient: reviewRecipients.recipient,
  }).from(emails)
    .leftJoin(campaignReviews, and(scope(campaignReviews, a), eq(campaignReviews.id, emails.reviewId), eq(campaignReviews.campaignId, emails.campaignId)))
    .leftJoin(reviewRecipients, and(eq(reviewRecipients.reviewId, emails.reviewId), eq(reviewRecipients.ordinal, emails.reviewOrdinal)))
    .where(mailWhere(a, emailId));
  if (!row) notFound('Email');
  const { reviewDraft, reviewRendered, reviewStatus, reviewContentHash, reviewRecipient, ...mail } = row!;
  return { mail, review: reviewDraft && reviewRendered && reviewRecipient ? { draft: reviewDraft, rendered: reviewRendered, status: reviewStatus, contentHash: reviewContentHash, recipient: reviewRecipient } : null };
}
async function findCampaign(db: DbExecutor, a: Actor, campaignId: string, lock: boolean | 'share' = false) {
  const query = db.select().from(campaigns).where(campaignWhere(a, campaignId));
  const [row] = await (lock ? query.for(lock === 'share' ? 'share' : 'update') : query);
  if (!row) notFound('Campaign');
  return row;
}
async function attachmentRows(db: DbExecutor, a: Actor, ids: string[], lock = false) {
  if (!ids.length) return [];
  if (new Set(ids).size !== ids.length) throw new ApiError(422, 'DUPLICATE_ATTACHMENT', 'An attachment can appear only once per message.');
  const query = db.select().from(attachments).where(and(scope(attachments, a), inArray(attachments.id, ids))).orderBy(asc(attachments.id));
  const rows = await (lock ? query.for('update') : query);
  if (rows.length !== ids.length) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'One or more attachments were not found in this environment.');
  if (rows.reduce((n, row) => n + row.size, 0) > MAX_ATTACHMENTS) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Combined attachments may not exceed 8 MiB of decoded data.');
  const cid = rows.flatMap(r => r.contentId ? [r.contentId] : []);
  if (new Set(cid).size !== cid.length) throw new ApiError(422, 'DUPLICATE_CONTENT_ID', 'Inline content IDs must be unique.');
  return rows;
}
async function linkAttachments(db: DbExecutor, a: Actor, ids: string[], ownerType: 'email' | 'campaign' | 'review', ownerId: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  // A campaign may reuse metadata already ownership-checked and locked in this same transaction.
  if (!lockedAttachments) await attachmentRows(db, a, ids, true);
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, environment: a.environment, attachmentId, ownerType, ownerId }))).onConflictDoNothing();
}
function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function formattedSender(from: string, fromName?: string, foldMime = false): string {
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
function inlineMessage(snapshot: EmailSnapshot, parts: Attachment[]): Uint8Array {
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
function sizeCheck(snapshot: EmailSnapshot, rows: { size: number }[]) {
  const bytes = new TextEncoder().encode((snapshot.raw ?? '') + (snapshot.html ?? '') + (snapshot.text ?? '') + snapshot.subject).length;
  // Conservatively reserve base64/MIME expansion, line folding and headers. This is an application cap, not SES's 40 MB maximum.
  const encoded = Math.ceil(bytes * 1.4) + rows.reduce((sum, r) => sum + Math.ceil(r.size / 3) * 4 * 1.04 + 2048, 0) + 16384;
  if (encoded > MAX_ENCODED_MESSAGE) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', 'Estimated encoded MIME exceeds the initial 16 MiB message limit.');
}
function marketingFooter(snapshot: EmailSnapshot, url: string) {
  if (snapshot.html) {
    const footer = `<p style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#595959;margin:24px 0 0"><a href="${escaped(url)}" style="color:#595959;text-decoration:underline">Unsubscribe</a></p>`;
    const close = snapshot.html.search(/<\/td>\s*<\/tr>\s*<\/table>\s*<\/td>\s*<\/tr>\s*<\/table>\s*<\/body>/i);
    snapshot.html = close >= 0 ? snapshot.html.slice(0, close) + footer + snapshot.html.slice(close) : snapshot.html + footer;
  }
  snapshot.text = (snapshot.text ?? '') + `\n\nUnsubscribe: ${url}`;
  snapshot.headers = [{ Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
}
async function prepare(runtime: Runtime, db: DbExecutor, a: Actor, request: SendRequest, preview = false, lockedAttachments?: (typeof attachments.$inferSelect)[], sharedValidated = false, htmlValidated = false): Promise<EmailSnapshot> {
  const input = { ...request, region: sharedValidated ? request.region! : await assertRegionEnabled(db, a.workspaceId, request.region) };
  if (!sharedValidated) {
    if (a.environment === 'live') await assertLiveRegionReady(runtime, db, input.region, input.kind);
    sender(runtime, a, input.from, input.region);
  }
  const snapshot: EmailSnapshot = { from: input.from, ...(input.fromName !== undefined ? { fromName: input.fromName } : {}), to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo, region: input.region, kind: input.kind, subject: input.subject ?? '', html: input.html, text: input.text, attachments: input.attachments, tracking: input.tracking ?? input.kind === 'marketing', headers: [] };
  const rows = lockedAttachments ?? await attachmentRows(db, a, input.attachments, true);
  if (!htmlValidated) validateHtmlUrls(snapshot.html);
  if (input.template) {
    // Preserve native SES semantics in both HTML and plaintext; callers own context-specific escaping.
    const templateData = JSON.stringify(input.template.data);
    if (templateData.length > 262144) throw new ApiError(413, 'TEMPLATE_DATA_TOO_LARGE', 'Serialized template data exceeds 262,144 characters.');
    if (a.environment === 'test') {
      snapshot.subject = `[simulated template: ${input.template.name}]`;
      snapshot.template = { ...input.template, source: {}, render: 'simulated' };
    } else {
      const ses = getSes(runtime, input.region);
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
      const headers = normalized.slice(0, split).split(/\r\n(?![ \t])/).filter(h => !/^(?:from|to|cc|bcc|reply-to|return-path|date|message-id):/i.test(h));
      snapshot.raw = [`From: ${formattedSender(snapshot.from, snapshot.fromName, true)}`, `To: ${snapshot.to.join(', ')}`, ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(', ')}`] : []), ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(', ')}`] : []), ...headers].join('\r\n') + normalized.slice(split);
    }
  }
  if (input.kind === 'marketing' && !preview) {
    const url = await unsubscribeUrl(runtime, a.workspaceId, a.environment, snapshot.to[0]!, db);
    marketingFooter(snapshot, url);
  }
  sizeCheck(snapshot, rows);
  return snapshot;
}
async function queueEmail(db: DbExecutor, a: Actor, snapshot: EmailSnapshot, campaignId?: string, availableAt?: string, requestId?: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  const emailId = id('email');
  await db.insert(emails).values({ id: emailId, workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, region: snapshot.region, campaignId: campaignId ?? null, from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, snapshot, simulated: a.environment === 'test', scheduledAt: availableAt ?? null });
  await linkAttachments(db, a, snapshot.attachments, 'email', emailId, lockedAttachments);
  await enqueue(db, { type: 'email.dispatch', workspaceId: a.workspaceId, environment: a.environment, payload: { emailId, version: 0, ...(campaignId ? { campaignId } : {}), ...(requestId ? { requestId } : {}) }, availableAt });
  return { id: emailId, status: 'queued' as const, environment: a.environment, simulated: a.environment === 'test' };
}
async function wake(runtime: Runtime, readyJobs: number) {
  try { await runtime.wake?.(readyJobs); }
  catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Expanded jobs are durable; the scheduler will recover them.' }); }
}
async function saveAttachment(c: Ctx, a: Actor, metadata: z.infer<typeof AttachmentMetadata>, bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_ATTACHMENTS) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments must be nonempty and at most 8 MiB decoded.');
  const input = validateAttachment(metadata, bytes);
  const checksum = await bytesDigest(bytes);
  return idempotent(c, a, { ...input, size: bytes.length, checksum }, async db => {
    await lockAdmission(db, a);
    const [usage] = await db.select({ bytes: sql<string>`coalesce(sum(${attachments.size}), 0)` }).from(attachments).where(scope(attachments, a));
    if (Number(usage!.bytes) + bytes.length > SENDING_LIMITS[a.environment].storedAttachmentBytes) throw new ApiError(413, 'STORED_ATTACHMENT_LIMIT_EXCEEDED', `Stored attachments exceed the ${SENDING_LIMITS[a.environment].storedAttachmentBytes / 1024 / 1024} MiB ${a.environment} limit. Delete unused attachments before uploading more.`);
    const attachmentId = id('attachment'); const storageKey = `${a.workspaceId}/${a.environment}/attachments/${attachmentId}`;
    await c.env.storage.put(storageKey, bytes, input.contentType);
    try {
      const [row] = await db.insert(attachments).values({ id: attachmentId, workspaceId: a.workspaceId, environment: a.environment, ...input, size: bytes.length, contentId: input.contentId ?? null, storageKey, checksum }).returning();
      return AttachmentInfo.parse(row);
    } catch (error) { await c.env.storage.delete(storageKey).catch(() => undefined); throw error; }
  });
}
function editable(row: typeof campaigns.$inferSelect, revision?: number) {
  if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before editing, reviewing or sending it.');
  if (revision !== undefined && row.revision !== revision) throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign has changed; fetch it and review again.');
  if (!['draft', 'reviewed'].includes(row.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'Only drafts and reviewed campaigns may be changed.');
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
    const parsed = SendInput.safeParse({ from: draft.from, fromName: draft.fromName, to: contact.email, replyTo: draft.replyTo, region: draft.region, kind: test ? 'transactional' : 'marketing', subject: interpolate(draft.subject, values, false, templateValidated), html: withPreheader(interpolate(rendered.html, values, true, templateValidated), draft.previewText), text: interpolate(rendered.text, values, false, templateValidated), attachments: draft.attachments, tracking: test ? false : draft.tracking });
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
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/send', operationId: 'sendEmail', tags: ['Emails'], security, request: { body: json(SendInput) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c, a, input, async db => { await checkPending(db, a, 1); return queueEmail(db, a, await prepare(c.env, db, a, input), undefined, undefined, c.get('requestId')); });
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/batch', operationId: 'sendEmailBatch', tags: ['Emails'], security, request: { body: json(BatchInput) }, responses: { 202: response(BatchReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (input.emails.reduce((n, e) => n + (e.html?.length ?? 0) + (e.text?.length ?? 0), 0) > 2 * 1024 * 1024) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', 'Combined batch body content may not exceed 2 MiB.');
    const result = await idempotent(c, a, input, async db => {
      await checkPending(db, a, input.emails.length);
      const snapshots: EmailSnapshot[] = []; let expandedBytes = 0;
      for (const mail of input.emails) {
        const snapshot = await prepare(c.env, db, a, mail);
        expandedBytes += Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
        if (expandedBytes > SENDING_LIMITS[a.environment].expandedCampaignBytes) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', `Expanded batch content exceeds the ${SENDING_LIMITS[a.environment].expandedCampaignBytes / 1024 / 1024} MiB ${a.environment} limit. Submit smaller batches.`);
        snapshots.push(snapshot);
      }
      const data = []; for (const snapshot of snapshots) data.push(await queueEmail(db, a, snapshot, undefined, undefined, c.get('requestId'))); return { data };
    });
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
      search ? sql`(${emails.id} ILIKE ${search} OR ${emails.subject} ILIKE ${search} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(${emails.to} || ${emails.cc} || ${emails.bcc}) AS recipient(address) WHERE recipient.address ILIKE ${search}))` : undefined,
    )).orderBy(desc(emails.createdAt), desc(emails.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(emailView), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}', operationId: 'getEmail', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => {
    const [row] = await c.env.db.select(emailColumns).from(emails).where(mailWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(emailView(row ?? notFound('Email')), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/content', operationId: 'getEmailContent', description: 'Manage keys receive full snapshots. Other readers receive app unsubscribe tokens redacted from subject/HTML/text and raw MIME withheld (null), since MIME encodings can conceal capabilities. Other transactional bearer links are not sanitized; grant content-read access only to trusted integrations.', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(EmailContent), ...errors } }), async c => {
    const a = actor(c); const row = await findEmail(c.env.db, a, c.req.valid('param').id); const s = row.snapshot;
    const manage = a.permissions.includes('manage');
    // App-owned capabilities only, not a general sanitizer for transactional bearer links.
    // Raw MIME can hide tokens inside encodings/folding; only managers receive that opaque content.
    const visible = (value: string | undefined) => value === undefined ? null : manage ? value : redactCapabilityText(value);
    return c.json(EmailContent.parse({ subject: visible(s.subject), html: visible(s.html), text: visible(s.text), raw: manage ? s.raw ?? null : null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated }), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/events', operationId: 'listEmailEvents', tags: ['Emails'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Event)), ...errors } }), async c => {
    const a = actor(c); const emailId = c.req.valid('param').id; await findEmail(c.env.db, a, emailId); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(emailEvents).where(and(scope(emailEvents, a), eq(emailEvents.emailId, emailId), q.cursor ? gt(emailEvents.id, q.cursor) : undefined)).orderBy(asc(emailEvents.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => Event.parse({ ...r, data: a.permissions.includes('manage') ? r.data : redactCapabilityData(r.data) })), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/attachments', operationId: 'uploadAttachment', tags: ['Attachments'], security, request: { body: json(AttachmentInput) }, responses: { 201: response(AttachmentInfo), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (input.content.length > Math.ceil(MAX_ATTACHMENTS / 3) * 4) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments must be at most 8 MiB decoded.');
    // Flat character validation avoids stack exhaustion from repeated regex groups on large uploads.
    if (input.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be standard padded base64.');
    const bytes = Buffer.from(input.content, 'base64');
    if (bytes.toString('base64') !== input.content) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be canonical padded base64.');
    const { content: _content, ...metadata } = input;
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
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}/content', operationId: 'getAttachmentContent', description: 'Returns the private attachment as canonical base64 JSON, scoped like its metadata. At most 8 MiB decoded; never a public object URL or executable inline response.', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo.extend({ content: z.string().max(Math.ceil(MAX_ATTACHMENTS / 3) * 4) }).openapi('AttachmentContent')), ...errors } }), async c => {
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
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns', operationId: 'createCampaign', description: 'Create a campaign; only a name is required. templateId copies an active published global template, including its content and assets, into this environment as an independent draft. Omitted region uses the installation default. Returns a dashboard URL so an agent and user can continue editing together.', tags: ['Campaigns'], security, request: { body: json(CampaignCreate) }, responses: { 201: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    assertBlockContent(input.html);
    const result = await idempotent(c, a, input, async db => {
      const campaignId = id('campaign'); const source = input.templateId ? await instantiateTemplate(c.env, db, a, input.templateId) : null;
      const draft = { name: input.name, from: input.from, ...(input.fromName ?? source?.draft.fromName ? { fromName: input.fromName ?? source?.draft.fromName } : {}), ...(input.previewText ?? source?.draft.previewText ? { previewText: input.previewText ?? source?.draft.previewText } : {}), replyTo: input.replyTo.length ? input.replyTo : source?.draft.replyTo ?? [], region: await assertRegionEnabled(db, a.workspaceId, input.region), subject: input.subject || source?.draft.subject || '', attachments: [...new Set([...(source?.draft.attachments ?? []), ...input.attachments])], tracking: input.tracking ?? source?.draft.tracking ?? true, audience: input.audience, defaults: { ...(source?.draft.defaults ?? {}), ...input.defaults }, ...(input.html ?? source?.draft.html ? { html: input.html ?? source?.draft.html } : {}) };
      draftSender(c.env, a, draft);
      await linkAttachments(db, a, draft.attachments, 'campaign', campaignId);
      const [row] = await db.insert(campaigns).values({ id: campaignId, workspaceId: a.workspaceId, environment: a.environment, draft, sourceTemplateId: source?.templateId ?? null, sourceTemplateRevision: source?.templateRevision ?? null }).returning();
      return { ...row!, counts: emptyCounts() };
    });
    return c.json(Campaign.parse({ ...result, archivedAt: result.archivedAt ?? null, url: campaignUrl(c.env, result) }), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns', operationId: 'listCampaigns', description: 'Returns bounded campaign metadata summaries. Fetch an individual campaign for its full editable draft; list drafts omit bodies, defaults, attachments and audience exclusions.', tags: ['Campaigns'], security, request: { query: CampaignQuery }, responses: { 200: response(page(CampaignSummary)), ...errors } }), async c => {
    const a = actor(c), q = c.req.valid('query'), binding = await pageBinding(a, 'campaigns', q), cursor = readCursor(q.cursor, binding);
    if (q.region) region(c.env, q.region);
    const search = q.search ? literalSearch(q.search) : null;
    const rows = await timed(c, 'campaign-list-db', () => c.env.db.select(campaignSummaryColumns).from(campaigns).where(and(scope(campaigns, a),
      q.archived === 'true' ? isNotNull(campaigns.archivedAt) : isNull(campaigns.archivedAt),
      cursor ? sql`(${campaigns.createdAt}, ${campaigns.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      q.region ? sql`${campaigns.draft}->>'region' = ${q.region}` : undefined, q.status ? eq(campaigns.status, q.status) : undefined,
      search ? sql`(${campaigns.id} ILIKE ${search} OR ${campaigns.draft}->>'name' ILIKE ${search} OR ${campaigns.draft}->>'subject' ILIKE ${search})` : undefined,
    )).orderBy(desc(campaigns.createdAt), desc(campaigns.id)).limit(q.limit + 1));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, rows.slice(0, q.limit)));
    return c.json({ data: views.map(row => CampaignSummary.parse(row)), nextCursor: nextCursor(rows, q.limit, binding) }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}', operationId: 'getCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c), row = await timed(c, 'campaign-db', () => findCampaign(c.env.db, a, c.req.valid('param').id));
    const views = await timed(c, 'campaign-counts-db', () => campaignViews(c.env, a, [row]));
    return c.json(Campaign.parse(views[0]!), 200);
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
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/preview-image', operationId: 'renderCampaignPreviewImage', description: 'Renders the saved campaign draft as a full-page, 720 px wide PNG for visual review. Inline CID images are embedded; remote HTTPS images are loaded by the isolated renderer.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignPreviewImage), ...errors } }), async c => {
    const a = actor(c, 'send'), row = await findCampaign(c.env.db, a, c.req.valid('param').id);
    if (!c.env.renderHtmlImage) throw new ApiError(503, 'PREVIEW_RENDERING_UNAVAILABLE', 'Visual campaign preview rendering is not configured.', undefined, true);
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
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/state', operationId: 'getCampaignState', description: 'Compact authenticated state for draft sync polling; fetch the full campaign with getCampaign when state changes. Compare all returned fields, not only revision: review, archive and status changes need not increment the draft revision. Omits draft content and delivery counts.', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignState), ...errors } }), async c => {
    const [row] = await c.env.db.select(campaignStateColumns).from(campaigns).where(campaignWhere(actor(c), c.req.valid('param').id)).limit(1);
    return c.json(CampaignState.parse(row ?? notFound('Campaign')), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}', operationId: 'updateCampaign', description: 'Replace the whole draft at the current revision. Read the campaign first: html is block HTML that people may have edited in the dashboard composer, so send the complete updated html rather than a fragment. Rejected content names the unsupported tag or attribute.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignUpdate) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    assertBlockContent(input.draft.html);
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      const selectedRegion = await assertRegionEnabled(db, a.workspaceId, input.draft.region ?? current.draft.region);
      draftSender(c.env, a, { ...input.draft, region: selectedRegion });
      draftSender(c.env, a, current.draft); editable(current, input.revision);
      await attachmentRows(db, a, input.draft.attachments, true);
      await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId)));
      await linkAttachments(db, a, input.draft.attachments, 'campaign', campaignId);
      const draft = { ...input.draft, region: selectedRegion };
      const [updated] = await db.update(campaigns).set({ draft, revision: current.revision + 1, status: 'draft', reviewId: null, preparingReviewId: null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning();
      return updated;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row!]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}/archive', operationId: 'setCampaignArchived', description: 'Archive a campaign to hide it from default lists, or restore it. Preserves its content, revision, delivery status and history. Scheduled or sending campaigns must finish or be canceled before archiving. Archived campaigns cannot be edited, reviewed, tested or sent until restored.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignArchive) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'), campaignId = c.req.valid('param').id, input = c.req.valid('json');
    const row = await c.env.db.transaction(async db => {
      const current = await findCampaign(db, a, campaignId, true);
      draftSender(c.env, a, current.draft);
      if (input.archived && ['scheduled', 'sending'].includes(current.status)) throw new ApiError(409, 'CAMPAIGN_ACTIVE', 'Cancel or finish sending this campaign before archiving it.');
      if (Boolean(current.archivedAt) === input.archived) return current;
      const [updated] = await db.update(campaigns).set({ archivedAt: input.archived ? now() : null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning();
      return updated!;
    });
    return c.json(Campaign.parse((await campaignViews(c.env, a, [row]))[0]!), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/campaigns/{id}', operationId: 'deleteCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, current.draft); editable(current); await db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews r WHERE l.owner_type = 'review' AND l.owner_id = r.id AND l.workspace_id = r.workspace_id AND l.environment = r.environment AND r.workspace_id = ${a.workspaceId} AND r.environment = ${a.environment} AND r.campaign_id = ${campaignId}`); await db.delete(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.campaignId, campaignId))); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await db.delete(campaigns).where(campaignWhere(a, campaignId)); });
    return c.json({ id: campaignId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/audience-preview', operationId: 'previewCampaignAudience', tags: ['Campaigns'], security, responses: { 200: response(AudienceCounts), ...errors }, request: { params: IdParams } }), async c => {
    const a = actor(c); const row = await findCampaign(c.env.db, a, c.req.valid('param').id); const result = await getAudience(c.env, a, campaignAudience(row.draft), 1000); return c.json(AudienceCounts.parse(result), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/test', operationId: 'testCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(TestCampaign) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => { const row = await findCampaign(db, a, campaignId, true); if (row.archivedAt) throw new ApiError(409, 'CAMPAIGN_ARCHIVED', 'Restore this campaign before sending a test.'); await checkPending(db, a, 1); const snapshot = await campaignMessage(c.env, db, a, row.draft, { id: 'test-recipient', email: input.to, properties: input.data }, true); return queueEmail(db, a, snapshot, undefined, undefined, c.get('requestId')); });
    return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/review', operationId: 'reviewCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(Revision) }, responses: { 200: response(Review), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => {
      const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision);
      const draft = readyCampaign(row.draft); sender(c.env, a, draft.from, draft.region);
      const audience = await getAudience(c.env, a, draft.audience, 1000, db);
      if (!audience.contacts.length) throw new ApiError(422, 'EMPTY_AUDIENCE', 'This campaign has no eligible subscribed recipients.');
      const lockedAttachments = await attachmentRows(db, a, row.draft.attachments, true);
      let expandedBytes = 0;
      for (const contact of audience.contacts) expandedBytes = campaignBytes(a, expandedBytes, await campaignMessage(c.env, db, a, row.draft, contact, false, true, lockedAttachments));
      const reviewId = id('review'); const contentHash = await digest(canonical({ draft: row.draft, recipients: audience.contacts }));
      const [review] = await db.insert(campaignReviews).values({ id: reviewId, workspaceId: a.workspaceId, environment: a.environment, campaignId, revision: row.revision, draft: row.draft, recipients: audience.contacts, matched: audience.matched, eligible: audience.eligible, suppressed: audience.suppressed, unsubscribed: audience.unsubscribed, contentHash }).returning();
      await db.update(campaigns).set({ status: 'reviewed', reviewId, preparingReviewId: null, updatedAt: now() }).where(campaignWhere(a, campaignId)); return Review.parse(review);
    }); return c.json(Review.parse(result), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/reviews', operationId: 'startCampaignReview', description: 'Opt in to durable preparation for up to 1,000,000 matching contacts. Captures one fixed audience snapshot, then validates every message in bounded jobs. Poll getCampaignReview until ready before asking for send confirmation. The existing /review endpoint remains synchronous.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(Revision) }, responses: { 202: response(AsyncReview), ...errors } }), async c => {
    const a = actor(c, 'send'), input = c.req.valid('json'), campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => {
      const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision);
      const draft = readyCampaign(row.draft); sender(c.env, a, draft.from, draft.region);
      if (row.preparingReviewId) {
        const [active] = await db.select().from(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.id, row.preparingReviewId)));
        if (active && active.revision === row.revision && ['pending', 'processing'].includes(active.status)) return asyncReviewView(active);
      }
      await assertRegionEnabled(db, a.workspaceId, draft.region);
      if (a.environment === 'live') await assertLiveRegionReady(c.env, db, draft.region, 'marketing');
      const lockedAttachments = await attachmentRows(db, a, draft.attachments, true);
      const rendered = renderCampaignContent(c.env, draft);
      const reviewId = id('review');
      const contentHash = await digest(canonical({ version: 2, draft: row.draft, rendered }));
      await db.insert(campaignReviews).values({ id: reviewId, workspaceId: a.workspaceId, environment: a.environment, campaignId, revision: row.revision, draft: row.draft, recipients: [], matched: 0, eligible: 0, suppressed: 0, unsubscribed: 0, contentHash, storageVersion: 2, status: 'pending', actorKeyId: a.keyId, rendered });
      const propertyKeys = [...new Set([draft.subject, rendered.html ?? '', rendered.text ?? ''].flatMap(value => [...value.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)].map(match => match[1]!)))];
      const counts = await snapshotCampaignAudience(db, a, draft.audience, reviewId, propertyKeys);
      const [review] = await db.update(campaignReviews).set(counts).where(eq(campaignReviews.id, reviewId)).returning();
      await linkAttachments(db, a, draft.attachments, 'review', reviewId, lockedAttachments);
      await db.update(campaigns).set({ status: 'draft', reviewId: null, preparingReviewId: reviewId, updatedAt: now() }).where(campaignWhere(a, campaignId));
      await enqueue(db, { type: 'campaign.prepare', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId, reviewId, cursor: 0 } });
      return asyncReviewView(review!);
    });
    return c.json(AsyncReview.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}/reviews/{reviewId}', operationId: 'getCampaignReview', description: 'Read fixed audience counts and durable preparation progress. A ready review is usable only while it remains the campaign’s current review and revision.', tags: ['Campaigns'], security, request: { params: ReviewParams }, responses: { 200: response(AsyncReview), ...errors } }), async c => {
    const a = actor(c), params = c.req.valid('param');
    await findCampaign(c.env.db, a, params.id);
    const [review] = await c.env.db.select().from(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.id, params.reviewId), eq(campaignReviews.campaignId, params.id)));
    if (!review) notFound('Campaign review');
    return c.json(asyncReviewView(review), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/send', operationId: 'sendCampaign', description: 'Accept the current revision for durable background delivery. Omit reviewId to snapshot and validate the complete audience automatically before any provider attempt; supply an existing completed reviewId to reuse it. The 202 count is accepted recipient intents, not SES acceptance or delivery.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignSend) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const result = await idempotent(c, a, input, db => launchCampaign(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/schedule', operationId: 'scheduleCampaign', description: 'Accept the current revision for durable scheduled delivery. Omit reviewId to snapshot and validate automatically; no recipient is materialized or sent before scheduledAt. The 202 count is accepted recipient intents.', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignSchedule) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c, a, input, db => launchCampaign(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/cancel', operationId: 'cancelCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignCanceled), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, {}, async db => { const row = await findCampaign(db, a, campaignId, true); draftSender(c.env, a, row.draft); if (row.status === 'completed') throw new ApiError(409, 'CAMPAIGN_ALREADY_DISPATCHED', 'This campaign has already finished dispatching.'); return cancelCampaignWork(db, a, row); });
    return c.json(CampaignCanceled.parse(result), 200);
  });
}

function asyncReviewView(review: typeof campaignReviews.$inferSelect) {
  return AsyncReview.parse({ ...review, processed: review.storageVersion === 1 ? review.eligible : review.processed, contentHash: review.status === 'ready' ? review.contentHash : null, error: review.error ?? null });
}
async function checkCampaignCapacity(db: DbExecutor, a: Actor, incoming: number) {
  await lockAdmission(db, a);
  // Unexpanded intents plus active email rows, each counted exactly once. The reservation survives a failed expansion.
  // Direct and legacy mail retain their existing, separate small pending-email admission limits.
  const result = await db.execute<{ total: string; key: string }>(sql`
    WITH outstanding AS (
      SELECT x.actor_key_id, CASE WHEN x.status IN ('canceled','failed') THEN 0 ELSE x.total - x.expanded END
        + (SELECT count(*) FROM sending_emails e WHERE e.review_id = x.review_id AND e.status IN ('queued','attempting')) AS n
      FROM sending_campaign_expansions x WHERE x.workspace_id = ${a.workspaceId} AND x.environment = ${a.environment}
    ) SELECT coalesce(sum(n), 0) AS total, coalesce(sum(n) FILTER (WHERE actor_key_id = ${a.keyId}), 0) AS key FROM outstanding`);
  const row = result.rows[0]!;
  if (Number(row.total) + incoming > 2000000 || Number(row.key) + incoming > 1000000) throw new ApiError(429, 'CAMPAIGN_PENDING_LIMIT_EXCEEDED', 'Campaigns may reserve 1,000,000 outstanding recipients per sender key and 2,000,000 per environment. Wait for dispatch or cancel an active campaign.', undefined, true);
}
async function cancelCampaignWork(db: DbExecutor, a: Actor, row: typeof campaigns.$inferSelect, errorCode?: string) {
  const [expansion] = await db.select().from(campaignExpansions).where(and(scope(campaignExpansions, a), eq(campaignExpansions.campaignId, row.id))).for('update');
  const unexpanded = expansion && expansion.status !== 'canceled' ? expansion.total - expansion.expanded : 0;
  if (expansion) await db.update(campaignExpansions).set({ status: 'canceled', canceled: expansion.canceled + unexpanded, updatedAt: now(), ...(errorCode ? { error: { code: errorCode, message: 'The sending origin is no longer authorized.' } } : {}) }).where(eq(campaignExpansions.campaignId, row.id));
  if (expansion?.jobId) await db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: 'CAMPAIGN_CANCELED' }).where(and(eq(jobs.id, expansion.jobId), eq(jobs.status, 'pending')));
  const changed = await db.execute<{ count: number }>(sql`WITH canceled AS (
    UPDATE sending_emails SET status = 'canceled', updated_at = now(), error_code = coalesce(${errorCode ?? null}::text, error_code)
    WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND campaign_id = ${row.id} AND status = 'queued' RETURNING 1
  ) SELECT count(*)::int AS count FROM canceled`);
  const [inFlight] = await db.select({ count: sql<number>`count(*)::int` }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, row.id), inArray(emails.status, ['attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown'])));
  if (row.preparingReviewId) await db.update(campaignReviews).set({ status: 'failed', error: { code: 'CAMPAIGN_CANCELED', message: 'The campaign was canceled during preparation.' } }).where(and(eq(campaignReviews.id, row.preparingReviewId), inArray(campaignReviews.status, ['pending', 'processing'])));
  await db.update(campaigns).set({ status: 'canceled', preparingReviewId: null, updatedAt: now() }).where(campaignWhere(a, row.id));
  return { id: row.id, status: 'canceled' as const, canceled: changed.rows[0]!.count + unexpanded, inFlight: inFlight!.count };
}
async function recipientChunk(db: DbExecutor, reviewId: string, cursor: number, limit = CAMPAIGN_CHUNK_ROWS) {
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
  return { code, message: `Campaign work could not finish (${code}). Correct the cause and prepare a new review, or cancel the campaign.` };
}
async function launchCampaign(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, input: { reviewId?: string; revision: number; scheduledAt?: string }, requestId?: string) {
  if (input.scheduledAt && (Date.parse(input.scheduledAt) <= Date.now() || Date.parse(input.scheduledAt) > Date.now() + 365 * 86400000)) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.');
  const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision);
  await db.delete(campaignExpansions).where(and(scope(campaignExpansions, a), eq(campaignExpansions.campaignId, campaignId), eq(campaignExpansions.status, 'failed')));
  // Previewing must not silently opt normal send/schedule into the legacy path.
  // Only clients explicitly supplying reviewId request that snapshot contract.
  let reviewId = input.reviewId;
  if (!reviewId) {
    const draft = readyCampaign(row.draft); sender(runtime, a, draft.from, draft.region);
    await assertRegionEnabled(db, a.workspaceId, draft.region);
    if (a.environment === 'live') await assertLiveRegionReady(runtime, db, draft.region, 'marketing');
    let active = row.preparingReviewId ? (await db.select().from(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.id, row.preparingReviewId), eq(campaignReviews.campaignId, campaignId), eq(campaignReviews.revision, row.revision))))[0] : undefined;
    let captured = false;
    if (!active || !['pending', 'processing'].includes(active.status)) {
      const rendered = renderCampaignContent(runtime, draft);
      reviewId = id('review');
      const contentHash = await digest(canonical({ version: 2, draft: row.draft, rendered }));
      await db.insert(campaignReviews).values({ id: reviewId, workspaceId: a.workspaceId, environment: a.environment, campaignId, revision: row.revision, draft: row.draft, recipients: [], matched: 0, eligible: 0, suppressed: 0, unsubscribed: 0, contentHash, storageVersion: 2, status: 'pending', actorKeyId: a.keyId, rendered });
      const propertyKeys = [...new Set([draft.subject, rendered.html ?? '', rendered.text ?? ''].flatMap(value => [...value.matchAll(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g)].map(match => match[1]!)))];
      const counts = await snapshotCampaignAudience(db, a, draft.audience, reviewId, propertyKeys);
      [active] = await db.update(campaignReviews).set(counts).where(eq(campaignReviews.id, reviewId)).returning();
      captured = true;
    } else reviewId = active.id;
    await checkCampaignCapacity(db, a, active!.eligible);
    if (captured) {
      const lockedAttachments = await attachmentRows(db, a, draft.attachments, true);
      await linkAttachments(db, a, draft.attachments, 'review', reviewId, lockedAttachments);
      await enqueue(db, { type: 'campaign.prepare', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId, reviewId, cursor: 0 } });
    }
    await db.insert(campaignExpansions).values({ campaignId, reviewId, workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, total: active!.eligible, requestId });
    const status = input.scheduledAt ? 'scheduled' as const : 'sending' as const;
    await db.update(campaigns).set({ status, reviewId, preparingReviewId: active!.status === 'ready' ? null : reviewId, scheduledAt: input.scheduledAt ?? null, updatedAt: now() }).where(campaignWhere(a, campaignId));
    if (active!.status === 'ready') {
      const jobId = await enqueue(db, { type: 'campaign.expand', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId, cursor: 0, ...(requestId ? { requestId } : {}) } });
      await db.update(campaignExpansions).set({ jobId }).where(eq(campaignExpansions.campaignId, campaignId));
    }
    return { id: campaignId, status, queued: active!.eligible, scheduledAt: input.scheduledAt ?? null, simulated: a.environment === 'test' };
  }
  if (row.reviewId !== reviewId || row.status !== 'reviewed') throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'Review the current campaign revision before sending.');
  const [review] = await db.select().from(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.id, reviewId), eq(campaignReviews.campaignId, campaignId), eq(campaignReviews.revision, row.revision)));
  if (!review) throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'The selected review is no longer current.');
  if (review.storageVersion === 2) {
    if (review.status !== 'ready' || review.processed !== review.eligible) throw new ApiError(409, 'CAMPAIGN_REVIEW_NOT_READY', 'Wait for every reviewed recipient to finish preparation.');
    sender(runtime, a, review.draft.from, review.draft.region);
    await assertRegionEnabled(db, a.workspaceId, review.draft.region);
    if (a.environment === 'live') await assertLiveRegionReady(runtime, db, review.draft.region, 'marketing');
    await checkCampaignCapacity(db, a, review.eligible);
    await attachmentRows(db, a, review.draft.attachments, true);
    await db.insert(campaignExpansions).values({ campaignId, reviewId: review.id, workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, total: review.eligible, requestId });
    const status = input.scheduledAt ? 'scheduled' as const : 'sending' as const;
    await db.update(campaigns).set({ status, scheduledAt: input.scheduledAt ?? null, updatedAt: now() }).where(campaignWhere(a, campaignId));
    const jobId = await enqueue(db, { type: 'campaign.expand', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId, cursor: 0, ...(requestId ? { requestId } : {}) } });
    await db.update(campaignExpansions).set({ jobId }).where(eq(campaignExpansions.campaignId, campaignId));
    return { id: campaignId, status, queued: review.eligible, scheduledAt: input.scheduledAt ?? null, simulated: a.environment === 'test' };
  }
  if (review.contentHash !== await digest(canonical({ draft: review.draft, recipients: review.recipients }))) throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'The reviewed content or recipients changed; review the campaign again.');
  sender(runtime, a, review.draft.from, review.draft.region);
  await checkPending(db, a, review.recipients.length);
  const lockedAttachments = await attachmentRows(db, a, review.draft.attachments, true);
  const snapshots: EmailSnapshot[] = []; let expandedBytes = 0;
  for (const contact of review.recipients) {
    const snapshot = await campaignMessage(runtime, db, a, review.draft, contact, false, false, lockedAttachments);
    expandedBytes = campaignBytes(a, expandedBytes, snapshot); snapshots.push(snapshot);
  }
  for (const snapshot of snapshots) await queueEmail(db, a, snapshot, campaignId, input.scheduledAt, requestId, lockedAttachments);
  const status = input.scheduledAt ? 'scheduled' as const : 'sending' as const;
  await db.update(campaigns).set({ status, scheduledAt: input.scheduledAt ?? null, updatedAt: now() }).where(campaignWhere(a, campaignId));
  return { id: campaignId, status, queued: review.recipients.length, scheduledAt: input.scheduledAt ?? null, simulated: a.environment === 'test' };
}
async function bytesDigest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join(''); }
// Reuse fully verified bytes across invocations sharing the same bucket binding.
// Pending reads remain local to each Storage wrapper/invocation: Workers cannot
// await I/O owned by a different request. Both paths retain bounded byte storage.
const attachmentCaches = new WeakMap<object, { bytes: number; entries: Map<string, Uint8Array> }>();
const attachmentLoads = new WeakMap<Storage, Map<string, Promise<Uint8Array>>>();
async function verifiedAttachment(runtime: Runtime, row: typeof attachments.$inferSelect) {
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

const statusForEvent: Record<string, EmailStatus> = { send: 'sent', delivery: 'delivered', bounce: 'bounced', complaint: 'complained', reject: 'rejected', rendering_failure: 'rendering_failed', delivery_delay: 'delayed', accepted: 'accepted', suppressed: 'suppressed', acceptance_unknown: 'acceptance_unknown', simulated: 'simulated' };
const rank: Record<EmailStatus, number> = { queued: 0, attempting: 1, acceptance_unknown: 2, accepted: 3, sent: 4, delayed: 4, delivered: 5, bounced: 6, complained: 7, rejected: 6, rendering_failed: 6, suppressed: 6, canceled: 6, simulated: 6 };
export async function recordEmailEvent(runtime: Runtime, input: { workspaceId: string; environment: Mode; emailId: string; type: string; providerId?: string; data?: Record<string, unknown>; externalId?: string; createdAt?: string }) {
  const next = statusForEvent[input.type];
  const publicType = ({ send: 'email.sent', delivery: 'email.delivered', bounce: 'email.bounced', complaint: 'email.complained', reject: 'email.rejected', rendering_failure: 'email.rendering_failed', delivery_delay: 'email.delivery_delayed', open: 'email.opened', click: 'email.clicked' } as Record<string, string>)[input.type];
  // One transaction inside PostgreSQL instead of BEGIN/read/insert/update/enqueue/COMMIT
  // over the network. The locked row determines monotonic status; only a newly
  // inserted event may change it or publish a callback.
  const result = await runtime.db.execute<typeof emailEvents.$inferSelect>(sql`WITH mail AS MATERIALIZED (
    SELECT id, status, region FROM sending_emails WHERE workspace_id = ${input.workspaceId}
      AND environment = ${input.environment} AND id = ${input.emailId} FOR UPDATE
  ), inserted AS (
    INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, provider_id, external_id, data, simulated, created_at)
    SELECT ${id('event')}, ${input.workspaceId}, ${input.environment}, mail.id, ${input.type}, ${input.providerId ?? null},
      ${input.externalId ?? null}, ${JSON.stringify(input.data ?? {})}::jsonb, ${input.environment === 'test'}, ${input.createdAt ?? now()}::timestamptz
    FROM mail ON CONFLICT DO NOTHING RETURNING *
  ), updated AS (
    UPDATE sending_emails e SET status = ${next ?? null}, provider_id = coalesce(${input.providerId || null}::text, e.provider_id), updated_at = clock_timestamp()
    FROM mail, inserted WHERE e.id = mail.id AND e.workspace_id = ${input.workspaceId} AND e.environment = ${input.environment}
      AND ${next ?? null}::text IS NOT NULL AND ${next ? rank[next] : -1} >= (${JSON.stringify(rank)}::jsonb ->> mail.status)::int
  ), published AS (
    INSERT INTO jobs(id, workspace_id, environment, type, payload)
    SELECT ${id('job')}, ${input.workspaceId}, ${input.environment}, 'operation.publish', jsonb_build_object('event', jsonb_build_object(
      'id', inserted.id, 'workspaceId', inserted.workspace_id, 'environment', inserted.environment,
      'type', ${publicType ?? null}::text, 'region', mail.region, 'createdAt', inserted.created_at,
      'data', ${JSON.stringify({ ...(input.data ?? {}), emailId: input.emailId, simulated: input.environment === 'test', ...(input.providerId ? { providerId: input.providerId } : {}) })}::jsonb))
    FROM inserted, mail WHERE ${publicType ?? null}::text IS NOT NULL
  ) SELECT id, workspace_id AS "workspaceId", environment, email_id AS "emailId", type,
    provider_id AS "providerId", external_id AS "externalId", data, simulated, created_at::text AS "createdAt" FROM inserted`);
  return result.rows[0] ?? null;
}
async function finishCampaign(runtime: Runtime, a: Actor, campaignId: string | null) {
  if (!campaignId) return;
  await runtime.db.transaction(async db => {
    const row = await findCampaign(db, a, campaignId, true);
    if (!['scheduled', 'sending'].includes(row.status)) return;
    const [expansion] = await db.select({ status: campaignExpansions.status }).from(campaignExpansions).where(eq(campaignExpansions.campaignId, campaignId));
    // Normalized campaigns use one durable finalizer instead of one completion
    // transaction per recipient. Legacy reviews retain this compatibility path.
    if (expansion) return;
    const pending = await db.select({ id: emails.id }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, campaignId), inArray(emails.status, ['queued', 'attempting']))).limit(1);
    if (!pending.length) await db.update(campaigns).set({ status: 'completed', updatedAt: now() }).where(campaignWhere(a, campaignId));
  });
}
async function finishEmailCampaign(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect) {
  if (!mail.reviewId) await finishCampaign(runtime, a, mail.campaignId);
}
const liveReadiness = new WeakMap<Runtime, Map<string, Promise<void>>>();
async function assertDispatchRegionReady(runtime: Runtime, region: string, kind: 'transactional' | 'marketing') {
  let cache = liveReadiness.get(runtime);
  if (!cache) { cache = new Map(); liveReadiness.set(runtime, cache); }
  const key = `${region}:${kind}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = assertLiveRegionReady(runtime, runtime.db, region, kind, true);
    cache.set(key, pending);
  }
  try { await pending; }
  catch (error) { if (cache.get(key) === pending) cache.delete(key); throw error; }
}
async function reserveQuota(runtime: Runtime, a: Actor, selectedRegion: string, recipients: number, ses: SESv2Client): Promise<{ deferUntil?: string; waitUntil?: number }> {
  const where = and(scope(regionalLimits, a), eq(regionalLimits.region, selectedRegion));
  // The normal path is one atomic statement: no application-held permit lock
  // across network round trips. Database time coordinates all Workers/replicas.
  const reserve = () => runtime.db.execute<{ wait_until: string | number }>(sql`
    UPDATE sending_region_limits SET reserved = reserved + ${recipients},
      next_allowed_at = greatest(clock_timestamp(), next_allowed_at) + ceil(1000 * ${recipients} / max_send_rate) * interval '1 millisecond'
    WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND region = ${selectedRegion}
      AND checked_at > clock_timestamp() - interval '60 seconds' AND max_send_rate > 0
      AND (max_24_hour_send < 0 OR sent_last_24_hours + reserved + ${recipients} <= max_24_hour_send)
      AND (next_allowed_at IS NULL OR next_allowed_at <= clock_timestamp() + interval '1 second')
    RETURNING extract(epoch FROM next_allowed_at) * 1000 - ceil(1000 * ${recipients} / max_send_rate) AS wait_until`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await reserve();
    if (reserved.rows[0]) return { waitUntil: Number(reserved.rows[0].wait_until) };
    const [gate] = await runtime.db.select().from(regionalLimits).where(where);
    if (gate?.checkedAt && Date.parse(gate.checkedAt) > Date.now() - 60000) {
      if (gate.max24HourSend >= 0 && gate.sentLast24Hours + gate.reserved + recipients > gate.max24HourSend) return { deferUntil: new Date(Date.now() + 60000).toISOString() };
      return { deferUntil: new Date(Math.max(Date.now() + 1000, gate.nextAllowedAt ? Date.parse(gate.nextAllowedAt) - 1000 : 0)).toISOString() };
    }
    if (attempt) break;
    // Refresh the control-plane quota without holding a database transaction.
    const account = await ses.send(new GetAccountCommand({})), quota = account.SendQuota;
    if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.MaxSendRate <= 0 || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
    // Concurrent refreshes must not reset reservations made after the first one.
    // Keep next_allowed_at so refreshing never discards already allocated slots.
    await runtime.db.execute(sql`INSERT INTO sending_region_limits
      (workspace_id, environment, region, max_send_rate, max_24_hour_send, sent_last_24_hours, reserved, checked_at)
      VALUES (${a.workspaceId}, ${a.environment}, ${selectedRegion}, ${quota.MaxSendRate}, ${quota.Max24HourSend}, ${quota.SentLast24Hours}, 0, clock_timestamp())
      ON CONFLICT (workspace_id, environment, region) DO UPDATE SET
        max_send_rate = excluded.max_send_rate, max_24_hour_send = excluded.max_24_hour_send,
        sent_last_24_hours = excluded.sent_last_24_hours, reserved = 0, checked_at = excluded.checked_at
      WHERE sending_region_limits.checked_at IS NULL OR sending_region_limits.checked_at <= clock_timestamp() - interval '60 seconds'`);
  }
  return { deferUntil: new Date(Date.now() + 1000).toISOString() };
}
async function deferDispatch(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, payload: Record<string, unknown>, availableAt: string, attempted = false) {
  await runtime.db.transaction(async db => {
    if (mail.campaignId) {
      const campaign = await findCampaign(db, a, mail.campaignId, 'share');
      if (campaign.status === 'canceled') {
        // A definitive throttle after cancellation must not resurrect an in-flight message as queued.
        await db.update(emails).set({ status: 'canceled', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, attempted ? 'attempting' : 'queued'), eq(emails.dispatchVersion, mail.dispatchVersion)));
        return;
      }
    }
    const changed = await db.update(emails).set({ status: 'queued', dispatchVersion: mail.dispatchVersion + 1, ...(attempted ? { attemptStartedAt: null, errorCode: 'SES_THROTTLED' } : {}), updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, attempted ? 'attempting' : 'queued'), eq(emails.dispatchVersion, mail.dispatchVersion))).returning();
    if (changed.length) await enqueue(db, { type: 'email.dispatch', workspaceId: a.workspaceId, environment: a.environment, payload: { ...payload, version: mail.dispatchVersion + 1 }, availableAt });
  });
}
async function originAllowed(runtime: Runtime, db: DbExecutor, mail: { workspaceId: string; environment: Mode; actorKeyId: string; snapshot: Pick<EmailSnapshot, 'from'> }) {
  // Session-origin jobs retain the Google principal, not a browser session or bootstrap credential.
  // Re-check its current allowlist approval under the same transaction lock as the attempt claim.
  if (mail.actorKeyId.startsWith('user_')) return mail.workspaceId === runtime.config.workspaceId && (mail.environment === 'live' || mail.environment === 'test') && await isApprovedUser(runtime, mail.actorKeyId.slice(5), db);
  if (mail.actorKeyId.startsWith('mcp_')) {
    const grant = await getMcpGrantActor(runtime, mail.actorKeyId, db);
    return !!grant && grant.workspaceId === mail.workspaceId && (mail.environment === 'test' || grant.environment === mail.environment) &&
      (grant.permissions.includes('manage') || grant.permissions.includes('send')) &&
      senderDomainAllowed(grant.domains, mail.snapshot.from.split('@')[1]!);
  }
  // Removed bootstrap origins fail closed; only durable API keys are accepted below.
  const [key] = await db.select().from(apiKeys).where(and(eq(apiKeys.id, mail.actorKeyId), eq(apiKeys.workspaceId, mail.workspaceId), eq(apiKeys.environment, mail.environment))).for('share');
  // Shared readers allow parallel sends but conflict with revocation/permission updates through the durable attempt claim,
  // never through SES I/O. Once attempting, revocation cannot recall an in-flight provider call.
  return !!key && !key.revokedAt && (key.permissions.includes('manage') || key.permissions.includes('send')) && senderDomainAllowed(key.domains, mail.snapshot.from.split('@')[1]!);
}
async function cancelRevokedOrigin(db: DbExecutor, a: Actor, mail: typeof emails.$inferSelect) {
  return db.update(emails).set({ status: 'canceled', errorCode: 'ORIGIN_KEY_REVOKED', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'queued'), eq(emails.dispatchVersion, mail.dispatchVersion))).returning();
}
async function materializeCampaignEmail(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, review: { draft: CampaignDraft; rendered: { html?: string; text?: string }; status: string | null; contentHash: string | null; recipient: ReviewedRecipient } | null) {
  // Review/recipient data and attachment metadata are immutable; retained email
  // links prevent attachment deletion. No transaction is needed to render them.
  // The winning claim persists its snapshot and token atomically; losing workers
  // discard their render without writing a different snapshot over the winner.
  const rows = await attachmentRows(runtime.db, a, mail.snapshot.attachments);
  if (!review?.rendered || review.status !== 'ready' || !review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The reviewed recipient is unavailable.');
  const snapshot = await campaignMessage(runtime, runtime.db, a, review.draft, review.recipient, false, true, rows, review.rendered, true, !review.rendered.html?.includes('{{'));
  if (await digest(canonical(snapshot)) !== review.contentHash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_CHANGED', 'The renderer no longer reproduces the reviewed message. No provider attempt was made.');
  const unsubscribe = await createUnsubscribeLink(runtime, a.workspaceId, a.environment, snapshot.to[0]!);
  marketingFooter(snapshot, unsubscribe.url);
  sizeCheck(snapshot, rows);
  return { mail: { ...mail, snapshot }, rows, unsubscribe: unsubscribe.record };
}
const dispatch: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.emailId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'Email dispatch requires emailId.');
  const started = Date.now(), timings: Record<string, number> = {};
  const phase = async <T>(name: string, work: () => Promise<T>) => {
    const start = Date.now();
    try { return await work(); } finally { timings[name] = (timings[name] ?? 0) + Date.now() - start; }
  };
  try {
  const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', domains: [], permissions: ['manage'] };
  const dispatchInput = await phase('read', () => findDispatchEmail(runtime.db, a, payload.emailId as string));
  let mail = dispatchInput.mail;
  if (mail.dispatchVersion !== (payload.version ?? 0)) return;
  if (mail.status === 'attempting') {
    // A previous lease died after recording attempt start. SES has no idempotency token: never automatically resend.
    await runtime.db.update(emails).set({ status: 'acceptance_unknown', errorCode: 'INTERRUPTED_PROVIDER_ATTEMPT', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'attempting')));
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'acceptance_unknown', externalId: `attempt-unknown:${mail.id}` });
    await finishEmailCampaign(runtime, a, mail); return;
  }
  if (mail.status !== 'queued') { await finishEmailCampaign(runtime, a, mail); return; }
  if (mail.scheduledAt && Date.parse(mail.scheduledAt) > Date.now()) throw new ApiError(409, 'DISPATCH_NOT_DUE', 'The scheduled dispatch is not due.', undefined, true);
  if (a.environment === 'live') await phase('readiness', () => assertDispatchRegionReady(runtime, mail.snapshot.region, mail.snapshot.kind));
  let preparedAttachments: (typeof attachments.$inferSelect)[] | undefined;
  let pendingUnsubscribe: Awaited<ReturnType<typeof createUnsubscribeLink>>['record'] | undefined;
  if (mail.snapshot.deferredCampaign) {
    const materialized = await phase('materialize', () => materializeCampaignEmail(runtime, a, mail, dispatchInput.review));
    mail = materialized.mail; preparedAttachments = materialized.rows; pendingUnsubscribe = materialized.unsubscribe;
  }
  const s = mail.snapshot;
  // Resolve storage and credentials BEFORE claiming a provider attempt; these failures cannot have sent email.
  const parts: Attachment[] = [];
  await phase('attachments', async () => {
    const rows = preparedAttachments ?? await attachmentRows(runtime.db, a, s.attachments);
    if (a.environment === 'live') for (const row of rows) { const body = await verifiedAttachment(runtime, row); parts.push({ FileName: row.filename, RawContent: body, ContentType: row.contentType, ContentDisposition: row.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(row.contentId ? { ContentId: row.contentId } : {}) }); }
    sizeCheck(s, rows);
  });
  // Serialization/size failures are preflight failures, never uncertain sends.
  const content: SendEmailCommandInput['Content'] = await phase('mime', async () => s.raw
    ? { Raw: { Data: new TextEncoder().encode(s.raw) } }
    : s.html && parts.some(part => part.ContentDisposition === 'INLINE')
      ? { Raw: { Data: inlineMessage(s, parts) } }
      : { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } });
  const ses = a.environment === 'live' ? getSes(runtime, s.region) : null;
  if (ses) {
    const permit = await phase('permit', () => reserveQuota(runtime, a, s.region, s.to.length + s.cc.length + s.bcc.length, ses));
    if (permit.deferUntil) { await deferDispatch(runtime, a, mail, payload, permit.deferUntil); return; }
    if (permit.waitUntil && permit.waitUntil > Date.now()) await phase('permitWait', () => new Promise(resolve => setTimeout(resolve, permit.waitUntil! - Date.now())));
  }
  const claim = (lock: true | 'share') => runtime.db.transaction(async db => {
    const campaign = mail.campaignId && mail.scheduledAt ? await findCampaign(db, a, mail.campaignId, lock) : null;
    // Never upgrade shared campaign locks: concurrent scheduled claims would
    // deadlock. Release and retry with the writer lock before any other locks.
    if (campaign?.status === 'scheduled' && lock === 'share') return null;
    if (!await originAllowed(runtime, db, mail)) return cancelRevokedOrigin(db, a, mail);
    if (campaign) { if (campaign.status === 'canceled') return []; if (campaign.status === 'scheduled') await db.update(campaigns).set({ status: 'sending', updatedAt: now() }).where(campaignWhere(a, campaign.id)); }
    const destinations = [...s.to, ...s.cc, ...s.bcc].map(email => email.toLowerCase());
    // PostgreSQL locks consent, elects one sender, and saves the exact winning
    // snapshot/token/attempt together. No intermediate application round trips.
    const changed = await db.execute<{ status: EmailStatus }>(sql`WITH campaign_state AS MATERIALIZED (
      SELECT status FROM sending_campaigns WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment}
        AND id = ${mail.campaignId ?? null} FOR SHARE
    ), destinations AS (
      SELECT jsonb_array_elements_text(${JSON.stringify(destinations)}::jsonb) AS email
    ), consent AS MATERIALIZED (
      SELECT email, suppressed, deleted_at, marketing_consent FROM audience_contacts
      WHERE workspace_id = ${a.workspaceId} AND environment = ${a.environment} AND email IN (SELECT email FROM destinations)
      ORDER BY id FOR UPDATE
    ), eligibility AS (
      SELECT (${mail.campaignId === null} OR EXISTS (SELECT 1 FROM campaign_state WHERE status <> 'canceled')) AS campaign_allowed,
        NOT EXISTS (SELECT 1 FROM destinations
        LEFT JOIN consent USING (email) WHERE consent.suppressed IS TRUE
        OR (${s.kind === 'marketing'} AND (consent.email IS NULL OR consent.deleted_at IS NOT NULL OR consent.marketing_consent <> 'subscribed'))) AS recipient_allowed
    ), claimed AS (
      UPDATE sending_emails e SET status = CASE WHEN NOT eligibility.campaign_allowed THEN 'canceled' WHEN eligibility.recipient_allowed THEN 'attempting' ELSE 'suppressed' END,
        attempt_started_at = CASE WHEN eligibility.campaign_allowed AND eligibility.recipient_allowed THEN clock_timestamp() ELSE e.attempt_started_at END,
        error_code = CASE WHEN NOT eligibility.campaign_allowed THEN 'CAMPAIGN_CANCELED' WHEN eligibility.recipient_allowed THEN e.error_code ELSE 'RECIPIENT_INELIGIBLE' END,
        snapshot = coalesce(${pendingUnsubscribe ? JSON.stringify(s) : null}::jsonb, e.snapshot), updated_at = clock_timestamp()
      FROM eligibility WHERE e.workspace_id = ${a.workspaceId} AND e.environment = ${a.environment}
        AND e.id = ${mail.id} AND e.status = 'queued' AND e.dispatch_version = ${mail.dispatchVersion}
      RETURNING e.id, e.status
    ), token AS (
      INSERT INTO operation_unsubscribe_tokens(token_hash, workspace_id, environment, email)
      SELECT ${pendingUnsubscribe?.tokenHash ?? null}::text, ${a.workspaceId}, ${a.environment}, ${pendingUnsubscribe?.email ?? null}::text
      FROM claimed WHERE ${pendingUnsubscribe?.tokenHash ?? null}::text IS NOT NULL
    ), attempt AS (
      INSERT INTO sending_email_events(id, workspace_id, environment, email_id, type, external_id, simulated, data)
      SELECT ${id('event')}, ${a.workspaceId}, ${a.environment}, claimed.id, 'dispatch_attempt',
        ${`attempt-start:${mail.id}:${mail.dispatchVersion}`}, ${a.environment === 'test'},
        ${JSON.stringify({ attempt: mail.dispatchVersion + 1, providerCallPlanned: a.environment === 'live' })}::jsonb
      FROM claimed WHERE claimed.status = 'attempting' ON CONFLICT DO NOTHING
    ) SELECT status FROM claimed`);
    return changed.rows;
  });
  const claimed = await phase('claim', async () => await claim('share') ?? await claim(true));
  if (!claimed?.length) return;
  mail = { ...mail, status: claimed[0]!.status };
  if (mail.status === 'canceled') { await finishEmailCampaign(runtime, a, mail); return; }
  if (mail.status === 'suppressed') { await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'suppressed', externalId: `suppressed:${mail.id}` }); await finishEmailCampaign(runtime, a, mail); return; }
  if (!ses) {
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'simulated', externalId: `simulated:${mail.id}`, data: { stage: 'validated', providerCalled: false, deliveryObserved: false } });
    await finishEmailCampaign(runtime, a, mail); return;
  }
  const request: SendEmailCommandInput = { FromEmailAddress: formattedSender(s.from, s.fromName), Destination: { ToAddresses: s.to, CcAddresses: s.cc, BccAddresses: s.bcc }, ReplyToAddresses: s.replyTo,
    ConfigurationSetName: runtime.config.configurationSets[s.kind], EmailTags: [{ Name: 'opensend_email_id', Value: mail.id }, { Name: 'opensend_workspace_id', Value: a.workspaceId }],
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED', ClickTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED' } },
    Content: content,
  };
  let providerId: string | undefined;
  try { const result = await phase('ses', () => ses.send(new SendEmailCommand(request))); providerId = result.MessageId; }
  catch (error) {
    const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
    const status = failure.$metadata?.httpStatusCode;
    // Only access-denial text is retained; redact addresses, credentials and URL query strings.
    const denial = failure.name === 'AccessDeniedException' && typeof failure.message === 'string' ? failure.message.slice(0, 8192) : '';
    const deniedAction = denial.match(/not authorized to perform(?::\s*|\s+['"])([a-z0-9-]+:[A-Za-z0-9]+)\b/)?.[1];
    const deniedResource = denial.match(/on resource:\s*(arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:[A-Za-z0-9_+=,.@/*:-]{1,512}|\*)(?=\s|$)/)?.[1]
      ?.replace(/[A-Za-z0-9_+=,.%-]+@/g, '[redacted]@');
    const awsRequestId = typeof failure.$metadata?.requestId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(failure.$metadata.requestId) ? failure.$metadata.requestId : undefined;
    const denialMessage = [runtime.config.aws?.accessKeyId, runtime.config.aws?.secretAccessKey, runtime.config.aws?.sessionToken]
      .reduce<string>((text, secret) => secret ? text.replaceAll(secret, '[redacted credential]') : text, denial)
      .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
      .replace(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g, '[redacted email]')
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted access key]')
      .replace(/\b(?:Bearer\s+\S+|(?:token|secret|password|credential|signature|authorization)\s*[:=]\s*\S+)/gi, '[redacted credential]')
      .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
    const diagnostics = { ...(awsRequestId ? { awsRequestId } : {}), ...(deniedAction ? { deniedAction } : {}), ...(deniedResource ? { deniedResource } : {}), ...(denialMessage ? { denialMessage } : {}) };
    if (denial) log('error', { code: 'SES_ACCESS_DENIED', emailId: mail.id, jobId: job.id, region: s.region, ...diagnostics });
    const providerRetries = typeof payload.providerRetries === 'number' ? payload.providerRetries : 0;
    if (status === 429 && providerRetries < 5) {
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'provider_throttled', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 } });
      await deferDispatch(runtime, a, mail, { ...payload, providerRetries: providerRetries + 1 }, new Date(Date.now() + Math.min(60000, 2000 * 2 ** providerRetries)).toISOString(), true);
      return;
    }
    const definitive = status !== undefined && status >= 400 && status < 500;
    const next: EmailStatus = definitive ? 'rejected' : 'acceptance_unknown';
    await runtime.db.update(emails).set({ status: next, errorCode: definitive ? (failure.name ?? 'SES_REJECTED') : 'SES_ACCEPTANCE_UNKNOWN', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'attempting')));
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: definitive ? 'reject' : 'acceptance_unknown', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: definitive ? failure.name ?? 'SES_REJECTED' : 'SES_ACCEPTANCE_UNKNOWN', retryable: false, ...diagnostics } });
    await finishEmailCampaign(runtime, a, mail); return;
  }
  await phase('record', async () => {
    if (!providerId) {
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'acceptance_unknown', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: 'SES_MESSAGE_ID_MISSING' } });
    } else {
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'accepted', providerId, externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}` });
    }
  });
  await finishEmailCampaign(runtime, a, mail);
  } finally {
    log('info', { code: 'DISPATCH_TIMINGS', jobId: job.id, emailId: payload.emailId, version: payload.version ?? 0, environment: job.environment, durationMs: Date.now() - started, timings });
  }
};
const guardedDispatch: JobHandler = async (runtime, payload, job) => {
  try { await dispatch(runtime, payload, job); }
  catch (error) {
    if (typeof payload.emailId !== 'string') throw error;
    const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', domains: [], permissions: ['manage'] };
    const [mail] = await runtime.db.select().from(emails).where(mailWhere(a, payload.emailId));
    if (!mail) throw error;
    if (mail.status === 'attempting') {
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'acceptance_unknown', externalId: `interrupted:${mail.id}:${mail.dispatchVersion}`, data: { code: 'INTERRUPTED_PROVIDER_ATTEMPT' } });
      await finishEmailCampaign(runtime, a, mail); return;
    }
    if (mail.status === 'queued') {
      const failure = error instanceof ApiError ? error : new ApiError(503, 'DISPATCH_PREFLIGHT_FAILED', 'A dispatch dependency failed before the provider attempt.', undefined, true);
      // The handler and queue must agree about terminal failure.
      if (failure.retryable && job.attempts < MAX_ATTEMPTS) throw failure;
      await runtime.db.update(emails).set({ status: 'rejected', errorCode: failure.code, updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'queued')));
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'reject', externalId: `preflight-failed:${mail.id}`, data: { code: failure.code, providerCalled: false } });
    }
    await finishEmailCampaign(runtime, a, mail);
  }
};
const prepareCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.reviewId !== 'string' || typeof payload.campaignId !== 'string' || typeof payload.cursor !== 'number') throw new ApiError(422, 'INVALID_JOB', 'Campaign preparation requires a review and cursor.');
  const reviewId = payload.reviewId, campaignId = payload.campaignId;
  const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', permissions: ['manage'], domains: [] };
  try {
    const [initial] = await runtime.db.select().from(campaignReviews).where(and(eq(campaignReviews.id, reviewId), scope(campaignReviews, a)));
    if (!initial || initial.storageVersion !== 2 || !['pending', 'processing'].includes(initial.status) || initial.processed !== payload.cursor) return;
    a.keyId = initial.actorKeyId!;
    await runtime.db.transaction(async db => {
      const [campaign] = await db.select().from(campaigns).where(campaignWhere(a, initial.campaignId)).for('update');
      if (!campaign) return;
      const authorized = await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, snapshot: { from: initial.draft.from } });
      const [review] = await db.select().from(campaignReviews).where(eq(campaignReviews.id, initial.id)).for('update');
      if (!review || !['pending', 'processing'].includes(review.status) || review.processed !== payload.cursor) return;
      const [delivery] = await db.select().from(campaignExpansions).where(and(scope(campaignExpansions, a), eq(campaignExpansions.reviewId, review.id))).for('update');
      const current = campaign.preparingReviewId === review.id && campaign.revision === review.revision && !campaign.archivedAt &&
        (['draft', 'reviewed'].includes(campaign.status) || !!delivery && ['scheduled', 'sending'].includes(campaign.status) && ['pending', 'expanding'].includes(delivery.status));
      if (!authorized || !current) {
        const failure = { code: authorized ? 'STALE_CAMPAIGN_REVIEW' : 'ORIGIN_KEY_REVOKED', message: authorized ? 'The campaign changed during preparation. Prepare the current revision.' : 'The reviewing origin is no longer authorized.' };
        await db.update(campaignReviews).set({ status: 'failed', error: failure }).where(eq(campaignReviews.id, review.id));
        if (delivery) await db.update(campaignExpansions).set({ status: 'failed', error: failure, updatedAt: now() }).where(eq(campaignExpansions.campaignId, campaign.id));
        if (campaign.preparingReviewId === review.id) await db.update(campaigns).set({ ...(delivery && ['scheduled', 'sending'].includes(campaign.status) ? { status: 'draft' as const, reviewId: null, scheduledAt: null } : {}), preparingReviewId: null, updatedAt: now() }).where(campaignWhere(a, campaign.id));
        return;
      }
      await assertRegionEnabled(db, a.workspaceId, review.draft.region);
      if (a.environment === 'live') await assertLiveRegionReady(runtime, db, review.draft.region, 'marketing', true);
      const lockedAttachments = await attachmentRows(db, a, review.draft.attachments, true);
      if (!review.rendered) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen message source is missing.');
      const recipients = await recipientChunk(db, review.id, review.processed);
      if (!recipients.length) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience is incomplete.');
      validateInterpolationTemplate(review.draft.subject, false);
      validateInterpolationTemplate(review.rendered.html, true);
      validateInterpolationTemplate(review.rendered.text, false);
      const htmlStatic = !review.rendered.html?.includes('{{');
      if (htmlStatic) validateHtmlUrls(review.rendered.html);
      const messageStatic = ![review.draft.subject, review.rendered.html, review.rendered.text].some(value => value?.includes('{{'));
      let cursor = review.processed, bytes = 0, hash = review.contentHash;
      const started = Date.now(), prepared: { ordinal: number; hash: string; subject: string; bytes: number }[] = [];
      let staticSnapshot: EmailSnapshot | undefined;
      for (const recipient of recipients) {
        if (recipient.ordinal !== cursor + 1 || recipient.content_hash) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The frozen audience cursor is inconsistent.');
        // Validate every substitution, URL and MIME size, but retain only its digest and lightweight metadata.
        // The immutable rendered base is shared by all recipients; full message audit is saved at dispatch.
        if (messageStatic && !staticSnapshot) staticSnapshot = await campaignMessage(runtime, db, a, review.draft, recipient.recipient, false, true, lockedAttachments, review.rendered, true, true);
        const snapshot = staticSnapshot
          ? { ...staticSnapshot, to: [recipient.recipient.email], headers: [...staticSnapshot.headers] }
          : await campaignMessage(runtime, db, a, review.draft, recipient.recipient, false, true, lockedAttachments, review.rendered, true, htmlStatic);
        const contentHash = await digest(canonical(snapshot));
        marketingFooter(snapshot, `${runtime.config.publicUrl.replace(/\/$/, '')}/unsubscribe/u_${'0'.repeat(64)}`);
        sizeCheck(snapshot, lockedAttachments);
        const size = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
        if (prepared.length && bytes + size > CAMPAIGN_CHUNK_BYTES) break;
        if (review.preparedBytes + bytes + size > CAMPAIGN_PREPARED_BYTES) throw new ApiError(413, 'EXPANDED_CAMPAIGN_TOO_LARGE', 'Prepared campaign content exceeds 64 GiB.');
        prepared.push({ ordinal: recipient.ordinal, hash: contentHash, subject: snapshot.subject, bytes: size }); bytes += size; cursor = recipient.ordinal;
        hash = await digest(canonical([hash, recipient.ordinal, recipient.recipient, contentHash]));
        if (Date.now() - started >= 10000) break;
      }
      log('info', { code: 'CAMPAIGN_PREPARE_TIMINGS', jobId: job.id, campaignId, reviewId, cursor: review.processed, rows: prepared.length, messageStatic, durationMs: Date.now() - started });
      await db.execute(sql`UPDATE sending_review_recipients r SET content_hash = p.hash, subject = p.subject, snapshot_bytes = p.bytes
        FROM jsonb_to_recordset(${JSON.stringify(prepared)}::jsonb) AS p(ordinal integer, hash text, subject text, bytes integer)
        WHERE r.review_id = ${review.id} AND r.ordinal = p.ordinal AND r.content_hash IS NULL`);
      const ready = cursor === review.eligible;
      await db.update(campaignReviews).set({ processed: cursor, preparedBytes: review.preparedBytes + bytes, contentHash: hash, status: ready ? 'ready' : 'processing' }).where(eq(campaignReviews.id, review.id));
      await db.update(campaigns).set({ ...(ready ? delivery ? { reviewId: review.id, preparingReviewId: null } : { status: 'reviewed' as const, reviewId: review.id, preparingReviewId: null } : {}), updatedAt: now() }).where(campaignWhere(a, campaign.id));
      if (ready && delivery) {
        const jobId = await enqueue(db, { type: 'campaign.expand', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, cursor: 0, ...(delivery.requestId ? { requestId: delivery.requestId } : {}) }, availableAt: campaign.scheduledAt ?? undefined });
        await db.update(campaignExpansions).set({ jobId }).where(eq(campaignExpansions.campaignId, campaign.id));
      }
      if (!ready) await enqueue(db, { type: 'campaign.prepare', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, reviewId: review.id, cursor } });
    });
  } catch (error) {
    const retry = !(error instanceof ApiError) || error.retryable;
    if (retry && job.attempts < MAX_ATTEMPTS) throw new ApiError(503, error instanceof ApiError ? error.code : 'CAMPAIGN_PREPARATION_FAILED', 'Campaign preparation will retry its durable cursor.', undefined, true);
    try { await runtime.db.transaction(async db => {
      const [campaign] = await db.select().from(campaigns).where(campaignWhere(a, campaignId)).for('update');
      const failure = backgroundFailure(error);
      const changed = await db.update(campaignReviews).set({ status: 'failed', error: failure }).where(and(scope(campaignReviews, a), eq(campaignReviews.id, reviewId), eq(campaignReviews.processed, payload.cursor as number), inArray(campaignReviews.status, ['pending', 'processing']))).returning({ id: campaignReviews.id });
      const failedDelivery = changed.length ? await db.update(campaignExpansions).set({ status: 'failed', error: failure, updatedAt: now() }).where(and(scope(campaignExpansions, a), eq(campaignExpansions.reviewId, reviewId), inArray(campaignExpansions.status, ['pending', 'expanding']))).returning({ id: campaignExpansions.campaignId }) : [];
      if (changed.length && campaign?.preparingReviewId === reviewId) await db.update(campaigns).set({ ...(failedDelivery.length && ['scheduled', 'sending'].includes(campaign.status) ? { status: 'draft' as const, reviewId: null, scheduledAt: null } : {}), preparingReviewId: null, updatedAt: now() }).where(campaignWhere(a, campaign.id));
    }); } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign failure state will retry until it is durable.', undefined, true); }
  }
};
const expandCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'Campaign expansion requires a campaign.');
  const campaignId = payload.campaignId;
  const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', permissions: ['manage'], domains: [] };
  try {
    const [initial] = await runtime.db.select().from(campaignExpansions).where(and(eq(campaignExpansions.campaignId, campaignId), scope(campaignExpansions, a)));
    if (!initial || !['pending', 'expanding'].includes(initial.status) || initial.jobId !== job.id) return;
    a.keyId = initial.actorKeyId;
    const [review] = await runtime.db.select({ draft: campaignReviews.draft }).from(campaignReviews).where(eq(campaignReviews.id, initial.reviewId));
    const readyJobs = await runtime.db.transaction(async db => {
      const campaign = await findCampaign(db, a, initial.campaignId, true);
      await lockAdmission(db, a);
      const authorized = !!review && await originAllowed(runtime, db, { ...a, actorKeyId: a.keyId, snapshot: { from: review.draft.from } });
      const [expansion] = await db.select().from(campaignExpansions).where(eq(campaignExpansions.campaignId, campaign.id)).for('update');
      if (!expansion || expansion.jobId !== job.id || !['pending', 'expanding'].includes(expansion.status)) return;
      if (campaign.status === 'canceled' || !authorized) { await cancelCampaignWork(db, a, campaign, authorized ? undefined : 'ORIGIN_KEY_REVOKED'); return; }
      if (!['scheduled', 'sending'].includes(campaign.status)) throw new ApiError(409, 'CAMPAIGN_EXPANSION_STATE_INVALID', 'Campaign expansion no longer owns this delivery.');
      const defer = async (availableAt: string) => {
        const jobId = await enqueue(db, { type: 'campaign.expand', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, cursor: expansion.expanded, ...(expansion.requestId ? { requestId: expansion.requestId } : {}) }, availableAt });
        await db.update(campaignExpansions).set({ jobId }).where(eq(campaignExpansions.campaignId, campaign.id));
      };
      // Future schedules reserve their full audience without occupying the active dispatch buffer.
      if (campaign.scheduledAt && Date.parse(campaign.scheduledAt) > Date.now()) { await defer(campaign.scheduledAt); return; }
      const [buffer] = await db.select({ total: sql<number>`count(*)::int`, campaign: sql<number>`count(*) FILTER (WHERE ${emails.campaignId} = ${campaign.id})::int` }).from(emails).where(and(scope(emails, a), isNotNull(emails.reviewId), inArray(emails.status, ['queued', 'attempting'])));
      const capacity = Math.min(CAMPAIGN_CHUNK_ROWS, CAMPAIGN_BUFFER - buffer!.campaign, 1000 - buffer!.total);
      if (capacity <= 0) { await defer(new Date(Date.now() + 2000).toISOString()); return; }
      const recipients = await recipientChunk(db, expansion.reviewId, expansion.expanded, capacity);
      if (!review || !recipients.length || recipients.some((recipient, index) => !recipient.content_hash || recipient.subject === null || recipient.ordinal !== expansion.expanded + index + 1)) throw new ApiError(409, 'CAMPAIGN_SNAPSHOT_INVALID', 'The prepared audience is incomplete.');
      const draft = review.draft;
      const prepared = recipients.map(recipient => ({ id: id('email'), ordinal: recipient.ordinal, snapshot: {
        from: draft.from, ...(draft.fromName !== undefined ? { fromName: draft.fromName } : {}), to: [recipient.recipient.email], cc: [], bcc: [], replyTo: draft.replyTo ?? [], region: draft.region,
        kind: 'marketing' as const, subject: recipient.subject!, attachments: draft.attachments, tracking: draft.tracking, headers: [], deferredCampaign: true,
      } satisfies EmailSnapshot }));
      await db.insert(emails).values(prepared.map(({ id: emailId, ordinal, snapshot }) => ({ id: emailId, workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, region: snapshot.region, campaignId: campaign.id, reviewId: expansion.reviewId, reviewOrdinal: ordinal, from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, snapshot, simulated: a.environment === 'test', scheduledAt: campaign.scheduledAt })));
      const links = prepared.flatMap(({ id: emailId, snapshot }) => snapshot.attachments.map(attachmentId => ({ workspaceId: a.workspaceId, environment: a.environment, attachmentId, ownerType: 'email' as const, ownerId: emailId })));
      if (links.length) await db.insert(attachmentLinks).values(links);
      await db.insert(jobs).values(prepared.map(({ id: emailId }) => ({ id: id('job'), type: 'email.dispatch', workspaceId: a.workspaceId, environment: a.environment, payload: { emailId, campaignId: campaign.id, version: 0, ...(expansion.requestId ? { requestId: expansion.requestId } : {}) } })));
      const expanded = recipients[recipients.length - 1]!.ordinal, completed = expanded === expansion.total;
      const jobId = completed ? null : await enqueue(db, { type: 'campaign.expand', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, cursor: expanded, ...(expansion.requestId ? { requestId: expansion.requestId } : {}) } });
      if (completed) await enqueue(db, { type: 'campaign.finish', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, ...(expansion.requestId ? { requestId: expansion.requestId } : {}) }, availableAt: new Date(Date.now() + 2000).toISOString() });
      await db.update(campaignExpansions).set({ expanded, jobId, status: completed ? 'completed' : 'expanding', updatedAt: now() }).where(eq(campaignExpansions.campaignId, campaign.id));
      await db.update(campaigns).set({ updatedAt: now() }).where(campaignWhere(a, campaign.id));
      return prepared.length;
    });
    if (readyJobs) await wake(runtime, readyJobs);
  } catch (error) {
    const retry = !(error instanceof ApiError) || error.retryable;
    if (retry && job.attempts < MAX_ATTEMPTS) throw new ApiError(503, error instanceof ApiError ? error.code : 'CAMPAIGN_EXPANSION_FAILED', 'Campaign expansion will retry its durable cursor.', undefined, true);
    try { await runtime.db.transaction(async db => {
      await findCampaign(db, a, campaignId, true);
      const changed = await db.update(campaignExpansions).set({ status: 'failed', error: backgroundFailure(error), updatedAt: now() }).where(and(scope(campaignExpansions, a), eq(campaignExpansions.campaignId, campaignId), eq(campaignExpansions.jobId, job.id), inArray(campaignExpansions.status, ['pending', 'expanding']))).returning({ id: campaignExpansions.campaignId });
      if (changed.length) await db.update(campaigns).set({ updatedAt: now() }).where(campaignWhere(a, campaignId));
    }); } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign failure state will retry until it is durable.', undefined, true); }
  }
};
const finishExpandedCampaign: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.campaignId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'Campaign completion requires a campaign.');
  const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', domains: [], permissions: ['manage'] };
  try {
    await runtime.db.transaction(async db => {
      const campaign = await findCampaign(db, a, payload.campaignId as string, true);
      if (!['scheduled', 'sending'].includes(campaign.status)) return;
      const [expansion] = await db.select({ status: campaignExpansions.status }).from(campaignExpansions).where(and(scope(campaignExpansions, a), eq(campaignExpansions.campaignId, campaign.id)));
      if (expansion?.status !== 'completed') return;
      const pending = await db.select({ id: emails.id }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, campaign.id), inArray(emails.status, ['queued', 'attempting']))).limit(1);
      if (pending.length) await enqueue(db, { type: 'campaign.finish', workspaceId: a.workspaceId, environment: a.environment, payload: { campaignId: campaign.id, ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}) }, availableAt: new Date(Date.now() + 2000).toISOString() });
      else await db.update(campaigns).set({ status: 'completed', updatedAt: now() }).where(campaignWhere(a, campaign.id));
    });
  } catch { throw new ApiError(503, 'JOB_FINALIZATION_FAILED', 'Campaign completion will retry until it is durable.', undefined, true); }
};
export const jobHandlers: Record<string, JobHandler> = { 'email.dispatch': guardedDispatch, 'campaign.prepare': prepareCampaign, 'campaign.expand': expandCampaign, 'campaign.finish': finishExpandedCampaign };
