import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { z } from 'zod';
import { SESv2Client,CreateTenantResourceAssociationCommand,GetEmailIdentityCommand,ListResourceTenantsCommand,DkimSigningAttributesOrigin } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand,STSClient } from '@aws-sdk/client-sts';
import { postgresConnection } from '../src/adapters/node.js';
import { id } from '../src/core.js';
import { domainName,claimNameAllowed } from '../src/domain-claims.js';
import { platformAccount } from '../src/byo-regional.js';
import { adoptionFingerprint,matchesAdoption } from '../src/adopted-identity.js';
import { paceSetupSes,poolTenantName } from '../src/ses-setup.js';
import { requirePoolFlags } from './set-domain-pool.js';

const region='us-east-1',prefix=`arn:aws:ses:${region}:${platformAccount}:identity/`;
const attestation=z.object({workspaceId:z.string(),installation:z.literal('opensend-042df6f752eaa1f62cb8'),scope:z.literal('exclusive-send-only'),identities:z.array(z.object({
  arn:z.string(),defaultSet:z.string().nullable(),dkimOrigin:z.enum(DkimSigningAttributesOrigin),dkimZone:z.string().nullable(),dkimTokens:z.array(z.string().min(1)),mailFrom:z.string().nullable(),mailFromBehavior:z.enum(['USE_DEFAULT_VALUE','REJECT_MESSAGE']).nullable(),
}).strict()).length(12)}).strict();

// No API endpoint. `arns` is the very same private JSON array supplied to the IAM renderer.
// Its independently reviewed facts are pinned BEFORE reading AWS; live discovery is not authorization.
export async function adoptIdentities(db:Client,ses:SESv2Client,wid:string,arns:unknown,inventory:unknown,operator:string,apply:boolean,env:Record<string,string|undefined>=process.env) {
  requirePoolFlags(env);
  if (!operator.startsWith(`arn:aws:sts::${platformAccount}:assumed-role/`)) throw new Error('Use the signed-in platform migration operator, never the runtime principal.');
  const input=attestation.parse(inventory),list=z.array(z.string()).length(12).parse(arns).sort(),tenant=poolTenantName(wid,'trusted');
  if (input.workspaceId!==wid || new Set(list).size!==12) throw new Error('Attestation workspace or ARN list mismatch.');
  const domains=input.identities.sort((a,b)=>a.arn<b.arn?-1:a.arn>b.arn?1:0).map(({arn,...facts},i)=>{
    const name=arn.slice(prefix.length);
    if (list[i]!==arn || !arn.startsWith(prefix) || domainName.safeParse(name).data!==name || facts.mailFrom && !facts.mailFrom.endsWith('.'+name)) throw new Error('Expected exactly the attested Virginia domain ARNs and their MAIL FROM hosts.');
    facts.dkimTokens.sort();return {name,arn,fingerprint:adoptionFingerprint(facts)};
  });
  for (const d of domains) if (!await claimNameAllowed(d.name,'https://opensend.mx')) throw new Error('Reserved identity name.');
  const digest=createHash('sha256').update(JSON.stringify([wid,input.installation,input.scope,domains])).digest('hex');
  async function members(arn:string) {
    const p=await ses.send(new ListResourceTenantsCommand({ResourceArn:arn,PageSize:2}));
    if (!Array.isArray(p.ResourceTenants) || p.NextToken || p.ResourceTenants.length>1 || p.ResourceTenants.some(t=>t.TenantName!==tenant || t.ResourceArn!==arn)) throw new Error('Unexpected or ambiguous SES tenant membership.');
    return p.ResourceTenants[0];
  }
  async function readIdentity(d:typeof domains[number]) {
    const s=await ses.send(new GetEmailIdentityCommand({EmailIdentity:d.name}));
    if (!matchesAdoption(s,d.fingerprint)) throw new Error(`SES identity, DKIM, default set or MAIL FROM drift: ${d.arn}`);
    return {VerificationStatus:s.VerificationStatus,VerifiedForSendingStatus:s.VerifiedForSendingStatus,DkimAttributes:s.DkimAttributes,MailFromAttributes:s.MailFromAttributes};
  }
  // Same settings -> connection -> sorted namespace lock order as claim reservation. Allow
  // related names inside this exact manifest, never an unrelated exact/parent/child claim.
  async function inspectClaims(reserving:boolean) {
    const c=(await db.query(`SELECT c.id,o.arn FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
      JOIN provider_connection_regions r ON r.connection_id=c.id JOIN provider_pool_regions p ON p.region=r.region AND p.aws_account_id=c.aws_account_id
      JOIN hosted_tenant_ownership o ON o.workspace_id=c.workspace_id AND o.region=r.region
      WHERE c.workspace_id=$1 AND c.kind='shared' AND c.state='ready' AND c.paused_at IS NULL AND c.aws_account_id=$2 AND r.region=$3 AND NOT r.legacy AND r.pool_tenant_name=$4
      AND r.sending_state='ready' AND r.tenant_state='ready' AND r.receiving_state='off' AND p.sending_state='ready' AND p.confirmed_generation=p.generation
      AND p.feedback_topic_arn=$5 FOR ${reserving?'NO KEY UPDATE':'SHARE'} OF s FOR SHARE OF c,r,p,o`,[wid,platformAccount,region,tenant,`arn:aws:sns:${region}:${platformAccount}:opensendmx-trusted-feedback`])).rows[0];
    if (!c || !c.arn.startsWith(`arn:aws:ses:${region}:${platformAccount}:tenant/${tenant}/`)) throw new Error('Prepare and canary the signed Virginia pool and workspace tenant first.');
    const names=domains.map(d=>d.name);
    for (const root of [...new Set(names.map(n=>n.split('.').slice(-2).join('.')))].sort()) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,84912))',[root]);
    const rows=(await db.query(`SELECT a.name,a.arn,a.associated FROM hosted_adoptions a WHERE a.name=ANY($1) AND a.workspace_id=$2 AND a.manifest_hash=$3 AND a.tenant_arn=$4`,[names,wid,digest,c.arn])).rows;
    if (rows.length && rows.length!==12 || (await db.query('SELECT FROM hosted_adoptions WHERE name=ANY($1) AND (workspace_id,manifest_hash,tenant_arn)<>($2,$3,$4)',[names,wid,digest,c.arn])).rowCount) throw new Error('The recorded manifest or tenant differs from the attestation.');
    const overlaps=(await db.query(`SELECT dc.name,b.region,b.connection_id,dc.workspace_id,dc.identity,dc.claim_scope,dc.receiving_state FROM domain_claims dc
      LEFT JOIN domain_sending_bindings b USING(workspace_id,name) WHERE EXISTS(SELECT FROM unnest($1::text[]) n WHERE right('.'||dc.name,length(n)+1)='.'||n OR right('.'||n,length(dc.name)+1)='.'||dc.name) ORDER BY dc.name FOR UPDATE OF dc`,[names])).rows;
    for (const x of overlaps) if (x.workspace_id!==wid || x.region!==region || x.connection_id!==c.id || x.receiving_state!=='off' || x.claim_scope!=='exclusive' || !rows.find(r=>r.name===x.name && r.arn===x.identity?.adopted?.arn)) throw new Error('Overlapping or changed domain claim.');
    if (Number((await db.query('SELECT count(*) FROM domain_claims WHERE workspace_id=$1',[wid])).rows[0].count)+12-overlaps.length>100) throw new Error('Workspace domain limit exceeded.');
    return {c,prior:new Map(rows.map(r=>[r.name,r])),bound:new Set(overlaps.map(r=>r.name))};
  }
  const plan:{arn:string;tenant:string;action:string}[]=[];
  // Never hold an exclusive workspace settings lock across these control-plane reads.
  const initial=new Map<string,Awaited<ReturnType<typeof members>>>();
  for (const d of domains) {await readIdentity(d);initial.set(d.name,await members(d.arn));}
  await db.query('BEGIN');
  try {
    const {c,prior,bound}=await inspectClaims(apply);
    for (const d of domains) {
      const member=initial.get(d.name),saved=prior.get(d.name);
      if (member && (!saved || member.TenantId!==c.arn.split('/').at(-1)) || saved?.associated && !member) throw new Error('SES tenant membership drift.');
      plan.push({arn:d.arn,tenant,action:member?'verify existing association':'associate, verify and bind send-only'});
    }
    if (!apply) {await db.query('ROLLBACK');return plan;}
    // Commit the entire intent before the first AWS write. No verify job, TXT shortcut,
    // receiving projection or send eligibility for a partially associated batch.
    for (const d of domains) {
      if (!prior.has(d.name)) await db.query('INSERT INTO hosted_adoptions(name,arn,workspace_id,manifest_hash,tenant_arn) VALUES($1,$2,$3,$4,$5)',[d.name,d.arn,wid,digest,c.arn]);
      if (bound.has(d.name)) continue;
      await db.query(`INSERT INTO domain_claims(workspace_id,name,connection_id,claim_scope,identity,ever_proven) VALUES($1,$2,$3,'exclusive',$4,true)`,[wid,d.name,c.id,{ses:{},proven:false,mx:null,note:null,imported:true,adopted:{arn:d.arn,fingerprint:d.fingerprint}}]);
      await db.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,$3,$4)',[id('dom'),wid,d.name,region]);
    }
    await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'adoption-intent',$2)`,[wid,{operator,digest,tenant,source:input.installation}]);
    await db.query('COMMIT');
  } catch(e) {await db.query('ROLLBACK');throw e;}
  await db.query('BEGIN');
  try {
    const {c,prior,bound}=await inspectClaims(false);if (bound.size!==12 || prior.size!==12) throw new Error('The reserved claims changed.');
    const missing:string[]=[];
    for (const d of domains) {
      await readIdentity(d);const m=await members(d.arn);
      if (!m && prior.get(d.name)?.associated || m && m.TenantId!==c.arn.split('/').at(-1)) throw new Error('Association drift before apply.');
      if (!m) missing.push(d.arn);
    }
    for (const arn of missing) await ses.send(new CreateTenantResourceAssociationCommand({TenantName:tenant,ResourceArn:arn}));
    for (const d of domains) {
      const m=await members(d.arn);if (!m || m.TenantId!==c.arn.split('/').at(-1)) throw new Error('Exclusive association is not yet visible; rerun the same manifest.');
      const ses=await readIdentity(d);
      await db.query(`UPDATE domain_claims SET sending_state='verified',lost_since=NULL,identity=identity||$4::jsonb WHERE workspace_id=$1 AND connection_id=$2 AND name=$3`,[wid,c.id,d.name,{ses,proven:true}]);
    }
    await db.query('UPDATE hosted_adoptions SET associated=true WHERE workspace_id=$1 AND manifest_hash=$2',[wid,digest]);
    await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'adoption-published',$2)`,[wid,{operator,digest,tenant}]);
    await db.query('COMMIT');return plan;
  } catch(e) {await db.query('ROLLBACK');throw e;}
}
if (import.meta.main) {
  requirePoolFlags(process.env);
  const {positionals:[wid,...rest],values:v}=parseArgs({allowPositionals:true,options:{manifest:{type:'string'},facts:{type:'string'},'dry-run':{type:'boolean'},apply:{type:'boolean'}}});
  if (!wid || rest.length || !v.manifest || v['dry-run'] && v.apply) throw new Error('Usage: adopt-identities.ts WORKSPACE_ID --manifest ARNS.json [--facts FACTS.json] [--dry-run|--apply]');
  const arns=JSON.parse(await readFile(v.manifest,'utf8')),facts=JSON.parse(await readFile(v.facts??v.manifest+'.facts.json','utf8'));
  const cfg={profile:'anomaly',region,ignoreConfiguredEndpointUrls:true,maxAttempts:1},sts=new STSClient(cfg),ses=new SESv2Client(cfg);paceSetupSes(ses);
  const db=new Client(postgresConnection(process.env.DATABASE_URL));await db.connect();
  try {
    const op=await sts.send(new GetCallerIdentityCommand({}));
    if (op.Account!==platformAccount || !op.Arn) throw new Error('Unexpected migration operator account.');
    console.table(await adoptIdentities(db,ses,wid,arns,facts,op.Arn,!!v.apply));
  } finally {await db.end();sts.destroy();ses.destroy();}
}
