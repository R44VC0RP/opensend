import { useLayoutEffect, useRef, useState } from 'react'
import { StatusBadge } from '../../components/ui'
import type { SesDiscovery, SesReputation } from '../../data/types'
import { date } from '../../lib/format'
import { accountStatus, ratePercent, rateStatus, reputationThresholds, type ReputationMetric } from '../../lib/reputation'

export function ReputationSection({ report }: { report: SesDiscovery }) {
  const reputation = report.reputation
  const status = accountStatus(report.account?.enforcementStatus)
  return <div className="stack settings-discovery-section">
    <div className="reputation-heading">
      <h3 className="cluster">Reputation <StatusBadge status={status.label} tone={status.tone} /></h3>
      <p className="muted">Historic rates SES calculates from a representative volume of your mail.</p>
    </div>
    {reputation == null ? <p className="muted">Reputation rates load on the next check. Select Refresh to check now.</p>
      : !reputation.available ? <p className="muted">{reputation.reason ?? 'Reputation rates are unavailable.'}</p>
      : <div className="reputation-panels">
        <RatePanel metric="bounceRate" title="Bounce rate" reputation={reputation} />
        <RatePanel metric="complaintRate" title="Complaint rate" reputation={reputation} />
      </div>}
  </div>
}

function RatePanel({ metric, title, reputation }: { metric: ReputationMetric; title: string; reputation: SesReputation }) {
  const value = reputation[metric], status = rateStatus(metric, value)
  return <section className="reputation-panel" aria-label={title}>
    <div className="reputation-panel-header">
      <div className="reputation-panel-value"><span className="muted">{title}</span><span className="cluster"><strong>{ratePercent(value)}</strong><StatusBadge status={status.label} tone={status.tone} /></span></div>
      <span className="reputation-legend"><span><i className="reputation-key--warning" />Warning</span><span><i className="reputation-key--risk" />At risk</span></span>
    </div>
    <RateChart metric={metric} title={title} series={reputation.series} />
  </section>
}

const H = 132, L = 44, T = 8, B = H - 22
const axisPercent = (value: number) => `${Number((value * 100).toFixed(2))}%`
function RateChart({ metric, title, series }: { metric: ReputationMetric; title: string; series: SesReputation['series'] }) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    setWidth(Math.max(1, element.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const limits = reputationThresholds[metric]
  const points = series.filter(point => point[metric] != null)
  const values = points.map(point => point[metric]!)
  if (!values.length) return <p className="muted reputation-empty">No data in the last 14 days. SES publishes these rates once you send mail.</p>
  const R = width - 4
  const max = Math.max(limits.risk * 1.25, ...values.map(value => value * 1.1))
  const start = Date.parse(series[0].at), end = Date.parse(series[series.length - 1].at)
  const x = (at: string) => L + (Date.parse(at) - start) / Math.max(1, end - start) * (R - L)
  const y = (value: number) => B - value / max * (B - T)
  const path = points.map((point, i) => `${i ? 'L' : 'M'} ${x(point.at).toFixed(1)} ${y(point[metric]!).toFixed(1)}`).join(' ')
  const day = (at: string) => date(at, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return <div ref={container} className="reputation-chart">
    <svg width={width} height={H} role="img" aria-label={`${title} over the last 14 days. Latest ${ratePercent(values[values.length - 1])}; warning at ${ratePercent(limits.warning)}, at risk at ${ratePercent(limits.risk)}.`}>
      <line x1={L} x2={R} y1={B} y2={B} className="chart-grid" />
      <text x={0} y={B + 4} className="chart-label">0%</text>
      {[{ value: limits.risk, className: 'reputation-line--risk' }, { value: limits.warning, className: 'reputation-line--warning' }].map(line => <g key={line.className}>
        <line x1={L} x2={R} y1={y(line.value)} y2={y(line.value)} className={`reputation-line ${line.className}`} />
        <text x={0} y={y(line.value) + 4} className="chart-label">{axisPercent(line.value)}</text>
      </g>)}
      <path d={path} className="reputation-series" />
      <text x={L} y={H - 4} className="chart-label">{day(series[0].at)}</text>
      <text x={R} y={H - 4} textAnchor="end" className="chart-label">{day(series[series.length - 1].at)}</text>
    </svg>
  </div>
}
