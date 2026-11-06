import { sql } from 'drizzle-orm';
import { ApiError, type Runtime, type JobHandler } from './core.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { acquireRegionProvisioning, finishHostedRegion } from './states.js';
import { awsError, byoFeedback, POOL_INSTALLATION, poolTenantName, provisionJournaledFeedback, provisionTenant, type JournalEntry } from './ses-setup.js';
import { caller, platformCredentials } from './provider-credentials.js';
import { platformAccount } from './byo-regional.js';

export const virginia='us-east-1';
const pending=()=>new JobDeferred(new Date(Date.now()+15_000).toISOString());
const fenced=(count:number|null)=>{if (!count) throw new ApiError(409,'PROVISION_LEASE_LOST','The trusted setup lease changed.',undefined,true);};
const topic=`arn:aws:sns:${virginia}:${platformAccount}:opensendmx-trusted-feedback`;

// Shared across every workspace. Never call the legacy pool reconciler (it provisions receiving).
async function ensureFeedback(r:Runtime) {
  const target=sql`region=${virginia} AND aws_account_id=${platformAccount} AND NOT legacy_names AND pool_tier='trusted'`;
  await r.db.execute(sql`INSERT INTO provider_pool_regions(region,aws_account_id,pool_tier,legacy_names) VALUES(${virginia},${platformAccount},'trusted',false) ON CONFLICT DO NOTHING`);
  const state=(await r.db.execute(sql`SELECT sending_state,feedback_topic_arn,confirmed_generation,generation FROM provider_pool_regions WHERE ${target}`)).rows[0];
  if (!state) throw new ApiError(409,'POOL_CONFLICT','Virginia already has a different pool binding.');
  if (state.sending_state==='ready') {
    if (state.feedback_topic_arn!==topic || state.confirmed_generation!==state.generation) throw new ApiError(409,'POOL_CONFLICT','No signed confirmation for the ready pool generation.');
    return;
  }
  const lease=(await r.db.execute<{generation:string;ownership_journal:JournalEntry[]}>(sql`UPDATE provider_pool_regions SET generation=generation+1,
    confirmed_generation=CASE WHEN confirmed_generation=generation AND feedback_topic_arn=${topic} THEN generation+1 END,lease_until=clock_timestamp()+interval '4 minutes'
    WHERE ${target} AND sending_state='pending' AND coalesce(lease_until,'-infinity')<=clock_timestamp() RETURNING generation,ownership_journal`)).rows[0];
  if (!lease) throw pending();
  const owned=sql`${target} AND sending_state='pending' AND generation=${lease.generation} AND lease_until>clock_timestamp()`;
  try {
    const result=await provisionJournaledFeedback({...r,config:{...r.config,awsAccountId:platformAccount,sesFeedbackUrl:byoFeedback}},virginia,POOL_INSTALLATION,lease.ownership_journal,
      async()=>fenced((await r.db.execute(sql`SELECT FROM provider_pool_regions WHERE ${owned}`)).rowCount),
      async entry=>fenced((await r.db.execute(sql`UPDATE provider_pool_regions SET ownership_journal=(SELECT coalesce(jsonb_agg(e),'[]') FROM jsonb_array_elements(ownership_journal) e WHERE NOT(e->>'kind'=${entry.kind} AND e->>'resource'=${entry.resource}))||${JSON.stringify([entry])}::jsonb WHERE ${owned}`)).rowCount),
      async arn=>fenced((await r.db.execute(sql`UPDATE provider_pool_regions SET feedback_topic_arn=${arn} WHERE ${owned} AND ${arn}::text=${topic} AND (feedback_topic_arn IS NULL OR feedback_topic_arn=${arn})`)).rowCount),
      async()=>!!(await r.db.execute(sql`SELECT FROM provider_pool_regions WHERE ${owned} AND confirmed_generation=generation AND feedback_topic_arn=${topic}`)).rowCount);
    if (!result.verified || !(await r.db.execute(sql`UPDATE provider_pool_regions SET sending_state='ready',lease_until=NULL WHERE ${owned} AND feedback_topic_arn=${topic} AND confirmed_generation=generation`)).rowCount) throw pending();
  } finally {await r.db.execute(sql`UPDATE provider_pool_regions SET lease_until=NULL WHERE ${owned}`);}
}

export const trustedProvision:JobHandler=retryDatabaseFailures(async(r,p,j)=>{
  if (!r.config.multiTenant || !r.config.regionalSending || !r.config.trustedPool) throw new JobDeferred(new Date(Date.now()+300_000).toISOString());
  const wid=j.workspaceId,cid=String(p.connectionId),name=poolTenantName(wid,'trusted');
  const target=sql`connection_id=${cid} AND region=${virginia} AND NOT legacy AND pool_tenant_name=${name}`;
  const row=(await r.db.execute(sql`SELECT r.sending_state FROM provider_connections c JOIN provider_connection_regions r ON r.connection_id=c.id
    WHERE c.workspace_id=${wid} AND c.id=${cid} AND c.kind='shared' AND c.state='ready' AND c.aws_account_id=${platformAccount} AND r.region=${virginia} AND r.pool_tenant_name=${name} AND NOT r.legacy`)).rows[0];
  if (!row || row.sending_state==='ready' || row.sending_state==='disabled') return;
  const principal=await caller(virginia,platformCredentials(r));
  if (principal.Arn!==`arn:aws:iam::${platformAccount}:user/opensend-mx` || principal.Account!==platformAccount) throw new ApiError(409,'AWS_ACCOUNT_MISMATCH','Use only the Hosted runtime principal for pool setup.');
  await ensureFeedback(r);
  const ref={connectionId:cid,region:virginia};
  const lease=(await r.db.execute(acquireRegionProvisioning(ref,target))).rows[0];if (!lease) throw pending();
  const gen=Number(lease.generation),owned=sql`${target} AND generation=${gen} AND lease_until>clock_timestamp() AND sending_state='provisioning'`;
  try {
    const saved=(await r.db.execute<{arn:string}>(sql`SELECT arn FROM hosted_tenant_ownership WHERE workspace_id=${wid} AND region=${virginia}`)).rows[0];
    await provisionTenant(r,virginia,platformAccount,wid,true,'trusted',name,{arn:saved?.arn??null,
      fence:async()=>fenced((await r.db.execute(sql`SELECT FROM provider_connection_regions WHERE ${owned}`)).rowCount),
      created:async arn=>fenced((await r.db.execute(sql`INSERT INTO hosted_tenant_ownership SELECT ${wid},${virginia},${arn} FROM provider_connection_regions WHERE ${owned}`)).rowCount)});
    fenced((await r.db.execute(finishHostedRegion(ref,gen))).rowCount);
  } catch(e) {
    const err=awsError(e);await r.db.execute(sql`UPDATE provider_connection_regions SET sending_state='failed',lease_until=NULL,provision_error=${err.code} WHERE ${owned}`);throw err;
  }
});
