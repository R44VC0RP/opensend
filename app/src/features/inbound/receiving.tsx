import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert, Button, CopyButton, DataTable, Dialog, EmptyState, ErrorState, PageHeader, SectionHeader, SkeletonText, StatusBadge } from '../../components/ui'
import { useApiDef, useApiMutation, useWorkspaceAccess } from '../../data/context'
import { useRouteIntent } from '../../data/prefetch'
import { queries } from '../../data/queries'
import type { InboundAddress, MailboxDomain, MailboxDomainStatus } from '../../data/types'
import { number } from '../../lib/format'
import { MutationError } from '../settings/shared'
import { AddressesSection } from './addresses'
import { catchAllLabel, mxTone, receivingStatus } from './status'
import '../settings/settings.css'
import './inbound.css'

// Receiving domains first, then the ones still being set up; domains that only send are left out.
const order: Record<MailboxDomainStatus, number> = { active: 0, failed: 1, provisioning: 2, disabling: 3, waiting_for_mx: 4, off: 5, disabled: 5 }
const settingUp = (domain: MailboxDomain) => !['off', 'disabled'].includes(domain.status)
const plural = (count: number, word: string) => `${number(count)} ${word}${count === 1 ? '' : 's'}`

function DomainsSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const domains = useApiDef(queries.inboundDomains(), { interval: rows => rows?.some(domain => ['provisioning', 'disabling'].includes(domain.status)) ? 15_000 : false })
  const [showWaiting, setShowWaiting] = useState(false)
  const all = domains.data ?? []
  const receiving = all.filter(settingUp).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))
  const waiting = receiving.filter(domain => domain.status === 'waiting_for_mx').length
  // Domains still waiting for their MX record fold away once at least one other domain is set up.
  const folded = waiting > 0 && waiting < receiving.length
  const rows = folded && !showWaiting ? receiving.filter(domain => domain.status !== 'waiting_for_mx') : receiving
  const sendOnly = all.length - receiving.length
  return <section className="section stack" aria-labelledby="receiving-domains">
    <SectionHeader title={<span id="receiving-domains">Domains</span>} />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable loading={domains.isPending} skeletonRows={2} rows={rows} rowKey={domain => domain.id} onRowClick={domain => onOpen(domain.id)}
        empty={<EmptyState title="No domain receives mail yet" description={canAdminister ? 'Open a verified domain in Domains and choose Enable receiving.' : undefined} action={canAdminister ? <Link to="/domains">Open Domains</Link> : undefined} />}
        columns={[
          { key: 'name', label: 'Domain', width: '36%', render: domain => <div className="settings-cell-stack"><span>{domain.name}</span>{domain.subdomains?.enabled && <span className="muted receiving-clip">Subdomains too · {number(domain.subdomains.count)}</span>}</div> },
          { key: 'status', label: 'Status', width: '22%', render: domain => <StatusBadge status={receivingStatus[domain.status].label} tone={receivingStatus[domain.status].tone} /> },
          { key: 'catchAll', label: 'Unknown addresses', width: '26%', render: domain => catchAllLabel[domain.catchAll] },
          { key: 'addresses', label: 'Addresses', align: 'right', render: domain => number(domain.addressCount) },
        ]} />
      {domains.isPending ? <div className="receiving-foot"><SkeletonText width={240} /></div>
        : (folded || (canAdminister && sendOnly > 0)) && <div className="receiving-foot">
          {folded && <Button variant="ghost" size="sm" aria-expanded={showWaiting} onClick={() => setShowWaiting(!showWaiting)}>{showWaiting ? 'Hide' : 'Show'} {number(waiting)} waiting for MX</Button>}
          {canAdminister && sendOnly > 0 && <span className="muted">{sendOnly === 1 ? '1 domain only sends' : `${number(sendOnly)} domains only send`}. Turn on receiving in <Link to="/domains">Domains</Link>.</span>}
        </div>}
    </>}
  </section>
}

function DomainDialog({ domain: listed, onClose }: { domain: MailboxDomain; onClose: () => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const check = useApiMutation((api, id: string) => api.mailboxes.checkDomain(id), 'MX records checked')
  // Hosted checks report fresh DNS without saving it, so the dialog shows the check's own result over the cached list.
  const checked = check.data?.id === listed.id ? check.data : null
  const domain = checked ? { ...listed, status: checked.status, mx: checked.mx, lastError: checked.lastError, dns: checked.dns, subdomains: checked.subdomains ?? listed.subdomains } : listed
  const status = receivingStatus[domain.status]
  const live = domain.status === 'active' && domain.mx?.state === 'active'
  const records = [...domain.dns, ...(domain.subdomains?.enabled ? domain.subdomains.dns : [])]
  return <Dialog open onOpenChange={open => { if (!open) onClose() }} title={domain.name} footer={<>
    {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to={`/domains/${domain.id}`}>Domain settings</Link>}
    {canAdminister && !live && ['waiting_for_mx', 'active', 'failed'].includes(domain.status) && <Button variant="primary" loading={check.isPending} onClick={async () => { try { await check.mutateAsync(domain.id) } catch { /* Shown inline. */ } }}>Check MX</Button>}
  </>}>
    <div className="stack">
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><StatusBadge status={status.label} tone={status.tone} /></dd></div>
        <div><dt>Unknown addresses</dt><dd>{catchAllLabel[domain.catchAll]}</dd></div>
        <div><dt>Addresses</dt><dd>{number(domain.addressCount)}</dd></div>
        {domain.subdomains?.enabled && <div><dt>Subdomains</dt><dd>{plural(domain.subdomains.count, 'subdomain')}</dd></div>}
      </dl>
      <MutationError error={check.error} />
      {domain.lastError && <Alert tone="danger">{domain.lastError}</Alert>}
      {domain.mx && domain.status !== 'provisioning' && !live && <Alert tone={mxTone(domain.mx.state)}>{domain.mx.message}</Alert>}
      {records.length > 0 && <div className="stack receiving-records">
        <p className="receiving-records__title">{live ? 'MX records' : `Add ${records.length === 1 ? 'this MX record' : 'these MX records'} at your DNS provider`}</p>
        {records.map(record => <dl key={`${record.name} ${record.value}`} className="receiving-record">
          <dt>Host</dt><dd className="settings-copy-cell"><code>{record.name}</code><CopyButton value={record.name} label="Copy host" /></dd>
          <dt>Type</dt><dd>MX</dd>
          <dt>Priority</dt><dd>{record.priority}</dd>
          <dt>Value</dt><dd className="settings-copy-cell"><code>{record.value}</code><CopyButton value={record.value} label="Copy value" /></dd>
        </dl>)}
      </div>}
    </div>
  </Dialog>
}

type Route = { key: string; match: ReactNode; to: ReactNode; kind: string; open?: () => void }
function RoutesSection({ onOpenDomain }: { onOpenDomain: (id: string) => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const navigate = useNavigate()
  // Domains and webhooks are admin-only reads; rules and aliases come from the addresses every member can list.
  const domains = useApiDef(queries.inboundDomains(), { enabled: canAdminister })
  const addresses = useApiDef(queries.inboundAddressOptions())
  const webhooks = useApiDef(queries.inboundWebhooks(), { enabled: canAdminister })
  const loading = addresses.isPending || (canAdminister && ((domains.isPending && !domains.error) || (webhooks.isPending && !webhooks.error)))
  const partial = canAdminister ? domains.error ?? webhooks.error : null
  const byId = new Map((addresses.data ?? []).map(address => [address.id, address]))
  const target = (address: InboundAddress) => <Link to={`/receiving/addresses/${address.id}`}>{address.address}</Link>
  const rows: Route[] = [
    ...(addresses.data ?? []).flatMap(address => [
      ...address.rules.map(rule => ({ key: `rule:${address.id}:${rule}`, match: rule, to: target(address), kind: 'Wildcard rule', open: () => navigate(`/receiving/addresses/${address.id}`) })),
      ...address.aliases.map(alias => ({ key: `alias:${address.id}:${alias}`, match: alias, to: target(address), kind: 'Alias', open: () => navigate(`/receiving/addresses/${address.id}`) })),
    ]),
    // A catch-all only routes mail once the domain receives.
    ...(canAdminister ? domains.data ?? [] : []).filter(domain => domain.status === 'active').sort((a, b) => a.name.localeCompare(b.name)).map(domain => ({
      key: `catch-all:${domain.id}`, match: `*@${domain.name}`, kind: 'Catch-all', open: () => onOpenDomain(domain.id),
      to: domain.catchAll === 'create_address' ? 'A new address per recipient' : <span className="muted">Stored as unrouted</span>,
    })),
    ...(canAdminister ? webhooks.data ?? [] : []).map(webhook => ({
      key: `webhook:${webhook.id}`, kind: webhook.paused ? 'Webhook · paused' : 'Webhook', open: () => navigate(`/receiving/webhooks/${webhook.id}`),
      match: <div className="settings-cell-stack"><span className="receiving-clip">{webhook.addressIds ? webhook.addressIds.map(id => byId.get(id)?.address ?? id).join(', ') : 'Every address'}</span><span className="muted receiving-clip">{webhook.eventTypes.length === 1 ? webhook.eventTypes[0] : plural(webhook.eventTypes.length, 'event')}</span></div>,
      to: <div className="settings-cell-stack"><Link to={`/receiving/webhooks/${webhook.id}`}>{webhook.description || new URL(webhook.url).host}</Link>{webhook.description && <span className="muted receiving-clip">{new URL(webhook.url).host}</span>}</div>,
    })),
  ]
  return <section className="section stack" aria-labelledby="receiving-routes">
    <SectionHeader title={<span id="receiving-routes">Routes</span>} actions={canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/webhooks">Webhooks</Link>} />
    {addresses.error ? <ErrorState error={addresses.error} onRetry={() => void addresses.refetch()} /> : <>
      <DataTable loading={loading} skeletonRows={3} rows={rows} rowKey={row => row.key} onRowClick={row => row.open?.()}
        empty={<EmptyState title="No routes yet" description="Aliases, wildcard rules, catch-alls and webhooks show here." />}
        columns={[
          { key: 'match', label: 'Mail to', width: '40%', render: row => row.match },
          { key: 'to', label: 'Goes to', width: '40%', render: row => row.to },
          { key: 'kind', label: 'Type', render: row => <span className="muted">{row.kind}</span> },
        ]} />
      {!loading && partial && <Alert tone="warning">{domains.error ? 'Catch-alls' : 'Webhooks'} could not be loaded. <Button variant="ghost" size="sm" onClick={() => { if (domains.error) void domains.refetch(); if (webhooks.error) void webhooks.refetch() }}>Retry</Button></Alert>}
      {!loading && addresses.data?.nextCursor && <p className="muted receiving-foot">Rules and aliases of the first 100 addresses.</p>}
    </>}
  </section>
}

export function ReceivingPage() {
  const { canAdminister } = useWorkspaceAccess()
  const intent = useRouteIntent()
  const domains = useApiDef(queries.inboundDomains(), { enabled: canAdminister })
  const [openDomain, setOpenDomain] = useState<string | null>(null)
  const selected = domains.data?.find(domain => domain.id === openDomain)
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={<Link className="ui-button ui-button--primary ui-button--md" to="/receiving/inbox" {...intent('/receiving/inbox')}>Inbox</Link>} />
    <div className="receiving-sections">
      {canAdminister && <DomainsSection onOpen={setOpenDomain} />}
      <RoutesSection onOpenDomain={setOpenDomain} />
      <AddressesSection domains={domains.data} />
    </div>
    {selected && <DomainDialog key={selected.id} domain={selected} onClose={() => setOpenDomain(null)} />}
  </div>
}
