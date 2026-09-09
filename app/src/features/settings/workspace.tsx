import { useState, type FormEvent } from 'react'
import { Button, ErrorState, Field, Input, PageHeader, SectionHeader } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useSession } from '../../data/context'
import type { Workspace } from '../../data/types'
import { fieldError, MutationError, SettingsTabs } from './shared'
import { SettingsBodySkeleton } from './skeletons'
import { RegionSetup } from './region-setup'

function WorkspaceForm({workspace}: {workspace: Workspace}) {
  const [name, setName] = useState(workspace.name)
  const save = useApiMutation((api, input: {name: string}) => api.workspace.update(input), 'Saved')
  async function submit(event: FormEvent) {event.preventDefault(); try {await save.mutateAsync({name: name.trim()})} catch { /* inline */ }}
  return <form className="section stack" onSubmit={submit}><SectionHeader title="Workspace" actions={<Button type="submit" loading={save.isPending} variant="primary">Save</Button>} /><MutationError error={save.error} /><Field label="Name" htmlFor="workspace-name" error={fieldError(save.error, 'name')}><Input id="workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} required /></Field></form>
}
export function SettingsPage() {
  const {regionId} = useRegion()
  const session = useSession()
  const workspace = useApiQuery(['workspace'], (api, signal) => api.workspace.get(signal))
  return <div className="stack settings-ses">
    <PageHeader title="Settings" />
    <SettingsTabs value="ses" />
    {workspace.isPending ? <SettingsBodySkeleton regionId={regionId} /> : <>
      <RegionSetup />
      {workspace.error ? <ErrorState error={workspace.error} onRetry={() => void workspace.refetch()} /> : <WorkspaceForm key={workspace.data.id} workspace={workspace.data} />}
      {session?.identity && <section className="section stack"><SectionHeader title="Signed in" /><dl className="settings-facts"><div><dt>Email</dt><dd>{session.identity.email || '—'}</dd></div><div><dt>Access</dt><dd>{session.identity.permissions.includes('manage') ? 'Administrator' : session.identity.permissions.join(', ')}</dd></div></dl></section>}
    </>}
  </div>
}
