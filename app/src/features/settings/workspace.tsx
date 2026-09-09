import { useState, type FormEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button, ErrorState, Field, Input, PageHeader, SectionHeader } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useSession } from '../../data/context'
import type { Workspace } from '../../data/types'
import { fieldError, MutationError, SettingsTabs } from './shared'
import { SettingsBodySkeleton } from './skeletons'
import { RegionSetup } from './region-setup'

function WorkspaceForm({workspace}: {workspace: Workspace}) {
  const [name, setName] = useState(workspace.name)
  const save = useApiMutation((api, input: {name: string}) => api.workspace.update(input), 'Workspace saved')
  async function submit(event: FormEvent) {event.preventDefault(); try {await save.mutateAsync({name: name.trim()})} catch { /* inline */ }}
  return <form className="section stack" onSubmit={submit}><SectionHeader title="Workspace" actions={<Button type="submit" loading={save.isPending} variant="primary">Save workspace</Button>} /><MutationError error={save.error} /><Field label="Workspace name" htmlFor="workspace-name" error={fieldError(save.error, 'name')}><Input id="workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} required /></Field></form>
}
export function SettingsPage() {
  const {regionId} = useRegion()
  const session = useSession()
  const workspace = useApiQuery(['workspace'], (api, signal) => api.workspace.get(signal))
  return <div className="stack settings-ses">
    <PageHeader title="Settings" actions={<a className="ui-button ui-button--secondary" href={`https://${regionId}.console.aws.amazon.com/ses/home?region=${regionId}#/account`} target="_blank" rel="noopener noreferrer">Open AWS console <ArrowUpRight size={16} aria-hidden /></a>} />
    <SettingsTabs value="ses" />
    {workspace.isPending ? <SettingsBodySkeleton regionId={regionId} /> : <>
      <RegionSetup />
      {workspace.error ? <ErrorState error={workspace.error} onRetry={() => void workspace.refetch()} /> : <WorkspaceForm key={workspace.data.id} workspace={workspace.data} />}
      {session?.identity && <section className="section stack"><SectionHeader title="Google identity" /><dl className="settings-facts"><div><dt>Name</dt><dd>{session.identity.name || '—'}</dd></div><div><dt>Email</dt><dd>{session.identity.email || '—'}</dd></div><div><dt>Permissions</dt><dd>{session.identity.permissions.join(', ')}</dd></div></dl><p className="muted">Access is managed through the deployment’s approved Google identities. There are no dashboard passwords or team invitations.</p></section>}
    </>}
  </div>
}
