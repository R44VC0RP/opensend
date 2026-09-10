import type { Campaign } from '../../data/types'
import { number } from '../../lib/format'

export function CampaignProgress({ campaign }: { campaign: Campaign }) {
  if (!campaign.counts) return null
  const { total, byStatus } = campaign.counts
  const queued = byStatus.queued ?? 0
  const processing = byStatus.attempting ?? 0
  const processed = Math.max(0, total - queued - processing)
  const outcomes = [
    ['Delivered', byStatus.delivered], ['Bounced', byStatus.bounced],
    ['Complaints', byStatus.complained], ['Rejected', byStatus.rejected],
    ['Rendering failed', byStatus.rendering_failed], ['Suppressed', byStatus.suppressed],
    ['Canceled', byStatus.canceled], ['Acceptance unknown', byStatus.acceptance_unknown],
    ['Simulated', byStatus.simulated],
  ] as const
  return <div className="campaign-audience-summary">
    {campaign.expansion && <div className="campaign-summary-line"><span>Added to send queue</span><span>{number(campaign.expansion.expanded)} / {number(campaign.expansion.total)}</span></div>}
    <div className="campaign-summary-line"><strong>Send progress</strong><span>{number(processed)} / {number(total)} processed</span></div>
    {total > 0 ? <progress className="campaign-progress-bar" aria-label="Campaign send progress" aria-valuetext={`${number(processed)} of ${number(total)} emails processed`} value={processed} max={total} /> : <p className="muted">No email records available.</p>}
    <div className="campaign-summary-line"><span>Queued</span><span>{number(queued)}</span></div>
    <div className="campaign-summary-line"><span>Processing</span><span>{number(processing)}</span></div>
    <p className="muted">Processed means no longer queued or processing, including failed and canceled emails. It does not mean delivered.</p>
    {outcomes.filter(([, count]) => count && count > 0).map(([label, count]) => <div className="campaign-summary-line" key={label}><span>{label}</span><span>{number(count)}</span></div>)}
    <p className="muted">Updates every 3 seconds.</p>
  </div>
}
