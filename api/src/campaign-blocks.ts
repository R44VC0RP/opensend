// Campaign content is "block HTML": a small, opinionated HTML vocabulary that maps
// one-to-one onto the dashboard composer's blocks. Agents and the dashboard both read
// and write this form; the server validates it on save and renders the styled email
// (and a plain-text alternative) at review/test/send time. Styling lives in the
// renderer, never in the stored content.
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type Attr = { name: string; value: string };

const ALIGNMENTS = new Set(['left', 'center', 'right']);
const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'code', 'sup', 'br', 'a', 'span']);
const HEADINGS = new Set(['h1', 'h2', 'h3']);
const HREF = /^(?:https?:\/\/|mailto:|tel:|\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}|#$)/i;
const IMAGE_SRC = /^(?:https:\/\/[^\s"'<>]+|cid:[a-zA-Z0-9_.@-]{1,120})$/;
const DIMENSION = /^(?:[1-9][0-9]{0,3}|[1-9][0-9]?%|100%)$/;

export const CAMPAIGN_CONTENT_GUIDE = `# OpenSend campaign and template content

Campaign and template \`html\` is **block HTML**: a small HTML vocabulary that maps exactly onto the
dashboard composer's blocks. Anything written through the API opens as editable blocks
for people, and anything people compose comes back to you in the same form. OpenSend
applies the email design (fonts, spacing, colours, button and layout styling) when it
renders; the content itself carries structure only. The server rejects anything outside
this vocabulary with a 422 that names the offending tag or attribute.

## Blocks (top level, in reading order)

| Block | HTML | Attributes |
| --- | --- | --- |
| Heading | \`<h1>\`, \`<h2>\`, \`<h3>\` | \`align\` = left, center or right |
| Paragraph | \`<p>\` | \`align\` |
| Bullet list | \`<ul><li>…</li></ul>\` | — |
| Numbered list | \`<ol start="1"><li>…</li></ol>\` | \`start\` |
| Quote | \`<blockquote><p>…</p></blockquote>\` | — |
| Code block | \`<pre><code>…</code></pre>\` | — |
| Divider | \`<hr>\` | — |
| Image | \`<img src alt width height>\` | \`src\` is \`https://…\` or \`cid:<contentId>\` for an uploaded inline attachment; \`width\`/\`height\` in pixels or \`width\` as a percentage; \`align\` |
| Linked image | \`<a href="https://…"><img …></a>\` | — |
| Button | \`<a data-button href="https://…">Label</a>\` | \`align\` (default left). \`href="#"\` is accepted as a draft placeholder but blocks review. |
| Columns | \`<div data-columns="2"><div data-column>…</div><div data-column>…</div></div>\` | \`data-columns\` is 2, 3 or 4 and must match the number of \`data-column\` children. Columns hold blocks but not nested columns. |

List items hold inline content and may contain a nested \`<ul>\`/\`<ol>\`; \`<li><p>…</p></li>\` is also accepted.

### Images in templates

For an existing public image, call \`importTemplateImage\`. Add the returned \`asset.id\` to
the template draft's \`attachments\` and use its returned \`cid:…\` value as the image
\`src\`. This produces a stable private asset that renders in the dashboard, campaigns and
\`previewTemplate\`. Direct HTTPS image URLs remain valid email content, but the dashboard
does not load remote images because they can track the viewer; do not use Browser Control to
work around that privacy boundary.

## Inline formatting (inside headings, paragraphs, list items, quotes, buttons)

\`<strong>\`, \`<em>\`, \`<u>\`, \`<s>\`, \`<code>\`, \`<sup>\`, \`<br>\`, links as
\`<a href="https://… | mailto: | tel:">text</a>\` (optional \`target="_blank"\`), and
\`<span style="text-transform:uppercase">\` for small caps. Buttons may not contain links.

## Campaign personalization

Use \`{{name}}\` placeholders in text and in quoted \`href\`/\`alt\` attributes. Values come
from recipient properties plus the campaign \`defaults\`; every placeholder must resolve at
review time. \`{{email}}\` and \`{{name}}\` are always available. Values are escaped
automatically.

Templates are reusable concrete campaign drafts, not personalization presets. Template subject,
preview text and HTML must contain literal example content and cannot contain \`{{placeholder}}\`
syntax. After creating a campaign from a template, replace its example content and add campaign
personalization only when the specific campaign needs it.

## Not allowed

Any other element (\`div\` without \`data-columns\`/\`data-column\`, \`table\`, \`section\`,
\`span\` without the uppercase style, \`img\` with \`http://\` or \`data:\` sources, \`script\`,
\`style\`, \`iframe\`, forms), \`class\`, \`id\`, \`style\` (other than the uppercase span), event
handlers, comments, and document wrappers (\`<!doctype>\`, \`<html>\`, \`<head>\`, \`<body>\`).

## Example

\`\`\`html
<h1>Welcome, {{name}}</h1>
<p>Thanks for joining. Here is what is new this month:</p>
<ul>
  <li><strong>Faster search</strong> across every project</li>
  <li>Shared templates for your team</li>
</ul>
<img src="https://cdn.example.com/launch.png" alt="Launch screenshot" width="560">
<a data-button href="https://example.com/whats-new" align="center">See what's new</a>
<hr>
<p align="center">You are receiving this because you signed up at example.com.</p>
\`\`\`

## Working with people

Fetch a campaign with findCampaigns or a template with findTemplates to read the current
block HTML, including edits made in the dashboard composer. Send the complete replacement
\`html\` with saveCampaign or saveTemplate at the current revision; the dashboard reflects it
live. Preview campaigns through reviewCampaign and templates through previewTemplate; neither
workflow requires browser automation.`;

export class BlockContentError extends Error {}

function fail(message: string): never { throw new BlockContentError(`${message} Email content is block HTML; call getContentGuide in MCP or GET /v1/campaign-content-guide for the vocabulary.`); }
const describe = (element: Element) => `<${element.tagName}>`;
const isElement = (node: Node): node is Element => 'tagName' in node;
const isText = (node: Node): node is DefaultTreeAdapterMap['textNode'] => node.nodeName === '#text';
const attrs = (element: Element): Attr[] => element.attrs.map(a => ({ name: a.prefix ? `${a.prefix}:${a.name}` : a.name, value: a.value }));
const attribute = (element: Element, name: string) => element.attrs.find(a => a.name === name && !a.prefix)?.value;

function allowAttributes(element: Element, allowed: Record<string, (value: string) => boolean>) {
  for (const { name, value } of attrs(element)) {
    const check = allowed[name];
    if (!check) fail(`Unsupported attribute ${name} on ${describe(element)}.`);
    if (!check(value)) fail(`Invalid ${name} value on ${describe(element)}.`);
  }
}
const alignment = (value: string) => ALIGNMENTS.has(value);
const href = (value: string) => HREF.test(value.trim());
const anything = () => true;

function checkInline(parent: Element, node: Node, inButton: boolean) {
  if (isText(node)) return;
  if (!isElement(node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') fail(`Unsupported content inside ${describe(parent)}.`);
  const tag = node.tagName;
  if (!INLINE_TAGS.has(tag)) fail(`Unsupported ${describe(node)} inside ${describe(parent)}.`);
  if (tag === 'a') {
    if (inButton) fail('Buttons cannot contain links.');
    allowAttributes(node, { href, target: value => value === '_blank' || value === '_self', rel: anything });
    if (!attribute(node, 'href')) fail('Links require an href.');
  } else if (tag === 'span') {
    allowAttributes(node, { style: value => /^\s*text-transform\s*:\s*uppercase\s*;?\s*$/i.test(value) });
    if (!attribute(node, 'style')) fail('<span> is only supported with style="text-transform:uppercase".');
  } else allowAttributes(node, {});
  for (const child of node.childNodes) checkInline(node, child, inButton || tag === 'a');
}
function checkInlineChildren(element: Element, inButton = false) { for (const child of element.childNodes) checkInline(element, child, inButton); }

function checkImage(element: Element) {
  allowAttributes(element, { src: value => IMAGE_SRC.test(value.trim()), alt: anything, width: value => DIMENSION.test(value.trim()), height: value => DIMENSION.test(value.trim()), align: alignment });
  if (!attribute(element, 'src')) fail('Images require a src.');
  if (element.childNodes.some(child => !(isText(child) && !child.value.trim()))) fail('Images cannot contain content.');
}
function checkList(element: Element, depth: number) {
  allowAttributes(element, element.tagName === 'ol' ? { start: value => /^[0-9]{1,6}$/.test(value) } : {});
  for (const child of element.childNodes) {
    if (isText(child) && !child.value.trim()) continue;
    if (!isElement(child) || child.tagName !== 'li') fail(`${describe(element)} may only contain <li> items.`);
    allowAttributes(child, {});
    for (const item of child.childNodes) {
      if (isElement(item) && (item.tagName === 'ul' || item.tagName === 'ol')) { if (depth >= 3) fail('Lists nest at most three levels.'); checkList(item, depth + 1); }
      else if (isElement(item) && item.tagName === 'p') { allowAttributes(item, { align: alignment }); checkInlineChildren(item); }
      else checkInline(child, item, false);
    }
  }
}
function checkBlock(node: Node, inColumn: boolean) {
  if (isText(node)) { if (node.value.trim()) fail('Text must be inside a block such as <p>.'); return; }
  if (node.nodeName === '#comment') fail('Comments are not supported.');
  if (!isElement(node) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') fail('Unsupported markup in campaign content.');
  const tag = node.tagName;
  if (HEADINGS.has(tag) || tag === 'p') { allowAttributes(node, { align: alignment }); checkInlineChildren(node); return; }
  if (tag === 'ul' || tag === 'ol') { checkList(node, 1); return; }
  if (tag === 'blockquote') {
    allowAttributes(node, {});
    for (const child of node.childNodes) {
      if (isElement(child) && child.tagName === 'p') { allowAttributes(child, { align: alignment }); checkInlineChildren(child); }
      else checkInline(node, child, false);
    }
    return;
  }
  if (tag === 'pre') {
    allowAttributes(node, {});
    const children = node.childNodes.filter(child => !(isText(child) && !child.value.trim()));
    const code = children.length === 1 && isElement(children[0]!) && children[0]!.tagName === 'code' ? children[0] as Element : undefined;
    if (!code || code.childNodes.some(child => !isText(child))) fail('Code blocks are <pre><code> with text only.');
    allowAttributes(code, {});
    return;
  }
  if (tag === 'hr') { allowAttributes(node, {}); return; }
  if (tag === 'img') { checkImage(node); return; }
  if (tag === 'a') {
    const button = node.attrs.some(a => a.name === 'data-button');
    if (button) {
      allowAttributes(node, { 'data-button': anything, href, align: alignment });
      if (!attribute(node, 'href')) fail('Buttons require an href.');
      checkInlineChildren(node, true);
      return;
    }
    allowAttributes(node, { href, target: value => value === '_blank' || value === '_self', rel: anything });
    const children = node.childNodes.filter(child => !(isText(child) && !child.value.trim()));
    if (children.length === 1 && isElement(children[0]!) && children[0]!.tagName === 'img') { checkImage(children[0] as Element); return; }
    fail('A top-level <a> must be a button (<a data-button href>) or wrap a single <img>.');
  }
  if (tag === 'div') {
    const count = attribute(node, 'data-columns');
    if (count === undefined) fail('<div> is only supported as data-columns / data-column layout.');
    if (inColumn) fail('Columns cannot be nested.');
    allowAttributes(node, { 'data-columns': value => ['2', '3', '4'].includes(value) });
    const columns = node.childNodes.filter(child => !(isText(child) && !child.value.trim()));
    if (columns.length !== Number(count) || columns.some(column => !isElement(column) || column.tagName !== 'div' || attribute(column, 'data-column') === undefined)) fail(`data-columns="${count}" requires exactly ${count} <div data-column> children.`);
    for (const column of columns as Element[]) { allowAttributes(column, { 'data-column': anything }); for (const child of column.childNodes) checkBlock(child, true); }
    return;
  }
  fail(`Unsupported ${describe(node)} in campaign content.`);
}

/**
 * Throws BlockContentError when the HTML is outside the campaign block vocabulary.
 * Drafts may keep href="#" placeholders on links and buttons; `complete` rejects them.
 */
export function validateBlockHtml(html: string, options: { complete?: boolean } = {}): void {
  if (/<\s*(?:!doctype|\/?(?:html|head|body)\b)/i.test(html)) fail('Send content blocks only, without <!doctype>, <html>, <head> or <body> wrappers.');
  const fragment = parseFragment(html);
  for (const node of fragment.childNodes) checkBlock(node, false);
  if (options.complete && /<a\b[^>]*\bhref\s*=\s*["']#["']/i.test(html)) fail('A link or button still has the # placeholder; set its URL.');
}

// ----- Rendering -----------------------------------------------------------------

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TEXT = '#181818', MUTED = '#595959', LINK = '#3156c7', RULE = '#e2e2e2', BUTTON = '#181818';
const BASE = `font-family:${FONT};letter-spacing:-0.01em;color:${TEXT};`;
const styles: Record<string, string> = {
  p: `${BASE}font-size:16px;line-height:1.6;margin:0 0 16px;`,
  h1: `${BASE}font-size:26px;line-height:1.25;font-weight:600;margin:0 0 20px;`,
  h2: `${BASE}font-size:22px;line-height:1.3;font-weight:600;margin:24px 0 12px;`,
  h3: `${BASE}font-size:18px;line-height:1.4;font-weight:600;margin:20px 0 12px;`,
  li: `${BASE}font-size:16px;line-height:1.6;margin:0 0 6px;`,
  list: 'margin:0 0 16px;padding-left:24px;',
  blockquote: `margin:0 0 16px;padding:4px 0 4px 16px;border-left:3px solid ${RULE};color:${MUTED};`,
  pre: `margin:0 0 16px;padding:14px 16px;background:#f4f4f4;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;color:${TEXT};`,
  code: 'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;background:#f4f4f4;padding:1px 4px;border-radius:3px;',
  hr: `border:0;border-top:1px solid ${RULE};margin:24px 0;`,
  img: 'display:block;max-width:100%;height:auto;border:0;margin:0 0 16px;',
  link: `color:${LINK};text-decoration:underline;`,
  button: `${BASE}display:inline-block;font-size:15px;font-weight:500;line-height:1;background-color:${BUTTON};color:#ffffff;padding:12px 20px;border-radius:4px;text-decoration:none;`,
};

function renderInline(node: Node): string {
  if (isText(node)) return escape(node.value);
  if (!isElement(node)) return '';
  const inner = node.childNodes.map(renderInline).join('');
  switch (node.tagName) {
    case 'strong': case 'b': return `<strong>${inner}</strong>`;
    case 'em': case 'i': return `<em>${inner}</em>`;
    case 'u': return `<u>${inner}</u>`;
    case 's': return `<s>${inner}</s>`;
    case 'sup': return `<sup>${inner}</sup>`;
    case 'code': return `<code style="${styles.code}">${inner}</code>`;
    case 'br': return '<br>';
    case 'span': return `<span style="text-transform:uppercase">${inner}</span>`;
    case 'a': {
      const target = attribute(node, 'target');
      return `<a href="${escape(attribute(node, 'href') ?? '')}"${target ? ` target="${escape(target)}" rel="noopener noreferrer"` : ''} style="${styles.link}">${inner}</a>`;
    }
    default: return inner;
  }
}
const inlineChildren = (element: Element) => element.childNodes.map(renderInline).join('');
const alignStyle = (element: Element) => { const value = attribute(element, 'align'); return value && value !== 'left' ? `text-align:${value};` : ''; };

function renderImage(element: Element, link?: Element): string {
  const width = attribute(element, 'width')?.trim(), height = attribute(element, 'height')?.trim(), align = attribute(element, 'align') ?? 'left';
  const size = width ? `width:${/%$/.test(width) ? width : `${width}px`};` : '';
  const margin = align === 'center' ? 'margin:0 auto 16px;' : align === 'right' ? 'margin:0 0 16px auto;' : '';
  const image = `<img src="${escape(attribute(element, 'src') ?? '')}" alt="${escape(attribute(element, 'alt') ?? '')}"${width && !/%$/.test(width) ? ` width="${width}"` : ''}${height && !/%$/.test(height) ? ` height="${height}"` : ''} style="${styles.img}${size}${margin}">`;
  return link ? `<a href="${escape(attribute(link, 'href') ?? '')}" style="display:block;text-decoration:none">${image}</a>` : image;
}
function renderList(element: Element): string {
  const items = element.childNodes.filter((child): child is Element => isElement(child) && child.tagName === 'li').map(item => {
    const parts = item.childNodes.map(child => {
      if (isElement(child) && (child.tagName === 'ul' || child.tagName === 'ol')) return renderList(child);
      if (isElement(child) && child.tagName === 'p') return inlineChildren(child);
      return renderInline(child);
    });
    return `<li style="${styles.li}">${parts.join('')}</li>`;
  });
  const start = attribute(element, 'start');
  return `<${element.tagName}${start ? ` start="${escape(start)}"` : ''} style="${styles.list}">${items.join('')}</${element.tagName}>`;
}
function renderBlock(node: Node): string {
  if (!isElement(node)) return '';
  const tag = node.tagName;
  if (HEADINGS.has(tag) || tag === 'p') return `<${tag} style="${styles[tag]}${alignStyle(node)}">${inlineChildren(node) || '<br>'}</${tag}>`;
  if (tag === 'ul' || tag === 'ol') return renderList(node);
  if (tag === 'blockquote') {
    const inner = node.childNodes.map(child => isElement(child) && child.tagName === 'p' ? `<p style="${styles.p}margin:0 0 8px;color:inherit;${alignStyle(child)}">${inlineChildren(child)}</p>` : renderInline(child)).join('');
    return `<blockquote style="${styles.blockquote}">${inner}</blockquote>`;
  }
  if (tag === 'pre') { const code = node.childNodes.find((child): child is Element => isElement(child) && child.tagName === 'code'); return `<pre style="${styles.pre}">${code ? code.childNodes.map(renderInline).join('') : ''}</pre>`; }
  if (tag === 'hr') return `<hr style="${styles.hr}">`;
  if (tag === 'img') return renderImage(node);
  if (tag === 'a') {
    if (node.attrs.some(a => a.name === 'data-button')) {
      const align = attribute(node, 'align') ?? 'left';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:0 0 16px;${align === 'center' ? 'margin-left:auto;margin-right:auto;' : align === 'right' ? 'margin-left:auto;' : ''}"><tr><td style="border-radius:4px;background-color:${BUTTON}"><a href="${escape(attribute(node, 'href') ?? '')}" style="${styles.button}">${inlineChildren(node)}</a></td></tr></table>`;
    }
    const image = node.childNodes.find((child): child is Element => isElement(child) && child.tagName === 'img');
    return image ? renderImage(image, node) : '';
  }
  if (tag === 'div') {
    const columns = node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === 'div');
    const width = `${Math.floor(100 / columns.length)}%`;
    const cells = columns.map((column, index) => `<td width="${width}" valign="top" style="width:${width};vertical-align:top;padding:0 ${index === columns.length - 1 ? 0 : 12}px 0 ${index === 0 ? 0 : 12}px">${column.childNodes.map(renderBlock).join('')}</td>`).join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 16px"><tr>${cells}</tr></table>`;
  }
  return '';
}

/** Renders validated block HTML as a complete, inline-styled email document. */
export function renderBlockHtml(html: string, options: { fontBase?: string; title?: string } = {}): string {
  const fragment = parseFragment(html);
  const body = fragment.childNodes.map(renderBlock).join('\n');
  const fonts = options.fontBase ? `<style>@font-face{font-family:Inter;src:url('${escape(options.fontBase)}inter-variable.woff2') format('woff2');font-style:normal;font-weight:100 900}@font-face{font-family:Inter;src:url('${escape(options.fontBase)}inter-variable-italic.woff2') format('woff2');font-style:italic;font-weight:100 900}</style>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escape(options.title ?? '')}</title>${fonts}<style>@media (prefers-color-scheme: dark){li::marker{color:#c4c4c4}}</style></head><body style="margin:0;padding:0;background-color:#ffffff;${BASE}font-size:16px;-webkit-text-size-adjust:100%"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:#ffffff"><tr><td align="center" style="padding:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px"><tr><td style="padding:24px;text-align:left">\n${body}\n</td></tr></table></td></tr></table></body></html>`;
}

function textInline(node: Node): string {
  if (isText(node)) return node.value.replace(/\s+/g, ' ');
  if (!isElement(node)) return '';
  const inner = node.childNodes.map(textInline).join('');
  if (node.tagName === 'br') return '\n';
  if (node.tagName === 'a') { const url = attribute(node, 'href') ?? ''; return inner.trim() && inner.trim() !== url ? `${inner} (${url})` : url; }
  return inner;
}
function textBlock(node: Node, indent = ''): string {
  if (!isElement(node)) return '';
  const tag = node.tagName;
  if (HEADINGS.has(tag) || tag === 'p') return `${indent}${textInline(node).trim()}\n\n`;
  if (tag === 'ul' || tag === 'ol') {
    let index = Number(attribute(node, 'start') ?? '1') || 1;
    return node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === 'li').map(item => {
      const marker = tag === 'ol' ? `${index++}. ` : '- ';
      const nested = item.childNodes.filter((child): child is Element => isElement(child) && (child.tagName === 'ul' || child.tagName === 'ol'));
      const own = item.childNodes.filter(child => !nested.includes(child as Element)).map(child => isElement(child) && child.tagName === 'p' ? textInline(child) : textInline(child)).join('').trim();
      return `${indent}${marker}${own}\n${nested.map(list => textBlock(list, `${indent}  `)).join('')}`;
    }).join('') + (indent ? '' : '\n');
  }
  if (tag === 'blockquote') return node.childNodes.map(child => `${indent}> ${(isElement(child) && child.tagName === 'p' ? textInline(child) : textInline(child)).trim()}\n`).join('') + '\n';
  if (tag === 'pre') return `${node.childNodes.map(child => isElement(child) ? child.childNodes.map(c => isText(c) ? c.value : '').join('') : '').join('')}\n\n`;
  if (tag === 'hr') return `${indent}----------\n\n`;
  if (tag === 'img') { const alt = attribute(node, 'alt')?.trim(); const src = attribute(node, 'src') ?? ''; return src.startsWith('cid:') ? (alt ? `${indent}[${alt}]\n\n` : '') : `${indent}${alt ? `[${alt}] ` : ''}${src}\n\n`; }
  if (tag === 'a') {
    const url = attribute(node, 'href') ?? '';
    const image = node.childNodes.find((child): child is Element => isElement(child) && child.tagName === 'img');
    if (image) { const alt = attribute(image, 'alt')?.trim(); return `${indent}${alt ? `[${alt}] ` : ''}${url}\n\n`; }
    return `${indent}${node.childNodes.map(textInline).join('').trim()}: ${url}\n\n`;
  }
  if (tag === 'div') return node.childNodes.filter((child): child is Element => isElement(child) && child.tagName === 'div').map(column => column.childNodes.map(child => textBlock(child, indent)).join('')).join('');
  return '';
}

/** Plain-text alternative derived from block HTML; placeholders are left intact. */
export function renderBlockText(html: string): string {
  const fragment = parseFragment(html);
  return fragment.childNodes.map(node => textBlock(node)).join('').replace(/\n{3,}/g, '\n\n').trim();
}
