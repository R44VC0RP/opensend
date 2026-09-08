import { useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion } from '../../data/context'
import type { ApiKey, ApiKeyInput } from '../../data/types'
import { date } from '../../lib/format'
import { fieldError, MutationError, SecretDialog } from './shared'

export function ApiKeysPage() {
  const { regionId } = useRegion()
  const keys = useApiQuery(['keys'], (api, signal) => api.keys.list(signal))
  const domains = useApiQuery(['key-domains'], (api, signal) => api.domains.list({ pageSize: 1000 }, signal))
  const choices = useApiQuery(['key-domain-choices', regionId], (api, signal) => api.domains.list({ regionId, pageSize: 1000 }, signal))
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const revoke = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [permission, setPermission] = useState<ApiKeyInput['permission']>('send')
  const [domainId, setDomainId] = useState('all')
  const [nameError, setNameError] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [revokeKey, setRevokeKey] = useState<ApiKey | null>(null)
  function openCreate() { create.reset(); setName(''); setNameError(''); setPermission('send'); setDomainId('all'); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setNameError('Enter a name for this key.'); return }
    setNameError('')
    try {
      const result = await create.mutateAsync({ name: name.trim(), permission, domainId: domainId === 'all' ? null : domainId })
      setOpen(false)
      setSecret(result.secret)
      create.reset()
    } catch { /* The mutation error is shown in the form. */ }
  }
  return <div className="stack">
    <PageHeader title="API keys" actions={<Button variant="primary" onClick={openCreate}>Create key</Button>} />
    <div className="muted">Workspace-wide keys · Domain restrictions available in {regionId}</div>
    {keys.isPending ? <LoadingState /> : keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable rows={keys.data} rowKey={row => row.id} empty={<EmptyState title="No API keys" action={<Button onClick={openCreate}>Create key</Button>} />} columns={[
      { key: 'name', label: 'Name', width: '23%', render: row => row.name },
      { key: 'prefix', label: 'Key prefix', width: '20%', render: row => <code>{row.prefix}</code> },
      { key: 'permission', label: 'Permissions', width: '30%', render: row => <>{row.permission === 'read' ? 'Read only' : 'Send'} · {row.domainId ? domains.data?.items.find(domain => domain.id === row.domainId)?.name ?? row.domainId : 'All domains'}</> },
      { key: 'last', label: 'Last used', render: row => row.lastUsedAt ? date(row.lastUsedAt) : 'Never' },
      { key: 'actions', label: '', align: 'right', width: 100, render: row => <Button variant="danger" onClick={() => setRevokeKey(row)}>Revoke</Button> },
    ]} />}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Create API key" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-api-key">Create key</Button></>}>
      <form id="create-api-key" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Name" htmlFor="key-name" error={nameError || fieldError(create.error, 'name')}><Input id="key-name" value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={create.isPending} placeholder="Order notifications" /></Field>
        <Field label="Permission" htmlFor="key-permission"><Select id="key-permission" value={permission} onValueChange={value => setPermission(value as ApiKeyInput['permission'])} disabled={create.isPending} options={[{ value: 'send', label: 'Sending access' }, { value: 'read', label: 'Read only' }]} /></Field>
        <Field label="Domain restriction" htmlFor="key-domain" error={fieldError(create.error, 'domainId')} hint={`Specific domains are scoped to ${regionId}.`}><Select id="key-domain" value={domainId} onValueChange={setDomainId} disabled={create.isPending || choices.isPending} options={[{ value: 'all', label: 'All domains' }, ...(choices.data?.items ?? []).map(domain => ({ value: domain.id, label: domain.name }))]} /></Field>
        {choices.error && <ErrorState error={choices.error} onRetry={() => void choices.refetch()} />}
      </form>
    </Dialog>
    <SecretDialog secret={secret} title="API key created" onClose={() => { setSecret(null); create.reset() }} />
    <ConfirmDialog open={revokeKey !== null} onOpenChange={next => { if (!next) setRevokeKey(null) }} title={`Revoke ${revokeKey?.name ?? 'key'}?`} description="Requests using this key will stop working. Revoking a key cannot be undone." confirmLabel="Revoke key" danger pending={revoke.isPending} onConfirm={async () => { if (revokeKey) await revoke.mutateAsync(revokeKey.id) }} />
  </div>
}
