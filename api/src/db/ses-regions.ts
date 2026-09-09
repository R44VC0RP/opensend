import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { SesDiscovery } from '../ses-setup.js';

export const sesSettings = pgTable('ses_installation_settings', {
  workspaceId: text('workspace_id').primaryKey(),
  installationId: text('installation_id').notNull(),
  defaultRegion: text('default_region').notNull(),
  enabledRegions: jsonb('enabled_regions').$type<string[]>().notNull(),
});
export const sesRegions = pgTable('ses_region_discovery', {
  workspaceId: text('workspace_id').notNull(), region: text('region').notNull(),
  report: jsonb('report').$type<SesDiscovery>(),
  credentialsFingerprint: text('credentials_fingerprint'), publicUrl: text('public_url'),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true, mode: 'string' }),
  trustedAccountId: text('trusted_account_id'), trustedTopicArn: text('trusted_topic_arn'),
  trustedCredentialsFingerprint: text('trusted_credentials_fingerprint'),
  provisionJobId: text('provision_job_id'),
}, t => [primaryKey({ columns: [t.workspaceId, t.region] })]);
