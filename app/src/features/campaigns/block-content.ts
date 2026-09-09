// Block HTML is the campaign content contract shared with the API and agents (see the
// API's campaign content guide). The composer opens it as blocks and writes it back in
// the same vocabulary. Import is lenient so drafts written before the vocabulary or
// pasted from elsewhere still open; export is strict so saved content always validates.
import { isRasterDataUrl } from './composer-content'

export type EditorNode = { type: string; attrs?: Record<string, unknown>; content?: EditorNode[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }
type Mark = NonNullable<EditorNode['marks']>[number]

const ALIGNMENTS = new Set(['left', 'center', 'right'])
const HEADING_LEVELS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 3, H5: 3, H6: 3 }
const COLUMN_TYPES: Record<number, string> = { 2: 'twoColumns', 3: 'threeColumns', 4: 'fourColumns' }
const safeHref = (value: string | null) => value != null && /^(?:https?:\/\/|mailto:|tel:|\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}|#$)/i.test(value.trim()) && !/[\u0000-\u0020\u007f\\]/.test(value.trim()) ? value.trim() : null
export const safeImageSource = (value: string | null) => value != null && (/^https:\/\/[^\s"'<>]+$/.test(value.trim()) || /^cid:[a-zA-Z0-9_.@-]{1,120}$/.test(value.trim()) || isRasterDataUrl(value.trim())) ? value.trim() : null
const dimension = (value: string | null) => value && /^(?:[1-9][0-9]{0,3}|[1-9][0-9]?%|100%)$/.test(value.trim()) ? value.trim() : null

function alignmentOf(element: Element): string | null {
  const explicit = element.getAttribute('align') ?? element.getAttribute('alignment') ?? (element as HTMLElement).style?.textAlign
  return explicit && ALIGNMENTS.has(explicit) ? explicit : null
}
const withAlignment = (attrs: Record<string, unknown>, element: Element) => { const alignment = alignmentOf(element); return alignment ? { ...attrs, alignment } : attrs }

// ----- Import: block HTML (or legacy HTML) -> editor document -----------------------

function inlineNodes(parent: Node, marks: Mark[], inButton: boolean): EditorNode[] {
  const nodes: EditorNode[] = []
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\s+/g, ' ')
      if (text) nodes.push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    const tag = element.tagName
    if (tag === 'BR') { nodes.push({ type: 'hardBreak' }); continue }
    if (tag === 'IMG') continue // Images are blocks; an inline image is lifted by the caller.
    let next = marks
    const add = (mark: Mark) => { if (!marks.some(item => item.type === mark.type)) next = [...marks, mark] }
    if (tag === 'STRONG' || tag === 'B') add({ type: 'bold' })
    else if (tag === 'EM' || tag === 'I') add({ type: 'italic' })
    else if (tag === 'U') add({ type: 'underline' })
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') add({ type: 'strike' })
    else if (tag === 'CODE') add({ type: 'code' })
    else if (tag === 'SUP') add({ type: 'sup' })
    else if (tag === 'SPAN' && /text-transform\s*:\s*uppercase/i.test(element.getAttribute('style') ?? '')) add({ type: 'uppercase' })
    else if (tag === 'A' && !inButton) {
      const href = safeHref(element.getAttribute('href'))
      if (href) { const target = element.getAttribute('target'); add({ type: 'link', attrs: { href, target: target === '_blank' ? '_blank' : null, rel: target === '_blank' ? 'noopener noreferrer' : null } }) }
    }
    nodes.push(...inlineNodes(element, next, inButton))
  }
  return nodes
}
const paragraph = (element: Element, attrs: Record<string, unknown> = {}): EditorNode => ({ type: 'paragraph', attrs: withAlignment(attrs, element), content: inlineNodes(element, [], false) })
const emptyParagraph = (): EditorNode => ({ type: 'paragraph' })

function listNode(element: Element): EditorNode {
  const ordered = element.tagName === 'OL'
  const items: EditorNode[] = []
  for (const child of Array.from(element.children)) {
    if (child.tagName !== 'LI') continue
    const nested: EditorNode[] = []
    const holder = document.createElement('li')
    for (const part of Array.from(child.childNodes)) {
      if (part.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes((part as Element).tagName)) nested.push(listNode(part as Element))
      else if (part.nodeType === Node.ELEMENT_NODE && (part as Element).tagName === 'P') holder.append(...Array.from(part.childNodes))
      else holder.append(part.cloneNode(true))
    }
    const text = paragraph(holder)
    items.push({ type: 'listItem', content: [text.content?.length ? text : emptyParagraph(), ...nested] })
  }
  const start = Number(element.getAttribute('start'))
  return { type: ordered ? 'orderedList' : 'bulletList', ...(ordered && start > 1 ? { attrs: { start } } : {}), content: items.length ? items : [{ type: 'listItem', content: [emptyParagraph()] }] }
}
function imageNode(element: Element, link?: Element): EditorNode | null {
  const src = safeImageSource(element.getAttribute('src'))
  if (!src) return null
  const width = dimension(element.getAttribute('width')), height = dimension(element.getAttribute('height'))
  return { type: 'image', attrs: { src, alt: element.getAttribute('alt') ?? '', width: width ?? 'auto', height: height ?? 'auto', alignment: alignmentOf(element) ?? 'left', href: link ? safeHref(link.getAttribute('href')) : null } }
}
function blockNodes(parent: Node, inColumn: boolean): EditorNode[] {
  const nodes: EditorNode[] = []
  let pending: Element | null = null // Accumulates loose inline content into a paragraph.
  const flush = () => { if (pending) { const text = paragraph(pending); if (text.content?.length) nodes.push(text); pending = null } }
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) { if ((child.textContent ?? '').trim()) { pending ??= document.createElement('p'); pending.append(child.cloneNode(true)) } continue }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    const tag = element.tagName
    if (tag in HEADING_LEVELS) { flush(); nodes.push({ type: 'heading', attrs: withAlignment({ level: HEADING_LEVELS[tag] }, element), content: inlineNodes(element, [], false) }); continue }
    if (tag === 'P') {
      flush()
      const images = Array.from(element.querySelectorAll('img'))
      const text = paragraph(element)
      if (text.content?.length || !images.length) nodes.push(text)
      for (const image of images) { const node = imageNode(image, image.closest('a') ?? undefined); if (node) nodes.push(node) }
      continue
    }
    if (tag === 'UL' || tag === 'OL') { flush(); nodes.push(listNode(element)); continue }
    if (tag === 'BLOCKQUOTE') {
      flush()
      const inner = blockNodes(element, inColumn).filter(node => node.type === 'paragraph')
      nodes.push({ type: 'blockquote', content: inner.length ? inner : [paragraph(element)] })
      continue
    }
    if (tag === 'PRE') { flush(); const text = element.textContent ?? ''; nodes.push({ type: 'codeBlock', attrs: { language: null }, content: text ? [{ type: 'text', text }] : [] }); continue }
    if (tag === 'HR') { flush(); nodes.push({ type: 'horizontalRule' }); continue }
    if (tag === 'IMG') { flush(); const node = imageNode(element); if (node) nodes.push(node); continue }
    if (tag === 'A') {
      const image = element.children.length === 1 && element.children[0].tagName === 'IMG' ? element.children[0] : null
      if (image) { flush(); const node = imageNode(image, element); if (node) nodes.push(node); continue }
      const href = safeHref(element.getAttribute('href'))
      const isButton = element.hasAttribute('data-button') || element.getAttribute('data-id') === 'react-email-button' || /\bbutton\b/.test(element.getAttribute('class') ?? '')
      if (isButton && href) { flush(); nodes.push({ type: 'button', attrs: { href, alignment: alignmentOf(element) ?? 'left' }, content: inlineNodes(element, [], true).map(node => node.type === 'text' ? { ...node, marks: node.marks?.filter(mark => mark.type === 'bold') } : node) }); continue }
      pending ??= document.createElement('p'); pending.append(element.cloneNode(true)); continue
    }
    if (tag === 'DIV' && element.hasAttribute('data-columns') && !inColumn) {
      flush()
      const columns = Array.from(element.children).filter(column => column.hasAttribute('data-column'))
      const type = COLUMN_TYPES[columns.length]
      if (type) { nodes.push({ type, content: columns.map(column => { const inner = blockNodes(column, true); return { type: 'columnsColumn', content: inner.length ? inner : [emptyParagraph()] } }) }); continue }
    }
    if (['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) continue
    // Inline content directly inside a container becomes a paragraph; other containers (legacy div/table/section) unwrap.
    if (['STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'CODE', 'SUP', 'SPAN', 'BR', 'FONT', 'SMALL', 'LABEL'].includes(tag)) { pending ??= document.createElement('p'); pending.append(element.cloneNode(true)); continue }
    flush()
    nodes.push(...blockNodes(element, inColumn))
  }
  flush()
  return nodes
}

export function blockHtmlToDocument(html: string): EditorNode {
  const template = document.createElement('template')
  template.innerHTML = html
  const content = blockNodes(template.content, false)
  return { type: 'doc', content: content.length ? content : [emptyParagraph()] }
}

// ----- Export: editor document -> block HTML ----------------------------------------

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const alignAttr = (attrs: Record<string, unknown> | undefined) => typeof attrs?.alignment === 'string' && ALIGNMENTS.has(attrs.alignment) && attrs.alignment !== 'left' ? ` align="${attrs.alignment}"` : ''
const MARK_TAGS: Record<string, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', code: 'code', sup: 'sup' }
const MARK_ORDER = ['link', 'bold', 'italic', 'underline', 'strike', 'code', 'sup', 'uppercase']

function exportInline(node: EditorNode, inButton: boolean): string {
  if (node.type === 'hardBreak') return '<br>'
  if (node.type !== 'text') return node.content?.map(child => exportInline(child, inButton)).join('') ?? ''
  let html = escape(node.text ?? '')
  const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(b.type) - MARK_ORDER.indexOf(a.type))
  for (const mark of marks) {
    if (mark.type === 'link' && !inButton) {
      const href = safeHref(typeof mark.attrs?.href === 'string' ? mark.attrs.href : null)
      if (href) html = `<a href="${escape(href)}"${mark.attrs?.target === '_blank' ? ' target="_blank"' : ''}>${html}</a>`
    } else if (mark.type === 'uppercase') html = `<span style="text-transform:uppercase">${html}</span>`
    else if (MARK_TAGS[mark.type] && !(inButton && mark.type !== 'bold')) html = `<${MARK_TAGS[mark.type]}>${html}</${MARK_TAGS[mark.type]}>`
  }
  return html
}
const exportInlineContent = (node: EditorNode, inButton = false) => (node.content ?? []).map(child => exportInline(child, inButton)).join('')

function exportList(node: EditorNode): string {
  const tag = node.type === 'orderedList' ? 'ol' : 'ul'
  const start = Number(node.attrs?.start)
  const items = (node.content ?? []).filter(item => item.type === 'listItem').map(item => {
    const parts = (item.content ?? []).map(child => {
      if (child.type === 'paragraph') return exportInlineContent(child)
      if (child.type === 'bulletList' || child.type === 'orderedList') return exportList(child)
      return exportBlock(child, true)
    })
    return `<li>${parts.join('')}</li>`
  })
  return `<${tag}${tag === 'ol' && start > 1 ? ` start="${start}"` : ''}>${items.join('')}</${tag}>`
}
function exportBlock(node: EditorNode, inColumn: boolean): string {
  switch (node.type) {
    case 'paragraph': return `<p${alignAttr(node.attrs)}>${exportInlineContent(node)}</p>`
    case 'heading': { const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1)); return `<h${level}${alignAttr(node.attrs)}>${exportInlineContent(node)}</h${level}>` }
    case 'bulletList': case 'orderedList': return exportList(node)
    case 'blockquote': return `<blockquote>${(node.content ?? []).map(child => child.type === 'paragraph' ? `<p${alignAttr(child.attrs)}>${exportInlineContent(child)}</p>` : exportBlock(child, inColumn)).join('')}</blockquote>`
    case 'codeBlock': return `<pre><code>${escape((node.content ?? []).map(child => child.text ?? '').join(''))}</code></pre>`
    case 'horizontalRule': return '<hr>'
    case 'hardBreak': return ''
    case 'image': {
      const src = safeImageSource(typeof node.attrs?.src === 'string' ? node.attrs.src : null)
      if (!src) return ''
      const width = dimension(typeof node.attrs?.width === 'string' ? node.attrs.width : null), height = dimension(typeof node.attrs?.height === 'string' ? node.attrs.height : null)
      const image = `<img src="${escape(src)}" alt="${escape(typeof node.attrs?.alt === 'string' ? node.attrs.alt : '')}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}${alignAttr(node.attrs)}>`
      const href = safeHref(typeof node.attrs?.href === 'string' ? node.attrs.href : null)
      return href ? `<a href="${escape(href)}">${image}</a>` : image
    }
    case 'button': {
      const href = safeHref(typeof node.attrs?.href === 'string' ? node.attrs.href : null)
      return href ? `<a data-button href="${escape(href)}"${alignAttr(node.attrs)}>${exportInlineContent(node, true)}</a>` : `<p${alignAttr(node.attrs)}>${exportInlineContent(node)}</p>`
    }
    case 'twoColumns': case 'threeColumns': case 'fourColumns': {
      const columns = (node.content ?? []).filter(child => child.type === 'columnsColumn')
      if (inColumn || !COLUMN_TYPES[columns.length]) return columns.map(column => (column.content ?? []).map(child => exportBlock(child, inColumn)).join('')).join('')
      return `<div data-columns="${columns.length}">${columns.map(column => `<div data-column>${trimTrailingEmpty(column.content ?? []).map(child => exportBlock(child, true)).join('') || '<p></p>'}</div>`).join('')}</div>`
    }
    case 'previewText': case 'globalContent': return ''
    default: {
      // Containers the vocabulary does not have (section, div, table, body) unwrap to their blocks.
      if (node.content?.some(child => child.type === 'text' || child.type === 'hardBreak')) return `<p>${exportInlineContent(node)}</p>`
      return (node.content ?? []).map(child => exportBlock(child, inColumn)).join('')
    }
  }
}

// The editor keeps a trailing empty paragraph for the caret; it is not content.
function trimTrailingEmpty(nodes: EditorNode[]): EditorNode[] {
  const blocks = [...nodes]
  while (blocks.length && blocks[blocks.length - 1].type === 'paragraph' && !blocks[blocks.length - 1].content?.length) blocks.pop()
  return blocks
}
export function documentToBlockHtml(doc: EditorNode): string {
  // The editor wraps content in a container node (and stores theme state in globalContent); unwrap to the blocks.
  const unwrap = (nodes: EditorNode[]): EditorNode[] => nodes.flatMap(node => ['container', 'body', 'section', 'div'].includes(node.type) ? unwrap(node.content ?? []) : node.type === 'globalContent' || node.type === 'previewText' ? [] : [node])
  const blocks = trimTrailingEmpty(unwrap(doc.content ?? []))
  return blocks.map(node => exportBlock(node, false)).join('\n')
}

/** True when the document has no visible text, image, button or divider. */
export function isBlockDocumentEmpty(doc: EditorNode): boolean {
  const pending = [...(doc.content ?? [])]
  while (pending.length) {
    const node = pending.pop()!
    if (node.type === 'text' && node.text?.trim()) return false
    if (['image', 'horizontalRule', 'button', 'codeBlock'].includes(node.type) && (node.type !== 'codeBlock' || node.content?.some(child => child.text?.trim()))) return false
    pending.push(...(node.content ?? []))
  }
  return true
}
