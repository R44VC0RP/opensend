import { ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import './audience.css'

const statuses = [{ value: 'subscribed', label: 'Subscribed' }, { value: 'unsubscribed', label: 'Unsubscribed' }, { value: 'suppressed', label: 'Suppressed' }]

export function AudienceCellSkeleton({ secondary = false }: { secondary?: boolean }) {
  return <div><SkeletonText width="78%" />{secondary && <SkeletonText width="48%" lineHeight={18} />}</div>
}
export const contactColumns: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '28%', skeleton: <AudienceCellSkeleton /> },
  { key: 'status', label: 'Status', width: '17%', skeleton: <SkeletonText width={92} /> },
  { key: 'name', label: 'Name', width: '18%' },
  { key: 'lists', label: 'Lists', width: '20%' },
  { key: 'created', label: 'Added', width: '17%', skeleton: <SkeletonText width={95} /> },
]
export const memberColumns: SkeletonColumn[] = [contactColumns[0], contactColumns[1], { key: 'suppression', label: 'Suppression reason', width: '38%' }, contactColumns[4]]
export const listColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '27%' },
  { key: 'subscribed', label: 'Subscribed', width: '14%' },
  { key: 'suppressed', label: 'Suppressed', width: '14%' },
  { key: 'unsubscribed', label: 'Unsubscribed', width: '15%' },
  { key: 'total', label: 'Total contacts', width: '15%' },
  { key: 'created', label: 'Created', width: '15%' },
]
export const segmentColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '30%' },
  { key: 'rules', label: 'Rules', width: '22%' },
  { key: 'matched', label: 'Matched', width: '14%' },
  { key: 'eligible', label: 'Eligible', width: '14%' },
  { key: 'updated', label: 'Updated', width: '20%' },
]
export const activityColumns: SkeletonColumn[] = [
  { key: 'subject', label: 'Email', width: '55%' },
  { key: 'status', label: 'Latest event', width: '23%', skeleton: <SkeletonText width={90} /> },
  { key: 'time', label: 'Sent', width: '22%' },
]
export function AudienceSummarySkeleton() {
  return <div className="audience-summary cluster">{[100, 115, 110, 125].map(width => <SkeletonText key={width} width={width} />)}</div>
}
export function AudienceMembersSkeleton() {
  return <><Tabs value="" onValueChange={() => {}} items={[{ value: '', label: 'All members' }, ...statuses]} /><div className="data-toolbar"><ControlSkeleton width={320} /></div><TableSkeleton columns={memberColumns} rows={8} pagination /></>
}
export function ListDetailBodySkeleton() {
  return <LoadingRegion label="Loading list"><AudienceSummarySkeleton /><AudienceMembersSkeleton /></LoadingRegion>
}
export function AudiencePreviewSkeleton() {
  return <LoadingRegion label="Loading audience preview"><AudienceSummarySkeleton /><TableSkeleton columns={memberColumns} rows={8} /></LoadingRegion>
}
export function ContactDetailBodySkeleton() {
  return <><div className="audience-summary cluster"><SkeletonText width={240} /><SkeletonText width={94} /></div>
    <div className="form-grid audience-properties">{[{ title: 'Properties', labels: ['Full name', 'Country', 'Created', 'Last opened'] }, { title: 'Marketing consent', labels: ['Status', 'Consent source', 'Confirmed', 'Suppression'] }].map(group => <section key={group.title}><SectionHeader title={group.title} /><dl>{group.labels.map(label => <div className="audience-property-placeholder" key={label}><dt>{label}</dt><dd><SkeletonText width="65%" /></dd></div>)}</dl></section>)}</div>
    <section className="section"><SectionHeader title="Lists" actions={<ControlSkeleton width={111} />} /><SkeletonText width={170} /></section>
    <section className="section"><SectionHeader title="Recent email activity" /><p className="muted"><SkeletonText width={80} /></p><TableSkeleton columns={activityColumns} rows={5} pagination /></section>
  </>
}
export function SegmentEditorBodySkeleton() {
  return <div className="stack audience-editor"><div className="audience-name"><FieldSkeleton label="Segment name" /></div><section className="section stack"><SectionHeader title="Conditions" /><div className="cluster"><span>Match</span><ControlSkeleton width={220} /></div><div className="audience-rule"><FieldSkeleton label="Property" /><FieldSkeleton label="Operator" /><FieldSkeleton label="Value" /><div className="audience-rule-remove"><ControlSkeleton width={34} /></div></div><div className="cluster"><ControlSkeleton width={133} /><ControlSkeleton width={141} /></div></section></div>
}
export function AudienceRouteSkeleton({ kind, isNew = false }: { kind: 'contacts' | 'contact' | 'lists' | 'list' | 'segments' | 'segment'; isNew?: boolean }) {
  if (kind === 'contact') return <LoadingRegion className="audience-page" label="Loading contact"><PageHeader title={<SkeletonText width={200} lineHeight={24} />} backTo="/contacts" actions={<><ControlSkeleton width={109} /><ControlSkeleton width={111} /></>} /><ContactDetailBodySkeleton /></LoadingRegion>
  if (kind === 'list') return <LoadingRegion className="audience-page" label="Loading list"><PageHeader title={<SkeletonText width={180} lineHeight={24} />} backTo="/lists" actions={<ControlSkeleton width={132} />} /><AudienceSummarySkeleton /><AudienceMembersSkeleton /></LoadingRegion>
  if (kind === 'segment') return <LoadingRegion className="audience-page" label="Loading segment"><PageHeader title={isNew ? 'Create segment' : 'Edit segment'} backTo="/segments" actions={<><ControlSkeleton width={72} /><ControlSkeleton width={121} /></>} /><SegmentEditorBodySkeleton /></LoadingRegion>
  const contacts = kind === 'contacts'
  const title = contacts ? 'Contacts' : kind === 'lists' ? 'Lists' : 'Segments'
  return <LoadingRegion className="audience-page" label={`Loading ${kind}`}><PageHeader title={title} actions={<>{contacts && <ControlSkeleton width={132} />}<ControlSkeleton width={contacts ? 131 : kind === 'lists' ? 124 : 155} /></>} />
    {contacts && <Tabs value="" onValueChange={() => {}} items={[{ value: '', label: 'All contacts' }, ...statuses]} />}
    <div className="data-toolbar"><div className="cluster"><ControlSkeleton width={320} />{contacts && <ControlSkeleton width={170} />}</div><SkeletonText width={100} /></div>
    <TableSkeleton columns={contacts ? contactColumns : kind === 'lists' ? listColumns : segmentColumns} rows={contacts ? 8 : 5} pagination />
  </LoadingRegion>
}
