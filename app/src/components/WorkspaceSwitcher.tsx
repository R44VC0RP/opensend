import { useState } from 'react'
import { useLocation } from 'react-router'
import { useApiDef, useSession } from '../data/context'
import { queries } from '../data/queries'
import { Select, useToast } from './ui'

// Multi-tenant only. Shown in the dashboard sidebar and the onboarding header.
export function WorkspaceSwitcher() {
  const session = useSession()
  const toast = useToast()
  const location = useLocation()
  const workspaces = useApiDef(queries.workspaces())
  const [switching, setSwitching] = useState(false)
  async function changeWorkspace(id: string) {
    // Detail routes belong to the previous workspace; keep only the section.
    const [section, child] = location.pathname.split('/').filter(Boolean)
    const path = (section === 'audience' && ['lists', 'segments'].includes(child)) || (section === 'campaigns' && child === 'templates') ? `/${section}/${child}` : section ? `/${section}` : '/'
    setSwitching(true)
    try { await session?.switchWorkspace(id, path) }
    catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t switch workspace.', 'error'); setSwitching(false) }
  }
  return <Select id="sidebar-workspace" aria-label="Workspace" value={session?.identity?.workspaceId ?? ''} onValueChange={id => void changeWorkspace(id)} options={(workspaces.data ?? []).map(workspace => ({ value: workspace.id, label: workspace.name }))} disabled={switching || workspaces.isPending} placeholder={workspaces.isPending ? 'Loading workspaces…' : 'Workspace'} />
}
