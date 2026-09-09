import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EmailEditor, type EmailEditorRef } from '@react-email/editor'
import type {} from '@react-email/editor/extensions'
import { composeReactEmail, isDocumentVisuallyEmpty } from '@react-email/editor/core'
import { Bold, ChevronDown, Columns2, Heading2, ImagePlus, Italic, List, Minus, MousePointer2, Plus, Redo2, Type, Undo2 } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DropdownMenu, IconButton, SkeletonText } from '../../components/ui'
import { useApi } from '../../data/context'
import type { CampaignEditorMetadata } from '../../data/types'
import { prepareEditorContent, prepareLocalImage, sanitizeEditorDocument, inlineImageSources, inlineImageReferences, inlineImageHash, replaceImageSource, replaceEditorImageSources, loadInlineAttachments, cidImageSources, type InlineImageReference } from './composer-content'
import '@react-email/editor/themes/default.css'
import './composer.css'

type Draft = { html: string; editor: CampaignEditorMetadata | null; inlineAttachmentIds?: string[] }
export type EmailComposerRef = { prepare: () => Promise<Draft> }
type Props = { attachmentIds?: string[]; initialHtml: string; initialEditor?: CampaignEditorMetadata | null; disabled?: boolean; onReady: () => void; onDirty: () => void }
const linkForms = '[data-re-link-selector-form], [data-re-link-bm-form], [data-re-btn-bm-form], [data-re-img-bm-form]'

export const EmailComposer = forwardRef<EmailComposerRef, Props>(function EmailComposer({ attachmentIds = [], initialHtml, initialEditor, disabled = false, onReady, onDirty }, ref) {
  const api = useApi()
  const inlineReferences = useRef<InlineImageReference[]>(inlineImageReferences(initialEditor?.document))
  const ownedInline = useRef(new Set<string>())
  const preparing = useRef<Promise<Draft> | null>(null)
  const [initialSnapshot] = useState(() => ({html: initialHtml, editor: initialEditor, attachmentIds: [...attachmentIds]}))
  const resolvedImageSources = useRef(new Map<string, string>())
  const [hydrating, setHydrating] = useState(Boolean(initialEditor && cidImageSources(initialHtml).size))
  const [initial] = useState(() => prepareEditorContent(initialHtml, initialEditor))
  const [source, setSource] = useState<'compose' | 'html'>(initial.canCompose ? 'compose' : 'html')
  const [content, setContent] = useState(initial.content)
  const [generation, setGeneration] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [convert, setConvert] = useState(false)
  const editor = useRef<EmailEditorRef>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const changed = useRef(false)
  const preservedEditor = useRef(initialEditor ?? null)
  const preservedHtml = useRef(initialHtml)
  const uploads = useRef(0)
  const sourceRef = useRef(source)
  const locked = disabled || busy || hydrating
  const [theme] = useState(() => {
    const tokens = getComputedStyle(document.documentElement)
    const fontFamily = tokens.getPropertyValue('--font-email').trim()
    const letterSpacing = tokens.getPropertyValue('--tracking-email').trim()
    const color = tokens.getPropertyValue('--color-email-text').trim()
    const backgroundColor = tokens.getPropertyValue('--color-email-surface').trim()
    return { extends: 'minimal' as const, styles: {
      body: { fontFamily, letterSpacing, color, backgroundColor, margin: '0', padding: '0' },
      container: { width: '100%', maxWidth: '600px', margin: '0 auto', padding: '24px' },
      paragraph: { fontFamily, letterSpacing, fontSize: '16px', lineHeight: '1.6', margin: '0 0 16px', color },
      h1: { fontFamily, letterSpacing, fontSize: '26px', lineHeight: '1.25', fontWeight: '600', margin: '0 0 20px', color },
      h2: { fontFamily, letterSpacing, fontSize: '22px', lineHeight: '1.3', fontWeight: '600', margin: '24px 0 12px', color },
      h3: { fontFamily, letterSpacing, fontSize: '18px', lineHeight: '1.4', fontWeight: '600', margin: '20px 0 12px', color },
      button: { fontFamily, letterSpacing, fontSize: '15px', backgroundColor: '#181818', color: '#ffffff', padding: '12px 20px', borderRadius: '4px' },
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

  async function prepareContent(): Promise<Draft> {
    if (hydrating) throw new Error('Wait for inline images to finish loading before saving.')
    if (uploads.current) throw new Error('Wait for your image to finish loading before continuing.')
    if (sourceRef.current === 'html') {
      if (api.mode !== 'demo' && /<img\b[^>]*\bsrc\s*=\s*["']data:/i.test(preservedHtml.current)) throw new Error('Inline data images cannot be sent. Convert this email to blocks so images can be uploaded as inline attachments.')
      return { html: preservedHtml.current, editor: preservedEditor.current, inlineAttachmentIds: inlineReferences.current.filter(item => preservedHtml.current.includes(`cid:${item.contentId}`)).map(item => item.attachmentId) }
    }
    const instance = editor.current
    if (!instance?.editor) throw new Error('The composer is still loading. Try again in a moment.')
    const preserveOriginal = !changed.current && preservedHtml.current.trim() && (api.mode === 'demo' || (!/<script\b/i.test(preservedHtml.current) && !/<img\b[^>]*\bsrc\s*=\s*["']data:/i.test(preservedHtml.current) && !inlineImageSources(preservedEditor.current?.document ?? {}).length))
    if (isDocumentVisuallyEmpty(instance.editor.state.doc) && (initial.canCompose || !preserveOriginal)) throw new Error('Add some email content before continuing.')
    if (preserveOriginal) return { html: preservedHtml.current, editor: preservedEditor.current }
    // The serializer snapshots JSON before its first await. Lock the editor during export.
    let document = sanitizeEditorDocument(replaceEditorImageSources(instance.getJSON(), resolvedImageSources.current))
    if (new TextEncoder().encode(JSON.stringify({format: 'react-email', version: 1, document})).byteLength > 256 * 1024) throw new Error('The visual document exceeds 256 KiB. Remove an image or shorten the content before saving.')
    const result = await composeReactEmail({ editor: instance.editor })
    // React Email emits JSON-LD metadata, but the public send contract forbids all script tags.
    let html = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    // React Email serializes theme sizes as em relative to 14px. Supply that same
    // base in the delivered HTML, not just the editor, so previews and mail agree.
    html = html.replace(/<body\b[^>]*>/i, tag => /\bstyle="/i.test(tag)
      ? tag.replace(/\bstyle="([^"]*)"/i, (_, styles: string) => `style="${styles};font-size:14px"`)
      : tag.replace(/>$/, ' style="font-size:14px">'))
    const fontBase = new URL('/fonts/', window.location.origin).href
    html = html.replace('</head>', `<style data-opensend-fonts="true">@font-face{font-family:Inter;src:url('${fontBase}inter-variable.woff2') format('woff2');font-style:normal;font-weight:100 900}@font-face{font-family:Inter;src:url('${fontBase}inter-variable-italic.woff2') format('woff2');font-style:italic;font-weight:100 900}</style></head>`)
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
  function prepare(): Promise<Draft> {
    if (!preparing.current) preparing.current = prepareContent().finally(() => {preparing.current = null})
    return preparing.current
  }
  useImperativeHandle(ref, () => ({ prepare }))

  function openVisual() {
    if (locked || sourceRef.current !== 'html') return
    const imported = prepareEditorContent(preservedHtml.current)
    setContent(imported.content)
    setGeneration(value => value + 1)
    changed.current = false
    preservedEditor.current = null
    sourceRef.current = 'compose'
    setSource('compose')
    setReady(false)
    setError('')
    setConvert(false)
  }
  const upload = useCallback(async (file: File) => {
    uploads.current += 1
    setBusy(true)
    try { return await prepareLocalImage(file) }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Could not load this image.'; setError(message); throw new Error(message) }
    finally { uploads.current -= 1; if (!uploads.current) setBusy(false) }
  }, [])
  async function insertImage(file?: File) {
    if (!file || locked || sourceRef.current !== 'compose') return
    setBusy(true)
    setError('')
    try {
      const { url } = await upload(file)
      command(e => e.chain().focus().insertContent({ type: 'image', attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, ''), width: '100%' } }).run(), true, true)
    } catch { /* Shown inline by the upload callback. */ }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  // Opening the Insert menu blurs the editor, which resets its selection to the document
  // start. Remember the caret while focused so menu insertions land where the user was.
  const caret = useRef<{ from: number; to: number; node: boolean } | null>(null)
  function trackCaret(instance: EmailEditorRef) {
    caret.current = null
    instance.editor?.on('transaction', ({ editor: value }) => {
      if (!value.isFocused) return
      const selection = value.state.selection
      caret.current = { from: selection.from, to: selection.to, node: selection.toJSON().type === 'node' }
    })
  }
  // The menu returns focus to its trigger in a queued task after closing; run the
  // insertion after that so the caret lands in the new block instead of on the button.
  function insertFromMenu(run: (value: NonNullable<EmailEditorRef['editor']>) => void) {
    setTimeout(() => setTimeout(() => command(run, true, true), 0), 0)
  }
  function command(run: (value: NonNullable<EmailEditorRef['editor']>) => void, insert = false, restoreCaret = false) {
    if (locked || sourceRef.current !== 'compose' || !ready || !editor.current?.editor) return
    const instance = editor.current.editor
    if (restoreCaret && caret.current && !instance.isFocused) {
      try { if (caret.current.node) instance.commands.setNodeSelection(caret.current.from); else instance.commands.focus(caret.current.to) }
      catch { /* The remembered position no longer exists; insert at the current selection. */ }
    }
    const selection = instance.state.selection
    // Insert after selected media instead of replacing it with the new block.
    if (insert && selection.toJSON().type === 'node') {
      const after = selection.to
      instance.view.focus()
      instance.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).run()
    }
    run(instance)
  }
  return <div className="email-composer" data-inactive={locked || source !== 'compose' || undefined} onClickCapture={event => { if (locked) { event.preventDefault(); event.stopPropagation() } }} onKeyDownCapture={event => {
    if (event.key === 'Escape' && (event.target as Element).closest(linkForms)) {
      event.preventDefault()
      event.stopPropagation()
      const trigger = (event.target as Element).closest('[data-re-link-selector]')?.querySelector<HTMLButtonElement>('[data-re-link-selector-trigger]')
      // These library forms stop bubbling before their own window Escape listener can run.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); else editor.current?.editor?.commands.focus() })
    } else if (locked) { event.preventDefault(); event.stopPropagation() }
  }}>
    <div className="composer-toolbar">
      <div className="composer-tools" aria-label="Email formatting" onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
        <DropdownMenu trigger={<Button size="sm" variant="ghost" disabled={locked || source !== 'compose' || !ready}><Plus size={16} />Insert<ChevronDown size={14} /></Button>} items={[
          { label: 'Text', icon: <Type size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setParagraph().run()) },
          { label: 'Heading', icon: <Heading2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHeading({ level: 2 }).run()) },
          { label: 'Button', icon: <MousePointer2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setButton().run()) },
          { label: 'Image', icon: <ImagePlus size={16} />, onSelect: () => fileInput.current?.click() },
          { label: 'Bullet list', icon: <List size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().toggleBulletList().run()) },
          { label: 'Divider', icon: <Minus size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHorizontalRule().run()) },
          { label: 'Two columns', icon: <Columns2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().insertColumns(2).run()) },
        ]} />
        <div className="cluster"><IconButton size="sm" label="Bold" disabled={locked || source !== 'compose' || !ready} onClick={() => command(e => e.chain().focus().toggleBold().run())}><Bold size={16} /></IconButton><IconButton size="sm" label="Italic" disabled={locked || source !== 'compose' || !ready} onClick={() => command(e => e.chain().focus().toggleItalic().run())}><Italic size={16} /></IconButton></div>
        {busy && <span className="muted" role="status">Preparing…</span>}
        <div className="cluster composer-history"><IconButton size="sm" label="Undo" disabled={locked || source !== 'compose' || !ready} onClick={() => command(e => e.chain().focus().undo().run())}><Undo2 size={16} /></IconButton><IconButton size="sm" label="Redo" disabled={locked || source !== 'compose' || !ready} onClick={() => command(e => e.chain().focus().redo().run())}><Redo2 size={16} /></IconButton></div>
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void insertImage(event.target.files?.[0])} />
      </div>
    </div>
    {source === 'html' && <Alert tone="info"><div className="composer-conversion"><span>This email uses custom HTML. Convert it to edit in the composer.</span><Button size="sm" disabled={locked} onClick={() => setConvert(true)}>Convert to blocks</Button></div></Alert>}
    {error && <Alert tone="danger">{error}</Alert>}
    <div hidden={source !== 'compose'} className="composer-visual">
      <div className="composer-canvas" onClickCapture={event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault() }}>
        {!ready && <div className="composer-starting" role="status"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><span className="sr-only">Loading visual composer</span></div>}
        <EmailEditor key={generation} ref={editor} content={content} theme={theme} editable={!locked && source === 'compose'} placeholder="Write your email, or type / to insert a block…" onUploadImage={upload} className="composer-document" onReady={instance => { synchronizeEditor(instance); trackCaret(instance); setReady(!hydrating); if (!hydrating) onReady() }} onUpdate={() => { changed.current = true; onDirty() }} />
      </div>
    </div>
    <ConfirmDialog open={convert} onOpenChange={setConvert} title="Convert HTML to visual blocks?" description="Custom HTML and styles may not convert exactly. The original HTML is kept until you edit the blocks." confirmLabel="Convert to blocks" onConfirm={openVisual} />
  </div>
})
