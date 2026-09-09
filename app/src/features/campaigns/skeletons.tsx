import {
  Button, FieldSkeleton, Input, LoadingRegion, PageHeader, SectionHeader,
  Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn,
} from '../../components/ui'
import './campaigns.css'

export const campaignColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '35%', skeleton: <div className="campaign-row-name"><SkeletonText width="68%" lineHeight={18} /><SkeletonText width="88%" lineHeight={18} /></div> },
  { key: 'status', label: 'Status', skeleton: <SkeletonText width={65} lineHeight={18} /> },
  { key: 'recipients', label: 'Recipients', skeleton: <SkeletonText width={45} /> },
  { key: 'delivered', label: 'Delivered', skeleton: <SkeletonText width={42} /> },
  { key: 'updated', label: 'Last activity', skeleton: <SkeletonText width="90%" /> },
]

export function CampaignAudienceSkeleton({ review = false }: { review?: boolean }) {
  const summary = <div className="campaign-audience-summary">
    <div className="campaign-summary-line"><span>Matched contacts</span><SkeletonText width={45} /></div>
    <div className="campaign-summary-line muted"><span>{review ? 'Suppressed' : 'Suppressed excluded'}</span><SkeletonText width={35} /></div>
    <div className="campaign-summary-line muted"><span>{review ? 'Unsubscribed' : 'Unsubscribed excluded'}</span><SkeletonText width={35} /></div>
    {!review && <div className="campaign-summary-line"><strong>Estimated recipients</strong><SkeletonText width={45} /></div>}
  </div>
  return <LoadingRegion label="Loading audience" className={review ? 'campaign-audience-review-skeleton' : undefined}>
    {review && <div><SkeletonText width={70} /><p className="muted">will receive this email</p></div>}
    {summary}
  </LoadingRegion>
}

export function CampaignEditorSkeleton({ isNew = false, hasAudience = !isNew, hasSegment = false }: { isNew?: boolean; hasAudience?: boolean; hasSegment?: boolean }) {
  return <LoadingRegion label="Loading campaign editor" className="campaign-editor-layout">
    <div className="campaign-fields">
      <FieldSkeleton label="Name" />
      <FieldSkeleton label="Subject" />
      <FieldSkeleton label="Preview text" />
      <FieldSkeleton label="From name" />
      <div className="campaign-sender"><FieldSkeleton label="From email" /><span aria-hidden="true">@</span><FieldSkeleton label="Verified domain" /></div>
      <section className="section">
        <SectionHeader title="Recipients" />
        <div className="campaign-fields">
          <FieldSkeleton label="Include list" />
          <div className="ui-field"><FieldSkeleton label="Limit to a segment" />{hasSegment && <div className="ui-field__hint">Only contacts in both this list and segment are included.</div>}</div>
          {hasAudience && <CampaignAudienceSkeleton />}
        </div>
      </section>
    </div>
    <section className="campaign-message">
      <div className="campaign-message-toolbar"><Tabs value="html" onValueChange={() => {}} items={[{ value: 'html', label: 'HTML' }, { value: 'preview', label: 'Preview' }]} />{!isNew && <Button variant="secondary" disabled>Send test</Button>}</div>
      <div className="ui-field" aria-hidden="true"><span className="ui-field__label">Email HTML</span><Skeleton height={430} /></div>
      {isNew && <p className="muted">Save your draft to send a test email.</p>}
    </section>
  </LoadingRegion>
}

export function CampaignRouteSkeleton({ kind, isNew = false }: { kind: 'list' | 'editor' | 'review'; isNew?: boolean }) {
  if (kind === 'list') return <>
    <PageHeader title="Campaigns" actions={<Button variant="primary" disabled>Create campaign</Button>} />
    <Tabs value="all" onValueChange={() => {}} items={[{ value: 'all', label: 'All campaigns' }, { value: 'draft', label: 'Drafts' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'sent', label: 'Sent' }]} />
    <div className="data-toolbar"><Input className="campaign-search" aria-label="Search campaigns" placeholder="Search campaigns" type="search" disabled /></div>
    <TableSkeleton columns={campaignColumns} rows={4} rowSize="large" pagination />
  </>
  if (kind === 'editor') return <>
    <PageHeader title={isNew ? 'Create campaign' : <SkeletonText width={220} lineHeight={28} />} backTo="/campaigns" actions={<div className="cluster"><Button variant="secondary" disabled>Save draft</Button><Button variant="primary" disabled>Continue to review</Button></div>} />
    <CampaignEditorSkeleton isNew={isNew} />
  </>
  return <>
    <PageHeader title={<SkeletonText width={220} lineHeight={28} />} backTo="/campaigns" actions={<SkeletonText width={65} lineHeight={18} />} />
    <p className="muted campaign-review-name"><SkeletonText width={220} /></p>
    <LoadingRegion label="Loading campaign review" className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title="Recipients" actions={<Button variant="ghost" disabled>Edit audience</Button>} />
        <CampaignAudienceSkeleton review />
      </section>
      <section className="campaign-fields">
        <SectionHeader title="Message preview" actions={<div className="cluster"><Button variant="ghost" disabled>Edit message</Button><Button variant="secondary" disabled>Send test</Button></div>} />
        <dl className="campaign-message-details"><dt>From</dt><dd><SkeletonText width="70%" /></dd><dt>Subject</dt><dd><SkeletonText width="85%" /></dd><dt>Preview</dt><dd><SkeletonText width="65%" /></dd></dl>
        <Skeleton height={400} />
      </section>
    </LoadingRegion>
    <section className="section campaign-delivery">
      <SectionHeader title="Delivery" />
      <Tabs value="now" onValueChange={() => {}} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled>Back to draft</Button><Button variant="primary" disabled>Send campaign now</Button></div>
    </section>
  </>
}
