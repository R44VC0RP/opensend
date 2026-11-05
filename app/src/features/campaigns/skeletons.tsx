import {
  Button, ControlSkeleton, Input, LoadingRegion, PageHeader, SectionHeader,
  Select, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn,
} from '../../components/ui'
import { CampaignsHeader } from './header'
import './campaigns.css'

export const campaignColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '35%', skeleton: <div className="campaign-row-name"><SkeletonText width="68%" lineHeight={18} /><SkeletonText width="88%" lineHeight={18} /></div> },
  { key: 'status', label: 'Status', skeleton: <SkeletonText width={65} lineHeight={18} /> },
  { key: 'recipients', label: 'Recipients', skeleton: <SkeletonText width={45} /> },
  { key: 'delivered', label: 'Delivered', skeleton: <SkeletonText width={42} /> },
  { key: 'updated', label: 'Last activity · UTC', skeleton: <SkeletonText width="90%" /> },
  { key: 'archive', label: <span className="sr-only">Actions</span>, width: 48, align: 'right', skeleton: <span /> },
]

export const templateColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Template', skeleton: campaignColumns[0].skeleton },
  { key: 'status', label: 'Status', width: 120, skeleton: <SkeletonText width={65} lineHeight={18} /> },
  { key: 'updated', label: 'Updated · UTC', width: 190, skeleton: <SkeletonText width="90%" /> },
  { key: 'action', label: '', width: 150, align: 'right', skeleton: <span /> },
]

export function CampaignAudienceSkeleton() {
  return <LoadingRegion label="Loading audience" className="campaign-audience-review-skeleton">
    <div><SkeletonText width={70} /><p className="muted">eligible recipients</p></div>
    <div className="campaign-audience-summary">
      <div className="campaign-summary-line"><span>Matched contacts</span><SkeletonText width={45} /></div>
      <div className="campaign-summary-line muted"><span>Suppressed</span><SkeletonText width={35} /></div>
      <div className="campaign-summary-line muted"><span>Not subscribed (including unknown)</span><SkeletonText width={35} /></div>
    </div>
  </LoadingRegion>
}

export function ComposerSkeleton() {
  return <LoadingRegion label="Loading composer" className="composer-loading"><div className="composer-skeleton-tools"><ControlSkeleton width={90} /><ControlSkeleton width={28} /><ControlSkeleton width={28} /></div><div className="composer-skeleton-canvas"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><SkeletonText width="60%" /></div></LoadingRegion>
}

export function CampaignEditorSkeleton() {
  return <LoadingRegion label="Loading campaign editor" className="campaign-compose-workspace">
    <div className="campaign-compose-scroll"><div className="campaign-compose-sheet">
      <div className="campaign-compose-metadata" aria-hidden="true">
        {['Name', 'From', 'To'].map(label => <div className="campaign-compose-row" key={label}><span className="muted">{label}</span><ControlSkeleton /></div>)}
        <div className="campaign-compose-row campaign-compose-subject"><span className="muted">Subject</span><ControlSkeleton /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled>Preview text</Button></div>
      </div>
      <ComposerSkeleton />
    </div></div>
  </LoadingRegion>
}

export function CampaignRouteSkeleton({ kind, isNew = false }: { kind: 'list' | 'editor' | 'review' | 'templates' | 'template'; isNew?: boolean }) {
  if (kind === 'list' || kind === 'templates') {
    const templates = kind === 'templates'
    return <>
      <CampaignsHeader actions={<Button variant="primary" disabled>{templates ? 'Create template' : 'Create campaign'}</Button>} />
      <div className="data-toolbar"><div className="cluster"><Input className={templates ? 'template-search' : 'campaign-search'} aria-label={templates ? 'Search templates' : 'Search campaigns'} placeholder={templates ? 'Search templates' : 'Search campaigns'} type="search" disabled /><Select aria-label={templates ? 'Filter templates' : 'Filter by status'} value="all" onValueChange={() => {}} options={[{ value: 'all', label: templates ? 'Active' : 'All campaigns' }]} disabled /></div></div>
      <TableSkeleton columns={templates ? templateColumns : campaignColumns} rows={4} pagination />
    </>
  }
  if (kind === 'template') return <div className="campaign-compose-page template-compose-page">
    <PageHeader title="Edit template" backTo="/campaigns/templates" actions={<><span className="campaign-sync-status"><span className="campaign-sync-dot" /></span><Button variant="ghost" disabled>Preview</Button><Button variant="secondary" disabled>Archive</Button><Button variant="primary" disabled>Publish</Button></>} />
    <LoadingRegion label="Loading template editor" className="campaign-compose-workspace">
      <div className="campaign-compose-scroll"><div className="campaign-compose-sheet">
        <div className="campaign-compose-metadata" aria-hidden="true">
          {['Name', 'Purpose', 'Subject', 'Preview', 'From', 'Reply to'].map(label => <div className="campaign-compose-row" key={label}><span className="muted">{label}</span><ControlSkeleton /></div>)}
        </div>
        <ComposerSkeleton />
      </div></div>
    </LoadingRegion>
  </div>
  if (kind === 'editor') return <div className="campaign-compose-page">
    <PageHeader title={isNew ? 'Create campaign' : 'Edit campaign'} backTo="/campaigns" actions={<><span className="campaign-sync-status"><span className="campaign-sync-dot" />{isNew ? 'New draft' : 'Connecting…'}</span><div className="campaign-compose-actions"><Button variant="ghost" disabled>Send test</Button><Button variant="primary" disabled>Continue to review</Button></div></>} />
    <CampaignEditorSkeleton />
  </div>
  return <div className="stack campaign-review">
    <PageHeader title={<SkeletonText width={220} lineHeight={28} />} backTo="/campaigns" actions={<SkeletonText width={65} lineHeight={18} />} />
    <LoadingRegion label="Loading campaign review" className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title="Recipients" actions={<Button variant="ghost" disabled>Edit audience</Button>} />
        <CampaignAudienceSkeleton />
      </section>
      <section className="campaign-fields">
        <SectionHeader title="Message" actions={<><Button variant="ghost" disabled>Edit message</Button><Button variant="secondary" disabled>Send test</Button></>} />
        <dl className="campaign-message-details"><dt>From</dt><dd><SkeletonText width="70%" /></dd><dt>Subject</dt><dd><SkeletonText width="85%" /></dd><dt>Preview</dt><dd><SkeletonText width="65%" /></dd></dl>
        <Skeleton height={400} />
      </section>
    </LoadingRegion>
    <section className="campaign-delivery">
      <SectionHeader title="Delivery" />
      <p className="muted campaign-delivery-lead">Review the message and audience, then send.</p>
      <Tabs value="now" onValueChange={() => {}} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled>Back to draft</Button><Button variant="primary" disabled>Send campaign now</Button></div>
    </section>
  </div>
}
