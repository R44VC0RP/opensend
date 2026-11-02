import type { InboundAddress, InboundRecipients, MailAddress } from '../data/types'

type Original = { direction: 'inbound' | 'outbound'; from: MailAddress; to: MailAddress[]; cc: MailAddress[]; replyTo: MailAddress[] }

/** Every address the sending address owns: receiving address, aliases and its send-only public address. */
export const ownAddressesOf = (address: Pick<InboundAddress, 'address' | 'aliases' | 'publicAddress'>) =>
  new Set([address.address, ...address.aliases, ...(address.publicAddress ? [address.publicAddress] : [])].map(value => value.toLowerCase()))

/** The visible default From: the public address when configured, otherwise the receiving address. */
export const senderOf = (address: Pick<InboundAddress, 'address' | 'displayName' | 'publicAddress'>): MailAddress => ({ name: address.displayName, address: address.publicAddress ?? address.address })

// Mirrors the API's reply resolution so the operator reviews the exact recipients it will check (expectedRecipients).
export function replyRecipients(original: Original, own: Set<string>, replyAll: boolean): InboundRecipients {
  const list = (values: MailAddress[]) => values.map(value => value.address.toLowerCase()).filter(value => !own.has(value))
  const to = [...new Set(original.direction === 'outbound' ? list(original.to) : list(original.replyTo.length ? original.replyTo : [original.from]))]
  const cc = replyAll ? [...new Set([...(original.direction === 'outbound' ? [] : list(original.to)), ...list(original.cc)])].filter(value => !to.includes(value)) : []
  return { to, cc, bcc: [] }
}
