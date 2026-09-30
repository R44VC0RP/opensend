import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, StatusBadge, type Tone } from '../../components/ui'
import { useApiMutation, useApiQuery, useRegion, useApi } from '../../data/context'
import { label } from '../../lib/format'
import { ApiError, type DnsRecord, type Domain, type MailboxDomain } from '../../data/types'
import { receivingStatus } from '../mailboxes/status'
import { fieldError, MutationError } from './shared'
import { DomainDetailSkeleton, settingsColumns } from './skeletons'

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

const fqdn = (name: string) => name.endsWith('.') ? name : `${name}.`

function downloadDnsRecords(domain: string, records: { type: string; name: string; value: string }[]) {
  const lines = records.map(record => {
    const value = record.type === 'TXT' ? `"${record.value.replace(/"/g, '\\"')}"`
      : record.type === 'MX' ? record.value.replace(/(\S+)$/, target => fqdn(target))
      : fqdn(record.value)
    return `${fqdn(record.name)}\t3600\tIN\t${record.type}\t${value}`
  })
  const text = `; DNS records for ${domain}\n; Import into your DNS provider or add each record manually.\n${lines.join('\n')}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${domain}-dns-records.txt` })
  link.click()
  URL.revokeObjectURL(url)
}

function setupSummary(domain: Domain) {
  const parts = [domain.dkimStatus && domain.dkimStatus !== 'verified' && `DKIM ${domain.dkimStatus}`, ['pending', 'failed'].includes(domain.mailFromStatus) && `MAIL FROM ${domain.mailFromStatus}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Waiting for SES'
}

function LiveDomainsPage() {
  const { regionId } = useRegion()
  const navigate = useNavigate()
  const [pageState, setPageState] = useState({ regionId, page: 1 })
  const page = pageState.regionId === regionId ? pageState.page : 1
  const domains = useApiQuery(['domains', regionId, page], (api, signal) => api.domains.list({ regionId, page, pageSize: 10 }, signal))
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
      <DataTable loading={domains.isPending} skeletonRows={3} minRows={3} rows={domains.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/domains/${row.id}`)} empty={<EmptyState title="No domains in this region" action={<Button onClick={openCreate}>Add domain</Button>} />} columns={[
        { ...settingsColumns.domains[0], render: row => <Link to={`/domains/${row.id}`}>{row.name}</Link> },
        { ...settingsColumns.domains[1], render: row => <div className="settings-cell-stack"><StatusBadge status={label(row.status)} tone={row.status === 'issue' ? 'danger' : undefined} />{row.status !== 'verified' && <div className="muted">{setupSummary(row)}</div>}</div> },
        { ...settingsColumns.domains[2], render: row => row.regionId },
        { ...settingsColumns.domains[3], render: row => <Link to={`/domains/${row.id}`}>{row.status === 'verified' && row.mailFromStatus === 'verified' ? 'Manage' : 'Review records'}</Link> },
      ]} />
      {domains.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={10} total={domains.data.total} nextCursor={domains.data.nextCursor} onPageChange={next => setPageState({ regionId, page: next })} />}
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

function LiveDomainDetailPage() {
  const { id = '' } = useParams()
  const { regionId, setRegionId } = useRegion()
  const domain = useApiQuery(['domain', id], (api, signal) => api.domains.get(id, signal))
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Domain readiness refreshed', true)
  const configureMailFrom = useApiMutation((api, input: {id: string; mailFromDomain: string}) => api.domains.configureMailFrom(input.id, input.mailFromDomain), 'Custom MAIL FROM configured', true)
  const [mailFromOpen, setMailFromOpen] = useState(false)
  const [mailFromDomain, setMailFromDomain] = useState('')
  const [mailFromInvalid, setMailFromInvalid] = useState('')
  function openMailFrom() { configureMailFrom.reset(); setMailFromDomain(domain.data?.mailFromDomain ?? domain.data?.records.find(record => record.type !== 'CNAME')?.name ?? `email.${domain.data?.name ?? ''}`); setMailFromInvalid(''); setMailFromOpen(true) }
  async function submitMailFrom(event: FormEvent) {
    event.preventDefault()
    const current = domain.data, value = mailFromDomain.trim().toLowerCase()
    if (!current || !domainPattern.test(value) || value === current.name || !value.endsWith(`.${current.name}`)) { setMailFromInvalid(`Use an unused subdomain of ${current?.name ?? 'this domain'}.`); return }
    setMailFromInvalid('')
    try { await configureMailFrom.mutateAsync({id, mailFromDomain: value}); setMailFromOpen(false) } catch { /* Shown inline. */ }
  }
  if (domain.isPending) return <DomainDetailSkeleton />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  const dkimRecords = current.records.filter(record => record.type === 'CNAME')
  const mailFromRecords = current.records.filter(record => record.type !== 'CNAME')
  const mailFromName = current.mailFromDomain ?? mailFromRecords[0]?.name ?? null
  const dkimStatus = current.dkimStatus ?? (current.status === 'verified' ? 'verified' : 'pending')
  const sending = current.status === 'verified' ? { status: 'Ready', tone: 'success' as const } : current.status === 'issue' ? { status: 'Failed', tone: 'danger' as const } : { status: 'Waiting for DNS', tone: 'warning' as const }
  const sesUrl = `https://${current.regionId}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(current.regionId)}#/identities/${encodeURIComponent(current.name)}`
  return <div className="stack">
    <PageHeader title={current.name} backTo="/domains" actions={<><a className="ui-button ui-button--secondary ui-button--md" href={sesUrl} target="_blank" rel="noreferrer">Open in SES</a><Button variant="primary" loading={verify.isPending} onClick={async () => { try { await verify.mutateAsync(id) } catch { /* Shown inline. */ } }}>Verify records</Button></>} />
    <MutationError error={verify.error} />
    {regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    <dl className="settings-facts settings-account-summary">
      <div><dt>Sending</dt><dd><StatusBadge status={sending.status} tone={sending.tone} /></dd></div>
      <div><dt>DKIM</dt><dd><StatusBadge status={label(dkimStatus)} /></dd></div>
      <div><dt>Custom MAIL FROM</dt><dd>{mailFromName ? <StatusBadge status={label(current.mailFromStatus)} /> : <span className="muted">Not configured</span>}</dd></div>
      <div><dt>Region</dt><dd>{current.regionId}</dd></div>
    </dl>
    <section className="section stack">
      <div className="ui-section-header"><div className="domain-group-title"><h2>DNS records</h2><p className="muted">Add these records at your DNS provider, then verify. SES can take up to 72 hours to detect changes.</p></div>{current.records.length > 0 && <Button onClick={() => downloadDnsRecords(current.name, current.records)}>Download .txt</Button>}</div>
      {current.dnsStatus === 'unavailable' && <Alert tone="warning">{current.dnsUnavailableReason || 'DNS records are unavailable from SES. Try refreshing domain readiness.'}</Alert>}
      {dkimRecords.length > 0 && <div className="stack settings-discovery-section">
        <div className="ui-section-header"><div className="domain-group-title"><h3>DKIM</h3><p className="muted">Signs mail sent from {current.name}.</p></div></div>
        <DnsRecordTable records={dkimRecords} />
      </div>}
      <div className="stack settings-discovery-section">
        <div className="ui-section-header"><div className="domain-group-title"><h3>Custom MAIL FROM{mailFromName && <span className="muted"> · {mailFromName}</span>}</h3><p className="muted">{mailFromName ? 'Routes bounces through your subdomain and aligns SPF.' : 'Optional. Routes bounces through a subdomain you own and aligns SPF.'}</p></div><Button onClick={openMailFrom}>{mailFromName ? 'Change' : 'Add custom MAIL FROM'}</Button></div>
        {mailFromRecords.length > 0 && <DnsRecordTable records={mailFromRecords} />}
      </div>
    </section>
    <MailboxReceiving domainId={id} domainName={current.name} verified={current.status === 'verified'} />
    <Dialog open={mailFromOpen} onOpenChange={next => {if (!configureMailFrom.isPending) setMailFromOpen(next)}} title={current.mailFromDomain ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} footer={<><Button disabled={configureMailFrom.isPending} onClick={() => setMailFromOpen(false)}>Cancel</Button><Button variant="primary" loading={configureMailFrom.isPending} type="submit" form="configure-mail-from">Continue to DNS records</Button></>}>
      <form id="configure-mail-from" className="stack" onSubmit={submitMailFrom} noValidate>
        <MutationError error={configureMailFrom.error} />
        <Field label="MAIL FROM domain" htmlFor="mail-from-domain" error={mailFromInvalid || fieldError(configureMailFrom.error, 'mailFromDomain')}><Input id="mail-from-domain" autoFocus required value={mailFromDomain} onChange={event => setMailFromDomain(event.target.value)} disabled={configureMailFrom.isPending} placeholder={`email.${current.name}`} /></Field>
        <p className="muted">Use an unused subdomain of {current.name}. OpenSend will show its MX and SPF records here.</p>
      </form>
    </Dialog>
  </div>
}

const mxTone = (state: NonNullable<MailboxDomain['mx']>['state']): Tone => state === 'active' ? 'success' : state === 'missing' || state === 'error' ? 'info' : 'warning'

function MailboxReceiving({ domainId, domainName, verified }: { domainId: string; domainName: string; verified: boolean }) {
  const receiving = useApiQuery(['mailbox-domain', domainId], (api, signal) => api.mailboxes.domain(domainId, signal))
  const enable = useApiMutation((api, force: boolean) => api.mailboxes.enableDomain(domainId, { force }), 'Mailbox setup started')
  const disable = useApiMutation((api, _: void) => api.mailboxes.disableDomain(domainId), 'Receiving turned off')
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked')
  const [conflict, setConflict] = useState<string | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  async function start() {
    try { await enable.mutateAsync(false) }
    catch (error) { if (error instanceof ApiError && error.code === 'MX_CONFLICT') { enable.reset(); setConflict(error.message.replace(/ Retry with force=true to continue anyway\. \[MX_CONFLICT\].*$/, '')) } }
  }
  if (receiving.error) return <section className="section stack"><SectionHeader title="Mailboxes" /><ErrorState error={receiving.error} onRetry={() => void receiving.refetch()} /></section>
  const state = receiving.data
  const on = !!state && !['off', 'disabled'].includes(state.status)
  const status = state ? receivingStatus[state.status] : null
  const records: DnsRecord[] = (state?.dns ?? []).map((record, index) => ({ id: `mx_${index}`, type: 'MX', name: record.name, value: `${record.priority} ${record.value}`, status: state?.mx?.state === 'active' ? 'verified' : 'pending' }))
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>Mailboxes</h2><p className="muted">Receive mail on {domainName} and manage mailboxes through the mailbox API.</p></div>
      <div className="cluster">{on ? <>
        <Button loading={check.isPending} onClick={async () => { try { await check.mutateAsync() } catch { /* Shown inline. */ } }}>Check MX</Button>
        {state!.status !== 'disabling' && <Button onClick={() => setDisableOpen(true)}>Turn off</Button>}
      </> : <Button variant="primary" disabled={!verified || !state} loading={enable.isPending} onClick={start}>Enable mailboxes</Button>}</div>
    </div>
    <MutationError error={enable.error ?? disable.error ?? check.error} />
    {!verified && !on && <p className="muted">Verify the domain before enabling mailboxes.</p>}
    {state && status && on && <>
      <dl className="settings-facts settings-account-summary">
        <div><dt>Receiving</dt><dd><StatusBadge status={status.label} tone={status.tone} /></dd></div>
        <div><dt>Unknown addresses</dt><dd>{state.catchAll === 'create_mailbox' ? 'Create a mailbox' : 'Store as unrouted'}</dd></div>
        <div><dt>Mailboxes</dt><dd><Link to="/mailboxes">{state.mailboxCount}</Link></dd></div>
        <div><dt>Region</dt><dd>{state.region}</dd></div>
      </dl>
      {state.lastError && <Alert tone="danger">{state.lastError}</Alert>}
      {state.status === 'provisioning' && <Alert tone="info">Creating the S3 bucket, SNS topic and SES receipt rule. This usually takes under a minute.</Alert>}
      {state.mx && state.status !== 'provisioning' && <Alert tone={mxTone(state.mx.state)}>{state.mx.message}</Alert>}
      <DnsRecordTable records={records} />
    </>}
    <ConfirmDialog open={!!conflict} onOpenChange={open => { if (!open) setConflict(null) }} title={`Move mail for ${domainName}?`} description={`${conflict ?? ''} Existing mailboxes at that provider stop receiving mail once the MX record changes.`} confirmLabel="Enable anyway" danger onConfirm={() => enable.mutateAsync(true)} />
    <ConfirmDialog open={disableOpen} onOpenChange={setDisableOpen} title={`Stop receiving on ${domainName}?`} description="SES stops accepting mail for this domain. Mailboxes and stored messages are kept." confirmLabel="Turn off" danger onConfirm={() => disable.mutateAsync()} />
  </section>
}

function DnsRecordTable({ records }: { records: DnsRecord[] }) {
  return <DataTable rows={records} rowKey={record => record.id} columns={[
    { ...settingsColumns.dns[0], render: record => record.type },
    { ...settingsColumns.dns[1], render: record => <div className="settings-copy-cell"><code title={record.name}>{record.name}</code><CopyButton value={record.name} label={`Copy ${record.type} record name`} /></div> },
    { ...settingsColumns.dns[2], render: record => <div className="settings-copy-cell"><code title={record.value}>{record.value}</code><CopyButton value={record.value} label={`Copy ${record.type} record value`} /></div> },
  ]} />
}

function TestDomainsNotice() { return <><PageHeader title="Domains" /><Alert tone="info">Domains are managed in live mode only.</Alert></> }
export function DomainsPage() { return useApi().environment === 'test' ? <TestDomainsNotice /> : <LiveDomainsPage /> }
export function DomainDetailPage() { return useApi().environment === 'test' ? <TestDomainsNotice /> : <LiveDomainDetailPage /> }
