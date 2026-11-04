import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, errors, id, json, log, notFound, response, type App, type Ctx, type Runtime, type JobHandler } from './core.js';
import { caller, assume, platformCredentials } from './provider-credentials.js';
import { awsError, feedbackUrl, POOL_INSTALLATION, provisionSes, provisionTenant, setupResources, type SesDiscovery } from './ses-setup.js';
import { regionPattern, getRegionSettings } from './ses-region-state.js';
import { retryDatabaseFailures } from './jobs.js';
import { preparePoolReceiving, sharedInboundDomain } from './mailbox-setup.js';

const tags = ['Workspaces'], security = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
const Kind = z.enum(['shared', 'byo']);
const Create = z.object({ kind: Kind, region: z.string().max(32).regex(regionPattern).optional() }).strict().openapi('CreateConnection');
const AccountId = z.string().regex(/^\d{12}$/).openapi({ example: '123456789012' });
const Connection = z.object({ id: z.string(), kind: Kind, region: z.string(), status: z.enum(['pending', 'ready']), awsAccountId: z.string().nullable(), roleArn: z.string().nullable(), templateVersion: z.string().nullable(), quickCreateUrl: z.url().nullable() }).openapi('ProviderConnection');
// Safe for every workspace member: no account IDs, role ARNs or external IDs.
export const ConnectionSummary = z.object({ kind: Kind, region: z.string(), status: z.enum(['pending', 'ready']) }).openapi('ConnectionSummary');
type Row = { id: string; workspace_id: string; kind: 'shared' | 'byo'; region: string; status: 'pending' | 'ready'; aws_account_id: string | null; role_arn: string | null; external_id: string | null; platform_principal_arn: string | null; template_version: string | null };

function owner(c: Ctx) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard' || (a.role !== 'owner' && a.role !== 'admin')) throw new ApiError(403, 'PERMISSION_DENIED', 'Use an owner or admin dashboard session to manage sending connections.');
  return a.workspaceId;
}
function template(runtime: Runtime) {
  if (!runtime.config.byoTemplateUrl) throw new ApiError(503, 'BYO_NOT_CONFIGURED', 'Bring-your-own AWS is not configured.');
  return runtime.config.byoTemplateUrl;
}
const platformRegion = 'us-east-2';
const sharedRegions = (runtime: Runtime) => runtime.config.sharedRegions ?? [platformRegion];
const principals = new Map<string, { account: string; arn: string }>();
async function platformIdentity(runtime: Runtime, expectedAccount?: string) {
  const key = platformCredentials(runtime), cached = principals.get(key.accessKeyId);
  if (cached) {
    if (expectedAccount && cached.account !== expectedAccount) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    return cached;
  }
  const identity = await caller(platformRegion, key);
  if (!identity.Account || !/^\d{12}$/.test(identity.Account) || !identity.Arn?.startsWith(`arn:aws:iam::${identity.Account}:user/`)) throw new ApiError(503, 'PLATFORM_PRINCIPAL_INVALID', 'Use an IAM user in the commercial AWS partition for the platform connection.');
  if (expectedAccount && identity.Account !== expectedAccount) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
  const value = { account: identity.Account, arn: identity.Arn };
  principals.set(key.accessKeyId, value); return value;
}
// Commercial regions with an SES sending endpoint: https://docs.aws.amazon.com/general/latest/gr/ses.html
const byoRegions = ['us-east-2', 'us-east-1', 'us-west-1', 'us-west-2', 'af-south-1', 'ap-south-2', 'ap-southeast-3', 'ap-southeast-5', 'ap-south-1', 'ap-northeast-3', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-south-1', 'eu-west-3', 'eu-north-1', 'eu-central-2',
  'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1'];
const stackName = (row: Row) => `OpenSendMX-${row.id.slice(-20)}`;
function view(runtime: Runtime, row: Row) {
  let quickCreateUrl: string | null = null;
  if (row.kind === 'byo' && row.status === 'pending') {
    const params = new URLSearchParams({ templateURL: template(runtime), stackName: stackName(row), param_ExternalId: row.external_id!, param_PlatformPrincipalArn: row.platform_principal_arn!, param_ReceiveMail: 'false',
      param_ResourcePrefix: setupResources(row.id).topicName.replace(/-feedback$/, ''), param_FeedbackUrl: feedbackUrl({ publicUrl: runtime.config.publicUrl }) });
    quickCreateUrl = `https://${row.region}.console.aws.amazon.com/cloudformation/home?region=${row.region}#/stacks/create/review?${params}`;
  }
  return { id: row.id, kind: row.kind, region: row.region, status: row.status, awsAccountId: row.aws_account_id, roleArn: row.role_arn, templateVersion: row.template_version, quickCreateUrl };
}
async function get(runtime: Runtime, wid: string) {
  return (await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE workspace_id=${wid}`)).rows[0];
}
export async function connectionSummary(runtime: Runtime, wid: string): Promise<z.infer<typeof ConnectionSummary> | null> {
  const row = (await runtime.db.execute<Pick<Row, 'kind' | 'region' | 'status'>>(sql`SELECT kind, region, status FROM provider_connections WHERE workspace_id=${wid}`)).rows[0];
  return row ? { kind: row.kind, region: row.region, status: row.status } : null;
}
function checkProvisioned(report: SesDiscovery, pooled: boolean) {
  // Domain verification and a BYO customer's production-access request are separate onboarding steps.
  const blocker = report.blockers.find(b => b.code !== 'SES_DOMAIN_REQUIRED' && (pooled || b.code !== 'SES_SANDBOX'));
  if (report.provisioned && !blocker) return;
  if (blocker?.code === 'SNS_CONFIRMATION_PENDING') throw new ApiError(409, blocker.code, 'Waiting for AWS to confirm the feedback subscription. Retry shortly.', undefined, true);
  throw new ApiError(409, blocker?.code ?? 'PROVISIONING_INCOMPLETE', blocker?.message ?? 'AWS setup is not confirmed yet. Retry this request.', undefined, true);
}

// Fenced, expiring leases protect external side effects without holding a DB transaction during AWS calls.
// A crashed isolate leaves a reclaimable pending row. Successful pool setup survives disconnects and restarts.
async function getPool(runtime: Runtime, region: string) {
  return (await runtime.db.execute<{ ready: boolean; aws_account_id: string; inbound_domain:string|null }>(sql`SELECT ready, aws_account_id,inbound_domain FROM provider_pool_regions WHERE region=${region}`)).rows[0];
}
async function ensurePool(runtime: Runtime, principal:Awaited<ReturnType<typeof platformIdentity>>, region: string) {
  const account=principal.account;
  const lease = new Date(Date.now() + 180_000).toISOString();
  const result = await runtime.db.execute(sql`INSERT INTO provider_pool_regions(region, aws_account_id, lease_until) VALUES (${region}, ${account}, ${lease})
    ON CONFLICT(region) DO UPDATE SET lease_until=excluded.lease_until WHERE (NOT provider_pool_regions.ready OR provider_pool_regions.inbound_domain IS DISTINCT FROM ${sharedInboundDomain(runtime)})
      AND provider_pool_regions.aws_account_id=excluded.aws_account_id AND coalesce(provider_pool_regions.lease_until, '-infinity') <= now() RETURNING ready`);
  if (!result.rowCount) {
    const pool = await getPool(runtime, region);
    if (pool?.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    if (pool.ready) return;
    throw busy();
  }
  const owned = sql`region=${region} AND lease_until=${lease}::timestamptz`;
  try {
    const scoped = { ...runtime, config: { ...runtime.config, awsAccountId: account, sesFeedbackUrl: undefined } };
    if (!result.rows[0]!.ready) {
      const report = await provisionSes(scoped, { region, installationId: POOL_INSTALLATION, verifiedPoolPrincipal:principal, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
      checkProvisioned(report, true);
      if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET ready=true WHERE ${owned}`)).rowCount) throw busy();
    }
    const records=await preparePoolReceiving(scoped,region,account,async(_account,bucket,arn)=>{
      if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET inbound_bucket=${bucket},inbound_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
    });
    if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET inbound_domain=${sharedInboundDomain(runtime)},inbound_dns=${JSON.stringify(records)}::jsonb,lease_until=NULL WHERE ${owned}`)).rowCount) throw busy();
  } catch (e) { await runtime.db.execute(sql`UPDATE provider_pool_regions SET lease_until=NULL WHERE ${owned}`); throw e; }
}
const busy = () => new ApiError(409, 'CONNECTION_BUSY', 'Connection setup is already in progress. Retry shortly.', undefined, true);
function uniqueAccount(error: unknown) {
  const e = (error as { cause?: unknown })?.cause ?? error;
  return (e as { code?: string })?.code === '23505' && (e as { constraint?: string }).constraint === 'provider_connections_byo_account';
}
async function provision(runtime: Runtime, row: Row, account: string, roleArn: string) {
  if (row.aws_account_id && row.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Disconnect before choosing a different AWS account.');
  if (row.status === 'ready') return row;
  const credentials = await assume(runtime, row.region, roleArn, row.external_id!, true);
  if ((await caller(row.region, credentials)).Account !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'STS did not return the expected customer account.');
  const scoped = { ...runtime, config: { ...runtime.config, aws: credentials, awsAccountId: account, sesFeedbackUrl: undefined, workspaceId: row.workspace_id } };
  const lease = new Date(Date.now() + 240_000).toISOString();
  // Reserve the verified BYO account BEFORE creating resources in it. The unique index serializes racing workspaces.
  try {
    const claimed = await runtime.db.execute(sql`UPDATE provider_connections SET lease_until=${lease}, aws_account_id=${account}, role_arn=${roleArn ?? null}
      WHERE id=${row.id} AND status='pending' AND (aws_account_id IS NULL OR aws_account_id=${account}) AND coalesce(lease_until, '-infinity') <= now()`);
    if (!claimed.rowCount) throw busy();
  } catch (e) { if (uniqueAccount(e)) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'This AWS account is already connected to a workspace.'); throw e; }
  const owned = sql`id=${row.id} AND lease_until=${lease}::timestamptz`;
  try {
    const report = await provisionSes(scoped, { region: row.region, installationId: row.id, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_connections SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
    checkProvisioned(report, false);
    const result = await runtime.db.execute<Row>(sql`WITH ready AS (UPDATE provider_connections SET status='ready', lease_until=NULL WHERE ${owned} RETURNING *),
      stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL, report=NULL FROM ready r WHERE d.workspace_id=r.workspace_id),
      settings AS (UPDATE ses_installation_settings s SET installation_id=CASE WHEN r.kind='byo' THEN r.id ELSE s.installation_id END, default_region=r.region, enabled_regions=jsonb_build_array(r.region) FROM ready r WHERE s.workspace_id=r.workspace_id)
      SELECT * FROM ready`);
    if (!result.rows[0]) throw busy();
    return result.rows[0];
  } catch (e) { await runtime.db.execute(sql`UPDATE provider_connections SET lease_until=NULL WHERE ${owned}`); throw e; }
}
// Only job/dispatch paths call this. A ready connection is not proof of a provisioned tenant.
export async function ensureTenant(runtime: Runtime, wid: string, connectionId: string) {
  const lease = new Date(Date.now()+30_000).toISOString();
  const row = (await runtime.db.execute<Row>(sql`UPDATE provider_connections c SET lease_until=${lease}, aws_account_id=p.aws_account_id
    FROM provider_pool_regions p WHERE c.id=${connectionId} AND c.workspace_id=${wid} AND c.kind='shared' AND c.region=p.region AND p.ready
    AND (c.aws_account_id IS NULL OR c.aws_account_id=p.aws_account_id) AND NOT c.tenant_provisioned AND coalesce(c.lease_until,'-infinity')<=now() RETURNING c.*`)).rows[0];
  if (!row) {
    const current = (await runtime.db.execute<{ tenant_provisioned: boolean }>(sql`SELECT tenant_provisioned FROM provider_connections WHERE id=${connectionId} AND workspace_id=${wid}`)).rows[0];
    if (current && !current.tenant_provisioned) throw busy();
    return;
  }
  const owned = sql`id=${row.id} AND lease_until=${lease}::timestamptz`;
  try {
    await platformIdentity(runtime, row.aws_account_id!);
    await provisionTenant(runtime, row.region, row.aws_account_id!, wid);
    if (!(await runtime.db.execute(sql`UPDATE provider_connections SET tenant_provisioned=true, lease_until=NULL WHERE ${owned}`)).rowCount) throw busy();
  } catch (e) { await runtime.db.execute(sql`UPDATE provider_connections SET lease_until=NULL WHERE ${owned}`); throw e; }
}
export const tenantJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (runtime.config.multiTenant && job.environment==='live' && typeof payload.connectionId==='string') await ensureTenant(runtime,job.workspaceId,payload.connectionId);
});
// Platform maintenance, never called by an HTTP request. One failed tenant or region must not stop the rest.
export async function reconcileSharedConnections(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  for (const region of sharedRegions(runtime)) {
    try {
      const pool = await getPool(runtime, region);
      if (!pool?.ready || pool.inbound_domain!==sharedInboundDomain(runtime)) {
        const principal=await platformIdentity(runtime,pool?.aws_account_id);
        try { await ensurePool(runtime,principal,region); }
        catch (e) {
          // Receiving (including its separate SNS confirmation) never blocks a healthy sending pool.
          if (!(await getPool(runtime,region))?.ready) throw e;
          log('warn',{operation:'shared-receiving-setup',region,code:awsError(e).code});
        }
      }
      const pending = await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE kind='shared' AND region=${region}
        AND NOT tenant_provisioned AND coalesce(lease_until, '-infinity') <= now()`);
      if (!pending.rows.length) continue;
      for (const row of pending.rows) {
        try { await ensureTenant(runtime, row.workspace_id, row.id); }
        catch (e) { log('warn', { operation: 'shared-tenant-setup', region, connectionId: row.id, code: awsError(e).code }); }
      }
    } catch (e) { log('warn', { operation: 'shared-pool-setup', region, code: awsError(e).code }); }
  }
}
async function create(runtime: Runtime, wid: string, input: z.infer<typeof Create>) {
  const { kind } = input, region = input.region ?? (kind === 'shared' ? sharedRegions(runtime)[0]! : platformRegion);
  if (kind === 'byo') template(runtime);
  // Offered regions come from SHARED_SENDING_REGIONS (Ohio at launch; Ireland is inside the IAM boundary).
  const offered = sharedRegions(runtime);
  if (kind === 'shared' && !offered.includes(region)) throw new ApiError(422, 'SHARED_REGION_UNAVAILABLE', `Shared sending is available in ${offered.join(', ')}.`, 'region');
  if (/^(cn-|us-gov-|us-iso|us-isob|eu-isoe|us-isof)/.test(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region.', 'region');
  if (kind === 'byo' && !byoRegions.includes(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region where Amazon SES supports sending.', 'region');
  platformCredentials(runtime);
  if (kind==='shared') {
    const row = (await runtime.db.execute<Row & { queued: boolean }>(sql`WITH pool AS (SELECT aws_account_id FROM provider_pool_regions WHERE region=${region} AND ready), connection AS (
      INSERT INTO provider_connections(id,workspace_id,kind,region,status,aws_account_id) VALUES (${id('conn')},${wid},'shared',${region},'ready',(SELECT aws_account_id FROM pool))
      ON CONFLICT(workspace_id) DO UPDATE SET status='ready',aws_account_id=coalesce(provider_connections.aws_account_id,excluded.aws_account_id) WHERE provider_connections.kind='shared' AND provider_connections.region=excluded.region RETURNING *),
      settings AS (UPDATE ses_installation_settings s SET default_region=c.region,enabled_regions=jsonb_build_array(c.region) FROM connection c WHERE c.workspace_id=s.workspace_id),
      stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL,report=NULL FROM connection c WHERE c.workspace_id=d.workspace_id AND d.report IS NOT NULL),
      queued AS (INSERT INTO jobs(id,type,workspace_id,environment,payload) SELECT 'tenant.provision:'||id,'tenant.provision',workspace_id,'live',jsonb_build_object('connectionId',id) FROM connection JOIN pool USING (aws_account_id) WHERE NOT tenant_provisioned ON CONFLICT DO NOTHING RETURNING 1)
      SELECT *, EXISTS (SELECT 1 FROM queued) AS queued FROM connection`)).rows[0];
    if (!row) throw new ApiError(409,'CONNECTION_EXISTS','Disconnect the existing connection before choosing another.');
    return row;
  }
  const principalArn = (await platformIdentity(runtime)).arn;
  const result = await runtime.db.execute<Row>(sql`INSERT INTO provider_connections(id,workspace_id,kind,region,external_id,platform_principal_arn,template_version)
    VALUES (${id('conn')},${wid},${kind},${region},${crypto.randomUUID()},${principalArn},'v3')
    ON CONFLICT(workspace_id) DO NOTHING RETURNING *`);
  const row = result.rows[0] ?? await get(runtime, wid);
  if (!row || row.kind !== kind || row.region !== region) throw new ApiError(409, 'CONNECTION_EXISTS', 'Disconnect the existing connection before choosing another.');
  return row;
}
export function registerProviderConnections(app: App) {
  const path = '/v1/connection';
  app.openapi(createRoute({ method: 'get', path, operationId: 'getConnection', tags, security, description: 'Get the current MX workspace connection or null. Owner/admin dashboard only.', responses: { 200: response(z.object({ connection: z.union([Connection, z.null()]) })), ...errors } }), async c => {
    const row = await get(c.env, owner(c)); return c.json({ connection: row ? view(c.env, row) : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/connection/regions', operationId: 'listConnectionRegions', tags, security, description: 'Regions offered for shared sending, and the commercial AWS regions where Amazon SES supports sending for bring-your-own AWS. Owner/admin dashboard only.', responses: { 200: response(z.object({ shared: z.array(z.string()), byo: z.array(z.string()) }).openapi('ConnectionRegions')), ...errors } }), async c => {
    owner(c); return c.json({ shared: sharedRegions(c.env), byo: byoRegions }, 200);
  });
  app.openapi(createRoute({ method: 'post', path, operationId: 'createConnection', tags, security, description: 'Choose a sending provider. Hosted mail is ready immediately; platform setup runs in the background. BYO returns a CloudFormation quick-create URL. Never sends mail.', request: { body: json(Create) }, responses: { 201: response(Connection), ...errors } }), async c => {
    const wid = owner(c);
    try {
      const row = await create(c.env, wid, c.req.valid('json'));
      if ('queued' in row && row.queued) c.get('actor').wakeJobs=1;
      return c.json(view(c.env, row), 201);
    } catch (e) { throw awsError(e); }
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/connection/verify', operationId: 'verifyConnection', tags, security, description: 'Verify the external-ID role in the AWS account from the CloudFormation stack output and provision its regional feedback resources. Safe to retry.', request: { body: json(z.object({ awsAccountId: AccountId }).strict()) }, responses: { 200: response(Connection), ...errors } }), async c => {
    const wid = owner(c); template(c.env);
    const row = await get(c.env, wid) ?? notFound('Connection');
    if (row.kind !== 'byo') throw new ApiError(409, 'BYO_CONNECTION_REQUIRED', 'Only bring-your-own connections require verification.');
    const account = c.req.valid('json').awsAccountId;
    if (row.platform_principal_arn!.split(':')[4] === account) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'The shared sending account cannot be used as a customer account.');
    try { return c.json(view(c.env, await provision(c.env, row, account, `arn:aws:iam::${account}:role/${stackName(row)}`)), 200); } catch (e) { throw awsError(e); }
  });
  app.openapi(createRoute({ method: 'delete', path, operationId: 'deleteConnection', tags, security, description: 'Disconnect only when there is no queued, in-flight, or uncertain mail and no scheduled or sending campaigns. AWS resources are retained. Delete the customer stack in AWS to revoke the role.', responses: { 200: response(z.object({ deleted: z.literal(true) })), ...errors } }), async c => {
    const wid = owner(c);
    await c.env.db.transaction(async db => {
      await getRegionSettings(db, wid, 'update'); // Serialize with send admission, which takes FOR SHARE on this row.
      const deleted = await db.execute(sql`DELETE FROM provider_connections WHERE workspace_id=${wid} AND coalesce(lease_until, '-infinity') <= now()
        AND NOT EXISTS (SELECT 1 FROM domain_claims WHERE connection_id=provider_connections.id)
        AND NOT EXISTS (SELECT 1 FROM sending_emails WHERE workspace_id=${wid} AND status IN ('queued','attempting','acceptance_unknown'))
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns WHERE workspace_id=${wid} AND status IN ('scheduled','sending'))`);
      if (!deleted.rowCount) {
        if (!(await db.execute(sql`SELECT 1 FROM provider_connections WHERE workspace_id=${wid}`)).rowCount) return notFound('Connection');
        throw new ApiError(409, 'CONNECTION_IN_USE', 'Remove connected domains and finish queued work or active setup before disconnecting.');
      }
    });
    return c.json({ deleted: true as const }, 200);
  });
}
