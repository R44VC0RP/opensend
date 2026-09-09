import { useState, type FormEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button, DataTable, ErrorState, Field, Input, PageHeader, SectionHeader, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useSession } from '../../data/context'
import type { Workspace } from '../../data/types'
import { label, number } from '../../lib/format'
import { fieldError, MutationError, SettingsTabs } from './shared'
import { settingsColumns, SettingsBodySkeleton } from './skeletons'

function WorkspaceForm({workspace}: {workspace: Workspace}) {
  const [name, setName] = useState(workspace.name)
  const save = useApiMutation((api, input: {name: string}) => api.workspace.update(input), 'Workspace saved')
  async function submit(event: FormEvent) {event.preventDefault(); try {await save.mutateAsync({name: name.trim()})} catch { /* inline */ }}
  return <form className="section stack" onSubmit={submit}><SectionHeader title="Workspace" actions={<Button type="submit" loading={save.isPending} variant="primary">Save workspace</Button>} /><MutationError error={save.error} /><Field label="Workspace name" htmlFor="workspace-name" error={fieldError(save.error, 'name')}><Input id="workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} required /></Field></form>
}
export function SettingsPage() {
  const {regionId, setRegionId} = useRegion()
  const session = useSession()
  const testEnvironment = session?.environment === 'test'
  const workspace = useApiQuery(['workspace'], (api, signal) => api.workspace.get(signal))
  const regions = useApiQuery(['regions'], (api, signal) => api.environment === 'test' ? Promise.resolve([]) : api.regions.list(signal))
  return <div className="stack"><PageHeader title="Settings" actions={<a className="ui-button ui-button--secondary" href={`https://${regionId}.console.aws.amazon.com/ses/home?region=${regionId}#/account`} target="_blank" rel="noopener noreferrer">Open AWS console <ArrowUpRight size={16} aria-hidden /></a>} /><SettingsTabs value="ses" />{workspace.isPending || regions.isPending ? <SettingsBodySkeleton regionId={regionId} /> : workspace.error || regions.error ? <ErrorState error={workspace.error || regions.error} onRetry={() => {void workspace.refetch(); void regions.refetch()}} /> : <><div className="settings-account"><div>{workspace.data.name}</div><Button loading={workspace.isFetching || regions.isFetching} onClick={() => {void workspace.refetch(); void regions.refetch()}}>Refresh</Button></div><section className="section stack"><SectionHeader title={testEnvironment ? "AWS access unavailable in test mode" : "Configured regions"} /><DataTable minRows={3} rowSize="large" rows={regions.data} rowKey={region => region.id} columns={[
    {...settingsColumns.regions[0], render: region => region.id},
    {...settingsColumns.regions[1], render: region => <div>{label(region.access)}<div className="muted">{region.access === 'sandbox' ? 'Verified recipients only' : 'Production access'}</div></div>},
    {...settingsColumns.regions[2], render: region => <div><StatusBadge status={region.health} /><div className="muted">Sending {region.sendingEnabled ? 'enabled' : 'disabled'}</div></div>},
    {...settingsColumns.regions[3], render: region => <div>{number(region.sent24h)} / {number(region.dailyQuota)}<div className="muted">{number(Math.max(0, region.dailyQuota - region.sent24h))} remaining</div></div>},
    {...settingsColumns.regions[4], render: region => `${number(region.maxSendRate)} / sec`},
    {...settingsColumns.regions[5], render: region => <Button variant="ghost" disabled={regionId === region.id} onClick={() => setRegionId(region.id)}>{regionId === region.id ? 'Selected' : 'Select region'}</Button>},
  ]} /><p className="muted">Regions and AWS credentials are managed by the deployment operator.</p></section><WorkspaceForm key={workspace.data.id} workspace={workspace.data} />{session?.identity && <section className="section stack"><SectionHeader title="Google identity" /><dl><dt>Name</dt><dd>{session.identity.name || '—'}</dd><dt>Email</dt><dd>{session.identity.email || '—'}</dd><dt>Permissions</dt><dd>{session.identity.permissions.join(', ')}</dd></dl><p className="muted">Access is managed through the deployment’s approved Google identities. There are no dashboard passwords or team invitations.</p></section>}</>}</div>
}
