import { ApiError, type Config, type FeedbackItem } from './core.js';
import type { EmailSnapshot } from './db/sending.js';
import { resolve } from './mailbox-dns.js';

// Cloudflare Email Service is a second sending provider selected by the reserved pseudo-region `cloudflare`.
// Region ids already flow through every API (sends, campaigns, domains, webhook filters, the catalog,
// dispatcher shards and quota rows), so the public shape stays the same for both providers.
export const CLOUDFLARE_REGION = 'cloudflare';
export type Provider = 'ses' | 'cloudflare';
export const providerFor = (region: string): Provider => region === CLOUDFLARE_REGION ? 'cloudflare' : 'ses';
// Feedback items translated from Cloudflare delivery events carry this topic prefix. Only the Cloudflare
// event consumers create it (verified SNS topics are always arn:aws:sns ARNs), so it selects the Cloudflare
// trust path instead of the SES account binding.
export const CLOUDFLARE_TOPIC_PREFIX = 'urn:opensend:cloudflare-email:';
export const isCloudflareFeedback = (item: { environment?: string; region?: unknown; topicArn?: unknown }) =>
  item.environment === 'live' && item.region === CLOUDFLARE_REGION && typeof item.topicArn === 'string' && item.topicArn.startsWith(CLOUDFLARE_TOPIC_PREFIX);

/** Cloudflare Email Service limits enforced when mail is queued; one source for the API, docs and tests. */
export const CLOUDFLARE_LIMITS = { recipients: 50, messageBytes: 5 * 1024 * 1024, attachments: 32, replyTo: 1, headerBytes: 16 * 1024, standardHeaders: 20, headerValueBytes: 2048, headerNameBytes: 100 } as const;
const LIST_TARGET = String.raw`<(?:https:\/\/[^<>\s,]+|mailto:[^<>\s,]+)>`;
// Custom headers Cloudflare accepts besides X-*; anything else fails the whole request. From/To/Cc/Bcc/Subject/
// Reply-To use API fields and Date, Message-ID, MIME-Version and Content-Type are platform-controlled.
const HEADER_RULES: Record<string, ((value: string) => boolean) | null> = {
  'in-reply-to': null, references: null, 'thread-index': null, 'thread-topic': null,
  'list-unsubscribe': value => new RegExp(`^\\s*${LIST_TARGET}(?:\\s*,\\s*${LIST_TARGET})*\\s*$`, 'i').test(value),
  'list-unsubscribe-post': value => value === 'List-Unsubscribe=One-Click',
  'list-id': null, 'list-archive': null, 'list-help': null, 'list-owner': null, 'list-post': null, 'list-subscribe': null,
  precedence: value => /^(?:bulk|list|junk)$/i.test(value), 'auto-submitted': value => /^(?:auto-generated|auto-replied|auto-notified)$/i.test(value),
  'content-language': null, keywords: null, comments: null, importance: null, priority: null, sensitivity: null, organization: null,
  'require-recipient-valid-since': null, expires: null, 'reply-by': null, 'archived-at': null,
};
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** Request-level Cloudflare constraints, checked before any rendering (applies to live and test). */
export function assertCloudflareRequest(input: { kind: 'transactional' | 'marketing'; template?: unknown; tracking?: boolean; to: string | string[]; cc: string[]; bcc: string[]; replyTo: string[]; attachments: string[] }) {
  if ((Array.isArray(input.to) ? input.to.length : 1) + input.cc.length + input.bcc.length > CLOUDFLARE_LIMITS.recipients) throw new ApiError(422, 'VALIDATION_FAILED', `Cloudflare Email Service accepts at most ${CLOUDFLARE_LIMITS.recipients} recipients across to, cc and bcc.`, 'to');
  if (input.kind === 'marketing') throw new ApiError(422, 'PROVIDER_STREAM_UNSUPPORTED', 'Cloudflare Email Service only permits transactional email; send marketing through an SES region.', 'kind');
  if (input.template) throw new ApiError(422, 'PROVIDER_TEMPLATE_UNSUPPORTED', 'Cloudflare Email Service has no stored templates; send subject and html/text instead.', 'template');
  if (input.tracking === true) throw new ApiError(422, 'PROVIDER_TRACKING_UNSUPPORTED', 'Cloudflare Email Service has no open or click tracking; omit tracking or set it to false.', 'tracking');
  if (input.replyTo.length > CLOUDFLARE_LIMITS.replyTo) throw new ApiError(422, 'VALIDATION_FAILED', 'Cloudflare Email Service accepts one Reply-To address.', 'replyTo');
  if (input.attachments.length > CLOUDFLARE_LIMITS.attachments) throw new ApiError(422, 'VALIDATION_FAILED', `Cloudflare Email Service accepts at most ${CLOUDFLARE_LIMITS.attachments} attachments.`, 'attachments');
}
/** Every snapshot header must be X-* or allowlisted, within Cloudflare's value, count and size limits. */
export function assertCloudflareHeaders(headers: EmailSnapshot['headers']) {
  let standard = 0, total = 0;
  for (const header of headers) {
    const name = header.Name.toLowerCase(), rule = HEADER_RULES[name];
    const custom = /^x-[a-z0-9_-]+$/.test(name);
    if (!custom && rule === undefined) throw new ApiError(422, 'PROVIDER_HEADER_UNSUPPORTED', `Cloudflare Email Service does not accept the ${header.Name} header.`, 'headers');
    if (bytes(header.Name) > CLOUDFLARE_LIMITS.headerNameBytes || bytes(header.Value) > CLOUDFLARE_LIMITS.headerValueBytes || /[\r\n]/.test(header.Value) || (rule && !rule(header.Value))) throw new ApiError(422, 'PROVIDER_HEADER_UNSUPPORTED', `Cloudflare Email Service does not accept this ${header.Name} header value.`, 'headers');
    if (!custom) standard++;
    total += bytes(header.Name) + bytes(header.Value);
  }
  if (standard > CLOUDFLARE_LIMITS.standardHeaders || total > CLOUDFLARE_LIMITS.headerBytes) throw new ApiError(422, 'PROVIDER_HEADER_UNSUPPORTED', `Cloudflare Email Service accepts at most ${CLOUDFLARE_LIMITS.standardHeaders} standard headers and ${CLOUDFLARE_LIMITS.headerBytes / 1024} KB of custom headers.`, 'headers');
}
/** Campaigns are marketing mail; Cloudflare Email Service only permits transactional email. */
export function assertCampaignProvider(region: string) {
  if (providerFor(region) === 'cloudflare') throw new ApiError(422, 'PROVIDER_STREAM_UNSUPPORTED', 'Cloudflare Email Service only permits transactional email; send campaigns through an SES region.', 'region');
}
/** SES discovery, provisioning, Auto Validation, account settings, MAIL FROM and receiving do not exist for Cloudflare. */
export function assertSesOperation(region: string, operation: string) {
  if (providerFor(region) === 'cloudflare') throw new ApiError(422, 'PROVIDER_OPERATION_UNSUPPORTED', `${operation} is an Amazon SES operation; Cloudflare Email Service is configured through its Worker binding or API token and the Cloudflare dashboard.`, 'region');
}

// Bytes for the Workers binding; the REST adapter base64-encodes them.
export type CloudflareAttachment = { content: Uint8Array; filename: string; type: string; disposition: 'attachment' | 'inline'; contentId?: string };
/** The Workers `send_email` builder shape; the REST adapter converts it to the snake_case API body. */
export interface CloudflareMessage {
  from: string | { email: string; name: string }; to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string;
  subject: string; html?: string; text?: string; attachments?: CloudflareAttachment[]; headers?: Record<string, string>;
}
export interface CloudflareEmailSender { send(message: CloudflareMessage): Promise<{ messageId: string }> }
// Codes for which Cloudflare definitively did not accept the message. Anything else (internal errors,
// synchronous delivery failures, timeouts, network) may have been accepted and is never resent.
const DEFINITIVE = new Set(['E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS', 'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY', 'E_SENDING_DISABLED', 'E_UNAUTHORIZED', 'E_NOT_FOUND']);
/** A normalized provider failure. Never carries provider messages, which may contain addresses. */
export class CloudflareSendError extends Error {
  constructor(public code: string, public retryable: boolean, public status?: number) { super(`Cloudflare Email Service request failed (${code}).`); this.name = 'CloudflareSendError'; }
}
export function cloudflareSendError(code: unknown, status?: number) {
  const value = typeof code === 'string' && /^E_[A-Z0-9_]{1,64}$/.test(code) ? code : 'E_UNKNOWN';
  return new CloudflareSendError(value, !DEFINITIVE.has(value), status);
}
/** Send results and delivery events may differ in surrounding angle brackets. */
export const normalizeMessageId = (value: string) => value.trim().replace(/^<([^]*)>$/, '$1').trim();

/** Builds the provider message from the frozen snapshot. Templates (snapshot.raw) are rejected for Cloudflare at queue time. */
export function cloudflareMessage(s: EmailSnapshot, parts: { filename: string; contentType: string; disposition: 'attachment' | 'inline'; contentId?: string | null; body: Uint8Array }[]): CloudflareMessage {
  return {
    from: s.fromName ? { email: s.from, name: s.fromName } : s.from, to: s.to,
    ...(s.cc.length ? { cc: s.cc } : {}), ...(s.bcc.length ? { bcc: s.bcc } : {}), ...(s.replyTo[0] ? { replyTo: s.replyTo[0] } : {}),
    subject: s.subject, ...(s.html ? { html: s.html } : {}), ...(s.text ? { text: s.text } : {}),
    ...(parts.length ? { attachments: parts.map(part => ({ content: part.body, filename: part.filename, type: part.contentType, disposition: part.disposition, ...(part.contentId ? { contentId: part.contentId } : {}) })) } : {}),
    ...(s.headers.length ? { headers: Object.fromEntries(s.headers.map(header => [header.Name, header.Value])) } : {}),
  };
}

const EVENT_TYPES = new Set(['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained']);
function rejectEvent(reason: string): never { throw new ApiError(422, 'CLOUDFLARE_EVENT_REJECTED', reason); }
const text = (value: unknown, max = 2048) => typeof value === 'string' ? value.slice(0, max) : undefined;
/**
 * Translates one Cloudflare Email Service delivery event (a Queues event subscription message) into a
 * FeedbackItem. The message is normalized into the SES event shape that ingestFeedbackBatch,
 * processSesReceipt and ingestRoutineSesEvents already consume: that shape is OpenSend's internal
 * canonical delivery event. Events are per recipient; the event id becomes the receipt message id, so
 * redelivered events deduplicate exactly like SNS callbacks.
 */
export function cloudflareEventToFeedback(body: unknown, config: Pick<Config, 'cloudflare'>): FeedbackItem {
  let value = body;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { rejectEvent('Event body is not JSON.'); } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) rejectEvent('Event body is not an object.');
  const event = value as Record<string, any>;
  const type = typeof event.type === 'string' ? /^cf\.email\.sending\.message\.([a-z]+)$/.exec(event.type)?.[1] : undefined;
  if (!type || !EVENT_TYPES.has(type)) rejectEvent('Not a Cloudflare Email Sending message event.');
  if (config.cloudflare?.accountId && (typeof event.metadata?.accountId === 'string' ? event.metadata.accountId.toLowerCase() : undefined) !== config.cloudflare.accountId) rejectEvent('Event account does not match CLOUDFLARE_ACCOUNT_ID.');
  const payload = event.payload as Record<string, any> | undefined;
  const eventId = payload?.eventId, rawMessageId = payload?.messageId, recipient = payload?.recipient;
  if (typeof eventId !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(eventId) || typeof rawMessageId !== 'string' || !normalizeMessageId(rawMessageId) || rawMessageId.length > 998 || typeof recipient !== 'string' || !recipient || recipient.length > 254) rejectEvent('Event lacks eventId, messageId or recipient.');
  const domain = typeof event.source?.domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(event.source.domain) ? event.source.domain.toLowerCase() : 'unknown';
  const at = event.metadata?.eventTimestamp, parsed = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN;
  const timestamp = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  const delivery = (payload!.delivery ?? {}) as Record<string, unknown>;
  const smtpResponse = text(delivery.smtpResponse), status = text(delivery.smtpEnhancedStatusCode, 32);
  const mail = { messageId: normalizeMessageId(rawMessageId), timestamp, destination: [recipient] };
  const delay = () => ({ eventType: 'DeliveryDelay', mail, deliveryDelay: { timestamp, delayType: 'TransientCommunicationFailure', delayedRecipients: [{ emailAddress: recipient, status, diagnosticCode: smtpResponse }] } });
  const bounce = (bounceType: string, bounceSubType: string, diagnosticCode?: string) => ({ eventType: 'Bounce', mail, bounce: { timestamp, bounceType, bounceSubType, bouncedRecipients: [{ emailAddress: recipient, status, diagnosticCode }] } });
  let message: Record<string, unknown>;
  if (type === 'delivered') message = { eventType: 'Delivery', mail, delivery: { timestamp, recipients: [recipient], smtpResponse, processingTimeMillis: typeof delivery.deliveryTimeMs === 'number' ? delivery.deliveryTimeMs : undefined } };
  else if (type === 'deferred') message = delay();
  else if (type === 'bounced') {
    const detail = (payload!.bounce ?? {}) as Record<string, unknown>;
    // A soft bounce Cloudflare will still retry (terminal: false) is a delay; a terminal soft bounce is final but never suppresses.
    message = detail.type === 'soft' && payload!.terminal === false ? delay() : bounce(detail.type === 'hard' ? 'Permanent' : 'Transient', text(detail.classification, 64) ?? 'General', text(detail.reason) ?? smtpResponse);
  } else if (type === 'failed') message = bounce('Undetermined', 'Undetermined', text(payload!.failure?.reason));
  else if (type === 'rejected') {
    const rejection = (payload!.rejection ?? {}) as Record<string, unknown>;
    // Cloudflare's own suppression list dropped the recipient before sending: the existing SES Auto Validation
    // subtype records it as suppressed (not bounced) and keeps outcome flags unset (migration 034).
    message = rejection.reason === 'suppressed' ? bounce('Permanent', 'EmailValidationSuppressed', 'Recipient is on the Cloudflare suppression list.')
      : { eventType: 'Reject', mail, reject: { timestamp, reason: text(rejection.reason, 200) ?? 'Unknown', detail: text(rejection.detail) } };
  } else message = { eventType: 'Complaint', mail, complaint: { timestamp, complainedRecipients: [{ emailAddress: recipient }], complaintFeedbackType: text(payload!.complaint?.type, 64) } };
  return { environment: 'live', region: CLOUDFLARE_REGION, topicArn: `${CLOUDFLARE_TOPIC_PREFIX}${domain}`, messageId: eventId, message };
}

type DnsRecord = { name: string; type: 'CNAME' | 'TXT' | 'MX'; value: string; priority?: number };
const txt = (data: string) => data.replace(/"\s+"/g, '').replace(/^"|"$/g, '').replace(/\\"/g, '"');
/**
 * Sending-domain readiness from public DNS over HTTPS (no Cloudflare API calls): onboarding a domain with
 * Cloudflare Email Service publishes a cf-bounce MX, SPF and DKIM record, so their presence means ready.
 */
export async function cloudflareDomainReadiness(row: { id: string; name: string; region: string }) {
  const bounce = `cf-bounce.${row.name}`, dkimName = `cf-bounce._domainkey.${row.name}`;
  let failed = false;
  const lookup = (name: string, type: 'MX' | 'TXT') => resolve(name, type).then(result => result.answers.filter(answer => answer.type === (type === 'MX' ? 15 : 16)).map(answer => answer.data), () => { failed = true; return [] as string[]; });
  const [mx, spf, dkim] = await Promise.all([lookup(bounce, 'MX'), lookup(bounce, 'TXT'), lookup(dkimName, 'TXT')]);
  const mxReady = mx.some(data => /(?:^|\.)mx\.cloudflare\.net$/.test((data.trim().split(/\s+/)[1] ?? '').replace(/\.$/, '').toLowerCase()));
  const spfReady = spf.some(data => /\binclude:_spf\.mx\.cloudflare\.net\b/i.test(txt(data)));
  const dkimReady = dkim.some(data => /^v=DKIM1\b/i.test(txt(data).trim()));
  const ready = mxReady && spfReady && dkimReady;
  const verificationStatus = ready ? 'SUCCESS' : failed ? 'TEMPORARY_FAILURE' : mxReady || spfReady || dkimReady ? 'PENDING' : 'NOT_STARTED';
  const dns: DnsRecord[] = [
    ...[1, 2, 3].map(n => ({ name: bounce, type: 'MX' as const, value: `route${n}.mx.cloudflare.net` })),
    { name: bounce, type: 'TXT', value: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
    { name: dkimName, type: 'TXT', value: `Created by Cloudflare when you onboard ${row.name} in the Cloudflare dashboard or with wrangler email sending enable ${row.name}.` },
  ];
  return { id: row.id, name: row.name, region: row.region, verificationStatus, verified: ready, dkimStatus: dkimReady ? 'SUCCESS' : failed ? 'TEMPORARY_FAILURE' : 'PENDING', ready,
    mailFromDomain: bounce, mailFromStatus: mxReady && spfReady ? 'SUCCESS' : failed ? 'TEMPORARY_FAILURE' : 'PENDING', dnsStatus: 'available' as const, dnsUnavailableReason: null, dns };
}
