import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi, useSession } from './context'
import { ApiError, type OpenSendApi, type RegionCatalog, type RegionCatalogEntry, type SesDiscovery } from './types'

export const regionCatalogKey = (api: OpenSendApi) => ['opensend', api.mode, api.environment, 'regions'] as const
export const regionDiscoveryKey = (api: OpenSendApi, region: string) => ['opensend', api.mode, 'live', 'region-discovery', region] as const
export const regionJobActive = (entry?: RegionCatalogEntry) => entry?.discoveryStatus === 'discovering' || entry?.provisionStatus === 'pending' || entry?.provisionStatus === 'running'

export function useRegionAccess() {
  const api = useApi()
  const session = useSession()
  const permissions = session?.identity?.permissions ?? []
  const canManage = api.mode === 'demo' || permissions.includes('manage')
  const canDiscover = canManage || permissions.includes('read')
  return { canManage, canDiscover, autoDiscover: canDiscover && (api.mode === 'demo' || api.environment === 'live') }
}

export function useRegionCatalog(options: { enabled?: boolean } = {}) {
  const api = useApi()
  return useQuery({
    queryKey: regionCatalogKey(api),
    queryFn: ({ signal }) => api.regions.list(signal),
    enabled: options.enabled,
    staleTime: 30_000,
    retry: false,
    refetchInterval: query => query.state.data?.data.some(regionJobActive) ? 2500 : false,
  })
}

export function useRegionDiscovery(entry: RegionCatalogEntry | undefined, options: { auto?: boolean } = {}) {
  const api = useApi()
  const access = useRegionAccess()
  const cache = useQueryClient()
  const region = entry?.region ?? ''
  const automatic = options.auto ?? access.autoDiscover
  const allowed = Boolean(entry?.enabled && access.canDiscover)
  const active = regionJobActive(entry)
  const query = useQuery({
    queryKey: regionDiscoveryKey(api, region),
    enabled: allowed && automatic && !active,
    queryFn: async ({ signal }) => {
      if (!allowed) throw new ApiError('Enable this region and use an unrestricted read or management identity to inspect SES.', 'REGION_DISCOVERY_UNAVAILABLE')
      const previous = cache.getQueryData<SesDiscovery>(regionDiscoveryKey(api, region))
      // A finished job is not readiness: SNS may still be confirming its HTTPS subscription.
      const refresh = !active && previous?.resources.topic.subscription === 'pending'
      const report = await api.regions.discover(region, { refresh }, signal)
      cache.setQueryData<RegionCatalog>(regionCatalogKey(api), current => current ? { ...current, data: current.data.map(row => row.region === region && (!row.lastDiscoveredAt || Date.parse(row.lastDiscoveredAt) <= Date.parse(report.checkedAt)) ? { ...row, discoveryStatus: report.status, lastDiscoveredAt: report.checkedAt } : row) } : current)
      return report
    },
    staleTime: 15 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => query.state.status === 'error' ? false : active ? 5000 : query.state.data?.resources.topic.subscription === 'pending' ? 15_000 : false,
  })
  useEffect(() => {
    if (allowed && automatic && entry?.discoveryStatus === 'stale') void cache.invalidateQueries({ queryKey: regionDiscoveryKey(api, region), exact: true })
  }, [allowed, automatic, entry?.discoveryStatus, entry?.lastDiscoveredAt, api, cache, region])
  // Job completion can replace the server's cached report before our 15-minute stale time.
  useEffect(() => {
    if (allowed && automatic && entry?.provisionJobId) void cache.invalidateQueries({ queryKey: regionDiscoveryKey(api, region), exact: true })
  }, [allowed, automatic, entry?.provisionJobId, entry?.provisionStatus, api, cache, region])
  return query
}
