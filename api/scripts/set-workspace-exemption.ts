import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

export async function setWorkspaceExemption(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, state] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !wid || (state !== 'on' && state !== 'off') || !reason) throw new Error('Usage: set-workspace-exemption.ts WORKSPACE_ID on|off --reason "..."');
  // The row change and its audit must either both commit or neither commit.
  const { rows: [audit] } = await db.query(`WITH previous AS (
    SELECT w.id,w.exempt_hosted_quotas FROM provider_connections c JOIN workspaces w ON w.id=c.workspace_id
    WHERE w.id=$1 AND c.kind='shared' FOR SHARE OF c FOR UPDATE OF w
  ), changed AS (
    UPDATE workspaces w SET exempt_hosted_quotas=$2 FROM previous p WHERE w.id=p.id
    RETURNING w.id,p.exempt_hosted_quotas AS old_value,w.exempt_hosted_quotas AS new_value
  ) INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT id,'set-workspace-exemption',jsonb_build_object('old',old_value,'new',new_value,'reason',$3::text) FROM changed RETURNING details`, [wid, state === 'on', reason]);
  if (!audit) throw new Error('No Hosted connection for this workspace.');
  log('info', { code: 'HOSTED_EXEMPTION_CHANGED', workspaceId: wid, ...audit.details });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setWorkspaceExemption(db, process.argv.slice(2)); } finally { await db.end(); }
}
