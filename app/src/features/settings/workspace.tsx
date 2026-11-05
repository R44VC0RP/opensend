import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router'
import { Button, ErrorState, Field, Input, PageHeader, SectionHeader } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import type { Workspace } from '../../data/types'
import { fieldError, MutationError } from './shared'
import { SesSendingSkeleton, WorkspaceFormSkeleton } from './skeletons'
import { RegionSetup } from './region-setup'
import { SendingConnection } from './sending'
import { useWebhooks, WebhooksSection } from './webhooks'
import { WorkspaceSections } from './workspace-members'
import { roleLabel } from '../../data/workspaces'

function WorkspaceForm({workspace, ruled}: {workspace: Workspace; ruled: boolean}) {
  const [name, setName] = useState(workspace.name)
  const save = useApiMutation((api, input: {name: string}) => api.workspace.update(input), 'Saved')
  async function submit(event: FormEvent) {event.preventDefault(); try {await save.mutateAsync({name: name.trim()})} catch { /* inline */ }}
  return <form id="workspace" className={`section stack settings-group${ruled ? ' settings-rule' : ''}`} onSubmit={submit}><SectionHeader title="Workspace" actions={<Button type="submit" loading={save.isPending} variant="primary">Save</Button>} /><MutationError error={save.error} /><Field label="Name" htmlFor="workspace-name" error={fieldError(save.error, 'name')}><Input id="workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} required /></Field></form>
}
function SignedInSection() {
  const session = useSession()
  const access = useWorkspaceAccess()
  if (!session?.identity) return null
  return <section className="section stack settings-group settings-rule"><SectionHeader title="Signed in" actions={<Button onClick={() => session.logout()}>Sign out</Button>} /><dl className="settings-facts"><div><dt>Email</dt><dd>{session.identity.email || '—'}</dd></div><div><dt>{access.multiTenant ? 'Role' : 'Access'}</dt><dd>{access.role ? roleLabel[access.role] : session.identity.permissions.includes('manage') ? 'Administrator' : session.identity.permissions.join(', ')}</dd></div></dl></section>
}
// Sending, webhooks and the workspace live on one page; old tab links arrive as #webhooks or #workspace.
export function SettingsPage() {
  const access = useWorkspaceAccess()
  const { hash } = useLocation()
  useEffect(() => {
    if (!hash) return
    // After the shell resets the scroll position for the new route.
    const frame = requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [hash])
  // Self-hosted: regions and the workspace load together, as before, so later sections never jump.
  const workspace = useApiQuery(['workspace'], (api, signal) => api.workspace.get(signal), { enabled: !access.multiTenant })
  // Start the webhooks request alongside the workspace one instead of after it.
  useWebhooks(undefined, access.canAdminister)
  const {regionId} = useRegion()
  return <div className="stack settings-ses settings-page">
    <PageHeader title="Settings" />
    {!access.multiTenant && workspace.isPending ? <><SesSendingSkeleton regionId={regionId} /><WorkspaceFormSkeleton /></> : <>
      {access.canAdminister && (access.multiTenant ? <SendingConnection /> : <RegionSetup />)}
      {access.canAdminister && <WebhooksSection />}
      {access.multiTenant ? <WorkspaceSections /> : workspace.error ? <section id="workspace" className={`section stack settings-group${access.canAdminister ? ' settings-rule' : ''}`}><SectionHeader title="Workspace" /><ErrorState error={workspace.error} onRetry={() => void workspace.refetch()} /></section> : workspace.data && <WorkspaceForm key={workspace.data.id} workspace={workspace.data} ruled={access.canAdminister} />}
      <SignedInSection />
    </>}
  </div>
}
