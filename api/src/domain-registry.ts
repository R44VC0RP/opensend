// Request modules can import the lookup functions without loading the registry
// snapshot. Claim validation needs the PSL, but never needs to build the RDAP map.
let suffixes:{icann:Set<string>;private:Set<string>}|undefined;
let registries:Map<string,string>|undefined;

export async function rdapBase(tld:string) {
  if(!registries) {
    const {rdapServices}=await import('./placement-registries.js');
    registries??=new Map(rdapServices.flatMap(([tlds,base])=>tlds.split(' ').map(t=>[t,base] as const)));
  }
  return registries.get(tld);
}

// Longest PSL match, including exceptions and wildcards. A wildcard's base
// (e.g. sch.uk) is also not an independently registrable name.
export async function placementRoot(host:string) {
  if(!suffixes) {
    const {icannRules,privateRules}=await import('./placement-registries.js');
    suffixes??={icann:new Set(icannRules.trim().split(/\s+/)),private:new Set([...privateRules.trim().split(/\s+/),
      'wordpress.com','weebly.com','myshopify.com','tumblr.com','squarespace.com'])}; // Not every host registers its suffix.
  }
  const labels=host.split('.'),{icann,private:platform}=suffixes; let suffix=1,shared=false;
  for(let i=0;i<labels.length;i++) {
    const name=labels.slice(i).join('.'),wildcard='*.'+labels.slice(i+1).join('.');
    if(platform.has('!'+name) || icann.has('!'+name)) { suffix=labels.length-i-1; shared=platform.has('!'+name); break; }
    if(platform.has(name) || platform.has(wildcard) || platform.has('*.'+name)) { suffix=labels.length-i; shared=true; break; }
    if(icann.has(name) || icann.has(wildcard) || icann.has('*.'+name)) { suffix=labels.length-i; break; }
  }
  return {root:labels.length>suffix ? labels.slice(-suffix-1).join('.') : null,shared};
}
