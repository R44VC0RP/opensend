import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { FetchHttpHandler } from '@smithy/fetch-http-handler';
import { sql } from 'drizzle-orm';
import { ApiError, type Config, type Runtime } from './core.js';

type Credentials = NonNullable<Config['aws']>;
export function platformCredentials(runtime: Runtime) {
  if (!runtime.config.aws) throw new ApiError(503, 'AWS_NOT_CONFIGURED', 'The platform AWS connection is not configured.');
  return runtime.config.aws;
}
function sts(region: string, credentials: Credentials) {
  return new STSClient({ region, credentials, ignoreConfiguredEndpointUrls: true, maxAttempts: 2, requestHandler: new FetchHttpHandler({ requestTimeout: 10000 }) });
}
export async function caller(region: string, credentials: Credentials) {
  const client = sts(region, credentials);
  try { return await client.send(new GetCallerIdentityCommand({})); } finally { client.destroy(); }
}
// Only completed credential values cross requests, never a Worker request's promise or SDK client.
const sessions = new Map<string, Credentials & { expiration: Date }>();
export async function assume(runtime: Runtime, region: string, roleArn: string, externalId: string, verify = false) {
  const platform = platformCredentials(runtime), key = `${platform.accessKeyId}:${roleArn}:${externalId}`;
  const cached = sessions.get(key);
  if (!verify && cached && cached.expiration.getTime() - Date.now() > 60_000) return cached;
  const client = sts(region, platform);
  try {
    const input = { RoleArn: roleArn, RoleSessionName: 'OpenSendMX', DurationSeconds: 3600 };
    const { Credentials: c } = await client.send(new AssumeRoleCommand({ ...input, ExternalId: externalId }));
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new ApiError(503, 'AWS_SESSION_INVALID', 'STS returned incomplete session credentials.');
    if (verify) {
      // Do not accept a role whose trust policy ignores the workspace-specific external ID.
      try { await client.send(new AssumeRoleCommand(input)); throw new ApiError(409, 'EXTERNAL_ID_REQUIRED', 'The customer role must require its connection external ID.'); }
      catch (error) { if (!(error instanceof Error && error.name === 'AccessDenied')) throw error; }
    }
    const value = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
    sessions.set(key, value);
    return value;
  } finally { client.destroy(); }
}
export type ReadyConnection = { id: string; kind: 'shared' | 'byo'; aws_account_id: string; role_arn: string; external_id: string };
export async function workspaceConnection(runtime: Runtime, region?: string) {
  const result = await runtime.db.execute<ReadyConnection & { region: string }>(sql`
    SELECT id, kind, region, aws_account_id, role_arn, external_id FROM provider_connections
    WHERE workspace_id = ${runtime.config.workspaceId} ${region !== undefined ? sql`AND region = ${region}` : sql``} AND status = 'ready'`);
  const row = result.rows[0];
  if (!row) throw new ApiError(409, 'CONNECTION_REQUIRED', 'Set up a sending connection for this workspace and region.');
  return row;
}
export async function workspaceCredentials(runtime: Runtime, region: string, connection?: ReadyConnection) {
  const row = connection ?? await workspaceConnection(runtime, region);
  return row.kind === 'shared' ? platformCredentials(runtime) : assume(runtime, region, row.role_arn, row.external_id);
}
