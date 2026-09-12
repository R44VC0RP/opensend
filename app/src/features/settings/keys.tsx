import { useState, type FormEvent } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select } from '../../components/ui'
import { useApiMutation, useApiQuery, useApi } from '../../data/context'
import type { AgentTokenSummary, ApiKey, ApiKeyInput, McpConnection, PageRequest } from '../../data/types'
import { date } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { fieldError, MutationError, SecretDialog } from './shared'
import { settingsColumns } from './skeletons'

export function ApiKeysPage() {
  const api = useApi()
  const [showRevoked, setShowRevoked] = useState(false)
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const keys = useApiQuery(['keys', cursor, showRevoked], (api, signal) => api.keys.list(signal, cursor, showRevoked))
  const agentTokens = useApiQuery(['agent-tokens', showRevoked], (api, signal) => api.credentials.agentTokens(showRevoked, signal))
  const mcpConnections = useApiQuery(['mcp-connections'], (api, signal) => api.credentials.mcpConnections(signal))
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const revoke = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  const revokeAgentToken = useApiMutation((api, id: string) => api.credentials.revokeAgentToken(id), 'Agent token revoked')
  const revokeMcpConnection = useApiMutation((api, id: string) => api.credentials.revokeMcpConnection(id), 'MCP connection revoked')
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
  const [revokeToken, setRevokeToken] = useState<AgentTokenSummary | null>(null)
  const [revokeConnection, setRevokeConnection] = useState<McpConnection | null>(null)
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
    <PageHeader title="Credentials" actions={<Button variant="primary" onClick={openCreate}>Create API key</Button>} />
    <section className="section stack"><SectionHeader title="API keys" actions={<Checkbox label="Show inactive" checked={showRevoked} onCheckedChange={checked => {setShowRevoked(checked); pagination.reset()}} />} />
    {keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable loading={keys.isPending} skeletonRows={3} minRows={3} rows={keys.data ?? []} rowKey={row => row.id} empty={<EmptyState title={cursor ? 'No keys on this page' : showRevoked ? 'No API keys' : 'No active API keys'} action={<Button onClick={openCreate}>Create key</Button>} />} columns={[
      { ...settingsColumns.keys[0], render: row => <>{row.name}<div className="muted">{row.environment ?? 'Demo'}</div></> },
      { ...settingsColumns.keys[1], render: row => <code>{row.prefix}</code> },
      { ...settingsColumns.keys[2], render: row => <>{row.permission} · {row.domains.length ? row.domains.join(', ') : 'All domains'}</> },
      { ...settingsColumns.keys[3], render: row => row.lastUsedAt ? date(row.lastUsedAt) : 'Never' },
      { ...settingsColumns.keys[4], render: row => row.revokedAt ? 'Revoked' : <Button variant="danger" onClick={() => setRevokeKey(row)}>Revoke</Button> },
    ]} />}
    {keys.isPending ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={20} nextCursor={keys.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, keys.data?.nextCursor)} />}
    </section>
    <section className="section stack"><SectionHeader title="Agent tokens" />
      {agentTokens.error ? <ErrorState error={agentTokens.error} onRetry={() => void agentTokens.refetch()} /> : <DataTable loading={agentTokens.isPending} skeletonRows={1} rows={agentTokens.data ?? []} rowKey={row => row.id} empty={<EmptyState title={showRevoked ? 'No agent tokens' : 'No active agent tokens'} />} columns={[
        {key: 'purpose', label: 'Purpose', width: '28%', render: row => <>{row.purpose}<div className="muted">{row.environment}</div></>},
        {key: 'permissions', label: 'Permissions', width: '25%', render: row => <>{row.permissions.join(', ')} · {row.domains.length ? row.domains.join(', ') : 'All domains'}</>},
        {key: 'expires', label: 'Expires', width: '17%', render: row => row.revokedAt ? 'Revoked' : Date.parse(row.expiresAt) <= Date.now() ? 'Expired' : date(row.expiresAt)},
        {key: 'used', label: 'Last used', width: '15%', render: row => row.lastUsedAt ? date(row.lastUsedAt) : 'Never'},
        {key: 'actions', label: '', align: 'right', width: 100, render: row => row.revokedAt || Date.parse(row.expiresAt) <= Date.now() ? null : <Button variant="danger" onClick={() => setRevokeToken(row)}>Revoke</Button>},
      ]} />}
    </section>
    <section className="section stack"><SectionHeader title="MCP connections" />
      {mcpConnections.error ? <ErrorState error={mcpConnections.error} onRetry={() => void mcpConnections.refetch()} /> : <DataTable loading={mcpConnections.isPending} skeletonRows={1} rows={mcpConnections.data ?? []} rowKey={row => row.id} empty={<EmptyState title="No MCP connections" />} columns={[
        {key: 'client', label: 'Client', width: '32%', render: row => <>{row.name || 'MCP client'}<div className="muted">{row.userEmail}</div></>},
        {key: 'access', label: 'Access', width: '38%', render: row => row.scopes.map(scope => scope.replace('opensend:', '').replaceAll('_', ' ')).join(', ')},
        {key: 'connected', label: 'Connected', render: row => date(row.createdAt)},
        {key: 'actions', label: '', align: 'right', width: 100, render: row => <Button variant="danger" onClick={() => setRevokeConnection(row)}>Revoke</Button>},
      ]} />}
    </section>
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Create API key" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-api-key">Create key</Button></>}>
      <form id="create-api-key" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Name" htmlFor="key-name" error={nameError || fieldError(create.error, 'name')}><Input id="key-name" value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={create.isPending} placeholder="Order notifications" /></Field>
        <Field label="Key environment" htmlFor="key-environment"><Select id="key-environment" value={keyEnvironment} onValueChange={value => setKeyEnvironment(value as 'live' | 'test')} options={[{value: 'test', label: 'Test · simulated'}, {value: 'live', label: 'Live · real delivery'}]} /></Field>
        <Field label="Permission" htmlFor="key-permission" hint={permission === 'manage' ? 'Includes reading, sending, and management.' : undefined}><Select id="key-permission" value={permission} onValueChange={value => setPermission(value as ApiKeyInput['permission'])} disabled={create.isPending} options={[{ value: 'send', label: 'Sending access' }, { value: 'read', label: 'Read only' }, { value: 'manage', label: 'Management access' }]} /></Field>
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
    <ConfirmDialog open={revokeToken !== null} onOpenChange={next => { if (!next) setRevokeToken(null) }} title={`Revoke ${revokeToken?.purpose ?? 'agent token'}?`} description="This temporary token will stop working immediately. Revoking it cannot be undone." confirmLabel="Revoke token" danger pending={revokeAgentToken.isPending} onConfirm={async () => { if (revokeToken) await revokeAgentToken.mutateAsync(revokeToken.id) }} />
    <ConfirmDialog open={revokeConnection !== null} onOpenChange={next => { if (!next) setRevokeConnection(null) }} title={`Revoke ${revokeConnection?.name || 'MCP connection'}?`} description="This connection and every agent token created from it will stop working immediately." confirmLabel="Revoke connection" danger pending={revokeMcpConnection.isPending} onConfirm={async () => { if (revokeConnection) await revokeMcpConnection.mutateAsync(revokeConnection.id) }} />
  </div>
}
