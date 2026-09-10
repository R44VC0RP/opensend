import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { Client } from 'pg';
import {
  actor,
  ApiError,
  digest,
  errors,
  id,
  IdParams,
  json,
  notFound,
  page,
  PageQuery,
  response,
  security,
  type Actor,
  type App,
  type DbExecutor,
  type JobHandler,
  type Runtime,
} from './core.js';
import { contacts, consentAudit, listMembers, lists } from './db/audience.js';
import { enqueue } from './jobs.js';
import { postgresConnection } from './adapters/node.js';

const Properties = z
  .record(z.string().min(1).max(80), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]))
  .refine((v) => Object.keys(v).length <= 50);
const Profile = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((v) => v.toLowerCase()),
  name: z.string().trim().max(200).optional(),
  properties: Properties.default({}),
});
const Bulk = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    nextChunk: z.number(),
    received: z.number(),
    valid: z.number(),
    errors: z.number(),
    imported: z.number(),
    errorCode: z.string().nullable(),
  })
  .openapi('BulkContactImport');
interface BulkRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  environment: 'live' | 'test';
  list_id: string;
  name: string;
  status: string;
  next_chunk: number;
  received: number;
  valid: number;
  errors: number;
  imported: number;
  cursor: number;
  error_code: string | null;
}
const view = (r: BulkRow) => Bulk.parse({ ...r, nextChunk: r.next_chunk, errorCode: r.error_code });
const scope = (a: Pick<Actor, 'workspaceId' | 'environment'>) =>
  sql`workspace_id=${a.workspaceId} AND environment=${a.environment}`;
async function list(db: DbExecutor, a: Pick<Actor, 'workspaceId' | 'environment'>, listId: string) {
  const [row] = await db
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.workspaceId, a.workspaceId), eq(lists.environment, a.environment)));
  return row ?? notFound('List');
}
async function bulk(db: DbExecutor, a: Actor, importId: string, lock = false) {
  const r = await db.execute<BulkRow>(
    sql`SELECT * FROM audience_bulk_imports WHERE id=${importId} AND ${scope(a)} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  return r.rows[0] ?? notFound('Import');
}
export async function mergeProfile(
  db: DbExecutor,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  listId: string,
  input: z.infer<typeof Profile>,
) {
  const [row] = await db
    .insert(contacts)
    .values({ id: id('con'), workspaceId: a.workspaceId, environment: a.environment, ...input })
    .onConflictDoUpdate({
      target: [contacts.workspaceId, contacts.environment, contacts.email],
      set: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        properties: sql`${contacts.properties} || ${JSON.stringify(input.properties)}::jsonb`,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
      },
    })
    .returning();
  if (!Properties.safeParse(row!.properties).success)
    throw new ApiError(422, 'IMPORT_PROPERTIES_INVALID', 'Merged properties exceed 50 fields or field size limits.');
  await db
    .insert(listMembers)
    .values({ workspaceId: a.workspaceId, environment: a.environment, listId, contactId: row!.id })
    .onConflictDoNothing();
  return row!;
}
export function registerAudienceSync(app: App) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/bulk-contact-imports',
      operationId: 'createBulkContactImport',
      description:
        'Create a resumable contact import. Upload explicitly mapped rows in ordered chunks, finalize the preview, then commit. Imports do not establish consent.',
      tags: ['Audience'],
      security,
      request: {
        body: json(z.object({ listId: z.string().min(1), name: z.string().trim().min(1).max(200) }).strict()),
      },
      responses: { 201: response(Bulk), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage'),
        input = c.req.valid('json');
      await list(c.env.db, a, input.listId);
      const r = await c.env.db.execute<BulkRow>(
        sql`INSERT INTO audience_bulk_imports(id,workspace_id,environment,list_id,name) VALUES(${id('imp')},${a.workspaceId},${a.environment},${input.listId},${input.name}) RETURNING *`,
      );
      return c.json(view(r.rows[0]!), 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/bulk-contact-imports/{id}',
      operationId: 'getBulkContactImport',
      tags: ['Audience'],
      security,
      request: { params: IdParams },
      responses: { 200: response(Bulk), ...errors },
    }),
    async (c) => c.json(view(await bulk(c.env.db, actor(c), c.req.valid('param').id)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/bulk-contact-imports/{id}/chunks',
      operationId: 'uploadContactImportChunk',
      tags: ['Audience'],
      security,
      request: {
        params: IdParams,
        body: json(
          z
            .object({
              chunk: z.number().int().nonnegative(),
              rows: z
                .array(
                  z.object({
                    email: z.string().max(1000),
                    name: z.string().max(1000).optional(),
                    properties: z
                      .record(z.string().max(100), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]))
                      .default({}),
                  }),
                )
                .min(1)
                .max(1000),
            })
            .strict(),
        ),
      },
      responses: { 200: response(Bulk), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage'),
        input = c.req.valid('json'),
        checksum = await digest(JSON.stringify(input));
      const r = await c.env.db.transaction(async (db) => {
        const row = await bulk(db, a, c.req.valid('param').id, true);
        const previous = await db.execute<{ checksum: string }>(
          sql`SELECT checksum FROM audience_bulk_chunks WHERE import_id=${row.id} AND chunk=${input.chunk}`,
        );
        if (previous.rows[0]) {
          if (previous.rows[0].checksum !== checksum)
            throw new ApiError(409, 'IMPORT_CHUNK_CONFLICT', 'This chunk has different content.');
          return row;
        }
        if (row.status !== 'uploading' || row.next_chunk !== input.chunk)
          throw new ApiError(409, 'IMPORT_CHUNK_ORDER', 'Upload the next expected chunk.');
        if (row.received + input.rows.length > 250000)
          throw new ApiError(413, 'IMPORT_TOO_LARGE', 'Imports support at most 250,000 rows.');
        let valid = 0,
          failures = 0;
        for (let i = 0; i < input.rows.length; i++) {
          const candidate = input.rows[i]!,
            parsed = Profile.safeParse(candidate),
            number = row.received + i + 2;
          if (!parsed.success) {
            await db.execute(
              sql`INSERT INTO audience_bulk_rows(import_id,row_number,error) VALUES(${row.id},${number},'Invalid email, name, or properties')`,
            );
            failures++;
            continue;
          }
          const p = parsed.data;
          const inserted = await db.execute(
            sql`INSERT INTO audience_bulk_rows(import_id,row_number,email,name,properties) VALUES(${row.id},${number},${p.email},${p.name ?? null},${JSON.stringify(p.properties)}::jsonb) ON CONFLICT DO NOTHING RETURNING row_number`,
          );
          if (!inserted.rows.length) {
            await db.execute(
              sql`INSERT INTO audience_bulk_rows(import_id,row_number,error) VALUES(${row.id},${number},'Duplicate normalized email')`,
            );
            failures++;
          } else valid++;
        }
        await db.execute(
          sql`INSERT INTO audience_bulk_chunks(import_id,chunk,checksum) VALUES(${row.id},${input.chunk},${checksum})`,
        );
        const updated = await db.execute<BulkRow>(
          sql`UPDATE audience_bulk_imports SET next_chunk=next_chunk+1,received=received+${input.rows.length},valid=valid+${valid},errors=errors+${failures},updated_at=now() WHERE id=${row.id} RETURNING *`,
        );
        return updated.rows[0]!;
      });
      return c.json(view(r), 200);
    },
  );
  for (const action of ['finalize', 'commit'] as const)
    app.openapi(
      createRoute({
        method: 'post',
        path: `/v1/bulk-contact-imports/{id}/${action}`,
        operationId: action === 'finalize' ? 'finalizeBulkContactImport' : 'commitBulkContactImport',
        tags: ['Audience'],
        security,
        request: { params: IdParams },
        responses: { 202: response(Bulk), ...errors },
      }),
      async (c) => {
        const a = actor(c, 'manage');
        const r = await c.env.db.transaction(async (db) => {
          const row = await bulk(db, a, c.req.valid('param').id, true);
          if (action === 'finalize') {
            if (row.status !== 'uploading') return row;
            if (!row.received) throw new ApiError(422, 'IMPORT_EMPTY', 'Upload contact rows first.');
            await db.execute(
              sql`UPDATE audience_bulk_imports SET status='preview',updated_at=now() WHERE id=${row.id}`,
            );
          } else {
            if (['committing', 'committed'].includes(row.status)) return row;
            if (!['preview', 'failed'].includes(row.status))
              throw new ApiError(409, 'IMPORT_NOT_READY', 'Finalize and inspect the import before committing.');
            await list(db, a, row.list_id);
            await db.execute(
              sql`UPDATE audience_bulk_imports SET status='committing',error_code=NULL,updated_at=now() WHERE id=${row.id}`,
            );
            await enqueue(db, {
              type: 'audience.import',
              workspaceId: a.workspaceId,
              environment: a.environment,
              payload: { importId: row.id },
            });
          }
          return bulk(db, a, row.id);
        });
        return c.json(view(r), 202);
      },
    );
  const ImportDetail = z.object({
    row: z.number(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    error: z.string().nullable(),
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/bulk-contact-imports/{id}/rows',
      operationId: 'getBulkContactImportRows',
      tags: ['Audience'],
      security,
      request: {
        params: IdParams,
        query: PageQuery.extend({ errorsOnly: z.enum(['true', 'false']).default('false') }),
      },
      responses: { 200: response(page(ImportDetail)), ...errors },
    }),
    async (c) => {
      const a = actor(c),
        row = await bulk(c.env.db, a, c.req.valid('param').id),
        q = c.req.valid('query');
      const r = await c.env.db.execute<{
        row: number;
        email: string | null;
        name: string | null;
        error: string | null;
      }>(
        sql`SELECT row_number AS row,email,name,error FROM audience_bulk_rows WHERE import_id=${row.id} AND row_number>${Number(q.cursor) || 0} ${q.errorsOnly === 'true' ? sql`AND error IS NOT NULL` : sql``} ORDER BY row_number LIMIT ${q.limit + 1}`,
      );
      return c.json(
        {
          data: r.rows.slice(0, q.limit),
          nextCursor: r.rows.length > q.limit ? String(r.rows[q.limit - 1]!.row) : null,
        },
        200,
      );
    },
  );
  const Sync = z
    .object({
      configured: z.boolean(),
      status: z.string(),
      scanned: z.number(),
      imported: z.number(),
      errors: z.number(),
      errorCode: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      nextAt: z.string().nullable(),
    })
    .openapi('CrmSyncStatus');
  const status = async (runtime: Runtime, a: Actor) => {
    const r = await runtime.db.execute<SyncState>(sql`SELECT * FROM crm_sync_state WHERE ${scope(a)}`);
    const s = r.rows[0];
    return {
      configured: !!runtime.config.crm,
      status: s?.status ?? 'idle',
      scanned: s?.scanned ?? 0,
      imported: s?.imported ?? 0,
      errors: s?.errors ?? 0,
      errorCode: s?.error_code ?? null,
      lastSuccessAt: s?.last_success_at ?? null,
      nextAt: s?.next_at ?? null,
    };
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/audience-sync',
      operationId: 'getAudienceSync',
      tags: ['Audience'],
      security,
      responses: { 200: response(Sync), ...errors },
    }),
    async (c) => c.json(await status(c.env, actor(c)), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/audience-sync',
      operationId: 'refreshAudienceSync',
      description:
        'Read the configured CRM view and merge profiles/consent into OpenSend. Never writes to the CRM or clears an OpenSend opt-out.',
      tags: ['Audience'],
      security,
      responses: { 202: response(Sync), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage');
      if (a.domains.length)
        throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'CRM sync requires an unrestricted principal.');
      if (a.environment !== 'live')
        throw new ApiError(422, 'CRM_LIVE_ONLY', 'CRM sync is available in live; use synthetic imports in test.');
      await queueCrmSync(c.env, true);
      return c.json(await status(c.env, a), 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/audience-sync/errors',
      operationId: 'getAudienceSyncErrors',
      tags: ['Audience'],
      security,
      request: { query: PageQuery },
      responses: {
        200: response(page(z.object({ id: z.string(), sourceId: z.string().nullable(), code: z.string() }))),
        ...errors,
      },
    }),
    async (c) => {
      const a = actor(c),
        q = c.req.valid('query');
      const r = await c.env.db.execute<{ id: string; sourceId: string | null; code: string }>(
        sql`SELECT id::text,source_id AS "sourceId",code FROM crm_sync_errors WHERE ${scope(a)} AND id>${Number(q.cursor) || 0} ORDER BY id LIMIT ${q.limit + 1}`,
      );
      return c.json(
        { data: r.rows.slice(0, q.limit), nextCursor: r.rows.length > q.limit ? r.rows[q.limit - 1]!.id : null },
        200,
      );
    },
  );
}
interface SyncState extends Record<string, unknown> {
  workspace_id: string;
  environment: 'live' | 'test';
  status: string;
  checkpoint_at: string;
  checkpoint_id: string;
  cutoff_at: string | null;
  scanned: number;
  imported: number;
  errors: number;
  error_code: string | null;
  last_success_at: string | null;
  next_at: string;
}
const CrmRow = Profile.extend({
  source_id: z.string().min(1).max(200),
  updated_at: z.coerce.date(),
  deleted: z.boolean(),
  consent_status: z.enum(['unknown', 'subscribed', 'unsubscribed']),
  consent_source: z.string().max(200).nullable(),
  policy_version: z.string().max(120).nullable(),
  evidence: z.string().max(2000).nullable(),
  consent_at: z.coerce.date().nullable(),
});
export async function queueCrmSync(runtime: Runtime, force = false) {
  const config = runtime.config.crm;
  if (!config) {
    if (force) throw new ApiError(503, 'CRM_NOT_CONFIGURED', 'Configure the read-only CRM view and target list first.');
    return;
  }
  const a = { workspaceId: runtime.config.workspaceId, environment: 'live' as const };
  await runtime.db.transaction(async (db) => {
    await db.execute(
      sql`INSERT INTO crm_sync_state(workspace_id,environment) VALUES(${a.workspaceId},'live') ON CONFLICT DO NOTHING`,
    );
    const r = await db.execute<SyncState>(sql`SELECT * FROM crm_sync_state WHERE ${scope(a)} FOR UPDATE`),
      s = r.rows[0]!;
    if (s.status === 'running') {
      const active = await db.execute(
        sql`SELECT id FROM jobs WHERE ${scope(a)} AND type='audience.crm' AND status IN ('pending','running') LIMIT 1`,
      );
      if (!active.rows.length) await enqueue(db, { type: 'audience.crm', ...a, payload: {} });
      return;
    }
    if (!force && Date.parse(s.next_at) > Date.now()) return;
    await list(db, a, config.listId);
    await db.execute(
      sql`UPDATE crm_sync_state SET status='running',cutoff_at=now(),scanned=0,imported=0,errors=0,error_code=NULL,updated_at=now() WHERE ${scope(a)}`,
    );
    await enqueue(db, { type: 'audience.crm', ...a, payload: {} });
  });
}
export const audienceSyncJobs: Record<string, JobHandler> = {
  'audience.import': async (runtime, payload, job) => {
    const a: Actor = {
      workspaceId: job.workspaceId,
      environment: job.environment,
      keyId: 'worker',
      permissions: ['manage'],
      domains: [],
    };
    try {
      await runtime.db.transaction(async (db) => {
        const r = await bulk(db, a, String(payload.importId), true);
        if (r.status !== 'committing') return;
        await list(db, a, r.list_id);
        const rows = await db.execute<{
          row_number: number;
          email: string;
          name: string | null;
          properties: z.infer<typeof Properties>;
        }>(
          sql`SELECT * FROM audience_bulk_rows WHERE import_id=${r.id} AND error IS NULL AND row_number>${r.cursor} ORDER BY row_number LIMIT 100`,
        );
        for (const row of rows.rows)
          await mergeProfile(db, a, r.list_id, {
            email: row.email,
            ...(row.name !== null ? { name: row.name } : {}),
            properties: row.properties,
          });
        await db.execute(
          sql`UPDATE audience_bulk_imports SET imported=imported+${rows.rows.length},cursor=${rows.rows.at(-1)?.row_number ?? r.cursor},status=${rows.rows.length ? 'committing' : 'committed'},updated_at=now() WHERE id=${r.id}`,
        );
        if (rows.rows.length)
          await enqueue(db, {
            type: 'audience.import',
            workspaceId: a.workspaceId,
            environment: a.environment,
            payload: { importId: r.id },
          });
      });
    } catch (error) {
      await runtime.db.execute(
        sql`UPDATE audience_bulk_imports SET status='failed',error_code=${error instanceof ApiError ? error.code : 'IMPORT_FAILED'},updated_at=now() WHERE id=${String(payload.importId)} AND ${scope(a)}`,
      );
      throw error;
    }
  },
  'audience.crm': async (runtime, _payload, job) => {
    const config = runtime.config.crm;
    if (!config) throw new ApiError(503, 'CRM_NOT_CONFIGURED', 'CRM sync configuration is missing.');
    const a = { workspaceId: job.workspaceId, environment: job.environment };
    if (a.environment !== 'live')
      throw new ApiError(403, 'CRM_LIVE_ONLY', 'CRM data cannot enter the test environment.');
    const connection = new Client({ ...postgresConnection(config.url), statement_timeout: 15000 });
    try {
      await connection.connect();
      await connection.query('BEGIN READ ONLY');
      await runtime.db.transaction(async (db) => {
        const state = await db.execute<SyncState>(sql`SELECT * FROM crm_sync_state WHERE ${scope(a)} FOR UPDATE`),
          s = state.rows[0];
        if (!s || s.status !== 'running') return;
        // View identifier is validated in loadConfig. Data values always use parameters.
        const viewName = config.view
          .split('.')
          .map((v) => `"${v}"`)
          .join('.');
        const source = await connection.query(
          `SELECT source_id,email,name,properties,updated_at,deleted,consent_status,consent_source,policy_version,evidence,consent_at FROM ${viewName} WHERE (updated_at,source_id)>($1::timestamptz,$2::text) AND updated_at <= $3::timestamptz ORDER BY updated_at,source_id LIMIT 500`,
          [s.checkpoint_at, s.checkpoint_id, s.cutoff_at],
        );
        let imported = 0,
          failed = 0;
        for (const raw of source.rows) {
          const parsed = CrmRow.safeParse({ ...raw, name: raw.name ?? undefined, properties: raw.properties ?? {} });
          if (!parsed.success) {
            failed++;
            await db.execute(
              sql`INSERT INTO crm_sync_errors(workspace_id,environment,source_id,code) VALUES(${a.workspaceId},${a.environment},${typeof raw.source_id === 'string' ? raw.source_id.slice(0, 200) : null},'CRM_ROW_INVALID')`,
            );
            continue;
          }
          const row = parsed.data;
          const link = await db.execute<{ contact_id: string }>(
            sql`SELECT contact_id FROM crm_contact_links WHERE ${scope(a)} AND source_id=${row.source_id}`,
          );
          if (row.deleted) {
            if (link.rows[0])
              await db
                .delete(listMembers)
                .where(
                  and(
                    eq(listMembers.workspaceId, a.workspaceId),
                    eq(listMembers.environment, a.environment),
                    eq(listMembers.listId, config.listId),
                    eq(listMembers.contactId, link.rows[0].contact_id),
                  ),
                );
            continue;
          }
          const contact = await mergeProfile(db, a, config.listId, {
            email: row.email,
            name: row.name,
            properties: row.properties,
          });
          if (link.rows[0] && link.rows[0].contact_id !== contact.id)
            await db
              .delete(listMembers)
              .where(
                and(
                  eq(listMembers.listId, config.listId),
                  eq(listMembers.contactId, link.rows[0].contact_id),
                  eq(listMembers.workspaceId, a.workspaceId),
                  eq(listMembers.environment, a.environment),
                ),
              );
          await db.execute(
            sql`INSERT INTO crm_contact_links(workspace_id,environment,source_id,contact_id) VALUES(${a.workspaceId},${a.environment},${row.source_id},${contact.id}) ON CONFLICT(workspace_id,environment,source_id) DO UPDATE SET contact_id=excluded.contact_id`,
          );
          const evidence =
            !!row.consent_source &&
            !!row.evidence &&
            !!row.policy_version &&
            !!row.consent_at &&
            row.consent_at.getTime() <= Date.now();
          const next =
            row.consent_status === 'unsubscribed'
              ? 'unsubscribed'
              : row.consent_status === 'subscribed' && evidence && contact.marketingConsent === 'unknown'
                ? 'subscribed'
                : contact.marketingConsent;
          if (next !== contact.marketingConsent && next !== 'unknown') {
            await db
              .update(contacts)
              .set({ marketingConsent: next, updatedAt: new Date().toISOString() })
              .where(eq(contacts.id, contact.id));
            await db
              .insert(consentAudit)
              .values({
                id: id('consent'),
                ...a,
                contactId: contact.id,
                email: contact.email,
                status: next,
                source: row.consent_source ?? 'crm-sync',
                policyVersion: row.policy_version,
                evidence: row.evidence,
                actorKeyId: null,
                occurredAt: row.consent_at?.toISOString() ?? new Date().toISOString(),
              });
          }
          imported++;
        }
        const last = source.rows.at(-1);
        if (last && (!(last.updated_at instanceof Date) || typeof last.source_id !== 'string'))
          throw new ApiError(
            422,
            'CRM_CURSOR_INVALID',
            'The CRM view must expose a timestamp updated_at and text source_id.',
          );
        const more = source.rows.length === 500;
        await db.execute(
          sql`UPDATE crm_sync_state SET checkpoint_at=${last?.updated_at?.toISOString() ?? s.checkpoint_at}::timestamptz,checkpoint_id=${last?.source_id ?? s.checkpoint_id},scanned=scanned+${source.rows.length},imported=imported+${imported},errors=errors+${failed},status=${more ? 'running' : 'idle'},last_success_at=${more ? sql`last_success_at` : sql`now()`},next_at=now()+${config.intervalMinutes}*interval '1 minute',updated_at=now() WHERE ${scope(a)}`,
        );
        if (more) await enqueue(db, { type: 'audience.crm', ...a, payload: {} });
      });
      await connection.query('COMMIT');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'CRM_SYNC_FAILED';
      await runtime.db.execute(
        sql`UPDATE crm_sync_state SET status='failed',error_code=${code},next_at=now()+interval '15 minutes',updated_at=now() WHERE ${scope(a)}`,
      );
      throw new ApiError(503, code, 'CRM sync failed. Check the read-only connection and source view mapping.');
    } finally {
      await connection.end().catch(() => undefined);
    }
  },
};
