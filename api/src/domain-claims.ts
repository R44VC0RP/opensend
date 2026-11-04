import { sql, type SQL } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { ApiError, type DbExecutor } from './core.js';

// Rare registrations serialize against each other, not sends. The conflict check MUST be
// a separate READ COMMITTED statement after the lock: a waiting statement's snapshot is stale.
const lockClaims = (db: DbExecutor) => db.execute(sql`LOCK TABLE domain_claims IN SHARE ROW EXCLUSIVE MODE`);
export const domainName = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const within = (name: SQL, parent: SQL) => sql`right('.' || ${name}, length(${parent}) + 1) = '.' || ${parent}`;
const overlaps = (name: SQL, workspace: string) => sql`EXISTS (SELECT 1 FROM domain_claims other WHERE other.workspace_id <> ${workspace}
  AND (${within(sql`other.name`, name)} OR ${within(name, sql`other.name`)}))`;
export async function reserveClaim(db: DbExecutor, workspace: string, name: string) {
  await lockClaims(db);
  const row = (await db.execute<{ token: string }>(sql`INSERT INTO domain_claims(name, workspace_id)
    SELECT ${name}, ${workspace} WHERE NOT ${overlaps(sql`${name}::text`, workspace)}
    ON CONFLICT(name) DO UPDATE SET name=excluded.name WHERE domain_claims.workspace_id=excluded.workspace_id RETURNING token`)).rows[0];
  if (!row) throw new ApiError(409, 'DOMAIN_CLAIMED', 'This domain overlaps an existing claim.');
  return row.token;
}

// The caller has discovered only this customer's role/account. Conflicting identities stay
// in that account and never become senders here; importing 1,000 domains is still one write.
export async function importByoDomains(db: DbExecutor, connectionId: string, workspace: string, region: string, identities: { name: string; verified: boolean }[]) {
  if (!identities.length) return;
  await lockClaims(db);
  await db.execute(sql`WITH claimed AS (INSERT INTO domain_claims(name,workspace_id,connection_id,verified,ready)
    SELECT d.name, p.workspace_id, p.id, d.verified, false FROM provider_connections p,
      jsonb_to_recordset(${JSON.stringify(identities)}::jsonb) d(name text, verified boolean)
    WHERE p.id=${connectionId} AND p.workspace_id=${workspace} AND p.region=${region} AND p.kind='byo' AND p.status='ready'
      AND NOT ${overlaps(sql`d.name`, workspace)}
    ON CONFLICT(name) DO UPDATE SET connection_id=excluded.connection_id, verified=excluded.verified,
      ready=(domain_claims.connection_id IS NOT DISTINCT FROM excluded.connection_id) AND domain_claims.ready AND excluded.verified
    WHERE domain_claims.workspace_id=excluded.workspace_id RETURNING name,workspace_id)
    INSERT INTO operation_domains(id,workspace_id,environment,name,region)
    SELECT 'dom_' || replace(gen_random_uuid()::text,'-',''),workspace_id,'live',name,${region} FROM claimed ON CONFLICT DO NOTHING`);
}

// Used in the existing admission/dispatch statements. The connection join also fences
// disconnects and verifies the region; test mail uses the same live ownership proof.
export const verifiedClaim = (workspace: SQL, region: SQL, host: SQL) => sql`EXISTS (SELECT 1 FROM domain_claims dc
  JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE dc.workspace_id=${workspace} AND pc.region=${region} AND pc.status='ready' AND dc.verified
    AND ${within(host, sql`dc.name`)} FOR SHARE OF dc,pc)`;
export const unverifiedSender = () => new ApiError(403, 'SENDER_DOMAIN_NOT_VERIFIED', 'Verify this sender domain or a parent domain in this workspace and region.', 'from');
