import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, SectionHeader, Select, SkeletonText, StatusBadge } from '../../components/ui'
import { useApi, useApiMutation, useApiQuery } from '../../data/context'
import { mailboxEventTypes, type Mailbox, type MailboxEventType, type MailboxWebhook, type MailboxWebhookInput } from '../../data/types'
import { date, time } from '../../lib/format'
import { fieldError, MutationError, SecretDialog } from '../settings/shared'
import '../settings/settings.css'
import './mailboxes.css'

const eventInfo: Record<MailboxEventType, string> = {
  'message.received': 'New mail arrived in a mailbox', 'message.queued': 'A mailbox queued an outgoing message', 'message.sent': 'SES accepted an outgoing message',
  'message.delivered': 'The recipient server accepted it', 'message.delayed': 'Delivery is being retried', 'message.bounced': 'The message bounced',
  'message.complained': 'The recipient reported spam', 'message.failed': 'The message was rejected, suppressed or canceled', 'message.updated': 'Read state or message labels changed',
  'thread.updated': 'A conversation was archived, starred, trashed or relabeled', 'mailbox.created': 'A mailbox was created (including automatically)', 'mailbox.deleted': 'A mailbox was deleted',
}
const blank: MailboxWebhookInput = { url: '', description: '', eventTypes: ['message.received'], mailboxIds: null }
function validate(input: MailboxWebhookInput) {
  const errors: Record<string, string> = {}
  try { const url = new URL(input.url.trim()); if (url.protocol !== 'https:' || url.username || url.password) errors.url = 'Enter an HTTPS URL without embedded credentials.' } catch { errors.url = 'Enter a valid HTTPS endpoint URL.' }
  if (!input.eventTypes.length) errors.eventTypes = 'Choose at least one event.'
  if (input.mailboxIds && !input.mailboxIds.length) errors.mailboxIds = 'Choose at least one mailbox, or send events for every mailbox.'
  return errors
}
const scopeText = (webhook: MailboxWebhook, mailboxes?: Mailbox[]) => webhook.mailboxIds ? webhook.mailboxIds.map(id => mailboxes?.find(item => item.id === id)?.address ?? id).join(', ') : 'All mailboxes'

function WebhookFields({ input, onChange, mailboxes, errors, apiError, disabled }: { input: MailboxWebhookInput; onChange: (input: MailboxWebhookInput) => void; mailboxes?: Mailbox[]; errors: Record<string, string>; apiError: unknown; disabled: boolean }) {
  return <div className="stack">
    <div className="form-grid">
      <Field label="Description" htmlFor="mailbox-webhook-description"><Input id="mailbox-webhook-description" value={input.description} onChange={event => onChange({ ...input, description: event.target.value })} disabled={disabled} placeholder="Support agent runtime" /></Field>
      <Field label="Endpoint URL" htmlFor="mailbox-webhook-url" error={errors.url || fieldError(apiError, 'url')} hint="The host must be in the deployment’s webhook allowlist (WEBHOOK_ALLOWED_HOSTS)."><Input id="mailbox-webhook-url" type="url" value={input.url} onChange={event => onChange({ ...input, url: event.target.value })} disabled={disabled} placeholder="https://agents.acme.com/hooks/mail" /></Field>
    </div>
    <Field label="Mailboxes" htmlFor="mailbox-webhook-scope" error={errors.mailboxIds || fieldError(apiError, 'mailboxIds')} hint={input.mailboxIds === null ? 'Includes mailboxes created later.' : undefined}>
      <Select id="mailbox-webhook-scope" value={input.mailboxIds === null ? 'all' : 'selected'} disabled={disabled} onValueChange={value => onChange({ ...input, mailboxIds: value === 'all' ? null : [] })} options={[{ value: 'all', label: 'Every mailbox' }, { value: 'selected', label: 'Selected mailboxes' }]} />
    </Field>
    {input.mailboxIds !== null && <div className="settings-choices" role="group" aria-label="Mailboxes">{!mailboxes?.length ? <p className="muted">No mailboxes yet.</p> : mailboxes.map(mailbox => <Checkbox key={mailbox.id} label={mailbox.address} disabled={disabled} checked={input.mailboxIds!.includes(mailbox.id)} onCheckedChange={checked => onChange({ ...input, mailboxIds: checked ? [...input.mailboxIds!, mailbox.id] : input.mailboxIds!.filter(id => id !== mailbox.id) })} />)}</div>}
    <fieldset className="mailbox-webhook-events" disabled={disabled}>
      <legend className="ui-field__label">Events</legend>
      {mailboxEventTypes.map(type => <Checkbox key={type} label={<span className="settings-cell-stack"><code>{type}</code><span className="ui-field__hint">{eventInfo[type]}</span></span>} checked={input.eventTypes.includes(type)} onCheckedChange={checked => onChange({ ...input, eventTypes: checked ? [...input.eventTypes, type] : input.eventTypes.filter(value => value !== type) })} />)}
      {(errors.eventTypes || fieldError(apiError, 'eventTypes')) && <p className="ui-field__error" role="alert">{errors.eventTypes || fieldError(apiError, 'eventTypes')}</p>}
    </fieldset>
  </div>
}

function LiveMailboxWebhooksPage() {
  const navigate = useNavigate()
  const webhooks = useApiQuery(['mailbox-webhooks'], (api, signal) => api.mailboxes.webhooks(signal))
  const mailboxes = useApiQuery(['mailboxes', 'webhook-options'], (api, signal) => api.mailboxes.list({}, signal))
  const create = useApiMutation((api, input: MailboxWebhookInput) => api.mailboxes.createWebhook(input), 'Mailbox webhook created')
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState<MailboxWebhookInput>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<{ value: string; id: string } | null>(null)
  function openCreate() { create.reset(); setInput(blank); setErrors({}); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next = validate(input); setErrors(next)
    if (Object.keys(next).length) return
    try { const result = await create.mutateAsync({ ...input, url: input.url.trim(), description: input.description.trim() }); setOpen(false); setSecret({ value: result.secret, id: result.webhook.id }) } catch { /* Shown in the form. */ }
  }
  return <div className="stack">
    <PageHeader title="Mailbox webhooks" backTo="/mailboxes" actions={<Button variant="primary" onClick={openCreate}>Add webhook</Button>} />
    <p className="muted settings-section-note">Signed POST requests (Standard Webhooks headers) for mail and conversation events, retried with backoff. Agents without a public URL can long-poll <code>GET /mailbox/v1/events</code> instead.</p>
    {webhooks.error ? <ErrorState error={webhooks.error} onRetry={() => void webhooks.refetch()} /> : <DataTable loading={webhooks.isPending} skeletonRows={2} minRows={2} rows={webhooks.data ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/mailboxes/webhooks/${row.id}`)}
      empty={<EmptyState title="No mailbox webhooks" description="Get a POST when mail arrives or a sent message is delivered." action={<Button onClick={openCreate}>Add webhook</Button>} />}
      columns={[
        { key: 'endpoint', label: 'Endpoint', width: '38%', render: row => <div className="settings-cell-stack"><Link to={`/mailboxes/webhooks/${row.id}`}>{row.description || new URL(row.url).host}</Link><span className="muted settings-break">{row.url}</span></div> },
        { key: 'mailboxes', label: 'Mailboxes', width: '24%', render: row => <span className="settings-break">{scopeText(row, mailboxes.data)}</span> },
        { key: 'events', label: 'Events', width: '16%', render: row => <span title={row.eventTypes.join(', ')}>{row.eventTypes.length === 1 ? row.eventTypes[0] : `${row.eventTypes.length} events`}</span> },
        { key: 'status', label: 'Status', render: row => <StatusBadge status={row.paused ? 'Paused' : 'Active'} tone={row.paused ? 'neutral' : 'success'} /> },
      ]} />}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add mailbox webhook" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-mailbox-webhook">Add webhook</Button></>}>
      <form id="create-mailbox-webhook" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <WebhookFields input={input} onChange={setInput} mailboxes={mailboxes.data} errors={errors} apiError={create.error} disabled={create.isPending} />
      </form>
    </Dialog>
    <SecretDialog secret={secret?.value ?? null} title="Signing secret" onClose={() => { const target = secret?.id; setSecret(null); if (target) navigate(`/mailboxes/webhooks/${target}`) }} />
  </div>
}

function LiveMailboxWebhookDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const webhook = useApiQuery(['mailbox-webhook', id], (api, signal) => api.mailboxes.webhook(id, signal))
  const deliveries = useApiQuery(['mailbox-webhook-deliveries', id], (api, signal) => api.mailboxes.webhookDeliveries(id, undefined, signal))
  const mailboxes = useApiQuery(['mailboxes', 'webhook-options'], (api, signal) => api.mailboxes.list({}, signal))
  const save = useApiMutation((api, patch: Parameters<typeof api.mailboxes.updateWebhook>[1]) => api.mailboxes.updateWebhook(id, patch), 'Webhook saved')
  const rotate = useApiMutation((api, _: void) => api.mailboxes.rotateWebhookSecret(id))
  const remove = useApiMutation((api, _: void) => api.mailboxes.deleteWebhook(id), 'Webhook deleted')
  const [input, setInput] = useState<MailboxWebhookInput | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null)
  useEffect(() => { if (webhook.data && !input) setInput({ url: webhook.data.url, description: webhook.data.description, eventTypes: webhook.data.eventTypes, mailboxIds: webhook.data.mailboxIds }) }, [webhook.data, input])
  if (webhook.error) return <><PageHeader title="Mailbox webhook" backTo="/mailboxes/webhooks" /><ErrorState error={webhook.error} onRetry={() => void webhook.refetch()} /></>
  const current = webhook.data
  const dirty = !!current && !!input && JSON.stringify({ url: current.url, description: current.description, eventTypes: [...current.eventTypes].sort(), mailboxIds: current.mailboxIds }) !== JSON.stringify({ ...input, eventTypes: [...input.eventTypes].sort() })
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input) return
    const next = validate(input); setErrors(next)
    if (Object.keys(next).length) return
    try { await save.mutateAsync({ ...input, url: input.url.trim(), description: input.description.trim() }) } catch { /* Shown in the form. */ }
  }
  return <div className="stack">
    <PageHeader title={current ? current.description || new URL(current.url).host : <SkeletonText width={220} lineHeight={28} />} backTo="/mailboxes/webhooks" actions={current && <>
      <Button onClick={() => void save.mutateAsync({ paused: !current.paused }).catch(() => undefined)} loading={save.isPending && !dirty}>{current.paused ? 'Resume' : 'Pause'}</Button>
      <Button onClick={() => setConfirm('rotate')}>Rotate secret</Button>
      <Button variant="danger" onClick={() => setConfirm('delete')}>Delete</Button>
    </>} />
    {current && <dl className="settings-facts settings-account-summary">
      <div><dt>Status</dt><dd><StatusBadge status={current.paused ? 'Paused' : 'Active'} tone={current.paused ? 'neutral' : 'success'} /></dd></div>
      <div><dt>Mailboxes</dt><dd className="settings-break">{scopeText(current, mailboxes.data)}</dd></div>
      <div><dt>Events</dt><dd>{current.eventTypes.length}</dd></div>
      <div><dt>Created</dt><dd>{date(current.createdAt)}</dd></div>
    </dl>}
    {current?.paused && <Alert tone="info">Paused: no new deliveries are queued. Events keep recording and stay readable through the events API.</Alert>}
    <section className="section stack">
      <SectionHeader title="Recent deliveries" actions={<span className="muted">UTC</span>} />
      {deliveries.error ? <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} /> : <DataTable loading={deliveries.isPending} skeletonRows={3} minRows={3} rows={deliveries.data ?? []} rowKey={row => row.id} empty={<EmptyState title="No deliveries yet" description="Deliveries appear here after matching events." />}
        columns={[
          { key: 'time', label: 'Time', width: 200, render: row => <span className="muted mailbox-nowrap">{date(row.createdAt, { month: 'short', day: 'numeric', timeZone: 'UTC' })} · {time(row.createdAt)}</span> },
          { key: 'status', label: 'Status', width: 120, render: row => <StatusBadge status={row.status === 'delivered' ? 'Delivered' : row.status === 'failed' ? 'Failed' : 'Retrying'} tone={row.status === 'delivered' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'} /> },
          { key: 'code', label: 'Response', width: 100, render: row => row.lastStatusCode ?? '—' },
          { key: 'attempts', label: 'Attempts', width: 90, render: row => row.attemptCount },
          { key: 'event', label: 'Event', render: row => <code className="settings-break">{row.eventId}</code> },
        ]} />}
    </section>
    <section className="section stack">
      <SectionHeader title="Settings" />
      {!input ? <SkeletonText width="60%" /> : <form className="stack" onSubmit={submit} noValidate>
        <MutationError error={save.error} />
        <WebhookFields input={input} onChange={setInput} mailboxes={mailboxes.data} errors={errors} apiError={save.error} disabled={save.isPending} />
        <div className="cluster"><Button variant="primary" type="submit" loading={save.isPending && dirty} disabled={!dirty}>Save changes</Button>{dirty && <Button onClick={() => { setInput(null); setErrors({}) }}>Discard</Button>}</div>
      </form>}
    </section>
    <ConfirmDialog open={confirm === 'rotate'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Rotate signing secret?" description="The old secret stops working immediately. Update your endpoint with the new secret right away." confirmLabel="Rotate secret" pending={rotate.isPending} onConfirm={async () => { setSecret((await rotate.mutateAsync()).secret) }} />
    <ConfirmDialog open={confirm === 'delete'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Delete this webhook?" description="Pending deliveries are dropped. Events stay available through the events API." confirmLabel="Delete webhook" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/mailboxes/webhooks') }} />
    <SecretDialog secret={secret} title="New signing secret" onClose={() => setSecret(null)} />
  </div>
}

const LiveOnly = ({ title }: { title: string }) => <><PageHeader title={title} backTo="/mailboxes" /><Alert tone="info">Mailboxes receive real mail, so they are managed in live mode only.</Alert></>
export function MailboxWebhooksPage() { return useApi().environment === 'test' ? <LiveOnly title="Mailbox webhooks" /> : <LiveMailboxWebhooksPage /> }
export function MailboxWebhookDetailPage() { return useApi().environment === 'test' ? <LiveOnly title="Mailbox webhook" /> : <LiveMailboxWebhookDetailPage /> }
