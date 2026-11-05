import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, CopyButton, DataTable, StatusBadge, useToast } from '../../components/ui'
import { CopyAction, LiveStatus, type LiveState } from '../../components/motion'
import { useApi, useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import type { DnsRecord, DnsRecordPurpose, Domain } from '../../data/types'
import { settingsColumns } from './skeletons'
import './settings.css'
import './domain-records.css'

// Hosted reads are DB-only, so poll briskly while visible; self-hosted reads call SES and stay slow.
export function useDomain(id: string) {
  const api = useApi()
  const { multiTenant } = useWorkspaceAccess()
  return useQuery({
    queryKey: ['opensend', api.mode, 'domain', id],
    queryFn: ({ signal }) => api.domains.get(id, signal),
    refetchInterval: query => query.state.status === 'error' ? false : query.state.data?.status === 'pending' || query.state.data?.mailFromStatus === 'pending' ? multiTenant ? 3000 : 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: multiTenant ? 'always' : false,
  })
}

export type DnsSetup = { provider: { id: string; name: string } | null; applyUrl: string | null; groups: string[] }
// Domain Connect: the provider's one-click consent URL, when the domain's DNS host supports it.
// Fetched once per page. Callers hold the records back while it is pending (the API bounds discovery
// to about three seconds), and the answer is fixed at reveal, so the button never appears above
// records that are already on screen.
export function useDnsSetup(domain: Domain | undefined) {
  const api = useApi()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const needed = !!domain && domain.records.some(record => record.status !== 'verified')
  const enabled = api.mode !== 'demo' && multiTenant && canAdminister && needed
  const query = useQuery({
    queryKey: ['opensend', api.mode, 'domain', domain?.id, 'dns-setup'],
    queryFn: ({ signal }) => request<DnsSetup>(`/v1/domains/${encodeURIComponent(domain!.id)}/dns-setup`, { signal }),
    // gcTime 0: each page asks afresh, since pending groups change between onboarding and the domain page.
    enabled, retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false,
  })
  const id = domain?.id
  const [timedOut, setTimedOut] = useState<string>()
  useEffect(() => { if (!enabled || !id) return; const timer = setTimeout(() => setTimedOut(id), 4000); return () => clearTimeout(timer) }, [enabled, id])
  const pending = !!domain && enabled && query.isPending && timedOut !== id
  // Decided once per domain, so moving between domains never reuses another domain's link.
  const decided = useRef<{ id: string; setup: DnsSetup | null }>(undefined)
  if (domain && !pending && decided.current?.id !== domain.id) decided.current = { id: domain.id, setup: query.data?.applyUrl && query.data.provider ? query.data : null }
  const current = decided.current
  return { pending: !domain || pending, setup: current && current.id === id ? current.setup : null }
}

// Navigates this tab: providers refuse to be framed, and they return to /domains/<id> when done.
function DnsConnect({ setup, open }: { setup: DnsSetup; open: boolean }) {
  return <div className="dns-connect" data-hidden={!open || undefined} inert={!open}>
    <a className="ui-button ui-button--primary ui-button--md" href={setup.applyUrl!} rel="noopener">Configure DNS with {setup.provider!.name}<ArrowRight size={16} aria-hidden /></a>
    <p className="muted">Or add the records below yourself.</p>
  </div>
}

// Records saved before purposes split into sending and receiving may still say dkim or ownership.
const purposeOf = (record: DnsRecord): DnsRecordPurpose => {
  const purpose = record.purpose as string | undefined
  return purpose === 'dkim' || purpose === 'ownership' ? 'sending' : record.purpose ?? (record.type === 'CNAME' ? 'sending' : 'mail_from')
}
export const recordsFor = (domain: Domain, purpose: DnsRecordPurpose) => domain.records.filter(record => purposeOf(record) === purpose)
export function domainState(domain: Domain) {
  return domain.status === 'verified' ? { status: 'Verified', tone: 'success' as const } : domain.status === 'issue' ? { status: 'Failed', tone: 'danger' as const } : { status: 'Pending', tone: 'warning' as const }
}
const allVerified = (records: DnsRecord[]) => records.length > 0 && records.every(record => record.status === 'verified')
// Shown relative to the zone, as most DNS providers ask for it; copying gives the full name.
const relativeHost = (name: string, domain: string) => name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : name
const fqdn = (name: string) => name.endsWith('.') ? name : `${name}.`
export function zoneLines(records: DnsRecord[]) {
  return records.map(record => {
    const value = record.type === 'TXT' ? `"${record.value.replace(/"/g, '\\"')}"`
      : record.type === 'MX' ? record.value.replace(/(\S+)$/, target => fqdn(target))
      : fqdn(record.value)
    return `${fqdn(record.name)}\t3600\tIN\t${record.type}\t${value}`
  }).join('\n')
}

export function DnsRecordTable({ domain, records }: { domain: string; records: DnsRecord[] }) {
  return <DataTable className="domain-records" rows={records} rowKey={record => record.id} columns={[
    { ...settingsColumns.dns[0], render: record => record.type },
    { ...settingsColumns.dns[1], width: '44%', render: record => <div className="settings-copy-cell"><code title={record.name}>{relativeHost(record.name, domain)}</code><CopyButton value={record.name} label={`Copy full ${record.type} name`} /></div> },
    { ...settingsColumns.dns[2], render: record => <div className="settings-copy-cell"><code title={record.value}>{record.value}</code><CopyButton value={record.value} label={`Copy ${record.type} value`} /></div> },
    { key: 'status', label: 'Status', width: 112, render: record => <StatusBadge status={record.status === 'verified' ? 'Verified' : 'Pending'} /> },
  ]} />
}

function RecordGroup({ title, description, notes = [], verified, domain, records }: { title: string; description: string; notes?: string[]; verified: boolean; domain: string; records: DnsRecord[] }) {
  return <div className="stack settings-discovery-section">
    <div className="ui-section-header"><div className="domain-group-title"><h3>{title}</h3><p className="muted">{description}</p>{notes.map(note => <p key={note}>{note}</p>)}</div><StatusBadge status={verified ? 'Verified' : 'Pending'} /></div>
    <DnsRecordTable domain={domain} records={records} />
  </div>
}

const liveState = (verified: boolean): LiveState => verified ? 'verified' : 'pending'

// Long hostnames wrap at their dots rather than mid-label.
const breakable = (text: string) => text.split('.').flatMap((part, index) => index === 0 ? [part] : [<wbr key={index} />, `.${part}`])

function CopyText({ label, display, value, copyLabel }: { label: string; display: string; value: string; copyLabel: string }) {
  return <div className="dns-cell">
    <span className="dns-label">{label}</span>
    <span className="dns-text"><code title={value}>{breakable(display)}</code><CopyAction value={value} label={copyLabel} variant="ghost" size="sm" compact className="dns-copy" /></span>
  </div>
}

// Guided layout (onboarding): a heading with one quiet status per group, then plain hairline rows.
function RecordRows({ title, optional = false, description, notes = [], verified, domain, records }: { title: string; optional?: boolean; description: string; notes?: string[]; verified: boolean; domain: string; records: DnsRecord[] }) {
  return <div className="dns-group" data-state={liveState(verified)}>
    <div className="dns-group-head">
      <h3>{title}{optional && <span className="muted"> · optional</span>}</h3>
      <LiveStatus state={liveState(verified)} plain />
    </div>
    <p className="dns-group-copy muted">{description}</p>
    {notes.map(note => <p key={note} className="dns-group-copy muted">{note}</p>)}
    <div className="dns-columns" aria-hidden="true"><span>Type</span><span>Name</span><span>Value</span><span /></div>
    <ul className="dns-rows">{records.map((record, index) => <li key={record.id} className="dns-row" style={{ '--i': index } as CSSProperties}>
      <div className="dns-cell dns-type"><span className="dns-label">Type</span><code>{record.type}</code></div>
      <CopyText label="Name" display={relativeHost(record.name, domain)} value={record.name} copyLabel={`Copy full ${record.type} name`} />
      <CopyText label="Value" display={record.value} value={record.value} copyLabel={`Copy ${record.type} value`} />
      <div className="dns-cell dns-status"><span className="dns-label">Status</span><LiveStatus state={liveState(record.status === 'verified')} plain /></div>
    </li>)}</ul>
  </div>
}

// Sending and receiving records. MAIL FROM is optional and lives in the domain's Advanced section.
export function DomainRecords({ domain, actions, guided = false, setup = null }: { domain: Domain; actions?: ReactNode; guided?: boolean; setup?: DnsSetup | null }) {
  const toast = useToast()
  const sending = recordsFor(domain, 'sending'), receiving = recordsFor(domain, 'receiving')
  const all = [...sending, ...receiving]
  const notes = [...new Set(receiving.flatMap(record => record.note ? [record.note] : []))]
  async function copyAll() {
    try { await navigator.clipboard.writeText(`${zoneLines(all)}\n`); toast(`Copied ${all.length} records`, 'success') }
    catch { toast('Could not copy to clipboard.', 'error') }
  }
  const sendingVerified = (domain.sending ?? (domain.status === 'verified' ? 'verified' : 'pending')) === 'verified'
  const receivingVerified = (domain.receiving ?? (allVerified(receiving) ? 'verified' : 'pending')) === 'verified'
  // Stays in place (invisible) once every record verifies, so nothing below moves.
  const connect = setup && <DnsConnect setup={setup} open={domain.records.some(record => record.status !== 'verified')} />
  if (guided) return <section className="dns-guided" aria-label="DNS records">
    {connect}
    <div className="dns-guided-bar"><h2>DNS records</h2>{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}</div>
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {sending.length > 0 && <RecordRows title="Sending" description={`Signs your mail and proves ${domain.name} is yours.`} verified={sendingVerified} domain={domain.name} records={sending} />}
    {receiving.length > 0 && <RecordRows title="Receiving" optional description={`Add this to receive mail at ${domain.name}.`} notes={notes} verified={receivingVerified} domain={domain.name} records={receiving} />}
  </section>
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>DNS records</h2><p className="muted">Add these at your DNS provider. They usually verify within minutes; you can leave this page and OpenSend keeps checking.</p></div>
      <div className="cluster">{actions}{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}</div>
    </div>
    {connect}
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {sending.length > 0 && <RecordGroup title="Sending" description={`Signs mail sent from ${domain.name} and proves the domain is yours.`} verified={sendingVerified} domain={domain.name} records={sending} />}
    {receiving.length > 0 && <RecordGroup title="Receiving" description="Optional — add to receive mail on this domain." notes={notes} verified={receivingVerified} domain={domain.name} records={receiving} />}
  </section>
}
