import { lazy, Suspense, useCallback, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Paperclip, X } from 'lucide-react'
import { useApiMutation, useApiQuery, useRegion, useApi } from '../../data/context'
import { useRegionCatalog } from '../../data/regions'
import type { Campaign, CampaignInput, CampaignReview as ReviewResult, Attachment, SendCampaignInput } from '../../data/types'
import {
  Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState,
  Field, IconButton, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select,
  StatusBadge, Tabs, useToast,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, number, percent, time } from '../../lib/format'
import { campaignColumns, CampaignAudienceSkeleton, CampaignEditorSkeleton, CampaignRouteSkeleton } from './skeletons'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { CampaignSenderInput } from './CampaignSenderInput'
import { ComposerSkeleton } from './skeletons'
const EmailComposer = lazy(() => import('./EmailComposer').then(module => ({ default: module.EmailComposer })))

const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const emailIsValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const campaignPath = (campaign: Campaign) => `/campaigns/${encodeURIComponent(campaign.id)}/${['draft', 'reviewed'].includes(campaign.status) ? 'edit' : 'review'}`

export function CampaignsPage() {
  const { regionId } = useRegion()
  return <CampaignList key={regionId} regionId={regionId} />
}

function CampaignList({ regionId }: { regionId: string }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const search = params.get('search') || ''
  const status = ['draft', 'reviewed', 'scheduled', 'sending', 'completed', 'canceled'].includes(params.get('status') || '') ? params.get('status')! : 'all'
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
      { value: 'reviewed', label: 'Reviewed' }, { value: 'sending', label: 'Sending' }, { value: 'completed', label: 'Completed' }, { value: 'canceled', label: 'Canceled' },
    ]} />
    <div className="data-toolbar"><Input className="campaign-search" aria-label="Search campaigns" placeholder="Search campaigns" type="search" value={search} onChange={event => filter('search', event.target.value)} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(campaignPath(row))} empty={<EmptyState title={search || status !== 'all' ? 'No matching campaigns' : 'No campaigns yet'} action={search || status !== 'all' ? <Button variant="secondary" onClick={() => setParams({})}>Clear filters</Button> : <Button variant="primary" onClick={() => navigate('/campaigns/new')}>Create campaign</Button>} />} columns={[
        { ...campaignColumns[0], render: row => <div className="campaign-row-name"><Link to={campaignPath(row)} onClick={event => event.stopPropagation()}>{row.name}</Link><span className="muted">{row.subject}</span></div> },
        { ...campaignColumns[1], render: row => <StatusBadge status={row.status} /> },
        { ...campaignColumns[2], render: row => number(row.recipients) },
        { ...campaignColumns[3], render: row => ['sent', 'completed'].includes(row.status) && row.recipients > 0 ? percent(row.delivered / row.recipients) : '—' },
        { ...campaignColumns[4], render: row => <span className="muted">{date(row.scheduledAt || row.updatedAt)} · {time(row.scheduledAt || row.updatedAt)} UTC</span> },
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={value => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(value)); return next })} />}
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
  if (query.data && !['draft', 'reviewed'].includes(query.data.status)) return <>
    <PageHeader title={query.data.name} backTo="/campaigns" />
    <Alert tone="info">This campaign is {query.data.status} and cannot be edited.</Alert>
    <Link to={`/campaigns/${encodeURIComponent(query.data.id)}/review`}>View campaign</Link>
  </>
  return <CampaignEditor key={`${id ?? 'new'}:${regionId}`} initial={query.data} regionId={regionId} />
}

function RegionMismatch({ campaign }: { campaign: Campaign }) {
  const { setRegionId } = useRegion()
  return <><PageHeader title="Campaign in another region" backTo="/campaigns" /><EmptyState title={`This campaign belongs to ${campaign.regionId}`} action={<Button onClick={() => setRegionId(campaign.regionId)}>Switch to {campaign.regionId}</Button>} /></>
}

function CampaignEditor({ initial, regionId }: { initial: Campaign | null; regionId: string }) {
  const toast = useToast()
  const testEnvironment = useApi().environment === 'test'
  const regionCatalog = useRegionCatalog()
  const {setRegionId} = useRegion()
  const navigate = useNavigate()
  const [form, setForm] = useState<CampaignInput>(() => initial ? {
    id: initial.id, revision: initial.revision, draft: initial.draft, attachments: initial.attachments, regionId: initial.regionId, name: initial.name, subject: initial.subject,
    previewText: initial.previewText, fromName: initial.fromName, fromEmail: initial.fromEmail,
    listId: initial.listId, segmentId: initial.segmentId, html: initial.html, editor: initial.editor,
  } : { regionId, name: '', subject: '', previewText: '', fromName: '', fromEmail: '', listId: '', segmentId: null, html: '' })
  const textOnly = Boolean(initial?.draft?.text && !initial?.draft?.html)
  const composer = useRef<EmailComposerRef>(null)
  const [composerReady, setComposerReady] = useState(textOnly)
  const [preparing, setPreparing] = useState(false)
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const handleComposerReady = useCallback(() => setComposerReady(true), [])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(Boolean(initial?.previewText))
  const previewInput = useRef<HTMLInputElement>(null)
  const guard = useRef(false)
  const [optionCursors, setOptionCursors] = useState<{lists?: string; domains?: string}>({})
  const options = useApiQuery(['campaign-options', { regionId, pageSize: 100, ...optionCursors }], async (api, signal) => {
    const [listPage, domainPage] = await Promise.all([
      api.lists.list({ pageSize: 100, cursor: optionCursors.lists }, signal), api.environment === 'test' ? Promise.resolve({items: [], nextCursor: null}) : api.domains.list({regionId, pageSize: 100, cursor: optionCursors.domains}, signal),
    ])
    const lists = listPage.items, domains = domainPage.items
    return { lists, domains: domains.filter(domain => domain.status === 'verified'), next: {lists: listPage.nextCursor, domains: domainPage.nextCursor} }
  })
  const previousOptions = useRef<typeof options.data>(undefined)
  if (options.data) previousOptions.current = options.data
  const choices = options.data ?? previousOptions.current
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input), 'Draft saved')
  const pending = preparing || attachmentsBusy || saveMutation.isPending
  const handleComposerDirty = useCallback(() => setError(''), [])
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    setForm(previous => ({ ...previous, [key]: value }))
    setError('')
  }
  async function save(next: 'edit' | 'review' | 'test') {
    if (guard.current || pending || !composerReady) return
    setError('')
    if (!form.name.trim() || !form.subject.trim()) { setError('Enter a campaign name and subject.'); return }
    if (!emailIsValid(form.fromEmail)) { toast('Enter a valid sender email address.', 'error'); return }
    if (!form.regionId.trim() || form.regionId.trim().length > 40) {setError('Enter a region identifier of 1–40 characters.'); return}
    if (!form.listId) { setError('Choose a recipient list.'); return }
    guard.current = true
    setPreparing(true)
    try {
      const draft = textOnly ? {html: '', editor: form.editor ?? null, inlineAttachmentIds: [] as string[]} : await composer.current?.prepare()
      if (!textOnly && !draft?.html.trim()) throw new Error('Add some email content before continuing.')
      const saved = await saveMutation.mutateAsync({ ...form, ...draft, attachments: [...new Set([...(form.attachments ?? []), ...(draft?.inlineAttachmentIds ?? [])])], name: form.name.trim(), subject: form.subject.trim(), fromName: form.fromName.trim(), fromEmail: form.fromEmail.trim(), regionId: form.regionId.trim() })
      setForm(previous => ({...previous, id: saved.id, revision: saved.revision, draft: saved.draft, attachments: saved.attachments}))
      if (saved.regionId !== regionId) setRegionId(saved.regionId)
      if (next === 'test') setTestOpen(true)
      else navigate(`/campaigns/${encodeURIComponent(saved.id)}/${next}`, { replace: !initial })
    } catch (cause) { setError(message(cause)) }
    finally { guard.current = false; setPreparing(false) }
  }
  return <div className="campaign-compose-page">
    <PageHeader title={initial ? 'Edit campaign' : 'Create campaign'} backTo="/campaigns" />
    {error && <Alert tone="danger">{error}</Alert>}{options.isError && choices && <ErrorState error={options.error} onRetry={() => options.refetch()} />}
    {options.isPending && !choices ? <CampaignEditorSkeleton isNew={!initial} /> : options.isError && !choices ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : choices && <section className="campaign-compose-workspace" aria-label="Campaign composer">
      <div className="campaign-compose-scroll">
        <div className="campaign-compose-sheet">
          <div className="campaign-compose-metadata">
            <div className="campaign-compose-row"><label htmlFor="campaign-name">Name</label><Input id="campaign-name" placeholder="Campaign name" value={form.name} onChange={event => change('name', event.target.value)} required disabled={pending} /></div>
            <div className="campaign-compose-row"><label htmlFor="campaign-from-email">From</label><CampaignSenderInput name={form.fromName} email={form.fromEmail} domains={choices.domains.map(domain => domain.name)} allowUnverified={testEnvironment} disabled={pending} onChange={({name, email}) => {setForm(previous => ({...previous, fromName: name, fromEmail: email})); setError('')}} /></div>
            {!testEnvironment && (optionCursors.domains || choices.next.domains) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, domains: undefined})}>First domains</Button><Button disabled={!choices.next.domains} onClick={() => setOptionCursors({...optionCursors, domains: choices.next.domains ?? undefined})}>More domains</Button></div>}
            {!testEnvironment && choices.domains.length === 0 && <Alert tone="warning">No verified domains on this page. <Link to="/domains">Add a domain</Link></Alert>}
            <div className="campaign-compose-row"><label htmlFor="campaign-list">To</label><Select id="campaign-list" aria-label="Include list" disabled={pending} value={form.listId} onValueChange={value => change('listId', value)} options={[{ value: '', label: 'Select a recipient list' }, ...(form.listId && !choices.lists.some(l => l.id === form.listId) ? [{value: form.listId, label: form.listId}] : []), ...choices.lists.map(list => ({ value: list.id, label: list.total === undefined ? list.name : `${list.name} · ${number(list.total)} contacts` }))]} /></div>
            {(optionCursors.lists || choices.next.lists) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, lists: undefined})}>First lists</Button><Button disabled={!choices.next.lists} onClick={() => setOptionCursors({...optionCursors, lists: choices.next.lists ?? undefined})}>More lists</Button></div>}
            {choices.lists.length === 0 && <Alert tone="info">No lists on this page. <Link to="/lists">Create a list</Link></Alert>}
            {testEnvironment && <div className="campaign-compose-row"><label htmlFor="campaign-test-region">Region</label><Select id="campaign-test-region" aria-label="Simulation region" required value={form.regionId} onValueChange={value => change('regionId', value)} disabled={pending || regionCatalog.isPending} options={(regionCatalog.data?.data ?? []).filter(region => region.enabled || region.region === form.regionId).map(region => ({value: region.region, label: `${region.region}${region.enabled ? '' : ' · Disabled'}`, disabled: !region.enabled}))} /></div>}
            <div id="campaign-preview-row" className="campaign-compose-preview" data-open={previewOpen || undefined} aria-hidden={!previewOpen} inert={!previewOpen}>
              <div><div className="campaign-compose-row"><label htmlFor="campaign-preview">Preview</label><Input ref={previewInput} id="campaign-preview" aria-label="Preview text" maxLength={200} placeholder="Inbox preview text" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={pending} /></div></div>
            </div>
            <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="campaign-subject">Subject</label><Input id="campaign-subject" placeholder="Add a subject" value={form.subject} onChange={event => change('subject', event.target.value)} required disabled={pending} /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled={pending} aria-expanded={previewOpen} aria-controls="campaign-preview-row" onClick={() => {setPreviewOpen(!previewOpen); if (!previewOpen) requestAnimationFrame(() => previewInput.current?.focus({preventScroll: true}))}}>Preview text</Button></div>
          </div>
          {textOnly ? <div className="campaign-compose-plain"><Field label="Plain-text body" hint="Read-only; preserved when saved."><textarea className="ui-input" value={String(form.draft?.text ?? '')} readOnly /></Field></div> : <Suspense fallback={<ComposerSkeleton />}><EmailComposer ref={composer} attachmentIds={form.attachments ?? []} initialHtml={form.html} initialEditor={form.editor} disabled={pending} onReady={handleComposerReady} onDirty={handleComposerDirty} /></Suspense>}
        </div>
      </div>
      <footer className="campaign-compose-footer"><div className="campaign-compose-controls">
        <CampaignAttachments ids={form.attachments ?? []} persisted={form.draft?.attachments ?? []} onChange={ids => change('attachments', ids)} onBusy={setAttachmentsBusy} disabled={preparing || saveMutation.isPending} />
        <div className="campaign-compose-actions">
          <Button variant="ghost" disabled={!initial || options.isPending || options.isError || !composerReady || pending} title={!initial ? 'Save your draft first' : undefined} onClick={() => save('test')}>Send test</Button>
          <Button variant="secondary" disabled={options.isPending || options.isError || !composerReady} loading={pending} onClick={() => save('edit')}>Save draft</Button>
          <Button variant="primary" disabled={options.isPending || options.isError || !composerReady} loading={pending} onClick={() => save('review')}>Continue to review</Button>
        </div>
      </div></footer>
    </section>}
    {initial && testOpen && <TestEmailDialog id={initial.id} open={testOpen} onOpenChange={setTestOpen} />}
  </div>
}

function CampaignAttachments({ ids, persisted, onChange, onBusy, disabled }: {ids: string[]; persisted: string[]; onChange: (ids: string[]) => void; onBusy: (busy: boolean) => void; disabled: boolean}) {
  const api = useApi()
  const input = useRef<HTMLInputElement>(null)
  const owned = useRef(new Set<string>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const metadata = useApiQuery(['attachments', ids], async api => api.attachments ? Promise.all(ids.map(id => api.attachments!.get(id))) : [] as Attachment[])
  if (!api.attachments) return <div className="campaign-compose-attach"><Button variant="ghost" disabled title="Attachments are unavailable for this connection"><Paperclip size={16} />Attach file</Button></div>
  async function upload(file?: File) {
    if (!file || busy || disabled) return
    setError('')
    if (metadata.isPending || metadata.isError) { setError('Wait for attachment sizes to load before uploading.'); return }
    if (ids.length >= 20 || file.size + (metadata.data ?? []).reduce((sum, item) => sum + item.size, 0) > 8 * 1024 * 1024) {setError('Use at most 20 attachments with a combined size of 8 MiB.'); return}
    setBusy(true); onBusy(true)
    try { const item = await api.attachments!.upload(file); owned.current.add(item.id); onChange([...ids, item.id]) }
    catch (cause) {setError(message(cause))} finally {setBusy(false); onBusy(false)}
  }
  async function remove(id: string) {
    setBusy(true); onBusy(true); setError('')
    try { if (owned.current.has(id) && !persisted.includes(id)) {await api.attachments!.remove(id); owned.current.delete(id)} onChange(ids.filter(value => value !== id)) }
    catch (cause) {setError(message(cause))} finally {setBusy(false); onBusy(false)}
  }
  return <>
    {metadata.isError && <div className="campaign-compose-attachment-status"><ErrorState error={metadata.error} onRetry={() => metadata.refetch()} /></div>}
    {Boolean(metadata.data?.length) && <ul className="campaign-compose-attachments" aria-label="Attachments">{metadata.data!.map(item => <li key={item.id} title={`${item.filename} · ${item.contentType} · ${number(item.size)} bytes`}>
      <Paperclip size={14} aria-hidden="true" /><span className="campaign-attachment-name">{item.filename}</span><span className="muted">{number(item.size)} B</span>
      <IconButton label={`Remove ${item.filename}`} disabled={busy || disabled || item.disposition === 'inline'} title={item.disposition === 'inline' ? 'Inline image attachment; retained with the saved message' : undefined} onClick={() => remove(item.id)}><X size={14} /></IconButton>
    </li>)}</ul>}
    {error && <div className="campaign-compose-attachment-status"><Alert tone="danger">{error}</Alert></div>}
    <div className="campaign-compose-attach"><Button variant="ghost" loading={busy} disabled={busy || disabled || metadata.isPending} onClick={() => input.current?.click()} title="Up to 20 attachments, 8 MiB total"><Paperclip size={16} />Attach file</Button><input ref={input} type="file" hidden id="campaign-attachment" aria-label="Upload attachment" disabled={busy || disabled || metadata.isPending} onChange={event => {void upload(event.target.files?.[0]); event.currentTarget.value = ''}} /></div>
  </>
}

function TestEmailDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const guard = useRef(false)
  const api = useApi()
  const [receipt, setReceipt] = useState<{id?: string; status?: string; simulated?: boolean} | null>(null)
  const mutation = useApiMutation((api, input: { id: string; to: string }) => api.campaigns.test(input))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (guard.current || mutation.isPending) return
    if (!emailIsValid(to.trim())) { setError('Enter a valid recipient email address.'); return }
    setError('')
    guard.current = true
    try {
      const result = await mutation.mutateAsync({ id, to: to.trim() })
      if (!result.accepted) { setError('The test email was not accepted. Please try again.'); return }
      setReceipt(result)
    } catch (cause) { setError(message(cause)) }
    finally { guard.current = false }
  }
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setError(''); onOpenChange(value) } }} title="Send test email" description={`Sends the saved draft to one recipient in ${api.environment ?? 'demo'} mode.`}>
    <form className="stack" onSubmit={submit}>
      {receipt && <Alert tone="success">{receipt.simulated ? 'Simulated test queued' : 'Test queued'} · {receipt.id ?? 'Demo'}</Alert>}
      <Field label="Recipient email" htmlFor="campaign-test-recipient"><Input id="campaign-test-recipient" type="email" autoComplete="email" value={to} onChange={event => { setTo(event.target.value); setError(''); setReceipt(null) }} required disabled={mutation.isPending} /></Field>
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
  const api = useApi()
  const draft = ['draft', 'reviewed'].includes(campaign.status)
  const audience = useApiMutation(async api => api.review ? api.review(campaign.id, campaign.revision!) : {...await api.campaigns.audience({listId: campaign.listId, segmentId: campaign.segmentId}), id: 'demo', revision: 1} as ReviewResult)
  const [receipt, setReceipt] = useState('')
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input))
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    setError('')
    if (!audience.data || audience.data.eligible < 1) { setError('Choose an audience with at least one eligible contact before sending.'); return }
    const input: SendCampaignInput = { id: campaign.id, mode, timezone: 'UTC', reviewId: audience.data.id, revision: audience.data.revision }
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
    try { const result = await sendMutation.mutateAsync(confirmation); setReceipt(`Campaign ${result.status}${'queued' in result ? ` · ${number(result.queued)} queued` : ''} · ${api.environment ?? 'demo'} mode${'simulated' in result && result.simulated ? ' (simulated)' : ''}`); setConfirmation(null) }
    catch (cause) { setError(message(cause)); setConfirmation(null) }
    finally { guard.current = false }
  }
  return <>
    <PageHeader title={draft ? 'Review campaign' : campaign.name} backTo="/campaigns" actions={<StatusBadge status={campaign.status} />} />
    {draft && <p className="muted campaign-review-name">{campaign.name}</p>}
    {receipt && <Alert tone="success">{receipt}</Alert>}{!draft && campaign.scheduledAt && <Alert tone="info">Scheduled for {date(campaign.scheduledAt)} at {time(campaign.scheduledAt)} UTC.</Alert>}
    <div className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title="Recipients" actions={draft ? <Button variant="ghost" onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Edit audience</Button> : undefined} />
        {draft ? audience.isPending ? <CampaignAudienceSkeleton /> : audience.isError ? <ErrorState error={audience.error} onRetry={() => audience.mutate(undefined)} /> : !audience.data ? <Button variant="primary" onClick={() => audience.mutate(undefined)}>Generate recipient review</Button> : <>
          <div><strong className="campaign-recipient-count">{number(audience.data.eligible)}</strong><p className="muted">eligible recipients</p></div>
          <div className="campaign-audience-summary">
            <div className="campaign-summary-line"><span>Matched contacts</span><span>{number(audience.data.matched)}</span></div>
            <div className="campaign-summary-line muted"><span>Suppressed</span><span>−{number(audience.data.suppressed)}</span></div>
            <div className="campaign-summary-line muted"><span>Not subscribed (including unknown)</span><span>−{number(audience.data.unsubscribed)}</span></div>
          </div>
          <Button disabled={sendMutation.isPending} onClick={() => audience.mutate(undefined)}>Generate new review</Button>
          {audience.data.eligible === 0 && <Alert tone="warning">No eligible recipients.</Alert>}
        </> : <div className="campaign-audience-summary">
          <div className="campaign-summary-line"><span>Recipients</span><span>{number(campaign.recipients)}</span></div>
          {['sent', 'completed'].includes(campaign.status) && <><div className="campaign-summary-line"><span>Delivered</span><span>{number(campaign.delivered)}</span></div><div className="campaign-summary-line"><span>Bounced</span><span>{number(campaign.bounced)}</span></div><div className="campaign-summary-line"><span>Complaints</span><span>{number(campaign.complaints)}</span></div></>}
        </div>}
      </section>
      <section className="campaign-fields">
        <SectionHeader title="Message preview" actions={draft ? <div className="cluster"><Button variant="ghost" onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Edit message</Button><Button variant="secondary" onClick={() => setTestOpen(true)}>Send test</Button></div> : undefined} />
        <dl className="campaign-message-details"><dt>From</dt><dd>{campaign.fromName} &lt;{campaign.fromEmail}&gt;</dd><dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <EmailPreview html={campaign.html} title="Campaign email preview" editor={campaign.editor} attachmentIds={campaign.attachments} />{!campaign.html && campaign.draft?.text && <pre className="message-source">{String(campaign.draft.text)}</pre>}
      </section>
    </div>
    {draft && <section className="section campaign-delivery">
      <SectionHeader title="Delivery" />
      <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      {mode === 'schedule' && <div className="form-grid"><Field label="Time zone"><Input value="UTC (UTC+00:00)" readOnly aria-label="Time zone" /></Field><Field label="Date and time (UTC)" htmlFor="campaign-schedule"><Input id="campaign-schedule" type="datetime-local" value={scheduled} onChange={event => { setScheduled(event.target.value); setError('') }} disabled={sendMutation.isPending} /></Field></div>}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled={sendMutation.isPending} onClick={() => navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`)}>Back to draft</Button><Button variant="primary" loading={sendMutation.isPending} disabled={audience.isPending || audience.isError || !audience.data?.eligible} onClick={requestConfirmation}>{mode === 'schedule' ? 'Schedule campaign' : 'Send campaign now'}</Button></div>
    </section>}
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'} description={confirmation?.mode === 'schedule' ? `In ${api.environment ?? 'demo'} mode, send “${campaign.name}” from ${regionId} to ${number(audience.data?.eligible ?? 0)} eligible recipients on ${date(confirmation.scheduledAt)} at ${time(confirmation.scheduledAt!)} UTC.` : `In ${api.environment ?? 'demo'} mode, send “${campaign.name}” from ${regionId} to ${number(audience.data?.eligible ?? 0)} eligible recipients now. This action cannot be undone.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Confirm schedule' : 'Confirm send'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && testOpen && <TestEmailDialog id={campaign.id} open={testOpen} onOpenChange={setTestOpen} />}
  </>
}
