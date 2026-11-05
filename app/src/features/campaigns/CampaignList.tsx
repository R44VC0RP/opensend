import { Link, useNavigate, useSearchParams } from 'react-router'
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import { campaignEditable, type Campaign } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Input, Pagination, PaginationSkeleton, Select, StatusBadge } from '../../components/ui'
import { date, number, percent, shortDateTime, time } from '../../lib/format'
import { campaignColumns } from './skeletons'
import { CampaignArchiveButton } from './CampaignArchiveButton'
import { campaignPollInterval } from './CampaignProgress'
import { CampaignsHeader } from './header'
import './campaigns.css'

const campaignPath = (campaign: Campaign) => `/campaigns/${encodeURIComponent(campaign.id)}/${!campaign.archivedAt && campaignEditable(campaign) ? 'edit' : 'review'}`

export function CampaignsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const archived = params.get('archived') === 'true'
  const search = params.get('search') || ''
  const status = !archived && ['draft', 'preparing', 'scheduled', 'sending', 'paused', 'done', 'failed', 'canceled'].includes(params.get('status') || '') ? params.get('status')! : 'all'
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = 10
  const request = { search, archived, status: status === 'all' ? undefined : status, page, pageSize }
  const query = useApiDef(queries.campaigns(request), { keepPrevious: true, interval: data => {
    const intervals = (data?.items ?? []).map(campaignPollInterval).filter((value): value is number => value !== false)
    return intervals.length ? Math.max(15_000, Math.min(...intervals)) : false
  } })
  const filtered = Boolean(search || status !== 'all')
  function filter(key: string, value: string) {
    setParams(previous => { const next = new URLSearchParams(previous); value ? next.set(key, value) : next.delete(key); next.delete('page'); return next })
  }
  function selectTab(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      next.delete('page'); next.delete('status'); next.delete('archived')
      if (value === 'archived') next.set('archived', 'true')
      else if (value !== 'all') next.set('status', value)
      return next
    })
  }
  return <>
    <CampaignsHeader actions={<Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />
    <div className="data-toolbar"><div className="cluster"><Input className="campaign-search" aria-label="Search campaigns" placeholder="Search campaigns" type="search" value={search} onChange={event => filter('search', event.target.value)} /><Select aria-label="Filter by status" value={archived ? 'archived' : status} onValueChange={selectTab} options={[
      { value: 'all', label: 'All campaigns' }, { value: 'draft', label: 'Drafts' }, { value: 'scheduled', label: 'Scheduled' },
      { value: 'sending', label: 'Sending' }, { value: 'paused', label: 'Paused' }, { value: 'done', label: 'Done' }, { value: 'failed', label: 'Failed' }, { value: 'canceled', label: 'Canceled' },
      { value: 'archived', label: 'Archived' },
    ]} /></div></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(campaignPath(row))} empty={<EmptyState title={filtered ? 'No matching campaigns' : archived ? 'No archived campaigns' : 'No campaigns yet'} action={filtered ? <Button variant="secondary" onClick={() => setParams(archived ? { archived: 'true' } : {})}>Clear filters</Button> : archived ? undefined : <Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} columns={[
        { ...campaignColumns[0], render: row => <div className="campaign-row-name"><Link to={campaignPath(row)} onClick={event => event.stopPropagation()}>{row.name}</Link>{row.subject.trim() && row.subject.trim() !== row.name.trim() && <span className="muted">{row.subject}</span>}</div> },
        { ...campaignColumns[1], render: row => <StatusBadge status={row.status} /> },
        { ...campaignColumns[2], render: row => number(row.recipients) },
        { ...campaignColumns[3], render: row => ['sent', 'done'].includes(row.status) && row.recipients > 0 ? percent(row.delivered / row.recipients) : '—' },
        { ...campaignColumns[4], render: row => { const at = row.scheduledAt || row.updatedAt; return <span className="muted campaign-activity" title={`${date(at)} · ${time(at)} UTC`}>{shortDateTime(at)}</span> } },
        { ...campaignColumns[5], render: row => <CampaignArchiveButton campaign={row} compact onSuccess={() => filter('page', '')} /> },
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
    </>}
  </>
}
