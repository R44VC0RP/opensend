import { ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import { useRegion } from '../../data/context'
import './settings.css'

const twoLines = <div><SkeletonText width="74%" /><SkeletonText width="88%" /></div>
export const settingsColumns = {
  keys: [
    { key: 'name', label: 'Name', width: '23%' },
    { key: 'prefix', label: 'Key prefix', width: '20%' },
    { key: 'permission', label: 'Permissions', width: '30%' },
    { key: 'last', label: 'Last used' },
    { key: 'actions', label: '', align: 'right', width: 100, skeleton: <ControlSkeleton width={76} /> },
  ],
  domains: [
    { key: 'name', label: 'Domain', width: '32%' },
    { key: 'status', label: 'Status', width: '25%', skeleton: twoLines },
    { key: 'region', label: 'Region' },
    { key: 'action', label: '', align: 'right' },
  ],
  dns: [
    { key: 'type', label: 'Type', width: 80 },
    { key: 'name', label: 'Name', width: '30%', skeleton: <div className="settings-copy-cell"><SkeletonText width="75%" /><ControlSkeleton width={34} /></div> },
    { key: 'value', label: 'Value', skeleton: <div className="settings-copy-cell"><SkeletonText width="80%" /><ControlSkeleton width={34} /></div> },
    { key: 'status', label: 'Status', width: 115 },
  ],
  regions: [
    { key: 'region', label: 'Region', width: '20%', skeleton: twoLines },
    { key: 'access', label: 'Access', width: '16%', skeleton: twoLines },
    { key: 'health', label: 'Health', width: '17%', skeleton: twoLines },
    { key: 'quota', label: 'Sent in last 24h', width: '17%', skeleton: twoLines },
    { key: 'rate', label: 'Max. send rate', width: 128 },
    { key: 'action', label: '', align: 'right', width: 134, skeleton: <ControlSkeleton width={110} /> },
  ],
  webhooks: [
    { key: 'name', label: 'Name / Endpoint URL', width: '34%', skeleton: twoLines },
    { key: 'scope', label: 'Region scope', width: '17%' },
    { key: 'events', label: 'Events', width: '12%' },
    { key: 'status', label: 'Status', width: '12%' },
    { key: 'last', label: 'Last delivery', width: '25%', skeleton: twoLines },
  ],
  deliveries: [
    { key: 'time', label: 'Time · UTC', width: '16%', skeleton: twoLines },
    { key: 'region', label: 'Region', width: '14%' },
    { key: 'event', label: 'Event', width: '16%' },
    { key: 'status', label: 'Response / Status', width: '22%', skeleton: twoLines },
    { key: 'attempts', label: 'Attempts' },
    { key: 'actions', label: '', align: 'right', width: 220, skeleton: <ControlSkeleton width={85} /> },
  ],
} satisfies Record<string, SkeletonColumn[]>

function RouteTabs({ value }: { value: 'ses' | 'webhooks' }) {
  return <Tabs value={value} onValueChange={() => {}} items={[{ value: 'ses', label: 'Amazon SES' }, { value: 'webhooks', label: 'Webhooks' }]} />
}

export function SettingsBodySkeleton({ regionId }: { regionId: string }) {
  return <LoadingRegion label="Loading workspace and sending regions" className="settings-loading-body">
    <div className="settings-account"><SkeletonText width={270} /><Skeleton width={90} /><ControlSkeleton width="calc(7ch + 26px)" /></div>
    <section className="section stack"><SectionHeader title="Connected regions" actions={<ControlSkeleton width={110} />} /><TableSkeleton columns={settingsColumns.regions} rows={3} rowSize="large" /></section>
    <section className="section stack"><SectionHeader title={`${regionId} · Reputation & capabilities`} /><div className="settings-reputation">
      <div><div className="muted">Bounce rate</div><SkeletonText width={50} /><div className="muted">Keep below 5%</div></div>
      <div><div className="muted">Complaint rate</div><SkeletonText width={50} /><div className="muted">Keep below 0.1%</div></div>
      <div><div className="muted">Account suppression</div><SkeletonText width={140} /></div>
      <div><div className="muted">IP pool</div><SkeletonText width={70} /></div>
      <div><div className="muted">Virtual Deliverability Manager</div><SkeletonText width={80} /></div>
    </div></section>
    <section className="section stack"><SectionHeader title="Workspace" actions={<ControlSkeleton width={146} />} /><div className="form-grid"><FieldSkeleton label="Workspace name" /><div className="stack"><div className="muted">Team</div><SkeletonText width={240} /></div></div></section>
  </LoadingRegion>
}

export function EndpointFieldsSkeleton({ isNew = false, selectedRegions = false }: { isNew?: boolean; selectedRegions?: boolean }) {
  return <div className="stack">
    <div className="form-grid"><FieldSkeleton label="Name" /><FieldSkeleton label="Endpoint URL" /></div>
    <div className="stack settings-region-scope"><div className="ui-field"><span className="ui-field__label">Region scope</span><ControlSkeleton />{!selectedRegions && <div className="ui-field__hint">{isNew ? 'This workspace · Includes future connected regions' : <SkeletonText width={350} lineHeight={18} />}</div>}</div>
    {selectedRegions && <div className="settings-choices"><ControlSkeleton width={135} /><ControlSkeleton width={135} /></div>}</div>
    <div className="stack"><div>Events</div><div className="settings-choices">{['Send', 'Delivered', 'Bounced', 'Complaint', 'Rejected', 'Delivery delayed'].map(event => <div className="ui-check-field" key={event} aria-hidden="true"><Skeleton width={14} height={14} /><span>{event}</span></div>)}</div></div>
  </div>
}

export function WebhookBodySkeleton({ isNew = false, selectedRegions = false }: { isNew?: boolean; selectedRegions?: boolean }) {
  return <LoadingRegion label={isNew ? 'Loading webhook form' : 'Loading webhook endpoint'} className="settings-loading-body">
    {isNew ? <div className="stack"><EndpointFieldsSkeleton isNew /><div className="muted">A separate signing secret is created for each endpoint.</div><div className="cluster"><ControlSkeleton width={76} /><ControlSkeleton width={128} /></div></div> : <>
      <div className="muted"><SkeletonText width={400} /></div>
      <EndpointFieldsSkeleton selectedRegions={selectedRegions} />
      <section className="section stack"><SectionHeader title={<SkeletonText width={300} />} actions={<><ControlSkeleton width={76} /><ControlSkeleton width={138} /></>} /><SkeletonText width={250} /></section>
      <section className="section stack"><SectionHeader title="Delivery history" actions={<SkeletonText width={300} />} /><TableSkeleton columns={settingsColumns.deliveries} rows={3} rowSize="large" /></section>
      <div><ControlSkeleton width={146} /></div>
    </>}
  </LoadingRegion>
}

export function DomainDetailSkeleton() {
  return <LoadingRegion className="stack" label="Loading domain">
    <PageHeader title={<SkeletonText width={260} lineHeight={28} />} backTo="/domains" actions={<ControlSkeleton width={138} />} />
    <div className="cluster"><Skeleton width={90} /><Skeleton width={100} /><span className="cluster">Custom mail from · <Skeleton width={90} /></span></div>
    <section className="section stack"><SectionHeader title="DNS records" /><div className="muted">Copy these records to your DNS provider, then verify.</div><TableSkeleton columns={settingsColumns.dns} rows={3} rowSize="large" /><div className="ui-alert" aria-hidden="true"><SkeletonText width={320} /></div></section>
  </LoadingRegion>
}

export function SettingsRouteSkeleton({ kind, isNew = false }: { kind: 'keys' | 'domains' | 'domain' | 'ses' | 'webhooks' | 'webhook'; isNew?: boolean }) {
  const { regionId } = useRegion()
  if (kind === 'domain') return <DomainDetailSkeleton />
  if (kind === 'webhook') return <LoadingRegion className="stack" label="Loading webhook"><PageHeader title={isNew ? 'Add webhook' : <SkeletonText width={240} lineHeight={28} />} backTo="/settings/webhooks" actions={isNew ? undefined : <><Skeleton width={70} /><ControlSkeleton width="calc(5ch + 26px)" /><ControlSkeleton width={128} /></>} /><WebhookBodySkeleton isNew={isNew} /></LoadingRegion>
  if (kind === 'ses') return <LoadingRegion className="stack" label="Loading settings"><PageHeader title="Settings" actions={<ControlSkeleton width={180} />} /><RouteTabs value="ses" /><SettingsBodySkeleton regionId={regionId} /></LoadingRegion>
  if (kind === 'webhooks') return <LoadingRegion className="stack" label="Loading webhooks"><PageHeader title="Settings" actions={<ControlSkeleton width={120} />} /><RouteTabs value="webhooks" /><SectionHeader title={<SkeletonText width={110} />} actions={<span className="muted">Workspace-wide · All regions</span>} /><TableSkeleton columns={settingsColumns.webhooks} rows={3} rowSize="large" /></LoadingRegion>
  return <LoadingRegion className="stack" label={kind === 'keys' ? 'Loading API keys' : 'Loading domains'}><PageHeader title={kind === 'keys' ? 'API keys' : 'Domains'} actions={<ControlSkeleton width="calc(10ch + 26px)" />} /><div className="page-toolbar muted">{kind === 'keys' ? `Workspace-wide keys · Domain restrictions available in ${regionId}` : `Sending region · ${regionId}`}</div><TableSkeleton columns={settingsColumns[kind]} rows={3} rowSize={kind === 'domains' ? 'large' : 'default'} pagination={kind === 'domains'} /></LoadingRegion>
}
