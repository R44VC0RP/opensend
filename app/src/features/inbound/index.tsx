import { Navigate, useLocation, useParams } from 'react-router'

export { InboundPage } from './threads'
export { InboundAddressDetailPage, InboundAddressesPage } from './addresses'
export { InboundWebhookDetailPage, InboundWebhooksPage } from './webhooks'

// Former /mailboxes links keep working: a mailbox is now an address filter on the thread-first Inbound view.
function LegacyRedirect({ to, address }: { to: string; address?: string }) {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  if (address) search.set('address', address)
  const query = search.toString()
  return <Navigate replace to={`${to}${query ? `?${query}` : ''}${location.hash}`} />
}
export const LegacyMailboxesRedirect = () => <LegacyRedirect to="/inbound/addresses" />
export function LegacyMailboxRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to="/inbound" address={id} /> }
export const LegacyMailboxWebhooksRedirect = () => <LegacyRedirect to="/inbound/webhooks" />
export function LegacyMailboxWebhookRedirect() { const { id = '' } = useParams(); return <LegacyRedirect to={`/inbound/webhooks/${encodeURIComponent(id)}`} /> }
