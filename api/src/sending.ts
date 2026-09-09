import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { GetAccountCommand, GetEmailTemplateCommand, SendEmailCommand, TestRenderEmailTemplateCommand, type Attachment, type SESv2Client, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { actor, ApiError, digest, errors, getSes, id, IdParams, json, notFound, PageQuery, page, region, response, security, type Actor, type App, type Ctx, type DbExecutor, type JobHandler, type Mode, type Runtime } from './core.js';
import { enqueue, MAX_ATTEMPTS } from './jobs.js';
import { AudienceSpec, canMarket, getAudience, isSuppressed } from './audience.js';
import { contacts } from './db/audience.js';
import { unsubscribeUrl } from './operations.js';
import { attachmentLinks, attachments, campaignReviews, campaigns, emailEvents, emails, regionalLimits, sendingIdempotency, type CampaignDraft, type EmailSnapshot, type EmailStatus, type ReviewedRecipient } from './db/sending.js';

const MAX_ATTACHMENTS = 8 * 1024 * 1024;
const MAX_ENCODED_MESSAGE = 16 * 1024 * 1024;
const MAX_BODY = 512 * 1024;
const Address = z.string().email().max(254).regex(/^[\x21-\x7e]+$/, 'Use ASCII email addresses (punycode domains are supported).');
const Subject = z.string().min(1).max(998).refine(v => !/[\r\n]/.test(v), 'Subject cannot contain line breaks.');
const Scalar = z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]);
const Data = z.record(z.string().max(120), Scalar).default({});
const StoredTemplateData = z.record(z.string(), z.unknown()).default({}).refine(value => {
  try { return JSON.stringify(value).length <= 262144; } catch { return false; }
}, 'Template data must be JSON serializable and at most 262,144 serialized characters.').describe('JSON substitution data, including nested objects and arrays, is passed unchanged to SES. SES stored templates do not automatically escape HTML: callers must escape untrusted values for their HTML context. Maximum serialized JSON length: 262,144 characters.');
const Region = z.string().min(1).max(40);
const AttachmentIds = z.array(z.string().min(1).max(120)).max(20).default([]);
const ContentFields = { subject: Subject.optional(), html: z.string().min(1).max(MAX_BODY).optional(), text: z.string().min(1).max(MAX_BODY).optional() };
const SendInput = z.object({
  from: Address, to: z.union([Address, z.array(Address).min(1).max(50)]), cc: z.array(Address).max(49).default([]), bcc: z.array(Address).max(49).default([]), replyTo: z.array(Address).max(10).default([]),
  region: Region, kind: z.enum(['transactional', 'marketing']).default('transactional'), ...ContentFields,
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
const Email = z.object({ id: z.string(), environment: z.enum(['live', 'test']), region: z.string(), campaignId: z.string().nullable(), from: z.string(), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), status: Status, providerId: z.string().nullable(), simulated: z.boolean(), attemptStartedAt: z.string().nullable(), errorCode: z.string().nullable(), scheduledAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('Email');
const Receipt = z.object({ id: z.string(), status: z.literal('queued'), environment: z.enum(['live', 'test']), simulated: z.boolean() }).openapi('EmailQueued');
const BatchReceipt = z.object({ data: z.array(Receipt) }).openapi('EmailBatchQueued');
const Event = z.object({ id: z.string(), emailId: z.string(), type: z.string(), providerId: z.string().nullable(), simulated: z.boolean(), environment: z.enum(['live', 'test']), createdAt: z.string(), data: z.record(z.string(), z.unknown()) }).openapi('EmailEvent');
const EmailContent = z.object({ subject: z.string(), html: z.string().nullable(), text: z.string().nullable(), raw: z.string().nullable(), attachments: z.array(z.string()), render: z.enum(['direct', 'ses', 'simulated']), templateName: z.string().nullable(), simulated: z.boolean() }).openapi('EmailContent');
const AttachmentInfo = z.object({ id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int(), disposition: z.enum(['attachment', 'inline']), contentId: z.string().nullable(), createdAt: z.string(), environment: z.enum(['live', 'test']) }).openapi('Attachment');
const AttachmentInput = z.object({ filename: z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f/\\]+$/), contentType: z.string().max(100).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default('application/octet-stream'), content: z.string().min(4).max(Math.ceil(MAX_ATTACHMENTS / 3) * 4).describe('Standard padded base64; no data URLs. Maximum decoded bytes: 8 MiB.'), disposition: z.enum(['attachment', 'inline']).default('attachment'), contentId: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.@-]+$/).optional() }).strict().refine(v => v.disposition !== 'inline' || !!v.contentId, 'Inline attachments require contentId.').openapi('AttachmentUpload');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) }).openapi('DeletedSendingResource');
const CampaignInput = z.object({ name: z.string().min(1).max(200), from: Address, replyTo: z.array(Address).max(10).default([]), region: Region, subject: Subject, html: z.string().min(1).max(MAX_BODY).optional(), text: z.string().min(1).max(MAX_BODY).optional(), attachments: AttachmentIds, tracking: z.boolean().default(true), audience: AudienceSpec, defaults: Data }).strict().refine(v => !!v.html || !!v.text, 'Provide html or text.').openapi('CampaignDraftInput');
const Campaign = z.object({ id: z.string(), environment: z.enum(['live', 'test']), revision: z.number().int(), draft: CampaignInput, status: z.enum(['draft', 'reviewed', 'scheduled', 'sending', 'completed', 'canceled']), reviewId: z.string().nullable(), scheduledAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('Campaign');
const AudienceCounts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int() }).openapi('CampaignAudienceCounts');
const Review = AudienceCounts.extend({ id: z.string(), campaignId: z.string(), revision: z.number().int(), contentHash: z.string(), createdAt: z.string() }).openapi('CampaignReview');
const Revision = z.object({ revision: z.number().int().positive() }).strict().openapi('CampaignRevisionInput');
const CampaignUpdate = z.object({ revision: z.number().int().positive(), draft: CampaignInput }).strict().openapi('CampaignUpdateInput');
const CampaignSend = z.object({ reviewId: z.string().min(1), revision: z.number().int().positive() }).strict().openapi('CampaignSendInput');
const CampaignSchedule = CampaignSend.extend({ scheduledAt: z.string().datetime({ offset: true }) }).openapi('CampaignScheduleInput');
const CampaignQueued = z.object({ id: z.string(), status: z.enum(['scheduled', 'sending']), queued: z.number().int(), scheduledAt: z.string().nullable(), simulated: z.boolean() }).openapi('CampaignQueued');
const CampaignCanceled = z.object({ id: z.string(), status: z.literal('canceled'), canceled: z.number().int(), inFlight: z.number().int() }).openapi('CampaignCanceled');
const TestCampaign = z.object({ to: Address, data: Data }).strict().openapi('CampaignTestInput');
type SendRequest = z.infer<typeof SendInput>;
const now = () => new Date().toISOString();
const scope = (table: { workspaceId: AnyPgColumn; environment: AnyPgColumn }, a: Pick<Actor, 'workspaceId' | 'environment'>) => and(eq(table.workspaceId, a.workspaceId), eq(table.environment, a.environment));
const mailWhere = (a: Pick<Actor, 'workspaceId' | 'environment'>, emailId: string) => and(scope(emails, a), eq(emails.id, emailId));
const campaignWhere = (a: Actor, campaignId: string) => and(scope(campaigns, a), eq(campaigns.id, campaignId));
function sender(runtime: Runtime, a: Actor, from: string, selectedRegion: string) {
  region(runtime, selectedRegion);
  const domain = from.split('@')[1]!.toLowerCase();
  if (a.domains.length && !a.domains.some(d => d.toLowerCase() === domain)) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'This API key cannot send from this domain.', 'from');
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
async function findCampaign(db: DbExecutor, a: Actor, campaignId: string, lock = false) {
  const query = db.select().from(campaigns).where(campaignWhere(a, campaignId));
  const [row] = await (lock ? query.for('update') : query);
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
async function linkAttachments(db: DbExecutor, a: Actor, ids: string[], ownerType: 'email' | 'campaign', ownerId: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  // A campaign may reuse metadata already ownership-checked and locked in this same transaction.
  if (!lockedAttachments) await attachmentRows(db, a, ids, true);
  if (ids.length) await db.insert(attachmentLinks).values(ids.map(attachmentId => ({ workspaceId: a.workspaceId, environment: a.environment, attachmentId, ownerType, ownerId }))).onConflictDoNothing();
}
function escaped(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
function safeData(data: Record<string, unknown>) {
  for (const value of Object.values(data)) if (typeof value === 'string' && /(?:javascript|vbscript|data)\s*:/i.test(value)) throw new ApiError(422, 'UNSAFE_TEMPLATE_VALUE', 'Template values may not contain active-content URL schemes.');
}
function interpolate(source: string | undefined, values: Record<string, unknown>, html: boolean): string | undefined {
  if (!source) return source;
  const unsupported = source.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, '');
  if (unsupported.includes('{{') || unsupported.includes('}}')) throw new ApiError(422, 'UNSUPPORTED_TEMPLATE_SYNTAX', 'Campaigns support simple {{name}} substitutions, not helpers, HTML fragments, or Liquid syntax.');
  return source.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_token, key: string) => {
    if (!(key in values) || values[key] === undefined || values[key] === null) throw new ApiError(422, 'MISSING_TEMPLATE_VARIABLE', `A value is required for ${key}.`, key);
    return html ? escaped(String(values[key])) : String(values[key]);
  });
}
function validateHtmlUrls(html: string | undefined) {
  if (!html) return;
  for (const match of html.matchAll(/\b(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_m, hex: string | undefined, decimal: string | undefined) => { const n = parseInt(hex ?? decimal ?? '', hex ? 16 : 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd'; }).replace(/&colon;/gi, ':').replace(/&(?:tab|newline);/gi, '').replace(/[\x00-\x20\x7f]/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(?:https?|mailto|tel|cid):/i.test(url)) throw new ApiError(422, 'UNSAFE_HTML_URL', 'HTML URLs must use HTTP(S), mailto, tel, CID, or relative references.');
  }
}
function sizeCheck(snapshot: EmailSnapshot, rows: { size: number }[]) {
  const bytes = new TextEncoder().encode((snapshot.raw ?? '') + (snapshot.html ?? '') + (snapshot.text ?? '') + snapshot.subject).length;
  // Conservatively reserve base64/MIME expansion, line folding and headers. This is an application cap, not SES's 40 MB maximum.
  const encoded = Math.ceil(bytes * 1.4) + rows.reduce((sum, r) => sum + Math.ceil(r.size / 3) * 4 * 1.04 + 2048, 0) + 16384;
  if (encoded > MAX_ENCODED_MESSAGE) throw new ApiError(413, 'ENCODED_MESSAGE_TOO_LARGE', 'Estimated encoded MIME exceeds the initial 16 MiB message limit.');
}
async function prepare(runtime: Runtime, db: DbExecutor, a: Actor, input: SendRequest, preview = false, lockedAttachments?: (typeof attachments.$inferSelect)[]): Promise<EmailSnapshot> {
  sender(runtime, a, input.from, input.region);
  const snapshot: EmailSnapshot = { from: input.from, to: Array.isArray(input.to) ? input.to : [input.to], cc: input.cc, bcc: input.bcc, replyTo: input.replyTo, region: input.region, kind: input.kind, subject: input.subject ?? '', html: input.html, text: input.text, attachments: input.attachments, tracking: input.tracking ?? input.kind === 'marketing', headers: [] };
  const rows = lockedAttachments ?? await attachmentRows(db, a, input.attachments, true);
  validateHtmlUrls(snapshot.html);
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
      snapshot.raw = [`From: ${snapshot.from}`, `To: ${snapshot.to.join(', ')}`, ...(snapshot.cc.length ? [`Cc: ${snapshot.cc.join(', ')}`] : []), ...(snapshot.replyTo.length ? [`Reply-To: ${snapshot.replyTo.join(', ')}`] : []), ...headers].join('\r\n') + normalized.slice(split);
    }
  }
  if (input.kind === 'marketing' && !preview) {
    const url = await unsubscribeUrl(runtime, a.workspaceId, a.environment, snapshot.to[0]!, db);
    if (snapshot.html) snapshot.html += `<p><a href="${escaped(url)}">Unsubscribe</a></p>`;
    snapshot.text = (snapshot.text ?? '') + `\n\nUnsubscribe: ${url}`;
    snapshot.headers = [{ Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
  }
  sizeCheck(snapshot, rows);
  return snapshot;
}
async function queueEmail(db: DbExecutor, a: Actor, snapshot: EmailSnapshot, campaignId?: string, availableAt?: string, requestId?: string, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  const emailId = id('email');
  await db.insert(emails).values({ id: emailId, workspaceId: a.workspaceId, environment: a.environment, actorKeyId: a.keyId, region: snapshot.region, campaignId: campaignId ?? null, from: snapshot.from, to: snapshot.to, cc: snapshot.cc, bcc: snapshot.bcc, subject: snapshot.subject, snapshot, simulated: a.environment === 'test', scheduledAt: availableAt ?? null });
  await linkAttachments(db, a, snapshot.attachments, 'email', emailId, lockedAttachments);
  await enqueue(db, { type: 'email.dispatch', workspaceId: a.workspaceId, environment: a.environment, payload: { emailId, version: 0, ...(requestId ? { requestId } : {}) }, availableAt });
  return { id: emailId, status: 'queued' as const, environment: a.environment, simulated: a.environment === 'test' };
}
function wake(runtime: Runtime) { void runtime.wake?.().catch(() => undefined); }
function editable(row: typeof campaigns.$inferSelect, revision?: number) {
  if (revision !== undefined && row.revision !== revision) throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign has changed; fetch it and review again.');
  if (!['draft', 'reviewed'].includes(row.status)) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'Only drafts and reviewed campaigns may be changed.');
}
async function campaignMessage(runtime: Runtime, db: DbExecutor, a: Actor, draft: CampaignDraft, contact: ReviewedRecipient, test = false, preview = false, lockedAttachments?: (typeof attachments.$inferSelect)[]) {
  try {
    const values = { ...draft.defaults, ...Object.fromEntries(Object.entries(contact.properties).filter(([, value]) => value !== null && value !== undefined)), email: contact.email, ...(contact.name ? { name: contact.name } : {}) };
    safeData(values);
    const parsed = SendInput.safeParse({ from: draft.from, to: contact.email, replyTo: draft.replyTo, region: draft.region, kind: test ? 'transactional' : 'marketing', subject: interpolate(draft.subject, values, false), html: interpolate(draft.html, values, true), text: interpolate(draft.text, values, false), attachments: draft.attachments, tracking: test ? false : draft.tracking });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'content'))].join(', ');
      throw new ApiError(422, 'CAMPAIGN_RECIPIENT_INVALID', `Recipient or rendered message is invalid (${fields}).`);
    }
    return await prepare(runtime, db, a, parsed.data, preview, lockedAttachments);
  } catch (error) {
    // Add only a contact identifier to known local validation failures; never rewrite database/provider errors.
    if (error instanceof ApiError && ['CAMPAIGN_RECIPIENT_INVALID', 'MISSING_TEMPLATE_VARIABLE', 'UNSUPPORTED_TEMPLATE_SYNTAX', 'UNSAFE_TEMPLATE_VALUE', 'UNSAFE_HTML_URL', 'ENCODED_MESSAGE_TOO_LARGE'].includes(error.code)) throw new ApiError(error.status, error.code, `Contact ${contact.id}: ${error.message}`, 'contactId', error.retryable);
    throw error;
  }
}

export function registerSending(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/send', operationId: 'sendEmail', tags: ['Emails'], security, request: { body: json(SendInput) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c, a, input, async db => queueEmail(db, a, await prepare(c.env, db, a, input), undefined, undefined, c.get('requestId')));
    wake(c.env); return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/emails/batch', operationId: 'sendEmailBatch', tags: ['Emails'], security, request: { body: json(BatchInput) }, responses: { 202: response(BatchReceipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    if (input.emails.reduce((n, e) => n + (e.html?.length ?? 0) + (e.text?.length ?? 0), 0) > 2 * 1024 * 1024) throw new ApiError(413, 'BATCH_CONTENT_TOO_LARGE', 'Combined batch body content may not exceed 2 MiB.');
    const result = await idempotent(c, a, input, async db => { const data = []; for (const mail of input.emails) data.push(await queueEmail(db, a, await prepare(c.env, db, a, mail), undefined, undefined, c.get('requestId'))); return { data }; });
    wake(c.env); return c.json(BatchReceipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails', operationId: 'listEmails', tags: ['Emails'], security, request: { query: PageQuery.extend({ campaignId: z.string().optional(), status: Status.optional() }) }, responses: { 200: response(page(Email)), ...errors } }), async c => {
    const a = actor(c); const q = c.req.valid('query'); const rows = await c.env.db.select().from(emails).where(and(scope(emails, a), q.cursor ? gt(emails.id, q.cursor) : undefined, q.campaignId ? eq(emails.campaignId, q.campaignId) : undefined, q.status ? eq(emails.status, q.status) : undefined)).orderBy(asc(emails.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => Email.parse(r)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}', operationId: 'getEmail', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(Email), ...errors } }), async c => c.json(Email.parse(await findEmail(c.env.db, actor(c), c.req.valid('param').id)), 200));
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/content', operationId: 'getEmailContent', tags: ['Emails'], security, request: { params: IdParams }, responses: { 200: response(EmailContent), ...errors } }), async c => {
    const row = await findEmail(c.env.db, actor(c), c.req.valid('param').id); const s = row.snapshot;
    return c.json(EmailContent.parse({ subject: s.subject, html: s.html ?? null, text: s.text ?? null, raw: s.raw ?? null, attachments: s.attachments, render: s.template?.render ?? 'direct', templateName: s.template?.name ?? null, simulated: row.simulated }), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/emails/{id}/events', operationId: 'listEmailEvents', tags: ['Emails'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Event)), ...errors } }), async c => {
    const a = actor(c); const emailId = c.req.valid('param').id; await findEmail(c.env.db, a, emailId); const q = c.req.valid('query');
    const rows = await c.env.db.select().from(emailEvents).where(and(scope(emailEvents, a), eq(emailEvents.emailId, emailId), q.cursor ? gt(emailEvents.id, q.cursor) : undefined)).orderBy(asc(emailEvents.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => Event.parse(r)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/attachments', operationId: 'uploadAttachment', tags: ['Attachments'], security, request: { body: json(AttachmentInput) }, responses: { 201: response(AttachmentInfo), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    // Conservative application allowlist, deliberately narrower than SES's prohibited-extension list.
    const extension = input.filename.split('.').pop()?.toLowerCase();
    if (!extension || !['pdf', 'txt', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ics', 'docx', 'xlsx', 'pptx'].includes(extension)) throw new ApiError(422, 'UNSUPPORTED_ATTACHMENT_TYPE', 'This initial release allows PDF, text, CSV, JSON, common raster images, ICS, and modern Office documents.');
    if (input.content.length > Math.ceil(MAX_ATTACHMENTS / 3) * 4) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments must be at most 8 MiB decoded.');
    // Flat character validation avoids stack exhaustion from repeated regex groups on large uploads.
    if (input.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) throw new ApiError(422, 'INVALID_BASE64', 'Attachment content must be standard padded base64.');
    let binary: string;
    try { binary = atob(input.content); } catch { throw new ApiError(422, 'INVALID_BASE64', 'Attachment content is not valid base64.'); }
    if (!binary.length || binary.length > MAX_ATTACHMENTS) throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'Attachments must be nonempty and at most 8 MiB decoded.');
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    const result = await idempotent(c, a, { ...input, content: await digest(input.content) }, async db => {
      const attachmentId = id('attachment'); const storageKey = `${a.workspaceId}/${a.environment}/attachments/${attachmentId}`;
      await c.env.storage.put(storageKey, bytes, input.contentType);
      try {
        const [row] = await db.insert(attachments).values({ id: attachmentId, workspaceId: a.workspaceId, environment: a.environment, filename: input.filename, contentType: input.contentType, size: bytes.length, disposition: input.disposition, contentId: input.contentId, storageKey, checksum: await bytesDigest(bytes) }).returning();
        return AttachmentInfo.parse(row);
      } catch (error) { await c.env.storage.delete(storageKey).catch(() => undefined); throw error; }
    });
    return c.json(AttachmentInfo.parse(result), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/attachments/{id}', operationId: 'getAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(AttachmentInfo), ...errors } }), async c => {
    const [row] = await attachmentRows(c.env.db, actor(c), [c.req.valid('param').id]); return c.json(AttachmentInfo.parse(row), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/attachments/{id}', operationId: 'deleteAttachment', tags: ['Attachments'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const attachmentId = c.req.valid('param').id;
    await c.env.db.transaction(async db => {
      const [row] = await attachmentRows(db, a, [attachmentId], true);
      const links = await db.select().from(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.attachmentId, attachmentId))).limit(1);
      if (links.length) throw new ApiError(409, 'ATTACHMENT_IN_USE', 'Remove this attachment from all drafts first; queued and retained emails keep their immutable attachment references.');
      await c.env.storage.delete(row!.storageKey);
      await db.delete(attachments).where(and(scope(attachments, a), eq(attachments.id, attachmentId)));
    }); return c.json({ id: attachmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns', operationId: 'createCampaign', tags: ['Campaigns'], security, request: { body: json(CampaignInput) }, responses: { 201: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const draft = c.req.valid('json'); sender(c.env, a, draft.from, draft.region);
    const result = await idempotent(c, a, draft, async db => { const campaignId = id('campaign'); await linkAttachments(db, a, draft.attachments, 'campaign', campaignId); const [row] = await db.insert(campaigns).values({ id: campaignId, workspaceId: a.workspaceId, environment: a.environment, draft }).returning(); return Campaign.parse(row); });
    return c.json(Campaign.parse(result), 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns', operationId: 'listCampaigns', tags: ['Campaigns'], security, request: { query: PageQuery }, responses: { 200: response(page(Campaign)), ...errors } }), async c => {
    const a = actor(c); const q = c.req.valid('query'); const rows = await c.env.db.select().from(campaigns).where(and(scope(campaigns, a), q.cursor ? gt(campaigns.id, q.cursor) : undefined)).orderBy(asc(campaigns.id)).limit(q.limit + 1);
    return c.json({ data: rows.slice(0, q.limit).map(r => Campaign.parse(r)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/campaigns/{id}', operationId: 'getCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Campaign), ...errors } }), async c => c.json(Campaign.parse(await findCampaign(c.env.db, actor(c), c.req.valid('param').id)), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/campaigns/{id}', operationId: 'updateCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignUpdate) }, responses: { 200: response(Campaign), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id; sender(c.env, a, input.draft.from, input.draft.region);
    const row = await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); editable(current, input.revision); await attachmentRows(db, a, input.draft.attachments, true); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await linkAttachments(db, a, input.draft.attachments, 'campaign', campaignId); const [updated] = await db.update(campaigns).set({ draft: input.draft, revision: current.revision + 1, status: 'draft', reviewId: null, updatedAt: now() }).where(campaignWhere(a, campaignId)).returning(); return updated; });
    return c.json(Campaign.parse(row), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/campaigns/{id}', operationId: 'deleteCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    await c.env.db.transaction(async db => { const current = await findCampaign(db, a, campaignId, true); editable(current); await db.delete(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.campaignId, campaignId))); await db.delete(attachmentLinks).where(and(scope(attachmentLinks, a), eq(attachmentLinks.ownerType, 'campaign'), eq(attachmentLinks.ownerId, campaignId))); await db.delete(campaigns).where(campaignWhere(a, campaignId)); });
    return c.json({ id: campaignId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/audience-preview', operationId: 'previewCampaignAudience', tags: ['Campaigns'], security, responses: { 200: response(AudienceCounts), ...errors }, request: { params: IdParams } }), async c => {
    const a = actor(c); const row = await findCampaign(c.env.db, a, c.req.valid('param').id); const result = await getAudience(c.env, a, row.draft.audience, 1000); return c.json(AudienceCounts.parse(result), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/test', operationId: 'testCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(TestCampaign) }, responses: { 202: response(Receipt), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => { const row = await findCampaign(db, a, campaignId, true); const snapshot = await campaignMessage(c.env, db, a, row.draft, { id: 'test-recipient', email: input.to, properties: input.data }, true); return queueEmail(db, a, snapshot, undefined, undefined, c.get('requestId')); });
    wake(c.env); return c.json(Receipt.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/review', operationId: 'reviewCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(Revision) }, responses: { 200: response(Review), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, input, async db => {
      const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision); sender(c.env, a, row.draft.from, row.draft.region);
      const audience = await getAudience(c.env, a, row.draft.audience, 1000, db);
      if (!audience.contacts.length) throw new ApiError(422, 'EMPTY_AUDIENCE', 'This campaign has no eligible subscribed recipients.');
      const lockedAttachments = await attachmentRows(db, a, row.draft.attachments, true);
      for (const contact of audience.contacts) await campaignMessage(c.env, db, a, row.draft, contact, false, true, lockedAttachments);
      const reviewId = id('review'); const contentHash = await digest(canonical({ draft: row.draft, recipients: audience.contacts }));
      const [review] = await db.insert(campaignReviews).values({ id: reviewId, workspaceId: a.workspaceId, environment: a.environment, campaignId, revision: row.revision, draft: row.draft, recipients: audience.contacts, matched: audience.matched, eligible: audience.eligible, suppressed: audience.suppressed, unsubscribed: audience.unsubscribed, contentHash }).returning();
      await db.update(campaigns).set({ status: 'reviewed', reviewId, updatedAt: now() }).where(campaignWhere(a, campaignId)); return Review.parse(review);
    }); return c.json(Review.parse(result), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/send', operationId: 'sendCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignSend) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json'); const result = await idempotent(c, a, input, db => launchCampaign(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); wake(c.env); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/schedule', operationId: 'scheduleCampaign', tags: ['Campaigns'], security, request: { params: IdParams, body: json(CampaignSchedule) }, responses: { 202: response(CampaignQueued), ...errors } }), async c => {
    const a = actor(c, 'send'); const input = c.req.valid('json');
    const result = await idempotent(c, a, input, db => launchCampaign(c.env, db, a, c.req.valid('param').id, input, c.get('requestId'))); wake(c.env); return c.json(CampaignQueued.parse(result), 202);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/campaigns/{id}/cancel', operationId: 'cancelCampaign', tags: ['Campaigns'], security, request: { params: IdParams }, responses: { 200: response(CampaignCanceled), ...errors } }), async c => {
    const a = actor(c, 'send'); const campaignId = c.req.valid('param').id;
    const result = await idempotent(c, a, {}, async db => { const row = await findCampaign(db, a, campaignId, true); if (row.status === 'completed') throw new ApiError(409, 'CAMPAIGN_ALREADY_DISPATCHED', 'This campaign has already finished dispatching.'); const canceled = await db.update(emails).set({ status: 'canceled', updatedAt: now() }).where(and(scope(emails, a), eq(emails.campaignId, campaignId), eq(emails.status, 'queued'))).returning({ id: emails.id }); const inFlight = await db.select({ id: emails.id }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, campaignId), inArray(emails.status, ['attempting', 'accepted', 'sent', 'delivered', 'acceptance_unknown']))); await db.update(campaigns).set({ status: 'canceled', updatedAt: now() }).where(campaignWhere(a, campaignId)); return { id: campaignId, status: 'canceled' as const, canceled: canceled.length, inFlight: inFlight.length }; });
    return c.json(CampaignCanceled.parse(result), 200);
  });
}

async function launchCampaign(runtime: Runtime, db: DbExecutor, a: Actor, campaignId: string, input: { reviewId: string; revision: number; scheduledAt?: string }, requestId?: string) {
  if (input.scheduledAt && (Date.parse(input.scheduledAt) <= Date.now() || Date.parse(input.scheduledAt) > Date.now() + 365 * 86400000)) throw new ApiError(422, 'INVALID_SCHEDULE', 'Schedule between now and one year from now.');
  const row = await findCampaign(db, a, campaignId, true); editable(row, input.revision);
  if (row.reviewId !== input.reviewId || row.status !== 'reviewed') throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'Review the current campaign revision before sending.');
  const [review] = await db.select().from(campaignReviews).where(and(scope(campaignReviews, a), eq(campaignReviews.id, input.reviewId), eq(campaignReviews.campaignId, campaignId), eq(campaignReviews.revision, row.revision)));
  if (!review) throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'The selected review is no longer current.');
  if (review.contentHash !== await digest(canonical({ draft: review.draft, recipients: review.recipients }))) throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'The reviewed content or recipients changed; review the campaign again.');
  sender(runtime, a, review.draft.from, review.draft.region);
  const lockedAttachments = await attachmentRows(db, a, review.draft.attachments, true);
  for (const contact of review.recipients) await queueEmail(db, a, await campaignMessage(runtime, db, a, review.draft, contact, false, false, lockedAttachments), campaignId, input.scheduledAt, requestId, lockedAttachments);
  const status = input.scheduledAt ? 'scheduled' as const : 'sending' as const;
  await db.update(campaigns).set({ status, scheduledAt: input.scheduledAt ?? null, updatedAt: now() }).where(campaignWhere(a, campaignId));
  return { id: campaignId, status, queued: review.recipients.length, scheduledAt: input.scheduledAt ?? null, simulated: a.environment === 'test' };
}
async function bytesDigest(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), n => n.toString(16).padStart(2, '0')).join(''); }

const statusForEvent: Record<string, EmailStatus> = { send: 'sent', delivery: 'delivered', bounce: 'bounced', complaint: 'complained', reject: 'rejected', rendering_failure: 'rendering_failed', delivery_delay: 'delayed', accepted: 'accepted', suppressed: 'suppressed', acceptance_unknown: 'acceptance_unknown', simulated: 'simulated' };
const rank: Record<EmailStatus, number> = { queued: 0, attempting: 1, acceptance_unknown: 2, accepted: 3, sent: 4, delayed: 4, delivered: 5, bounced: 6, complained: 7, rejected: 6, rendering_failed: 6, suppressed: 6, canceled: 6, simulated: 6 };
export async function recordEmailEvent(runtime: Runtime, input: { workspaceId: string; environment: Mode; emailId: string; type: string; providerId?: string; data?: Record<string, unknown>; externalId?: string; createdAt?: string }) {
  const eventId = id('event');
  const result = await runtime.db.transaction(async db => {
    const [mail] = await db.select().from(emails).where(mailWhere(input, input.emailId)).for('update');
    if (!mail) return null;
    const [event] = await db.insert(emailEvents).values({ id: eventId, workspaceId: input.workspaceId, environment: input.environment, emailId: input.emailId, type: input.type, providerId: input.providerId, externalId: input.externalId, data: input.data ?? {}, simulated: input.environment === 'test', createdAt: input.createdAt ?? now() }).onConflictDoNothing().returning();
    if (!event) return null;
    const next = statusForEvent[input.type];
    if (next && rank[next] >= rank[mail.status]) await db.update(emails).set({ status: next, ...(input.providerId ? { providerId: input.providerId } : {}), updatedAt: now() }).where(mailWhere(input, input.emailId));
    const publicType = ({ send: 'email.sent', delivery: 'email.delivered', bounce: 'email.bounced', complaint: 'email.complained', reject: 'email.rejected', rendering_failure: 'email.rendering_failed', delivery_delay: 'email.delivery_delayed', open: 'email.opened', click: 'email.clicked' } as Record<string, string>)[input.type];
    if (publicType) await enqueue(db, { type: 'operation.publish', workspaceId: input.workspaceId, environment: input.environment, payload: { event: { id: event.id, workspaceId: input.workspaceId, environment: input.environment, type: publicType, region: mail.region, createdAt: event.createdAt, data: { ...(input.data ?? {}), emailId: input.emailId, simulated: input.environment === 'test', ...(input.providerId ? { providerId: input.providerId } : {}) } } } });
    return event;
  });
  return result;
}
async function finishCampaign(runtime: Runtime, a: Actor, campaignId: string | null) {
  if (!campaignId) return;
  await runtime.db.transaction(async db => { const row = await findCampaign(db, a, campaignId, true); if (!['scheduled', 'sending'].includes(row.status)) return; const pending = await db.select({ id: emails.id }).from(emails).where(and(scope(emails, a), eq(emails.campaignId, campaignId), inArray(emails.status, ['queued', 'attempting']))).limit(1); if (!pending.length) await db.update(campaigns).set({ status: 'completed', updatedAt: now() }).where(campaignWhere(a, campaignId)); });
}
async function reserveQuota(runtime: Runtime, a: Actor, selectedRegion: string, recipients: number, ses: SESv2Client): Promise<string | null> {
  return runtime.db.transaction(async db => {
    const identity = { workspaceId: a.workspaceId, environment: a.environment, region: selectedRegion };
    await db.insert(regionalLimits).values(identity).onConflictDoNothing();
    const where = and(scope(regionalLimits, a), eq(regionalLimits.region, selectedRegion));
    const [stored] = await db.select().from(regionalLimits).where(where).for('update');
    if (!stored) throw new ApiError(503, 'QUOTA_GATE_UNAVAILABLE', 'The regional quota gate is unavailable.', undefined, true);
    let gate = stored;
    if (!gate.checkedAt || Date.parse(gate.checkedAt) < Date.now() - 60000) {
      const account = await ses.send(new GetAccountCommand({}));
      const quota = account.SendQuota;
      if (!account.SendingEnabled || !quota || !quota.MaxSendRate || quota.Max24HourSend === undefined || quota.SentLast24Hours === undefined) throw new ApiError(503, 'SES_SENDING_NOT_READY', 'SES sending is disabled or regional quota information is unavailable.', undefined, true);
      gate = { ...gate, maxSendRate: quota.MaxSendRate, max24HourSend: quota.Max24HourSend, sentLast24Hours: quota.SentLast24Hours, reserved: 0, checkedAt: now() };
      await db.update(regionalLimits).set({ maxSendRate: gate.maxSendRate, max24HourSend: gate.max24HourSend, sentLast24Hours: gate.sentLast24Hours, reserved: 0, checkedAt: gate.checkedAt }).where(where);
    }
    if (gate.max24HourSend >= 0 && gate.sentLast24Hours + gate.reserved + recipients > gate.max24HourSend) return new Date(Date.now() + 60000).toISOString();
    if (gate.nextAllowedAt && Date.parse(gate.nextAllowedAt) > Date.now()) return gate.nextAllowedAt;
    await db.update(regionalLimits).set({ reserved: gate.reserved + recipients, nextAllowedAt: new Date(Date.now() + Math.ceil(1000 * recipients / gate.maxSendRate)).toISOString() }).where(where);
    return null;
  });
}
async function deferDispatch(runtime: Runtime, a: Actor, mail: typeof emails.$inferSelect, payload: Record<string, unknown>, availableAt: string, attempted = false) {
  await runtime.db.transaction(async db => {
    const changed = await db.update(emails).set({ status: 'queued', dispatchVersion: mail.dispatchVersion + 1, ...(attempted ? { attemptStartedAt: null, errorCode: 'SES_THROTTLED' } : {}), updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, attempted ? 'attempting' : 'queued'), eq(emails.dispatchVersion, mail.dispatchVersion))).returning();
    if (changed.length) await enqueue(db, { type: 'email.dispatch', workspaceId: a.workspaceId, environment: a.environment, payload: { ...payload, version: mail.dispatchVersion + 1 }, availableAt });
  });
}
const dispatch: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.emailId !== 'string') throw new ApiError(422, 'INVALID_JOB', 'Email dispatch requires emailId.');
  const a: Actor = { workspaceId: job.workspaceId, environment: job.environment, keyId: 'worker', domains: [], permissions: ['manage'] };
  let mail = await findEmail(runtime.db, a, payload.emailId);
  if (mail.dispatchVersion !== (payload.version ?? 0)) return;
  if (mail.status === 'attempting') {
    // A previous lease died after recording attempt start. SES has no idempotency token: never automatically resend.
    await runtime.db.update(emails).set({ status: 'acceptance_unknown', errorCode: 'INTERRUPTED_PROVIDER_ATTEMPT', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'attempting')));
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'acceptance_unknown', externalId: `attempt-unknown:${mail.id}` });
    await finishCampaign(runtime, a, mail.campaignId); return;
  }
  if (mail.status !== 'queued') return;
  if (mail.scheduledAt && Date.parse(mail.scheduledAt) > Date.now()) throw new ApiError(409, 'DISPATCH_NOT_DUE', 'The scheduled dispatch is not due.', undefined, true);
  const s = mail.snapshot;
  // Resolve storage and credentials BEFORE claiming a provider attempt; these failures cannot have sent email.
  const parts: Attachment[] = [];
  const rows = await attachmentRows(runtime.db, a, s.attachments);
  if (a.environment === 'live') for (const row of rows) { const asset = await runtime.storage.get(row.storageKey); if (!asset || asset.body.length !== row.size || await bytesDigest(asset.body) !== row.checksum) throw new ApiError(503, 'ATTACHMENT_STORAGE_UNAVAILABLE', 'An immutable attachment is missing or changed.', undefined, true); parts.push({ FileName: row.filename, RawContent: asset.body, ContentType: row.contentType, ContentDisposition: row.disposition === 'inline' ? 'INLINE' : 'ATTACHMENT', ContentTransferEncoding: 'BASE64', ...(row.contentId ? { ContentId: row.contentId } : {}) }); }
  sizeCheck(s, rows);
  const ses = a.environment === 'live' ? getSes(runtime, s.region) : null;
  // Check every destination and cancel the whole message, avoiding accidental exposure via a partially filtered Cc list.
  let blocked = false;
  for (const recipient of [...s.to, ...s.cc, ...s.bcc]) if (await isSuppressed(runtime, a, recipient) || (s.kind === 'marketing' && !await canMarket(runtime, a, recipient))) { blocked = true; break; }
  if (blocked) {
    const changed = await runtime.db.update(emails).set({ status: 'suppressed', errorCode: 'RECIPIENT_INELIGIBLE', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'queued'))).returning();
    if (changed.length) await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'suppressed', externalId: `suppressed:${mail.id}` });
    await finishCampaign(runtime, a, mail.campaignId); return;
  }
  if (ses) { const availableAt = await reserveQuota(runtime, a, s.region, s.to.length + s.cc.length + s.bcc.length, ses); if (availableAt) { await deferDispatch(runtime, a, mail, payload, availableAt); return; } }
  const claimed = await runtime.db.transaction(async db => {
    if (mail.campaignId) { const campaign = await findCampaign(db, a, mail.campaignId, true); if (campaign.status === 'canceled') return []; if (campaign.status === 'scheduled') await db.update(campaigns).set({ status: 'sending', updatedAt: now() }).where(campaignWhere(a, mail.campaignId)); }
    const destinations = [...s.to, ...s.cc, ...s.bcc].map(email => email.toLowerCase());
    const consent = await db.select().from(contacts).where(and(scope(contacts, a), inArray(contacts.email, destinations))).orderBy(asc(contacts.id)).for('update');
    const eligible = destinations.every(email => { const contact = consent.find(row => row.email === email); return !contact?.suppressed && (s.kind !== 'marketing' || (!!contact && !contact.deletedAt && contact.marketingConsent === 'subscribed')); });
    // Consent and the durable attempt claim share a transaction. Opt-outs after this boundary cannot recall an in-flight request.
    const changed = await db.update(emails).set(eligible ? { status: 'attempting', attemptStartedAt: now(), updatedAt: now() } : { status: 'suppressed', errorCode: 'RECIPIENT_INELIGIBLE', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'queued'), eq(emails.dispatchVersion, mail.dispatchVersion))).returning();
    if (eligible && changed.length) await db.insert(emailEvents).values({ id: id('event'), workspaceId: a.workspaceId, environment: a.environment, emailId: mail.id, type: 'dispatch_attempt', externalId: `attempt-start:${mail.id}:${mail.dispatchVersion}`, simulated: a.environment === 'test', data: { attempt: mail.dispatchVersion + 1, providerCallPlanned: a.environment === 'live' } }).onConflictDoNothing();
    return changed;
  });
  if (!claimed.length) return;
  mail = claimed[0]!;
  if (mail.status === 'suppressed') { await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'suppressed', externalId: `suppressed:${mail.id}` }); await finishCampaign(runtime, a, mail.campaignId); return; }
  if (!ses) {
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'simulated', externalId: `simulated:${mail.id}`, data: { stage: 'validated', providerCalled: false, deliveryObserved: false } });
    await finishCampaign(runtime, a, mail.campaignId); return;
  }
  const request: SendEmailCommandInput = { FromEmailAddress: s.from, Destination: { ToAddresses: s.to, CcAddresses: s.cc, BccAddresses: s.bcc }, ReplyToAddresses: s.replyTo,
    ConfigurationSetName: runtime.config.configurationSets[s.kind], EmailTags: [{ Name: 'opensend_email_id', Value: mail.id }, { Name: 'opensend_workspace_id', Value: a.workspaceId }],
    ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED', ClickTrackingEnabled: s.tracking ? 'ENABLED' : 'DISABLED' } },
    Content: s.raw ? { Raw: { Data: new TextEncoder().encode(s.raw) } } : { Simple: { Subject: { Data: s.subject, Charset: 'UTF-8' }, Body: { ...(s.html ? { Html: { Data: s.html, Charset: 'UTF-8' } } : {}), ...(s.text ? { Text: { Data: s.text, Charset: 'UTF-8' } } : {}) }, Headers: s.headers, Attachments: parts } },
  };
  let providerId: string | undefined;
  try { const result = await ses.send(new SendEmailCommand(request)); providerId = result.MessageId; }
  catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = failure.$metadata?.httpStatusCode;
    const providerRetries = typeof payload.providerRetries === 'number' ? payload.providerRetries : 0;
    if (status === 429 && providerRetries < 5) {
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'provider_throttled', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: 'SES_THROTTLED', retryable: true, attempt: providerRetries + 1 } });
      await deferDispatch(runtime, a, mail, { ...payload, providerRetries: providerRetries + 1 }, new Date(Date.now() + Math.min(60000, 2000 * 2 ** providerRetries)).toISOString(), true);
      return;
    }
    const definitive = status !== undefined && status >= 400 && status < 500;
    const next: EmailStatus = definitive ? 'rejected' : 'acceptance_unknown';
    await runtime.db.update(emails).set({ status: next, errorCode: definitive ? (failure.name ?? 'SES_REJECTED') : 'SES_ACCEPTANCE_UNKNOWN', updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'attempting')));
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: definitive ? 'reject' : 'acceptance_unknown', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: definitive ? failure.name ?? 'SES_REJECTED' : 'SES_ACCEPTANCE_UNKNOWN', retryable: false } });
    await finishCampaign(runtime, a, mail.campaignId); return;
  }
  if (!providerId) {
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'acceptance_unknown', externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}`, data: { code: 'SES_MESSAGE_ID_MISSING' } });
  } else {
    await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'accepted', providerId, externalId: `attempt-result:${mail.id}:${mail.dispatchVersion}` });
  }
  await finishCampaign(runtime, a, mail.campaignId);
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
      await finishCampaign(runtime, a, mail.campaignId); return;
    }
    if (mail.status === 'queued') {
      const failure = error instanceof ApiError ? error : new ApiError(503, 'DISPATCH_PREFLIGHT_FAILED', 'A dispatch dependency failed before the provider attempt.', undefined, true);
      // The handler and queue must agree about terminal failure.
      if (failure.retryable && job.attempts < MAX_ATTEMPTS) throw failure;
      await runtime.db.update(emails).set({ status: 'rejected', errorCode: failure.code, updatedAt: now() }).where(and(mailWhere(a, mail.id), eq(emails.status, 'queued')));
      await recordEmailEvent(runtime, { ...a, emailId: mail.id, type: 'reject', externalId: `preflight-failed:${mail.id}`, data: { code: failure.code, providerCalled: false } });
    }
    await finishCampaign(runtime, a, mail.campaignId);
  }
};
export const jobHandlers: Record<string, JobHandler> = { 'email.dispatch': guardedDispatch };
