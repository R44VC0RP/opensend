import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, id, isSimulatedSes, type Runtime } from './core.js';
import type { ReadyConnection } from './provider-credentials.js';

export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
export async function reserveClaim(runtime: Runtime, workspace: string, name: string, region: string) {
  const row = (await runtime.db.execute<{connection: ReadyConnection | null; token: string | null; id: string; readiness: unknown; fresh: boolean}>(
    sql`SELECT * FROM reserve_domain_claim(${workspace},${name},${region},${id('dom')})`)).rows[0]!;
  if (!row.connection) throw new ApiError(409,'CONNECTION_REQUIRED','Set up a sending connection for this workspace and region.');
  if (!row.token || !row.id) throw new ApiError(409,'DOMAIN_CLAIMED','This domain overlaps an existing claim.');
  return { ...row, connection: row.connection, token: row.token };
}

// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region. Simulation needs a claim, never delivery proof.
export const sendingConnections = (runtime: Runtime) => sql.identifier(isSimulatedSes(runtime) ? 'provider_simulated_connections' : 'provider_sending_connections');
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL, runtime: Runtime) => sql`EXISTS (SELECT 1 FROM domain_claims dc
  JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE dc.workspace_id=${workspace} AND pc.region=${region} AND pc.status='ready' ${!isSimulatedSes(runtime) ? sql`AND dc.verified` : sql``}
    AND ${within(host, sql`dc.name`)} FOR SHARE OF dc,pc)`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'Verify this sender domain or a parent domain in this workspace and region.', 'from');
