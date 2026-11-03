import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { authUser } from './google-auth.js';
import { sql } from 'drizzle-orm';

// Better Auth 1.7.3 modelName mappings: organization → workspaces, member → workspaceMembers,
// invitation → workspaceInvitations. Map organizationId → workspaceId on both child models;
// all other plugin fields match the Drizzle keys. The plugin serializes metadata as JSON text.
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(), name: text('name').notNull(), slug: text('slug').notNull().unique(),
  logo: text('logo'), metadata: text('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable('workspace_members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('workspace_members_workspace_user_idx').on(t.workspaceId, t.userId), index('workspace_members_user_idx').on(t.userId)]);

export const workspaceInvitations = pgTable('workspace_invitations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(), role: text('role'), status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  inviterId: text('inviter_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('workspace_invitations_workspace_idx').on(t.workspaceId), index('workspace_invitations_email_idx').on(t.email),
  uniqueIndex('workspace_invitations_pending_idx').on(t.workspaceId, t.email).where(sql`status = 'pending'`)]);
