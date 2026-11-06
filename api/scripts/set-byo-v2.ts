import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

// Operator DB access only. Never exposed as a workspace API or dashboard setting.
export async function setByoV2(db:Client,args:string[]) {
  const [wid,mode]=args;
  if (!wid || args.length!==2 || !['enable','disable'].includes(mode!)) throw new Error('Usage: set-byo-v2.ts WORKSPACE_ID enable|disable');
  await db.query('BEGIN');
  try {
    if (!(await db.query('SELECT FROM workspaces WHERE id=$1 FOR UPDATE',[wid])).rowCount) throw new Error('Unknown workspace.');
    if (mode==='disable' && (await db.query("SELECT FROM provider_connections WHERE workspace_id=$1 AND template_version='v5'",[wid])).rowCount) throw new Error('Disconnect the regional AWS connection before removing this workspace from the pilot.');
    await db.query('UPDATE workspaces SET byo_v2_enabled=$2 WHERE id=$1',[wid,mode==='enable']);
    await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;}
  log('info',{code:'BYO_V2_PILOT_CHANGED',workspaceId:wid,enabled:mode==='enable'});
}
if (import.meta.main) {
  const db=new Client(postgresConnection(process.env.DATABASE_URL));await db.connect();
  try {await setByoV2(db,process.argv.slice(2));} finally {await db.end();}
}
