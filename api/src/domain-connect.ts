import { createHmac, hkdfSync, sign, timingSafeEqual } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { Config } from './core.js';

const template = '/v2/domainTemplates/providers/opensend.mx/services/mail';
export const groupIds = ['sending', 'ownership', 'receiving', 'receivingReply', 'mailfrom'] as const;
type Group = typeof groupIds[number];
type Discovery = { zone: string; name: string; id: string; sync: string };

// The TXT value is user-controlled (and may include a path, notably on Cloudflare).
// Pin both ends of discovery, not just the advertised providerId. Never follow redirects.
const cloudflare = 'https://api.cloudflare.com/client/v4/dns/domainconnect';
const ionosApi = ['https://api.domainconnect.ionos.com', 'https://api.domainconnect.1and1.com'];
const ionosSync = ['com','de','co.uk','ca','es','fr','it','mx','at'].map(tld => `https://domainconnect.ionos.${tld}/sync`);
const providers = [
  { id:'cloudflare.com', settings:[cloudflare], api:[cloudflare], sync:['https://dash.cloudflare.com/domainconnect'] },
  { id:'vercel.com', settings:['https://domainconnect.vercel.com'], api:['https://vercel.com/api/domain-connect'], sync:['https://vercel.com/domain-connect'] },
  { id:'ionos.com', settings:ionosApi, api:ionosApi, sync:[...ionosSync, 'https://domainconnect.1and1.com/sync'] },
];
const settingsSchema = z.object({ providerId:z.string().optional(), providerName:z.string().min(1).max(128), providerDisplayName:z.string().min(1).max(128).optional(), urlAPI:z.string(), urlSyncUX:z.string() });
const rr = z.object({ name:z.string(), type:z.number(), data:z.string() });
const dnsSchema = z.object({ Status:z.number(), TC:z.boolean().optional(), Answer:z.array(rr).default([]), Authority:z.array(rr).default([]) });
const dnsName = (name: string) => name.toLowerCase().replace(/\.$/, '');

// TXT may be reached through one or more CNAMEs (IONOS). Ignore unrelated answers.
function txtAt(answers: z.infer<typeof rr>[], name: string) {
  const seen = new Set<string>();
  while (!seen.has(name)) {
    seen.add(name);
    const at = answers.filter(r => dnsName(r.name) === name);
    const txt = at.filter(r => r.type === 16);
    if (txt.length) return txt.length === 1 ? txt[0]!.data.replace(/^"(.*)"$/, '$1') : '';
    const alias = at.find(r => r.type === 5);
    if (!alias) return undefined;
    name = dnsName(alias.data);
  }
  return '';
}

// undefined: no marker at this label, keep walking. null: definitive lack of support.
async function probe(zone:string, signal:AbortSignal): Promise<Discovery|null|undefined> {
  const get=async (url:string,accept='application/json')=>{
    const res=await fetch(url,{headers:{accept},redirect:'error',signal});
    if(res.status===429 || res.status>=500) { await res.body?.cancel(); throw new Error('Discovery temporarily unavailable'); }
    return res;
  };
  const record=`_domainconnect.${zone}`;
  const dns=await get(`https://cloudflare-dns.com/dns-query?name=${record}&type=TXT`,'application/dns-json');
  if (!dns.ok) { await dns.body?.cancel(); throw new Error('Discovery resolver unavailable'); }
  const answer=dnsSchema.parse(await dns.json());
  if (answer.TC || ![0,3].includes(answer.Status)) throw new Error('Incomplete discovery DNS answer');
  const txt=answer.Status===0 ? txtAt(answer.Answer,record) : undefined;
  // Do not cross a known DNS delegation to configure records in its parent.
  if (txt===undefined) return answer.Authority.some(r=>r.type===6 && dnsName(r.name)===zone) ? null : undefined;
  const base=`https://${txt.replace(/\/$/,'')}`, trusted=providers.find(p=>p.settings.includes(base));
  if (!trusted) return null;
  const res=await get(`${base}/v2/${zone}/settings`);
  if (!res.ok) { await res.body?.cancel(); return null; }
  const settings=settingsSchema.safeParse(await res.json());
  if (!settings.success) return null;
  const {providerId,providerName,providerDisplayName,urlAPI,urlSyncUX}=settings.data;
  const api=urlAPI.replace(/\/$/,''), sync=urlSyncUX.replace(/\/$/,'');
  const legacy=base===ionosApi[1] && !providerId && providerName==='1and1';
  if ((!legacy && providerId!==trusted.id) || !trusted.api.includes(api) || !trusted.sync.includes(sync)) return null;
  const support=await get(api+template);
  await support.body?.cancel();
  return support.status===200 ? {zone,id:trusted.id,name:providerDisplayName ?? (legacy?'IONOS':providerName),sync} : null;
}

type CacheEntry = { value: Discovery|null; expiresAt:number };
const cache=new Map<string,CacheEntry>(); // Public metadata only; never share request-bound promises or customer tokens.
function remember(name:string, entry:CacheEntry) {
  if(cache.size>=256 && !cache.has(name)) cache.delete(cache.keys().next().value!);
  cache.set(name,entry);
  return entry.value;
}
export async function discover(name:string):Promise<Discovery|null> {
  const hit=cache.get(name);
  if(hit && hit.expiresAt>Date.now()) return hit.value;
  const signal=AbortSignal.timeout(3000);
  for(let zone=name, hops=0; zone.includes('.') && hops<5; zone=zone.slice(zone.indexOf('.')+1),hops++) {
    const cached=cache.get(zone);
    if(cached && cached.expiresAt>Date.now()) return remember(name,cached);
    let value:Discovery|null|undefined, ttl=300_000;
    try { value=await probe(zone,signal); }
    catch { value=null; ttl=30_000; }
    if(value===undefined) continue;
    const entry={value,expiresAt:Date.now()+ttl};
    if(zone!==name) remember(zone,entry);
    return remember(name,entry);
  }
  return remember(name,{value:null,expiresAt:Date.now()+300_000});
}

type RecordSet = { name:string; region:string; dns:{name:string;type:string;purpose:string;status:string;value:string}[] };
export function pendingGroups(domain:RecordSet, shared:boolean, safeReceiving:boolean, requested:readonly string[]=groupIds) {
  const groups:Group[]=[], vars:Record<string,string>={};
  const pending=domain.dns.filter(r=>r.status==='pending');
  const add=(group:Group, fields:Record<string,string>)=>{ if(requested.includes(group)) {groups.push(group); Object.assign(vars,fields);} };
  const keys=pending.filter(r=>r.purpose==='sending' && r.type==='CNAME');
  if (keys.length===3) {
    const selectors=keys.map(r=>r.name.split('.')[0]!);
    const zone=keys[0]!.value.replace(/\.$/,'').split('.').slice(1).join('.');
    if ((zone==='dkim.amazonses.com' || zone===`dkim.${domain.region}.amazonses.com`) && new Set(selectors).size===3 &&
        keys.every((r,i)=>/^[a-z0-9]{1,63}$/.test(selectors[i]!) && r.name===`${selectors[i]}._domainkey.${domain.name}` && r.value.replace(/\.$/,'')===`${selectors[i]}.${zone}`)) {
      add('sending',{dkim1:selectors[0]!,dkim2:selectors[1]!,dkim3:selectors[2]!,dkimZone:zone.slice(0,-'.amazonses.com'.length)});
    }
  }
  const proof=pending.find(r=>r.purpose==='sending' && r.type==='TXT' && r.name===`_opensend.${domain.name}`);
  if(shared && proof) add('ownership',{ownership:proof.value});
  const mx=pending.find(r=>r.purpose==='receiving' && r.value===`inbound-smtp.${domain.region}.amazonaws.com`);
  if(safeReceiving && mx?.name===domain.name) add('receiving',{region:domain.region});
  if(safeReceiving && mx?.name===`reply.${domain.name}`) add('receivingReply',{region:domain.region});
  const bounce=pending.find(r=>r.purpose==='mail_from' && r.type==='MX' && r.value===`feedback-smtp.${domain.region}.amazonses.com`);
  if(bounce?.name===`email.${domain.name}` && pending.some(r=>r.type==='TXT' && r.name===bounce.name && r.value==='v=spf1 include:amazonses.com ~all')) {
    add('mailfrom',{region:domain.region});
  }
  return {groups,vars};
}

const returnPayload=z.object({workspaceId:z.string().min(1),userId:z.string().min(1),domainId:z.string().min(1),exp:z.number().int().positive()}).strict();
function mac(authSecret:string,encoded:string) {
  const key=hkdfSync('sha256',authSecret,'opensend:keys:v1','domain-connect-return:v1',32);
  return createHmac('sha256',Buffer.from(key)).update(encoded).digest('base64url');
}
function returnToken(authSecret:string,workspaceId:string,userId:string,domainId:string) {
  const encoded=Buffer.from(JSON.stringify({workspaceId,userId,domainId,exp:Date.now()+600_000})).toString('base64url');
  return `${encoded}.${mac(authSecret,encoded)}`;
}
export function verifyReturn(authSecret:string,token:string) {
  const match=/^([A-Za-z0-9_-]{1,1500})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if(!match || !timingSafeEqual(Buffer.from(match[2]!),Buffer.from(mac(authSecret,match[1]!)))) return null;
  try { const p=returnPayload.parse(JSON.parse(Buffer.from(match[1]!,'base64url').toString())); return p.exp>Date.now() ? p : null; }
  catch { return null; }
}

export function signedApply(config:Config, found:Discovery, domain:{id:string;name:string}, selection:ReturnType<typeof pendingGroups>, workspaceId:string,userId:string) {
  const {zone}=found, signing=config.domainConnect;
  if(!signing || !selection.groups.length) return null;
  const token=returnToken(config.authSecret,workspaceId,userId,domain.id);
  const q=new URLSearchParams({domain:zone});
  if(domain.name!==zone) {
    if(!domain.name.endsWith('.'+zone)) throw new Error('Invalid discovery zone');
    q.set('host',domain.name.slice(0,-zone.length-1));
  }
  for(const [name,value] of Object.entries(selection.vars)) q.set(name,value);
  q.set('groupId',selection.groups.join(','));
  q.set('redirect_uri',`${config.publicUrl}/v1/domains/${encodeURIComponent(domain.id)}/dns-setup/return/${token}`);
  q.set('state',token);
  q.sort();
  const signature=Buffer.from(sign('RSA-SHA256',Buffer.from(q.toString()),signing.privateKey)).toString('base64');
  q.set('key',signing.keyId); q.set('sig',signature); // Signature excludes both and must be last on Cloudflare.
  return `${found.sync}${template}/apply?${q}`;
}
