import { pgTable, text, timestamp, integer, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import type { Permission, Mode } from '../core.js';
export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  environment: text('environment').$type<Mode>().notNull(), name: text('name').notNull(),
  hash: text('hash').notNull().unique(), prefix: text('prefix').notNull(),
  permissions: jsonb('permissions').$type<Permission[]>().notNull(), domains: jsonb('domains').$type<string[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
});
export const requestBudgets = pgTable('api_request_budgets', {
  workspaceId: text('workspace_id').notNull(), keyId: text('key_id').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true, mode: 'string' }).notNull(),
  used: integer('used').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.keyId] }), index('api_request_budgets_expiry').on(t.windowStart)]);
export const jobSchedule = pgTable('job_schedule', {
  workspaceId: text('workspace_id').primaryKey(), turn: integer('turn').notNull().default(0),
});
export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull(),
  environment: text('environment').$type<Mode>().notNull(), type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), availableAt: timestamp('available_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'string' }), lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, t => [index('jobs_due_idx').on(t.status, t.availableAt)]);
