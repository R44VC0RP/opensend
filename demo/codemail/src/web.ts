import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { createAuth, MEMBER_LIMIT, type Auth } from './better-auth.js';
import { consentRoutes } from './consent.js';
import { account, connect, invitation, member, organization, retiredSlug, user, type Db } from './db.js';
import { mayCreateOrganizations, origin, type Env } from './env.js';
import { action, ago, alert, button, caption, day, empty, field, html, linkButton, pageHeader, raw, sectionHeader, shell, solo, status, table, type Html, type ShellNav, type Viewer } from './html.js';
import { OpenSendAdmin, OpenSendError, type Mailbox } from './opensend.js';

export type Vars = { db: Db; auth: Auth; admin: OpenSendAdmin };
export type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
export type Membership = { org: typeof organization.$inferSelect; role: string; memberId: string };

export const MAILBOX_LIMIT = 25;
const RESERVED_SLUGS = new Set(['www', 'mail', 'email', 'api', 'app', 'apps', 'admin', 'administrator', 'auth', 'login', 'signin', 'signup', 'account', 'accounts', 'mcp', 'oauth', 'docs', 'help', 'support', 'status', 'blog', 'dev', 'staging', 'test', 'demo', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'dns', 'ftp', 'cdn', 'static', 'assets', 'billing', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply', 'root', 'system', 'codemail', 'opcd', 'opensend', 'inbound', 'bounce', 'bounces', 'dmarc', 'autodiscover', 'autoconfig']);
const RESERVED_LOCAL = new Set(['postmaster', 'abuse', 'hostmaster', 'mailer-daemon']);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const orgHost = (env: Env, org: { slug: string }) => `${org.slug}.${env.MAIL_DOMAIN}`;
export const safeNext = (value: string | null | undefined) => value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/app';
const redirect = (location: string, headers?: Headers) => { const out = new Headers(headers); out.set('Location', location); return new Response(null, { status: 303, headers: out }); };
function withCookies(from: Response, to = new Headers()) { for (const cookie of from.headers.getSetCookie()) to.append('Set-Cookie', cookie); return to; }
const errorText = (error: unknown) => error instanceof OpenSendError ? error.message : error && typeof error === 'object' && 'body' in error && (error as { body?: { message?: string } }).body?.message ? (error as { body: { message: string } }).body.message : error instanceof Error ? error.message : 'Something went wrong.';

export async function viewerOf(c: Ctx) {
  const result = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  return result ? { user: result.user, session: result.session } : null;
}
export const viewerView = (value: Awaited<ReturnType<typeof viewerOf>>): Viewer => value ? { email: value.user.email, name: value.user.name } : null;
export async function memberships(db: Db, userId: string) {
  return db.select({ org: organization, role: member.role, memberId: member.id }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(eq(member.userId, userId)).orderBy(asc(organization.name));
}
export async function membershipFor(db: Db, userId: string, slug: string): Promise<Membership | null> {
  const [row] = await db.select({ org: organization, role: member.role, memberId: member.id }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(and(eq(member.userId, userId), eq(organization.slug, slug)));
  return row ?? null;
}
const isAdmin = (role: string) => role === 'owner' || role === 'admin';
/** The email-domain label for an organization name (same rule as public/new-org.js). */
export const slugify = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');

/**
 * Suggests an organization from the Google Workspace domain (the ID token's hd claim, e.g. anoma.ly →
 * "Anoma" / anoma). Google doesn't share the company's display name, so it comes from the domain.
 * Personal Gmail accounts have no hd and get an empty form.
 */
export async function workspaceSuggestion(db: Db, userId: string): Promise<{ name?: string; slug?: string }> {
  const [row] = await db.select({ idToken: account.idToken }).from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'google')));
  let hd: unknown;
  try { hd = row?.idToken ? JSON.parse(atob(row.idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).hd : undefined; } catch { return {}; }
  if (typeof hd !== 'string' || !/^[a-z0-9.-]+$/i.test(hd)) return {};
  const label = hd.toLowerCase().split('.')[0]!;
  const name = label.split('-').filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join(' ');
  return { name, slug: slugify(label) };
}
const orgMeta = (org: { metadata: string | null }) => { try { return JSON.parse(org.metadata ?? '{}') as { subdomainId?: string }; } catch { return {}; } };

/** Mailboxes belong to an organization by address: anything @<slug>.<mail domain>. */
export async function orgMailbox(c: Ctx, org: { slug: string }, mailboxId: string): Promise<Mailbox | null> {
  const mailbox = await c.var.admin.mailbox(mailboxId).catch(error => { if (error instanceof OpenSendError && error.status === 404) return null; throw error; });
  return mailbox && mailbox.address.endsWith(`@${orgHost(c.env, org)}`) ? mailbox : null;
}

/** Connected agents (OAuth grants) in an organization, across its members. */
export async function orgGrants(c: Ctx, orgId: string) {
  const people = await c.var.db.select({ userId: member.userId, email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.organizationId, orgId));
  const lists = await Promise.all(people.map(async person => (await c.env.OAUTH_PROVIDER.listUserGrants(person.userId, { limit: 100 })).items.filter(grant => grant.metadata?.organizationId === orgId).map(grant => ({ ...grant, email: person.email }))));
  return lists.flat().sort((a, b) => b.createdAt - a.createdAt);
}
export async function revokeGrant(c: Ctx, grant: { id: string; userId: string; metadata?: { keyId?: string } }) {
  await c.env.OAUTH_PROVIDER.revokeGrant(grant.id, grant.userId);
  if (grant.metadata?.keyId) await c.var.admin.revokeKey(grant.metadata.keyId);
}

const notices = (c: Ctx) => { const ok = c.req.query('ok'); const error = c.req.query('error'); return html`${ok ? alert('success', ok) : ''}${error ? alert('danger', error) : ''}`; };
const back = (path: string, key: 'ok' | 'error', message: string) => redirect(`${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(message)}`);
const input = (attributes: Html) => html`<input class="ui-input" ${attributes}>`;

export function createWeb() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use('*', async (c, next) => {
    // Forms post only from our own pages. Better Auth and the OAuth consent handle their own checks too.
    if (!['GET', 'HEAD'].includes(c.req.method) && !c.req.path.startsWith('/api/auth/')) {
      const from = c.req.header('Origin');
      if (from !== origin(c.env)) return c.text('Cross-site form submission refused.', 403);
    }
    const connection = connect(c.env.HYPERDRIVE.connectionString);
    try {
      await connection.ready;
      c.set('db', connection.db);
      c.set('auth', createAuth(c.env, connection.db, work => c.executionCtx.waitUntil(work)));
      c.set('admin', new OpenSendAdmin(c.env.OPENSEND_URL, c.env.OPENSEND_API_KEY, c.env.MAIL_DOMAIN));
      await next();
    } finally { c.executionCtx.waitUntil(connection.close()); }
  });

  app.on(['GET', 'POST'], '/api/auth/*', c => c.var.auth.handler(c.req.raw));

  // ---------- sign-in ----------
  // The root page is the sign-in page: one step to Google.
  const signInPage = (c: Ctx, next: string) => {
    const failed = c.req.query('error');
    return solo('Sign in', html`<h1>Email for AI agents</h1>
<p>Give your agents real mailboxes at <strong>@yourteam.${c.env.MAIL_DOMAIN}</strong>. Over MCP they read, reply in-thread, send and wait for new mail.</p>
${failed ? alert('danger', `Google sign-in didn’t complete (${failed}). Try again.`) : ''}
<form method="post" action="/sign-in/google"><input type="hidden" name="next" value="${next}"><div class="solo-actions">${button('Continue with Google', { variant: 'primary', block: true })}</div></form>
<p class="muted">Signing in the first time creates your account.</p>`);
  };
  app.get('/', async c => (await viewerOf(c)) ? redirect('/app') : signInPage(c, '/app'));
  app.get('/sign-in', async c => {
    const next = safeNext(c.req.query('next'));
    return (await viewerOf(c)) ? redirect(next) : signInPage(c, next);
  });
  app.post('/sign-in/google', async c => {
    const form = await c.req.formData();
    const next = safeNext(String(form.get('next') ?? ''));
    const response = await c.var.auth.api.signInSocial({ body: { provider: 'google', callbackURL: next, errorCallbackURL: `/sign-in?next=${encodeURIComponent(next)}` }, headers: c.req.raw.headers, asResponse: true });
    const body = await response.json() as { url?: string };
    if (!response.ok || !body.url) return solo('Sign in', html`<h1>Sign-in is unavailable</h1>${alert('danger', 'Google sign-in could not start. Try again in a moment.')}`, { status: 502 });
    return redirect(body.url, withCookies(response));
  });
  app.post('/sign-out', async c => {
    const response = await c.var.auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
    return redirect('/', withCookies(response));
  });

  // ---------- organizations ----------
  app.get('/app', async c => {
    const viewer = await viewerOf(c);
    if (!viewer) return redirect('/sign-in?next=/app');
    const orgs = await memberships(c.var.db, viewer.user.id);
    const pending = await c.var.db.select({ id: invitation.id, orgName: organization.name }).from(invitation).innerJoin(organization, eq(organization.id, invitation.organizationId))
      .where(and(eq(sql`lower(${invitation.email})`, viewer.user.email.toLowerCase()), eq(invitation.status, 'pending'), sql`${invitation.expiresAt} > now()`));
    if (orgs.length === 1 && !pending.length && c.req.query('switch') === undefined) return redirect(`/o/${orgs[0]!.org.slug}`);
    if (!orgs.length && !pending.length) return redirect('/app/new');
    return solo('Organizations', html`<h1>Organizations</h1>
${pending.length ? html`${sectionHeader('Invitations')}${table([{ label: 'Organization' }, { label: '', className: 'row-actions' }], pending.map(item => [html`${item.orgName}`, linkButton('View', `/invite/${item.id}`, { size: 'sm' })]))}` : ''}
${orgs.length ? table([{ label: 'Organization' }, { label: 'Role', className: 'row-actions' }], orgs.map(item => [html`<a class="link" href="/o/${item.org.slug}">${item.org.name}</a>${caption(`@${orgHost(c.env, item.org)}`)}`, status('neutral', item.role)])) : ''}
${mayCreateOrganizations(c.env, viewer.user.email) ? html`<div class="solo-actions">${linkButton('New organization', '/app/new')}</div>` : ''}`, { viewer: viewerView(viewer) });
  });

  const newOrgPage = (c: Ctx, viewer: NonNullable<Awaited<ReturnType<typeof viewerOf>>>, values: { name?: string; slug?: string; slugEdited?: boolean; firstOrganization?: boolean } = {}, error?: string, statusCode = 200) => {
    if (!mayCreateOrganizations(c.env, viewer.user.email)) return solo('Invite only', html`<h1>codemail is invite-only for now</h1><p>Ask someone in an organization to invite ${viewer.user.email}, then open the link from their email.</p>`, { viewer: viewerView(viewer) });
    return solo('New organization', html`<h1>Name your organization</h1><p>Your agents’ mailboxes live at your organization’s email domain.</p>
${error ? alert('danger', error) : ''}
<form method="post" action="/app/orgs" autocomplete="off" class="stack">
${field('Organization name', input(html`id="name" name="name" type="text" required maxlength="80" value="${values.name ?? ''}" placeholder="Acme Inc." autofocus`), { id: 'name' })}
${field('Email domain', html`<div class="input-suffix">${input(html`id="slug" name="slug" type="text" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" value="${values.slug ?? ''}" placeholder="acme" spellcheck="false" autocapitalize="off" data-slug-from="name"${values.slugEdited ? raw(' data-edited') : ''}`)}<span>.${c.env.MAIL_DOMAIN}</span></div>`, { id: 'slug', hint: html`Filled in from the name. 3–32 lowercase letters, digits or hyphens. Mailboxes look like <code>agent@<span data-slug-preview>${values.slug || 'acme'}</span>.${c.env.MAIL_DOMAIN}</code>. This can’t be changed later.` })}
<div class="solo-actions">${values.firstOrganization ? '' : linkButton('Cancel', '/app?switch')}${button('Create organization', { variant: 'primary', block: values.firstOrganization })}</div></form>
<script src="/new-org.js" defer></script>`, { status: statusCode, viewer: viewerView(viewer) });
  };
  app.get('/app/new', async c => {
    const viewer = await viewerOf(c);
    if (!viewer) return redirect('/sign-in?next=/app/new');
    const firstOrganization = !(await memberships(c.var.db, viewer.user.id)).length;
    return newOrgPage(c, viewer, { ...await workspaceSuggestion(c.var.db, viewer.user.id), firstOrganization });
  });
  app.post('/app/orgs', async c => {
    const viewer = await viewerOf(c);
    if (!viewer) return redirect('/sign-in?next=/app/new');
    const form = await c.req.formData();
    const name = String(form.get('name') ?? '').trim().replace(/\s+/g, ' ');
    const slug = String(form.get('slug') ?? '').trim().toLowerCase();
    const firstOrganization = !(await memberships(c.var.db, viewer.user.id)).length;
    const retry = (message: string, statusCode = 422) => newOrgPage(c, viewer, { name, slug, slugEdited: slug !== slugify(name), firstOrganization }, message, statusCode);
    if (!mayCreateOrganizations(c.env, viewer.user.email)) return retry('Your account can’t create organizations yet.', 403);
    if (!name || name.length > 80) return retry('Enter an organization name of up to 80 characters.');
    if (!SLUG.test(slug) || slug.includes('--')) return retry('Use 3–32 lowercase letters, digits or single hyphens, starting and ending with a letter or digit.');
    if (RESERVED_SLUGS.has(slug)) return retry(`${slug}.${c.env.MAIL_DOMAIN} is reserved. Choose another.`);
    const [taken] = await c.var.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug));
    const [retired] = await c.var.db.select({ slug: retiredSlug.slug }).from(retiredSlug).where(eq(retiredSlug.slug, slug));
    if (taken || retired) return retry(`${slug}.${c.env.MAIL_DOMAIN} is taken. Choose another.`, 409);
    // Reserve the mail subdomain first, so an organization never exists without its address.
    let subdomain;
    try { subdomain = await c.var.admin.addSubdomain(slug, { product: 'codemail' }); }
    catch (error) { return retry(error instanceof OpenSendError && error.code === 'SUBDOMAIN_EXISTS' ? `${slug}.${c.env.MAIL_DOMAIN} is taken. Choose another.` : `Couldn’t set up email for ${slug}.${c.env.MAIL_DOMAIN}: ${errorText(error)}`, 409); }
    // OpenSend restores a removed subdomain with its old ID; never give someone else an address that was used before.
    if (subdomain.mailboxCount > 0 || Date.now() - Date.parse(subdomain.createdAt) > 5 * 60_000) {
      await c.var.admin.removeSubdomain(subdomain.id).catch(() => {});
      return retry(`${slug}.${c.env.MAIL_DOMAIN} was used before. Choose another.`, 409);
    }
    try {
      const created = await c.var.auth.api.createOrganization({ body: { name, slug, metadata: { subdomainId: subdomain.id } }, headers: c.req.raw.headers });
      if (!created) throw new Error('Organization was not created.');
      await c.var.admin.updateSubdomain(subdomain.id, { product: 'codemail', organizationId: created.id }).catch(() => {});
      return redirect(`/o/${slug}?ok=${encodeURIComponent(`${name} is ready. Create your first agent mailbox.`)}`);
    } catch (error) {
      await c.var.admin.removeSubdomain(subdomain.id).catch(() => {});
      return retry(errorText(error), 409);
    }
  });

  const orgPage = async (c: Ctx, need: 'member' | 'admin' = 'member') => {
    const viewer = await viewerOf(c);
    if (!viewer) return { response: redirect(`/sign-in?next=${encodeURIComponent(new URL(c.req.url).pathname)}`) } as const;
    const membership = await membershipFor(c.var.db, viewer.user.id, c.req.param('slug') ?? '');
    if (!membership) return { response: solo('Not found', html`<h1>Organization not found</h1><p>It doesn’t exist, or you’re not a member.</p><div class="solo-actions">${linkButton('Your organizations', '/app?switch')}</div>`, { status: 404, viewer: viewerView(viewer) }) } as const;
    if (need === 'admin' && !isAdmin(membership.role)) return { response: back(`/o/${membership.org.slug}`, 'error', 'Only owners and admins can do that.') } as const;
    return { viewer, membership } as const;
  };
  const inShell = (c: Ctx, ctx: { viewer: NonNullable<Awaited<ReturnType<typeof viewerOf>>>; membership: Membership }, active: ShellNav['active'], title: string, content: Html) =>
    shell(title, content, { viewer: viewerView(ctx.viewer), nav: { org: { name: ctx.membership.org.name, slug: ctx.membership.org.slug, host: orgHost(c.env, ctx.membership.org) }, active } });

  // ---------- mailboxes ----------
  app.get('/o/:slug', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership; const host = orgHost(c.env, org);
    let list: Mailbox[] = []; let loadError: string | null = null;
    try { list = await c.var.admin.mailboxes(host); } catch (error) { loadError = errorText(error); }
    list.sort((a, b) => a.address.localeCompare(b.address));
    const rows = list.map(mailbox => [
      html`<a class="link" href="/o/${org.slug}/m/${mailbox.id}">${mailbox.stats.unreadThreads ? raw('<span class="unread-dot" aria-hidden="true"></span>') : ''}<code class="identifier">${mailbox.address}</code></a>${mailbox.displayName ? caption(mailbox.displayName) : ''}`,
      html`${mailbox.stats.threads}`,
      mailbox.stats.unreadThreads ? status('info', `${mailbox.stats.unreadThreads} unread`) : html`<span class="muted">—</span>`,
      html`<span class="muted">${mailbox.stats.lastMessageAt ? ago(mailbox.stats.lastMessageAt) : 'No mail yet'}</span>`,
      isAdmin(role) ? action(`/o/${org.slug}/mailboxes/${mailbox.id}/delete`, 'Delete', { variant: 'danger', title: `Delete ${mailbox.address}` }) : html``,
    ]);
    return inShell(c, ctx, 'mailboxes', org.name, html`${pageHeader('Mailboxes')}${notices(c)}
${loadError ? alert('danger', loadError, 'Couldn’t load mailboxes') : ''}
${list.length ? table([{ label: 'Address', className: 'col-primary' }, { label: 'Conversations' }, { label: 'Unread' }, { label: 'Last mail' }, { label: '', className: 'row-actions' }], rows) : loadError ? '' : empty('No mailboxes yet', 'Create one for your first agent below.')}
<section class="section section--bordered">${list.length < MAILBOX_LIMIT ? html`${sectionHeader('New mailbox')}<form method="post" action="/o/${org.slug}/mailboxes" autocomplete="off" class="inline-form">
${field('Address', html`<div class="input-suffix">${input(html`id="local" name="local" type="text" required maxlength="64" placeholder="support" spellcheck="false" autocapitalize="off"`)}<span>@${host}</span></div>`, { id: 'local' })}
${field('Display name', input(html`id="display" name="display" type="text" maxlength="100" placeholder="Support agent"`), { id: 'display' })}
${button('Create mailbox', { variant: 'primary' })}</form>` : html`<p class="muted">This organization has the maximum of ${MAILBOX_LIMIT} mailboxes.</p>`}</section>
<section class="section section--bordered">${sectionHeader('Connect an agent')}<div class="stack"><p class="muted">Add codemail to any MCP client (Claude, Cursor, OpenCode and others) with this URL. You’ll sign in and choose which mailboxes the agent may use.</p>
<p><code class="identifier">${origin(c.env)}/mcp</code></p><p class="muted">Connected agents are listed under <a class="link" href="/o/${org.slug}/agents">Agents</a>.</p></div></section>`);
  });
  app.post('/o/:slug/mailboxes', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership; const host = orgHost(c.env, org); const path = `/o/${org.slug}`;
    const form = await c.req.formData();
    const local = String(form.get('local') ?? '').trim().toLowerCase();
    const displayName = String(form.get('display') ?? '').trim().slice(0, 100);
    if (!LOCAL.test(local) || local.includes('..')) return back(path, 'error', 'Use letters, digits, dots, hyphens or underscores for the mailbox name, starting and ending with a letter or digit.');
    if (RESERVED_LOCAL.has(local)) return back(path, 'error', `${local}@ is reserved for mail servers.`);
    const existing = await c.var.admin.mailboxes(host);
    if (existing.length >= MAILBOX_LIMIT) return back(path, 'error', `An organization can have up to ${MAILBOX_LIMIT} mailboxes.`);
    try {
      const created = await c.var.admin.createMailbox({ address: `${local}@${host}`, ...(displayName ? { displayName } : {}), metadata: { product: 'codemail', organizationId: org.id, createdBy: ctx.viewer.user.id } });
      return back(path, 'ok', `Created ${created.address}.`);
    } catch (error) { return back(path, 'error', errorText(error)); }
  });
  app.post('/o/:slug/mailboxes/:id/delete', async c => {
    const ctx = await orgPage(c, 'admin'); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership; const path = `/o/${org.slug}`;
    const mailbox = await orgMailbox(c, org, c.req.param('id'));
    if (!mailbox) return back(path, 'error', 'Mailbox not found.');
    try { await c.var.admin.deleteMailbox(mailbox.id); return back(path, 'ok', `Deleted ${mailbox.address}.`); }
    catch (error) { return back(path, 'error', errorText(error)); }
  });
  app.get('/o/:slug/m/:id', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership;
    const mailbox = await orgMailbox(c, org, c.req.param('id'));
    if (!mailbox) return back(`/o/${org.slug}`, 'error', 'Mailbox not found.');
    const threads = (await c.var.admin.threads(mailbox.id)).data;
    const mine = new Set([mailbox.address, ...mailbox.aliases]);
    const rows = threads.map(thread => {
      const people = thread.participants.filter(person => !mine.has(person.address)).map(person => person.name || person.address).slice(0, 3).join(', ') || mailbox.address;
      return [
        html`<a class="link" href="/o/${org.slug}/m/${mailbox.id}/t/${thread.id}">${thread.unreadCount ? raw('<span class="unread-dot" aria-hidden="true"></span>') : ''}${thread.subject || '(no subject)'}</a>${caption(thread.snippet)}`,
        html`${people}${thread.messageCount > 1 ? html` <span class="muted">(${thread.messageCount})</span>` : ''}`,
        html`<span class="muted nowrap">${ago(thread.lastMessageAt)}</span>`,
      ];
    });
    return inShell(c, ctx, 'mailboxes', mailbox.address, html`${pageHeader(mailbox.address, linkButton('All mailboxes', `/o/${org.slug}`))}
${mailbox.displayName ? html`<p class="muted">${mailbox.displayName}</p>` : ''}
${threads.length ? table([{ label: 'Conversation', className: 'col-primary' }, { label: 'People' }, { label: 'Last activity', className: 'row-actions' }], rows) : empty('No mail yet', html`Send something to <code>${mailbox.address}</code>.`)}`);
  });
  app.get('/o/:slug/m/:id/t/:threadId', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership;
    const mailbox = await orgMailbox(c, org, c.req.param('id'));
    if (!mailbox) return back(`/o/${org.slug}`, 'error', 'Mailbox not found.');
    const thread = await c.var.admin.thread(mailbox.id, c.req.param('threadId')).catch(() => null);
    if (!thread) return back(`/o/${org.slug}/m/${mailbox.id}`, 'error', 'Conversation not found.');
    const who = (value: { name: string | null; address: string }) => value.name ? `${value.name} <${value.address}>` : value.address;
    return inShell(c, ctx, 'mailboxes', thread.subject || 'Conversation', html`${pageHeader(thread.subject || '(no subject)', linkButton(mailbox.address, `/o/${org.slug}/m/${mailbox.id}`))}
<div>${thread.messages.map(message => html`<article class="thread-message"><div class="thread-message__meta"><strong>${who(message.from)}</strong><span class="muted">${new Date(message.receivedAt).toUTCString().slice(5, 22)} UTC</span></div>
<div class="cluster muted"><span>To ${[...message.to, ...message.cc].map(who).join(', ')}</span>${message.direction === 'outbound' ? status(message.status === 'delivered' ? 'success' : ['bounced', 'failed', 'complained'].includes(message.status) ? 'danger' : 'neutral', `Sent · ${message.status}`) : message.read ? '' : status('info', 'Unread')}</div>
<pre class="thread-message__body">${(message.replyText || message.text || '').trim() || '(no text)'}</pre>${message.attachments?.length ? html`<p class="muted">Attachments: ${message.attachments.map(file => file.filename).join(', ')}</p>` : ''}</article>`)}</div>`);
  });

  // ---------- members and invitations ----------
  app.get('/o/:slug/members', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership; const admin = isAdmin(role);
    const people = await c.var.db.select({ id: member.id, role: member.role, userId: user.id, name: user.name, email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.organizationId, org.id)).orderBy(asc(member.createdAt));
    const invites = await c.var.db.select().from(invitation).where(and(eq(invitation.organizationId, org.id), eq(invitation.status, 'pending'), sql`${invitation.expiresAt} > now()`)).orderBy(asc(invitation.createdAt));
    const link = c.req.query('link');
    return inShell(c, ctx, 'members', `${org.name} members`, html`${pageHeader('Members')}${notices(c)}
${link ? alert('success', html`They’ll get an email. You can also share this link: <code class="identifier">${link}</code>`, 'Invitation sent') : ''}
${table([{ label: 'Name' }, { label: 'Role' }, { label: '', className: 'row-actions' }], people.map(person => [
      html`${person.name || person.email}${person.userId === ctx.viewer.user.id ? html` <span class="muted">(you)</span>` : ''}${caption(person.email)}`,
      status(person.role === 'owner' ? 'info' : 'neutral', person.role),
      admin && person.role !== 'owner' && person.userId !== ctx.viewer.user.id ? action(`/o/${org.slug}/members/${person.id}/remove`, 'Remove', { variant: 'danger' }) : html``,
    ]))}
${admin ? html`<section class="section section--bordered">${sectionHeader('Invite people')}<form method="post" action="/o/${org.slug}/invites" autocomplete="off" class="stack">
<div class="inline-form">${field('Email', input(html`id="email" name="email" type="email" required placeholder="teammate@company.com"`), { id: 'email' })}
${field('Role', html`<select class="ui-input" id="role" name="role"><option value="member">Member</option><option value="admin">Admin</option></select>`, { id: 'role', narrow: true })}${button('Send invite', { variant: 'primary' })}</div>
<p class="muted">They sign in with the Google account for that email. Members create mailboxes and connect agents; admins also manage people and delete mailboxes.</p></form></section>
${invites.length ? html`<section class="section">${sectionHeader('Pending invitations')}${table([{ label: 'Email' }, { label: 'Role' }, { label: 'Expires' }, { label: '', className: 'row-actions' }], invites.map(item => [
      html`${item.email}`, status('neutral', item.role ?? 'member'), html`<span class="muted">${day(item.expiresAt)}</span>`, action(`/o/${org.slug}/invites/${item.id}/cancel`, 'Cancel'),
    ]))}</section>` : ''}` : ''}`);
  });
  app.post('/o/:slug/invites', async c => {
    const ctx = await orgPage(c, 'admin'); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership; const path = `/o/${org.slug}/members`;
    const form = await c.req.formData();
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const role = form.get('role') === 'admin' ? 'admin' : 'member';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return back(path, 'error', 'Enter a valid email address.');
    const [count] = await c.var.db.select({ n: sql<number>`count(*)::int` }).from(member).where(eq(member.organizationId, org.id));
    if ((count?.n ?? 0) >= MEMBER_LIMIT) return back(path, 'error', `An organization can have up to ${MEMBER_LIMIT} members.`);
    try {
      const created = await c.var.auth.api.createInvitation({ body: { email, role, organizationId: org.id, resend: true }, headers: c.req.raw.headers });
      return redirect(`${path}?link=${encodeURIComponent(`${origin(c.env)}/invite/${created.id}`)}`);
    } catch (error) { return back(path, 'error', errorText(error)); }
  });
  app.post('/o/:slug/invites/:id/cancel', async c => {
    const ctx = await orgPage(c, 'admin'); if ('response' in ctx) return ctx.response;
    const path = `/o/${ctx.membership.org.slug}/members`;
    try { await c.var.auth.api.cancelInvitation({ body: { invitationId: c.req.param('id') }, headers: c.req.raw.headers }); return back(path, 'ok', 'Invitation cancelled.'); }
    catch (error) { return back(path, 'error', errorText(error)); }
  });
  app.post('/o/:slug/members/:id/remove', async c => {
    const ctx = await orgPage(c, 'admin'); if ('response' in ctx) return ctx.response;
    const { org } = ctx.membership; const path = `/o/${org.slug}/members`;
    const [target] = await c.var.db.select({ userId: member.userId, role: member.role, email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.id, c.req.param('id')), eq(member.organizationId, org.id)));
    if (!target) return back(path, 'error', 'Member not found.');
    if (target.role === 'owner') return back(path, 'error', 'Owners can’t be removed.');
    try {
      await c.var.auth.api.removeMember({ body: { memberIdOrEmail: c.req.param('id'), organizationId: org.id }, headers: c.req.raw.headers });
      // Their agents lose access immediately.
      const grants = (await c.env.OAUTH_PROVIDER.listUserGrants(target.userId, { limit: 100 })).items.filter(grant => grant.metadata?.organizationId === org.id);
      await Promise.all(grants.map(grant => revokeGrant(c, grant)));
      return back(path, 'ok', `Removed ${target.email}${grants.length ? ` and disconnected ${grants.length} agent${grants.length === 1 ? '' : 's'}` : ''}.`);
    } catch (error) { return back(path, 'error', errorText(error)); }
  });

  app.get('/invite/:id', async c => {
    const viewer = await viewerOf(c);
    const self = `/invite/${encodeURIComponent(c.req.param('id'))}`;
    if (!viewer) return solo('Invitation', html`<h1>You’re invited to codemail</h1><p>Sign in with the Google account the invitation was sent to.</p><div class="solo-actions">${linkButton('Sign in to accept', `/sign-in?next=${encodeURIComponent(self)}`, { variant: 'primary' })}</div>`);
    const [row] = await c.var.db.select({ invite: invitation, orgName: organization.name, orgSlug: organization.slug, inviter: user.name, inviterEmail: user.email }).from(invitation).innerJoin(organization, eq(organization.id, invitation.organizationId)).innerJoin(user, eq(user.id, invitation.inviterId)).where(eq(invitation.id, c.req.param('id')));
    const usable = row && row.invite.status === 'pending' && new Date(row.invite.expiresAt).getTime() > Date.now();
    if (!row || !usable) return solo('Invitation', html`<h1>This invitation isn’t available</h1><p>It may have expired, been cancelled or already been used.</p><div class="solo-actions">${linkButton('Continue', '/app')}</div>`, { status: 404, viewer: viewerView(viewer) });
    if (row.invite.email.toLowerCase() !== viewer.user.email.toLowerCase()) return solo('Invitation', html`<h1>Wrong account</h1><p>This invitation is for <strong>${row.invite.email}</strong>, but you’re signed in as ${viewer.user.email}. Sign out, then sign in with that account.</p>`, { status: 403, viewer: viewerView(viewer) });
    return solo('Invitation', html`<h1>Join ${row.orgName}</h1><p>${row.inviter || row.inviterEmail} invited you as ${row.invite.role === 'admin' ? 'an admin' : 'a member'}. You’ll be able to create agent mailboxes at <strong>@${row.orgSlug}.${c.env.MAIL_DOMAIN}</strong>.</p>
<form method="post"><div class="solo-actions">${button('Decline', { name: 'decision', value: 'decline' })}${button(`Join ${row.orgName}`, { variant: 'primary', name: 'decision', value: 'accept' })}</div></form>`, { viewer: viewerView(viewer) });
  });
  app.post('/invite/:id', async c => {
    const viewer = await viewerOf(c);
    if (!viewer) return redirect(`/sign-in?next=${encodeURIComponent(`/invite/${c.req.param('id')}`)}`);
    const form = await c.req.formData();
    try {
      if (form.get('decision') !== 'accept') { await c.var.auth.api.rejectInvitation({ body: { invitationId: c.req.param('id') }, headers: c.req.raw.headers }); return redirect('/app'); }
      const accepted = await c.var.auth.api.acceptInvitation({ body: { invitationId: c.req.param('id') }, headers: c.req.raw.headers });
      const [org] = await c.var.db.select({ slug: organization.slug, name: organization.name }).from(organization).where(eq(organization.id, accepted?.invitation.organizationId ?? ''));
      return redirect(org ? `/o/${org.slug}?ok=${encodeURIComponent(`Welcome to ${org.name}.`)}` : '/app');
    } catch (error) { return solo('Invitation', html`<h1>Couldn’t accept the invitation</h1>${alert('danger', errorText(error))}`, { status: 400, viewer: viewerView(viewer) }); }
  });

  // ---------- connected agents ----------
  app.get('/o/:slug/agents', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership;
    const grants = await orgGrants(c, org.id);
    const canRevoke = (grant: { userId: string }) => grant.userId === ctx.viewer.user.id || isAdmin(role);
    return inShell(c, ctx, 'agents', `${org.name} agents`, html`${pageHeader('Agents')}${notices(c)}
${grants.length ? table([{ label: 'App' }, { label: 'Mailboxes', className: 'col-primary' }, { label: 'Permissions' }, { label: 'Connected' }, { label: '', className: 'row-actions' }], grants.map(grant => [
      html`${grant.metadata?.clientName ?? grant.clientId}${caption(`by ${grant.email}`)}`,
      html`${((grant.metadata?.mailboxes as string[] | undefined) ?? []).map((address, index) => html`${index ? raw('<br>') : ''}<code class="identifier">${address}</code>`)}`,
      html`<div class="cluster">${((grant.metadata?.permissions as string[] | undefined) ?? []).map(permission => status('neutral', permission))}</div>`,
      html`<span class="muted nowrap">${ago(new Date(grant.createdAt * 1000).toISOString())}</span>`,
      canRevoke(grant) ? action(`/o/${org.slug}/agents/${encodeURIComponent(grant.id)}/revoke`, 'Disconnect', { variant: 'danger', hidden: { user: grant.userId } }) : html``,
    ])) : empty('No agents connected', html`Add <code>${origin(c.env)}/mcp</code> to an MCP client to connect one.`)}`);
  });
  app.post('/o/:slug/agents/:grantId/revoke', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership; const path = `/o/${org.slug}/agents`;
    const owner = String((await c.req.formData()).get('user') ?? '');
    if (owner !== ctx.viewer.user.id && !isAdmin(role)) return back(path, 'error', 'Only admins can disconnect other people’s agents.');
    const [target] = await c.var.db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, org.id), eq(member.userId, owner)));
    if (!target) return back(path, 'error', 'Agent not found.');
    const grant = (await c.env.OAUTH_PROVIDER.listUserGrants(owner, { limit: 100 })).items.find(item => item.id === c.req.param('grantId') && item.metadata?.organizationId === org.id);
    if (!grant) return back(path, 'error', 'Agent not found.');
    await revokeGrant(c, grant);
    return back(path, 'ok', `Disconnected ${grant.metadata?.clientName ?? 'the agent'}. Its mailbox key is revoked.`);
  });

  // ---------- settings ----------
  app.get('/o/:slug/settings', async c => {
    const ctx = await orgPage(c); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership;
    return inShell(c, ctx, 'settings', `${org.name} settings`, html`${pageHeader('Settings')}${notices(c)}
<dl class="facts"><div><dt>Name</dt><dd>${org.name}</dd></div><div><dt>Email address</dt><dd><code class="identifier">@${orgHost(c.env, org)}</code></dd></div><div><dt>Your role</dt><dd>${role}</dd></div><div><dt>Created</dt><dd>${day(org.createdAt)}</dd></div></dl>
${role === 'owner' ? html`<section class="section section--bordered">${sectionHeader('Delete organization')}<div class="panel danger-zone stack"><p class="muted">Deletes every mailbox, disconnects all agents and removes all members. <code>@${orgHost(c.env, org)}</code> stops receiving mail and is never reused.</p>
<form method="post" action="/o/${org.slug}/delete" autocomplete="off" class="inline-form">${field('Type the organization’s address to confirm', input(html`id="confirm" name="confirm" type="text" required spellcheck="false" placeholder="${org.slug}"`), { id: 'confirm' })}${button('Delete organization', { variant: 'danger' })}</form></div></section>` : ''}`);
  });
  app.post('/o/:slug/delete', async c => {
    const ctx = await orgPage(c, 'admin'); if ('response' in ctx) return ctx.response;
    const { org, role } = ctx.membership; const path = `/o/${org.slug}/settings`;
    if (role !== 'owner') return back(path, 'error', 'Only the owner can delete the organization.');
    if (String((await c.req.formData()).get('confirm') ?? '').trim() !== org.slug) return back(path, 'error', `Type ${org.slug} to confirm.`);
    try {
      for (const grant of await orgGrants(c, org.id)) await revokeGrant(c, grant);
      for (const mailbox of await c.var.admin.mailboxes(orgHost(c.env, org))) await c.var.admin.deleteMailbox(mailbox.id);
      const { subdomainId } = orgMeta(org);
      // The subdomain stays registered (disabled) with OpenSend, so the slug is never handed to someone else with old mail.
      if (subdomainId) await c.var.admin.removeSubdomain(subdomainId);
      await c.var.db.insert(retiredSlug).values({ slug: org.slug }).onConflictDoNothing();
      await c.var.auth.api.deleteOrganization({ body: { organizationId: org.id }, headers: c.req.raw.headers });
      return redirect('/app');
    } catch (error) { return back(path, 'error', errorText(error)); }
  });

  app.route('/', consentRoutes());
  app.notFound(() => solo('Not found', html`<h1>Page not found</h1><div class="solo-actions">${linkButton('Home', '/')}</div>`, { status: 404 }));
  app.onError((error, c) => {
    console.error(JSON.stringify({ code: 'UNHANDLED', path: c.req.path, message: error instanceof Error ? error.message : String(error) }));
    return solo('Error', html`<h1>Something went wrong</h1><p>Try again in a moment.</p>`, { status: 500 });
  });
  return app;
}
