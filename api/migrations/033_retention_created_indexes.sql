-- Hourly retention deletes rows older than 30 days by created_at. These two tables had no created_at index, so
-- every run sequentially scanned ~1 GB (sending_email_events) and ~200 MB (operation_sns_receipts) on a 1-vCPU
-- database while it sends. On a large live table create them first with CREATE INDEX CONCURRENTLY (same name and
-- definition) so this transactional migration is a no-op.
CREATE INDEX IF NOT EXISTS sending_email_events_retention ON sending_email_events (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS operation_sns_receipts_retention ON operation_sns_receipts (workspace_id, created_at);
