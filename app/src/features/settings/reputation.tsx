import { StatusBadge } from '../../components/ui'
import type { SesDiscovery, SesReputation } from '../../data/types'
import { date, number, percent } from '../../lib/format'
import { accountStatus, ratePercent, rateStatus, reputationThresholds, type ReputationMetric } from '../../lib/reputation'

export function ReputationSection({ report }: { report: SesDiscovery }) {
  const reputation = report.reputation, quota = report.account?.quota
  const status = accountStatus(report.account?.enforcementStatus)
  const remaining = quota?.max24HourSend != null && quota.sentLast24Hours != null ? Math.max(0, quota.max24HourSend - quota.sentLast24Hours) : null
  const used = quota?.max24HourSend ? (quota.sentLast24Hours ?? 0) / quota.max24HourSend : null
  return <div className="stack settings-discovery-section">
    <div className="reputation-heading"><h3>Reputation</h3><p className="muted">Historic rates SES calculates from a representative volume of your mail.</p></div>
    <dl className="settings-facts settings-account-summary">
      <div><dt>Status</dt><dd className="reputation-fact"><StatusBadge status={status.label} tone={status.tone} /></dd></div>
      <RateFact metric="bounceRate" title="Bounce rate" reputation={reputation} />
      <RateFact metric="complaintRate" title="Complaint rate" reputation={reputation} />
      <div><dt>Remaining sends</dt><dd className="reputation-fact">{remaining == null ? 'Unknown' : number(remaining)}{used != null && <span className="muted">· {percent(used)} used</span>}</dd></div>
    </dl>
    {reputation == null ? <p className="muted">Reputation rates load on the next check. Select Refresh to check now.</p>
      : !reputation.available ? <p className="muted">{reputation.reason ?? 'Reputation rates are unavailable.'}</p>
      : <div className="reputation-charts">
        <RateChart metric="bounceRate" title="Bounce rate" series={reputation.series} />
        <RateChart metric="complaintRate" title="Complaint rate" series={reputation.series} />
      </div>}
  </div>
}

function RateFact({ metric, title, reputation }: { metric: ReputationMetric; title: string; reputation: SesReputation | null | undefined }) {
  const value = reputation?.available ? reputation[metric] : null
  const status = rateStatus(metric, value)
  return <div><dt>{title}</dt><dd className="reputation-fact">{reputation?.available ? <><span>{ratePercent(value)}</span><StatusBadge status={status.label} tone={status.tone} /></> : <span className="muted">Unavailable</span>}</dd></div>
}

const W = 480, H = 168, L = 48, R = W - 8, T = 10, B = H - 26
function RateChart({ metric, title, series }: { metric: ReputationMetric; title: string; series: SesReputation['series'] }) {
  const limits = reputationThresholds[metric]
  const values = series.map(point => point[metric]).filter((value): value is number => value != null)
  const max = Math.max(limits.risk * 1.25, ...values.map(value => value * 1.1))
  const start = series.length ? Date.parse(series[0].at) : 0, end = series.length ? Date.parse(series[series.length - 1].at) : 1
  const x = (at: string) => L + (Date.parse(at) - start) / Math.max(1, end - start) * (R - L)
  const y = (value: number) => B - value / max * (B - T)
  const path = series.filter(point => point[metric] != null).map((point, i) => `${i ? 'L' : 'M'} ${x(point.at).toFixed(1)} ${y(point[metric]!).toFixed(1)}`).join(' ')
  const lines = [{ value: limits.risk, className: 'reputation-line--risk' }, { value: limits.warning, className: 'reputation-line--warning' }]
  return <figure className="reputation-chart">
    <figcaption><span>{title}</span><span className="reputation-legend"><span><i className="reputation-key--warning" />Warning</span><span><i className="reputation-key--risk" />At risk</span></span></figcaption>
    {values.length ? <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} over the last 14 days. Latest ${ratePercent(values[values.length - 1])}; warning at ${ratePercent(limits.warning)}, at risk at ${ratePercent(limits.risk)}.`}>
      <line x1={L} x2={R} y1={B} y2={B} className="chart-grid" />
      <text x={0} y={B + 4} className="chart-label">0%</text>
      {lines.map(line => <g key={line.className}><line x1={L} x2={R} y1={y(line.value)} y2={y(line.value)} className={`reputation-line ${line.className}`} /><text x={0} y={y(line.value) + 4} className="chart-label">{ratePercent(line.value)}</text></g>)}
      <path d={path} className="reputation-series" />
      <text x={L} y={H - 6} className="chart-label">{date(series[0].at, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>
      <text x={R} y={H - 6} textAnchor="end" className="chart-label">{date(series[series.length - 1].at, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>
    </svg> : <p className="muted reputation-empty">No data in the last 14 days. SES publishes these rates once you send mail.</p>}
  </figure>
}
