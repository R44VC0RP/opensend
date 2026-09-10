import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useApi, useApiMutation, useApiQuery, useRegion } from '../../data/context'
import type { CampaignTemplate, CampaignTemplateDraft } from '../../data/types'
import { Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, StatusBadge, Tabs, useToast } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, time } from '../../lib/format'
import { CampaignAttachments, type CampaignAttachmentsRef } from '../campaigns/CampaignAttachments'
import type { EmailComposerRef } from '../campaigns/EmailComposer'
import { ComposerSkeleton } from '../campaigns/skeletons'
import '../campaigns/campaigns.css'
import './templates.css'

const loadEmailComposer = () => import('../campaigns/EmailComposer').then(module => ({ default: module.EmailComposer }))
const EmailComposer = lazy(loadEmailComposer)
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'

export function TemplatesPage() {
  const api = useApi()
  const navigate = useNavigate()
  const { regionId } = useRegion()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const archived = params.get('archived') === 'true'
  const search = params.get('search') ?? ''
  const requestedPage = Number(params.get('page'))
  const currentPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const query = useApiQuery(['templates', { search, archived, page: currentPage }], (client, signal) => client.templates.list({ search: search || undefined, archived, page: currentPage, pageSize: 10 }, signal))
  const create = useApiMutation((client, name: string) => client.templates.create({ name }))
  const instantiate = useApiMutation((client, template: {id: string; name: string}) => client.campaigns.save({ templateId: template.id, idempotencyKey: crypto.randomUUID(), regionId, name: template.name, subject: '', previewText: '', fromName: '', fromEmail: '', listId: '', segmentId: null, html: '' }))
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  async function createTemplate() {
    if (!name.trim()) return
    try { const result = await create.mutateAsync(name.trim()); navigate(`/templates/${encodeURIComponent(result.id)}`) }
    catch (error) { toast(errorMessage(error), 'error') }
  }
  async function createCampaign(template: {id: string; name: string}) {
    try { const campaign = await instantiate.mutateAsync(template); navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit${api.environment ? `?environment=${api.environment}` : ''}`) }
    catch (error) { toast(errorMessage(error), 'error') }
  }
  return <>
    <PageHeader title="Templates" actions={<Button variant="primary" onClick={() => setCreateOpen(true)}>Create template</Button>} />
    <Tabs value={archived ? 'archived' : 'active'} onValueChange={value => setParams(value === 'archived' ? { archived: 'true' } : {})} items={[{value: 'active', label: 'Active'}, {value: 'archived', label: 'Archived'}]} />
    <div className="data-toolbar"><Input className="template-search" type="search" aria-label="Search templates" placeholder="Search templates" value={search} onChange={event => setParams(previous => { const next = new URLSearchParams(previous); event.target.value ? next.set('search', event.target.value) : next.delete('search'); next.delete('page'); return next })} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/templates/${encodeURIComponent(row.id)}`)} empty={<EmptyState title={search ? 'No matching templates' : archived ? 'No archived templates' : 'No templates yet'} action={!search && !archived ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create template</Button> : undefined} />} columns={[
        {key: 'name', label: 'Template', render: row => <div className="campaign-row-name"><Link to={`/templates/${encodeURIComponent(row.id)}`} onClick={event => event.stopPropagation()}>{row.name}</Link><span className="muted">{row.subject || row.description || 'No subject yet'}</span></div>},
        {key: 'status', label: 'Status', width: 120, render: row => <StatusBadge status={row.published ? 'Published' : 'Draft'} />},
        {key: 'updated', label: 'Updated', width: 190, render: row => <span className="muted">{date(row.updatedAt)} · {time(row.updatedAt)} UTC</span>},
        {key: 'action', label: '', width: 150, align: 'right' as const, render: row => row.published && !archived ? <Button size="sm" variant="secondary" disabled={instantiate.isPending || !regionId} onClick={() => void createCampaign(row)}>Create campaign</Button> : null},
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={page => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(page)); return next })} />}
    </>}
    <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create template" footer={<><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => void createTemplate()}>Create</Button></>}><Field label="Name"><Input autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createTemplate() }} /></Field></Dialog>
  </>
}

export function TemplateEditorPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['template', id], (api, signal) => api.templates.get(id, signal))
  if (query.isPending) return <div className="campaign-compose-page"><ComposerSkeleton /></div>
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <TemplateEditor key={`${query.data.id}:${query.data.revision}`} initial={query.data} />
}

function TemplateEditor({ initial }: {initial: CampaignTemplate}) {
  const api = useApi()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [template, setTemplate] = useState(initial)
  const [draft, setDraft] = useState(initial.draft)
  const draftRef = useRef(draft)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [assetBusy, setAssetBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [error, setError] = useState('')
  const version = useRef(0)
  const savingRef = useRef(false)
  const archived = Boolean(template.archivedAt)
  const refreshLists = () => cache.invalidateQueries({queryKey: ['opensend', api.mode, api.environment, 'templates'], refetchType: 'none'})
  const remember = (value: CampaignTemplate) => cache.setQueryData(['opensend', api.mode, api.environment, 'template', value.id], value)
  const changed = useCallback(() => { version.current++; setDirty(true); setError('') }, [])
  function change<K extends keyof CampaignTemplateDraft>(key: K, value: CampaignTemplateDraft[K]) { const next = {...draftRef.current, [key]: value}; draftRef.current = next; setDraft(next); changed() }
  useEffect(() => {
    if (!dirty || saving || savingRef.current || !ready || assetBusy || composerBusy || archived || !draft.name.trim()) return
    const timer = window.setTimeout(() => void save(), 800)
    return () => window.clearTimeout(timer)
  }, [dirty, saving, ready, assetBusy, composerBusy, archived, draft.name])
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty || savingRef.current) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  async function save(): Promise<CampaignTemplate | null> {
    if (savingRef.current || !ready || archived) return null
    savingRef.current = true; setSaving(true); setError('')
    const submittedVersion = version.current
    try {
      const content = await composer.current?.prepare()
      if (!content) throw new Error('The composer is still loading.')
      const submitted = {...draftRef.current, ...content, attachments: [...new Set([...(draftRef.current.attachments ?? []), ...(content.inlineAttachmentIds ?? [])])], name: draftRef.current.name.trim(), subject: draftRef.current.subject.trim()}
      const updated = await api.templates.update(template.id, template.revision, submitted)
      remember(updated)
      await refreshLists()
      setTemplate(updated); draftRef.current = version.current === submittedVersion ? updated.draft : draftRef.current; if (version.current === submittedVersion) { setDraft(updated.draft); setDirty(false) }
      return updated
    } catch (cause) { const message = errorMessage(cause); setError(message); return null }
    finally { savingRef.current = false; setSaving(false) }
  }
  async function publish() {
    const current = dirty ? await save() : template
    if (!current) { toast(error || 'Save the template before publishing.', 'error'); return }
    try { const updated = await api.templates.publish(current.id, current.revision); setTemplate(updated); remember(updated); await refreshLists(); toast('Template published', 'success') }
    catch (cause) { toast(errorMessage(cause), 'error') }
  }
  async function archive() {
    try { const updated = await api.templates.archive(template.id, !archived); setTemplate(updated); remember(updated); await refreshLists(); toast(archived ? 'Template restored' : 'Template archived', 'success') }
    catch (cause) { toast(errorMessage(cause), 'error') }
  }
  return <div className="campaign-compose-page template-compose-page">
    <PageHeader title={draft.name || 'Template'} backTo="/templates" actions={<>
      <div className="campaign-sync-status" data-state={error ? 'offline' : dirty || saving ? 'changed' : 'live'} role="status"><span className="campaign-sync-dot" aria-hidden="true" /><span>{saving ? 'Saving…' : error ? 'Save failed' : dirty ? 'Unsaved changes' : 'Saved'}</span></div>
      <Button variant="ghost" disabled={saving || dirty || !draft.html} onClick={() => setPreviewOpen(true)}>Preview</Button>
      {archived && <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete</Button>}
      <Button variant="secondary" disabled={saving} onClick={() => void archive()}>{archived ? 'Restore' : 'Archive'}</Button>
      <Button variant="primary" disabled={archived || saving || !ready || template.publishedRevision === template.revision && !dirty} onClick={() => void publish()}>{template.publishedRevision === template.revision && !dirty ? 'Published' : 'Publish'}</Button>
    </>} />
    <section className="campaign-compose-workspace" aria-label="Template composer"><div className="campaign-compose-scroll"><div className="campaign-compose-sheet">
      <div className="campaign-compose-metadata">
        <div className="campaign-compose-row"><label htmlFor="template-name">Name</label><Input id="template-name" value={draft.name} disabled={archived} onChange={event => change('name', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-description">Purpose</label><Input id="template-description" value={draft.description} disabled={archived} onChange={event => change('description', event.target.value)} /></div>
        <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="template-subject">Subject</label><Input id="template-subject" value={draft.subject} disabled={archived} onChange={event => change('subject', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-preview">Preview</label><Input id="template-preview" value={draft.previewText ?? ''} disabled={archived} onChange={event => change('previewText', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-from">From</label><Input id="template-from" value={draft.fromName ?? ''} disabled={archived} onChange={event => change('fromName', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-reply">Reply to</label><Input id="template-reply" value={draft.replyTo.join(', ')} disabled={archived} onChange={event => change('replyTo', event.target.value.split(',').map(value => value.trim()).filter(Boolean))} /></div>
      </div>
      {error && <p className="ui-field__error template-save-error" role="alert">{error}</p>}
      <Suspense fallback={<ComposerSkeleton />}><EmailComposer ref={composer} attachmentApi={api.templateAssets} attachmentIds={draft.attachments} initialHtml={draft.html ?? ''} disabled={archived} onReady={() => setReady(true)} onDirty={changed} onBusy={setComposerBusy} onAttach={() => attachments.current?.open()} /></Suspense>
      <CampaignAttachments ref={attachments} attachmentApi={api.templateAssets} ids={draft.attachments} persisted={template.draft.attachments} onChange={ids => change('attachments', ids)} onBusy={setAssetBusy} disabled={archived || saving || composerBusy} />
    </div></div></section>
    {previewOpen && <TemplatePreviewDialog template={template} onOpenChange={setPreviewOpen} />}
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete template?" description="Campaigns already created from this template will not change." confirmLabel="Delete template" danger onConfirm={async () => { await api.templates.remove(template.id); cache.removeQueries({queryKey: ['opensend', api.mode, api.environment, 'template', template.id], exact: true}); await refreshLists(); navigate('/templates') }} />
  </div>
}

function TemplatePreviewDialog({ template, onOpenChange }: {template: CampaignTemplate; onOpenChange: (open: boolean) => void}) {
  const api = useApi()
  const preview = useApiQuery(['template-preview', template.id, template.revision], (client, signal) => client.templates.preview(template.id, false, signal))
  return <Dialog open onOpenChange={onOpenChange} title="Template preview" className="template-preview-dialog">
    {preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : preview.isPending ? <div className="stack"><ComposerSkeleton /></div> : <EmailPreview html={preview.data.html} attachmentIds={template.draft.attachments} attachmentApi={api.templateAssets} respectStyles />}
  </Dialog>
}
