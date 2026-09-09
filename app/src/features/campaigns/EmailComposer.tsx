import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { EmailEditor, type EmailEditorRef } from '@react-email/editor'
import type {} from '@react-email/editor/extensions'
import { composeReactEmail, isDocumentVisuallyEmpty } from '@react-email/editor/core'
import { Bold, ChevronDown, Columns2, Heading2, ImagePlus, Italic, List, Minus, MousePointer2, Plus, Redo2, Type, Undo2 } from 'lucide-react'
import { Alert, Button, ConfirmDialog, DropdownMenu, Field, IconButton, SkeletonText, Tabs, Textarea } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import type { CampaignEditorMetadata } from '../../data/types'
import { prepareEditorContent, prepareLocalImage, sanitizeEditorDocument } from './composer-content'
import '@react-email/editor/themes/default.css'
import './composer.css'

type Draft = { html: string; editor: CampaignEditorMetadata | null }
export type EmailComposerRef = { prepare: () => Promise<Draft> }
type Props = { initialHtml: string; initialEditor?: CampaignEditorMetadata | null; previewText: string; disabled?: boolean; onReady: () => void; onDirty: () => void }
type Mode = 'compose' | 'html' | 'preview'

export const EmailComposer = forwardRef<EmailComposerRef, Props>(function EmailComposer({ initialHtml, initialEditor, previewText, disabled = false, onReady, onDirty }, ref) {
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
  const changed = useRef(Boolean(initialEditor))
  const operation = useRef(false)
  const latestRaw = useRef(initialHtml)
  const preservedHtml = useRef(initialHtml)
  const uploads = useRef(0)
  const sourceRef = useRef(source)
  const locked = disabled || busy
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

  async function prepare(allowEmpty = false): Promise<Draft> {
    if (uploads.current) throw new Error('Wait for your image to finish loading before continuing.')
    if (sourceRef.current === 'html') return { html: latestRaw.current, editor: null }
    const instance = editor.current
    if (!instance?.editor) throw new Error('The composer is still loading. Try again in a moment.')
    if (isDocumentVisuallyEmpty(instance.editor.state.doc)) {
      if (allowEmpty) return { html: '', editor: null }
      throw new Error('Add some email content before continuing.')
    }
    if (!changed.current && preservedHtml.current.trim()) return { html: preservedHtml.current, editor: null }
    // The serializer snapshots JSON before its first await. Lock the editor during export.
    const document = sanitizeEditorDocument(instance.getJSON())
    const result = await composeReactEmail({ editor: instance.editor, preview: previewText || undefined })
    if (result.html.length > 500_000) throw new Error('This email is too large. Remove an image or shorten the content before saving.')
    return { html: result.html, editor: { format: 'react-email', version: 1, document } }
  }
  useImperativeHandle(ref, () => ({ prepare }))

  function openVisual() {
    const imported = prepareEditorContent(latestRaw.current)
    setContent(imported.content)
    setGeneration(value => value + 1)
    changed.current = false
    preservedHtml.current = latestRaw.current
    sourceRef.current = 'compose'
    setSource('compose')
    setReady(false)
    setMode('compose')
    setConvert(false)
  }
  async function selectMode(next: string) {
    if (locked || operation.current || next === mode) return
    setError('')
    if (next === 'compose') {
      if (sourceRef.current === 'html') {
        if (!prepareEditorContent(latestRaw.current).canCompose) { setConvert(true); return }
        openVisual()
      } else setMode('compose')
      return
    }
    operation.current = true
    setBusy(true)
    try {
      const draft = await prepare(next === 'html')
      if (next === 'html') { latestRaw.current = draft.html; setRaw(draft.html) }
      else setPreview(draft.html)
      setMode(next as Mode)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare this email.') }
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
  return <div className="email-composer">
    <div className="composer-mode-bar"><Tabs value={mode} onValueChange={selectMode} label="Email content mode" items={[{ value: 'compose', label: 'Compose' }, { value: 'html', label: 'HTML' }, { value: 'preview', label: 'Preview' }]} />{busy && <span className="muted" role="status">Preparing…</span>}</div>
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
        <EmailEditor key={generation} ref={editor} content={content} theme={theme} editable={!locked && source === 'compose'} placeholder="Write your newsletter, or type / to insert a block…" onUploadImage={upload} className="composer-document" onReady={instance => { instance.editor?.setOptions({ editorProps: { ...instance.editor.options.editorProps, attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true' }, handlePaste: (_view, event) => { if (event.clipboardData?.files.length) return false; const html = event.clipboardData?.getData('text/html'); if (!html) return false; event.preventDefault(); instance.editor?.commands.insertContent(prepareEditorContent(html).content); return true }, transformPastedHTML: html => String(prepareEditorContent(html).content) } }); setReady(true); onReady() }} onUpdate={() => { changed.current = true; onDirty() }} />
      </div>
    </div>
    {mode === 'html' && <Field label="Email HTML" htmlFor="campaign-html"><Textarea id="campaign-html" className="campaign-html" value={raw} disabled={locked} spellCheck={false} onChange={event => { latestRaw.current = event.target.value; setRaw(event.target.value); sourceRef.current = 'html'; setSource('html'); onDirty() }} /></Field>}
    {mode === 'preview' && <EmailPreview html={preview} title="Campaign email preview" />}
    <ConfirmDialog open={convert} onOpenChange={setConvert} title="Convert HTML to visual blocks?" description="Custom HTML and styles may not convert exactly. Your original HTML is kept until you edit the visual content. Review the preview before saving." confirmLabel="Convert to blocks" onConfirm={openVisual} />
  </div>
})
