import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router'
import { useApiDef, useApiMutation, useSession } from '../data/context'
import { queries } from '../data/queries'
import { workspaceApi } from '../data/workspaces'
import { fieldError, MutationError } from '../features/settings/shared'
import { Button, Dialog, Field, Input, Select, useToast } from './ui'

const createValue = 'new-workspace'

// Multi-tenant only. Shown in the dashboard sidebar and the onboarding header.
export function WorkspaceSwitcher() {
  const session = useSession()
  const toast = useToast()
  const location = useLocation()
  const workspaces = useApiDef(queries.workspaces())
  const [switching, setSwitching] = useState(false)
  const [creating, setCreating] = useState(false)
  async function changeWorkspace(id: string, path?: string) {
    // Detail routes belong to the previous workspace; keep only the section.
    const [section, child] = location.pathname.split('/').filter(Boolean)
    path ??= (section === 'audience' && ['lists', 'segments'].includes(child)) || (section === 'campaigns' && child === 'templates') ? `/${section}/${child}` : section ? `/${section}` : '/'
    setSwitching(true)
    try { await session?.switchWorkspace(id, path) }
    catch (error) { toast(error instanceof Error ? error.message : 'Couldn’t switch workspace.', 'error'); setSwitching(false); void workspaces.refetch() }
  }
  const options = [...(workspaces.data ?? []).map(workspace => ({ value: workspace.id, label: workspace.name })), ...(workspaces.data ? [{ value: createValue, label: 'New workspace…' }] : [])]
  return <>
    <Select id="sidebar-workspace" aria-label="Workspace" value={session?.identity?.workspaceId ?? ''} onValueChange={id => { if (id === createValue) setCreating(true); else void changeWorkspace(id) }} options={options} disabled={switching || workspaces.isPending} placeholder={workspaces.isPending ? 'Loading workspaces…' : 'Workspace'} />
    {creating && <CreateWorkspaceDialog onClose={() => { setCreating(false); requestAnimationFrame(() => document.getElementById('sidebar-workspace')?.focus()) }} onCreated={id => void changeWorkspace(id, '/')} />}
  </>
}

// A new workspace starts like a new signup: switching to it opens onboarding.
function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const create = useApiMutation((_api, value: string) => workspaceApi.create(value), 'Workspace created', false, false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { const workspace = await create.mutateAsync(name.trim()); onClose(); onCreated(workspace.id) } catch { /* inline */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="Create workspace" description="Each workspace has its own domains, keys and contacts. You’ll set up sending next."
    footer={<><Button onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="create-workspace" variant="primary" loading={create.isPending}>Create workspace</Button></>}>
    <form id="create-workspace" className="stack" onSubmit={submit}>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="create-workspace-name" error={fieldError(create.error, 'name')}><Input id="create-workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} autoFocus required /></Field>
    </form>
  </Dialog>
}
