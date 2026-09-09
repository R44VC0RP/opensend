import { ArrowUpRight } from 'lucide-react'
import { useRegion } from '../../data/context'
import { Button, LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, SkeletonText, TableSkeleton, Tabs } from '../../components/ui'

export const recentCampaignColumns = [{ key: 'name', label: 'Campaign', width: '48%', skeleton: <><SkeletonText /><SkeletonText width="45%" lineHeight={18} /></> }, { key: 'sent', label: 'Recipients', width: '26%', align: 'right' as const }, { key: 'delivered', label: 'Delivered', width: '26%', align: 'right' as const }]
export function OverviewBodySkeleton() {
  return <LoadingRegion label="Loading overview">
    <div className="metrics-grid">{['Sent', 'Delivered', 'Bounced', 'Complaints'].map(title => <div className="metric" key={title}><div className="muted">{title}</div><div className="metric-value"><SkeletonText width="55%" lineHeight={36} /></div><div className="muted cell-caption"><SkeletonText width="80%" lineHeight={18} /></div></div>)}</div>
    <section className="chart-section"><SectionHeader title="Email activity" actions={<div className="chart-legend"><span><i className="legend-sent" />Sent</span><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span><span>UTC</span></div>} /><div className="chart-skeleton" aria-hidden="true"><div className="cluster between"><span>Sent</span><span>Exceptions</span></div><div className="chart-skeleton-grid">{[0, 1, 2, 3].map(i => <div key={i}><Skeleton width={28} /><span /><Skeleton width={18} /></div>)}</div><div className="chart-skeleton-ticks">{[0, 1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} width={40} />)}</div></div></section>
    <div className="dashboard-bottom"><section><SectionHeader title="Recent campaigns" actions={<Button variant="ghost" size="sm" disabled>View all <ArrowUpRight size={16} /></Button>} /><TableSkeleton columns={recentCampaignColumns} rows={4} /></section><section className="sending-streams"><SectionHeader title="Sending streams" />{['Transactional', 'Marketing'].map(name => <div className="stream-row" key={name}><div className="cluster between"><span>{name}</span><Skeleton width={70} /></div><div className="stream-track"><Skeleton height={4} /></div></div>)}<Button variant="ghost" size="sm" disabled>Explore email logs <ArrowUpRight size={16} /></Button></section></div>
  </LoadingRegion>
}
export function OverviewRouteSkeleton() {
  const { regionId } = useRegion()
  return <><PageHeader title="Overview" actions={<div className="cluster"><span className="muted">{regionId}</span><Skeleton width={84} height={20} /></div>} /><div className="overview-toolbar"><Tabs value="7d" onValueChange={() => {}} items={[{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }]} /><div className="cluster"><span className="range-label"><Skeleton width={195} /></span><Select aria-label="Email stream" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All emails' }]} /></div></div><OverviewBodySkeleton /></>
}
