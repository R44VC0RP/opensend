import { Link, useNavigate } from 'react-router'
import { useState } from 'react'
import { Alert, DataTable, EmptyState, ErrorState, Input, PageHeader, Pagination, PaginationSkeleton, SkeletonText, StatusBadge } from '../../components/ui'
import { useApi, useApiQuery } from '../../data/context'
import { date, number } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import type { MailboxDomain } from '../../data/types'
import { receivingStatus } from './status'
import '../settings/settings.css'
import './mailboxes.css'


function ReceivingDomains({ domains }: { domains: MailboxDomain[] }) {
  const receiving = domains.filter(domain => !['off', 'disabled'].includes(domain.status))
  if (!receiving.length) return <Alert tone="info">No domain receives mail yet. Open a verified domain in <Link to="/domains">Domains</Link> and choose Enable mailboxes.</Alert>
  return <ul className="mailbox-domains" aria-label="Receiving domains">{receiving.map(domain => <li key={domain.id}>
    <Link to={`/domains/${domain.id}`}>{domain.name}</Link>
    <StatusBadge status={receivingStatus[domain.status].label} tone={receivingStatus[domain.status].tone} />
  </li>)}</ul>
}

function LiveMailboxesPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const mailboxes = useApiQuery(['mailboxes', search, cursor], (api, signal) => api.mailboxes.list({ search: search.trim() || undefined, cursor }, signal))
  const domains = useApiQuery(['mailbox-domains'], (api, signal) => api.mailboxes.domains(signal))
  return <div className="stack">
    <PageHeader title="Mailboxes" />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : domains.isPending ? <SkeletonText width={260} /> : <ReceivingDomains domains={domains.data} />}
    <div className="data-toolbar"><Input className="audience-search" aria-label="Search mailboxes" placeholder="Search address or name" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} /></div>
    {mailboxes.error ? <ErrorState error={mailboxes.error} onRetry={() => void mailboxes.refetch()} /> : <>
      <DataTable loading={mailboxes.isPending} skeletonRows={5} minRows={3} rows={mailboxes.data ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/mailboxes/${row.id}`)}
        empty={<EmptyState title={search ? 'No matching mailboxes' : 'No mailboxes yet'} description={search ? undefined : 'Create mailboxes with the mailbox API, or let the domain catch-all create them when mail arrives.'} />}
        columns={[
          { key: 'address', label: 'Mailbox', width: '34%', render: row => <div className="settings-cell-stack"><span className="mailbox-address"><Link to={`/mailboxes/${row.id}`}>{row.address}</Link>{row.origin === 'auto' && <StatusBadge status="Auto" tone="neutral" />}</span>{(row.displayName || row.aliases.length > 0) && <span className="muted">{[row.displayName, row.aliases.length ? `+${row.aliases.length} alias${row.aliases.length === 1 ? '' : 'es'}` : null].filter(Boolean).join(' · ')}</span>}</div> },
          { key: 'domain', label: 'Domain', width: '20%', render: row => row.domain },
          { key: 'threads', label: 'Threads', align: 'right', width: '12%', render: row => number(row.stats.threads) },
          { key: 'unread', label: 'Unread', align: 'right', width: '12%', render: row => row.stats.unreadThreads ? <strong>{number(row.stats.unreadThreads)}</strong> : <span className="muted">0</span> },
          { key: 'last', label: 'Last message', align: 'right', render: row => row.stats.lastMessageAt ? date(row.stats.lastMessageAt) : <span className="muted">None yet</span> },
        ]} />
      {mailboxes.isPending ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={50} nextCursor={mailboxes.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, mailboxes.data?.nextCursor)} />}
    </>}
  </div>
}

export { MailboxDetailPage } from './detail'

export function MailboxesPage() {
  return useApi().environment === 'test' ? <><PageHeader title="Mailboxes" /><Alert tone="info">Mailboxes receive real mail, so they are managed in live mode only.</Alert></> : <LiveMailboxesPage />
}
