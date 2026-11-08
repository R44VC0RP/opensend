import { connectionApi } from './connections'
import type { InboundThreadView, OpenSendApi, PageRequest, Stream, TimeRange } from './types'
import { workspaceApi } from './workspaces'

// The first-screen queries of the sidebar pages, defined once: a page reads them through useApiDef and
// data/prefetch.ts warms the very same keys and readers before the page is opened.
export type QueryDef<T> = { key: readonly unknown[]; read: (api: OpenSendApi, signal: AbortSignal) => Promise<T> }
const def = <T>(key: readonly unknown[], read: QueryDef<T>['read']): QueryDef<T> => ({ key, read })

export const queries = {
  overview: (regionId: string, range: TimeRange, stream: Stream | 'all') => def(['overview', regionId, range, stream], (api, signal) => api.overview.get({ regionId, range, stream: stream === 'all' ? undefined : stream }, signal)),
  emails: (params: PageRequest) => def(['emails', params], (api, signal) => api.emails.list(params, signal)),
  inboundDomains: () => def(['mailbox-domains'], (api, signal) => api.mailboxes.domains(signal)),
  inboundWebhooks: () => def(['inbound-webhooks'], (api, signal) => api.inbound.webhooks(signal)),
  inboundAddressOptions: () => def(['inbound-addresses', 'options'], (api, signal) => api.inbound.addresses({}, signal)),
  inboundThreads: (addressId: string | undefined, view: InboundThreadView, q: string, cursor: string | undefined) => def(['inbound-threads', addressId ?? null, view, q, cursor ?? null], (api, signal) => api.inbound.threads({ addressId, view, q: q || undefined, cursor }, signal)),
  campaigns: (request: PageRequest & { archived?: boolean }) => def(['campaigns', request], (api, signal) => api.campaigns.list(request, signal)),
  contacts: (params: PageRequest) => def(['contacts', params], (api, signal) => api.contacts.list(params, signal)),
  audienceLists: (search = '', cursor?: string) => def(['lists', 'options', { pageSize: 100, search, cursor }], async (api, signal) => {
    const page = await api.lists.list({ pageSize: 100, search, cursor, counts: false }, signal)
    return Object.assign(page.items, { nextCursor: page.nextCursor ?? null })
  }),
  domains: (regionId: string, page: number) => def(['domains', regionId, page], (api, signal) => api.domains.list({ regionId, page, pageSize: 10 }, signal)),
  keys: (cursor: string | undefined, showRevoked: boolean) => def(['keys', cursor, showRevoked], (api, signal) => api.keys.list(signal, cursor, showRevoked)),
  agentTokens: (showRevoked: boolean) => def(['agent-tokens', showRevoked], (api, signal) => api.credentials.agentTokens(showRevoked, signal)),
  mcpConnections: () => def(['mcp-connections'], (api, signal) => api.credentials.mcpConnections(signal)),
  mailboxKeys: (showRevoked: boolean) => def(['mailbox-keys', showRevoked], (api, signal) => api.mailboxes.keys(showRevoked, signal)),
  webhooks: (cursor?: string) => def(['webhooks', cursor], (api, signal) => api.webhooks.list(signal, cursor)),
  connection: () => def(['connection'], (_api, signal) => connectionApi.get(signal)),
  workspaces: () => def(['workspaces'], (_api, signal) => workspaceApi.list(signal)),
  workspaceMembers: () => def(['workspace-members'], (_api, signal) => workspaceApi.members(signal)),
  workspaceInvitations: () => def(['workspace-invitations'], (_api, signal) => workspaceApi.invitations(signal)),
}
