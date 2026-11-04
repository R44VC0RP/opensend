import { useQuery } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, CopyButton, DataTable, StatusBadge, useToast } from '../../components/ui'
import { useApi, useWorkspaceAccess } from '../../data/context'
import type { DnsRecord, Domain } from '../../data/types'
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

const purposeOf = (record: DnsRecord) => record.purpose ?? (record.type === 'CNAME' ? 'dkim' : 'mail_from')
export const recordsFor = (domain: Domain, purpose: NonNullable<DnsRecord['purpose']>) => domain.records.filter(record => purposeOf(record) === purpose)
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

function RecordGroup({ title, description, domain, records }: { title: string; description: string; domain: string; records: DnsRecord[] }) {
  return <div className="stack settings-discovery-section">
    <div className="ui-section-header"><div className="domain-group-title"><h3>{title}</h3><p className="muted">{description}</p></div><StatusBadge status={allVerified(records) ? 'Verified' : 'Pending'} /></div>
    <DnsRecordTable domain={domain} records={records} />
  </div>
}

// DKIM and ownership records. MAIL FROM is optional and lives in the domain's Advanced section.
export function DomainRecords({ domain, actions }: { domain: Domain; actions?: ReactNode }) {
  const toast = useToast()
  const dkim = recordsFor(domain, 'dkim'), ownership = recordsFor(domain, 'ownership')
  const all = [...dkim, ...ownership]
  async function copyAll() {
    try { await navigator.clipboard.writeText(`${zoneLines(all)}\n`); toast(`Copied ${all.length} records`, 'success') }
    catch { toast('Could not copy to clipboard.', 'error') }
  }
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>DNS records</h2><p className="muted">Add these at your DNS provider. They usually verify within minutes; you can leave this page and OpenSend keeps checking.</p></div>
      <div className="cluster">{actions}{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}</div>
    </div>
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {dkim.length > 0 && <RecordGroup title="DKIM" description={`Signs mail sent from ${domain.name}.`} domain={domain.name} records={dkim} />}
    {ownership.length > 0 && <RecordGroup title="Ownership" description="Proves this domain belongs to your workspace." domain={domain.name} records={ownership} />}
  </section>
}
