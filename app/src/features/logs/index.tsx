import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowUpRight, ChevronRight, Download, Paperclip, Search, X } from 'lucide-react'
import { useApiDef, useApiQuery, useRegion, useApi, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Email, ReceivedEmail, ReceivedEmailDetail } from '../../data/types'
import { Alert, Button, CopyButton, DataTable, EmptyState, ErrorState, Input, PaginationSkeleton, PageHeader, Pagination, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { EmailPreview, htmlToText } from '../../components/EmailPreview'
import { date, label, time } from '../../lib/format'
import { downloadCsv } from '../../lib/download'
import { EmailDetailSkeleton, logColumns } from './skeletons'
import { useAdaptivePageSize, useCursorPagination } from '../../lib/pagination'

function RecipientEmail({ email }: { email: string }) {
  return <span className="log-recipient"><span aria-hidden="true">{email.slice(0, 2)}</span><span className="log-recipient__private" aria-hidden="true">{email.slice(2)}</span><span className="sr-only">{email}</span></span>
}

function logTimestamp(value: string) {
  return date(value, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
}

export function LogsPage() {
  const { regionId } = useRegion()
  const [params] = useSearchParams()
  const campaignId = params.get('campaign') || undefined
  return params.get('view') === 'received' ? <ReceivedLogs key={regionId} regionId={regionId} /> : <RegionalLogs key={`${regionId}:${campaignId ?? ''}`} regionId={regionId} campaignId={campaignId} />
}
function LogsHeader({ regionId, view }: { regionId: string; view: 'sent' | 'received' }) {
  const [params, setParams] = useSearchParams()
  const selected = useRegion().regionId
  const { canAdminister } = useWorkspaceAccess()
  // The sidebar's region selector already names the region; repeat it only when it is hidden or a campaign filter shows another region.
  return <><PageHeader title="Logs" actions={!canAdminister || regionId !== selected ? <span className="muted">{regionId}</span> : undefined} />
    <Tabs label="Log type" value={view} onValueChange={value => { const next = new URLSearchParams(params); if (value === 'received') next.set('view', 'received'); else next.delete('view'); setParams(next) }} items={[{ value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]} /></>
}
function RegionalLogs({ regionId, campaignId }: { regionId: string; campaignId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  // A campaign sends from one region, so its filter replaces the region selector.
  const campaign = useApiQuery(['campaign', campaignId ?? null], (api, signal) => campaignId ? api.campaigns.get(campaignId, signal) : Promise.resolve(null))
  const clearCampaign = () => { const next = new URLSearchParams(searchParams); next.delete('campaign'); setSearchParams(next) }
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [stream, setStream] = useState('all')
  const [page, setPage] = useState(1)
  const {pageSize, tableRef, measured} = useAdaptivePageSize(5, 100, 'logs')
  useEffect(() => setPage(1), [pageSize])
  const navigate = useNavigate()
  const params = { ...(campaignId ? { campaignId } : { regionId }), search, status: status === 'all' ? undefined : status, stream: stream === 'all' ? undefined : stream, page, pageSize }
  const query = useApiDef(queries.emails(params), { interval: 30_000, enabled: measured, keepPrevious: true })
  return <div className="logs-page"><LogsHeader regionId={campaign.data?.regionId ?? regionId} view="sent" />
    <div className="data-toolbar"><div className="cluster">{campaignId && <Button variant="secondary" aria-label={`Remove campaign filter: ${campaign.data?.name ?? campaignId}`} onClick={clearCampaign}>Campaign: {campaign.data?.name ?? campaignId}<X size={14} aria-hidden /></Button>}<div className="search-box"><Search size={16} /><Input type="search" aria-label="Search email logs" placeholder="Search logs" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
      <Select aria-label="Email status" value={status} onValueChange={value => { setStatus(value); setPage(1) }} options={['all', 'queued', 'attempting', 'accepted', 'sent', 'delivered', 'bounced', 'complained', 'rejected', 'rendering_failed', 'delayed', 'suppressed', 'canceled', 'acceptance_unknown', 'simulated'].map(value => ({ value, label: value === 'all' ? 'All statuses' : label(value) }))} />
      <Select aria-label="Email stream filter" value={stream} onValueChange={value => { setStream(value); setPage(1) }} options={[{ value: 'all', label: 'All streams' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} /></div>
      <Button disabled={!query.data?.items.length} onClick={() => downloadCsv(campaignId ? `opensend-${campaignId}-logs-page.csv` : 'opensend-logs-page.csv', [['Status', 'Recipient', 'Subject', 'Stream', 'Created at', 'Region'], ...(query.data?.items ?? []).map(email => [email.status, email.to, email.subject, email.stream, email.sentAt, email.regionId])])}><Download size={16} />Export page</Button>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable<Email> className="logs-table" tableRef={tableRef} loading={query.isPending} skeletonRows={pageSize} minRows={pageSize} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/logs/${row.id}`)} columns={[
        { ...logColumns[0], render: row => <span className="muted" title={row.sentAt}>{logTimestamp(row.sentAt)}</span> },
        { ...logColumns[1], render: row => <StatusBadge status={row.status} /> },
        { ...logColumns[2], render: row => <RecipientEmail email={row.to} /> },
        { ...logColumns[3], render: row => <span title={row.from}>{row.from}</span> },
        { ...logColumns[4], render: row => <span title={row.subject}>{row.subject}</span> },
        { ...logColumns[5], render: row => <span className="muted">{label(row.stream)}</span> },
        { ...logColumns[6], render: () => <ChevronRight size={14} aria-hidden /> },
      ]} empty={<EmptyState title="No emails found" action={<Button onClick={() => { setSearch(''); setStatus('all'); setStream('all'); setPage(1); if (campaignId) clearCampaign() }}>Clear filters</Button>} />} />
      {query.data ? <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} /> : <PaginationSkeleton />}
    </>}
  </div>
}
const receivedColumns = [{ key: 'time', label: 'Received · UTC', width: 150 }, { key: 'status', label: 'Status', width: 112 }, { key: 'from', label: 'Sender', width: '20%' }, { key: 'to', label: 'Recipient', width: '18%' }, { key: 'mailbox', label: 'Address', width: '18%' }, { key: 'subject', label: 'Subject' }, { key: 'open', label: '', width: 28 }]
const mailboxLabel = (row: ReceivedEmail) => row.addresses.map(mailbox => mailbox.address).join(', ') || 'Unrouted'
function ReceivedLogs({ regionId }: { regionId: string }) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const pagination = useCursorPagination()
  const { pageSize, tableRef, measured } = useAdaptivePageSize(5, 100)
  const cursor = pagination.cursor
  const query = useApiQuery(['received', regionId, search, cursor, pageSize], (api, signal) => api.mailboxes.received({ regionId, search: search.trim() || undefined, cursor, pageSize }, signal), { interval: 30_000, enabled: measured })
  return <div className="logs-page"><LogsHeader regionId={regionId} view="received" />
    <div className="data-toolbar"><div className="cluster"><div className="search-box"><Search size={16} /><Input type="search" aria-label="Search received email" placeholder="Search received mail" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} /></div></div>
      <Button disabled={!query.data?.length} onClick={() => downloadCsv('opensend-received-page.csv', [['Received at', 'From', 'To', 'Address', 'Subject', 'Spam', 'Region'], ...(query.data ?? []).map(row => [row.receivedAt, row.from.address, row.envelopeTo.join(' '), mailboxLabel(row), row.subject, row.spam ? 'yes' : 'no', row.region ?? ''])])}><Download size={16} />Export page</Button>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable<ReceivedEmail> className="logs-table" tableRef={tableRef} loading={query.isPending} skeletonRows={pageSize} minRows={pageSize} rows={query.data ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/logs/received/${row.id}`)} columns={[
        { ...receivedColumns[0]!, render: row => <span className="muted" title={row.receivedAt}>{logTimestamp(row.receivedAt)}</span> },
        { ...receivedColumns[1]!, render: row => row.spam ? <StatusBadge status="Spam" tone="danger" /> : <StatusBadge status="Received" tone="success" /> },
        { ...receivedColumns[2]!, render: row => <span title={row.from.name ? `${row.from.name} <${row.from.address}>` : row.from.address}>{row.from.address}</span> },
        { ...receivedColumns[3]!, render: row => <RecipientEmail email={row.envelopeTo[0] ?? row.to[0]?.address ?? ''} /> },
        { ...receivedColumns[4]!, render: row => row.addresses.length ? <span title={mailboxLabel(row)}>{mailboxLabel(row)}</span> : <span className="muted">Unrouted</span> },
        { ...receivedColumns[5]!, render: row => <span className="received-subject" title={row.subject}>{row.attachmentCount > 0 && <Paperclip size={12} aria-label={`${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`} />}{row.subject || <span className="muted">(no subject)</span>}</span> },
        { ...receivedColumns[6]!, render: () => <ChevronRight size={14} aria-hidden /> },
      ]} empty={<EmptyState title={search ? 'No received mail matches' : 'No received mail yet'} description={search ? undefined : 'Enable receiving on a domain to start.'} action={search ? <Button onClick={() => { setSearch(''); pagination.reset() }}>Clear search</Button> : <Link to="/inbound">Open Inbound</Link>} />} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={pageSize} nextCursor={query.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, query.data?.nextCursor)} />}
    </>}
  </div>
}

const addressText = (value: { name: string | null; address: string }) => value.name ? `${value.name} <${value.address}>` : value.address
const checkTone = (value?: string) => value === 'PASS' ? 'success' as const : value === 'FAIL' ? 'danger' as const : value === 'GRAY' ? 'warning' as const : 'neutral' as const
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`
export function ReceivedEmailDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['received-email', id], (api, signal) => api.mailboxes.receivedEmail(id, signal))
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Received email" backTo="/logs?view=received" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return <ReceivedEmailDetailView email={query.data} />
}
function ReceivedEmailDetailView({ email }: { email: ReceivedEmailDetail }) {
  const [view, setView] = useState('preview')
  // Inline images reference attachments by Content-ID; point them at the signed S3 links.
  const html = email.attachments.reduce((value, file) => file.contentId && file.url ? value.split(`cid:${file.contentId}`).join(file.url) : value, email.html ?? '')
  const hasHtml = html.trim().length > 0
  const checks = (['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const).filter(key => email.verdicts[key])
  return <div className="email-detail-page"><PageHeader title={email.subject || '(no subject)'} backTo="/logs?view=received" actions={email.rawUrl ? <a className="ui-button ui-button--secondary ui-button--md" href={email.rawUrl}><Download size={16} />Download .eml</a> : undefined} />
    <dl className="email-metadata"><div><dt>From</dt><dd>{addressText(email.from)}</dd></div><div><dt>To</dt><dd>{email.envelopeTo.join(', ') || email.to.map(addressText).join(', ')}</dd></div><div><dt>Address</dt><dd>{email.addresses.length ? email.addresses.map((mailbox, index) => <Fragment key={mailbox.id}>{index > 0 && ', '}<Link to={`/inbound?address=${encodeURIComponent(mailbox.id)}&thread=${encodeURIComponent(email.threadId)}&message=${encodeURIComponent(email.id)}`}>{mailbox.address}</Link></Fragment>) : 'Unrouted'}</dd></div></dl>
    {email.spam && <Alert tone="warning">SES flagged this message as spam or a virus. It’s stored, but spam never creates a new address.</Alert>}
    {email.bodyTruncated && <Alert tone="info">Part of this message was too large to store in full. Download the original for the complete content.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'plain', label: 'Plain text' }, { value: 'html', label: 'HTML' }, { value: 'headers', label: 'Headers' }]} />
      {view === 'preview' ? hasHtml ? <EmailPreview html={html} title="Received message preview" remoteImages /> : email.text ? <pre className="plain-text-preview">{email.text}</pre> : <EmptyState title="This message has no body" />
        : view === 'plain' ? <pre className="message-source">{email.text || 'No plain-text body.'}</pre>
        : view === 'html' ? <pre className="message-source">{email.html || 'No HTML body.'}</pre>
        : <pre className="message-source">{(email.headers ?? []).map(header => `${header.name}: ${header.value}`).join('\n') || 'No headers stored.'}</pre>}
    </section><section className="delivery-timeline received-details">
      <SectionHeader title="Details" />
      <dl className="received-facts">
        <div><dt>Received</dt><dd>{date(email.receivedAt)} · {time(email.receivedAt)} UTC</dd></div>
        {email.sentAt && <div><dt>Sent</dt><dd>{date(email.sentAt)} · {time(email.sentAt)} UTC</dd></div>}
        {checks.length > 0 && <div><dt>Checks</dt><dd className="cluster">{checks.map(key => <StatusBadge key={key} status={`${key.toUpperCase()} ${label(email.verdicts[key]!.toLowerCase())}`} tone={checkTone(email.verdicts[key])} />)}</dd></div>}
        {email.cc.length > 0 && <div><dt>Cc</dt><dd>{email.cc.map(addressText).join(', ')}</dd></div>}
        {email.replyTo.length > 0 && <div><dt>Reply-To</dt><dd>{email.replyTo.map(addressText).join(', ')}</dd></div>}
        {email.sizeBytes !== null && <div><dt>Size</dt><dd>{fileSize(email.sizeBytes)}</dd></div>}
      </dl>
      {email.attachments.length > 0 && <div className="received-group"><h3 className="received-heading">Attachments</h3><ul className="received-attachments">{email.attachments.map(file => <li key={file.id}>
        <Paperclip size={14} aria-hidden />{file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a> : <span>{file.filename}</span>}<span className="muted">{fileSize(file.size)}{file.disposition === 'inline' ? ' · inline' : ''}</span>
      </li>)}</ul></div>}
    </section></div>
    <div className="message-identifiers"><span className="cluster">Message ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy message ID" /></span>{email.messageId && <span className="cluster">Message-ID <span className="identifier" title={email.messageId}>{email.messageId}</span><CopyButton value={email.messageId} label="Copy Message-ID header" /></span>}<span>SES · {email.region ?? '—'}</span></div>
  </div>
}

// Statuses that can still change without user action; terminal emails are not polled.
const pendingStatuses = ['queued', 'attempting', 'accepted', 'sent', 'deferred', 'delayed']
export function EmailDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['email', id], (api, signal) => api.emails.get(id, signal), { interval: email => email && pendingStatuses.includes(email.status) ? 30_000 : false })
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Email detail" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return query.data ? <EmailDetail email={query.data} /> : null
}
function EmailDetail({ email }: { email: Email }) {
  const navigate = useNavigate()
  const api = useApi()
  const [events, setEvents] = useState(email.events)
  const [cursor, setCursor] = useState(email.eventsNextCursor)
  const [eventError, setEventError] = useState('')
  const [eventBusy, setEventBusy] = useState(false)
  const [view, setView] = useState('preview')
  const hasHtml = email.html.trim().length > 0
  const plainText = email.text ?? (api.mode === 'demo' && hasHtml ? htmlToText(email.html) : '')
  const hasPlainText = plainText.trim().length > 0
  const contacts = useApiQuery(['contact-for-email', email.to], (api, signal) => api.contacts.list({ email: email.to, pageSize: 1 }, signal))
  const contact = contacts.data?.items.find(item => item.email.toLowerCase() === email.to.toLowerCase())
  // Bounce and complaint notices say whether the address is suppressed; keep the loading state until the contact lookup settles so the notice never grows or shrinks under the reader.
  if (contacts.isPending && ['bounced', 'complaint', 'complained'].includes(email.status)) return <EmailDetailSkeleton />
  return <div className="email-detail-page"><PageHeader title={email.subject} backTo="/logs" actions={<span className="email-header-actions"><span data-hidden={contact ? true : undefined}><StatusBadge status={email.status} /></span><Button data-hidden={contact ? undefined : true} onClick={() => contact && navigate(`/audience/contacts/${contact.id}`)}>View contact<ArrowUpRight size={16} /></Button></span>} />
    <dl className="email-metadata"><div><dt>To</dt><dd>{email.to}</dd></div><div><dt>From</dt><dd>{email.fromName ? `${email.fromName} <${email.from}>` : email.from}</dd></div><div><dt>Stream</dt><dd>{label(email.stream)}</dd></div></dl>
    {email.simulated && <Alert tone="info">Simulated; not sent to SES.</Alert>}
    {email.status === 'bounced' && <Alert tone="warning">Delivery failed.{contact?.status === 'suppressed' && ' This address is suppressed.'}</Alert>}
    {['complaint', 'complained'].includes(email.status) && <Alert tone="danger">The recipient reported this message as spam.{contact?.status === 'suppressed' && ' This address is suppressed.'}</Alert>}
    {['deferred', 'delayed'].includes(email.status) && <Alert tone="warning">Delivery delayed.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'html', label: 'HTML' }, { value: 'plain', label: 'Plain text' }]} />
      {view === 'preview' ? hasHtml ? <EmailPreview html={email.html} title="Email message preview" attachmentIds={email.attachments} remoteImages /> : hasPlainText ? <pre className="plain-text-preview">{plainText}</pre> : <EmptyState title="No message snapshot available" /> : <pre className="message-source">{view === 'html' ? email.html || 'No HTML snapshot available.' : hasPlainText ? plainText : 'No plain-text snapshot available.'}</pre>}
    </section><section className="delivery-timeline"><SectionHeader title="Delivery timeline" actions={<span className="muted">UTC</span>} /><ol>{events.map(event => <li key={event.id}><span className={`timeline-dot ui-tone--${eventTone(event.type)}`} /><div><div className="cluster between"><span>{eventLabel(event.type)}</span><time className="muted">{time(event.at)}</time></div><p className="muted">{event.description}</p>{event.diagnostic && <pre className="diagnostic">{event.diagnostic}</pre>}</div></li>)}</ol>{eventError && <Alert tone="danger">{eventError}</Alert>}{cursor && api.emailEvents && <Button loading={eventBusy} onClick={async () => {setEventBusy(true); setEventError(''); try {const next = await api.emailEvents!(email.id, cursor); setEvents(previous => [...previous, ...next.items]); setCursor(next.nextCursor)} catch (error) {setEventError(error instanceof Error ? error.message : 'Could not load events.')} finally {setEventBusy(false)}}}>Load more events</Button>}</section></div>
    <div className="message-identifiers"><span className="cluster">Email ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy email ID" /></span><span>Created {date(email.sentAt)} · {time(email.sentAt)} UTC</span><span>SES · {email.regionId}</span></div>
  </div>
}

const eventNames: Record<string, string> = { send: 'Accepted', sent: 'Accepted', delivered: 'Delivered', bounced: 'Bounced', complaint: 'Complaint', complained: 'Complaint', rejected: 'Rejected', rendering_failed: 'Rendering failed', delivery_delayed: 'Delivery delayed', opened: 'Opened', clicked: 'Clicked' }
const eventKey = (type: string) => type.replace(/^email\./, '')
function eventLabel(type: string) { return eventNames[eventKey(type)] ?? label(eventKey(type)) }
function eventTone(type: string) {
  const key = eventKey(type)
  if (['delivered', 'opened', 'clicked'].includes(key)) return 'success'
  if (['bounced', 'delivery_delayed'].includes(key)) return 'warning'
  if (['complaint', 'complained', 'rejected', 'rendering_failed'].includes(key)) return 'danger'
  return 'neutral'
}
