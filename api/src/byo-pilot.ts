import { sql } from 'drizzle-orm';
import type { DbExecutor, Runtime } from './core.js';

export async function byoEnabled(r:Runtime,wid:string,locked?:DbExecutor) {
  if (!r.config.multiTenant || !r.config.byoV2) return false;
  return !!(await (locked??r.db).execute(sql`SELECT FROM workspaces WHERE id=${wid} AND byo_v2_enabled ${locked?sql`FOR SHARE`:sql``}`)).rowCount;
}
