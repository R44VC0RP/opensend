import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, assertSesConfigured, id, isSimulatedSes, type Runtime, type DbExecutor } from './core.js';
import type { ReadyConnection } from './provider-credentials.js';
import { claimSends, connectionReady, detachedClaim, verifyImportedClaims, type ClaimState, type IdentityFacts, type TenantState } from './states.js';

export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
// Exact suffixes are shared by independent DNS owners; their customer subdomains are still claimable.
const publicSuffixes = new Set(`co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk police.uk
  com.au net.au org.au edu.au gov.au asn.au id.au co.nz org.nz net.nz govt.nz ac.nz co.jp or.jp ne.jp ac.jp go.jp
  com.br org.br net.br com.cn net.cn org.cn gov.cn co.in net.in org.in ac.in gov.in co.za org.za net.za com.mx org.mx
  co.kr com.sg com.hk com.tw com.tr com.ar com.co co.id co.il co.th com.my com.ph com.vn co.ke co.ug
  github.io gitlab.io pages.dev workers.dev vercel.app netlify.app herokuapp.com onmicrosoft.com cloudfront.net
  azurewebsites.net web.app firebaseapp.com appspot.com blogspot.com fly.dev onrender.com ngrok.io`.split(/\s+/));
const reservedRoots = ['amazonses.com','amazonaws.com'];
const notAllowed = () => new ApiError(422,'DOMAIN_NOT_ALLOWED','A public suffix or reserved domain cannot be claimed.','name');
// Report the same policy error for a bare TLD, before the ordinary DNS syntax validator rejects it.
export const claimName = z.preprocess(value=>{
  if (typeof value==='string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(value.trim())) throw notAllowed();
  return value;
},domainName);
export function claimNameAllowed(name:string,publicUrl:string) {
  return name.includes('.') && !publicSuffixes.has(name) && ![...reservedRoots,new URL(publicUrl).hostname.toLowerCase().replace(/\.$/,'')].some(root=>name===root || name.endsWith('.'+root));
}
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
// A hosted workspace has exactly one connection, so the region may be omitted and defaults to it.
export async function reserveClaim(runtime: Runtime, workspace: string, name: string, region?: string) {
  if (!claimNameAllowed(name,runtime.config.publicUrl)) throw notAllowed();
  assertSesConfigured(runtime);
  // The statement's snapshot predates the function's own insert, so a brand-new claim joins to nothing: that is
  // exactly its start state. A retried or reconnected claim existed before and joins to its current states.
  const row = (await runtime.db.execute<{connection: (ReadyConnection & { region: string; tenant_state: TenantState }) | null; token: string | null; id: string; claim: (ClaimState & { identity: IdentityFacts | null }) | null; fresh: boolean; recovering: boolean; error_code: string | null}>(
    sql`SELECT r.connection,r.token,r.id,r.fresh,r.error_code,NOT r.fresh OR dc.token IS NOT NULL AS recovering,CASE WHEN dc.connection_id=r.connection->>'id' THEN to_jsonb(dc) END AS claim
      FROM reserve_domain_claim(${workspace},${name},coalesce(${region ?? null}::text,(SELECT region FROM provider_connections pc WHERE workspace_id=${workspace} AND ${connectionReady()})),${id('dom')}) r
      LEFT JOIN domain_claims dc ON dc.token=r.token`)).rows[0]!;
  if (!row.connection) throw new ApiError(409,'CONNECTION_REQUIRED','Set up a sending connection for this workspace and region.');
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
// Only exclusive claims survive disconnect. Account-scoped imports have no independent DNS proof.
export const releaseConnectionClaims = (wid: string, target: SQL) => sql`target AS (${target}), detached AS (UPDATE domain_claims dc SET ${detachedClaim}
    FROM target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND dc.claim_scope<>'account' RETURNING dc.name,dc.token),
  forgotten AS (DELETE FROM domain_claims dc USING target t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id AND dc.claim_scope='account' RETURNING dc.name,dc.token),
  released AS (SELECT * FROM detached UNION ALL SELECT * FROM forgotten),
  dropped AS (DELETE FROM operation_domains d USING released r WHERE d.workspace_id=${wid} AND d.name=r.name), ${releasedClaimCleanup(wid)}`;
// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region. Simulation needs a claim, never delivery proof.
export const sendingConnections = (runtime: Runtime) => sql.identifier(isSimulatedSes(runtime) ? 'provider_simulated_connections' : 'provider_sending_connections');
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL, runtime: Runtime) => sql`EXISTS (SELECT 1 FROM domain_claims dc
  JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE dc.workspace_id=${workspace} AND pc.region=${region} AND ${connectionReady()} ${!isSimulatedSes(runtime) ? sql`AND ${claimSends()}` : sql``}
    AND ${within(host, sql`dc.name`)} FOR SHARE OF dc,pc)`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'Verify this sender domain or a parent domain in this workspace and region.', 'from');
