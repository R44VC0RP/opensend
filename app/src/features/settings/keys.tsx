import { useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useApi } from '../../data/context'
import type { ApiKey, ApiKeyInput } from '../../data/types'
import { date } from '../../lib/format'
import { fieldError, MutationError, SecretDialog } from './shared'
import { settingsColumns } from './skeletons'

export function ApiKeysPage() {
  const { regionId } = useRegion()
  const api = useApi()
  const [cursor, setCursor] = useState<string | undefined>()
  const keys = useApiQuery(['keys', cursor], (api, signal) => api.keys.list(signal, cursor))
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const revoke = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [keyEnvironment, setKeyEnvironment] = useState<'live' | 'test'>('test')
  const [permission, setPermission] = useState<ApiKeyInput['permission']>('send')
  const [domainId, setDomainId] = useState('all')
  const [nameError, setNameError] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null)
  function openCreate() { create.reset(); setName(''); setKeyEnvironment('test'); setNameError(''); setPermission('send'); setDomainId('all'); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setNameError('Enter a name for this key.'); return }
    setNameError('')
    if (domainId !== 'all' && domainId.trim() && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domainId.trim().toLowerCase())) {setNameError('Enter a valid domain hostname without a scheme or path.'); return}
    try {
      const result = await create.mutateAsync({ name: name.trim(), environment: keyEnvironment, permission, domainId: domainId === 'all' || !domainId.trim() ? null : domainId.trim().toLowerCase() })
      setOpen(false)
      setSecret(result.secret)
      create.reset()
    } catch { /* The mutation error is shown in the form. */ }
  }
  return <div className="stack">
    <PageHeader title="API keys" actions={<Button variant="primary" onClick={openCreate}>Create key</Button>} />
    <div className="page-toolbar muted">Workspace keys · Domain restrictions apply to domain names</div>
    {keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable loading={keys.isPending} skeletonRows={3} minRows={3} rows={keys.data ?? []} rowKey={row => row.id} empty={<EmptyState title="No API keys" action={<Button onClick={openCreate}>Create key</Button>} />} columns={[
      { ...settingsColumns.keys[0], render: row => <>{row.name}<div className="muted">{row.environment ?? 'Demo'}</div></> },
      { ...settingsColumns.keys[1], render: row => <code>{row.prefix}</code> },
      { ...settingsColumns.keys[2], render: row => <>{row.permission} · {row.domainId || 'All domains'}</> },
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
        <Field label="Domain restriction" htmlFor="key-domain" error={fieldError(create.error, 'domains')} hint="Optional hostname, such as example.com. The public API validates this restriction; no AWS lookup is needed."><Input id="key-domain" value={domainId === 'all' ? '' : domainId} placeholder="All domains" onChange={event => setDomainId(event.target.value)} disabled={create.isPending} /></Field>
      </form>
    </Dialog>
    <SecretDialog secret={secret} title="API key created" onClose={() => { setSecret(null); create.reset() }} />
    <ConfirmDialog open={revokeKey !== null} onOpenChange={next => { if (!next) setRevokeKey(null) }} title={`Revoke ${revokeKey?.name ?? 'key'}?`} description="Requests using this key will stop working. Revoking a key cannot be undone." confirmLabel="Revoke key" danger pending={revoke.isPending} onConfirm={async () => { if (revokeKey) await revoke.mutateAsync(revokeKey.id) }} />
  </div>
}
