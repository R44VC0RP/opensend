import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, Checkbox, Dialog, Field, Input, Select } from '../../components/ui'
import { useApi, useApiDef, useApiMutation } from '../../data/context'
import { queries } from '../../data/queries'
import type { ApiKeyInput, MailboxKeyInput, MailboxPermission, PageRequest } from '../../data/types'
import { fieldError, MutationError } from './shared'
import '../inbound/inbound.css'

type Purpose = ApiKeyInput['permission'] | 'inbound'
const purposes: { value: Purpose; label: string; hint: string }[] = [
  { value: 'manage', label: 'Full access', hint: 'Send, read, and manage domains, keys and settings.' },
  { value: 'send', label: 'Send only', hint: 'Send email from your app. Can’t read logs or change settings.' },
  { value: 'read', label: 'Read only', hint: 'Read logs, events and settings. Can’t send.' },
  { value: 'inbound', label: 'Inbound address', hint: 'For an agent that reads and replies on an inbound address. Nothing else.' },
]
const mailboxPermissions: { value: MailboxPermission; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'List and read mail, events and attachments.' },
  { value: 'send', label: 'Send', hint: 'Send, reply and forward.' },
  { value: 'modify', label: 'Modify', hint: 'Mark read, archive, star, trash and label.' },
]
const EVERY_ADDRESS = '*'
const list = new Intl.ListFormat('en', { type: 'conjunction' })
const capitalize = (value: string) => value.replace(/^./, c => c.toUpperCase())

/** Plain words for read/send/manage permission sets. */
export function accessLabel(permissions: string[]) {
  if (permissions.includes('manage')) return 'Full access'
  const known = permissions.filter(permission => permission === 'read' || permission === 'send')
  if (known.length === 1) return known[0] === 'send' ? 'Send only' : 'Read only'
  return capitalize(list.format(known.length ? known : permissions))
}
export const domainScope = (domains: string[]) => domains.length ? domains.join(', ') : 'All domains'
export const permissionList = (permissions: string[]) => capitalize(list.format(permissions))

/** One dialog for every key: a plain choice up front, exact scope and permissions under Advanced. Mount with a new key per opening to start fresh. */
export function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (secret: string, title: string) => void }) {
  const api = useApi()
  const createApiKey = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const createInboundKey = useApiMutation((api, input: MailboxKeyInput) => api.mailboxes.createKey(input), 'Inbound key created')
  const addresses = useApiDef(queries.inboundAddressOptions())
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<Purpose>('send')
  const [advanced, setAdvanced] = useState(false)
  const [allDomains, setAllDomains] = useState(true)
  const [selectedDomains, setSelectedDomains] = useState<string[]>([])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [granted, setGranted] = useState<MailboxPermission[]>(['read', 'send', 'modify'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const inbound = purpose === 'inbound'
  const create = inbound ? createInboundKey : createApiKey
  const pending = createApiKey.isPending || createInboundKey.isPending
  const domainOptions = useInfiniteQuery({
    queryKey: ['opensend', api.mode, 'domains', 'key-options'],
    enabled: open && !inbound,
    initialPageParam: { page: 1 } as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({ pageParam, signal }) => api.domains.list({ ...pageParam, pageSize: 10 }, signal),
    getNextPageParam: last => last.nextCursor ? { cursor: last.nextCursor } : api.mode === 'demo' && last.total !== undefined && last.page * last.pageSize < last.total ? { page: last.page + 1 } : undefined,
    staleTime: 60_000,
    retry: false,
  })
  const domains = [...new Set(domainOptions.data?.pages.flatMap(page => page.items.map(domain => domain.name.toLowerCase())) ?? [])].sort()
  const nameError = errors.name || fieldError(create.error, 'name')
  const domainError = errors.domains || fieldError(createApiKey.error, 'domains')
  const addressError = errors.addressIds || fieldError(createInboundKey.error, 'addressIds')
  const permissionError = errors.permissions || fieldError(createInboundKey.error, 'permissions')

  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  function toggleDomain(domain: string, checked: boolean) {
    clearError('domains')
    setAllDomains(false)
    setSelectedDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain))
  }
  function toggleAddress(id: string, checked: boolean) {
    clearError('addressIds')
    setAllAddresses(false)
    setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name for this key.'
    const chosenAddresses = addressIds.filter(Boolean)
    if (inbound) {
      if (!allAddresses && !chosenAddresses.length) next.addressIds = 'Choose an address.'
      if (!granted.length) next.permissions = 'Choose at least one permission.'
    } else if (!allDomains && !selectedDomains.length) next.domains = 'Select at least one domain, or choose All domains.'
    else if (!allDomains && selectedDomains.length > 50) next.domains = 'Select up to 50 domains.'
    setErrors(next)
    if (next.domains || next.permissions) setAdvanced(true)
    if (Object.keys(next).length) return
    try {
      const result = inbound
        ? await createInboundKey.mutateAsync({ name: name.trim(), addressIds: allAddresses ? null : chosenAddresses, permissions: granted })
        : await createApiKey.mutateAsync({ name: name.trim(), permission: purpose, domains: allDomains ? [] : selectedDomains })
      onOpenChange(false)
      onCreated(result.secret, inbound ? 'Inbound key created' : 'API key created')
    } catch (cause) {
      if (fieldError(cause, 'domains') || fieldError(cause, 'permissions')) setAdvanced(true)
    }
  }

  // With several addresses (or none) chosen the Select shows a placeholder; its hidden native select then reports '' on change, which is ignored.
  const addressValue = allAddresses ? EVERY_ADDRESS : addressIds.length === 1 ? addressIds[0] : ''
  const addressPlaceholder = addressIds.length > 1 ? `${addressIds.length} addresses` : addresses.isPending ? 'Loading addresses…' : 'Choose an address'
  const summary = inbound ? granted.length ? permissionList(granted) : 'No permissions' : allDomains ? 'All domains' : selectedDomains.length ? selectedDomains.join(', ') : 'No domains'

  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title="Create key" footer={<><Button disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={pending} type="submit" form="create-key">Create key</Button></>}>
    <form id="create-key" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="key-name" error={nameError}><Input id="key-name" value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder={inbound ? 'Support agent' : 'Order notifications'} /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What’s it for?</legend>
        {purposes.map(item => <label key={item.value} className="keys-choice">
          <input type="radio" name="key-purpose" value={item.value} checked={purpose === item.value} onChange={() => { setPurpose(item.value); setErrors({}); createApiKey.reset(); createInboundKey.reset() }} aria-labelledby={`key-purpose-${item.value}`} aria-describedby={`key-purpose-${item.value}-hint`} />
          <span className="settings-cell-stack"><span id={`key-purpose-${item.value}`}>{item.label}</span><span id={`key-purpose-${item.value}-hint`} className="ui-field__hint">{item.hint}</span></span>
        </label>)}
      </fieldset>
      {inbound && <Field label="Address" htmlFor="key-address" error={addressError} hint={!addresses.isPending && !addresses.data?.length ? <>No inbound addresses yet. <Link to="/inbound/addresses">Create one</Link> first.</> : allAddresses ? 'Includes addresses created later.' : undefined}>
        <Select id="key-address" value={addressValue} placeholder={addressPlaceholder} disabled={pending || addresses.isPending || !addresses.data?.length}
          onValueChange={value => { if (!value) return; clearError('addressIds'); if (value === EVERY_ADDRESS) { setAllAddresses(true); setAddressIds([]) } else { setAllAddresses(false); setAddressIds([value]) } }}
          options={[...(addresses.data ?? []).map(item => ({ value: item.id, label: item.address })), ...(addresses.data?.length ? [{ value: EVERY_ADDRESS, label: 'Every address' }] : [])]} />
      </Field>}
      <details className="keys-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}>
        <summary>Advanced <span className="muted">· {summary}</span></summary>
        <div className="keys-advanced-body">
          {inbound ? <>
            <fieldset className="settings-key-domains" disabled={pending}>
              <legend className="ui-field__label">Addresses</legend>
              <p className="ui-field__hint">Choose several to share one key between them.</p>
              <div className="settings-key-domain-options">
                {addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : !addresses.data?.length ? <p className="muted">No addresses yet.</p>
                  : addresses.data.map(item => <Checkbox key={item.id} label={item.address} checked={!allAddresses && addressIds.includes(item.id)} disabled={pending} onCheckedChange={checked => toggleAddress(item.id, checked)} />)}
              </div>
            </fieldset>
            <fieldset className="settings-choices mailbox-key-permissions" disabled={pending}>
              <legend className="ui-field__label">Permissions</legend>
              {mailboxPermissions.map(item => <Checkbox key={item.value} label={<span className="settings-cell-stack"><span>{item.label}</span><span className="ui-field__hint">{item.hint}</span></span>} checked={granted.includes(item.value)} onCheckedChange={checked => { clearError('permissions'); setGranted(current => checked ? [...current, item.value] : current.filter(value => value !== item.value)) }} />)}
              {permissionError && <p className="ui-field__error" role="alert">{permissionError}</p>}
            </fieldset>
          </> : <fieldset className="settings-key-domains" disabled={pending} aria-describedby={domainError ? 'key-domain-error' : undefined}>
            <legend className="ui-field__label">Domains</legend>
            <Checkbox label={<span className="settings-key-all-domains">All domains <span className="ui-field__hint">Includes future domains.</span></span>} checked={allDomains} onCheckedChange={checked => { setAllDomains(checked); setSelectedDomains([]); clearError('domains') }} disabled={pending} />
            <div className="settings-key-domain-options">
              {domainOptions.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !domainOptions.isError ? <p className="muted">No domains available.</p> : domains.map(domain => <Checkbox key={domain} label={domain} checked={!allDomains && selectedDomains.includes(domain)} onCheckedChange={checked => toggleDomain(domain, checked)} disabled={pending || !selectedDomains.includes(domain) && selectedDomains.length >= 50} />)}
            </div>
            {domainOptions.isError && <div className="stack"><MutationError error={domainOptions.error} /><Button onClick={() => { void (domainOptions.isFetchNextPageError ? domainOptions.fetchNextPage() : domainOptions.refetch()) }}>Retry loading domains</Button></div>}
            {domainOptions.hasNextPage && !domainOptions.isError && <Button variant="ghost" loading={domainOptions.isFetchingNextPage} onClick={() => void domainOptions.fetchNextPage()}>Load more domains</Button>}
            {!allDomains && selectedDomains.length >= 50 && <p className="ui-field__hint">50-domain limit reached.</p>}
            {domainError && <p id="key-domain-error" className="ui-field__error" role="alert">{domainError}</p>}
          </fieldset>}
        </div>
      </details>
    </form>
  </Dialog>
}
