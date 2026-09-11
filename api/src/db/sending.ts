import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export type EmailStatus = 'queued' | 'attempting' | 'accepted' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'rejected' | 'rendering_failed' | 'delayed' | 'suppressed' | 'canceled' | 'acceptance_unknown' | 'simulated';
export type CampaignEditor = { format: 'react-email'; version: 1; document: Record<string, unknown> };
export type EmailSnapshot = {
  from: string; fromName?: string; previewText?: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]; region: string;
  kind: 'transactional' | 'marketing'; subject: string; html?: string; text?: string;
  attachments: string[]; tracking: boolean; raw?: string;
  template?: { name: string; data: Record<string, unknown>; source: { Subject?: string; Html?: string; Text?: string }; render: 'ses' | 'simulated' };
  headers: { Name: string; Value: string }[];
  deferredCampaign?: boolean;
};
export type CampaignDraft = {
  name: string; from: string; fromName?: string; previewText?: string; replyTo?: string[]; region: string; subject: string; html?: string;
  attachments: string[]; tracking: boolean;
  audience: { listId?: string; segmentId?: string; excludeListIds?: string[]; excludeSegmentIds?: string[] };
  defaults: Record<string, string | number | boolean | null>;
};
export type ReviewedRecipient = { id: string; email: string; name?: string; properties: Record<string, unknown> };
const scope = () => ({ workspaceId: text('workspace_id').notNull(), environment: text('environment').$type<'live' | 'test'>().notNull() });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const emails = pgTable('sending_emails', {
  id: text('id').primaryKey(), ...scope(), region: text('region').notNull(), actorKeyId: text('actor_key_id').notNull(),
  reviewId: text('review_id'), reviewOrdinal: integer('review_ordinal'),
  campaignId: text('campaign_id'), from: text('from_address').notNull(), to: jsonb('to_addresses').$type<string[]>().notNull(), cc: jsonb('cc_addresses').$type<string[]>().notNull(), bcc: jsonb('bcc_addresses').$type<string[]>().notNull(),
  subject: text('subject').notNull(), status: text('status').$type<EmailStatus>().notNull().default('queued'), providerId: text('provider_id'),
  snapshot: jsonb('snapshot').$type<EmailSnapshot>().notNull(), simulated: boolean('simulated').notNull(),
  attemptStartedAt: time('attempt_started_at'), errorCode: text('error_code'), scheduledAt: time('scheduled_at'), dispatchVersion: integer('dispatch_version').notNull().default(0),
  createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [index('sending_emails_page').on(t.workspaceId, t.environment, t.id), index('sending_emails_created_page').on(t.workspaceId, t.environment, t.createdAt.desc(), t.id.desc()), index('sending_emails_campaign').on(t.workspaceId, t.environment, t.campaignId), uniqueIndex('sending_emails_provider').on(t.workspaceId, t.environment, t.region, t.providerId), uniqueIndex('sending_emails_review_recipient').on(t.reviewId, t.reviewOrdinal)]);
export const emailEvents = pgTable('sending_email_events', {
  id: text('id').primaryKey(), ...scope(), emailId: text('email_id').notNull(), type: text('type').notNull(), providerId: text('provider_id'),
  externalId: text('external_id'), data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}), simulated: boolean('simulated').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, t => [index('sending_events_page').on(t.workspaceId, t.environment, t.emailId, t.id), uniqueIndex('sending_events_external').on(t.workspaceId, t.environment, t.externalId)]);
export const attachments = pgTable('sending_attachments', {
  id: text('id').primaryKey(), ...scope(), filename: text('filename').notNull(), contentType: text('content_type').notNull(), size: integer('size').notNull(),
  disposition: text('disposition').$type<'attachment' | 'inline'>().notNull(), contentId: text('content_id'), storageKey: text('storage_key').notNull(), checksum: text('checksum').notNull(), sourceTemplateAssetId: text('source_template_asset_id'),
  createdAt: time('created_at').notNull().defaultNow(),
}, t => [index('sending_attachments_page').on(t.workspaceId, t.environment, t.id)]);
export const attachmentLinks = pgTable('sending_attachment_links', {
  ...scope(), attachmentId: text('attachment_id').notNull().references(() => attachments.id), ownerType: text('owner_type').$type<'email' | 'campaign' | 'review'>().notNull(), ownerId: text('owner_id').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.attachmentId, t.ownerType, t.ownerId] }), index('sending_attachment_owner').on(t.workspaceId, t.environment, t.ownerType, t.ownerId)]);
export const campaigns = pgTable('sending_campaigns', {
  id: text('id').primaryKey(), ...scope(), revision: integer('revision').notNull().default(1), draft: jsonb('draft').$type<CampaignDraft>().notNull(),
  preparingReviewId: text('preparing_review_id'),
  sourceTemplateId: text('source_template_id'), sourceTemplateRevision: integer('source_template_revision'),
  status: text('status').$type<'draft' | 'reviewed' | 'scheduled' | 'sending' | 'completed' | 'canceled'>().notNull().default('draft'), reviewId: text('review_id'), scheduledAt: time('scheduled_at'), archivedAt: time('archived_at'),
  createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [index('sending_campaigns_page').on(t.workspaceId, t.environment, t.id), index('sending_campaigns_created_page').on(t.workspaceId, t.environment, t.createdAt.desc(), t.id.desc()), index('sending_campaigns_archive_page').on(t.workspaceId, t.environment, t.archivedAt, t.createdAt.desc(), t.id.desc())]);
export const campaignReviews = pgTable('sending_campaign_reviews', {
  id: text('id').primaryKey(), ...scope(), campaignId: text('campaign_id').notNull(), revision: integer('revision').notNull(), draft: jsonb('draft').$type<CampaignDraft>().notNull(),
  recipients: jsonb('recipients').$type<ReviewedRecipient[]>().notNull(), matched: integer('matched').notNull(), eligible: integer('eligible').notNull(), suppressed: integer('suppressed').notNull(), unsubscribed: integer('unsubscribed').notNull(),
  contentHash: text('content_hash').notNull(), createdAt: time('created_at').notNull().defaultNow(),
  storageVersion: integer('storage_version').notNull().default(1),
  status: text('status').$type<'pending' | 'processing' | 'ready' | 'failed'>().notNull().default('ready'),
  actorKeyId: text('actor_key_id'), processed: integer('processed').notNull().default(0),
  recipientBytes: bigint('recipient_bytes', { mode: 'number' }).notNull().default(0), preparedBytes: bigint('prepared_bytes', { mode: 'number' }).notNull().default(0),
  rendered: jsonb('rendered').$type<{ html?: string; text?: string }>(), error: jsonb('error').$type<{ code: string; message: string }>(),
}, t => [index('sending_review_campaign').on(t.workspaceId, t.environment, t.campaignId)]);
// Recipient values are copied once from one database snapshot; no live contact joins during preparation or expansion.
export const reviewRecipients = pgTable('sending_review_recipients', {
  reviewId: text('review_id').notNull().references(() => campaignReviews.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(), recipient: jsonb('recipient').$type<ReviewedRecipient>().notNull(),
  recipientBytes: integer('recipient_bytes').notNull(), contentHash: text('content_hash'), subject: text('subject'), snapshotBytes: integer('snapshot_bytes'),
}, t => [primaryKey({ columns: [t.reviewId, t.ordinal] })]);
export const campaignExpansions = pgTable('sending_campaign_expansions', {
  campaignId: text('campaign_id').primaryKey(), reviewId: text('review_id').notNull().unique(), ...scope(), actorKeyId: text('actor_key_id').notNull(),
  total: integer('total').notNull(), expanded: integer('expanded').notNull().default(0), canceled: integer('canceled').notNull().default(0),
  status: text('status').$type<'pending' | 'expanding' | 'completed' | 'failed' | 'canceled'>().notNull().default('pending'),
  error: jsonb('error').$type<{ code: string; message: string }>(), requestId: text('request_id'), jobId: text('job_id'),
  updatedAt: time('updated_at').notNull().defaultNow(),
}, t => [index('sending_expansion_scope').on(t.workspaceId, t.environment, t.actorKeyId)]);
export const regionalLimits = pgTable('sending_region_limits', {
  ...scope(), region: text('region').notNull(), maxSendRate: doublePrecision('max_send_rate').notNull().default(0), max24HourSend: doublePrecision('max_24_hour_send').notNull().default(0), sentLast24Hours: doublePrecision('sent_last_24_hours').notNull().default(0), reserved: integer('reserved').notNull().default(0),
  checkedAt: time('checked_at'), nextAllowedAt: time('next_allowed_at'),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.region] })]);
export const sendingIdempotency = pgTable('sending_idempotency', {
  ...scope(), actorKeyId: text('actor_key_id').notNull(), path: text('path').notNull(), requestKey: text('request_key').notNull(), requestHash: text('request_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(), createdAt: time('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.actorKeyId, t.path, t.requestKey] })]);
