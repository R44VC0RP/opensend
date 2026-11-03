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
export const connectionKindLabel: Record<ConnectionKind, string> = { shared: 'OpenSend shared sending', byo: 'Your AWS account' }
// Setup in progress elsewhere or AWS still confirming; repeating the request resumes it.
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
