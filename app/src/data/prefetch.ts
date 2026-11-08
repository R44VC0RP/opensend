import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { rememberedPageSize } from '../lib/pagination'
import { useApi, useRegion, useWorkspaceAccess } from './context'
import { queries, type QueryDef } from './queries'
import type { OpenSendApi } from './types'

// A warmed result stays fresh this long, so repeated hovers and the idle sweep never refetch it.
const FRESH = 30_000
export const sidebarPaths = ['/', '/logs', '/receiving', '/campaigns', '/audience', '/domains', '/api-keys', '/settings'] as const
// Filled by App.tsx with each route's chunk preload.
export const routeChunks: Record<string, () => Promise<unknown>> = {}

type Scope = { regionId: string; multiTenant: boolean; canAdminister: boolean }
// The first screen of each page with its default filters: exactly what the page asks for when it opens.
function firstScreen(path: string, { regionId, multiTenant, canAdminister }: Scope): QueryDef<unknown>[] {
  const scoped = multiTenant || Boolean(regionId)
  switch (path) {
    case '/': return scoped ? [queries.overview(regionId, '24h', 'all')] : []
    case '/logs': { const pageSize = rememberedPageSize('logs'); return scoped && pageSize ? [queries.emails({ regionId, search: '', status: undefined, stream: undefined, page: 1, pageSize })] : [] }
    // Receiving domains and inbound webhooks are admin-only reads.
    case '/receiving': return [queries.inboundAddressOptions(), ...(canAdminister ? [queries.inboundDomains(), queries.inboundWebhooks()] : [])]
    case '/receiving/inbox': return [queries.inboundAddressOptions(), queries.inboundThreads(undefined, 'inbox', '', undefined)]
    case '/campaigns': return [queries.campaigns({ search: '', archived: false, status: undefined, page: 1, pageSize: 10 })]
    case '/audience': { const pageSize = rememberedPageSize('contacts'); return [queries.audienceLists(), ...(pageSize ? [queries.contacts({ page: 1, pageSize, search: '', status: '', listId: '' })] : [])] }
    // Self-hosted domain reads call SES for every identity (the list refreshes by default), so only hosted workspaces warm it.
    case '/domains': return multiTenant && canAdminister ? [queries.domains(regionId, 1)] : []
    case '/api-keys': return canAdminister ? [queries.keys(undefined, false), queries.agentTokens(false), queries.mcpConnections(), queries.mailboxKeys(false), queries.inboundAddressOptions()] : []
    // Self-hosted settings load their own region and workspace data.
    case '/settings': return !multiTenant ? [] : canAdminister ? [queries.connection(), queries.webhooks(), queries.workspaces(), queries.workspaceMembers(), queries.workspaceInvitations()] : [queries.workspaces()]
    default: return []
  }
}

export function prefetchQueries(cache: QueryClient, api: OpenSendApi, defs: QueryDef<unknown>[]) {
  return Promise.allSettled(defs.map(query => cache.prefetchQuery({ queryKey: ['opensend', api.mode, ...query.key], queryFn: ({ signal }) => query.read(api, signal), staleTime: FRESH })))
}

// Loads a sidebar page's code and warms its first-screen queries. GET only; queries already fresh or in flight are skipped.
export function usePrefetchRoute() {
  const cache = useQueryClient()
  const api = useApi()
  const { regionId } = useRegion()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  return useCallback(async (path: string) => {
    const chunk = routeChunks[path]?.().catch(() => {})
    const data = api.mode === 'live' ? prefetchQueries(cache, api, firstScreen(path, { regionId, multiTenant, canAdminister })) : undefined
    await Promise.all([chunk, data])
  }, [cache, api, regionId, multiTenant, canAdminister])
}

// Hover intent: a pointer that rests on a link for a moment (not one crossing it) or focuses/presses it starts the warm-up.
export function useRouteIntent() {
  const prefetchRoute = usePrefetchRoute()
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (path: string) => {
    const start = () => { window.clearTimeout(timer.current); void prefetchRoute(path) }
    return {
      onPointerEnter: () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void prefetchRoute(path), 80) },
      onPointerLeave: () => window.clearTimeout(timer.current),
      onPointerDown: start,
      onFocus: start,
    }
  }
}
