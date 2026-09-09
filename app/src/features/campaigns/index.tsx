import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useApiMutation, useApiQuery, useRegion, useApi } from '../../data/context'
import { useRegionCatalog } from '../../data/regions'
import type { Campaign, CampaignInput, CampaignReview as ReviewResult, SendCampaignInput } from '../../data/types'
import {
  Alert, Button, ConfirmDialog, Dialog, EmptyState, ErrorState,
  Field, Input, PageHeader, SectionHeader, Select, SkeletonText,
  StatusBadge, Tabs, useToast,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, number, time } from '../../lib/format'
import { CampaignAudienceSkeleton, CampaignEditorSkeleton, CampaignRouteSkeleton } from './skeletons'
import { CampaignArchiveButton } from './CampaignArchiveButton'
export { CampaignsPage } from './CampaignList'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { CampaignSenderInput } from './CampaignSenderInput'
import { CampaignAttachments, type CampaignAttachmentsRef } from './CampaignAttachments'
import { campaignVersion, useCampaignSync } from './useCampaignSync'
import { ComposerSkeleton } from './skeletons'
const EmailComposer = lazy(() => import('./EmailComposer').then(module => ({ default: module.EmailComposer })))

const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const emailIsValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const campaignRoute = (campaign: Pick<Campaign, 'id'>, view: 'edit' | 'review', environment?: 'live' | 'test') => `/campaigns/${encodeURIComponent(campaign.id)}/${view}${environment ? `?environment=${environment}` : ''}`
function campaignReadinessError(campaign: Campaign) {
  const missing = [!campaign.name.trim() && 'a campaign name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a valid sender email address', !campaign.listId && 'a recipient list', !campaign.html.trim() && 'email content'].filter(Boolean)
  return missing.length ? `Complete the draft before reviewing or sending: add ${missing.join(', ')}.` : ''
}
const olderCampaign = (candidate: Campaign, baseline: Campaign) => (candidate.revision ?? 1) < (baseline.revision ?? 1) || ((candidate.revision ?? 1) === (baseline.revision ?? 1) && Date.parse(candidate.updatedAt) < Date.parse(baseline.updatedAt))
const campaignInput = (campaign: Campaign): CampaignInput => ({
  id: campaign.id, revision: campaign.revision, draft: campaign.draft, attachments: campaign.attachments, regionId: campaign.regionId,
  name: campaign.name, subject: campaign.subject, previewText: campaign.previewText, fromName: campaign.fromName, fromEmail: campaign.fromEmail,
  listId: campaign.listId, segmentId: campaign.segmentId, html: campaign.html,
})

export function CampaignEditorPage() {
  const { id } = useParams()
  const { regionId } = useRegion()
  const regions = useRegionCatalog()
  const fallbackRegion = regionId || regions.data?.defaultRegion || ''
  const scope = useRef({ id, key: id ?? 'new', createdId: null as string | null })
  if (scope.current.id !== id) {
    const ownCreation = !scope.current.id && id === scope.current.createdId
    scope.current = { id, key: ownCreation ? scope.current.key : id ?? 'new', createdId: null }
  }
  if (!id && !fallbackRegion) return <CampaignRouteSkeleton kind="editor" isNew />
  return <CampaignEditorLoader key={scope.current.key} id={id} fallbackRegion={fallbackRegion} preserveEditor={next => {scope.current.createdId = next.id}} />
}

function CampaignEditorLoader({ id, fallbackRegion, preserveEditor }: { id?: string; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const api = useApi()
  const query = useApiQuery<Campaign | null>(['campaign', id ?? 'new'], (api, signal) => id ? api.campaigns.get(id, signal) : Promise.resolve(null))
  const opened = useRef<Campaign | null | undefined>(undefined)
  useEffect(() => {
    if (query.data) console.info('[OpenSend timing] campaign content ready', { navigationMs: Number(performance.now().toFixed(1)), revision: query.data.revision })
  }, [query.data])
  if (opened.current === undefined && query.data !== undefined && (query.data === null || (!query.data.archivedAt && ['draft', 'reviewed'].includes(query.data.status)))) opened.current = query.data
  // Once opened, background refetches must never unmount an unsaved working copy.
  if (opened.current !== undefined) return <CampaignEditor initial={opened.current} fallbackRegion={fallbackRegion} preserveEditor={preserveEditor} />
  if (query.isPending) return <CampaignRouteSkeleton kind="editor" isNew={!id} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.data?.archivedAt) return <>
    <PageHeader title={query.data.name} backTo="/campaigns?archived=true" actions={<CampaignArchiveButton campaign={query.data} />} />
    <Alert tone="info">This campaign is archived. Restore it to edit or send it.</Alert>
    <Link to={campaignRoute(query.data, 'review', api.environment)}>View campaign</Link>
  </>
  if (query.data && !['draft', 'reviewed'].includes(query.data.status)) return <>
    <PageHeader title={query.data.name} backTo="/campaigns" />
    <Alert tone="info">This campaign is {query.data.status} and cannot be edited.</Alert>
    <Link to={campaignRoute(query.data, 'review', api.environment)}>View campaign</Link>
  </>
  return null
}

function CampaignEditor({ initial, fallbackRegion, preserveEditor }: { initial: Campaign | null; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const toast = useToast()
  const api = useApi()
  const testEnvironment = api.environment === 'test'
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(initial)
  const acceptedRef = useRef(initial)
  const [form, setForm] = useState<CampaignInput>(() => initial ? campaignInput(initial) : { regionId: fallbackRegion, name: '', subject: '', previewText: '', fromName: '', fromEmail: '', listId: '', segmentId: null, html: '' })
  const formRef = useRef(form)
  function updateForm(next: CampaignInput) { formRef.current = next; setForm(next) }
  const editVersion = useRef(0)
  const [edits, setEdits] = useState(0)
  const [autosaving, setAutosaving] = useState(false)
  const [autosavePaused, setAutosavePaused] = useState(false)
  const creation = useRef<{ input: CampaignInput; version: number; ambiguous?: boolean } | null>(null)
  const mounted = useRef(true)
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [generation, setGeneration] = useState(0)
  const [composerReady, setComposerReady] = useState(false)
  const readyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const [remote, setRemote] = useState<Campaign | null>(null)
  const remoteRef = useRef<Campaign | null>(null)
  const [reviewUpdate, setReviewUpdate] = useState(false)
  const [loadingLatest, setLoadingLatest] = useState(false)
  const refreshController = useRef<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const handleComposerReady = useCallback(() => { readyRef.current = true; setComposerReady(true) }, [])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(Boolean(initial?.previewText))
  const previewInput = useRef<HTMLInputElement>(null)
  const guard = useRef(false)
  useEffect(() => {
    mounted.current = true
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current || guard.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { mounted.current = false; refreshController.current?.abort(); window.removeEventListener('beforeunload', warn) }
  }, [])
  const [optionCursors, setOptionCursors] = useState<{lists?: string; domains?: string}>({})
  const options = useApiQuery(['campaign-options', { pageSize: 100, ...optionCursors }], async (api, signal) => {
    const [listPage, domainPage] = await Promise.all([
      api.lists.list({ pageSize: 100, cursor: optionCursors.lists }, signal), api.environment === 'test' ? Promise.resolve({items: [], nextCursor: null}) : api.domains.list({pageSize: 100, cursor: optionCursors.domains}, signal),
    ])
    const lists = listPage.items, domains = domainPage.items
    return { lists, domains: domains.filter(domain => domain.status === 'verified'), next: {lists: listPage.nextCursor, domains: domainPage.nextCursor} }
  })
  const previousOptions = useRef<typeof options.data>(undefined)
  if (options.data) previousOptions.current = options.data
  const choices = options.data ?? previousOptions.current
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input))
  const pending = preparing || autosaving || attachmentsBusy || composerBusy || saveMutation.isPending || loadingLatest
  busyRef.current = pending
  const markDirty = useCallback(() => { editVersion.current += 1; setEdits(editVersion.current); dirtyRef.current = true; setDirty(true); setError('') }, [])
  const handleComposerDirty = useCallback(() => { if (readyRef.current) markDirty() }, [markDirty])
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    updateForm({ ...formRef.current, [key]: value })
    markDirty()
  }
  function queueRemote(next: Campaign | null) { remoteRef.current = next; setRemote(next) }
  function applyRemote(next: Campaign) {
    // A manual reload and background poll can finish out of order. Never discard
    // a newer snapshot that arrived while the reload was in flight.
    if (remoteRef.current && olderCampaign(next, remoteRef.current)) next = remoteRef.current
    if (acceptedRef.current && olderCampaign(next, acceptedRef.current)) next = acceptedRef.current
    acceptedRef.current = next
    setAccepted(next)
    updateForm(campaignInput(next))
    setAutosavePaused(false)
    creation.current = null
    dirtyRef.current = false
    setDirty(false)
    readyRef.current = false
    setComposerReady(readyRef.current)
    setGeneration(value => value + 1)
    setPreviewOpen(Boolean(next.previewText))
    queueRemote(null)
    setReviewUpdate(false)
    setTestOpen(false)
    setError('')
  }
  function receiveRemote(next: Campaign) {
    const baseline = acceptedRef.current
    if (!baseline || next.id !== baseline.id || campaignVersion(next) === campaignVersion(baseline)) return
    if (olderCampaign(next, baseline) || (remoteRef.current && olderCampaign(next, remoteRef.current))) return
    setTestOpen(false)
    if (dirtyRef.current || busyRef.current) queueRemote(next)
    else applyRemote(next)
  }
  const sync = useCampaignSync(accepted, receiveRemote)
  const current = remote ?? accepted
  const unavailable = Boolean(sync.error && 'status' in sync.error && [401, 403, 404].includes(Number(sync.error.status)))
  const readOnly = unavailable || Boolean(current && (current.archivedAt || !['draft', 'reviewed'].includes(current.status)))
  const controlsDisabled = preparing || attachmentsBusy || composerBusy || loadingLatest || readOnly
  const saveDisabled = options.isPending || options.isError || !composerReady || readOnly || Boolean(remote)
  useEffect(() => {
    if (!dirty || pending || saveDisabled || autosavePaused || !form.name.trim()) return
    const timer = setTimeout(() => { void save('auto') }, 800)
    return () => clearTimeout(timer)
  }, [edits, dirty, pending, saveDisabled, autosavePaused, form.name])
  useEffect(() => { if (remote && !dirtyRef.current && !busyRef.current) applyRemote(remote) }, [remote, pending, dirty])
  async function loadLatest() {
    if (!acceptedRef.current || pending) return
    const controller = new AbortController()
    refreshController.current?.abort()
    refreshController.current = controller
    setLoadingLatest(true)
    busyRef.current = true
    try {
      const latest = await api.campaigns.get(acceptedRef.current.id, controller.signal)
      if (!controller.signal.aborted) applyRemote(latest)
    } catch (cause) { if (!controller.signal.aborted) toast(message(cause), 'error') }
    finally { if (!controller.signal.aborted) { setLoadingLatest(false); busyRef.current = false } }
  }
  const syncLabel = autosaving || preparing || saveMutation.isPending ? 'Saving…' : remote ? 'Update available' : autosavePaused ? 'Save failed' : error ? 'Check draft' : unavailable ? 'Unavailable' : readOnly ? 'Read only' : sync.connection === 'offline' ? 'Sync interrupted' : dirty ? form.name.trim() ? 'Unsaved changes' : 'Name required' : accepted ? 'Saved' : 'New draft'
  function reportError(value: string) { setError(value); toast(value, 'error') }
  async function save(next: 'auto' | 'edit' | 'review' | 'test') {
    if (guard.current || pending || !readyRef.current || readOnly) return
    const automatic = next === 'auto'
    if (remoteRef.current) { if (!automatic) setReviewUpdate(true); return }
    const continuing = next === 'review' || next === 'test'
    const input = creation.current?.input ?? formRef.current
    const version = creation.current?.version ?? editVersion.current
    const validation = !input.name.trim() ? 'Enter a campaign name.'
      : continuing && !input.subject.trim() ? 'Enter a subject before continuing.'
      : (continuing || input.fromEmail.trim()) && !emailIsValid(input.fromEmail.trim()) ? 'Enter a valid sender email address.'
      : !input.regionId.trim() || input.regionId.trim().length > 40 ? 'Enter a region identifier of 1–40 characters.'
      : continuing && !input.listId ? 'Choose a recipient list before continuing.' : ''
    if (validation) { if (!automatic) reportError(validation); return }
    guard.current = true
    busyRef.current = true
    setError('')
    setAutosavePaused(false)
    if (automatic) setAutosaving(true)
    else setPreparing(true)
    try {
      let submitted = creation.current?.input
      if (!submitted) {
        const content = await composer.current?.prepare()
        if (!content) throw new Error('The composer is still loading. Try again in a moment.')
        if (continuing && !content.html.trim()) throw new Error('Add some email content before continuing.')
        submitted = { ...input, ...content, attachments: [...new Set([...(input.attachments ?? []), ...(content.inlineAttachmentIds ?? [])])], name: input.name.trim(), subject: input.subject.trim(), fromName: input.fromName.trim(), fromEmail: input.fromEmail.trim(), regionId: input.regionId.trim() }
        if (!submitted.id) {
          submitted.idempotencyKey = crypto.randomUUID()
          creation.current = { input: structuredClone(submitted), version }
        }
      }
      const saved = await saveMutation.mutateAsync(submitted)
      if (!mounted.current) return
      creation.current = null
      const changedWhileSaving = editVersion.current !== version
      acceptedRef.current = saved
      setAccepted(saved)
      dirtyRef.current = changedWhileSaving
      setDirty(changedWhileSaving)
      queueRemote(remoteRef.current && olderCampaign(saved, remoteRef.current) ? remoteRef.current : null)
      updateForm({...formRef.current, id: saved.id, revision: saved.revision, draft: saved.draft, attachments: changedWhileSaving ? formRef.current.attachments : saved.attachments})
      const reviewing = next === 'review' && !changedWhileSaving
      if (!submitted.id && !reviewing) {
        preserveEditor(saved)
        navigate(campaignRoute(saved, 'edit', api.environment), { replace: true })
      }
      if (next === 'test' && !changedWhileSaving) setTestOpen(true)
      else if (reviewing) navigate(campaignRoute(saved, 'review', api.environment))
      if (!automatic && !changedWhileSaving) toast('Draft saved', 'success')
    } catch (cause) {
      if (!mounted.current) return
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0
      if (creation.current) {
        if (!creation.current.ambiguous && status >= 400 && status < 500 && status !== 408) creation.current = null
        else creation.current.ambiguous = true
      }
      setAutosavePaused(true)
      if (automatic) setError(message(cause))
      else reportError(message(cause))
      sync.checkNow()
    } finally {
      guard.current = false
      if (mounted.current) { setPreparing(false); setAutosaving(false) }
    }
  }
  return <div className="campaign-compose-page">
    <PageHeader title={accepted ? 'Edit campaign' : 'Create campaign'} backTo="/campaigns" actions={<>
      <div className="campaign-sync-status" role="status" data-state={error || autosavePaused || sync.connection === 'offline' ? 'offline' : remote || dirty || autosaving ? 'changed' : sync.connection} title={error || sync.error?.message || (remote ? 'A newer version is available. Your unsaved changes are safe.' : autosavePaused ? 'Autosave paused. Retry saving your changes.' : readOnly ? 'This campaign is no longer editable.' : 'Changes save automatically and sync with MCP and the API.')}>
        <span className="campaign-sync-dot" aria-hidden="true" />
        {remote || error || autosavePaused || sync.connection === 'offline' ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => { if (remote) setReviewUpdate(true); else if (autosavePaused) void save('edit'); else if (error) toast(error, 'error'); else sync.checkNow() }}>{syncLabel}</Button> : <span>{syncLabel}</span>}
      </div>
      <div className="campaign-compose-actions">
        <Button variant="ghost" disabled={!accepted || saveDisabled || pending || autosavePaused} title={!accepted ? 'Save your draft first' : undefined} onClick={() => save('test')}>Send test</Button>
        <Button variant="primary" disabled={saveDisabled || pending || autosavePaused} loading={preparing} onClick={() => save('review')}>Continue to review</Button>
      </div>
    </>} />
    {options.isError && choices && <ErrorState error={options.error} onRetry={() => options.refetch()} />}
    {options.isPending && !choices ? <CampaignEditorSkeleton /> : options.isError && !choices ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : choices && <section className="campaign-compose-workspace" aria-label="Campaign composer">
      <div className="campaign-compose-scroll">
        <div className="campaign-compose-sheet">
          <div className="campaign-compose-metadata">
            <div className="campaign-compose-row"><label htmlFor="campaign-name">Name</label><Input id="campaign-name" placeholder="Campaign name" value={form.name} onChange={event => change('name', event.target.value)} required disabled={controlsDisabled} /></div>
            <div className="campaign-compose-row"><label htmlFor="campaign-from-email">From</label><CampaignSenderInput key={generation} name={form.fromName} email={form.fromEmail} domains={choices.domains.map(domain => domain.name)} allowUnverified={testEnvironment} disabled={controlsDisabled} onChange={({name, email}) => {const domain = email.split('@')[1]?.toLowerCase(); const match = choices.domains.find(item => item.name === domain && item.regionId === formRef.current.regionId) ?? choices.domains.find(item => item.name === domain); if (name !== formRef.current.fromName || email !== formRef.current.fromEmail || (match && match.regionId !== formRef.current.regionId)) updateForm({...formRef.current, fromName: name, fromEmail: email, ...(match ? {regionId: match.regionId} : {})}); markDirty()}} /></div>
            {!testEnvironment && (optionCursors.domains || choices.next.domains) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, domains: undefined})}>First domains</Button><Button disabled={!choices.next.domains} onClick={() => setOptionCursors({...optionCursors, domains: choices.next.domains ?? undefined})}>More domains</Button></div>}
            {!testEnvironment && choices.domains.length === 0 && <Alert tone="warning">No verified domains on this page. <Link to="/domains">Add a domain</Link></Alert>}
            <div className="campaign-compose-row"><label htmlFor="campaign-list">To</label><Select id="campaign-list" aria-label="Include list" disabled={controlsDisabled} value={form.listId} onValueChange={value => change('listId', value)} options={choices.lists.length ? [{ value: '', label: 'Select a recipient list' }, ...(form.listId && !choices.lists.some(l => l.id === form.listId) ? [{value: form.listId, label: form.listId}] : []), ...choices.lists.map(list => ({ value: list.id, label: list.total === undefined ? list.name : `${list.name} · ${number(list.total)} contacts` }))] : [{value: '', label: 'No recipient lists created', disabled: true}]} /></div>
            {(optionCursors.lists || choices.next.lists) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, lists: undefined})}>First lists</Button><Button disabled={!choices.next.lists} onClick={() => setOptionCursors({...optionCursors, lists: choices.next.lists ?? undefined})}>More lists</Button></div>}
            <div id="campaign-preview-row" className="campaign-compose-preview" data-open={previewOpen || undefined} aria-hidden={!previewOpen} inert={!previewOpen}>
              <div><div className="campaign-compose-row"><label htmlFor="campaign-preview">Preview</label><Input ref={previewInput} id="campaign-preview" aria-label="Preview text" maxLength={200} placeholder="Inbox preview text" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={controlsDisabled} /></div></div>
            </div>
            <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="campaign-subject">Subject</label><Input id="campaign-subject" placeholder="Add a subject" value={form.subject} onChange={event => change('subject', event.target.value)} disabled={controlsDisabled} /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled={controlsDisabled} aria-expanded={previewOpen} aria-controls="campaign-preview-row" onClick={() => {setPreviewOpen(!previewOpen); if (!previewOpen) requestAnimationFrame(() => previewInput.current?.focus({preventScroll: true}))}}>Preview text</Button></div>
          </div>
          <Suspense fallback={<ComposerSkeleton />}><EmailComposer key={generation} ref={composer} attachmentIds={form.attachments ?? []} initialHtml={form.html} disabled={controlsDisabled} onReady={handleComposerReady} onDirty={handleComposerDirty} onBusy={value => {busyRef.current = value || attachmentsBusy || guard.current || loadingLatest; setComposerBusy(value); if (value) markDirty()}} onAttach={api.attachments ? () => {markDirty(); attachments.current?.open()} : undefined} /></Suspense>
          <CampaignAttachments key={`attachments:${generation}`} ref={attachments} ids={form.attachments ?? []} persisted={form.draft?.attachments ?? []} onChange={ids => change('attachments', ids)} onBusy={value => {busyRef.current = value || guard.current || loadingLatest; setAttachmentsBusy(value)}} disabled={preparing || autosaving || saveMutation.isPending || composerBusy || loadingLatest || readOnly} />
        </div>
      </div>
    </section>}
    <ConfirmDialog open={reviewUpdate} onOpenChange={value => {if (!loadingLatest) setReviewUpdate(value)}} title="Load the latest campaign?" description="This campaign changed outside this editor. Loading the latest version will discard your unsaved browser changes." confirmLabel="Load latest" onConfirm={loadLatest} pending={loadingLatest} />
    {accepted && testOpen && <TestEmailDialog id={accepted.id} open={testOpen} onOpenChange={setTestOpen} />}
  </div>
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
  const query = useApiQuery(['campaign', id], (api, signal) => api.campaigns.get(id, signal))
  if (query.isPending) return <CampaignRouteSkeleton kind="review" />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <CampaignReview key={id} campaign={query.data} />
}

// The server renders block HTML into the styled email; the review shows that rendering, not the blocks.
function CampaignRenderedPreview({ campaign }: { campaign: Campaign }) {
  const preview = useApiQuery(['campaign-preview', campaign.id, campaign.revision, campaign.updatedAt], (api, signal) => api.campaigns.preview(campaign.id, signal))
  if (preview.isPending) return <div className="ui-email-preview campaign-preview-loading" role="status"><SkeletonText width="55%" lineHeight={28} /><SkeletonText /><SkeletonText width="80%" /></div>
  if (preview.isError) return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
  return <EmailPreview html={preview.data.html} title="Campaign email preview" attachmentIds={campaign.attachments} respectStyles remoteImages />
}
function CampaignReview({ campaign }: { campaign: Campaign }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduled, setScheduled] = useState('')
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<SendCampaignInput | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const guard = useRef(false)
  const api = useApi()
  const draft = !campaign.archivedAt && ['draft', 'reviewed'].includes(campaign.status)
  const readinessError = campaignReadinessError(campaign)
  const audience = useApiMutation(async api => {
    if (readinessError) throw new Error(readinessError)
    return api.review ? api.review(campaign.id, campaign.revision!) : {...await api.campaigns.audience({listId: campaign.listId, segmentId: campaign.segmentId}), id: 'demo', revision: campaign.revision ?? 1} as ReviewResult
  })
  const [receipt, setReceipt] = useState('')
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input))
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); return }
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
    if (readinessError) { setError(readinessError); setConfirmation(null); return }
    guard.current = true
    setError('')
    try { const result = await sendMutation.mutateAsync(confirmation); setReceipt(`Campaign ${result.status}${'queued' in result ? ` · ${number(result.queued)} queued` : ''} · ${api.environment ?? 'demo'} mode${'simulated' in result && result.simulated ? ' (simulated)' : ''}`); setConfirmation(null) }
    catch (cause) { setError(message(cause)); setConfirmation(null) }
    finally { guard.current = false }
  }
  return <>
    <PageHeader title={draft ? 'Review campaign' : campaign.name} backTo={campaign.archivedAt ? '/campaigns?archived=true' : '/campaigns'} actions={<div className="cluster"><StatusBadge status={campaign.archivedAt ? 'archived' : campaign.status} />{campaign.archivedAt && <CampaignArchiveButton campaign={campaign} />}</div>} />
    {draft && <p className="muted campaign-review-name">{campaign.name}</p>}
    {draft && readinessError && <Alert tone="warning">{readinessError} <Link to={campaignRoute(campaign, 'edit', api.environment)}>Edit draft</Link></Alert>}
    {receipt && <Alert tone="success">{receipt}</Alert>}{!draft && campaign.scheduledAt && <Alert tone="info">Scheduled for {date(campaign.scheduledAt)} at {time(campaign.scheduledAt)} UTC.</Alert>}
    <div className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title="Recipients" actions={draft ? <Button variant="ghost" onClick={() => navigate(campaignRoute(campaign, 'edit', api.environment))}>Edit audience</Button> : undefined} />
        {draft ? audience.isPending ? <CampaignAudienceSkeleton /> : audience.isError ? <ErrorState error={audience.error} onRetry={() => audience.mutate(undefined)} /> : !audience.data ? <Button variant="primary" disabled={Boolean(readinessError)} onClick={() => audience.mutate(undefined)}>Generate recipient review</Button> : <>
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
        <SectionHeader title="Message preview" actions={draft ? <div className="cluster"><Button variant="ghost" onClick={() => navigate(campaignRoute(campaign, 'edit', api.environment))}>Edit message</Button><Button variant="secondary" disabled={Boolean(readinessError)} onClick={() => setTestOpen(true)}>Send test</Button></div> : undefined} />
        <dl className="campaign-message-details"><dt>From</dt><dd>{campaign.fromName} &lt;{campaign.fromEmail}&gt;</dd><dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <CampaignRenderedPreview campaign={campaign} />
      </section>
    </div>
    {draft && <section className="section campaign-delivery">
      <SectionHeader title="Delivery" />
      <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      {mode === 'schedule' && <div className="form-grid"><Field label="Time zone"><Input value="UTC (UTC+00:00)" readOnly aria-label="Time zone" /></Field><Field label="Date and time (UTC)" htmlFor="campaign-schedule"><Input id="campaign-schedule" type="datetime-local" value={scheduled} onChange={event => { setScheduled(event.target.value); setError('') }} disabled={sendMutation.isPending} /></Field></div>}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled={sendMutation.isPending} onClick={() => navigate(campaignRoute(campaign, 'edit', api.environment))}>Back to draft</Button><Button variant="primary" loading={sendMutation.isPending} disabled={Boolean(readinessError) || audience.isPending || audience.isError || !audience.data?.eligible} onClick={requestConfirmation}>{mode === 'schedule' ? 'Schedule campaign' : 'Send campaign now'}</Button></div>
    </section>}
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'} description={confirmation?.mode === 'schedule' ? `In ${api.environment ?? 'demo'} mode, send “${campaign.name}” from ${campaign.regionId} to ${number(audience.data?.eligible ?? 0)} eligible recipients on ${date(confirmation.scheduledAt)} at ${time(confirmation.scheduledAt!)} UTC.` : `In ${api.environment ?? 'demo'} mode, send “${campaign.name}” from ${campaign.regionId} to ${number(audience.data?.eligible ?? 0)} eligible recipients now. This action cannot be undone.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Confirm schedule' : 'Confirm send'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && testOpen && <TestEmailDialog id={campaign.id} open={testOpen} onOpenChange={setTestOpen} />}
  </>
}
