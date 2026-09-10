import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { CreateEmailTemplateCommand, GetEmailTemplateCommand, UpdateEmailTemplateCommand } from '@aws-sdk/client-sesv2';
import {
  actor,
  ApiError,
  digest,
  errors,
  getSes,
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
import { templates, templateVersions } from './db/templates.js';
import { TemplateArtifact, validateTemplate } from './template-content.js';
import { enqueue } from './jobs.js';
import { assertRegionEnabled } from './ses-region-state.js';
import { s3Storage } from './adapters/storage.js';

const scope = (a: Pick<Actor, 'workspaceId' | 'environment'>) =>
  and(eq(templates.workspaceId, a.workspaceId), eq(templates.environment, a.environment));
const Template = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['marketing', 'automation']),
    revision: z.number(),
    publishedVersionId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('LibraryTemplate');
const Validation = z.object({ valid: z.boolean(), errors: z.array(z.string()), bytes: z.number() });
const Version = z
  .object({
    id: z.string(),
    templateId: z.string(),
    revision: z.number(),
    subject: z.string(),
    checksum: z.string(),
    status: z.enum(['draft', 'publishing', 'published', 'failed']),
    region: z.string().nullable(),
    sesName: z.string().nullable(),
    legacySesName: z.string().nullable(),
    errorCode: z.string().nullable(),
    validation: Validation,
    createdAt: z.string(),
    publishedAt: z.string().nullable(),
  })
  .openapi('TemplateVersion');
const VersionParams = IdParams.extend({ versionId: z.string().min(1).max(120) });
export const SaveTemplate = z.object({ revision: z.number().int().nonnegative(), artifact: TemplateArtifact }).strict();
export function templateStorage(runtime: Runtime) {
  return runtime.config.templateS3 ? s3Storage(runtime.config.templateS3) : runtime.storage;
}
export async function findTemplate(
  db: DbExecutor,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  templateId: string,
  lock = false,
) {
  const query = db
    .select()
    .from(templates)
    .where(and(scope(a), eq(templates.id, templateId)));
  const [row] = await (lock ? query.for('update') : query);
  return row ?? notFound('Template');
}
export async function getTemplateVersion(
  runtime: Runtime,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  versionId: string,
  db: DbExecutor = runtime.db,
  published = true,
) {
  const [version] = await db
    .select()
    .from(templateVersions)
    .where(
      and(
        eq(templateVersions.id, versionId),
        eq(templateVersions.workspaceId, a.workspaceId),
        eq(templateVersions.environment, a.environment),
      ),
    );
  if (!version) notFound('Template version');
  if (published && version.status !== 'published')
    throw new ApiError(409, 'TEMPLATE_NOT_PUBLISHED', 'Select a published template version.');
  const object = await templateStorage(runtime).get(version.artifactKey);
  const source = object ? new TextDecoder().decode(object.body) : '';
  if (!object || (await digest(source)) !== version.checksum)
    throw new ApiError(
      503,
      'TEMPLATE_ARTIFACT_UNAVAILABLE',
      'The immutable template artifact is unavailable or changed.',
      undefined,
      true,
    );
  return { version, artifact: TemplateArtifact.parse(JSON.parse(source)) };
}
export async function saveTemplate(
  runtime: Runtime,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  templateId: string,
  input: z.infer<typeof SaveTemplate>,
) {
  const source = JSON.stringify(input.artifact);
  if (new TextEncoder().encode(source).byteLength > 6 * 1024 * 1024)
    throw new ApiError(413, 'TEMPLATE_TOO_LARGE', 'A source bundle must be at most 6 MiB.');
  const checksum = await digest(source),
    validation = validateTemplate(input.artifact);
  return runtime.db.transaction(async (db) => {
    const template = await findTemplate(db, a, templateId, true);
    // A retried save of exactly the same artifact returns the committed version.
    const [last] = await db
      .select()
      .from(templateVersions)
      .where(and(eq(templateVersions.templateId, template.id), eq(templateVersions.revision, input.revision + 1)));
    if (last?.checksum === checksum) return Version.parse(last);
    if (template.revision !== input.revision)
      throw new ApiError(409, 'STALE_TEMPLATE_REVISION', 'Fetch the latest template before saving.');
    const versionId = id('tplv'),
      artifactKey = `${a.workspaceId}/${a.environment}/templates/${template.id}/${versionId}.json`;
    await templateStorage(runtime).put(artifactKey, new TextEncoder().encode(source), 'application/json');
    const [version] = await db
      .insert(templateVersions)
      .values({
        id: versionId,
        templateId,
        ...a,
        revision: template.revision + 1,
        artifactKey,
        checksum,
        subject: input.artifact.subject,
        validation,
      })
      .returning();
    await db
      .update(templates)
      .set({ revision: template.revision + 1, updatedAt: new Date().toISOString() })
      .where(eq(templates.id, templateId));
    return Version.parse(version);
  });
}
function unrestricted(a: Actor) {
  if (a.domains.length)
    throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Template management requires an unrestricted principal.');
}
export function registerTemplates(app: App) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library',
      operationId: 'createLibraryTemplate',
      tags: ['Templates'],
      security,
      request: {
        body: json(
          z
            .object({
              name: z.string().trim().min(1).max(200),
              kind: z.enum(['marketing', 'automation']).default('marketing'),
            })
            .strict(),
        ),
      },
      responses: { 201: response(Template), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage');
      unrestricted(a);
      const [row] = await c.env.db
        .insert(templates)
        .values({ id: id('tpl'), workspaceId: a.workspaceId, environment: a.environment, ...c.req.valid('json') })
        .returning();
      return c.json(Template.parse(row), 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library',
      operationId: 'listLibraryTemplates',
      tags: ['Templates'],
      security,
      request: { query: PageQuery },
      responses: { 200: response(page(Template)), ...errors },
    }),
    async (c) => {
      const a = actor(c);
      unrestricted(a);
      const q = c.req.valid('query');
      const rows = await c.env.db
        .select()
        .from(templates)
        .where(and(scope(a), q.cursor ? gt(templates.id, q.cursor) : undefined))
        .orderBy(asc(templates.id))
        .limit(q.limit + 1);
      return c.json(
        {
          data: rows.slice(0, q.limit).map((r) => Template.parse(r)),
          nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library/{id}',
      operationId: 'getLibraryTemplate',
      tags: ['Templates'],
      security,
      request: { params: IdParams },
      responses: { 200: response(Template), ...errors },
    }),
    async (c) => {
      const a = actor(c);
      unrestricted(a);
      return c.json(Template.parse(await findTemplate(c.env.db, a, c.req.valid('param').id)), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library/{id}/versions',
      operationId: 'saveTemplateVersion',
      description: 'Save a versioned React source bundle and rendered HTML/text. Does not publish or send email.',
      tags: ['Templates'],
      security,
      request: { params: IdParams, body: json(SaveTemplate) },
      responses: { 201: response(Version), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage');
      unrestricted(a);
      return c.json(await saveTemplate(c.env, a, c.req.valid('param').id, c.req.valid('json')), 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library/{id}/versions',
      operationId: 'listTemplateVersions',
      tags: ['Templates'],
      security,
      request: { params: IdParams, query: PageQuery },
      responses: { 200: response(page(Version)), ...errors },
    }),
    async (c) => {
      const a = actor(c);
      unrestricted(a);
      const t = await findTemplate(c.env.db, a, c.req.valid('param').id),
        q = c.req.valid('query');
      const rows = await c.env.db
        .select()
        .from(templateVersions)
        .where(
          and(
            eq(templateVersions.templateId, t.id),
            q.cursor ? sql`${templateVersions.revision} < ${Number(q.cursor) || 0}` : undefined,
          ),
        )
        .orderBy(desc(templateVersions.revision))
        .limit(q.limit + 1);
      return c.json(
        {
          data: rows.slice(0, q.limit).map((r) => Version.parse(r)),
          nextCursor: rows.length > q.limit ? String(rows[q.limit - 1]!.revision) : null,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library/{id}/versions/{versionId}',
      operationId: 'getTemplateArtifact',
      tags: ['Templates'],
      security,
      request: { params: VersionParams },
      responses: { 200: response(z.object({ version: Version, artifact: TemplateArtifact })), ...errors },
    }),
    async (c) => {
      const a = actor(c);
      unrestricted(a);
      const p = c.req.valid('param');
      const result = await getTemplateVersion(c.env, a, p.versionId, c.env.db, false);
      if (result.version.templateId !== p.id) notFound('Template version');
      return c.json({ version: Version.parse(result.version), artifact: result.artifact }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library/{id}/versions/{versionId}/publish',
      operationId: 'publishTemplateVersion',
      description:
        'Explicitly publish this immutable version to SES. Test environment simulates publication. Updating an existing legacy SES name requires updateLegacy=true.',
      tags: ['Templates'],
      security,
      request: {
        params: VersionParams,
        body: json(z.object({ region: z.string(), updateLegacy: z.boolean().default(false) }).strict()),
      },
      responses: { 202: response(Version), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'manage');
      unrestricted(a);
      const p = c.req.valid('param'),
        input = c.req.valid('json');
      const result = await c.env.db.transaction(async (db) => {
        await findTemplate(db, a, p.id, true);
        const { version, artifact } = await getTemplateVersion(c.env, a, p.versionId, db, false);
        if (version.templateId !== p.id) notFound('Template version');
        if (version.status === 'published' || version.status === 'publishing') {
          if (version.region !== input.region || Boolean(version.legacySesName) !== input.updateLegacy)
            throw new ApiError(409, 'PUBLICATION_CONFLICT', 'This version already has a different publication target.');
          return version;
        }
        const validation = validateTemplate(artifact);
        if (!validation.valid) throw new ApiError(422, 'TEMPLATE_VALIDATION_FAILED', validation.errors.join(' '));
        const selectedRegion = await assertRegionEnabled(db, a.workspaceId, input.region);
        const sesName = `os_${version.id}`;
        if (input.updateLegacy && !artifact.legacySesName)
          throw new ApiError(422, 'LEGACY_NAME_REQUIRED', 'This artifact has no legacy SES name.');
        const [updated] = await db
          .update(templateVersions)
          .set({
            status: 'publishing',
            region: selectedRegion,
            sesName,
            legacySesName: input.updateLegacy ? artifact.legacySesName : null,
            errorCode: null,
          })
          .where(eq(templateVersions.id, version.id))
          .returning();
        await enqueue(db, {
          type: 'template.publish',
          workspaceId: a.workspaceId,
          environment: a.environment,
          payload: { versionId: version.id },
        });
        return updated!;
      });
      return c.json(Version.parse(result), 202);
    },
  );
}
export const templateJobs: Record<string, JobHandler> = {
  'template.publish': async (runtime, payload, job) => {
    const a = { workspaceId: job.workspaceId, environment: job.environment };
    const { version, artifact } = await getTemplateVersion(runtime, a, String(payload.versionId), runtime.db, false);
    if (version.status === 'published') return;
    if (!version.sesName || !version.region || version.status !== 'publishing') return;
    try {
      if (a.environment === 'live') {
        const ses = getSes(runtime, version.region);
        const content = { Subject: artifact.subject, Html: artifact.html, Text: artifact.text };
        try {
          await ses.send(new CreateEmailTemplateCommand({ TemplateName: version.sesName, TemplateContent: content }));
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'AlreadyExistsException') throw error;
          const existing = await ses.send(new GetEmailTemplateCommand({ TemplateName: version.sesName }));
          if (
            existing.TemplateContent?.Subject !== content.Subject ||
            existing.TemplateContent?.Html !== content.Html ||
            existing.TemplateContent?.Text !== content.Text
          )
            throw new ApiError(
              409,
              'SES_TEMPLATE_COLLISION',
              'The SES version name already contains different content.',
            );
        }
        if (version.legacySesName)
          await runtime.db.transaction(async (db) => {
            const lockKey = `${a.workspaceId}:${version.region}:${version.legacySesName}`;
            await db.execute(sql`INSERT INTO template_publication_locks(id) VALUES(${lockKey}) ON CONFLICT DO NOTHING`);
            await db.execute(sql`SELECT id FROM template_publication_locks WHERE id=${lockKey} FOR UPDATE`);
            const newer = await db.execute(
              sql`SELECT v.id FROM template_versions v JOIN template_library t ON t.id=v.template_id WHERE t.workspace_id=${a.workspaceId} AND t.environment=${a.environment} AND v.legacy_ses_name=${version.legacySesName} AND v.region=${version.region} AND v.status='published' AND v.created_at > ${version.createdAt}::timestamptz LIMIT 1`,
            );
            if (newer.rows.length) return;
            try {
              await ses.send(
                new UpdateEmailTemplateCommand({ TemplateName: version.legacySesName!, TemplateContent: content }),
              );
            } catch (error) {
              if (!(error instanceof Error) || error.name !== 'NotFoundException') throw error;
              await ses.send(
                new CreateEmailTemplateCommand({ TemplateName: version.legacySesName!, TemplateContent: content }),
              );
            }
            await db
              .update(templateVersions)
              .set({ status: 'published', publishedAt: new Date().toISOString(), errorCode: null })
              .where(eq(templateVersions.id, version.id));
          });
      }
      await runtime.db.transaction(async (db) => {
        await findTemplate(db, a, version.templateId, true);
        await db
          .update(templateVersions)
          .set({ status: 'published', publishedAt: new Date().toISOString(), errorCode: null })
          .where(eq(templateVersions.id, version.id));
        // A slow older publication must not replace a newer published version.
        await db.execute(
          sql`UPDATE template_library SET published_version_id = ${version.id}, updated_at = now() WHERE id = ${version.templateId} AND (published_version_id IS NULL OR (SELECT revision FROM template_versions WHERE id = published_version_id) <= ${version.revision})`,
        );
      });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'SES_PUBLICATION_FAILED';
      await runtime.db
        .update(templateVersions)
        .set({
          status: job.attempts >= 6 || (error instanceof ApiError && !error.retryable) ? 'failed' : 'publishing',
          errorCode: code,
        })
        .where(eq(templateVersions.id, version.id));
      throw error instanceof ApiError
        ? error
        : new ApiError(503, code, 'SES publication failed. Check regional access and retry.', undefined, true);
    }
  },
};
