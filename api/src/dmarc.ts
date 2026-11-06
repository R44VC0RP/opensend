import { placementRoot } from './domain-registry.js';
import { dns, fqdn } from './public-dns.js';
import type { IdentityFacts } from './states.js';

type Policy = 'none'|'quarantine'|'reject';
type Mode = 'r'|'s';
type PolicyRecord = { status:Policy|'invalid'|'missing'; record:string|null; source:string|null; adkim:Mode; aspf:Mode };
export type DmarcObservation = PolicyRecord & { checkedAt:number; recommend:boolean; alignedMailFrom:string|null };
const isPolicy=(p?:string):p is Policy=>p==='none' || p==='quarantine' || p==='reject';

function policyAt(values:string[],source:string,inherited:boolean):PolicyRecord|null {
  const records=values.map(s=>s.replace(/^"|"$/g,'').replace(/"\s*"/g,''))
    .filter(s=>/(?:^|;)\s*(?:v\s*=\s*DMARC|p\s*=)/i.test(s));
  if(!records.length) return null;
  const invalid={status:'invalid',record:records.join('\n'),source,adkim:'r',aspf:'r'} as const;
  if(records.length!==1) return invalid;
  const record=records[0]!, tags=new Map<string,string>();
  for(const field of record.trim().replace(/;$/,'').split(';')) {
    const m=/^\s*([a-z][a-z0-9_-]*)\s*=\s*([^;\x00-\x1f]+?)\s*$/i.exec(field);
    if(!m || tags.has(m[1]!.toLowerCase())) return invalid;
    tags.set(m[1]!.toLowerCase(),m[2]!);
  }
  const [v,p]=tags.keys(), policy=tags.get('p')?.toLowerCase(), sub=tags.get('sp')?.toLowerCase();
  const adkim=tags.get('adkim')?.toLowerCase() ?? 'r', aspf=tags.get('aspf')?.toLowerCase() ?? 'r';
  if(v!=='v' || tags.get(v)!=='DMARC1' || p!=='p' || !isPolicy(policy) || (sub!==undefined && !isPolicy(sub)) ||
     !['r','s'].includes(adkim) || !['r','s'].includes(aspf) || (tags.has('pct') && !/^(?:\d{1,2}|100)$/.test(tags.get('pct')!))) return invalid;
  return {status:inherited && sub ? sub : policy,record,source,adkim:adkim as Mode,aspf:aspf as Mode};
}

// The verifier persists this alongside its SES and MX facts. No resolver calls in MX reads or admissions.
export async function observeDmarc(name:string,mailFrom?:string):Promise<DmarcObservation|null> {
  const signal=AbortSignal.timeout(5000);
  const {root}=await placementRoot(name), query=(host:string)=>dns('_dmarc.'+host,'TXT',signal);
  const exact=await query(name);
  let policy=policyAt(exact.values,name,false), empty=!exact.values.length && exact.aliases.length===1;
  if(!policy && root && root!==name) {
    const org=await query(root);
    policy=policyAt(org.values,root,true);
    empty &&= !org.values.length && org.aliases.length===1;
  }
  // Our alignment boundary is the shared PSL. Before recommending a new TXT,
  // also rule out an inherited policy visible to RFC 9989 tree-walk receivers.
  // An authoritative disagreement returns null; transport failures reject.
  if(!policy && empty) {
    const labels=name.split('.').slice(1).slice(-7);
    const other=labels.map((_,i)=>labels.slice(i).join('.')).filter(host=>host!==root);
    const answers=await Promise.all(other.map(query));
    if(answers.some((rr,i)=>policyAt(rr.values,other[i]!,true))) return null;
  }
  policy??={status:'missing',record:null,source:null,adkim:'r',aspf:'r'};
  const bounce=mailFrom && fqdn(mailFrom);
  const aligns=bounce && (name===bounce || (policy.aspf==='r' && root && (await placementRoot(bounce)).root===root));
  return {...policy,checkedAt:Date.now(),recommend:policy.status==='missing' && empty,alignedMailFrom:aligns?bounce:null};
}

export function dmarcView(obs:DmarcObservation|null|undefined,ses:IdentityFacts['ses']) {
  if(!obs || obs.checkedAt<Date.now()-48*3600_000) return null;
  const {status,record,source,adkim,aspf}=obs, mail=ses.MailFromAttributes;
  return {status,record,source,adkim,aspf,alignment:{
    // The checked From domain IS this SES identity (also an exact match in strict mode).
    dkim:ses.DkimAttributes?.SigningEnabled===true && ses.DkimAttributes.Status==='SUCCESS',
    spf:!!obs.alignedMailFrom && mail?.MailFromDomainStatus==='SUCCESS' && fqdn(mail.MailFromDomain ?? '')===obs.alignedMailFrom,
  }};
}

// Self-hosted detail already refreshes SES inline; cache public DNS only and never cache an in-flight request.
const local=new Map<string,{value:DmarcObservation|null;until:number}>();
export async function localDmarc(name:string,mailFrom?:string,refresh=false) {
  const key=name+':'+(mailFrom ?? ''), hit=local.get(key);
  if(!refresh && hit && hit.until>Date.now()) return hit.value;
  const value=await observeDmarc(name,mailFrom).catch(()=>null);
  if(local.size>=256) local.delete(local.keys().next().value!);
  local.set(key,{value,until:Date.now()+(value?300_000:30_000)}); return value;
}
