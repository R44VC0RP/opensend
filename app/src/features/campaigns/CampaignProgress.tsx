import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApi, useApiMutation } from '../../data/context'
import type { Campaign, CampaignExpansion, CampaignPacingInput } from '../../data/types'
import { Alert, Button, Checkbox, Input } from '../../components/ui'
import { date, number, relativeTime, time } from '../../lib/format'

export const liveInterval = 3000
export const heldInterval = 60_000
export const minPerDay = 100
export const maxPerDay = 10_000_000
export const perDayError = (value: number) => Number.isInteger(value) && value >= minPerDay && value <= maxPerDay ? '' : `Enter a whole number from ${number(minPerDay)} to ${number(maxPerDay)}.`
const releasing = (expansion?: CampaignExpansion | null) => expansion?.status === 'pending' || expansion?.status === 'expanding'
// Paused or waiting for a pacing window / SES quota: nothing new is released for a while.
export const sendingHeld = (expansion?: CampaignExpansion | null) => expansion?.status === 'paused' || (releasing(expansion) && Boolean(expansion?.waiting))
const waitingLabel = { pacing_window: 'Waiting for the next daily slice', ses_daily_quota: 'Holding for the SES daily quota' } as const
const atUtc = (value: string) => `${date(value)} · ${time(value)} UTC`

// Poll only while a send can still change; a future schedule waits until it is due.
// While paused or waiting for the next window, poll slowly unless queued mail is still draining.
export function campaignPollInterval(campaign?: Pick<Campaign, 'status' | 'scheduledAt' | 'expansion' | 'counts'> | null): number | false {
  if (!campaign) return false
  if (campaign.status === 'scheduled') {
    const due = Date.parse(campaign.scheduledAt ?? '') - Date.now()
    return due > liveInterval ? Math.min(due, 2_147_483_647) : liveInterval
  }
  const expansion = campaign.expansion
  if (sendingHeld(expansion)) {
    const byStatus = campaign.counts?.byStatus
    if ((byStatus?.queued ?? 0) + (byStatus?.attempting ?? 0) > 0) return liveInterval
    const until = expansion?.status === 'paused' ? NaN : Date.parse(expansion?.waiting?.until ?? '') - Date.now()
    return until > 0 && until < heldInterval ? Math.max(liveInterval, until + 1000) : heldInterval
  }
  if (campaign.status === 'sending') return liveInterval
  return releasing(expansion) ? liveInterval : false
}

export function CampaignProgress({ campaign }: { campaign: Campaign }) {
  if (!campaign.counts) return null
  const { total: materialized, byStatus } = campaign.counts
  const total = Math.max(materialized, campaign.expansion?.total ?? 0)
  const canceledBeforeQueue = campaign.expansion?.canceled ?? 0
  const awaitingQueue = Math.max(0, total - materialized - canceledBeforeQueue)
  const queued = byStatus.queued ?? 0
  const processing = byStatus.attempting ?? 0
  const processed = Math.min(total, Math.max(0, materialized - queued - processing + canceledBeforeQueue))
  const interval = campaignPollInterval(campaign)
  const outcomes = [
    ['Delivered', byStatus.delivered], ['Bounced', byStatus.bounced],
    ['Complaints', byStatus.complained], ['Rejected', byStatus.rejected],
    ['Rendering failed', byStatus.rendering_failed], ['Suppressed', byStatus.suppressed],
    ['Canceled', (byStatus.canceled ?? 0) + canceledBeforeQueue], ['Acceptance unknown', byStatus.acceptance_unknown],
    ['Simulated', byStatus.simulated],
  ] as const
  return <div className="campaign-audience-summary">
    {campaign.expansion && !campaign.expansion.pacing?.perDay && <div className="campaign-summary-line"><span>Added to send queue</span><span>{number(campaign.expansion.expanded)} / {number(campaign.expansion.total)}</span></div>}
    <div className="campaign-summary-line"><strong>Send progress</strong><span>{number(processed)} / {number(total)} processed</span></div>
    {total > 0 ? <progress className="campaign-progress-bar" aria-label="Campaign send progress" aria-valuetext={`${number(processed)} of ${number(total)} emails processed`} value={processed} max={total} /> : <p className="muted">No email records available.</p>}
    {awaitingQueue > 0 && <div className="campaign-summary-line"><span>Awaiting queue</span><span>{number(awaitingQueue)}</span></div>}
    <div className="campaign-summary-line"><span>Queued</span><span>{number(queued)}</span></div>
    <div className="campaign-summary-line"><span>Processing</span><span>{number(processing)}</span></div>
    <p className="muted">Processed means no longer queued or processing, including failed and canceled emails. It does not mean delivered.</p>
    {outcomes.filter(([, count]) => count && count > 0).map(([label, count]) => <div className="campaign-summary-line" key={label}><span>{label}</span><span>{number(count)}</span></div>)}
    {interval === liveInterval ? <p className="muted">Updates every 3 seconds.</p> : interval !== false && sendingHeld(campaign.expansion) && <p className="muted">Updates every minute while sending is held.</p>}
  </div>
}

const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

// Pause, resume, and daily-limit controls for a send that is still releasing recipients.
export function CampaignPacing({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const cache = useQueryClient()
  const expansion = campaign.expansion
  const pacing = expansion?.pacing
  const paused = expansion?.status === 'paused'
  const active = releasing(expansion)
  const [limit, setLimit] = useState(() => pacing?.perDay ? String(pacing.perDay) : '')
  const [autoPause, setAutoPause] = useState(pacing?.autoPause ?? true)
  const [error, setError] = useState('')
  // Each action returns the full campaign; write it into the cache instead of refetching everything.
  const campaignKey = ['opensend', api.mode, api.environment, 'campaign', campaign.id]
  function accept(next: Campaign) {
    cache.setQueryData(campaignKey, next)
    void cache.invalidateQueries({ queryKey: ['opensend', api.mode, api.environment, 'campaigns'], refetchType: 'none' })
  }
  const pause = useApiMutation((api, id: string) => api.campaigns.pause(id), 'Sending paused', false, false)
  const resume = useApiMutation((api, id: string) => api.campaigns.resume(id), 'Sending resumed', false, false)
  const update = useApiMutation((api, input: CampaignPacingInput) => api.campaigns.setPacing(campaign.id, input), 'Pacing updated', false, false)
  const busy = pause.isPending || resume.isPending || update.isPending
  async function run(action: () => Promise<Campaign>) {
    setError('')
    try { accept(await action()) }
    catch (cause) {
      setError(message(cause))
      // A conflict means the send moved on (finished, paused elsewhere); show its real state.
      void cache.invalidateQueries({ queryKey: campaignKey })
    }
  }
  const trimmed = limit.trim()
  const nextPerDay = trimmed ? Number(trimmed.replaceAll(',', '')) : null
  const limitError = nextPerDay === null ? '' : perDayError(nextPerDay)
  const changed = nextPerDay !== (pacing?.perDay ?? null) || autoPause !== (pacing?.autoPause ?? true)
  function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !changed) return
    if (limitError) { setError(limitError); return }
    void run(() => update.mutateAsync({ perDay: nextPerDay, autoPause }))
  }
  if (!expansion || (!paused && !active && !pacing?.perDay)) return null
  const perDay = pacing?.perDay ?? null
  const released = `${number(expansion.expanded)} of ${number(expansion.total)} released`
  const nextSlice = perDay && pacing?.nextWindowAt && (active || paused) ? ` · next slice ${relativeTime(pacing.nextWindowAt)}` : ''
  return <div className="campaign-pacing">
    {paused && <Alert tone="warning" title="Sending paused">
      <div className="campaign-pacing-banner">
        <span>{expansion.pauseReason?.message ?? 'No new recipients are being released.'} Queued emails still send.{expansion.pausedAt && <span className="muted" title={atUtc(expansion.pausedAt)}> Paused {relativeTime(expansion.pausedAt)}.</span>}</span>
        <Button variant="primary" size="sm" loading={resume.isPending} disabled={busy} onClick={() => void run(() => resume.mutateAsync(campaign.id))}>Resume</Button>
      </div>
    </Alert>}
    <div className="campaign-summary-line">
      <span>{perDay ? <>{released} · {number(perDay)}/day{nextSlice && <span title={atUtc(pacing!.nextWindowAt!)}>{nextSlice}</span>}</> : released}</span>
      {active && <Button variant="secondary" size="sm" loading={pause.isPending} disabled={busy} onClick={() => void run(() => pause.mutateAsync(campaign.id))}>Pause</Button>}
    </div>
    {perDay && (active || paused) && <div className="campaign-summary-line muted"><span>Released in this 24-hour slice</span><span>{number(pacing?.windowExpanded ?? 0)} / {number(perDay)}</span></div>}
    {active && expansion.waiting && <p className="muted" role="status" title={atUtc(expansion.waiting.until)}>{waitingLabel[expansion.waiting.reason] ?? 'Waiting to release more recipients'} · about {relativeTime(expansion.waiting.until)}</p>}
    {(active || paused) && <form className="campaign-pacing-form" onSubmit={save}>
      <div className="campaign-pacing-limit">
        <label htmlFor="campaign-pacing-limit" className="muted">Daily limit</label>
        <Input id="campaign-pacing-limit" type="number" inputMode="numeric" min={minPerDay} max={maxPerDay} step={1} placeholder="No limit" value={limit} aria-invalid={Boolean(limitError) || undefined} onChange={event => { setLimit(event.target.value); setError('') }} disabled={busy} />
        <Button type="submit" size="sm" loading={update.isPending} disabled={busy || !changed}>Save</Button>
      </div>
      <Checkbox label="Auto-pause on high bounces or complaints" checked={autoPause} onCheckedChange={value => { setAutoPause(value); setError('') }} disabled={busy} />
    </form>}
    {error && <Alert tone="danger">{error}</Alert>}
  </div>
}
