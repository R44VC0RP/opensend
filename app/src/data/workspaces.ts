import { request } from './live'
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceMembership, WorkspaceRole } from './types'

// Multi-tenant workspace administration. Only reachable when /v1/me reports multiTenant.
const current = '/v1/workspaces/current'
export const workspaceApi = {
  list: async (signal?: AbortSignal) => (await request<{ data: WorkspaceMembership[] }>('/v1/workspaces', { signal })).data,
  create: (name: string) => request<WorkspaceMembership>('/v1/workspaces', { method: 'POST', body: { name } }),
  rename: (name: string) => request<WorkspaceMembership>(current, { method: 'PATCH', body: { name } }),
  members: async (signal?: AbortSignal) => (await request<{ data: WorkspaceMember[] }>(`${current}/members`, { signal })).data,
  updateMember: (id: string, role: WorkspaceRole) => request<{ id: string; role: WorkspaceRole }>(`${current}/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role } }),
  removeMember: (id: string) => request(`${current}/members/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  invitations: async (signal?: AbortSignal) => (await request<{ data: WorkspaceInvitation[] }>(`${current}/invitations`, { signal })).data,
  invite: (input: { email: string; role: WorkspaceRole }) => request<WorkspaceInvitation>(`${current}/invitations`, { method: 'POST', body: input }),
  revokeInvitation: (id: string) => request(`${current}/invitations?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
export const roleLabel: Record<WorkspaceRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }
