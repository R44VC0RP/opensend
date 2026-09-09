import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowUpRight, ChevronRight, Download, Search } from 'lucide-react'
import { useApiQuery, useRegion } from '../../data/context'
import type { Email } from '../../data/types'
import { Alert, Button, CopyButton, DataTable, EmptyState, ErrorState, Input, SkeletonText, PaginationSkeleton, PageHeader, Pagination, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { EmailPreview, htmlToText } from '../../components/EmailPreview'
import { date, label, number, time } from '../../lib/format'
import { downloadCsv } from '../../lib/download'
import { EmailDetailSkeleton, logColumns } from './skeletons'

export function LogsPage() {
  const { regionId } = useRegion()
  return <RegionalLogs key={regionId} regionId={regionId} />
}
function RegionalLogs({ regionId }: { regionId: string }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [stream, setStream] = useState('all')
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const params = { regionId, search, status: status === 'all' ? undefined : status, stream: stream === 'all' ? undefined : stream, page, pageSize: 10 }
  const query = useApiQuery(['emails', params], (api, signal) => api.emails.list(params, signal))
  return <><PageHeader title="Logs" actions={<span className="muted">{regionId}</span>} />
    <div className="data-toolbar"><div className="cluster"><div className="search-box"><Search size={16} /><Input type="search" aria-label="Search emails" placeholder="Search recipient, subject or ID" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
      <Select aria-label="Email status" value={status} onValueChange={value => { setStatus(value); setPage(1) }} options={['all', 'delivered', 'bounced', 'complaint', 'deferred', 'rejected'].map(value => ({ value, label: value === 'all' ? 'All statuses' : label(value) }))} />
      <Select aria-label="Email stream filter" value={stream} onValueChange={value => { setStream(value); setPage(1) }} options={[{ value: 'all', label: 'All streams' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} /></div>
      <Button disabled={!query.data?.items.length} onClick={() => downloadCsv('opensend-logs-page.csv', [['Status', 'Recipient', 'Subject', 'Stream', 'Sent at', 'Region'], ...(query.data?.items ?? []).map(email => [email.status, email.to, email.subject, email.stream, email.sentAt, email.regionId])])}><Download size={16} />Export page</Button>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <div className="table-summary"><span>{query.data ? `${number(query.data.total)} emails` : <SkeletonText width={100} />}</span><span>Times in UTC</span></div>
      <DataTable<Email> loading={query.isPending} skeletonRows={10} minRows={10} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/logs/${row.id}`)} columns={[
        { ...logColumns[0], render: row => <StatusBadge status={row.status} /> },
        { ...logColumns[1], render: row => row.to },
        { ...logColumns[2], render: row => row.subject },
        { ...logColumns[3], render: row => <span className="muted">{label(row.stream)}</span> },
        { ...logColumns[4], render: row => <span className="muted nowrap">{time(row.sentAt)}</span> },
        { ...logColumns[5], render: () => <ChevronRight size={16} aria-hidden /> },
      ]} empty={<EmptyState title="No emails found" description="Try another search, status, or region." action={<Button onClick={() => { setSearch(''); setStatus('all'); setStream('all'); setPage(1) }}>Clear filters</Button>} />} />
      {query.data ? <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={setPage} /> : <PaginationSkeleton />}
    </>}
  </>
}
export function EmailDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['email', id], (api, signal) => api.emails.get(id, signal))
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Email detail" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return query.data ? <EmailDetail email={query.data} /> : null
}
function EmailDetail({ email }: { email: Email }) {
  const navigate = useNavigate()
  const [view, setView] = useState('preview')
  const contacts = useApiQuery(['contact-for-email', email.to], (api, signal) => api.contacts.list({ search: email.to, pageSize: 10 }, signal))
  const contact = contacts.data?.items.find(item => item.email.toLowerCase() === email.to.toLowerCase())
  return <><PageHeader title={email.subject} backTo="/logs" actions={contact ? <Button onClick={() => navigate(`/contacts/${contact.id}`)}>View contact<ArrowUpRight size={16} /></Button> : <StatusBadge status={email.status} />} />
    <dl className="email-metadata"><div><dt>To</dt><dd>{email.to}</dd></div><div><dt>From</dt><dd>{email.from}</dd></div><div><dt>Stream</dt><dd>{label(email.stream)}</dd></div></dl>
    {email.status === 'bounced' && <Alert tone="warning">Delivery failed. Review the delivery diagnostics below.{contact?.status === 'suppressed' && ' This address is suppressed.'}</Alert>}
    {email.status === 'complaint' && <Alert tone="danger">The recipient reported this message as spam.{contact?.status === 'suppressed' && ' This address is suppressed.'}</Alert>}
    {email.status === 'deferred' && <Alert tone="warning">Delivery is delayed. SES will retry according to its delivery policy.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'html', label: 'HTML' }, { value: 'plain', label: 'Plain text' }]} />
      {view === 'preview' ? <EmailPreview html={email.html} title="Email message preview" /> : <pre className="message-source">{view === 'html' ? email.html : htmlToText(email.html)}</pre>}
    </section><section className="delivery-timeline"><SectionHeader title="Delivery timeline" actions={<span className="muted">UTC</span>} /><ol>{email.events.map(event => <li key={event.id}><span className={`timeline-dot ${['bounced', 'complaint'].includes(event.type) ? 'timeline-dot--warning' : ''}`} /><div><div className="cluster between"><span>{label(event.type)}</span><time className="muted">{time(event.at)}</time></div><p className="muted">{event.description}</p>{event.diagnostic && <pre className="diagnostic">{event.diagnostic}</pre>}</div></li>)}</ol></section></div>
    <div className="message-identifiers"><span className="cluster">Email ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy email ID" /></span><span>{date(email.sentAt)} · {time(email.sentAt)} UTC</span><span>SES · {email.regionId}</span></div>
  </>
}
