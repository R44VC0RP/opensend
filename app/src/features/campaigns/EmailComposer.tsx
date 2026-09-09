import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EmailEditor, type EmailEditorRef } from '@react-email/editor'
import type {} from '@react-email/editor/extensions'
import { defaultSlashCommands } from '@react-email/editor/ui'
import { Bold, ChevronDown, Columns2, Heading2, ImagePlus, Italic, List, Minus, MousePointer2, Paperclip, Plus, Redo2, Type, Undo2 } from 'lucide-react'
import { Alert, Button, DropdownMenu, IconButton, SkeletonText } from '../../components/ui'
import { useApi } from '../../data/context'
import type { Attachment } from '../../data/types'
import { prepareLocalImage, inlineImageSources, inlineImageHash, replaceEditorImageSources, loadInlineAttachments, cidImageSources } from './composer-content'
import { blockHtmlToDocument, documentToBlockHtml, isBlockDocumentEmpty, type EditorNode } from './block-content'
import '@react-email/editor/themes/default.css'
import './composer.css'

// The composer edits block HTML: the same document agents read and write through the
// API. Opening converts block HTML to editor blocks; saving converts blocks back.
type Draft = { html: string; inlineAttachmentIds?: string[] }
export type EmailComposerRef = { prepare: () => Promise<Draft> }
type Props = { attachmentIds?: string[]; initialHtml: string; disabled?: boolean; onReady: () => void; onDirty: () => void; onAttach?: () => void; onBusy?: (busy: boolean) => void }
const linkForms = '[data-re-link-selector-form], [data-re-link-bm-form], [data-re-btn-bm-form], [data-re-img-bm-form]'

// The library's slash menu reads this shared list and has no image entry, although the
// editor supports images. Route "/image" to the mounted composer's file picker.
let pickImage: (() => void) | null = null
if (!defaultSlashCommands.some(item => item.title === 'Image')) {
  const divider = defaultSlashCommands.findIndex(item => item.title === 'Divider')
  defaultSlashCommands.splice(divider < 0 ? defaultSlashCommands.length : divider, 0, {
    title: 'Image', description: 'Upload an image', icon: <ImagePlus size={20} />, category: 'Media', searchTerms: ['img', 'picture', 'photo', 'upload'],
    command: ({ editor: value, range }) => { value.chain().focus().deleteRange(range).run(); pickImage?.() },
  })
}
// Sections are not part of the block vocabulary; keep the slash menu to blocks that save.
const section = defaultSlashCommands.findIndex(item => item.title === 'Section')
if (section >= 0) defaultSlashCommands.splice(section, 1)

export const EmailComposer = forwardRef<EmailComposerRef, Props>(function EmailComposer({ attachmentIds = [], initialHtml, disabled = false, onReady, onDirty, onAttach, onBusy }, ref) {
  const api = useApi()
  const preparing = useRef<Promise<Draft> | null>(null)
  const [initialSnapshot] = useState(() => ({ html: initialHtml, attachmentIds: [...attachmentIds] }))
  // Inline attachments open as data URLs and save back as their cid references.
  const cidBySource = useRef(new Map<string, string>())
  // Uploads must survive a failed prepare/save before their IDs reach attachmentIds.
  const uploadedInline = useRef(new Map<string, Attachment>())
  const [hydrating, setHydrating] = useState(cidImageSources(initialHtml).size > 0)
  const [content, setContent] = useState<EditorNode>(() => blockHtmlToDocument(initialHtml))
  const [generation, setGeneration] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyListener = useRef(onBusy)
  busyListener.current = onBusy
  const [error, setError] = useState('')
  const editor = useRef<EmailEditorRef>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const changed = useRef(false)
  const uploads = useRef(0)
  const locked = disabled || busy || hydrating
  const [theme] = useState(() => {
    const tokens = getComputedStyle(document.documentElement)
    const fontFamily = tokens.getPropertyValue('--font-email').trim()
    const letterSpacing = tokens.getPropertyValue('--tracking-email').trim()
    const color = tokens.getPropertyValue('--color-email-text').trim()
    const backgroundColor = tokens.getPropertyValue('--color-email-surface').trim()
    // Mirrors the server renderer (api/src/campaign-blocks.ts) so the canvas matches delivered mail.
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
    value.setEditable(!locked, false)
    value.setOptions({ editorProps: {
      ...value.options.editorProps,
      attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        if (locked) return true
        if (event.clipboardData?.files.length) return false
        const html = event.clipboardData?.getData('text/html')
        if (!html) return false
        event.preventDefault()
        // Pasted HTML enters through the same lenient block import as API content.
        value.commands.insertContent(blockHtmlToDocument(html).content ?? [])
        return true
      },
    } })
  }
  // Run after child option reconciliation so the name and paste boundary remain installed.
  useEffect(() => { if (editor.current) synchronizeEditor(editor.current) })
  useEffect(() => {
    pickImage = () => { if (!locked) { onDirty(); fileInput.current?.click() } }
    return () => { pickImage = null }
  })

  useEffect(() => {
    const needed = cidImageSources(initialSnapshot.html)
    if (!needed.size) return
    const controller = new AbortController()
    let release: (() => void) | undefined
    setHydrating(true)
    loadInlineAttachments(api, initialSnapshot.attachmentIds, needed, controller.signal).then(result => {
      if (controller.signal.aborted) { result.release(); return }
      release = result.release
      cidBySource.current = new Map([...result.sources].map(([cid, url]) => [url, cid]))
      setContent(replaceEditorImageSources(blockHtmlToDocument(initialSnapshot.html), result.sources) as EditorNode)
      setHydrating(false); setReady(false); setGeneration(value => value + 1)
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Inline images could not be loaded.'); setHydrating(false); setGeneration(value => value + 1) } })
    return () => { controller.abort(); release?.() }
  }, [api, initialSnapshot])

  async function prepareContent(): Promise<Draft> {
    if (hydrating) throw new Error('Wait for inline images to finish loading before saving.')
    if (uploads.current) throw new Error('Wait for your image to finish loading before continuing.')
    const instance = editor.current
    if (!instance?.editor) throw new Error('The composer is still loading. Try again in a moment.')
    let document = instance.getJSON() as EditorNode
    if (isBlockDocumentEmpty(document)) return { html: '', inlineAttachmentIds: [] }
    const currentInline: string[] = []
    if (api.attachments) {
      const allIds = new Set(attachmentIds)
      const metadata = await Promise.all([...allIds].map(id => api.attachments!.get(id)))
      const inlineSources = inlineImageSources(document as Record<string, unknown>)
      for (const source of inlineSources) {
        const cached = uploadedInline.current.get(source)
        if (cached && !allIds.has(cached.id)) { metadata.push(cached); allIds.add(cached.id) }
      }
      let totalSize = metadata.reduce((total, item) => total + item.size, 0)
      if (allIds.size > 20 || totalSize > 8 * 1024 * 1024) throw new Error('Use at most 20 attachments with a combined size of 8 MiB.')
      const sources = new Map<string, string>()
      for (const source of inlineSources) {
        let cid = cidBySource.current.get(source)
        if (!cid) {
          const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,(.+)$/i.exec(source)
          if (!match) throw new Error('Unsupported inline image format.')
          const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
          if (allIds.size >= 20 || totalSize + bytes.length > 8 * 1024 * 1024) throw new Error('Use at most 20 attachments with a combined size of 8 MiB.')
          const hash = await inlineImageHash(source)
          const contentId = `opensend-${crypto.randomUUID()}`
          const extension = match[1].split('/')[1] === 'jpeg' ? 'jpg' : match[1].split('/')[1]
          const item = await api.attachments.upload(new File([bytes], `image-${hash.slice(0, 12)}.${extension}`, { type: match[1] }), { contentId })
          cid = `cid:${contentId}`
          cidBySource.current.set(source, cid); uploadedInline.current.set(source, item); allIds.add(item.id); totalSize += item.size
          currentInline.push(item.id)
        } else {
          const owner = metadata.find(item => item.contentId && `cid:${item.contentId}` === cid)
          if (owner) currentInline.push(owner.id)
        }
        sources.set(source, cid)
      }
      document = replaceEditorImageSources(document as Record<string, unknown>, sources) as EditorNode
    } else if (api.mode !== 'demo' && inlineImageSources(document as Record<string, unknown>).length) throw new Error('Inline images cannot be saved without attachment support.')
    const html = documentToBlockHtml(document)
    if (html.length > 500_000) throw new Error('This email is too large. Remove an image or shorten the content before saving.')
    return { html, inlineAttachmentIds: currentInline }
  }
  function prepare(): Promise<Draft> {
    if (!preparing.current) preparing.current = prepareContent().finally(() => { preparing.current = null })
    return preparing.current
  }
  useImperativeHandle(ref, () => ({ prepare }))

  const upload = useCallback(async (file: File) => {
    uploads.current += 1
    setBusy(true)
    busyListener.current?.(true)
    try { return await prepareLocalImage(file) }
    catch (cause) { const message = cause instanceof Error ? cause.message : 'Could not load this image.'; setError(message); throw new Error(message) }
    finally { uploads.current -= 1; if (!uploads.current) { setBusy(false); busyListener.current?.(false) } }
  }, [])
  async function insertImage(file?: File) {
    if (!file || locked) return
    setBusy(true)
    setError('')
    try {
      const { url } = await upload(file)
      command(e => e.chain().focus().insertContent({ type: 'image', attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, ''), width: '100%', alignment: 'left' } }).run(), true, true)
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
    if (locked || !ready || !editor.current?.editor) return
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
  const inactive = locked || !ready
  return <div className="email-composer" data-inactive={locked || undefined} onClickCapture={event => { if (locked) { event.preventDefault(); event.stopPropagation() } }} onKeyDownCapture={event => {
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
        <DropdownMenu trigger={<Button size="sm" variant="ghost" disabled={inactive}><Plus size={16} />Insert<ChevronDown size={14} /></Button>} items={[
          { label: 'Text', icon: <Type size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setParagraph().run()) },
          { label: 'Heading', icon: <Heading2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHeading({ level: 2 }).run()) },
          { label: 'Button', icon: <MousePointer2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setButton().run()) },
          { label: 'Image', icon: <ImagePlus size={16} />, onSelect: () => { onDirty(); fileInput.current?.click() } },
          { label: 'Attachment', icon: <Paperclip size={16} />, disabled: !onAttach, onSelect: () => onAttach?.() },
          { label: 'Bullet list', icon: <List size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().toggleBulletList().run()) },
          { label: 'Divider', icon: <Minus size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHorizontalRule().run()) },
          { label: 'Two columns', icon: <Columns2 size={16} />, onSelect: () => insertFromMenu(e => e.chain().focus().insertColumns(2).run()) },
        ]} />
        <div className="cluster"><IconButton size="sm" label="Bold" disabled={inactive} onClick={() => command(e => e.chain().focus().toggleBold().run())}><Bold size={16} /></IconButton><IconButton size="sm" label="Italic" disabled={inactive} onClick={() => command(e => e.chain().focus().toggleItalic().run())}><Italic size={16} /></IconButton></div>
        {busy && <span className="muted" role="status">Preparing…</span>}
        <div className="cluster composer-history"><IconButton size="sm" label="Undo" disabled={inactive} onClick={() => command(e => e.chain().focus().undo().run())}><Undo2 size={16} /></IconButton><IconButton size="sm" label="Redo" disabled={inactive} onClick={() => command(e => e.chain().focus().redo().run())}><Redo2 size={16} /></IconButton></div>
        <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/webp,image/avif" onChange={event => void insertImage(event.target.files?.[0])} />
      </div>
    </div>
    {error && <Alert tone="danger">{error}</Alert>}
    <div className="composer-visual">
      <div className="composer-canvas" onClickCapture={event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault() }}>
        {!ready && <div className="composer-starting" role="status"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><span className="sr-only">Loading visual composer</span></div>}
        <EmailEditor key={generation} ref={editor} content={content as Record<string, unknown>} theme={theme} editable={!locked} placeholder="Write your email, or type / to insert a block…" onUploadImage={upload} className="composer-document" onReady={instance => { synchronizeEditor(instance); trackCaret(instance); setReady(!hydrating); if (!hydrating) onReady() }} onUpdate={() => { changed.current = true; onDirty() }} />
      </div>
    </div>
  </div>
})
