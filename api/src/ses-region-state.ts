import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, digest, id, type Config, type Database, type DbExecutor, type Runtime } from './core.js';
import { sesRegions, sesSettings } from './db/ses-regions.js';
import { campaigns, emails } from './db/sending.js';
import { jobs } from './db/core.js';
import { feedbackTarget, setupResources } from './ses-setup.js';

export const discoveryTarget = (config: Config) => JSON.stringify([config.publicUrl, feedbackTarget(config)]);

export const regionPattern = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
export const DISCOVERY_TTL = 15 * 60 * 1000;
const settingWhere = (workspaceId: string) => eq(sesSettings.workspaceId, workspaceId);
export const regionWhere = (workspaceId: string, region: string) => and(eq(sesRegions.workspaceId, workspaceId), eq(sesRegions.region, region));
export async function credentialFingerprint(config: Config) {
  // The AWS SDK annotates credential objects with internal metadata during real requests.
  // Only actual credential fields identify the connection, never those mutable annotations.
  return digest(JSON.stringify(config.aws ? [config.aws.accessKeyId, config.aws.secretAccessKey, config.aws.sessionToken ?? null] : null));
}
// Called by the explicit migration command, never an AWS discovery request.
export async function ensureRegionSettings(db: Database, config: Config) {
  if ((await db.select().from(sesSettings).where(settingWhere(config.workspaceId)).limit(1)).length) return;
  const used = await db.execute<{ region: string }>(sql`SELECT region FROM sending_emails WHERE workspace_id=${config.workspaceId}
    UNION SELECT draft->>'region' FROM sending_campaigns WHERE workspace_id=${config.workspaceId}
    UNION SELECT region FROM operation_domains WHERE workspace_id=${config.workspaceId}`);
  const enabledRegions = [...new Set([...config.regions, ...used.rows.map(row => row.region)])];
  if (!enabledRegions.length || enabledRegions.length > 40 || enabledRegions.some(region => !regionPattern.test(region))) throw new ApiError(503, 'REGION_MIGRATION_REQUIRED', 'Existing region data requires an explicit migration plan.');
  await db.insert(sesSettings).values({ workspaceId: config.workspaceId, installationId: id('install'), defaultRegion: config.regions[0]!, enabledRegions }).onConflictDoNothing();
}
export async function getRegionSettings(db: DbExecutor, workspaceId: string, lock: 'share' | 'update' | undefined = undefined) {
  const query = db.select().from(sesSettings).where(settingWhere(workspaceId)).limit(1);
  const [settings] = await (lock ? query.for(lock) : query);
  if (!settings) throw new ApiError(503, 'REGION_SETTINGS_NOT_INITIALIZED', 'Run database migrations to initialize SES region settings.');
  return settings;
}
export async function assertRegionEnabled(db: DbExecutor, workspaceId: string, region?: string) {
  const settings = await getRegionSettings(db, workspaceId, 'share');
  const selected = region ?? settings.defaultRegion;
  if (!settings.enabledRegions.includes(selected)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested SES region is not enabled.', 'region');
  return selected;
}
export async function assertLiveRegionReady(runtime: Runtime, db: DbExecutor, region: string, stream: 'transactional' | 'marketing', retryable = false) {
  const [row] = await db.select().from(sesRegions).where(regionWhere(runtime.config.workspaceId, region)).limit(1);
  if (!row?.report?.provisioned || row.report.account?.sendingEnabled !== true || row.credentialsFingerprint !== await credentialFingerprint(runtime.config) || row.publicUrl !== discoveryTarget(runtime.config) || row.trustedAccountId !== row.report.account?.id || row.trustedTopicArn !== row.report.resources.topic.arn || row.report.resources[stream].sendingEnabled !== true) {
    throw new ApiError(409, 'SES_SETUP_REQUIRED', 'Run discovery and complete provisioning for this region before live sending.', 'region', retryable);
  }
}
export async function resolveRegionRuntime(runtime: Runtime): Promise<Runtime> {
  const settings = await getRegionSettings(runtime.db, runtime.config.workspaceId);
  const resources = setupResources(settings.installationId);
  const trusted = await runtime.db.select({ region: sesRegions.region, account: sesRegions.trustedAccountId, arn: sesRegions.trustedTopicArn }).from(sesRegions)
    .where(eq(sesRegions.workspaceId, runtime.config.workspaceId));
  const valid = trusted.filter(row => row.account && /^\d{12}$/.test(row.account) && row.arn === `arn:aws:sns:${row.region}:${row.account}:${resources.topicName}`);
  const accounts = new Set(valid.map(row => row.account!));
  return { ...runtime, config: { ...runtime.config,
    regions: [settings.defaultRegion, ...settings.enabledRegions.filter(region => region !== settings.defaultRegion)],
    configurationSets: { transactional: resources.transactional, marketing: resources.marketing },
    // A disabled sending region retains its authenticated feedback channel for historical mail.
    snsTopicArns: accounts.size === 1 ? valid.map(row => row.arn!) : [],
    awsAccountId: accounts.size === 1 ? valid[0]!.account! : undefined,
  } };
}
export async function regionCatalog(runtime: Runtime) {
  const settings = await getRegionSettings(runtime.db, runtime.config.workspaceId);
  const fingerprint = await credentialFingerprint(runtime.config);
  const rows = await runtime.db.select({ region: sesRegions.region, status: sql<string | null>`${sesRegions.report}->>'status'`,
    lastDiscoveredAt: sesRegions.lastDiscoveredAt, fingerprint: sesRegions.credentialsFingerprint, publicUrl: sesRegions.publicUrl,
    provisionJobId: sesRegions.provisionJobId, provisionStatus: jobs.status, provisionError: jobs.lastError,
  }).from(sesRegions).leftJoin(jobs, and(eq(jobs.id, sesRegions.provisionJobId), eq(jobs.workspaceId, sesRegions.workspaceId)))
    .where(eq(sesRegions.workspaceId, runtime.config.workspaceId));
  const active = await runtime.db.select({ payload: jobs.payload }).from(jobs).where(and(eq(jobs.workspaceId, runtime.config.workspaceId), eq(jobs.type, 'ses.discover'), inArray(jobs.status, ['pending', 'running'])));
  const regions = [...new Set([...settings.enabledRegions, ...rows.map(row => row.region)])].sort();
  return { defaultRegion: settings.defaultRegion, data: regions.map(region => {
    const row = rows.find(value => value.region === region);
    const stale = row?.lastDiscoveredAt && (row.fingerprint !== fingerprint || row.publicUrl !== discoveryTarget(runtime.config) || Date.now() - Date.parse(row.lastDiscoveredAt) >= DISCOVERY_TTL);
    const discovering = active.some(job => job.payload.region === region && job.payload.credentialsFingerprint === fingerprint && job.payload.publicUrl === discoveryTarget(runtime.config));
    const discoveryStatus = discovering ? 'discovering' : !row?.lastDiscoveredAt ? 'not_discovered' : stale ? 'stale' : row.status ?? 'not_discovered';
    return { region, enabled: settings.enabledRegions.includes(region), isDefault: region === settings.defaultRegion,
      discoveryStatus, lastDiscoveredAt: row?.lastDiscoveredAt ?? null, provisionJobId: row?.provisionJobId ?? null,
      provisionStatus: row?.provisionStatus ?? null, provisionError: row?.provisionError ?? null };
  }) };
}
export async function configureRegion(runtime: Runtime, region: string, input: { enabled?: boolean; makeDefault?: boolean }) {
  await runtime.db.transaction(async tx => {
    const settings = await getRegionSettings(tx, runtime.config.workspaceId, 'update');
    let enabled = settings.enabledRegions;
    if (input.enabled === false) {
      if (settings.defaultRegion === region || input.makeDefault) throw new ApiError(409, 'REGION_DEFAULT_REQUIRED', 'Choose another default region before disabling this one.');
      const pending = await tx.select({ id: emails.id }).from(emails).where(and(eq(emails.workspaceId, runtime.config.workspaceId), eq(emails.region, region), inArray(emails.status, ['queued', 'attempting', 'acceptance_unknown']))).limit(1);
      const scheduled = await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.workspaceId, runtime.config.workspaceId), sql`${campaigns.draft}->>'region'=${region}`, inArray(campaigns.status, ['scheduled', 'sending']))).limit(1);
      const provisioning = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, runtime.config.workspaceId), eq(jobs.type, 'ses.provision'), sql`${jobs.payload}->>'region'=${region}`, inArray(jobs.status, ['pending', 'running']))).limit(1);
      if (pending.length || scheduled.length || provisioning.length) throw new ApiError(409, 'REGION_IN_USE', 'This region has queued, in-flight, or uncertain work. Resolve it before disabling the region.');
      enabled = enabled.filter(value => value !== region);
    } else if (input.enabled === true || input.makeDefault) enabled = [...new Set([...enabled, region])];
    const existing = await tx.select({ region: sesRegions.region }).from(sesRegions).where(eq(sesRegions.workspaceId, runtime.config.workspaceId));
    if (new Set([...enabled, ...existing.map(row => row.region), region]).size > 40) throw new ApiError(422, 'REGION_LIMIT_EXCEEDED', 'At most 40 SES regions may be configured.');
    await tx.insert(sesRegions).values({ workspaceId: runtime.config.workspaceId, region }).onConflictDoNothing();
    await tx.update(sesSettings).set({ enabledRegions: enabled, defaultRegion: input.makeDefault ? region : settings.defaultRegion }).where(settingWhere(runtime.config.workspaceId));
  });
  return regionCatalog(runtime);
}
