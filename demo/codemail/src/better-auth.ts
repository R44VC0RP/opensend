import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { authSchema, type Db } from './db.js';
import { mayCreateOrganizations, origin, type Env } from './env.js';
import { esc } from './html.js';
import { OpenSendAdmin } from './opensend.js';

export const ORGANIZATION_LIMIT = 5;
export const MEMBER_LIMIT = 50;

/** Built per request around that request's database connection. */
export function createAuth(env: Env, db: Db, waitUntil: (work: Promise<unknown>) => void) {
  const base = origin(env);
  return betterAuth({
    appName: 'codemail', baseURL: base, basePath: '/api/auth', secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    trustedOrigins: [base],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account', scope: ['openid', 'email', 'profile'] },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    advanced: { cookiePrefix: 'codemail' },
    plugins: [organization({
      allowUserToCreateOrganization: user => mayCreateOrganizations(env, user.email),
      organizationLimit: ORGANIZATION_LIMIT,
      membershipLimit: MEMBER_LIMIT,
      creatorRole: 'owner',
      invitationExpiresIn: 60 * 60 * 24 * 7,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      sendInvitationEmail: async data => {
        const link = `${base}/invite/${encodeURIComponent(data.id)}`;
        const [fromName, from] = parseFrom(env.INVITE_FROM);
        const who = data.inviter.user.name || data.inviter.user.email;
        const text = `${who} invited you to join ${data.organization.name} on codemail.\n\nMembers create email mailboxes for AI agents at @${data.organization.slug}.${env.MAIL_DOMAIN}.\n\nAccept the invitation (expires in 7 days):\n${link}\n\nIf you weren't expecting this, you can ignore this email.`;
        const htmlBody = `<p>${esc(who)} invited you to join <strong>${esc(data.organization.name)}</strong> on codemail.</p><p>Members create email mailboxes for AI agents at <strong>@${esc(data.organization.slug)}.${esc(env.MAIL_DOMAIN)}</strong>.</p><p><a href="${esc(link)}">Accept the invitation</a> (expires in 7 days).</p><p style="color:#777">If you weren't expecting this, you can ignore this email.</p>`;
        const admin = new OpenSendAdmin(env.OPENSEND_URL, env.OPENSEND_API_KEY, env.MAIL_DOMAIN);
        // Invitations should not fail because email is slow; the link is also shown to the inviter.
        waitUntil(admin.sendEmail({ from, ...(fromName ? { fromName } : {}), to: data.email, subject: `Join ${data.organization.name} on codemail`, text, html: htmlBody }, `invite-${data.id}`)
          .catch(error => console.error(JSON.stringify({ code: 'INVITE_EMAIL_FAILED', message: error instanceof Error ? error.message : String(error) }))));
      },
    })],
  });
}
export type Auth = ReturnType<typeof createAuth>;

function parseFrom(value: string): [string | null, string] {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return match ? [match[1] || null, match[2]!] : [null, value.trim()];
}
