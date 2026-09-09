import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EmailEditor, type EmailEditorRef } from '@react-email/editor'
import type {} from '@react-email/editor/extensions'
import { composeReactEmail, isDocumentVisuallyEmpty } from '@react-email/editor/core'
import { Bold, ChevronDown, Columns2, Heading2, ImagePlus, Italic, List, Minus, MousePointer2, Plus, Redo2, Type, Undo2 } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DropdownMenu, Field, IconButton, SkeletonText, Tabs, Textarea } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { useApi } from '../../data/context'
import type { CampaignEditorMetadata } from '../../data/types'
import { prepareEditorContent, prepareLocalImage, sanitizeEditorDocument, inlineImageSources, inlineImageReferences, inlineImageHash, replaceImageSource, replaceEditorImageSources, loadInlineAttachments, cidImageSources, type InlineImageReference } from './composer-content'
import '@react-email/editor/themes/default.css'
import './composer.css'

type Draft = { html: string; editor: CampaignEditorMetadata | null; inlineAttachmentIds?: string[] }
export type EmailComposerRef = { prepare: () => Promise<Draft> }
type Props = { attachmentIds?: string[]; initialHtml: string; initialEditor?: CampaignEditorMetadata | null; previewText: string; disabled?: boolean; onReady: () => void; onDirty: () => void }
type Mode = 'compose' | 'html' | 'preview'
const linkForms = '[data-re-link-selector-form], [data-re-link-bm-form], [data-re-btn-bm-form], [data-re-img-bm-form]'

export const EmailComposer = forwardRef<EmailComposerRef, Props>(function EmailComposer({ attachmentIds = [], initialHtml, initialEditor, previewText, disabled = false, onReady, onDirty }, ref) {
  const api = useApi()
  const inlineReferences = useRef<InlineImageReference[]>(inlineImageReferences(initialEditor?.document))
  const ownedInline = useRef(new Set<string>())
  const preparing = useRef<Promise<Draft> | null>(null)
  const [initialSnapshot] = useState(() => ({html: initialHtml, editor: initialEditor, attachmentIds: [...attachmentIds]}))
  const resolvedImageSources = useRef(new Map<string, string>())
  const [hydrating, setHydrating] = useState(Boolean(initialEditor && cidImageSources(initialHtml).size))
  const [previewAttachmentIds, setPreviewAttachmentIds] = useState(attachmentIds)
  const [previewEditor, setPreviewEditor] = useState(initialEditor ?? null)
  const [initial] = useState(() => prepareEditorContent(initialHtml, initialEditor))
  const [mode, setMode] = useState<Mode>(initial.canCompose ? 'compose' : 'html')
  const [source, setSource] = useState<'compose' | 'html'>(initial.canCompose ? 'compose' : 'html')
  const [content, setContent] = useState(initial.content)
  const [generation, setGeneration] = useState(0)
  const [raw, setRaw] = useState(initialHtml)
  const [preview, setPreview] = useState(initialHtml)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [convert, setConvert] = useState(false)
  const editor = useRef<EmailEditorRef>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const changed = useRef(false)
  const preservedEditor = useRef(initialEditor ?? null)
  const operation = useRef(false)
  const latestRaw = useRef(initialHtml)
  const preservedHtml = useRef(initialHtml)
  const uploads = useRef(0)
  const sourceRef = useRef(source)
  const locked = disabled || busy || hydrating
  const [theme] = useState(() => {
    const tokens = getComputedStyle(document.documentElement)
    const fontFamily = tokens.getPropertyValue('--font-email').trim()
    const color = tokens.getPropertyValue('--color-email-text').trim()
    const backgroundColor = tokens.getPropertyValue('--color-email-surface').trim()
    return { extends: 'minimal' as const, styles: {
      body: { fontFamily, color, backgroundColor, margin: '0', padding: '0' },
      container: { width: '100%', maxWidth: '600px', margin: '0 auto', padding: '24px' },
      paragraph: { fontFamily, fontSize: '16px', lineHeight: '1.6', margin: '0 0 16px', color },
      h1: { fontFamily, fontSize: '26px', lineHeight: '1.25', fontWeight: '600', margin: '0 0 20px', color },
      h2: { fontFamily, fontSize: '22px', lineHeight: '1.3', fontWeight: '600', margin: '24px 0 12px', color },
      h3: { fontFamily, fontSize: '18px', lineHeight: '1.4', fontWeight: '600', margin: '20px 0 12px', color },
      button: { fontFamily, fontSize: '15px', backgroundColor: '#181818', color: '#ffffff', padding: '12px 20px', borderRadius: '4px' },
      link: { color: '#3156c7', textDecoration: 'underline' },
      image: { maxWidth: '100%', height: 'auto' },
    } }
  })

  function synchronizeEditor(instance: EmailEditorRef) {
    const value = instance.editor
    if (!value) return
    // Tiptap preserves isEditable during React option updates; synchronize it explicitly.
    value.setEditable(!locked && source === 'compose', false)
    value.setOptions({ editorProps: {
      ...value.options.editorProps,
      attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        if (locked || source !== 'compose') return true
        if (event.clipboardData?.files.length) return false
        const html = event.clipboardData?.getData('text/html')
        if (!html) return false
        event.preventDefault()
        value.commands.insertContent(prepareEditorContent(html).content)
        return true
      },
      transformPastedHTML: html => String(prepareEditorContent(html).content),
    } })
  }
  // Run after child option reconciliation so the name and paste boundary remain installed.
  useEffect(() => { if (editor.current) synchronizeEditor(editor.current) })

  useEffect(() => {
    if (!initialSnapshot.editor || !cidImageSources(initialSnapshot.html).size) return
    const controller = new AbortController()
    let release: (() => void) | undefined
    setHydrating(true)
    loadInlineAttachments(api, initialSnapshot.attachmentIds, cidImageSources(initialSnapshot.html), controller.signal).then(result => {
      if (controller.signal.aborted) {result.release(); return}
      release = result.release
      resolvedImageSources.current = new Map([...result.sources].map(([cid, url]) => [url, cid]))
      const original = sanitizeEditorDocument(initialSnapshot.editor!.document)
      setContent(replaceEditorImageSources(original, result.sources))
      setHydrating(false); setReady(false); setGeneration(value => value + 1)
    }).catch(cause => {if (!controller.signal.aborted) {setError(cause instanceof Error ? cause.message : 'Inline images could not be loaded.'); setHydrating(false); setGeneration(value => value + 1)}})
    return () => {controller.abort(); release?.()}
  }, [api, initialSnapshot])

  async function prepareContent(allowEmpty = false): Promise<Draft> {
    if (hydrating) throw new Error('Wait for inline images to finish loading before saving.')
    if (uploads.current) throw new Error('Wait for your image to finish loading before continuing.')
    if (sourceRef.current === 'html') {
      if (api.mode !== 'demo' && /<img\b[^>]*\bsrc\s*=\s*["']data:/i.test(latestRaw.current)) throw new Error('Inline data images cannot be sent. Convert this HTML to Compose so images can be uploaded as inline attachments, or use an HTTPS image URL.')
      return { html: latestRaw.current, editor: latestRaw.current === preservedHtml.current ? preservedEditor.current : null, inlineAttachmentIds: inlineReferences.current.filter(item => latestRaw.current.includes(`cid:${item.contentId}`)).map(item => item.attachmentId) }
    }
    const instance = editor.current
    if (!instance?.editor) throw new Error('The composer is still loading. Try again in a moment.')
    if (isDocumentVisuallyEmpty(instance.editor.state.doc)) {
      if (allowEmpty) return { html: '', editor: null }
      throw new Error('Add some email content before continuing.')
    }
    if (!changed.current && preservedHtml.current.trim() && (api.mode === 'demo' || (!/<script\b/i.test(preservedHtml.current) && !/<img\b[^>]*\bsrc\s*=\s*["']data:/i.test(preservedHtml.current) && !inlineImageSources(preservedEditor.current?.document ?? {}).length))) return { html: preservedHtml.current, editor: preservedEditor.current }
    // The serializer snapshots JSON before its first await. Lock the editor during export.
    let document = sanitizeEditorDocument(replaceEditorImageSources(instance.getJSON(), resolvedImageSources.current))
    if (new TextEncoder().encode(JSON.stringify({format: 'react-email', version: 1, document})).byteLength > 256 * 1024) throw new Error('The visual document exceeds 256 KiB. Remove an image or shorten the content before saving.')
    const result = await composeReactEmail({ editor: instance.editor })
    // React Email emits JSON-LD metadata, but the public send contract forbids all script tags.
    let html = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    for (const [localSource, cid] of resolvedImageSources.current) html = replaceImageSource(html, localSource, cid)
    const currentReferences: InlineImageReference[] = []
    const storedSources = new Map<string, string>()
    if (api.attachments) {
      const metadata = await Promise.all(attachmentIds.map(id => api.attachments!.get(id)))
      let totalSize = metadata.reduce((total, item) => total + item.size, 0)
      const allIds = new Set(attachmentIds)
      for (const source of inlineImageSources(document)) {
        const hash = await inlineImageHash(source)
        let reference = inlineReferences.current.find(item => item.hash === hash && (allIds.has(item.attachmentId) || ownedInline.current.has(item.attachmentId)))
        if (!reference) {
          const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,(.+)$/i.exec(source)
          if (!match) throw new Error('Unsupported inline image format.')
          const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
          if (allIds.size >= 20 || totalSize + bytes.length > 8 * 1024 * 1024) throw new Error('Use at most 20 attachments with a combined size of 8 MiB.')
          const contentId = `opensend-${crypto.randomUUID()}`
          const extension = match[1].split('/')[1] === 'jpeg' ? 'jpg' : match[1].split('/')[1]
          const item = await api.attachments.upload(new File([bytes], `image-${hash.slice(0, 12)}.${extension}`, {type: match[1]}), {contentId})
          reference = {hash, contentId, attachmentId: item.id}
          ownedInline.current.add(item.id); inlineReferences.current.push(reference); totalSize += item.size
        } else if (!allIds.has(reference.attachmentId)) {
          totalSize += (await api.attachments.get(reference.attachmentId)).size
          if (allIds.size >= 20 || totalSize > 8 * 1024 * 1024) throw new Error('Use at most 20 attachments with a combined size of 8 MiB.')
        }
        allIds.add(reference.attachmentId); currentReferences.push(reference)
        html = replaceImageSource(html, source, `cid:${reference.contentId}`)
        storedSources.set(source, `cid:${reference.contentId}`)
      }
      document = replaceEditorImageSources(document, storedSources)
      delete document.opensendInlineImages
    }
    if (new TextEncoder().encode(JSON.stringify({format: 'react-email', version: 1, document})).byteLength > 256 * 1024) throw new Error('The visual document exceeds 256 KiB. Remove an image or shorten the content before saving.')
    if (html.length > 500_000) throw new Error('This email is too large. Remove an image or shorten the content before saving.')
    return { html, editor: { format: 'react-email', version: 1, document }, inlineAttachmentIds: currentReferences.map(item => item.attachmentId) }
  }
  function prepare(allowEmpty = false): Promise<Draft> {
    if (!preparing.current) preparing.current = prepareContent(allowEmpty).finally(() => {preparing.current = null})
    return preparing.current
  }
  useImperativeHandle(ref, () => ({ prepare }))

  function openVisual() {
    const imported = prepareEditorContent(latestRaw.current)
    setContent(imported.content)
    setGeneration(value => value + 1)
    changed.current = false
    preservedHtml.current = latestRaw.current
    preservedEditor.current = null
    sourceRef.current = 'compose'
    setSource('compose')
    setReady(false)
    setMode('compose')
    setConvert(false)
  }
  async function selectMode(next: string) {
    if (locked || operation.current) return false
    if (next === mode) return true
    setError('')
    if (next === 'compose') {
      if (sourceRef.current === 'html') {
        if (!prepareEditorContent(latestRaw.current).canCompose) { setConvert(true); return false }
        openVisual()
      } else setMode('compose')
      return true
    }
    operation.current = true
    setBusy(true)
    try {
      const draft = await prepare(next === 'html')
      if (next === 'html') { latestRaw.current = draft.html; setRaw(draft.html) }
      else {setPreview(draft.html); setPreviewEditor(draft.editor); setPreviewAttachmentIds([...new Set([...attachmentIds, ...(draft.inlineAttachmentIds ?? [])])])}
      setMode(next as Mode)
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare this email.'); return false }
    finally { operation.current = false; setBusy(false) }
  }
  const upload = useCallback(async (file: File) => {
    uploads.current += 1
    setBusy(true)
    try { return await prepareLocalImage(file) }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Could not load this image.'; setError(message); throw new Error(message) }
    finally { uploads.current -= 1; if (!uploads.current) setBusy(false) }
  }, [])
  async function insertImage(file?: File) {
    if (!file || locked) return
    setBusy(true)
    setError('')
    try {
      const { url } = await upload(file)
      command(e => e.chain().focus().insertContent({ type: 'image', attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, ''), width: '100%' } }).run(), true)
    } catch { /* Shown inline by the upload callback. */ }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  function command(run: (value: NonNullable<EmailEditorRef['editor']>) => void, insert = false) {
    if (locked || !ready || !editor.current?.editor) return
    const instance = editor.current.editor
    const selection = instance.state.selection
    // Insert after selected media instead of replacing it with the new block.
    if (insert && selection.toJSON().type === 'node') {
      const after = selection.to
      instance.view.focus()
      instance.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).run()
    }
    run(instance)
  }
  return <div className="email-composer" data-inactive={locked || mode !== 'compose' || undefined} onClickCapture={event => { if (locked) { event.preventDefault(); event.stopPropagation() } }} onKeyDownCapture={event => {
    if (event.key === 'Escape' && (event.target as Element).closest(linkForms)) {
      event.preventDefault()
      event.stopPropagation()
      const trigger = (event.target as Element).closest('[data-re-link-selector]')?.querySelector<HTMLButtonElement>('[data-re-link-selector-trigger]')
      // These library forms stop bubbling before their own window Escape listener can run.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); else editor.current?.editor?.commands.focus() })
    } else if (locked) { event.preventDefault(); event.stopPropagation() }
  }}>
    <div className="composer-mode-bar"><Tabs value={mode} onValueChange={selectMode} disabled={locked} label="Email content mode" items={[{ value: 'compose', label: 'Compose' }, { value: 'html', label: 'HTML' }, { value: 'preview', label: 'Preview' }]} />{busy && <span className="muted" role="status">Preparing…</span>}</div>
    {initial.reason && source === 'html' && <Alert tone="info">{initial.reason}</Alert>}
    {error && <Alert tone="danger">{error}</Alert>}
    <div hidden={mode !== 'compose'} className="composer-visual">
      <div className="composer-tools" aria-label="Email formatting" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
        <DropdownMenu trigger={<Button disabled={locked || !ready}><Plus size={16} />Insert<ChevronDown size={14} /></Button>} items={[
          { label: 'Text', icon: <Type size={16} />, onSelect: () => command(e => e.chain().focus().setParagraph().run(), true) },
          { label: 'Heading', icon: <Heading2 size={16} />, onSelect: () => command(e => e.chain().focus().setHeading({ level: 2 }).run(), true) },
          { label: 'Button', icon: <MousePointer2 size={16} />, onSelect: () => command(e => e.chain().focus().setButton().run(), true) },
          { label: 'Image', icon: <ImagePlus size={16} />, onSelect: () => fileInput.current?.click() },
          { label: 'Bullet list', icon: <List size={16} />, onSelect: () => command(e => e.chain().focus().toggleBulletList().run(), true) },
          { label: 'Divider', icon: <Minus size={16} />, onSelect: () => command(e => e.chain().focus().setHorizontalRule().run(), true) },
          { label: 'Two columns', icon: <Columns2 size={16} />, onSelect: () => command(e => e.chain().focus().insertColumns(2).run(), true) },
        ]} />
        <div className="cluster"><IconButton label="Bold" disabled={locked || !ready} onClick={() => command(e => e.chain().focus().toggleBold().run())}><Bold /></IconButton><IconButton label="Italic" disabled={locked || !ready} onClick={() => command(e => e.chain().focus().toggleItalic().run())}><Italic /></IconButton></div>
        <div className="cluster composer-history"><IconButton label="Undo" disabled={locked || !ready} onClick={() => command(e => e.chain().focus().undo().run())}><Undo2 /></IconButton><IconButton label="Redo" disabled={locked || !ready} onClick={() => command(e => e.chain().focus().redo().run())}><Redo2 /></IconButton></div>
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void insertImage(event.target.files?.[0])} />
      </div>
      <div className="composer-canvas" onClickCapture={event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault() }}>
        {!ready && <div className="composer-starting" role="status"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><span className="sr-only">Loading visual composer</span></div>}
        <EmailEditor key={generation} ref={editor} content={content} theme={theme} editable={!locked && source === 'compose'} placeholder="Write your newsletter, or type / to insert a block…" onUploadImage={upload} className="composer-document" onReady={instance => { synchronizeEditor(instance); setReady(!hydrating); if (!hydrating) onReady() }} onUpdate={() => { changed.current = true; onDirty() }} />
      </div>
    </div>
    {mode === 'html' && <Field label="Email HTML" htmlFor="campaign-html"><Textarea id="campaign-html" className="campaign-html" value={raw} disabled={locked} spellCheck={false} onChange={event => { latestRaw.current = event.target.value; setRaw(event.target.value); sourceRef.current = 'html'; setSource('html'); onDirty() }} /></Field>}
    {mode === 'preview' && <EmailPreview html={preview} title="Campaign email preview" editor={previewEditor} attachmentIds={previewAttachmentIds} />}
    <ConfirmDialog open={convert} onOpenChange={setConvert} title="Convert HTML to visual blocks?" description="Custom HTML and styles may not convert exactly. The original HTML is kept until you edit the blocks." confirmLabel="Convert to blocks" onConfirm={openVisual} />
  </div>
})
