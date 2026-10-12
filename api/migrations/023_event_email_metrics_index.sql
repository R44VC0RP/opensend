-- Metrics collapse email events per email within the cohort window. Without this index every metrics
-- request scans all operation_events, including contact.subscription_changed and other events that can
-- never match an email. On a large existing table, create it first with CREATE INDEX CONCURRENTLY
-- (same name and definition) so this transactional migration is a no-op and writes are never blocked.
CREATE INDEX IF NOT EXISTS operation_events_email_metrics ON operation_events (workspace_id, environment, created_at) WHERE data ? 'emailId';
