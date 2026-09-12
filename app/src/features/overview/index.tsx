import { useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiQuery, useRegion, useApi } from '../../data/context'
import { useRegionCatalog } from '../../data/regions'
import type { ChartPoint, Stream, TimeRange } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, Skeleton, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { date, number, percent, label } from '../../lib/format'
import { OverviewBodySkeleton, recentCampaignColumns } from './skeletons'

export function OverviewPage() {
  const { regionId } = useRegion()
  const api = useApi()
  const live = api.mode === 'live'
  const [range, setRange] = useState<TimeRange>('7d')
  const [stream, setStream] = useState('all')
  const navigate = useNavigate()
  const query = useApiQuery(['overview', regionId, range, stream], (api, signal) => api.overview.get({ regionId, range, stream: stream === 'all' ? undefined : stream as Stream }, signal))
  const regions = useRegionCatalog()
  const current = regions.data?.data.find(region => region.region === regionId)
  const data = query.data
  const filterBar = <div className="overview-toolbar"><Tabs value={range} onValueChange={v => setRange(v as TimeRange)} items={[{ value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }]} /><div className="cluster"><span className="range-label">{data && `${date(data.periodStart, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${date(data.periodEnd)}`}</span><Select aria-label="Email stream" value={stream} onValueChange={setStream} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} /></div></div>
  return <><PageHeader title="Overview" actions={<div className="cluster"><span className="muted">{regionId}</span>{api.environment === 'test' ? <StatusBadge status="Test simulation" /> : current ? <StatusBadge status={label(current.discoveryStatus)} tone={current.discoveryStatus === 'ready' ? 'success' : current.discoveryStatus === 'blocked' ? 'danger' : 'warning'} /> : <Skeleton width={84} height={20} />}</div>} />{filterBar}
    {query.isPending ? <OverviewBodySkeleton /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : data && <div className="overview-content">
      <div className="metrics-grid">
        <Metric title={live ? "Created" : "Sent"} value={number(data.sent)} note={data.previousSent ? `${percent((data.sent - data.previousSent) / data.previousSent, 1)} vs. previous period` : 'No emails in the previous period'} tone="accent" />
        <Metric title="Delivered" value={percent(data.sent ? data.delivered / data.sent : 0)} note={`${number(data.delivered)} ${data.delivered === 1 ? 'email' : 'emails'}`} />
        <Metric title="Bounced" value={percent(data.sent ? data.bounced / data.sent : 0)} note={`${number(data.bounced)} ${data.bounced === 1 ? 'email' : 'emails'}`} tone="warning" />
        <Metric title="Complaints" value={percent(data.sent ? data.complaints / data.sent : 0)} note={`${number(data.complaints)} ${data.complaints === 1 ? 'email' : 'emails'}`} tone="danger" />
      </div>
      <section className="chart-section" aria-label="Sending activity"><SectionHeader title={live ? `Emails created per ${range === '30d' ? 'day' : 'hour'}` : `Email activity per ${range === '30d' ? 'day' : 'hour'}`} actions={<div className="chart-legend"><span><i className="legend-sent" />{live ? 'Created' : 'Sent'}</span><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span><span>UTC</span></div>} />{data.sent ? <ActivityChart key={range} points={data.points} createdOnly={live} range={range} /> : <EmptyState title="No emails in this period" />}</section>
      <div className="dashboard-bottom"><section><SectionHeader title="Recent campaigns" actions={<Button variant="ghost" size="sm" onClick={() => navigate('/campaigns')}>View all <ArrowUpRight size={16} /></Button>} /><DataTable minRows={4} rows={data.recentCampaigns} rowKey={row => row.id} onRowClick={row => navigate(`/campaigns/${row.id}/${['draft', 'reviewed'].includes(row.status) ? 'edit' : 'review'}`)} columns={[{ ...recentCampaignColumns[0], render: row => <div><span>{row.name}</span><div className="muted cell-caption">{date(row.updatedAt)}</div></div> }, { ...recentCampaignColumns[1], render: row => number(row.recipients), align: 'right' }, { ...recentCampaignColumns[2], render: row => ['sent', 'completed'].includes(row.status) ? <span className="text-success">{percent(row.recipients ? row.delivered / row.recipients : 0)}</span> : <StatusBadge status={row.status} />, align: 'right' }]} empty={<EmptyState title="No campaigns yet" action={<Button onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} /></section>
      <section className="sending-streams"><SectionHeader title="Sending streams" />{data.streams.map(item => <div className="stream-row" key={item.name}><div className="cluster between"><span>{label(item.name)}</span><span>{number(item.sent)}</span></div><div className={`stream-track stream-track--${item.name}`}><span style={{ width: `${data.streams.reduce((sum, stream) => sum + stream.sent, 0) ? item.sent / data.streams.reduce((sum, stream) => sum + stream.sent, 0) * 100 : 0}%` }} /></div></div>)}<Button variant="ghost" size="sm" onClick={() => navigate('/logs')}>View logs <ArrowUpRight size={16} /></Button></section></div>
    </div>}
  </>
}
function Metric({ title, value, note, tone }: { title: string; value: string; note: string; tone?: string }) { return <div className="metric"><div className="muted">{title}</div><div className={`metric-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="muted cell-caption">{note}</div></div> }
function niceMax(value: number) { if (value <= 1) return 1; const base = 10 ** Math.floor(Math.log10(value)); return Math.ceil(value / base) * base }
function ActivityChart({ points, range, createdOnly = false }: { points: ChartPoint[]; range: TimeRange; createdOnly?: boolean }) {
  const [active, setActive] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1080, height: 260 })
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = ({ width, height }: DOMRectReadOnly) => setSize({ width: Math.max(1, width), height: Math.max(1, height) })
    measure(element.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect))
    observer.observe(element)
    return () => observer.disconnect()
  }, [points.length])
  if (!points.length) return <EmptyState title="No activity" />
  const { width, height } = size
  const left = 52, right = width - 64, top = 30, bottom = height - 42
  const selectedPoint = active === null ? undefined : points[active]
  const hasOutcomes = points.every(point => Number.isFinite(point.bounced) && Number.isFinite(point.complaints))
  const maxSent = niceMax(Math.max(...points.map(p => p.sent)))
  const maxException = Math.max(3, niceMax(Math.max(...points.map(p => Math.max(p.bounced ?? 0, p.complaints ?? 0)))))
  const x = (i: number) => left + i * (right - left) / Math.max(1, points.length - 1)
  const y = (value: number, max: number) => bottom - value / max * (bottom - top)
  const line = (key: 'sent' | 'bounced' | 'complaints', max: number) => {
    const values = points.map(p => y(p[key], max))
    const slopes = values.slice(1).map((value, i) => value - values[i])
    // Monotone cubic interpolation passes through every count without overshooting
    // a peak or dipping below zero; opposite/flat slopes keep extrema horizontal.
    const tangents = values.map((_, i) => {
      if (i === 0) return slopes[0] ?? 0
      if (i === values.length - 1) return slopes[i - 1]
      const before = slopes[i - 1], after = slopes[i]
      return before * after <= 0 ? 0 : 2 * before * after / (before + after)
    })
    return values.map((value, i) => i === 0 ? `M ${x(i)} ${value}` : `C ${x(i - 2 / 3)} ${values[i - 1] + tangents[i - 1] / 3} ${x(i - 1 / 3)} ${value - tangents[i] / 3} ${x(i)} ${value}`).join(' ')
  }
  const hourly = range !== '30d'
  const pointLabel = (at: string) => `${date(at, { month: 'short', day: 'numeric', ...(hourly ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}), timeZone: 'UTC' })} UTC`
  const tickIndices = [...new Set([0, ...Array.from({ length: 6 }, (_, i) => Math.round((i + 1) * (points.length - 1) / 6))])]
  return <div ref={container} className="activity-chart" onMouseLeave={() => setActive(null)}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={createdOnly ? `Emails created per ${hourly ? 'hour' : 'day'} on the left scale; outcomes for those emails on the right scale.` : `Email activity per ${hourly ? 'hour' : 'day'}. Sends use the left scale; bounces and complaints use the right scale.`}>
    <text x={0} y={12} className="chart-label">{createdOnly ? 'Created' : 'Sent'}</text>{hasOutcomes && <text x={width - 2} y={12} textAnchor="end" className="chart-label">Exceptions</text>}
    {[0, 1, 2, 3].map(i => <g key={i}><line x1={left} x2={right} y1={top + i * (bottom - top) / 3} y2={top + i * (bottom - top) / 3} className="chart-grid" /><text x={0} y={top + i * (bottom - top) / 3 + 4} className="chart-label">{number(Math.round(maxSent * (1 - i / 3)))}</text>{hasOutcomes && <text x={width - 2} y={top + i * (bottom - top) / 3 + 4} textAnchor="end" className="chart-label">{number(Math.round(maxException * (1 - i / 3)))}</text>}</g>)}
    <path d={`${line('sent', maxSent)} L${right} ${bottom} L${left} ${bottom} Z`} className="chart-fill" /><path d={line('sent', maxSent)} className="chart-line chart-line--sent" />{hasOutcomes && <><path d={line('bounced', maxException)} className="chart-line chart-line--bounces" /><path d={line('complaints', maxException)} className="chart-line chart-line--complaints" /></>}
    {tickIndices.map(i => <text key={i} x={x(i)} y={height - (range === '7d' ? 22 : 13)} textAnchor="middle" className="chart-label">{date(points[i].at, range === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })}{range === '7d' && <tspan x={x(i)} dy={15}>{date(points[i].at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })}</tspan>}</text>)}
    {points.map((p, i) => {
      const start = i === 0 ? left : (x(i - 1) + x(i)) / 2
      const end = i === points.length - 1 ? right : (x(i) + x(i + 1)) / 2
      return <rect key={p.at} x={start} y={top} width={Math.max(0, end - start)} height={bottom - top} fill="transparent" tabIndex={0} role="button" aria-label={`${pointLabel(p.at)}: ${number(p.sent)} ${createdOnly ? 'created' : 'sent'}${hasOutcomes ? `, ${p.bounced} bounces, ${p.complaints} complaints` : ''}`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} />
    })}
    {selectedPoint && active !== null && <line x1={x(active)} x2={x(active)} y1={top} y2={bottom} className="chart-crosshair" />}
  </svg>{selectedPoint && <div className="chart-tooltip" role="status"><strong>{pointLabel(selectedPoint.at)}</strong><span>{createdOnly ? 'Created' : 'Sent'} <b>{number(selectedPoint.sent)}</b></span>{hasOutcomes && <><span>Bounces <b>{number(selectedPoint.bounced)}</b></span><span>Complaints <b>{number(selectedPoint.complaints)}</b></span></>}</div>}</div>
}
