import { request } from './live'
import type { ConnectionKind, ProviderConnection } from './types'

// Multi-tenant sending connection. Owner/admin dashboard sessions only.
const path = '/v1/connection'
export const connectionApi = {
  get: async (signal?: AbortSignal) => (await request<{ connection: ProviderConnection | null }>(path, { signal })).connection,
  create: (input: { kind: ConnectionKind; region: string }) => request<ProviderConnection>(path, { method: 'POST', body: input }),
  verify: (awsAccountId: string) => request<ProviderConnection>(`${path}/verify`, { method: 'POST', body: { awsAccountId } }),
  remove: () => request<{ deleted: true }>(path, { method: 'DELETE' }),
}
// The API does not list regions; shared sending launches in us-east-2.
export const sendingRegions = ['us-east-2']
export const connectionKindLabel: Record<ConnectionKind, string> = { shared: 'OpenSend shared sending', byo: 'Your AWS account' }
// Setup in progress elsewhere or AWS still confirming; repeating the request resumes it.
export const retryableConnectionErrors = new Set(['CONNECTION_BUSY', 'SNS_CONFIRMATION_PENDING', 'PROVISIONING_INCOMPLETE', 'AWS_SETUP_TIMEOUT', 'AWS_THROTTLED'])
