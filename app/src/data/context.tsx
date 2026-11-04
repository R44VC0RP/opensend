import { createContext, lazy, Suspense, useContext, useState, useMemo, useEffect, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createMockApi } from './mock'
import { ApiError, type Identity, type OpenSendApi } from './types'
import { createLiveApi, request, selectedWorkspace, selectWorkspace } from './live'
import { regionCatalogKey } from './regions'
import { dashboardLikelyReady, identityOnboardingStage, useDomainStep, onboardingStage } from './onboarding'
import { Alert, Button, PageHeader, useToast } from '../components/ui'
import { BootLoader } from '../components/BootLoader'

type Session = { identity: Identity | null; logout: () => Promise<void>; switchWorkspace: (id: string, path?: string) => Promise<void>; notice: string | null; dismissNotice: () => void }
const HomePage = lazy(() => import('../features/home').then(m => ({ default: m.HomePage })))
const ApiContext = createContext<OpenSendApi | null>(null)
const SessionContext = createContext<Session | null>(null)
export const useSession = () => useContext(SessionContext)
// Self-hosted installations have no workspace roles; every signed-in operator administers.
export function useWorkspaceAccess() {
  const identity = useContext(SessionContext)?.identity
  const multiTenant = identity?.multiTenant === true
  const role = multiTenant ? identity?.role ?? null : null
  return { multiTenant, role, canAdminister: !multiTenant || role === 'owner' || role === 'admin' }
}
// What the current workspace still needs before the dashboard opens; null when it can open.
export function useOnboardingStage() {
  const identity = useContext(SessionContext)?.identity
  return onboardingStage(identity, useDomainStep(identity?.workspaceId))
}
function invitationError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This invitation is invalid, expired or for a different email address. Ask for a new invitation.'
  return `Couldn’t accept the invitation. ${error instanceof Error ? error.message : 'Try the link again.'}`
}
export function ApiProvider({ children, api }: { children: ReactNode; api?: OpenSendApi }) {
  const publicRoute = window.location.pathname === '/docs'
  const [provided] = useState(() => api ?? (import.meta.env.VITE_DEMO_MODE === 'true' ? createMockApi() : null))
  // Bumped on workspace switches so clients, cursors and every mounted screen start fresh.
  const [generation, setGeneration] = useState(0)
  const client = useMemo(() => provided ?? createLiveApi(), [provided, generation])
  const cache = useQueryClient()
  const toast = useToast()
  const [authError, setAuthError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invitation, setInvitation] = useState(() => client.mode === 'demo' || publicRoute ? null : new URLSearchParams(window.location.search).get('invitation'))
  const accept = useQuery({
    queryKey: ['invitation', invitation], enabled: Boolean(invitation), retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async () => {
      try {
        const { workspaceId } = await request<{ workspaceId: string }>(`/v1/workspaces/invitations/${encodeURIComponent(invitation!)}/accept`, { method: 'POST', body: {} })
        selectWorkspace(workspaceId)
        toast('Invitation accepted', 'success')
      } catch (error) {
        // Signed out: keep the link so sign-in returns here and accepts it.
        if (error instanceof ApiError && error.status === 401) return 'signed-out'
        setNotice(invitationError(error))
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('invitation')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
      setInvitation(null)
      return 'done'
    },
  })
  const identity = useQuery({
    queryKey: ['identity'], enabled: client.mode !== 'demo' && !publicRoute && (!invitation || accept.isFetched),
    networkMode: 'always', refetchOnReconnect: true,
    retry: (failures, error) => failures < 1 && error instanceof ApiError && error.code !== 'AUTH_NOT_CONFIGURED' && (error.code === 'NETWORK_UNAVAILABLE' || (error.status ?? 0) >= 500),
    queryFn: async ({signal}) => {
      const started = performance.now()
      let result: Identity
      try { result = await request<Identity>('/v1/me', {signal}) }
      catch (error) {
        // A remembered workspace the user no longer belongs to: fall back to the server's choice.
        if (!(error instanceof ApiError && error.code === 'WORKSPACE_ACCESS_DENIED' && selectedWorkspace())) throw error
        selectWorkspace(null)
        result = await request<Identity>('/v1/me', {signal})
      }
      selectWorkspace(result.multiTenant ? result.workspaceId : null)
      console.info('[OpenSend timing] Google session ready', { durationMs: Number((performance.now() - started).toFixed(1)) })
      return result
    },
  })
  async function switchWorkspace(id: string, path?: string) {
    const previous = selectedWorkspace()
    if (id === previous) return
    await cache.cancelQueries()
    selectWorkspace(id)
    let next: Identity
    try { next = await request<Identity>('/v1/me') }
    catch (error) { selectWorkspace(previous); throw error }
    // Nothing from the previous workspace may remain visible or cached.
    cache.clear()
    cache.setQueryData(['identity'], next)
    if (path) window.history.pushState(null, '', path)
    setGeneration(value => value + 1)
  }
  // Load the region catalog alongside /v1/me rather than after it; the shell reuses this cache entry.
  // An invitation link selects its workspace first, so wait until it is accepted. Workspaces that may
  // still need onboarding wait for /v1/me, so onboarding never starts dashboard requests.
  useEffect(() => {
    if (client.mode === 'demo' || publicRoute || invitation || window.location.pathname === '/onboarding' || !dashboardLikelyReady(selectedWorkspace())) return
    void cache.prefetchQuery({ queryKey: regionCatalogKey(client), queryFn: ({ signal }) => client.regions.list(signal), staleTime: 30_000 })
  }, [cache, client, publicRoute, invitation])
  useEffect(() => {
    if (!identity.data || client.mode === 'demo' || identityOnboardingStage(identity.data)) return
    const match = window.location.pathname.match(/^\/campaigns\/([^/]+)\/(?:edit|review)$/)
    if (!match) return
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { return }
    void cache.prefetchQuery({ queryKey: ['opensend', client.mode, 'campaign', id], queryFn: ({ signal }) => client.campaigns.get(id, signal), staleTime: 30_000 })
  }, [cache, client, identity.data])
  // Before a session is known, a 401 from the boot prefetch is answered by /v1/me itself.
  useEffect(() => { const denied = () => { if (!publicRoute && cache.getQueryData(['identity']) === undefined) return; cache.clear(); void identity.refetch() }; window.addEventListener('opensend:unauthorized', denied); return () => window.removeEventListener('opensend:unauthorized', denied) }, [cache])
  async function logout() { setAuthError(null); try { await request('/api/auth/sign-out', {method: 'POST', body: {}}); selectWorkspace(null); cache.clear(); await identity.refetch() } catch (error) { setAuthError(error) } }
  async function login() {
    setBusy(true); setAuthError(null)
    try {
      // Assign path components rather than resolving an untrusted redirect parameter.
      const callback = new URL(window.location.origin)
      callback.pathname = window.location.pathname
      callback.search = window.location.search
      callback.hash = window.location.hash
      callback.searchParams.delete('auth')
      const errorCallback = new URL(callback)
      errorCallback.searchParams.set('auth', 'error')
      const result = await request<{url: string}>('/api/auth/sign-in/social', {method: 'POST', body: {provider: 'google', callbackURL: callback.href, errorCallbackURL: errorCallback.href}})
      const url = new URL(result.url)
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Invalid Google sign-in redirect.')
      window.location.assign(url.href)
    }
    catch (error) { setAuthError(error); setBusy(false) }
  }
  const signedOut = identity.error instanceof ApiError && identity.error.status === 401 && identity.error.code === 'AUTH_REQUIRED'
  const unconfigured = identity.error instanceof ApiError && identity.error.code === 'AUTH_NOT_CONFIGURED'
  // Multi-tenant installations greet signed-out visitors at "/" with the public homepage; /health says which this is.
  const home = useQuery({ queryKey: ['public-home'], enabled: signedOut && window.location.pathname === '/', staleTime: Infinity, retry: false, queryFn: ({signal}) => request<{multiTenant?: boolean} | null>('/health', {signal}).then(health => health?.multiTenant === true) })
  const authNotice = authError ? <Alert tone="danger">{String(authError)}</Alert> : new URLSearchParams(window.location.search).get('auth') === 'error' && <Alert tone="danger">Google sign-in was not completed.</Alert>
  return <ApiContext.Provider key={generation} value={client}><SessionContext.Provider value={{identity: identity.data ?? null, logout, switchWorkspace, notice, dismissNotice: () => setNotice(null)}}>
    {publicRoute || client.mode === 'demo' || (identity.data && !identity.isError) ? <>{authError && <Alert tone="danger">{String(authError)}</Alert>}{children}</> : identity.isPending || home.isLoading ? <BootLoader /> : signedOut && home.data ? <Suspense fallback={null}><HomePage onSignIn={login} busy={busy} notice={authNotice} /></Suspense> : <main className="page-surface"><PageHeader title="OpenSend" /><div className="stack" style={{maxWidth: 520}}>
      {signedOut ? <>
        <h2>Sign in with Google</h2>
        {authNotice}
        <Button variant="primary" loading={busy} onClick={login}>Continue with Google</Button>
      </> : <>
        <h2>Couldn’t check your session</h2>
        <Alert tone="warning">{unconfigured ? 'Google sign-in is not configured on this installation.' : 'OpenSend couldn’t verify your session. Try again without signing in.'}</Alert>
      </>}
      <Button loading={identity.isFetching} onClick={() => void identity.refetch()}>Check session again</Button>
    </div></main>}
  </SessionContext.Provider></ApiContext.Provider>
}
export function useApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider is required')
  return api
}
// Polling is opt-in and foreground-only; pass a function to poll only while the data is in progress.
export function useApiQuery<T>(key: readonly unknown[], read: (api: OpenSendApi, signal: AbortSignal) => Promise<T>, poll?: { interval?: number | ((data: T | undefined) => number | false); enabled?: boolean }) {
  const api = useApi()
  const interval = poll?.interval
  return useQuery({ queryKey: ['opensend', api.mode, ...key], queryFn: ({ signal }) => read(api, signal), enabled: poll?.enabled, refetchInterval: typeof interval === 'function' ? query => interval(query.state.data) : interval ?? false, refetchIntervalInBackground: false })
}
export function useApiMutation<TInput, TResult>(write: (api: OpenSendApi, input: TInput) => Promise<TResult>, successMessage?: string, refreshSes = false, invalidate = true) {
  const api = useApi()
  const client = useQueryClient()
  const toast = useToast()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: TInput) => write(api, input),
    onSuccess: () => {
      if (successMessage) toast(successMessage, 'success')
      if (!invalidate) return
      const external = new Set(['regions', 'region-discovery', 'domain', 'domains', 'campaign-options'])
      void client.invalidateQueries({predicate: query => query.queryKey[0] === 'opensend' && (refreshSes || !external.has(String(query.queryKey[3])))}).catch(() => {})
      if (!refreshSes) void client.invalidateQueries({predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[3] === 'campaign-options', refetchType: 'none'}).catch(() => {})
    },
  })
}

const RegionContext = createContext<{ regionId: string; setRegionId: (id: string) => void } | null>(null)
export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegion] = useState(() => {
    const linked = new URLSearchParams(window.location.search).get('region')
    if (linked && /^[a-z0-9-]{1,40}$/.test(linked)) return linked
    try { return localStorage.getItem('opensend.region') || '' } catch { return '' }
  })
  function setRegionId(id: string) {
    setRegion(id)
    try { localStorage.setItem('opensend.region', id) } catch { /* Selection can remain session-only. */ }
  }
  return <RegionContext.Provider value={{ regionId, setRegionId }}>{children}</RegionContext.Provider>
}
export function useRegion() {
  const region = useContext(RegionContext)
  if (!region) throw new Error('RegionProvider is required')
  return region
}
