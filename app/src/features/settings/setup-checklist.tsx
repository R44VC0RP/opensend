import { Check, Circle, CircleAlert, Clock3 } from 'lucide-react'
import type { SesDiscovery } from '../../data/types'

type CheckState = 'complete' | 'missing' | 'unknown' | 'blocked' | 'waiting'
type SetupCheck = { name: string; state: CheckState; detail?: string }
const labels: Record<CheckState, string> = { complete: 'Ready', missing: 'Needs setup', unknown: 'Not checked', blocked: 'Needs attention', waiting: 'Awaiting confirmation' }

export function awaitingConfirmationOnly(report: SesDiscovery | undefined) {
  if (!report || report.resources.topic.subscription !== 'pending') return false
  const { transactional, marketing, topic } = report.resources
  return [transactional, marketing].every(set => set.exists === true && set.owned === true && set.sendingEnabled === true && set.eventWired === true)
    && topic.exists === true && topic.owned === true && topic.policyReady === true
    && !report.blockers.some(issue => !['SNS_CONFIRMATION_PENDING', 'SES_SANDBOX', 'SES_DOMAIN_REQUIRED', 'SES_SENDING_DISABLED', 'SES_ACCOUNT_ENFORCEMENT'].includes(issue.code))
}

export function SetupChecklist({report, running, queued}: {report?: SesDiscovery; running: boolean; queued: boolean}) {
  const sets = report ? [report.resources.transactional, report.resources.marketing] : []
  const topic = report?.resources.topic
  const checks: SetupCheck[] = [
    { name: 'AWS account access', state: report?.account ? 'complete' : report?.blockers.some(issue => issue.code.startsWith('AWS_')) ? 'blocked' : 'unknown' },
    { name: 'SES configuration sets', state: !report ? 'unknown' : sets.some(set => set.exists === true && (set.owned === false || set.sendingEnabled === false)) ? 'blocked' : sets.some(set => set.exists === false) ? 'missing' : sets.every(set => set.exists === true && set.owned === true && set.sendingEnabled === true) ? 'complete' : 'unknown', detail: report ? sets.map((set, index) => `${index === 0 ? 'Transactional' : 'Marketing'}: ${set.exists === false ? 'not created' : set.owned === false ? 'ownership conflict' : set.sendingEnabled === false ? 'sending disabled' : set.exists === true && set.owned === true && set.sendingEnabled === true ? 'ready' : 'not checked'}`).join(' · ') : undefined },
    { name: 'SNS topic and permissions', state: topic?.exists === false ? 'missing' : topic?.owned === false ? 'blocked' : topic?.exists === true && topic.owned === true && topic.policyReady === true ? 'complete' : topic?.policyReady === false ? 'missing' : 'unknown', detail: topic?.owned === false && topic.exists === true ? 'The topic is not owned by this installation.' : topic?.exists === true && topic.policyReady === false ? 'The topic policy needs updating.' : undefined },
    { name: 'SES event destinations', state: !report ? 'unknown' : sets.every(set => set.eventWired === true) ? 'complete' : sets.some(set => set.eventWired === false || set.exists === false) ? 'missing' : 'unknown', detail: report && !sets.every(set => set.eventWired === true) ? sets.map((set, index) => `${index === 0 ? 'Transactional' : 'Marketing'}: ${set.eventWired === true ? 'connected' : set.eventWired === false || set.exists === false ? 'not connected' : 'not checked'}`).join(' · ') : undefined },
    { name: 'HTTPS subscription', state: topic?.subscription === 'pending' ? 'waiting' : topic?.subscription === 'confirmed' && topic.rawMessageDelivery === false && !topic.subscriptionsTruncated && !report?.blockers.some(issue => issue.code === 'SNS_SUBSCRIPTION_FILTERED') ? 'complete' : topic?.subscription === 'missing' || topic?.exists === false ? 'missing' : topic?.subscription === 'confirmed' ? 'blocked' : 'unknown' },
  ]
  const pending = topic?.subscription === 'pending'
  const snsUrl = report && topic?.arn ? `https://${report.region}.console.aws.amazon.com/sns/v3/home?region=${report.region}#/topic/${encodeURIComponent(topic.arn)}` : undefined
  return <div className="settings-setup-checklist" aria-label="Provisioning checklist">
    <div className="settings-setup-heading"><h3>Provisioning</h3>{running && <span role="status">{queued ? 'Queued' : 'In progress'}</span>}</div>
    {running && report && <p className="muted">Last checked state.</p>}
    <ul className="settings-setup-steps">{checks.map(check => {
      const Icon = check.state === 'complete' ? Check : check.state === 'waiting' ? Clock3 : check.state === 'blocked' ? CircleAlert : Circle
      return <li key={check.name} data-state={check.state}>
        <Icon size={16} aria-hidden="true" />
        <div className="settings-setup-step"><div className="settings-setup-step-heading"><span>{check.name}</span><span className="settings-setup-status">{labels[check.state]}</span></div>{check.detail && <p className="muted">{check.detail}</p>}
          {check.name === 'HTTPS subscription' && pending && <div className="settings-setup-confirmation"><p>In SNS, choose <strong>Request confirmation</strong> for the pending subscription, then <strong>Check AWS</strong>. Provisioning does not resend confirmation.</p>{snsUrl && <a className="ui-button ui-button--secondary" href={snsUrl} target="_blank" rel="noopener noreferrer">Open SNS</a>}</div>}
        </div>
      </li>
    })}</ul>
    {report?.feedbackUrl && <div className="settings-setup-callback"><span className="muted">Callback</span><span>{report.feedbackUrl}</span></div>}
  </div>
}
