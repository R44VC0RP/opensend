import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { actor, ApiError, errors, id, json, response, security, type Actor, type App, type Database, type DbExecutor } from './core.js';
import { compileRule } from './audience.js';
import { audiencePlans, consentAudit, contacts, listMembers, lists, segments, type AudienceOperation } from './db/audience.js';
import { enqueue } from './jobs.js';

const Statement = z.string().trim().min(1).max(20_000).describe("AudienceQL statement. Supported: SELECT fields|count(*) FROM contacts [WHERE ...] [LIMIT n]; UPDATE contacts SET name|consent|properties.key = value WHERE ...; ADD contacts TO LIST 'name-or-id' WHERE ...; REMOVE contacts FROM LIST 'name-or-id' WHERE .... WHERE supports AND with =, !=, CONTAINS, IS NULL, IS NOT NULL and timestamp comparisons over id, email, name, consent, suppressed, list, segment, lastOpenAt, lastClickAt and properties.key. No raw tables, joins, comments or semicolons.");
const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Sample = z.object({ id: z.string(), email: z.string(), name: z.string().nullable(), consent: z.enum(['unknown', 'subscribed', 'unsubscribed']), suppressed: z.boolean() });
const QueryResult = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), Value.or(z.record(z.string(), Value)))), matched: z.number().int(), truncated: z.boolean() }).openapi('AudienceQueryResult');
const PlanResult = z.object({ id: z.string(), operation: z.enum(['update_contacts', 'add_to_list', 'remove_from_list']), matched: z.number().int(), sample: z.array(Sample), warnings: z.array(z.string()), requiresResubscribeConfirmation: z.boolean(), expiresAt: z.string() }).openapi('AudienceOperationPlan');
const ApplyResult = z.object({ id: z.string(), operation: z.enum(['update_contacts', 'add_to_list', 'remove_from_list']), affected: z.number().int(), appliedAt: z.string() }).openapi('AudienceOperationResult');
type Literal = string | number | boolean | null;
type UpdateSet = { name?: string | null; consent?: 'subscribed' | 'unsubscribed'; properties?: Record<string, Literal> };

function scoped(column: { workspaceId: AnyPgColumn; environment: AnyPgColumn }, identity: Actor) { return and(eq(column.workspaceId, identity.workspaceId), eq(column.environment, identity.environment))!; }
function clean(statement: string) {
  const value = statement.trim();
  if (/[;\0]|--|\/\*/.test(value)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL does not allow semicolons, comments, or multiple statements.', 'statement');
  return value;
}
function splitOutside(value: string, separator: ',' | 'AND'): string[] {
  const result: string[] = []; let start = 0; let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "'") { if (quoted && value[index + 1] === "'") index++; else quoted = !quoted; continue; }
    if (quoted) continue;
    if (separator === ',' && value[index] === ',') { result.push(value.slice(start, index).trim()); start = index + 1; }
    if (separator === 'AND' && /^\s+AND\s+/i.test(value.slice(index))) { const match = /^\s+AND\s+/i.exec(value.slice(index))!; result.push(value.slice(start, index).trim()); start = index + match[0].length; index = start - 1; }
  }
  if (quoted) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL contains an unterminated string.', 'statement');
  result.push(value.slice(start).trim()); return result.filter(Boolean);
}
function literal(raw: string): Literal {
  const value = raw.trim();
  if (/^NULL$/i.test(value)) return null;
  if (/^TRUE$/i.test(value)) return true;
  if (/^FALSE$/i.test(value)) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^'(?:[^']|'')*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
  throw new ApiError(422, 'AUDIENCEQL_INVALID', `Use a quoted string, finite number, boolean, or NULL instead of ${value.slice(0, 40)}.`, 'statement');
}
async function reference(db: DbExecutor, identity: Actor, kind: 'list' | 'segment', value: string) {
  const table = kind === 'list' ? lists : segments;
  const rows = await db.select({ id: table.id, name: table.name, ...(kind === 'segment' ? { rule: segments.rule } : {}) }).from(table as typeof lists).where(and(scoped(table, identity), or(eq(table.id, value), eq(table.name, value)))).limit(2);
  if (!rows.length) throw new ApiError(422, 'AUDIENCEQL_REFERENCE_NOT_FOUND', `${kind === 'list' ? 'List' : 'Segment'} ${value} was not found.`, 'statement');
  if (rows.length > 1) throw new ApiError(422, 'AUDIENCEQL_REFERENCE_AMBIGUOUS', `Use the ${kind} ID because its name is not unique.`, 'statement');
  return rows[0]! as { id: string; rule?: typeof segments.$inferSelect.rule };
}
function compare(field: SQL | AnyPgColumn, operator: string, value: Literal): SQL {
  if (operator === 'IS NULL') return isNull(field as AnyPgColumn);
  if (operator === 'IS NOT NULL') return isNotNull(field as AnyPgColumn);
  if (value === null) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Use IS NULL or IS NOT NULL for NULL.', 'statement');
  if (operator === '=') return eq(field as AnyPgColumn, value);
  if (operator === '!=') return ne(field as AnyPgColumn, value);
  if (operator === 'CONTAINS' && typeof value === 'string') return sql`strpos(lower(${field}), lower(${value})) > 0`;
  if (operator === '>') return gt(field as AnyPgColumn, value);
  if (operator === '>=') return gte(field as AnyPgColumn, value);
  if (operator === '<') return lt(field as AnyPgColumn, value);
  if (operator === '<=') return lte(field as AnyPgColumn, value);
  throw new ApiError(422, 'AUDIENCEQL_INVALID', `Operator ${operator} is not valid for this field.`, 'statement');
}
async function whereSql(db: DbExecutor, identity: Actor, source: string | undefined): Promise<SQL[]> {
  if (!source) return [];
  if (/\s+OR\s+/i.test(source) || /[()]/.test(source)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'AudienceQL v1 supports AND conditions without parentheses.', 'statement');
  const result: SQL[] = [];
  for (const clause of splitOutside(source, 'AND')) {
    const match = /^([A-Za-z][A-Za-z0-9_.]*)\s+(IS NOT NULL|IS NULL|CONTAINS|!=|>=|<=|=|>|<)(?:\s+(.+))?$/i.exec(clause);
    if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Invalid WHERE condition: ${clause.slice(0, 80)}.`, 'statement');
    const name = match[1]!, operator = match[2]!.toUpperCase(), value = operator.startsWith('IS ') ? null : literal(match[3] ?? '');
    if (/^properties\.[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) { if (!['=', '!=', 'CONTAINS', 'IS NULL', 'IS NOT NULL'].includes(operator)) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Property filters support =, !=, CONTAINS and NULL checks.', 'statement'); result.push(compare(sql`${contacts.properties} ->> ${name.slice(11)}`, operator, value === null ? null : String(value))); continue; }
    if (name === 'list' || name === 'segment') {
      if (!['=', '!='].includes(operator) || typeof value !== 'string') throw new ApiError(422, 'AUDIENCEQL_INVALID', `${name} supports = or != with a quoted name or ID.`, 'statement');
      const found = await reference(db, identity, name, value);
      const condition = name === 'list' ? sql`EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${found.id} AND m.contact_id = ${contacts.id})` : compileRule(found.rule!);
      result.push(operator === '=' ? condition : sql`NOT (${condition})`); continue;
    }
    const fields: Record<string, AnyPgColumn> = { id: contacts.id, email: contacts.email, name: contacts.name, consent: contacts.marketingConsent, suppressed: contacts.suppressed, lastOpenAt: contacts.lastOpenAt, lastClickAt: contacts.lastClickAt };
    const field = fields[name]; if (!field) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Unknown AudienceQL field ${name}.`, 'statement');
    if (name === 'suppressed' && typeof value !== 'boolean' && !operator.startsWith('IS ')) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'suppressed requires TRUE or FALSE.', 'statement');
    if ((name === 'lastOpenAt' || name === 'lastClickAt') && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new ApiError(422, 'AUDIENCEQL_INVALID', `${name} requires an ISO date string.`, 'statement');
    result.push(compare(field, operator, value));
  }
  return result;
}
function mScope(identity: Actor) { return sql`m.workspace_id = ${identity.workspaceId} AND m.environment = ${identity.environment}`; }
async function targetRows(db: DbExecutor, identity: Actor, where: string, extra?: SQL) {
  const conditions = await whereSql(db, identity, where);
  const rows = await db.select().from(contacts).where(and(scoped(contacts, identity), isNull(contacts.deletedAt), ...conditions, extra)).orderBy(asc(contacts.id)).limit(10_001);
  if (rows.length > 10_000) throw new ApiError(422, 'AUDIENCEQL_LIMIT_EXCEEDED', 'A mutation plan may target at most 10,000 contacts. Narrow the WHERE clause.', 'statement');
  return rows;
}
function sample(rows: Array<typeof contacts.$inferSelect>) { return rows.slice(0, 10).map(row => ({ id: row.id, email: row.email, name: row.name, consent: row.marketingConsent, suppressed: row.suppressed })); }
function parseMutation(statement: string): { kind: 'update'; set: UpdateSet; where: string } | { kind: 'add' | 'remove'; list: string; where: string } {
  const update = /^UPDATE\s+contacts\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is.exec(statement);
  if (update) {
    const set: UpdateSet = {};
    for (const assignment of splitOutside(update[1]!, ',')) {
      const match = /^([A-Za-z][A-Za-z0-9_.]*)\s*=\s*(.+)$/s.exec(assignment); if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', `Invalid SET assignment: ${assignment}.`, 'statement');
      const name = match[1]!, value = literal(match[2]!);
      if (name === 'name' && (typeof value === 'string' || value === null)) set.name = value;
      else if (name === 'consent' && (value === 'subscribed' || value === 'unsubscribed')) set.consent = value;
      else if (/^properties\.[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) (set.properties ??= {})[name.slice(11)] = value;
      else throw new ApiError(422, 'AUDIENCEQL_INVALID', `Cannot update AudienceQL field ${name}.`, 'statement');
    }
    if (!Object.keys(set).length) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'UPDATE requires at least one supported assignment.', 'statement');
    return { kind: 'update', set, where: update[2]!.trim() };
  }
  const membership = /^(ADD\s+contacts\s+TO|REMOVE\s+contacts\s+FROM)\s+LIST\s+(.+?)\s+WHERE\s+(.+)$/is.exec(statement);
  if (membership) { const list = literal(membership[2]!); if (typeof list !== 'string') throw new ApiError(422, 'AUDIENCEQL_INVALID', 'LIST requires a quoted name or ID.', 'statement'); return { kind: membership[1]!.toUpperCase().startsWith('ADD') ? 'add' : 'remove', list, where: membership[3]!.trim() }; }
  throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Expected UPDATE contacts, ADD contacts TO LIST, or REMOVE contacts FROM LIST.', 'statement');
}

async function queryAudience(db: DbExecutor, identity: Actor, statement: string) {
  const match = /^SELECT\s+(.+?)\s+FROM\s+contacts(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT\s+(\d+))?$/is.exec(clean(statement));
  if (!match) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Expected SELECT fields FROM contacts [WHERE ...] [LIMIT n].', 'statement');
  const conditions = await whereSql(db, identity, match[2]?.trim());
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(contacts).where(and(scoped(contacts, identity), isNull(contacts.deletedAt), ...conditions));
  if (/^count\(\*\)$/i.test(match[1]!.trim())) return { columns: ['count'], rows: [{ count }], matched: count, truncated: false };
  const fields = splitOutside(match[1]!, ','); if (!fields.length || fields.length > 10) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'Select between one and ten fields.', 'statement');
  const allowed = /^(?:id|email|name|consent|suppressed|lastOpenAt|lastClickAt|properties|properties\.[A-Za-z][A-Za-z0-9_]{0,79})$/;
  if (fields.some(field => !allowed.test(field))) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'SELECT contains an unsupported field.', 'statement');
  const limit = match[3] ? Number(match[3]) : 100; if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ApiError(422, 'AUDIENCEQL_INVALID', 'SELECT LIMIT must be between 1 and 1000.', 'statement');
  const rows = await db.select().from(contacts).where(and(scoped(contacts, identity), isNull(contacts.deletedAt), ...conditions)).orderBy(asc(contacts.id)).limit(limit);
  const data = rows.map(row => Object.fromEntries(fields.map(field => [field, field === 'consent' ? row.marketingConsent : field === 'lastOpenAt' ? row.lastOpenAt : field === 'lastClickAt' ? row.lastClickAt : field === 'properties' ? row.properties : field.startsWith('properties.') ? row.properties[field.slice(11)] ?? null : row[field as 'id' | 'email' | 'name' | 'suppressed']])));
  return { columns: fields, rows: data, matched: count, truncated: count > rows.length };
}

async function planAudience(db: DbExecutor, identity: Actor, statement: string) {
  statement = clean(statement); const parsed = parseMutation(statement); let rows: Array<typeof contacts.$inferSelect>; let operation: AudienceOperation;
  if (parsed.kind === 'update') { rows = await targetRows(db, identity, parsed.where); operation = { kind: 'update_contacts', targets: rows.map(row => ({ id: row.id, email: row.email, updatedAt: row.updatedAt, consent: row.marketingConsent })), set: parsed.set }; }
  else {
    const list = await reference(db, identity, 'list', parsed.list);
    rows = await targetRows(db, identity, parsed.where, parsed.kind === 'add' ? sql`NOT EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${list.id} AND m.contact_id = ${contacts.id})` : sql`EXISTS (SELECT 1 FROM ${listMembers} m WHERE ${mScope(identity)} AND m.list_id = ${list.id} AND m.contact_id = ${contacts.id})`);
    operation = { kind: parsed.kind === 'add' ? 'add_to_list' : 'remove_from_list', targetIds: rows.map(row => row.id), listId: list.id };
  }
  const requiresResubscribeConfirmation = operation.kind === 'update_contacts' && operation.set.consent === 'subscribed' && operation.targets.some(target => target.consent === 'unsubscribed');
  const warnings = [...(rows.some(row => row.suppressed) ? [`${rows.filter(row => row.suppressed).length} suppressed contact(s) remain suppressed.`] : []), ...(requiresResubscribeConfirmation ? ['The plan includes prior opt-outs and requires explicit resubscribe confirmation.'] : [])];
  const planId = id('aqp'), expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await db.insert(audiencePlans).values({ id: planId, workspaceId: identity.workspaceId, environment: identity.environment, actorKeyId: identity.keyId, statement, operation, matched: rows.length, expiresAt });
  return { id: planId, operation: operation.kind, matched: rows.length, sample: sample(rows), warnings, requiresResubscribeConfirmation, expiresAt };
}
const chunks = <T,>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
async function applyPlan(db: Database, identity: Actor, planId: string, confirmResubscribe: boolean) {
  return db.transaction(async tx => {
    const [plan] = await tx.select().from(audiencePlans).where(and(scoped(audiencePlans, identity), eq(audiencePlans.id, planId), eq(audiencePlans.actorKeyId, identity.keyId))).limit(1).for('update');
    if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Audience operation plan was not found.');
    if (plan.appliedAt) throw new ApiError(409, 'AUDIENCE_PLAN_APPLIED', 'This audience operation plan was already applied.');
    if (Date.parse(plan.expiresAt) <= Date.now()) throw new ApiError(409, 'AUDIENCE_PLAN_EXPIRED', 'This audience operation plan expired. Create a new plan.');
    const operation = plan.operation; const appliedAt = new Date().toISOString();
    if (operation.kind === 'update_contacts') {
      const ids = operation.targets.map(target => target.id); const current = ids.length ? await tx.select().from(contacts).where(and(scoped(contacts, identity), inArray(contacts.id, ids), isNull(contacts.deletedAt))).orderBy(asc(contacts.id)).for('update') : [];
      const expected = new Map(operation.targets.map(target => [target.id, target]));
      if (current.length !== ids.length || current.some(row => row.updatedAt !== expected.get(row.id)?.updatedAt)) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'A planned contact changed or was deleted. Review a new plan.');
      if (operation.set.consent === 'subscribed' && current.some(row => row.marketingConsent === 'unsubscribed') && !confirmResubscribe) throw new ApiError(409, 'RESUBSCRIBE_CONFIRMATION_REQUIRED', 'This plan includes prior opt-outs. Explicitly confirm renewed consent before applying it.');
      for (const batch of chunks(ids, 5000)) await tx.update(contacts).set({ ...(Object.hasOwn(operation.set, 'name') ? { name: operation.set.name } : {}), ...(operation.set.consent ? { marketingConsent: operation.set.consent } : {}), ...(operation.set.properties ? { properties: sql`${contacts.properties} || ${JSON.stringify(operation.set.properties)}::jsonb` } : {}), updatedAt: appliedAt }).where(and(scoped(contacts, identity), inArray(contacts.id, batch)));
      if (operation.set.consent) {
        const changed = current.filter(row => row.marketingConsent !== operation.set.consent).map(row => ({ row, eventId: id('cns') }));
        for (const batch of chunks(changed, 500)) await tx.insert(consentAudit).values(batch.map(({ row, eventId }) => ({ id: eventId, workspaceId: identity.workspaceId, environment: identity.environment, contactId: row.id, email: row.email, status: operation.set.consent!, source: 'audienceql', actorKeyId: identity.keyId, occurredAt: appliedAt })));
        for (const batch of chunks(changed, 100)) await enqueue(tx, { type: 'operation.publishBatch', workspaceId: identity.workspaceId, environment: identity.environment, payload: { events: batch.map(({ row, eventId }) => ({ id: eventId, workspaceId: identity.workspaceId, environment: identity.environment, type: 'contact.subscription_changed', region: null, createdAt: appliedAt, data: { contactId: row.id, status: operation.set.consent, source: 'audienceql' } })) } });
      }
    } else {
      const [list] = await tx.select({ id: lists.id }).from(lists).where(and(scoped(lists, identity), eq(lists.id, operation.listId))).limit(1).for('update');
      if (!list) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'The planned list was deleted. Review a new plan.');
      const currentMemberships = operation.targetIds.length ? await tx.select({ contactId: listMembers.contactId }).from(listMembers).where(and(scoped(listMembers, identity), eq(listMembers.listId, operation.listId), inArray(listMembers.contactId, operation.targetIds))) : [];
      if (operation.kind === 'add_to_list' && currentMemberships.length || operation.kind === 'remove_from_list' && currentMemberships.length !== operation.targetIds.length) throw new ApiError(409, 'STALE_AUDIENCE_PLAN', 'List memberships changed after review. Review a new plan.');
      if (operation.kind === 'add_to_list') for (const batch of chunks(operation.targetIds, 1000)) if (batch.length) await tx.insert(listMembers).values(batch.map(contactId => ({ workspaceId: identity.workspaceId, environment: identity.environment, listId: operation.listId, contactId }))).onConflictDoNothing();
      else for (const batch of chunks(operation.targetIds, 5000)) if (batch.length) await tx.delete(listMembers).where(and(scoped(listMembers, identity), eq(listMembers.listId, operation.listId), inArray(listMembers.contactId, batch)));
    }
    await tx.update(audiencePlans).set({ appliedAt }).where(and(scoped(audiencePlans, identity), eq(audiencePlans.id, plan.id)));
    return { id: plan.id, operation: operation.kind, affected: plan.matched, appliedAt };
  });
}

export function registerAudienceQuery(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/query', operationId: 'queryAudience', tags: ['Audience'], security, description: 'Execute a bounded read-only AudienceQL SELECT against the virtual contacts schema.', request: { body: json(z.object({ statement: Statement }).strict()) }, responses: { 200: response(QueryResult), ...errors } }), async c => c.json(QueryResult.parse(await queryAudience(c.env.db, actor(c), c.req.valid('json').statement)), 200));
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/plan', operationId: 'planAudienceMutation', tags: ['Audience'], security, description: 'Create a 15-minute immutable plan for a bounded AudienceQL bulk mutation. Does not modify contacts or memberships.', request: { body: json(z.object({ statement: Statement }).strict()) }, responses: { 201: response(PlanResult), ...errors } }), async c => c.json(PlanResult.parse(await planAudience(c.env.db, actor(c, 'manage'), c.req.valid('json').statement)), 201));
  app.openapi(createRoute({ method: 'post', path: '/v1/audience-query/apply', operationId: 'applyAudiencePlan', tags: ['Audience'], security, description: 'Apply an immutable AudienceQL plan once. Prior opt-outs require confirmResubscribe.', request: { body: json(z.object({ planId: z.string().regex(/^aqp_[0-9a-f]{32}$/), confirmResubscribe: z.boolean().default(false) }).strict()) }, responses: { 200: response(ApplyResult), ...errors } }), async c => c.json(ApplyResult.parse(await applyPlan(c.env.db, actor(c, 'manage'), c.req.valid('json').planId, c.req.valid('json').confirmResubscribe)), 200));
}
