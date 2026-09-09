import { Link, useNavigate, useSearchParams } from 'react-router'
import { useApiQuery, useRegion } from '../../data/context'
import type { Campaign } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Input, PageHeader, Pagination, PaginationSkeleton, Tabs, StatusBadge } from '../../components/ui'
import { date, number, percent, time } from '../../lib/format'
import { campaignColumns } from './skeletons'
import { CampaignArchiveButton } from './CampaignArchiveButton'
import './campaigns.css'

const campaignPath = (campaign: Campaign) => `/campaigns/${encodeURIComponent(campaign.id)}/${!campaign.archivedAt && ['draft', 'reviewed'].includes(campaign.status) ? 'edit' : 'review'}`

export function CampaignsPage() {
  const { regionId } = useRegion()
  return <CampaignList key={regionId} regionId={regionId} />
}

function CampaignList({ regionId }: { regionId: string }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const archived = params.get('archived') === 'true'
  const search = params.get('search') || ''
  const status = !archived && ['draft', 'reviewed', 'scheduled', 'sending', 'completed', 'canceled'].includes(params.get('status') || '') ? params.get('status')! : 'all'
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = 10
  const request = { regionId, search, archived, status: status === 'all' ? undefined : status, page, pageSize }
  const query = useApiQuery(['campaigns', request], (api, signal) => api.campaigns.list(request, signal))
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
    <PageHeader title="Campaigns" actions={<Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />
    <Tabs value={archived ? 'archived' : status} onValueChange={selectTab} items={[
      { value: 'all', label: 'All campaigns' }, { value: 'draft', label: 'Drafts' }, { value: 'scheduled', label: 'Scheduled' },
      { value: 'reviewed', label: 'Reviewed' }, { value: 'sending', label: 'Sending' }, { value: 'completed', label: 'Completed' }, { value: 'canceled', label: 'Canceled' },
      { value: 'archived', label: 'Archived' },
    ]} />
    <div className="data-toolbar"><Input className="campaign-search" aria-label="Search campaigns" placeholder="Search campaigns" type="search" value={search} onChange={event => filter('search', event.target.value)} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(campaignPath(row))} empty={<EmptyState title={filtered ? 'No matching campaigns' : archived ? 'No archived campaigns' : 'No campaigns yet'} action={filtered ? <Button variant="secondary" onClick={() => setParams(archived ? { archived: 'true' } : {})}>Clear filters</Button> : archived ? undefined : <Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} columns={[
        { ...campaignColumns[0], render: row => <div className="campaign-row-name"><Link to={campaignPath(row)} onClick={event => event.stopPropagation()}>{row.name}</Link><span className="muted">{row.subject}</span></div> },
        { ...campaignColumns[1], render: row => <StatusBadge status={row.status} /> },
        { ...campaignColumns[2], render: row => number(row.recipients) },
        { ...campaignColumns[3], render: row => ['sent', 'completed'].includes(row.status) && row.recipients > 0 ? percent(row.delivered / row.recipients) : '—' },
        { ...campaignColumns[4], render: row => <span className="muted">{date(row.scheduledAt || row.updatedAt)} · {time(row.scheduledAt || row.updatedAt)} UTC</span> },
        { ...campaignColumns[5], render: row => <CampaignArchiveButton campaign={row} compact onSuccess={() => filter('page', '')} /> },
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
    </>}
  </>
}
