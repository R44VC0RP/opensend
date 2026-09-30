import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, SectionHeader, Select } from '../../components/ui'
import { useApiMutation, useApiQuery } from '../../data/context'
import type { MailboxKey, MailboxKeyInput, MailboxPermission } from '../../data/types'
import { date } from '../../lib/format'
import { fieldError, MutationError, SecretDialog } from './shared'
import '../mailboxes/mailboxes.css'

const permissions: { value: MailboxPermission; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'List and read mail, events and attachments.' },
  { value: 'send', label: 'Send', hint: 'Send, reply and forward.' },
  { value: 'modify', label: 'Modify', hint: 'Mark read, archive, star, trash and label.' },
]

/** Keys an agent uses to work only inside chosen mailboxes. Admin actions (domains, mailboxes, keys) stay with API keys. */
export function MailboxKeysSection({ showRevoked }: { showRevoked: boolean }) {
  const keys = useApiQuery(['mailbox-keys', showRevoked], (api, signal) => api.mailboxes.keys(showRevoked, signal))
  const mailboxes = useApiQuery(['mailboxes', 'key-options'], (api, signal) => api.mailboxes.list({}, signal))
  const create = useApiMutation((api, input: MailboxKeyInput) => api.mailboxes.createKey(input), 'Mailbox key created')
  const revoke = useApiMutation((api, id: string) => api.mailboxes.revokeKey(id), 'Mailbox key revoked')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'all' | 'selected'>('selected')
  const [selected, setSelected] = useState<string[]>([])
  const [granted, setGranted] = useState<MailboxPermission[]>(['read', 'send', 'modify'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<MailboxKey | null>(null)
  const address = (id: string) => mailboxes.data?.find(mailbox => mailbox.id === id)?.address ?? id
  function openCreate() { create.reset(); setName(''); setScope('selected'); setSelected([]); setGranted(['read', 'send', 'modify']); setErrors({}); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name for this key.'
    if (scope === 'selected' && !selected.length) next.mailboxIds = 'Choose at least one mailbox, or allow every mailbox.'
    if (!granted.length) next.permissions = 'Choose at least one permission.'
    setErrors(next)
    if (Object.keys(next).length) return
    try {
      const result = await create.mutateAsync({ name: name.trim(), mailboxIds: scope === 'all' ? null : selected, permissions: granted })
      setOpen(false); setSecret(result.secret); create.reset()
    } catch { /* Shown in the form. */ }
  }
  return <section className="section stack">
    <SectionHeader title="Mailbox keys" actions={<Button onClick={openCreate}>Create mailbox key</Button>} />
    <p className="muted settings-section-note">For agents that read and send from specific <Link to="/mailboxes">mailboxes</Link>. A mailbox key cannot manage domains, mailboxes or other keys.</p>
    {keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable loading={keys.isPending} skeletonRows={2} minRows={2} rows={keys.data ?? []} rowKey={row => row.id}
      empty={<EmptyState title={showRevoked ? 'No mailbox keys' : 'No active mailbox keys'} action={<Button onClick={openCreate}>Create mailbox key</Button>} />}
      columns={[
        { key: 'name', label: 'Name', width: '23%', render: row => <>{row.name}<div className="muted">Created {date(row.createdAt)}</div></> },
        { key: 'prefix', label: 'Key prefix', width: '20%', render: row => <code>{row.prefix}</code> },
        { key: 'access', label: 'Access', width: '30%', render: row => <div className="settings-cell-stack"><span>{row.permissions.join(', ')}</span><span className="muted settings-break">{row.mailboxIds ? row.mailboxIds.map(address).join(', ') : 'All mailboxes'}</span></div> },
        { key: 'last', label: 'Last used', render: row => row.lastUsedAt ? date(row.lastUsedAt) : 'Never' },
        { key: 'actions', label: '', align: 'right', width: 100, render: row => row.revokedAt ? 'Revoked' : <Button variant="danger" onClick={() => setRevoking(row)}>Revoke</Button> },
      ]} />}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Create mailbox key" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-mailbox-key">Create key</Button></>}>
      <form id="create-mailbox-key" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Name" htmlFor="mailbox-key-name" error={errors.name || fieldError(create.error, 'name')}><Input id="mailbox-key-name" value={name} onChange={event => setName(event.target.value)} autoFocus disabled={create.isPending} placeholder="Support agent" /></Field>
        <Field label="Mailboxes" htmlFor="mailbox-key-scope" error={errors.mailboxIds || fieldError(create.error, 'mailboxIds')} hint={scope === 'all' ? 'Includes mailboxes created later.' : undefined}>
          <Select id="mailbox-key-scope" value={scope} onValueChange={value => setScope(value as 'all' | 'selected')} disabled={create.isPending} options={[{ value: 'selected', label: 'Selected mailboxes' }, { value: 'all', label: 'Every mailbox' }]} />
        </Field>
        {scope === 'selected' && <div className="settings-choices" role="group" aria-label="Mailboxes">
          {mailboxes.isPending ? <p className="muted" role="status">Loading mailboxes…</p> : !mailboxes.data?.length ? <p className="muted">No mailboxes yet.</p>
            : mailboxes.data.map(mailbox => <Checkbox key={mailbox.id} label={mailbox.address} checked={selected.includes(mailbox.id)} disabled={create.isPending} onCheckedChange={checked => setSelected(current => checked ? [...current, mailbox.id] : current.filter(id => id !== mailbox.id))} />)}
        </div>}
        <fieldset className="settings-choices mailbox-key-permissions" disabled={create.isPending}>
          <legend className="ui-field__label">Permissions</legend>
          {permissions.map(item => <Checkbox key={item.value} label={<span className="settings-cell-stack"><span>{item.label}</span><span className="ui-field__hint">{item.hint}</span></span>} checked={granted.includes(item.value)} onCheckedChange={checked => setGranted(current => checked ? [...current, item.value] : current.filter(value => value !== item.value))} />)}
          {errors.permissions && <p className="ui-field__error" role="alert">{errors.permissions}</p>}
        </fieldset>
      </form>
    </Dialog>
    <SecretDialog secret={secret} title="Mailbox key created" onClose={() => setSecret(null)} />
    <ConfirmDialog open={revoking !== null} onOpenChange={next => { if (!next) setRevoking(null) }} title={`Revoke ${revoking?.name ?? 'key'}?`} description="Agents using this key stop working immediately, and queued mail it sent will not be dispatched. Revoking cannot be undone." confirmLabel="Revoke key" danger pending={revoke.isPending} onConfirm={async () => { if (revoking) await revoke.mutateAsync(revoking.id) }} />
  </section>
}
