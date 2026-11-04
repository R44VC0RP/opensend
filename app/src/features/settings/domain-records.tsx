import { useQuery } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, CopyButton, DataTable, StatusBadge, useToast } from '../../components/ui'
import { useApi, useWorkspaceAccess } from '../../data/context'
import type { DnsRecord, DnsRecordPurpose, Domain } from '../../data/types'
import { settingsColumns } from './skeletons'
import './settings.css'

// Hosted reads are DB-only, so poll briskly while visible; self-hosted reads call SES and stay slow.
export function useDomain(id: string) {
  const api = useApi()
  const { multiTenant } = useWorkspaceAccess()
  return useQuery({
    queryKey: ['opensend', api.mode, api.environment, 'domain', id],
    queryFn: ({ signal }) => api.domains.get(id, signal),
    refetchInterval: query => query.state.status === 'error' ? false : query.state.data?.status === 'pending' || query.state.data?.mailFromStatus === 'pending' ? multiTenant ? 3000 : 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: multiTenant ? 'always' : false,
  })
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

// Sending and receiving records. MAIL FROM is optional and lives in the domain's Advanced section.
export function DomainRecords({ domain, actions }: { domain: Domain; actions?: ReactNode }) {
  const toast = useToast()
  const sending = recordsFor(domain, 'sending'), receiving = recordsFor(domain, 'receiving')
  const all = [...sending, ...receiving]
  const notes = [...new Set(receiving.flatMap(record => record.note ? [record.note] : []))]
  async function copyAll() {
    try { await navigator.clipboard.writeText(`${zoneLines(all)}\n`); toast(`Copied ${all.length} records`, 'success') }
    catch { toast('Could not copy to clipboard.', 'error') }
  }
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>DNS records</h2><p className="muted">Add these at your DNS provider. They usually verify within minutes; you can leave this page and OpenSend keeps checking.</p></div>
      <div className="cluster">{actions}{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}</div>
    </div>
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {sending.length > 0 && <RecordGroup title="Sending" description={`Signs mail sent from ${domain.name} and proves the domain is yours.`} verified={(domain.sending ?? (domain.status === 'verified' ? 'verified' : 'pending')) === 'verified'} domain={domain.name} records={sending} />}
    {receiving.length > 0 && <RecordGroup title="Receiving" description="Optional — add to receive mail on this domain." notes={notes} verified={(domain.receiving ?? (allVerified(receiving) ? 'verified' : 'pending')) === 'verified'} domain={domain.name} records={receiving} />}
  </section>
}
