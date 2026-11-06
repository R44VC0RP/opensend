import { z } from 'zod';

export async function boundedJson(url:string,accept:string,signal:AbortSignal,limit:number) {
  const res=await fetch(url,{headers:{accept},redirect:'manual',signal});
  if(!res.ok || !res.body) { await res.body?.cancel(); throw new Error('Probe unavailable'); }
  const reader=res.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try {
    for(;;) { const next=await reader.read(); if(next.done) break;
      size+=next.value.length; if(size>limit) { await reader.cancel(); throw new Error('Probe response too large'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
const rr=z.object({name:z.string(),type:z.number(),data:z.string()});
const dnsResponse=z.object({Status:z.number(),TC:z.boolean().optional(),Answer:z.array(rr).default([]),Authority:z.array(rr).default([])});
export const fqdn=(s:string)=>s.toLowerCase().replace(/\.$/,'');
export async function dns(name:string,type:'A'|'AAAA'|'MX'|'TXT',signal:AbortSignal) {
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
