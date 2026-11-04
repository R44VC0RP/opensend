import { useQueryClient } from '@tanstack/react-query'
import { request } from './live'
import { useApi } from './context'
import type { ConnectionKind, Identity, ProviderConnection } from './types'

// Multi-tenant sending connection. Owner/admin dashboard sessions only.
const path = '/v1/connection'
export const connectionApi = {
  get: async (signal?: AbortSignal) => (await request<{ connection: ProviderConnection | null }>(path, { signal })).connection,
  create: (input: { kind: ConnectionKind; region?: string }) => request<ProviderConnection>(path, { method: 'POST', body: input }),
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
  return (connection: ProviderConnection | null) => {
    client.setQueryData(['opensend', api.mode, 'connection'], connection)
    client.setQueryData<Identity>(['identity'], old => old && { ...old, connection: connection && { kind: connection.kind, region: connection.region, status: connection.status } })
  }
}
