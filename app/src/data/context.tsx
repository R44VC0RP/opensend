import { createContext, useContext, useState, useMemo, useEffect, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createMockApi } from './mock'
import { ApiError, type Identity, type OpenSendApi } from './types'
import { createLiveApi, request } from './live'
import { Alert, Button, PageHeader, useToast } from '../components/ui'

const ApiContext = createContext<OpenSendApi | null>(null)
const SessionContext = createContext<{ identity: Identity | null; environment: 'live' | 'test'; setEnvironment: (value: 'live' | 'test') => void; logout: () => Promise<void> } | null>(null)
export const useSession = () => useContext(SessionContext)
export function ApiProvider({ children, api }: { children: ReactNode; api?: OpenSendApi }) {
  const [environment, setSelected] = useState<'live' | 'test'>(() => {
    try { return sessionStorage.getItem('opensend.environment') === 'test' ? 'test' : 'live' }
    catch { return 'live' }
  })
  const [provided] = useState(() => api ?? (import.meta.env.VITE_DEMO_MODE === 'true' ? createMockApi() : null))
  const client = useMemo(() => provided ?? createLiveApi(environment), [provided, environment])
  const cache = useQueryClient()
  const [authError, setAuthError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const identity = useQuery({ queryKey: ['identity', environment], enabled: client.mode !== 'demo', retry: false, queryFn: async ({signal}) => {
    await request('/api/auth/get-session', {signal})
    return request<Identity>('/v1/me', {signal, environment})
  } })
  useEffect(() => { const denied = () => { cache.clear(); void identity.refetch() }; window.addEventListener('opensend:unauthorized', denied); return () => window.removeEventListener('opensend:unauthorized', denied) }, [cache, environment])
  function setEnvironment(value: 'live' | 'test') {
    if (value !== environment) {
      try { sessionStorage.setItem('opensend.environment', value) } catch { /* Keep the explicit choice for this page if storage is unavailable. */ }
      cache.clear(); setSelected(value)
    }
  }
  async function logout() { setAuthError(null); try { await request('/api/auth/sign-out', {method: 'POST', body: {}}); cache.clear(); await identity.refetch() } catch (error) { setAuthError(error) } }
  async function login() {
    setBusy(true); setAuthError(null)
    try { const result = await request<{url: string}>('/api/auth/sign-in/social', {method: 'POST', body: {provider: 'google', callbackURL: window.location.origin, errorCallbackURL: `${window.location.origin}/?auth=error`}}); const url = new URL(result.url); if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Invalid Google sign-in redirect.'); window.location.assign(url.href) }
    catch (error) { setAuthError(error); setBusy(false) }
  }
  const error = authError ?? identity.error
  const unconfigured = error instanceof ApiError && error.code === 'AUTH_NOT_CONFIGURED'
  return <ApiContext.Provider key={environment} value={client}><SessionContext.Provider value={{identity: identity.data ?? null, environment, setEnvironment, logout}}>{client.mode === 'demo' || (identity.data && !identity.isError) ? <>{authError && <Alert tone="danger">{String(authError)}</Alert>}{children}</> : <main className="page-surface"><PageHeader title="OpenSend" /><div className="stack" style={{maxWidth: 520}}>{identity.isPending ? <p role="status">Checking Google session…</p> : <><h2>Sign in with Google</h2>{unconfigured ? <Alert tone="warning">Google sign-in is not configured. The deployment operator must configure the Google OAuth client, auth secret, public URL, and approved identities.</Alert> : error && !(error instanceof ApiError && error.status === 401) ? <Alert tone="danger">{error instanceof Error ? error.message : 'Sign-in is unavailable.'}</Alert> : null}{new URLSearchParams(window.location.search).get('auth') === 'error' && <Alert tone="danger">Google sign-in was not completed. Use an approved Google identity.</Alert>}<Button variant="primary" disabled={unconfigured} loading={busy} onClick={login}>Continue with Google</Button><Button onClick={() => identity.refetch()}>Check session again</Button></>}</div></main>}</SessionContext.Provider></ApiContext.Provider>
}
export function useApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider is required')
  return api
}
export function useApiQuery<T>(key: readonly unknown[], read: (api: OpenSendApi, signal: AbortSignal) => Promise<T>) {
  const api = useApi()
  return useQuery({ queryKey: ['opensend', api.mode, api.environment, ...key], queryFn: ({ signal }) => read(api, signal) })
}
export function useApiMutation<TInput, TResult>(write: (api: OpenSendApi, input: TInput) => Promise<TResult>, successMessage?: string, refreshSes = false) {
  const api = useApi()
  const client = useQueryClient()
  const toast = useToast()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: TInput) => write(api, input),
    onSuccess: () => {
      const external = new Set(['regions', 'domain', 'domains', 'campaign-options'])
      void client.invalidateQueries({predicate: query => query.queryKey[0] === 'opensend' && (refreshSes || !external.has(String(query.queryKey[3])))}).catch(() => {})
      if (!refreshSes) void client.invalidateQueries({predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[3] === 'campaign-options', refetchType: 'none'}).catch(() => {})
      if (successMessage) toast(successMessage, 'success')
    },
  })
}

const RegionContext = createContext<{ regionId: string; setRegionId: (id: string) => void } | null>(null)
export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegion] = useState(() => {
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
