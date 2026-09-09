import { useMemo } from 'react';
import DOMPurify from 'dompurify';

export function htmlToText(html: string): string {
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'script'] });
  const email = new DOMParser().parseFromString(clean, 'text/html');
  email.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  email.querySelectorAll('p, div, h1, h2, h3, h4, li, tr, blockquote').forEach(node => node.append('\n'));
  return (email.body.textContent ?? '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export type EmailPreviewProps = { html: string; title?: string; className?: string };
export function EmailPreview({ html, title = 'Email preview', className }: EmailPreviewProps) {
  const srcDoc = useMemo(() => {
    const clean = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ['style'],
      FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'link', 'base', 'meta'],
      FORBID_ATTR: ['href', 'srcset', 'ping', 'action', 'formaction', 'target', 'download', 'autofocus', 'xlink:href', 'background'],
    });
    const email = new DOMParser().parseFromString(clean, 'text/html');
    email.querySelectorAll('[src]').forEach(element => {
      if (element.tagName !== 'IMG' || !/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(element.getAttribute('src') ?? '')) element.removeAttribute('src');
    });
    const csp = email.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; form-action 'none'; base-uri 'none'; connect-src 'none'";
    email.head.prepend(csp);
    const tokens = getComputedStyle(document.documentElement);
    const style = email.createElement('style');
    style.textContent = `:root { --font-email: ${tokens.getPropertyValue('--font-email')}; --color-text: ${tokens.getPropertyValue('--color-email-text')}; --color-surface: ${tokens.getPropertyValue('--color-email-surface')}; } html { color-scheme: light; background: var(--color-surface); color: var(--color-text); } body { margin: 24px; line-height: 1.5; overflow-wrap: anywhere; } body, body * { font-family: var(--font-email) !important; } img { max-width: 100%; height: auto; }`;
    email.head.append(style);
    return `<!doctype html>${email.documentElement.outerHTML}`;
  }, [html]);
  return <iframe title={title} className={['ui-email-preview', className].filter(Boolean).join(' ')} srcDoc={srcDoc} sandbox="" referrerPolicy="no-referrer" />;
}
export default EmailPreview;
