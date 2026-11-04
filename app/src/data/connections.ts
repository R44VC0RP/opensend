import { useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { request } from './live'
import { useApi, useSession } from './context'
import type { ConnectionKind, Identity, ProviderConnection } from './types'

// Multi-tenant sending connection. Owner/admin dashboard sessions only.
const path = '/v1/connection'
export const connectionApi = {
  get: async (signal?: AbortSignal) => (await request<{ connection: ProviderConnection | null }>(path, { signal })).connection,
  regions: (signal?: AbortSignal) => request<{ shared: string[]; byo: string[] }>(`${path}/regions`, { signal }),
  create: (input: { kind: ConnectionKind; region: string }) => request<ProviderConnection>(path, { method: 'POST', body: input }),
  verify: (awsAccountId: string) => request<ProviderConnection>(`${path}/verify`, { method: 'POST', body: { awsAccountId } }),
  remove: () => request<{ deleted: true }>(path, { method: 'DELETE' }),
}
export const connectionKindLabel: Record<ConnectionKind, string> = { shared: 'Hosted mail', byo: 'Your AWS account' }
// AWS still confirming a bring-your-own setup; repeating the verify request resumes it.
export const retryableConnectionErrors = new Set(['CONNECTION_BUSY', 'SNS_CONFIRMATION_PENDING', 'PROVISIONING_INCOMPLETE', 'AWS_SETUP_TIMEOUT', 'AWS_THROTTLED'])
// Keeps the full connection and the /v1/me summary (which gates the app) in step.
export function useConnectionCache() {
  const api = useApi()
  const client = useQueryClient()
  const environment = useSession()?.environment ?? 'live'
  return (connection: ProviderConnection | null) => {
    client.setQueryData(['opensend', api.mode, api.environment, 'connection'], connection)
    client.setQueryData<Identity>(['identity', environment], old => old && { ...old, connection: connection && { kind: connection.kind, region: connection.region, status: connection.status } })
  }
}

// The add-domain step follows a fresh connection until the user continues to the dashboard.
// Stored per workspace so a reload returns to the same records: '' before a domain is added, else its ID.
const stepKey = (workspaceId: string) => `opensend.onboarding.domain.${workspaceId}`
const listeners = new Set<() => void>()
const memory = new Map<string, string | null>()
function readStep(workspaceId: string) { try { return localStorage.getItem(stepKey(workspaceId)) } catch { return null } }
export function setDomainStep(workspaceId: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(stepKey(workspaceId)); else localStorage.setItem(stepKey(workspaceId), value) } catch { /* Step can remain in memory only. */ }
  memory.set(workspaceId, value)
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useDomainStep(workspaceId: string | undefined) {
  return useSyncExternalStore(subscribe, () => !workspaceId ? null : memory.has(workspaceId) ? memory.get(workspaceId)! : readStep(workspaceId))
}
