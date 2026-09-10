import { createHmac } from 'node:crypto';
import { enqueue } from './jobs.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
import {
  actor,
  ApiError,
  digest,
  errors,
  id,
  IdParams,
  json,
  response,
  security,
  type App,
  type Runtime,
  type JobHandler,
} from './core.js';
import { templateSessions, templates } from './db/templates.js';
import { findTemplate, getTemplateVersion, saveTemplate, SaveTemplate } from './templates.js';

export async function openCode(
  runtime: Runtime,
  path: string,
  method = 'GET',
  body?: unknown,
  allowMissing = false,
): Promise<Record<string, unknown>> {
  const config = runtime.config.openCode;
  if (!config)
    throw new ApiError(503, 'AUTHORING_NOT_CONFIGURED', 'Configure the OpenCode authoring connection first.');
  let result: Response;
  try {
    result = await fetch(`${config.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.password
          ? {
              authorization: `Basic ${Buffer.from(`${config.username ?? 'opencode'}:${config.password}`).toString('base64')}`,
            }
          : config.token
            ? { authorization: `Bearer ${config.token}` }
            : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new ApiError(
      503,
      'AUTHORING_UNAVAILABLE',
      'The authoring server is unavailable. Retry to resume the saved session.',
      undefined,
      true,
    );
  }
  if (allowMissing && result.status === 404) return {};
  if (!result.ok)
    throw new ApiError(
      503,
      'AUTHORING_REQUEST_FAILED',
      `The authoring server returned ${result.status}. Check its configuration.`,
      undefined,
      true,
    );
  if (result.status === 204) return {};
  const text = await result.text();
  if (text.length > 2 * 1024 * 1024)
    throw new ApiError(503, 'AUTHORING_RESPONSE_TOO_LARGE', 'The authoring response exceeded its limit.');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ApiError(503, 'AUTHORING_RESPONSE_INVALID', 'The authoring server returned invalid JSON.');
  }
}
const Session = z
  .object({
    sessionId: z.string().nullable(),
    expiresAt: z.string().nullable(),
    configured: z.boolean(),
    inputStatus: z.string().nullable().optional(),
    errorCode: z.string().nullable().optional(),
  })
  .openapi('TemplateAuthoringSession');
const Message = z.object({ id: z.string(), role: z.string(), text: z.string() });
// Session projections can contain tool output. Only expose ordinary text, with capabilities redacted.
function messages(result: Record<string, unknown>) {
  const data = Array.isArray(result.data) ? result.data : [];
  return data
    .map((entry: Record<string, unknown>) => {
      const parts = Array.isArray(entry.content) ? (entry.content as Record<string, unknown>[]) : [];
      const text =
        typeof entry.text === 'string'
          ? entry.text
          : parts
              .filter((p) => p.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text)
              .join('\n');
      return {
        id: String(entry.id ?? ''),
        role: String(entry.type ?? entry.role ?? 'assistant'),
        text: text
          .replace(/\[OPENSEND_AUTHOR_CONTEXT\][\s\S]*?\[END_OPENSEND_AUTHOR_CONTEXT\]\s*/g, '')
          .replace(/os_tpl_[a-f0-9]+/g, '[template capability]')
          .slice(0, 20000),
      };
    })
    .filter((m) => m.text);
}
export function registerAuthoring(app: App) {
  const authorized = async (c: Parameters<typeof actor>[0], permission: 'read' | 'manage' = 'manage') => {
    const a = actor(c, permission);
    if (a.domains.length)
      throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Authoring requires an unrestricted principal.');
    const templateId = c.req.param('id')!;
    await findTemplate(c.env.db, a, templateId);
    return { a, templateId };
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library/{id}/authoring',
      operationId: 'getTemplateAuthoring',
      tags: ['Templates'],
      security,
      request: { params: IdParams },
      responses: { 200: response(Session), ...errors },
    }),
    async (c) => {
      const { templateId } = await authorized(c, 'read');
      const [session] = await c.env.db
        .select()
        .from(templateSessions)
        .where(eq(templateSessions.templateId, templateId));
      const latest = await c.env.db.execute<{ status: string; error_code: string | null }>(
        sql`SELECT status,error_code FROM template_author_inputs WHERE template_id=${templateId} ORDER BY created_at DESC LIMIT 1`,
      );
      return c.json(
        {
          sessionId: session?.sessionId ?? null,
          expiresAt: session?.expiresAt ?? null,
          configured: !!c.env.config.openCode,
          inputStatus: latest.rows[0]?.status ?? null,
          errorCode: latest.rows[0]?.error_code ?? null,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library/{id}/authoring',
      operationId: 'promptTemplateAuthor',
      description:
        'Start or resume an isolated authoring session. The author can save drafts only; publishing and sending are separate actions.',
      tags: ['Templates'],
      security,
      request: {
        params: IdParams,
        body: json(
          z
            .object({ prompt: z.string().trim().min(1).max(20000), messageId: z.string().regex(/^msg_[a-f0-9]{32}$/) })
            .strict(),
        ),
      },
      responses: { 202: response(Session), ...errors },
    }),
    async (c) => {
      const { a, templateId } = await authorized(c);
      const input = c.req.valid('json');
      const config = c.env.config.openCode;
      if (!config)
        throw new ApiError(503, 'AUTHORING_NOT_CONFIGURED', 'Configure the OpenCode authoring connection first.');
      const result = await c.env.db.transaction(async (db) => {
        await findTemplate(db, a, templateId, true);
        const checksum = await digest(input.prompt);
        const previous = await db.execute<{ template_id: string; checksum: string }>(
          sql`SELECT template_id,checksum FROM template_author_inputs WHERE id=${input.messageId}`,
        );
        if (previous.rows[0] && (previous.rows[0].template_id !== templateId || previous.rows[0].checksum !== checksum))
          throw new ApiError(409, 'AUTHOR_INPUT_CONFLICT', 'This message ID already has different instructions.');
        let [session] = await db.select().from(templateSessions).where(eq(templateSessions.templateId, templateId));
        if (!session || Date.parse(session.expiresAt) < Date.now()) {
          const sessionId = session?.sessionId ?? id('ses');
          const expiresAt = new Date(Date.now() + 24 * 3600000).toISOString();
          const tokenHash = await digest(authorCapability(c.env, templateId, sessionId, expiresAt));
          [session] = await db
            .insert(templateSessions)
            .values({
              templateId,
              workspaceId: a.workspaceId,
              environment: a.environment,
              sessionId,
              tokenHash,
              expiresAt,
            })
            .onConflictDoUpdate({ target: templateSessions.templateId, set: { tokenHash, expiresAt } })
            .returning();
        }
        if (!previous.rows[0]) {
          await db.execute(
            sql`INSERT INTO template_author_inputs(id,template_id,prompt,checksum) VALUES(${input.messageId},${templateId},${input.prompt},${checksum})`,
          );
          await enqueue(db, {
            type: 'template.author',
            workspaceId: a.workspaceId,
            environment: a.environment,
            payload: { templateId, messageId: input.messageId },
          });
        }
        return { sessionId: session!.sessionId, expiresAt: session!.expiresAt, configured: true };
      });
      return c.json(result, 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/template-library/{id}/authoring/messages',
      operationId: 'getTemplateAuthorMessages',
      tags: ['Templates'],
      security,
      request: { params: IdParams },
      responses: { 200: response(z.object({ data: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const { templateId } = await authorized(c, 'read');
      const [session] = await c.env.db
        .select()
        .from(templateSessions)
        .where(eq(templateSessions.templateId, templateId));
      return c.json(
        {
          data: session
            ? messages(
                await openCode(
                  c.env,
                  `/api/session/${encodeURIComponent(session.sessionId)}/message?limit=30&order=desc`,
                  'GET',
                  undefined,
                  true,
                ),
              ).reverse()
            : [],
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/template-library/{id}/authoring/interrupt',
      operationId: 'interruptTemplateAuthor',
      tags: ['Templates'],
      security,
      request: { params: IdParams },
      responses: { 200: response(z.object({ interrupted: z.literal(true) })), ...errors },
    }),
    async (c) => {
      const { templateId } = await authorized(c);
      const [session] = await c.env.db
        .select()
        .from(templateSessions)
        .where(eq(templateSessions.templateId, templateId));
      await c.env.db.execute(
        sql`UPDATE template_author_inputs SET status='canceled',error_code=NULL WHERE template_id=${templateId} AND status='pending'`,
      );
      await c.env.db
        .update(templateSessions)
        .set({ expiresAt: new Date(0).toISOString() })
        .where(eq(templateSessions.templateId, templateId));
      if (session) await openCode(c.env, `/api/session/${encodeURIComponent(session.sessionId)}/interrupt`, 'POST', {});
      return c.json({ interrupted: true as const }, 200);
    },
  );
  // A narrowly scoped capability is intentionally separate from public API-key authentication.
  app.use('/authoring/templates/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!/^os_tpl_[a-f0-9]{64}$/.test(token))
      throw new ApiError(401, 'AUTHORING_CAPABILITY_INVALID', 'A valid template capability is required.');
    const [session] = await c.env.db
      .select()
      .from(templateSessions)
      .where(
        and(
          eq(templateSessions.templateId, decodeURIComponent(c.req.path.split('/')[3] ?? '')),
          eq(templateSessions.tokenHash, await digest(token)),
        ),
      );
    if (!session || Date.parse(session.expiresAt) <= Date.now())
      throw new ApiError(401, 'AUTHORING_CAPABILITY_EXPIRED', 'Resume authoring to renew this capability.');
    c.set('actor', {
      workspaceId: session.workspaceId,
      environment: session.environment,
      keyId: session.sessionId,
      permissions: ['read'],
      domains: [],
    });
    await next();
  });
  app.get('/authoring/templates/:id', async (c) => {
    const a = actor(c),
      template = await findTemplate(c.env.db, a, c.req.param('id'));
    const latest = await c.env.db.execute<{ id: string }>(sqlLatest(template.id));
    const artifact = latest.rows[0]
      ? (await getTemplateVersion(c.env, a, latest.rows[0].id, c.env.db, false)).artifact
      : null;
    return c.json({ revision: template.revision, kind: template.kind, artifact });
  });
  app.put('/authoring/templates/:id', async (c) => {
    const input = SaveTemplate.safeParse(await c.req.json());
    if (!input.success) throw new ApiError(422, 'TEMPLATE_ARTIFACT_INVALID', 'The template artifact is invalid.');
    return c.json(await saveTemplate(c.env, actor(c), c.req.param('id'), input.data), 201);
  });
}
import { sql } from 'drizzle-orm';
const sqlLatest = (templateId: string) =>
  sql`SELECT id FROM template_versions WHERE template_id = ${templateId} ORDER BY revision DESC LIMIT 1`;

function authorCapability(runtime: Runtime, templateId: string, sessionId: string, expiresAt: string) {
  return `os_tpl_${createHmac('sha256', runtime.config.authSecret)
    .update(`opensend:template:${templateId}:${sessionId}:${new Date(expiresAt).toISOString()}`)
    .digest('hex')}`;
}
export const authoringJobs: Record<string, JobHandler> = {
  'template.author': async (runtime, payload, job) => {
    const templateId = String(payload.templateId),
      messageId = String(payload.messageId),
      a = { workspaceId: job.workspaceId, environment: job.environment };
    const template = await findTemplate(runtime.db, a, templateId);
    const [session] = await runtime.db
      .select()
      .from(templateSessions)
      .where(eq(templateSessions.templateId, templateId));
    const input = await runtime.db.execute<{ prompt: string; status: string }>(
      sql`SELECT prompt,status FROM template_author_inputs WHERE id=${messageId} AND template_id=${templateId}`,
    );
    if (!session || Date.parse(session.expiresAt) < Date.now() || !input.rows[0] || input.rows[0].status !== 'pending')
      return;
    const config = runtime.config.openCode;
    if (!config) throw new ApiError(503, 'AUTHORING_NOT_CONFIGURED', 'Configure the authoring server.');
    try {
      const remote = await openCode(
        runtime,
        `/api/session/${encodeURIComponent(session.sessionId)}`,
        'GET',
        undefined,
        true,
      );
      if (!remote.data)
        await openCode(runtime, '/api/session', 'POST', {
          id: session.sessionId,
          title: template.name,
          agent: config.agent,
          location: { directory: `${config.directory}/${templateId}` },
        });
      const token = authorCapability(runtime, templateId, session.sessionId, session.expiresAt);
      const instructions = `[OPENSEND_AUTHOR_CONTEXT]You author this OpenSend template only, in the assigned directory. Restore with GET ${runtime.config.publicUrl}/authoring/templates/${templateId} using Authorization: Bearer ${token}. Save with PUT to that URL, JSON {revision,artifact}. artifact contains subject, previewText, html, text, source (relative filename to contents), dependencies (package to exact version), fields ([{name,required,sample,default?}]), legacySesName?. Run TypeScript checking and React Email rendering before saving. Bundle every local import. Upload raster images with POST to the same template URL plus /images, JSON {contentType,content:base64}; returned image URLs are public and immutable. Use {{unsubscribeUrl}} in marketing footer links; declare other simple personalization fields. Never publish, read contacts, or send mail. Do not print the bearer token. [END_OPENSEND_AUTHOR_CONTEXT]\n\n`;
      await openCode(runtime, `/api/session/${encodeURIComponent(session.sessionId)}/prompt`, 'POST', {
        id: messageId,
        text: instructions + input.rows[0].prompt,
      });
      await runtime.db.execute(
        sql`UPDATE template_author_inputs SET status='sent',error_code=NULL WHERE id=${messageId} AND status='pending'`,
      );
    } catch (error) {
      await runtime.db.execute(
        sql`UPDATE template_author_inputs SET status=${job.attempts >= 6 ? 'failed' : 'pending'},error_code=${error instanceof ApiError ? error.code : 'AUTHORING_UNAVAILABLE'} WHERE id=${messageId} AND status='pending'`,
      );
      throw error;
    }
  },
};
