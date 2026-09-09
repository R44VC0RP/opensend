import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion } from '../../data/context'
import { label } from '../../lib/format'
import { fieldError, MutationError } from './shared'
import { DomainDetailSkeleton, settingsColumns } from './skeletons'

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export function DomainsPage() {
  const { regionId } = useRegion()
  const navigate = useNavigate()
  const [pageState, setPageState] = useState({ regionId, page: 1 })
  const page = pageState.regionId === regionId ? pageState.page : 1
  const domains = useApiQuery(['domains', regionId, page], (api, signal) => api.domains.list({ regionId, page, pageSize: 20 }, signal))
  const create = useApiMutation((api, input: { regionId: string; name: string }) => api.domains.create(input), 'Domain added')
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [invalid, setInvalid] = useState('')
  function openCreate() { create.reset(); setName(''); setInvalid(''); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!domainPattern.test(name.trim())) { setInvalid('Enter a valid domain without https:// or a path.'); return }
    setInvalid('')
    try {
      const domain = await create.mutateAsync({ regionId, name: name.trim().toLowerCase() })
      setOpen(false)
      navigate(`/domains/${domain.id}`)
    } catch { /* Shown inline. */ }
  }
  return <div className="stack">
    <PageHeader title="Domains" actions={<Button variant="primary" onClick={openCreate}>Add domain</Button>} />
    <div className="page-toolbar muted">Sending region · {regionId}</div>
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable loading={domains.isPending} skeletonRows={3} minRows={3} rowSize="large" rows={domains.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/domains/${row.id}`)} empty={<EmptyState title="No domains in this region" action={<Button onClick={openCreate}>Add domain</Button>} />} columns={[
        { ...settingsColumns.domains[0], render: row => <Link to={`/domains/${row.id}`}>{row.name}</Link> },
        { ...settingsColumns.domains[1], render: row => <div><StatusBadge status={label(row.status)} tone={row.status === 'issue' ? 'danger' : undefined} />{row.mailFromStatus === 'pending' && <div className="muted">Mail from pending</div>}</div> },
        { ...settingsColumns.domains[2], render: row => row.regionId },
        { ...settingsColumns.domains[3], render: row => <Link to={`/domains/${row.id}`}>{row.status === 'verified' && row.mailFromStatus === 'verified' ? 'Manage' : 'Review records'}</Link> },
      ]} />
      {domains.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={20} total={domains.data.total} onPageChange={next => setPageState({ regionId, page: next })} />}
    </>}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add domain" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="add-domain">Continue to DNS records</Button></>}>
      <form id="add-domain" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Domain name" htmlFor="domain-name" error={invalid || fieldError(create.error, 'name')}><Input id="domain-name" autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} placeholder="updates.acme.com" /></Field>
        <Field label="Sending region" htmlFor="domain-region"><Input id="domain-region" value={regionId} readOnly /></Field>
      </form>
    </Dialog>
  </div>
}

export function DomainDetailPage() {
  const { id = '' } = useParams()
  const { regionId, setRegionId } = useRegion()
  const domain = useApiQuery(['domain', id], (api, signal) => api.domains.get(id, signal))
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Domain records verified')
  if (domain.isPending) return <DomainDetailSkeleton />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  const pending = current.records.filter(record => record.status === 'pending').length
  return <div className="stack">
    <PageHeader title={current.name} backTo="/domains" actions={<Button variant="primary" loading={verify.isPending} onClick={async () => { try { await verify.mutateAsync(id) } catch { /* Shown inline. */ } }}>Verify records</Button>} />
    <MutationError error={verify.error} />
    <div className="cluster"><StatusBadge status={label(current.status)} tone={current.status === 'issue' ? 'danger' : undefined} /><span className="muted">{current.regionId}</span><span>Custom mail from · <StatusBadge status={label(current.mailFromStatus)} /></span></div>
    {regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    <section className="section stack">
      <SectionHeader title="DNS records" />
      <div className="muted">Copy these records to your DNS provider, then verify.</div>
      <DataTable minRows={3} rowSize="large" rows={current.records} rowKey={record => record.id} columns={[
        { ...settingsColumns.dns[0], render: record => record.type },
        { ...settingsColumns.dns[1], render: record => <div className="settings-copy-cell"><code>{record.name}</code><CopyButton value={record.name} label={`Copy ${record.type} record name`} /></div> },
        { ...settingsColumns.dns[2], render: record => <div className="settings-copy-cell"><code>{record.value}</code><CopyButton value={record.value} label={`Copy ${record.type} record value`} /></div> },
        { ...settingsColumns.dns[3], render: record => <StatusBadge status={label(record.status)} /> },
      ]} />
      {pending > 0 ? <Alert tone="warning" title={`${pending} ${pending === 1 ? 'record' : 'records'} pending`}>Review the pending records, then verify again.</Alert> : <Alert tone="success">All DNS records are verified.</Alert>}
    </section>
  </div>
}
