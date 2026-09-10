import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export type TemplateDraft = { name: string; description: string; subject: string; previewText?: string; fromName?: string; replyTo: string[]; tracking: boolean; defaults: Record<string, string | number | boolean | null>; html?: string; attachments: string[] };
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
export const templates = pgTable('campaign_templates', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(), revision: integer('revision').notNull().default(1), draft: jsonb('draft').$type<TemplateDraft>().notNull(),
  published: jsonb('published').$type<TemplateDraft>(), publishedRevision: integer('published_revision'), archivedAt: time('archived_at'), createdAt: time('created_at').notNull().defaultNow(), updatedAt: time('updated_at').notNull().defaultNow(),
}, table => [index('campaign_templates_page').on(table.workspaceId, table.updatedAt.desc(), table.id.desc())]);
export const templateAssets = pgTable('template_assets', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(), filename: text('filename').notNull(), contentType: text('content_type').notNull(), size: integer('size').notNull(),
  disposition: text('disposition').$type<'attachment' | 'inline'>().notNull(), contentId: text('content_id'), storageKey: text('storage_key').notNull(), checksum: text('checksum').notNull(), createdAt: time('created_at').notNull().defaultNow(),
}, table => [index('template_assets_page').on(table.workspaceId, table.id)]);
export const templateAssetLinks = pgTable('template_asset_links', {
  workspaceId: text('workspace_id').notNull(), assetId: text('asset_id').notNull(), templateId: text('template_id').notNull(), stage: text('stage').$type<'draft' | 'published'>().notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.assetId, table.templateId, table.stage] }), index('template_asset_owner').on(table.workspaceId, table.templateId, table.stage)]);
