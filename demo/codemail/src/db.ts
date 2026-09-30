// codemail's tables live in their own Postgres schema ("codemail") inside the OpenSend database.
import { drizzle } from 'drizzle-orm/node-postgres';
import { boolean, index, pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import pg from 'pg';

const schema = pgSchema('codemail');
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const user = schema.table('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false), image: text('image'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
});
export const session = schema.table('session', {
  id: text('id').primaryKey(), token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  activeOrganizationId: text('active_organization_id'),
  expiresAt: ts('expires_at').notNull(), ipAddress: text('ip_address'), userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('session_user_idx').on(t.userId)]);
export const account = schema.table('account', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull(), providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'), refreshToken: text('refresh_token'), idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'), refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'), password: text('password'),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('account_user_idx').on(t.userId), uniqueIndex('account_provider_subject_idx').on(t.providerId, t.accountId)]);
export const verification = schema.table('verification', {
  id: text('id').primaryKey(), identifier: text('identifier').notNull(), value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(), updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [index('verification_identifier_idx').on(t.identifier)]);

// Organizations: slug is the mail subdomain (acme → acme.opcd.ai).
export const organization = schema.table('organization', {
  id: text('id').primaryKey(), name: text('name').notNull(), slug: text('slug').notNull().unique(), logo: text('logo'),
  metadata: text('metadata'), createdAt: ts('created_at').notNull().defaultNow(),
});
export const member = schema.table('member', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
}, t => [uniqueIndex('member_org_user_idx').on(t.organizationId, t.userId), index('member_user_idx').on(t.userId)]);
export const invitation = schema.table('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(), role: text('role'), status: text('status').notNull(),
  expiresAt: ts('expires_at').notNull(), createdAt: ts('created_at').notNull().defaultNow(),
  inviterId: text('inviter_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, t => [index('invitation_org_idx').on(t.organizationId), index('invitation_email_idx').on(t.email)]);

// Deleted organizations' slugs. Only former members (by Google email) may recreate one.
export const retiredSlug = schema.table('retired_slug', {
  slug: text('slug').primaryKey(), retiredAt: ts('retired_at').notNull().defaultNow(),
  formerMemberEmails: text('former_member_emails').array().notNull().default([]), subdomainId: text('subdomain_id'),
});

export const authSchema = { user, session, account, verification, organization, member, invitation };

/** One connection per request: Workers must not keep sockets across requests. Hyperdrive pools for us. */
export function connect(connectionString: string) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  const db = drizzle(client, { schema: authSchema });
  return { db, ready: client.connect(), close: () => client.end().catch(() => {}) };
}
export type Db = ReturnType<typeof connect>['db'];
