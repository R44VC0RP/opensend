import type { Tone } from '../components/ui'

// Thresholds match the SES console's reputation charts.
export const reputationThresholds = {
  bounceRate: { warning: 0.05, risk: 0.1 },
  complaintRate: { warning: 0.001, risk: 0.005 },
} as const
export type ReputationMetric = keyof typeof reputationThresholds

export function rateStatus(metric: ReputationMetric, value: number | null | undefined): { label: string; tone: Tone } {
  if (value == null) return { label: 'No data', tone: 'neutral' }
  const limits = reputationThresholds[metric]
  if (value >= limits.risk) return { label: 'At risk', tone: 'danger' }
  if (value >= limits.warning) return { label: 'Warning', tone: 'warning' }
  return { label: 'Healthy', tone: 'success' }
}
export function accountStatus(enforcement: string | null | undefined): { label: string; tone: Tone } {
  switch (enforcement?.toUpperCase()) {
    case 'HEALTHY': return { label: 'Healthy', tone: 'success' }
    case 'PROBATION': return { label: 'Probation', tone: 'warning' }
    case 'SHUTDOWN': return { label: 'Shutdown', tone: 'danger' }
    default: return { label: 'Unknown', tone: 'neutral' }
  }
}
export const ratePercent = (value: number | null | undefined) => value == null ? '—' : `${(value * 100).toFixed(2)}%`
