import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
import { contacts } from './db/audience.js';
import { campaigns, emails, type CampaignDraft, type EmailSnapshot, type ReviewedRecipient } from './db/sending.js';
import { audienceConditions } from './audience.js';
import {
  campaignMessage,
  personalizeCampaign,
  appendMarketingFooter,
  renderCampaignContent,
  canonical,
  checkPending,
  editable,
  findCampaign,
  lockAdmission,
  queueEmail,
  readyCampaign,
  sender,
} from './sending.js';
import { MAX_ATTEMPTS, enqueue } from './jobs.js';

export interface CampaignRun extends Record<string, unknown> {
  id: string;
  campaign_id: string;
  workspace_id: string;
  environment: 'live' | 'test';
  revision: number;
  draft: CampaignDraft;
  content: Awaited<ReturnType<typeof renderCampaignContent>> | null;
  actor: Actor;
  status: string;
  frozen: boolean;
  matched: number;
  eligible: number;
  suppressed: number;
  unsubscribed: number;
  prepared: number;
  expanded: number;
  cursor: string;
  error_code: string | null;
  scheduled_at: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}
interface Recipient extends Record<string, unknown> {
  contact_id: string;
  email: string;
  name: string | null;
  properties: Record<string, unknown>;
  eligible: boolean;
  exclusion: string | null;
  email_id: string | null;
}
const Run = z
  .object({
    id: z.string(),
    campaignId: z.string(),
    revision: z.number(),
    status: z.string(),
    matched: z.number(),
    eligible: z.number(),
    suppressed: z.number(),
    unsubscribed: z.number(),
    prepared: z.number(),
    expanded: z.number(),
    errorCode: z.string().nullable(),
    contentHash: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('CampaignPreparation');
const view = (r: CampaignRun) =>
  Run.parse({
    ...r,
    campaignId: r.campaign_id,
    errorCode: r.error_code,
    contentHash: r.content_hash,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  });
const scope = (a: Pick<Actor, 'workspaceId' | 'environment'>) =>
  sql`workspace_id = ${a.workspaceId} AND environment = ${a.environment}`;
const asContact = (r: Recipient): ReviewedRecipient => ({
  id: r.contact_id,
  email: r.email,
  ...(r.name ? { name: r.name } : {}),
  properties: r.properties,
});
export async function findRun(
  db: DbExecutor,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  runId: string,
  lock = false,
) {
  const result = await db.execute<CampaignRun>(
    sql`SELECT * FROM campaign_runs WHERE id = ${runId} AND ${scope(a)} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  return result.rows[0];
}
export async function launchPreparedCampaign(
  runtime: Runtime,
  db: DbExecutor,
  a: Actor,
  campaignId: string,
  input: { reviewId: string; revision: number; scheduledAt?: string },
) {
  const run = await findRun(db, a, input.reviewId, true);
  if (!run) return null;
  const row = await findCampaign(db, a, campaignId, true);
  editable(row, input.revision);
  if (
    run.campaign_id !== campaignId ||
    run.revision !== input.revision ||
    run.status !== 'ready' ||
    row.reviewId !== run.id ||
    row.status !== 'reviewed'
  )
    throw new ApiError(409, 'STALE_CAMPAIGN_REVIEW', 'Review the current revision before sending.');
  sender(runtime, a, run.draft.from, run.draft.region);
  const status = input.scheduledAt ? ('scheduled' as const) : ('sending' as const);
  await db.execute(
    sql`UPDATE campaign_runs SET status=${status}, actor=${JSON.stringify(a)}::jsonb, cursor='', scheduled_at=${input.scheduledAt ?? new Date().toISOString()}::timestamptz, updated_at=now() WHERE id=${run.id}`,
  );
  await db
    .update(campaigns)
    .set({ status, scheduledAt: input.scheduledAt ?? null, updatedAt: new Date().toISOString() })
    .where(eq(campaigns.id, campaignId));
  await enqueue(db, {
    type: 'campaign.expand',
    workspaceId: a.workspaceId,
    environment: a.environment,
    payload: { runId: run.id },
    availableAt: input.scheduledAt,
  });
  return {
    id: campaignId,
    status,
    queued: 0,
    scheduledAt: input.scheduledAt ?? null,
    simulated: a.environment === 'test',
  };
}
export async function hydrateCampaignSnapshot(
  runtime: Runtime,
  a: Pick<Actor, 'workspaceId' | 'environment'>,
  snapshot: EmailSnapshot,
): Promise<EmailSnapshot> {
  if (!snapshot.campaignContent) return snapshot;
  const ref = snapshot.campaignContent,
    run = await findRun(runtime.db, a, ref.runId);
  if (!run) throw new ApiError(503, 'CAMPAIGN_CONTENT_UNAVAILABLE', 'The immutable campaign content is unavailable.');
  const result = await runtime.db.execute<Recipient>(
    sql`SELECT * FROM campaign_recipients WHERE run_id=${run.id} AND contact_id=${ref.contactId}`,
  );
  if (!result.rows[0])
    throw new ApiError(503, 'CAMPAIGN_CONTENT_UNAVAILABLE', 'The immutable recipient snapshot is unavailable.');
  const unsubscribe = snapshot.headers.find((h) => h.Name === 'List-Unsubscribe')?.Value.slice(1, -1);
  if (!run.content || !unsubscribe)
    throw new ApiError(503, 'CAMPAIGN_CONTENT_UNAVAILABLE', 'The frozen campaign content is incomplete.');
  const body = personalizeCampaign(run.draft, asContact(result.rows[0]), run.content, unsubscribe);
  const hydrated = { ...snapshot, html: body.html, text: body.text };
  appendMarketingFooter(hydrated, unsubscribe);
  return hydrated;
}
export function registerCampaignRuns(app: App) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/campaigns/{id}/prepare',
      operationId: 'prepareCampaign',
      description:
        'Asynchronously freeze and validate up to 250,000 matching contacts. Poll getCampaignPreparation until ready. Send/schedule with the resulting review ID and revision.',
      tags: ['Campaigns'],
      security,
      request: { params: IdParams, body: json(z.object({ revision: z.number().int().positive() }).strict()) },
      responses: { 202: response(Run), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'send'),
        campaignId = c.req.valid('param').id,
        { revision } = c.req.valid('json');
      const result = await c.env.db.transaction(async (db) => {
        const row = await findCampaign(db, a, campaignId, true);
        editable(row, revision);
        const draft = readyCampaign(row.draft);
        sender(c.env, a, draft.from, draft.region);
        const previous = await db.execute<CampaignRun>(
          sql`SELECT * FROM campaign_runs WHERE campaign_id=${campaignId} AND revision=${revision} AND status NOT IN ('failed','canceled')`,
        );
        if (previous.rows[0]) return previous.rows[0];
        const runId = id('review'),
          hash = await digest(canonical(draft));
        const inserted = await db.execute<CampaignRun>(
          sql`INSERT INTO campaign_runs(id,campaign_id,workspace_id,environment,revision,draft,actor,content_hash) VALUES(${runId},${campaignId},${a.workspaceId},${a.environment},${revision},${JSON.stringify(draft)}::jsonb,${JSON.stringify(a)}::jsonb,${hash}) RETURNING *`,
        );
        await enqueue(db, {
          type: 'campaign.prepare',
          workspaceId: a.workspaceId,
          environment: a.environment,
          payload: { runId },
        });
        return inserted.rows[0]!;
      });
      return c.json(view(result), 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/campaigns/{id}/preparation',
      operationId: 'getCampaignPreparation',
      tags: ['Campaigns'],
      security,
      request: { params: IdParams },
      responses: { 200: response(Run.nullable()), ...errors },
    }),
    async (c) => {
      const a = actor(c),
        row = await findCampaign(c.env.db, a, c.req.valid('param').id);
      const result = await c.env.db.execute<CampaignRun>(
        sql`SELECT * FROM campaign_runs WHERE campaign_id=${row.id} AND revision=${row.revision} ORDER BY created_at DESC LIMIT 1`,
      );
      return c.json(result.rows[0] ? view(result.rows[0]) : null, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/campaigns/{id}/resume-expansion',
      operationId: 'resumeCampaignExpansion',
      description:
        'Resume a failed expansion from its frozen review. Only recipients without an email record are queued; existing sends are never replayed.',
      tags: ['Campaigns'],
      security,
      request: { params: IdParams },
      responses: { 202: response(Run), ...errors },
    }),
    async (c) => {
      const a = actor(c, 'send'),
        campaignId = c.req.valid('param').id;
      const result = await c.env.db.transaction(async (db) => {
        await lockAdmission(db, a);
        const selected = await db.execute<CampaignRun>(
            sql`SELECT * FROM campaign_runs WHERE campaign_id=${campaignId} AND ${scope(a)} ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          ),
          run = selected.rows[0];
        const campaign = await findCampaign(db, a, campaignId, true);
        if (
          !run ||
          run.status !== 'failed' ||
          !['sending', 'scheduled'].includes(campaign.status) ||
          campaign.reviewId !== run.id
        )
          throw new ApiError(
            409,
            'CAMPAIGN_NOT_RESUMABLE',
            'Only a failed, previously authorized expansion can be resumed.',
          );
        sender(c.env, a, run.draft.from, run.draft.region);
        const updated = await db.execute<CampaignRun>(
          sql`UPDATE campaign_runs SET status='sending',actor=${JSON.stringify(a)}::jsonb,error_code=NULL,updated_at=now() WHERE id=${run.id} RETURNING *`,
        );
        await enqueue(db, {
          type: 'campaign.expand',
          workspaceId: a.workspaceId,
          environment: a.environment,
          payload: { runId: run.id },
        });
        return updated.rows[0]!;
      });
      return c.json(view(result), 202);
    },
  );
  const Progress = z
    .object({
      campaignId: z.string(),
      status: z.string(),
      preparation: Run.nullable(),
      total: z.number(),
      statuses: z.record(z.string(), z.number()),
      outcomes: z.record(z.string(), z.number()),
      daily: z.array(z.object({ day: z.string(), outcome: z.string(), count: z.number() })),
      remaining: z.number(),
      perSecond: z.number().nullable(),
      estimatedSeconds: z.number().nullable(),
      updatedAt: z.string(),
    })
    .openapi('CampaignProgress');
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/campaigns/{id}/progress',
      operationId: 'getCampaignProgress',
      description:
        'Durable campaign progress and distinct-message outcomes. Dispatch completion is separate from delivery. Open/click observations are not verified human activity.',
      tags: ['Campaigns'],
      security,
      request: { params: IdParams },
      responses: { 200: response(Progress), ...errors },
    }),
    async (c) => {
      const a = actor(c),
        row = await findCampaign(c.env.db, a, c.req.valid('param').id);
      const results = await Promise.all([
        c.env.db.execute<CampaignRun>(
          sql`SELECT * FROM campaign_runs WHERE campaign_id=${row.id} ORDER BY created_at DESC LIMIT 1`,
        ),
        c.env.db.execute<{
          total: number;
          statuses: Record<string, number>;
          outcomes: Record<string, number>;
          updated_at: string;
        }>(sql`SELECT * FROM campaign_statistics WHERE campaign_id=${row.id}`),
        c.env.db.execute<{ day: string; outcome: string; count: number }>(
          sql`SELECT day::text,outcome,count FROM campaign_daily_statistics WHERE campaign_id=${row.id} ORDER BY day DESC LIMIT 3650`,
        ),
      ]);
      const run = results[0].rows[0],
        stats = results[1].rows[0],
        statuses = stats?.statuses ?? {},
        outcomes = stats?.outcomes ?? {};
      if (row.status === 'canceled' && run)
        statuses.canceled = (statuses.canceled ?? 0) + Math.max(0, run.eligible - run.expanded);
      const remaining =
        (statuses.queued ?? 0) +
        (statuses.attempting ?? 0) +
        (run && !['completed', 'canceled'].includes(row.status) ? Math.max(0, run.eligible - run.expanded) : 0);
      const elapsed = run ? Math.max(0, (Date.now() - Date.parse(run.scheduled_at ?? run.created_at)) / 1000) : 0;
      const processed = (stats?.total ?? 0) - (statuses.queued ?? 0) - (statuses.attempting ?? 0);
      const rate = elapsed >= 30 && processed >= 20 ? processed / elapsed : null;
      return c.json(
        {
          campaignId: row.id,
          status: row.status,
          preparation: run ? view(run) : null,
          total: stats?.total ?? 0,
          statuses,
          outcomes,
          daily: results[2].rows,
          remaining,
          perSecond: rate,
          estimatedSeconds: rate && remaining ? Math.ceil(remaining / rate) : null,
          updatedAt: stats?.updated_at ?? row.updatedAt,
        },
        200,
      );
    },
  );
  const RecipientView = z.object({
    contactId: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    eligible: z.boolean(),
    exclusion: z.string().nullable(),
    emailId: z.string().nullable(),
    status: z.string().nullable(),
    errorCode: z.string().nullable(),
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/campaigns/{id}/recipients',
      operationId: 'getCampaignRecipients',
      tags: ['Campaigns'],
      security,
      request: { params: IdParams, query: PageQuery.extend({ status: z.string().max(60).optional() }) },
      responses: { 200: response(page(RecipientView)), ...errors },
    }),
    async (c) => {
      const a = actor(c),
        row = await findCampaign(c.env.db, a, c.req.valid('param').id),
        q = c.req.valid('query');
      const r = await c.env.db.execute<{
        contactId: string;
        email: string;
        name: string | null;
        eligible: boolean;
        exclusion: string | null;
        emailId: string | null;
        status: string | null;
        errorCode: string | null;
      }>(
        sql`SELECT r.contact_id AS "contactId",r.email,r.name,r.eligible,r.exclusion,r.email_id AS "emailId",coalesce(e.status,CASE WHEN r.eligible AND ${row.status}='canceled' THEN 'canceled' ELSE NULL END) status,e.error_code AS "errorCode" FROM campaign_recipients r LEFT JOIN sending_emails e ON e.id=r.email_id WHERE r.run_id=(SELECT id FROM campaign_runs WHERE campaign_id=${row.id} ORDER BY created_at DESC LIMIT 1) AND r.contact_id>${q.cursor ?? ''} ${q.status ? sql`AND coalesce(e.status,r.exclusion,CASE WHEN ${row.status}='canceled' THEN 'canceled' ELSE 'pending' END)=${q.status}` : sql``} ORDER BY r.contact_id LIMIT ${q.limit + 1}`,
      );
      return c.json(
        { data: r.rows.slice(0, q.limit), nextCursor: r.rows.length > q.limit ? r.rows[q.limit - 1]!.contactId : null },
        200,
      );
    },
  );
}
async function withRun(
  runtime: Runtime,
  payload: Record<string, unknown>,
  job: Parameters<JobHandler>[2],
  work: (db: DbExecutor, run: CampaignRun) => Promise<void>,
) {
  try {
    await runtime.db.transaction(async (db) => {
      await lockAdmission(db, {
        workspaceId: job.workspaceId,
        environment: job.environment,
        keyId: 'worker',
        permissions: ['manage'],
        domains: [],
      });
      const run = await findRun(
        db,
        { workspaceId: job.workspaceId, environment: job.environment },
        String(payload.runId),
        true,
      );
      if (run) await work(db, run);
    });
  } catch (error) {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError(
            503,
            'CAMPAIGN_JOB_FAILED',
            'Campaign processing failed; retrying its durable checkpoint.',
            undefined,
            true,
          );
    if (!failure.retryable || job.attempts >= MAX_ATTEMPTS)
      await runtime.db.execute(
        sql`UPDATE campaign_runs SET status='failed',error_code=${failure.code},updated_at=now() WHERE id=${String(payload.runId)} AND ${scope({ workspaceId: job.workspaceId, environment: job.environment })} AND status NOT IN ('completed','canceled')`,
      );
    throw failure;
  }
}
export const campaignRunJobs: Record<string, JobHandler> = {
  'campaign.prepare': async (runtime, payload, job) =>
    withRun(runtime, payload, job, async (db, run) => {
      if (run.status !== 'preparing') return;
      const campaign = await findCampaign(db, run.actor, run.campaign_id, true);
      if (campaign.revision !== run.revision || campaign.archivedAt || !['draft', 'reviewed'].includes(campaign.status))
        throw new ApiError(409, 'STALE_CAMPAIGN_REVISION', 'The campaign changed during preparation.');
      if (!run.frozen) {
        run.content = await renderCampaignContent(runtime, run.draft, true, run.actor, db);
        await db.execute(
          sql`UPDATE campaign_runs SET content=${JSON.stringify(run.content)}::jsonb WHERE id=${run.id}`,
        );
        const conditions = await audienceConditions(db, run.actor, readyCampaign(run.draft).audience);
        const where = and(
          eq(contacts.workspaceId, run.workspace_id),
          eq(contacts.environment, run.environment),
          isNull(contacts.deletedAt),
          ...conditions,
        );
        await db.execute(
          sql`INSERT INTO campaign_recipients(run_id,contact_id,email,name,properties,eligible,exclusion) SELECT ${run.id},${contacts.id},${contacts.email},${contacts.name},${contacts.properties},NOT ${contacts.suppressed} AND ${contacts.marketingConsent}='subscribed',CASE WHEN ${contacts.suppressed} THEN 'suppressed' WHEN ${contacts.marketingConsent}<>'subscribed' THEN 'unsubscribed' ELSE NULL END FROM ${contacts} WHERE ${where} ORDER BY ${contacts.id} LIMIT 250001`,
        );
        const counts = await db.execute<{
          matched: number;
          eligible: number;
          suppressed: number;
          unsubscribed: number;
        }>(
          sql`SELECT count(*)::int matched,count(*) FILTER(WHERE eligible)::int eligible,count(*) FILTER(WHERE exclusion='suppressed')::int suppressed,count(*) FILTER(WHERE exclusion='unsubscribed')::int unsubscribed FROM campaign_recipients WHERE run_id=${run.id}`,
        );
        const total = counts.rows[0]!;
        if (total.matched > 250000)
          throw new ApiError(422, 'AUDIENCE_LIMIT_EXCEEDED', 'Campaigns support at most 250,000 matching contacts.');
        if (!total.eligible) throw new ApiError(422, 'EMPTY_AUDIENCE', 'No eligible subscribed recipients.');
        await db.execute(
          sql`UPDATE campaign_runs SET frozen=true,matched=${total.matched},eligible=${total.eligible},suppressed=${total.suppressed},unsubscribed=${total.unsubscribed},updated_at=now() WHERE id=${run.id}`,
        );
      }
      const recipients = await db.execute<Recipient>(
        sql`SELECT * FROM campaign_recipients WHERE run_id=${run.id} AND eligible AND contact_id>${run.cursor} ORDER BY contact_id LIMIT 100`,
      );
      for (const recipient of recipients.rows)
        await campaignMessage(
          runtime,
          db,
          run.actor,
          run.draft,
          asContact(recipient),
          false,
          true,
          undefined,
          undefined,
          run.content ?? undefined,
        );
      if (recipients.rows.length) {
        await db.execute(
          sql`UPDATE campaign_runs SET prepared=prepared+${recipients.rows.length},cursor=${recipients.rows.at(-1)!.contact_id},updated_at=now() WHERE id=${run.id}`,
        );
        await enqueue(db, {
          type: 'campaign.prepare',
          workspaceId: run.workspace_id,
          environment: run.environment,
          payload: { runId: run.id },
        });
      } else {
        await db.execute(sql`UPDATE campaign_runs SET status='ready',cursor='',updated_at=now() WHERE id=${run.id}`);
        await db
          .update(campaigns)
          .set({ status: 'reviewed', reviewId: run.id, updatedAt: new Date().toISOString() })
          .where(eq(campaigns.id, run.campaign_id));
      }
    }),
  'campaign.expand': async (runtime, payload, job) =>
    withRun(runtime, payload, job, async (db, run) => {
      if (!['sending', 'scheduled'].includes(run.status)) return;
      const campaign = await findCampaign(db, run.actor, run.campaign_id, true);
      if (campaign.status === 'canceled') {
        await db.execute(sql`UPDATE campaign_runs SET status='canceled',updated_at=now() WHERE id=${run.id}`);
        return;
      }
      if (run.scheduled_at && Date.parse(run.scheduled_at) > Date.now()) {
        await enqueue(db, {
          type: 'campaign.expand',
          workspaceId: run.workspace_id,
          environment: run.environment,
          payload: { runId: run.id },
          availableAt: run.scheduled_at,
        });
        return;
      }
      const recipients = await db.execute<Recipient>(
        sql`SELECT * FROM campaign_recipients WHERE run_id=${run.id} AND eligible AND email_id IS NULL ORDER BY contact_id LIMIT ${run.environment === 'test' ? 20 : 100}`,
      );
      try {
        await checkPending(db, run.actor, recipients.rows.length);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'PENDING_EMAIL_LIMIT_EXCEEDED') throw error;
        await enqueue(db, {
          type: 'campaign.expand',
          workspaceId: run.workspace_id,
          environment: run.environment,
          payload: { runId: run.id },
          availableAt: new Date(Date.now() + 5000).toISOString(),
        });
        return;
      }
      for (const recipient of recipients.rows) {
        const snapshot = await campaignMessage(
          runtime,
          db,
          run.actor,
          run.draft,
          asContact(recipient),
          false,
          false,
          undefined,
          undefined,
          run.content ?? undefined,
        );
        snapshot.campaignContent = { runId: run.id, contactId: recipient.contact_id };
        delete snapshot.html;
        delete snapshot.text;
        const receipt = await queueEmail(db, run.actor, snapshot, run.campaign_id, undefined);
        await db.execute(
          sql`UPDATE campaign_recipients SET email_id=${receipt.id} WHERE run_id=${run.id} AND contact_id=${recipient.contact_id}`,
        );
      }
      await db.execute(
        sql`UPDATE campaign_runs SET expanded=expanded+${recipients.rows.length},status='sending',updated_at=now() WHERE id=${run.id}`,
      );
      if (recipients.rows.length)
        await enqueue(db, {
          type: 'campaign.expand',
          workspaceId: run.workspace_id,
          environment: run.environment,
          payload: { runId: run.id },
        });
      else {
        const pending = await db
          .select({ id: emails.id })
          .from(emails)
          .where(and(eq(emails.campaignId, run.campaign_id), sql`${emails.status} IN ('queued','attempting')`))
          .limit(1);
        if (pending.length)
          await enqueue(db, {
            type: 'campaign.expand',
            workspaceId: run.workspace_id,
            environment: run.environment,
            payload: { runId: run.id },
            availableAt: new Date(Date.now() + 5000).toISOString(),
          });
        if (!pending.length) {
          await db.execute(sql`UPDATE campaign_runs SET status='completed',updated_at=now() WHERE id=${run.id}`);
          await db
            .update(campaigns)
            .set({ status: 'completed', updatedAt: new Date().toISOString() })
            .where(eq(campaigns.id, run.campaign_id));
        }
      }
    }),
};
