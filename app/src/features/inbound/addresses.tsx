import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, SkeletonText, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { date, number } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import type { InboundAddress, InboundAddressInput, InboundAddressPatch, MailboxDomain } from '../../data/types'
import { fieldError, MutationError } from '../settings/shared'
import { AliasEditor, aliasState, commitAliases, type AliasState } from './aliases'
import { receivingStatus } from './status'
import '../settings/settings.css'
import './inbound.css'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
const lifetimes = [{ value: '', label: 'Permanent' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]
const receivingDomains = (domains: MailboxDomain[]) => domains.filter(domain => !['off', 'disabled'].includes(domain.status))

function ReceivingDomains({ domains }: { domains: MailboxDomain[] }) {
  const receiving = receivingDomains(domains)
  if (!receiving.length) return <Alert tone="info">No domain receives mail yet. Open a verified domain in <Link to="/domains">Domains</Link> and choose Enable receiving.</Alert>
  return <ul className="mailbox-domains" aria-label="Receiving domains">{receiving.map(domain => <li key={domain.id}>
    <Link to={`/domains/${domain.id}`}>{domain.name}</Link>
    <StatusBadge status={receivingStatus[domain.status].label} tone={receivingStatus[domain.status].tone} />
  </li>)}</ul>
}

function CreateAddressDialog({ open, onOpenChange, domains }: { open: boolean; onOpenChange: (open: boolean) => void; domains: MailboxDomain[] }) {
  const navigate = useNavigate()
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [publicAddress, setPublicAddress] = useState('')
  const [lifetime, setLifetime] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useApiMutation((api, input: InboundAddressInput) => api.inbound.createAddress(input), 'Address created')
  const receiving = receivingDomains(domains)
  useEffect(() => { if (open) { create.reset(); setErrors({}); setAddress(''); setDisplayName(''); setPublicAddress(''); setLifetime('') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = address.trim().toLowerCase()
    const next: Record<string, string> = {}
    if (!EMAIL.test(value)) next.address = 'Enter a full email address, such as support@example.com.'
    else if (receiving.length && !receiving.some(domain => domain.name === value.split('@')[1])) next.address = `Use a receiving domain: ${receiving.map(domain => domain.name).join(', ')}.`
    const sender = publicAddress.trim().toLowerCase()
    // The API accepts a public sender only on permanent addresses; the form keeps the two exclusive.
    if (sender && lifetime) next.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) next.publicAddress = 'Enter a full email address.'
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) next.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    setErrors(next)
    if (Object.keys(next).length) return
    try { const row = await create.mutateAsync({ address: value, displayName: displayName.trim() || null, ...(sender ? { publicAddress: sender } : {}), ...(lifetime ? { ttlSeconds: Number(lifetime) } : {}) }); onOpenChange(false); navigate(`/inbound/addresses/${row.id}`) } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next) }} title="Create address" footer={<><Button disabled={create.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="inbound-create-address" loading={create.isPending}>Create address</Button></>}>
    <form id="inbound-create-address" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Address" htmlFor="inbound-address" error={errors.address || fieldError(create.error, 'address')} hint={receiving.length ? receiving.length > 1 ? `Receiving domains: ${receiving.map(domain => domain.name).join(', ')}` : undefined : 'Enable receiving on a domain first.'}>
        <Input id="inbound-address" type="email" value={address} onChange={event => setAddress(event.target.value)} disabled={create.isPending} placeholder={`support@${receiving[0]?.name ?? 'example.com'}`} autoFocus autoComplete="off" />
      </Field>
      <Field label="Display name" htmlFor="inbound-address-name" error={fieldError(create.error, 'displayName')} hint="Shown as the sender name on replies."><Input id="inbound-address-name" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={create.isPending} placeholder="Support" /></Field>
      <Field label="Lifetime" htmlFor="inbound-address-lifetime" error={fieldError(create.error, 'ttlSeconds')} hint={lifetime ? 'After expiry it stops receiving and sending. History stays readable until you delete it.' : 'Permanent addresses also claim earlier unrouted mail.'}>
        <Select id="inbound-address-lifetime" value={lifetime} onValueChange={value => { setLifetime(value); if (value) setPublicAddress('') }} disabled={create.isPending} options={lifetimes} />
      </Field>
      <Field label="Public sender" htmlFor="inbound-address-public" error={errors.publicAddress || fieldError(create.error, 'publicAddress')} hint={lifetime ? 'Only permanent addresses can have a public sender.' : 'The default From: the same name on a parent domain verified for sending, such as support@example.com.'}>
        <Input id="inbound-address-public" type="email" value={publicAddress} onChange={event => setPublicAddress(event.target.value)} disabled={create.isPending || !!lifetime} placeholder={address.includes('@') ? `${address.split('@')[0]}@${address.split('@')[1]!.split('.').slice(1).join('.') || 'example.com'}` : 'support@example.com'} autoComplete="off" />
      </Field>
    </form>
  </Dialog>
}

export function InboundAddressesPage() {
  const { canAdminister } = useWorkspaceAccess()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const addresses = useApiQuery(['inbound-addresses', search, cursor], (api, signal) => api.inbound.addresses({ search: search.trim() || undefined, cursor }, signal), { interval: 60_000 })
  const domains = useApiQuery(['mailbox-domains'], (api, signal) => api.mailboxes.domains(signal))
  return <div className="stack inbound-stack">
    <PageHeader title="Addresses" backTo="/inbound" actions={<>
      {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to="/api-keys">Inbound keys</Link>}
      {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to="/inbound/webhooks">Webhooks</Link>}
      <Button variant="primary" disabled={!domains.data || !receivingDomains(domains.data).length} onClick={() => setCreating(true)}>Create address</Button>
    </>} />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : domains.isPending ? <SkeletonText width={260} /> : <ReceivingDomains domains={domains.data} />}
    <div className="data-toolbar"><Input className="audience-search" aria-label="Search addresses" placeholder="Search address or name" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} /></div>
    {addresses.error ? <ErrorState error={addresses.error} onRetry={() => void addresses.refetch()} /> : <>
      <DataTable loading={addresses.isPending} skeletonRows={5} minRows={3} rows={addresses.data ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/inbound/addresses/${row.id}`)}
        empty={<EmptyState title={search ? 'No matching addresses' : 'No addresses yet'} description={search ? undefined : 'Create one, or let a catch-all create them as mail arrives.'} />}
        columns={[
          { key: 'address', label: 'Address', width: '44%', render: row => <div className="settings-cell-stack"><span className="mailbox-address"><Link to={`/inbound/addresses/${row.id}`}>{row.address}</Link>{row.origin === 'auto' && <StatusBadge status="Auto" tone="neutral" />}</span>{(row.displayName || row.aliases.length > 0) && <span className="muted">{[row.displayName, row.aliases.length ? `+${row.aliases.length} alias${row.aliases.length === 1 ? '' : 'es'}` : null].filter(Boolean).join(' · ')}</span>}</div> },
          { key: 'threads', label: 'Threads', align: 'right', width: '12%', render: row => <Link to={`/inbound?address=${encodeURIComponent(row.id)}`} onClick={event => event.stopPropagation()}>{number(row.stats.threads)}</Link> },
          { key: 'unread', label: 'Unread', align: 'right', width: '12%', render: row => row.stats.unreadThreads ? <strong>{number(row.stats.unreadThreads)}</strong> : <span className="muted">0</span> },
          { key: 'last', label: 'Last message', align: 'right', render: row => row.stats.lastMessageAt ? date(row.stats.lastMessageAt) : <span className="muted">None yet</span> },
        ]} />
      {addresses.isPending ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={100} nextCursor={addresses.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, addresses.data?.nextCursor)} />}
    </>}
    <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={domains.data ?? []} />
  </div>
}

// `base` is the saved address the edit started from, so a just-saved form doesn't wait on the refetch.
type AddressForm = { base: InboundAddress; displayName: string; aliases: AliasState }
const formOf = (address: InboundAddress): AddressForm => ({ base: address, displayName: address.displayName ?? '', aliases: aliasState(address.aliases) })
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

export function InboundAddressDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const address = useApiQuery(['inbound-address', id], (api, signal) => api.inbound.address(id, signal))
  const save = useApiMutation((api, patch: InboundAddressPatch) => api.inbound.updateAddress(id, patch), 'Address saved')
  const remove = useApiMutation((api, _: void) => api.inbound.deleteAddress(id), 'Address deleted')
  const [edited, setInput] = useState<AddressForm | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const current = address.data
  const input = edited ?? (current ? formOf(current) : null)
  if (address.error) return <><PageHeader title="Address" backTo="/inbound/addresses" /><ErrorState error={address.error} onRetry={() => void address.refetch()} /></>
  const base = input?.base
  const dirty = !!base && !!input && (input.displayName.trim() !== (base.displayName ?? '') || !sameList(input.aliases.list, base.aliases) || !!input.aliases.draft.trim())
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input || !base) return
    // Text still in the alias box counts: add it, or stop on it so nothing invalid is sent.
    const aliases = commitAliases(input.aliases, { address: base.address, temporary: !!base.expiresAt })
    if (!aliases.ok) { setInput({ ...input, aliases: { list: aliases.list, draft: aliases.draft, message: aliases.message } }); document.getElementById('inbound-address-aliases')?.focus(); return }
    const patch: InboundAddressPatch = {}
    if (input.displayName.trim() !== (base.displayName ?? '')) patch.displayName = input.displayName.trim() || null
    if (!sameList(aliases.list, base.aliases)) patch.aliases = aliases.list
    if (!Object.keys(patch).length) { setInput(null); return }
    setInput({ ...input, aliases: { list: aliases.list, draft: '', message: null } })
    try { setInput(formOf(await save.mutateAsync(patch))) } catch { /* Shown in the form. */ }
  }
  return <div className="stack inbound-stack">
    <PageHeader title={current ? current.address : <SkeletonText width={240} lineHeight={28} />} backTo="/inbound/addresses" actions={current && <>
      <Link className="ui-button ui-button--secondary ui-button--md" to={`/inbound?address=${encodeURIComponent(current.id)}`}>Open conversations</Link>
      <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
    </>} />
    {current && <>
      <dl className="settings-facts">
        <div><dt>Domain</dt><dd><Link to="/domains">{current.domain}</Link></dd></div>
        <div><dt>Sends as</dt><dd className="settings-break">{current.publicAddress ?? current.address}</dd></div>
        <div><dt>Created</dt><dd>{current.origin === 'auto' ? 'Automatically, ' : ''}{date(current.createdAt)}</dd></div>
        <div><dt>Threads</dt><dd>{number(current.stats.threads)}{current.stats.unreadThreads > 0 && <span className="muted"> · {number(current.stats.unreadThreads)} unread</span>}</dd></div>
        <div><dt>Last message</dt><dd>{current.stats.lastMessageAt ? date(current.stats.lastMessageAt) : 'None yet'}</dd></div>
        {current.expiresAt && <div><dt>Expires</dt><dd>{date(current.expiresAt)}</dd></div>}
      </dl>
      {current.expiresAt && Date.parse(current.expiresAt) <= Date.now() && <Alert tone="info">This temporary address has expired. It no longer receives or sends mail; its history stays readable until you delete it.</Alert>}
      <section className="section section--bordered stack">
        <SectionHeader title="Settings" />
        {input && <form className="stack inbound-settings-form" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <Field label="Display name" htmlFor="inbound-address-display" error={fieldError(save.error, 'displayName')} hint="Shown as the sender name on replies."><Input id="inbound-address-display" value={input.displayName} onChange={event => setInput({ ...input, displayName: event.target.value })} disabled={save.isPending} placeholder="Support" /></Field>
          <AliasEditor id="inbound-address-aliases" address={current.address} temporary={!!current.expiresAt} saved={input.base.aliases} value={input.aliases} onChange={aliases => setInput({ ...input, aliases })} disabled={save.isPending} error={fieldError(save.error, 'aliases')} />
          <div className="cluster"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Save changes</Button>{dirty && !save.isPending && <Button onClick={() => { setInput(null); save.reset() }}>Discard</Button>}</div>
        </form>}
      </section>
    </>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${current?.address ?? 'this address'}?`} description="The address and its aliases are released, and its read, star and archive state is removed. Stored messages are kept; future mail to these addresses follows the domain’s routing." confirmLabel="Delete address" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/inbound/addresses') }} />
  </div>
}

