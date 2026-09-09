import { useState, type FormEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button, DataTable, Dialog, ErrorState, Field, Input, PageHeader, SectionHeader, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion } from '../../data/context'
import type { Workspace } from '../../data/types'
import { label, number, percent } from '../../lib/format'
import { fieldError, MutationError, SettingsTabs } from './shared'
import { settingsColumns, SettingsBodySkeleton } from './skeletons'

function WorkspaceForm({ workspace }: { workspace: Workspace }) {
  const [name, setName] = useState(workspace.name)
  const [invalid, setInvalid] = useState('')
  const save = useApiMutation((api, input: { name: string }) => api.workspace.update(input), 'Workspace saved')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setInvalid('Enter a workspace name.'); return }
    setInvalid('')
    try { await save.mutateAsync({ name: name.trim() }) } catch { /* Shown inline. */ }
  }
  return <form className="section stack" onSubmit={submit} noValidate>
    <SectionHeader title="Workspace" actions={<Button type="submit" loading={save.isPending} variant="primary">Save workspace</Button>} />
    <MutationError error={save.error} />
    <div className="form-grid">
      <Field label="Workspace name" htmlFor="workspace-name" error={invalid || fieldError(save.error, 'name')}><Input id="workspace-name" value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} required /></Field>
      <div className="stack"><div className="muted">Team</div><div>{number(workspace.members.length)} members · Your role: {label(workspace.role)}</div></div>
    </div>
  </form>
}

export function SettingsPage() {
  const { regionId, setRegionId } = useRegion()
  const workspace = useApiQuery(['workspace'], (api, signal) => api.workspace.get(signal))
  const regions = useApiQuery(['regions'], (api, signal) => api.regions.list(signal))
  const connect = useApiMutation((api, id: string) => api.regions.connect(id), 'Region connected')
  const [open, setOpen] = useState(false)
  const [newRegion, setNewRegion] = useState('')
  const [invalid, setInvalid] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(newRegion.trim())) { setInvalid('Enter a region ID such as ap-southeast-2.'); return }
    if (regions.data?.some(region => region.id === newRegion.trim())) { setInvalid('This region is already connected.'); return }
    setInvalid('')
    try { await connect.mutateAsync(newRegion.trim()); setOpen(false) } catch { /* Shown inline. */ }
  }
  const selected = regions.data?.find(region => region.id === regionId)
  return <div className="stack">
    <PageHeader title="Settings" actions={<a className="ui-button ui-button--secondary" href={`https://${regionId}.console.aws.amazon.com/ses/home?region=${regionId}#/account`} target="_blank" rel="noopener noreferrer">Open AWS console <ArrowUpRight size={16} aria-hidden /></a>} />
    <SettingsTabs value="ses" />
    {workspace.isPending || regions.isPending ? <SettingsBodySkeleton regionId={regionId} /> : workspace.error || regions.error ? <ErrorState error={workspace.error || regions.error} onRetry={() => { void workspace.refetch(); void regions.refetch() }} /> : <>
      <div className="settings-account"><div>{workspace.data.name} AWS · •••• {workspace.data.accountId.slice(-4)}</div><StatusBadge status="Connected" /><Button loading={workspace.isFetching || regions.isFetching} onClick={() => { void workspace.refetch(); void regions.refetch() }}>Refresh</Button></div>
      <section className="section stack">
        <SectionHeader title="Connected regions" actions={<Button onClick={() => { setNewRegion(''); setInvalid(''); connect.reset(); setOpen(true) }}>Add region</Button>} />
        <DataTable minRows={3} rowSize="large" rows={regions.data} rowKey={region => region.id} columns={[
          { ...settingsColumns.regions[0], render: region => <div><div>{region.id}</div><div className="muted">{region.name}</div></div> },
          { ...settingsColumns.regions[1], render: region => <div><div>{label(region.access)}</div><div className="muted">{region.access === 'sandbox' ? 'Verified only' : 'Any recipient'}</div></div> },
          { ...settingsColumns.regions[2], render: region => <div><StatusBadge status={label(region.health)} tone={region.health === 'probation' ? 'warning' : region.health === 'shutdown' ? 'danger' : 'success'} /><div className="muted">Sending {region.sendingEnabled ? 'enabled' : 'disabled'}</div></div> },
          { ...settingsColumns.regions[3], render: region => <div>{number(region.sent24h)} / {number(region.dailyQuota)}<div className="muted">{number(Math.max(0, region.dailyQuota - region.sent24h))} remaining</div></div> },
          { ...settingsColumns.regions[4], render: region => `${number(region.maxSendRate)} / sec` },
          { ...settingsColumns.regions[5], render: region => <Button variant="ghost" aria-pressed={regionId === region.id} disabled={regionId === region.id} onClick={() => setRegionId(region.id)}>{regionId === region.id ? 'Selected' : 'View details'}</Button> },
        ]} />
      </section>
      {selected && <section className="section stack">
        <SectionHeader title={`${selected.id} · Reputation & capabilities`} />
        <div className="settings-reputation">
          <div><div className="muted">Bounce rate</div><div>{percent(selected.bounceRate)}</div><div className="muted">Keep below 5%</div></div>
          <div><div className="muted">Complaint rate</div><div>{percent(selected.complaintRate)}</div><div className="muted">Keep below 0.1%</div></div>
          <div><div className="muted">Account suppression</div><div>{selected.suppression.map(reason => label(reason.toLowerCase())).join(' and ') || 'None'}</div></div>
          <div><div className="muted">IP pool</div><div>{label(selected.ipPool)}</div></div>
          <div><div className="muted">Virtual Deliverability Manager</div><div>{selected.vdmEnabled ? 'Enabled' : 'Disabled'}</div></div>
        </div>
      </section>}
      <WorkspaceForm key={workspace.data.id} workspace={workspace.data} />
    </>}
    <Dialog open={open} onOpenChange={next => { if (!connect.isPending) setOpen(next) }} title="Add region" footer={<><Button disabled={connect.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" type="submit" form="add-region" loading={connect.isPending}>Connect region</Button></>}>
      <form id="add-region" className="stack" onSubmit={submit} noValidate><MutationError error={connect.error} /><Field label="Region ID" htmlFor="new-region" error={invalid || fieldError(connect.error, 'id')} hint="New regions begin with sandbox access and their own sending quota."><Input id="new-region" value={newRegion} onChange={event => setNewRegion(event.target.value)} placeholder="ap-southeast-2" autoFocus required disabled={connect.isPending} /></Field></form>
    </Dialog>
  </div>
}
