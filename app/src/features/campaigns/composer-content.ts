import DOMPurify from 'dompurify'
import type { CampaignEditorMetadata, OpenSendApi } from '../../data/types'

const semanticTags = new Set(['H1', 'H2', 'H3', 'P', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'UL', 'OL', 'LI', 'A', 'BR', 'HR'])
const semanticAttributes = new Set(['href', 'target', 'rel'])
const blockedAttributes = new Set(['__proto__', 'prototype', 'constructor', 'srcset', 'imagesrcset', 'srcdoc', 'poster', 'background', 'action', 'formaction', 'ping', 'xlink:href', 'xmlns', 'innerhtml', 'outerhtml', 'dangerouslysetinnerhtml'])
export function isRasterDataUrl(value: string): boolean {
  const content = value.slice(value.indexOf(',') + 1)
  return content.length % 4 === 0 && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)
}
const unsafeCss = /url\s*\(|expression\s*\(|@import|binding|behavior|(?:image-set|image|paint|var|src)\s*\(|\\|\/\*/i

function safeImageSource(value: unknown): value is string {
  return typeof value === 'string' && ((value.length > value.indexOf(',') + 1 && isRasterDataUrl(value)) || /^cid:[a-zA-Z0-9_.@-]{1,120}$/.test(value))
}

function safeHref(value: unknown): value is string {
  return typeof value === 'string' && !/[\u0000-\u0020\u007f\\]/.test(value) && /^(?:https?:\/\/|mailto:|#)/i.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanJson(value: unknown, depth: number, attributes = false): unknown {
  if (depth > 50) throw new Error('This visual document is too deeply nested to edit in the composer.')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return attributes && unsafeCss.test(value) ? undefined : value
  if (Array.isArray(value)) return value.map(item => cleanJson(item, depth + 1, attributes)).filter(item => item !== undefined)
  if (!isRecord(value)) return undefined
  if (value.type === 'image' && (!isRecord(value.attrs) || !safeImageSource(value.attrs.src))) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase()
    if (name.startsWith('on') || blockedAttributes.has(name)) continue
    if (name === 'src') {
      if (safeImageSource(item)) result[key] = item
      continue
    }
    if (name === 'href') {
      if (safeHref(item)) result[key] = item
      continue
    }
    if (name === 'target') {
      if (item === '_blank' || item === '_self') result[key] = item
      continue
    }
    const cleaned = cleanJson(item, depth + 1, attributes || name === 'attrs' || name === 'style')
    if (cleaned !== undefined) result[key] = cleaned
  }
  if (result.target === '_blank') result.rel = 'noopener noreferrer'
  return result
}

export function sanitizeEditorDocument(document: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(document) || document.type !== 'doc' || (document.content !== undefined && !Array.isArray(document.content))) {
    throw new Error('This visual document is invalid and cannot be edited in the composer.')
  }
  return cleanJson(document, 0) as Record<string, unknown>
}

function isSemanticHtml(html: string): boolean {
  // A template is inert: classification must never request images from custom HTML.
  const template = document.createElement('template')
  template.innerHTML = html
  if (/<\s*(?:!|\/?(?:html|head|body)\b)/i.test(html)) return false
  const pending = Array.from(template.content.childNodes)
  while (pending.length) {
    const node = pending.pop()!
    if (node.nodeType === Node.TEXT_NODE) continue
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    const element = node as Element
    if (!semanticTags.has(element.tagName) || Array.from(element.attributes).some(attribute => !semanticAttributes.has(attribute.name))) return false
    pending.push(...Array.from(element.childNodes))
  }
  return true
}

function sanitizedImportHtml(html: string): string {
  const body = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'form', 'style', 'link', 'input', 'button', 'select', 'option', 'textarea', 'object', 'embed', 'applet', 'base', 'meta', 'video', 'audio', 'source', 'track', 'template', 'noscript'],
    FORBID_ATTR: ['srcset', 'imagesrcset', 'srcdoc', 'poster', 'background', 'action', 'formaction', 'ping'],
    ADD_ATTR: ['target'],
    ALLOW_DATA_ATTR: false,
  }) as HTMLElement
  for (const element of Array.from(body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || blockedAttributes.has(name)
        || (name === 'src' && (element.tagName !== 'IMG' || !safeImageSource(attribute.value)))
        || (name === 'href' && !safeHref(attribute.value))
        || (name === 'style' && unsafeCss.test(attribute.value))
        || (name === 'target' && attribute.value !== '_blank' && attribute.value !== '_self')) {
        element.removeAttribute(attribute.name)
      }
    }
    if (element.getAttribute('target') === '_blank') element.setAttribute('rel', 'noopener noreferrer')
    // Avoid importing an empty image node whose default src could request the app URL.
    if (element.tagName === 'IMG' && !element.hasAttribute('src')) element.remove()
  }
  return body.innerHTML.trim() || '<p></p>'
}

export function prepareEditorContent(html: string, metadata?: CampaignEditorMetadata | null): { content: Record<string, unknown> | string; canCompose: boolean; reason?: string } {
  if (metadata?.format === 'react-email' && metadata.version === 1) {
    try {
      const content = sanitizeEditorDocument(metadata.document)
      if (JSON.stringify(content) !== JSON.stringify(metadata.document)) return {
        content: '<p></p>', canCompose: false,
        reason: 'The composer cannot preserve parts of this document. The original content is kept until you edit converted blocks.',
      }
      return { content, canCompose: true }
    } catch {
      return { content: '<p></p>', canCompose: false, reason: 'The composer cannot open this document. The original content is preserved.' }
    }
  }
  return { content: sanitizedImportHtml(html), canCompose: metadata == null && isSemanticHtml(html) }
}

export async function prepareLocalImage(file: File): Promise<{ url: string }> {
  const supported = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif'])
  if (file.type === 'image/gif') throw new Error('GIF animation cannot be preserved. Choose a PNG, JPEG, WebP, or AVIF image instead.')
  if (!supported.has(file.type)) throw new Error('Choose a PNG, JPEG, WebP, or AVIF image.')
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.')
  if (!file.size) throw new Error('This image is empty. Choose another image.')
  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot optimize images. Try a current browser.')

  let bitmap: ImageBitmap
  try {
    const header = new Uint8Array(await file.slice(0, 32).arrayBuffer())
    const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end))
    if (ascii(0, 3) === 'GIF') throw new Error('unsupported')
    const raster = (header[0] === 0x89 && ascii(1, 4) === 'PNG' && header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10)
      || (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
      || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
      || (ascii(4, 8) === 'ftyp' && ascii(8, 12) === 'avif')
    if (!raster) throw new Error('unsupported')
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This image could not be opened. Export it as a PNG or JPEG and try again.')
  }

  const canvas = document.createElement('canvas')
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('invalid dimensions')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    let scale = Math.min(1, 1200 / bitmap.width, 1200 / bitmap.height)
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of [0.84, 0.68, 0.52, 0.36]) {
        const url = canvas.toDataURL('image/jpeg', quality)
        if (url.startsWith('data:image/jpeg;base64,') && url.length <= 140_000) return { url }
      }
      scale *= 0.72
    }
  } catch {
    throw new Error('This image could not be optimized. Try a smaller PNG or JPEG image.')
  } finally {
    bitmap.close()
    canvas.width = 0
    canvas.height = 0
  }
  throw new Error('This image is still too large for email. Choose a smaller image.')
}

export type InlineImageReference = { attachmentId: string; contentId: string; hash: string }
export function inlineImageReferences(document?: Record<string, unknown>): InlineImageReference[] {
  const value = document?.opensendInlineImages
  if (!Array.isArray(value)) return []
  return value.filter((item): item is InlineImageReference => isRecord(item) && typeof item.attachmentId === 'string' && typeof item.contentId === 'string' && /^[a-zA-Z0-9_.@-]{1,120}$/.test(item.contentId) && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash))
}
export function inlineImageSources(document: Record<string, unknown>): string[] {
  const sources = new Set<string>()
  const pending: unknown[] = [document]
  let count = 0
  while (pending.length && count++ < 20000) {
    const value = pending.pop()
    if (!isRecord(value)) continue
    if (value.type === 'image' && isRecord(value.attrs) && typeof value.attrs.src === 'string' && isRasterDataUrl(value.attrs.src)) sources.add(value.attrs.src)
    if (Array.isArray(value.content)) pending.push(...value.content)
  }
  return [...sources]
}
export async function inlineImageHash(source: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function replaceImageSource(html: string, source: string, replacement: string): string {
  // Only quoted img src attributes are rewritten; never arbitrary text or CSS.
  return html.replace(/<img\b[^>]*>/gi, tag => tag.replace(/(\bsrc\s*=\s*)(["'])(.*?)\2/gi, (attribute, prefix: string, quote: string, value: string) => value === source ? `${prefix}${quote}${replacement}${quote}` : attribute))
}
export async function inlinePreviewHtml(html: string, editor?: CampaignEditorMetadata | null): Promise<string> {
  if (!editor) return html
  const references = inlineImageReferences(editor.document)
  if (!references.length) return html
  const document = sanitizeEditorDocument(editor.document)
  let result = html
  for (const source of inlineImageSources(document)) {
    const hash = await inlineImageHash(source)
    const reference = references.find(item => item.hash === hash)
    if (reference) result = replaceImageSource(result, `cid:${reference.contentId}`, source)
  }
  return result
}

export function replaceEditorImageSources(document: Record<string, unknown>, sources: ReadonlyMap<string, string>): Record<string, unknown> {
  const copy = structuredClone(document)
  const pending: unknown[] = [copy]
  let count = 0
  while (pending.length && count++ < 20000) {
    const value = pending.pop()
    if (!isRecord(value)) continue
    if (value.type === 'image' && isRecord(value.attrs) && typeof value.attrs.src === 'string') {
      const replacement = sources.get(value.attrs.src)
      if (replacement) value.attrs.src = replacement
    }
    if (Array.isArray(value.content)) pending.push(...value.content)
  }
  return copy
}
export function cidImageSources(html: string): Set<string> {
  const ids = new Set<string>()
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const match = /\ssrc\s*=\s*(["'])cid:([a-zA-Z0-9_.@-]{1,120})\1/i.exec(tag)
    if (match) ids.add(match[2])
  }
  return ids
}
const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
function rasterBytesMatch(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if (type === 'image/png') return bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
  return type === 'image/avif' && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))
}
export async function loadInlineAttachments(api: OpenSendApi, attachmentIds: string[], needed: ReadonlySet<string>, signal: AbortSignal): Promise<{sources: Map<string, string>; release: () => void}> {
  const sources = new Map<string, string>()
  const release = () => {} // Data URLs are scoped to the caller's transient preview state; no global URL registration.
  if (!needed.size || !api.attachments) return {sources, release}
  const ids = [...new Set(attachmentIds)]
  if (ids.length > 20) throw new Error('Too many attachments to preview.')
  const metadata = await Promise.all(ids.map(id => api.attachments!.get(id, signal)))
  const inline = metadata.filter(item => item.disposition === 'inline' && item.contentId && needed.has(item.contentId) && rasterTypes.has(item.contentType.toLowerCase()))
  if (inline.reduce((total, item) => total + item.size, 0) > 8 * 1024 * 1024) throw new Error('Inline images exceed the 8 MiB preview limit.')
  try {
    const results = await Promise.allSettled(inline.map(async item => {
      const result = await api.attachments!.content(item.id, signal)
      const type = result.contentType.toLowerCase()
      if (result.id !== item.id || type !== item.contentType.toLowerCase() || !rasterTypes.has(type) || result.content.length > 11184812) throw new Error('Attachment preview metadata does not match.')
      // A repeated four-character regex group over 8 MiB can exhaust the JavaScript engine's stack.
      if (result.content.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.content)) throw new Error('Attachment preview encoding is invalid.')
      const bytes = Uint8Array.from(atob(result.content), character => character.charCodeAt(0))
      if (bytes.length !== item.size || !rasterBytesMatch(bytes, type)) throw new Error('The attachment is not a supported raster image.')
      if (signal.aborted) throw new DOMException('Preview canceled.', 'AbortError')
      sources.set(`cid:${item.contentId}`, `data:${type};base64,${result.content}`)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    return {sources, release}
  } catch (error) {release(); throw error}
}
