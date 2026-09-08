import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, SectionHeader, Select, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery } from '../../data/context'
import type { Region, Webhook, WebhookDelivery, WebhookEvent, WebhookInput } from '../../data/types'
import { date, label, number, time } from '../../lib/format'
import { fieldError, MutationError, SecretDialog, SettingsTabs } from './shared'

const events: WebhookEvent[] = ['send', 'delivered', 'bounced', 'complaint', 'rejected', 'delivery_delayed']
const blankEndpoint: WebhookInput = { name: '', url: '', regionIds: 'all', events: [...events] }
function scopeText(scope: WebhookInput['regionIds']) { return scope === 'all' ? 'All connected regions' : scope.join(', ') }
function validate(input: WebhookInput) {
  const errors: Record<string, string> = {}
  if (!input.name.trim()) errors.name = 'Enter an endpoint name.'
  try { const url = new URL(input.url.trim()); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) errors.url = 'Enter an HTTPS URL without embedded credentials.' } catch { errors.url = 'Enter a valid HTTPS endpoint URL.' }
  if (input.regionIds !== 'all' && input.regionIds.length === 0) errors.regionIds = 'Choose at least one region.'
  if (input.events.length === 0) errors.events = 'Choose at least one event.'
  return errors
}

function EndpointFields({ input, onChange, regions, errors, apiError, disabled }: { input: WebhookInput; onChange: (input: WebhookInput) => void; regions: Region[]; errors: Record<string, string>; apiError: unknown; disabled: boolean }) {
  return <div className="stack">
    <div className="form-grid">
      <Field label="Name" htmlFor="endpoint-name" error={errors.name || fieldError(apiError, 'name')}><Input id="endpoint-name" value={input.name} onChange={event => onChange({ ...input, name: event.target.value })} required disabled={disabled} placeholder="Support notifications" /></Field>
      <Field label="Endpoint URL" htmlFor="endpoint-url" error={errors.url || fieldError(apiError, 'url')}><Input id="endpoint-url" type="url" value={input.url} onChange={event => onChange({ ...input, url: event.target.value })} required disabled={disabled} placeholder="https://support.acme.com/hooks/email" /></Field>
    </div>
    <Field label="Region scope" htmlFor="endpoint-scope" error={errors.regionIds || fieldError(apiError, 'regionIds')} hint={input.regionIds === 'all' ? 'This workspace · Includes future connected regions' : undefined}><Select id="endpoint-scope" value={input.regionIds === 'all' ? 'all' : 'selected'} onValueChange={value => onChange({ ...input, regionIds: value === 'all' ? 'all' : regions.map(region => region.id) })} disabled={disabled} options={[{ value: 'all', label: 'All connected regions' }, { value: 'selected', label: 'Selected regions' }]} /></Field>
    {input.regionIds !== 'all' && <div className="settings-choices" role="group" aria-label="Selected regions">{regions.map(region => <Checkbox key={region.id} label={region.id} checked={input.regionIds !== 'all' && input.regionIds.includes(region.id)} disabled={disabled} onCheckedChange={checked => { const selected = input.regionIds === 'all' ? [] : input.regionIds; onChange({ ...input, regionIds: checked ? [...selected, region.id] : selected.filter(id => id !== region.id) }) }} />)}</div>}
    <div className="stack"><div id="endpoint-events-label">Events</div><div className="settings-choices" role="group" aria-labelledby="endpoint-events-label" aria-describedby={errors.events || fieldError(apiError, 'events') ? 'endpoint-events-error' : undefined}>{events.map(event => <Checkbox key={event} label={label(event)} checked={input.events.includes(event)} disabled={disabled} onCheckedChange={checked => onChange({ ...input, events: checked ? [...input.events, event] : input.events.filter(current => current !== event) })} />)}</div>{(errors.events || fieldError(apiError, 'events')) && <div id="endpoint-events-error" className="ui-field__error" role="alert">{errors.events || fieldError(apiError, 'events')}</div>}</div>
  </div>
}

export function WebhooksPage() {
  const navigate = useNavigate()
  const webhooks = useApiQuery(['webhooks'], (api, signal) => api.webhooks.list(signal))
  return <div className="stack">
    <PageHeader title="Settings" actions={<Button variant="primary" onClick={() => navigate('/settings/webhooks/new')}>Add webhook</Button>} />
    <SettingsTabs value="webhooks" />
    <SectionHeader title={`${number(webhooks.data?.length ?? 0)} webhooks`} actions={<span className="muted">Workspace-wide · All regions</span>} />
    {webhooks.isPending ? <LoadingState /> : webhooks.error ? <ErrorState error={webhooks.error} onRetry={() => void webhooks.refetch()} /> : <DataTable rows={webhooks.data} rowKey={webhook => webhook.id} onRowClick={webhook => navigate(`/settings/webhooks/${webhook.id}`)} empty={<EmptyState title="No webhook endpoints" action={<Button onClick={() => navigate('/settings/webhooks/new')}>Add webhook</Button>} />} columns={[
      { key: 'name', label: 'Name / Endpoint URL', width: '34%', render: webhook => <div><Link to={`/settings/webhooks/${webhook.id}`}>{webhook.name}</Link><div className="muted settings-break">{webhook.url}</div></div> },
      { key: 'scope', label: 'Region scope', width: '22%', render: webhook => scopeText(webhook.regionIds) },
      { key: 'events', label: 'Events', width: '12%', render: webhook => <span title={webhook.events.map(label).join(', ')}>{number(webhook.events.length)} events</span> },
      { key: 'status', label: 'Status', width: '12%', render: webhook => <StatusBadge status={label(webhook.status)} /> },
      { key: 'last', label: 'Last delivery', render: webhook => { const latest = [...webhook.deliveries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]; return latest ? <div><span>{latest.response} · {label(latest.status)}</span><div className="muted">{date(latest.at)} · {time(latest.at)} UTC</div></div> : 'No deliveries' } },
    ]} />}
  </div>
}

function NewWebhook() {
  const navigate = useNavigate()
  const regions = useApiQuery(['regions'], (api, signal) => api.regions.list(signal))
  const save = useApiMutation((api, input: WebhookInput) => api.webhooks.save(input), 'Webhook endpoint created')
  const [input, setInput] = useState<WebhookInput>(blankEndpoint)
  const [errors, setErrors] = useState<Record<string, string>>({})
  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = validate(input)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    try { const endpoint = await save.mutateAsync({ ...input, name: input.name.trim(), url: input.url.trim() }); navigate(`/settings/webhooks/${endpoint.id}`) } catch { /* Shown inline. */ }
  }
  return <div className="stack">
    <PageHeader title="Add webhook" backTo="/settings/webhooks" />
    {regions.isPending ? <LoadingState /> : regions.error ? <ErrorState error={regions.error} onRetry={() => void regions.refetch()} /> : <form className="stack" onSubmit={submit} noValidate>
      <MutationError error={save.error} />
      <EndpointFields input={input} onChange={setInput} regions={regions.data} errors={errors} apiError={save.error} disabled={save.isPending} />
      <div className="muted">A separate signing secret is created for each endpoint.</div>
      <div className="cluster"><Button disabled={save.isPending} onClick={() => navigate('/settings/webhooks')}>Cancel</Button><Button variant="primary" type="submit" loading={save.isPending}>Add endpoint</Button></div>
    </form>}
  </div>
}

function ExistingWebhook({ id }: { id: string }) {
  const webhook = useApiQuery(['webhook', id], (api, signal) => api.webhooks.get(id, signal))
  const regions = useApiQuery(['regions'], (api, signal) => api.regions.list(signal))
  if (webhook.isPending || regions.isPending) return <LoadingState />
  if (webhook.error || regions.error) return <ErrorState error={webhook.error || regions.error} onRetry={() => { void webhook.refetch(); void regions.refetch() }} />
  return <WebhookEditor key={id} webhook={webhook.data} regions={regions.data} />
}

function WebhookEditor({ webhook, regions }: { webhook: Webhook; regions: Region[] }) {
  const navigate = useNavigate()
  const [input, setInput] = useState<WebhookInput>({ id: webhook.id, name: webhook.name, url: webhook.url, regionIds: webhook.regionIds, events: webhook.events })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [action, setAction] = useState<'pause' | 'resume' | 'rotate' | 'delete' | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [inspected, setInspected] = useState<WebhookDelivery | null>(null)
  const save = useApiMutation((api, value: WebhookInput) => api.webhooks.save(value), 'Webhook saved')
  const status = useApiMutation((api, value: { id: string; status: 'active' | 'paused' }) => api.webhooks.setStatus(value.id, value.status), 'Webhook status updated')
  const rotate = useApiMutation((api, id: string) => api.webhooks.rotate(id), 'Signing secret rotated')
  const remove = useApiMutation((api, id: string) => api.webhooks.remove(id), 'Webhook deleted')
  const test = useApiMutation((api, id: string) => api.webhooks.test(id), 'Test delivery created')
  const retry = useApiMutation((api, value: { id: string; deliveryId: string }) => api.webhooks.retry(value.id, value.deliveryId), 'Delivery retried')
  const pending = save.isPending || status.isPending || rotate.isPending || remove.isPending || test.isPending || retry.isPending
  async function submit(event: FormEvent) {
    event.preventDefault()
    const nextErrors = validate(input)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    try { await save.mutateAsync({ ...input, name: input.name.trim(), url: input.url.trim() }) } catch { /* Shown inline. */ }
  }
  async function confirm() {
    if (action === 'pause' || action === 'resume') await status.mutateAsync({ id: webhook.id, status: action === 'pause' ? 'paused' : 'active' })
    if (action === 'rotate') { const result = await rotate.mutateAsync(webhook.id); setSecret(result.secret); rotate.reset() }
    if (action === 'delete') { await remove.mutateAsync(webhook.id); navigate('/settings/webhooks') }
  }
  const actionTitle = action === 'rotate' ? `Rotate ${webhook.name} signing secret?` : action === 'delete' ? `Delete ${webhook.name}?` : `${action === 'pause' ? 'Pause' : 'Resume'} ${webhook.name}?`
  const actionDescription = action === 'rotate' ? 'Only this endpoint’s signing secret will change. Copy the new demo secret once after rotation.' : action === 'delete' ? 'This endpoint and its delivery history will be removed. Other endpoints are unchanged.' : `${action === 'pause' ? 'Stop' : 'Resume'} deliveries to this endpoint across its scoped regions. Other endpoints are unchanged.`
  return <div className="stack">
    <PageHeader title={webhook.name} backTo="/settings/webhooks" actions={<><StatusBadge status={label(webhook.status)} /><Button disabled={pending} onClick={() => setAction(webhook.status === 'active' ? 'pause' : 'resume')}>{webhook.status === 'active' ? 'Pause' : 'Resume'}</Button><Button variant="primary" form="edit-webhook" type="submit" loading={save.isPending} disabled={pending}>Save changes</Button></>} />
    <div className="muted">Workspace-wide endpoint · {scopeText(webhook.regionIds)}</div>
    <form id="edit-webhook" className="stack" onSubmit={submit} noValidate><MutationError error={save.error} /><EndpointFields input={input} onChange={setInput} regions={regions} errors={errors} apiError={save.error} disabled={pending} /></form>
    <section className="section stack"><SectionHeader title={`Signing secret · ${webhook.name} only`} actions={<><Button disabled={pending} onClick={() => setAction('rotate')}>Rotate</Button><Button loading={test.isPending} disabled={pending || webhook.status === 'paused'} title={webhook.status === 'paused' ? 'Resume this endpoint to test delivery' : undefined} onClick={async () => { try { await test.mutateAsync(webhook.id) } catch { /* Shown inline. */ } }}>Test endpoint</Button></>} /><code>{webhook.secretHint}</code><MutationError error={test.error} /></section>
    <section className="section stack"><SectionHeader title="Delivery history" actions={<span className="muted">Time in UTC · {scopeText(webhook.regionIds)}</span>} /><MutationError error={retry.error} />
      <DataTable rows={webhook.deliveries} rowKey={delivery => delivery.id} empty={<EmptyState title="No deliveries yet" />} columns={[
        { key: 'time', label: 'Time · UTC', width: '18%', render: delivery => <div>{time(delivery.at)}<div className="muted">{date(delivery.at)}</div></div> },
        { key: 'region', label: 'Region', width: '15%', render: delivery => delivery.regionId },
        { key: 'event', label: 'Event', width: '17%', render: delivery => label(delivery.event) },
        { key: 'status', label: 'Response / Status', width: '24%', render: delivery => <div>{delivery.response || 'No response'} · <StatusBadge status={label(delivery.status)} /></div> },
        { key: 'attempts', label: 'Attempts', render: delivery => number(delivery.attempts) },
        { key: 'actions', label: '', align: 'right', width: 190, render: delivery => <div className="cluster settings-row-actions">{delivery.status === 'retry_pending' && <Button disabled={pending || webhook.status === 'paused'} loading={retry.isPending && retry.variables?.deliveryId === delivery.id} onClick={async () => { try { await retry.mutateAsync({ id: webhook.id, deliveryId: delivery.id }) } catch { /* Shown inline. */ } }}>Retry now</Button>}<Button variant="ghost" onClick={() => setInspected(delivery)}>Inspect</Button></div> },
      ]} />
    </section>
    <div><Button variant="danger" disabled={pending} onClick={() => setAction('delete')}>Delete endpoint</Button></div>
    <ConfirmDialog open={action !== null} onOpenChange={open => { if (!open) setAction(null) }} title={actionTitle} description={actionDescription} confirmLabel={action === 'rotate' ? 'Rotate secret' : action === 'delete' ? 'Delete endpoint' : action === 'pause' ? 'Pause endpoint' : 'Resume endpoint'} danger={action === 'delete' || action === 'rotate'} pending={pending} onConfirm={confirm} />
    <SecretDialog secret={secret} title={`${webhook.name} · New signing secret`} onClose={() => { setSecret(null); rotate.reset() }} />
    <Dialog open={inspected !== null} onOpenChange={open => { if (!open) setInspected(null) }} title="Delivery payload" description={inspected ? `${label(inspected.event)} · ${inspected.regionId} · ${label(inspected.status)}` : undefined} footer={<Button onClick={() => setInspected(null)}>Close</Button>}><pre className="settings-payload">{JSON.stringify(inspected?.payload ?? {}, null, 2)}</pre></Dialog>
  </div>
}

export function WebhookDetailPage() {
  const { id } = useParams()
  return !id || id === 'new' ? <NewWebhook /> : <ExistingWebhook key={id} id={id} />
}
