import type { InboundAddress, MailAddress } from '../../data/types'

export const nameOf = (value: MailAddress) => value.name || value.address.split('@')[0]!
export const full = (value: MailAddress) => value.name ? `${value.name} <${value.address}>` : value.address
export const addressName = (addresses: Map<string, InboundAddress>, id: string) => addresses.get(id)?.address ?? id
export function when(value: string) {
  const at = new Date(value), now = new Date()
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** Reuse one Idempotency-Key while the operator retries the same payload; a changed payload gets a new key. */
export function idempotencyFor(state: { key: string; body: string }, body: unknown) {
  const next = JSON.stringify(body)
  if (state.body !== next) { state.key = crypto.randomUUID(); state.body = next }
  return state.key
}
