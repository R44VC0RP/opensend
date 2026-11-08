import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { claimNameAllowed, domainName } from '../src/domain-claims.js';
import { poolTenantName } from '../src/ses-setup.js';
import { platformAccount } from '../src/byo-regional.js';
import { id } from '../src/core.js';

export function requirePoolFlags(env:Record<string,string|undefined>) {
  if ([env.MULTI_TENANT,env.MX_REGIONAL_SENDING,env.MX_TRUSTED_POOL].some(v=>v!=='true')) throw new Error('Hosted regional sending and trusted-pool enrollment must both be enabled.');
}
// This only sets initial placement. Never silently move live mail, reset proof, or join the
// two sending regions' DNS. A graduation requires a staged identity, drain and reviewed cutover.
export async function setDomainPool(db:Client,args:string[],env:Record<string,string|undefined>=process.env) {
  requirePoolFlags(env);
  const [wid,host,tier]=args,prepare=args.length===2 && host==='--prepare-trusted';
  const canary=host==='e2e-trusted.opensend.mx' && tier==='trusted';
  if (!wid || !prepare && (args.length!==3 || !['probation','trusted'].includes(tier!) || domainName.safeParse(host).data!==host || (!canary && !await claimNameAllowed(host!,'https://opensend.mx')))) throw new Error('Usage: set-domain-pool.ts WORKSPACE_ID DOMAIN trusted|probation, or WORKSPACE_ID --prepare-trusted');
  const name=poolTenantName(wid,'trusted');
  await db.query('BEGIN');
  try {
    const c=(await db.query(`SELECT c.id FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id) WHERE s.workspace_id=$1 AND c.kind='shared' AND c.state='ready'
      AND c.region='us-east-2' AND c.aws_account_id=$2 AND c.paused_at IS NULL FOR UPDATE OF s FOR SHARE OF c`,[wid,platformAccount])).rows[0];
    if (!c) throw new Error('Expected an unpaused Hosted Ohio connection in the platform account.');
    // The release checker uses a platform-owned fixture. Never relax the public reserved-name
    // filter. Only its pinned Ohio workspace may reserve this exact sibling (normal TXT still required).
    if (canary && !(await db.query(`SELECT FROM domain_sending_bindings b JOIN domain_claims dc USING(workspace_id,name,connection_id)
      WHERE b.workspace_id=$1 AND b.connection_id=$2 AND b.name='e2e.opensend.mx' AND b.region='us-east-2' AND b.domain_id='dom_1aa89a5a687348e89699f5cd97f5496b' AND dc.sending_state='verified'`,[wid,c.id])).rowCount) throw new Error('Not the verified Ohio release-canary workspace.');
    if (!prepare) {
      const bound=(await db.query('SELECT region FROM domain_sending_bindings WHERE workspace_id=$1 AND name=$2',[wid,host])).rows[0];
      if (bound && bound.region!==(tier==='trusted'?'us-east-1':'us-east-2')) throw new Error('Already bound in another region. A staged and drained migration is required.');
      const prior=(await db.query('SELECT tier FROM hosted_domain_tiers WHERE connection_id=$1 AND name=$2',[c.id,host])).rows[0]?.tier??'probation';
      await db.query('INSERT INTO hosted_domain_tiers VALUES($1,$2,$3) ON CONFLICT(connection_id,name) DO UPDATE SET tier=excluded.tier',[c.id,host,tier]);
      await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'set-domain-pool',$2)`,[wid,{domain:host,from:prior,to:tier,connection:c.id}]);
    }
    if (prepare || tier==='trusted') {
      await db.query(`INSERT INTO provider_connection_regions(connection_id,region,pool_tenant_name) VALUES($1,'us-east-1',$2) ON CONFLICT DO NOTHING`,[c.id,name]);
      const r=(await db.query(`SELECT sending_state FROM provider_connection_regions WHERE connection_id=$1 AND region='us-east-1' AND NOT legacy AND pool_tenant_name=$2 AND receiving_state='off' FOR UPDATE`,[c.id,name])).rows[0];
      if (!r || r.sending_state==='disabled') throw new Error('Virginia regional binding unavailable.');
      if (canary && r.sending_state==='ready') {
        const claim=(await db.query(`SELECT id,error_code FROM reserve_placed_claim($1,$2,'us-east-1',$3)`,[wid,host,id('dom')])).rows[0];
        if (!claim?.id || claim.error_code) throw new Error('Canary claim conflicts or expired; review before continuing.');
      }
      if (r.sending_state!=='ready') await db.query(`INSERT INTO jobs(id,workspace_id,type,payload) VALUES($1,$2,'hosted.trusted',$3)
        ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0,lease_until=NULL,last_error=NULL WHERE jobs.status IN ('completed','failed')`,['hosted.trusted:'+c.id,wid,{connectionId:c.id}]);
    }
    await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;}
}
if (import.meta.main) {
  requirePoolFlags(process.env);
  const db=new Client(postgresConnection(process.env.DATABASE_URL));await db.connect();
  try {await setDomainPool(db,process.argv.slice(2));console.log('Selection recorded. Before enrollment, verify the regional setup job and signed feedback.');} finally {await db.end();}
}
