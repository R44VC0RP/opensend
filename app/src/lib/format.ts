export const number = (value: number) => new Intl.NumberFormat('en-US').format(value)
export const percent = (value: number, digits = 2) => new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
export function date(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return new Intl.DateTimeFormat('en-US', options ?? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(parsed)
}
export const time = (value: string) => date(value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())
export const formatNumber = number
export const formatPercent = percent
export const formatDate = date
export const formatTime = time
