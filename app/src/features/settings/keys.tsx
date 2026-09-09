import { useState, type FormEvent } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select } from '../../components/ui'
import { useApiMutation, useApiQuery, useApi } from '../../data/context'
import type { ApiKey, ApiKeyInput, PageRequest } from '../../data/types'
import { date } from '../../lib/format'
import { fieldError, MutationError, SecretDialog } from './shared'
import { settingsColumns } from './skeletons'

export function ApiKeysPage() {
  const api = useApi()
  const [cursor, setCursor] = useState<string | undefined>()
  const [showRevoked, setShowRevoked] = useState(false)
  const keys = useApiQuery(['keys', cursor, showRevoked], (api, signal) => api.keys.list(signal, cursor, showRevoked))
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const revoke = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [keyEnvironment, setKeyEnvironment] = useState<'live' | 'test'>('test')
  const [permission, setPermission] = useState<ApiKeyInput['permission']>('send')
  const [allDomains, setAllDomains] = useState(true)
  const [selectedDomains, setSelectedDomains] = useState<string[]>([])
  const [domainError, setDomainError] = useState('')
  const domainOptions = useInfiniteQuery({
    queryKey: ['opensend', api.mode, api.environment, 'domains', 'key-options'],
    enabled: open,
    initialPageParam: {page: 1} as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({pageParam, signal}) => api.domains.list({...pageParam, pageSize: 10}, signal),
    getNextPageParam: last => last.nextCursor ? {cursor: last.nextCursor} : api.mode === 'demo' && last.total !== undefined && last.page * last.pageSize < last.total ? {page: last.page + 1} : undefined,
    staleTime: 60_000,
    retry: false,
  })
  const domains = [...new Set(domainOptions.data?.pages.flatMap(page => page.items.map(domain => domain.name.toLowerCase())) ?? [])].sort()
  function toggleDomain(name: string, checked: boolean) {
    setDomainError('')
    setAllDomains(false)
    setSelectedDomains(current => checked ? [...new Set([...current, name])] : current.filter(domain => domain !== name))
  }
  const [nameError, setNameError] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null)
  function openCreate() { create.reset(); setName(''); setKeyEnvironment('test'); setNameError(''); setPermission('send'); setAllDomains(true); setSelectedDomains([]); setDomainError(''); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setNameError('Enter a name for this key.'); return }
    setNameError('')
    if (!allDomains && selectedDomains.length === 0) { setDomainError('Select at least one domain, or choose All domains.'); return }
    if (!allDomains && selectedDomains.length > 50) { setDomainError('Select up to 50 domains.'); return }
    setDomainError('')
    try {
      const result = await create.mutateAsync({ name: name.trim(), environment: keyEnvironment, permission, domains: allDomains ? [] : selectedDomains })
      setOpen(false)
      setSecret(result.secret)
      create.reset()
    } catch { /* The mutation error is shown in the form. */ }
  }
  return <div className="stack">
    <PageHeader title="API keys" actions={<div className="cluster"><Checkbox label="Show revoked" checked={showRevoked} onCheckedChange={checked => {setShowRevoked(checked); setCursor(undefined)}} /><Button variant="primary" onClick={openCreate}>Create key</Button></div>} />
    {keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable loading={keys.isPending} skeletonRows={3} minRows={3} rows={keys.data ?? []} rowKey={row => row.id} empty={<EmptyState title={cursor ? 'No keys on this page' : showRevoked ? 'No API keys' : 'No active API keys'} action={<Button onClick={openCreate}>Create key</Button>} />} columns={[
      { ...settingsColumns.keys[0], render: row => <>{row.name}<div className="muted">{row.environment ?? 'Demo'}</div></> },
      { ...settingsColumns.keys[1], render: row => <code>{row.prefix}</code> },
      { ...settingsColumns.keys[2], render: row => <>{row.permission} · {row.domains.length ? row.domains.join(', ') : 'All domains'}</> },
      { ...settingsColumns.keys[3], render: row => row.lastUsedAt ? date(row.lastUsedAt) : 'Never' },
      { ...settingsColumns.keys[4], render: row => row.revokedAt ? 'Revoked' : <Button variant="danger" onClick={() => setRevokeKey(row)}>Revoke</Button> },
    ]} />}
    {api.mode !== 'demo' && <div className="cluster"><Button disabled={!cursor} onClick={() => setCursor(undefined)}>First page</Button><Button disabled={!keys.data?.nextCursor} onClick={() => setCursor(keys.data?.nextCursor ?? undefined)}>Next page</Button></div>}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Create API key" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-api-key">Create key</Button></>}>
      <form id="create-api-key" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Name" htmlFor="key-name" error={nameError || fieldError(create.error, 'name')}><Input id="key-name" value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={create.isPending} placeholder="Order notifications" /></Field>
        <Field label="Key environment" htmlFor="key-environment"><Select id="key-environment" value={keyEnvironment} onValueChange={value => setKeyEnvironment(value as 'live' | 'test')} options={[{value: 'test', label: 'Test · simulated'}, {value: 'live', label: 'Live · real delivery'}]} /></Field>
        <Field label="Permission" htmlFor="key-permission"><Select id="key-permission" value={permission} onValueChange={value => setPermission(value as ApiKeyInput['permission'])} disabled={create.isPending} options={[{ value: 'send', label: 'Sending access' }, { value: 'read', label: 'Read only' }]} /></Field>
        <fieldset className="settings-key-domains" disabled={create.isPending} aria-describedby={domainError || fieldError(create.error, 'domains') ? 'key-domain-error' : undefined}>
          <legend className="ui-field__label">Domains</legend>
          <Checkbox label={<span className="settings-key-all-domains">All domains <span className="ui-field__hint">Includes future domains.</span></span>} checked={allDomains} onCheckedChange={checked => {setAllDomains(checked); setSelectedDomains([]); setDomainError('')}} disabled={create.isPending} />
          <div className="settings-key-domain-options">
            {domainOptions.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !domainOptions.isError ? <p className="muted">No domains available.</p> : domains.map(name => <Checkbox key={name} label={name} checked={!allDomains && selectedDomains.includes(name)} onCheckedChange={checked => toggleDomain(name, checked)} disabled={create.isPending || !selectedDomains.includes(name) && selectedDomains.length >= 50} />)}
          </div>
          {domainOptions.isError && <div className="stack"><MutationError error={domainOptions.error} /><Button onClick={() => {void (domainOptions.isFetchNextPageError ? domainOptions.fetchNextPage() : domainOptions.refetch())}}>Retry loading domains</Button></div>}
          {domainOptions.hasNextPage && !domainOptions.isError && <Button variant="ghost" loading={domainOptions.isFetchingNextPage} onClick={() => void domainOptions.fetchNextPage()}>Load more domains</Button>}
          {!allDomains && selectedDomains.length >= 50 && <p className="ui-field__hint">50-domain limit reached.</p>}
          {(domainError || fieldError(create.error, 'domains')) && <p id="key-domain-error" className="ui-field__error" role="alert">{domainError || fieldError(create.error, 'domains')}</p>}
        </fieldset>
      </form>
    </Dialog>
    <SecretDialog secret={secret} title="API key created" onClose={() => { setSecret(null); create.reset() }} />
    <ConfirmDialog open={revokeKey !== null} onOpenChange={next => { if (!next) setRevokeKey(null) }} title={`Revoke ${revokeKey?.name ?? 'key'}?`} description="Requests using this key will stop working. Revoking a key cannot be undone." confirmLabel="Revoke key" danger pending={revoke.isPending} onConfirm={async () => { if (revokeKey) await revoke.mutateAsync(revokeKey.id) }} />
  </div>
}
