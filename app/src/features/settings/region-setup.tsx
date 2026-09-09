import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Input, SectionHeader, StatusBadge } from '../../components/ui'
import { useApi, useRegion } from '../../data/context'
import { regionCatalogKey, regionDiscoveryKey, useRegionAccess, useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import type { RegionCatalog, RegionCatalogEntry, SesDiscovery } from '../../data/types'
import { date, label, number } from '../../lib/format'
import { fieldError, MutationError } from './shared'
import { RegionDiscoverySkeleton, settingsColumns } from './skeletons'

const activeJob = (entry: RegionCatalogEntry) => entry.provisionStatus === 'pending' || entry.provisionStatus === 'running'
const flag = (value: boolean | null | undefined, yes = 'Yes', no = 'No') => value == null ? 'Unknown' : value ? yes : no
const amount = (value: number | null | undefined) => value == null ? 'Unknown' : number(value)
const checkedAt = (value: string) => date(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })

export function RegionSetup() {
  const api = useApi()
  const client = useQueryClient()
  const {regionId, setRegionId} = useRegion()
  const {canManage, canDiscover} = useRegionAccess()
  const catalog = useRegionCatalog()
  const [viewRegion, setViewRegion] = useState<string | null>(null)
  const [enableOpen, setEnableOpen] = useState(false)
  const [newRegion, setNewRegion] = useState('')
  const [disableRegion, setDisableRegion] = useState<RegionCatalogEntry | null>(null)
  const [inspectionError, setInspectionError] = useState<unknown>(null)
  const [inspectedRegion, setInspectedRegion] = useState<string | null>(null)
  const entry = catalog.data?.data.find(item => item.region === (viewRegion ?? regionId))
  useEffect(() => {setViewRegion(null); setInspectionError(null); setInspectedRegion(null)}, [regionId])
  const configure = useMutation({
    mutationFn: ({region, ...input}: {region: string; enabled?: boolean; makeDefault?: boolean}) => api.regions.configure(region, input),
    onSuccess: data => client.setQueryData(regionCatalogKey(api), data),
  })
  async function inspectEnabled(region: string) {
    setViewRegion(null)
    setRegionId(region)
    setEnableOpen(false)
    setInspectionError(null)
    if (canDiscover) {
      try {
        await client.fetchQuery({queryKey: regionDiscoveryKey(api, region), queryFn: ({signal}) => api.regions.discover(region, undefined, signal), staleTime: 0})
        setInspectedRegion(region)
        void client.invalidateQueries({queryKey: regionCatalogKey(api)})
      } catch (error) { setInspectionError(error) }
    }
  }
  async function enable(region: string) {
    await configure.mutateAsync({region, enabled: true})
    await inspectEnabled(region)
  }
  async function makeDefault(row: RegionCatalogEntry) {
    await configure.mutateAsync({region: row.region, makeDefault: true})
    if (!row.enabled) await inspectEnabled(row.region)
  }
  async function submitEnable(event: FormEvent) {
    event.preventDefault()
    try { await enable(newRegion.trim().toLowerCase()) } catch { /* Shown inside the dialog. */ }
  }
  return <>
    <section className="section stack">
      <SectionHeader title="Sending regions" actions={<div className="cluster"><Button loading={catalog.isFetching} onClick={() => void catalog.refetch()}>Refresh catalog</Button><Button variant="primary" disabled={!canManage || configure.isPending} onClick={() => {configure.reset(); setNewRegion(''); setEnableOpen(true)}}>Enable region</Button></div>} />
      <MutationError error={catalog.error} />
      {!enableOpen && !disableRegion && <MutationError error={configure.error} />}
      <MutationError error={inspectionError} />
      <DataTable loading={catalog.isPending} skeletonRows={3} minRows={3} rowSize="large" rows={catalog.data?.data ?? []} rowKey={row => row.region} selectedId={entry?.region} empty={<EmptyState title="No regions configured" />} columns={[
        {...settingsColumns.regions[0], render: row => row.region},
        {...settingsColumns.regions[1], render: row => <><StatusBadge status={row.enabled ? 'Enabled' : 'Disabled'} tone={row.enabled ? 'success' : 'neutral'} />{row.isDefault && <div className="muted">Default</div>}</>},
        {...settingsColumns.regions[2], render: row => <StatusBadge status={activeJob(row) ? 'Pending setup' : row.discoveryStatus} tone={activeJob(row) ? 'neutral' : row.discoveryStatus === 'ready' ? 'success' : row.discoveryStatus === 'blocked' ? 'warning' : 'neutral'} />},
        {...settingsColumns.regions[3], render: row => <><StatusBadge status={row.provisionStatus === 'pending' ? 'Queued' : row.provisionStatus ?? 'Not requested'} tone={row.provisionStatus === 'failed' ? 'danger' : 'neutral'} />{row.provisionError && <div className="settings-job-error" title={row.provisionError}>{row.provisionError}</div>}</>},
        {...settingsColumns.regions[4], render: row => <div className="cluster settings-row-actions settings-region-actions"><Button variant="ghost" disabled={entry?.region === row.region} onClick={() => {setInspectionError(null); if (row.enabled) {setViewRegion(null); setRegionId(row.region)} else setViewRegion(row.region)}}>{entry?.region === row.region ? 'Selected' : row.enabled ? 'Select' : 'View'}</Button><Button disabled={!canManage || row.isDefault || configure.isPending} onClick={() => {void makeDefault(row).catch(() => {})}}>Make default</Button>{row.enabled ? <Button variant="ghost" disabled={!canManage || row.isDefault || activeJob(row) || configure.isPending} title={row.isDefault ? 'Choose another default before disabling this region.' : activeJob(row) ? 'Wait for provisioning to finish.' : undefined} onClick={() => {configure.reset(); setDisableRegion(row)}}>Disable</Button> : <Button disabled={!canManage || configure.isPending} title="Enabling also inspects live AWS; no resources are created." onClick={() => {void enable(row.region).catch(() => {})}}>Enable</Button>}</div>},
      ]} />
      <p className="muted">Region settings are shared by Live and Test. Discovery only reads live AWS; provisioning requires confirmation.</p>
    </section>
    {entry ? <RegionDetail key={entry.region} entry={entry} inspected={inspectedRegion === entry.region} /> : !catalog.isPending && <p className="muted">Select a configured region to inspect its SES setup.</p>}
    <Dialog open={enableOpen} onOpenChange={open => {if (!configure.isPending) setEnableOpen(open)}} title="Enable region" footer={<><Button disabled={configure.isPending} onClick={() => setEnableOpen(false)}>Cancel</Button><Button variant="primary" loading={configure.isPending} type="submit" form="enable-ses-region">Enable region</Button></>}>
      <form id="enable-ses-region" className="stack" onSubmit={submitEnable}>
        <MutationError error={configure.error} />
        <Field label="AWS region" htmlFor="ses-region" error={fieldError(configure.error, 'region')} hint="Enabling also inspects live AWS; no resources are created."><Input id="ses-region" value={newRegion} onChange={event => setNewRegion(event.target.value)} placeholder="us-east-1" maxLength={32} pattern="[a-z]{2}(-[a-z]+)+-[0-9]" required autoFocus disabled={configure.isPending} /></Field>
      </form>
    </Dialog>
    <ConfirmDialog open={disableRegion !== null} onOpenChange={open => {if (!open) setDisableRegion(null)}} title={`Disable ${disableRegion?.region ?? 'region'}?`} description="New sending in this region will be disabled in Live and Test. AWS resources and historical mail are not deleted. Regions with active provisioning or other in-use restrictions cannot be disabled." confirmLabel="Disable region" danger pending={configure.isPending} onConfirm={async () => {if (disableRegion) await configure.mutateAsync({region: disableRegion.region, enabled: false})}} />
  </>
}

function RegionDetail({entry, inspected}: {entry: RegionCatalogEntry; inspected: boolean}) {
  const api = useApi()
  const client = useQueryClient()
  const {canManage, canDiscover, autoDiscover} = useRegionAccess()
  const [explicitInspection, setExplicitInspection] = useState(false)
  const discovery = useRegionDiscovery(entry, {auto: autoDiscover || inspected || explicitInspection})
  const [confirmOpen, setConfirmOpen] = useState(false)
  const refresh = useMutation({
    mutationFn: () => api.regions.discover(entry.region, {refresh: true}),
    onSuccess: report => {
      client.setQueryData(regionDiscoveryKey(api, entry.region), report)
      setExplicitInspection(true)
      void client.invalidateQueries({queryKey: regionCatalogKey(api)})
    },
  })
  const provision = useMutation({
    mutationFn: () => api.regions.provision(entry.region),
    onSuccess: receipt => {
      setExplicitInspection(true)
      client.setQueryData<RegionCatalog>(regionCatalogKey(api), old => old ? {...old, data: old.data.map(row => row.region === entry.region ? {...row, provisionJobId: receipt.jobId, provisionStatus: receipt.status, provisionError: null} : row)} : old)
      void client.invalidateQueries({queryKey: regionCatalogKey(api)})
    },
  })
  const report = discovery.data
  const running = activeJob(entry)
  const discovering = entry.discoveryStatus === 'discovering'
  const ready = !running && report?.status === 'ready' && report.provisioned && report.resources.topic.subscription === 'confirmed'
  const hardBlocker = report?.blockers.find(issue => !['SES_SANDBOX', 'SES_SENDING_DISABLED', 'SES_ACCOUNT_ENFORCEMENT', 'SES_DOMAIN_REQUIRED', 'SES_CONFIGURATION_SET_DISABLED', 'SNS_CONFIRMATION_PENDING'].includes(issue.code))
  const status = discovering ? 'Discovering' : running ? entry.provisionStatus === 'pending' ? 'Queued' : 'Provisioning' : report?.resources.topic.subscription === 'pending' ? 'Awaiting confirmation' : ready ? 'Ready' : report ? report.status === 'ready' ? 'Needs provisioning' : label(report.status) : 'Not inspected'
  return <section className="section stack settings-region-detail" aria-label={`${entry.region} setup`}>
    <SectionHeader title={`${entry.region} · SES setup`} actions={<div className="cluster"><Button disabled={!canDiscover || !entry.enabled || discovering || refresh.isPending} loading={discovery.isFetching || refresh.isPending} onClick={() => {if (!report) void discovery.refetch().then(result => {if (result.data) setExplicitInspection(true)}); else refresh.mutate()}}>{!autoDiscover ? 'Inspect live AWS' : report ? 'Refresh discovery' : 'Inspect AWS'}</Button><Button variant="primary" disabled={!canManage || !entry.enabled || running || discovering || !report || Boolean(hardBlocker) || provision.isPending} title={hardBlocker?.message} onClick={() => {provision.reset(); setConfirmOpen(true)}}>{entry.provisionStatus === 'failed' ? 'Retry provisioning' : 'Provision resources'}</Button></div>} />
    <div className="cluster settings-discovery-state"><StatusBadge status={status} tone={ready ? 'success' : report?.status === 'blocked' && !running ? 'warning' : 'neutral'} />{report && <span className="muted">Last checked {checkedAt(report.checkedAt)} UTC</span>}</div>
    {!entry.enabled && <p className="muted">This region is disabled. Enable it to inspect AWS or provision resources.</p>}
    {!canDiscover && <p className="muted">Read permission is required to inspect live AWS.</p>}
    {entry.provisionJobId && <div className="settings-job-state" role="status"><span>Provisioning job · {entry.provisionStatus === 'pending' ? 'Queued' : label(entry.provisionStatus ?? 'unknown')}</span><code className="settings-break">{entry.provisionJobId}</code></div>}
    {entry.provisionError && <Alert tone="danger">{entry.provisionError}</Alert>}
    <MutationError error={discovery.error || refresh.error} />
    {!confirmOpen && <MutationError error={provision.error} />}
    {!report && (discovery.isFetching || discovering) ? <RegionDiscoverySkeleton /> : report ? <DiscoveryReport report={report} /> : <p className="muted">{entry.enabled ? 'No discovery report loaded. Inspect live AWS to check account access and existing resources without creating anything.' : 'No discovery report is loaded for this region.'}</p>}
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={`Provision ${entry.region}?`} description="Create or repair this installation’s owned SES configuration sets, SNS feedback topic, policy, event destinations, and HTTPS subscription in live AWS. This does not change DNS, grant SES production approval, or send email. Setup runs as a background job; readiness is checked separately." confirmLabel="Provision resources" pending={provision.isPending} onConfirm={() => provision.mutateAsync()} />
  </section>
}

function DiscoveryReport({report}: {report: SesDiscovery}) {
  const {account, resources} = report
  const topic = resources.topic
  return <>
    {report.blockers.length > 0 && <Alert tone="warning" title="Readiness blockers"><ul className="settings-issues">{report.blockers.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Alert>}
    {report.warnings.length > 0 && <Alert tone="warning" title="Warnings"><ul className="settings-issues">{report.warnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Alert>}
    <div className="stack settings-discovery-section"><h3>Account</h3><dl className="settings-facts">
      <div><dt>AWS account</dt><dd>{account?.id ?? 'Unknown'}</dd></div><div><dt>Access</dt><dd>{flag(account?.productionAccess, 'Production', 'Sandbox')}</dd></div><div><dt>Sending</dt><dd>{flag(account?.sendingEnabled, 'Enabled', 'Disabled')}</dd></div><div><dt>Enforcement</dt><dd>{account?.enforcementStatus ?? 'Unknown'}</dd></div><div><dt>Sent in last 24h / quota</dt><dd>{amount(account?.quota.sentLast24Hours)} / {amount(account?.quota.max24HourSend)}</dd></div><div><dt>Maximum send rate</dt><dd>{amount(account?.quota.maxSendRate)}{account?.quota.maxSendRate != null ? ' / sec' : ''}</dd></div>
    </dl></div>
    <div className="stack settings-discovery-section"><h3>Discovered domains</h3>{report.identitiesTruncated && <p className="muted">Identity discovery was truncated. This list is incomplete.</p>}<DataTable rows={report.domains} rowKey={row => row.name} rowSize="large" empty={<EmptyState title={report.account ? 'No domains returned by discovery' : 'Domains unknown'} />} columns={[
      {key: 'name', label: 'Domain', render: row => row.name}, {key: 'status', label: 'Verification', render: row => row.verificationStatus ?? 'Unknown'}, {key: 'sending', label: 'Sending', render: row => flag(row.sendingEnabled, 'Enabled', 'Disabled')},
    ]} /></div>
    <div className="stack settings-discovery-section"><h3>Configuration sets</h3><DataTable rowSize="large" rows={(['transactional', 'marketing'] as const).map(kind => ({kind, ...resources[kind]}))} rowKey={row => row.kind} columns={[
      {...settingsColumns.configurationSets[0], render: row => <>{label(row.kind)}<div className="muted settings-break">{row.name}</div></>}, {...settingsColumns.configurationSets[1], render: row => flag(row.exists)}, {...settingsColumns.configurationSets[2], render: row => flag(row.owned)}, {...settingsColumns.configurationSets[3], render: row => flag(row.sendingEnabled, 'Enabled', 'Disabled')}, {...settingsColumns.configurationSets[4], render: row => flag(row.eventDestinationExists, 'Exists', 'Missing')}, {...settingsColumns.configurationSets[5], render: row => flag(row.eventWired, 'Ready', 'Not wired')},
    ]} /><div className="muted settings-break">Event destination · {resources.eventDestinationName}</div></div>
    <div className="stack settings-discovery-section"><h3>SNS feedback</h3><dl className="settings-facts">
      <div className="settings-fact-wide"><dt>Topic name</dt><dd>{topic.name}</dd></div><div className="settings-fact-wide"><dt>Topic ARN</dt><dd>{topic.arn ?? 'Unknown'}</dd></div><div><dt>Exists</dt><dd>{flag(topic.exists)}</dd></div><div><dt>Owned</dt><dd>{flag(topic.owned)}</dd></div><div><dt>Policy</dt><dd>{flag(topic.policyReady, 'Ready', 'Not ready')}</dd></div><div><dt>Subscription</dt><dd>{topic.subscription === 'pending' ? 'Awaiting confirmation' : label(topic.subscription)}</dd></div><div><dt>Raw message delivery</dt><dd>{flag(topic.rawMessageDelivery, 'Enabled', 'Disabled')}</dd></div><div><dt>Other HTTPS subscriptions</dt><dd>{number(topic.staleSubscriptions)}</dd></div><div className="settings-fact-wide"><dt>Feedback URL</dt><dd>{report.feedbackUrl ?? 'Unknown'}</dd></div>
    </dl>{topic.subscriptionsTruncated && <p className="muted">Subscription discovery was truncated. Subscription state is incomplete.</p>}</div>
  </>
}
