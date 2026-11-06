import { sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { createHash } from 'node:crypto';
import { ApiError, id, notFound, type Runtime, type DbExecutor, type JobHandler } from './core.js';
import { assume } from './provider-credentials.js';
import { awsError, byoFeedback, provisionByoRegion, readSelectedDomains, removeByoFeedbackResource, scanRegionPage, setupResources, type Inventory, type CandidateIdentity, type JournalEntry, type ScanStage } from './ses-setup.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { acquireRegionProvisioning, campaignReserved, finishRegionProvisioning, verifyImportedClaims } from './states.js';
import { claimNameAllowed, releaseConnectionClaims } from './domain-claims.js';
import { lockAdmission } from './sending.js';
import { getRegionSettings } from './ses-region-state.js';
import { byoEnabled } from './byo-pilot.js';

export const regionLabels:Record<string,string>={'us-east-2':'Ohio','us-east-1':'N. Virginia','us-west-1':'N. California','us-west-2':'Oregon','af-south-1':'Cape Town','ap-south-1':'Mumbai','ap-south-2':'Hyderabad','ap-southeast-1':'Singapore','ap-southeast-2':'Sydney','ap-southeast-3':'Jakarta','ap-southeast-4':'Melbourne','ap-southeast-5':'Malaysia','ap-southeast-6':'New Zealand','ap-southeast-7':'Thailand','ap-northeast-1':'Tokyo','ap-northeast-2':'Seoul','ap-northeast-3':'Osaka','ca-central-1':'Canada Central','ca-west-1':'Calgary','eu-central-1':'Frankfurt','eu-central-2':'Zurich','eu-west-1':'Ireland','eu-west-2':'London','eu-west-3':'Paris','eu-south-1':'Milan','eu-south-2':'Spain','eu-north-1':'Stockholm','il-central-1':'Tel Aviv','mx-central-1':'Mexico Central','me-south-1':'Bahrain','me-central-1':'UAE','sa-east-1':'São Paulo'};
export const platformAccount='438095551154';
const platformArn=`arn:aws:iam::${platformAccount}:user/opensend-mx`;
export type V5Connection={id:string;workspace_id:string;requested_account:string;aws_account_id:string|null;role_arn:string|null;external_id:string;inventory_revision:number;state:string;region:string;disconnect_error:{region:string|null;code:string}|null};
type ScanRow={region:string;scan_state:string;scan_error:string|null;scan_facts:Inventory;scan_revision:string;sending_state:string;receiving_state:string;provision_error:string|null;ownership_journal:JournalEntry[]};
const conflict=(code:string,message:string)=>new ApiError(409,code,message);
const stale=()=>conflict('SCAN_STALE','Refresh the list and select verified domains from a completed regional scan.');
const defer=(ms:number,payload?:Record<string,unknown>)=>new JobDeferred(new Date(Date.now()+ms).toISOString(),payload);
async function writable(r:Runtime,wid:string,db?:DbExecutor) {
  if (!await byoEnabled(r,wid,db)) return notFound('Endpoint');
  if (!r.config.regionalSending) throw conflict('REGIONAL_SENDING_REQUIRED','Enable regional sending before enrolling a regional AWS connection.');
}
async function connection(db:DbExecutor,wid:string,lock=false) {
  return (await db.execute<V5Connection>(sql`SELECT * FROM provider_connections WHERE workspace_id=${wid} AND template_version='v5' AND kind='byo' ${lock?sql`FOR UPDATE`:sql``}`)).rows[0];
}
export async function requiredV5(r:Runtime,wid:string) {
  await writable(r,wid);return usable(await connection(r.db,wid));
}
function usable(c:V5Connection|undefined) {
  if (!c) return notFound('Regional connection');
  if (c.state==='disconnecting') throw conflict('CONNECTION_DISCONNECTING','Regional cleanup is in progress.');
  return c;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Op={operationId:string;regions:string[]};
type ScanOp={operationId:string;revision:number};
function receipt<T extends Op|ScanOp>(c:V5Connection,operation:string,key:string|undefined,body:string) {
  if (key!==undefined && !/^[\x21-\x7e]{1,200}$/.test(key)) throw new ApiError(422,'INVALID_IDEMPOTENCY_KEY','Use 1–200 printable ASCII characters.');
  const request=hash(body), keyHash=key?hash(key):null;
  return {read:async(db:DbExecutor)=>{
    if (!keyHash) return;
    const prior=(await db.execute<{request_hash:string;result:T}>(sql`SELECT request_hash,result FROM byo_operation_receipts WHERE connection_id=${c.id} AND operation=${operation} AND key_hash=${keyHash}`)).rows[0];
    if (prior && prior.request_hash!==request) throw conflict('IDEMPOTENCY_KEY_REUSED','This idempotency key was used with a different request.');
    return prior?.result;
  },save:async(db:DbExecutor,result:T)=>{
    if (keyHash) await db.execute(sql`INSERT INTO byo_operation_receipts VALUES(${c.id},${operation},${keyHash},${request},${JSON.stringify(result)}::jsonb)`);return result;
  }};
}
const candidateId=(region:string,name:string)=>region+':'+name;
const proofId=(c:V5Connection)=>`byo.prove:${c.id}:${c.inventory_revision}`;
const regionJobId=(c:V5Connection,region:string)=>`byo.provision:${c.id}:${region}`;
const job=(db:DbExecutor,c:V5Connection,type:string,jobId:string,extra:Record<string,unknown>={})=>db.execute(sql`INSERT INTO jobs(id,workspace_id,type,payload) VALUES(${jobId},${c.workspace_id},${type},${JSON.stringify({connectionId:c.id,...extra,run:id('run')})}::jsonb)
  ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0,last_error=NULL,lease_until=NULL,payload=excluded.payload WHERE jobs.status IN ('completed','failed')`);

export function v5Link(r:Runtime,c:{id:string;workspace_id:string;external_id:string|null;region:string}) {
  if (!r.config.byoV5TemplateUrl) throw new ApiError(503,'BYO_NOT_CONFIGURED','The v5 role template URL is not configured.');
  const params=new URLSearchParams({templateURL:r.config.byoV5TemplateUrl,stackName:'OpenSendMX-'+c.id.slice(-20),param_ExternalId:c.external_id!,param_ConnectionId:c.id,param_WorkspaceId:c.workspace_id,param_ResourcePrefix:setupResources(c.id,'byo').topicName.slice(0,-9)});
  return `https://${c.region}.console.aws.amazon.com/cloudformation/home?region=${c.region}#/stacks/create/review?${params}`;
}
export async function enrollV5(r:Runtime,wid:string,account:string) {
  if (account===platformAccount) throw conflict('AWS_ACCOUNT_IN_USE','The shared sending account cannot be connected.');
  const cid=id('conn'),roleRegion='us-east-2',external=crypto.randomUUID();
  v5Link(r,{id:cid,region:roleRegion,workspace_id:wid,external_id:external});
  return r.db.transaction(async db=>{
    await writable(r,wid,db);
    const inserted=await db.execute(sql`INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state,external_id,platform_principal_arn,template_version,resource_prefix,requested_account,inventory_revision)
      VALUES(${cid},${wid},'byo',${roleRegion},'awaiting_role','ready',${external},${platformArn},'v5',${setupResources(cid,'byo').topicName.slice(0,-9)},${account},1) ON CONFLICT(workspace_id) DO NOTHING`);
    const c=await connection(db,wid,true);if (c) usable(c);
    if (!c || c.requested_account!==account) throw conflict('CONNECTION_EXISTS','A different sending connection already exists.');
    if (inserted.rowCount) await job(db,c,'byo.prove',proofId(c),{revision:c.inventory_revision});
    return {operationId:proofId(c),revision:c.inventory_revision};
  });
}

// Inline STS policies intersect with v5's tag, endpoint, and trust conditions. No
// scanner can send, provision, or read an email address identity; provisioning cannot
// read other sets/topics. The proof probes use the same limited policy.
async function scoped(r:Runtime,c:V5Connection,region:string,purpose:'scan'|'provision'|'cleanup',verify=false) {
  const account=c.requested_account, role=`arn:aws:iam::${account}:role/OpenSendMX-${c.id.slice(-20)}`;
  if (account===platformAccount || !/^\d{12}$/.test(account) || !(region in regionLabels) || (!verify && (c.aws_account_id!==account || c.role_arn!==role))) throw conflict('AWS_ACCOUNT_MISMATCH','The regional role is not bound to this account.');
  const names=setupResources(c.id,'byo'),ses=`arn:aws:ses:${region}:${account}:`,sets=[names.transactional,names.marketing].map(n=>ses+'configuration-set/'+n),topic=`arn:aws:sns:${region}:${account}:${names.topicName}`;
  const allow=(Action:string[],Resource:string|string[])=>({Effect:'Allow',Action,Resource,Condition:{StringEquals:{'aws:RequestedRegion':region}}});
  const Statement=purpose==='cleanup'?[
    allow(['ses:GetConfigurationSet','ses:GetConfigurationSetEventDestinations','ses:DeleteConfigurationSet'],sets),allow(['sns:GetTopicAttributes','sns:ListTagsForResource','sns:ListSubscriptionsByTopic','sns:GetSubscriptionAttributes','sns:DeleteTopic'],topic)
  ]:purpose==='scan'?[allow(['ses:GetAccount','ses:ListEmailIdentities','ses:ListConfigurationSets','ses:DescribeActiveReceiptRuleSet'],'*'),allow(['ses:GetEmailIdentity'],ses+'identity/?*.??*'),allow(['ses:GetConfigurationSet'],[...sets,ses+'configuration-set/opensend-*'])]:[
    allow(['ses:GetAccount'],'*'),allow(['ses:GetConfigurationSet','ses:CreateConfigurationSet','ses:TagResource','ses:PutConfigurationSetSuppressionOptions','ses:GetConfigurationSetEventDestinations','ses:CreateConfigurationSetEventDestination'],sets),
    allow(['sns:CreateTopic','sns:TagResource','sns:GetTopicAttributes','sns:ListTagsForResource','sns:SetTopicAttributes','sns:ListSubscriptionsByTopic','sns:GetSubscriptionAttributes','sns:Subscribe'],topic)];
  const aws=await assume(r,region,role,c.external_id,verify,JSON.stringify({Version:'2012-10-17',Statement}));
  return {...r,config:{...r.config,workspaceId:c.workspace_id,aws,awsAccountId:account,sesFeedbackUrl:byoFeedback}};
}
async function beginScan(db:DbExecutor,c:V5Connection) {
  await db.execute(sql`DELETE FROM byo_candidates WHERE connection_id=${c.id}`);
  await db.execute(sql`WITH regions AS (INSERT INTO provider_connection_regions(connection_id,region,managed_tenant,tenant_state,scan_revision,scan_state)
    SELECT ${c.id},region,false,'ready',${c.inventory_revision},'scanning' FROM jsonb_array_elements_text(${JSON.stringify(Object.keys(regionLabels))}::jsonb) rs(region)
    ON CONFLICT(connection_id,region) DO UPDATE SET scan_revision=excluded.scan_revision,scan_state='scanning',scan_error=NULL,scan_facts='{}' RETURNING region)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT ${'byo.scan:'+c.id+':'+c.inventory_revision+':'}||region,'byo.scan',${c.workspace_id},
      jsonb_build_object('connectionId',${c.id}::text,'region',region,'revision',${c.inventory_revision}::integer,'stage','account','run',gen_random_uuid()) FROM regions`);
}
export async function refreshScan(r:Runtime,wid:string,key?:string) {
  await writable(r,wid);return r.db.transaction(async db=>{
    const c=usable(await connection(db,wid,true));
    const op=receipt<ScanOp>(c,'scan',key,''),prior=await op.read(db);if (prior) return prior;
    if (!c.aws_account_id) { await job(db,c,'byo.prove',proofId(c),{revision:c.inventory_revision});return op.save(db,{revision:c.inventory_revision,operationId:proofId(c)}); }
    if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='scanning' LIMIT 1`)).rowCount) {
      c.inventory_revision++;await db.execute(sql`UPDATE provider_connections SET inventory_revision=${c.inventory_revision},state=CASE WHEN state='ready' THEN state ELSE 'scanning' END WHERE id=${c.id}`);await beginScan(db,c);
    }
    return op.save(db,{revision:c.inventory_revision,operationId:`byo.scan:${c.id}:${c.inventory_revision}`});
  });
}
const runV5=(handler:(r:Runtime,c:V5Connection,p:Record<string,unknown>,attempt:number)=>Promise<void>):JobHandler=>retryDatabaseFailures(async(r,p,j)=>{
  // Preserve accepted work on rollout pause, without touching AWS or consuming attempts.
  if (!r.config.regionalSending || !await byoEnabled(r,j.workspaceId)) throw defer(300_000);
  const c=await connection(r.db,j.workspaceId);if (!c || c.id!==p.connectionId || c.state==='disconnecting') return;
  await handler(r,c,p,j.attempts);
});
const prove=runV5(async(r,c,p)=>{
  if (c.aws_account_id || p.revision!==c.inventory_revision) return;
  try { await scoped(r,c,c.region,'scan',true); }
  catch(e) {
    const err=awsError(e);if (err.code==='AWS_ACCESS_DENIED' || err.retryable) throw defer(30_000);
    await r.db.execute(sql`UPDATE provider_connections SET state='failed' WHERE id=${c.id} AND aws_account_id IS NULL`);throw err;
  }
  try {
    await r.db.transaction(async db=>{
      if (!(await db.execute(sql`UPDATE provider_connections SET aws_account_id=requested_account,role_arn=${`arn:aws:iam::${c.requested_account}:role/OpenSendMX-${c.id.slice(-20)}`},state='scanning' WHERE id=${c.id} AND aws_account_id IS NULL`)).rowCount) return;
      await beginScan(db,c);
    });
  } catch(e) {
    if ((e as {cause?:{constraint?:string}}).cause?.constraint!=='provider_connections_byo_account') throw e;
    await r.db.execute(sql`UPDATE provider_connections SET state='failed' WHERE id=${c.id} AND aws_account_id IS NULL`);throw conflict('AWS_ACCOUNT_IN_USE','This AWS account is already connected.');
  }
});
const scan=runV5(async(r,c,p)=>{
  if (p.revision!==c.inventory_revision) return;
  const region=String(p.region),stage=p.stage as ScanStage,token=p.token as string|undefined;
  const guard=sql`connection_id=${c.id} AND region=${region} AND scan_revision=${c.inventory_revision} AND scan_state='scanning'`;
  const terminal=async(db:DbExecutor)=>db.execute(sql`UPDATE provider_connections SET state=CASE WHEN EXISTS(SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='ready_to_import') THEN 'ready_to_import' ELSE 'failed' END WHERE id=${c.id} AND inventory_revision=${c.inventory_revision} AND state='scanning'
    AND NOT EXISTS(SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND scan_state='scanning')`);
  const fail=(code:string)=>r.db.transaction(async db=>{await connection(db,c.workspace_id,true);await db.execute(sql`UPDATE provider_connection_regions SET scan_state='failed',scan_error=${code} WHERE ${guard}`);await terminal(db);});
  let page;
  try { page=await scanRegionPage(await scoped(r,c,region,'scan'),region,c.id,stage,token); }
  catch(e) { await fail(awsError(e).code);return; }
  const facts=page.facts;
  const seen=(p.seen as string[]|undefined)??[], fingerprint=page.next?.token?hash(page.next.token):null;
  if (fingerprint && seen.includes(fingerprint)) { await fail('SES_PAGINATION_STALLED');return; }
  const updated=await r.db.transaction(async db=>{
    if (!page.next) await connection(db,c.workspace_id,true);
    if (!(await db.execute(sql`UPDATE provider_connection_regions SET scan_facts=scan_facts||${JSON.stringify(facts)}::jsonb ${facts.configurationSets ? sql`||jsonb_build_object('configurationSets',coalesce(scan_facts->'configurationSets','{}')||${JSON.stringify(facts.configurationSets)}::jsonb)` : sql``},scan_state=${page.next?'scanning':'ready_to_import'} WHERE ${guard}`)).rowCount) return false;
    for (const d of page.domains) await db.execute(sql`INSERT INTO byo_candidates VALUES(${c.id},${region},${d.name},${c.inventory_revision},${JSON.stringify(d.identity)}::jsonb) ON CONFLICT(connection_id,region,name) DO UPDATE SET identity=excluded.identity`);
    if (!page.next) await terminal(db);
    return true;
  });
  if (updated && page.next) throw defer(1050,{...p,...page.next,token:page.next.token??null,seen:fingerprint?[...seen,fingerprint]:[]});
});

const Candidate=z.object({id:z.string(),domain:z.string(),region:z.string(),regionLabel:z.string(),selectable:z.boolean(),status:z.enum(['verified','signing_pending','not_verified','incomplete','already_bound','overlap']),sandbox:z.boolean().nullable(),defaultConfigurationSet:z.string().nullable(),dkimStatus:z.string().nullable(),signingOrigin:z.string().nullable(),mailFromDomain:z.string().nullable(),overlap:z.boolean()});
const Facts=z.object({production:z.boolean().optional(),sendingEnabled:z.boolean().optional(),max24HourSend:z.number().optional(),maxSendRate:z.number().optional(),sentLast24Hours:z.number().optional(),configurationSets:z.record(z.string(),z.object({installation:z.boolean().nullable()})).optional(),receiving:z.object({supported:z.boolean(),set:z.string().nullable(),rules:z.array(z.object({name:z.string(),enabled:z.boolean(),recipients:z.array(z.string()),actions:z.array(z.string())}))}).optional()});
const Pending=z.object({domain:z.string(),importing:z.boolean(),error:z.string().nullable()});
const FailedIntent=Pending.extend({error:z.string()});
const Region=z.object({region:z.string(),regionLabel:z.string(),scanState:z.string(),scanError:z.string().nullable(),sendingState:z.string(),receivingState:z.string(),error:z.string().nullable(),facts:Facts,resources:z.array(z.object({kind:z.string(),resource:z.string(),target:z.string().optional(),state:z.enum(['creating','created']).optional()})),pending:z.array(Pending),failedIntents:z.array(FailedIntent)});
export const RegionStatus=z.object({regions:z.array(Region)});
export const ScanView=z.object({revision:z.number(),cursor:z.object({checked:z.number(),total:z.number()}),state:z.enum(['awaiting_role','failed','scanning','partial','ready_to_import']),error:z.string().nullable(),alreadySendsEmail:z.boolean().nullable(),regions:z.array(Region)});
const Cleanup=z.object({operationId:z.string(),lastError:z.object({region:z.string().nullable(),code:z.string()}).nullable(),remaining:z.array(z.object({region:z.string(),resources:Region.shape.resources})),retain:z.array(z.string())});
export const InventoryFields={scan:ScanView.optional(),candidates:z.array(Candidate).optional(),cleanup:Cleanup.optional()};
export async function statuses(db:DbExecutor,cid:string) {
  const rows=(await db.execute<ScanRow & {pending:z.infer<typeof Pending>[];failed:z.infer<typeof FailedIntent>[]}>(sql`SELECT r.*,i.pending,i.failed FROM provider_connection_regions r CROSS JOIN LATERAL (SELECT
    coalesce(jsonb_agg(jsonb_build_object('domain',i.name,'importing',i.importing,'error',j.last_error) ORDER BY i.name) FILTER(WHERE i.closed_reason IS NULL),'[]') AS pending,
    coalesce(jsonb_agg(jsonb_build_object('domain',i.name,'importing',i.importing,'error',i.closed_reason) ORDER BY i.name) FILTER(WHERE i.closed_reason IS NOT NULL),'[]') AS failed
    FROM byo_domain_intents i LEFT JOIN jobs j ON j.id='byo.bind:'||i.id WHERE i.connection_id=r.connection_id AND i.region=r.region) i WHERE r.connection_id=${cid} ORDER BY r.region`)).rows;
  return rows.map(s=>({region:s.region,regionLabel:regionLabels[s.region]!,scanState:s.scan_state,scanError:s.scan_error,sendingState:s.sending_state,receivingState:s.receiving_state,error:s.provision_error,facts:s.scan_facts,resources:s.ownership_journal.map(({kind,resource,target,state})=>({kind,resource,target,state})),pending:s.pending,failedIntents:s.failed}));
}
async function candidates(db:DbExecutor,c:V5Connection) {
  const rows=(await db.execute<{name:string;region:string;identity:CandidateIdentity;complete:boolean;sandbox:boolean|null;overlap:boolean;bound:boolean}>(sql`SELECT i.name,i.region,i.identity,(r.scan_state='ready_to_import') AS complete,NOT (r.scan_facts->>'production')::boolean AS sandbox,exclusive_domain_overlap(${c.workspace_id},i.name) AS overlap,
    EXISTS(SELECT FROM domain_sending_bindings b WHERE b.workspace_id=${c.workspace_id} AND b.name=i.name) AS bound
    FROM byo_candidates i JOIN provider_connection_regions r USING(connection_id,region) WHERE i.connection_id=${c.id} AND i.revision=${c.inventory_revision} AND i.revision=r.scan_revision ORDER BY i.name,i.region`)).rows;
  return rows.map(d=>{
    const status=!d.complete?'incomplete':d.bound?'already_bound':d.overlap?'overlap':!d.identity.VerifiedForSendingStatus || d.identity.VerificationStatus!=='SUCCESS'?'not_verified':d.identity.DkimAttributes?.SigningEnabled && d.identity.DkimAttributes.Status==='SUCCESS'?'verified':'signing_pending';
    return {id:candidateId(d.region,d.name),domain:d.name,region:d.region,regionLabel:regionLabels[d.region]!,status,selectable:status==='verified'||status==='signing_pending',sandbox:d.sandbox,overlap:d.overlap,defaultConfigurationSet:d.identity.ConfigurationSetName??null,dkimStatus:d.identity.DkimAttributes?.Status??null,signingOrigin:d.identity.DkimAttributes?.SigningAttributesOrigin??null,mailFromDomain:d.identity.MailFromAttributes?.MailFromDomain??null} satisfies z.infer<typeof Candidate>;
  });
}
export async function inventory(db:DbExecutor,c:V5Connection) {
  const regions=await statuses(db,c.id),list=await candidates(db,c),checked=regions.filter(r=>r.scanState!=='scanning').length;
  const proof=c.aws_account_id?null:(await db.execute<{last_error:string|null}>(sql`SELECT last_error FROM jobs WHERE id=${proofId(c)}`)).rows[0]?.last_error??null;
  const state=!c.aws_account_id?(c.state==='failed'?'failed':'awaiting_role'):checked<Object.keys(regionLabels).length?'scanning':regions.every(s=>s.scanError)?'failed':regions.some(s=>s.scanError)?'partial':'ready_to_import';
  const evidence=list.length>0 || regions.some(({facts:f})=>(f.sentLast24Hours??0)>0 || Object.keys(f.configurationSets??{}).length>0 || !!f.receiving?.rules.length);
  const scan={revision:c.inventory_revision,cursor:{checked,total:Object.keys(regionLabels).length},state,error:proof,regions,alreadySendsEmail:evidence?true:state==='ready_to_import'?false:null} satisfies z.infer<typeof ScanView>;
  const cleanup=c.state==='disconnecting'?{operationId:disconnectId(c),lastError:c.disconnect_error,remaining:regions.map(r=>({region:r.region,resources:r.resources.filter(e=>e.kind!=='identity')})).filter(r=>r.resources.length),retain:['SES identities','DNS records','mailbox data']}:undefined;
  return {candidates:list,scan,cleanup};
}

export const Imports=z.object({revision:z.number().int().positive(),candidateIds:z.array(z.string().min(1).max(300)).min(1).max(100),confirm:z.literal(true)}).strict();
export const Accepted=z.object({operationId:z.string(),regions:z.array(z.string())});
type Intent={id:string;region:string;name:string;importing:boolean};
async function saveIntent(db:DbExecutor,c:V5Connection,region:string,name:string,importing:boolean) {
  const row=(await db.execute<{sending_state:string;scan_state:string;bound:string|null;imported:boolean|null}>(sql`SELECT r.sending_state,r.scan_state,b.region AS bound,(dc.identity @> '{"imported":true}') AS imported FROM provider_connection_regions r
    LEFT JOIN domain_sending_bindings b ON b.workspace_id=${c.workspace_id} AND b.name=${name} LEFT JOIN domain_claims dc ON dc.workspace_id=b.workspace_id AND dc.name=b.name
    WHERE r.connection_id=${c.id} AND r.region=${region} FOR SHARE OF r`)).rows[0];
  if (!row || row.sending_state==='disabled' || row.scan_state!=='ready_to_import' && (importing || row.sending_state!=='ready')) throw stale();
  if (row.bound) {
    if (row.bound!==region || importing && !row.imported) throw conflict('DOMAIN_REGION_CONFLICT','This domain already has a sending binding.');
    return;
  }
  if ((await db.execute(sql`SELECT FROM (SELECT exclusive_domain_overlap(${c.workspace_id},${name}) AS overlap) e WHERE overlap`)).rowCount) throw conflict('DOMAIN_CLAIMED','The domain overlaps an existing exclusive claim.');
  const intent=(await db.execute<Intent>(sql`INSERT INTO byo_domain_intents AS i(id,connection_id,region,name,importing) VALUES(${id('dom')},${c.id},${region},${name},${importing})
    ON CONFLICT(connection_id,name) DO UPDATE SET id=CASE WHEN i.closed_reason IS NULL THEN i.id ELSE excluded.id END,region=excluded.region,importing=excluded.importing,closed_reason=NULL
    WHERE i.closed_reason IS NOT NULL OR (i.region=excluded.region AND i.importing=excluded.importing) RETURNING *`)).rows[0];
  if (!intent) throw conflict('DOMAIN_REGION_CONFLICT','Only one sending region may be selected for a domain.');
  const cap=(await db.execute<{total:number;unproven:number}>(sql`SELECT
    (SELECT count(*) FROM domain_claims WHERE workspace_id=${c.workspace_id})+(SELECT count(*) FROM byo_domain_intents WHERE connection_id=${c.id} AND closed_reason IS NULL) AS total,
    (SELECT count(*) FROM domain_claims WHERE workspace_id=${c.workspace_id} AND NOT ever_proven)+(SELECT count(*) FROM byo_domain_intents WHERE connection_id=${c.id} AND closed_reason IS NULL AND NOT importing) AS unproven`)).rows[0]!;
  if (Number(cap.total)>100 || !importing && Number(cap.unproven)>10) throw conflict('DOMAIN_LIMIT_REACHED','The workspace domain limit would be exceeded.');
  if (row.sending_state==='ready') await queueBinding(db,c,intent);
  else await job(db,c,'byo.provision',regionJobId(c,region),{region});
}
const queueBinding=(db:DbExecutor,c:V5Connection,i:Intent)=>job(db,c,'byo.bind','byo.bind:'+i.id,{intent:i.id,region:i.region});
export async function selectImports(r:Runtime,wid:string,input:z.infer<typeof Imports>,key?:string) {
  const c=await requiredV5(r,wid);
  const request=JSON.stringify([c.id,input.revision,[...input.candidateIds].sort()]),op=receipt<Op>(c,'imports',key,request),prior=await op.read(r.db);if (prior) return prior;
  if (c.inventory_revision!==input.revision) throw stale();
  const rows=await candidates(r.db,c), found=new Map(rows.map(v=>[v.id,v])), names=new Set<string>(), groups=new Map<string,string[]>();
  for (const key of input.candidateIds) {
    const v=found.get(key);if (!v || !v.selectable && v.status!=='already_bound') throw stale();
    if (names.has(v.domain)) throw conflict('DUPLICATE_DOMAIN_SELECTION','Select only one region for each domain.');
    names.add(v.domain);groups.set(v.region,[...(groups.get(v.region)??[]),v.domain]);
  }
  // No DB locks across network I/O. The accepting transaction rechecks both revision
  // and regional completeness; a rescan racing these reads invalidates the request.
  for (const [region,domains] of groups) try { await readSelectedDomains(await scoped(r,c,region,'scan'),region,domains); } catch(e) { throw awsError(e); }
  return r.db.transaction(async db=>{
    await getRegionSettings(db,wid,'update');
    const locked=usable(await connection(db,wid,true)),replay=await op.read(db);if (replay) return replay;
    if (locked.id!==c.id || locked.inventory_revision!==input.revision) throw stale();
    for (const [region,domains] of groups) for (const name of domains) await saveIntent(db,c,region,name,true);
    return op.save(db,{operationId:'byo.import:'+hash(request),regions:[...groups.keys()].sort()});
  });
}

// Existing v4/Hosted connections continue to use the synchronous domain API. For
// v5 this returns a durable operation, even if the workspace has no ready region yet.
export async function newRegionalDomain(r:Runtime,wid:string,name:string,owner:boolean,override?:string,key?:string) {
  const c=await connection(r.db,wid);if (!c) return null;
  if (!owner) throw new ApiError(403,'PERMISSION_DENIED','Use an owner or admin dashboard session to enable a regional domain.');
  await writable(r,wid);if (!await claimNameAllowed(name,r.config.publicUrl)) throw new ApiError(422,'DOMAIN_NOT_ALLOWED','A public suffix or reserved domain cannot be claimed.','name');
  return r.db.transaction(async db=>{
    await getRegionSettings(db,wid,'update');if (usable(await connection(db,wid,true)).id!==c.id) throw stale();
    const op=receipt<Op>(c,'domain',key,JSON.stringify([name,override])),prior=await op.read(db);if(prior)return prior;
    const current=(await db.execute<{region:string}>(sql`SELECT region FROM domain_sending_bindings WHERE workspace_id=${wid} AND name=${name} UNION ALL SELECT region FROM byo_domain_intents WHERE connection_id=${c.id} AND name=${name} AND closed_reason IS NULL LIMIT 1`)).rows[0];
    const first=(await db.execute<{region:string}>(sql`SELECT region FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready' ORDER BY ready_at,region LIMIT 1`)).rows[0];
    const region=override??current?.region??first?.region??'us-east-2';
    if (!Object.hasOwn(regionLabels,region)) throw new ApiError(422,'INVALID_REGION','Choose a commercial SES sending region.','region');
    await saveIntent(db,c,region,name,false);
    return op.save(db,{operationId:'byo.domain:'+hash(JSON.stringify([c.id,region,name])),regions:[region]});
  });
}

const provision=runV5(async(r,c,p,attempt)=>{
  const region=String(p.region),ref={connectionId:c.id,region};
  const task=regionJobId(c,region), active=sql`EXISTS(SELECT FROM jobs WHERE id=${task} AND status='running' AND attempts=${attempt} AND lease_until>clock_timestamp() AND payload->>'run'=${p.run})`;
  const target=sql`connection_id=${c.id} AND region=${region} AND NOT legacy`;
  const row=(await r.db.execute<{generation:string;ownership_journal:JournalEntry[]}>(sql`SELECT generation,ownership_journal FROM provider_connection_regions WHERE ${target} AND ${active} AND sending_state NOT IN ('ready','disabled')`)).rows[0];
  if (!row) return;
  let gen=Number(p.generation??0);
  if (!gen || !(await r.db.execute(sql`UPDATE provider_connection_regions SET lease_until=clock_timestamp()+interval '4 minutes' WHERE ${target} AND ${active} AND sending_state='provisioning' AND generation=${gen} AND lease_until>clock_timestamp()`)).rowCount) {
    const accepted=sql`EXISTS(SELECT FROM byo_domain_intents i WHERE i.connection_id=${c.id} AND i.region=${region} AND i.closed_reason IS NULL)`;
    const claimed=(await r.db.execute(acquireRegionProvisioning(ref,sql`${active} AND ${accepted}`,accepted))).rows[0];
    if (!claimed) throw defer(15_000,p);
    gen=Number(claimed.generation);
  }
  const owned=sql`${target} AND ${active} AND sending_state='provisioning' AND generation=${gen} AND lease_until>clock_timestamp()`;
  const fenced=(count:number|null)=>{if (!count) throw conflict('PROVISION_LEASE_LOST','Regional setup is owned by a newer generation.');};
  const journal=(await r.db.execute<{ownership_journal:JournalEntry[]}>(sql`SELECT ownership_journal FROM provider_connection_regions WHERE ${owned}`)).rows[0];
  if (!journal) return;
  try {
    if (!journal.ownership_journal.length) {
      const pending=(await r.db.execute<Intent>(sql`SELECT * FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL`)).rows;
      if (!pending.length) throw conflict('NO_SELECTED_DOMAINS','No domains were selected for this region.');
      const imports=new Map(pending.filter(i=>i.importing).map(i=>[i.name,i.id]));
      if (imports.size) {
        let retired=false;
        const verified=await readSelectedDomains(await scoped(r,c,region,'scan'),region,[...imports.keys()],async name=>{
          await r.db.transaction(async db=>{
            await connection(db,c.workspace_id,true); // Serialize last-intent retirement with accepting a new selection.
            fenced((await db.execute(sql`UPDATE byo_domain_intents SET closed_reason='CANDIDATE_NO_LONGER_VERIFIED' WHERE id=${imports.get(name)!} AND closed_reason IS NULL
              AND EXISTS(SELECT FROM provider_connection_regions WHERE ${owned})`)).rowCount);
            if ((await db.execute(sql`UPDATE provider_connection_regions SET sending_state='unprovisioned',lease_until=NULL,provision_error=NULL WHERE ${owned}
              AND NOT EXISTS(SELECT FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL)`)).rowCount) {
              // Make the queue row reusable before releasing the connection lock; the
              // runner's settlement is fenced by run and cannot overwrite its successor.
              fenced((await db.execute(sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE id=${task} AND status='running' AND attempts=${attempt} AND payload->>'run'=${p.run}`)).rowCount);
              retired=true;
            }
          });
        });
        if (retired) return;
        if (!verified.size && imports.size===pending.length) throw defer(1000,{...p,generation:gen}); // Recheck selections added during the SES reads.
      }
    }
    const result=await provisionByoRegion(await scoped(r,c,region,'provision'),region,c.id,journal.ownership_journal,
      async()=>fenced((await r.db.execute(sql`SELECT FROM provider_connection_regions WHERE ${owned}`)).rowCount),
      async entry=>fenced((await r.db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=(SELECT coalesce(jsonb_agg(e),'[]') FROM jsonb_array_elements(ownership_journal) e WHERE NOT(e->>'kind'=${entry.kind} AND e->>'resource'=${entry.resource}))||${JSON.stringify([entry])}::jsonb WHERE ${owned}`)).rowCount),
      async arn=>fenced((await r.db.execute(sql`UPDATE provider_connection_regions SET feedback_topic_arn=${arn} WHERE ${owned} AND (feedback_topic_arn IS NULL OR feedback_topic_arn=${arn})`)).rowCount));
    if (result.verified) {
      const published=await r.db.transaction(async db=>{
        await getRegionSettings(db,c.workspace_id,'update');await connection(db,c.workspace_id,true);
        if (!(await db.execute(sql`SELECT FROM provider_connection_regions WHERE ${owned} FOR UPDATE`)).rowCount) return false;
        if (!(await db.execute(finishRegionProvisioning(ref,gen,result.topic))).rowCount) return false;
        await db.execute(sql`UPDATE provider_connection_regions SET ready_at=coalesce(ready_at,clock_timestamp()),provision_error=NULL WHERE ${target}`);
        await db.execute(sql`UPDATE ses_installation_settings SET installation_id=${c.id},default_region=(SELECT region FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready' ORDER BY ready_at,region LIMIT 1),
          enabled_regions=(SELECT jsonb_agg(region ORDER BY ready_at,region) FROM provider_connection_regions WHERE connection_id=${c.id} AND sending_state='ready') WHERE workspace_id=${c.workspace_id}`);
        const pending=(await db.execute<Intent>(sql`SELECT * FROM byo_domain_intents WHERE connection_id=${c.id} AND region=${region} AND closed_reason IS NULL`)).rows;
        for (const i of pending) await queueBinding(db,c,i);
        return true;
      });
      if (published) return;
    }
    await r.db.execute(sql`UPDATE provider_connection_regions SET provision_error='SNS_CONFIRMATION_PENDING' WHERE ${owned}`);
    throw defer(15_000,{...p,generation:gen});
  } catch(e) {
    if (e instanceof JobDeferred) throw e;
    const err=awsError(e);
    if (err.retryable) {
      // Keep the journaled topic eligible for signed confirmations during backoff,
      // including when SNS accepted Subscribe but its response never reached us.
      await r.db.execute(sql`UPDATE provider_connection_regions SET provision_error=${err.code} WHERE ${owned}`);
      throw defer(30_000,{...p,generation:gen});
    }
    await r.db.execute(sql`UPDATE provider_connection_regions SET sending_state='failed',lease_until=NULL,provision_error=${err.code} WHERE ${owned}`);
    throw err;
  }
});

async function bindIntent(r:Runtime,c:V5Connection,p:Record<string,unknown>) {
  const guard=sql`i.connection_id=${c.id} AND i.id=${p.intent} AND i.region=${p.region} AND i.closed_reason IS NULL AND cr.sending_state='ready' AND cr.confirmed_topic_arn=cr.feedback_topic_arn AND cr.confirmed_generation=cr.generation`;
  const select=sql`SELECT i.* FROM byo_domain_intents i JOIN provider_connection_regions cr USING(connection_id,region) WHERE ${guard}`;
  const i=(await r.db.execute<Intent>(select)).rows[0];if (!i) return;
  let ses:CandidateIdentity|undefined;
  if (i.importing) try { ses=(await readSelectedDomains(await scoped(r,c,i.region,'scan'),i.region,[i.name])).get(i.name); } catch(e) { throw awsError(e); }
  await r.db.transaction(async db=>{
    await getRegionSettings(db,c.workspace_id,'update');await connection(db,c.workspace_id,true);
    if (!(await db.execute(sql`${select} FOR UPDATE OF i FOR SHARE OF cr`)).rowCount) return;
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(substring(${i.name} FROM '[^.]+\\.[^.]+$'),84912))`);
    if ((await db.execute(sql`SELECT WHERE exclusive_domain_overlap(${c.workspace_id},${i.name})`)).rowCount) throw conflict('DOMAIN_CLAIMED','A selected domain now overlaps an exclusive claim.');
    const claim=(await db.execute<{id:string|null;token:string;error_code:string|null}>(sql`SELECT * FROM reserve_regional_claim(${c.workspace_id},${i.name},${i.region},${i.id},${i.importing?c.id:null})`)).rows[0];
    if (!claim?.id) throw conflict(claim?.error_code??'DOMAIN_CLAIMED','The requested regional binding is no longer available.');
    if (ses) {
      await db.execute(verifyImportedClaims(c.id,[{name:i.name,ses}]));
      if (ses.DkimAttributes?.Status!=='SUCCESS' || !ses.DkimAttributes.SigningEnabled) await db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload,available_at) VALUES(${'domain.verify:'+claim.token},'domain.verify',${c.workspace_id},${JSON.stringify({domainId:claim.id,token:claim.token})}::jsonb,now()+interval '1 minute') ON CONFLICT DO NOTHING`);
    }
    await db.execute(sql`DELETE FROM byo_domain_intents WHERE connection_id=${c.id} AND id=${i.id}`);
  });
}
const bind=runV5(async(r,c,p,attempt)=>{
  try {await bindIntent(r,c,p);} catch(e) {
    // Preserve transient failures for retry. Closing only this attempt's intent
    // frees the name and capacity; a new selection gets a distinct ID and job.
    if (e instanceof ApiError && !e.retryable) await r.db.execute(sql`UPDATE byo_domain_intents i SET closed_reason=${e.code}
      FROM jobs j WHERE i.connection_id=${c.id} AND i.id=${p.intent} AND i.closed_reason IS NULL AND j.id='byo.bind:'||i.id AND j.workspace_id=${c.workspace_id}
        AND j.status='running' AND j.attempts=${attempt} AND j.payload->>'run'=${p.run}`);
    throw e;
  }
});
const disconnectId=(c:V5Connection)=>'byo.disconnect:'+c.id;
export async function disconnectV5(r:Runtime,wid:string,connectionId:string) {
  await writable(r,wid);
  return r.db.transaction(async db=>{
    await lockAdmission(db,{workspaceId:wid});await getRegionSettings(db,wid,'update');
    const c=await connection(db,wid,true);if (!c || c.id!==connectionId) throw stale();
    if (c.state!=='disconnecting') {
      const busy=()=>conflict('CONNECTION_IN_USE','Finish outstanding mail, campaigns and running setup jobs before disconnecting.');
      if ((await db.execute(sql`SELECT FROM sending_emails WHERE workspace_id=${wid} AND status IN ('queued','attempting','acceptance_unknown') LIMIT 1`)).rowCount ||
          (await db.execute(sql`SELECT FROM sending_campaigns c WHERE workspace_id=${wid} AND ${campaignReserved()} LIMIT 1`)).rowCount) throw busy();
      if ((await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${c.id} AND (legacy OR receiving_state<>'off' OR inbound_topic_arn IS NOT NULL) LIMIT 1`)).rowCount) throw conflict('REGIONAL_DISCONNECT_REQUIRED','Receiving resources require separate reviewed cleanup.');
      const setup=sql`workspace_id=${wid} AND ((type LIKE 'byo.%' AND payload->>'connectionId'=${c.id}) OR type IN ('domain.verify','domain.mx','mailbox.reconcile')) AND status IN ('pending','running')`;
      const jobs=(await db.execute<{status:string}>(sql`SELECT status FROM jobs WHERE ${setup} ORDER BY id FOR UPDATE`)).rows;
      if (jobs.some(j=>j.status==='running')) throw busy();
      await db.execute(sql`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE ${setup}`);
      await db.execute(sql`UPDATE provider_connections SET state='disconnecting' WHERE id=${c.id}`);
      await db.execute(sql`UPDATE provider_connection_regions SET sending_state='disabled',generation=generation+1,lease_until=NULL WHERE connection_id=${c.id}`);
    }
    await job(db,c,'byo.disconnect',disconnectId(c));return {operationId:disconnectId(c)};
  });
}

const disconnect:JobHandler=retryDatabaseFailures(async(r,p,j)=>{
  if (!await byoEnabled(r,j.workspaceId)) throw defer(300_000);
  let region:string|null=null;
  const ticket=sql`id=${j.id} AND workspace_id=${j.workspaceId} AND status='running' AND attempts=${j.attempts} AND payload->>'run'=${p.run}`;
  try {
    const more=await r.db.transaction(async db=>{
      await getRegionSettings(db,j.workspaceId,'update');const c=await connection(db,j.workspaceId,true);
      if (!c || c.id!==p.connectionId || c.state!=='disconnecting') return false;
      // Fence the worker through one bounded AWS removal and its checkpoint. Losing
      // the response leaves the old journal; a retry proves absence or checks ownership anew.
      if (!(await db.execute(sql`SELECT FROM jobs WHERE ${ticket} AND lease_until>clock_timestamp() FOR UPDATE`)).rowCount) return false;
      const rr=(await db.execute<{region:string;ownership_journal:JournalEntry[];feedback_topic_arn:string|null}>(sql`SELECT region,ownership_journal,feedback_topic_arn FROM provider_connection_regions WHERE connection_id=${c.id} AND
        (feedback_topic_arn IS NOT NULL OR EXISTS(SELECT FROM jsonb_array_elements(ownership_journal) e WHERE e->>'kind' IS DISTINCT FROM 'identity')) ORDER BY region LIMIT 1 FOR UPDATE`)).rows[0];
      if (!rr) {
        await db.execute(sql`WITH ${releaseConnectionClaims(c.workspace_id,sql`SELECT ${c.id}::text AS id`)} SELECT 1`);
        await db.execute(sql`DELETE FROM provider_connections WHERE id=${c.id} AND state='disconnecting'`);return false;
      }
      region=rr.region;
      const remaining=await removeByoFeedbackResource(await scoped(r,c,region,'cleanup'),region,c.id,rr.ownership_journal,rr.feedback_topic_arn);
      await db.execute(sql`UPDATE provider_connection_regions SET ownership_journal=${JSON.stringify(remaining)}::jsonb,feedback_topic_arn=${remaining.some(e=>e.kind==='topic')?rr.feedback_topic_arn:null} WHERE connection_id=${c.id} AND region=${region}`);
      await db.execute(sql`UPDATE provider_connections SET disconnect_error=NULL WHERE id=${c.id}`);return true;
    });
    if (more) throw defer(1000,p);
  } catch(e) {
    if (e instanceof JobDeferred) throw e;
    const err=awsError(e);await r.db.execute(sql`UPDATE provider_connections SET disconnect_error=${JSON.stringify({region,code:err.code})}::jsonb WHERE id=${p.connectionId} AND state='disconnecting' AND EXISTS(SELECT FROM jobs WHERE ${ticket})`);throw err;
  }
});
export const regionalByoJobs:Record<string,JobHandler>={'byo.prove':prove,'byo.scan':scan,'byo.provision':provision,'byo.bind':bind,'byo.disconnect':disconnect};
