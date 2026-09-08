import { createContext, useContext, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createMockApi } from './mock'
import type { OpenSendApi } from './types'
import { useToast } from '../components/ui'

const ApiContext = createContext<OpenSendApi | null>(null)
export function ApiProvider({ children, api }: { children: ReactNode; api?: OpenSendApi }) {
  const [client] = useState(() => api ?? createMockApi())
  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>
}
export function useApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider is required')
  return api
}
export function useApiQuery<T>(key: readonly unknown[], read: (api: OpenSendApi, signal: AbortSignal) => Promise<T>) {
  const api = useApi()
  return useQuery({ queryKey: ['opensend', ...key], queryFn: ({ signal }) => read(api, signal) })
}
export function useApiMutation<TInput, TResult>(write: (api: OpenSendApi, input: TInput) => Promise<TResult>, successMessage?: string) {
  const api = useApi()
  const client = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: (input: TInput) => write(api, input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['opensend'] })
      if (successMessage) toast(successMessage, 'success')
    },
  })
}

const RegionContext = createContext<{ regionId: string; setRegionId: (id: string) => void } | null>(null)
export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegion] = useState(() => {
    try { return localStorage.getItem('opensend.region') || 'us-east-1' } catch { return 'us-east-1' }
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
