import { useState } from 'react'
import { useLocation } from 'react-router'
import { useApiQuery, useSession } from '../data/context'
import { workspaceApi } from '../data/workspaces'
import { Select, useToast } from './ui'

// Multi-tenant only. Shown in the dashboard sidebar and the onboarding header.
export function WorkspaceSwitcher() {
  const session = useSession()
  const toast = useToast()
  const location = useLocation()
  const workspaces = useApiQuery(['workspaces'], (_api, signal) => workspaceApi.list(signal))
  const [switching, setSwitching] = useState(false)
  async function changeWorkspace(id: string) {
    // Detail routes belong to the previous workspace; keep only the section.
    const [section, child] = location.pathname.split('/').filter(Boolean)
    const path = section === 'settings' && child === 'workspace' ? '/settings/workspace' : section ? `/${section}` : '/'
    setSwitching(true)
    try { await session?.switchWorkspace(id, path) }
    catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t switch workspace.', 'error'); setSwitching(false) }
  }
  return <Select id="sidebar-workspace" aria-label="Workspace" value={session?.identity?.workspaceId ?? ''} onValueChange={id => void changeWorkspace(id)} options={(workspaces.data ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))} disabled={switching || workspaces.isPending} placeholder={workspaces.isPending ? 'Loading workspaces…' : 'Workspace'} />
}
