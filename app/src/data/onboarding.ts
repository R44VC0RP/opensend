import { useSyncExternalStore } from 'react'
import type { Identity } from './types'

// The add-domain and agent steps follow a fresh connection until the user continues to the dashboard.
// Stored per workspace so a reload returns to the same step: '' before a domain is added, then its ID,
// then `agent:<ID>` once the user continues to the agent setup.
const stepKey = (workspaceId: string) => `opensend.onboarding.domain.${workspaceId}`
const listeners = new Set<() => void>()
const memory = new Map<string, string | null>()
export function readDomainStep(workspaceId: string) {
  if (memory.has(workspaceId)) return memory.get(workspaceId)!
  try { return localStorage.getItem(stepKey(workspaceId)) } catch { return null }
}
export function setDomainStep(workspaceId: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(stepKey(workspaceId)); else localStorage.setItem(stepKey(workspaceId), value) } catch { /* Step can remain in memory only. */ }
  memory.set(workspaceId, value)
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useDomainStep(workspaceId: string | undefined) {
  return useSyncExternalStore(subscribe, () => workspaceId ? readDomainStep(workspaceId) : null)
}

// Hosted workspaces need a ready sending connection (summarised in /v1/me) before the dashboard opens.
export type OnboardingStage = { step: 'sending' } | { step: 'setup-required' } | { step: 'domain'; domainId: string } | { step: 'agent'; domainId: string } | null
const agentPrefix = 'agent:'
export const agentStep = (domainId: string) => `${agentPrefix}${domainId}`
export function onboardingStage(identity: Identity | null | undefined, domainStep: string | null): OnboardingStage {
  if (!identity?.multiTenant) return null
  const admin = identity.role === 'owner' || identity.role === 'admin'
  if (identity.connection?.state !== 'ready') return { step: admin ? 'sending' : 'setup-required' }
  if (!admin || domainStep === null) return null
  return domainStep.startsWith(agentPrefix) ? { step: 'agent', domainId: domainStep.slice(agentPrefix.length) } : { step: 'domain', domainId: domainStep }
}
export const identityOnboardingStage = (identity: Identity | null | undefined) => onboardingStage(identity, identity ? readDomainStep(identity.workspaceId) : null)

// Remembers which workspace last opened the dashboard, so boot only prefetches dashboard data
// alongside /v1/me when that workspace is unlikely to need onboarding.
const readyKey = 'opensend.dashboard-ready'
const readyValue = (workspaceId: string | null) => workspaceId ?? '*'
export function rememberDashboardReady(workspaceId: string | null, ready: boolean) {
  try { if (ready) localStorage.setItem(readyKey, readyValue(workspaceId)); else if (localStorage.getItem(readyKey) === readyValue(workspaceId)) localStorage.removeItem(readyKey) } catch { /* Boot then waits for /v1/me. */ }
}
export function dashboardLikelyReady(workspaceId: string | null) {
  try { return localStorage.getItem(readyKey) === readyValue(workspaceId) } catch { return false }
}
