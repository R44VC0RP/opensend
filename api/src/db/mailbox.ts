import { bigint, bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Mode } from '../core.js';

export type MailAddress = { name: string | null; address: string };
export type MailHeader = { name: string; value: string };
export type MxReport = {
  state: 'active' | 'missing' | 'conflict' | 'mixed' | 'wrong_region' | 'null_mx' | 'cname' | 'error';
  expected: { type: 'MX'; name: string; value: string; priority: number };
  records: { priority: number; host: string; provider: string | null }[];
  providers: string[];
  message: string;
  checkedAt: string;
};
export type MailboxDomainStatus = 'provisioning' | 'waiting_for_mx' | 'active' | 'disabling' | 'disabled' | 'failed';
export type CatchAll = 'create_mailbox' | 'store';
export type MailboxPermission = 'read' | 'send' | 'modify';
export type SendLimits = { perHour: number; perDay: number; perRecipientPerHour: number; perThreadPer10Minutes: number };
export type Verdicts = { spf?: string; dkim?: string; dmarc?: string; spam?: string; virus?: string };

const scope = () => ({ workspaceId: text('workspace_id').notNull(), environment: text('environment').$type<Mode>().notNull() });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const mailboxRegions = pgTable('mailbox_regions', {
  workspaceId: text('workspace_id').notNull(), region: text('region').notNull(),
  accountId: text('account_id'), bucket: text('bucket'), topicArn: text('topic_arn'), ruleSetName: text('rule_set_name'),
  reconcileLeaseUntil: ts('reconcile_lease_until'), lastReconciledAt: ts('last_reconciled_at'), lastError: text('last_error'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.region] })]);

export const mailboxDomains = pgTable('mailbox_domains', {
  id: text('id').primaryKey(), ...scope(), domainId: text('domain_id').notNull(), name: text('name').notNull(), region: text('region').notNull(),
  status: text('status').$type<MailboxDomainStatus>().notNull(), catchAll: text('catch_all').$type<CatchAll>().notNull().default('create_mailbox'),
  mx: jsonb('mx').$type<MxReport | null>(), lastError: text('last_error'), enabledAt: ts('enabled_at'), checkedAt: ts('checked_at'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [uniqueIndex('mailbox_domains_name').on(t.workspaceId, t.environment, t.name), uniqueIndex('mailbox_domains_domain').on(t.workspaceId, t.environment, t.domainId), index('mailbox_domains_region').on(t.workspaceId, t.region, t.status)]);

export const mailboxes = pgTable('mailboxes', {
  id: text('id').primaryKey(), ...scope(), domainId: text('domain_id').notNull(), address: text('address').notNull(), displayName: text('display_name'),
  rules: jsonb('rules').$type<string[]>().notNull().default([]), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  origin: text('origin').$type<'api' | 'auto'>().notNull().default('api'),
  sendLimits: jsonb('send_limits').$type<Partial<SendLimits>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('mailboxes_page').on(t.workspaceId, t.environment, t.id), index('mailboxes_domain').on(t.workspaceId, t.environment, t.domainId)]);

export const mailboxAddresses = pgTable('mailbox_addresses', {
  ...scope(), address: text('address').notNull(), mailboxId: text('mailbox_id').notNull(), kind: text('kind').$type<'primary' | 'alias'>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.address] }), index('mailbox_addresses_mailbox').on(t.mailboxId)]);

export const mailThreads = pgTable('mail_threads', {
  id: text('id').primaryKey(), ...scope(), subject: text('subject').notNull().default(''), messageCount: integer('message_count').notNull().default(0),
  lastMessageAt: ts('last_message_at').notNull().defaultNow(), createdAt: ts('created_at').notNull().defaultNow(),
});

export const mailMessages = pgTable('mail_messages', {
  id: text('id').primaryKey(), ...scope(), direction: text('direction').$type<'inbound' | 'outbound'>().notNull(), threadId: text('thread_id').notNull(),
  region: text('region'), domainId: text('domain_id'), sesMessageId: text('ses_message_id'), sendingEmailId: text('sending_email_id'),
  messageId: text('message_id'), inReplyTo: text('in_reply_to'), references: jsonb('references').$type<string[]>().notNull().default([]),
  subject: text('subject').notNull().default(''), fromAddress: text('from_address').notNull().default(''), fromName: text('from_name'),
  to: jsonb('to').$type<MailAddress[]>().notNull().default([]), cc: jsonb('cc').$type<MailAddress[]>().notNull().default([]),
  bcc: jsonb('bcc').$type<MailAddress[]>().notNull().default([]), replyTo: jsonb('reply_to').$type<MailAddress[]>().notNull().default([]),
  envelopeFrom: text('envelope_from'), envelopeTo: jsonb('envelope_to').$type<string[]>().notNull().default([]),
  sentAt: ts('sent_at'), receivedAt: ts('received_at').notNull().defaultNow(),
  text: text('text'), html: text('html'), bodyTruncated: boolean('body_truncated').notNull().default(false), snippet: text('snippet').notNull().default(''),
  headers: jsonb('headers').$type<MailHeader[]>().notNull().default([]), attachmentCount: integer('attachment_count').notNull().default(0), sizeBytes: integer('size_bytes'),
  rawBucket: text('raw_bucket'), rawKey: text('raw_key'), verdicts: jsonb('verdicts').$type<Verdicts>().notNull().default({}),
  spam: boolean('spam').notNull().default(false), automated: boolean('automated').notNull().default(false), status: text('status').notNull().default('received'),
  senderMailboxId: text('sender_mailbox_id'), errorCode: text('error_code'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const mailMessageIds = pgTable('mail_message_ids', {
  ...scope(), messageId: text('message_id').notNull(), mailMessageId: text('mail_message_id').notNull(), threadId: text('thread_id').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.messageId] })]);

export const mailUnrouted = pgTable('mail_unrouted', {
  ...scope(), messageId: text('message_id').notNull(), address: text('address').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.workspaceId, t.environment, t.address, t.messageId] })]);

export const mailboxMessages = pgTable('mailbox_messages', {
  mailboxId: text('mailbox_id').notNull(), messageId: text('message_id').notNull(), ...scope(), threadId: text('thread_id').notNull(),
  direction: text('direction').$type<'inbound' | 'outbound'>().notNull(), read: boolean('read').notNull().default(false), receivedAt: ts('received_at').notNull(),
  labels: text('labels').array().notNull().default([]),
}, t => [primaryKey({ columns: [t.mailboxId, t.messageId] })]);

export const mailboxThreads = pgTable('mailbox_threads', {
  mailboxId: text('mailbox_id').notNull(), threadId: text('thread_id').notNull(), ...scope(),
  subject: text('subject').notNull().default(''), snippet: text('snippet').notNull().default(''), participants: jsonb('participants').$type<MailAddress[]>().notNull().default([]),
  messageCount: integer('message_count').notNull().default(0), unreadCount: integer('unread_count').notNull().default(0),
  lastMessageAt: ts('last_message_at').notNull(), lastInboundAt: ts('last_inbound_at'),
  archived: boolean('archived').notNull().default(false), starred: boolean('starred').notNull().default(false), spam: boolean('spam').notNull().default(false),
  trashedAt: ts('trashed_at'), labels: text('labels').array().notNull().default([]), createdAt: ts('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.mailboxId, t.threadId] })]);

export const mailAttachments = pgTable('mail_attachments', {
  id: text('id').primaryKey(), ...scope(), messageId: text('message_id').notNull(), filename: text('filename').notNull(), contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(), contentId: text('content_id'), disposition: text('disposition').$type<'attachment' | 'inline'>().notNull(),
  sha256: text('sha256').notNull(), bucket: text('bucket').notNull(), storageKey: text('storage_key').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
});

export const mailReceipts = pgTable('mail_receipts', {
  workspaceId: text('workspace_id').notNull(), sesMessageId: text('ses_message_id').notNull(), environment: text('environment').$type<Mode>().notNull(),
  region: text('region').notNull(), bucket: text('bucket').notNull(), objectKey: text('object_key').notNull(), recipients: jsonb('recipients').$type<string[]>().notNull(),
  notification: jsonb('notification').$type<Record<string, unknown>>().notNull(), status: text('status').$type<'pending' | 'processed' | 'failed'>().notNull().default('pending'),
  error: text('error'), createdAt: ts('created_at').notNull().defaultNow(), processedAt: ts('processed_at'),
}, t => [primaryKey({ columns: [t.workspaceId, t.sesMessageId] })]);

export const mailboxKeys = pgTable('mailbox_keys', {
  id: text('id').primaryKey(), ...scope(), name: text('name').notNull(), hash: text('hash').notNull().unique(), prefix: text('prefix').notNull(),
  mailboxIds: jsonb('mailbox_ids').$type<string[] | null>(), permissions: jsonb('permissions').$type<MailboxPermission[]>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(), lastUsedAt: ts('last_used_at'), revokedAt: ts('revoked_at'),
});

export const mailboxEvents = pgTable('mailbox_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(), ...scope(), type: text('type').notNull(), mailboxId: text('mailbox_id'), threadId: text('thread_id'), messageId: text('message_id'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(), createdAt: ts('created_at').notNull().defaultNow(),
});

export const mailboxWebhooks = pgTable('mailbox_webhooks', {
  id: text('id').primaryKey(), ...scope(), url: text('url').notNull(), description: text('description').notNull().default(''),
  eventTypes: jsonb('event_types').$type<string[]>().notNull(), mailboxIds: jsonb('mailbox_ids').$type<string[] | null>(), paused: boolean('paused').notNull().default(false),
  encryptedSecret: text('encrypted_secret').notNull(), createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const mailboxWebhookDeliveries = pgTable('mailbox_webhook_deliveries', {
  id: text('id').primaryKey(), ...scope(), webhookId: text('webhook_id').notNull(), eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), status: text('status').$type<'pending' | 'delivered' | 'failed'>().notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0), lastStatusCode: integer('last_status_code'), lastError: text('last_error'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
});
