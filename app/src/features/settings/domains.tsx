import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, StatusBadge } from '../../components/ui'
import { useApiMutation, useApiDef, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { label } from '../../lib/format'
import { ApiError, type DnsRecord, type Domain } from '../../data/types'
import { catchAllLabel, mxTone, receivingStatus } from '../inbound/status'
import { fieldError, MutationError } from './shared'
import { DomainDetailSkeleton, domainColumns, settingsColumns } from './skeletons'
import { DnsRecordTable, DomainRecords, domainState, recordsFor, useDnsSetup, useDomain, zoneLines } from './domain-records'

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

function downloadDnsRecords(domain: string, records: DnsRecord[]) {
  const text = `; DNS records for ${domain}\n; Import into your DNS provider or add each record manually.\n${zoneLines(records)}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${domain}-dns-records.txt` })
  link.click()
  URL.revokeObjectURL(url)
}

function setupSummary(domain: Domain) {
  const ownership = recordsFor(domain, 'sending').filter(record => record.type === 'TXT')
  const parts = [domain.dkimStatus && domain.dkimStatus !== 'verified' && `DKIM ${domain.dkimStatus}`, ownership.length > 0 && !ownership.every(record => record.status === 'verified') && 'Ownership pending', ['pending', 'failed'].includes(domain.mailFromStatus) && `MAIL FROM ${domain.mailFromStatus}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Waiting for DNS'
}

export function DomainsPage() {
  const { regionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  const navigate = useNavigate()
  const [pageState, setPageState] = useState({ regionId, page: 1 })
  const page = pageState.regionId === regionId ? pageState.page : 1
  const domains = useApiDef(queries.domains(regionId, page), { keepPrevious: previous => previous[1] === regionId })
  const create = useApiMutation((api, input: { regionId: string; name: string }) => api.domains.create(input), 'Domain added', true)
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
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable loading={domains.isPending} skeletonRows={3} minRows={3} rows={domains.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/domains/${row.id}`)} empty={<EmptyState title={multiTenant ? 'No domains' : 'No domains in this region'} action={<Button onClick={openCreate}>Add domain</Button>} />} columns={[
        { ...settingsColumns.domains[0], render: row => <Link to={`/domains/${row.id}`}>{row.name}</Link> },
        { ...domainColumns(multiTenant)[1], render: row => <div className="settings-cell-stack"><StatusBadge status={label(row.status)} tone={row.status === 'issue' ? 'danger' : undefined} />{(row.status !== 'verified' || ['pending', 'failed'].includes(row.mailFromStatus)) && <div className="muted">{setupSummary(row)}</div>}</div> },
        ...multiTenant ? [] : [{ ...settingsColumns.domains[2], render: (row: Domain) => row.regionId }],
      ]} />
      {domains.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={10} total={domains.data.total} nextCursor={domains.data.nextCursor} onPageChange={next => setPageState({ regionId, page: next })} />}
    </>}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add domain" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="add-domain">Continue to DNS records</Button></>}>
      <form id="add-domain" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Domain name" htmlFor="domain-name" error={invalid || fieldError(create.error, 'name')}><Input id="domain-name" autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} placeholder="updates.acme.com" /></Field>
        {!multiTenant && <Field label="Sending region" htmlFor="domain-region"><Input id="domain-region" value={regionId} readOnly /></Field>}
      </form>
    </Dialog>
  </div>
}

export function DomainDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { regionId, setRegionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  const hosted = useSession()?.identity?.connection?.kind === 'shared'
  const [recheckUntil, setRecheckUntil] = useState(0)
  const domain = useDomain(id, recheckUntil)
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Checking records', true)
  const client = useQueryClient()
  // Invalidate only after leaving: refetching this domain would 404 while the dialog closes.
  const remove = useApiMutation((api, domainId: string) => api.domains.remove(domainId), 'Domain deleted', true, false)
  const configureMailFrom = useApiMutation((api, input: {id: string; mailFromDomain: string}) => api.domains.configureMailFrom(input.id, input.mailFromDomain), 'Custom MAIL FROM configured', true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [mailFromOpen, setMailFromOpen] = useState(false)
  const [mailFromDomain, setMailFromDomain] = useState('')
  const [mailFromInvalid, setMailFromInvalid] = useState('')
  function openMailFrom() { configureMailFrom.reset(); setMailFromDomain(domain.data?.mailFromDomain ?? `email.${domain.data?.name ?? ''}`); setMailFromInvalid(''); setMailFromOpen(true) }
  async function submitMailFrom(event: FormEvent) {
    event.preventDefault()
    const current = domain.data, value = mailFromDomain.trim().toLowerCase()
    if (!current || !domainPattern.test(value) || value === current.name || !value.endsWith(`.${current.name}`)) { setMailFromInvalid(`Use an unused subdomain of ${current?.name ?? 'this domain'}.`); return }
    setMailFromInvalid('')
    try { await configureMailFrom.mutateAsync({id, mailFromDomain: value}); setMailFromOpen(false) } catch { /* Shown inline. */ }
  }
  const dns = useDnsSetup(domain.data)
  if (domain.isPending || (!domain.error && dns.pending)) return <DomainDetailSkeleton />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  const mailFromRecords = recordsFor(current, 'mail_from')
  const mailFromName = current.mailFromDomain ?? mailFromRecords[0]?.name ?? null
  const state = domainState(current)
  const sesUrl = `https://${current.regionId}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(current.regionId)}#/identities/${encodeURIComponent(current.name)}`
  return <div className="stack">
    <PageHeader title={current.name} backTo="/domains" actions={<>
      <Button loading={verify.isPending} onClick={async () => { try { await verify.mutateAsync(id); if (multiTenant) setRecheckUntil(Date.now() + 30_000) } catch { /* Shown inline. */ } }}>Check now</Button>
      {!hosted && <a className="ui-button ui-button--secondary ui-button--md" href={sesUrl} target="_blank" rel="noreferrer">Open in SES</a>}
      {multiTenant && <Button variant="danger" onClick={() => { remove.reset(); setDeleteOpen(true) }}>Delete domain</Button>}
    </>} />
    <MutationError error={verify.error} />
    {!multiTenant && regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    <dl className="settings-facts domain-facts">
      <div><dt>Status</dt><dd><StatusBadge status={state.status} tone={state.tone} /></dd></div>
      {!multiTenant && <div><dt>Region</dt><dd>{current.regionId}</dd></div>}
    </dl>
    <div className="domain-sections">
      <DomainRecords domain={current} setup={dns.setup} actions={current.records.length > 0 && <Button onClick={() => downloadDnsRecords(current.name, current.records)}>Download .txt</Button>} />
      <details className="domain-advanced">
        <summary>Advanced</summary>
        <div className="domain-advanced-body">
          <div className="ui-section-header"><div className="domain-group-title"><h3>Custom MAIL FROM{mailFromName && <span className="muted"> · {mailFromName}</span>}</h3><p className="muted">Routes bounces through a subdomain you own for relaxed SPF alignment.</p></div>
            <div className="cluster">{mailFromName && <StatusBadge status={label(current.mailFromStatus)} />}<Button aria-label={mailFromName ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} onClick={openMailFrom}>{mailFromName ? 'Change' : 'Add'}</Button></div>
          </div>
          {mailFromRecords.length > 0 && <DnsRecordTable domain={current.name} records={mailFromRecords} />}
        </div>
      </details>
      {!hosted && <MailboxReceiving domainId={id} domainName={current.name} verified={current.status === 'verified'} />}
    </div>
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${current.name}?`} description="You can no longer send from this domain. Its DNS records stay at your DNS provider until you remove them." confirmLabel="Delete domain" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(id); navigate('/domains', { replace: true }); client.removeQueries({ predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[2] === 'domain' && query.queryKey[3] === id }); void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'opensend' && query.queryKey[2] === 'domains' }) }} />
    <Dialog open={mailFromOpen} onOpenChange={next => {if (!configureMailFrom.isPending) setMailFromOpen(next)}} title={current.mailFromDomain ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} footer={<><Button disabled={configureMailFrom.isPending} onClick={() => setMailFromOpen(false)}>Cancel</Button><Button variant="primary" loading={configureMailFrom.isPending} type="submit" form="configure-mail-from">Continue to DNS records</Button></>}>
      <form id="configure-mail-from" className="stack" onSubmit={submitMailFrom} noValidate>
        <MutationError error={configureMailFrom.error} />
        <Field label="MAIL FROM domain" htmlFor="mail-from-domain" error={mailFromInvalid || fieldError(configureMailFrom.error, 'mailFromDomain')}><Input id="mail-from-domain" autoFocus required value={mailFromDomain} onChange={event => setMailFromDomain(event.target.value)} disabled={configureMailFrom.isPending} placeholder={`email.${current.name}`} /></Field>
        <p className="muted">Use an unused subdomain of {current.name}.</p>
      </form>
    </Dialog>
  </div>
}

function MailboxReceiving({ domainId, domainName, verified }: { domainId: string; domainName: string; verified: boolean }) {
  const { multiTenant } = useWorkspaceAccess()
  const receiving = useApiQuery(['mailbox-domain', domainId], (api, signal) => api.mailboxes.domain(domainId, signal), { interval: state => state && ['provisioning', 'waiting_for_mx', 'disabling'].includes(state.status) ? 30_000 : false })
  const enable = useApiMutation((api, force: boolean) => api.mailboxes.enableDomain(domainId, { force }), 'Receiving setup started')
  const disable = useApiMutation((api, _: void) => api.mailboxes.disableDomain(domainId), 'Receiving turned off')
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked')
  const [conflict, setConflict] = useState<string | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  async function start() {
    try { await enable.mutateAsync(false) }
    catch (error) { if (error instanceof ApiError && error.code === 'MX_CONFLICT') { enable.reset(); setConflict(error.message.replace(/ Retry with force=true to continue anyway\. \[MX_CONFLICT\].*$/, '')) } }
  }
  if (receiving.error) return <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={receiving.error} onRetry={() => void receiving.refetch()} /></section>
  const state = receiving.data
  const on = !!state && !['off', 'disabled'].includes(state.status)
  const status = state ? receivingStatus[state.status] : null
  const records: DnsRecord[] = (state?.dns ?? []).map((record, index) => ({ id: `mx_${index}`, type: 'MX', name: record.name, value: `${record.priority} ${record.value}`, status: state?.mx?.state === 'active' ? 'verified' : 'pending' }))
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>Receiving</h2><p className="muted">Receive mail on {domainName}. Manage addresses in <Link to="/receiving">Receiving</Link>.</p></div>
      <div className="cluster">{on ? <>
        <Button loading={check.isPending} onClick={async () => { try { await check.mutateAsync() } catch { /* Shown inline. */ } }}>Check MX</Button>
        {state!.status !== 'disabling' && <Button onClick={() => setDisableOpen(true)}>Turn off</Button>}
      </> : <Button variant="primary" disabled={!verified || !state} loading={enable.isPending} onClick={start}>Enable receiving</Button>}</div>
    </div>
    <MutationError error={enable.error ?? disable.error ?? check.error} />
    {!verified && !on && <p className="muted">Verify the domain before enabling receiving.</p>}
    {state && status && on && <>
      <dl className="settings-facts domain-facts">
        <div><dt>Status</dt><dd><StatusBadge status={status.label} tone={status.tone} /></dd></div>
        <div><dt>Unknown addresses</dt><dd>{catchAllLabel[state.catchAll]}</dd></div>
        <div><dt>Addresses</dt><dd><Link to="/receiving">{state.addressCount}</Link></dd></div>
        {!multiTenant && <div><dt>Region</dt><dd>{state.region}</dd></div>}
      </dl>
      {state.lastError && <Alert tone="danger">{state.lastError}</Alert>}
      {state.status === 'provisioning' && <Alert tone="info">Creating the S3 bucket, SNS topic and SES receipt rule. This usually takes under a minute.</Alert>}
      {state.mx && state.status !== 'provisioning' && <Alert tone={mxTone(state.mx.state)}>{state.mx.message}</Alert>}
      <DnsRecordTable domain={domainName} records={records} />
    </>}
    <ConfirmDialog open={!!conflict} onOpenChange={open => { if (!open) setConflict(null) }} title={`Move mail for ${domainName}?`} description={`${conflict ?? ''} Mail stops arriving at that provider once the MX record changes.`} confirmLabel="Enable anyway" danger onConfirm={() => enable.mutateAsync(true)} />
    <ConfirmDialog open={disableOpen} onOpenChange={setDisableOpen} title={`Stop receiving on ${domainName}?`} description="SES stops accepting mail for this domain. Addresses and stored messages are kept." confirmLabel="Turn off" danger onConfirm={() => disable.mutateAsync()} />
  </section>
}
