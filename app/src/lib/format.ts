export const number = (value: number | undefined | null) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US').format(value)
export const percent = (value: number, digits = 2) => new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
export function date(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', options ?? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(parsed)
}
export const time = (value: string) => date(value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
export function shortDateTime(value: string) {
  const sameYear = new Date(value).getUTCFullYear() === new Date().getUTCFullYear()
  return date(value, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })
}
export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
export const formatNumber = number
export const formatPercent = percent
export const formatDate = date
export const formatTime = time
// Coarse, human-readable distance from now ("in 5 hours", "2 minutes ago"); best for estimates, not exact times.
export function relativeTime(value: string | null | undefined, now = Date.now()) {
  const at = Date.parse(value ?? '')
  if (!Number.isFinite(at)) return '—'
  const ms = at - now
  const abs = Math.abs(ms)
  if (abs < 60_000) return ms >= 0 ? 'in under a minute' : 'just now'
  const format = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
  if (abs < 3_600_000) return format.format(Math.round(ms / 60_000), 'minute')
  if (abs < 172_800_000) return format.format(Math.round(ms / 3_600_000), 'hour')
  return format.format(Math.round(ms / 86_400_000), 'day')
}
