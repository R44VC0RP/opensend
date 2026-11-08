import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, assertSesConfigured, id, isSimulatedSes, type Runtime, type DbExecutor } from './core.js';
import type { ReadyConnection } from './provider-credentials.js';
import { placementRoot } from './domain-registry.js';
import { assertTenantReady, connectionReady, detachedClaim, verifyImportedClaims, type ClaimState, type IdentityFacts, type TenantState } from './states.js';

export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
// Separate from the PSL: these platform-controlled trees also prohibit child claims.
const reservedRoots = `amazonses.com amazonaws.com github.io gitlab.io pages.dev workers.dev vercel.app netlify.app herokuapp.com onmicrosoft.com cloudfront.net
  azurewebsites.net web.app firebaseapp.com appspot.com blogspot.com fly.dev onrender.com ngrok.io`.split(/\s+/);
const notAllowed = () => new ApiError(422,'DOMAIN_NOT_ALLOWED','A public suffix or reserved domain cannot be claimed.','name');
// Report the same policy error for a bare TLD, before the ordinary DNS syntax validator rejects it.
export const claimName = z.preprocess(value=>{
  if (typeof value==='string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value.trim())) throw notAllowed();
  return value;
},domainName);
export async function claimNameAllowed(name:string,publicUrl:string) {
  const host=new URL(publicUrl).hostname.toLowerCase().replace(/\.$/,'');
  return name.includes('.') && (name==='e2e.opensend.mx' || (name!==host && !name.endsWith('.'+host) && !host.endsWith('.'+name)))
    && !reservedRoots.some(root=>name===root || name.endsWith('.'+root)) && (await placementRoot(name)).root!==null;
}
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
// A hosted workspace has exactly one connection, so the region may be omitted and defaults to it.
export async function reserveClaim(runtime: Runtime, workspace: string, name: string, region?: string) {
  if (!await claimNameAllowed(name,runtime.config.publicUrl)) throw notAllowed();
  assertSesConfigured(runtime);
  // The statement's snapshot predates the function's own insert, so a brand-new claim joins to nothing: that is
  // exactly its start state. A retried or reconnected claim existed before and joins to its current states.
  const reserve = regionalSending(runtime) ? sql`${sql.identifier(runtime.config.trustedPool?'reserve_placed_claim':'reserve_regional_claim')}(${workspace},${name},${region ?? null},${id('dom')})` : sql`reserve_domain_claim(${workspace},${name},coalesce(${region ?? null}::text,(SELECT region FROM provider_connections pc WHERE workspace_id=${workspace} AND ${connectionReady()})),${id('dom')})`;
  // One reservation, one statement. The profiler never gates or runs inside the create route.
  const shadow = runtime.config.multiTenant && runtime.config.placementShadow;
  const row = (await runtime.db.execute<{connection: (ReadyConnection & { region: string; tenant_state: TenantState }) | null; token: string | null; id: string; claim: (ClaimState & { identity: IdentityFacts | null }) | null; fresh: boolean; recovering: boolean; error_code: string | null}>(
    sql`${shadow ? sql`WITH reserved AS MATERIALIZED (SELECT * FROM ${reserve}), queued AS (
      INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.placement:'||id,'domain.placement',${workspace},jsonb_build_object('domainId',id)
      FROM reserved WHERE fresh AND id IS NOT NULL AND error_code IS NULL AND connection->>'kind'='shared' ON CONFLICT DO NOTHING)` : sql``}
      SELECT r.connection,r.token,r.id,r.fresh,r.error_code,NOT r.fresh OR dc.token IS NOT NULL AS recovering,CASE WHEN dc.connection_id=r.connection->>'id' THEN to_jsonb(dc) END AS claim
      FROM ${shadow ? sql`reserved` : reserve} r
      LEFT JOIN domain_claims dc ON dc.token=r.token`)).rows[0]!;
  if (!row.connection) throw new ApiError(409,'CONNECTION_REQUIRED','Set up a sending connection for this workspace and region.');
  if (row.error_code==='OPERATOR_ADOPTION_REQUIRED') throw new ApiError(409,row.error_code,'An operator must reattest this retained sending identity.');
  if (row.error_code==='DOMAIN_REGION_CONFLICT') throw new ApiError(409,row.error_code,'The domain already has a different sending binding.','region');
  if (row.error_code==='POOL_PLACEMENT_MANAGED') throw new ApiError(422,row.error_code,'Hosted sending placement is managed by OpenSend.','region');
  if (row.error_code==='DOMAIN_LIMIT_REACHED') throw new ApiError(409,row.error_code,'A workspace can have at most 10 unproven domains and 100 domains in total. Verify or remove a domain first.');
  if (row.error_code==='DOMAIN_CLAIM_EXPIRED') throw new ApiError(409,row.error_code,'The 72-hour ownership window expired. Remove the domain and add it again.');
  if (!row.token || !row.id) throw new ApiError(409,'DOMAIN_CLAIMED','This domain overlaps an existing claim.');
  return { ...row, connection: row.connection, token: row.token, claim: row.claim ?? { sending_state: 'pending', receiving_state: 'off', receiving_host: null, lost_since: null, receiving_lost_since: null, identity: null } };
}

export async function importByoClaims(db: DbExecutor, connection: { id: string; workspace_id: string; region: string }, domains: { name: string; ses: IdentityFacts['ses'] }[]) {
  if (!domains.length) return;
  // Two statements in the caller's transaction: the update can see the function's new claims.
  // These reservations are account-scoped and never displace or block another workspace's domain.
  await db.execute(sql`SELECT r.token FROM jsonb_to_recordset(${JSON.stringify(domains.map(d => ({ name: d.name, id: id('dom') })).sort((a,b) => a.name.localeCompare(b.name)))}::jsonb) d(name text,id text)
    CROSS JOIN LATERAL reserve_domain_claim(${connection.workspace_id},d.name,${connection.region},d.id,${connection.id}) r`);
  await db.execute(verifyImportedClaims(connection.id, domains));
}

// Shared tail for every claim release (single domain delete, workspace disconnect): the caller's
// `released` CTE yields (name, token); receiving stops and the claim's polls are canceled.
export const releasedClaimCleanup = (wid: string) => sql`retired AS (UPDATE mailbox_domains m SET status='disabled',updated_at=now() FROM released r WHERE m.workspace_id=${wid} AND m.name=r.name AND m.status<>'disabled'),
  canceled AS (DELETE FROM jobs USING released r WHERE jobs.workspace_id=${wid} AND jobs.id IN ('domain.verify:'||r.token,'domain.mx:'||r.token) AND jobs.type IN ('domain.verify','domain.mx') AND jobs.status IN ('pending','running'))`;
// Keep independently owned exclusive claims. Send-only imports/adoptions have no TXT proof;
// their authority cannot survive disconnect. The operator's retained ARN journal does survive.
export const releaseConnectionClaims = (wid: string, target: SQL) => sql`target AS (${target}), detached AS (UPDATE domain_claims dc SET ${detachedClaim}
    FROM target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND dc.claim_scope<>'account' AND NOT coalesce(dc.identity ? 'adopted',false) RETURNING dc.name,dc.token),
  forgotten AS (DELETE FROM domain_claims dc USING target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND (dc.claim_scope='account' OR dc.identity ? 'adopted') RETURNING dc.name,dc.token),
  released AS (SELECT * FROM detached UNION ALL SELECT * FROM forgotten),
  dropped AS (DELETE FROM operation_domains d USING released r WHERE d.workspace_id=${wid} AND d.name=r.name), ${releasedClaimCleanup(wid)}`;
// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region. Hosted sender proof is required even when SES is simulated.
export const regionalSending = (runtime: Pick<Runtime,'config'>) => runtime.config.multiTenant && runtime.config.regionalSending === true;
// Dispatch/recovery readers always understand a persisted binding, including on flag rollback.
export const sendingConnections = (runtime: Runtime) => sql.identifier(`regional_${isSimulatedSes(runtime) ? 'simulated' : 'sending'}_connections`);
export type SendingBinding = { domain: string; connection: string; generation: number; account:string; topic:string|null };
export type SenderRoute = { region: string; verified: boolean; binding: SendingBinding; connection: (ReadyConnection & { region:string; tenant_state:TenantState; pause_reason:string|null }) | null };
export const senderRoutes = (runtime:Runtime,wid:string,hosts:string[]) => sql`(SELECT coalesce(jsonb_object_agg(h.host,to_jsonb(r)),'{}'::jsonb)
  FROM jsonb_array_elements_text(${JSON.stringify([...new Set(hosts)])}::jsonb) h(host) CROSS JOIN LATERAL regional_sender(${wid},h.host,${isSimulatedSes(runtime)}) r)`;
export function checkRoute(runtime: Runtime, route: SenderRoute | undefined, requested?: string) {
  if (!route?.verified) throw unverifiedSender();
  if (requested !== undefined && requested !== route.region) throw new ApiError(422,'SENDER_REGION_MISMATCH','The requested region does not match this sender domain.', 'region');
  if (!route.connection) throw new ApiError(409,'CONNECTION_REQUIRED','The sending connection is not ready in the bound region.');
  if (route.connection.pool_tenant_name && route.connection.pool_tier==='trusted' && !runtime.config.trustedPool) throw new ApiError(409,'TRUSTED_POOL_DISABLED','New trusted-pool admissions are disabled.');
  if (route.connection.pause_reason) throw new ApiError(409,'HOSTED_SENDING_PAUSED',route.connection.pause_reason);
  assertTenantReady(route.connection,isSimulatedSes(runtime));
  return route;
}
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL) =>
  sql`EXISTS (SELECT FROM verified_sending_domains v WHERE v.workspace_id=${workspace} AND v.region=${region} AND ${within(host,sql`v.name`)})`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'Verify this sender domain or a parent domain in this workspace and region.', 'from');
