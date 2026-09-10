import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
const scope = () => ({
  workspaceId: text('workspace_id').notNull(),
  environment: text('environment').$type<'live' | 'test'>().notNull(),
});
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const templates = pgTable('template_library', {
  id: text('id').primaryKey(),
  ...scope(),
  name: text('name').notNull(),
  kind: text('kind').$type<'marketing' | 'automation'>().notNull(),
  revision: integer('revision').notNull().default(0),
  publishedVersionId: text('published_version_id'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const templateVersions = pgTable('template_versions', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull(),
  ...scope(),
  revision: integer('revision').notNull(),
  artifactKey: text('artifact_key').notNull(),
  checksum: text('checksum').notNull(),
  subject: text('subject').notNull(),
  status: text('status').$type<'draft' | 'publishing' | 'published' | 'failed'>().notNull().default('draft'),
  region: text('region'),
  sesName: text('ses_name'),
  legacySesName: text('legacy_ses_name'),
  errorCode: text('error_code'),
  validation: jsonb('validation').$type<{ valid: boolean; errors: string[]; bytes: number }>().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  publishedAt: time('published_at'),
});
export const templateSessions = pgTable('template_sessions', {
  templateId: text('template_id').primaryKey(),
  ...scope(),
  sessionId: text('session_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
