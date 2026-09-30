import type { MxReport } from './db/mailbox.js';

// Known inbound mail hosts. Used only to name what currently receives a domain's mail.
const PROVIDERS: [RegExp, string][] = [
  [/(?:^|\.)(?:aspmx\.l\.google\.com|googlemail\.com|google\.com|smtp\.google\.com)$/, 'Google Workspace'],
  [/\.mail\.protection\.outlook\.com$/, 'Microsoft 365'],
  [/(?:^|\.)zoho(?:mail)?\.(?:com|eu|in|com\.au|jp|com\.cn)$/, 'Zoho Mail'],
  [/(?:^|\.)(?:protonmail\.ch|proton\.me)$/, 'Proton Mail'],
  [/(?:^|\.)messagingengine\.com$/, 'Fastmail'],
  [/(?:^|\.)mail\.icloud\.com$/, 'iCloud Mail'],
  [/(?:^|\.)mx\.cloudflare\.net$/, 'Cloudflare Email Routing'],
  [/(?:^|\.)mailgun\.org$/, 'Mailgun'],
  [/(?:^|\.)sendgrid\.net$/, 'SendGrid'],
  [/(?:^|\.)postmarkapp\.com$/, 'Postmark'],
  [/(?:^|\.)improvmx\.com$/, 'ImprovMX'],
  [/(?:^|\.)forwardemail\.net$/, 'Forward Email'],
  [/(?:^|\.)secureserver\.net$/, 'GoDaddy'],
  [/(?:^|\.)(?:privateemail\.com|registrar-servers\.com)$/, 'Namecheap'],
  [/(?:^|\.)mimecast\.com$/, 'Mimecast'],
  [/(?:^|\.)(?:pphosted\.com|ppe-hosted\.com)$/, 'Proofpoint'],
  [/(?:^|\.)barracudanetworks\.com$/, 'Barracuda'],
  [/(?:^|\.)yahoodns\.net$/, 'Yahoo'],
  [/(?:^|\.)migadu\.com$/, 'Migadu'],
  [/(?:^|\.)mxrouting\.net$/, 'MXroute'],
  [/^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/, 'Amazon SES'],
];

export const inboundHost = (region: string) => `inbound-smtp.${region}.amazonaws.com`;
export const expectedMx = (domain: string, region: string): MxReport['expected'] => ({ type: 'MX', name: domain, value: inboundHost(region), priority: 10 });
const provider = (host: string) => PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? null;

type DohAnswer = { name: string; type: number; data: string };
async function resolve(name: string, type: 'MX' | 'CNAME'): Promise<{ status: number; answers: DohAnswer[] }> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`DNS_HTTP_${response.status}`); }
  const body = await response.json() as { Status?: number; Answer?: DohAnswer[] };
  return { status: body.Status ?? -1, answers: body.Answer ?? [] };
}

/** Reads public MX/CNAME records over DNS-over-HTTPS and classifies who receives the domain's mail. Read-only. */
export async function checkMx(domain: string, region: string): Promise<MxReport> {
  const expected = expectedMx(domain, region);
  const base = { expected, checkedAt: new Date().toISOString() };
  let mx: { status: number; answers: DohAnswer[] };
  try { mx = await resolve(domain, 'MX'); }
  catch { return { ...base, state: 'error', records: [], providers: [], message: 'DNS lookup failed. Retry the check.' }; }
  if (mx.status !== 0 && mx.status !== 3) return { ...base, state: 'error', records: [], providers: [], message: `DNS lookup returned status ${mx.status}. Retry the check.` };
  // DoH follows a CNAME at the name and reports it in the answer; an MX cannot coexist with it.
  if (mx.answers.some(answer => answer.type === 5)) return { ...base, state: 'cname', records: [], providers: [], message: `${domain} is a CNAME, so it cannot also have an MX record. Use a different subdomain for inbound mail.` };
  const records = mx.answers.filter(answer => answer.type === 15).map(answer => {
    const [priority, host = ''] = answer.data.trim().split(/\s+/);
    const name = host.replace(/\.$/, '').toLowerCase();
    return { priority: Number(priority) || 0, host: name, provider: provider(name) };
  }).sort((a, b) => a.priority - b.priority);
  const providers = [...new Set(records.map(record => record.provider ?? record.host))];
  if (!records.length) return { ...base, state: 'missing', records, providers, message: `No MX record yet. Add ${expected.value} (priority ${expected.priority}) to start receiving.` };
  if (records.length === 1 && !records[0]!.host) return { ...base, state: 'null_mx', records, providers, message: `${domain} publishes a null MX, which tells senders it accepts no mail. Replace it with ${expected.value}.` };
  const ours = records.filter(record => record.host === expected.value);
  if (ours.length === records.length) return { ...base, state: 'active', records, providers, message: 'MX points to Amazon SES in this region. Mail is being received.' };
  if (ours.length) return { ...base, state: 'mixed', records, providers, message: `MX also lists ${providers.filter(p => p !== 'Amazon SES').join(', ')}. Some mail may go there instead. Remove the other MX records.` };
  if (records.every(record => /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(record.host))) return { ...base, state: 'wrong_region', records, providers, message: `MX points to Amazon SES in another region. Change it to ${expected.value}.` };
  return { ...base, state: 'conflict', records, providers, message: `${providers.join(', ')} currently receives mail for ${domain}. Changing the MX record moves all of its mail to OpenSend; use a subdomain to keep the existing mailboxes.` };
}

export const mxBlocksEnable = (report: MxReport) => ['conflict', 'mixed', 'wrong_region', 'null_mx', 'cname'].includes(report.state);
