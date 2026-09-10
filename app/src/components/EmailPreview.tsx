import { useEffect, useMemo, useState } from 'react';
import type { AttachmentApi } from '../data/types';
import { useApi } from '../data/context';
import { cidImageSources, isRasterDataUrl, loadInlineAttachments } from '../features/campaigns/composer-content';
import DOMPurify from 'dompurify';

export function htmlToText(html: string): string {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script'] });
  const email = new DOMParser().parseFromString(clean, 'text/html');
  email.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  email.querySelectorAll('p, div, h1, h2, h3, h4, li, tr, blockquote').forEach(node => node.append('\n'));
  return (email.body.textContent ?? '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export type EmailPreviewProps = { html: string; title?: string; className?: string; attachmentIds?: string[]; attachmentApi?: AttachmentApi; respectStyles?: boolean; remoteImages?: boolean };
export function EmailPreview({ html, title = 'Email preview', className, attachmentIds = [], attachmentApi: providedAttachmentApi, respectStyles = false, remoteImages = false }: EmailPreviewProps) {
  const api = useApi();
  const attachmentApi = providedAttachmentApi ?? api.attachments;
  const attachmentKey = [...new Set(attachmentIds)].sort().join('\0');
  const [resolved, setResolved] = useState<{html: string; attachmentKey: string; api: AttachmentApi | undefined; sources: Map<string, string>} | null>(null);
  const [error, setError] = useState('');
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all(['/fonts/inter-variable.woff2', '/fonts/inter-variable-italic.woff2'].map(async path => {
      const response = await fetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error('Font unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `data:font/woff2;base64,${btoa(binary)}`;
    })).then(sources => { if (!controller.signal.aborted) setFonts(sources); }).catch(() => { /* Use the font stack's fallback if local fonts are unavailable. */ });
    return () => controller.abort();
  }, []);
  const needed = useMemo(() => cidImageSources(html), [html]);
  useEffect(() => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    setError('');
    loadInlineAttachments(attachmentApi, attachmentKey ? attachmentKey.split('\0') : [], needed, controller.signal).then(result => {
      if (controller.signal.aborted) { result.release(); return; }
      release = result.release;
      setResolved({html, attachmentKey, api: attachmentApi, sources: result.sources});
      if (result.sources.size < needed.size) setError('Some inline images could not be resolved from this message’s attachments.');
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inline image preview is unavailable.'); });
    return () => {controller.abort(); release?.();};
  }, [html, attachmentKey, attachmentApi, needed]);
  const sources = resolved?.html === html && resolved.attachmentKey === attachmentKey && resolved.api === attachmentApi ? resolved.sources : undefined;
  const srcDoc = useMemo(() => {
    // Authenticated, validated raster data is assigned from the attachment map
    // after DOMPurify; the opaque sandbox never needs access to parent Blob URLs.
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      USE_PROFILES: { html: true },
      ADD_TAGS: ['style'],
      ALLOWED_URI_REGEXP: remoteImages ? /^(?:https:\/\/[^\s"'<>]+$|cid:[a-zA-Z0-9_.@-]{1,120}$|data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$)/i : /^(?:cid:[a-zA-Z0-9_.@-]{1,120}$|data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$)/i,
      FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'link', 'base', 'meta'],
      FORBID_ATTR: ['href', 'srcset', 'ping', 'action', 'formaction', 'target', 'download', 'autofocus', 'xlink:href', 'background'],
    });
    const email = new DOMParser().parseFromString(clean, 'text/html');
    email.querySelectorAll('style[data-opensend-fonts]').forEach(style => style.remove());
    email.querySelectorAll('[src]').forEach(element => {
      const source = element.getAttribute('src') ?? '';
      const owned = element.tagName === 'IMG' ? sources?.get(source) : undefined;
      if (owned) element.setAttribute('src', owned);
      else if (element.tagName !== 'IMG' || !(isRasterDataUrl(source) || (remoteImages && /^https:\/\//i.test(source)))) element.removeAttribute('src');
    });
    const csp = email.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https:' : ''}; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'`;
    email.head.prepend(csp);
    const tokens = getComputedStyle(document.documentElement);
    const style = email.createElement('style');
    // Reuse the browser's cached font files without opening network access inside the sandbox.
    const fontFaces = fonts.map((source, index) => `@font-face { font-family: 'Inter'; src: url('${source}') format('woff2'); font-style: ${index === 0 ? 'normal' : 'italic'}; font-weight: 100 900; font-display: swap; }`).join(' ');
    style.textContent = `${fontFaces} :root { --font-email: ${tokens.getPropertyValue('--font-email')}; --tracking-email: ${tokens.getPropertyValue('--tracking-email')}; --color-text: ${tokens.getPropertyValue('--color-email-text')}; --color-surface: ${tokens.getPropertyValue('--color-email-surface')}; } :where(html) { color-scheme: light; background: var(--color-surface); color: var(--color-text); } :where(body) { margin: 24px; line-height: 1.5; overflow-wrap: anywhere; font-family: var(--font-email); letter-spacing: var(--tracking-email); } ${respectStyles ? '' : 'body, body * { font-family: var(--font-email) !important; letter-spacing: var(--tracking-email) !important; }'} :where(img) { max-width: 100%; height: auto; }`;
    email.head.append(style);
    return `<!doctype html>${email.documentElement.outerHTML}`;
  }, [html, sources, fonts, respectStyles, remoteImages]);
  return <>{error && <p className="ui-field__error" role="alert">{error}</p>}<iframe title={title} className={['ui-email-preview', className].filter(Boolean).join(' ')} srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" /></>;
}
export default EmailPreview;
