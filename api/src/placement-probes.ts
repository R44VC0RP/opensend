import { isIPv4, isIPv6 } from 'node:net';
import tls from 'node:tls';
import { domainToUnicode } from 'node:url';
import { z } from 'zod';
import { icannRules, privateRules, rdapServices } from './placement-registries.js';

const day = 86_400_000;
const rules = new Set(icannRules.trim().split(/\s+/)), privateSuffixes = new Set([...privateRules.trim().split(/\s+/),
  'wordpress.com','weebly.com','myshopify.com','tumblr.com','squarespace.com']); // Not every hosting provider registers its suffix.
const registries = new Map(rdapServices.flatMap(([tlds,base]) => tlds.split(' ').map(tld => [tld,base] as const)));
const hostSyntax = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// PSL longest match, including wildcard and exception rules. Never borrow a hosting
// provider's registration date, signup, or mail records for one of its tenants.
export function placementRoot(host:string) {
  const labels=host.split('.'); let suffix=1, shared=false;
  for(let i=0;i<labels.length;i++) {
    const name=labels.slice(i).join('.'), wildcard='*.'+labels.slice(i+1).join('.');
    if(privateSuffixes.has('!'+name) || rules.has('!'+name)) { suffix=labels.length-i-1; shared=privateSuffixes.has('!'+name); break; }
    if(privateSuffixes.has(name) || privateSuffixes.has(wildcard)) { suffix=labels.length-i; shared=true; break; }
    if(rules.has(name) || rules.has(wildcard)) { suffix=labels.length-i; break; }
  }
  return {root:labels.length>suffix ? labels.slice(-suffix-1).join('.') : null, shared};
}

const protectedBrands = ['paypal.com','google.com','microsoft.com','apple.com','amazon.com','stripe.com','opensend.mx'];
const confusables:Record<string,string> = { '0':'o','1':'l','3':'e','4':'a','5':'s','7':'t','а':'a','α':'a','е':'e','ε':'e','і':'i','ι':'i','ӏ':'l','о':'o','ο':'o','р':'p','ρ':'p','с':'c','ѕ':'s','т':'t','у':'y','х':'x','ν':'v','к':'k','м':'m' };
const skeleton = (value:string) => domainToUnicode(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'').replace(/./gu,c=>confusables[c]??c).replace(/rn/g,'m');
export function brandLookalike(host:string) {
  const labels=host.split('.').slice(0,-1).map(skeleton);
  return protectedBrands.some(official => host!==official && !host.endsWith('.'+official) && labels.some(label =>
    [label.replaceAll('-',''),...label.split('-')].includes(official.split('.')[0]!)));
}

async function boundedJson(url:string,accept:string,signal:AbortSignal,limit:number) {
  const res=await fetch(url,{headers:{accept},redirect:'manual',signal});
  if(!res.ok || !res.body) { await res.body?.cancel(); throw new Error('Probe unavailable'); }
  const reader=res.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try {
    for(;;) { const next=await reader.read(); if(next.done) break;
      size+=next.value.length; if(size>limit) { await reader.cancel(); throw new Error('Probe response too large'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
const registrations = new Map<string,{created:number;expires:number}>(); // Public dates only, no cross-request I/O.
async function rdapAge(root:string,signal:AbortSignal) {
  const now=Date.now(), cached=registrations.get(root);
  if(cached && cached.expires>now) return Math.floor((now-cached.created)/day);
  const base=registries.get(root.split('.').at(-1)!); if(!base) return null;
  const data=z.object({ldhName:z.string(),events:z.array(z.object({eventAction:z.string(),eventDate:z.string()}))}).parse(
    await boundedJson(`${base.replace(/\/$/,'')}/domain/${root}`,'application/rdap+json',signal,256*1024));
  if(data.ldhName.toLowerCase()!==root) return null;
  const created=Date.parse(data.events.find(e=>e.eventAction==='registration')?.eventDate??'');
  if(!Number.isFinite(created) || created>now) return null;
  if(registrations.size>=256) registrations.delete(registrations.keys().next().value!);
  registrations.set(root,{created,expires:now+3_600_000}); return Math.floor((now-created)/day);
}

const rr=z.object({name:z.string(),type:z.number(),data:z.string()});
const dnsResponse=z.object({Status:z.number(),TC:z.boolean().optional(),Answer:z.array(rr).default([]),Authority:z.array(rr).default([])});
const fqdn=(s:string)=>s.toLowerCase().replace(/\.$/,'');
async function dns(name:string,type:'A'|'AAAA'|'MX'|'TXT',signal:AbortSignal) {
  const url=new URL('https://cloudflare-dns.com/dns-query');url.search=new URLSearchParams({name,type}).toString();
  const result=dnsResponse.parse(await boundedJson(url.href,'application/dns-json',signal,64*1024));
  if(result.TC || ![0,3].includes(result.Status)) throw new Error('Incomplete DNS');
  const aliases=new Set<string>(); let at=name;
  for(;;) {
    if(aliases.has(at) || aliases.size>12) throw new Error('Invalid alias chain'); aliases.add(at);
    const records=result.Answer.filter(r=>fqdn(r.name)===at), alias=records.find(r=>r.type===5);
    if(!alias) return {status:result.Status,authority:result.Authority,aliases:[...aliases],values:records.filter(r=>r.type==={A:1,AAAA:28,MX:15,TXT:16}[type]).map(r=>r.data)};
    at=fqdn(alias.data);
  }
}
// Abort the transport AND settle each signal by the common deadline; even a stalled
// body reader must not make already-completed sibling observations disappear.
function observe<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T|null> {
  if(signal.aborted) return Promise.resolve(null);
  return new Promise(resolve=>{
    const finish=(value:T|null)=>{signal.removeEventListener('abort',cancel);resolve(value);},cancel=()=>finish(null);
    signal.addEventListener('abort',cancel,{once:true});void work().then(finish,cancel);
  });
}
const txt=(values:string[])=>values.map(s=>s.replace(/^"|"$/g,'').replace(/"\s+"/g,''));
// Validate mechanisms locally; never execute someone else's SPF include/redirect tree.
function spf(values:string[]) {
  const records=txt(values).filter(s=>/^v=spf1(?: |$)/i.test(s)); if(records.length!==1) return false;
  const modifiers=new Set<string>();
  return records[0]!.trim().split(/ +/).slice(1).every(token=>{
    const term=token.toLowerCase(), mod=/^([a-z][\w.-]*)=(\S+)$/.exec(term);
    if(mod) { if(modifiers.has(mod[1]!)) return false; modifiers.add(mod[1]!); return !['redirect','exp'].includes(mod[1]!) || hostSyntax.test(mod[2]!); }
    const mech=term.replace(/^[+?~-]/,''), ip=/^ip([46]):([^/]+)(?:\/(\d+))?$/.exec(mech);
    if(ip) return (ip[1]==='4'?isIPv4(ip[2]!):isIPv6(ip[2]!)) && (ip[3]===undefined || Number(ip[3])<=(ip[1]==='4'?32:128));
    const mx=/^(?:a|mx)(?::([^/]+))?(?:\/(\d+))?(?:\/\/(\d+))?$/.exec(mech);
    if(mx) return (!mx[1] || hostSyntax.test(mx[1])) && Number(mx[2]??0)<=32 && Number(mx[3]??0)<=128;
    const ref=/^(?:include|exists|ptr):(.+)$/.exec(mech);
    return ref ? /^[a-z0-9_.-]+\.[a-z]{2,63}$/.test(ref[1]!) : ['all','ptr'].includes(mech);
  });
}
function dmarc(values:string[]) {
  const records=txt(values).filter(s=>/^v=DMARC1(?:;|$)/i.test(s)); if(!records.length) return 'absent';
  return records.length===1 && /^v=DMARC1\s*;\s*p=(?:none|quarantine|reject)\s*(?:;|$)/i.test(records[0]!) && !/;\s*p=.*;\s*p=/i.test(records[0]!) ? 'valid':'invalid';
}
async function mailDns(name:string,signal:AbortSignal) {
  const [mx,policy,report]=await Promise.all([observe(signal,()=>dns(name,'MX',signal)),observe(signal,()=>dns(name,'TXT',signal)),observe(signal,()=>dns('_dmarc.'+name,'TXT',signal))]);
  return {mx:mx && mx.values.length>0 && mx.values.every(v=>{const m=/^(\d+)\s+(\S+)$/.exec(v);return !!m && +m[1]!<=65535 && hostSyntax.test(fqdn(m[2]!));}),
    spf:policy && spf(policy.values),dmarc:report && dmarc(report.values)};
}
async function dbl(name:string,zone:string,signal:AbortSignal) {
  const res=await dns(`${name}.${zone}`,'A',signal);
  // A denied public resolver, usage-limit code, unexpected address or SERVFAIL is not clean.
  if(res.status===0 && res.values.some(a=>/^127\.0\.1\.(?:2|4|5|6|10[2-6])$/.test(a))) return 'listed';
  if(res.status===3 && res.authority.some(r=>r.type===6 && (fqdn(r.name)===zone || (fqdn(r.name)==='dbl.dq.spamhaus.net' && zone.endsWith('.dbl.dq.spamhaus.net'))))) return 'clear';
  return null;
}

// Use only a proved public IP literal for the TCP destination; SNI and Host are
// the original DNS name. No ambient resolver, proxy, redirect, cookies, or fallback.
function publicIPv4(ip:string) {
  if(!isIPv4(ip)) return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) ||
    (a===192 && (b===0 || b===168 || (b===88 && c===99))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
function publicIPv6(ip:string) {
  if(!isIPv6(ip) || /[%.]/.test(ip)) return false;
  const [first,second]=ip.split(':').map(s=>parseInt(s||'0',16));
  // Global unicast only; exclude special-use, documentation and transition/tunneling ranges.
  return first>=0x2000 && first<0x4000 && !(first===0x2001 && (second<=0x1ff || second===0xdb8)) &&
    first!==0x2002 && first!==0x3ffe && !(first===0x3fff && second<0x1000);
}
function httpsHead(host:string,ip:string,signal:AbortSignal):Promise<string> {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const socket=tls.connect({host:ip,port:443,servername:host,rejectUnauthorized:true},()=>{
      socket.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
    });
    const abort=()=>socket.destroy(new Error('Probe timed out'));
    signal.addEventListener('abort',abort,{once:true}); let headers='';
    socket.on('error',reject).on('close',()=>{signal.removeEventListener('abort',abort);reject(new Error('Incomplete HTTP headers'));});
    socket.on('data',(chunk:Uint8Array)=>{
      headers+=Buffer.from(chunk.subarray(0,16_384-headers.length)).toString('latin1');
      const end=headers.indexOf('\r\n\r\n');
      if(end!==-1) { resolve(headers.slice(0,end)); socket.destroy(); } else if(headers.length>=16_384) socket.destroy(new Error('Headers too large'));
    });
  });
}
const parking=/\b(?:sedoparking|parkingcrew|bodis|afternic|dan\.com|domainparking|hugedomains)\b/i;
async function website(host:string,signal:AbortSignal) {
  if(!hostSyntax.test(host) || /\.(?:localhost|internal|local|lan|home|invalid|test|example|arpa|onion)$/.test(host)) return null;
  let a=await dns(host,'A',signal);
  if(a.status===0 && !a.values.length) { a=await dns(host,'AAAA',signal); if(!a.values.every(publicIPv6)) return null; }
  else if(!a.values.every(publicIPv4)) return null;
  if(a.status!==0 || !a.values.length) return null;
  if(a.aliases.some(alias=>parking.test(alias))) return 'parked';
  const headers=await httpsHead(host,a.values[0]!,signal);
  if(/^HTTP\/1\.[01] 3\d\d\b/.test(headers)) return 'redirect';
  if(!/^HTTP\/1\.[01] 200\b/.test(headers) || !/\r\ncontent-type:\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(headers)) return null;
  return parking.test(headers) || /\r\nx-(?:parking|parked)[-:]/i.test(headers) ? 'parked':'live';
}
export async function publicSignals(host:string,root:string|null,shared:boolean,zone:string|undefined,signal:AbortSignal) {
  const names=root && root!==host ? [host,root]:[host];
  const [ageDays,mail,site,lists]=await Promise.all([root && !shared ? observe(signal,()=>rdapAge(root,signal)):null,
    Promise.all(names.map(n=>mailDns(n,signal))),observe(signal,()=>website(host,signal)),Promise.all(names.map(n=>zone ? observe(signal,()=>dbl(n,zone,signal)):null))]);
  return {root,shared,ageDays,exact:mail[0]!,parent:mail[1]??null,site,lookalike:brandLookalike(host),
    dbl:!zone?'unconfigured':lists.includes('listed')?'listed':root && lists.every(v=>v==='clear')?'clear':'unknown',dblExact:lists[0],dblParent:lists[1]??null};
}
