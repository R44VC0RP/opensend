import { Navigate, useLocation, useParams } from 'react-router'

export { InboundPage } from './threads'
export { InboundAddressDetailPage } from './addresses'
export { ReceivingPage } from './receiving'
export { InboundWebhookDetailPage, InboundWebhooksPage } from './webhooks'

// Former /mailboxes links keep working: a mailbox is now an address filter on the thread-first inbox.
function LegacyRedirect({ to, address }: { to: string; address?: string }) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  if (address) search.set('address', address)
  const query = search.toString()
  return <Navigate replace to={`${to}${query ? `?${query}` : ''}${location.hash}`} />
}
export const LegacyMailboxesRedirect = () => <LegacyRedirect to="/receiving" />
export function LegacyMailboxRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to="/receiving/inbox" address={id} /> }
export const LegacyMailboxWebhooksRedirect = () => <LegacyRedirect to="/receiving/webhooks" />
export function LegacyMailboxWebhookRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to={`/receiving/webhooks/${encodeURIComponent(id)}`} /> }
