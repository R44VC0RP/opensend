import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { ApiError, type Config, type Runtime } from './core.js';
import { connectionReady } from './states.js';
import { setupResources } from './ses-setup.js';

type Credentials = NonNullable<Config['aws']>;
export function platformCredentials(runtime: Runtime) {
  if (!runtime.config.aws) throw new ApiError(503, 'AWS_NOT_CONFIGURED', 'The platform AWS connection is not configured.');
  return runtime.config.aws;
}
function sts(region: string, credentials: Credentials) {
  return new STSClient({ region, credentials, ignoreConfiguredEndpointUrls: true, maxAttempts: 1, requestHandler: new FetchHttpHandler({ requestTimeout: 4000 }) });
}
export async function caller(region: string, credentials: Credentials) {
  const client = sts(region, credentials);
  try { return await client.send(new GetCallerIdentityCommand({})); } finally { client.destroy(); }
}
// Only completed credential values cross requests, never a Worker request's promise or SDK client.
const sessions = new Map<string, Credentials & { expiration: Date }>();
export async function assume(runtime: Runtime, region: string, roleArn: string, externalId: string, verify = false, policy?: string) {
  const platform = platformCredentials(runtime), key = `${platform.accessKeyId}:${roleArn}:${externalId}:${policy ? createHash('sha256').update(policy).digest('hex') : ''}`;
  const cached = sessions.get(key);
  if (!verify && cached && cached.expiration.getTime() - Date.now() > 60_000) return cached;
  const client = sts(region, platform);
  try {
    const input = { RoleArn: roleArn, RoleSessionName: 'OpenSendMX', DurationSeconds: policy ? 900 : 3600, Policy: policy };
    const opts = { abortSignal: AbortSignal.timeout(4000) };
    const probe = async (ExternalId?: string) => {
      try { await client.send(new AssumeRoleCommand({ ...input, ExternalId }), opts); }
      catch (e) { if (e instanceof Error && e.name === 'AccessDenied') return; throw e; }
      throw new ApiError(409, 'EXTERNAL_ID_REQUIRED', 'The customer role must require its connection external ID.');
    };
    // One bounded STS round trip, including the absent and incorrect external-ID checks. Never
    // grant credentials from an unverified positive response or cache a failed proof.
    const [result] = await Promise.all([client.send(new AssumeRoleCommand({ ...input, ExternalId: externalId }), opts),
      ...(verify ? [probe(), probe(crypto.randomUUID())] : [])]);
    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new ApiError(503, 'AWS_SESSION_INVALID', 'STS returned incomplete session credentials.');
    if (verify) {
      const expected = /^arn:aws:iam::(\d{12}):role\/(OpenSendMX-[a-f0-9]{20})$/.exec(roleArn);
      if (!expected || result.AssumedRoleUser?.Arn !== `arn:aws:sts::${expected[1]}:assumed-role/${expected[2]}/${input.RoleSessionName}`) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'STS did not return the expected customer role and account.');
    }
    const value = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
    sessions.set(key, value);
    return value;
  } finally { client.destroy(); }
}
type DeliverySession={purpose:'send';domainId:string}|{purpose:'template';name:string}|{purpose:'quota'};
export type ReadyConnection = { id: string; kind: 'shared' | 'byo'; aws_account_id: string; role_arn: string; external_id: string; managed_tenant?:boolean; pool_tenant_name?:string|null; legacy?:boolean; legacy_names?:boolean; template_version?:string; pool_tier?:'trusted'|'probation'; identitySession?:{name:string;purpose:'verify'|'read'|'delete'|'mailFrom'}; deliverySession?:DeliverySession };
export function forDelivery(connection:ReadyConnection|undefined,scope:DeliverySession) {
  return connection?.template_version==='v5'?{...connection,deliverySession:scope}:connection;
}

async function deliveryCredentials(runtime:Runtime,region:string,row:ReadyConnection,scope:DeliverySession) {
  // Use only a currently enabled, ready binding. An immutable domain ID from the
  // queued envelope resolves to the selected parent identity, never a From suffix or wildcard.
  const bound=(await runtime.db.execute<{name:string|null}>(sql`SELECT ${scope.purpose==='send'?sql`b.name`:sql`NULL::text`} AS name
    FROM regional_sending_connections c JOIN workspaces w ON w.id=c.workspace_id
    ${scope.purpose==='send'?sql`JOIN domain_sending_bindings b ON b.workspace_id=c.workspace_id AND b.connection_id=c.id AND b.region=c.region AND b.domain_id=${scope.domainId}
      JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.connection_id=b.connection_id AND dc.name=b.name AND dc.sending_state IN ('verified','lost')`:sql``}
    WHERE c.workspace_id=${runtime.config.workspaceId} AND w.byo_v2_enabled AND c.template_version='v5' AND c.kind='byo' AND c.id=${row.id} AND c.region=${region}
      AND c.aws_account_id=${row.aws_account_id} AND c.role_arn=${row.role_arn} AND c.external_id=${row.external_id}::uuid`)).rows[0];
  if (!runtime.config.byoV2 || !bound) throw new ApiError(409,'BYO_SESSION_SCOPE_REQUIRED','This delivery scope is not bound to an enabled regional connection.');
  const prefix=`arn:aws:ses:${region}:${row.aws_account_id}:`, names=setupResources(row.id,'byo');
  const allow=(Action:string[],Resource:string|string[],extra:Record<string,string>={})=>({Effect:'Allow',Action,Resource,Condition:{StringEquals:{'aws:RequestedRegion':region,...extra}}});
  let statements;
  if (scope.purpose==='send') {
    if (!bound.name || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(bound.name)) throw new ApiError(409,'BYO_SESSION_SCOPE_REQUIRED','Missing bound SES domain.');
    statements=[allow(['ses:SendEmail'],[prefix+'identity/'+bound.name,...[names.transactional,names.marketing].map(n=>prefix+'configuration-set/'+n)],{'ses:ApiVersion':'2'}),allow(['ses:ApplyTrackingConfigurationOverrides'],'*',{'ses:OpenTrackingEnabled':'${ses:ClickTrackingEnabled}'})];
  } else if (scope.purpose==='template') {
    if (!/^opensend-[A-Za-z0-9_-]+$/.test(scope.name)) throw new ApiError(422,'TEMPLATE_SCOPE_REQUIRED','Regional BYO may render only opensend- templates.');
    statements=[allow(['ses:GetEmailTemplate','ses:TestRenderEmailTemplate'],prefix+'template/'+scope.name)];
  } else statements=[allow(['ses:GetAccount'],'*')];
  return assume(runtime,region,row.role_arn,row.external_id,false,JSON.stringify({Version:'2012-10-17',Statement:statements}));
}
export async function workspaceConnection(runtime: Runtime, region?: string) {
  const result = await runtime.db.execute<ReadyConnection & { region: string }>(sql`
    SELECT id, kind, region, aws_account_id, role_arn, external_id, template_version ${region!==undefined ? sql`,legacy` : sql``} FROM ${region!==undefined ? sql`regional_connections` : sql`provider_connections`} pc
    WHERE workspace_id = ${runtime.config.workspaceId} ${region !== undefined ? sql`AND region = ${region} AND (legacy OR sending_state='ready')` : sql``} AND ${connectionReady()}`);
  const row = result.rows[0];
  if (!row) throw new ApiError(409, 'CONNECTION_REQUIRED', 'Set up a sending connection for this workspace and region.');
  return row;
}
export async function workspaceCredentials(runtime: Runtime, region: string, connection?: ReadyConnection) {
  const row = connection ?? await workspaceConnection(runtime, region);
  if (row.kind==='shared') return platformCredentials(runtime);
  // Missing metadata is not evidence of a legacy stack. An explicit managed
  // marker always wins over a contradictory legacy marker or naming convention.
  const legacy=row.template_version!=='v5' && row.legacy!==false && row.legacy_names!==false && (row.legacy===true || !!row.template_version);
  if (!legacy) {
    if (row.template_version==='v5' && row.deliverySession) return deliveryCredentials(runtime,region,row,row.deliverySession);
    const scope=row.identitySession;
    // A generic data-plane/mailbox caller must add its own narrowly scoped v5
    // session before release; never silently hand it the customer's entire role.
    if (!scope || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(scope.name)) throw new ApiError(409,'BYO_SESSION_SCOPE_REQUIRED','A purpose-scoped regional AWS session is required.');
    const actions=['ses:GetEmailIdentity',...({read:[],verify:['ses:CreateEmailIdentity','ses:TagResource'],delete:['ses:DeleteEmailIdentity'],mailFrom:['ses:PutEmailIdentityMailFromAttributes']}[scope.purpose])];
    return assume(runtime,region,row.role_arn,row.external_id,false,JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:actions,Resource:`arn:aws:ses:${region}:${row.aws_account_id}:identity/${scope.name}`}] }));
  }
  return assume(runtime,region,row.role_arn,row.external_id);
}
