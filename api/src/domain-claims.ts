import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, id, isSimulatedSes, type Runtime } from './core.js';
import type { ReadyConnection } from './provider-credentials.js';

export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
// A hosted workspace has exactly one connection, so the region may be omitted and defaults to it.
export async function reserveClaim(runtime: Runtime, workspace: string, name: string, region?: string) {
  const row = (await runtime.db.execute<{connection: (ReadyConnection & { region: string }) | null; token: string | null; id: string; readiness: unknown; fresh: boolean}>(
    sql`SELECT * FROM reserve_domain_claim(${workspace},${name},coalesce(${region ?? null}::text,(SELECT region FROM provider_connections WHERE workspace_id=${workspace} AND status='ready')),${id('dom')})`)).rows[0]!;
  if (!row.connection) throw new ApiError(409,'CONNECTION_REQUIRED','Set up a sending connection for this workspace and region.');
  if (!row.token || !row.id) throw new ApiError(409,'DOMAIN_CLAIMED','This domain overlaps an existing claim.');
  return { ...row, connection: row.connection, token: row.token };
}

// Shared tail for every claim release (single domain delete, workspace disconnect): the caller's
// `released` CTE yields (name, token); receiving stops and the claim's polls are canceled.
export const releasedClaimCleanup = (wid: string) => sql`retired AS (UPDATE mailbox_domains m SET status='disabled',updated_at=now() FROM released r WHERE m.workspace_id=${wid} AND m.name=r.name AND m.status<>'disabled'),
  canceled AS (DELETE FROM jobs USING released r WHERE jobs.workspace_id=${wid} AND jobs.id IN ('domain.verify:'||r.token,'domain.mx:'||r.token) AND jobs.type IN ('domain.verify','domain.mx') AND jobs.status='pending')`;
// Disconnecting keeps every claim but detaches it with no readiness and no domain rows: the next
// POST /v1/domains on a new connection re-proves it from scratch; other workspaces still cannot take it.
export const releaseConnectionClaims = (wid: string, target: SQL) => sql`released AS (UPDATE domain_claims dc SET connection_id=NULL,verified=false,ready=false,readiness=NULL,receiving_name=NULL,receiving_eligible=false,txt_misses=0,mx_misses=0
    FROM (${target}) t WHERE dc.workspace_id=${wid} AND dc.connection_id=t.id RETURNING dc.name,dc.token),
  dropped AS (DELETE FROM operation_domains d USING released r WHERE d.workspace_id=${wid} AND d.name=r.name), ${releasedClaimCleanup(wid)}`;
// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region. Simulation needs a claim, never delivery proof.
export const sendingConnections = (runtime: Runtime) => sql.identifier(isSimulatedSes(runtime) ? 'provider_simulated_connections' : 'provider_sending_connections');
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL, runtime: Runtime) => sql`EXISTS (SELECT 1 FROM domain_claims dc
  JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE dc.workspace_id=${workspace} AND pc.region=${region} AND pc.status='ready' ${!isSimulatedSes(runtime) ? sql`AND dc.verified` : sql``}
    AND ${within(host, sql`dc.name`)} FOR SHARE OF dc,pc)`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'Verify this sender domain or a parent domain in this workspace and region.', 'from');
