import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiQuery, useRegion } from '../../data/context'
import type { ChartPoint, Stream, TimeRange } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Skeleton, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { date, number, percent, label } from '../../lib/format'
import { OverviewBodySkeleton, recentCampaignColumns } from './skeletons'

export function OverviewPage() {
  const { regionId } = useRegion()
  const [range, setRange] = useState<TimeRange>('7d')
  const [stream, setStream] = useState('all')
  const navigate = useNavigate()
  const query = useApiQuery(['overview', regionId, range, stream], (api, signal) => api.overview.get({ regionId, range, stream: stream === 'all' ? undefined : stream as Stream }, signal))
  const regions = useApiQuery(['regions'], (api, signal) => api.regions.list(signal))
  const current = regions.data?.find(region => region.id === regionId)
  const data = query.data
  const filterBar = <div className="overview-toolbar"><Tabs value={range} onValueChange={v => setRange(v as TimeRange)} items={[{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }]} /><div className="cluster"><span className="range-label">{data && `${date(data.periodStart, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${date(data.periodEnd)}`}</span><Select aria-label="Email stream" value={stream} onValueChange={setStream} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} /></div></div>
  return <><PageHeader title="Overview" actions={<div className="cluster"><span className="muted">{regionId}</span>{current ? <StatusBadge status={current.access} tone={current.access === 'production' ? 'success' : 'warning'} /> : <Skeleton width={84} height={20} />}</div>} />{filterBar}
    {query.isPending ? <OverviewBodySkeleton /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : data && <>
      <div className="metrics-grid">
        <Metric title="Sent" value={number(data.sent)} note={data.previousSent ? `${percent((data.sent - data.previousSent) / data.previousSent, 1)} vs. previous period` : 'No previous-period sends'} tone="accent" />
        <Metric title="Delivered" value={percent(data.sent ? data.delivered / data.sent : 0)} note={`${number(data.delivered)} ${data.delivered === 1 ? 'email' : 'emails'}`} />
        <Metric title="Bounced" value={percent(data.sent ? data.bounced / data.sent : 0)} note={`${number(data.bounced)} ${data.bounced === 1 ? 'email' : 'emails'}`} tone="warning" />
        <Metric title="Complaints" value={percent(data.sent ? data.complaints / data.sent : 0)} note={`${number(data.complaints)} ${data.complaints === 1 ? 'email' : 'emails'}`} tone="danger" />
      </div>
      <section className="chart-section" aria-label="Sending activity"><SectionHeader title="Email activity" actions={<div className="chart-legend"><span><i className="legend-sent" />Sent</span><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span><span>UTC</span></div>} />{data.sent ? <ActivityChart points={data.points} /> : <EmptyState title="No emails in this period" description="Choose another period or email stream." />}</section>
      <div className="dashboard-bottom"><section><SectionHeader title="Recent campaigns" actions={<Button variant="ghost" size="sm" onClick={() => navigate('/campaigns')}>View all <ArrowUpRight size={16} /></Button>} /><DataTable minRows={4} rowSize="large" rows={data.recentCampaigns} rowKey={row => row.id} onRowClick={row => navigate(`/campaigns/${row.id}/${row.status === 'draft' ? 'edit' : 'review'}`)} columns={[{ ...recentCampaignColumns[0], render: row => <div><span>{row.name}</span><div className="muted cell-caption">{date(row.updatedAt)}</div></div> }, { ...recentCampaignColumns[1], render: row => number(row.recipients), align: 'right' }, { ...recentCampaignColumns[2], render: row => row.status === 'sent' ? <span className="text-success">{percent(row.recipients ? row.delivered / row.recipients : 0)}</span> : <StatusBadge status={row.status} />, align: 'right' }]} empty={<EmptyState title="No campaigns yet" action={<Button onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} /></section>
      <section className="sending-streams"><SectionHeader title="Sending streams" />{data.streams.map(item => <div className="stream-row" key={item.name}><div className="cluster between"><span>{label(item.name)}</span><span>{number(item.sent)}</span></div><div className={`stream-track stream-track--${item.name}`}><span style={{ width: `${data.sent ? item.sent / data.sent * 100 : 0}%` }} /></div></div>)}<Button variant="ghost" size="sm" onClick={() => navigate('/logs')}>Explore email logs <ArrowUpRight size={16} /></Button></section></div>
    </>}
  </>
}
function Metric({ title, value, note, tone }: { title: string; value: string; note: string; tone?: string }) { return <div className="metric"><div className="muted">{title}</div><div className={`metric-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="muted cell-caption">{note}</div></div> }
function niceMax(value: number) { if (value <= 1) return 1; const base = 10 ** Math.floor(Math.log10(value)); return Math.ceil(value / base) * base }
function ActivityChart({ points }: { points: ChartPoint[] }) {
  const [active, setActive] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1080)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = (value: number) => setWidth(Math.max(1, value))
    measure(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [points.length])
  if (!points.length) return <EmptyState title="No activity" />
  const left = 52, right = width - 64, top = 30, bottom = 218
  const selectedPoint = active === null ? undefined : points[active]
  const maxSent = niceMax(Math.max(...points.map(p => p.sent)))
  const maxException = Math.max(3, niceMax(Math.max(...points.map(p => Math.max(p.bounced, p.complaints)))))
  const x = (i: number) => left + i * (right - left) / Math.max(1, points.length - 1)
  const y = (value: number, max: number) => bottom - value / max * (bottom - top)
  const line = (key: 'sent' | 'bounced' | 'complaints', max: number) => points.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(p[key], max)}`).join(' ')
  const tickIndices = [...new Set([0, ...Array.from({ length: 6 }, (_, i) => Math.round((i + 1) * (points.length - 1) / 6))])]
  return <div ref={container} className="activity-chart" onMouseLeave={() => setActive(null)}><svg viewBox={`0 0 ${width} 260`} role="img" aria-label="Email activity. Sends use the left scale; bounces and complaints use the right scale.">
    <text x={0} y={12} className="chart-label">Sent</text><text x={width - 2} y={12} textAnchor="end" className="chart-label">Exceptions</text>
    {[0, 1, 2, 3].map(i => <g key={i}><line x1={left} x2={right} y1={top + i * (bottom - top) / 3} y2={top + i * (bottom - top) / 3} className="chart-grid" /><text x={0} y={top + i * (bottom - top) / 3 + 4} className="chart-label">{number(Math.round(maxSent * (1 - i / 3)))}</text><text x={width - 2} y={top + i * (bottom - top) / 3 + 4} textAnchor="end" className="chart-label">{number(Math.round(maxException * (1 - i / 3)))}</text></g>)}
    <path d={`${line('sent', maxSent)} L${right} ${bottom} L${left} ${bottom} Z`} className="chart-fill" /><path d={line('sent', maxSent)} className="chart-line chart-line--sent" /><path d={line('bounced', maxException)} className="chart-line chart-line--bounces" /><path d={line('complaints', maxException)} className="chart-line chart-line--complaints" />
    {tickIndices.map(i => <text key={i} x={x(i)} y={247} textAnchor="middle" className="chart-label">{date(points[i].at, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>)}
    {points.map((p, i) => {
      const start = i === 0 ? left : (x(i - 1) + x(i)) / 2
      const end = i === points.length - 1 ? right : (x(i) + x(i + 1)) / 2
      return <rect key={p.at} x={start} y={top} width={Math.max(0, end - start)} height={bottom - top} fill="transparent" tabIndex={0} role="button" aria-label={`${date(p.at)}: ${number(p.sent)} sent, ${p.bounced} bounces, ${p.complaints} complaints`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} />
    })}
    {selectedPoint && active !== null && <line x1={x(active)} x2={x(active)} y1={top} y2={bottom} className="chart-crosshair" />}
  </svg>{selectedPoint && <div className="chart-tooltip" role="status"><strong>{date(selectedPoint.at)}</strong><span>Sent <b>{number(selectedPoint.sent)}</b></span><span>Bounces <b>{number(selectedPoint.bounced)}</b></span><span>Complaints <b>{number(selectedPoint.complaints)}</b></span></div>}</div>
}
