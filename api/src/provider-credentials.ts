import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { ApiError, type Config, type Runtime } from './core.js';
import { connectionReady } from './states.js';

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
export type ReadyConnection = { id: string; kind: 'shared' | 'byo'; aws_account_id: string; role_arn: string; external_id: string; managed_tenant?:boolean; legacy?:boolean; legacy_names?:boolean; template_version?:string; pool_tier?:'trusted'|'probation'; identitySession?:{name:string;purpose:'verify'|'read'|'delete'|'mailFrom'} };
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
    const scope=row.identitySession;
    // A generic data-plane/mailbox caller must add its own narrowly scoped v5
    // session before release; never silently hand it the customer's entire role.
    if (!scope || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(scope.name)) throw new ApiError(409,'BYO_SESSION_SCOPE_REQUIRED','A purpose-scoped regional AWS session is required.');
    const actions=['ses:GetEmailIdentity',...({read:[],verify:['ses:CreateEmailIdentity','ses:TagResource'],delete:['ses:DeleteEmailIdentity'],mailFrom:['ses:PutEmailIdentityMailFromAttributes']}[scope.purpose])];
    return assume(runtime,region,row.role_arn,row.external_id,false,JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Action:actions,Resource:`arn:aws:ses:${region}:${row.aws_account_id}:identity/${scope.name}`}] }));
  }
  return assume(runtime,region,row.role_arn,row.external_id);
}
