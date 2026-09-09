import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { useLocation } from 'react-router'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Input, SectionHeader, Select, StatusBadge } from '../../components/ui'
import { useApi, useRegion } from '../../data/context'
import { regionCatalogKey, regionDiscoveryKey, useRegionAccess, useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import type { RegionCatalog, RegionCatalogEntry, SesDiscovery } from '../../data/types'
import { date, label, number } from '../../lib/format'
import { fieldError, MutationError } from './shared'
import { RegionDiscoverySkeleton, settingsColumns } from './skeletons'

const activeJob = (entry: RegionCatalogEntry) => entry.provisionStatus === 'pending' || entry.provisionStatus === 'running'
const flag = (value: boolean | null | undefined, yes = 'Yes', no = 'No') => value == null ? 'Unknown' : value ? yes : no
const amount = (value: number | null | undefined) => value == null ? 'Unknown' : number(value)
const checkedAt = (value: string) => date(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
function regionStatus(entry: RegionCatalogEntry) {
  if (!entry.enabled) return 'Disabled'
  if (activeJob(entry)) return entry.provisionStatus === 'pending' ? 'Queued' : 'Provisioning'
  if (entry.discoveryStatus === 'discovering') return 'Checking'
  if (entry.discoveryStatus === 'ready') return 'Ready'
  if (entry.provisionStatus === 'failed') return 'Setup failed'
  return ({ not_discovered: 'Not checked', stale: 'Check needed', ready: 'Ready', needs_provisioning: 'Needs setup', blocked: 'Needs attention' } as const)[entry.discoveryStatus]
}
function setupError(code: string) {
  if (code === 'AWS_ACCESS_DENIED') return 'AWS denied setup. Check the IAM policy, then retry.'
  if (code === 'AWS_CONNECTION_CHANGED') return 'Connection settings changed. Check AWS, then retry setup.'
  if (code === 'ORIGIN_KEY_REVOKED') return 'Setup stopped because its requester no longer has access.'
  return label(code)
}

export function RegionSetup() {
  const api = useApi()
  const client = useQueryClient()
  const {regionId} = useRegion()
  const location = useLocation()
  const {canManage, canDiscover} = useRegionAccess()
  const catalog = useRegionCatalog()
  const [viewRegion, setViewRegion] = useState<string | null>(null)
  const [enableOpen, setEnableOpen] = useState(false)
  const [newRegion, setNewRegion] = useState('')
  const [disableRegion, setDisableRegion] = useState<RegionCatalogEntry | null>(null)
  const [inspectedRegion, setInspectedRegion] = useState<string | null>(null)
  const entry = catalog.data?.data.find(item => item.region === (viewRegion ?? regionId))
  useEffect(() => {setViewRegion(new URLSearchParams(location.search).get('region') === regionId ? regionId : null); setInspectedRegion(null)}, [regionId, location.key, location.search])
  const configure = useMutation({
    mutationFn: ({region, ...input}: {region: string; enabled?: boolean; makeDefault?: boolean}) => api.regions.configure(region, input),
    onSuccess: data => client.setQueryData(regionCatalogKey(api), data),
  })
  async function enable(region: string) {
    await configure.mutateAsync({region, enabled: true})
    setViewRegion(region)
    setEnableOpen(false)
    if (canDiscover) setInspectedRegion(region)
  }
  async function submitEnable(event: FormEvent) {
    event.preventDefault()
    try { await enable(newRegion.trim().toLowerCase()) } catch { /* Shown inside the dialog. */ }
  }
  return <>
    <section className="section stack">
      <SectionHeader title="Regions" actions={<div className="cluster"><Button loading={catalog.isFetching} onClick={() => void catalog.refetch()}>Refresh</Button><Button variant="primary" disabled={!canManage || configure.isPending} onClick={() => {configure.reset(); setNewRegion(''); setEnableOpen(true)}}>Add region</Button></div>} />
      <MutationError error={catalog.error} />
      {!enableOpen && !disableRegion && <MutationError error={configure.error} />}
      <Field label="Default sending region" htmlFor="default-sending-region" hint="Used when no region is specified. Applies to Live and Test.">
        <Select id="default-sending-region" className="settings-default-region" value={catalog.data?.defaultRegion ?? ''} options={(catalog.data?.data ?? []).filter(row => row.enabled).map(row => ({value: row.region, label: row.region}))} disabled={!canManage || configure.isPending || !catalog.data} onValueChange={region => configure.mutate({region, makeDefault: true})} />
      </Field>
      <DataTable loading={catalog.isPending} skeletonRows={2} rowSize="large" rows={catalog.data?.data ?? []} rowKey={row => row.region} selectedId={entry?.region} empty={<EmptyState title="No regions configured" />} columns={[
        {...settingsColumns.regions[0], render: row => <button type="button" className="settings-region-link" aria-label={`View ${row.region}`} aria-current={entry?.region === row.region ? 'true' : undefined} aria-controls="ses-region-detail" onClick={() => {setViewRegion(row.region)}}>{row.region}</button>},
        {...settingsColumns.regions[1], render: row => <StatusBadge status={regionStatus(row)} tone={!row.enabled || activeJob(row) ? 'neutral' : row.discoveryStatus === 'ready' ? 'success' : row.provisionStatus === 'failed' ? 'danger' : row.discoveryStatus === 'blocked' ? 'warning' : 'neutral'} />},
        {...settingsColumns.regions[2], render: row => <div className="cluster settings-row-actions">{row.enabled ? !row.isDefault && <Button variant="ghost" disabled={!canManage || activeJob(row) || configure.isPending} title={activeJob(row) ? 'Wait for provisioning to finish.' : undefined} onClick={() => {configure.reset(); setDisableRegion(row)}}>Disable</Button> : <Button disabled={!canManage || configure.isPending} onClick={() => {void enable(row.region).catch(() => {})}}>Enable</Button>}</div>},
      ]} />
    </section>
    {entry && <RegionDetail key={entry.region} entry={entry} inspected={inspectedRegion === entry.region} />}
    <Dialog open={enableOpen} onOpenChange={open => {if (!configure.isPending) setEnableOpen(open)}} title="Add region" footer={<><Button disabled={configure.isPending} onClick={() => setEnableOpen(false)}>Cancel</Button><Button variant="primary" loading={configure.isPending} type="submit" form="enable-ses-region">Add region</Button></>}>
      <form id="enable-ses-region" className="stack" onSubmit={submitEnable}>
        <MutationError error={configure.error} />
        <Field label="AWS region" htmlFor="ses-region" error={fieldError(configure.error, 'region')} hint="Checks live AWS without creating resources."><Input id="ses-region" value={newRegion} onChange={event => setNewRegion(event.target.value)} placeholder="us-east-1" maxLength={32} pattern="[a-z]{2}(-[a-z]+)+-[0-9]" required autoFocus disabled={configure.isPending} /></Field>
      </form>
    </Dialog>
    <ConfirmDialog open={disableRegion !== null} onOpenChange={open => {if (!open) setDisableRegion(null)}} title={`Disable ${disableRegion?.region ?? 'region'}?`} description="Stops new sends in this region in Live and Test. Keeps AWS resources and mail history." confirmLabel="Disable" danger pending={configure.isPending} onConfirm={async () => {if (disableRegion) await configure.mutateAsync({region: disableRegion.region, enabled: false})}} />
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
  const status = discovering ? 'Checking' : running ? entry.provisionStatus === 'pending' ? 'Queued' : 'Provisioning' : ready ? 'Ready' : entry.provisionStatus === 'failed' ? 'Setup failed' : report?.resources.topic.subscription === 'pending' ? 'Awaiting confirmation' : report ? report.status === 'blocked' ? 'Needs attention' : 'Needs setup' : 'Not checked'
  return <section id="ses-region-detail" className="section stack settings-region-detail" aria-label={`${entry.region} setup`}>
    <SectionHeader title={<span className="cluster">{entry.region}<StatusBadge status={status} tone={ready ? 'success' : entry.provisionStatus === 'failed' ? 'danger' : report?.status === 'blocked' && !running ? 'warning' : 'neutral'} /></span>} actions={<div className="cluster"><Button disabled={!canDiscover || !entry.enabled || discovering || running || refresh.isPending} loading={discovery.isFetching || refresh.isPending} onClick={() => {if (!report) void discovery.refetch().then(result => {if (result.data) setExplicitInspection(true)}); else refresh.mutate()}}>Check AWS</Button><Button variant="primary" disabled={!canManage || !entry.enabled || running || discovering || !report || Boolean(hardBlocker) || provision.isPending} title={hardBlocker?.message} onClick={() => {provision.reset(); setConfirmOpen(true)}}>{entry.provisionStatus === 'failed' ? 'Retry provisioning' : 'Provision resources'}</Button></div>} />
    {!entry.enabled && <p className="muted">Enable this region to check or provision AWS resources.</p>}
    {!canDiscover && <p className="muted">Read permission required to check AWS.</p>}
    {entry.provisionError && !ready && <Alert tone="danger">{setupError(entry.provisionError)}</Alert>}
    <MutationError error={discovery.error || refresh.error} />
    {!confirmOpen && <MutationError error={provision.error} />}
    {!report && (discovery.isFetching || discovering) ? <RegionDiscoverySkeleton /> : report ? <DiscoveryReport report={report} entry={entry} /> : entry.enabled && <p className="muted">Check AWS to load setup status. No resources are created.</p>}
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title={`Provision ${entry.region}?`} description={`Creates or repairs SES configuration sets and SNS feedback in live AWS account ${report?.account?.id ?? '(not identified)'}, in ${entry.region}. Does not send email, change DNS, or grant production access.`} confirmLabel="Provision resources" pending={provision.isPending} onConfirm={() => provision.mutateAsync()} />
  </section>
}

function configurationStatus(set: SesDiscovery['resources']['transactional']) {
  if (set.exists === false) return 'Not created'
  if (set.owned === false) return 'Name conflict'
  if (set.sendingEnabled === false) return 'Sending disabled'
  if (set.eventWired === true && set.sendingEnabled === true) return 'Ready'
  if (set.exists == null || set.owned == null || set.sendingEnabled == null) return 'Not checked'
  return 'Needs setup'
}
function domainStatus(domain: SesDiscovery['domains'][number]) {
  if (domain.sendingEnabled === false) return 'Sending disabled'
  if (domain.verificationStatus === 'SUCCESS') return domain.sendingEnabled === true ? 'Verified' : 'Sending unknown'
  return domain.verificationStatus ? label(domain.verificationStatus) : 'Not checked'
}
function DiscoveryReport({report, entry}: {report: SesDiscovery; entry: RegionCatalogEntry}) {
  const {account, resources} = report
  const topic = resources.topic
  const feedbackStatus = topic.exists === false ? 'Not created' : topic.owned === false ? 'Name conflict' : topic.subscription === 'pending' ? 'Awaiting confirmation' : topic.subscription === 'confirmed' && topic.policyReady && topic.rawMessageDelivery === false ? 'Ready' : topic.exists == null ? 'Not checked' : 'Needs setup'
  return <>
    {report.blockers.length > 0 && <Alert tone="warning" title="Needs attention"><ul className="settings-issues">{report.blockers.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Alert>}
    {report.warnings.length > 0 && <Alert tone="warning"><ul className="settings-issues">{report.warnings.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></Alert>}
    <div className="stack settings-discovery-section"><h3>Account</h3><dl className="settings-facts settings-account-summary">
      <div><dt>AWS account</dt><dd>{account?.id ?? 'Unknown'}</dd></div><div><dt>SES access</dt><dd>{flag(account?.productionAccess, 'Production', 'Sandbox')}</dd></div><div><dt>Sent / daily quota</dt><dd>{amount(account?.quota.sentLast24Hours)} / {amount(account?.quota.max24HourSend)}</dd></div><div><dt>Send rate</dt><dd>{amount(account?.quota.maxSendRate)}{account?.quota.maxSendRate != null ? ' / sec' : ''}</dd></div>
    </dl></div>
    <div className="stack settings-discovery-section"><h3>Domains</h3><DataTable rows={report.domains} rowKey={row => row.name} rowSize="large" empty={<EmptyState title={report.account ? 'No domains found' : 'Domains unavailable'} />} columns={[
      {key: 'name', label: 'Domain', render: row => row.name}, {key: 'status', label: 'Status', render: row => domainStatus(row)},
    ]} />{report.identitiesTruncated && !report.blockers.some(issue => issue.code === 'SES_IDENTITIES_TRUNCATED') && <p className="muted">Domain list is incomplete.</p>}</div>
    <div className="stack settings-discovery-section"><h3>Configuration sets</h3><DataTable rowSize="large" rows={(['transactional', 'marketing'] as const).map(kind => ({kind, ...resources[kind]}))} rowKey={row => row.kind} columns={[
      {key: 'name', label: 'Stream', render: row => label(row.kind)}, {key: 'status', label: 'Status', render: row => configurationStatus(row)},
    ]} /></div>
    <div className="stack settings-discovery-section"><h3>Feedback</h3><dl className="settings-facts"><div><dt>Event delivery</dt><dd>{feedbackStatus}</dd></div><div className="settings-fact-wide"><dt>Callback URL</dt><dd>{report.feedbackUrl ?? 'Not configured'}</dd></div></dl></div>
    <details className="settings-aws-details">
      <summary>AWS details</summary>
      <div className="stack">
        <div className="cluster"><a className="ui-button ui-button--secondary" href={`https://${report.region}.console.aws.amazon.com/ses/home?region=${report.region}#/account`} target="_blank" rel="noopener noreferrer">AWS console <ArrowUpRight size={16} aria-hidden /></a><span className="muted">Checked {checkedAt(report.checkedAt)} UTC</span></div>
        <dl className="settings-facts"><div><dt>Account sending</dt><dd>{flag(account?.sendingEnabled, 'Enabled', 'Disabled')}</dd></div><div><dt>Enforcement</dt><dd>{account?.enforcementStatus ? label(account.enforcementStatus.toLowerCase()) : 'Unknown'}</dd></div>{entry.provisionJobId && <div className="settings-fact-wide"><dt>Job ID</dt><dd><code>{entry.provisionJobId}</code></dd></div>}{entry.provisionError && <div><dt>Error code</dt><dd><code>{entry.provisionError}</code></dd></div>}</dl>
        <DataTable rowSize="large" rows={(['transactional', 'marketing'] as const).map(kind => ({kind, ...resources[kind]}))} rowKey={row => row.kind} columns={[
          {...settingsColumns.configurationSets[0], render: row => row.name}, {...settingsColumns.configurationSets[1], render: row => flag(row.exists)}, {...settingsColumns.configurationSets[2], render: row => flag(row.owned)}, {...settingsColumns.configurationSets[3], render: row => flag(row.sendingEnabled, 'Enabled', 'Disabled')}, {...settingsColumns.configurationSets[4], render: row => flag(row.eventDestinationExists, 'Exists', 'Missing')}, {...settingsColumns.configurationSets[5], render: row => flag(row.eventWired, 'Ready', 'Not connected')},
        ]} />
        <dl className="settings-facts"><div className="settings-fact-wide"><dt>Event destination</dt><dd>{resources.eventDestinationName}</dd></div><div className="settings-fact-wide"><dt>SNS topic</dt><dd>{topic.name}</dd></div><div className="settings-fact-wide"><dt>Topic ARN</dt><dd>{topic.arn ?? 'Unknown'}</dd></div><div><dt>Exists</dt><dd>{flag(topic.exists)}</dd></div><div><dt>Owned</dt><dd>{flag(topic.owned)}</dd></div><div><dt>Policy</dt><dd>{flag(topic.policyReady, 'Ready', 'Not ready')}</dd></div><div><dt>Subscription</dt><dd>{topic.subscription === 'pending' ? 'Awaiting confirmation' : label(topic.subscription)}</dd></div><div><dt>Raw delivery</dt><dd>{flag(topic.rawMessageDelivery, 'Enabled', 'Disabled')}</dd></div><div><dt>Other HTTPS subscriptions</dt><dd>{number(topic.staleSubscriptions)}</dd></div></dl>
      </div>
    </details>
  </>
}
