import { lazy, Suspense, useCallback, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useApiMutation, useApiQuery, useRegion } from '../../data/context'
import type { Campaign, CampaignInput, PageResult, SendCampaignInput } from '../../data/types'
import {
  Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState,
  Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select,
  StatusBadge, Tabs,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, number, percent, time } from '../../lib/format'
import { campaignColumns, CampaignAudienceSkeleton, CampaignEditorSkeleton, CampaignRouteSkeleton } from './skeletons'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { ComposerSkeleton } from './skeletons'
const EmailComposer = lazy(() => import('./EmailComposer').then(module => ({ default: module.EmailComposer })))

const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const emailIsValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const campaignPath = (campaign: Campaign) => `/campaigns/${encodeURIComponent(campaign.id)}/${campaign.status === 'draft' ? 'edit' : 'review'}`

export function CampaignsPage() {
  const { regionId } = useRegion()
  return <CampaignList key={regionId} regionId={regionId} />
}

function CampaignList({ regionId }: { regionId: string }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const search = params.get('search') || ''
  const status = ['draft', 'scheduled', 'sent'].includes(params.get('status') || '') ? params.get('status')! : 'all'
  const requestedPage = Number(params.get('page'))
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = 10
  const request = { regionId, search, status: status === 'all' ? undefined : status, page, pageSize }
  const query = useApiQuery(['campaigns', request], (api, signal) => api.campaigns.list(request, signal))
  function filter(key: string, value: string) {
    setParams(previous => { const next = new URLSearchParams(previous); value ? next.set(key, value) : next.delete(key); next.delete('page'); return next })
  }
  return <>
    <PageHeader title="Campaigns" actions={<Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />
    <Tabs value={status} onValueChange={value => filter('status', value === 'all' ? '' : value)} items={[
      { value: 'all', label: 'All campaigns' },
      { value: 'draft', label: 'Drafts' },
      { value: 'scheduled', label: 'Scheduled' },
      { value: 'sent', label: 'Sent' },
    ]} />
    <div className="data-toolbar"><Input className="campaign-search" aria-label="Search campaigns" placeholder="Search campaigns" type="search" value={search} onChange={event => filter('search', event.target.value)} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rowSize="large" rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(campaignPath(row))} empty={<EmptyState title={search || status !== 'all' ? 'No matching campaigns' : 'No campaigns yet'} description={search || status !== 'all' ? 'Try another search or status.' : 'Create your first campaign in this region.'} action={search || status !== 'all' ? <Button variant="secondary" onClick={() => setParams({})}>Clear filters</Button> : <Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} columns={[
        { ...campaignColumns[0], render: row => <div className="campaign-row-name"><Link to={campaignPath(row)} onClick={event => event.stopPropagation()}>{row.name}</Link><span className="muted">{row.subject}</span></div> },
        { ...campaignColumns[1], render: row => <StatusBadge status={row.status} /> },
        { ...campaignColumns[2], render: row => number(row.recipients) },
        { ...campaignColumns[3], render: row => row.status === 'sent' && row.recipients > 0 ? percent(row.delivered / row.recipients) : '—' },
        { ...campaignColumns[4], render: row => <span className="muted">{date(row.scheduledAt || row.updatedAt)} · {time(row.scheduledAt || row.updatedAt)} UTC</span> },
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
    </>}
  </>
}

export function CampaignEditorPage() {
  const { id } = useParams()
  const { regionId } = useRegion()
  const query = useApiQuery<Campaign | null>(['campaign', id ?? 'new', regionId], (api, signal) => id ? api.campaigns.get(id, signal) : Promise.resolve(null))
  if (query.isPending) return <CampaignRouteSkeleton kind="editor" isNew={!id} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.data && query.data.regionId !== regionId) return <RegionMismatch campaign={query.data} />
  if (query.data && query.data.status !== 'draft') return <>
    <PageHeader title={query.data.name} backTo="/campaigns" />
    <Alert tone="info">This campaign is {query.data.status} and cannot be edited.</Alert>
    <Link to={`/campaigns/${encodeURIComponent(query.data.id)}/review`}>View campaign</Link>
  </>
  return <CampaignEditor key={`${id ?? 'new'}:${regionId}`} initial={query.data} regionId={regionId} />
}

function RegionMismatch({ campaign }: { campaign: Campaign }) {
  const { setRegionId } = useRegion()
  return <><PageHeader title="Campaign in another region" backTo="/campaigns" /><EmptyState title={`This campaign belongs to ${campaign.regionId}`} description="Switch regions to view or edit this campaign." action={<Button onClick={() => setRegionId(campaign.regionId)}>Switch to {campaign.regionId}</Button>} /></>
}

function AudienceSummary({ listId, segmentId, regionId }: { listId: string; segmentId: string | null; regionId: string }) {
  const query = useApiQuery(['campaign-audience', { listId, segmentId, regionId }], (api, signal) => api.campaigns.audience({ listId, segmentId }, signal))
  if (query.isPending) return <CampaignAudienceSkeleton />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <div className="campaign-audience-summary">
    <div className="campaign-summary-line"><span>Matched contacts</span><span>{number(query.data.matched)}</span></div>
    <div className="campaign-summary-line muted"><span>Suppressed excluded</span><span>−{number(query.data.suppressed)}</span></div>
    <div className="campaign-summary-line muted"><span>Unsubscribed excluded</span><span>−{number(query.data.unsubscribed)}</span></div>
    <div className="campaign-summary-line"><strong>Estimated recipients</strong><strong>{number(query.data.eligible)}</strong></div>
    {query.data.eligible === 0 && <Alert tone="warning">No eligible contacts. Choose another list or segment before sending.</Alert>}
  </div>
}

function CampaignEditor({ initial, regionId }: { initial: Campaign | null; regionId: string }) {
  const navigate = useNavigate()
  const [form, setForm] = useState<CampaignInput>(() => initial ? {
    id: initial.id, regionId: initial.regionId, name: initial.name, subject: initial.subject,
    previewText: initial.previewText, fromName: initial.fromName, fromEmail: initial.fromEmail,
    listId: initial.listId, segmentId: initial.segmentId, html: initial.html, editor: initial.editor,
  } : { regionId, name: '', subject: '', previewText: '', fromName: '', fromEmail: '', listId: '', segmentId: null, html: '' })
  const composer = useRef<EmailComposerRef>(null)
  const [composerReady, setComposerReady] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const handleComposerReady = useCallback(() => setComposerReady(true), [])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const guard = useRef(false)
  const options = useApiQuery(['campaign-options', { regionId, pageSize: 1000 }], async (api, signal) => {
    async function allPages<T>(read: (page: number) => Promise<PageResult<T>>) {
      const first = await read(1)
      const items = [...first.items]
      for (let page = 2; items.length < first.total; page += 1) {
        const next = await read(page)
        if (!next.items.length) break
        items.push(...next.items)
      }
      return items
    }
    const [lists, segments, domains] = await Promise.all([
      allPages(page => api.lists.list({ regionId, page, pageSize: 1000 }, signal)),
      allPages(page => api.segments.list({ regionId, page, pageSize: 1000 }, signal)),
      allPages(page => api.domains.list({ regionId, page, pageSize: 1000 }, signal)),
    ])
    return { lists, segments, domains: domains.filter(domain => domain.status === 'verified') }
  })
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input), 'Draft saved')
  const pending = preparing || saveMutation.isPending
  const handleComposerDirty = useCallback(() => setError(''), [])
  const senderParts = form.fromEmail.split('@')
  const senderLocal = senderParts[0] || ''
  const senderDomain = senderParts[1] || ''
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    setForm(previous => ({ ...previous, [key]: value }))
    setError('')
  }
  async function save(next: 'edit' | 'review' | 'test') {
    if (guard.current || pending || !composerReady) return
    setError('')
    if (!form.name.trim() || !form.subject.trim() || !form.fromName.trim()) { setError('Enter a campaign name, subject, and sender name.'); return }
    if (!emailIsValid(form.fromEmail)) { setError('Enter a valid sender email address.'); return }
    if (!options.data?.domains.some(domain => domain.name.toLowerCase() === senderDomain.toLowerCase())) { setError('Select a verified sending domain in this region.'); return }
    if (!form.listId) { setError('Choose a recipient list.'); return }
    guard.current = true
    setPreparing(true)
    try {
      const draft = await composer.current?.prepare()
      if (!draft?.html.trim()) throw new Error('Add some email content before continuing.')
      const saved = await saveMutation.mutateAsync({ ...form, ...draft, name: form.name.trim(), subject: form.subject.trim(), fromName: form.fromName.trim(), fromEmail: form.fromEmail.trim() })
      if (next === 'test') setTestOpen(true)
      else navigate(`/campaigns/${encodeURIComponent(saved.id)}/${next}`, { replace: !initial })
    } catch (cause) { setError(message(cause)) }
    finally { guard.current = false; setPreparing(false) }
  }
  return <>
    <PageHeader title={initial?.name || 'Create campaign'} backTo="/campaigns" actions={<div className="cluster"><Button variant="secondary" disabled={options.isPending || options.isError || !composerReady} loading={pending} onClick={() => save('edit')}>Save draft</Button><Button variant="primary" disabled={options.isPending || options.isError || !composerReady} loading={pending} onClick={() => save('review')}>Continue to review</Button></div>} />
    {error && <Alert tone="danger">{error}</Alert>}
    {options.isPending ? <CampaignEditorSkeleton isNew={!initial} hasAudience={Boolean(form.listId)} hasSegment={Boolean(form.segmentId)} /> : options.isError ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : <div className="campaign-editor-layout">
      <div className="campaign-fields">
        <Field label="Name" htmlFor="campaign-name"><Input id="campaign-name" value={form.name} onChange={event => change('name', event.target.value)} required disabled={pending} /></Field>
        <Field label="Subject" htmlFor="campaign-subject"><Input id="campaign-subject" value={form.subject} onChange={event => change('subject', event.target.value)} required disabled={pending} /></Field>
        <Field label="Preview text" htmlFor="campaign-preview"><Input id="campaign-preview" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={pending} /></Field>
        <Field label="From name" htmlFor="campaign-from-name"><Input id="campaign-from-name" value={form.fromName} onChange={event => change('fromName', event.target.value)} required disabled={pending} /></Field>
        <div className="campaign-sender">
          <Field label="From email" htmlFor="campaign-from-email"><Input id="campaign-from-email" placeholder="updates" value={senderLocal} onChange={event => change('fromEmail', `${event.target.value}@${senderDomain}`)} disabled={pending} /></Field>
          <span aria-hidden="true">@</span>
          <Field label="Verified domain" htmlFor="campaign-domain"><Select id="campaign-domain" value={senderDomain || '__choose__'} disabled={pending} onValueChange={value => change('fromEmail', `${senderLocal}@${value === '__choose__' ? '' : value}`)} options={[{ value: '__choose__', label: 'Select', disabled: true }, ...options.data.domains.map(domain => ({ value: domain.name, label: domain.name }))]} /></Field>
        </div>
        {options.data.domains.length === 0 && <Alert tone="warning">No verified domains in this region. <Link to="/domains">Set up a sending domain</Link> before saving.</Alert>}
        <section className="section">
          <SectionHeader title="Recipients" />
          <div className="campaign-fields">
            <Field label="Include list" htmlFor="campaign-list"><Select id="campaign-list" disabled={pending} value={form.listId} onValueChange={value => change('listId', value)} options={[{ value: '', label: 'Select a list' }, ...options.data.lists.map(list => ({ value: list.id, label: `${list.name} · ${number(list.total)} contacts` }))]} /></Field>
            {options.data.lists.length === 0 && <Alert tone="info">No lists yet. <Link to="/lists">Create a list</Link> to select recipients.</Alert>}
            <Field label="Limit to a segment" htmlFor="campaign-segment" hint={form.segmentId ? 'Only contacts in both this list and segment are included.' : undefined}><Select id="campaign-segment" disabled={pending} value={form.segmentId || ''} onValueChange={value => change('segmentId', value || null)} options={[{ value: '', label: 'All subscribed contacts in list' }, ...options.data.segments.map(segment => ({ value: segment.id, label: `${segment.name} · ${number(segment.matched)} matches` }))]} /></Field>
            {form.listId && <AudienceSummary listId={form.listId} segmentId={form.segmentId} regionId={regionId} />}
          </div>
        </section>
      </div>
      <section className="campaign-message">
        <Suspense fallback={<ComposerSkeleton />}><EmailComposer ref={composer} initialHtml={form.html} initialEditor={form.editor} previewText={form.previewText} disabled={pending} onReady={handleComposerReady} onDirty={handleComposerDirty} /></Suspense>
        {initial && <div className="campaign-test-action"><Button variant="secondary" disabled={!composerReady} loading={pending} onClick={() => save('test')}>Send test</Button></div>}
        {!initial && <p className="muted">Save your draft to send a test email.</p>}
      </section>
    </div>}
    {initial && <TestEmailDialog id={initial.id} open={testOpen} onOpenChange={setTestOpen} />}
  </>
}

function TestEmailDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const guard = useRef(false)
  const mutation = useApiMutation((api, input: { id: string; to: string }) => api.campaigns.test(input), 'Test email accepted')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (guard.current || mutation.isPending) return
    if (!emailIsValid(to.trim())) { setError('Enter a valid recipient email address.'); return }
    setError('')
    guard.current = true
    try {
      const result = await mutation.mutateAsync({ id, to: to.trim() })
      if (!result.accepted) { setError('The test email was not accepted. Please try again.'); return }
      onOpenChange(false)
    } catch (cause) { setError(message(cause)) }
    finally { guard.current = false }
  }
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setError(''); onOpenChange(value) } }} title="Send test email" description="Send the saved message to a single recipient.">
    <form className="stack" onSubmit={submit}>
      <Field label="Recipient email" htmlFor="campaign-test-recipient"><Input id="campaign-test-recipient" type="email" autoComplete="email" value={to} onChange={event => { setTo(event.target.value); setError('') }} required disabled={mutation.isPending} /></Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="cluster"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" loading={mutation.isPending}>Send test</Button></div>
    </form>
  </Dialog>
}

export function CampaignReviewPage() {
  const { id = '' } = useParams()
  const { regionId } = useRegion()
  const query = useApiQuery(['campaign', id, regionId], (api, signal) => api.campaigns.get(id, signal))
  if (query.isPending) return <CampaignRouteSkeleton kind="review" />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.data.regionId !== regionId) return <RegionMismatch campaign={query.data} />
  return <CampaignReview key={`${id}:${regionId}`} campaign={query.data} />
}

function CampaignReview({ campaign }: { campaign: Campaign }) {
  const navigate = useNavigate()
  const { regionId } = useRegion()
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduled, setScheduled] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<SendCampaignInput | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const guard = useRef(false)
  const draft = campaign.status === 'draft'
  const audience = useApiQuery(['campaign-audience', { listId: campaign.listId, segmentId: campaign.segmentId, regionId }], (api, signal) => api.campaigns.audience({ listId: campaign.listId, segmentId: campaign.segmentId }, signal))
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input), mode === 'schedule' ? 'Campaign scheduled' : 'Campaign sent')
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    setError('')
    if (!audience.data || audience.data.eligible < 1) { setError('Choose an audience with at least one eligible contact before sending.'); return }
    const input: SendCampaignInput = { id: campaign.id, mode, timezone: 'UTC' }
    if (mode === 'schedule') {
      // datetime-local has no offset: this field is explicitly UTC, never the browser's local zone.
      const parsed = new Date(`${scheduled}:00Z`)
      if (!scheduled || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) { setError('Choose a future date and time in UTC.'); return }
      input.scheduledAt = parsed.toISOString()
    }
    setConfirmation(input)
  }
  async function confirmSend() {
    if (!confirmation || !draft || guard.current || sendMutation.isPending) return
    guard.current = true
    setError('')
    try { await sendMutation.mutateAsync(confirmation); setConfirmation(null) }
    catch (cause) { setError(message(cause)); setConfirmation(null) }
    finally { guard.current = false }
  }
  return <>
    <PageHeader title={draft ? 'Review campaign' : campaign.name} backTo="/campaigns" actions={<StatusBadge status={campaign.status} />} />
    {draft && <p className="muted campaign-review-name">{campaign.name}</p>}
    {!draft && <Alert tone={campaign.status === 'sent' ? 'success' : 'info'}>{campaign.status === 'sent' ? `Sent to ${number(campaign.recipients)} recipients. This campaign is read-only.` : `Scheduled for ${date(campaign.scheduledAt)} at ${time(campaign.scheduledAt!)} UTC. This campaign is read-only.`}</Alert>}
    <div className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title="Recipients" actions={draft ? <Button variant="ghost" onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Edit audience</Button> : undefined} />
        {draft ? audience.isPending ? <CampaignAudienceSkeleton review /> : audience.isError ? <ErrorState error={audience.error} onRetry={() => audience.refetch()} /> : <>
          <div><strong className="campaign-recipient-count">{number(audience.data.eligible)}</strong><p className="muted">will receive this email</p></div>
          <div className="campaign-audience-summary">
            <div className="campaign-summary-line"><span>Matched contacts</span><span>{number(audience.data.matched)}</span></div>
            <div className="campaign-summary-line muted"><span>Suppressed</span><span>−{number(audience.data.suppressed)}</span></div>
            <div className="campaign-summary-line muted"><span>Unsubscribed</span><span>−{number(audience.data.unsubscribed)}</span></div>
          </div>
          {audience.data.eligible === 0 && <Alert tone="warning">No eligible recipients. Edit your audience before sending.</Alert>}
        </> : <div className="campaign-audience-summary">
          <div className="campaign-summary-line"><span>Recipients</span><span>{number(campaign.recipients)}</span></div>
          {campaign.status === 'sent' && <><div className="campaign-summary-line"><span>Delivered</span><span>{number(campaign.delivered)}</span></div><div className="campaign-summary-line"><span>Bounced</span><span>{number(campaign.bounced)}</span></div><div className="campaign-summary-line"><span>Complaints</span><span>{number(campaign.complaints)}</span></div></>}
        </div>}
      </section>
      <section className="campaign-fields">
        <SectionHeader title="Message preview" actions={draft ? <div className="cluster"><Button variant="ghost" onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Edit message</Button><Button variant="secondary" onClick={() => setTestOpen(true)}>Send test</Button></div> : undefined} />
        <dl className="campaign-message-details"><dt>From</dt><dd>{campaign.fromName} &lt;{campaign.fromEmail}&gt;</dd><dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <EmailPreview html={campaign.html} title="Campaign email preview" />
      </section>
    </div>
    {draft && <section className="section campaign-delivery">
      <SectionHeader title="Delivery" />
      <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      {mode === 'schedule' && <div className="form-grid"><Field label="Time zone"><Input value="UTC (UTC+00:00)" readOnly aria-label="Time zone" /></Field><Field label="Date and time (UTC)" htmlFor="campaign-schedule"><Input id="campaign-schedule" type="datetime-local" value={scheduled} onChange={event => { setScheduled(event.target.value); setError('') }} disabled={sendMutation.isPending} /></Field></div>}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled={sendMutation.isPending} onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Back to draft</Button><Button variant="primary" loading={sendMutation.isPending} disabled={audience.isPending || audience.isError || !audience.data?.eligible} onClick={requestConfirmation}>{mode === 'schedule' ? 'Schedule campaign' : 'Send campaign now'}</Button></div>
    </section>}
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'} description={confirmation?.mode === 'schedule' ? `Send “${campaign.name}” to ${number(audience.data?.eligible ?? 0)} eligible recipients on ${date(confirmation.scheduledAt)} at ${time(confirmation.scheduledAt!)} UTC. Audience eligibility is checked again when scheduling.` : `Send “${campaign.name}” to ${number(audience.data?.eligible ?? 0)} eligible recipients now. This action cannot be undone.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Confirm schedule' : 'Confirm send'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && <TestEmailDialog id={campaign.id} open={testOpen} onOpenChange={setTestOpen} />}
  </>
}
