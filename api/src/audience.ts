import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actor, ApiError, errors, id, IdParams, json, notFound, page, PageQuery, response, security, type Actor, type App, type DbExecutor, type Mode, type Runtime } from './core.js';
import { contacts, consentAudit, imports, listMembers, lists, segments, type ImportError, type ImportRow, type SegmentRule } from './db/audience.js';
import { enqueue } from './jobs.js';

const Email = z.string().trim().email().max(320).transform(v => v.toLowerCase());
const Properties = z.record(z.string().min(1).max(80), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 50, 'At most 50 properties are supported.');
const ContactInput = z.object({ email: Email, name: z.string().trim().max(200).optional(), properties: Properties.default({}) }).strict();
const ContactPatch = z.object({ name: z.string().trim().max(200).nullable().optional(), properties: Properties.optional() }).strict();
const Scope = { workspaceId: z.string(), environment: z.enum(['live', 'test']) };
const Dates = { createdAt: z.string(), updatedAt: z.string() };
const Contact = z.object({ id: z.string(), ...Scope, email: z.string(), name: z.string().nullable(), properties: Properties, marketingConsent: z.enum(['unknown', 'subscribed', 'unsubscribed']), suppressed: z.boolean(), suppressionReason: z.string().nullable(), lastOpenAt: z.string().nullable(), lastClickAt: z.string().nullable(), observedSince: z.string().nullable(), openObservedSince: z.string().nullable(), clickObservedSince: z.string().nullable(), deletedAt: z.string().nullable(), ...Dates }).openapi('Contact');
const ListInput = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).default('') }).strict();
const List = ListInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('ContactList');
const ContactRead = Contact.extend({ listIds: z.array(z.string()) }).openapi('ContactRead');
const ListCounts = z.object({ total: z.number().int(), subscribed: z.number().int(), unsubscribed: z.number().int(), unknown: z.number().int(), suppressed: z.number().int() }).describe('Active members only. Suppressed takes precedence over consent; subscribed, unsubscribed, unknown and suppressed are mutually exclusive and sum to total.');
const ListRead = z.object({ ...List.shape, counts: ListCounts }).strict().openapi('ContactListRead');
const SearchQuery = PageQuery.extend({ search: z.string().trim().min(1).max(200).optional() });
const ContactQuery = SearchQuery.extend({ consent: z.enum(['unknown', 'subscribed', 'unsubscribed']).optional(), suppressed: z.enum(['true', 'false']).optional(), listId: z.string().min(1).max(120).optional() }).openapi('ListContactsQuery');
const RuleLeaf = z.union([z.object({ field: z.enum(['email', 'firstName', 'plan', 'country']), operator: z.enum(['eq', 'neq', 'contains']), value: z.string().max(200) }).strict(), z.object({ field: z.enum(['lastOpenAt', 'lastClickAt']), operator: z.enum(['within', 'inactive']), days: z.number().int().min(1).max(730) }).strict()]);
// Finite-depth schemas remain fully representable in OpenAPI; no recursive lazy schema.
let ruleSchema: z.ZodType<SegmentRule> = RuleLeaf;
for (let depth = 0; depth < 3; depth++) ruleSchema = z.union([RuleLeaf, z.object({ operator: z.enum(['and', 'or']), rules: z.array(ruleSchema).min(1).max(10) }).strict()]);
function ruleSize(rule: SegmentRule): number { return 'rules' in rule ? 1 + rule.rules.reduce((n, child) => n + ruleSize(child), 0) : 1; }
const Rule = ruleSchema.refine(v => ruleSize(v) <= 50, 'A segment supports at most 50 rules and three nested groups.').openapi('SegmentRule');
const SegmentInput = z.object({ name: z.string().trim().min(1).max(200), rule: Rule }).strict();
const Segment = SegmentInput.extend({ id: z.string(), ...Scope, ...Dates }).openapi('Segment');
export const AudienceSpec = z.object({ listId: z.string().min(1).max(120), segmentId: z.string().min(1).max(120).optional(), excludeListIds: z.array(z.string().min(1).max(120)).max(20).optional(), excludeSegmentIds: z.array(z.string().min(1).max(120)).max(20).optional() }).strict();
const Counts = z.object({ matched: z.number().int(), eligible: z.number().int(), suppressed: z.number().int(), unsubscribed: z.number().int() });
const Deleted = z.object({ id: z.string(), deleted: z.literal(true) });
const Audit = z.object({ id: z.string(), ...Scope, contactId: z.string(), email: z.string(), status: z.enum(['subscribed', 'unsubscribed']), source: z.string(), policyVersion: z.string().nullable(), evidence: z.string().nullable(), actorKeyId: z.string().nullable(), occurredAt: z.string(), createdAt: z.string() });
const ConsentInput = z.object({ status: z.enum(['subscribed', 'unsubscribed']), source: z.string().trim().min(1).max(200).optional(), policyVersion: z.string().trim().min(1).max(120).optional(), evidence: z.string().trim().min(1).max(2000).optional(), occurredAt: z.string().datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 60000, 'Consent cannot occur in the future.').optional(), confirmResubscribe: z.boolean().default(false) }).strict();
const ImportRowSchema = z.object({ row: z.number().int(), email: z.string(), name: z.string().optional(), properties: Properties });
const ImportErrorSchema = z.object({ row: z.number().int(), field: z.string(), message: z.string() });
const Import = z.object({ id: z.string(), ...Scope, listId: z.string().nullable(), status: z.enum(['preview', 'committed']), rows: z.array(ImportRowSchema), errors: z.array(ImportErrorSchema), imported: z.number().int(), ...Dates }).openapi('AudienceImport');
const ImportInput = z.object({ csv: z.string().min(1).max(1048576), listId: z.string().min(1).max(120).optional(), mapping: z.object({ email: z.string().min(1).max(200), name: z.string().min(1).max(200).optional(), firstName: z.string().min(1).max(200).optional(), plan: z.string().min(1).max(200).optional(), country: z.string().min(1).max(200).optional() }).strict() }).strict();

function scope(table: { workspaceId: AnyPgColumn; environment: AnyPgColumn }, identity: Pick<Actor, 'workspaceId' | 'environment'>) { return and(eq(table.workspaceId, identity.workspaceId), eq(table.environment, identity.environment))!; }
function scopeValues(identity: Pick<Actor, 'workspaceId' | 'environment'>) { return { workspaceId: identity.workspaceId, environment: identity.environment }; }
function paginate<T extends { id: string }>(rows: T[], limit: number) { return { data: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }; }
async function findContact(db: DbExecutor, identity: Actor, contactId: string) { const [row] = await db.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1); return row ?? notFound('Contact'); }
async function findList(db: DbExecutor, identity: Actor, listId: string) { const [row] = await db.select().from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1); return row ?? notFound('List'); }
async function findSegment(db: DbExecutor, identity: Actor, segmentId: string) { const [row] = await db.select().from(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).limit(1); return row ?? notFound('Segment'); }

// Literal substring search: %, _ and backslash have no wildcard meaning.
function searchText(column: AnyPgColumn, search: string): SQL { return sql`strpos(lower(${column}), lower(${search})) > 0`; }
function contactFilters(identity: Actor, query: z.infer<typeof ContactQuery>) {
  return [query.search ? sql`(${searchText(contacts.email, query.search)} OR ${searchText(contacts.name, query.search)})` : undefined, query.consent ? eq(contacts.marketingConsent, query.consent) : undefined, query.suppressed !== undefined ? eq(contacts.suppressed, query.suppressed === 'true') : undefined, query.listId ? inList(identity, query.listId) : undefined];
}
async function readContacts(db: DbExecutor, identity: Actor, rows: Array<typeof contacts.$inferSelect>) {
  if (!rows.length) return [];
  const memberships = await db.select({ contactId: listMembers.contactId, listId: listMembers.listId }).from(listMembers).innerJoin(lists, and(eq(lists.id, listMembers.listId), eq(lists.workspaceId, listMembers.workspaceId), eq(lists.environment, listMembers.environment))).where(and(scope(listMembers, identity), scope(lists, identity), inArray(listMembers.contactId, rows.map(row => row.id)))).orderBy(asc(listMembers.listId));
  const byContact = new Map<string, string[]>();
  for (const member of memberships) { const ids = byContact.get(member.contactId) ?? []; ids.push(member.listId); byContact.set(member.contactId, ids); }
  return rows.map(row => ({ ...row, listIds: byContact.get(row.id) ?? [] }));
}
async function readLists(db: DbExecutor, identity: Actor, rows: Array<typeof lists.$inferSelect>) {
  if (!rows.length) return [];
  const totals = await db.select({ listId: listMembers.listId, total: sql<number>`count(*)::int`, subscribed: sql<number>`count(*) FILTER (WHERE NOT ${contacts.suppressed} AND ${contacts.marketingConsent} = 'subscribed')::int`, unsubscribed: sql<number>`count(*) FILTER (WHERE NOT ${contacts.suppressed} AND ${contacts.marketingConsent} = 'unsubscribed')::int`, unknown: sql<number>`count(*) FILTER (WHERE NOT ${contacts.suppressed} AND ${contacts.marketingConsent} = 'unknown')::int`, suppressed: sql<number>`count(*) FILTER (WHERE ${contacts.suppressed})::int` }).from(listMembers).innerJoin(contacts, and(eq(contacts.id, listMembers.contactId), eq(contacts.workspaceId, listMembers.workspaceId), eq(contacts.environment, listMembers.environment))).where(and(scope(listMembers, identity), scope(contacts, identity), isNull(contacts.deletedAt), inArray(listMembers.listId, rows.map(row => row.id)))).groupBy(listMembers.listId);
  const byList = new Map(totals.map(({ listId, ...counts }) => [listId, counts]));
  return rows.map(row => ({ ...row, counts: byList.get(row.id) ?? { total: 0, subscribed: 0, unsubscribed: 0, unknown: 0, suppressed: 0 } }));
}

export function compileRule(rule: SegmentRule): SQL { return sql`coalesce((${compileRuleCondition(rule)}), false)`; }
function compileRuleCondition(rule: SegmentRule): SQL {
  if ('rules' in rule) return sql`(${sql.join(rule.rules.map(compileRule), rule.operator === 'and' ? sql` AND ` : sql` OR `)})`;
  if ('days' in rule) {
    const cutoff = new Date(Date.now() - rule.days * 86400000).toISOString();
    const timestamp = rule.field === 'lastOpenAt' ? contacts.lastOpenAt : contacts.lastClickAt;
    const coverage = rule.field === 'lastOpenAt' ? contacts.openObservedSince : contacts.clickObservedSince;
    return rule.operator === 'within' ? sql`${timestamp} >= ${cutoff}::timestamptz` : sql`(${coverage} <= ${cutoff}::timestamptz AND (${timestamp} IS NULL OR ${timestamp} < ${cutoff}::timestamptz))`;
  }
  const field = rule.field === 'email' ? sql`${contacts.email}` : sql`(${contacts.properties} ->> ${rule.field})`;
  const value = rule.field === 'email' ? rule.value.trim().toLowerCase() : rule.value;
  if (rule.operator === 'eq') return sql`${field} = ${value}`;
  if (rule.operator === 'neq') return sql`(${field} IS NOT NULL AND ${field} <> ${value})`;
  // strpos treats wildcard characters as literal text, never SQL syntax.
  return sql`strpos(lower(${field}), lower(${rule.value})) > 0`;
}
// Keep the full membership-key probe correlated even immediately after a large import,
// before PostgreSQL has analyzed the new row distribution.
function inList(identity: Actor, listId: string): SQL { return sql`EXISTS (SELECT 1 FROM ${listMembers} WHERE ${scope(listMembers, identity)} AND ${listMembers.listId} = ${listId} AND ${listMembers.contactId} = ${contacts.id} OFFSET 0)`; }
function counts(rows: Array<typeof contacts.$inferSelect>) {
  const suppressed = rows.filter(c => c.suppressed).length;
  const unsubscribed = rows.filter(c => !c.suppressed && c.marketingConsent !== 'subscribed').length;
  return { matched: rows.length, eligible: rows.length - suppressed - unsubscribed, suppressed, unsubscribed };
}
async function boundedContacts(db: DbExecutor, identity: Actor, conditions: SQL[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ApiError(422, 'AUDIENCE_LIMIT_INVALID', 'Audience limits must be between 1 and 1000.');
  const rows = await db.select().from(contacts).where(and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)).orderBy(asc(contacts.id)).limit(limit + 1);
  if (rows.length > limit) throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', `This deployment supports at most ${limit} matching contacts per preview or campaign. Narrow the audience; no contacts were silently truncated.`);
  return rows;
}
export interface AudienceResult { contacts: Array<{ id: string; email: string; name?: string; properties: Record<string, unknown> }>; matched: number; eligible: number; suppressed: number; unsubscribed: number; }
export async function getAudience(runtime: Runtime, identity: Actor, spec: z.infer<typeof AudienceSpec>, limit = 1000, db: DbExecutor = runtime.db): Promise<AudienceResult> {
  const parsed = AudienceSpec.safeParse(spec);
  if (!parsed.success) throw new ApiError(422, 'INVALID_AUDIENCE', 'The audience specification is invalid.');
  spec = parsed.data;
  await findList(db, identity, spec.listId);
  const conditions = [inList(identity, spec.listId)];
  if (spec.segmentId) conditions.push(compileRule((await findSegment(db, identity, spec.segmentId)).rule));
  for (const listId of spec.excludeListIds ?? []) { await findList(db, identity, listId); conditions.push(sql`NOT (${inList(identity, listId)})`); }
  for (const segmentId of spec.excludeSegmentIds ?? []) conditions.push(sql`NOT (${compileRule((await findSegment(db, identity, segmentId)).rule)})`);
  const rows = await boundedContacts(db, identity, conditions, limit);
  return { ...counts(rows), contacts: rows.filter(c => !c.suppressed && c.marketingConsent === 'subscribed').map(c => ({ id: c.id, email: c.email, ...(c.name ? { name: c.name } : {}), properties: c.properties })) };
}
// One INSERT ... SELECT captures membership, consent and only referenced personalization values.
// Keyset-paging the live audience across transactions would not be a review snapshot.
export async function snapshotCampaignAudience(db: DbExecutor, identity: Actor, spec: z.infer<typeof AudienceSpec>, reviewId: string, propertyKeys: string[]) {
  const listIds = [...new Set([spec.listId, ...(spec.excludeListIds ?? [])])].sort();
  const segmentIds = [...new Set([...(spec.segmentId ? [spec.segmentId] : []), ...(spec.excludeSegmentIds ?? [])])].sort();
  const lockedLists = await db.select({ id: lists.id }).from(lists).where(and(scope(lists, identity), inArray(lists.id, listIds))).orderBy(asc(lists.id)).for('share');
  if (lockedLists.length !== listIds.length) notFound('List');
  const lockedSegments = segmentIds.length ? await db.select().from(segments).where(and(scope(segments, identity), inArray(segments.id, segmentIds))).orderBy(asc(segments.id)).for('share') : [];
  if (lockedSegments.length !== segmentIds.length) notFound('Segment');
  const conditions = [inList(identity, spec.listId)];
  if (spec.segmentId) conditions.push(compileRule(lockedSegments.find(row => row.id === spec.segmentId)!.rule));
  for (const listId of spec.excludeListIds ?? []) conditions.push(sql`NOT (${inList(identity, listId)})`);
  for (const segmentId of spec.excludeSegmentIds ?? []) conditions.push(sql`NOT (${compileRule(lockedSegments.find(row => row.id === segmentId)!.rule)})`);
  const result = await db.execute<{ matched: number; eligible: number; suppressed: number; unsubscribed: number; bytes: string; captured: number }>(sql`
    WITH matched AS MATERIALIZED (
      SELECT ${contacts.id} AS id, ${contacts.email} AS email, CASE WHEN ${propertyKeys.includes('name')} THEN ${contacts.name} END AS name,
        ${contacts.suppressed} AS suppressed, ${contacts.marketingConsent} AS consent,
        coalesce((SELECT jsonb_object_agg(p.key, p.value) FROM jsonb_each(${contacts.properties}) p
          WHERE p.key IN (SELECT jsonb_array_elements_text(${JSON.stringify(propertyKeys)}::jsonb))), '{}'::jsonb) AS properties
      FROM ${contacts} WHERE ${and(scope(contacts, identity), isNull(contacts.deletedAt), ...conditions)}
      ORDER BY ${contacts.id} LIMIT 1000001
    ), eligible AS (
      SELECT row_number() OVER (ORDER BY id ROWS UNBOUNDED PRECEDING)::int AS ordinal,
        jsonb_strip_nulls(jsonb_build_object('id', id, 'email', email, 'name', nullif(name, ''), 'properties', properties)) AS recipient
      FROM matched WHERE NOT suppressed AND consent = 'subscribed'
    ), sized AS (
      SELECT *, octet_length(recipient::text) AS bytes,
        sum(octet_length(recipient::text)) OVER (ORDER BY ordinal ROWS UNBOUNDED PRECEDING) AS running_bytes FROM eligible
    ), captured AS (
      INSERT INTO sending_review_recipients(review_id, ordinal, recipient, recipient_bytes)
      SELECT ${reviewId}, ordinal, recipient, bytes FROM sized WHERE bytes <= 1048576 AND running_bytes <= 1073741824
      RETURNING recipient_bytes
    ) SELECT count(*)::int AS matched,
      count(*) FILTER (WHERE NOT suppressed AND consent = 'subscribed')::int AS eligible,
      count(*) FILTER (WHERE suppressed)::int AS suppressed,
      count(*) FILTER (WHERE NOT suppressed AND consent <> 'subscribed')::int AS unsubscribed,
      (SELECT count(*)::int FROM captured) AS captured,
      (SELECT coalesce(sum(recipient_bytes), 0)::bigint FROM captured) AS bytes FROM matched`);
  const row = result.rows[0]!;
  if (row.matched > 1000000) throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaign reviews support at most 1,000,000 matching contacts. No recipients were truncated.');
  if (row.captured !== row.eligible) throw new ApiError(413, 'CAMPAIGN_RECIPIENT_DATA_TOO_LARGE', 'Referenced personalization exceeds 1 GiB per review or 1 MiB per recipient.');
  if (!row.eligible) throw new ApiError(422, 'EMPTY_AUDIENCE', 'This campaign has no eligible subscribed recipients.');
  return { matched: row.matched, eligible: row.eligible, suppressed: row.suppressed, unsubscribed: row.unsubscribed, recipientBytes: Number(row.bytes) };
}
export async function isSuppressed(runtime: Runtime, identity: Actor, email: string): Promise<boolean> {
  const [row] = await runtime.db.select({ suppressed: contacts.suppressed }).from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email.trim().toLowerCase()))).limit(1);
  return row?.suppressed ?? false;
}
export async function canMarket(runtime: Runtime, identity: Actor, email: string): Promise<boolean> {
  const [row] = await runtime.db.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, email.trim().toLowerCase()))).limit(1);
  return !!row && !row.deletedAt && !row.suppressed && row.marketingConsent === 'subscribed';
}
export async function recordUnsubscribe(runtime: Runtime, workspaceId: string, environment: Mode, email: string, source: 'footer-get' | 'rfc8058-post' | 'ses-subscription' = 'footer-get'): Promise<{ contactId: string; changed: boolean }> {
  const normalized = Email.safeParse(email);
  if (!normalized.success) throw new ApiError(422, 'INVALID_EMAIL', 'A valid email address is required.');
  return runtime.db.transaction(async tx => {
    const identity = { workspaceId, environment };
    await tx.insert(contacts).values({ id: id('con'), ...identity, email: normalized.data }).onConflictDoNothing({ target: [contacts.workspaceId, contacts.environment, contacts.email] });
    const [contact] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.email, normalized.data))).limit(1).for('update');
    if (!contact) throw new ApiError(500, 'CONSENT_WRITE_FAILED', 'Unable to persist consent.');
    if (contact.marketingConsent === 'unsubscribed') return { contactId: contact.id, changed: false };
    const now = new Date().toISOString();
    await tx.update(contacts).set({ marketingConsent: 'unsubscribed', updatedAt: now }).where(and(scope(contacts, identity), eq(contacts.id, contact.id)));
    const auditId = id('cns');
    const evidence = source === 'ses-subscription' ? 'Signed SES subscription event reported unsubscribeAll for a single-recipient email.' : source === 'rfc8058-post' ? 'POST request presented a valid one-click unsubscribe token; no human identity asserted.' : 'GET request presented a valid footer unsubscribe token; no human identity asserted.';
    await tx.insert(consentAudit).values({ id: auditId, ...identity, contactId: contact.id, email: normalized.data, status: 'unsubscribed', source, evidence, actorKeyId: null, occurredAt: now });
    await enqueue(tx, { type: 'operation.publish', ...identity, payload: { event: { id: auditId, type: 'contact.subscription_changed', createdAt: now, ...identity, region: null, data: { contactId: contact.id, status: 'unsubscribed', source } } } });
    return { contactId: contact.id, changed: true };
  });
}

// Adapted from app/src/features/audience/csv.ts: quoted fields, escaped quotes, CRLF and BOM.
function parseCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > 1048576) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 1 MiB and 1000 contact rows.');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, endedQuote = false;
  const input = text.replace(/^\uFEFF/, '');
  const finishRow = () => { row.push(cell); if (row.some(value => value.trim())) rows.push(row); if (rows.length > 1001) throw new ApiError(413, 'IMPORT_TOO_LARGE', 'CSV imports are limited to 1000 contact rows.'); row = []; cell = ''; endedQuote = false; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) { if (char === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; endedQuote = true; } } else cell += char; continue; }
    if (char === '"') { if (cell || endedQuote) throw new ApiError(422, 'INVALID_CSV', 'Unexpected quote: quote the whole field and double embedded quotes.'); quoted = true; }
    else if (char === ',') { row.push(cell); cell = ''; endedQuote = false; if (row.length > 100) throw new ApiError(422, 'INVALID_CSV', 'At most 100 CSV columns are supported.'); }
    else if (char === '\n' || char === '\r') { if (char === '\r' && input[i + 1] === '\n') i++; finishRow(); }
    else if (endedQuote) { if (char !== ' ' && char !== '\t') throw new ApiError(422, 'INVALID_CSV', 'Unexpected text after a quoted field.'); } else cell += char;
  }
  if (quoted) throw new ApiError(422, 'INVALID_CSV', 'A quoted field has no closing quote.');
  finishRow();
  if (rows.length < 2) throw new ApiError(422, 'INVALID_CSV', 'Include a header and at least one contact row.');
  return rows;
}
function previewImport(input: z.infer<typeof ImportInput>) {
  const [headerRaw, ...data] = parseCsv(input.csv); const headers = headerRaw!.map(h => h.trim());
  if (new Set(headers).size !== headers.length || headers.some(h => !h)) throw new ApiError(422, 'INVALID_CSV_HEADERS', 'CSV headers must be nonempty and unique.');
  const mapping = Object.entries(input.mapping);
  for (const [field, column] of mapping) if (!headers.includes(column)) throw new ApiError(422, 'INVALID_IMPORT_MAPPING', `The mapped column for ${field} was not found.`, `mapping.${field}`);
  const rows: ImportRow[] = [], failures: ImportError[] = [], seen = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const values = data[i]!, row = i + 2;
    if (values.length !== headers.length) { failures.push({ row, field: 'row', message: 'The row has a different number of columns than the header.' }); continue; }
    const mapped = Object.fromEntries(mapping.map(([field, column]) => [field, values[headers.indexOf(column)]!.trim()]));
    const parsed = ContactInput.safeParse({ email: mapped.email, name: mapped.name, properties: Object.fromEntries(['firstName', 'plan', 'country'].filter(k => mapped[k] !== undefined).map(k => [k, mapped[k]])) });
    if (!parsed.success) { for (const issue of parsed.error.issues) failures.push({ row, field: issue.path.join('.'), message: issue.message }); continue; }
    if (seen.has(parsed.data.email)) { failures.push({ row, field: 'email', message: 'Duplicate normalized email within this import.' }); continue; }
    seen.add(parsed.data.email); rows.push({ row, ...parsed.data });
  }
  return { rows, errors: failures };
}

export function registerAudience(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts', operationId: 'listContacts', tags: ['Audience'], security, description: 'Active contacts with current list IDs. Search is a case-insensitive literal email/name substring. Consent and suppression filters are independent.', request: { query: ContactQuery }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query');
    if (query.listId) await findList(c.env.db, identity, query.listId);
    const rows = await c.env.db.select().from(contacts).where(and(scope(contacts, identity), isNull(contacts.deletedAt), ...contactFilters(identity, query), query.cursor ? gt(contacts.id, query.cursor) : undefined)).orderBy(asc(contacts.id)).limit(query.limit + 1);
    const result = paginate(rows, query.limit);
    return c.json({ ...result, data: await readContacts(c.env.db, identity, result.data) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts', operationId: 'createContact', tags: ['Audience'], security, request: { body: json(ContactInput) }, responses: { 201: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'manage'), input = c.req.valid('json');
    const [contact] = await c.env.db.insert(contacts).values({ id: id('con'), ...scopeValues(identity), ...input }).onConflictDoNothing({ target: [contacts.workspaceId, contacts.environment, contacts.email] }).returning();
    if (!contact) throw new ApiError(409, 'CONTACT_EXISTS', 'This address already has a contact or retained consent record. Use imports to restore a deleted contact without changing consent.');
    return c.json(contact, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}', operationId: 'getContact', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ContactRead), ...errors } }), async c => {
    const identity = actor(c), row = await findContact(c.env.db, identity, c.req.valid('param').id);
    return c.json((await readContacts(c.env.db, identity, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/contacts/{id}', operationId: 'updateContact', tags: ['Audience'], security, request: { params: IdParams, body: json(ContactPatch) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'manage'), contactId = c.req.valid('param').id; await findContact(c.env.db, identity, contactId);
    const [contact] = await c.env.db.update(contacts).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).returning();
    return c.json(contact ?? notFound('Contact'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/contacts/{id}', operationId: 'deleteContact', tags: ['Audience'], security, description: 'Remove contact profile and memberships, retaining minimal consent/suppression to prevent accidental re-enrollment.', request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), contactId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => {
      await findContact(tx, identity, contactId);
      await tx.update(contacts).set({ deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: null, properties: {} }).where(and(scope(contacts, identity), eq(contacts.id, contactId)));
      await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.contactId, contactId)));
    });
    return c.json({ id: contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contacts/{id}/consent', operationId: 'updateContactConsent', tags: ['Consent'], security, description: 'Set marketing subscription status. Source, policy version, evidence and occurrence time are optional audit context; OpenSend records the actor and current time when omitted. Does not lift delivery suppression. Imports/profile edits cannot establish consent.', request: { params: IdParams, body: json(ConsentInput) }, responses: { 200: response(Contact), ...errors } }), async c => {
    const identity = actor(c, 'manage'), contactId = c.req.valid('param').id, input = c.req.valid('json');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const source = input.source ?? (identity.credential === 'dashboard' ? 'dashboard' : identity.credential === 'mcp' ? 'mcp' : identity.credential === 'agentToken' ? 'agent-token' : 'api');
    const contact = await c.env.db.transaction(async tx => {
      const [existing] = await tx.select().from(contacts).where(and(scope(contacts, identity), eq(contacts.id, contactId), isNull(contacts.deletedAt))).limit(1).for('update');
      if (!existing) return notFound('Contact');
      if (existing.marketingConsent === 'unsubscribed' && input.status === 'subscribed' && !input.confirmResubscribe) throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'Explicitly confirm renewed verifiable consent to replace a prior opt-out.', 'confirmResubscribe');
      if (input.status === 'subscribed') {
        const [latest] = await tx.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId))).orderBy(sql`${consentAudit.occurredAt} DESC`).limit(1);
        if (latest && Date.parse(occurredAt) <= Date.parse(latest.occurredAt)) throw new ApiError(409, 'STALE_CONSENT', 'Renewed consent must be newer than the prior consent decision.');
      }
      const auditId = id('cns');
      await tx.insert(consentAudit).values({ id: auditId, ...scopeValues(identity), contactId, email: existing.email, status: input.status, source, policyVersion: input.policyVersion ?? null, evidence: input.evidence ?? null, occurredAt, actorKeyId: identity.keyId });
      if (existing.marketingConsent !== input.status) await enqueue(tx, { type: 'operation.publish', ...scopeValues(identity), payload: { event: { id: auditId, type: 'contact.subscription_changed', createdAt: new Date().toISOString(), ...scopeValues(identity), region: null, data: { contactId, status: input.status } } } });
      const [updated] = await tx.update(contacts).set({ marketingConsent: input.status, updatedAt: new Date().toISOString() }).where(and(scope(contacts, identity), eq(contacts.id, contactId))).returning();
      return updated!;
    }); return c.json(contact, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contacts/{id}/consent', operationId: 'listContactConsentEvents', tags: ['Consent'], security, request: { params: IdParams, query: PageQuery }, responses: { 200: response(page(Audit)), ...errors } }), async c => {
    const identity = actor(c), contactId = c.req.valid('param').id, query = c.req.valid('query'); await findContact(c.env.db, identity, contactId);
    const rows = await c.env.db.select().from(consentAudit).where(and(scope(consentAudit, identity), eq(consentAudit.contactId, contactId), query.cursor ? gt(consentAudit.id, query.cursor) : undefined)).orderBy(asc(consentAudit.id)).limit(query.limit + 1);
    return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists', operationId: 'listContactLists', tags: ['Audience'], security, request: { query: SearchQuery }, responses: { 200: response(page(ListRead)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select().from(lists).where(and(scope(lists, identity), query.search ? searchText(lists.name, query.search) : undefined, query.cursor ? gt(lists.id, query.cursor) : undefined)).orderBy(asc(lists.id)).limit(query.limit + 1);
    const result = paginate(rows, query.limit); return c.json({ ...result, data: await readLists(c.env.db, identity, result.data) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists', operationId: 'createContactList', tags: ['Audience'], security, request: { body: json(ListInput) }, responses: { 201: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(lists).values({ id: id('lst'), ...scopeValues(identity), ...c.req.valid('json') }).returning(); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}', operationId: 'getContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(ListRead), ...errors } }), async c => {
    const identity = actor(c), row = await findList(c.env.db, identity, c.req.valid('param').id);
    return c.json((await readLists(c.env.db, identity, [row]))[0]!, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: '/v1/lists/{id}', operationId: 'updateContactList', tags: ['Audience'], security, request: { params: IdParams, body: json(ListInput.partial()) }, responses: { 200: response(List), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(lists).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(lists, identity), eq(lists.id, c.req.valid('param').id))).returning(); return c.json(row ?? notFound('List'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}', operationId: 'deleteContactList', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id;
    await c.env.db.transaction(async tx => { const [row] = await tx.delete(lists).where(and(scope(lists, identity), eq(lists.id, listId))).returning(); if (!row) notFound('List'); await tx.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, listId))); }); return c.json({ id: listId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/lists/{id}/members', operationId: 'listListMembers', tags: ['Audience'], security, request: { params: IdParams, query: ContactQuery.omit({ listId: true }) }, responses: { 200: response(page(ContactRead)), ...errors } }), async c => {
    const identity = actor(c), listId = c.req.valid('param').id, query = c.req.valid('query'); await findList(c.env.db, identity, listId);
    const rows = await c.env.db.select().from(contacts).where(and(scope(contacts, identity), isNull(contacts.deletedAt), ...contactFilters(identity, { ...query, listId }), query.cursor ? gt(contacts.id, query.cursor) : undefined)).orderBy(asc(contacts.id)).limit(query.limit + 1);
    const result = paginate(rows, query.limit); return c.json({ ...result, data: await readContacts(c.env.db, identity, result.data) }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/lists/{id}/members', operationId: 'addListMembers', tags: ['Audience'], security, request: { params: IdParams, body: json(z.object({ contactIds: z.array(z.string().min(1).max(120)).min(1).max(100) }).strict()) }, responses: { 200: response(z.object({ added: z.number().int() })), ...errors } }), async c => {
    const identity = actor(c, 'manage'), listId = c.req.valid('param').id, contactIds = [...new Set(c.req.valid('json').contactIds)];
    const added = await c.env.db.transaction(async tx => { const [list] = await tx.select().from(lists).where(and(scope(lists, identity), eq(lists.id, listId))).limit(1).for('update'); if (!list) notFound('List'); for (const contactId of contactIds) await findContact(tx, identity, contactId); const result = await tx.insert(listMembers).values(contactIds.map(contactId => ({ ...scopeValues(identity), listId, contactId }))).onConflictDoNothing().returning(); return result.length; }); return c.json({ added }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/lists/{id}/members/{contactId}', operationId: 'removeListMember', tags: ['Audience'], security, request: { params: IdParams.extend({ contactId: z.string().min(1).max(120) }) }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), params = c.req.valid('param'); await findList(c.env.db, identity, params.id); await c.env.db.delete(listMembers).where(and(scope(listMembers, identity), eq(listMembers.listId, params.id), eq(listMembers.contactId, params.contactId))); return c.json({ id: params.contactId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments', operationId: 'listSegments', tags: ['Audience'], security, request: { query: SearchQuery }, responses: { 200: response(page(Segment)), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select().from(segments).where(and(scope(segments, identity), query.search ? searchText(segments.name, query.search) : undefined, query.cursor ? gt(segments.id, query.cursor) : undefined)).orderBy(asc(segments.id)).limit(query.limit + 1); return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments', operationId: 'createSegment', tags: ['Audience'], security, request: { body: json(SegmentInput) }, responses: { 201: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.insert(segments).values({ id: id('seg'), ...scopeValues(identity), ...c.req.valid('json') }).returning(); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/segments/{id}', operationId: 'getSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Segment), ...errors } }), async c => c.json(await findSegment(c.env.db, actor(c), c.req.valid('param').id), 200));
  app.openapi(createRoute({ method: 'patch', path: '/v1/segments/{id}', operationId: 'updateSegment', tags: ['Audience'], security, request: { params: IdParams, body: json(SegmentInput.partial()) }, responses: { 200: response(Segment), ...errors } }), async c => {
    const identity = actor(c, 'manage'); const [row] = await c.env.db.update(segments).set({ ...c.req.valid('json'), updatedAt: new Date().toISOString() }).where(and(scope(segments, identity), eq(segments.id, c.req.valid('param').id))).returning(); return c.json(row ?? notFound('Segment'), 200);
  });
  app.openapi(createRoute({ method: 'delete', path: '/v1/segments/{id}', operationId: 'deleteSegment', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Deleted), ...errors } }), async c => {
    const identity = actor(c, 'manage'), segmentId = c.req.valid('param').id; const [row] = await c.env.db.delete(segments).where(and(scope(segments, identity), eq(segments.id, segmentId))).returning(); if (!row) notFound('Segment'); return c.json({ id: segmentId, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/segments/{id}/preview', operationId: 'previewSegment', tags: ['Audience'], security, description: 'Bounded to 1000 matches. Unknown observation history is never classified as inactive. Counts separate suppressed and other non-consenting contacts.', request: { params: IdParams, body: json(z.object({ listId: z.string().min(1).max(120).optional() }).strict()) }, responses: { 200: response(Counts), ...errors } }), async c => {
    const identity = actor(c), segment = await findSegment(c.env.db, identity, c.req.valid('param').id), listId = c.req.valid('json').listId;
    const conditions = [compileRule(segment.rule)]; if (listId) { await findList(c.env.db, identity, listId); conditions.push(inList(identity, listId)); } return c.json(counts(await boundedContacts(c.env.db, identity, conditions, 1000)), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports', operationId: 'previewContactImport', tags: ['Audience'], security, description: 'Persist a preview before commit. Feature limit: 1 MiB UTF-8 CSV, 1000 rows, 100 columns. Map headers explicitly. Valid rows can commit alongside a retained row-error report; imports never modify consent or suppression.', request: { body: json(ImportInput) }, responses: { 201: response(Import), ...errors } }), async c => {
    const identity = actor(c, 'manage'), input = c.req.valid('json'); if (input.listId) await findList(c.env.db, identity, input.listId);
    const preview = previewImport(input); const [row] = await c.env.db.insert(imports).values({ id: id('imp'), ...scopeValues(identity), listId: input.listId, ...preview }).returning(); return c.json(row!, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports', operationId: 'listContactImports', tags: ['Audience'], security, request: { query: PageQuery }, responses: { 200: response(page(Import.omit({ rows: true, errors: true }))), ...errors } }), async c => {
    const identity = actor(c), query = c.req.valid('query'); const rows = await c.env.db.select({ id: imports.id, workspaceId: imports.workspaceId, environment: imports.environment, listId: imports.listId, status: imports.status, imported: imports.imported, createdAt: imports.createdAt, updatedAt: imports.updatedAt }).from(imports).where(and(scope(imports, identity), query.cursor ? gt(imports.id, query.cursor) : undefined)).orderBy(asc(imports.id)).limit(query.limit + 1); return c.json(paginate(rows, query.limit), 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/contact-imports/{id}', operationId: 'getContactImport', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Import), ...errors } }), async c => {
    const identity = actor(c); const [row] = await c.env.db.select().from(imports).where(and(scope(imports, identity), eq(imports.id, c.req.valid('param').id))).limit(1); return c.json(row ?? notFound('Import'), 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-imports/{id}/commit', operationId: 'commitContactImport', tags: ['Audience'], security, request: { params: IdParams }, responses: { 200: response(Import), ...errors } }), async c => {
    const identity = actor(c, 'manage'), importId = c.req.valid('param').id;
    const result = await c.env.db.transaction(async tx => {
      const [job] = await tx.select().from(imports).where(and(scope(imports, identity), eq(imports.id, importId))).limit(1).for('update'); if (!job) return notFound('Import'); if (job.status === 'committed') return job;
      if (job.listId) { const [list] = await tx.select().from(lists).where(and(scope(lists, identity), eq(lists.id, job.listId))).limit(1).for('update'); if (!list) notFound('List'); }
      for (const row of job.rows) {
        const [contact] = await tx.insert(contacts).values({ id: id('con'), ...scopeValues(identity), email: row.email, name: row.name, properties: row.properties }).onConflictDoUpdate({ target: [contacts.workspaceId, contacts.environment, contacts.email], set: { ...(row.name !== undefined ? { name: row.name } : {}), properties: sql`${contacts.properties} || ${JSON.stringify(row.properties)}::jsonb`, deletedAt: null, updatedAt: new Date().toISOString() } }).returning();
        // The upsert locks the current profile, so concurrent imports cannot bypass the merged limit.
        // Rejecting here rolls back this entire commit, including earlier rows and restorations.
        if (!Properties.safeParse(contact!.properties).success) throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', `Row ${row.row}: merged contact properties exceed the supported limits. No rows were imported.`, `rows.${row.row}.properties`);
        if (job.listId) await tx.insert(listMembers).values({ ...scopeValues(identity), listId: job.listId, contactId: contact!.id }).onConflictDoNothing();
      }
      const [updated] = await tx.update(imports).set({ status: 'committed', imported: job.rows.length, updatedAt: new Date().toISOString() }).where(and(scope(imports, identity), eq(imports.id, job.id))).returning(); return updated!;
    }); return c.json(result, 200);
  });
}
