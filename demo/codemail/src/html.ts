// Server-rendered pages in OpenSend's design system: its tokens.css, ui.css and app.css (synced from
// app/ by scripts/sync-design.mjs), with the same shell, ui-* components and light/dark theme.
// Every interpolated value is escaped unless it is already Html.

export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export type Html = { __html: string };
export const raw = (value: string): Html => ({ __html: value });
const render = (item: unknown): string => item == null || item === false ? '' : Array.isArray(item) ? item.map(render).join('') : typeof item === 'object' && '__html' in (item as object) ? (item as Html).__html : esc(item);
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((value, index) => { out += render(value) + strings[index + 1]!; });
  return raw(out);
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export type Viewer = { email: string; name: string } | null;

// ---------- components (OpenSend ui.css) ----------
type ButtonOptions = { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm'; name?: string; value?: string; disabled?: boolean; block?: boolean; title?: string };
const buttonClass = (options: ButtonOptions) => `ui-button ui-button--${options.variant ?? 'secondary'}${options.size ? ` ui-button--${options.size}` : ''}${options.block ? ' ui-button--block' : ''}`;
export const button = (label: string, options: ButtonOptions = {}) => html`<button class="${buttonClass(options)}"${options.name ? html` name="${options.name}" value="${options.value ?? ''}"` : ''}${options.disabled ? raw(' disabled') : ''}${options.title ? html` title="${options.title}"` : ''}>${label}</button>`;
export const linkButton = (label: string, href: string, options: ButtonOptions = {}) => html`<a class="${buttonClass(options)}" href="${href}">${label}</a>`;
/** A one-button POST form, e.g. Delete or Disconnect. */
export const action = (url: string, label: string, options: ButtonOptions & { hidden?: Record<string, string> } = {}) =>
  html`<form method="post" action="${url}">${Object.entries(options.hidden ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`)}${button(label, { size: 'sm', ...options })}</form>`;
export const alert = (tone: Tone, content: Html | string, title?: string) => html`<div class="ui-alert ui-tone--${tone}" role="${tone === 'danger' ? 'alert' : 'status'}"><div>${title ? html`<div class="ui-alert__title">${title}</div>` : ''}${content}</div></div>`;
export const status = (tone: Tone, label: string) => html`<span class="ui-status ui-tone--${tone}"><span class="ui-status__dot"></span>${label}</span>`;
export const pageHeader = (title: string, actions?: Html) => html`<div class="ui-page-header"><h1>${title}</h1>${actions ? html`<div class="cluster">${actions}</div>` : ''}</div>`;
export const sectionHeader = (title: string, actions?: Html) => html`<div class="ui-section-header"><h2>${title}</h2>${actions ?? ''}</div>`;
export const field = (label: string, control: Html, options: { id: string; hint?: Html | string; narrow?: boolean }) =>
  html`<div class="ui-field${options.narrow ? ' ui-field--narrow' : ''}"><label class="ui-field__label" for="${options.id}">${label}</label>${control}${options.hint ? html`<span class="ui-field__hint">${options.hint}</span>` : ''}</div>`;
export const empty = (title: string, body?: Html | string, actionHtml?: Html) => html`<div class="ui-empty-state"><h3>${title}</h3>${body ? html`<p class="muted">${body}</p>` : ''}${actionHtml ?? ''}</div>`;
export function table(columns: { label: string; className?: string }[], rows: Html[][]) {
  return html`<div class="ui-table-scroll"><table class="ui-table"><thead><tr>${columns.map(column => html`<th class="${column.className ?? ''}">${column.label}</th>`)}</tr></thead>
<tbody>${rows.map(row => html`<tr>${row.map((cell, index) => html`<td class="${columns[index]?.className ?? ''}">${cell}</td>`)}</tr>`)}</tbody></table></div>`;
}
export const caption = (value: Html | string) => html`<div class="cell-caption muted">${value}</div>`;

const THEME_TOGGLE = raw(`<button type="button" class="ui-button ui-button--ghost ui-button--sm ui-icon-button theme-toggle" data-theme-toggle aria-label="Switch theme" title="Switch theme">
<svg data-icon="moon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
<svg data-icon="sun" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg></button>`);
const WORDMARK = raw('<a class="wordmark" href="/app" aria-label="codemail home"><span class="wordmark-square" aria-hidden="true"></span>codemail</a>');

const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
};

function documentResponse(title: string, body: Html, options: { status?: number; headers?: HeadersInit }) {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  for (const [name, value] of Object.entries(SECURITY)) if (!headers.has(name)) headers.set(name, value);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · codemail</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg"><script src="/theme.js"></script>
<link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/ui.css"><link rel="stylesheet" href="/styles/app.css"><link rel="stylesheet" href="/codemail.css">
<script src="/theme-toggle.js" defer></script></head><body>`;
  return new Response(`${head}${body.__html}</body></html>`, { status: options.status ?? 200, headers });
}

export type ShellNav = { org: { name: string; slug: string; host: string }; active: 'mailboxes' | 'members' | 'agents' | 'settings' };

/** The signed-in app: OpenSend's sidebar and raised page surface. */
export function shell(title: string, content: Html, options: { viewer: Viewer; nav: ShellNav; status?: number }) {
  const { org, active } = options.nav;
  const item = (key: ShellNav['active'], label: string, href: string) => html`<a href="${href}" class="${key === active ? 'active' : ''}"${key === active ? raw(' aria-current="page"') : ''}>${label}</a>`;
  const base = `/o/${org.slug}`;
  return documentResponse(title, html`<div class="app-shell"><a class="skip-link" href="#main-content">Skip to content</a>
<aside class="sidebar">${WORDMARK}${THEME_TOGGLE}
<div class="sidebar-context"><a class="org-switch" href="/app" title="Switch organization"><strong>${org.name}</strong><span>@${org.host}</span></a></div>
<nav class="main-navigation" aria-label="Main navigation">${item('mailboxes', 'Mailboxes', base)}${item('members', 'Members', `${base}/members`)}${item('agents', 'Agents', `${base}/agents`)}${item('settings', 'Settings', `${base}/settings`)}</nav>
<div class="sidebar-footer">${options.viewer ? html`<div class="sidebar-account"><span>${options.viewer.email}</span><form method="post" action="/sign-out">${button('Sign out', { variant: 'ghost', size: 'sm' })}</form></div>` : ''}</div></aside>
<main id="main-content" class="page-surface" tabindex="-1"><div class="stack">${content}</div></main></div>`, { status: options.status });
}

/** Signed-out and single-task pages (sign-in, consent, invitations): one centered surface. */
export function solo(title: string, content: Html, options: { viewer?: Viewer; status?: number; headers?: HeadersInit } = {}) {
  return documentResponse(title, html`<div class="solo-shell"><header class="solo-top">${WORDMARK}${THEME_TOGGLE}</header>
<main id="main-content" class="solo-main"><div class="solo-surface"><div class="stack">${content}</div></div>
${options.viewer ? html`<form method="post" action="/sign-out" class="cluster muted" style="margin-top:var(--space-16)"><span>Signed in as ${options.viewer.email}</span>${button('Sign out', { variant: 'ghost', size: 'sm' })}</form>` : ''}</main></div>`, options);
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60); if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60); if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
export const day = (value: string | Date) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
