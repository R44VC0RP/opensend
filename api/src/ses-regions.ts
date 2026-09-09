import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { actor, ApiError, errors, id, json, response, security, type Actor, type App, type JobHandler, type Runtime } from './core.js';
import { apiKeys, jobs } from './db/core.js';
import { domains } from './db/operations.js';
import { sesRegions } from './db/ses-regions.js';
import { isApprovedUser } from './google-auth.js';
import { getMcpGrantActor } from './mcp-auth.js';
import { enqueue } from './jobs.js';
import { assertProvisionable, discoverSes, provisionSes, SesDiscoverySchema, type SesDiscovery } from './ses-setup.js';
import { assertRegionEnabled, configureRegion, credentialFingerprint, discoveryTarget, DISCOVERY_TTL, getRegionSettings, regionCatalog, regionPattern, regionWhere } from './ses-region-state.js';
export { ensureRegionSettings, resolveRegionRuntime } from './ses-region-state.js';

const Params = z.object({ region: z.string().max(32).regex(regionPattern) }).openapi('SesRegionParams');
const Catalog = z.object({ defaultRegion: z.string(), data: z.array(z.object({
  region: z.string(), enabled: z.boolean(), isDefault: z.boolean(),
  discoveryStatus: z.enum(['not_discovered', 'discovering', 'stale', 'ready', 'needs_provisioning', 'blocked']),
  lastDiscoveredAt: z.string().nullable(), provisionJobId: z.string().nullable(),
  provisionStatus: z.enum(['pending', 'running', 'completed', 'failed']).nullable(), provisionError: z.string().nullable(),
})) }).openapi('RegionCatalog');
const Receipt = z.object({ jobId: z.string(), status: z.enum(['pending', 'running']) }).openapi('RegionProvisionReceipt');
function access(c: Parameters<typeof actor>[0], mutate = false, aws = false) {
  const value = actor(c, mutate ? 'manage' : 'read');
  if (value.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Region configuration requires unrestricted workspace access.');
  if ((mutate || aws) && value.environment !== 'live') throw new ApiError(403, 'TEST_EXTERNAL_OPERATION', 'Use live administrator context for AWS discovery and region configuration.');
  return value;
}
async function saveDiscovery(runtime: Runtime, report: SesDiscovery, jobId?: string) {
  const fingerprint = await credentialFingerprint(runtime.config);
  await runtime.db.transaction(async tx => {
    await tx.insert(sesRegions).values({ workspaceId: runtime.config.workspaceId, region: report.region }).onConflictDoNothing();
    const updated = await tx.update(sesRegions).set({ report, credentialsFingerprint: fingerprint, publicUrl: discoveryTarget(runtime.config), lastDiscoveredAt: report.checkedAt })
      .where(and(regionWhere(runtime.config.workspaceId, report.region), jobId ? eq(sesRegions.provisionJobId, jobId) : undefined,
        sql`(${sesRegions.lastDiscoveredAt} IS NULL OR ${sesRegions.lastDiscoveredAt} <= ${report.checkedAt}::timestamptz)`)).returning({ region: sesRegions.region });
    if (!updated.length) return;
    for (const domain of report.domains) await tx.insert(domains).values({ id: id('domain'), workspaceId: runtime.config.workspaceId, environment: 'live', region: report.region, name: domain.name }).onConflictDoNothing();
  });
}
export function registerSesRegions(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/regions', operationId: 'listRegions', tags: ['Regions'], security,
    description: 'Lists persisted region settings and cached discovery/job status without AWS calls. The environment default only seeds installation settings during migration.',
    responses: { 200: response(Catalog), ...errors },
  }), async c => { access(c); return c.json(Catalog.parse(await regionCatalog(c.env)), 200); });
  app.openapi(createRoute({ method: 'put', path: '/v1/regions/{region}', operationId: 'configureRegion', tags: ['Regions'], security,
    description: 'Enable/disable a region or choose the default. Changes are shared by live and test modes; requires unrestricted live management access. Disabling never deletes AWS resources or historical mail.',
    request: { params: Params, body: json(z.object({ enabled: z.boolean().optional(), makeDefault: z.boolean().optional() }).strict().refine(value => value.enabled !== undefined || value.makeDefault === true, 'Choose enabled or makeDefault.').openapi('ConfigureRegion')) },
    responses: { 200: response(Catalog), ...errors },
  }), async c => { access(c, true); return c.json(Catalog.parse(await configureRegion(c.env, c.req.valid('param').region, c.req.valid('json'))), 200); });
  app.openapi(createRoute({ method: 'get', path: '/v1/regions/{region}/discovery', operationId: 'discoverRegion', tags: ['Regions'], security,
    description: 'Read-only AWS discovery. Caches observations in PostgreSQL for 15 minutes; refresh=true forces AWS reads. Never creates resources or subscribes endpoints. Credential or public-origin changes invalidate the cache.',
    request: { params: Params, query: z.object({ refresh: z.enum(['true', 'false']).optional() }) }, responses: { 200: response(SesDiscoverySchema), ...errors },
  }), async c => {
    access(c, false, true); const { region } = c.req.valid('param');
    const settings = await getRegionSettings(c.env.db, c.env.config.workspaceId);
    if (!settings.enabledRegions.includes(region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'Enable this SES region before discovery.', 'region');
    const [cached] = await c.env.db.select().from(sesRegions).where(regionWhere(c.env.config.workspaceId, region)).limit(1);
    const fingerprint = await credentialFingerprint(c.env.config);
    if (c.req.valid('query').refresh !== 'true' && cached?.report && cached.credentialsFingerprint === fingerprint && cached.publicUrl === discoveryTarget(c.env.config) && cached.lastDiscoveredAt && Date.now() - Date.parse(cached.lastDiscoveredAt) < DISCOVERY_TTL) return c.json(SesDiscoverySchema.parse(cached.report), 200);
    const report = await discoverSes(c.env, { region, installationId: settings.installationId });
    await saveDiscovery(c.env, report); return c.json(report, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/regions/{region}/provision', operationId: 'provisionRegion', tags: ['Regions'], security,
    description: 'Explicitly queue idempotent setup of OpenSend-owned SES configuration sets, SNS topic/policy/event destinations and signed HTTPS subscription. Never sends email, changes DNS, or grants SES production approval. Repeated requests reuse the active job; inspect listRegions and discovery for completion and remaining blockers.',
    request: { params: Params, body: json(z.object({ confirm: z.literal(true) }).strict().openapi('ProvisionRegion')) }, responses: { 202: response(Receipt), ...errors },
  }), async c => {
    const value = access(c, true); assertProvisionable(c.env); const { region } = c.req.valid('param');
    const receipt = await c.env.db.transaction(async tx => {
      await assertRegionEnabled(tx, value.workspaceId, region);
      await tx.insert(sesRegions).values({ workspaceId: value.workspaceId, region }).onConflictDoNothing();
      const [row] = await tx.select().from(sesRegions).where(regionWhere(value.workspaceId, region)).for('update');
      if (row!.provisionJobId) {
        const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, row!.provisionJobId), eq(jobs.workspaceId, value.workspaceId))).limit(1);
        if (job && ['pending', 'running'].includes(job.status)) return { jobId: job.id, status: job.status as 'pending' | 'running' };
      }
      const jobId = await enqueue(tx, { type: 'ses.provision', workspaceId: value.workspaceId, environment: 'live', payload: {
        region, actorKeyId: value.keyId, credentialsFingerprint: await credentialFingerprint(c.env.config), publicUrl: discoveryTarget(c.env.config), requestId: c.get('requestId'),
      } });
      await tx.update(sesRegions).set({ provisionJobId: jobId }).where(regionWhere(value.workspaceId, region));
      return { jobId, status: 'pending' as const };
    });
    return c.json(receipt, 202);
  });
}
async function approvedOrigin(runtime: Runtime, keyId: string) {
  if (keyId.startsWith('user_')) return isApprovedUser(runtime, keyId.slice(5));
  if (keyId.startsWith('mcp_')) {
    const grant = await getMcpGrantActor(runtime, keyId);
    return !!grant && grant.environment === 'live' && grant.permissions.includes('manage') && !grant.domains.length;
  }
  const [key] = await runtime.db.select().from(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, runtime.config.workspaceId), eq(apiKeys.environment, 'live'), isNull(apiKeys.revokedAt))).limit(1);
  return Boolean(key?.permissions.includes('manage') && !key.domains.length);
}
const provision: JobHandler = async (runtime, payload, job) => {
  const parsed = Params.safeParse(payload);
  if (!parsed.success || job.environment !== 'live' || job.workspaceId !== runtime.config.workspaceId || typeof payload.actorKeyId !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid SES provisioning job.');
  const { region } = parsed.data;
  if (payload.credentialsFingerprint !== await credentialFingerprint(runtime.config) || payload.publicUrl !== discoveryTarget(runtime.config)) throw new ApiError(409, 'AWS_CONNECTION_CHANGED', 'AWS credentials or public URL changed; request provisioning again.');
  if (!await approvedOrigin(runtime, payload.actorKeyId)) throw new ApiError(403, 'ORIGIN_KEY_REVOKED', 'The provisioning principal is no longer authorized.');
  const settings = await getRegionSettings(runtime.db, job.workspaceId);
  if (!settings.enabledRegions.includes(region)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The provisioning region is disabled.');
  const [row] = await runtime.db.select().from(sesRegions).where(regionWhere(job.workspaceId, region)).limit(1);
  if (row?.provisionJobId !== job.id) throw new ApiError(409, 'PROVISION_SUPERSEDED', 'A newer provisioning job superseded this request.');
  const report = await provisionSes(runtime, { region, installationId: settings.installationId,
    registerTopic: async (accountId, topicArn) => {
      const updated = await runtime.db.update(sesRegions).set({ trustedAccountId: accountId, trustedTopicArn: topicArn, trustedCredentialsFingerprint: await credentialFingerprint(runtime.config) })
        .where(and(regionWhere(job.workspaceId, region), eq(sesRegions.provisionJobId, job.id), sql`EXISTS (SELECT 1 FROM jobs WHERE id=${job.id} AND status='running' AND attempts=${job.attempts})`)).returning({ region: sesRegions.region });
      if (!updated.length) throw new ApiError(409, 'PROVISION_SUPERSEDED', 'This provisioning job no longer owns the region.');
    },
  });
  await saveDiscovery(runtime, report, job.id);
};
// Startup schedules only read-only discovery. Concurrent worker starts reuse active jobs.
export async function queueStartupDiscovery(runtime: Runtime): Promise<number> {
  if (!runtime.config.aws) return 0;
  const fingerprint = await credentialFingerprint(runtime.config), target = discoveryTarget(runtime.config);
  return runtime.db.transaction(async tx => {
    const settings = await getRegionSettings(tx, runtime.config.workspaceId, 'update');
    const rows = await tx.select().from(sesRegions).where(eq(sesRegions.workspaceId, runtime.config.workspaceId));
    const active = await tx.select({ payload: jobs.payload }).from(jobs).where(and(eq(jobs.workspaceId, runtime.config.workspaceId), eq(jobs.type, 'ses.discover'), inArray(jobs.status, ['pending', 'running'])));
    let count = 0;
    for (const region of settings.enabledRegions) {
      const row = rows.find(value => value.region === region);
      if (row?.lastDiscoveredAt && row.credentialsFingerprint === fingerprint && row.publicUrl === target && Date.now() - Date.parse(row.lastDiscoveredAt) < DISCOVERY_TTL) continue;
      if (active.some(job => job.payload.region === region && job.payload.credentialsFingerprint === fingerprint && job.payload.publicUrl === target)) continue;
      await enqueue(tx, { type: 'ses.discover', workspaceId: runtime.config.workspaceId, environment: 'live', payload: { region, credentialsFingerprint: fingerprint, publicUrl: target } });
      count++;
    }
    return count;
  });
}
const discover: JobHandler = async (runtime, payload, job) => {
  const parsed = Params.safeParse(payload);
  if (!parsed.success || job.environment !== 'live' || job.workspaceId !== runtime.config.workspaceId) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid SES discovery job.');
  if (payload.credentialsFingerprint !== await credentialFingerprint(runtime.config) || payload.publicUrl !== discoveryTarget(runtime.config)) throw new ApiError(409, 'AWS_CONNECTION_CHANGED', 'Discovery connection settings changed.');
  const settings = await getRegionSettings(runtime.db, job.workspaceId);
  if (!settings.enabledRegions.includes(parsed.data.region)) return;
  const report = await discoverSes(runtime, { region: parsed.data.region, installationId: settings.installationId });
  await saveDiscovery(runtime, report);
};
export const sesRegionJobs = { 'ses.provision': provision, 'ses.discover': discover };
