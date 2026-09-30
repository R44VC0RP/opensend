// MCP sign-in: the OAuth consent page. The user signs in with Google, picks an organization, the
// mailboxes the agent may use and its permissions; codemail then mints an OpenSend mailbox key with
// exactly that scope and keeps it (encrypted) in the OAuth grant.
import { AuthorizationError, CimdFetchError, type AuthRequest } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { Env } from './env.js';
import { alert, button, html, linkButton, solo, status } from './html.js';
import type { CodemailProps } from './mcp.js';
import type { Permission } from './opensend.js';
import { memberships, orgHost, viewerOf, viewerView, type Ctx, type Vars } from './web.js';

const PERMISSIONS: { value: Permission; label: string; hint: string }[] = [
  { value: 'read', label: 'Read mail', hint: 'List and read conversations and attachments.' },
  { value: 'send', label: 'Send mail', hint: 'Send, reply and forward as the mailbox.' },
  { value: 'modify', label: 'Organize mail', hint: 'Mark read, archive, star and label.' },
];

function problem(error: unknown) {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
    return solo('Sign-in problem', html`<h1>Something went wrong</h1>${alert('danger', message)}<p>Start connecting again from your MCP client.</p>`, { status: 400 });
  }
  throw error;
}

/** The authorize URL without codemail's own parameters (org, error). */
function selfUrl(url: URL, changes: Record<string, string | null>) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(changes)) value === null ? next.searchParams.delete(key) : next.searchParams.set(key, value);
  return `${next.pathname}${next.search}`;
}

export function consentRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.get('/authorize', async c => {
    const url = new URL(c.req.url);
    const oauth = c.env.OAUTH_PROVIDER;
    let authRequest: AuthRequest;
    try { authRequest = await oauth.parseAuthRequest(c.req.raw); } catch (error) { return problem(error); }
    const viewer = await viewerOf(c);
    if (!viewer) return c.redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 303);
    const orgs = await memberships(c.var.db, viewer.user.id);
    const viewerInfo = viewerView(viewer);
    if (!orgs.length) return solo('Connect an agent', html`<h1>Create an organization first</h1><p>Agents connect to mailboxes in an organization. Create one, add a mailbox, then connect again from your MCP client.</p><div class="solo-actions">${linkButton('Create organization', '/app/new', { variant: 'primary' })}</div>`, { viewer: viewerInfo });
    const current = orgs.find(item => item.org.slug === url.searchParams.get('org')) ?? orgs[0]!;
    try {
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const mailboxes = (await c.var.admin.mailboxes(orgHost(c.env, current.org))).sort((a, b) => a.address.localeCompare(b.address));
      const failure = url.searchParams.get('error');
      const body = html`<h1>Connect ${details.clientName}</h1>
<p>${details.clientDomain ? html`Published by <strong>${details.clientDomain}</strong>.` : 'This app registered itself, so its name isn’t verified.'} Choose what it can do.</p>
<dl class="facts"><div><dt>App</dt><dd>${details.clientName}</dd></div><div><dt>Access goes to</dt><dd><strong>${details.redirectHost}</strong></dd></div></dl>
${details.redirectIsLoopback ? alert('warning', 'Access is sent to an app on your computer. Continue only if you just started connecting from it.') : ''}
${failure ? alert('danger', failure) : ''}
${orgs.length > 1 ? html`<div class="ui-field"><span class="ui-field__label">Organization</span><div class="org-pills">${orgs.map(item => item.org.id === current.org.id ? status('info', item.org.name) : html`<a href="${selfUrl(url, { org: item.org.slug, error: null })}">${status('neutral', item.org.name)}</a>`)}</div></div>` : ''}
<form method="post" action="${selfUrl(url, { error: null })}" autocomplete="off" class="stack">
<input type="hidden" name="handle" value="${consent.handle}"><input type="hidden" name="org" value="${current.org.slug}">
<fieldset class="ui-field" style="border:0;margin:0;padding:0"><legend class="ui-field__label" style="margin-bottom:var(--space-8)">Mailboxes in ${current.org.name}</legend>
${mailboxes.length ? html`<div class="choices">${mailboxes.map(mailbox => html`<label class="choice"><input type="checkbox" name="mailbox" value="${mailbox.id}" checked><span><code class="identifier">${mailbox.address}</code>${mailbox.displayName ? html`<span class="muted">${mailbox.displayName}</span>` : ''}</span></label>`)}</div>`
        : alert('warning', html`${current.org.name} has no mailboxes yet. <a class="link" href="/o/${current.org.slug}" target="_blank" rel="noreferrer">Create one</a>, then reload this page.`)}</fieldset>
<fieldset class="ui-field" style="border:0;margin:0;padding:0"><legend class="ui-field__label" style="margin-bottom:var(--space-8)">Permissions</legend><div class="choices">
${PERMISSIONS.map(item => html`<label class="choice"><input type="checkbox" name="permission" value="${item.value}" checked ${item.value === 'read' ? 'disabled' : ''}><span>${item.label}<span class="muted">${item.hint}</span></span></label>`)}</div></fieldset>
<div class="solo-actions">${button('Deny', { name: 'decision', value: 'deny' })}${button('Connect', { variant: 'primary', name: 'decision', value: 'approve', disabled: !mailboxes.length })}</div></form>`;
      return solo(`Connect ${details.clientName}`, body, { headers: consent.headers, viewer: viewerInfo });
    } catch (error) { return problem(error); }
  });

  app.post('/authorize', async c => {
    const url = new URL(c.req.url);
    const oauth = c.env.OAUTH_PROVIDER;
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '');
    try {
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const viewer = await viewerOf(c);
      if (!viewer) return c.redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 303);
      const retry = (message: string) => c.redirect(selfUrl(url, { error: message, org: String(form.get('org') ?? '') || null }), 303);
      const current = (await memberships(c.var.db, viewer.user.id)).find(item => item.org.slug === form.get('org'));
      if (!current) return retry('Choose one of your organizations.');
      const available = await c.var.admin.mailboxes(orgHost(c.env, current.org));
      const chosen = available.filter(mailbox => form.getAll('mailbox').includes(mailbox.id));
      if (!chosen.length) return retry('Choose at least one mailbox.');
      const permissions: Permission[] = ['read', ...PERMISSIONS.map(item => item.value).filter(value => value !== 'read' && form.getAll('permission').includes(value))];

      const approved = await oauth.approveConsent(c.req.raw, handle, { scope: ['mail'] });
      const clientName = (await oauth.describeConsent(approved.request)).clientName;
      const key = await c.var.admin.createKey({ name: `codemail · ${clientName} · ${viewer.user.email}`.slice(0, 100), mailboxIds: chosen.map(mailbox => mailbox.id), permissions });
      try {
        const props: CodemailProps = { mailboxKey: key.secret, keyId: key.id, userId: viewer.user.id, organizationId: current.org.id, mailboxes: chosen.map(({ id, address }) => ({ id, address })) };
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request, userId: viewer.user.id, scope: ['mail'], props,
          metadata: { label: `${clientName}: ${chosen.map(mailbox => mailbox.address).join(', ')}`, clientName, keyId: key.id, organizationId: current.org.id, mailboxes: chosen.map(mailbox => mailbox.address), permissions },
        });
        approved.headers.set('Location', redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      } catch (error) { await c.var.admin.revokeKey(key.id).catch(() => {}); throw error; }
    } catch (error) { return problem(error); }
  });
  return app;
}

export type { Ctx };
